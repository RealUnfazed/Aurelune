// At-rest encryption for uploaded audio. Every file on disk under
// DATA_DIR/uploads/audio is AES-256-CTR encrypted (a random 16-byte IV is
// stored as the file's first 16 bytes, the rest is ciphertext) so that
// anyone with raw filesystem or backup access — not a normal listener —
// never finds a directly playable file sitting there.
//
// This is real protection against file theft/leaks. It is NOT the same
// thing as licensed DRM (Widevine/FairPlay/PlayReady): those also stop an
// *authorized* device from ever touching decoded audio, which requires a
// paid vendor license and hardware-backed key handling — not something
// buildable from scratch. Anyone who can legitimately hear a track through
// their own authenticated session can, in principle, capture what their
// own speakers are playing; no software fully prevents that, including
// Spotify's (hence the existence of stream-ripping tools despite it).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const ALGO = 'aes-256-ctr';
const IV_LEN = 16;
const KEY_PATH = path.join(DATA_DIR, '.audio-key');

function loadOrCreateKey() {
  const fromEnv = process.env.AUDIO_ENCRYPTION_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'hex');
    if (buf.length !== 32) throw new Error('AUDIO_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    return buf;
  }
  try {
    return Buffer.from(fs.readFileSync(KEY_PATH, 'utf8').trim(), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
    console.log(
      'Aurelune: generated a new audio encryption key at', KEY_PATH,
      '— back this up. Losing it makes every uploaded file unreadable. Set AUDIO_ENCRYPTION_KEY to pin one explicitly (e.g. across a multi-server deployment).'
    );
    return key;
  }
}

let KEY = null;
const getKey = () => (KEY ||= loadOrCreateKey()); // lazy: never touch disk unless local storage is actually used

function incrementIv(iv, blocks) {
  const out = Buffer.from(iv);
  let carry = BigInt(blocks);
  for (let i = out.length - 1; i >= 0 && carry > 0n; i--) {
    const sum = BigInt(out[i]) + (carry & 0xffn);
    out[i] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return out;
}

/** Encrypts a plaintext file in place: reads it fully, overwrites with [iv][ciphertext]. */
export async function encryptFileInPlace(filePath) {
  const plain = await fs.promises.readFile(filePath);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  await fs.promises.writeFile(filePath, Buffer.concat([iv, encrypted]));
}

/** Size of the plaintext audio, given the encrypted file's size on disk. */
export function plainSize(encryptedFileSize) {
  return Math.max(0, encryptedFileSize - IV_LEN);
}

/**
 * Streams a byte range [start, end] (inclusive, plaintext offsets) of an
 * encrypted file to `res`, decrypting on the fly. Supports arbitrary
 * (non-block-aligned) start offsets, which is what makes `<audio>` seeking
 * and HTTP Range requests work against an encrypted file.
 */
export function streamDecryptedRange(filePath, res, start, end) {
  const blockIndex = Math.floor(start / 16);
  const trimLeading = start - blockIndex * 16;
  const readStart = IV_LEN + blockIndex * 16;
  const readEnd = IV_LEN + end; // inclusive, fs.createReadStream end is inclusive too

  return new Promise((resolve, reject) => {
    const ivFd = fs.createReadStream(filePath, { start: 0, end: IV_LEN - 1 });
    let iv = Buffer.alloc(0);
    ivFd.on('data', (c) => { iv = Buffer.concat([iv, c]); });
    ivFd.on('error', reject);
    ivFd.on('end', () => {
      if (iv.length < IV_LEN) return reject(new Error('Encrypted file is truncated (missing IV header)'));
      const decipher = crypto.createDecipheriv(ALGO, getKey(), incrementIv(iv, blockIndex));
      const body = fs.createReadStream(filePath, { start: readStart, end: readEnd });
      let first = true;
      body.on('error', reject);
      decipher.on('error', reject);
      decipher.on('data', (chunk) => {
        if (first) { chunk = chunk.subarray(trimLeading); first = false; }
        res.write(chunk);
      });
      decipher.on('end', () => { res.end(); resolve(); });
      body.pipe(decipher);
    });
  });
}
