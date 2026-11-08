'use strict';
/* Journal screens: the list of days and entries, the entry view with its player and transcript,
   typed notes, search, delete with undo, sharing the text. */
let curEntry = null, searchQ = '', pendingDel = new Set(), curFolder = '';      // curFolder: '' = all entries
let selMode = false; const selIds = new Set();                                      // pick mode on the home list
const player = { e: null, take: null, i: -1, urls: new Map(), audio: null, rate: 1, seeking: false, loading: false, want: false };      // urls: segment id -> blob URL
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

// ---------- home ----------
// ---------- search: every folder, title, text, folder name and date; accents do not matter ----------
const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss');
const qWords = q => fold(q).split(/\s+/).filter(Boolean);
function matches(e, words) {
  if (!words.length) return true;
  const hay = fold([e.title, entryText(e), e.folder, fmtDay(e.created), dayKey(e.created)].join('\n'));
  return words.every(w => hay.includes(w));
}
// the text with every hit marked (escaped piece by piece)
function marked(text, words) {
  const f = fold(text);
  if (!words.length || f.length !== text.length) return esc(text);
  let out = '', i = 0;
  while (i < text.length) {
    let at = -1, len = 0;
    for (const w of words) { const j = f.indexOf(w, i); if (j >= 0 && (at < 0 || j < at || (j === at && w.length > len))) { at = j; len = w.length; } }
    if (at < 0) { out += esc(text.slice(i)); break; }
    out += esc(text.slice(i, at)) + '<mark>' + esc(text.slice(at, at + len)) + '</mark>'; i = at + len;
  }
  return out;
}
// a piece of the text around the first hit
function hitSnippet(e, words) {
  const t = entryText(e).replace(/\s+/g, ' ').trim(); if (!t) return '';
  const f = fold(t); let at = -1;
  if (f.length === t.length) for (const w of words) { const i = f.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  if (at < 0) return esc(t.slice(0, 160));
  const from = Math.max(0, at - 50), to = Math.min(t.length, at + 120);
  return (from ? '…' : '') + marked(t.slice(from, to), words) + (to < t.length ? '…' : '');
}
function snippet(e) {
  const t = entryText(e).trim();
  if (t) return t.replace(/\s+/g, ' ').slice(0, 160);
  const s = txState(e);
  return s === 'busy' ? 'Transcribing…' : s === 'todo' ? 'Not transcribed yet' : s === 'fail' ? 'Transcription failed' : s === 'off' ? 'Audio only' : '';
}
function renderHome() {
  if (!entriesLoaded) return;
  if (typeof renderLockNudge === 'function') renderLockNudge();
  renderFolderRow();
  const list = $('list'), all = live().filter(e => !pendingDel.has(e.id)), words = qWords(searchQ), q = words.length > 0;
  $('searchRow').hidden = !all.length && !q;
  if (curFolder && !folderNames().includes(curFolder)) curFolder = '';
  const shown = all.filter(e => (q || !curFolder || e.folder === curFolder) && matches(e, words));      // a search looks in every folder
  searchHits = q ? shown : null;
  $('searchInfo').hidden = !q; $('searchInfo').textContent = q ? (shown.length ? shown.length + ' entr' + (shown.length > 1 ? 'ies' : 'y') + ' found, in all folders' : '') : '';
  $('searchExport').hidden = !q || !shown.length;
  if (!shown.length) {
    list.innerHTML = '<div class="empty">' + (q ? 'Nothing matches “' + esc(searchQ.trim()) + '”.' : curFolder ? 'Nothing in this folder yet. New entries you make now land here.' : '<b>Your journal is empty.</b>Tap the microphone and talk; the words appear as you go. The pen writes. Everything is stored encrypted on this phone.') + '</div>';
    renderSelDock(); return;
  }
  let html = '', day = '';
  for (const e of shown) {
    const d = dayKey(e.created);
    if (d !== day) { day = d; html += '<div class="day">' + esc(fmtDay(e.created)) + '</div>'; }
    const s = txState(e), rec = e.state === 'rec';
    const st = rec ? '<span class="st rec">● recording</span>' : s === 'busy' ? '<span class="st busy">transcribing</span>' : s === 'fail' ? '<span class="st fail">transcription failed</span>' : s === 'todo' ? '<span class="st">not transcribed</span>' : '';
    const pic = e.pics && e.pics.length ? e.pics[0] : null;
    html += '<div class="card' + (selMode && selIds.has(e.id) ? ' sel' : '') + '" data-id="' + esc(e.id) + '">' + (selMode ? '<div class="tick"></div>' : '') + '<div class="when">' + esc(fmtTime(e.created)) + '</div><div class="body"><div class="name">' + (q ? marked(entryLabel(e), words) : esc(entryLabel(e))) + '</div>' +
      (q ? (entryText(e).trim() ? '<div class="snip">' + hitSnippet(e, words) + '</div>' : '') : snippet(e) ? '<div class="snip">' + esc(snippet(e)) + '</div>' : '') +
      '<div class="meta">' + (e.segs && e.segs.length ? esc(fmtDur(entryDur(e))) + ' · ' : '') + (e.pics && e.pics.length ? e.pics.length + ' photo' + (e.pics.length > 1 ? 's' : '') + ' · ' : '') + ((q || !curFolder) && e.folder ? '📁 ' + (q ? marked(e.folder, words) : esc(e.folder)) + ' · ' : '') + (e.cloud ? '☁ ' : '') + st + '</div></div>' +
      (pic && safeThumb(pic.th) ? '<img class="th" src="' + pic.th + '" alt="">' : '') + '</div>';
  }
  list.innerHTML = html;
  renderSelDock();
}
// ---------- pick mode: several entries at once ----------
function renderSelDock() {
  $('selDock').hidden = !selMode; $('homeDock').hidden = selMode;
  $('selectBtn').textContent = selMode ? 'Done' : 'Select'; $('selectBtn').classList.toggle('on', selMode);
  if (selMode) { const n = selIds.size; $('selDelete').textContent = 'Delete' + (n ? ' (' + n + ')' : ''); $('selDelete').disabled = !n; $('selMove').disabled = !n; }
}
function startSelect(id) { selMode = true; selIds.clear(); if (id) selIds.add(id); renderHome(); }
function endSelect() { selMode = false; selIds.clear(); renderHome(); }
$('selectBtn').addEventListener('click', () => selMode ? endSelect() : startSelect());
$('selCancel').addEventListener('click', endSelect);
$('selDelete').addEventListener('click', () => {
  const ids = [...selIds].filter(id => byId(id) && !byId(id).deleted); if (!ids.length) return;
  popup('Delete ' + ids.length + ' entr' + (ids.length > 1 ? 'ies' : 'y') + '?', 'Text, audio and photos of these entries are deleted. You can undo for a few seconds.', [
    { label: 'Delete', cls: 'danger', fn: () => { endSelect(); deleteMany(ids); } }, { label: 'Cancel', cls: 'quiet' }]);
});
$('selMove').addEventListener('click', () => {
  const ids = [...selIds]; if (!ids.length) return;
  const apply = async name => { for (const id of ids) { const e = byId(id); if (e && !e.deleted && (e.folder || '') !== (name || '')) { e.folder = name || ''; await persist(e); } } endSelect(); toast(name ? 'Moved to ' + name : 'Removed from folder'); };
  const btns = folderNames().map(n => ({ label: n, fn: () => apply(n) }));
  btns.push({ label: '+ New folder', fn: () => newFolder(n => apply(n)) }, { label: 'No folder', cls: 'quiet', fn: () => apply('') }, { label: 'Cancel', cls: 'quiet' });
  popup('Move ' + ids.length + ' entr' + (ids.length > 1 ? 'ies' : 'y') + ' to', '', btns);
});
// several entries deleted at once, with one undo for the whole batch
function deleteMany(ids) {
  settleToast();
  const list = ids.map(byId).filter(e => e && !e.deleted);
  for (const e of list) pendingDel.add(e.id);
  if (curEntry && list.includes(curEntry)) closeScreen('entry');
  renderHome();
  let undone = false;
  const expire = async () => { if (undone) return; stopPlayer(); for (const e of list) { pendingDel.delete(e.id); e.deleted = true; e.del_at = Date.now(); if (await persist(e)) purgeEntryData(e).catch(() => {}); } renderHome(); };
  toast(list.length + ' entr' + (list.length > 1 ? 'ies' : 'y') + ' deleted', { label: 'Undo', fn: () => { undone = true; for (const e of list) pendingDel.delete(e.id); renderHome(); }, expire });
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
// the entry's date and time can be set back (or forward), for a memo added afterwards
const toLocalInput = t => { const d = new Date(t); return new Date(t - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
$('entryDateIn').addEventListener('click', ev => { try { ev.target.showPicker(); } catch (err) {} });
$('entryDateIn').addEventListener('change', ev => {
  const e = curEntry; if (!e || !ev.target.value) return;
  const t = new Date(ev.target.value).getTime(); if (!isFinite(t) || t === e.created) return;
  e.created = t; sortEntries(); persist(e); renderEntry(); renderHome();
  toast('Date set to ' + fmtDay(t) + ', ' + fmtTime(t));
});

let holdTimer = null, holdCard = null, holdX = 0, holdY = 0, holdFired = false;
$('list').addEventListener('click', ev => {
  if (holdFired) { holdFired = false; ev.preventDefault(); return; }      // the tap that ends a long press opens nothing
  const c = ev.target.closest('.card'); if (!c || locked) return;
  const e = byId(c.dataset.id); if (!e) return;
  if (selMode) { if (selIds.has(e.id)) selIds.delete(e.id); else selIds.add(e.id); c.classList.toggle('sel', selIds.has(e.id)); renderSelDock(); return; }
  if (e.state === 'rec' && recording) { push('rec'); return; }
  openEntry(e);
});
// long press (500 ms, finger still) on an entry: pick mode
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
// long press on an entry: pick mode with this entry picked (delete or move from the bar below)
function entryMenu(e) {
  if (e.state === 'rec' && recording) return;
  if (selMode) { if (!selIds.has(e.id)) { selIds.add(e.id); renderHome(); } return; }
  startSelect(e.id);
}
let searchHits = null;
$('searchBox').addEventListener('input', ev => { searchQ = ev.target.value; renderHome(); });
$('searchExport').addEventListener('click', () => { if (searchHits && searchHits.length) exportTextAsk(searchHits, 'journal-search-' + fold(searchQ.trim()).replace(/[^a-z0-9]+/g, '-').slice(0, 30)); });
$('menuBtn').addEventListener('click', () => openSheet());

// ---------- a new entry: write (pen) or record (microphone) ----------
async function newEntry(opts) {
  if (locked || passive || !Vault.isOpen() || recording) return;
  const e = { id: uid(), created: Date.now(), updated_at: Date.now(), title: '', text: '', transcript: '', tEdited: false, lang: settings.lang, segs: [], pics: [], state: 'done', dur: 0, deleted: false, tx: false, mime: '', merged: true, folder: curFolder || '' };
  entries.unshift(e);
  if (opts && opts.keyboard) {
    // the keyboard only comes up inside the tap itself: open and focus first, save right after
    openEntry(e, { focusNow: true }); keyboardHint();
    if (!(await persist(e))) { entries.splice(entries.indexOf(e), 1); if (curEntry === e) { curEntry = null; closeScreen('entry'); } renderHome(); return; }
    renderHome(); return;
  }
  if (!(await persist(e))) { entries.splice(entries.indexOf(e), 1); return; }
  openEntry(e, { focusText: true });
  renderHome();
}
$('noteBtn').addEventListener('click', () => newEntry());
// The microphone records your voice into a new entry: kept encrypted, playable, and its text is
// written afterwards from the recording (on this phone with Whisper, or online with a key).
// Inside an entry, Record adds another recording below the ones there.
$('recBtn').addEventListener('click', () => {
  if (settings.engine === 'claude') { openClaude(''); return; }
  if (settings.engine === 'keyboard') { newEntry({ keyboard: true }); return; }
  startRecording();
});

// ---------- entry view ----------
let titleTimer = null, textTimer = null, focusTextNext = false;
function openEntry(e, opts) {
  if (!e || e.deleted || locked) return;
  curEntry = e; focusTextNext = !!(opts && opts.focusText);
  if (current() !== 'entry') push('entry');
  renderEntry();
  if (opts && opts.focusNow) { const t = $('noteText'); if (t) t.focus(); }
  else if (focusTextNext) setTimeout(() => { const t = $('noteText'); if (t) t.focus(); }, 60);
}
// keyboard engine: the phone's keyboard does the listening (Gboard's microphone key), shown once per entry
function keyboardHint() { const t = $('noteText'); if (t) t.placeholder = 'Tap the microphone key on the keyboard and talk…'; toast('Tap the microphone key on the keyboard'); }
function leaveEntry() {
  closeLightbox(); commitTitle(); commitText(); stopPlayer();
  const e = curEntry; curEntry = null;
  if (e && !e.deleted && !(e.text || '').trim() && !(e.title || '').trim() && !(e.segs && e.segs.length) && !(e.pics && e.pics.length) && e.state !== 'rec' && !pendingSegList.some(s => s.entry === e.id)) { e.deleted = true; e.del_at = Date.now(); persist(e); renderHome(); }      // an entry left empty is not kept
}
// ---------- recordings: one block per recording, above the text ----------
// A recording (a "take") is one press of the microphone or of Record; a long one consists of
// several stored parts, played one after the other. Older entries without takes are one recording.
const takesOf = e => {
  const m = new Map();
  for (const g of (e.segs || [])) { const k = g.take || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(g); }
  return [...m].map(([id, segs]) => ({ id, segs: segs.slice().sort((a, b) => a.i - b.i) })).sort((a, b) => a.segs[0].i - b.segs[0].i);
};
const takeOf = (e, id) => takesOf(e).find(t => t.id === id) || null;
const takeDur = t => t.segs.reduce((s, g) => s + (g.dur || 0), 0);
const segOff = (t, i) => t.segs.slice(0, i).reduce((s, g) => s + (g.dur || 0), 0);
const blockOf = id => [...document.querySelectorAll('#takes .player')].find(b => b.dataset.take === id) || null;
function takeHtml(t, n) {
  const d = takeDur(t);
  return '<div class="player" data-take="' + esc(t.id) + '"><div class="phead"><span>🎙 Recording' + (n ? ' ' + n : '') + '</span><span class="pdur">' + esc(fmtDur(d)) + '</span></div>' +
    '<div class="row"><button class="skip" data-act="back" aria-label="10 seconds back">↺10</button><button class="play" data-act="play" aria-label="Play">▶</button><button class="skip" data-act="fwd" aria-label="10 seconds on">10↻</button><input type="range" class="pseek" min="0" max="' + Math.max(1, Math.round(d)) + '" value="0" step="250"></div>' +
    '<div class="times"><span class="pcur">0:00</span><span class="ptot">' + esc(fmtDur(d)) + '</span></div>' +
    '<div class="speed">' + RATES.map(r => '<button data-rate="' + r + '">' + r + '×</button>').join('') + '</div><div class="pstate"></div>' +
    '<div class="tstate"><span class="st"></span><span class="tbtn"></span></div></div>';
}
function renderTakes() {
  const e = curEntry, box = $('takes'); if (!e || !box) return;
  const ts = takesOf(e);
  box.innerHTML = ts.map((t, k) => takeHtml(t, ts.length > 1 ? k + 1 : 0)).join('');
  box.onclick = ev => {
    const b = ev.target.closest('button'), blk = ev.target.closest('.player'); if (!b || !blk) return;
    const id = blk.dataset.take, act = b.dataset.act;
    if (act === 'play') togglePlay(id); else if (act === 'back') skipBy(id, -10000); else if (act === 'fwd') skipBy(id, 10000);
    else if (act === 'tx') { for (const g of e.segs) if (g.st === 'empty') g.st = 'todo'; wantTranscribe(e); } else if (b.dataset.rate) setRate(+b.dataset.rate);
  };
  box.oninput = ev => { if (!ev.target.classList.contains('pseek')) return; player.seeking = true; ev.target.closest('.player').querySelector('.pcur').textContent = fmtDur(+ev.target.value); };
  box.onchange = ev => { if (!ev.target.classList.contains('pseek')) return; player.seeking = false; seekTo(ev.target.closest('.player').dataset.take, +ev.target.value); };
  renderTxState(); syncPlayerUi();
}
function renderEntry() {
  const e = curEntry; if (!e || current() !== 'entry') return;
  const ti = $('entryTitle'); if (document.activeElement !== ti) ti.value = e.title || '';
  const segs = e.segs || [];
  $('entryMeta').textContent = (segs.length ? fmtDur(entryDur(e)) + ' · ' + fmtSize(segs.reduce((a, g) => a + (g.size || 0), 0)) : '') + (e.cloud ? (segs.length ? ' · ' : '') + 'in the cloud' : '');
  $('entryDate').textContent = '📅 ' + fmtDay(e.created) + ' · ' + fmtTime(e.created);
  const di = $('entryDateIn'); if (document.activeElement !== di) di.value = toLocalInput(e.created);
  $('entryFolder').textContent = '📁 ' + (e.folder || 'No folder'); $('entryFolder').classList.toggle('on', !!e.folder);
  const body = $('entryBody'), nt = $('noteText');
  if (nt && document.activeElement === nt && nt.dataset.id === e.id) { commitText(); renderTakes(); renderRecordBtn(); return; }      // never redraw under a moving cursor; the recordings above and new text may change
  commitText();                                                                                         // nothing typed is lost to a redraw
  body.innerHTML = '<div id="takes"></div>' +
    '<div class="txcard"><div class="t"><span class="tlabel">Text</span><span class="tbtns"><button id="claudeBtn" title="Open this entry in Claude">Claude</button><button id="recHere" title="Record">🎙 Record</button></span></div><textarea id="noteText" data-id="' + esc(e.id) + '" placeholder="Write, or tap Record…">' + esc(e.text || '') + '</textarea></div>' +
    '<div class="txcard"><div class="t"><span>Photos</span></div><div class="pics" id="picGrid"></div></div>';
  $('noteText').dataset.base = e.text || '';
  renderTakes(); renderPics(); renderRecordBtn();
  $('picGrid').addEventListener('click', ev => { const im = ev.target.closest('img'); if (im) { openLightbox(e, +im.dataset.i); return; } if (ev.target.closest('#addPic')) { $('picInput').value = ''; $('picInput').click(); } });
  renderRecBar();
  $('noteText').addEventListener('input', () => { clearTimeout(textTimer); textTimer = setTimeout(commitText, 500); });
  $('noteText').addEventListener('blur', commitText);
  $('recHere').addEventListener('click', () => {
    if (recording) { if (recEntry === e) stopRecording(); return; }
    if (settings.engine === 'keyboard') { $('noteText').focus(); keyboardHint(); return; }
    startRecording(e);
  });
  $('claudeBtn').addEventListener('click', () => { commitTitle(); commitText(); if (entryText(e)) openInClaude(e); else openClaude(''); });
}
// the Record button follows the recorder: Stop while this entry records, unavailable while another one does
function renderRecordBtn() {
  const b = $('recHere'), e = curEntry; if (!b || !e) return;
  const here = recording && recEntry === e;
  b.textContent = here ? '■ Stop' : settings.engine === 'keyboard' ? '⌨ Dictate' : '🎙 Record';
  b.disabled = recording && !here; b.classList.toggle('rec', here);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) return; commitTitle(); commitText(); });
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
// the state of each recording's text, in its block
function takeTxState(segs) {
  if (segs.some(g => g.st === 'empty') && segs.every(g => g.st === 'done' || g.st === 'empty')) return 'empty';
  if (segs.every(g => g.st === 'done')) return 'done';
  if (segs.some(g => g.st === 'busy')) return 'busy';
  if (segs.some(g => g.st === 'fail')) return 'fail';
  if (segs.every(g => g.st === 'off' || g.st === 'done')) return 'off';
  return 'todo';
}
function renderTxState() {
  const e = curEntry; if (!e) return;
  for (const t of takesOf(e)) {
    const blk = blockOf(t.id); if (!blk) continue;
    const el = blk.querySelector('.st'), bt = blk.querySelector('.tbtn'), s = takeTxState(t.segs), n = t.segs.length, done = t.segs.filter(g => g.st === 'done').length;
    let msg = '', cls = '', btn = '';
    if (recording && recEntry === e && recTake === t.id) msg = 'Still recording…';
    else if (s === 'busy') { msg = (settings.engine === 'whisper' ? whisperStatus() || 'Writing the text on this phone…' : 'Getting its text…') + (n > 1 ? ' (part ' + Math.min(n, done + 1) + ' of ' + n + ')' : ''); cls = 'busy'; }
    else if (s === 'fail') { const f = t.segs.find(g => g.st === 'fail'); msg = 'No text yet: ' + (f && f.err || 'unknown error') + (txFailUntil(e) ? ' · trying again ' + txFailUntil(e) : ''); cls = 'fail'; btn = 'Try again'; }
    else if (s === 'todo') { if (txAvailable()) { msg = e.tx ? 'Its text follows…' : 'Its text is not written yet.'; if (!e.tx) btn = 'Write its text'; } else { msg = 'Your voice, stored encrypted.'; btn = 'Get its text'; } }
    else if (s === 'off') { msg = 'Audio only.'; btn = 'Write its text'; }
    else if (s === 'done') msg = '✓ Its text is in the entry below.';
    else if (s === 'empty') { const f = t.segs.find(g => g.st === 'empty'); msg = 'No text: ' + (f && f.err || 'no words heard') + '. Was it quiet, or very short? The recording is kept.'; cls = 'fail'; btn = 'Try again'; }
    el.textContent = msg; el.className = 'st ' + cls;
    bt.innerHTML = btn ? '<button data-act="tx">' + esc(btn) + '</button>' : '';
  }
}
function commitTitle() { const e = curEntry; if (!e) return; const v = $('entryTitle').value.trim(); if (v !== (e.title || '')) { e.title = v; persist(e); renderHome(); } }
// The field and the entry's text can both change: you type, and a recording's text is added to
// the entry meanwhile. The field remembers what it showed (its base); only what you typed is taken
// over, and text added to the entry since then is appended to the field, cursor kept.
function commitText() {
  clearTimeout(textTimer); const e = curEntry; if (!e) return;
  const nt = $('noteText'); if (!nt || nt.dataset.id !== e.id) return;
  const base = nt.dataset.base != null ? nt.dataset.base : (e.text || ''), cur = e.text || '', val = nt.value;
  if (val === base) { if (cur !== base) fieldTo(nt, cur); return; }                      // nothing typed: the field follows the entry
  const next = cur === base ? val : cur.startsWith(base) ? val + cur.slice(base.length) : val;
  e.text = next; persist(e); renderHome();
  if (next !== val) fieldTo(nt, next); else nt.dataset.base = next;
}
function fieldTo(nt, text) {
  if (document.activeElement === nt && text.startsWith(nt.value)) nt.setRangeText(text.slice(nt.value.length), nt.value.length, nt.value.length, 'preserve');
  else nt.value = text;
  nt.dataset.base = text;
}
$('entryTitle').addEventListener('input', () => { clearTimeout(titleTimer); titleTimer = setTimeout(commitTitle, 600); });
$('entryTitle').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); commitTitle(); } });
$('entryTitle').addEventListener('blur', commitTitle);
$('entryBack').addEventListener('click', () => { commitTitle(); commitText(); back(); });
$('entrySave').addEventListener('click', async () => {
  const e = curEntry; if (!e) return;
  commitTitle(); commitText();
  const ok = await persist(e);
  if (!ok) return;                                                                      // persist already said why
  toast((e.text || '').trim() || (e.title || '').trim() || (e.segs && e.segs.length) || (e.pics && e.pics.length) ? 'Saved' : 'Nothing to save');
});
$('entryMore').addEventListener('click', () => {
  const e = curEntry; if (!e) return;
  commitTitle(); commitText();
  const btns = [];
  if (entryText(e)) btns.push({ label: 'Share as text', fn: () => shareText(e) });
  if (e.segs && e.segs.length) btns.push({ label: 'Save or share the audio file', fn: () => shareAudio(e) });
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

// ---------- player: one <audio> for the entry; a recording's parts play one after the other ----------
function pState(msg) { const blk = player.take != null ? blockOf(player.take) : null; const el = blk && blk.querySelector('.pstate'); if (el) el.textContent = msg || ''; }
async function segBlob(e, g) {                                   // local first; a segment that only the cloud has is fetched and stored
  let b = await segGet(g.id, g.mime);
  if (!b && typeof fetchSeg === 'function') { pState('Downloading the audio…'); b = await fetchSeg(e, g); pState(''); }
  return b;
}
async function loadSeg(e, t, i, at) {
  const g = t.segs[i]; if (!g) return false;
  player.loading = true;
  try {
    let url = player.urls.get(g.id);
    if (!url) { const b = await segBlob(e, g); if (!b) { pState('This part of the audio is not on this device.'); return false; } url = URL.createObjectURL(b); player.urls.set(g.id, url); }
    if (player.e !== e || player.take !== t.id) return false;
    const a = player.audio; player.i = i; a.src = url; a.playbackRate = player.rate;
    if (at) { await new Promise(r => { a.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 1500); }); try { a.currentTime = at / 1000; } catch (err) {} }
    return true;
  } finally { player.loading = false; }
}
function ensureAudio() {
  if (player.audio) return player.audio;
  const a = new Audio(); a.preload = 'auto';
  a.addEventListener('timeupdate', updateSeek);
  a.addEventListener('ended', async () => {
    const e = player.e, t = e && takeOf(e, player.take); if (!t) return;
    if (player.i + 1 < t.segs.length) { if (await loadSeg(e, t, player.i + 1, 0)) a.play().catch(() => {}); }
    else { player.want = false; syncPlayerUi(); }
  });
  a.addEventListener('play', syncPlayerUi);
  a.addEventListener('pause', () => { if (!player.want) syncPlayerUi(); });
  a.addEventListener('error', () => pState('This part could not be played.'));
  player.audio = a; return a;
}
// the player now serves recording `id` of entry e
function playerOn(e, id) { if (player.e !== e || player.take !== id) { stopPlayer(); player.e = e; player.take = id; player.i = -1; ensureAudio(); syncPlayerUi(); } }
async function togglePlay(id) {
  const e = curEntry, t = e && takeOf(e, id); if (!t) return;
  playerOn(e, id);
  if (player.loading) return;
  if (player.i < 0 && !(await loadSeg(e, t, 0, 0))) return;
  if (player.audio.paused) { player.want = true; player.audio.play().catch(err => pState('Could not play: ' + errText(err))); } else { player.want = false; player.audio.pause(); }
}
function skipBy(id, d) {                                         // 10 seconds back or on, across parts
  const e = curEntry, t = e && takeOf(e, id); if (!t) return;
  const now = player.e === e && player.take === id && player.audio && player.i >= 0 ? segOff(t, player.i) + player.audio.currentTime * 1000 : 0;
  const to = Math.max(0, Math.min(takeDur(t) - 250, now + d));
  const blk = blockOf(id); if (blk) { blk.querySelector('.pseek').value = Math.round(to); blk.querySelector('.pcur').textContent = fmtDur(to); }
  seekTo(id, to);
}
async function seekTo(id, ms) {
  const e = curEntry, t = e && takeOf(e, id); if (!t) return;
  const wasPlaying = player.e === e && player.take === id && player.audio && !player.audio.paused;
  playerOn(e, id);
  let i = 0; while (i + 1 < t.segs.length && segOff(t, i + 1) <= ms) i++;
  if (!(await loadSeg(e, t, i, ms - segOff(t, i)))) return;
  if (wasPlaying || player.want) player.audio.play().catch(() => {});
}
function setRate(r) { player.rate = r; if (player.audio) player.audio.playbackRate = r; syncPlayerUi(); }
function updateSeek() {
  const e = player.e, a = player.audio; if (!e || !a || player.seeking || curEntry !== e) return;
  const t = takeOf(e, player.take), blk = blockOf(player.take); if (!t || !blk || player.i < 0) return;
  const ms = segOff(t, player.i) + a.currentTime * 1000;
  blk.querySelector('.pseek').value = Math.round(ms); blk.querySelector('.pcur').textContent = fmtDur(ms);
}
// play buttons and speeds of every block, as the one player stands
function syncPlayerUi() {
  for (const blk of document.querySelectorAll('#takes .player')) {
    const mine = player.e === curEntry && player.take === blk.dataset.take, playing = mine && player.audio && !player.audio.paused;
    blk.querySelector('[data-act=play]').textContent = playing ? '❚❚' : '▶';
    for (const b of blk.querySelectorAll('.speed button')) b.classList.toggle('on', +b.dataset.rate === player.rate);
  }
  updateSeek();
}
function stopPlayer() {
  if (player.audio) { try { player.audio.pause(); player.audio.removeAttribute('src'); player.audio.load(); } catch (e) {} }
  for (const u of player.urls.values()) URL.revokeObjectURL(u);
  player.urls.clear(); player.e = null; player.take = null; player.i = -1; player.want = false; player.audio = null;
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
  for (const g of e.segs) { const b = await segBlob(e, g); if (b) files.push(new File([b], (e.title || 'recording').replace(/[^\w.-]+/g, '_') + '-' + (e.segs.indexOf(g) + 1) + '.' + extOf(g.mime), { type: g.mime })); }
  if (!files.length) { toast('No audio on this device.'); return; }
  if (navigator.share && navigator.canShare && navigator.canShare({ files })) { try { await navigator.share({ files, title: entryLabel(e) }); return; } catch (err) { if (err && err.name === 'AbortError') return; } }
  for (const f of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); }
}
