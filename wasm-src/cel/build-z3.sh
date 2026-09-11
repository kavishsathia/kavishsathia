#!/usr/bin/env bash
# Builds a single-threaded Z3 4.14.1 wasm for the CEL verifier page.
#
# Why not the z3-solver npm build the other tools use? That one is compiled
# with pthreads, which needs SharedArrayBuffer and therefore a cross-origin-
# isolated page — and CheerpJ's runtime loads a helper iframe from its CDN that
# COEP would block. A thread-less build needs no isolation. Timeouts still
# work through Z3's polling timer (POLLING_TIMER), which piggybacks on the
# resource-limit checks the solver already performs.
#
# usage: build-z3.sh <z3 source dir at tag z3-4.14.1> <emsdk dir> <out dir>
set -euo pipefail
Z3_SRC=$1; EMSDK=$2; OUT=$3
HERE=$(cd "$(dirname "$0")" && pwd)
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1

mkdir -p "$Z3_SRC/build-wasm"
cd "$Z3_SRC/build-wasm"
if [ ! -f Makefile ]; then
  emcmake cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DZ3_SINGLE_THREADED=ON \
    -DZ3_POLLING_TIMER=ON \
    -DZ3_BUILD_LIBZ3_SHARED=OFF \
    -DZ3_BUILD_EXECUTABLE=OFF \
    -DZ3_BUILD_TEST_EXECUTABLES=OFF \
    -DZ3_ENABLE_EXAMPLE_TARGETS=OFF \
    -DZ3_BUILD_PYTHON_BINDINGS=OFF \
    -DZ3_BUILD_JAVA_BINDINGS=OFF \
    -DZ3_BUILD_DOTNET_BINDINGS=OFF \
    -DZ3_BUILD_DOCUMENTATION=OFF \
    -DZ3_INCLUDE_GIT_HASH=OFF \
    -DZ3_INCLUDE_GIT_DESCRIBE=OFF \
    -DCMAKE_CXX_FLAGS="-fwasm-exceptions" \
    -DCMAKE_C_FLAGS="-fwasm-exceptions"
fi
emmake make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" libz3

# Every def_API entry point, plus malloc/free and the shim.
node -e '
const t = require(process.argv[1]);
const fns = ["_malloc", "_free", "_cel_set_noop_error_handler", ...t.map(e => "_" + e.c)];
require("fs").writeFileSync("exported.json", JSON.stringify(fns));
' "$HERE/../../src/lib/cel/z3natives.json"

mkdir -p "$OUT"
em++ "$HERE/z3-shim.cpp" libz3.a -O2 -fwasm-exceptions \
  -I "$Z3_SRC/src/api" \
  -s WASM_BIGINT=1 \
  -s MODULARIZE=1 \
  -s 'EXPORT_NAME="initZ3Cel"' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s MAXIMUM_MEMORY=4GB \
  -s INITIAL_MEMORY=128MB \
  -s STACK_SIZE=32MB \
  -s EXPORTED_FUNCTIONS=@exported.json \
  -s 'EXPORTED_RUNTIME_METHODS=["ccall","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAP8","HEAPU8","HEAP32","HEAPU32","HEAP64","HEAPU64","HEAPF64","wasmMemory"]' \
  -o "$OUT/z3-cel.js"
ls -la "$OUT"
