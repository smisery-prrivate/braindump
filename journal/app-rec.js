'use strict';
/* Journal recorder. A memo is recorded in SEGMENTS: every few minutes the recorder is stopped and
   started again on the same microphone stream, so every segment is a complete audio file of its
   own. The moment a segment ends it is encrypted and stored, and transcription of it can start
   while the next segment is still recording. While a segment records, its chunks (every 10 s) are
   stored encrypted as "parts", so a crash or a killed app loses at most ten seconds; the next
   start assembles the parts into a segment. Nothing readable touches the device. */
let recording = false, recFinishing = false, recEntry = null, recStream = null, recorder = null, recSeg = null;
let recStartAt = 0, recPausedAt = 0, recPausedMs = 0, recPaused = false, segTimer = null, recTick = null, segWrites = 0;
let wakeLock = null, audioCtx = null, analyser = null, meterTimer = null, recDiscarding = false;
const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', ''];
const CHUNK_MS = 10000;
const pickMime = () => MIMES.find(m => !m || (self.MediaRecorder && MediaRecorder.isTypeSupported(m))) || '';
const extOf = mime => /mp4|aac|m4a/.test(mime) ? 'm4a' : /ogg/.test(mime) ? 'ogg' : 'webm';
const recElapsed = () => (recPaused ? recPausedAt : Date.now()) - recStartAt - recPausedMs;

// ---------- start ----------
async function startRecording() {
  if (recording || recFinishing || locked || passive || !Vault.isOpen()) return;
  if (!self.MediaRecorder || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { popup('No recorder', 'This browser cannot record audio. Use Chrome or Safari.', [{ label: 'OK', cls: 'primary' }]); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) {
    popup('Microphone', e && e.name === 'NotAllowedError' ? 'Journal has no permission to use the microphone. Allow it in the browser settings for this site.' : 'The microphone could not be started: ' + errText(e), [{ label: 'OK', cls: 'primary' }]);
    return;
  }
  if (recording || locked || passive) { for (const t of stream.getTracks()) t.stop(); return; }
  const mime = pickMime();
  const e = { id: uid(), created: Date.now(), updated_at: Date.now(), title: '', text: '', transcript: '', tEdited: false, lang: settings.lang, segs: [], state: 'rec', dur: 0, deleted: false, tx: settings.transcribe === 'auto', mime };
  entries.unshift(e);
  if (!(await persist(e))) { for (const t of stream.getTracks()) t.stop(); entries.splice(entries.indexOf(e), 1); return; }      // the entry exists before the first byte
  recEntry = e; recStream = stream; recording = true; recPaused = false; recPausedMs = 0; recStartAt = Date.now(); recDiscarding = false;
  stream.getAudioTracks().forEach(t => { t.onended = () => { if (recording && recStream === stream) { toast('The microphone was taken away. The memo is kept.'); stopRecording(); } }; });
  push('rec'); renderRec();
  keepAwake(); startMeter(stream);
  recTick = setInterval(renderRecTime, 250);
  startSegment();
}
function startSegment() {
  if (!recording || !recStream) return;
  const seg = { id: uid(), i: recEntry.segs.length + pendingSegs(), chunks: [], n: 0, start: Date.now(), pausedMs: 0, pausedAt: 0, mime: recEntry.mime, entry: recEntry.id, done: false };
  let r;
  try { r = new MediaRecorder(recStream, seg.mime ? { mimeType: seg.mime, audioBitsPerSecond: 48000 } : { audioBitsPerSecond: 48000 }); }
  catch (e) { try { r = new MediaRecorder(recStream); } catch (e2) { recFailed('The recorder could not be started: ' + errText(e2)); return; } }
  seg.mime = r.mimeType || seg.mime || 'audio/webm'; recEntry.mime = seg.mime;
  recSeg = seg; recorder = r; seg.rec = r;
  r.ondataavailable = ev => {
    if (!ev.data || !ev.data.size) return;
    const n = seg.n++; seg.chunks.push(ev.data);
    if (!recDiscarding) partPut(seg.id, n, ev.data, { entry: seg.entry, i: seg.i, mime: seg.mime }).catch(() => {});      // a crash keeps what was recorded so far
  };
  r.onstop = () => finishSegment(seg);
  r.onerror = ev => { if (recSeg === seg) recFailed('Recording stopped: ' + errText(ev && ev.error)); };
  try { r.start(CHUNK_MS); } catch (e) { recFailed('The recorder could not be started: ' + errText(e)); return; }
  armSegTimer(settings.segMin * 60000);
}
const pendingSegs = () => pendingSegList.length;
const pendingSegList = [];         // segments that have stopped but are not stored yet (their index is already taken)
function armSegTimer(ms) { clearTimeout(segTimer); segTimer = setTimeout(rollSegment, ms); }
// the running segment ends and the next one starts at once on the same stream; the gap is a few milliseconds
function rollSegment() {
  if (!recording || recPaused || !recorder || recorder.state !== 'recording') return;
  const r = recorder, seg = recSeg; recorder = null; recSeg = null;
  pendingSegList.push(seg);
  try { r.stop(); } catch (e) { finishSegment(seg); }
  startSegment();
}
// a stopped segment: its chunks become one file, encrypted and stored; then its parts go
async function finishSegment(seg) {
  if (seg.done) return; seg.done = true;
  const i = pendingSegList.indexOf(seg); if (i >= 0) pendingSegList.splice(i, 1);
  const e = byId(seg.entry) || recEntry;
  if (recDiscarding || !e || e.deleted) { partsDel(seg.id).catch(() => {}); return; }
  const blob = new Blob(seg.chunks, { type: seg.mime }), dur = Math.max(0, Date.now() - seg.start - seg.pausedMs - (seg.pausedAt ? Date.now() - seg.pausedAt : 0));
  if (!blob.size || dur < 300) { partsDel(seg.id).catch(() => {}); return; }
  segWrites++;
  try {
    await segPut(seg.id, blob, { entry: e.id, mime: seg.mime, size: blob.size, dur, i: seg.i });
    e.segs.push({ id: seg.id, i: seg.i, dur, mime: seg.mime, size: blob.size, text: '', st: settings.transcribe === 'off' && !e.tx ? 'off' : 'todo' });
    e.segs.sort((a, b) => a.i - b.i); e.dur = entryDur(e);
    if (await persist(e)) await partsDel(seg.id); else throw new Error('the entry could not be saved');      // the parts stay until the entry names the segment
    if (e.tx) scheduleTranscribe();
  } catch (err) { toast('A part of the recording could not be stored: ' + errText(err)); }
  finally { segWrites--; if (current() === 'entry' && curEntry === e) renderEntry(); renderHome(); }
}

// ---------- pause, stop, discard ----------
function pauseRecording() {
  if (!recording || !recorder) return;
  if (!recPaused) {
    try { recorder.pause(); } catch (e) { return; }
    recPaused = true; recPausedAt = Date.now(); if (recSeg) recSeg.pausedAt = recPausedAt; clearTimeout(segTimer);
  } else {
    try { recorder.resume(); } catch (e) { return; }
    const gap = Date.now() - recPausedAt; recPausedMs += gap; if (recSeg) { recSeg.pausedMs += gap; recSeg.pausedAt = 0; }
    recPaused = false;
    const used = recSeg ? Date.now() - recSeg.start - recSeg.pausedMs : 0;
    armSegTimer(Math.max(2000, settings.segMin * 60000 - used));
  }
  renderRec();
}
async function stopRecording() {
  if (!recording) return;
  recording = false; recFinishing = true; clearTimeout(segTimer); clearInterval(recTick);
  const e = recEntry, r = recorder, seg = recSeg; recorder = null; recSeg = null;
  if (seg) pendingSegList.push(seg);
  const stopped = new Promise(res => { if (!r || r.state === 'inactive') { if (seg) finishSegment(seg); res(); return; } const t = setTimeout(() => { if (seg) finishSegment(seg); res(); }, 4000); r.addEventListener('stop', () => { clearTimeout(t); res(); }, { once: true }); try { r.requestData && r.state === 'recording' && r.requestData(); } catch (err) {} try { r.stop(); } catch (err) { clearTimeout(t); if (seg) finishSegment(seg); res(); } });
  stopMeter(); releaseWake();
  await stopped;
  while (segWrites > 0 || pendingSegList.length) await sleep(50);
  if (recStream) { for (const t of recStream.getTracks()) { try { t.stop(); } catch (err) {} } }
  recStream = null; recEntry = null; recFinishing = false;
  const kept = e && !e.deleted && !recDiscarding && e.segs.length > 0;
  if (e && !e.deleted) {
    if (!kept) { e.deleted = true; e.del_at = Date.now(); await persist(e); if (!recDiscarding) toast('Nothing was recorded.'); }
    else { e.state = 'done'; e.dur = entryDur(e); await persist(e); }
  }
  recDiscarding = false;
  closeScreen('rec');
  if (kept) afterPop(() => {
    openEntry(e);
    if (!e.tx && settings.transcribe === 'ask' && e.segs.some(g => g.st === 'todo')) askTranscribe(e);
  });
  renderHome();
}
function discardRecording() {
  if (!recording) return;
  popup('Discard this recording?', 'What was recorded so far is deleted. This cannot be undone.', [
    { label: 'Discard', cls: 'danger', fn: async () => { if (!recording) return; const e = recEntry; recDiscarding = true; await stopRecording(); if (e) purgeEntryData(e).catch(() => {}); toast('Recording discarded'); } },
    { label: 'Keep recording', cls: 'quiet' }]);
}
function recFailed(msg) { toast(msg); if (recording) stopRecording(); }
function leaveRec() { if (recording) stopRecording(); }

// ---------- screen ----------
function renderRec() {
  $('recState').textContent = recPaused ? 'Paused' : 'Recording';
  $('recDot').classList.toggle('paused', recPaused);
  $('recPause').textContent = recPaused ? 'Resume' : 'Pause';
  renderRecTime();
}
function renderRecTime() {
  if (!recording) return;
  $('recTime').textContent = fmtDur(recElapsed());
  const n = recEntry ? recEntry.segs.length : 0;
  $('recInfo').textContent = (n ? n + ' part' + (n > 1 ? 's' : '') + ' stored encrypted · ' : '') + 'a part is stored every ' + settings.segMin + ' min' + (wakeLock ? ' · screen stays on' : ' · keep the screen on');
}
$('recPause').addEventListener('click', pauseRecording);
$('recStop').addEventListener('click', () => stopRecording());
$('recDiscard').addEventListener('click', discardRecording);
$('recBtn').addEventListener('click', () => startRecording());

// ---------- screen wake lock and level meter ----------
async function keepAwake() { try { if (navigator.wakeLock && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { wakeLock = null; } }
function releaseWake() { if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; } }
function startMeter(stream) {
  const box = $('meter'); box.innerHTML = ''; const bars = [];
  for (let i = 0; i < 28; i++) { const b = document.createElement('i'); box.appendChild(b); bars.push(b); }
  try {
    audioCtx = new (self.AudioContext || self.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream); analyser = audioCtx.createAnalyser(); analyser.fftSize = 256; src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    meterTimer = setInterval(() => {
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length), level = recPaused ? 0 : Math.min(1, rms * 4);
      for (let i = 0; i < bars.length; i++) { const w = Math.sin((i + 1) / (bars.length + 1) * Math.PI); bars[i].style.height = Math.max(6, 6 + level * w * 44 * (0.7 + Math.random() * 0.3)) + 'px'; }
    }, 90);
  } catch (e) { analyser = null; }
}
function stopMeter() { clearInterval(meterTimer); meterTimer = null; analyser = null; if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; } }
document.addEventListener('visibilitychange', () => { if (!document.hidden && recording) keepAwake(); });

// ---------- recovery: a recording the app did not finish ----------
// Parts of a segment that never became a file (the app was killed while recording) are assembled
// into a segment now; an entry left "recording" is closed; an entry without any audio goes.
async function recoverRecordings() {
  const keys = await idb.keys('parts'), bySeg = new Map();
  for (const k of keys) { if (typeof k !== 'string') continue; const seg = k.slice(0, k.indexOf('|')); if (!bySeg.has(seg)) bySeg.set(seg, []); bySeg.get(seg).push(k); }
  for (const [seg, ks] of bySeg) {
    ks.sort();
    try {
      if (await segHas(seg)) { for (const k of ks) await idb.del('parts', k); continue; }      // stored already; only the clean-up was missed
      const blobs = []; let meta = null;
      for (const k of ks) { const r = await idb.get('parts', k); if (!r) continue; const m = await Vault.openJson(r.m, pLabel(seg, +k.slice(k.indexOf('|') + 1)) + '|m'); meta = meta || m; blobs.push(await Vault.openBlob(r.data, pLabel(seg, m.n), m.mime)); }
      const e = meta && byId(meta.entry);
      if (!e || e.deleted || !blobs.length) { for (const k of ks) await idb.del('parts', k); continue; }
      const blob = new Blob(blobs, { type: meta.mime }), dur = await blobDuration(blob).catch(() => 0) || blobs.length * CHUNK_MS;
      await segPut(seg, blob, { entry: e.id, mime: meta.mime, size: blob.size, dur, i: meta.i });
      if (!e.segs.some(g => g.id === seg)) { e.segs.push({ id: seg, i: meta.i, dur, mime: meta.mime, size: blob.size, text: '', st: settings.transcribe === 'off' && !e.tx ? 'off' : 'todo', recovered: true }); e.segs.sort((a, b) => a.i - b.i); }
      e.dur = entryDur(e); e.state = 'done';
      if (await persist(e)) for (const k of ks) await idb.del('parts', k);
      toast('A recording that was cut off was recovered.');
    } catch (err) {}
  }
  for (const e of entries.slice()) {
    if (e.broken || e.deleted || e.state !== 'rec') continue;
    if (!e.segs.length) { e.deleted = true; e.del_at = Date.now(); } else { e.state = 'done'; e.dur = entryDur(e); }
    await persist(e);
  }
}
// the length of an audio file, read by the browser (a recovered segment has no stamp of its own)
function blobDuration(blob) {
  return new Promise((res, rej) => {
    const a = new Audio(), url = URL.createObjectURL(blob); let done = false;
    const fin = v => { if (done) return; done = true; URL.revokeObjectURL(url); v instanceof Error ? rej(v) : res(v); };
    a.preload = 'metadata';
    a.onloadedmetadata = () => { if (a.duration === Infinity || isNaN(a.duration)) { a.currentTime = 1e9; a.ontimeupdate = () => { a.ontimeupdate = null; fin(a.duration === Infinity ? 0 : a.duration * 1000); }; } else fin(a.duration * 1000); };
    a.onerror = () => fin(new Error('no metadata'));
    setTimeout(() => fin(new Error('timeout')), 4000);
    a.src = url;
  });
}
