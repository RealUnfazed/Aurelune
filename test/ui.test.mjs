import { JSDOM } from 'jsdom';
const SCENARIO = process.argv[2];
const MB = 1024 * 1024;
const OPTS = {
  selfhosted: { drivers: ['local', 'postfile'], default: 'local', serverless: false, direct_upload: true, max_mb: 50 },
  'vercel-direct': { drivers: ['postfile'], default: 'postfile', serverless: true, direct_upload: true, max_mb: 50 },
  'vercel-nodirect': { drivers: ['postfile'], default: 'postfile', serverless: true, direct_upload: false, max_mb: 50 },
  'no-storage': { drivers: [], default: null, serverless: true, direct_upload: false, max_mb: 50 },
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
const xhrPosts = [];
globalThis.XMLHttpRequest = class { // stands in for the browser->PostFile upload
  constructor() { this.upload = {}; }
  open(m, u) { this.m = m; this.u = u; }
  send(form) { xhrPosts.push({ url: this.u, fields: Object.fromEntries([...form.entries()].map(([k, v]) => [k, v instanceof window.File ? `<File ${v.name}>` : v])) });
    setTimeout(() => { this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 }); this.status = 200; this.responseText = JSON.stringify({ file_id: 'f1', url: 'https://cdn.example/f1' }); this.onload(); }, 5); }
};

const calls = [];
const errors = [];
process.on('unhandledRejection', (e) => errors.push(e));
window.addEventListener('error', (e) => errors.push(e.error || e.message));
const dashboard = { creator: { id: 'c1', name: 'Test Artist', slug: 'test', status: 'approved', focus: 'both', bio: '', image: '/i.svg', links: [] },
  stats: { followers: 0, total_plays: 0, plays_30d: 0, listeners_30d: 0, minutes_30d: 0, by_day: [] },
  tracks: [{ id: 't1', title: 'Existing', album: null, plays: 5, published: true, storage: 'postfile', cover: '/c.svg' }],
  albums: [], shows: [{ id: 's1', title: 'My Show', episode_count: 0, cover: '/c.svg' }], episodes: [] };
const reply = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
globalThis.fetch = async (url, o = {}) => {
  const path = String(url).replace('/api/v1', ''); const method = o.method || 'GET';
  const rec = { method, path, body: o.body instanceof window.FormData ? Object.fromEntries([...o.body.entries()].map(([k, v]) => [k, v instanceof window.File ? `<File ${v.name}>` : v])) : (o.body ? JSON.parse(o.body) : null) };
  calls.push(rec);
  if (path === '/studio' && method === 'GET') return reply(dashboard);
  if (path === '/studio/storage-options') return reply(OPTS);
  if (path === '/studio/intake-link') return reply({ upload_url: 'https://intake.example/v1/intake/tok/upload', max_mb: 50 });
  if (path === '/studio/tracks/from-remote') return reply({ track: { id: 'new' } }, 201);
  if (/^\/studio\/shows\/s1\/episodes(\/from-remote)?$/.test(path)) return reply({ episode: { id: 'e' } }, 201);
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
const reset = async () => { calls.length = 0; xhrPosts.length = 0; errors.length = 0; document.querySelectorAll('.modal-backdrop,.toast-stack').forEach((e) => e.remove()); await Views.studio($('#view')); };
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
if (SCENARIO === 'vercel-direct') check('single driver: no picker, note shown', [!!$('#tf-storage-slot select'), /PostFile/.test(slotText)], [false, true]);

if (SCENARIO === 'selfhosted') {
  $('#tf-storage-slot select').value = 'postfile'; $('#tf-storage-slot select').dispatchEvent(new window.Event('change'));
  setFile($('#tf-audio'), mkFile('song.mp3', 'audio/mpeg', 3 * MB)); $('#tf-title').value = 'My Song'; await tick();
  check('note switches to the PostFile warning', /anyone who has a file/i.test($('#tf-storage-slot').textContent), true);
  $('#tf-save').click(); await tick(100);
  check('proxy upload POSTed with storage=postfile', [posts('/studio/tracks').length, posts('/studio/tracks')[0]?.body?.storage, posts('/studio/tracks')[0]?.body?.title], [1, 'postfile', 'My Song']);
  check('audio file included', posts('/studio/tracks')[0]?.body?.audio, '<File song.mp3>');
  check('no unhandled errors', errors.length, 0);
}
if (SCENARIO === 'vercel-direct') {
  setFile($('#tf-audio'), mkFile('big.mp3', 'audio/mpeg', 5 * MB)); $('#tf-title').value = 'Big One'; await tick();
  check('route hint explains the direct upload', /straight to PostFile/.test($('#tf-route-hint').textContent), true);
  $('#tf-save').click(); await tick(150);
  check('browser posted the file straight to the intake URL', [xhrPosts.length, xhrPosts[0]?.url, xhrPosts[0]?.fields.file], [1, 'https://intake.example/v1/intake/tok/upload', '<File big.mp3>']);
  check('intake link requested before the upload', calls.map((c) => c.path).filter((p) => p.startsWith('/studio/') && p !== '/studio/storage-options'), ['/studio/intake-link', '/studio/tracks/from-remote']);
  const fin = posts('/studio/tracks/from-remote')[0]?.body;
  check('finalized with file_id, measured duration, typed title', [fin?.file_id, fin?.duration_ms, fin?.title], ['f1', 187000, 'Big One']);
  check('did NOT also send the bytes through the server', posts('/studio/tracks').length, 0);
  check('no unhandled errors', errors.length, 0);

  await reset(); await openTab('tracks'); $('#upload-track').click(); await tick();
  setFile($('#tf-audio'), mkFile('small.mp3', 'audio/mpeg', 1 * MB)); await tick();
  check('small file: no direct-upload hint', $('#tf-route-hint').textContent, '');
  $('#tf-save').click(); await tick(100);
  check('small file goes through the server (keeps tag extraction)', [posts('/studio/tracks').length, xhrPosts.length], [1, 0]);
}
if (SCENARIO === 'vercel-nodirect') {
  setFile($('#tf-audio'), mkFile('big.mp3', 'audio/mpeg', 5 * MB)); await tick();
  check('hint explains the file cannot be uploaded', /too large to send through this server/.test($('#tf-route-hint').textContent), true);
  $('#tf-save').click(); await tick(100);
  check('nothing was sent', [posts('/studio/tracks').length, xhrPosts.length, calls.filter((c) => c.path === '/studio/intake-link').length], [0, 0, 0]);
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
  setFile($('#ef-audio'), mkFile('ep.mp3', 'audio/mpeg', (SCENARIO === 'vercel-direct' ? 6 : 2) * MB)); $('#ef-title').value = 'Ep One'; await tick();
  $('#ef-save').click(); await tick(150);
  if (SCENARIO === 'vercel-direct') check('episode: large file went direct and was finalized', [xhrPosts.length, posts('/studio/shows/s1/episodes/from-remote')[0]?.body?.duration_ms], [1, 187000]);
  else check('episode: proxy upload with storage', [posts('/studio/shows/s1/episodes').length, posts('/studio/shows/s1/episodes')[0]?.body?.storage], [1, OPTS.default]);
  check('episode: no unhandled errors', errors.length, 0);
}

console.log(`\nRESULT [${SCENARIO}]: ${pass} passed, ${fail} failed`);
if (errors.length) console.log('UNHANDLED ERRORS:', errors.map((e) => String(e?.message || e)));
process.exit(fail ? 1 : 0);
