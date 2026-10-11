cmake_minimum_required(VERSION 3.16)

# WebAssembly build of the hivemind engine. Configure with emcmake and point
# HIVEMIND_ROOT at a hivemind checkout (see build.sh).
project(hivemind_web LANGUAGES CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure this project with emcmake")
endif()

set(HIVEMIND_ROOT "" CACHE PATH "Path to the hivemind repository")
set(HIVEMIND_WEB_SEARCH_THREADS 1 CACHE STRING "Search workers per engine instance")
if(NOT EXISTS "${HIVEMIND_ROOT}/engine/src/interface/uci.cc")
    message(FATAL_ERROR "HIVEMIND_ROOT must point at a hivemind checkout")
endif()

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(HM_SRC "${HIVEMIND_ROOT}/engine/src")
set(FS_SRC "${HM_SRC}/Fairy-Stockfish/src")

set(COMMON_FLAGS -O3 -msimd128 -pthread -fwasm-exceptions)
set(COMMON_DEFINITIONS
    NDEBUG NNUE_EMBEDDING_OFF IS_64BIT USE_POPCNT
    HIVEMIND_BACKEND_WEB
    HIVEMIND_NUM_SEARCH_THREADS=${HIVEMIND_WEB_SEARCH_THREADS})

add_library(fairy STATIC
    ${FS_SRC}/bitbase.cpp
    ${FS_SRC}/bitboard.cpp
    ${FS_SRC}/endgame.cpp
    ${FS_SRC}/evaluate.cpp
    ${FS_SRC}/material.cpp
    ${FS_SRC}/misc.cpp
    ${FS_SRC}/movegen.cpp
    ${FS_SRC}/movepick.cpp
    ${FS_SRC}/parser.cpp
    ${FS_SRC}/pawns.cpp
    ${FS_SRC}/piece.cpp
    ${FS_SRC}/position.cpp
    ${FS_SRC}/psqt.cpp
    ${FS_SRC}/stubs.cpp
    ${FS_SRC}/search.cpp
    ${FS_SRC}/thread.cpp
    ${FS_SRC}/timeman.cpp
    ${FS_SRC}/tt.cpp
    ${FS_SRC}/tune.cpp
    ${FS_SRC}/uci.cpp
    ${FS_SRC}/ucioption.cpp
    ${FS_SRC}/variant.cpp
)
target_compile_options(fairy PRIVATE ${COMMON_FLAGS} -w)
target_compile_definitions(fairy PRIVATE ${COMMON_DEFINITIONS})

add_executable(hivemind
    ${CMAKE_CURRENT_SOURCE_DIR}/src/web_main.cc
    ${CMAKE_CURRENT_SOURCE_DIR}/src/engine_web.cc
    ${HM_SRC}/common/globals.cc
    ${HM_SRC}/environment/board.cc
    ${HM_SRC}/environment/planes.cc
    ${HM_SRC}/environment/zobrist.cc
    ${HM_SRC}/nn/onnx_utils.cc
    ${HM_SRC}/search/agent.cc
    ${HM_SRC}/search/single_board.cc
    ${HM_SRC}/search/alphabeta.cc
    ${HM_SRC}/nnue/network.cc
    ${HM_SRC}/search/mate_probe.cc
    ${HM_SRC}/search/node.cc
    ${HM_SRC}/search/searchthread.cc
    ${HM_SRC}/interface/uci.cc
)
target_include_directories(hivemind PRIVATE ${HM_SRC})
target_compile_options(hivemind PRIVATE ${COMMON_FLAGS} -Wall -Wno-unused-function -Wno-unused-variable)
target_compile_definitions(hivemind PRIVATE ${COMMON_DEFINITIONS})
target_link_libraries(hivemind PRIVATE fairy)

set(HIVEMIND_LINK_FLAGS
    -O3
    -pthread
    -fwasm-exceptions
    -sPROXY_TO_PTHREAD=1
    -sPTHREAD_POOL_SIZE=16
    -sPTHREAD_POOL_SIZE_STRICT=0
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=268435456
    -sMAXIMUM_MEMORY=4294967296
    -sSTACK_SIZE=8388608
    -sDEFAULT_PTHREAD_STACK_SIZE=4194304
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createHivemind
    -sENVIRONMENT=web,worker,node
    -sEXIT_RUNTIME=0
    -sEXPORTED_FUNCTIONS=_main,_hm_command,_hm_inference_registry,_hm_search_threads_per_engine
    -sEXPORTED_RUNTIME_METHODS=FS,wasmMemory,ccall,cwrap,UTF8ToString,stringToNewUTF8
)
target_link_options(hivemind PRIVATE ${HIVEMIND_LINK_FLAGS})
set_target_properties(hivemind PROPERTIES SUFFIX ".js")
