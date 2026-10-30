'use strict';
if (self !== top) { try { document.documentElement.hidden = true; } catch (e) {} throw new Error('Journal does not run inside another page.'); }      // never framed by another site
/* Journal core: helpers, the write guard, settings, encrypted storage, the entry model, screens
   and the back button. The app is several plain script files that share one scope (no build
   step); index.html loads them in order. Built the Snapdoc way: nothing readable is ever written
   to the device, one window is active at a time, the lock restarts the page. */
const VERSION = 'v16';
const $ = id => document.getElementById(id);
const CFG = self.APP_CONFIG || {};
const SYNC = CFG.supabaseUrl && CFG.supabaseKey ? { url: String(CFG.supabaseUrl).replace(/\/$/, ''), key: CFG.supabaseKey } : null;
const SET_KEY = 'journal.settings', TICK_KEY = 'journal.tick', RESUME_KEY = 'journal.resume', OWNER_KEY = 'journal.owner', ALIVE_KEY = 'journal.alive';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const dayKey = t => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const fmtDay = t => new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' + pad(m) : String(m)) + ':' + pad(s % 60); };
const utf8 = s => new TextEncoder().encode(s);
const errText = e => (e && (e.message || e.name)) || (e == null ? 'unknown error' : String(e));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- one active instance ----------
// Only one tab or window writes at a time. Whoever is active puts its id into localStorage, which
// every tab reads synchronously; every write checks it first, so a tab that was replaced (or was
// frozen in the background and wakes up late) cannot write stale data over newer data.
const INSTANCE_ID = uid(), BOOT_ID = INSTANCE_ID.slice(0, 8);
let passive = false;
let markNeeded = false, lockHeld = false;
const isOwner = () => { try { const o = localStorage.getItem(OWNER_KEY); return !o || o === INSTANCE_ID; } catch (e) { return lockHeld || !markNeeded; } };
function writeGuard() {
  if (!passive && isOwner()) return;
  if (!passive && typeof instanceLost === 'function') instanceLost();
  throw new Error('Journal is active in another tab or window.');
}

// ---------- settings (not sensitive, plain) ----------
// transcribe: 'ask' (a question after every recording), 'auto' (as soon as a segment is stored),
// 'off' (audio only). segMin: minutes per audio segment; every segment is a complete file of its
// own, stored and encrypted the moment it ends, so a crash loses at most the open segment.
// engine: 'phone' (the phone's own speech recognition, live while recording and while dictating),
// 'keyboard' (the keyboard's own microphone key, Gboard: the text window opens with the keyboard up),
// 'key' (the user's own key for a service), 'cloud' (the app's own cloud function, needs sign-in)
let settings = { lockAfter: 60, transcribe: 'auto', segMin: 5, lang: 'auto', engine: 'phone' };
const LOCK_AFTER = [5, 60, 300, 1800], SEG_MIN = [2, 5, 10], LANGS = ['auto', 'de', 'en'];
try { Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch (e) {}
if (!LOCK_AFTER.includes(+settings.lockAfter)) settings.lockAfter = 60;      // only the offered values: nothing in plain storage can switch the lock off
if (!SEG_MIN.includes(+settings.segMin)) settings.segMin = 5;
if (!['ask', 'auto', 'off'].includes(settings.transcribe)) settings.transcribe = 'ask';
if (!LANGS.includes(settings.lang)) settings.lang = 'auto';
if (!['phone', 'keyboard', 'claude', 'key', 'cloud'].includes(settings.engine)) settings.engine = 'phone';
const saveSettings = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (e) {} };

// ---------- IndexedDB ----------
const idb = (() => {
  const STORES = ['entries', 'segs', 'parts', 'meta'];
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('journal', 1);
    r.onupgradeneeded = () => { const d = r.result; for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); };
    r.onblocked = () => { try { fatal('An older Journal window is still open. Close it, then open Journal again.'); } catch (e) {} };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { try { db.close(); } catch (e) {} dbp = null; try { instanceLost(); } catch (e) {} };
      res(db);
    };
    r.onerror = () => rej(r.error);
  }));
  const txOpts = (store, mode) => mode === 'readwrite' && (store === 'meta' || store === 'entries') ? { durability: 'strict' } : undefined;
  const fail = (t, e) => t.error || (e && e.target && e.target.error) || new Error('storage request failed');
  const tx = async (store, mode, fn) => {
    if (mode === 'readwrite') writeGuard();
    const d = await open();
    return new Promise((res, rej) => { const t = d.transaction(store, mode, txOpts(store, mode)); const rq = fn(t.objectStore(store)); t.oncomplete = () => res(rq && rq.result); t.onerror = e => rej(fail(t, e)); t.onabort = e => rej(fail(t, e)); });
  };
  return {
    get: (s, k) => tx(s, 'readonly', o => o.get(k)), put: (s, v) => tx(s, 'readwrite', o => o.put(v)), del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
    keys: s => tx(s, 'readonly', o => o.getAllKeys()), all: s => tx(s, 'readonly', o => o.getAll()),
    async wipe() { for (const s of STORES) await tx(s, 'readwrite', o => o.clear()).catch(() => {}); }
  };
})();
const metaStore = { get: id => idb.get('meta', id), put: rec => idb.put('meta', rec), del: id => idb.del('meta', id) };

// ---------- encrypted records: nothing readable is written to the device ----------
// Every record is sealed with a label that names its place (entry id, segment id, part number), so
// a record cannot be swapped for another unnoticed. A write that began under a key that is being
// renewed is written once more under the new key.
let recWrites = 0, recSeq = 0;
async function sealedPut(store, id, make) {
  recWrites++; recSeq++;
  try { let gen; do { gen = Vault.keyGen(); await idb.put(store, Object.assign({ id }, await make())); } while (Vault.keyGen() !== gen); }
  finally { recWrites--; recSeq++; }
}
const eLabel = id => 'jn|e|' + id, sLabel = id => 'jn|s|' + id, pLabel = (seg, n) => 'jn|p|' + seg + '|' + n;
// one record per entry: title, text, transcript, the segment list, sync marks
const entryPut = e => sealedPut('entries', e.id, async () => ({ m: await Vault.sealJson(e, eLabel(e.id)) }));
async function entryLoadAll() {
  const out = [];
  for (const r of await idb.all('entries')) { try { out.push(await Vault.openJson(r.m, eLabel(r.id))); } catch (e) { out.push({ id: r.id, broken: true }); } }
  return out;
}
// one record per audio segment: the sealed file plus a small sealed meta object (entry, mime, size, duration, write time)
const segPut = (id, blob, meta) => sealedPut('segs', id, async () => ({ data: await Vault.sealBlob(blob, sLabel(id)), m: await Vault.sealJson(Object.assign({}, meta, { t: Date.now() }), sLabel(id) + '|m') }));
async function segGet(id, mime) { const r = await idb.get('segs', id); if (!r) return null; return Vault.openBlob(r.data, sLabel(id), mime || 'application/octet-stream'); }
async function segMeta(r) { try { return await Vault.openJson(r.m, sLabel(r.id) + '|m'); } catch (e) { return null; } }
const segHas = async id => !!(await idb.get('segs', id));
// parts: the chunks of the segment being recorded, stored as they arrive, so a crash keeps them
const partPut = (seg, n, blob, meta) => sealedPut('parts', seg + '|' + pad(n).padStart(6, '0'), async () => ({ data: await Vault.sealBlob(blob, pLabel(seg, n)), m: await Vault.sealJson(Object.assign({}, meta, { seg, n, t: Date.now() }), pLabel(seg, n) + '|m') }));
async function partsOf(seg) {
  const out = [];
  for (const k of await idb.keys('parts')) if (typeof k === 'string' && k.startsWith(seg + '|')) out.push(k);
  out.sort(); return out;
}
async function partsDel(seg) { for (const k of await partsOf(seg)) await idb.del('parts', k).catch(() => {}); }

// ---------- entries in memory ----------
// An entry: { id, created, updated_at, title, text, transcript, tEdited, lang, segs: [{ id, i, dur, mime, size, text, st, err }],
//   state: 'rec' | 'done', dur, deleted, srv, pushed_at, up: { segId: true } }
// st of a segment: 'todo' (not transcribed), 'busy', 'done', 'fail', 'off' (the user chose audio only)
let entries = [], entriesLoaded = false, persistQueued = 0, persistFailed = false;
const byId = id => entries.find(e => e.id === id);
const live = () => entries.filter(e => !e.deleted && !e.broken);
const persistChain = { p: Promise.resolve() };
// store one entry; writes of the same entry queue behind each other, a failed write is shown once and tried again
function persist(e, opts) {
  if (!e || passive) return Promise.resolve(false);
  if (!(opts && opts.quiet)) e.updated_at = Math.max(Date.now(), (e.updated_at || 0) + 1);
  persistQueued++;
  const run = persistChain.p.then(async () => {
    try { await entryPut(e); persistFailed = false; tick(); if (!(opts && opts.quiet) && typeof scheduleSync === 'function') scheduleSync(); return true; }
    catch (err) { persistFailed = true; if (typeof toast === 'function') toast('Could not save: ' + errText(err)); return false; }
    finally { persistQueued--; }
  });
  persistChain.p = run.catch(() => {});
  return run;
}
const tick = () => { try { localStorage.setItem(TICK_KEY, Date.now() + '.' + Math.random()); } catch (e) {} };
async function loadEntries() {
  entries = await entryLoadAll();
  entries.sort((a, b) => (b.created || 0) - (a.created || 0));
  entriesLoaded = true;
  for (const e of entries) if (!e.broken && mergeText(e)) await persist(e, { quiet: true });
}
const entryDur = e => (e.segs || []).reduce((s, g) => s + (g.dur || 0), 0);
const entryLabel = e => (e.title || '').trim() || (e.segs && e.segs.length ? 'Voice memo' : 'Entry');
// One text per entry (e.text): typed, dictated, or transcribed from audio; the transcript of each
// audio segment is appended to it once (g.merged). Entries from before v5 carried a separate
// transcript: mergeText folds it in, once.
const entryText = e => e.text || '';
const joinText = (a, b) => { a = (a || '').replace(/\s+$/, ''); b = (b || '').trim(); return a && b ? a + '\n\n' + b : a || b; };
function mergeText(e) {
  if (e.merged) return false;
  let t = e.text || '';
  if (e.tEdited && e.transcript) { t = joinText(t, e.transcript); for (const g of e.segs || []) g.merged = true; }
  else for (const g of e.segs || []) if (g.text && !g.merged) { t = joinText(t, g.text); g.merged = true; }
  e.text = t; e.transcript = ''; e.tEdited = false; e.merged = true;
  return true;
}
// Speech recognition on Android ends a session after every phrase and often repeats, in the next
// session, everything said so far plus the new words. Two pieces are joined on their overlap: the
// longest run of words that ends the first and starts the second is kept once.
function joinOverlap(prev, next) {
  const A = (prev || '').trim().split(/\s+/).filter(Boolean), B = (next || '').trim().split(/\s+/).filter(Boolean);
  if (!A.length) return B.join(' '); if (!B.length) return A.join(' ');
  const norm = w => w.toLowerCase().replace(/[.,!?;:]+$/, '');
  for (let k = Math.min(A.length, B.length); k > 0; k--) {
    let same = 0; for (let i = 0; i < k; i++) if (norm(A[A.length - k + i]) === norm(B[i])) same++;
    if (same === k || (k >= 4 && same >= Math.ceil(k * 0.75))) return A.concat(B.slice(k)).join(' ');
  }
  return A.concat(B).join(' ');
}
// every stored file of an entry: audio segments and photos (same sealed store, same cloud objects)
const mediaOf = e => (e.segs || []).concat(e.pics || []);
// a segment's transcript arrived: into the text, once
function mergeSeg(e, g) { if (!g.merged && g.text) { e.text = joinText(e.text, g.text); g.merged = true; } }
const txState = e => {
  const segs = (e.segs || []); if (!segs.length) return '';
  if (segs.every(g => g.st === 'done')) return 'done';
  if (segs.some(g => g.st === 'busy')) return 'busy';
  if (segs.some(g => g.st === 'fail')) return 'fail';
  if (segs.every(g => g.st === 'off' || g.st === 'done')) return 'off';
  return 'todo';
};

// ---------- folders: a sealed list in the meta store; an entry carries its folder name ----------
let folders = [];
async function loadFolders() { folders = []; try { const r = await idb.get('meta', 'folders'); if (r) folders = (await Vault.openJson(r.data, 'jn|folders')).list || []; } catch (e) { folders = []; } }
async function saveFolders() { await idb.put('meta', { id: 'folders', data: await Vault.sealJson({ list: folders }, 'jn|folders') }); tick(); }
const folderNames = () => { const set = new Set(folders); for (const e of live()) if (e.folder) set.add(e.folder); return [...set]; };

// ---------- screens and the back button ----------
const BASE = ['home', 'entry'];
const stack = ['home'];
let popupState = null;
function applyStack() {
  const base = current();
  for (const s of BASE) $(s).hidden = s !== base;
  $('sheet').classList.toggle('open', stack.includes('sheet'));
  $('popup').classList.toggle('open', stack.includes('popup'));
}
function current() { return stack.slice().reverse().find(s => BASE.includes(s)) || 'home'; }
const histState = () => ({ n: stack.length, b: BOOT_ID });
function push(name) { stack.push(name); history.pushState(histState(), ''); applyStack(); }
let navPending = 0; const navQueue = [];
const afterPop = fn => { if (navPending) navQueue.push(fn); else fn(); };
function drainNav() { const q = navQueue.splice(0); for (const fn of q) fn(); }
const lockTop = () => { const t = stack[stack.length - 1]; return t === 'popup' || t === 'sheet'; };
function back() { if (navPending || (locked && !lockTop())) return; if (stack.length > 1) { navPending++; history.back(); } }
// close screen `name` wherever it sits in the stack, exactly once; under the lock screen it waits for the unlock
function closeScreen(name) { const go = () => { if (locked) { navQueue.push(go); return; } const i = stack.indexOf(name); if (i > 0 && !navPending) { navPending++; history.go(-(stack.length - i)); } }; afterPop(go); }
function leave(name) {
  if (name === 'entry') leaveEntry();
  if (name === 'sheet') sheetClosed();
  if (name === 'popup') { const p = popupState; popupState = null; if (p && p.after) setTimeout(p.after, 0); }
}
window.addEventListener('popstate', e => {
  const st = e.state; navPending = 0;
  if (/[#&?](access_token|code|error|error_code)=/.test(location.hash + location.search)) { linkOpened(); return; }
  if (locked && !lockTop()) { history.pushState(histState(), ''); drainNav(); return; }
  if (!st || st.b !== BOOT_ID) {
    if (stack.length > 1) { leave(stack.pop()); history.replaceState(histState(), ''); applyStack(); renderAll(); }
    else history.back();
    drainNav(); return;
  }
  const depth = st.n || 1;
  if (depth > stack.length) { history.go(stack.length - depth); return; }
  while (stack.length > depth && stack.length > 1) leave(stack.pop());
  applyStack(); renderAll(); afterNav();
  drainNav();
});
function renderAll() { renderHome(); renderSyncLine(); if (current() === 'entry') renderEntry(); }

// ---------- popups and toasts ----------
function popup(title, text, buttons, opts) {
  const lockOk = !!(opts && opts.lockOk);
  if ((locked && !lockOk) || passive) return;
  if (stack[stack.length - 1] === 'popup') return;
  const box = $('popupBox');
  box.innerHTML = '<h3>' + esc(title) + '</h3>' + (text ? '<p>' + esc(text) + '</p>' : '');
  for (const b of buttons) {
    const el = document.createElement('button'); el.textContent = b.label; el.className = b.cls || '';
    // b.now: the action runs inside the tap itself (a window the browser would otherwise block), then the popup closes
    el.addEventListener('click', () => { if (b.now && b.fn && !(locked && !popupState.lockOk)) { try { b.fn(); } catch (e) {} if (popupState) popupState.after = null; back(); return; } if (popupState) popupState.after = (locked && !popupState.lockOk) ? null : (b.fn || null); back(); });
    box.appendChild(el);
  }
  popupState = { after: null, lockOk }; push('popup');
}
$('popup').addEventListener('click', e => { if (e.target === $('popup')) back(); });
// a popup with one text field: fn(value) runs after OK (empty values are ignored)
function popupInput(title, text, value, placeholder, okLabel, fn) {
  if (locked || passive) return;
  if (stack[stack.length - 1] === 'popup') return;
  const box = $('popupBox');
  box.innerHTML = '<h3>' + esc(title) + '</h3>' + (text ? '<p>' + esc(text) + '</p>' : '');
  const inp = document.createElement('input'); inp.type = 'text'; inp.value = value || ''; inp.placeholder = placeholder || ''; inp.autocomplete = 'off'; inp.className = 'pinput'; box.appendChild(inp);
  const ok = document.createElement('button'); ok.textContent = okLabel || 'OK'; ok.className = 'primary';
  ok.addEventListener('click', () => { const v = inp.value.trim(); if (popupState) popupState.after = v ? () => fn(v) : null; back(); });
  const no = document.createElement('button'); no.textContent = 'Cancel'; no.className = 'quiet'; no.addEventListener('click', () => { if (popupState) popupState.after = null; back(); });
  box.appendChild(ok); box.appendChild(no);
  inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); ok.click(); } });
  popupState = { after: null, lockOk: false }; push('popup');
  setTimeout(() => inp.focus(), 80);
}
let toastTimer = null, toastAction = null, heldToast = ''; const toastQueue = [];
function endToast(settle) { const t = $('toast'); clearTimeout(toastTimer); t.classList.remove('show'); const a = toastAction; toastAction = null; if (settle && a && a.expire) a.expire(); if (settle) flushToast(); }
function flushToast() { if (toastQueue.length && !toastAction && !$('toast').classList.contains('show')) toast(toastQueue.shift()); }
function settleToast() { endToast(true); }
function toast(msg, action) {
  if (locked) { if (action) { if (action.expire) action.expire(); return; } heldToast = msg; return; }
  const t = $('toast');
  if (!action && toastAction) { if (!toastQueue.includes(msg)) toastQueue.push(msg); return; }
  clearTimeout(toastTimer);
  if (toastAction && toastAction.expire) toastAction.expire();
  toastAction = action || null;
  t.innerHTML = ''; t.appendChild(document.createTextNode(msg));
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.addEventListener('click', () => { endToast(false); action.fn(); flushToast(); }); t.appendChild(b); }
  t.classList.add('show');
  toastTimer = setTimeout(() => endToast(true), action ? 6000 : 2800);
}
