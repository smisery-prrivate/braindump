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

  // 2. record a short memo with segments every ~3 s
  await page.evaluate(() => { journalDebug.settings.segMin = 0.05; });
  await page.click('#recBtn');
  await page.waitForSelector('#rec:not([hidden])');
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
  await page.click('#menuBtn'); await page.waitForSelector('#sttKey');
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
  await page.evaluate(async () => { for (const g of journalDebug.entries[0].segs) { g.st = 'todo'; g.text = ''; } await journalDebug.persist(journalDebug.entries[0]); await journalDebug.saveStt(null); });

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
  await page.click('#txBtns button');
  await page.waitForFunction(() => journalDebug.entries[0].segs.every(g => g.st === 'done'), null, { timeout: 20000 });
  const tx = await page.evaluate(() => ({ text: document.getElementById('txText').value, segs: journalDebug.entries[0].segs.map(g => g.text) }));
  console.log('transcript', JSON.stringify(tx));
  check(tx.segs.length >= 2 && /prompt: Mock transcript \d+/.test(tx.segs[1]), 'second segment got the first one\'s tail as prompt');
  check(/Mock transcript \d+ \(.*\n\nMock transcript \d+/.test(tx.text), 'transcript stitched in the entry view');
  // edit the transcript
  await page.fill('#txText', 'Edited by hand.'); await sleep(1200);
  check(await page.evaluate(() => journalDebug.entries[0].tEdited && journalDebug.entries[0].transcript === 'Edited by hand.'), 'transcript edit stored');
  await page.click('#entryBack');

  // 4. set the encryption password, sync, then verify the cloud holds only ciphertext
  await page.click('#menuBtn'); await page.waitForSelector('#pw1');
  await page.fill('#pw1', 'correct horse battery'); await page.fill('#pw2', 'correct horse battery'); await page.click('#pwGo');
  await page.waitForFunction(() => journalDebug.syncState === '' && journalDebug.entries.every(e => e.pushed_at >= e.updated_at), null, { timeout: 20000 });
  const cloud = await fetchJson('http://localhost:' + PORT + '/__state');
  check(cloud.entries.length === 1 && cloud.objects.length === e.segs && !JSON.stringify(cloud.entries).includes('Erster'), 'cloud holds 1 sealed entry and ' + cloud.objects.length + ' sealed segments');
  await page.evaluate(() => back()); await sleep(500);

  // 5. a transcription failure backs off and is shown, then recovers
  await fetchJson('http://localhost:' + PORT + '/__fail?n=1');
  await page.evaluate(() => { journalDebug.settings.transcribe = 'auto'; });
  await page.click('#recBtn'); await sleep(4000); await page.click('#recStop'); await page.waitForSelector('#entry:not([hidden])', { timeout: 15000 });
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
  await page.click('#recBtn'); await page.waitForSelector('#rec:not([hidden])'); await sleep(12500);
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
  const r2 = await p2.evaluate(async bytes => { const f = new File([new Uint8Array(bytes)], 'x.journal'); let wrong = ''; try { await journalDebug.readBackup(f, 'nope'); } catch (e) { wrong = e.message; } const r = await journalDebug.readBackup(f, 'backup pass 1234'); return { wrong, r, n: journalDebug.entries.filter(e => !e.deleted).length, title: journalDebug.entries.find(e => e.title === 'Erster Test') && journalDebug.entries.find(e => e.title === 'Erster Test').transcript }; }, bk.bytes);
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
  const pulled = await p3.evaluate(async () => { const e = journalDebug.entries.find(x => x.title === 'Erster Test'); return { title: e && e.title, transcript: e && e.transcript, local: e ? !!(await journalDebug.segGet(e.segs[0].id)) : null, up: e && Object.keys(e.up).length }; });
  console.log('pulled', JSON.stringify(pulled));
  check(pulled.title === 'Erster Test' && pulled.transcript === 'Edited by hand.' && pulled.local === false, 'second device pulled the sealed entry; audio not yet local');
  await p3.evaluate(() => back()); await sleep(500);
  await p3.click('.card:has-text("Erster Test")'); await p3.waitForSelector('#playBtn');
  await p3.click('#playBtn'); await p3.waitForFunction(() => document.getElementById('tCur').textContent !== '0:00', null, { timeout: 15000 });
  check(await p3.evaluate(async () => !!(await journalDebug.segGet(journalDebug.entries.find(x => x.title === 'Erster Test').segs[0].id))), 'cloud segment fetched, decrypted and stored on play');
  // delete on device 3, tombstone reaches device 1
  await p3.click('#entryMore'); await p3.click('#popupBox button.danger'); await sleep(7000);
  await p3.waitForFunction(() => journalDebug.entries.find(x => x.title === 'Erster Test').deleted && journalDebug.syncState === '', null, { timeout: 20000 });
  let cloud2; for (let i = 0; i < 40; i++) { cloud2 = await fetchJson('http://localhost:' + PORT + '/__state'); if (cloud2.entries.find(r => r.deleted) && cloud2.objects.length < cloud.objects.length + 3) break; await sleep(500); }
  check(cloud2.entries.find(r => r.deleted) && cloud2.objects.length < cloud.objects.length + 10, 'delete marker in the cloud, objects removed: ' + cloud2.objects.length);
  await page.evaluate(() => journalDebug.syncNow());
  await page.waitForFunction(() => journalDebug.entries.find(x => x.title === 'Erster Test').deleted, null, { timeout: 20000 });
  check(!(await page.textContent('#list')).includes('Erster Test'), 'deletion propagated to the first device');

  console.log('\nerrors:', errors.length ? errors : 'none');
  if (errors.length) fails++;
  console.log(fails ? '\n' + fails + ' FAILURES' : '\nALL PASSED');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
