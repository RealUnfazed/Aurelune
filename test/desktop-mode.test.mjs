// Pure-logic checks for the desktop shell's modes (electron/mode.js) and the shared HTTP Range parser (server/pfstream.js).
import assert from 'node:assert/strict';
import { lockedServer, resolveMode, normalizeServerUrl } from '../electron/mode.js';
import { parseRange } from '../server/pfstream.js';

let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('a client build with an address is locked to it', () => assert.equal(lockedServer({ mode: 'client', serverUrl: 'music.example.com' }), 'https://music.example.com'));
t('a client build without an address is not locked', () => assert.equal(lockedServer({ mode: 'client', serverUrl: '' }), null));
t('a full build is never locked', () => assert.equal(lockedServer({ mode: 'full', serverUrl: 'https://x.y' }), null));
t('locked builds ignore --mode/AURELUNE_MODE=full', () => {
  const cfg = { mode: 'client', serverUrl: 'https://x.y' };
  assert.equal(resolveMode(cfg, { AURELUNE_MODE: 'full' }, ['--mode=full']), 'client');
});
t('unlocked builds still honour overrides (development)', () => {
  assert.equal(resolveMode({ mode: 'client', serverUrl: '' }, { AURELUNE_MODE: 'full' }, []), 'full');
  assert.equal(resolveMode({ mode: 'full', serverUrl: '' }, {}, ['--client']), 'client');
});
t('addresses normalise', () => {
  assert.equal(normalizeServerUrl('127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(normalizeServerUrl('ftp://x'), null);
});

// Range parsing: the seek-to-start bug came from ranges the browser sends while seeking.
const R = (h, total = 1000) => parseRange(h, total);
t('no header -> whole file, not partial', () => assert.deepEqual(R(undefined), { start: 0, end: 999, partial: false }));
t('bytes=0-1', () => assert.deepEqual(R('bytes=0-1'), { start: 0, end: 1, partial: true }));
t('open-ended', () => assert.deepEqual(R('bytes=500-'), { start: 500, end: 999, partial: true }));
t('end past EOF is clamped', () => assert.deepEqual(R('bytes=990-5000'), { start: 990, end: 999, partial: true }));
t('suffix range = last N bytes', () => assert.deepEqual(R('bytes=-100'), { start: 900, end: 999, partial: true }));
t('suffix larger than the file = whole file', () => assert.deepEqual(R('bytes=-5000'), { start: 0, end: 999, partial: true }));
t('start beyond EOF is unsatisfiable', () => assert.equal(R('bytes=1000-'), null));
t('backwards ranges are unsatisfiable', () => assert.equal(R('bytes=9-2'), null));
t('an unparseable Range header is ignored (whole file), as the RFC says', () => assert.deepEqual(R('bytes=a-b'), { start: 0, end: 999, partial: false }));

console.log(`\n${n} checks passed`);
