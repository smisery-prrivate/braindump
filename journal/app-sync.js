'use strict';
/* Journal cloud: sign-in by e-mail link (PKCE, no password), the transcription queue, and the
   optional encrypted cloud copy. The cloud receives ciphertext only: one encrypted file per audio
   segment and one entry whose title, text and transcript are encrypted too, sealed together with
   the change time and the delete flag so the server cannot alter or forge an entry.
   The one exception, by the user's choice: for a transcript an audio segment is sent to the
   app's own cloud function, which hands it to the transcription service and returns the text. */
const LINK_KEY = 'journal.linkAsked', PKCE_KEY = 'journal.pkce', OK_KEY = 'journal.lastOk', MAX_SEG = 52428800;
let session = null, syncTimer = null, syncing = false, syncAgain = false, syncState = '', syncMsg = '', syncCtl = null;
let keyNeed = '', keyEnv = null, keyBusy = false, cursor = { uid: '', at: 0 };
let txBusy = false, txCtl = null, txTimer = null; const txFail = new Map(), upFail = new Map();
// Direct mode: the user's own key for a transcription service, stored encrypted in the vault; the
// phone talks to the service itself, without a cloud project or sign-in. The simple way in
// (Mistral in the EU by default). stt = { provider: 'mistral' | 'elevenlabs' | 'deepgram' | 'openai', key }
let stt = null;
const STT = {
  mistral: { name: 'Mistral Voxtral (EU, Paris)', url: 'https://api.mistral.ai/v1/audio/transcriptions', model: 'voxtral-mini-transcribe-3', kind: 'openai', signup: 'console.mistral.ai' },
  elevenlabs: { name: 'ElevenLabs Scribe (London)', url: 'https://api.elevenlabs.io/v1/speech-to-text', model: 'scribe_v1', kind: 'elevenlabs', signup: 'elevenlabs.io' },
  deepgram: { name: 'Deepgram nova-3 (US, mixed languages)', url: 'https://api.deepgram.com/v1/listen', model: 'nova-3', kind: 'deepgram', signup: 'console.deepgram.com' },
  openai: { name: 'OpenAI gpt-4o-transcribe (US)', url: 'https://api.openai.com/v1/audio/transcriptions', model: 'gpt-4o-transcribe', kind: 'openai', signup: 'platform.openai.com' }
};
const sttUrl = p => (CFG.sttEndpoints && CFG.sttEndpoints[p]) || STT[p].url;      // sttEndpoints: only for the test mock
// can stored audio be transcribed right now? (the phone's recognition only listens live)
const txAvailable = () => settings.engine === 'key' ? !!stt : settings.engine === 'cloud' ? !!(SYNC && session) : false;
const txEngineLabel = () => settings.engine === 'key' ? (stt ? STT[stt.provider].name.split(' (')[0] : 'your own key (not set yet)') : settings.engine === 'cloud' ? 'your cloud function' : 'the phone\'s speech recognition';
async function loadStt() { stt = null; try { const r = await idb.get('meta', 'stt'); if (r) stt = await Vault.openJson(r.data, 'jn|stt'); } catch (e) { stt = null; } if (stt && !STT[stt.provider]) stt = null; }
async function saveStt(cfg) { stt = cfg; if (cfg) await idb.put('meta', { id: 'stt', data: await Vault.sealJson(cfg, 'jn|stt') }); else await idb.del('meta', 'stt'); }
const jwtPayload = t => JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

// ---------- session (stored encrypted like everything else) ----------
async function loadSession() {
  session = null;
  try { const r = await idb.get('meta', 'session'); if (r) session = await Vault.openJson(r.data, 'jn|session'); } catch (e) { session = null; }
  try { const c = await idb.get('meta', 'cursor'); if (c) cursor = await Vault.openJson(c.data, 'jn|cursor'); } catch (e) { cursor = { uid: '', at: 0 }; }
  if (session) await Vault.loadCloudKey(session.uid).catch(() => {});
}
async function storeSession() {
  if (session) await idb.put('meta', { id: 'session', data: await Vault.sealJson(session, 'jn|session') }); else await idb.del('meta', 'session');
  tick();
}

async function storeCursorNow() { await idb.put('meta', { id: 'cursor', data: await Vault.sealJson(cursor, 'jn|cursor') }); }
// Tokens from a sign-in link. Accepted only when this browser asked for a link within the last
// hour, nobody is signed in, and the cloud confirms the token. t: { code } (PKCE) or tokens.
async function adoptLink(t) {
  let asked = 0; try { asked = +localStorage.getItem(LINK_KEY) || 0; localStorage.removeItem(LINK_KEY); } catch (e) {}
  if (!SYNC) return 'The cloud is not switched on in this version.';
  if (session) return 'A sign-in link was opened, but this device is already signed in. Sign out first to use another account.';
  if (!asked || Date.now() - asked > 3600000) return 'This sign-in link was not requested from this browser, or it is older than an hour. Request a new one in the menu.';
  if (t.code) {
    let verifier = ''; try { verifier = localStorage.getItem(PKCE_KEY) || ''; localStorage.removeItem(PKCE_KEY); } catch (e) {}
    if (!verifier) return 'This sign-in link was not requested from this browser. Request a new one in the menu.';
    try {
      const r = await fetch(SYNC.url + '/auth/v1/token?grant_type=pkce', { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ auth_code: t.code, code_verifier: verifier }) });
      if (!r.ok) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
      const j = await r.json(); if (!j.access_token || !j.refresh_token) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
      t = { access_token: j.access_token, refresh_token: j.refresh_token };
    } catch (e) { return 'The sign-in link could not be confirmed (no connection). Request a new one in the menu.'; }
  }
  let u, p;
  try {
    p = jwtPayload(t.access_token);
    const r = await fetch(SYNC.url + '/auth/v1/user', { credentials: 'omit', cache: 'no-store', headers: { apikey: SYNC.key, Authorization: 'Bearer ' + t.access_token } });
    if (!r.ok) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
    u = await r.json();
  } catch (e) { return 'The sign-in link could not be confirmed (no connection). Request a new one in the menu.'; }
  if (!u || !u.id || u.id !== p.sub) return 'The sign-in link could not be confirmed. Request a new one in the menu.';
  session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: p.exp, email: u.email || '', uid: u.id };
  await storeSession();
  if (cursor.uid !== session.uid) {                                 // first sign-in, or another account: this cloud knows nothing from here yet
    for (const e of entries) { e.srv = 0; e.pushed_at = 0; e.up = {}; e.cloud = false; e.purged = false; }
    cursor = { uid: session.uid, at: 0 }; await storeCursorNow().catch(() => {});
    try { localStorage.removeItem(OK_KEY); } catch (e) {}
    await Vault.dropCloudKey();
    for (const e of entries) await persist(e, { quiet: true });
  }
  await Vault.loadCloudKey(session.uid).catch(() => {});
  return '';
}
async function signOut() {
  session = null; keyNeed = ''; keyEnv = null;
  abortSync(); abortTranscribe();
  await storeSession(); await Vault.dropCloudKey();
  setSyncState(''); renderAll();
}
async function ensureSession() {
  if (!SYNC || !session) return false;
  if (Date.now() / 1000 < session.expires_at - 60) return true;
  try {
    const r = await fetch(SYNC.url + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', credentials: 'omit', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) {
      const mine = session.access_token; await loadSession();
      if (session && session.access_token !== mine && Date.now() / 1000 < session.expires_at - 60) return true;
      setSyncState('error', 'The sign-in has expired. Sign out and sign in again.'); return false;
    }
    const t = await r.json(), p = jwtPayload(t.access_token);
    if (!session || p.sub !== session.uid) return false;
    session = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: p.exp, email: session.email, uid: session.uid };
    await storeSession();
    return true;
  } catch (e) { return false; }
}
async function api(method, path, opts) {
  const r = await fetch(SYNC.url + path, { method, credentials: 'omit', cache: 'no-store', signal: (opts && opts.signal) || (syncing && syncCtl ? syncCtl.signal : undefined),
    headers: Object.assign({ apikey: SYNC.key, Authorization: 'Bearer ' + session.access_token }, (opts && opts.headers) || {}), body: opts && opts.body });
  if (r.status === 401 && session && !(opts && opts.retried) && !path.startsWith('/auth/')) {
    session.expires_at = 0;
    if (await ensureSession()) return api(method, path, Object.assign({}, opts, { retried: true }));
  }
  return r;
}
async function httpError(what, r) {
  let t = ''; try { t = await r.text(); } catch (e) {}
  if (/PGRST205|Bucket not found|schema cache|does not exist/i.test(t) || (r.status === 404 && /rest\/v1/.test(r.url || '')))
    return new Error('The cloud is not set up yet. Run supabase-schema.sql once in the Supabase SQL editor.');
  if (r.status === 404 && /functions\/v1/.test(r.url || '')) return new Error('The transcription function is not deployed yet (see README).');
  if (r.status === 413) return new Error(what + ' failed: the file is too large.');
  let msg = ''; try { const j = JSON.parse(t); msg = j.error || j.msg || j.message || ''; } catch (e) {}
  return new Error(what + ' failed (' + r.status + ') ' + (msg || t).slice(0, 140));
}
async function sendMagicLink(email) {
  const redirect = encodeURIComponent(location.origin + location.pathname);
  const raw = crypto.getRandomValues(new Uint8Array(48)); let verifier = ''; for (const b of raw) verifier += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66];
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode.apply(null, digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  try { localStorage.setItem(PKCE_KEY, verifier); } catch (e) { return { ok: false, msg: 'This browser blocks local storage; sign-in is not possible here.' }; }
  let r;
  try { r = await fetch(SYNC.url + '/auth/v1/otp?redirect_to=' + redirect, { method: 'POST', credentials: 'omit', headers: { apikey: SYNC.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: true, code_challenge: challenge, code_challenge_method: 's256' }) }); }
  catch (e) { return { ok: false, msg: navigator.onLine === false ? 'No internet connection. Try again when you are online.' : 'The cloud could not be reached. Try again later.' }; }
  if (r.ok) { try { localStorage.setItem(LINK_KEY, String(Date.now())); } catch (e) {} return { ok: true }; }
  let msg = 'Sending failed. Try again later.';
  if (r.status === 429) msg = 'Too many sign-in mails in a short time. Try again in about an hour.';
  else { try { const j = await r.json(); if (j.msg || j.error_description) msg = 'Sending failed: ' + (j.msg || j.error_description); } catch (e) {} }
  return { ok: false, msg };
}

// ---------- transcription queue ----------
// One segment at a time, newest memo first. The previous segment's last words go along as a hint,
// so a sentence cut by the segment border is continued correctly. A refused segment is tried again
// after a growing pause; the entry shows the reason meanwhile.
function askTranscribe(e) {
  popup('Transcribe this memo?', (settings.engine === 'key' && stt ? 'The audio is sent, encrypted in transit, straight to ' + STT[stt.provider].name.split(' (')[0] + ' with your key.' : 'The audio is sent, encrypted in transit, to your own cloud function and from there to the transcription service.') + ' The text comes back and is stored encrypted here. German and English are both understood.', [
    { label: 'Transcribe', cls: 'primary', fn: () => wantTranscribe(e) },
    { label: 'Always transcribe', fn: () => { settings.transcribe = 'auto'; saveSettings(); wantTranscribe(e); } },
    { label: 'Not now', cls: 'quiet' }]);
}
function wantTranscribe(e) {
  if (!txAvailable()) {
    if (settings.engine === 'phone') popup('Stored audio needs a key or the cloud', 'The phone\'s speech recognition only listens live while you record. To transcribe this recording afterwards, choose "Own key" or "Cloud function" under Menu, Transcription.', [{ label: 'Open the menu', cls: 'primary', fn: openSheet }, { label: 'Not now', cls: 'quiet' }]);
    else { toast(settings.engine === 'key' ? 'Enter your key under Menu, Transcription.' : 'Sign in under Menu, Cloud.'); openSheet(); }
    return;
  }
  e.tx = true;
  for (const g of e.segs) if (g.st === 'off' || g.st === 'fail' || g.st === 'busy') { g.st = 'todo'; txFail.delete(g.id); }
  persist(e); renderAll(); scheduleTranscribe(0);
}
function retranscribe(e) {
  for (const g of e.segs) { g.st = 'todo'; g.text = ''; g.merged = false; txFail.delete(g.id); }
  wantTranscribe(e);
}
function scheduleTranscribe(ms) { if (!txAvailable() || passive) return; clearTimeout(txTimer); txTimer = setTimeout(transcribeNow, ms == null ? 600 : ms); }
function abortTranscribe() { if (txCtl) txCtl.abort(); }
function nextTxJob() {
  const now = Date.now();
  for (const e of live()) {
    if (!e.tx || e.broken) continue;
    for (const g of e.segs) {
      if (g.st === 'todo') return { e, g };
      if (g.st === 'fail') { const f = txFail.get(g.id); if (!f || f.until <= now) return { e, g }; }
    }
  }
  return null;
}
function txFailUntil(e) {
  let best = 0; for (const g of e.segs) if (g.st === 'fail') { const f = txFail.get(g.id); if (f && f.until > Date.now() && (!best || f.until < best)) best = f.until; }
  if (!best) return ''; const m = Math.ceil((best - Date.now()) / 60000); return m <= 1 ? 'in a minute' : 'in ' + m + ' min';
}
const setBusy = on => $('busy').classList.toggle('on', !!on);
async function transcribeNow() {
  if (txBusy || locked || passive || !Vault.isOpen() || !txAvailable()) return;
  txBusy = true; txCtl = new AbortController(); setBusy(true);
  try {
    for (;;) {
      if (locked || passive || !txAvailable() || txCtl.signal.aborted) break;
      const job = nextTxJob(); if (!job) break;
      const { e, g } = job;
      g.st = 'busy'; delete g.err; if (curEntry === e) renderTxState(); renderHome();
      try {
        if (settings.engine === 'cloud' && !(await ensureSession())) throw new Error('Not signed in.');
        const blob = await (typeof segBlob === 'function' ? segBlob(e, g) : segGet(g.id, g.mime));
        if (!blob) throw new Error('the audio of this part is not on this device');
        if (blob.size > MAX_SEG) throw new Error('this part is too large');
        const k = e.segs.indexOf(g), prev = k > 0 ? (e.segs[k - 1].text || '').trim().slice(-200) : '';
        const out = await transcribeRequest(blob, g, prev, e.lang || settings.lang);
        if (!e.deleted && g.st === 'busy') { g.text = out.text; if (out.language) g.lang = out.language; g.st = 'done'; g.merged = false; mergeSeg(e, g); txFail.delete(g.id); }
      } catch (err) {
        if (g.st === 'busy') {
          if (txCtl.signal.aborted) g.st = 'todo';
          else {
            const f = txFail.get(g.id) || { n: 0 }; f.n++; f.until = Date.now() + Math.min(3600000, 60000 * Math.pow(4, f.n - 1)); txFail.set(g.id, f);
            g.st = 'fail'; g.err = errText(err);
          }
        }
      }
      if (!e.deleted) await persist(e);
      if (curEntry === e) renderEntry(); renderHome();
      if (txState(e) === 'done' && session) scheduleSync();
    }
  } finally { txBusy = false; txCtl = null; setBusy(false); if (nextTxJob() && !locked && !passive) scheduleTranscribe(30000); }
}
async function transcribeRequest(blob, g, prompt, lang) {
  if (settings.engine === 'key') { if (!stt) throw new Error('no key set'); return transcribeDirect(blob, g, prompt, lang); }
  if (!session) throw new Error('Not signed in.');
  const fd = new FormData();
  fd.append('file', blob, 'segment.' + extOf(g.mime));
  if (lang && lang !== 'auto') fd.append('language', lang);
  if (prompt) fd.append('prompt', prompt);
  const r = await api('POST', '/functions/v1/transcribe', { body: fd, signal: txCtl ? txCtl.signal : undefined });
  if (!r.ok) throw await httpError('Transcription', r);
  const j = await r.json();
  if (typeof j.text !== 'string') throw new Error('the transcription service returned no text');
  return { text: j.text.trim(), language: j.language || '' };
}

// the phone talks to the transcription service itself, with the user's own key
const netErr = e => e && e.name === 'AbortError' ? e : new Error(navigator.onLine === false ? 'no internet connection' : 'the service could not be reached from the browser (offline, or it does not allow direct requests from a web app; the cloud function route in the menu always works)');
async function transcribeDirect(blob, g, prompt, lang) {
  const P = STT[stt.provider], signal = txCtl ? txCtl.signal : undefined;
  const fail = async r => { let t = ''; try { t = await r.text(); } catch (e) {} let msg = ''; try { const j = JSON.parse(t); msg = (j.error && (j.error.message || j.error)) || j.err_msg || j.message || ''; } catch (e) {} if (r.status === 401 || r.status === 403) msg = msg || 'the key was refused'; if (r.status === 429) msg = msg || 'rate limit reached, trying again later'; return new Error('Transcription failed (' + r.status + ') ' + String(msg || t).slice(0, 140)); };
  if (P.kind === 'openai') {
    const fd = new FormData();
    fd.append('file', blob, 'segment.' + extOf(g.mime));
    fd.append('model', P.model);
    fd.append('response_format', 'json');
    if (lang && lang !== 'auto') fd.append('language', lang);
    if (prompt) fd.append('prompt', prompt);
    const r = await fetch(sttUrl(stt.provider), { method: 'POST', credentials: 'omit', headers: { Authorization: 'Bearer ' + stt.key }, body: fd, signal }).catch(e => { throw netErr(e); });
    if (!r.ok) throw await fail(r);
    const j = await r.json();
    if (typeof j.text !== 'string') throw new Error('the transcription service returned no text');
    return { text: j.text.trim(), language: j.language || '' };
  }
  if (P.kind === 'elevenlabs') {
    const fd = new FormData();
    fd.append('file', blob, 'segment.' + extOf(g.mime));
    fd.append('model_id', P.model);
    if (lang && lang !== 'auto') fd.append('language_code', lang);
    const r = await fetch(sttUrl(stt.provider), { method: 'POST', credentials: 'omit', headers: { 'xi-api-key': stt.key }, body: fd, signal }).catch(e => { throw netErr(e); });
    if (!r.ok) throw await fail(r);
    const j = await r.json();
    if (typeof j.text !== 'string') throw new Error('the transcription service returned no text');
    return { text: j.text.trim(), language: j.language_code || '' };
  }
  const q = new URLSearchParams({ model: P.model, smart_format: 'true', punctuate: 'true', paragraphs: 'true', language: lang && lang !== 'auto' ? lang : 'multi' });
  for (const w of (prompt || '').split(/\s+/).filter(x => x.length > 3).slice(-20)) q.append('keyterm', w);
  const r = await fetch(sttUrl(stt.provider) + '?' + q, { method: 'POST', credentials: 'omit', headers: { Authorization: 'Token ' + stt.key, 'Content-Type': g.mime || 'application/octet-stream' }, body: blob, signal }).catch(e => { throw netErr(e); });
  if (!r.ok) throw await fail(r);
  const j = await r.json(), alt = j && j.results && j.results.channels && j.results.channels[0] && j.results.channels[0].alternatives && j.results.channels[0].alternatives[0];
  const text = alt && ((alt.paragraphs && alt.paragraphs.transcript) || alt.transcript);
  if (typeof text !== 'string') throw new Error('the transcription service returned no text');
  return { text: text.trim(), language: (j.results.channels[0].detected_language || '') };
}

// ---------- the encryption password ----------
async function ensureCloudKey() {
  if (Vault.hasCloudKey(session.uid)) return true;
  if (keyNeed) return false;
  const r = await api('GET', '/rest/v1/jn_keys?select=salt,iter,wrapped&user_id=eq.' + session.uid);
  if (!r.ok) throw await httpError('Checking the cloud', r);
  const rows = await r.json();
  keyEnv = rows[0] || null; keyNeed = keyEnv ? 'enter' : 'create';
  setSyncState('needkey');
  return false;
}
async function submitKey(pw, pw2, hint) {
  if (keyBusy) return;
  if (keyNeed !== 'enter') {
    if (pw.length < 10) { hint.textContent = 'Use at least 10 characters. A few random words work well.'; return; }
    if (pw !== pw2) { hint.textContent = 'The two entries differ.'; return; }
  } else if (!pw) return;
  keyBusy = true; hint.textContent = 'Working…';
  try {
    if (!(await ensureSession())) throw new Error('Not signed in.');
    const json = { 'Content-Type': 'application/json', Prefer: 'return=minimal' };
    if (keyNeed === 'create') {
      const ne = await Vault.newEnvelope(pw, session.uid);
      const r = await api('POST', '/rest/v1/jn_keys', { headers: json, body: JSON.stringify(Object.assign({ user_id: session.uid, created_at: Date.now() }, ne.env)) });
      if (r.status === 409) { keyNeed = ''; keyEnv = null; await ensureCloudKey(); toast('Another device set the password meanwhile. Enter that one.'); return; }
      if (!r.ok) throw await httpError('Saving the key', r);
      await ne.commit();
    } else if (keyNeed === 'change') {
      const env = await Vault.rewrapEnvelope(pw, session.uid);
      const r = await api('PATCH', '/rest/v1/jn_keys?user_id=eq.' + session.uid, { headers: json, body: JSON.stringify(env) });
      if (!r.ok) throw await httpError('Saving the key', r);
      keyNeed = ''; toast('Encryption password changed'); renderSyncBox(); return;
    } else await Vault.openEnvelope(keyEnv, pw, session.uid);
    keyNeed = ''; keyEnv = null; setSyncState(''); toast('Encrypted cloud copy is on'); renderAll(); syncNow();
  } catch (e) { hint.textContent = errText(e); }
  finally { keyBusy = false; }
}

// ---------- the encrypted cloud copy ----------
// Rules: every audio segment is one encrypted object, written once and never replaced. The entry
// (title, notes, transcript, segment list) is sealed with the cloud key together with its change
// time and delete flag; the newest change time wins per entry (one person, few devices). An entry
// is sent only after every segment it names is in the cloud, so the cloud never names audio it
// does not hold. Deleted entries become sealed delete markers; their objects are removed afterwards.
function setSyncState(s, msg) { syncState = s; syncMsg = msg || ''; renderSyncLine(); renderSyncBox(); }
function scheduleSync() { if (!SYNC || !session || passive) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2000); }
function abortSync() { if (syncCtl) syncCtl.abort(); }
function syncRetry() { upFail.clear(); if (syncState === 'error') setSyncState(''); syncNow(); }
const objName = (u, segId) => u + '/' + segId;
const cloudFields = e => ({ id: e.id, created: e.created, updated_at: e.updated_at, title: e.title || '', text: e.text || '', transcript: e.transcript || '', tEdited: !!e.tEdited, lang: e.lang || 'auto', mime: e.mime || '',
  segs: (e.segs || []).map(g => ({ id: g.id, i: g.i, dur: g.dur, mime: g.mime, size: g.size, text: g.text || '', st: g.st === 'done' ? 'done' : 'todo', lang: g.lang || '', merged: !!g.merged, live: !!g.live })), state: 'done', dur: e.dur || 0, deleted: !!e.deleted, del_at: e.del_at || 0, tx: !!e.tx, merged: !!e.merged });
const sealedMeta = e => Vault.csealJson(e.deleted ? { id: e.id, deleted: true, updated_at: e.updated_at, del_at: e.del_at || 0 } : cloudFields(e), 'jn|entry|' + e.id);
async function applyRow(row) {
  let m; try { m = await Vault.copenJson(row.meta, 'jn|entry|' + row.id); } catch (e) { return 'unreadable'; }
  if (!m || m.id !== row.id || +m.updated_at !== +row.updated_at || !!m.deleted !== !!row.deleted) return 'tampered';      // the plain columns must say what the seal says
  const local = byId(row.id);
  if (!local) {
    if (m.deleted) return 'ok';
    const e = Object.assign({ segs: [] }, m, { cloud: true, srv: row.synced_at, pushed_at: m.updated_at, up: {}, broken: false });
    for (const g of e.segs) e.up[g.id] = true;
    mergeText(e);
    entries.push(e); entries.sort((a, b) => (b.created || 0) - (a.created || 0));
    await persist(e, { quiet: true }); return 'ok';
  }
  if (m.updated_at > (local.updated_at || 0)) {
    if (curEntry === local && current() === 'entry') { commitTitle(); commitText(); if (local.updated_at >= m.updated_at) { local.srv = row.synced_at; await persist(local, { quiet: true }); return 'ok'; } }
    if (m.deleted) { const was = local.deleted; Object.assign(local, { deleted: true, del_at: m.del_at || Date.now(), updated_at: m.updated_at, srv: row.synced_at, pushed_at: m.updated_at }); if (!was) { if (curEntry === local) { stopPlayer(); closeScreen('entry'); toast('This entry was deleted on another device.'); } purgeEntryData(local).catch(() => {}); } }
    else {
      const up = local.up || {}; for (const g of m.segs || []) up[g.id] = true;
      for (const g of local.segs || []) if (!(m.segs || []).some(x => x.id === g.id)) { idb.del('segs', g.id).catch(() => {}); }
      Object.assign(local, m, { cloud: true, srv: row.synced_at, pushed_at: m.updated_at, up, broken: false });
      mergeText(local);
      if (curEntry === local) { stopPlayer(); renderEntry(); }
    }
    await persist(local, { quiet: true }); return 'ok';
  }
  local.srv = row.synced_at; if (m.updated_at === local.updated_at) { local.pushed_at = local.updated_at; local.cloud = true; const up = local.up || {}; for (const g of m.segs || []) up[g.id] = true; local.up = up; }
  await persist(local, { quiet: true }); return 'ok';
}
async function syncNow() {
  if (!SYNC || !session || passive || locked || !Vault.isOpen()) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true; syncCtl = new AbortController(); const uid = session.uid;
  try {
    if (!(await ensureSession())) return;
    if (!(await ensureCloudKey())) return;
    setSyncState('busy', 'Syncing');
    // pull: everything stamped after the last visit
    let bad = 0;
    for (;;) {
      if (!session || session.uid !== uid || locked || passive) return;
      const r = await api('GET', '/rest/v1/jn_entries?select=id,meta,updated_at,deleted,synced_at&user_id=eq.' + uid + '&synced_at=gt.' + (cursor.at || 0) + '&order=synced_at.asc,id.asc&limit=200');
      if (!r.ok) throw await httpError('Reading the cloud', r);
      const rows = await r.json(); if (!rows.length) break;
      for (const row of rows) { const res = await applyRow(row); if (res !== 'ok') bad++; cursor.at = Math.max(cursor.at || 0, +row.synced_at || 0); }
      cursor.uid = uid; await storeCursorNow();
      if (rows.length < 200) break;
    }
    // push: entries changed since the cloud last accepted them, segments first
    let failed = 0, n = 0; const todo = entries.filter(e => !e.broken && e.state === 'done' && (e.pushed_at || 0) < (e.updated_at || 0));
    for (const e of todo) {
      if (!session || session.uid !== uid || locked || passive) return;
      const f = upFail.get(e.id); if (f && f.until > Date.now()) { failed++; continue; }
      n++; setSyncState('busy', (todo.length > 1 ? 'Uploading ' + n + ' of ' + todo.length : 'Uploading') + ' · ' + entryLabel(e));
      try {
        const u = e.updated_at;
        if (!e.deleted) {
          e.up = e.up || {};
          for (const g of e.segs) {
            if (e.up[g.id]) continue;
            const blob = await segGet(g.id, g.mime);
            if (!blob) { if (e.cloud) { e.up[g.id] = true; continue; } throw new Error('the audio of part ' + (e.segs.indexOf(g) + 1) + ' is missing on this device'); }
            if (blob.size > MAX_SEG) throw new Error('a part is larger than 50 MB');
            const sealed = await Vault.cseal(await blob.arrayBuffer(), 'jn|seg|' + g.id);
            const r = await api('POST', '/storage/v1/object/jn/' + objName(uid, g.id), { headers: { 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' }, body: sealed });
            if (!r.ok) throw await httpError('Uploading audio', r);
            e.up[g.id] = true; await persist(e, { quiet: true });
          }
        }
        const meta = await sealedMeta(e);
        const r = await api('POST', '/rest/v1/jn_entries', { headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ id: e.id, user_id: uid, meta, updated_at: e.updated_at, deleted: !!e.deleted }) });
        if (!r.ok) throw await httpError('Saving the entry', r);
        const rows = await r.json(); const srv = rows && rows[0] ? +rows[0].synced_at : 0;
        if (e.updated_at === u) { e.pushed_at = u; e.cloud = true; if (srv) e.srv = srv; }      // the bookmark is not moved by a push: rows other devices wrote meanwhile must still be pulled
        upFail.delete(e.id);
        if (e.deleted && !e.purged && e.segs && e.segs.length) {
          const r2 = await api('DELETE', '/storage/v1/object/jn', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: e.segs.map(g => objName(uid, g.id)) }) });
          if (r2.ok || r2.status === 404) e.purged = true;
        }
        await persist(e, { quiet: true });
      } catch (err) {
        if (syncCtl.signal.aborted) return;
        const f = upFail.get(e.id) || { n: 0 }; f.n++; f.until = Date.now() + Math.min(3600000, 60000 * Math.pow(4, f.n - 1)); f.msg = errText(err); upFail.set(e.id, f); failed++;
      }
    }
    // delete markers whose objects are still owed
    for (const e of entries) {
      if (!e.deleted || e.purged || !e.segs || !e.segs.length || (e.pushed_at || 0) < (e.updated_at || 0)) continue;
      if (!session || session.uid !== uid || locked || passive) return;
      try { const r2 = await api('DELETE', '/storage/v1/object/jn', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefixes: e.segs.map(g => objName(uid, g.id)) }) }); if (r2.ok || r2.status === 404) { e.purged = true; await persist(e, { quiet: true }); } } catch (err) {}
    }
    await storeCursorNow();
    if (failed) { const first = [...upFail.values()][0]; setSyncState('error', failed + ' entr' + (failed > 1 ? 'ies' : 'y') + ' could not be uploaded' + (first && first.msg ? ': ' + first.msg : '')); }
    else { try { localStorage.setItem(OK_KEY, String(Date.now())); } catch (e) {} setSyncState(bad ? 'error' : '', bad ? bad + ' cloud entries could not be read or did not match their seal and were ignored.' : ''); }
    renderAll();
  } catch (e) {
    if (!(syncCtl && syncCtl.signal.aborted)) setSyncState(navigator.onLine === false || /Failed to fetch|NetworkError|Load failed/i.test(errText(e)) ? 'offline' : 'error', errText(e));
  } finally {
    syncing = false; syncCtl = null;
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}
// a segment that only the cloud holds: fetched, opened with the cloud key, stored here, returned
async function fetchSeg(e, g) {
  if (!SYNC || !session || !Vault.hasCloudKey(session.uid) || !(e.up && e.up[g.id]) || !(await ensureSession())) return null;
  const r = await api('GET', '/storage/v1/object/jn/' + objName(session.uid, g.id), { signal: new AbortController().signal });
  if (!r.ok) return null;
  let plain; try { plain = await Vault.copen(await r.arrayBuffer(), 'jn|seg|' + g.id); } catch (err) { return null; }
  const blob = new Blob([plain], { type: g.mime });
  try { await segPut(g.id, blob, { entry: e.id, mime: g.mime, size: blob.size, dur: g.dur, i: g.i }); } catch (err) {}
  return blob;
}

// ---------- status line and the cloud part of the menu ----------
function lastOkLabel() {
  let okAt = 0; try { okAt = +localStorage.getItem(OK_KEY) || 0; } catch (e) {}
  if (!okAt) return 'never';
  const m = Math.floor((Date.now() - okAt) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.floor(m / 60) + ' h ago';
}
function renderSyncLine() {
  const el = $('syncline'); el.className = 'subline';
  if (txBusy) { el.textContent = '↻ Transcribing…'; return; }
  const eng = settings.engine === 'phone' ? 'transcribes with the phone' : settings.engine === 'key' ? (stt ? 'transcribes with your key' : 'key missing · tap') : (session ? 'transcribes via your cloud' : 'sign in for transcription · tap');
  if (!SYNC) { el.textContent = 'Encrypted on this device · ' + eng; return; }
  if (!session) { el.textContent = 'Encrypted on this device · ' + eng; return; }
  if (!Vault.hasCloudKey(session.uid)) {
    el.className = 'subline err';
    el.textContent = syncState === 'error' ? '⚠ ' + syncMsg : keyNeed ? 'The cloud copy is waiting for your encryption password · tap here' : 'Connecting to the cloud…';
    return;
  }
  if (syncState === 'error') { el.className = 'subline err'; el.textContent = '⚠ Cloud copy failed · last success ' + lastOkLabel() + ' · tap for details'; return; }
  if (syncState === 'offline') { el.textContent = '⏸ Offline · last copied ' + lastOkLabel(); return; }
  if (syncState === 'busy') { el.textContent = '↻ ' + syncMsg + '…'; return; }
  let ok = 0; try { ok = +localStorage.getItem(OK_KEY); } catch (e) {}
  el.textContent = ok ? '✓ Encrypted cloud copy on · last ' + lastOkLabel() : 'Connecting to the cloud…';
}
$('syncline').addEventListener('click', () => openSheet());
function renderSyncBox() {
  const box = $('syncBox'); if (!box) return;
  const hasKey = !!session && Vault.hasCloudKey(session.uid);
  const mode = !SYNC ? 'none' : !session ? 'signin' : keyNeed === 'change' ? 'change' : hasKey ? 'on' : keyNeed || 'check';
  if (box.dataset.mode === mode && ['signin', 'create', 'enter', 'change'].includes(mode)) return;
  box.dataset.mode = mode;
  const signOutBtn = '<button id="signOut" class="btn quiet">Sign out on this device</button>';
  if (mode === 'none') { box.innerHTML = '<p>The cloud is not switched on in this version. Your journal stays on this device, encrypted. Keep a backup (below).</p>'; return; }
  if (mode === 'signin') {
    box.innerHTML = '<p>Sign in by e-mail, without a password, for transcription and an encrypted copy of your journal in your own cloud project (so a lost phone does not mean a lost journal).</p>' +
      '<input id="email" type="email" placeholder="you@example.com" autocomplete="email"><button id="sendLink" class="btn primary">Send sign-in link</button><div class="hint" id="authHint"></div>';
    let sending = false;
    $('sendLink').addEventListener('click', async () => {
      const email = $('email').value.trim(), hint = $('authHint');
      if (sending) return;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { hint.textContent = 'Please enter a valid e-mail address.'; return; }
      sending = true; hint.textContent = 'Sending…';
      try { const r = await sendMagicLink(email); hint.textContent = r.ok ? 'The mail is on its way. Open the link in it in this same browser on this device; the app continues by itself.' : r.msg; }
      catch (e) { hint.textContent = 'Sending failed: ' + errText(e); } finally { sending = false; }
    });
    return;
  }
  if (mode === 'check') {
    box.innerHTML = '<div class="statecard' + (syncState === 'error' ? ' err' : '') + '"><div class="t">Signed in as ' + esc(session.email || '') + '</div><div class="s">' + (syncState === 'error' ? esc(syncMsg) : 'Checking the cloud…') + '</div></div>' +
      '<button id="syncBtn" class="btn">Try again</button>' + signOutBtn;
  } else if (mode === 'create' || mode === 'change') {
    box.innerHTML = '<p>' + (mode === 'create' ? '<b>Choose an encryption password.</b> Your journal is encrypted on this phone before it is uploaded, so nobody else can read it, not even the cloud provider.' : '<b>New encryption password.</b> Other devices ask for it the next time they set up the cloud copy.') +
      ' It is needed once on each new device. It cannot be reset: without it the cloud copy cannot be opened.</p>' +
      '<input id="pw1" type="password" autocomplete="new-password" placeholder="Encryption password"><input id="pw2" type="password" autocomplete="new-password" placeholder="Repeat">' +
      '<button id="pwSuggest" class="btn">Suggest a strong one</button><button id="pwGo" class="btn primary">' + (mode === 'create' ? 'Turn on the encrypted cloud copy' : 'Change password') + '</button><div class="hint" id="pwHint"></div>' +
      (mode === 'create' ? '<div class="hint">Transcription works already; the cloud copy starts once the password is set.</div>' + signOutBtn : '<button id="pwCancel" class="btn quiet">Cancel</button>');
    $('pwSuggest').addEventListener('click', () => { const s = Vault.suggestPassword(); for (const id of ['pw1', 'pw2']) { $(id).type = 'text'; $(id).value = s; } $('pwHint').textContent = 'Save it in your password manager now, before you continue.'; });
    $('pwGo').addEventListener('click', () => submitKey($('pw1').value, $('pw2').value, $('pwHint')));
    if (mode === 'change') $('pwCancel').addEventListener('click', () => { keyNeed = ''; renderSyncBox(); });
  } else if (mode === 'enter') {
    box.innerHTML = '<p><b>Enter your encryption password.</b> It is the one you chose when you first turned on the cloud copy. It opens your journal on this device and is never sent anywhere.</p>' +
      '<input id="pw1" type="password" autocomplete="current-password" placeholder="Encryption password"><button id="pwGo" class="btn primary">Unlock the cloud copy</button><div class="hint" id="pwHint"></div>' + signOutBtn;
    $('pwGo').addEventListener('click', () => submitKey($('pw1').value, '', $('pwHint')));
    $('pw1').addEventListener('keydown', e => { if (e.key === 'Enter') submitKey($('pw1').value, '', $('pwHint')); });
  } else {
    const err = syncState === 'error', off = syncState === 'offline';
    const waiting = entries.filter(e => !e.broken && e.state === 'done' && (e.pushed_at || 0) < (e.updated_at || 0)).length;
    box.innerHTML = '<div class="statecard' + (err ? ' err' : '') + '"><div class="t">' + (err ? '⚠ The cloud copy has a problem' : off ? '⏸ Offline' : syncState === 'busy' ? '↻ ' + esc(syncMsg) : '✓ Encrypted cloud copy on') + '</div>' +
      '<div class="s">Signed in as ' + esc(session.email || '') + '<br>Last copied ' + lastOkLabel() + (waiting ? ' · ' + waiting + ' waiting' : '') + (err && syncMsg ? '<br>' + esc(syncMsg) : '') + '</div></div>' +
      '<button id="syncBtn" class="btn">Copy now</button><button id="pwChange" class="btn quiet">Change encryption password</button>' + signOutBtn;
    $('pwChange').addEventListener('click', () => { keyNeed = 'change'; renderSyncBox(); });
  }
  if ($('syncBtn')) $('syncBtn').addEventListener('click', syncRetry);
  if ($('signOut')) $('signOut').addEventListener('click', () => popup('Sign out on this device?', 'Your journal stays on this phone. Transcription and the cloud copy stop until you sign in and enter your encryption password again.', [{ label: 'Sign out', fn: signOut }, { label: 'Stay signed in', cls: 'quiet' }]));
}
