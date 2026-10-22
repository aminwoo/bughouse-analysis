#!/usr/bin/env bash
# Builds the hivemind engine to WebAssembly and copies the result, plus a
# fallback copy of the network, into public/engine.
#
#   engine/build.sh                     # clone hivemind at the pinned commit
#   HIVEMIND_ROOT=~/hivemind engine/build.sh   # use an existing checkout
#
# engine/patches/*.patch are applied to the pinned checkout; an existing
# checkout must already contain them.
#
# Requires an activated Emscripten SDK (source emsdk_env.sh) and Python 3
# with `onnx` for the one-off FP16 -> FP32 network conversion.
set -euo pipefail

HIVEMIND_REPO="https://github.com/aminwoo/hivemind.git"
HIVEMIND_COMMIT="9c214e10288154b1e4d31b5dbb87b403ec76ae3a"
NETWORK_REPO="aminwoo/bughouse-twin-s-clock"
NETWORK_FILE="twin-s-clock.onnx"

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$ENGINE_DIR")"
CACHE_DIR="$ENGINE_DIR/.cache"
BUILD_DIR="$ENGINE_DIR/build"
OUT_DIR="$ROOT_DIR/public/engine"
mkdir -p "$CACHE_DIR" "$OUT_DIR"

if ! command -v emcmake >/dev/null; then
    echo "emcmake not found: source emsdk_env.sh first" >&2
    exit 1
fi

# Changes the site needs on top of HIVEMIND_COMMIT (see each file's header).
PATCHES=("$ENGINE_DIR"/patches/*.patch)

if [[ -z "${HIVEMIND_ROOT:-}" ]]; then
    HIVEMIND_ROOT="$CACHE_DIR/hivemind"
    if [[ ! -d "$HIVEMIND_ROOT/.git" ]]; then
        git clone --filter=blob:none "$HIVEMIND_REPO" "$HIVEMIND_ROOT"
    fi
    git -C "$HIVEMIND_ROOT" fetch --quiet origin
    # This checkout belongs to the build: reset it, then apply the patches.
    git -C "$HIVEMIND_ROOT" checkout --quiet --force "$HIVEMIND_COMMIT"
    for patch in "${PATCHES[@]}"; do
        # A newer commit may have moved the patched lines; a three-way apply
        # still takes the patch when its change does not conflict.
        git -C "$HIVEMIND_ROOT" apply "$patch" 2>/dev/null \
            || git -C "$HIVEMIND_ROOT" apply --3way "$patch"
    done
else
    # Never modify a checkout we were pointed at; only check it has the patches.
    for patch in "${PATCHES[@]}"; do
        if ! git -C "$HIVEMIND_ROOT" apply --reverse --check "$patch" 2>/dev/null; then
            echo "$HIVEMIND_ROOT lacks $(basename "$patch"); apply it with:" >&2
            echo "  git -C $HIVEMIND_ROOT apply $patch" >&2
            exit 1
        fi
    done
fi
echo "hivemind: $HIVEMIND_ROOT ($(git -C "$HIVEMIND_ROOT" rev-parse --short HEAD) + ${#PATCHES[@]} patches)"

emcmake cmake -S "$ENGINE_DIR" -B "$BUILD_DIR" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DHIVEMIND_ROOT="$HIVEMIND_ROOT"
cmake --build "$BUILD_DIR" -j "$(nproc)"

cp "$BUILD_DIR/hivemind.js" "$BUILD_DIR/hivemind.wasm" "$OUT_DIR/"

# Saved reviews are keyed on the engine build, so a new engine reviews games
# again while a rebuild of the same engine keeps them.
cat > "$ROOT_DIR/src/engine/engineBuild.ts" <<EOF
// Written by engine/build.sh: the hivemind commit and a hash of hivemind.wasm.
export const ENGINE_BUILD = {
  hivemind: "$(git -C "$HIVEMIND_ROOT" rev-parse HEAD)",
  wasm: "$(sha256sum "$OUT_DIR/hivemind.wasm" | cut -c1-16)",
} as const;
EOF

# The site downloads the newest network from Hugging Face at run time
# (src/engine/network.ts). The copy here is the fallback for when Hugging Face
# is unreachable: the current twin-s-clock.onnx, converted to FP32 like the
# browser does, with its sha256 in twin-s.json.
NETWORK_FP16="$CACHE_DIR/$NETWORK_FILE"
NETWORK_FP32="$OUT_DIR/twin-s.onnx"
NETWORK_META="$OUT_DIR/twin-s.json"
read -r NETWORK_COMMIT NETWORK_SHA256 < <(
    curl -fsSL "https://huggingface.co/api/models/$NETWORK_REPO?blobs=true" | python3 -c '
import json, sys
repo = json.load(sys.stdin)
file = next(s for s in repo["siblings"] if s["rfilename"] == sys.argv[1])
print(repo["sha"], file["lfs"]["sha256"])' "$NETWORK_FILE"
)
if [[ ! -f "$NETWORK_FP32" ]] || ! grep -q "$NETWORK_SHA256" "$NETWORK_META" 2>/dev/null; then
    curl -fL -o "$NETWORK_FP16" "https://huggingface.co/$NETWORK_REPO/resolve/$NETWORK_COMMIT/$NETWORK_FILE"
    echo "$NETWORK_SHA256  $NETWORK_FP16" | sha256sum -c -
    python3 "$HIVEMIND_ROOT/engine/scripts/convert_onnx_fp32.py" "$NETWORK_FP16" "$NETWORK_FP32"
    printf '{ "id": "%s", "commit": "%s" }\n' "$NETWORK_SHA256" "$NETWORK_COMMIT" > "$NETWORK_META"
fi
echo "network: $NETWORK_FILE ${NETWORK_SHA256:0:7} (commit ${NETWORK_COMMIT:0:7})"
ls -la "$OUT_DIR"
