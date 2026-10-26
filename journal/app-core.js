'use strict';
if (self !== top) { try { document.documentElement.hidden = true; } catch (e) {} throw new Error('Journal does not run inside another page.'); }      // never framed by another site
/* Journal core: helpers, the write guard, settings, encrypted storage, the entry model, screens
   and the back button. The app is several plain script files that share one scope (no build
   step); index.html loads them in order. Built the Snapdoc way: nothing readable is ever written
   to the device, one window is active at a time, the lock restarts the page. */
const VERSION = 'v1';
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
let settings = { lockAfter: 60, transcribe: 'ask', segMin: 5, lang: 'auto', keepAudio: true };
const LOCK_AFTER = [5, 60, 300, 1800], SEG_MIN = [2, 5, 10], LANGS = ['auto', 'de', 'en'];
try { Object.assign(settings, JSON.parse(localStorage.getItem(SET_KEY) || '{}')); } catch (e) {}
if (!LOCK_AFTER.includes(+settings.lockAfter)) settings.lockAfter = 60;      // only the offered values: nothing in plain storage can switch the lock off
if (!SEG_MIN.includes(+settings.segMin)) settings.segMin = 5;
if (!['ask', 'auto', 'off'].includes(settings.transcribe)) settings.transcribe = 'ask';
if (!LANGS.includes(settings.lang)) settings.lang = 'auto';
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
}
const entryDur = e => (e.segs || []).reduce((s, g) => s + (g.dur || 0), 0);
const entryLabel = e => (e.title || '').trim() || (e.segs && e.segs.length ? 'Voice memo' : 'Note');
// the transcript as it stands: the edited text if the user touched it, otherwise the segments joined
function entryText(e) {
  if (e.tEdited || !e.segs || !e.segs.length) return e.transcript || '';
  return e.segs.map(g => (g.text || '').trim()).filter(Boolean).join('\n\n');
}
const txState = e => {
  const segs = (e.segs || []); if (!segs.length) return '';
  if (segs.every(g => g.st === 'done')) return 'done';
  if (segs.some(g => g.st === 'busy')) return 'busy';
  if (segs.some(g => g.st === 'fail')) return 'fail';
  if (segs.every(g => g.st === 'off' || g.st === 'done')) return 'off';
  return 'todo';
};

// ---------- screens and the back button ----------
const BASE = ['home', 'rec', 'entry'];
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
  if (name === 'rec') leaveRec();
  if (name === 'popup') { const p = popupState; popupState = null; if (p && p.after) setTimeout(p.after, 0); }
}
window.addEventListener('popstate', e => {
  const st = e.state; navPending = 0;
  if (/[#&?](access_token|code|error|error_code)=/.test(location.hash + location.search)) { linkOpened(); return; }
  if (locked && !lockTop()) { history.pushState(histState(), ''); drainNav(); return; }
  if (!st || st.b !== BOOT_ID) {
    if (stack.length > 1) { if (stack[stack.length - 1] === 'rec' && recording) { history.pushState(histState(), ''); drainNav(); return; } leave(stack.pop()); history.replaceState(histState(), ''); applyStack(); renderAll(); }
    else history.back();
    drainNav(); return;
  }
  const depth = st.n || 1;
  if (depth > stack.length) { history.go(stack.length - depth); return; }
  // Back never ends a recording: the recording screen stays until Stop is tapped
  if (stack.length > depth && stack.includes('rec') && recording && stack.indexOf('rec') >= depth) { history.pushState(histState(), ''); while (stack.length > depth + 1) leave(stack.pop()); applyStack(); drainNav(); return; }
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
    el.addEventListener('click', () => { if (popupState) popupState.after = (locked && !popupState.lockOk) ? null : (b.fn || null); back(); });
    box.appendChild(el);
  }
  popupState = { after: null, lockOk }; push('popup');
}
$('popup').addEventListener('click', e => { if (e.target === $('popup')) back(); });
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
