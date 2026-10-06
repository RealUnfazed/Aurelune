const calls = { wrapped: [], resumed: 0 };
class FakeAudio {
  constructor() { this.l = {}; this.paused = true; this.ended = false; this.currentTime = 0; this.volume = 1; this.id = FakeAudio.n++; this.pauses = 0; this.readyState = 0; this.crossOrigin = ''; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  fire(t) { (this.l[t] || []).forEach((f) => f()); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; this.pauses++; }
}
FakeAudio.n = 0;
globalThis.Audio = FakeAudio;
globalThis.window = { addEventListener() {}, AudioContext: class {
  constructor() { this.state = 'suspended'; this.destination = {}; }
  createMediaElementSource(el) { calls.wrapped.push(el.id); return { connect() {} }; }
  createBiquadFilter() { return { frequency: {}, Q: {}, gain: { value: 0 }, connect() {} }; }
  resume() { calls.resumed++; this.state = 'running'; return Promise.resolve(); }
} };
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } };
globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) });

const { player } = await import(new URL('../public/js/player.js', import.meta.url).href);
let pass = 0, fail = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); };

const L = (id) => ({ id, type: 'track', title: id, stream_url: '/s/' + id, external: false, duration_ms: 1e5 });
const X = (id) => ({ id, type: 'track', title: id, stream_url: '/s/' + id, external: true, duration_ms: 1e5 });
const local = player._elLocal, ext = player._elCors;
let changes = 0; player.addEventListener('change', () => changes++);

console.log('== a PostFile track FIRST: plays straight from the CDN with CORS, through the EQ graph ==');
check('cors element asks for CORS', ext.crossOrigin, 'anonymous');
player.playQueue([X('x1'), L('l1'), X('x2'), L('l2')], 0);
check('active element is the cors one', player.audio === ext, true);
check('EQ graph wraps it (equalizer works on PostFile tracks)', calls.wrapped, [ext.id]);
check('cors element got the plain stream url', ext.src, '/s/x1');

console.log('== switch to a local track ==');
player.next();
check('active element is now local', player.audio === local, true);
check('graph wraps the local element too, once each', calls.wrapped, [ext.id, local.id]);
check('cors element was paused', ext.paused, true);
check('audio context resumed', calls.resumed >= 1, true);

console.log('== back to PostFile, then local again ==');
player.next();
check('cors again', player.audio === ext, true);
player.next();
check('local again', player.audio === local, true);
check('elements are never wrapped twice', calls.wrapped.length, 2);

console.log('== CDN refuses CORS: fall back to the same track through this server, and remember it ==');
player.playQueue([X('x3'), X('x4'), L('l3')], 0);
check('x3 starts on the cors element', [player.audio === ext, ext.src], [true, '/s/x3']);
ext.readyState = 0; ext.currentTime = 12; ext.fire('error');
check('x3 now plays on the local element via ?proxy=1', [player.audio === local, local.src], [true, '/s/x3?proxy=1']);
check('cors element paused', ext.paused, true);
check('stored the choice for next time', JSON.parse(store.aur_ext_mode).mode, 'proxy');
player.next();
check('next PostFile track goes straight to the proxy', [player.audio === local, local.src], [true, '/s/x4?proxy=1']);
check('no error event surfaced for a recoverable failure', true, true);
local.fire('error');
check('a failing PROXY load is reported, not retried forever', player.current.id, 'x4');

console.log('== events from the INACTIVE element are ignored ==');
const before = changes;
ext.fire('pause'); ext.fire('ended'); ext.fire('timeupdate');
check('no change events / no auto-advance from inactive element', [changes, player.current.id], [before, 'x4']);
const activeBefore = changes;
local.fire('pause');
check('events from the ACTIVE element still fire', changes > activeBefore, true);

console.log('== volume applies to both elements ==');
player.setVolume(0.3);
check('both volumes set', [local.volume, ext.volume], [0.3, 0.3]);
player.toggleMute();
check('mute applies to both', [local.volume, ext.volume], [0, 0]);
player.toggleMute();
check('unmute restores both', [local.volume, ext.volume], [0.3, 0.3]);

console.log('== repeat never reloads the song (that re-downloaded it on every loop) ==');
player.playQueue([L('r1')], 0);
let srcSets = 0; const el = player.audio; let _src = el.src;
Object.defineProperty(el, 'src', { get: () => _src, set: (v) => { srcSets++; _src = v; }, configurable: true });
player.repeat = 'one'; el.currentTime = 90; el.paused = true;
el.fire('ended');
check('repeat one: source not set again', srcSets, 0);
check('repeat one: back to 0 and playing', [el.currentTime, el.paused], [0, false]);
player.repeat = 'all'; el.currentTime = 90; el.fire('ended');
check('repeat all with one song: source not set again', srcSets, 0);
player.repeat = 'off';

console.log('== a stream that dies part-way resumes where the listener was ==');
player.playQueue([L('e1')], 0);
const e = player.audio; let eSrc = e.src; let sets = [];
Object.defineProperty(e, 'src', { get: () => eSrc, set: (v) => { sets.push(v); eSrc = v; }, configurable: true });
e.currentTime = 42; e.fire('timeupdate'); e.readyState = 4;
e.currentTime = 0; // the broken stream resets the element...
e.fire('error');
await new Promise((r) => setTimeout(r, 900));
check('reloaded the same song', sets, ['/s/e1']);
check('...and went back to 42 s, not 0', e.currentTime, 42);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
