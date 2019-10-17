rm -rf libffmpeg.wasm libffmpeg.js
export TOTAL_MEMORY=67108864
export EXPORTED_FUNCTIONS="[ \
    '_initDecoder', \
    '_uninitDecoder', \
    '_openDecoder', \
    '_closeDecoder', \
    '_sendData', \
    '_decodeOnePacket', \
    '_seekTo', \
    '_main'
]"

echo "Running Emscripten..."
emcc decoder.c dist/lib/libavformat.a dist/lib/libavcodec.a dist/lib/libavutil.a dist/lib/libswscale.a \
    -O3 \
    -I "dist/include" \
    -s WASM=1 \
    -s TOTAL_MEMORY=${TOTAL_MEMORY} \
    -s EXPORTED_FUNCTIONS="${EXPORTED_FUNCTIONS}" \
    -s EXTRA_EXPORTED_RUNTIME_METHODS="['addFunction']" \
    -s RESERVED_FUNCTION_POINTERS=14 \
    -s FORCE_FILESYSTEM=1 \
    -o libffmpeg.js

echo "Finished Build"
