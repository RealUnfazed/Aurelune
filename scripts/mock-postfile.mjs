// A local stand-in for postfile.net, for developing/testing PostFile mode without a real key or quota.
//
//   node scripts/mock-postfile.mjs
//   POSTFILE_API_KEY=pf_mock_key POSTFILE_API_BASE=http://127.0.0.1:4010 npm start
//
// It implements upload, intake links, file lookup/delete and a CDN route, following https://postfile.net/docs
// as that page reads — so it checks Aurelune's code against the *documented* contract, NOT against the live
// service. Before relying on PostFile in production, do one real upload with a real key.
// (/__log and /__mode are test helpers: request history, and `?m=quota` to simulate a plan-limit error.)
import http from 'node:http';
const KEY = process.env.MOCK_KEY || 'pf_mock_key';
const files = new Map();      // file_id -> { name, type, bytes }
const log = [];               // request log for assertions
let mode = 'ok', n = 0;
const PORT = Number(process.env.MOCK_PORT || 4010);
const base = `http://127.0.0.1:${PORT}`;

function parseMultipart(buf, contentType) {
  const m = /boundary=(.+)$/.exec(contentType || '');
  if (!m) return null;
  const b = Buffer.from('--' + m[1]);
  const start = buf.indexOf(b);
  let pos = start;
  while (pos !== -1) {
    const next = buf.indexOf(b, pos + b.length);
    if (next === -1) break;
    const part = buf.subarray(pos + b.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString();
    if (/name="file"/.test(head)) {
      return { filename: /filename="([^"]*)"/.exec(head)?.[1], type: /Content-Type: (.+)/i.exec(head)?.[1]?.trim(), bytes: part.subarray(headEnd + 4) };
    }
    pos = next;
  }
  return null;
}

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
function saveFile(part) {
  const id = 'f' + (++n).toString().padStart(4, '0') + 'abcd';
  files.set(id, { name: part.filename, type: part.type, bytes: part.bytes });
  return { file_id: id, url: `${base}/cdn/${id}`, name: part.filename, size: part.bytes.length, content_type: part.type, expires_at: null };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const body = await readBody(req);
  log.push({ method: req.method, path: url.pathname, key: req.headers['x-api-key'] || null, ctype: req.headers['content-type'] || null });
  const authed = req.headers['x-api-key'] === KEY;

  if (url.pathname === '/__log') return json(res, 200, { log, files: [...files.keys()] });
  if (url.pathname === '/__mode') { mode = url.searchParams.get('m'); return json(res, 200, { mode }); }

  if (url.pathname.startsWith('/cdn/')) { // public CDN
    const f = files.get(url.pathname.slice(5));
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.type || 'application/octet-stream', 'content-length': f.bytes.length });
    return res.end(f.bytes);
  }
  if (url.pathname === '/v1/upload' && req.method === 'POST') {
    if (!authed) return json(res, 401, { detail: 'Invalid API key' });
    if (mode === 'quota') return json(res, 403, { detail: 'Monthly upload limit reached for your plan' });
    const part = parseMultipart(body, req.headers['content-type']);
    if (!part) return json(res, 422, { detail: 'Missing file field' });
    return json(res, 200, saveFile(part));
  }
  if (url.pathname === '/v1/intake-links' && req.method === 'POST') {
    if (!authed) return json(res, 401, { detail: 'Invalid API key' });
    const b = JSON.parse(body.toString() || '{}');
    log.at(-1).body = b;
    return json(res, 200, { intake_id: 'in1', token: 'tok123', upload_url: `${base}/u/tok123` });
  }
  if (url.pathname === '/v1/intake/tok123/upload' && req.method === 'POST') { // public, no key
    const part = parseMultipart(body, req.headers['content-type']);
    if (!part) return json(res, 422, { detail: 'Missing file field' });
    return json(res, 200, saveFile(part));
  }
  const m = /^\/v1\/files\/([^/]+)$/.exec(url.pathname);
  if (m) {
    if (!authed) return json(res, 401, { detail: 'Invalid API key' });
    const f = files.get(m[1]);
    if (!f) return json(res, 404, { detail: 'File not found' });
    if (req.method === 'DELETE') { files.delete(m[1]); return json(res, 200, { deleted: true, file_id: m[1] }); }
    return json(res, 200, { file_id: m[1], url: `${base}/cdn/${m[1]}`, name: f.name, size: f.bytes.length, content_type: f.type, expires_at: null });
  }
  json(res, 404, { detail: 'Not found' });
}).listen(PORT, () => console.log('MOCK UP'));
