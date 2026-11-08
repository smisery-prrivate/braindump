// Journal: speech to text on the phone itself (Whisper), in a worker so the app stays responsive.
// The library and its runtime come from this app's own folder (vendor/); only the model's
// weights are fetched once from Hugging Face and kept in the browser's cache. The audio never
// leaves the phone.
import { pipeline, env, Tensor } from './vendor/transformers-4.3.2/transformers.min.js';

const V = new URL('./vendor/transformers-4.3.2/', import.meta.url).href;
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = { mjs: V + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: V + 'ort-wasm-simd-threaded.asyncify.wasm' };
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

let asr = null, asrModel = '', loading = null;
const say = m => self.postMessage(m);

async function load(model) {
  if (asr && asrModel === model) return asr;
  if (loading && loading.model === model) return loading.p;
  const p = (async () => {
    if (asr) { try { await asr.dispose(); } catch (e) {} asr = null; asrModel = ''; }
    const files = new Map();                                  // file -> [loaded, total], for one progress figure
    const a = await pipeline('automatic-speech-recognition', model, {
      device: 'wasm',
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      progress_callback: ev => {
        if (!ev || !ev.file) return;
        if (ev.status === 'progress' || ev.status === 'download' || ev.status === 'initiate') {
          const prev = files.get(ev.file) || [0, 0];
          files.set(ev.file, [ev.loaded != null ? ev.loaded : prev[0], ev.total != null ? ev.total : prev[1]]);
        } else if (ev.status === 'done') { const prev = files.get(ev.file); if (prev) files.set(ev.file, [prev[1] || prev[0], prev[1] || prev[0]]); }
        let got = 0, all = 0; for (const [l, t] of files.values()) { got += l || 0; all += t || 0; }
        say({ type: 'progress', loaded: got, total: all });
      },
    });
    asr = a; asrModel = model; say({ type: 'ready', model });
    return a;
  })();
  loading = { model, p };
  try { return await p; } finally { if (loading && loading.p === p) loading = null; }
}

// Transformers.js does not detect the language itself (it would assume English): Whisper is asked
// once, on the first 30 seconds, whether this is German or English.
async function detect(a, audio) {
  try {
    const cfg = a.model.generation_config, ids = cfg.lang_to_id || {};
    const de = ids['<|de|>'], en = ids['<|en|>'];
    if (de == null || en == null) return 'de';
    const feats = await a.processor(audio.subarray(0, 16000 * 30));
    const start = new Tensor('int64', BigInt64Array.of(BigInt(cfg.decoder_start_token_id)), [1, 1]);
    const out = await a.model({ ...feats, decoder_input_ids: start });
    const L = out.logits.data, n = out.logits.dims[out.logits.dims.length - 1], off = L.length - n;
    return L[off + de] >= L[off + en] ? 'de' : 'en';
  } catch (e) { return 'de'; }
}

// Whisper invents a few stock phrases over silence (subtitle credits from its training data)
const JUNK = [/untertitel(ung)? (der|von|im auftrag)[^.!?\n]*[.!?]?/gi, /amara\.org[^.!?\n]*[.!?]?/gi, /\b(thanks|thank you) for watching[.!]?/gi, /vielen dank f(ü|ue)rs zuschauen[.!]?/gi];
const ONLY_JUNK = /^(vielen dank\.?|danke\.?|thank you\.?|you|\.+|…)$/i;
function clean(t) {
  let s = String(t || '');
  for (const r of JUNK) s = s.replace(r, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return ONLY_JUNK.test(s) ? '' : s;
}

self.onmessage = async ({ data: m }) => {
  if (m && m.type === 'load') { try { await load(m.model); } catch (e) { say({ type: 'loaderror', message: why(e) }); } return; }
  if (!m || m.type !== 'run') return;
  try {
    const a = await load(m.model);
    const audio = m.audio;
    if (!audio || audio.length < 16000 * 0.3) { say({ type: 'result', id: m.id, text: '', language: '' }); return; }
    const language = m.language === 'de' || m.language === 'en' ? m.language : await detect(a, audio);
    say({ type: 'working', id: m.id, language });
    const out = await a(audio, { language, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5, return_timestamps: false });
    const text = Array.isArray(out) ? out.map(o => o.text).join(' ') : out && out.text;
    say({ type: 'result', id: m.id, text: clean(text), language });
  } catch (e) { say({ type: 'error', id: m.id, message: why(e) }); }
};
// a failed download says so in plain words; anything else as it came
function why(e) {
  const msg = String((e && e.message) || e || 'unknown error');
  if (/failed to fetch|networkerror|load failed|could not locate file|err_internet|err_network/i.test(msg)) return 'the speech model could not be downloaded; is the phone online?';
  return msg.slice(0, 300);
}
