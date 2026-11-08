// Uploaded pictures are downscaled once, before storage (server/imgopt.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* optional dependency */ }
const { optimizeImage, MAX_SIDE } = await import('../server/imgopt.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imgopt-'));
const noise = (w, h, ch = 3) => sharp(crypto.randomBytes(w * h * ch), { raw: { width: w, height: h, channels: ch } });

test('a large photo is shrunk to MAX_SIDE and becomes much smaller', { skip: !sharp }, async () => {
  const f = path.join(dir, 'big.jpg'); await noise(3600, 2400).jpeg({ quality: 95 }).toFile(f);
  const before = fs.statSync(f).size;
  const r = await optimizeImage(f);
  assert.ok(r, 'optimised');
  const m = await sharp(r.file).metadata();
  assert.equal(Math.max(m.width, m.height), MAX_SIDE);
  assert.equal(m.width / m.height, 1.5, 'keeps the aspect ratio');
  assert.ok(fs.statSync(r.file).size < before / 3, `smaller: ${before} -> ${fs.statSync(r.file).size}`);
  assert.equal(r.mime, 'image/jpeg');
});

test('a big opaque PNG becomes a JPEG (new extension, old file removed)', { skip: !sharp }, async () => {
  const f = path.join(dir, 'cover.png'); await noise(2500, 2500).png().toFile(f);
  const r = await optimizeImage(f);
  assert.ok(r); assert.ok(r.file.endsWith('cover.jpg')); assert.equal(r.mime, 'image/jpeg');
  assert.ok(!fs.existsSync(f), 'the old .png is gone'); assert.ok(fs.existsSync(r.file));
});

test('a PNG with transparency stays a PNG', { skip: !sharp }, async () => {
  const f = path.join(dir, 'logo.png'); await noise(2400, 2400, 4).png().toFile(f);
  const r = await optimizeImage(f);
  assert.ok(r); assert.equal(r.mime, 'image/png'); assert.equal((await sharp(r.file).metadata()).hasAlpha, true);
});

test('EXIF rotation is applied, not lost', { skip: !sharp }, async () => {
  const f = path.join(dir, 'rot.jpg'); await noise(3000, 1500).withMetadata({ orientation: 6 }).jpeg().toFile(f); // displays as 1500x3000
  const r = await optimizeImage(f); const m = await sharp(r.file).metadata();
  assert.ok(m.height > m.width, `portrait after rotating: ${m.width}x${m.height}`);
  assert.equal(Math.max(m.width, m.height), MAX_SIDE);
});

test('small pictures, GIFs and SVGs are left alone', { skip: !sharp }, async () => {
  const small = path.join(dir, 'small.jpg'); await sharp({ create: { width: 600, height: 600, channels: 3, background: '#335' } }).jpeg().toFile(small);
  assert.equal(await optimizeImage(small), null);
  const gif = path.join(dir, 'a.gif'); fs.writeFileSync(gif, Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  assert.equal(await optimizeImage(gif), null); assert.ok(fs.existsSync(gif));
  const svg = path.join(dir, 'a.svg'); fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(await optimizeImage(svg), null);
});

test('a corrupt file never throws and is left as it was', async () => {
  const f = path.join(dir, 'bad.jpg'); fs.writeFileSync(f, 'this is not a picture');
  assert.equal(await optimizeImage(f), null);
  assert.equal(fs.readFileSync(f, 'utf8'), 'this is not a picture');
});

test('a missing file never throws', async () => { assert.equal(await optimizeImage(path.join(dir, 'nope.jpg')), null); });
