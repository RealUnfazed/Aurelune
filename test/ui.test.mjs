import { JSDOM } from 'jsdom';
const SCENARIO = process.argv[2];
const MB = 1024 * 1024;
const OPTS = {
  selfhosted: { drivers: ['local', 'postfile'], default: 'local', serverless: false, chunked: false, max_mb: 50 },
  'vercel-chunked': { drivers: ['postfile'], default: 'postfile', serverless: true, chunked: true, chunk_bytes: 3 * 1048576, max_mb: 50 },
  'vercel-parts': { drivers: ['postfile'], default: 'postfile', serverless: true, chunked: true, chunk_bytes: 3 * 1048576, max_mb: 600, part_bytes: 6 * 1048576, postfile_keys: 3 },
  'vercel-nochunk': { drivers: ['postfile'], default: 'postfile', serverless: true, chunked: false, max_mb: 50 },
  'no-storage': { drivers: [], default: null, serverless: true, chunked: false, max_mb: 50 },
}[SCENARIO];

const dom = new JSDOM('<!doctype html><body><div id="app"><div id="view"></div></div></body>', { url: 'http://localhost/' });
const { window } = dom;
for (const k of ['window', 'document', 'localStorage', 'FormData', 'File', 'Blob', 'HTMLElement', 'location', 'history']) {
  try { Object.defineProperty(globalThis, k, { value: k === 'window' ? window : window[k], configurable: true, writable: true }); } catch {}
}
window.URL.createObjectURL = () => 'blob:fake'; window.URL.revokeObjectURL = () => {};
globalThis.URL.createObjectURL = () => 'blob:fake'; globalThis.URL.revokeObjectURL = () => {};

class FakeAudio { // stands in for <audio>: reports a 187s duration as soon as a src is set
  constructor() { this.l = {}; this.paused = true; this.volume = 1; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  removeAttribute() {} pause() {} play() { return Promise.resolve(); }
  set src(v) { this._src = v; queueMicrotask(() => { this.duration = 187; this.onloadedmetadata?.(); }); }
  get src() { return this._src; }
}
globalThis.Audio = FakeAudio;
const calls = [];
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e));
window.addEventListener('error', (e) => errors.push(e.error || e.message));
const dashboard = { creator: { id: 'c1', name: 'Test Artist', slug: 'test', status: 'approved', focus: 'both', bio: '', image: '/i.svg', links: [] },
  stats: { followers: 0, total_plays: 0, plays_30d: 0, listeners_30d: 0, minutes_30d: 0, by_day: [] },
  tracks: [{ id: 't1', title: 'Existing', album: null, plays: 5, published: true, storage: 'postfile', cover: '/c.svg' }],
  albums: [], shows: [{ id: 's1', title: 'My Show', episode_count: 0, cover: '/c.svg' }], episodes: [] };
let failChunk = null, failStatus = 502, failFlush = null;
const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
globalThis.fetch = async (url, o = {}) => {
  const path = String(url).replace('/api/v1', ''); const method = o.method || 'GET';
  const rec = { method, path, raw: o.body instanceof window.Blob && !(o.body instanceof window.FormData) ? o.body.size : undefined, ctype: o.headers?.['Content-Type'], body: o.body instanceof window.Blob ? null : o.body instanceof window.FormData ? Object.fromEntries([...o.body.entries()].map(([k, v]) => [k, v instanceof window.File ? `<File ${v.name}>` : v])) : (o.body ? JSON.parse(o.body) : null) };
  calls.push(rec);
  if (path === '/studio' && method === 'GET') return reply(dashboard);
  if (path === '/studio/storage-options') return reply(OPTS);
  if (method === 'PUT' && /^\/studio\/chunks\/[a-f0-9]{32}\/\d+$/.test(path)) return failChunk && failChunk(path) ? reply({ error: { message: 'boom' } }, failStatus) : reply({ ok: true });
  if (method === 'POST' && /^\/studio\/uploads\/[a-f0-9]{32}\/parts\/\d+$/.test(path)) return failFlush && failFlush(path) ? reply({ error: { message: 'host busy' } }, failStatus) : reply({ ok: true });
  if (/^\/studio\/shows\/s1\/episodes$/.test(path)) return reply({ episode: { id: 'e' } }, 201);
  return reply({ ok: true, track: { id: 'new' }, album: { id: 'a' }, show: { id: 's' }, creator: dashboard.creator }, 201);
};

const { Views } = await import(new URL('../public/js/views.js', import.meta.url).href);
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const $ = (s, r = document) => r.querySelector(s);
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent);
let pass = 0, fail = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); };
const setFile = (input, file) => { Object.defineProperty(input, 'files', { value: [file], configurable: true }); input.dispatchEvent(new window.Event('change', { bubbles: true })); };
const mkFile = (name, type, size) => { const f = new window.File([new Uint8Array(Math.min(size, 64))], name, { type }); Object.defineProperty(f, 'size', { value: size }); return f; };
const posts = (p) => calls.filter((c) => c.method !== 'GET' && c.path === p);
const reset = async () => { calls.length = 0; errors.length = 0; document.querySelectorAll('.modal-backdrop,.toast-stack').forEach((e) => e.remove()); await Views.studio($('#view')); };
const openTab = async (t) => { $(`[data-tab="${t}"]`).click(); await tick(); };

console.log(`== scenario: ${SCENARIO} ==`);
const root = $('#view');

/* ---- track upload ---- */
await reset(); await openTab('tracks');
$('#upload-track').click(); await tick();
const slotText = $('#tf-storage-slot').textContent;
check('storage slot rendered', slotText.length > 0, true);
if (SCENARIO === 'no-storage') check('no-storage shows the setup callout', /aren.t set up/.test(slotText), true);
if (SCENARIO === 'selfhosted') check('picker offers both drivers', [...$('#tf-storage-slot select').options].map((o) => o.value), ['local', 'postfile']);
if (SCENARIO === 'vercel-chunked') check('single driver: no picker, note shown', [!!$('#tf-storage-slot select'), /PostFile/.test(slotText)], [false, true]);

if (SCENARIO === 'selfhosted') {
  $('#tf-storage-slot select').value = 'postfile'; $('#tf-storage-slot select').dispatchEvent(new window.Event('change'));
  setFile($('#tf-audio'), mkFile('song.mp3', 'audio/mpeg', 3 * MB)); $('#tf-title').value = 'My Song'; await tick();
  check('note switches to the PostFile warning', /anyone who has a file/i.test($('#tf-storage-slot').textContent), true);
  $('#tf-save').click(); await tick(100);
  check('proxy upload POSTed with storage=postfile', [posts('/studio/tracks').length, posts('/studio/tracks')[0]?.body?.storage, posts('/studio/tracks')[0]?.body?.title], [1, 'postfile', 'My Song']);
  check('audio file included', posts('/studio/tracks')[0]?.body?.audio, '<File song.mp3>');
  check('no unhandled errors', errors.length, 0);
}
if (SCENARIO === 'vercel-chunked') {
  setFile($('#tf-audio'), mkFile('big.mp3', 'audio/mpeg', 7 * MB)); $('#tf-title').value = 'Big One'; await tick();
  check('route hint explains the piecewise upload', /3 pieces/.test($('#tf-route-hint').textContent), true);
  $('#tf-save').click(); await tick(200);
  const puts = calls.filter((c) => c.method === 'PUT');
  const ids = new Set(puts.map((c) => c.path.split('/')[3]));
  check('sent 3 pieces in order to one upload id', [puts.map((c) => c.path.split('/')[4]), ids.size], [['0', '1', '2'], 1]);
  check('pieces sent as raw octet-stream', puts.every((c) => c.ctype === 'application/octet-stream' && typeof c.raw === 'number'), true);
  const fin = posts('/studio/tracks')[0]?.body;
  check('final form carries the upload id, count, name, title — and no audio file', [fin?.upload_id === [...ids][0], fin?.chunk_count, fin?.filename, fin?.title, fin?.audio], [true, '3', 'big.mp3', 'Big One', undefined]);
  check('pieces come before the form', calls.filter((c) => c.path.startsWith('/studio/') && c.path !== '/studio/storage-options').map((c) => c.method), ['PUT', 'PUT', 'PUT', 'POST']);
  check('no unhandled errors', errors.length, 0);

  // a flaky network: one piece fails twice with 502, then succeeds — the upload must still finish
  await reset(); await openTab('tracks'); $('#upload-track').click(); await tick();
  let n = 0; failChunk = (p) => p.endsWith('/1') && n++ < 2; failStatus = 502;
  setFile($('#tf-audio'), mkFile('flaky.mp3', 'audio/mpeg', 7 * MB)); await tick();
  $('#tf-save').click(); await tick(4000);
  check('retries a failed piece and still finishes', [calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/1')).length, posts('/studio/tracks').length], [3, 1]);

  // a refusal (403) must NOT be retried, and must stop the upload with a clear message
  await reset(); await openTab('tracks'); $('#upload-track').click(); await tick();
  failChunk = (p) => p.endsWith('/0'); failStatus = 403;
  setFile($('#tf-audio'), mkFile('nope.mp3', 'audio/mpeg', 7 * MB)); await tick();
  $('#tf-save').click(); await tick(300);
  check('403 is not retried; form never sent; user told', [calls.filter((c) => c.method === 'PUT').length, posts('/studio/tracks').length, toasts().some((t) => /piece 1 of 3/.test(t))], [1, 0, true]);
  failChunk = null;

  await reset(); await openTab('tracks'); $('#upload-track').click(); await tick();
  setFile($('#tf-audio'), mkFile('small.mp3', 'audio/mpeg', 1 * MB)); await tick();
  check('small file: no piecewise hint', $('#tf-route-hint').textContent, '');
  $('#tf-save').click(); await tick(100);
  check('small file goes through the server in one request', [posts('/studio/tracks').length, calls.filter((c) => c.method === 'PUT').length, posts('/studio/tracks')[0]?.body?.audio], [1, 0, '<File small.mp3>']);
}
if (SCENARIO === 'vercel-parts') {
  // 14 MB with 3 MB pieces = 5 pieces; 6 MB parts = 2 pieces each -> 3 parts (2 + 2 + 1)
  setFile($('#tf-audio'), mkFile('podcast.mp3', 'audio/mpeg', 14 * MB)); $('#tf-title').value = 'Long One'; await tick();
  check('route hint says it will be split into parts', /split into 3 parts/.test($('#tf-route-hint').textContent), true);
  check('not blocked although over the old 50 MB-style cap rules', $('#tf-route-hint').style.color !== 'var(--pink)', true);
  $('#tf-save').click(); await tick(300);
  const seq = calls.filter((c) => c.path.startsWith('/studio/') && c.path !== '/studio/storage-options').map((c) => (c.method === 'PUT' ? 'put' + c.path.split('/')[4] : c.path.includes('/parts/') ? 'part' + c.path.split('/')[5] : 'create'));
  check('pieces and parts interleave: each part is handed over as soon as its pieces are in', seq, ['put0', 'put1', 'part0', 'put2', 'put3', 'part1', 'put4', 'part2', 'create']);
  const parts = calls.filter((c) => c.path.includes('/parts/'));
  check('part requests describe their pieces', parts.map((c) => [c.body.first_chunk, c.body.chunk_count]), [[0, 2], [2, 2], [4, 1]]);
  check('part requests carry file name, size and the browser-measured duration', [parts[0].body.filename, parts[0].body.total_size, parts[0].body.duration_ms], ['podcast.mp3', 14 * MB, 187000]);
  const fin = posts('/studio/tracks')[0]?.body;
  check('final form points at the session and carries no audio or piece count', [fin?.upload_session === calls.find((c) => c.method === 'PUT').path.split('/')[3], fin?.filename, fin?.title, fin?.audio, fin?.upload_id], [true, 'podcast.mp3', 'Long One', undefined, undefined]);
  check('no unhandled errors', errors.length, 0);

  // a part that PostFile cannot take right now (502) is retried; the pieces are not resent
  await reset(); await openTab('tracks'); $('#upload-track').click(); await tick();
  let k = 0; failFlush = (p) => p.endsWith('/parts/1') && k++ < 1; failStatus = 502;
  setFile($('#tf-audio'), mkFile('retry.mp3', 'audio/mpeg', 14 * MB)); await tick();
  $('#tf-save').click(); await tick(2500);
  check('a failed part hand-over is retried without resending pieces', [calls.filter((c) => c.path.endsWith('/parts/1')).length, calls.filter((c) => c.method === 'PUT').length, posts('/studio/tracks').length], [2, 5, 1]);

  // a refusal (storage quota, 409) stops the upload and says which part
  await reset(); await openTab('tracks'); $('#upload-track').click(); await tick();
  failFlush = (p) => p.endsWith('/parts/0'); failStatus = 403;
  setFile($('#tf-audio'), mkFile('nope.mp3', 'audio/mpeg', 14 * MB)); await tick();
  $('#tf-save').click(); await tick(400);
  check('a 403 on a part is not retried and nothing is created', [calls.filter((c) => c.path.endsWith('/parts/0')).length, posts('/studio/tracks').length, toasts().some((t) => /part 1 of 3/.test(t))], [1, 0, true]);
  failFlush = null;

  // one-part files keep the simple route
  await reset(); await openTab('tracks'); $('#upload-track').click(); await tick();
  setFile($('#tf-audio'), mkFile('mid.mp3', 'audio/mpeg', 5 * MB)); await tick();
  check('a file that fits one part uses plain pieces', /2 pieces/.test($('#tf-route-hint').textContent), true);
  // way over the limit is refused up front
  setFile($('#tf-audio'), mkFile('huge.mp3', 'audio/mpeg', 700 * MB)); await tick();
  check('over max_mb is blocked up front', /over the 600 MB limit/.test($('#tf-route-hint').textContent), true);
}
if (SCENARIO === 'vercel-nochunk') {
  setFile($('#tf-audio'), mkFile('big.mp3', 'audio/mpeg', 5 * MB)); await tick();
  check('hint explains the file cannot be uploaded', /too large to send through this server/.test($('#tf-route-hint').textContent), true);
  $('#tf-save').click(); await tick(100);
  check('nothing was sent', [posts('/studio/tracks').length, calls.filter((c) => c.method === 'PUT').length], [0, 0]);
  check('user told why', toasts().some((t) => /too large/.test(t)), true);
  check('button re-enabled for another try', $('#tf-save').disabled, false);
}
if (SCENARIO === 'no-storage') {
  setFile($('#tf-audio'), mkFile('a.mp3', 'audio/mpeg', 1 * MB)); $('#tf-save').click(); await tick(100);
  check('upload refused with a clear message, nothing sent', [posts('/studio/tracks').length, toasts().some((t) => /aren.t set up/.test(t))], [0, true]);
}

/* ---- covers (album / show / profile) ---- */
const covers = [
  ['album', 'albums', '#new-album', '#af-cover', '#af-title', '#af-save', '/studio/albums'],
  ['show', 'shows', '#new-show', '#sf-cover', '#sf-title', '#sf-save', '/studio/shows'],
];
for (const [name, tab, openBtn, fileSel, titleSel, saveSel, path] of covers) {
  if (SCENARIO === 'no-storage') break;
  await reset(); await openTab(tab); $(openBtn).click(); await tick();
  check(`${name}: storage slot hidden until a cover is chosen`, $(`#${fileSel.slice(1).replace('cover', 'storage-slot')}`).style.display, 'none');
  setFile($(fileSel), mkFile('cover.png', 'image/png', 1 * MB)); $(titleSel).value = `New ${name}`; await tick();
  check(`${name}: slot appears once a cover is chosen`, $(`#${fileSel.slice(1).replace('cover', 'storage-slot')}`).style.display, '');
  $(saveSel).click(); await tick(100);
  check(`${name}: saved with cover + storage`, [posts(path).length, posts(path)[0]?.body?.cover, posts(path)[0]?.body?.storage], [1, '<File cover.png>', OPTS.default]);
  check(`${name}: no unhandled errors`, errors.length, 0);
  if (OPTS.serverless) {
    await reset(); await openTab(tab); $(openBtn).click(); await tick();
    setFile($(fileSel), mkFile('huge.png', 'image/png', 5 * MB)); $(titleSel).value = 'x'; await tick();
    $(saveSel).click(); await tick(100);
    check(`${name}: >4MB image blocked before upload on a size-capped host`, [posts(path).length, toasts().some((t) => /Images over 4 MB/.test(t))], [0, true]);
  }
}
if (SCENARIO !== 'no-storage') {
  await reset(); await openTab('profile');
  setFile($('#pf-image'), mkFile('me.png', 'image/png', 1 * MB)); await tick();
  $('#pf-save').click(); await tick(100);
  check('profile: saved with image + storage', [calls.filter((c) => c.method === 'PATCH' && c.path === '/studio/profile').length, calls.find((c) => c.path === '/studio/profile')?.body?.storage], [1, OPTS.default]);
  check('profile: no unhandled errors', errors.length, 0);

  /* ---- episode ---- */
  await reset(); await openTab('shows'); $('[data-add-ep]').click(); await tick();
  setFile($('#ef-audio'), mkFile('ep.mp3', 'audio/mpeg', (SCENARIO === 'vercel-chunked' ? 7 : 2) * MB)); $('#ef-title').value = 'Ep One'; await tick();
  $('#ef-save').click(); await tick(150);
  if (SCENARIO === 'vercel-chunked') check('episode: large file sent in pieces, then the form', [calls.filter((c) => c.method === 'PUT').length, posts('/studio/shows/s1/episodes')[0]?.body?.chunk_count, posts('/studio/shows/s1/episodes')[0]?.body?.audio], [3, '3', undefined]);
  else check('episode: proxy upload with storage', [posts('/studio/shows/s1/episodes').length, posts('/studio/shows/s1/episodes')[0]?.body?.storage], [1, OPTS.default]);
  check('episode: no unhandled errors', errors.length, 0);
}

console.log(`\nRESULT [${SCENARIO}]: ${pass} passed, ${fail} failed`);
if (errors.length) console.log('UNHANDLED ERRORS:', errors.map((e) => String(e?.message || e)));
process.exit(fail ? 1 : 0);
