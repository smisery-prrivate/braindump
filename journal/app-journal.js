'use strict';
/* Journal screens: the list of days and entries, the entry view with its player and transcript,
   typed notes, search, delete with undo, sharing the text. */
let curEntry = null, searchQ = '', pendingDel = new Set(), curFolder = '';      // curFolder: '' = all entries
const player = { e: null, i: -1, urls: new Map(), audio: null, rate: 1, seeking: false, loading: false, want: false };

// ---------- home ----------
function matches(e, q) {
  if (!q) return true;
  const hay = ((e.title || '') + '\n' + entryText(e)).toLowerCase();
  return q.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
}
function snippet(e) {
  const t = entryText(e).trim();
  if (t) return t.replace(/\s+/g, ' ').slice(0, 160);
  const s = txState(e);
  return s === 'busy' ? 'Transcribing…' : s === 'todo' ? 'Not transcribed yet' : s === 'fail' ? 'Transcription failed' : s === 'off' ? 'Audio only' : '';
}
function renderHome() {
  if (!entriesLoaded) return;
  renderFolderRow();
  const list = $('list'), all = live().filter(e => !pendingDel.has(e.id)), q = searchQ.trim().toLowerCase();
  $('searchRow').hidden = all.length < 4 && !q;
  if (curFolder && !folderNames().includes(curFolder)) curFolder = '';
  const shown = all.filter(e => (!curFolder || e.folder === curFolder) && matches(e, q));
  if (!shown.length) {
    list.innerHTML = '<div class="empty">' + (q ? 'Nothing matches.' : curFolder ? 'Nothing in this folder yet. New entries you make now land here.' : '<b>Your journal is empty.</b>Tap the microphone and talk; the words appear as you go. The pen writes. Everything is stored encrypted on this phone.') + '</div>';
    return;
  }
  let html = '', day = '';
  for (const e of shown) {
    const d = dayKey(e.created);
    if (d !== day) { day = d; html += '<div class="day">' + esc(fmtDay(e.created)) + '</div>'; }
    const s = txState(e), rec = e.state === 'rec';
    const st = rec ? '<span class="st rec">● recording</span>' : s === 'busy' ? '<span class="st busy">transcribing</span>' : s === 'fail' ? '<span class="st fail">transcription failed</span>' : s === 'todo' ? '<span class="st">not transcribed</span>' : '';
    const pic = e.pics && e.pics.length ? e.pics[0] : null;
    html += '<div class="card" data-id="' + esc(e.id) + '"><div class="when">' + esc(fmtTime(e.created)) + '</div><div class="body"><div class="name">' + esc(entryLabel(e)) + '</div>' +
      (snippet(e) ? '<div class="snip">' + esc(snippet(e)) + '</div>' : '') +
      '<div class="meta">' + (e.segs && e.segs.length ? esc(fmtDur(entryDur(e))) + ' · ' : '') + (e.pics && e.pics.length ? e.pics.length + ' photo' + (e.pics.length > 1 ? 's' : '') + ' · ' : '') + (!curFolder && e.folder ? '📁 ' + esc(e.folder) + ' · ' : '') + (e.cloud ? '☁ ' : '') + st + '</div></div>' +
      (pic && safeThumb(pic.th) ? '<img class="th" src="' + pic.th + '" alt="">' : '') + '</div>';
  }
  list.innerHTML = html;
}
// thumbnails are only ever accepted as a plain base64 image
const safeThumb = t => typeof t === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(t) ? t : '';

// ---------- folders ----------
function renderFolderRow() {
  const row = $('folderRow'); if (!row) return;
  const names = folderNames();
  row.hidden = !names.length && !live().length;
  let html = '<button class="chip' + (!curFolder ? ' on' : '') + '" data-f="">All</button>';
  for (const n of names) html += '<button class="chip' + (curFolder === n ? ' on' : '') + '" data-f="' + esc(n) + '">' + esc(n) + '</button>';
  html += '<button class="chip add" data-add="1">+ Folder</button>';
  row.innerHTML = html;
}
$('folderRow').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b || locked) return;
  if (b.dataset.add) { newFolder(f => { curFolder = f; renderHome(); }); return; }
  curFolder = b.dataset.f || ''; renderHome();
});
let chipHold = null;
$('folderRow').addEventListener('pointerdown', ev => { const b = ev.target.closest('button'); clearTimeout(chipHold); if (!b || !b.dataset.f || locked) return; const name = b.dataset.f; chipHold = setTimeout(() => { chipHold = null; folderMenu(name); }, 500); });
for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'pointermove']) $('folderRow').addEventListener(t, ev => { if (t === 'pointermove' && !chipHold) return; if (t !== 'pointermove') clearTimeout(chipHold); });
$('folderRow').addEventListener('contextmenu', ev => ev.preventDefault());
function newFolder(then) {
  popupInput('New folder', '', '', 'Name', 'Create', async name => {
    if (!folderNames().includes(name)) { folders.push(name); await saveFolders().catch(err => toast('Could not save: ' + errText(err))); }
    if (then) then(name); renderHome();
  });
}
function folderMenu(name) {
  const n = live().filter(e => e.folder === name).length;
  popup('📁 ' + name, n + ' entr' + (n === 1 ? 'y' : 'ies'), [
    { label: 'Rename', fn: () => popupInput('Rename folder', '', name, 'Name', 'Rename', async nn => { if (nn === name) return; for (const e of entries) if (e.folder === name && !e.deleted) { e.folder = nn; await persist(e); } folders = folders.map(f => f === name ? nn : f); if (!folders.includes(nn)) folders.push(nn); await saveFolders().catch(() => {}); if (curFolder === name) curFolder = nn; renderAll(); }) },
    { label: 'Delete folder (entries stay)', cls: 'danger', fn: async () => { for (const e of entries) if (e.folder === name && !e.deleted) { e.folder = ''; await persist(e); } folders = folders.filter(f => f !== name); await saveFolders().catch(() => {}); if (curFolder === name) curFolder = ''; renderAll(); } },
    { label: 'Cancel', cls: 'quiet' }]);
}
async function setFolder(e, name) { if ((e.folder || '') === (name || '')) return; e.folder = name || ''; await persist(e); renderAll(); }
function pickFolder(e) {
  const btns = folderNames().map(n => ({ label: (e.folder === n ? '✓ ' : '') + n, fn: () => setFolder(e, n) }));
  btns.push({ label: '+ New folder', fn: () => newFolder(n => setFolder(e, n)) });
  if (e.folder) btns.push({ label: 'No folder', cls: 'quiet', fn: () => setFolder(e, '') });
  btns.push({ label: 'Cancel', cls: 'quiet' });
  popup('Folder', '', btns);
}
$('entryFolder').addEventListener('click', () => { if (curEntry) pickFolder(curEntry); });

let holdTimer = null, holdCard = null, holdX = 0, holdY = 0, holdFired = false;
$('list').addEventListener('click', ev => {
  if (holdFired) { holdFired = false; ev.preventDefault(); return; }      // the tap that ends a long press opens nothing
  const c = ev.target.closest('.card'); if (!c || locked) return;
  const e = byId(c.dataset.id); if (!e) return;
  if (e.state === 'rec' && recording) { push('rec'); return; }
  openEntry(e);
});
// long press (500 ms, finger still) on an entry: the options menu
function holdCancel() { clearTimeout(holdTimer); holdTimer = null; holdCard = null; }
$('list').addEventListener('pointerdown', ev => {
  const c = ev.target.closest('.card'); if (!c || locked || ev.button > 0) return;
  holdCancel(); holdCard = c; holdX = ev.clientX; holdY = ev.clientY; holdFired = false;
  holdTimer = setTimeout(() => { holdTimer = null; const e = byId(c.dataset.id); if (!e || !holdCard) return; holdFired = true; holdCard = null; if (navigator.vibrate) { try { navigator.vibrate(20); } catch (err) {} } entryMenu(e); }, 500);
});
$('list').addEventListener('pointermove', ev => { if (holdCard && (Math.abs(ev.clientX - holdX) > 10 || Math.abs(ev.clientY - holdY) > 10)) holdCancel(); });
for (const t of ['pointerup', 'pointercancel', 'pointerleave']) $('list').addEventListener(t, () => { if (holdTimer) holdCancel(); });
$('list').addEventListener('scroll', holdCancel);
$('list').addEventListener('contextmenu', ev => { if (ev.target.closest('.card')) ev.preventDefault(); });
function entryMenu(e) {
  if (e.state === 'rec' && recording) return;
  const btns = [{ label: 'Open', fn: () => openEntry(e) }];
  if (entryText(e)) btns.push({ label: 'Share as text', fn: () => shareText(e) }, { label: 'Open in Claude', now: true, fn: () => openInClaude(e) });
  btns.push({ label: 'Delete entry', cls: 'danger', fn: () => deleteEntry(e) }, { label: 'Cancel', cls: 'quiet' });
  popup(entryLabel(e), fmtDay(e.created) + ' · ' + fmtTime(e.created) + (e.segs && e.segs.length ? ' · ' + fmtDur(entryDur(e)) : ''), btns);
}
$('searchBox').addEventListener('input', ev => { searchQ = ev.target.value; renderHome(); });
$('menuBtn').addEventListener('click', () => openSheet());

// ---------- a new entry: write (pen) or dictate (microphone) ----------
async function newEntry(opts) {
  if (locked || passive || !Vault.isOpen() || recording) return;
  if (dictOn) stopDictation();
  const e = { id: uid(), created: Date.now(), updated_at: Date.now(), title: '', text: '', transcript: '', tEdited: false, lang: settings.lang, segs: [], pics: [], state: 'done', dur: 0, deleted: false, tx: false, mime: '', merged: true, folder: curFolder || '' };
  entries.unshift(e);
  if (!(await persist(e))) { entries.splice(entries.indexOf(e), 1); return; }
  openEntry(e, { focusText: !(opts && opts.dictate) });
  renderHome();
  if (opts && opts.dictate) setTimeout(() => { if (curEntry === e) startDictation(); }, 80);
}
$('noteBtn').addEventListener('click', () => newEntry());
// The microphone: one tap, and the text window opens with the words flowing in. What runs behind
// it follows the engine: the phone's recognition (text live), the Claude app (a new chat opens
// there), or a key / the cloud (the audio records in the background, each part's text arrives
// below as it is done, the recording stays playable).
$('recBtn').addEventListener('click', () => {
  if (settings.engine === 'claude') { openClaude(''); return; }
  if (settings.engine === 'phone') { newEntry({ dictate: true }); return; }
  startRecording();
});

// ---------- entry view ----------
let titleTimer = null, textTimer = null, focusTextNext = false;
function openEntry(e, opts) {
  if (!e || e.deleted || locked) return;
  curEntry = e; focusTextNext = !!(opts && opts.focusText);
  if (current() !== 'entry') push('entry');
  renderEntry();
  if (focusTextNext) setTimeout(() => { const t = $('noteText'); if (t) t.focus(); }, 60);
}
function leaveEntry() {
  closeLightbox(); if (dictOn) stopDictation(); commitTitle(); commitText(); stopPlayer();
  const e = curEntry; curEntry = null;
  if (e && !e.deleted && !(e.text || '').trim() && !(e.title || '').trim() && !(e.segs && e.segs.length) && !(e.pics && e.pics.length) && e.state !== 'rec') { e.deleted = true; e.del_at = Date.now(); persist(e); renderHome(); }      // an entry left empty is not kept
}
function renderEntry() {
  const e = curEntry; if (!e || current() !== 'entry') return;
  const ti = $('entryTitle'); if (document.activeElement !== ti) ti.value = e.title || '';
  const segs = e.segs || [];
  $('entryMeta').textContent = fmtDay(e.created) + ' · ' + fmtTime(e.created) + (segs.length ? ' · ' + fmtDur(entryDur(e)) + ' · ' + fmtSize(segs.reduce((a, g) => a + (g.size || 0), 0)) : '') + (e.cloud ? ' · in the cloud' : '');
  $('entryFolder').textContent = '📁 ' + (e.folder || 'No folder'); $('entryFolder').classList.toggle('on', !!e.folder);
  const body = $('entryBody'), nt = $('noteText');
  if (nt && document.activeElement === nt) { renderTxState(); return; }                               // never redraw under a moving cursor
  let html = '';
  if (segs.length) {
    html += '<div class="player"><div class="row"><button class="play" id="playBtn" aria-label="Play">▶</button><input type="range" id="seek" min="0" max="' + Math.max(1, Math.round(entryDur(e))) + '" value="0" step="250"></div>' +
      '<div class="times"><span id="tCur">0:00</span><span id="tTot">' + esc(fmtDur(entryDur(e))) + '</span></div>' +
      '<div class="speed">' + [1, 1.25, 1.5, 2].map(r => '<button data-rate="' + r + '"' + (player.rate === r ? ' class="on"' : '') + '>' + r + '×</button>').join('') + '</div><div class="pstate" id="pState"></div>' +
      '<div class="t" style="margin-top:8px"><span>Audio</span><span id="txBtns"></span></div><div class="st" id="txState"></div></div>';
  }
  html += '<div class="txcard"><div class="t"><span>Text</span><span class="tbtns"><button id="claudeBtn" title="Open this entry in Claude">Claude</button><button id="dictBtn" title="Dictate with the phone\'s speech recognition">' + (dictOn ? '■ Stop' : '🎙 Dictate') + '</button></span></div><textarea id="noteText" placeholder="Write, or tap Dictate…">' + esc(e.text || '') + '</textarea></div>';
  html += '<div class="txcard"><div class="t"><span>Photos</span></div><div class="pics" id="picGrid"></div></div>';
  body.innerHTML = html;
  renderPics();
  $('picGrid').addEventListener('click', ev => { const im = ev.target.closest('img'); if (im) { openLightbox(e, +im.dataset.i); return; } if (ev.target.closest('#addPic')) { $('picInput').value = ''; $('picInput').click(); } });
  renderRecBar(); renderTxState(); wirePlayer();
  $('noteText').addEventListener('input', () => { clearTimeout(textTimer); textTimer = setTimeout(commitText, 800); });
  $('dictBtn').addEventListener('click', () => dictOn ? stopDictation() : startDictation());
  $('claudeBtn').addEventListener('click', () => { commitTitle(); commitText(); if (!entryText(e)) { toast('Nothing to send yet.'); return; } openInClaude(e); });
}

// ---------- dictation into the note, with the phone's own speech recognition ----------
// Web Speech API: Google on Android Chrome, Apple on iPhone. Free, instant, no key, no second
// app; but that audio goes to those providers, and Chrome ends after a pause, so it is started
// again while dictation is on. The private way for long memos stays the big microphone.
const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
// dictBase: the text before dictation started; dictFinal: text of the recognition sessions that
// ended; dictSess: the final results of the running session, rebuilt from the whole result list on
// every event (Android Chrome re-sends the same final result several times and resets
// resultIndex, so appending per event duplicates lines).
let dictRec = null, dictOn = false, dictBase = '', dictFinal = '', dictSess = '', dictEntry = null;
function dictLang() { const l = settings.lang; return l === 'de' ? 'de-DE' : l === 'en' ? 'en-US' : (navigator.language && /^(de|en)/.test(navigator.language) ? navigator.language : 'de-DE'); }
// the interim words repeat the running session's words: overlaid, never appended
const dictText = interim => { const t = joinOverlap(joinOverlap(dictFinal, dictSess), interim || ''); return dictBase + t + (interim ? ' ' : ''); };
function dictApply(interim) { const nt = $('noteText'); if (!nt) return; nt.value = dictText(interim); nt.scrollTop = nt.scrollHeight; }
function startDictation() {
  const e = curEntry; if (!e || locked || passive || recording) return;
  if (settings.engine !== 'phone') { startClipDictation(e); return; }
  if (!SR) { popup('No dictation here', 'This browser has no built-in speech recognition. Use Chrome or Safari, the keyboard\'s microphone key, or choose a key or the cloud under Menu, Transcription.', [{ label: 'OK', cls: 'primary' }]); return; }
  commitText(); keepAwake();
  const cur = (e.text || '').replace(/\s+$/, '');
  dictBase = cur ? cur + '\n' : ''; dictFinal = ''; dictSess = ''; dictEntry = e; dictOn = true;
  const b = $('dictBtn'); if (b) b.textContent = '■ Stop';
  const run = () => {
    if (!dictOn || curEntry !== e) return;
    const r = new SR(); dictRec = r; dictSess = '';
    r.lang = dictLang(); r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = ev => {
      // Android also lists the same utterance several times inside one event, each entry a little
      // longer than the one before ("dies", "dies ist", "dies ist ein"): folded on their overlap
      let finals = '', interim = '';
      for (let i = 0; i < ev.results.length; i++) { const t = ev.results[i][0].transcript; if (ev.results[i].isFinal) finals = joinOverlap(finals, t); else interim = joinOverlap(interim, t); }
      dictSess = finals; dictApply(interim);
    };
    r.onerror = ev => { if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') { stopDictation(); popup('Microphone', 'Journal has no permission to use the microphone for dictation. Allow it in the browser settings for this site.', [{ label: 'OK', cls: 'primary' }]); } };
    r.onend = () => { if (dictRec !== r) return; dictRec = null; dictFinal = joinOverlap(dictFinal, dictSess); dictSess = ''; if (dictOn) run(); };      // Android ends after every pause: on again at once
    try { r.start(); } catch (err) { stopDictation(); }
  };
  run();
}
// with a key or the cloud: a short clip is recorded and sent to the service, the text is appended
let clipRec = null, clipStream = null, clipChunks = [];
async function startClipDictation(e) {
  if (!txAvailable()) { wantTranscribe(e); return; }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, noiseSuppression: true, autoGainControl: true } }); } catch (err) { popup('Microphone', 'The microphone could not be started: ' + errText(err), [{ label: 'OK', cls: 'primary' }]); return; }
  if (curEntry !== e || dictOn) { for (const t of stream.getTracks()) t.stop(); return; }
  const mime = pickMime(); let r;
  try { r = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined); } catch (err) { for (const t of stream.getTracks()) t.stop(); toast('The recorder could not be started.'); return; }
  commitText(); dictEntry = e; dictOn = true; clipRec = r; clipStream = stream; clipChunks = [];
  const b = $('dictBtn'); if (b) b.textContent = '■ Stop';
  r.ondataavailable = ev => { if (ev.data && ev.data.size) clipChunks.push(ev.data); };
  r.onstop = async () => {
    for (const t of stream.getTracks()) { try { t.stop(); } catch (err) {} }
    const blob = new Blob(clipChunks, { type: r.mimeType || mime || 'audio/webm' }); clipChunks = [];
    const nt = $('noteText'); if (nt && curEntry === e) nt.placeholder = 'Transcribing…';
    const bb = $('dictBtn'); if (bb) { bb.textContent = '… Transcribing'; bb.disabled = true; }
    try {
      if (blob.size < 1000) throw new Error('nothing was recorded');
      const out = await transcribeRequest(blob, { mime: blob.type }, (e.text || '').trim().slice(-200), e.lang || settings.lang);
      const cur = (e.text || '').replace(/\s+$/, '');
      e.text = (cur ? cur + '\n' : '') + out.text;
      if (curEntry === e) { const t = $('noteText'); if (t) { t.value = e.text; t.scrollTop = t.scrollHeight; } }
      await persist(e); renderHome();
    } catch (err) { toast('Dictation failed: ' + errText(err)); }
    finally { const b2 = $('dictBtn'); if (b2) { b2.textContent = '🎙 Dictate'; b2.disabled = false; } if (nt) nt.placeholder = 'Write, or tap Dictate…'; }
  };
  try { r.start(1000); } catch (err) { stopDictation(); }
}
function stopDictation() {
  if (!dictOn) return;
  if (clipRec) { dictOn = false; const c = clipRec; clipRec = null; clipStream = null; dictEntry = null; try { c.stop(); } catch (e) {} return; }
  dictOn = false; const r = dictRec; dictRec = null; if (r) { try { r.stop(); } catch (e) {} }
  if (!recording) releaseWake();
  const e = dictEntry; dictEntry = null; dictFinal = joinOverlap(dictFinal, dictSess); dictSess = '';
  if (e) { e.text = (dictBase + dictFinal).replace(/\s+$/, ''); if (curEntry === e) { dictApply(''); } persist(e); renderHome(); }
  const b = $('dictBtn'); if (b) b.textContent = '🎙 Dictate';
}
document.addEventListener('visibilitychange', () => { if (document.hidden && dictOn) stopDictation(); });
// Open the Claude app (or claude.ai) on a new chat, with text as the first message when given.
// Android: an intent URL opens the installed app directly and falls back to the web site.
function openClaude(q) {
  const path = '/new' + (q ? '?q=' + encodeURIComponent(q.slice(0, 6000)) : '');
  const web = 'https://claude.ai' + path;
  if (/Android/i.test(navigator.userAgent)) { location.href = 'intent://claude.ai' + path + '#Intent;scheme=https;package=com.anthropic.claude;S.browser_fallback_url=' + encodeURIComponent(web) + ';end'; return; }
  const a = document.createElement('a'); a.href = web; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
}
function openInClaude(e) { openClaude('Here is an entry from my journal. Hold it for now; I will tell you what I want to do with it.\n\n' + entryAsText(e)); }
// the photo grid alone, so a photo added while the text is being typed shows up without a redraw of the text
function renderPics() {
  const e = curEntry, grid = $('picGrid'); if (!e || !grid) return;
  grid.innerHTML = (e.pics || []).map((p, i) => '<img data-i="' + i + '" src="' + (safeThumb(p.th) || '') + '" alt="">').join('') + '<button class="addpic" id="addPic" title="Add a photo">+</button>';
}
function renderTxState() {
  const e = curEntry, el = $('txState'), bt = $('txBtns'); if (!e || !el) return;
  const segs = e.segs || [], s = txState(e), done = segs.filter(g => g.st === 'done').length;
  let msg = '', cls = '';
  if (s === 'busy') { msg = 'Transcribing… ' + done + ' of ' + segs.length + ' parts done; the text is added below.'; cls = 'busy'; }
  else if (s === 'fail') { const f = segs.find(g => g.st === 'fail'); msg = 'Transcription failed: ' + (f && f.err || 'unknown error') + (txFailUntil(e) ? ' · trying again ' + txFailUntil(e) : ''); cls = 'fail'; }
  else if (s === 'todo') msg = e.tx ? (txAvailable() ? 'Waiting to transcribe…' : settings.engine === 'phone' ? 'Stored audio needs a key or the cloud (Menu, Transcription).' : 'Set up transcription in the menu.') : 'Not transcribed; the recording is stored encrypted here.' + (settings.engine === 'phone' ? ' The phone only transcribes live while recording; a key or the cloud can do it afterwards.' : '');
  else if (s === 'done') msg = segs.every(g => g.live) ? 'Transcribed live while recording; the text is below.' : 'Transcribed; the text is below.';
  else if (s === 'off') msg = 'Audio only.';
  if (e.state === 'rec') { msg = 'Still recording.'; cls = ''; }
  el.textContent = msg; el.className = 'st ' + cls;
  if (segs.length > 1) { const row = document.createElement('div'); row.className = 'segrow'; segs.forEach((g, i) => { const sp = document.createElement('span'); sp.className = g.st === 'done' ? 'done' : g.st === 'busy' ? 'busy' : g.st === 'fail' ? 'fail' : ''; sp.textContent = (i + 1) + ' · ' + fmtDur(g.dur); row.appendChild(sp); }); el.appendChild(row); }
  bt.innerHTML = '';
  if (e.state !== 'rec' && segs.some(g => g.st !== 'done')) { const b = document.createElement('button'); b.textContent = s === 'busy' ? 'Transcribing…' : s === 'fail' ? 'Try again' : txAvailable() ? 'Transcribe' : 'How to get text'; b.disabled = s === 'busy'; b.addEventListener('click', () => wantTranscribe(e)); bt.appendChild(b); }
}
function commitTitle() { const e = curEntry; if (!e) return; const v = $('entryTitle').value.trim(); if (v !== (e.title || '')) { e.title = v; persist(e); renderHome(); } }
function commitText() {
  clearTimeout(textTimer); const e = curEntry; if (!e) return;
  const nt = $('noteText'); if (nt && nt.value !== (e.text || '')) { e.text = nt.value; persist(e); renderHome(); }
}
$('entryTitle').addEventListener('input', () => { clearTimeout(titleTimer); titleTimer = setTimeout(commitTitle, 600); });
$('entryTitle').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); commitTitle(); } });
$('entryTitle').addEventListener('blur', commitTitle);
$('entryBack').addEventListener('click', () => back());
$('entryMore').addEventListener('click', () => {
  const e = curEntry; if (!e) return;
  commitTitle(); commitText();
  const btns = [];
  if (entryText(e)) btns.push({ label: 'Share as text', fn: () => shareText(e) });
  if (entryText(e)) btns.push({ label: 'Open in Claude', now: true, fn: () => openInClaude(e) });
  if (e.segs && e.segs.length) btns.push({ label: 'Share the audio', fn: () => shareAudio(e) });
  if (e.segs && e.segs.some(g => g.st === 'done')) btns.push({ label: 'Transcribe again', fn: () => popup('Transcribe again?', 'The recording is transcribed anew and the new text is added below what is there.', [{ label: 'Transcribe again', cls: 'primary', fn: () => retranscribe(e) }, { label: 'Cancel', cls: 'quiet' }]) });
  btns.push({ label: 'Delete entry', cls: 'danger', fn: () => deleteEntry(e) });
  btns.push({ label: 'Cancel', cls: 'quiet' });
  popup(entryLabel(e), '', btns);
});

// ---------- photos: shrunk on the device (no location data survives), stored sealed like audio ----------
const PIC_MAX = 1600, THUMB = 160;
function loadImage(file) { return new Promise((res, rej) => { const url = URL.createObjectURL(file), im = new Image(); im.onload = () => { URL.revokeObjectURL(url); res(im); }; im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('not an image')); }; im.src = url; }); }
function drawScaled(im, max, q) {
  const r = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.max(1, Math.round(im.naturalWidth * r)), h = Math.max(1, Math.round(im.naturalHeight * r));
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(im, 0, 0, w, h);
  return new Promise(res => c.toBlob(b => res({ blob: b, w, h, canvas: c }), 'image/jpeg', q));
}
async function addPhotos(e, files) {
  if (!e || e.deleted || locked) return;
  let n = 0;
  for (const f of files) {
    try {
      const im = await loadImage(f);
      const big = await drawScaled(im, PIC_MAX, 0.85), th = await drawScaled(im, THUMB, 0.7);
      const id = uid();
      await segPut(id, big.blob, { entry: e.id, mime: 'image/jpeg', size: big.blob.size, w: big.w, h: big.h, pic: true });
      e.pics = e.pics || []; e.pics.push({ id, mime: 'image/jpeg', size: big.blob.size, w: big.w, h: big.h, th: th.canvas.toDataURL('image/jpeg', 0.7), t: Date.now() });
      n++;
    } catch (err) { toast('A photo could not be added: ' + errText(err)); }
  }
  if (n) { await persist(e); if (curEntry === e) renderPics(); renderHome(); toast(n + ' photo' + (n > 1 ? 's' : '') + ' added'); }
}
$('picInput').addEventListener('change', ev => { const fs = Array.from(ev.target.files || []); if (fs.length && curEntry) addPhotos(curEntry, fs); });
let lightUrl = '', lightPic = null, lightEntry = null;
async function openLightbox(e, i) {
  const p = e.pics && e.pics[i]; if (!p) return;
  let blob = await segGet(p.id, p.mime);
  if (!blob && typeof fetchSeg === 'function') blob = await fetchSeg(e, p);
  if (!blob) { toast('This photo is not on this device.'); return; }
  closeLightbox(); lightUrl = URL.createObjectURL(blob); lightPic = p; lightEntry = e;
  $('lightImg').src = lightUrl; $('lightbox').hidden = false;
}
function closeLightbox() { $('lightbox').hidden = true; $('lightImg').removeAttribute('src'); if (lightUrl) URL.revokeObjectURL(lightUrl); lightUrl = ''; lightPic = null; lightEntry = null; }
$('lightClose').addEventListener('click', closeLightbox);
$('lightImg').addEventListener('click', closeLightbox);
$('lightDel').addEventListener('click', () => {
  const e = lightEntry, p = lightPic; closeLightbox(); if (!e || !p) return;
  popup('Delete this photo?', 'This cannot be undone.', [{ label: 'Delete', cls: 'danger', fn: async () => { e.pics = (e.pics || []).filter(x => x.id !== p.id); await persist(e); idb.del('segs', p.id).catch(() => {}); if (curEntry === e) renderPics(); renderHome(); } }, { label: 'Cancel', cls: 'quiet' }]);
});

// ---------- delete with undo; the records go only after the undo window ----------
function deleteEntry(e) {
  if (!e || e.deleted) return;
  settleToast();
  pendingDel.add(e.id);
  if (curEntry === e) closeScreen('entry');
  renderHome();
  let undone = false;
  const expire = async () => { if (undone) return; pendingDel.delete(e.id); e.deleted = true; e.del_at = Date.now(); stopPlayer(); if (await persist(e)) purgeEntryData(e).catch(() => {}); renderHome(); };
  toast('Entry deleted', { label: 'Undo', fn: () => { undone = true; pendingDel.delete(e.id); renderHome(); }, expire });
}
// the audio of a deleted entry goes; the entry itself stays as a sealed delete marker for the cloud copy
async function purgeEntryData(e) {
  for (const g of mediaOf(e)) { await idb.del('segs', g.id).catch(() => {}); await partsDel(g.id).catch(() => {}); }
}

// ---------- player: one <audio>, the segments played one after the other ----------
function wirePlayer() {
  const btn = $('playBtn'); if (!btn) return;
  btn.addEventListener('click', togglePlay);
  const seek = $('seek');
  seek.addEventListener('input', () => { player.seeking = true; $('tCur').textContent = fmtDur(+seek.value); });
  seek.addEventListener('change', () => { player.seeking = false; seekTo(+seek.value); });
  for (const b of $('entryBody').querySelectorAll('.speed button')) b.addEventListener('click', () => { player.rate = +b.dataset.rate; if (player.audio) player.audio.playbackRate = player.rate; for (const x of b.parentNode.children) x.classList.toggle('on', x === b); });
  if (player.e === curEntry && player.audio) { btn.textContent = player.audio.paused ? '▶' : '❚❚'; updateSeek(); }
}
const segOffset = (e, i) => e.segs.slice(0, i).reduce((s, g) => s + (g.dur || 0), 0);
function pState(msg) { const el = $('pState'); if (el) el.textContent = msg || ''; }
async function segBlob(e, g) {                                   // local first; a segment that only the cloud has is fetched and stored
  let b = await segGet(g.id, g.mime);
  if (!b && typeof fetchSeg === 'function') { pState('Downloading part ' + (e.segs.indexOf(g) + 1) + '…'); b = await fetchSeg(e, g); pState(''); }
  return b;
}
async function loadSeg(e, i, at) {
  if (!e.segs[i]) return false;
  player.loading = true;
  try {
    let url = player.urls.get(i);
    if (!url) { const b = await segBlob(e, e.segs[i]); if (!b) { pState('This part of the audio is not on this device.'); return false; } url = URL.createObjectURL(b); player.urls.set(i, url); }
    if (player.e !== e) return false;
    const a = player.audio; player.i = i; a.src = url; a.playbackRate = player.rate;
    if (at) { await new Promise(r => { a.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 1500); }); try { a.currentTime = at / 1000; } catch (err) {} }
    return true;
  } finally { player.loading = false; }
}
function ensureAudio() {
  if (player.audio) return player.audio;
  const a = new Audio(); a.preload = 'auto';
  a.addEventListener('timeupdate', updateSeek);
  a.addEventListener('ended', async () => { const e = player.e; if (!e) return; if (player.i + 1 < e.segs.length) { if (await loadSeg(e, player.i + 1, 0)) a.play().catch(() => {}); } else { player.want = false; const b = $('playBtn'); if (b) b.textContent = '▶'; } });
  a.addEventListener('play', () => { const b = $('playBtn'); if (b) b.textContent = '❚❚'; });
  a.addEventListener('pause', () => { const b = $('playBtn'); if (b && !player.want) b.textContent = '▶'; });
  a.addEventListener('error', () => pState('This part could not be played.'));
  player.audio = a; return a;
}
async function togglePlay() {
  const e = curEntry; if (!e || !e.segs.length) return;
  const a = ensureAudio();
  if (player.e !== e) { stopPlayer(); player.e = e; ensureAudio(); player.i = -1; }
  if (player.loading) return;
  if (player.i < 0) { if (!(await loadSeg(e, 0, 0))) return; }
  if (player.audio.paused) { player.want = true; player.audio.play().catch(err => pState('Could not play: ' + errText(err))); } else { player.want = false; player.audio.pause(); }
}
async function seekTo(ms) {
  const e = curEntry; if (!e || !e.segs.length) return;
  if (player.e !== e) { stopPlayer(); player.e = e; ensureAudio(); }
  let i = 0; while (i + 1 < e.segs.length && segOffset(e, i + 1) <= ms) i++;
  const at = ms - segOffset(e, i), wasPlaying = player.audio && !player.audio.paused;
  if (!(await loadSeg(e, i, at))) return;
  if (wasPlaying || player.want) player.audio.play().catch(() => {});
}
function updateSeek() {
  const e = player.e, a = player.audio, seek = $('seek'); if (!e || !a || !seek || player.seeking || curEntry !== e) return;
  const ms = segOffset(e, player.i) + a.currentTime * 1000;
  seek.value = Math.round(ms); $('tCur').textContent = fmtDur(ms);
}
function stopPlayer() {
  if (player.audio) { try { player.audio.pause(); player.audio.removeAttribute('src'); player.audio.load(); } catch (e) {} }
  for (const u of player.urls.values()) URL.revokeObjectURL(u);
  player.urls.clear(); player.e = null; player.i = -1; player.want = false; player.audio = null;
}

// ---------- sharing ----------
function entryAsText(e) {
  const parts = ['# ' + entryLabel(e), fmtDay(e.created) + ' ' + fmtTime(e.created) + (e.segs && e.segs.length ? ' · ' + fmtDur(entryDur(e)) : '')];
  if (entryText(e)) parts.push('', entryText(e));
  return parts.join('\n');
}
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('Copied'); } catch (e) { toast('Could not copy.'); } }
async function shareText(e) {
  const text = entryAsText(e);
  if (navigator.share) { try { await navigator.share({ title: entryLabel(e), text }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
  copyText(text);
}
async function shareAudio(e) {
  const files = [];
  for (const g of e.segs) { const b = await segBlob(e, g); if (b) files.push(new File([b], (e.title || 'memo').replace(/[^\w.-]+/g, '_') + '-' + (e.segs.indexOf(g) + 1) + '.' + extOf(g.mime), { type: g.mime })); }
  if (!files.length) { toast('No audio on this device.'); return; }
  if (navigator.share && navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files, title: entryLabel(e) }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
}
