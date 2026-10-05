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

// ---------- rotation ----------
await ctl({ reset: true });
const small = wav(300000);
const ids = [];
for (let i = 0; i < 6; i++) { const r = await upload('rot' + i + rid, small); ck('small upload ' + i + ' ok', r.s === 201, r); ids.push(r.j.track?.id); }
let st = await stats();
ck('rotation: every key took uploads', ['k1', 'k2', 'k3'].every((k) => st.uploads[k] >= 1), st.uploads);
ck('rotation: spread evenly (2 each)', ['k1', 'k2', 'k3'].every((k) => st.uploads[k] === 2), st.uploads);
// single-file redirect + proxy
const rs = await owner.raw('/stream/track/' + ids[0]); ck('single part: 302 to CDN', rs.status === 302 && rs.headers.get('location').startsWith(FP + '/cdn/'), rs.status);
const px = await owner.raw('/stream/track/' + ids[0] + '?proxy=1'); const pb = Buffer.from(await px.arrayBuffer());
ck('?proxy=1: same bytes, 200, no redirect', px.status === 200 && sha(pb) === sha(small), px.status);
const px2 = await owner.raw('/stream/track/' + ids[0] + '?proxy=1', { range: 'bytes=1000-1999' }); const pb2 = Buffer.from(await px2.arrayBuffer());
ck('?proxy=1: ranges work (206)', px2.status === 206 && pb2.equals(small.subarray(1000, 2000)) && /bytes 1000-1999\/300000/.test(px2.headers.get('content-range')), [px2.status, px2.headers.get('content-range')]);
const dto = (await owner.get('/tracks/' + ids[0])).j.track; ck('dto: single postfile file is external', dto.external === true);

// ---------- failover ----------
await ctl({ reset: true, key: 'k1', mode: 'quota' });
let okAll = true; for (let i = 0; i < 4; i++) { const r = await upload('fo' + i + rid, small); okAll &&= r.s === 201; }
st = await stats();
ck('failover: uploads succeed with k1 out of quota', okAll, st.uploads);
ck('failover: k1 tried at most once, then rested', st.uploads.k1 <= 1, st.uploads);
await ctl({ reset: true });

// ---------- big file, one request (server splits) ----------
const big = wav(20 * 1048576 + 12345);
const t0 = await stats();
const bigR = await upload('BigDirect' + rid, big, 'big.wav');
ck('big direct upload ok', bigR.s === 201, bigR);
const bigId = bigR.j.track.id;
const st1 = await stats();
const newFiles = st1.files - t0.files;
ck('big: 4 parts created (20MB / 6MB)', newFiles === 4, newFiles);
ck('big: parts spread over more than one key', Object.keys(st1.uploads).length >= 2, st1.uploads);
ck('big dto: not external (served by us)', bigR.j.track.external === false, bigR.j.track.external);
const full = await owner.raw('/stream/track/' + bigId);
const fb = Buffer.from(await full.arrayBuffer());
ck('big: full stream = original bytes', full.status === 200 && fb.length === big.length && sha(fb) === sha(big), [full.status, fb.length, big.length]);
ck('big: Accept-Ranges + length headers', full.headers.get('accept-ranges') === 'bytes' && Number(full.headers.get('content-length')) === big.length);
const PB = 6 * 1048576;
const ranges = [[0, 99], [PB - 50, PB + 50], [PB * 2 - 1, PB * 2], [PB * 3 + 10, big.length - 1], [big.length - 100, big.length - 1], [5000000, 17000000]];
for (const [a, b] of ranges) {
  const r = await owner.raw('/stream/track/' + bigId, { range: `bytes=${a}-${b}` }); const bb = Buffer.from(await r.arrayBuffer());
  ck(`big: range ${a}-${b}`, r.status === 206 && bb.equals(big.subarray(a, b + 1)) && r.headers.get('content-range') === `bytes ${a}-${b}/${big.length}`, [r.status, bb.length, r.headers.get('content-range')]);
}
const open = await owner.raw('/stream/track/' + bigId, { range: `bytes=${PB + 7}-` }); const ob = Buffer.from(await open.arrayBuffer());
ck('big: open-ended range', open.status === 206 && ob.equals(big.subarray(PB + 7)), [open.status, ob.length]);
const suf = await owner.raw('/stream/track/' + bigId, { range: 'bytes=-1000' }); const sb = Buffer.from(await suf.arrayBuffer());
ck('big: suffix range', suf.status === 206 && sb.equals(big.subarray(big.length - 1000)), suf.status);
const bad = await owner.raw('/stream/track/' + bigId, { range: `bytes=${big.length + 5}-` }); ck('big: out-of-range -> 416', bad.status === 416, bad.status);
// flaky CDN: first part fetch fails once, still plays
await ctl({ cdnFail: 1 });
const fl = await owner.raw('/stream/track/' + bigId, { range: `bytes=100-199` }); const flb = Buffer.from(await fl.arrayBuffer());
ck('big: survives a CDN hiccup (retry)', fl.status === 206 && flb.equals(big.subarray(100, 200)), [fl.status, flb.length]);
// CDN that ignores Range
await ctl({ ignoreRange: true });
const ig = await owner.raw('/stream/track/' + bigId, { range: `bytes=${PB - 10}-${PB + 10}` }); const igb = Buffer.from(await ig.arrayBuffer());
ck('big: CDN ignoring Range still gives right bytes', ig.status === 206 && igb.equals(big.subarray(PB - 10, PB + 11)), [ig.status, igb.length]);
await ctl({ ignoreRange: false });
// other users can't stream without login
const anon = new Cli(); ck('big: anon cannot stream', (await anon.raw('/stream/track/' + bigId)).status === 401);

// ---------- part-by-part session (how the browser does it on Vercel) ----------
const bigS = wav(15 * 1048576 + 777);
const uid = crypto.randomBytes(16).toString('hex'); const CH = opts.chunk_bytes; const chunks = Math.ceil(bigS.length / CH); const per = opts.part_bytes / CH; const nparts = Math.ceil(chunks / per);
const sessStart = await stats();
for (let n = 0; n < nparts; n++) {
  const first = n * per, last = Math.min(chunks, first + per);
  for (let i = first; i < last; i++) { const r = await owner.req('PUT', `/studio/chunks/${uid}/${i}`, bigS.subarray(i * CH, Math.min(bigS.length, (i + 1) * CH)), { headers: { 'content-type': 'application/octet-stream' } }); if (r.s !== 200) ck('chunk put ' + i, false, r); }
  const fr = await owner.req('POST', `/studio/uploads/${uid}/parts/${n}`, { first_chunk: first, chunk_count: last - first, filename: 'sess.wav', total_size: bigS.length, duration_ms: 333000 });
  ck(`session: part ${n + 1}/${nparts} accepted`, fr.s === 200, fr);
  if (n === 0) { const again = await owner.req('POST', `/studio/uploads/${uid}/parts/${n}`, { first_chunk: first, chunk_count: last - first, filename: 'sess.wav', total_size: bigS.length }); ck('session: retrying a finished part is harmless', again.s === 200, again); }
}
const sa = await stats(); ck('session: exactly one remote file per part', sa.files - sessStart.files === nparts, sa.files - sessStart.files);
const fd = new FormData(); fd.append('upload_session', uid); fd.append('filename', 'sess.wav'); fd.append('title', 'Session' + rid); fd.append('storage', 'postfile');
const sr = await owner.req('POST', '/studio/tracks', fd);
ck('session: track created', sr.s === 201, sr);
const sid = sr.j.track?.id;
ck('session: client-measured duration used', sr.j.track?.duration_ms === 333000, sr.j.track?.duration_ms);
const sf = await owner.raw('/stream/track/' + sid); const sfb = Buffer.from(await sf.arrayBuffer());
ck('session: stream = original', sf.status === 200 && sha(sfb) === sha(bigS), [sf.status, sfb.length, bigS.length]);
const again2 = await owner.req('POST', '/studio/tracks', (() => { const f = new FormData(); f.append('upload_session', uid); f.append('filename', 'sess.wav'); f.append('storage', 'postfile'); return f; })());
ck('session: cannot be reused after the track is made', again2.s === 400, again2.s);
// incomplete session -> clear error
const uid2 = crypto.randomBytes(16).toString('hex');
const inc = await owner.req('POST', `/studio/uploads/${uid2}/parts/0`, { first_chunk: 0, chunk_count: 2, filename: 'x.wav', total_size: bigS.length });
ck('session: part with missing pieces -> incomplete_upload', inc.s === 400 && inc.j.error.code === 'incomplete_upload', inc);
const fd3 = new FormData(); fd3.append('upload_session', uid2); fd3.append('filename', 'x.wav'); fd3.append('storage', 'postfile');
ck('session: unknown session -> 400', (await owner.req('POST', '/studio/tracks', fd3)).s === 400);
// someone else's session
const other = await mk('po' + rid); const r1 = await other.req('POST', '/studio/request', { name: 'Otherband' + rid, focus: 'both' }); await admin.req('POST', `/admin/creators/${r1.j.creator.id}/approve`, {});
const uid4 = crypto.randomBytes(16).toString('hex');
for (let i = 0; i < 2; i++) await owner.req('PUT', `/studio/chunks/${uid4}/${i}`, bigS.subarray(i * CH, (i + 1) * CH), { headers: { 'content-type': 'application/octet-stream' } });
await owner.req('POST', `/studio/uploads/${uid4}/parts/0`, { first_chunk: 0, chunk_count: 2, filename: 'sess.wav', total_size: bigS.length });
const steal = await other.req('POST', `/studio/uploads/${uid4}/parts/1`, { first_chunk: 2, chunk_count: 2, filename: 'sess.wav', total_size: bigS.length });
ck('session: another creator cannot touch it', steal.s === 403, steal);

// failed create after parts are up -> parts removed
const uid3 = crypto.randomBytes(16).toString('hex'); const mid = wav(7 * 1048576); const per3 = per; const ch3 = Math.ceil(mid.length / CH); const np3 = Math.ceil(ch3 / per3);
for (let n = 0; n < np3; n++) { const first = n * per3, last = Math.min(ch3, first + per3); for (let i = first; i < last; i++) await owner.req('PUT', `/studio/chunks/${uid3}/${i}`, mid.subarray(i * CH, Math.min(mid.length, (i + 1) * CH)), { headers: { 'content-type': 'application/octet-stream' } }); await owner.req('POST', `/studio/uploads/${uid3}/parts/${n}`, { first_chunk: first, chunk_count: last - first, filename: 'm.wav', total_size: mid.length }); }
const before = (await stats()).files;
const fd4 = new FormData(); fd4.append('upload_session', uid3); fd4.append('filename', 'm.wav'); fd4.append('storage', 'local'); // wrong storage -> create refuses
const fr4 = await owner.req('POST', '/studio/tracks', fd4);
await new Promise((r) => setTimeout(r, 600));
ck('failed create: refused', fr4.s === 400, fr4);
ck('failed create: its parts were removed from PostFile', (await stats()).files === before - np3, [before, (await stats()).files]);

// ---------- episode with parts via direct upload ----------
const sh = await owner.req('POST', '/studio/shows', (() => { const f = new FormData(); f.append('title', 'Longcast' + rid); f.append('category', 'x'); return f; })());
const showId = sh.j.show.id; const epBytes = wav(13 * 1048576);
const fe = new FormData(); fe.append('audio', new Blob([epBytes], { type: 'audio/wav' }), 'e.wav'); fe.append('title', 'LongEp' + rid); fe.append('storage', 'postfile');
const er = await owner.req('POST', `/studio/shows/${showId}/episodes`, fe); ck('episode: big upload ok', er.s === 201, er);
const ef = await owner.raw('/stream/episode/' + er.j.episode.id); const efb = Buffer.from(await ef.arrayBuffer());
ck('episode: stitched stream = original', ef.status === 200 && sha(efb) === sha(epBytes), [ef.status, efb.length]);

// ---------- deletes go to the right accounts ----------
const beforeDel = await stats();
const del = await owner.req('DELETE', '/studio/tracks/' + bigId); ck('delete big track', del.s === 200, del);
await new Promise((r) => setTimeout(r, 800));
const afterDel = await stats();
ck('delete: all 4 parts removed remotely', beforeDel.files - afterDel.files === 4, [beforeDel.files, afterDel.files]);
const del2 = await owner.req('DELETE', '/studio/shows/' + showId); ck('delete show with multi-part episode', del2.s === 200);
await new Promise((r) => setTimeout(r, 800));
ck('delete show: episode parts removed', afterDel.files - (await stats()).files === 3, [afterDel.files, (await stats()).files]);

// ---------- every key failing (last: this leaves the keys resting) ----------
await ctl({ reset: true, key: 'k1', mode: 'quota' });
await ctl({ key: 'k2', mode: 'auth' }); await ctl({ key: 'k3', mode: '429' });
const dead = await upload('dead' + rid, small);
ck('all keys failing: clean error, no crash', dead.s >= 400 && dead.j?.error?.message, dead);
await ctl({ reset: true });
// the pool rests failed keys for a while; the next uploads should still use whatever works (rested keys are last resort)
const back = await upload('back' + rid, small); ck('recovers when keys work again (rested keys are last resort)', back.s === 201, back);
await ctl({ reset: true });


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
