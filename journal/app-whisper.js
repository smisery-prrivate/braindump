'use strict';
/* Journal: on-device transcription with Whisper. A recording part is decoded here to 16 kHz mono
   and handed to whisper-worker.js; the text comes back. Nothing leaves the phone; the model is
   downloaded once (Hugging Face) and kept in the browser's cache. The transcription queue in
   app-sync.js calls whisperTranscribe() like any other engine. */
const WHISPER_MODELS = {
  base: { id: 'Xenova/whisper-base', label: 'Fast (Whisper base, about 80 MB)', bytes: 85e6 },
  small: { id: 'Xenova/whisper-small', label: 'Better German (Whisper small, about 250 MB, slower)', bytes: 260e6 },
};
const whisperOk = () => typeof WebAssembly === 'object' && typeof Worker === 'function' && typeof (self.OfflineAudioContext || self.webkitOfflineAudioContext) === 'function';
const whisperModel = () => WHISPER_MODELS[settings.whisperModel] || WHISPER_MODELS.base;
const WREADY_KEY = 'journal-whisper-ready';
const whisperCores = () => self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;
const whisperReady = () => { try { return localStorage.getItem(WREADY_KEY + '|' + whisperModel().id) === '1'; } catch (e) { return false; } };

// the last steps, for Menu, Transcription, "Show details": what happened on this phone, to copy and send
const wLog = [];
function wNote(msg) { wLog.push(new Date().toLocaleTimeString() + ' ' + msg); if (wLog.length > 80) wLog.splice(0, wLog.length - 80); }
let wWorker = null, wSeq = 0, wDl = null, wWorking = null;      // wDl: { loaded, total } while the model downloads
const wJobs = new Map();
function whisperWorker() {
  if (wWorker) return wWorker;
  wNote('[app] starting the speech worker · ' + (navigator.userAgent.match(/Android [\d.]+|iPhone OS [\d_]+|Chrome\/[\d]+/g) || []).join(' · ') + ' · model ' + whisperModel().id);
  const w = wWorker = new Worker('whisper-worker.js', { type: 'module' });
  w.onmessage = ({ data: m }) => {
    if (!m) return;
    if (m.type === 'log') { wNote(m.msg); return; }
    if (m.type === 'loading') { wDl = { loaded: 0, total: whisperModel().bytes, net: !!m.net }; whisperStateChanged(); return; }
    if (m.type === 'progress') { wDl = { loaded: Math.max(m.loaded || 0, wDl ? wDl.loaded : 0), total: Math.max(m.total || 0, whisperModel().bytes), net: !!m.net }; whisperStateChanged(); return; }      // the files come one after the other: the figure only ever grows
    if (m.type === 'ready') { wDl = null; try { localStorage.setItem(WREADY_KEY + '|' + m.model, '1'); } catch (e) {} whisperStateChanged(); return; }
    if (m.type === 'loaderror') { wDl = null; toast('The speech model could not be downloaded: ' + m.message); whisperStateChanged(); return; }
    if (m.type === 'working') { wDl = null; wWorking = { id: m.id, at: Date.now() }; whisperStateChanged(); return; }
    const job = wJobs.get(m.id); if (!job) return;
    wJobs.delete(m.id); wWorking = null;
    if (m.type === 'result') job.res({ text: (m.text || '').trim(), language: m.language || '', raw: m.raw || '', secs: m.secs || 0 });
    else job.rej(new Error(m.message || 'the speech model failed'));
    whisperStateChanged();
  };
  w.onerror = ev => { const msg = (ev && ev.message) || 'the speech model could not start'; wNote('[app] worker ERROR: ' + msg + (ev && ev.filename ? ' (' + ev.filename + ':' + ev.lineno + ')' : '')); whisperStop(msg); };
  return w;
}
// stops the worker (and with it any running transcription); the next part starts it afresh
function whisperStop(why) {
  if (wWorker) wNote('[app] worker stopped: ' + (why || ''));
  if (wWorker) { try { wWorker.terminate(); } catch (e) {} wWorker = null; }
  for (const [id, job] of wJobs) { wJobs.delete(id); job.rej(new Error(why || 'stopped')); }
  wDl = null; wWorking = null; whisperStateChanged();
}
let wTick = null;
function whisperStateChanged() {
  if (wWorking && !wTick) wTick = setInterval(() => { if (!wWorking) { clearInterval(wTick); wTick = null; return; } if (typeof curEntry !== 'undefined' && curEntry && typeof renderTxState === 'function') renderTxState(); }, 1000); if (typeof curEntry !== 'undefined' && curEntry && typeof renderTxState === 'function') renderTxState(); if ($('txBox') && typeof renderWhisperState === 'function') renderWhisperState(); }
// what the phone is doing right now, in words, for the recording's status line
function whisperStatus() {
  if (wDl) return wDl.net ? 'Downloading the speech model, once: ' + fmtSize(wDl.loaded || 0) + ' of about ' + fmtSize(wDl.total) + ' (' + Math.min(99, Math.round(100 * (wDl.loaded || 0) / wDl.total)) + ' %). Keep the app open…' : 'Starting the speech model on this phone (it is downloaded already)…';
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

// "Test the speech model": runs it on the newest recording on this phone and logs every step
async function whisperSelfTest() {
  wNote('[app] ---- test started ----');
  const g = live().flatMap(e => (e.segs || []).map(s => ({ e, s }))).sort((a, b) => (b.e.created + b.s.i) - (a.e.created + a.s.i))[0];
  if (!g) { wNote('[app] no recording on this phone yet: only the model is loaded'); whisperPrefetch(); return; }
  const blob = await segBlob(g.e, g.s);
  if (!blob) { wNote('[app] the newest recording is not on this phone'); return; }
  try { const out = await whisperTranscribe(blob, settings.lang); wNote('[app] test result: ' + (out.text ? out.text.length + ' characters' : 'no text') + (out.raw && !out.text ? ', Whisper gave “' + out.raw + '”' : '')); }
  catch (e) { wNote('[app] test FAILED: ' + ((e && e.message) || e)); }
  wNote('[app] ---- test ended ----');
}
// download the model ahead (on wifi, say), without a recording
function whisperPrefetch() { if (!whisperOk() || wDl) return; wDl = { loaded: 0, total: whisperModel().bytes, net: true }; whisperWorker().postMessage({ type: 'load', model: whisperModel().id }); whisperStateChanged(); }
async function whisperTranscribe(blob, lang, signal) {
  if (!whisperOk()) throw new Error('this browser cannot run the speech model');
  let audio; const t = performance.now();
  try { audio = await decode16k(blob); } catch (e) { wNote('[app] decoding FAILED (' + blob.type + ', ' + fmtSize(blob.size) + '): ' + ((e && e.message) || e)); throw new Error('the recording could not be read for transcription'); }
  let peak = 0; for (let i = 0; i < audio.length; i += 8) { const v = Math.abs(audio[i]); if (v > peak) peak = v; }
  wNote('[app] recording decoded in ' + Math.round(performance.now() - t) + ' ms: ' + blob.type + ', ' + fmtSize(blob.size) + ' → ' + (audio.length / 16000).toFixed(1) + ' s at 16 kHz, loudest ' + peak.toFixed(3) + (peak < 0.01 ? ' (that is silence)' : ''));
  if (signal && signal.aborted) throw new Error('stopped');
  return new Promise((res, rej) => {
    const id = ++wSeq; wJobs.set(id, { res, rej });
    if (signal) signal.addEventListener('abort', () => { const job = wJobs.get(id); if (!job) return; wJobs.delete(id); job.rej(new Error('stopped')); if (wWorker) { try { wWorker.postMessage({ type: 'cancel', id }); } catch (e) {} } if (wWorking && wWorking.id === id) { wWorking = null; whisperStateChanged(); } }, { once: true });
    try { whisperWorker().postMessage({ type: 'run', id, model: whisperModel().id, language: lang === 'de' || lang === 'en' ? lang : 'auto', audio, peak }, [audio.buffer]); }
    catch (e) { wJobs.delete(id); rej(e); }
  });
}
