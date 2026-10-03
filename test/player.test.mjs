const calls = { wrapped: [], resumed: 0 };
class FakeAudio {
  constructor() { this.l = {}; this.paused = true; this.ended = false; this.currentTime = 0; this.volume = 1; this.id = FakeAudio.n++; this.pauses = 0; }
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
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) });

const { player } = await import(new URL('../public/js/player.js', import.meta.url).href);
let pass = 0, fail = 0;
const check = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`); };

const L = (id) => ({ id, type: 'track', title: id, stream_url: '/s/' + id, external: false, duration_ms: 1e5 });
const X = (id) => ({ id, type: 'track', title: id, stream_url: '/s/' + id, external: true, duration_ms: 1e5 });
const local = player._elLocal, ext = player._elExternal;
let changes = 0; player.addEventListener('change', () => changes++);

console.log('== external track FIRST: graph must not be created ==');
player.playQueue([X('x1'), L('l1'), X('x2'), L('l2')], 0);
check('active element is the external one', player.audio === ext, true);
check('no MediaElementSource created yet', calls.wrapped, []);
check('external element got the stream', ext.src, '/s/x1');

console.log('== switch to a local track ==');
player.next();
check('active element is now local', player.audio === local, true);
check('graph wraps ONLY the local element', calls.wrapped, [local.id]);
check('external element was paused', ext.paused, true);
check('audio context resumed', calls.resumed, 1);

console.log('== back to external, then local again ==');
player.next();
check('external again', player.audio === ext, true);
player.next();
check('local again', player.audio === local, true);
check('graph still created exactly once', calls.wrapped.length, 1);

console.log('== events from the INACTIVE element are ignored ==');
const before = changes;
ext.fire('pause'); ext.fire('ended'); ext.fire('timeupdate');
check('no change events / no auto-advance from inactive element', [changes, player.current.id], [before, 'l2']);
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

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
