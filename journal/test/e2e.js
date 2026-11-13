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
  // headless Chromium has the on-device recognition API but no speech service: asking it kills the page
  await ctx.addInitScript(() => { const S = self.SpeechRecognition || self.webkitSpeechRecognition; if (S) { S.available = async () => 'unavailable'; S.install = async () => false; } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/502/.test(m.text())) errors.push('console: ' + m.text()); });      // the 502 is the mocked provider failure of step 5
  await fetchJson('http://localhost:' + PORT + '/__reset');

  // 1. boot
  await page.goto(BASE); await page.waitForFunction(() => window.journalDebug && document.getElementById('list').textContent.length > 0);
  check(await page.textContent('#list') .then(t => t.includes('empty')), 'empty state shown');
  check(await page.isVisible('#noteBtn') && !(await page.$('#recBtn')), 'one + button for a new entry, no microphone that records at once');

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
  await page.click('#takes [data-act=play]'); await sleep(2500);
  const pstate = await page.evaluate(() => ({ cur: document.querySelector('#takes .pcur').textContent, btn: document.querySelector('#takes [data-act=play]').textContent, err: document.querySelector('#takes .pstate').textContent }));
  check(pstate.cur !== '0:00' && !pstate.err, 'playback runs: ' + JSON.stringify(pstate));
  await page.click('#takes [data-act=play]');
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
  await page.click('#takes .tbtn button');
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
  await page.click('.card'); await page.waitForSelector('#entry:not([hidden])');
  check(await page.isVisible('#recHere') && await page.isVisible('#claudeBtn') && (await page.textContent('#recHere')).includes('Record') && !(await page.$('#dictBtn')), 'Record and Claude buttons in the entry, no browser dictation');
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])');

  // 2c2. the microphone records the voice inside the entry; the bar says how its text comes
  const before = await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length);
  await page.evaluate(() => { journalDebug.settings.engine = 'whisper'; });
  await page.click('#noteBtn'); await page.waitForSelector('#recHere'); await page.click('#recHere'); await page.waitForSelector('#recBar:not([hidden])'); await sleep(1500);
  check(await page.evaluate(() => journalDebug.recording && !document.getElementById('entry').hidden && document.getElementById('recLive').textContent.includes('written on this phone')), 'Whisper: the microphone records inside the entry, the text follows on this phone');
  await page.click('#recDiscard'); await page.waitForSelector('#popup.open'); await page.click('#popupBox button.danger'); await page.waitForFunction(() => !journalDebug.recording && !document.querySelector('#popup.open'), null, { timeout: 15000 }); await sleep(500);
  check(await page.isVisible('#entry:not([hidden])') && (await page.$$('#takes .player')).length === 0, 'a discarded recording leaves the entry open and empty');
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length) === before, 'leaving the empty entry drops it');
  // with a key the tap records in the background of the text window
  await page.evaluate(() => { journalDebug.settings.engine = 'key'; });
  await page.click('#noteBtn'); await page.waitForSelector('#recHere'); await page.click('#recHere'); await page.waitForSelector('#recBar:not([hidden])'); await sleep(1500);
  check(await page.evaluate(() => journalDebug.recording && !document.getElementById('entry').hidden), 'with a key the tap records inside the entry');
  await page.click('#recDiscard'); await page.waitForSelector('#popup.open'); await page.click('#popupBox button.danger'); await page.waitForFunction(() => !journalDebug.recording && !document.querySelector('#popup.open'), null, { timeout: 15000 }); await sleep(500);
  await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(() => journalDebug.entries.filter(x => !x.deleted).length) === before && !(await page.evaluate(() => journalDebug.recording)), 'discard drops the recording');

  // 2d. with an engine that gives recordings no text (Claude app), a recording says so and offers Whisper
  await page.evaluate(() => { journalDebug.settings.engine = 'claude'; journalDebug.settings.segMin = 0.05; });
  await page.evaluate(() => journalDebug.startRecording()); await page.waitForSelector('#recBar:not([hidden])'); await sleep(4000);
  check((await page.textContent('#recLive')).includes('choose a transcription'), 'the bar says the recording needs a transcription for its text');
  await page.click('#recStop'); await page.waitForSelector('#entry:not([hidden])', { timeout: 15000 }); await sleep(400);
  check(!(await page.isVisible('#popup.open')), 'no "Transcribe?" question without a transcription');
  await page.click('#takes .tbtn button'); await sleep(300);
  check((await page.textContent('#popupBox')).includes('Whisper'), 'stored audio offers Whisper for its text');
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
  await page.click('#noteBtn'); await page.waitForSelector('#noteText'); await sleep(300);
  check(await page.evaluate(() => document.activeElement !== document.getElementById('noteText') && !journalDebug.recording && document.getElementById('recHere').textContent.includes('Dictate')), 'a new entry opens quiet: nothing records, nothing is focused');
  await page.click('#recHere'); await sleep(300);
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'noteText' && document.activeElement.placeholder.includes('keyboard')), 'keyboard engine: Dictate focuses the field with the hint');
  await page.fill('#noteText', 'Per Tastatur diktiert'); await sleep(1000); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(() => journalDebug.entries.some(x => !x.deleted && x.text === 'Per Tastatur diktiert')), 'keyboard engine: entry kept with its text');
  await page.evaluate(async () => { const e = journalDebug.entries.find(x => x.text === 'Per Tastatur diktiert'); e.deleted = true; e.del_at = Date.now(); await journalDebug.persist(e); journalDebug.settings.engine = 'cloud'; saveSettings(); }); await sleep(300);

  // 2e4. the date of an entry can be set back; the list sorts it into its day
  await page.click('#noteBtn'); await page.waitForSelector('#noteText'); await page.fill('#noteText', 'Nachgetragen');
  check((await page.textContent('#entryDate')).includes(String(new Date().getFullYear())), 'date chip shows the date');
  await page.fill('#entryDateIn', '2024-05-17T21:30'); await page.dispatchEvent('#entryDateIn', 'change'); await sleep(300);
  check((await page.textContent('#entryDate')).includes('2024') && /21:30|9:30/.test(await page.textContent('#entryDate')), 'date chip shows the new date');
  await page.click('#entrySave'); await sleep(400); check(await page.isVisible('#entry:not([hidden])'), 'Save stays in the entry'); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  const back1 = await page.evaluate(async () => { const live = journalDebug.entries.filter(x => !x.deleted); const e = live.find(x => x.text === 'Nachgetragen'); const d = new Date(e.created); const r = await journalDebug.idb.get('entries', e.id); return { last: live[live.length - 1] === e, y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), stored: !!r, cardLast: [...document.querySelectorAll('.card')].pop().textContent.includes('Nachgetragen') }; });
  check(back1.y === 2024 && back1.m === 4 && back1.d === 17 && back1.h === 21 && back1.stored && back1.last && back1.cardLast, 'entry moved to 17 May 2024 and to the end of the list');
  await page.evaluate(async () => { const e = journalDebug.entries.find(x => x.text === 'Nachgetragen'); e.deleted = true; e.del_at = Date.now(); await journalDebug.persist(e); renderHome(); }); await sleep(300);

  // 2e3. Save button: stores, says so, back to the list
  await page.click('#noteBtn'); await page.waitForSelector('#noteText'); await page.fill('#noteText', 'Gespeichert per Knopf');
  await page.click('#entrySave'); await sleep(400); check(await page.isVisible('#entry:not([hidden])'), 'Save stays in the entry'); await page.click('#entryBack'); await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.evaluate(async () => { const e = journalDebug.entries.find(x => !x.deleted && x.text === 'Gespeichert per Knopf'); if (!e) return false; const r = await journalDebug.idb.get('entries', e.id); return !!r; }) , 'Save stores the text at once');
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

  // 2g. search in every folder (accents ignored, hits marked); export as one plain text file
  await page.evaluate(async () => {
    const mk = async (title, text, folder, created) => { const e = { id: 'srch-' + Math.random().toString(36).slice(2), created, updated_at: Date.now(), title, text, segs: [], pics: [], folder, state: 'done', deleted: false, tx: false, merged: true }; journalDebug.entries.push(e); await journalDebug.persist(e); };
    await mk('Am See', 'Heute waren wir am Bodensee und es war schön.', 'Reisen', new Date(2025, 10, 3, 9, 0).getTime());
    await mk('Arbeit', 'Über das Projekt gesprochen.', '', new Date(2025, 10, 4, 18, 30).getTime());
    sortEntries(); renderHome();
  });
  await page.click('#folderRow button[data-f="Reisen"]'); await sleep(200);
  check(await page.isVisible('#searchBox'), 'the search field is always there');
  await page.fill('#searchBox', 'uber projekt'); await sleep(300);
  const s1 = await page.evaluate(() => ({ cards: [...document.querySelectorAll('.card')].map(c => c.querySelector('.name').textContent), marks: [...document.querySelectorAll('.card mark')].map(m => m.textContent), info: document.getElementById('searchInfo').textContent }));
  console.log('search', JSON.stringify(s1));
  check(s1.cards.length === 1 && s1.cards[0] === 'Arbeit' && s1.marks.includes('Über') && s1.marks.includes('Projekt') && s1.info.includes('1 entry found, in all folders'), 'search looks outside the open folder, ignores accents and marks the hits');
  await page.fill('#searchBox', 'reisen'); await sleep(300);
  check(await page.evaluate(() => [...document.querySelectorAll('.card .name')].map(n => n.textContent).join() === 'Am See'), 'search finds the folder name');
  await page.fill('#searchBox', String(new Date(2025, 10, 3).toLocaleDateString(undefined, { month: 'long' })).toLowerCase() + ' 2025'); await sleep(300);
  check(await page.evaluate(() => (document.querySelectorAll('.card').length === 2)), 'search finds the month and year');
  await page.fill('#searchBox', 'bodensee'); await sleep(300);
  check(await page.isVisible('#searchExport'), 'Export offered for the hits');
  await page.click('#searchExport'); await page.waitForSelector('#popup.open');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#popupBox button.primary')]);
  const txt = require('fs').readFileSync(await dl.path(), 'utf8');
  console.log('export', JSON.stringify(dl.suggestedFilename()), JSON.stringify(txt.slice(0, 260)));
  check(/\.txt$/.test(dl.suggestedFilename()) && txt.startsWith('JOURNAL') && txt.includes('NOT encrypted') && txt.includes('Am See') && txt.includes('Bodensee') && !txt.includes('Projekt') && txt.includes('====='), 'the hits export as one plain text file');
  const full = await page.evaluate(() => textOfEntries(journalDebug.entries.filter(x => !x.deleted)));
  check(full.indexOf('Am See') < full.indexOf('Arbeit') && full.indexOf('Arbeit') < full.indexOf('Erster Test'), 'the full export runs oldest first');
  await page.fill('#searchBox', ''); await page.click('#folderRow button[data-f=""]'); await sleep(200);
  await page.evaluate(async () => { for (const e of journalDebug.entries.filter(x => x.id.startsWith('srch-'))) { journalDebug.entries.splice(journalDebug.entries.indexOf(e), 1); await journalDebug.idb.del('entries', e.id); } renderHome(); });

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
  if (await page.$('#takes .tbtn button')) await page.click('#takes .tbtn button');      // the queue may have started by itself right after the sign-in
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
  const st1 = await page.evaluate(() => ({ st: journalDebug.entries[0].segs.map(g => g.st), msg: document.querySelector('#takes .st').textContent }));
  console.log('fail state', JSON.stringify(st1));
  check(st1.st[0] === 'fail' && /provider down/.test(st1.msg), 'failure shown with reason');
  await page.click('#takes .tbtn button');
  await page.waitForFunction(() => journalDebug.entries[0].segs.every(g => g.st === 'done'), null, { timeout: 15000 });
  check(true, 'retry succeeded');
  await page.click('#entryBack');

  // 6. PIN lock: set, relock (restart), unlock; the "not locked yet" line goes away once a lock is set
  await page.waitForSelector('#home:not([hidden])'); await sleep(300);
  check(await page.isVisible('#lockNudge'), 'home says the journal is not locked yet');
  // headless Chromium has no fingerprint: the tap opens the menu straight at the password form
  await page.click('#lockNudge'); await page.waitForSelector('#pin1', { timeout: 5000 }).catch(() => {});
  check(await page.isVisible('#sheet.open') && await page.isVisible('#pin1'), 'without a fingerprint the tap leads to the password form');
  check(await page.evaluate(() => [...document.querySelectorAll('#pinForm .pmuser')].map(x => x.value).join() === 'Journal app lock' && document.getElementById('pin2').autocomplete === 'new-password'), 'lock password form names itself for password managers, asks twice');
  // backup password: asked twice, named for password managers
  await page.evaluate(() => document.getElementById('bkPw').scrollIntoView());
  await page.fill('#bkPw', 'ein langes passwort'); await page.fill('#bkPw2', 'ein anderes passwort'); await page.click('#bkMake'); await sleep(300);
  check((await page.textContent('#bkHint')).includes('differ') && await page.evaluate(() => document.querySelector('#bkForm .pmuser').value === 'Journal backup'), 'backup password asked twice, mismatch caught, named "Journal backup"');
  await page.evaluate(() => back()); await sleep(400);
  await page.evaluate(() => journalDebug.Vault.setPin('langes passwort 123'));
  await page.evaluate(() => renderLockNudge()); check(!(await page.isVisible('#lockNudge')), 'the line is gone once the lock is on');
  await page.evaluate(() => journalDebug.relock());
  await page.waitForFunction(() => window.journalDebug && journalDebug.locked && document.getElementById('lock').hidden === false, null, { timeout: 15000 });
  check(await page.evaluate(() => !journalDebug.Vault.isOpen()), 'after the restart the key is not in memory');
  check(await page.evaluate(() => document.querySelector('#lockForm .pmuser').value === 'Journal app lock' && document.getElementById('pinInput').autocomplete === 'current-password'), 'lock screen field can be filled by a password manager');
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
  await p3.click('.card:has-text("Erster Test")'); await p3.waitForSelector('#takes [data-act=play]');
  await p3.click('#takes [data-act=play]'); await p3.waitForFunction(() => document.querySelector('#takes .pcur').textContent !== '0:00', null, { timeout: 15000 });
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

  // 10. Whisper on this phone: the microphone records, the text is written from the recording afterwards.
  // Here the model cannot be downloaded (no access to Hugging Face), so the worker is replaced by a
  // stand-in that checks what it is given (16 kHz samples of the real recording) and answers like Whisper.
  const wav = require('path').join(require('os').tmpdir(), 'journal-voice.wav');
  { const sr = 16000, n = sr * 30, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / sr * 2 * Math.PI * 220) * 9000 * (0.6 + 0.4 * Math.sin(i / sr * 2 * Math.PI * 3))), 44 + i * 2);
    require('fs').writeFileSync(wav, buf); }
  const browser2 = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav, '--autoplay-policy=no-user-gesture-required'] });
  const fakeWhisper = () => {
    window.__wruns = []; const Real = window.Worker;
    window.Worker = function (url, opts) {
      if (!String(url).includes('whisper-worker')) return new Real(url, opts);
      const w = { onmessage: null, onerror: null, dead: false, terminate() { w.dead = true; }, postMessage(m) {
        const say = (d, ms) => setTimeout(() => { if (!w.dead && w.onmessage) w.onmessage({ data: d }); }, ms || 0);
        const net = !localStorage.getItem('fake.cached');                       // like the real worker: "download" only until the files sit in the cache
        if (m.type === 'load') { say({ type: 'loading', model: m.model, net }); say({ type: 'ready', model: m.model }, 50); localStorage.setItem('fake.cached', '1'); return; }
        if (m.type !== 'run') return;
        window.__wruns.push({ len: m.audio.length, lang: m.language, model: m.model, ctor: m.audio.constructor.name, rec: !!journalDebug.recording });
        const k = window.__wruns.length;
        if (!w.loaded) { say({ type: 'loading', model: m.model, net }); say({ type: 'progress', loaded: 40e6, total: 80e6, net }); say({ type: 'ready', model: m.model }, 1200); setTimeout(() => localStorage.setItem('fake.cached', '1'), 1200); w.loaded = true; }
        say({ type: 'working', id: m.id, language: 'de' }, w.loaded ? 1250 : 50);
        say({ type: 'result', id: m.id, text: window.__empty ? '' : 'Aufnahme Nummer ' + k + ' von Whisper', language: 'de', raw: window.__empty ? 'Vielen Dank.' : '', secs: 3 }, 1800);
      } };
      return w;
    };
  };
  const ctx5 = await browser2.newContext({ viewport: { width: 400, height: 800 } }); await ctx5.grantPermissions(['microphone']);
  await ctx5.addInitScript(fakeWhisper);
  await ctx5.addInitScript(() => { if (!localStorage.getItem('test.migr')) { localStorage.setItem('test.migr', '1'); localStorage.setItem('journal.settings', JSON.stringify({ engine: 'phone', dictVoice: true, srLocal: true })); } });      // a phone set up in the dictation days
  const p5 = await ctx5.newPage(); p5.on('pageerror', e => errors.push('p5 pageerror: ' + e.message));
  await p5.goto(BASE); await p5.waitForFunction(() => window.journalDebug && journalDebug.entries);
  check(await p5.evaluate(() => journalDebug.settings.engine === 'whisper' && !('dictVoice' in journalDebug.settings)), 'the old dictation setting becomes Whisper');
  await p5.click('#noteBtn'); await p5.waitForSelector('#recHere'); await p5.click('#recHere'); await p5.waitForSelector('#recBar:not([hidden])'); await sleep(3000);
  check((await p5.textContent('#recLive')).includes('written on this phone') && await p5.evaluate(() => window.__wruns.length === 0), 'while recording: the bar says the text follows, Whisper waits');
  await p5.click('#recStop');
  await p5.waitForFunction(() => /Downloading the speech model/.test((document.querySelector('#takes .st') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const dlMsg = await p5.evaluate(() => (document.querySelector('#takes .st') || {}).textContent || '');
  check(/Downloading the speech model, once: 38\.1 MB of about 81\.1 MB \(47 %\)/.test(dlMsg) && /Keep the app open/.test(dlMsg), 'first time: the recording shows the download in MB and percent (' + dlMsg + ')');
  await p5.waitForFunction(() => { const e = journalDebug.entries.find(x => !x.deleted); return e && e.segs.length && e.segs.every(g => g.st === 'done'); }, null, { timeout: 15000 }).catch(() => {});
  await sleep(300);
  const w1 = await p5.evaluate(() => ({ runs: window.__wruns, text: document.getElementById('noteText').value, blocks: document.querySelectorAll('#takes .player').length, st: (document.querySelector('#takes .st') || {}).textContent, entryText: journalDebug.entries.find(x => !x.deleted).text }));
  console.log('whisper 1', JSON.stringify(w1));
  check(w1.runs.length === 1 && w1.runs[0].ctor === 'Float32Array' && w1.runs[0].len > 16000 * 2.2 && w1.runs[0].len < 16000 * 4.5 && w1.runs[0].model === 'Xenova/whisper-base' && !w1.runs[0].rec, 'the recording reaches Whisper as 16 kHz samples after the stop (' + (w1.runs[0] && w1.runs[0].len) + ')');
  check(w1.blocks === 1 && w1.entryText.includes('Aufnahme Nummer 1 von Whisper') && w1.text.includes('Aufnahme Nummer 1') && /text is in the entry/.test(w1.st), 'its text lands in the entry, the recording above it');
  // a second recording from inside the entry
  await p5.click('#recHere'); await p5.waitForSelector('#recBar:not([hidden])'); await sleep(2500);
  check((await p5.textContent('#recHere')).includes('Stop'), 'Record turns into Stop while this entry records');
  await p5.click('#recHere');
  await p5.waitForFunction(() => window.__wruns.length === 2 && journalDebug.entries.find(x => !x.deleted).segs.every(g => g.st === 'done'), null, { timeout: 15000 }).catch(() => {});
  await sleep(300);
  const w2 = await p5.evaluate(() => ({ live: journalDebug.entries.filter(x => !x.deleted).length, heads: [...document.querySelectorAll('#takes .phead')].map(h => h.textContent), text: journalDebug.entries.find(x => !x.deleted).text }));
  console.log('whisper 2', JSON.stringify(w2));
  check(w2.live === 1 && w2.heads.length === 2 && w2.heads[0].includes('Recording 1') && w2.heads[1].includes('Recording 2') && w2.text.indexOf('Nummer 1') >= 0 && w2.text.indexOf('Nummer 2') > w2.text.indexOf('Nummer 1'), 'Record in the entry adds a second recording below the first, its text after the first');
  // typing while a recording's text arrives: both stay, the cursor stays where it is
  await p5.click('#noteText'); await p5.keyboard.press('End'); await p5.keyboard.type(' und getippt');
  await p5.evaluate(() => { const e = journalDebug.entries.find(x => !x.deleted); e.text = e.text + '\nText aus einer Aufnahme'; renderEntry(); });
  await p5.keyboard.type(' weiter'); await p5.evaluate(() => document.activeElement.blur()); await sleep(300);
  const mix = await p5.evaluate(() => ({ e: journalDebug.entries.find(x => !x.deleted).text, f: document.getElementById('noteText').value }));
  console.log('typing while text arrives', JSON.stringify(mix));
  check(mix.e === mix.f && mix.e.includes('und getippt weiter') && mix.e.includes('Text aus einer Aufnahme') && mix.e.includes('Nummer 2'), 'typing while a recording\'s text arrives: nothing is lost');
  // each recording has its own player
  await p5.click('#takes .player:nth-child(2) .speed button[data-rate="0.5"]'); await p5.click('#takes .player:nth-child(2) [data-act=play]'); await sleep(1200);
  const pl = await p5.evaluate(() => { const b = document.querySelectorAll('#takes .player'); return { b1: b[0].querySelector('[data-act=play]').textContent, b2: b[1].querySelector('[data-act=play]').textContent, t2: +b[1].querySelector('.pseek').value, rate: [...b[0].querySelectorAll('.speed button.on')].map(x => x.dataset.rate).join() }; });
  await p5.click('#takes .player:nth-child(2) [data-act=fwd]'); await sleep(700);
  const t2b = await p5.evaluate(() => +document.querySelectorAll('#takes .player')[1].querySelector('.pseek').value);
  check(pl.b2 === '❚❚' && pl.b1 === '▶' && pl.t2 > 0 && pl.t2 < 1200 && pl.rate === '0.5' && t2b > pl.t2 + 500, 'each recording plays on its own: half speed, 10 s on, the other one stays still (' + JSON.stringify(pl) + ' → ' + t2b + ')');
  await p5.click('#takes .player:nth-child(2) [data-act=play]');
  // a finger on the slider whose release gets lost (the block is redrawn meanwhile): the bar must not freeze
  await p5.evaluate(() => { const s = document.querySelector('#takes .player:nth-child(1) .pseek'); s.value = 250; s.dispatchEvent(new Event('input', { bubbles: true })); renderEntry(); });
  await sleep(900); await p5.click('#takes .player:nth-child(1) [data-act=play]'); await sleep(1500);
  const moved = await p5.evaluate(() => +document.querySelector('#takes .player:nth-child(1) .pseek').value);
  await p5.click('#takes .player:nth-child(1) [data-act=play]');
  check(moved > 300, 'a lost slider release no longer freezes the bar (' + moved + ' ms)');
  // a third recording discarded: the entry and its first two stay
  await p5.click('#recHere'); await p5.waitForSelector('#recBar:not([hidden])'); await sleep(1500);
  await p5.click('#recDiscard'); await p5.waitForSelector('#popup.open'); await p5.click('#popupBox button.danger'); await sleep(1500);
  check(await p5.evaluate(() => { const live = journalDebug.entries.filter(x => !x.deleted); return live.length === 1 && takesOf(live[0]).length === 2 && document.querySelectorAll('#takes .player').length === 2 && !journalDebug.recording; }), 'discarding a third recording keeps the entry and its first two');
  // Whisper hears nothing: the recording says so, with what Whisper gave, and Try again gets the text
  await p5.evaluate(() => { window.__empty = true; });
  await p5.click('#recHere'); await p5.waitForSelector('#recBar:not([hidden])'); await sleep(1500); await p5.click('#recHere');
  await p5.waitForFunction(() => /No text/.test([...document.querySelectorAll('#takes .st')].map(s => s.textContent).join()), null, { timeout: 15000 }).catch(() => {});
  const em = await p5.evaluate(() => { const b = [...document.querySelectorAll('#takes .player')].pop(); return { st: b.querySelector('.st').textContent, btn: (b.querySelector('.tbtn button') || {}).textContent, segs: journalDebug.entries.find(x => !x.deleted).segs.map(g => g.st).join(), text: journalDebug.entries.find(x => !x.deleted).text }; });
  console.log('empty', JSON.stringify(em));
  check(/No text: no words heard in 3 s; Whisper gave only “Vielen Dank\.”/.test(em.st) && em.btn === 'Try again' && /empty$/.test(em.segs) && !em.text.includes('Vielen Dank'), 'a recording with no words says so, offers Try again, adds nothing to the text');
  await p5.evaluate(() => { window.__empty = false; });
  await p5.click('#takes .player:last-child .tbtn button');
  await p5.waitForFunction(() => journalDebug.entries.find(x => !x.deleted).segs.every(g => g.st === 'done'), null, { timeout: 15000 }).catch(() => {});
  check(await p5.evaluate(() => { const e = journalDebug.entries.find(x => !x.deleted); return e.segs.every(g => g.st === 'done') && e.text.includes('Nummer 4'); }), 'Try again transcribes that recording anew and appends its text');
  // after a restart the model starts from the cache: no "Downloading"
  const p5b = await ctx5.newPage(); p5b.on('pageerror', e => errors.push('p5b pageerror: ' + e.message));
  await p5.close(); await p5b.goto(BASE); await p5b.waitForFunction(() => window.journalDebug && journalDebug.entries && !journalDebug.locked);
  await p5b.click('#noteBtn'); await p5b.waitForSelector('#recHere'); await p5b.click('#recHere'); await p5b.waitForSelector('#recBar:not([hidden])'); await sleep(1500); await p5b.click('#recStop');
  await p5b.waitForFunction(() => /speech model/.test((document.querySelector('#takes .st') || {}).textContent || ''), null, { timeout: 8000 }).catch(() => {});
  const startMsg = await p5b.evaluate(() => (document.querySelector('#takes .st') || {}).textContent || '');
  check(/Starting the speech model on this phone \(it is downloaded already\)/.test(startMsg) && !/Downloading/.test(startMsg), 'after a restart the model starts from the cache, not "Downloading" (' + startMsg + ')');
  await p5b.waitForFunction(() => { const e = journalDebug.entries.find(x => !x.deleted); return e && e.segs.length && e.segs.every(g => g.st === 'done'); }, null, { timeout: 15000 }).catch(() => {});
  await p5b.click('#entryBack'); await p5b.waitForSelector('#home:not([hidden])');
  const p5c = p5b;
  // the menu: Whisper chosen, the model on this phone
  await p5c.click('#menuBtn'); await p5c.waitForSelector('#setWModel');
  check(await p5c.evaluate(() => document.getElementById('setEngine').value === 'whisper' && document.getElementById('wState').textContent.includes('on this phone') && document.getElementById('wFetch').hidden), 'menu: Whisper chosen, the speech model is on this phone');
  await p5c.evaluate(() => back());

  // 10b. with the service worker in charge, the page is cross-origin isolated (the speech model gets
  // all cores); a CORS fetch to another origin (the model's weights) still works under it
  const ctxI = await browser2.newContext({ viewport: { width: 400, height: 800 } }); await ctxI.grantPermissions(['microphone']);
  await ctxI.addInitScript(() => { try { localStorage.setItem('journal.sw', '1'); } catch (e) {} });
  await ctxI.route(/huggingface\.co/, route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"ok":true}' }));
  const pI = await ctxI.newPage(); pI.on('pageerror', e => errors.push('pI pageerror: ' + e.message));
  await pI.goto(BASE); await pI.waitForFunction(() => window.journalDebug && journalDebug.entries);
  await pI.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
  // the app reloads itself once at a quiet moment: asked across that reload until the page is isolated
  let iso0 = false; for (let i = 0; i < 40; i++) { try { iso0 = await pI.evaluate(() => self.crossOriginIsolated && !!window.journalDebug && !!journalDebug.entries); if (iso0) break; } catch (e) {} await sleep(500); }
  if (!iso0) { await pI.reload(); await pI.waitForFunction(() => window.journalDebug && journalDebug.entries); }
  await sleep(500);
  const iso = await pI.evaluate(async () => ({ iso: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function', cores: whisperCores(), hf: await fetch('https://huggingface.co/x/config.json').then(r => r.ok).catch(() => false), menu: (document.getElementById('menuBtn') && (openSheet(), document.getElementById('wState').textContent)) }));
  console.log('isolation', JSON.stringify({ before: iso0, ...iso }));
  check(iso.iso && iso.sab && iso.cores >= 1 && iso.hf && /processor core/.test(iso.menu), 'under the service worker the page is isolated, cores known in the menu, the model\'s weights still fetchable');
  await pI.evaluate(() => back());

  // 10c. the log: the real library under isolation, stand-in model files; the details show every step
  // up to the failure, ready to copy
  await ctxI.route(/huggingface\.co|\.hf\.co/, route => {
    const u = route.request().url(), head = { 'access-control-allow-origin': '*' };
    if (/\/config\.json$/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', headers: head, body: JSON.stringify({ model_type: 'whisper', architectures: ['WhisperForConditionalGeneration'], d_model: 512, encoder_layers: 6, decoder_layers: 6, num_mel_bins: 80, vocab_size: 51865 }) });
    if (u.endsWith('.json')) return route.fulfill({ status: 200, contentType: 'application/json', headers: head, body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: head, body: Buffer.from('not an onnx model') });
  });
  await pI.click('#noteBtn'); await pI.waitForSelector('#recHere'); await pI.click('#recHere'); await pI.waitForSelector('#recBar:not([hidden])'); await sleep(2500); await pI.click('#recHere');
  await pI.waitForFunction(() => { const e = journalDebug.entries.find(x => !x.deleted); return e && e.segs.some(g => g.st === 'fail'); }, null, { timeout: 40000 }).catch(() => {});
  await pI.click('#entryBack'); await pI.waitForSelector('#home:not([hidden])'); await pI.click('#menuBtn'); await pI.waitForSelector('#wLogBtn'); await pI.click('#wLogBtn'); await pI.waitForSelector('pre.wlog');
  const wl = await pI.textContent('pre.wlog');
  console.log('log\n' + wl.split('\n').slice(0, 14).join('\n'));
  check(/isolated true · threads [2-9]/.test(wl) && /recording decoded in \d+ ms: audio\/webm/.test(wl) && /loudest \d\.\d+/.test(wl) && /loading Xenova\/whisper-base from the network/.test(wl) && /FAILED/.test(wl) && /part failed:/.test(wl), 'the details log every step on the phone, from the worker start to the failure');
  await pI.click('#popupBox button.quiet');

  // 11. the real library and runtime against a stand-in for Hugging Face: the right model files are
  // asked for, the runtime (WebAssembly) loads from the app's own folder and the page's rules allow it
  const ctx6 = await browser2.newContext({ viewport: { width: 400, height: 800 } }); await ctx6.grantPermissions(['microphone']);
  const hf = [], vendor = [];
  await ctx6.route(/huggingface\.co|\.hf\.co/, route => {
    const u = route.request().url(); hf.push(u.replace(/^https:\/\/[^/]+/, ''));
    const head = { 'access-control-allow-origin': '*' };
    if (/\/config\.json$/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', headers: head, body: JSON.stringify({ model_type: 'whisper', architectures: ['WhisperForConditionalGeneration'], d_model: 512, encoder_layers: 6, decoder_layers: 6, num_mel_bins: 80, vocab_size: 51865 }) });
    if (/preprocessor_config\.json$/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', headers: head, body: JSON.stringify({ feature_extractor_type: 'WhisperFeatureExtractor', processor_class: 'WhisperProcessor', feature_size: 80, sampling_rate: 16000, n_fft: 400, hop_length: 160, chunk_length: 30, n_samples: 480000, nb_max_frames: 3000, padding_value: 0 }) });
    if (u.endsWith('.json')) return route.fulfill({ status: 200, contentType: 'application/json', headers: head, body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: head, body: Buffer.from('not an onnx model') });
  });
  ctx6.on('request', r => { if (/\/vendor\//.test(r.url())) vendor.push(r.url().replace(/^http:\/\/[^/]+/, '')); });
  const p6 = await ctx6.newPage(); p6.on('pageerror', e => errors.push('p6 pageerror: ' + e.message));
  await p6.goto(BASE); await p6.waitForFunction(() => window.journalDebug && journalDebug.entries);
  await p6.click('#noteBtn'); await p6.waitForSelector('#recHere'); await p6.click('#recHere'); await p6.waitForSelector('#recBar:not([hidden])'); await sleep(2500); await p6.click('#recStop');
  await p6.waitForFunction(() => { const e = journalDebug.entries.find(x => !x.deleted); return e && e.segs.some(g => g.st === 'fail'); }, null, { timeout: 30000 }).catch(() => {});
  for (let i = 0; i < 40 && !vendor.some(u => u.endsWith('.wasm')); i++) await sleep(500);      // the runtime starts beside the other model files; a failing one does not stop it
  console.log('model requests', JSON.stringify([...new Set(hf)]), 'runtime', JSON.stringify([...new Set(vendor)]));
  check(hf.some(u => u.endsWith('/Xenova/whisper-base/resolve/main/onnx/encoder_model_quantized.onnx')) && hf.some(u => u.endsWith('/onnx/decoder_model_merged_quantized.onnx')) && hf.some(u => u.endsWith('/tokenizer.json')), 'the speech model files are asked for under their real names');
  check(vendor.some(u => u.endsWith('ort-wasm-simd-threaded.asyncify.wasm')) && vendor.some(u => u.endsWith('ort-wasm-simd-threaded.asyncify.mjs')) && vendor.some(u => u.endsWith('transformers.min.js')), 'the library and its WebAssembly runtime load from the app itself');
  check(/No text yet/.test(await p6.textContent('#takes .st')), 'a model that cannot run is reported in the recording, nothing breaks');
  // no connection to Hugging Face: said in plain words
  const ctx7 = await browser2.newContext({ viewport: { width: 400, height: 800 } }); await ctx7.grantPermissions(['microphone']);
  await ctx7.route(/huggingface\.co|\.hf\.co/, route => route.abort('internetdisconnected'));
  const p7 = await ctx7.newPage(); p7.on('pageerror', e => errors.push('p7 pageerror: ' + e.message));
  await p7.goto(BASE); await p7.waitForFunction(() => window.journalDebug && journalDebug.entries);
  await p7.click('#noteBtn'); await p7.waitForSelector('#recHere'); await p7.click('#recHere'); await p7.waitForSelector('#recBar:not([hidden])'); await sleep(2000); await p7.click('#recStop');
  await p7.waitForFunction(() => { const e = journalDebug.entries.find(x => !x.deleted); return e && e.segs.some(g => g.st === 'fail'); }, null, { timeout: 30000 }).catch(() => {});
  const st7 = await p7.textContent('#takes .st');
  console.log('offline', st7);
  check(/could not be downloaded; is the phone online\?/.test(st7) && (await p7.isVisible('#takes .tbtn button')), 'offline: the recording says the model could not be downloaded and offers to try again');
  await browser2.close();

  console.log('\nerrors:', errors.length ? errors : 'none');
  if (errors.length) fails++;
  console.log(fails ? '\n' + fails + ' FAILURES' : '\nALL PASSED');
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
