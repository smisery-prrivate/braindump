// Mock of the few Supabase endpoints Journal uses, plus a static server for the app folder.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = process.argv[2], PORT = +process.argv[3] || 8765;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const state = { keys: new Map(), entries: new Map(), objects: new Map(), stamp: 1000, txCalls: 0, txFailNext: 0 };
const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'pat@example.com' };
const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const token = exp => 'h.' + b64url(JSON.stringify({ sub: USER.id, exp })) + '.s';
const readBody = req => new Promise(res => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const authed = req => (req.headers.authorization || '').startsWith('Bearer h.');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname;
  if (p.startsWith('/auth/') || p.startsWith('/rest/') || p.startsWith('/storage/') || p.startsWith('/functions/') || p === '/__state' || p === '/__reset' || p === '/__fail') {
    const body = await readBody(req);
    if (p === '/__state') return json(res, 200, { keys: [...state.keys.values()], entries: [...state.entries.values()], objects: [...state.objects.keys()], txCalls: state.txCalls });
    if (p === '/__reset') { state.keys.clear(); state.entries.clear(); state.objects.clear(); state.txCalls = 0; state.txFailNext = +u.searchParams.get('failNext') || 0; return json(res, 200, { ok: true }); }
    if (p === '/__fail') { state.txFailNext = +u.searchParams.get('n') || 0; return json(res, 200, { ok: true }); }
    if (p === '/auth/v1/otp') return json(res, 200, {});
    if (p === '/auth/v1/token') { const j = JSON.parse(body.toString() || '{}'); if (u.searchParams.get('grant_type') === 'pkce' && j.auth_code !== 'goodcode') return json(res, 400, { error: 'bad code' }); return json(res, 200, { access_token: token(Math.floor(Date.now() / 1000) + 3600), refresh_token: 'r' + Date.now() }); }
    if (p === '/auth/v1/user') return authed(req) ? json(res, 200, USER) : json(res, 401, { error: 'no' });
    if (!authed(req)) return json(res, 401, { message: 'JWT required' });
    if (p === '/rest/v1/jn_keys') {
      if (req.method === 'GET') return json(res, 200, [...state.keys.values()]);
      const j = JSON.parse(body.toString());
      if (req.method === 'POST') { if (state.keys.has(USER.id)) return json(res, 409, {}); state.keys.set(USER.id, j); res.writeHead(201); return res.end(); }
      if (req.method === 'PATCH') { state.keys.set(USER.id, Object.assign(state.keys.get(USER.id) || {}, j)); res.writeHead(204); return res.end(); }
    }
    if (p === '/rest/v1/jn_entries') {
      if (req.method === 'GET') {
        const gt = +(u.searchParams.get('synced_at') || 'gt.0').slice(3), limit = +u.searchParams.get('limit') || 200;
        const rows = [...state.entries.values()].filter(r => r.synced_at > gt).sort((a, b) => a.synced_at - b.synced_at).slice(0, limit);
        return json(res, 200, rows);
      }
      if (req.method === 'POST') { const j = JSON.parse(body.toString()); j.synced_at = ++state.stamp; state.entries.set(j.id, j); return json(res, 201, [j]); }
    }
    if (p.startsWith('/storage/v1/object/jn/')) {
      const name = decodeURIComponent(p.slice('/storage/v1/object/jn/'.length));
      if (req.method === 'POST') { state.objects.set(name, body); return json(res, 200, { Key: 'jn/' + name }); }
      if (req.method === 'GET') { const b = state.objects.get(name); if (!b) return json(res, 404, { error: 'not found' }); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(b); }
    }
    if (p === '/storage/v1/object/jn' && req.method === 'DELETE') { const j = JSON.parse(body.toString()); for (const n of j.prefixes || []) state.objects.delete(n); return json(res, 200, []); }
    if (p === '/functions/v1/transcribe') {
      state.txCalls++;
      if (state.txFailNext > 0) { state.txFailNext--; return json(res, 502, { error: 'provider down (mock)' }); }
      const ct = req.headers['content-type'] || '', m = /boundary=(.+)$/.exec(ct); const sizeOf = body.length;
      const prompt = /name="prompt"\r\n\r\n([^\r]*)/.exec(body.toString('latin1')); const lang = /name="language"\r\n\r\n([^\r]*)/.exec(body.toString('latin1'));
      return json(res, 200, { text: 'Mock transcript ' + state.txCalls + ' (' + sizeOf + ' bytes' + (prompt ? ', prompt: ' + prompt[1].slice(0, 30) : '') + (lang ? ', lang ' + lang[1] : '') + ').', language: lang ? lang[1] : 'de' });
    }
    return json(res, 404, { error: 'mock: no route ' + req.method + ' ' + p });
  }
  // static
  let f = p === '/' ? '/index.html' : p;
  if (f === '/config.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end("window.APP_CONFIG = { supabaseUrl: 'http://localhost:" + PORT + "', supabaseKey: 'sb_publishable_test' };"); }
  const fp = path.join(ROOT, f);
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' }); fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log('mock on', PORT));
