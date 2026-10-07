import crypto from 'node:crypto';
const B = 'http://localhost:3000'; const A = B + '/api/v1'; const FP = 'http://127.0.0.1:4010';
let pass = 0, fail = 0;
const ck = (n, ok, x = '') => { ok ? pass++ : fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' ' + JSON.stringify(x))); };
class Cli { constructor() { this.c = ''; } async req(m, p, body, extra = {}) { const h = { cookie: this.c, ...(extra.headers || {}) }; let b; if (body instanceof FormData || Buffer.isBuffer(body)) b = body; else if (body) { h['content-type'] = 'application/json'; b = JSON.stringify(body); } const r = await fetch(A + p, { method: m, headers: h, body: b, redirect: 'manual' }); const sc = r.headers.getSetCookie?.() || []; if (sc.length) this.c = sc.map((s) => s.split(';')[0]).join('; '); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j }; } get(p) { return this.req('GET', p); } raw(p, headers = {}) { return fetch(A + p, { headers: { cookie: this.c, ...headers }, redirect: 'manual' }); } }
const ctl = (o) => fetch(FP + '/_ctl', { method: 'POST', body: JSON.stringify(o) }).then((r) => r.json());
const stats = () => fetch(FP + '/_stats').then((r) => r.json());
// WAV of ~N bytes: 22.05 kHz mono 16-bit, a quiet varying tone so every byte range is distinct
function wav(bytes) {
  const rate = 22050, n = Math.floor((bytes - 44) / 2); const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 9 + (i >> 12)) * 3000 + ((i * 2654435761) >>> 28) * 5), 44 + i * 2);
  return buf;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const rid = Math.random().toString(36).slice(2, 7);
const mk = async (u) => { const c = new Cli(); const r = await c.req('POST', '/auth/signup', { username: u, email: u + '@t.test', password: 'password123' }); if (r.s !== 201) throw new Error(JSON.stringify(r)); return c; };
const admin = new Cli(); let l = await admin.req('POST', '/auth/login', { login: 'admin@aurelune.local', password: 'aurelune-admin' }); if (l.s !== 200) l = await admin.req('POST', '/auth/login', { login: 'admin@aurelune.local', password: 'adminpass123' });
const owner = await mk('pf' + rid);
const r0 = await owner.req('POST', '/studio/request', { name: 'Partband' + rid, focus: 'both' }); await admin.req('POST', `/admin/creators/${r0.j.creator.id}/approve`, {});
const opts = (await owner.get('/studio/storage-options')).j;
ck('options: part_bytes is a whole number of chunks', opts.part_bytes % opts.chunk_bytes === 0 && opts.part_bytes === 6 * 1048576, opts);
ck('options: 3 keys, max_mb 600', opts.postfile_keys === 3 && opts.max_mb === 600, opts);
ck('options: postfile default', opts.default === 'postfile', opts);

const upload = async (title, bytes, name = 'a.wav') => { const fd = new FormData(); fd.append('audio', new Blob([bytes], { type: 'audio/wav' }), name); fd.append('title', title); fd.append('storage', 'postfile'); return owner.req('POST', '/studio/tracks', fd); };


// ---------- the file host IGNORES Range (sends the whole file every time) ----------
await ctl({ reset: true });
const song = wav(900000);
const up1 = await upload('seek' + rid, song); ck('upload ok', up1.s === 201, up1); const id = up1.j.track.id;
for (const ignore of [false, true]) {
  await ctl({ ignoreRange: ignore });
  const tag = ignore ? 'host ignores Range: ' : 'host honours Range: ';
  const u = '/stream/track/' + id + '?proxy=1';
  let r = await owner.raw(u, { range: 'bytes=300000-399999' }); let b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'mid range -> 206 with exactly those bytes', r.status === 206 && b.equals(song.subarray(300000, 400000)) && r.headers.get('content-range') === `bytes 300000-399999/${song.length}` && r.headers.get('content-length') === '100000', [r.status, r.headers.get('content-range'), b.length]);
  r = await owner.raw(u, { range: 'bytes=800000-' }); b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'open-ended range (what Chrome sends when you seek)', r.status === 206 && b.equals(song.subarray(800000)) && r.headers.get('content-range') === `bytes 800000-${song.length - 1}/${song.length}`, [r.status, r.headers.get('content-range'), b.length]);
  r = await owner.raw(u, { range: 'bytes=0-' }); b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'bytes=0- gives the whole file', (r.status === 206 || r.status === 200) && b.equals(song), [r.status, b.length]);
  r = await owner.raw(u, { range: 'bytes=-1000' }); b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'suffix range = last 1000 bytes', r.status === 206 && b.equals(song.subarray(song.length - 1000)), [r.status, b.length]);
  r = await owner.raw(u, { range: `bytes=${song.length + 5}-` });
  ck(tag + 'start past the end -> 416', r.status === 416, r.status); await r.arrayBuffer();
  r = await owner.raw(u, { range: `bytes=${song.length - 10}-${song.length + 9999}` }); b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'end past the end is clamped', r.status === 206 && b.length === 10, [r.status, b.length]);
  r = await owner.raw(u); ck(tag + 'no Range -> 200 whole file', r.status === 200 && sha(Buffer.from(await r.arrayBuffer())) === sha(song), r.status);
}
// ---------- the real CDN: ignores Range AND sends the whole file with no Content-Length (what a user's Playback test showed) ----------
await ctl({ ignoreRange: true, noLength: true });
{
  const u = '/stream/track/' + id + '?proxy=1', tag = 'CDN without Content-Length: ';
  let r = await owner.raw(u, { range: 'bytes=0-99' }); let b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'bytes=0-99 -> 206 + Content-Range + 100 bytes', r.status === 206 && b.length === 100 && r.headers.get('content-range') === `bytes 0-99/${song.length}` && b.equals(song.subarray(0, 100)), [r.status, r.headers.get('content-range'), b.length]);
  r = await owner.raw(u, { range: 'bytes=300000-300099' }); b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'bytes=300000-300099 -> exactly those bytes', r.status === 206 && b.equals(song.subarray(300000, 300100)) && r.headers.get('content-range') === `bytes 300000-300099/${song.length}`, [r.status, r.headers.get('content-range'), b.length]);
  r = await owner.raw(u, { range: 'bytes=800000-' }); b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'open-ended range', r.status === 206 && b.equals(song.subarray(800000)), [r.status, b.length]);
  r = await owner.raw(u); b = Buffer.from(await r.arrayBuffer());
  ck(tag + 'no Range -> 200 WITH Content-Length (so the browser knows the size and can seek)', r.status === 200 && r.headers.get('content-length') === String(song.length) && b.equals(song) && /bytes/.test(r.headers.get('accept-ranges') || ''), [r.status, r.headers.get('content-length'), b.length]);
}
await ctl({ ignoreRange: false, noLength: false });
// ---------- caching headers ----------
await ctl({ ignoreRange: false });
let r = await owner.raw('/stream/track/' + id + '?proxy=1', { range: 'bytes=0-99' }); await r.arrayBuffer();
const etag = r.headers.get('etag'), cc = r.headers.get('cache-control') || '';
ck('proxy: ETag + private max-age (the browser may keep it, shared caches may not)', !!etag && /private/.test(cc) && /max-age=\d{4,}/.test(cc) && !/no-store/.test(cc), [etag, cc]);
r = await owner.raw('/stream/track/' + id + '?proxy=1', { 'if-none-match': etag }); ck('proxy: If-None-Match -> 304 with no body', r.status === 304 && (await r.arrayBuffer()).byteLength === 0, r.status);
r = await owner.raw('/stream/track/' + id); ck('redirect is cacheable too (no extra round trip on replay)', r.status === 302 && /private, max-age=\d{3,}/.test(r.headers.get('cache-control') || ''), [r.status, r.headers.get('cache-control')]);
// an error must not be cached
await ctl({ cdnFail: 5 }); r = await owner.raw('/stream/track/' + id + '?proxy=1', { range: 'bytes=5-9' }); await r.arrayBuffer();
ck('proxy: host error -> 502 and not cacheable', r.status === 502 && !/max-age=\d{3,}/.test(r.headers.get('cache-control') || ''), [r.status, r.headers.get('cache-control')]); await ctl({ cdnFail: 0 });
// a stranger can't use the cache headers to reach a private track: the route still checks the login first
const anon = new Cli(); r = await anon.raw('/stream/track/' + id + '?proxy=1', { 'if-none-match': etag }); ck('not signed in -> 401, never 304', r.status === 401, r.status); await r.arrayBuffer();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
