'use strict';
/* Journal: on-device transcription with Whisper. A recording part is decoded here to 16 kHz mono
   and handed to whisper-worker.js; the text comes back. Nothing leaves the phone; the model is
   downloaded once (Hugging Face) and kept in the browser's cache. The transcription queue in
   app-sync.js calls whisperTranscribe() like any other engine. */
const WHISPER_MODELS = {
  base: { id: 'Xenova/whisper-base', label: 'Fast (Whisper base, about 80 MB)' },
  small: { id: 'Xenova/whisper-small', label: 'Better German (Whisper small, about 250 MB, slower)' },
};
const whisperOk = () => typeof WebAssembly === 'object' && typeof Worker === 'function' && typeof (self.OfflineAudioContext || self.webkitOfflineAudioContext) === 'function';
const whisperModel = () => WHISPER_MODELS[settings.whisperModel] || WHISPER_MODELS.base;
const WREADY_KEY = 'journal-whisper-ready';
const whisperReady = () => { try { return localStorage.getItem(WREADY_KEY + '|' + whisperModel().id) === '1'; } catch (e) { return false; } };

let wWorker = null, wSeq = 0, wDl = null, wWorking = null;      // wDl: { loaded, total } while the model downloads
const wJobs = new Map();
function whisperWorker() {
  if (wWorker) return wWorker;
  const w = wWorker = new Worker('whisper-worker.js', { type: 'module' });
  w.onmessage = ({ data: m }) => {
    if (!m) return;
    if (m.type === 'progress') { wDl = { loaded: m.loaded, total: m.total }; whisperStateChanged(); return; }
    if (m.type === 'ready') { wDl = null; try { localStorage.setItem(WREADY_KEY + '|' + m.model, '1'); } catch (e) {} whisperStateChanged(); return; }
    if (m.type === 'loaderror') { wDl = null; toast('The speech model could not be downloaded: ' + m.message); whisperStateChanged(); return; }
    if (m.type === 'working') { wDl = null; wWorking = { id: m.id, at: Date.now() }; whisperStateChanged(); return; }
    const job = wJobs.get(m.id); if (!job) return;
    wJobs.delete(m.id); wWorking = null;
    if (m.type === 'result') job.res({ text: (m.text || '').trim(), language: m.language || '' });
    else job.rej(new Error(m.message || 'the speech model failed'));
    whisperStateChanged();
  };
  w.onerror = ev => { const msg = (ev && ev.message) || 'the speech model could not start'; whisperStop(msg); };
  return w;
}
// stops the worker (and with it any running transcription); the next part starts it afresh
function whisperStop(why) {
  if (wWorker) { try { wWorker.terminate(); } catch (e) {} wWorker = null; }
  for (const [id, job] of wJobs) { wJobs.delete(id); job.rej(new Error(why || 'stopped')); }
  wDl = null; wWorking = null; whisperStateChanged();
}
let wTick = null;
function whisperStateChanged() {
  if (wWorking && !wTick) wTick = setInterval(() => { if (!wWorking) { clearInterval(wTick); wTick = null; return; } if (typeof curEntry !== 'undefined' && curEntry && typeof renderTxState === 'function') renderTxState(); }, 1000); if (typeof curEntry !== 'undefined' && curEntry && typeof renderTxState === 'function') renderTxState(); if ($('txBox') && typeof renderWhisperState === 'function') renderWhisperState(); }
// what the phone is doing right now, in words, for the recording's status line
function whisperStatus() {
  if (wDl) return 'Downloading the speech model, once: ' + (wDl.total ? Math.round(100 * wDl.loaded / wDl.total) + ' %' : fmtSize(wDl.loaded || 0)) + '…';
  if (wWorking) return 'Writing the text on this phone… ' + fmtDur(Date.now() - wWorking.at);
  return '';
}

// the recording (WebM/Opus or MP4/AAC) as 16 kHz mono samples, the form Whisper takes
async function decode16k(blob) {
  const OAC = self.OfflineAudioContext || self.webkitOfflineAudioContext;
  const buf = await blob.arrayBuffer();
  const dec = await new Promise((res, rej) => { const c = new OAC(1, 16000, 16000); const p = c.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  const n = Math.max(1, Math.ceil(dec.duration * 16000));
  const ctx = new OAC(1, n, 16000), src = ctx.createBufferSource();
  src.buffer = dec; src.connect(ctx.destination); src.start(0);
  const out = await ctx.startRendering();
  return out.getChannelData(0).slice(0);
}

// download the model ahead (on wifi, say), without a recording
function whisperPrefetch() { if (!whisperOk() || whisperReady()) return; wDl = { loaded: 0, total: 0 }; whisperWorker().postMessage({ type: 'load', model: whisperModel().id }); whisperStateChanged(); }
async function whisperTranscribe(blob, lang, signal) {
  if (!whisperOk()) throw new Error('this browser cannot run the speech model');
  let audio;
  try { audio = await decode16k(blob); } catch (e) { throw new Error('the recording could not be read for transcription'); }
  if (signal && signal.aborted) throw new Error('stopped');
  return new Promise((res, rej) => {
    const id = ++wSeq; wJobs.set(id, { res, rej });
    if (signal) signal.addEventListener('abort', () => { if (wJobs.has(id)) whisperStop('stopped'); }, { once: true });
    try { whisperWorker().postMessage({ type: 'run', id, model: whisperModel().id, language: lang === 'de' || lang === 'en' ? lang : 'auto', audio }, [audio.buffer]); }
    catch (e) { wJobs.delete(id); rej(e); }
  });
}
