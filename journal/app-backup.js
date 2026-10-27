'use strict';
/* Journal backup: one encrypted file with every entry and every audio segment, wrapped with a
   password of its own (PBKDF2, 600,000 rounds, AES-256-GCM), readable by any Journal on any
   device. Also a plain Markdown export of the texts, clearly marked as unencrypted. */
let backupBusy = false;
const BK_MAGIC = utf8('JNBK1\n');
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };

async function makeBackup(password) {
  const salt = Vault.rand(16), iter = Vault.PBKDF_ITER, k = await Vault.passKey(password, salt, iter);
  const list = entries.filter(e => !e.broken).map(cloudFields), parts = [BK_MAGIC];
  const header = utf8(JSON.stringify({ v: 1, salt: Array.from(salt), iter, created: Date.now(), app: 'journal', n: list.length }));
  parts.push(u32(header.length), header);
  const segs = [];
  for (const e of list) if (!e.deleted) for (const g of e.segs) segs.push({ id: g.id, entry: e.id, mime: g.mime, size: g.size, dur: g.dur, i: g.i });
  const have = [];
  for (const s of segs) { if (await segHas(s.id)) have.push(s); }
  const manifest = await k.seal(utf8(JSON.stringify({ entries: list, segs: have.map(s => s.id) })), 'jn|bk|manifest');
  parts.push(u32(manifest.byteLength), manifest);
  for (const s of have) {
    const e = byId(s.entry), g = e && e.segs.find(x => x.id === s.id);
    const blob = await segGet(s.id, s.mime); if (!blob) continue;
    const sealed = await k.seal(await blob.arrayBuffer(), 'jn|bk|seg|' + s.id);
    parts.push(u32(sealed.byteLength), sealed);
    if (g) g.inBackup = true;
  }
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), missing: segs.length - have.length };
}
async function readBackup(file, password, progress) {
  const head = new Uint8Array(await file.slice(0, 6).arrayBuffer());
  if (head.length < 6 || !BK_MAGIC.every((b, i) => b === head[i])) throw new Error('This is not a Journal backup file.');
  let pos = 6;
  const readLen = async () => { const b = await file.slice(pos, pos + 4).arrayBuffer(); if (b.byteLength < 4) throw new Error('The file is cut off.'); pos += 4; return new DataView(b).getUint32(0); };
  const readFrame = async () => { const n = await readLen(); const b = await file.slice(pos, pos + n).arrayBuffer(); if (b.byteLength < n) throw new Error('The file is cut off.'); pos += n; return b; };
  let header; try { header = JSON.parse(new TextDecoder().decode(await readFrame())); } catch (e) { throw new Error('The file header is damaged.'); }
  if (header.v !== 1 || !Array.isArray(header.salt)) throw new Error('This backup has an unknown format.');
  const k = await Vault.passKey(password, new Uint8Array(header.salt), header.iter);
  let manifest; try { manifest = JSON.parse(new TextDecoder().decode(await k.open(await readFrame(), 'jn|bk|manifest'))); } catch (e) { throw new Error('Wrong backup password.'); }
  let added = 0, updated = 0, audio = 0;
  const wanted = new Map();
  for (const m of manifest.entries || []) {
    if (!m || typeof m.id !== 'string') continue;
    const local = byId(m.id);
    if (!local) { if (m.deleted) continue; const e = Object.assign({ segs: [] }, m, { cloud: false, srv: 0, pushed_at: 0, up: {}, broken: false }); mergeText(e); entries.push(e); for (const g of e.segs) wanted.set(g.id, e); added++; await persist(e, { quiet: true }); continue; }
    if ((m.updated_at || 0) > (local.updated_at || 0)) {
      if (m.deleted) { if (!local.deleted) { local.deleted = true; local.del_at = m.del_at || Date.now(); purgeEntryData(local).catch(() => {}); } local.updated_at = m.updated_at; }
      else { Object.assign(local, m, { pushed_at: 0, up: local.up || {} }); mergeText(local); for (const g of local.segs) wanted.set(g.id, local); }
      updated++; await persist(local, { quiet: true });
    } else if (!local.deleted) for (const g of local.segs) wanted.set(g.id, local);
  }
  entries.sort((a, b) => (b.created || 0) - (a.created || 0));
  const ids = manifest.segs || []; let i = 0;
  for (const id of ids) {
    i++; if (progress) progress(i, ids.length);
    const buf = await readFrame();
    const e = wanted.get(id); if (!e || await segHas(id)) continue;
    const g = e.segs.find(x => x.id === id); if (!g) continue;
    let plain; try { plain = await k.open(buf, 'jn|bk|seg|' + id); } catch (err) { continue; }
    await segPut(id, new Blob([plain], { type: g.mime }), { entry: e.id, mime: g.mime, size: g.size, dur: g.dur, i: g.i });
    audio++;
  }
  return { added, updated, audio };
}
function markdownOfAll() {
  const out = ['# Journal export', 'Exported ' + new Date().toLocaleString() + ' · ' + live().length + ' entries · plain text, not encrypted', ''];
  for (const e of live().slice().sort((a, b) => a.created - b.created)) out.push(entryAsText(e).replace(/^# /, '## '), '');
  return out.join('\n');
}
async function deliverFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return 'saved';
}

// ---------- the backup part of the menu ----------
function renderBackupBox() {
  const box = $('backupBox'); if (!box) return;
  let last = 0; try { last = +localStorage.getItem('journal.lastBackup') || 0; } catch (e) {}
  const n = live().length, size = live().reduce((s, e) => s + (e.segs || []).reduce((a, g) => a + (g.size || 0), 0), 0);
  box.innerHTML = '<p>An encrypted file with every entry and every recording (' + n + ' entries, about ' + fmtSize(size) + '). It opens in Journal on any device with the backup password. ' + (last ? 'Last backup ' + fmtDate(last) + '.' : 'No backup yet.') + '</p>' +
    '<input id="bkPw" type="password" autocomplete="off" placeholder="Backup password (10+ characters)"><button id="bkMake" class="btn primary">Save encrypted backup</button>' +
    '<button id="bkLoad" class="btn">Load a backup file</button><div class="hint" id="bkHint"></div>' +
    '<button id="bkMd" class="btn quiet">Export all texts as Markdown (not encrypted)</button>';
  $('bkMake').addEventListener('click', async () => {
    const pw = $('bkPw').value, hint = $('bkHint');
    if (backupBusy) return;
    if (pw.length < 10) { hint.textContent = 'Use a backup password of at least 10 characters. You need it to open the file later; it cannot be recovered.'; return; }
    backupBusy = true; hint.textContent = 'Encrypting…';
    try {
      const { blob, missing } = await makeBackup(pw);
      const res = await deliverFile(blob, 'journal-' + dayKey(Date.now()) + '.journal');
      if (res !== 'cancelled') { try { localStorage.setItem('journal.lastBackup', String(Date.now())); } catch (e) {} hint.textContent = 'Backup ' + res + (missing ? '. ' + missing + ' recordings are only in the cloud and were not included.' : '.'); $('bkPw').value = ''; }
      else hint.textContent = '';
    } catch (e) { hint.textContent = 'Backup failed: ' + errText(e); }
    finally { backupBusy = false; }
  });
  $('bkLoad').addEventListener('click', () => {
    const pw = $('bkPw').value, hint = $('bkHint');
    if (!pw) { hint.textContent = 'Enter the backup password of the file first, then choose the file.'; return; }
    $('importInput').value = ''; $('importInput').click();
  });
  $('bkMd').addEventListener('click', () => popup('Export as plain text?', 'The Markdown file is NOT encrypted. Anyone who gets the file can read your journal. Keep it only in a place you trust.', [
    { label: 'Export', cls: 'primary', fn: () => deliverFile(new Blob([markdownOfAll()], { type: 'text/markdown' }), 'journal-' + dayKey(Date.now()) + '.md').then(r => { if (r !== 'cancelled') toast('Exported'); }) },
    { label: 'Cancel', cls: 'quiet' }]));
}
$('importInput').addEventListener('change', async ev => {
  const f = ev.target.files && ev.target.files[0]; if (!f || backupBusy) return;
  const pwEl = $('bkPw'), hint = $('bkHint'), pw = pwEl ? pwEl.value : '';
  if (!pw) { if (hint) hint.textContent = 'Enter the backup password first.'; return; }
  backupBusy = true; if (hint) hint.textContent = 'Reading…';
  try {
    const r = await readBackup(f, pw, (i, n) => { if ($('bkHint')) $('bkHint').textContent = 'Restoring recording ' + i + ' of ' + n + '…'; });
    if ($('bkHint')) $('bkHint').textContent = 'Done: ' + r.added + ' entries added, ' + r.updated + ' updated, ' + r.audio + ' recordings restored.';
    renderAll(); scheduleSync();
  } catch (e) { if ($('bkHint')) $('bkHint').textContent = 'Not loaded: ' + errText(e); }
  finally { backupBusy = false; }
});
