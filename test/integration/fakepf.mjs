// A stand-in for postfile.net: /v1/upload, DELETE /v1/files/:id, CDN GET with Range, and a control endpoint.
import http from 'node:http';
const files = new Map(); let seq = 0;
const KEYS = new Set((process.env.FAKE_KEYS || 'k1,k2,k3').split(','));
const mode = new Map(); // key -> 'ok' | 'quota' | 'auth' | '429' | 'down'
const uploads = {}; const deletes = {};
let slowKBps = 0;
// Sends a body at slowKBps (0 = as fast as possible), so a test can have audio that is NOT already fully buffered when the listener seeks.
function send(res, buf) {
  if (!slowKBps) return res.end(buf);
  const step = Math.max(1024, Math.floor(slowKBps * 1024 / 20)); let i = 0;
  const tick = () => { if (res.destroyed) return; if (i >= buf.length) return res.end(); res.write(buf.subarray(i, i + step)); i += step; setTimeout(tick, 50); };
  tick();
} let cdnHits = 0; let cors = false; let ignoreRange = false; let cdnFail = 0;
const PORT = Number(process.env.FAKE_PORT || 4010); const BASE = `http://127.0.0.1:${PORT}`;
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const json = (res, s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
http.createServer(async (req, res) => {
  const u = new URL(req.url, BASE);
  if (u.pathname === '/_ctl') { const b = JSON.parse((await readBody(req)).toString() || '{}'); if (b.reset) { mode.clear(); for (const k of Object.keys(uploads)) delete uploads[k]; for (const k of Object.keys(deletes)) delete deletes[k]; } if (b.key) mode.set(b.key, b.mode); if ('cors' in b) cors = b.cors; if ('ignoreRange' in b) ignoreRange = b.ignoreRange; if ('cdnFail' in b) cdnFail = b.cdnFail; if ('slowKBps' in b) slowKBps = b.slowKBps; return json(res, 200, { uploads, deletes, files: files.size }); }
  if (u.pathname === '/_stats') return json(res, 200, { cdnHits, uploads, deletes, files: files.size, sizes: [...files.values()].map((f) => f.bytes.length) });
  if (u.pathname.startsWith('/cdn/')) {
    if (cdnFail > 0) { cdnFail--; res.writeHead(503); return res.end(); }
    cdnHits++; const f = files.get(u.pathname.slice(5)); if (!f) { res.writeHead(404); return res.end(); }
    const h = { 'content-type': f.type || 'audio/mpeg', 'accept-ranges': 'bytes' }; if (cors) h['access-control-allow-origin'] = '*';
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (m && !ignoreRange && +m[1] >= f.bytes.length) { res.writeHead(416, { 'content-range': `bytes */${f.bytes.length}` }); return res.end(); }
    if (m && !ignoreRange) { const a = +m[1], b = m[2] ? Math.min(+m[2], f.bytes.length - 1) : f.bytes.length - 1; res.writeHead(206, { ...h, 'content-range': `bytes ${a}-${b}/${f.bytes.length}`, 'content-length': b - a + 1 }); return send(res, f.bytes.subarray(a, b + 1)); }
    res.writeHead(200, { ...h, 'content-length': f.bytes.length }); return send(res, f.bytes);
  }
  const key = req.headers['x-api-key'];
  if (!KEYS.has(key)) return json(res, 401, { detail: 'bad key' });
  const md = mode.get(key) || 'ok';
  if (u.pathname === '/v1/upload' && req.method === 'POST') {
    const body = await readBody(req);
    uploads[key] = (uploads[key] || 0) + 1;
    if (md === 'quota') return json(res, 403, { detail: 'monthly limit' });
    if (md === 'auth') return json(res, 401, { detail: 'revoked' });
    if (md === '429') return json(res, 429, { detail: 'slow down' });
    if (md === 'down') return json(res, 503, { detail: 'oops' });
    const ct = req.headers['content-type'] || ''; const boundary = ct.split('boundary=')[1];
    const raw = body; const sep = Buffer.from('--' + boundary);
    const start = raw.indexOf('\r\n\r\n') + 4; const end = raw.lastIndexOf(Buffer.concat([Buffer.from('\r\n'), sep]));
    const head = raw.subarray(0, start).toString(); const name = /filename="([^"]*)"/.exec(head)?.[1]; const type = /Content-Type: ([^\r\n]+)/i.exec(head)?.[1];
    const bytes = Buffer.from(raw.subarray(start, end));
    if (bytes.length > 50 * 1048576) return json(res, 413, { detail: 'too big' });
    const id = 'f' + (++seq); files.set(id, { bytes, key, name, type });
    return json(res, 200, { file_id: id, url: `${BASE}/cdn/${id}`, size: bytes.length, name, content_type: type });
  }
  const del = /^\/v1\/files\/(.+)$/.exec(u.pathname);
  if (del && req.method === 'DELETE') { const f = files.get(del[1]); if (!f || f.key !== key) return json(res, 404, { detail: 'nf' }); files.delete(del[1]); deletes[key] = (deletes[key] || 0) + 1; return json(res, 200, { ok: true }); }
  json(res, 404, { detail: 'nope' });
}).listen(PORT, '127.0.0.1', () => console.log('fakepf on', PORT));
