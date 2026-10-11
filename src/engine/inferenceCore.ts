// Serves the WebAssembly engine's inference slots (see engine/src/engine_web.cc).
//
// The engine's search threads publish batches into shared wasm memory and sleep
// on a per-slot state word. This module, running in a worker that holds the
// same WebAssembly.Memory, waits on those words with Atomics.wait, evaluates
// the batches with a caller-supplied runner and wakes the search threads.
//
// Written with erasable TypeScript only so Node can run it directly in tests.

export const REGISTRY_MAGIC = 0x48564d57;
const SLOT_IDLE = 0;
const SLOT_REQUESTED = 1;
const SLOT_DONE = 2;
const SLOT_FAILED = 3;

export interface SlotLayout {
  index: number;
  statePtr: number;
  batch: number;
  inputPtr: number;
  valuePtr: number;
  policyAPtr: number;
  policyBPtr: number;
  wdlPtr: number;
  movesLeftPtr: number;
}

export interface RegistryLayout {
  sequencePtr: number;
  inputValues: number;
  policyValues: number;
  slots: SlotLayout[];
}

export interface NetworkOutputs {
  value: Float32Array;
  policyA: Float32Array;
  policyB: Float32Array;
  wdl: Float32Array;
  movesLeft: Float32Array;
}

/** Evaluates `batch` positions laid out as [batch, 74, 8, 8]. */
export type NetworkRunner = (input: Float32Array, batch: number) => Promise<NetworkOutputs>;

export function readRegistry(memory: WebAssembly.Memory, registryPtr: number): RegistryLayout {
  const heap32 = new Int32Array(memory.buffer);
  const base = registryPtr >> 2;
  if (heap32[base] !== REGISTRY_MAGIC) {
    throw new Error("hivemind inference registry not found");
  }
  const slotCount = Atomics.load(heap32, base + 3);
  const slots: SlotLayout[] = [];
  for (let i = 0; i < slotCount; i++) {
    const slotPtr = heap32[base + 6 + i];
    if (!slotPtr) continue;
    const s = slotPtr >> 2;
    slots.push({
      index: i,
      statePtr: slotPtr,
      batch: heap32[s + 1],
      inputPtr: heap32[s + 4],
      valuePtr: heap32[s + 5],
      policyAPtr: heap32[s + 6],
      policyBPtr: heap32[s + 7],
      wdlPtr: heap32[s + 8],
      movesLeftPtr: heap32[s + 9],
    });
  }
  return {
    sequencePtr: registryPtr + 8,
    inputValues: heap32[base + 4],
    policyValues: heap32[base + 5],
    slots,
  };
}

export interface ServeOptions {
  memory: WebAssembly.Memory;
  registry: RegistryLayout;
  /** Slots this worker answers. */
  slots: SlotLayout[];
  run: NetworkRunner;
  /** Merge simultaneous requests into one network call (good for GPUs). */
  mergeBatches: boolean;
  shouldStop?: () => boolean;
  onBatch?: (positions: number, milliseconds: number) => void;
}

/** Runs until `shouldStop` returns true. Blocks the calling worker between batches. */
export async function serveSlots(options: ServeOptions): Promise<void> {
  const { memory, registry, slots, run, mergeBatches } = options;
  const seqIndex = registry.sequencePtr >> 2;
  const singleSlot = slots.length === 1 ? slots[0] : null;

  for (;;) {
    if (options.shouldStop?.()) return;
    let heap32 = new Int32Array(memory.buffer);

    let pending = slots.filter((slot) => Atomics.load(heap32, slot.statePtr >> 2) === SLOT_REQUESTED);
    if (pending.length === 0) {
      if (singleSlot) {
        const index = singleSlot.statePtr >> 2;
        const state = Atomics.load(heap32, index);
        if (state !== SLOT_REQUESTED) Atomics.wait(heap32, index, state, 250);
      } else {
        const seq = Atomics.load(heap32, seqIndex);
        pending = slots.filter((slot) => Atomics.load(heap32, slot.statePtr >> 2) === SLOT_REQUESTED);
        if (pending.length === 0) Atomics.wait(heap32, seqIndex, seq, 250);
      }
      continue;
    }

    const groups = mergeBatches ? [pending] : pending.map((slot) => [slot]);
    for (const group of groups) {
      const started = performance.now();
      const total = group.reduce((sum, slot) => sum + slot.batch, 0);
      const input = new Float32Array(total * registry.inputValues);
      let offset = 0;
      for (const slot of group) {
        const length = slot.batch * registry.inputValues;
        input.set(new Float32Array(memory.buffer, slot.inputPtr, length), offset);
        offset += length;
      }

      let outputs: NetworkOutputs | null = null;
      try {
        outputs = await run(input, total);
      } catch (error) {
        console.error("hivemind inference failed", error);
      }

      heap32 = new Int32Array(memory.buffer);
      let row = 0;
      for (const slot of group) {
        if (outputs) {
          const b = slot.batch;
          const p = registry.policyValues;
          new Float32Array(memory.buffer, slot.valuePtr, b).set(outputs.value.subarray(row, row + b));
          new Float32Array(memory.buffer, slot.policyAPtr, b * p).set(outputs.policyA.subarray(row * p, (row + b) * p));
          new Float32Array(memory.buffer, slot.policyBPtr, b * p).set(outputs.policyB.subarray(row * p, (row + b) * p));
          new Float32Array(memory.buffer, slot.wdlPtr, b * 3).set(outputs.wdl.subarray(row * 3, (row + b) * 3));
          new Float32Array(memory.buffer, slot.movesLeftPtr, b).set(outputs.movesLeft.subarray(row, row + b));
        }
        row += slot.batch;
        Atomics.store(heap32, slot.statePtr >> 2, outputs ? SLOT_DONE : SLOT_FAILED);
        Atomics.notify(heap32, slot.statePtr >> 2);
      }
      options.onBatch?.(total, performance.now() - started);
    }
  }
}

/** Output names differ across exported networks; match them the way the native engine does. */
export function mapOutputNames(names: readonly string[]): Record<keyof NetworkOutputs, string> {
  const find = (needles: string[], exclude: string[] = []) => {
    const name = names.find((n) => {
      const lower = n.toLowerCase();
      return needles.some((needle) => lower.includes(needle)) && !exclude.some((x) => lower.includes(x));
    });
    if (!name) throw new Error(`network output not found: ${needles.join("/")}`);
    return name;
  };
  return {
    wdl: find(["wdl"]),
    movesLeft: find(["moves_left", "movesleft"]),
    policyA: find(["pi_a", "policy_a", "policya"]),
    policyB: find(["pi_b", "policy_b", "policyb"]),
    value: find(["value"]),
  };
}

export { SLOT_IDLE, SLOT_REQUESTED, SLOT_DONE, SLOT_FAILED };
