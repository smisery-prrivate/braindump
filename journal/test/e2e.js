const { chromium } = require('playwright');
// End-to-end test: node test/e2e.js  (needs the mock server: node test/mock-server.js <app folder> 8765)
const PORT = 8765, BASE = 'http://localhost:' + PORT + '/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
const fetchJson = async (u, opt) => (await fetch(u, opt)).json();

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true });
  await ctx.grantPermissions(['microphone']);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/502/.test(m.text())) errors.push('console: ' + m.text()); });      // the 502 is the mocked provider failure of step 5
  await fetchJson('http://localhost:' + PORT + '/__reset');

  // 1. boot
  await page.goto(BASE); await page.waitForFunction(() => window.journalDebug && document.getElementById('list').textContent.length > 0);
  check(await page.textContent('#list') .then(t => t.includes('empty')), 'empty state shown');
  check(await page.isVisible('#recBtn'), 'record button visible');

  // 2. record a short memo with segments every ~3 s (engine "own key" for the stored-audio paths below)
  await page.evaluate(() => { journalDebug.settings.segMin = 0.05; journalDebug.settings.engine = 'key'; journalDebug.settings.transcribe = 'ask'; });
  await page.evaluate(() => journalDebug.startRecording());
  await page.waitForSelector('#recBar:not([hidden])');
  await sleep(8000);
  const t = await page.textContent('#recTime');
  check(/0:0[5-9]/.test(t), 'timer runs: ' + t);
  await page.click('#recPause'); await sleep(1500); check((await page.textContent('#recState')) === 'Paused', 'paused');
  await page.click('#recPause'); await sleep(1500);
  await page.click('#recStop');
  await page.waitForSelector('#entry:not([hidden])', { timeout: 15000 });
  await sleep(500);
  let e = await page.evaluate(() => { const e = journalDebug.entries[0]; return { segs: e.segs.length, dur: e.dur, state: e.state, mime: e.mime, sizes: e.segs.map(g => g.size), st: e.segs.map(g => g.st) }; });
  console.log('entry', JSON.stringify(e));
  check(e.state === 'done' && e.segs >= 2, 'memo stored in ' + e.segs + ' segments');
  check(e.dur > 7000 && e.dur < 12000, 'duration excludes pause: ' + e.dur);
  const askShown = await page.isVisible('#popup.open');
  check(askShown, '"Transcribe?" asked after the memo');
  if (askShown) await page.click('#popupBox button.quiet');
  // sealed at rest
  const sealed = await page.evaluate(async () => { const e = journalDebug.entries[0]; const r = await journalDebug.idb.get('segs', e.segs[0].id); const u = new Uint8Array(r.data); const webm = u[12] === 0x1a && u[13] === 0x45; const recs = await journalDebug.idb.all('entries'); const plain = recs.some(x => JSON.stringify(Object.keys(x)).includes('title')); return { len: u.length, webm, plain, parts: (await journalDebug.idb.keys('parts')).length }; });
  check(sealed.len > 100 && !sealed.webm && !sealed.plain, 'segment and entry are ciphertext in IndexedDB; parts cleaned: ' + JSON.stringify(sealed));
  // player
  await page.click('#playBtn'); await sleep(2500);
  const pstate = await page.evaluate(() => ({ cur: document.getElementById('tCur').textContent, btn: document.getElementById('playBtn').textContent, err: document.getElementById('pState').textContent }));
  check(pstate.cur !== '0:00' && !pstate.err, 'playback runs: ' + JSON.stringify(pstate));
  await page.click('#playBtn');
  // title + note
  await page.fill('#entryTitle', 'Erster Test'); await page.press('#entryTitle', 'Enter');
  await page.fill('#noteText', 'Eine Notiz dazu.'); await sleep(1200);
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])');
  check((await page.textContent('#list')).includes('Erster Test') && (await page.textContent('#list')).includes('Eine Notiz'), 'home shows title and note');

  // 2b. direct mode: own key, no cloud project
  await page.click('#menuBtn'); await page.waitForSelector('#setEngine'); await page.selectOption('#setEngine', 'key'); await page.waitForSelector('#sttKey');
  await page.selectOption('#sttProv', 'mistral'); await page.fill('#sttKey', 'short'); await page.click('#sttSave'); await sleep(300);
  check((await page.textContent('#sttHint')).includes('does not look'), 'a too short key is refused');
  await page.fill('#sttKey', 'mi_test_key_1234567890'); await page.click('#sttSave'); await sleep(500);
  check(await page.evaluate(async () => { const r = await journalDebug.idb.get('meta', 'stt'); return !!r && !new TextDecoder().decode(r.data).includes('mi_test'); }), 'key stored encrypted');
  await page.evaluate(() => back()); await sleep(500);
  await page.click('.card'); await page.waitForSelector('#entry:not([hidden])');
  await page.click('#txBtns button');
  await page.waitForFunction(() => journalDebug.entries[0].segs.every(g => g.st === 'done'), null, { timeout: 20000 });
  const direct = await page.evaluate(() => journalDebug.entries[0].segs.map(g => g.text));
  console.log('direct', JSON.stringify(direct));
  check(direct.every(t => /Mistral transcript .*voxtral-mini-transcribe-3/.test(t)), 'transcribed straight from the phone with the own key');
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])');
  await page.evaluate(async () => { const e = journalDebug.entries[0]; for (const g of e.segs) { g.st = 'todo'; g.text = ''; g.merged = false; } e.text = ''; await journalDebug.persist(e); await journalDebug.saveStt(null); journalDebug.settings.engine = 'cloud'; saveSettings(); });

  // 2c. long press on a card picks it (pick mode); a plain tap still opens the entry
  const box = await (await page.$('.card')).boundingBox();
  await page.mouse.move(box.x + 40, box.y + 20); await page.mouse.down(); await sleep(700); await page.mouse.up(); await sleep(300);
  check(await page.isVisible('#selDock') && (await page.$$('.card.sel')).length === 1 && await page.isVisible('#home:not([hidden])') && !(await page.isVisible('#popup.open')), 'long press picks the entry without a menu');
  await page.click('#selCancel'); await sleep(300);
  await page.evaluate(() => { journalDebug.settings.engine = 'phone'; });
  await page.click('.card'); await page.waitForSelector('#entry:not([hidden])');
  check(await page.isVisible('#dictBtn') && await page.isVisible('#claudeBtn'), 'Dictate and Claude buttons in the entry');
  await page.click('#dictBtn'); await sleep(300);
  check(await page.evaluate(() => !!(self.SpeechRecognition || self.webkitSpeechRecognition) || document.getElementById('popupBox').textContent.includes('No dictation')), 'dictation starts, or says the browser has none');
  if (await page.isVisible('#popup.open')) await page.click('#popupBox button');
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])');

  // 2c2. with the phone engine a tap on the microphone opens the text window for dictation; left empty, it is not kept
  const before = await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length);
  await page.evaluate(() => { journalDebug.settings.engine = 'phone'; });
  await page.click('#recBtn'); await page.waitForSelector('#entry:not([hidden])'); await sleep(400);
  check(await page.evaluate(() => document.getElementById('noteText').value === '' && document.getElementById('recBar').hidden && !journalDebug.recording), 'microphone tap opens the text window, no recording screen');
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length) === before, 'an entry left empty is dropped');
  // with a key the tap records in the background of the text window
  await page.evaluate(() => { journalDebug.settings.engine = 'key'; });
  await page.click('#recBtn'); await page.waitForSelector('#recBar:not([hidden])'); await sleep(1500);
  check(await page.evaluate(() => journalDebug.recording && !document.getElementById('entry').hidden), 'with a key the tap records inside the entry');
  await page.click('#recDiscard'); await page.waitForSelector('#popup.open'); await page.click('#popupBox button.danger'); await page.waitForSelector('#home:not([hidden])', { timeout: 15000 }); await sleep(500);
  check(await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length) === before && !(await page.evaluate(() => journalDebug.recording)), 'discard drops the recording');

  // 2d. the phone engine: a memo recorded with it gets no "Transcribe?" question and says what it needs
  await page.evaluate(() => { journalDebug.settings.engine = 'phone'; journalDebug.settings.segMin = 0.05; });
  await page.evaluate(() => journalDebug.startRecording()); await page.waitForSelector('#recBar:not([hidden])'); await sleep(4000);
  const liveShown = await page.evaluate(() => !!(self.SpeechRecognition || self.webkitSpeechRecognition) ? !document.getElementById('recLive').hidden : document.getElementById('recLive').hidden);
  check(liveShown, 'live line shown only when the browser has speech recognition');
  await page.click('#recStop'); await page.waitForSelector('#entry:not([hidden])', { timeout: 15000 }); await sleep(400);
  check(!(await page.isVisible('#popup.open')), 'no "Transcribe?" question with the phone engine');
  await page.click('#txBtns button'); await sleep(300);
  check((await page.textContent('#popupBox')).includes('no text yet'), 'stored audio explains it needs a key or the cloud');
  await page.click('#popupBox button.quiet'); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])');
  await page.evaluate(async () => { const e = journalDebug.entries[0]; e.deleted = true; e.del_at = Date.now(); await journalDebug.persist(e); journalDebug.settings.engine = 'cloud'; saveSettings(); }); await sleep(300);

  // 2e. folders and photos
  await page.evaluate(async () => { folders.push('Reisen'); await saveFolders(); renderHome(); });
  await page.click('#folderRow button[data-f="Reisen"]'); await sleep(200);
  check((await page.textContent('#list')).includes('Nothing in this folder'), 'folder chip filters the list');
  await page.click('#noteBtn'); await page.waitForSelector('#entry:not([hidden])');
  check((await page.textContent('#entryFolder')).includes('Reisen'), 'a new entry lands in the open folder');
  // a photo: a generated PNG through the file input, shrunk, sealed, with a thumbnail
  const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1800; const x = c.getContext('2d'); x.fillStyle = '#c33'; x.fillRect(0, 0, 2400, 1800); x.fillStyle = '#fff'; x.fillRect(600, 400, 1200, 1000); return c.toDataURL('image/png').split(',')[1]; });
  await page.setInputFiles('#picInput', { name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => journalDebug.entries[0].pics && journalDebug.entries[0].pics.length === 1, null, { timeout: 15000 }); await sleep(300);
  const pic = await page.evaluate(async () => { const p = journalDebug.entries[0].pics[0]; const r = await journalDebug.idb.get('segs', p.id); const u = new Uint8Array(r.data); return { w: p.w, h: p.h, th: p.th.slice(0, 22), sealedLen: u.length, jpegHeader: u[12] === 0xff && u[13] === 0xd8, grid: document.querySelectorAll('#picGrid img').length }; });
  console.log('photo', JSON.stringify(pic));
  check(pic.w === 1600 && pic.h === 1200 && pic.th === 'data:image/jpeg;base64' && pic.sealedLen > 1000 && !pic.jpegHeader && pic.grid === 1, 'photo shrunk to 1600 px, thumbnail made, stored as ciphertext');
  await page.click('#picGrid img'); await page.waitForSelector('#lightbox:not([hidden])'); await sleep(300);
  check(await page.evaluate(() => document.getElementById('lightImg').naturalWidth === 1600), 'lightbox shows the decrypted photo');
  await page.click('#lightClose'); await page.fill('#noteText', 'Foto-Eintrag'); await sleep(1000);
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check((await page.$$('.card img.th')).length === 1 && (await page.textContent('#list')).includes('1 photo'), 'the list shows the thumbnail');
  await page.click('#folderRow button[data-f=""]'); await sleep(200);
  check((await page.textContent('#list')).includes('📁 Reisen'), 'All shows the folder on the card');
  await page.evaluate(async () => { const e = journalDebug.entries[0]; e.deleted = true; e.del_at = Date.now(); await journalDebug.persist(e); }); await sleep(300);

  // 2e2. keyboard engine: the microphone opens the text window with the text field focused
  await page.evaluate(() => { journalDebug.settings.engine = 'keyboard'; saveSettings(); });
  await page.click('#recBtn'); await page.waitForSelector('#noteText'); await sleep(300);
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'noteText' && document.activeElement.placeholder.includes('keyboard')), 'keyboard engine: text window open, field focused, hint shown');
  await page.fill('#noteText', 'Per Tastatur diktiert'); await sleep(1000); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(() => journalDebug.entries.some(x => !x.deleted && x.text === 'Per Tastatur diktiert')), 'keyboard engine: entry kept with its text');
  await page.evaluate(async () => { const e = journalDebug.entries.find(x => x.text === 'Per Tastatur diktiert'); e.deleted = true; e.del_at = Date.now(); await journalDebug.persist(e); journalDebug.settings.engine = 'cloud'; saveSettings(); }); await sleep(300);

  // 2e3. Save button: stores, says so, back to the list
  await page.click('#noteBtn'); await page.waitForSelector('#noteText'); await page.fill('#noteText', 'Gespeichert per Knopf');
  await page.click('#entrySave'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(async () => { const e = journalDebug.entries.find(x => !x.deleted && x.text === 'Gespeichert per Knopf'); if (!e) return false; const r = await journalDebug.idb.get('entries', e.id); return !!r; }) && (await page.textContent('#toast')).includes('Saved'), 'Save stores the text at once and returns to the list');
  // Back right after typing (no pause) keeps the text too
  await page.click('#noteBtn'); await page.waitForSelector('#noteText'); await page.type('#noteText', 'Schnell zurueck'); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(() => journalDebug.entries.some(x => !x.deleted && x.text === 'Schnell zurueck')), 'Back right after typing keeps the text');
  await page.evaluate(async () => { for (const e of journalDebug.entries.filter(x => !x.deleted && (x.text === 'Gespeichert per Knopf' || x.text === 'Schnell zurueck'))) { e.deleted = true; e.del_at = Date.now(); await journalDebug.persist(e); } renderHome(); }); await sleep(300);

  // 2f. pick mode: two entries deleted at once, undo brings both back, then deleted for good
  await page.click('#noteBtn'); await page.waitForSelector('#noteText'); await page.fill('#noteText', 'Eins'); await sleep(1000); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])');
  await page.click('#noteBtn'); await page.waitForSelector('#noteText'); await page.fill('#noteText', 'Zwei'); await sleep(1000); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  const liveBefore = await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length);
  await page.click('#selectBtn'); await sleep(200);
  check(await page.isVisible('#selDock') && (await page.$$('.card .tick')).length >= 2, 'pick mode shows ticks and the bar');
  const cards = await page.$$('.card'); await cards[0].click(); await cards[1].click(); await sleep(200);
  check((await page.textContent('#selDelete')).includes('(2)'), 'two picked');
  await page.click('#selDelete'); await page.waitForSelector('#popup.open'); await page.click('#popupBox button.danger'); await sleep(500);
  check((await page.$$('.card')).length === liveBefore - 2 && await page.isVisible('#toast'), 'both gone from the list with an undo toast');
  await page.click('#toast button'); await sleep(300);
  check((await page.$$('.card')).length === liveBefore, 'undo brought both back');
  await page.click('#selectBtn'); await sleep(200); const cards2 = await page.$$('.card'); await cards2[0].click(); await cards2[1].click();
  await page.click('#selDelete'); await page.waitForSelector('#popup.open'); await page.click('#popupBox button.danger'); await sleep(7000);
  check(await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length) === liveBefore - 2 && !(await page.isVisible('#selDock')), 'deleted for good after the undo window, pick mode closed');

  // 3. sign in via PKCE link, then transcribe
  await page.evaluate(() => { localStorage.setItem('journal.linkAsked', String(Date.now())); localStorage.setItem('journal.pkce', 'verifier'); });
  await page.goto(BASE + '?code=goodcode'); await page.waitForFunction(() => window.journalDebug && journalDebug.session);
  check(await page.evaluate(() => journalDebug.session.email) === 'pat@example.com', 'signed in through the link');
  check((await page.evaluate(() => location.search)) === '', 'code removed from the address');
  await sleep(1500);
  check(await page.evaluate(() => journalDebug.keyNeed) === 'create', 'cloud asks for an encryption password');
  check(await page.isVisible('#sheet.open'), 'menu opened for the password');
  // transcribe the memo (segments transcribed one after the other, with the previous tail as prompt)
  await page.evaluate(() => back()); await sleep(500);
  await page.click('.card'); await page.waitForSelector('#entry:not([hidden])');
  if (await page.$('#txBtns button')) await page.click('#txBtns button');      // the queue may have started by itself right after the sign-in
  await page.waitForFunction(() => journalDebug.entries.find(x => !x.deleted).segs.every(g => g.st === 'done'), null, { timeout: 20000 }); await sleep(500);
  const tx = await page.evaluate(() => ({ text: document.getElementById('noteText').value, segs: journalDebug.entries.find(x => !x.deleted).segs.map(g => g.text) }));
  console.log('transcript', JSON.stringify(tx));
  check(tx.segs.length >= 2 && /prompt: Mock transcript \d+/.test(tx.segs[1]), 'second segment got the first one\'s tail as prompt');
  check(/Mock transcript \d+ \(.*\n\nMock transcript \d+/.test(tx.text), 'transcript stitched in the entry view');
  // edit the transcript
  await page.fill('#noteText', 'Edited by hand.'); await sleep(1200);
  check(await page.evaluate(() => journalDebug.entries.find(x => !x.deleted).text === 'Edited by hand.'), 'text edit stored');
  await page.click('#entryBack');

  // 4. set the encryption password, sync, then verify the cloud holds only ciphertext
  await page.click('#menuBtn'); await page.waitForSelector('#pw1');
  await page.fill('#pw1', 'correct horse battery'); await page.fill('#pw2', 'correct horse battery'); await page.click('#pwGo');
  await page.waitForFunction(() => journalDebug.syncState === '' && journalDebug.entries.every(e => e.pushed_at >= e.updated_at), null, { timeout: 20000 });
  const cloud = await fetchJson('http://localhost:' + PORT + '/__state');
  check(cloud.entries.filter(r => !r.deleted).length === 1 && cloud.objects.length === e.segs && !JSON.stringify(cloud.entries).includes('Erster'), 'cloud holds 1 sealed entry and ' + cloud.objects.length + ' sealed segments');
  await page.evaluate(() => back()); await sleep(500);

  // 5. a transcription failure backs off and is shown, then recovers
  await fetchJson('http://localhost:' + PORT + '/__fail?n=1');
  await page.evaluate(() => { journalDebug.settings.transcribe = 'auto'; });
  await page.evaluate(() => journalDebug.startRecording()); await sleep(4000); await page.click('#recStop'); await page.waitForSelector('#entry:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => journalDebug.entries[0].segs.some(g => g.st === 'fail' || g.st === 'done'), null, { timeout: 15000 });
  const st1 = await page.evaluate(() => ({ st: journalDebug.entries[0].segs.map(g => g.st), msg: document.getElementById('txState').textContent }));
  console.log('fail state', JSON.stringify(st1));
  check(st1.st[0] === 'fail' && /provider down/.test(st1.msg), 'failure shown with reason');
  await page.click('#txBtns button');
  await page.waitForFunction(() => journalDebug.entries[0].segs.every(g => g.st === 'done'), null, { timeout: 15000 });
  check(true, 'retry succeeded');
  await page.click('#entryBack');

  // 6. PIN lock: set, relock (restart), unlock
  await page.evaluate(() => journalDebug.Vault.setPin('langes passwort 123'));
  await page.evaluate(() => journalDebug.relock());
  await page.waitForFunction(() => window.journalDebug && journalDebug.locked && document.getElementById('lock').hidden === false, null, { timeout: 15000 });
  check(await page.evaluate(() => !journalDebug.Vault.isOpen()), 'after the restart the key is not in memory');
  await page.fill('#pinInput', 'wrong'); await page.click('#unlockBtn'); await sleep(2500);
  check((await page.textContent('#lockErr')).includes('Wrong'), 'wrong PIN refused');
  await page.fill('#pinInput', 'langes passwort 123'); await page.press('#pinInput', 'Enter');
  await page.waitForFunction(() => !journalDebug.locked, null, { timeout: 15000 }); await sleep(1000);
  check(await page.evaluate(() => journalDebug.entries.filter(e => !e.deleted).length) === 2, 'entries readable after unlock');
  check(await page.evaluate(() => !!journalDebug.session), 'session survived the key change');

  // 7. crash recovery: reload mid-recording
  await page.evaluate(() => { journalDebug.settings.segMin = 5; });
  await page.evaluate(() => journalDebug.startRecording()); await page.waitForSelector('#recBar:not([hidden])'); await sleep(12500);
  const partsBefore = await page.evaluate(async () => (await journalDebug.idb.keys('parts')).length);
  check(partsBefore >= 1, 'parts stored while recording: ' + partsBefore);
  await page.goto(BASE); await page.waitForFunction(() => window.journalDebug && journalDebug.locked);
  await page.fill('#pinInput', 'langes passwort 123'); await page.press('#pinInput', 'Enter');
  await page.waitForFunction(() => !journalDebug.locked, null, { timeout: 15000 }); await sleep(1500);
  const rec = await page.evaluate(async () => { const e = journalDebug.entries[0]; return { state: e.state, segs: e.segs.length, dur: e.dur, recovered: e.segs.map(g => !!g.recovered), parts: (await journalDebug.idb.keys('parts')).length, hasBlob: !!(await journalDebug.segGet(e.segs[0] && e.segs[0].id)) }; });
  console.log('recovered', JSON.stringify(rec));
  check(rec.state === 'done' && rec.segs === 1 && rec.recovered[0] && rec.hasBlob && rec.parts === 0 && rec.dur >= 9000, 'interrupted recording recovered from parts');

  // 8. backup round trip into a wiped second browser
  const bk = await page.evaluate(async () => { const { blob, missing } = await journalDebug.makeBackup('backup pass 1234'); const b = new Uint8Array(await blob.arrayBuffer()); return { bytes: Array.from(b), missing }; });
  check(bk.bytes.length > 1000 && !Buffer.from(bk.bytes).toString('latin1').includes('Erster'), 'backup file is ciphertext, ' + bk.bytes.length + ' bytes');
  const ctx2 = await browser.newContext({ viewport: { width: 400, height: 800 } }); await ctx2.grantPermissions(['microphone']);
  const p2 = await ctx2.newPage(); p2.on('pageerror', e => errors.push('p2 pageerror: ' + e.message));
  await p2.goto(BASE); await p2.waitForFunction(() => window.journalDebug && document.getElementById('list').textContent.includes('empty'));
  const r2 = await p2.evaluate(async bytes => { const f = new File([new Uint8Array(bytes)], 'x.journal'); let wrong = ''; try { await journalDebug.readBackup(f, 'nope'); } catch (e) { wrong = e.message; } const r = await journalDebug.readBackup(f, 'backup pass 1234'); return { wrong, r, n: journalDebug.entries.filter(e => !e.deleted).length, title: journalDebug.entries.find(e => e.title === 'Erster Test') && journalDebug.entries.find(e => e.title === 'Erster Test').text }; }, bk.bytes);
  console.log('restore', JSON.stringify(r2));
  check(/Wrong backup password/.test(r2.wrong) && r2.n === 3 && r2.r.audio >= 3 && r2.title === 'Edited by hand.', 'backup restored into a fresh browser');

  // 9. second device: sign in, enter the encryption password, pull the cloud copy, play a cloud-only segment
  const ctx3 = await browser.newContext({ viewport: { width: 400, height: 800 } }); await ctx3.grantPermissions(['microphone']);
  const p3 = await ctx3.newPage(); p3.on('pageerror', e => errors.push('p3 pageerror: ' + e.message));
  await p3.goto(BASE); await p3.waitForFunction(() => window.journalDebug);
  await p3.evaluate(() => { localStorage.setItem('journal.linkAsked', String(Date.now())); localStorage.setItem('journal.pkce', 'verifier'); });
  await p3.goto(BASE + '?code=goodcode'); await p3.waitForFunction(() => window.journalDebug && journalDebug.keyNeed === 'enter', null, { timeout: 15000 });
  await p3.waitForSelector('#pw1'); await p3.fill('#pw1', 'correct horse battery'); await p3.click('#pwGo');
  await p3.waitForFunction(() => journalDebug.entries.filter(e => !e.deleted && e.cloud).length >= 2, null, { timeout: 20000 });
  const pulled = await p3.evaluate(async () => { const e = journalDebug.entries.find(x => x.title === 'Erster Test'); return { title: e && e.title, transcript: e && e.text, local: e ? !!(await journalDebug.segGet(e.segs[0].id)) : null, up: e && Object.keys(e.up).length }; });
  console.log('pulled', JSON.stringify(pulled));
  check(pulled.title === 'Erster Test' && pulled.transcript === 'Edited by hand.' && pulled.local === false, 'second device pulled the sealed entry; audio not yet local');
  await p3.evaluate(() => back()); await sleep(500);
  await p3.click('.card:has-text("Erster Test")'); await p3.waitForSelector('#playBtn');
  await p3.click('#playBtn'); await p3.waitForFunction(() => document.getElementById('tCur').textContent !== '0:00', null, { timeout: 15000 });
  check(await p3.evaluate(async () => !!(await journalDebug.segGet(journalDebug.entries.find(x => x.title === 'Erster Test').segs[0].id))), 'cloud segment fetched, decrypted and stored on play');
  // delete on device 3, tombstone reaches device 1
  const erId = await p3.evaluate(() => journalDebug.entries.find(x => x.title === 'Erster Test').id);
  await p3.click('#entryMore'); await p3.click('#popupBox button.danger'); await sleep(7000);
  await p3.waitForFunction(() => journalDebug.entries.find(x => x.title === 'Erster Test').deleted && journalDebug.syncState === '', null, { timeout: 20000 });
  let cloud2; for (let i = 0; i < 40; i++) { cloud2 = await fetchJson('http://localhost:' + PORT + '/__state'); if (cloud2.entries.find(r => r.id === erId && r.deleted) && cloud2.objects.length < cloud.objects.length + 3) break; await sleep(500); }
  check(cloud2.entries.find(r => r.id === erId && r.deleted) && cloud2.objects.length < cloud.objects.length + 10, 'delete marker in the cloud, objects removed: ' + cloud2.objects.length);
  await page.evaluate(() => journalDebug.syncNow());
  await page.waitForFunction(() => journalDebug.entries.find(x => x.title === 'Erster Test').deleted, null, { timeout: 20000 });
  check(!(await page.textContent('#list')).includes('Erster Test'), 'deletion propagated to the first device');

  // 9. dictation stopped by Back keeps the last phrase that was still provisional (a fake recognition
  // that, like Android, leaves the last phrase interim and sends its final only after stop())
  const ctx4 = await browser.newContext({ viewport: { width: 400, height: 800 } }); await ctx4.grantPermissions(['microphone']);
  await ctx4.addInitScript(() => {
    class FakeSR { start() { const me = this; setTimeout(() => me.onresult && me.onresult({ results: [Object.assign([{ transcript: 'erster Satz' }], { isFinal: true }), Object.assign([{ transcript: 'letzter Satz vorlaeufig' }], { isFinal: false })] }), 100); } stop() { const me = this; setTimeout(() => me.onend && me.onend(), 50); } abort() {} }
    window.SpeechRecognition = window.webkitSpeechRecognition = FakeSR;
  });
  const p4 = await ctx4.newPage(); p4.on('pageerror', e => errors.push('p4 pageerror: ' + e.message));
  await p4.goto(BASE); await p4.waitForFunction(() => window.journalDebug && journalDebug.entries);
  await p4.evaluate(() => { journalDebug.settings.engine = 'phone'; saveSettings(); });
  await p4.click('#recBtn'); await p4.waitForSelector('#noteText'); await sleep(600);
  check((await p4.inputValue('#noteText')).includes('letzter Satz vorlaeufig'), 'dictation shows the provisional phrase');
  await p4.click('#entryBack'); await p4.waitForSelector('#home:not([hidden])'); await sleep(400);
  check(await p4.evaluate(() => journalDebug.entries.some(x => !x.deleted && x.text.includes('erster Satz') && x.text.includes('letzter Satz vorlaeufig'))), 'Back during dictation keeps the provisional last phrase');
  // typing while dictating stops dictation and keeps both
  await p4.click('.card'); await p4.waitForSelector('#noteText'); await p4.click('#dictBtn'); await sleep(400);
  await p4.focus('#noteText'); await p4.keyboard.press('End'); await p4.keyboard.type(' getippt'); await sleep(700);
  await p4.click('#entrySave'); await p4.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await p4.evaluate(() => { const e = journalDebug.entries.find(x => !x.deleted); return e && e.text.endsWith('getippt') && e.text.includes('letzter Satz vorlaeufig'); }), 'typing stops dictation and keeps dictated and typed text');

  console.log('\nerrors:', errors.length ? errors : 'none');
  if (errors.length) fails++;
  console.log(fails ? '\n' + fails + ' FAILURES' : '\nALL PASSED');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
