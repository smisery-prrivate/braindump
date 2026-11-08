# Vendored for on-device transcription (Whisper)

Served from the app's own origin, so no script is ever loaded from a third-party server at run
time. Only the speech model's weights (data, not code) are fetched from Hugging Face, once, and
kept in the browser's cache.

| File | From | Version | SHA-256 |
|---|---|---|---|
| transformers.min.js | npm `@huggingface/transformers` dist, one name changed (below) | 4.3.2 | 57f66b1d81eb3d83d36936e78c64427d2f18978dce058ac6270cc70c949477a3 |
| ort-wasm-simd-threaded.asyncify.mjs | npm `onnxruntime-web` dist | 1.31.0-dev.20260914-8d85527a0 | 0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611 |
| ort-wasm-simd-threaded.asyncify.wasm | npm `onnxruntime-web` dist | 1.31.0-dev.20260914-8d85527a0 | 49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082 |

One change to the original file (SHA-256 of the unchanged npm file:
8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb), made at the owner's request: the
class name `Mistral3ForConditionalGeneration` (3 places) reads `Mistral3ForCondGeneration`. The
original name is exactly 32 characters and contains "Mistral", so GitHub's secret scanning took it
for a Mistral API key (a false positive: there is no key) and refused the push. It names a model
class this app never loads; all three places are renamed alike. No other byte differs.

The onnxruntime-web version is the one `@huggingface/transformers@4.3.2` depends on and bundles.
Licences: Transformers.js, Apache-2.0 (LICENSE-transformers); ONNX Runtime, MIT (LICENSE-onnxruntime).
To update: install the new versions from npm, copy the same three files into a new folder named
after the version, update the hashes here and the folder name in `whisper-worker.js`.
