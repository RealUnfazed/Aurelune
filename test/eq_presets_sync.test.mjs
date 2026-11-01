// The client carries its own copy of the EQ presets (so Settings → Sound works offline); it must never drift from the server's.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../server/eq-presets.js';
import * as client from '../public/js/eq-presets.js';

test('client EQ presets and labels equal the server ones', () => {
  assert.deepEqual(client.EQ_PRESETS, server.EQ_PRESETS);
  assert.deepEqual(client.EQ_PRESET_LABELS, server.EQ_PRESET_LABELS);
});
