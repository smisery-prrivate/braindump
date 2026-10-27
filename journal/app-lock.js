'use strict';
/* Journal lock screen and the menu sheet (cloud, transcription, app lock, backup). Ported from
   Snapdoc: the lock never cuts work off, and the page restarts when the work is done, which also
   clears the key and every decrypted segment from memory. A running recording counts as work in
   flight: the lock screen covers the app, the microphone keeps going, Stop needs the unlock. */
let locked = false, softLock = false, unlocking = false, hiddenAt = 0, pinStep = false, hideTimer = null, softTimer = null, storageAtRisk = false;
const unlockWaiters = [];
const COVERED = ['home', 'rec', 'entry', 'sheet'];
const workInFlight = () => recording || recFinishing || segWrites > 0 || persistQueued > 0 || txBusy || syncing || backupBusy;

// ---------- lock screen ----------
function showLock(soft) {
  if (dictOn) stopDictation();
  let n = 0; for (let i = stack.length - 1; i > 0 && (stack[i] === 'popup' || stack[i] === 'sheet'); i--) n++;
  if (n) { if (popupState) popupState.after = null; history.go(-n); }
  locked = true; softLock = !!soft;
  for (const id of COVERED) $(id).inert = true;
  $('toast').classList.remove('show');
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const pin = Vault.lockType() === 'pin', num = Vault.pinIsNumeric(), inp = $('pinInput');
  $('lock').hidden = false; $('lockErr').textContent = ''; $('lockRec').hidden = !recording;
  inp.hidden = !pin; inp.value = ''; inp.inputMode = num ? 'numeric' : 'text'; inp.placeholder = num ? 'PIN' : 'Password';
  $('lockText').textContent = pin ? 'Enter your ' + (num ? 'PIN' : 'password') + ' to open your journal.' : 'Unlock with your fingerprint or screen lock.';
  if (pin) setTimeout(() => inp.focus(), 100); else if (!document.hidden) setTimeout(tryUnlock, 300);
  clearInterval(softTimer);
  if (soft) softTimer = setInterval(() => { if (!locked || !softLock) { clearInterval(softTimer); return; } $('lockRec').hidden = !recording; if (!workInFlight() && !unlocking && !$('pinInput').value) restartLocked(true); }, 1500);
}
let unlockCtl = null, unlockRun = null, unlockSeq = 0;
async function tryUnlock() {
  if (!locked) return;
  const pin = Vault.lockType() === 'pin', secret = $('pinInput').value;
  if (pin && (!secret || unlocking)) return;
  const my = ++unlockSeq;
  if (unlockCtl) { unlockCtl.abort(); unlockCtl = null; }
  if (unlockRun) { try { await unlockRun; } catch (e) {} }
  if (my !== unlockSeq || !locked) return;
  const ctl = unlockCtl = pin ? null : new AbortController();
  unlocking = true; $('lockErr').textContent = pin ? 'Checking…' : '';
  const run = unlockRun = Vault.unlock(secret, ctl ? ctl.signal : undefined);
  try {
    await run;
    locked = false; softLock = false; unlockCtl = null; clearInterval(softTimer);
    for (const id of COVERED) $(id).inert = false;
    $('lock').hidden = true; $('pinInput').value = ''; $('lockErr').textContent = '';
    while (unlockWaiters.length) unlockWaiters.shift()();
    if (heldToast) { const m = heldToast; heldToast = ''; toast(m); }
    drainNav();
    syncNow(); scheduleTranscribe(); resealAll();
  } catch (e) {
    if (my === unlockSeq) $('lockErr').textContent = e && (e.name === 'NotAllowedError' || e.name === 'AbortError') ? 'Not unlocked. Tap Unlock to try again.' : (e && e.message) || 'Not unlocked.';
  } finally { if (unlockRun === run) unlockRun = null; if (my === unlockSeq) unlocking = false; }
}
const whenUnlocked = () => locked ? new Promise(r => unlockWaiters.push(r)) : Promise.resolve();
$('unlockBtn').addEventListener('click', tryUnlock);
$('pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
$('lockReset').addEventListener('click', () => popup('Reset Journal on this device?',
  'Everything stored here is erased: entries, audio, lock and sign-in. Entries that were copied to the cloud come back after you sign in and enter your encryption password again. Entries that were never copied are lost.',
  [{ label: 'Erase and reset', cls: 'danger', fn: () => wipeEverything().then(() => location.reload(), e => popup('Reset', errText(e), [{ label: 'OK', cls: 'primary' }], { lockOk: true })) }, { label: 'Cancel', cls: 'quiet' }], { lockOk: true }));
async function wipeEverything() { try { sessionStorage.setItem(WIPE_KEY, '1'); } catch (e) { throw new Error('This browser blocks session storage. Clear the site data in the browser settings instead.'); } }
async function wipeNow() {
  try { await Vault.wipeBox(); } catch (e) {}
  await idb.wipe();
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('journal.')) localStorage.removeItem(k); sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
}
function relock() {
  if (!Vault.lockType() || locked || passive) return;
  showLock(true);
  if (!workInFlight()) restartLocked(true);
}
let restarting = false, linkHash = '';
async function restartLocked(soft) {
  if (restarting) return; restarting = true;
  try {
    const typing = () => soft && (!locked || unlocking || $('pinInput').value);
    if (typing()) { restarting = false; return; }
    if (recording) { restarting = false; return; }                   // a recording is never cut off; the restart follows once it stopped
    abortTranscribe(); abortSync();
    if (current() === 'entry') { commitTitle(); commitText(); }
    while (persistQueued > 0 || segWrites > 0) await sleep(100);
    if (persistFailed) {
      if (!locked && Vault.lockType()) showLock(true);
      $('lockErr').textContent = 'Your last changes could not be saved. Trying again…';
      restarting = false; setTimeout(() => restartLocked(soft), 5000); return;
    }
    if (typing()) { restarting = false; return; }
    await swSwitch();
    if (typing()) { restarting = false; return; }
    try { sessionStorage.setItem(RESUME_KEY, curEntry ? curEntry.id : ''); } catch (e) {}
    reloadPage();
  } catch (e) { restarting = false; }
}
function reloadPage() {
  let h = linkHash; if (!h) { try { h = sessionStorage.getItem(LINKHASH_KEY) || ''; } catch (e) {} }
  try { sessionStorage.removeItem(LINKHASH_KEY); } catch (e) {}
  if (h) { try { history.replaceState(history.state, '', location.pathname + h); } catch (e) {} }
  location.reload();
}
// A sign-in link opened in the running app: taken off the address at once and handled by a fresh
// start as soon as nothing is in flight, through the same careful path as a lock.
function linkOpened() {
  linkHash = location.search + location.hash; try { history.replaceState(histState(), '', location.pathname); } catch (e) {}
  try { sessionStorage.setItem(LINKHASH_KEY, linkHash); } catch (e) {}
  if (passive) return;
  if (locked && !entriesLoaded) { reloadPage(); return; }
  const go = () => { if (restarting) return; if (workInFlight()) { setTimeout(go, 1000); return; } restartLocked(false); };
  go();
}
document.addEventListener('visibilitychange', () => {
  clearTimeout(hideTimer);
  if (document.hidden) {
    hiddenAt = Date.now();
    if (Vault.lockType() && !locked) hideTimer = setTimeout(() => { if (document.hidden) relock(); }, (settings.lockAfter || 60) * 1000 + 500);
    return;
  }
  const away = hiddenAt ? Date.now() - hiddenAt : 0; hiddenAt = 0;
  if (passive || restarting) return;
  if (Vault.lockType() && !locked && away > (settings.lockAfter || 60) * 1000) relock();
  if (locked) { if (Vault.lockType() !== 'pin' && !unlocking) tryUnlock(); return; }
  if (!Vault.isOpen()) return;
  syncNow(); scheduleTranscribe(); checkForUpdate();
});

// ---------- menu sheet ----------
function openSheet() { if (stack.includes('sheet') || locked || passive) return; pinStep = false; push('sheet'); renderSheet(); }
function sheetClosed() { $('panel').innerHTML = ''; pinStep = false; }
$('sheet').addEventListener('click', e => { if (e.target === $('sheet')) back(); });
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstallBox(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstallBox(); });
function renderInstallBox() {
  const box = $('installBox'); if (!box) return;
  const unsafe = storageAtRisk && live().some(e => e.segs.length && !(session && e.pushed_at >= e.updated_at));
  box.innerHTML = (installEvt ? '<button class="btn primary" id="installBtn">Install on this phone</button>' : '') +
    (unsafe ? '<div class="hint warn">This browser may clear stored data it has not seen for a while. Install the app, keep a backup, or turn on the cloud copy so nothing is lost.</div>' : '');
  if (installEvt) $('installBtn').addEventListener('click', async () => { const ev = installEvt; installEvt = null; renderInstallBox(); ev.prompt(); try { await ev.userChoice; } catch (e) {} });
}
function renderSheet() {
  if (!stack.includes('sheet')) return;
  $('panel').innerHTML = '<div class="grab"></div><h2>Transcription</h2><div id="txBox"></div><h2>Cloud</h2><div id="syncBox"></div><h2>App lock</h2><div id="lockBox"></div>' +
    '<h2>Recording</h2>' +
    '<div class="rowopt"><span>Store a part every</span><select id="setSeg">' + SEG_MIN.map(m => '<option value="' + m + '">' + m + ' minutes</option>').join('') + '</select></div>' +
    '<div class="hint">Shorter parts mean less is lost if the phone dies, and the transcript arrives sooner; a change applies to the next recording.</div>' +
    '<h2>Backup</h2><div id="backupBox"></div>' +
    '<h2>App</h2><div id="installBox"></div>' +
    '<div class="hint">' + (settings.engine === 'phone' ? 'Tap the microphone to dictate, hold it to record audio.' : 'Tap the microphone to record (audio kept, text after the stop), hold it to dictate.') + ' Everything is encrypted on this device and encrypted again before it is uploaded. Audio leaves the device only for transcription, and only when you ask for it. No cookies, no trackers, no third-party scripts.</div>' +
    '<div class="version">Journal · ' + VERSION + '</div>';
  renderTxBox(); renderSyncBox(); renderLockBox(); renderBackupBox(); renderInstallBox();
  $('setSeg').value = String(settings.segMin); $('setSeg').addEventListener('change', e => { settings.segMin = +e.target.value; saveSettings(); });
}
function renderTxBox() {
  const box = $('txBox'); if (!box) return;
  const eng = settings.engine;
  let engBox = '';
  if (eng === 'phone') engBox = '<div class="hint">The phone\'s own speech recognition (Google on Android, Apple on iPhone). Free, no key, no account; that audio goes to Google or Apple. Its limits: it stops at every pause (the app starts it again), it cannot listen while the phone records audio, and it cannot read a stored recording. For long memos with pauses, audio kept and text after the stop, choose a key below.</div>';
  else if (eng === 'key') engBox = stt ? '<div class="statecard"><div class="t">✓ ' + esc(STT[stt.provider].name) + '</div><div class="s">The key is stored encrypted on this device. Memos and dictated notes go straight from this phone to the service and the text comes back. The service may keep audio for a while under its own terms.</div></div><button class="btn quiet" id="sttOff">Remove the key</button>'
    : '<p>Mistral (Paris) transcribes German and English for a few cents per hour: sign up at console.mistral.ai, choose the pay-as-you-go plan, API Keys, Create. (Mistral\'s free Experiment plan lets them train on your audio, so take the paid one for a journal.) The key is stored encrypted on this device and used only from here.</p>' +
      '<select id="sttProv">' + Object.keys(STT).map(k => '<option value="' + k + '">' + esc(STT[k].name) + '</option>').join('') + '</select>' +
      '<input id="sttKey" type="password" autocomplete="off" placeholder="API key"><button class="btn primary" id="sttSave">Use this key</button>';
  else engBox = SYNC ? '<div class="hint">' + (session ? 'Signed in: memos and dictated notes go to the transcription function in your own cloud project; no key is kept on the phone.' : 'Sign in under Cloud below. The transcription function in your own cloud project holds the key; nothing is kept on the phone.') + '</div>' : '<div class="hint">The cloud is not switched on in this version.</div>';
  box.innerHTML = '<div class="rowopt"><span>Engine</span><select id="setEngine"><option value="phone">Phone\'s speech recognition</option><option value="key">Own key (Mistral, …)</option><option value="cloud">Own cloud function</option></select></div>' + engBox +
    '<div class="rowopt"><span>Memos</span><select id="setTx">' + (eng === 'phone' ? '<option value="ask">Transcribe live while recording</option>' : '<option value="ask">Ask after each memo</option><option value="auto">Automatically</option>') + '<option value="off">Never (audio only)</option></select></div>' +
    '<div class="rowopt"><span>Spoken language</span><select id="setLang"><option value="auto">German and English (detect)</option><option value="de">German</option><option value="en">English</option></select></div>' +
    (eng === 'phone' ? '<div class="hint">The phone\'s recognition listens in one language at a time; "detect" uses the phone\'s language.</div>' : '') +
    '<div class="hint" id="sttHint"></div>';
  $('setEngine').value = eng; $('setEngine').addEventListener('change', e => { settings.engine = e.target.value; if (settings.engine === 'phone' && settings.transcribe === 'auto') settings.transcribe = 'ask'; saveSettings(); abortTranscribe(); renderTxBox(); renderSyncLine(); scheduleTranscribe(); });
  $('setTx').value = eng === 'phone' && settings.transcribe === 'auto' ? 'ask' : settings.transcribe;
  $('setTx').addEventListener('change', e => { settings.transcribe = e.target.value; saveSettings(); if (settings.transcribe === 'auto') { for (const en of live()) if (en.state === 'done' && en.segs.some(g => g.st === 'todo')) en.tx = true; scheduleTranscribe(); } });
  $('setLang').value = settings.lang; $('setLang').addEventListener('change', e => { settings.lang = e.target.value; saveSettings(); });
  if ($('sttSave')) $('sttSave').addEventListener('click', async () => {
    const key = $('sttKey').value.trim(), provider = $('sttProv').value, hint = $('sttHint');
    if (key.length < 16) { hint.textContent = 'That does not look like an API key.'; return; }
    try { await saveStt({ provider, key }); toast('Transcription is set up'); renderTxBox(); renderSyncLine(); scheduleTranscribe(); } catch (e) { hint.textContent = 'Not saved: ' + errText(e); }
  });
  if ($('sttOff')) $('sttOff').addEventListener('click', () => popup('Remove the key?', 'Transcription with it stops until a key is entered again.', [
    { label: 'Remove', cls: 'danger', fn: async () => { abortTranscribe(); await saveStt(null); renderTxBox(); renderSyncLine(); } }, { label: 'Keep it', cls: 'quiet' }]));
}
const LOCK_TEXT = {
  prf: ['🔒 Locked with fingerprint / screen lock', 'The key to your journal is released only by this phone\'s screen lock.'],
  gate: ['🔒 Locked with fingerprint / screen lock (screen only)', 'This browser cannot tie the key itself to the screen lock, so the lock guards the app screen but not a copy of the stored data. A long password ties the key as well.'],
  pin: ['🔒 Locked with a PIN or password', 'The key to your journal is derived from it.']
};
function pinProblem(a) {
  const s = String(a).normalize('NFKC'), n = [...s].length, letters = (s.match(/\p{L}/gu) || []).length, digits = (s.match(/\p{Nd}/gu) || []).length;
  if (letters < 4) return digits < 12 ? 'A PIN needs 12 digits or more. Shorter ones can be guessed by a computer. A password of 8 or more characters with at least 4 letters works too.' : '';
  return n < 8 ? 'Use at least 8 characters with at least 4 letters, or a PIN of 12 digits or more.' : '';
}
function renderLockBox() {
  const box = $('lockBox'); if (!box) return;
  const type = Vault.lockType();
  if (type) {
    box.innerHTML = '<div class="statecard"><div class="t">' + LOCK_TEXT[type][0] + '</div><div class="s">' + LOCK_TEXT[type][1] + (Vault.hasOldKeys() ? '<br>Older entries are being moved under the new key in the background.' : '') + '</div></div>' +
      '<div class="rowopt"><span>Lock again after</span><select id="lockAfter"><option value="5">5 seconds away</option><option value="60">1 minute away</option><option value="300">5 minutes away</option><option value="1800">30 minutes away</option></select></div>' +
      '<button class="btn" id="lockNow">Lock now</button><button class="btn quiet" id="lockOff">Turn the lock off</button>';
    $('lockAfter').value = String(settings.lockAfter || 60);
    $('lockAfter').addEventListener('change', e => { settings.lockAfter = +e.target.value; saveSettings(); });
    $('lockNow').addEventListener('click', () => relock());
    $('lockOff').addEventListener('click', () => popup('Turn the lock off?', 'Anyone who can open this phone can then open your journal.', [
      { label: 'Turn off', cls: 'danger', fn: async () => { try { await Vault.clearLock(); toast('Lock is off'); } catch (e) { toast('Could not turn it off: ' + errText(e)); } renderLockBox(); } },
      { label: 'Keep it on', cls: 'quiet' }]));
    return;
  }
  if (pinStep) {
    box.innerHTML = '<p>Choose a password (8 characters or more, with at least 4 letters) or a long PIN (12 digits or more). It is asked every time the app opens. It cannot be recovered: if you forget it, the app on this device has to be reset.</p>' +
      '<div class="pinform"><input id="pin1" type="password" autocomplete="new-password" placeholder="Password or long PIN"><input id="pin2" type="password" autocomplete="new-password" placeholder="Repeat"></div>' +
      '<button class="btn primary" id="pinSave">Turn the lock on</button><button class="btn quiet" id="pinBack">Back</button><div class="hint" id="lockHint"></div>';
    $('pinBack').addEventListener('click', () => { pinStep = false; renderLockBox(); });
    let saving = false;
    $('pinSave').addEventListener('click', async () => {
      const a = $('pin1').value, b = $('pin2').value, hint = $('lockHint');
      if (saving) return;
      const prob = pinProblem(a); if (prob) { hint.textContent = prob; return; }
      if (a !== b) { hint.textContent = 'The two entries differ.'; return; }
      saving = true; hint.textContent = 'Setting up…';
      try { await Vault.setPin(a); pinStep = false; toast('Lock is on'); renderLockBox(); resealAll(); } catch (e) { hint.textContent = 'Not set up: ' + errText(e); if (Vault.lockType()) { pinStep = false; renderLockBox(); resealAll(); } } finally { saving = false; }
    });
    return;
  }
  box.innerHTML = '<p>Your journal is stored encrypted on this phone. With a lock, the key is released only by your fingerprint or screen lock. Turn it on before you record anything private.</p>' +
    '<button class="btn primary" id="lockOnBio">Use fingerprint / screen lock</button><button class="btn" id="lockOnPin">Use a password or long PIN instead</button><div class="hint" id="lockHint"></div>';
  $('lockOnPin').addEventListener('click', () => { pinStep = true; renderLockBox(); });
  let setting = false;
  $('lockOnBio').addEventListener('click', async () => {
    const hint = $('lockHint'); if (setting) return;
    setting = true;
    try {
      if (!(await Vault.biometricAvailable())) { hint.textContent = 'This device or browser offers no fingerprint or screen lock here. Use a password or long PIN instead.'; return; }
      hint.textContent = 'Confirm with your fingerprint or screen lock. Your phone may ask twice.';
      const t = await Vault.setBiometric();
      toast(t === 'gate' ? 'Lock is on. On this browser it guards the screen only.' : 'Lock is on'); renderLockBox(); resealAll();
    } catch (e) { hint.textContent = e && e.name === 'NotAllowedError' ? 'Not set up: it was cancelled. Tap again to retry.' : 'Not set up: ' + errText(e); if (Vault.lockType()) { renderLockBox(); resealAll(); } }
    finally { setting = false; }
  });
}

// ---------- re-encryption after a key change ----------
// Every stored record is read and, if it still sits under an older key, written again under the
// current one; the old keys go once a pass under the current key found nothing left.
let resealing = false, resealAgain = false;
async function resealAll() {
  if (!Vault.hasOldKeys() || resealing || locked || passive) { if (resealing) resealAgain = true; return; }
  resealing = true;
  try {
    for (;;) {
      resealAgain = false; const gen = Vault.keyGen(), seqAt = recSeq; let left = false;
      const pass = async (store, label) => {
        for (const id of await idb.keys(store)) {
          if (locked || passive || Vault.keyGen() !== gen) { left = true; return; }
          const r = await idb.get(store, id); if (!r) continue;
          const upd = {};
          for (const f of ['m', 'data']) { if (!r[f]) continue; const nb = await Vault.reseal(r[f], label(r, f)).catch(err => { if (err && err.name === 'NoKey') return null; throw err; }); if (nb) upd[f] = nb; }
          if (Object.keys(upd).length) await idb.put(store, Object.assign(r, upd));
        }
      };
      await pass('entries', r => eLabel(r.id));
      await pass('segs', (r, f) => f === 'm' ? sLabel(r.id) + '|m' : sLabel(r.id));
      await pass('parts', (r, f) => { const seg = r.id.slice(0, r.id.indexOf('|')), n = +r.id.slice(r.id.indexOf('|') + 1); return f === 'm' ? pLabel(seg, n) + '|m' : pLabel(seg, n); });
      const sess = await idb.get('meta', 'session'); if (sess) { const nb = await Vault.reseal(sess.data, 'jn|session').catch(() => null); if (nb) await idb.put('meta', { id: 'session', data: nb }); }
      const cur = await idb.get('meta', 'cursor'); if (cur) { const nb = await Vault.reseal(cur.data, 'jn|cursor').catch(() => null); if (nb) await idb.put('meta', { id: 'cursor', data: nb }); }
      const sk = await idb.get('meta', 'stt'); if (sk) { const nb = await Vault.reseal(sk.data, 'jn|stt').catch(() => null); if (nb) await idb.put('meta', { id: 'stt', data: nb }); }
      if (session && !(await Vault.resealCloudKey(session.uid))) left = true;
      if (left || recWrites > 0 || recSeq !== seqAt || Vault.keyGen() !== gen) { if (resealAgain || Vault.keyGen() !== gen) continue; break; }
      await Vault.dropOldKeys(gen);
      if (!resealAgain) break;
    }
  } catch (e) {} finally { resealing = false; if ($('lockBox')) renderLockBox(); }
}
