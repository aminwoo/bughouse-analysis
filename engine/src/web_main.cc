// WebAssembly entry point for the hivemind engine.
//
// Runs under -sPROXY_TO_PTHREAD: main() lives on a pthread, so it may block on
// the command queue while the worker that loaded the module stays free to
// receive messages, spawn pthreads and print. JavaScript pushes UCI commands
// with hm_command(); output goes through std::cout as usual.

#include <emscripten/emscripten.h>

#include <condition_variable>
#include <deque>
#include <iostream>
#include <mutex>
#include <numeric>
#include <sstream>
#include <string>
#include <vector>

#include "common/globals.h"
#include "interface/uci.h"
#include "search/node.h"
#include "search/search_params.h"

namespace {

std::mutex g_queueMutex;
std::condition_variable g_queueReady;
std::deque<std::string> g_queue;

std::string next_command() {
    std::unique_lock<std::mutex> lock(g_queueMutex);
    g_queueReady.wait(lock, [] { return !g_queue.empty(); });
    std::string command = std::move(g_queue.front());
    g_queue.pop_front();
    return command;
}

void dispatch(UCI& uci, const std::string& command) {
    std::istringstream is(command);
    std::string token;
    is >> std::skipws >> token;
    try {
        if (token == "uci") uci.send_uci_response();
        else if (token == "isready") std::cout << "readyok" << std::endl;
        else if (token == "go") uci.go(is);
        else if (token == "ponderhit") uci.ponderhit();
        else if (token == "setoption") uci.setoption(is);
        else if (token == "position") uci.position(is);
        else if (token == "ucinewgame") uci.new_game();
        else if (token == "stop") uci.stop();
        else if (token == "policy") uci.policy();
        else if (token == "livenodes") {
            std::cout << "info string livenodes " << Node::live_count() << std::endl;
        }
    } catch (const std::exception& error) {
        uci.stop();
        std::cout << "info string " << token << " failed: " << error.what() << std::endl;
    } catch (...) {
        uci.stop();
        std::cout << "info string " << token << " failed: unknown exception" << std::endl;
    }
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void hm_command(const char* command) {
    {
        std::lock_guard<std::mutex> lock(g_queueMutex);
        g_queue.emplace_back(command ? command : "");
    }
    g_queueReady.notify_one();
}

EMSCRIPTEN_KEEPALIVE int hm_search_threads_per_engine() {
    return SearchParams::NUM_SEARCH_THREADS;
}

}  // extern "C"

int main(int argc, char* argv[]) {
    std::string modelPath = "/model.onnx";
    int engines = 1;
    int batchSize = SearchParams::BATCH_SIZE;
    for (int i = 1; i + 1 < argc; i += 2) {
        const std::string option = argv[i];
        const std::string value = argv[i + 1];
        if (option == "--model") modelPath = value;
        else if (option == "--engines") engines = std::max(1, std::stoi(value));
        else if (option == "--batch-size") batchSize = std::max(1, std::stoi(value));
    }

    init_fairy_stockfish();
    init_policy_index();

    UCI uci;
    std::vector<int> deviceIds(static_cast<size_t>(engines));
    std::iota(deviceIds.begin(), deviceIds.end(), 0);
    if (!uci.initializeEngines(deviceIds, modelPath, batchSize)) {
        std::cout << "info string failed to initialize inference" << std::endl;
        return 1;
    }
    std::cout << "info string hivemind web ready" << std::endl;

    for (;;) {
        const std::string command = next_command();
        if (command == "quit") break;
        dispatch(uci, command);
    }
    uci.stop();
    return 0;
}
