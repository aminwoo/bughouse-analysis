// Browser inference backend for the hivemind engine.
//
// The WebAssembly build cannot link ONNX Runtime directly, so it hands each
// batch to JavaScript instead. Every search worker owns one "slot" in shared
// wasm memory: an input tensor, the network's output tensors and a state word.
// A request is published by writing the input and flipping the state word;
// onnxruntime-web, running in dedicated Web Workers that hold a view of the
// same SharedArrayBuffer, wakes on that word, evaluates the batch (WebGPU or
// WASM) and flips it back. The search thread sleeps on the word in between,
// so the existing enqueue/synchronize contract is preserved unchanged.
//
// Layout of the registry read by JavaScript (all 32-bit little endian):
//   registry[0]   magic 0x48564d57 ("HVMW")
//   registry[1]   layout version
//   registry[2]   request sequence, bumped and notified on every request
//   registry[3]   number of slots
//   registry[4]   input values per position (74 * 8 * 8)
//   registry[5]   policy values per position (73 * 8 * 8)
//   registry[6..] pointer to slot i
// Each slot is a WebSlot below.

#include "nn/engine.h"

#include <emscripten/emscripten.h>
#include <emscripten/threading.h>

#include <algorithm>
#include <atomic>
#include <climits>
#include <cstring>
#include <iostream>
#include <mutex>
#include <vector>

#include "environment/constants.h"
#include "search/search_params.h"

namespace {

constexpr int32_t kRegistryMagic = 0x48564d57;
constexpr int32_t kLayoutVersion = 1;
constexpr int kMaxSlots = 64;

enum SlotState : int32_t {
    kIdle = 0,
    kRequested = 1,
    kDone = 2,
    kFailed = 3,
};

// Field order is part of the JavaScript contract (see web/inference).
struct WebSlot {
    int32_t state;
    int32_t batch;
    int32_t requestId;
    int32_t reserved;
    float* input;
    float* value;
    float* policyA;
    float* policyB;
    float* wdl;
    float* movesLeft;
};

struct Registry {
    int32_t magic = kRegistryMagic;
    int32_t version = kLayoutVersion;
    int32_t requestSequence = 0;
    int32_t slotCount = 0;
    int32_t inputValues = static_cast<int32_t>(NB_INPUT_VALUES());
    int32_t policyValues = static_cast<int32_t>(NB_POLICY_VALUES());
    WebSlot* slots[kMaxSlots] = {};
};

Registry g_registry;
std::mutex g_registryMutex;

float* allocate_floats(size_t count) {
    void* memory = nullptr;
    if (!hm::alloc_pinned(&memory, count * sizeof(float))) {
        throw std::bad_alloc();
    }
    std::memset(memory, 0, count * sizeof(float));
    return static_cast<float*>(memory);
}

WebSlot* create_slot(int batchSize) {
    auto* slot = new WebSlot{};
    slot->batch = batchSize;
    slot->input = allocate_floats(static_cast<size_t>(batchSize) * NB_INPUT_VALUES());
    slot->value = allocate_floats(static_cast<size_t>(batchSize));
    slot->policyA = allocate_floats(static_cast<size_t>(batchSize) * NB_POLICY_VALUES());
    slot->policyB = allocate_floats(static_cast<size_t>(batchSize) * NB_POLICY_VALUES());
    slot->wdl = allocate_floats(static_cast<size_t>(batchSize) * 3);
    slot->movesLeft = allocate_floats(static_cast<size_t>(batchSize));
    return slot;
}

int32_t atomic_load(int32_t* word) {
    return __atomic_load_n(word, __ATOMIC_SEQ_CST);
}

void atomic_store(int32_t* word, int32_t value) {
    __atomic_store_n(word, value, __ATOMIC_SEQ_CST);
}

}  // namespace

extern "C" {

// Address of the slot registry, read once by the JavaScript inference hub.
EMSCRIPTEN_KEEPALIVE void* hm_inference_registry() {
    return &g_registry;
}

}  // extern "C"

struct Engine::OrtState {
    std::vector<WebSlot*> slots;
    std::vector<bool> pending;
};

const char* Engine::backendName() { return "WebAssembly (onnxruntime-web)"; }

Engine::Engine(int deviceId, int batchSize)
    : m_deviceId(deviceId),
      m_batchSize(batchSize > 0 ? batchSize : SearchParams::BATCH_SIZE),
      m_ort(std::make_unique<OrtState>()) {}

Engine::~Engine() {
    // Slots live in the registry for the lifetime of the module: JavaScript
    // holds raw pointers to them, so they are never freed.
}

bool Engine::loadNetwork(const std::string& onnxFile,
                         const std::string& /*engineFile*/) {
    std::lock_guard<std::mutex> lock(g_registryMutex);
    const int workers = std::max(1, SearchParams::NUM_SEARCH_THREADS);
    const int first = m_deviceId * workers;
    if (first + workers > kMaxSlots) {
        std::cerr << "Too many inference slots requested" << std::endl;
        return false;
    }
    m_ort->slots.clear();
    m_ort->pending.assign(static_cast<size_t>(workers), false);
    for (int i = 0; i < workers; ++i) {
        WebSlot*& slot = g_registry.slots[first + i];
        if (!slot || slot->batch != m_batchSize) {
            // A batch-size change leaks the old slot: JavaScript may still
            // reference it, and reloads are rare.
            slot = create_slot(m_batchSize);
        }
        m_ort->slots.push_back(slot);
    }
    atomic_store(&g_registry.slotCount,
                 std::max(atomic_load(&g_registry.slotCount), first + workers));
    m_inputName = "data";
    std::cout << "info string backend " << backendName() << " model " << onnxFile
              << " batch " << m_batchSize << " slots " << first << "-"
              << (first + workers - 1) << std::endl;
    return true;
}

bool Engine::enqueueInferenceHalf(const __half* obs, size_t workerIndex) {
    if (!obs || !m_ort || workerIndex >= m_ort->slots.size()) return false;
    if (m_ort->pending[workerIndex]) return false;
    WebSlot* slot = m_ort->slots[workerIndex];
    std::memcpy(slot->input, obs,
                static_cast<size_t>(m_batchSize) * NB_INPUT_VALUES() * sizeof(float));
    slot->requestId++;
    atomic_store(&slot->state, kRequested);
    emscripten_futex_wake(&slot->state, INT_MAX);
    __atomic_add_fetch(&g_registry.requestSequence, 1, __ATOMIC_SEQ_CST);
    emscripten_futex_wake(&g_registry.requestSequence, INT_MAX);
    m_ort->pending[workerIndex] = true;
    return true;
}

bool Engine::synchronizeInferenceHalf(HalfInferenceOutputs& outputs,
                                      size_t workerIndex) {
    if (!m_ort || workerIndex >= m_ort->slots.size()) return false;
    if (!m_ort->pending[workerIndex]) return false;
    m_ort->pending[workerIndex] = false;
    WebSlot* slot = m_ort->slots[workerIndex];
    for (;;) {
        const int32_t state = atomic_load(&slot->state);
        if (state == kDone || state == kFailed) break;
        emscripten_futex_wait(&slot->state, static_cast<uint32_t>(state), 1000.0);
    }
    const bool ok = atomic_load(&slot->state) == kDone;
    atomic_store(&slot->state, kIdle);
    if (!ok) {
        std::cerr << "Browser inference failed for slot " << workerIndex << std::endl;
        return false;
    }
    outputs.value = slot->value;
    outputs.policyA = slot->policyA;
    outputs.policyB = slot->policyB;
    outputs.wdl = slot->wdl;
    outputs.movesLeft = slot->movesLeft;
    outputs.jointFactorsA = nullptr;
    outputs.jointFactorsB = nullptr;
    outputs.jointFactorRank = 0;
    return true;
}

bool Engine::runInferenceHalf(const __half* obs, HalfInferenceOutputs& outputs,
                              size_t workerIndex) {
    if (!enqueueInferenceHalf(obs, workerIndex)) return false;
    return synchronizeInferenceHalf(outputs, workerIndex);
}

bool Engine::runInference(float* obs, float* value, float* piA, float* piB,
                          float* wdl, float* movesLeft, size_t workerIndex) {
    HalfInferenceOutputs outputs;
    if (!runInferenceHalf(obs, outputs, workerIndex)) return false;
    const size_t batch = static_cast<size_t>(m_batchSize);
    auto copy = [](const float* src, float* dst, size_t count) {
        if (src && dst) std::copy(src, src + count, dst);
    };
    copy(outputs.value, value, batch);
    copy(outputs.policyA, piA, batch * NB_POLICY_VALUES());
    copy(outputs.policyB, piB, batch * NB_POLICY_VALUES());
    copy(outputs.wdl, wdl, batch * 3);
    copy(outputs.movesLeft, movesLeft, batch);
    return true;
}
