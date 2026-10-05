// Where uploaded files live. Two drivers, chosen per upload:
//
//  local     Files on this server's disk. Audio is AES-encrypted at rest and streamed
//            through the server (see crypto-store.js), so playback is login-gated.
//            Needs a persistent disk: fine for a VPS/Docker/Electron, impossible on Vercel.
//
//  postfile  Files hosted on postfile.net. The server never holds the bytes for long:
//            streaming is a 302 redirect to PostFile's CDN. That URL is PUBLIC and
//            unauthenticated (anyone holding it can fetch the file) and is not encrypted —
//            that's how the service works, and it's the price of not needing a disk.
//
// PostFile API reference: https://postfile.net/docs  (auth: X-API-Key header).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  POSTFILE_API_KEYS, POSTFILE_API_BASE, POSTFILE_MAX_MB, PART_BYTES, AUDIO_DIR, IMAGE_DIR, availableDrivers, defaultDriver,
} from './config.js';
import { HttpError } from './util.js';
import { encryptFileInPlace } from './crypto-store.js';

export const AUDIO_EXTS = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

const exposed = (status, message, code) => new HttpError(status, message, code, { expose: true });

/* ============================== PostFile client ============================== */

function postfileError(status, data) {
  // PostFile's own errors are JSON like {"detail": "..."}. A 401/403 *without* that shape came from
  // something in between (an egress proxy, a firewall, Cloudflare) — so don't guess at a cause.
  const fromPostfile = typeof data?.detail === 'string';
  const detail = fromPostfile ? data.detail : '';
  if ((status === 401 || status === 403) && !fromPostfile) {
    console.error(`PostFile request blocked with ${status} before reaching the API (not a PostFile-shaped error). Check network egress/firewall rules for ${POSTFILE_API_BASE}.`);
    return exposed(502, `The file host could not be reached (blocked with HTTP ${status}). If this server restricts outbound traffic, allow ${new URL(POSTFILE_API_BASE).hostname}.`, 'storage_blocked');
  }
  if (status === 401) { console.error('PostFile rejected the API key (401). Check POSTFILE_API_KEY.'); return exposed(502, "The file host rejected this server's credentials. The site owner needs to check POSTFILE_API_KEY.", 'storage_auth'); }
  if (status === 403) return exposed(409, `PostFile refused the upload${detail ? `: ${detail}` : ' (plan limit reached — monthly uploads or storage)'}. Try again after the monthly reset, or upgrade the PostFile plan.`, 'storage_quota');
  if (status === 413) return exposed(413, `That file is too large for the PostFile plan (${POSTFILE_MAX_MB} MB on the free plan).`, 'too_large');
  if (status === 429) return exposed(429, 'PostFile is rate-limiting uploads. Try again in a few seconds.', 'rate_limited');
  if (status === 404) return exposed(404, 'File not found on PostFile', 'not_found');
  if (status === 422) return exposed(422, `PostFile rejected the request${detail ? `: ${detail}` : ''}`, 'storage_rejected');
  console.error(`PostFile error ${status}: ${detail}`);
  return exposed(502, `The file host returned an error (${status}). Try again shortly.`, 'storage_error');
}

const isPostfileHost = (h) => h === new URL(POSTFILE_API_BASE).hostname || h === 'postfile.net' || h.endsWith('.postfile.net') || h.endsWith('.postfile.download');

/** Describes an unexpected 2xx reply without leaking anything secret: status, type, top-level keys / text start. */
function describeReply(res, text, data) {
  const ct = (res.headers.get('content-type') || '').split(';')[0] || 'unknown';
  const shape = data && typeof data === 'object' ? `keys: ${Object.keys(data).slice(0, 12).join(', ') || '(none)'}` : `starts with: ${JSON.stringify(String(text || '').slice(0, 80))}`;
  return `HTTP ${res.status}, ${ct}${res.redirected ? ', redirected' : ''}, ${shape}`;
}

/* ---------------- Key pool: rotation + failover ----------------
 * Several API keys (several PostFile accounts) are used in turn, so uploads — and the parts of one big file — spread out
 * over all of them. A key that fails in a way another key could fix (out of quota, rate-limited, rejected, host
 * trouble) sits out for a while and the request moves on to the next key. Nothing here is shared between serverless
 * instances; each instance simply learns it again, which is cheap.
 */
const keyFingerprint = (k) => crypto.createHash('sha256').update(k).digest('hex').slice(0, 10);
const pool = POSTFILE_API_KEYS.map((key) => ({ key, id: keyFingerprint(key), downUntil: 0, lastError: '' }));
let rotation = 0;
const COOLDOWN_MS = { storage_quota: 30 * 60e3, storage_auth: 15 * 60e3, rate_limited: 60e3, storage_unreachable: 20e3, storage_error: 30e3 };
const FAILOVER = new Set(Object.keys(COOLDOWN_MS));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keys in the order to try them: healthy ones starting from the rotating pointer, then resting ones soonest-back first. */
function keyOrder() {
  if (!pool.length) return [];
  const now = Date.now();
  const start = rotation++ % pool.length;
  const turn = pool.map((_, i) => pool[(start + i) % pool.length]);
  return [...turn.filter((e) => e.downUntil <= now), ...turn.filter((e) => e.downUntil > now).sort((a, b) => a.downUntil - b.downUntil)];
}

/** For the UI / diagnostics. Never includes the keys themselves. */
export const poolStatus = () => pool.map((e) => ({ id: e.id, ready: e.downUntil <= Date.now(), retry_in_s: Math.max(0, Math.ceil((e.downUntil - Date.now()) / 1000)), last_error: e.lastError || undefined }));
export const _poolReset = () => { for (const e of pool) { e.downUntil = 0; e.lastError = ''; } rotation = 0; };

/** Runs `fn(entry)` against keys in turn until one works. Non-key problems (a bad file) are thrown straight away. */
async function withKeys(fn, { only } = {}) {
  const order = only ? pool.filter((e) => e.id === only) : keyOrder();
  if (!order.length) throw exposed(503, 'No upload storage is configured on this server.', 'no_storage');
  let lastErr;
  for (const entry of order) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const out = await fn(entry); entry.lastError = ''; return out; }
      catch (err) {
        lastErr = err;
        if (!(err instanceof HttpError) || !FAILOVER.has(err.code)) throw err;
        // A blip (network, 5xx, rate limit) gets one quick retry on the same key before moving on.
        if (attempt === 0 && ['storage_unreachable', 'storage_error', 'rate_limited'].includes(err.code)) { await sleep(400 + Math.random() * 600); continue; }
        entry.downUntil = Date.now() + COOLDOWN_MS[err.code];
        entry.lastError = err.code;
        console.warn(`PostFile key ${entry.id} set aside for ${Math.round(COOLDOWN_MS[err.code] / 1000)}s (${err.code}); ${order.length > 1 ? 'trying the next key' : 'no other key to try'}.`);
        break;
      }
    }
  }
  throw lastErr;
}

async function pf(entry, pathname, { method = 'GET', body, headers = {}, timeoutMs = 120000 } = {}) {
  let res;
  let url = POSTFILE_API_BASE + pathname;
  try {
    // Follow redirects ourselves: fetch drops the X-API-Key header when a redirect crosses hosts
    // (e.g. postfile.net -> www.postfile.net), which would turn a good request into a silent failure.
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, {
        method, body, redirect: 'manual', headers: { 'X-API-Key': entry.key, ...headers }, signal: AbortSignal.timeout(timeoutMs),
      });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      const next = new URL(loc, url);
      if (next.protocol !== 'https:' || !isPostfileHost(next.hostname)) {
        console.error(`PostFile redirected to an untrusted location (${next.hostname}); refusing to follow.`);
        throw exposed(502, 'The file host redirected the request somewhere unexpected.', 'storage_error');
      }
      url = next.toString();
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error('PostFile unreachable:', err.message);
    throw exposed(503, 'Could not reach the file host. Try again in a moment.', 'storage_unreachable');
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON body */ }
  if (!res.ok) throw postfileError(res.status, data);
  if (data === null || typeof data !== 'object') {
    const why = describeReply(res, text, data);
    console.error(`PostFile ${method} ${pathname} returned a non-JSON success reply: ${why}`);
    throw exposed(502, `The file host sent a reply that isn't JSON (${why}). It may be blocking requests from this server.`, 'storage_error');
  }
  return data;
}

/** Only ever redirect listeners to PostFile's own hosts (never a client-supplied URL). */
export function assertTrustedUrl(u) {
  let url;
  try { url = new URL(u); } catch { throw exposed(502, 'The file host returned an invalid file location', 'storage_error'); }
  const apiHost = new URL(POSTFILE_API_BASE).hostname;
  const h = url.hostname;
  const ok = /^https?:$/.test(url.protocol) && (h === apiHost || h === 'postfile.net' || h.endsWith('.postfile.net') || h.endsWith('.postfile.download'));
  if (!ok) throw exposed(502, 'The file host returned an unexpected file location', 'storage_error');
  return url.toString();
}

function normalizeFile(raw, fallbackId) {
  // The documented shape is flat {file_id, url, ...}; also accept a wrapper ({file|data|result: {...}})
  // and common alias names, so a small difference in the live API doesn't break uploads.
  const d = (raw && (raw.file || raw.data || raw.result)) && typeof (raw.file || raw.data || raw.result) === 'object' ? (raw.file || raw.data || raw.result) : raw;
  const fileId = d?.file_id || d?.id || d?.fileId || fallbackId;
  const url = d?.url || d?.cdn_url || d?.download_url || d?.public_url || d?.file_url || d?.link;
  if (!fileId || !url) {
    const keys = raw && typeof raw === 'object' ? Object.keys(raw).slice(0, 12).join(', ') : typeof raw;
    console.error(`PostFile reply missing file id/url. Top-level keys: ${keys}`);
    throw exposed(502, `The file host returned an unexpected response (keys: ${keys || 'none'}).`, 'storage_error');
  }
  return { fileId, url: assertTrustedUrl(url), size: d.size, contentType: d.content_type || d.contentType, name: d.name || d.filename };
}

/** POST /v1/upload — multipart, field "file". `bytes` is a Buffer; returns { fileId, url, key } where `key` says which account holds it. */
export async function postfileUploadBytes(bytes, filename, contentType) {
  return withKeys(async (entry) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename);
    const f = normalizeFile(await pf(entry, '/v1/upload', { method: 'POST', body: form, timeoutMs: 280000 }));
    return { ...f, key: entry.id };
  });
}

export async function postfileUpload(filePath, filename, contentType) {
  return postfileUploadBytes(await fs.promises.readFile(filePath), filename, contentType);
}

/** DELETE /v1/files/{id} on the account that holds it — best effort; never throws (a failed cleanup must not block a delete). */
export async function postfileDelete(fileId, keyId) {
  try {
    await withKeys((entry) => pf(entry, `/v1/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }), keyId && pool.some((e) => e.id === keyId) ? { only: keyId } : {});
  } catch (err) { if (err.status !== 404) console.error(`Could not delete PostFile file ${fileId}: ${err.message}`); }
}

/** Part names keep the original extension so the host sees ordinary audio files: "talk.mp3" -> "talk-part2of6.mp3". */
export const partName = (name, i, n) => { const ext = path.extname(name || ''); return `${path.basename(name || 'audio', ext)}-part${i + 1}of${n}${ext}`; };
export const partsNeeded = (size) => Math.max(1, Math.ceil(size / PART_BYTES));

/** Uploads one part (a Buffer) and returns the record kept in the database. */
export async function uploadPart(bytes, name, mime, i, n) {
  const f = await postfileUploadBytes(bytes, n > 1 ? partName(name, i, n) : name, mime);
  return { fileId: f.fileId, url: f.url, size: bytes.length, key: f.key };
}

export const deleteParts = (parts) => Promise.all((parts || []).map((p) => postfileDelete(p.fileId, p.key)));

/** Splits a staged file into parts and uploads them (two at a time, each to the next key). All-or-nothing: if any part fails, the ones already up are removed. */
async function uploadFileInParts(full, size, name, mime) {
  const n = partsNeeded(size);
  const parts = new Array(n);
  const fh = await fs.promises.open(full, 'r');
  let next = 0, failure = null;
  const worker = async () => {
    while (!failure) {
      const i = next++;
      if (i >= n) return;
      try {
        const len = Math.min(PART_BYTES, size - i * PART_BYTES);
        const buf = Buffer.allocUnsafe(len);
        await fh.read(buf, 0, len, i * PART_BYTES);
        parts[i] = await uploadPart(buf, name, mime, i, n);
      } catch (e) { failure = e; }
    }
  };
  try { await Promise.all([worker(), worker()]); }
  finally { await fh.close(); }
  if (failure) { await deleteParts(parts.filter(Boolean)); throw failure; }
  return parts;
}

/* ============================== Driver dispatch ============================== */

/** Validates a requested driver (or picks the default) against what this deployment can do. */
export function resolveDriver(requested) {
  const avail = availableDrivers();
  if (!avail.length) throw exposed(503, 'No upload storage is configured on this server. The site owner needs to set POSTFILE_API_KEY (or run on a host with a persistent disk).', 'no_storage');
  const d = (requested || defaultDriver() || '').toLowerCase();
  if (!avail.includes(d)) throw exposed(400, `"${d}" storage isn't available on this server (available: ${avail.join(', ')})`, 'bad_storage');
  return d;
}

const unlinkQuiet = (p) => fs.promises.unlink(p).catch(() => {});

/** Moves a staged (plaintext) audio upload to its final home. Metadata must already have been read. */
export async function storeAudio(stagedFilename, { driver, originalName, mime }) {
  const full = path.join(AUDIO_DIR, path.basename(stagedFilename));
  if (driver === 'postfile') {
    try {
      const size = (await fs.promises.stat(full)).size;
      if (size > PART_BYTES) {
        const parts = await uploadFileInParts(full, size, originalName || stagedFilename, mime);
        return { driver, ref: parts[0].url, fileId: parts[0].fileId, parts, size };
      }
      const f = await postfileUpload(full, originalName || stagedFilename, mime);
      return { driver, ref: f.url, fileId: f.fileId, key: f.key, size };
    } finally { unlinkQuiet(full); } // the staged copy is never kept
  }
  await encryptFileInPlace(full);
  return { driver: 'local', ref: path.basename(stagedFilename), fileId: undefined };
}

/** Same for a cover image. Local images are stored as-is; postfile images become a CDN URL. */
export async function storeImage(stagedFilename, { driver, originalName, mime }) {
  const full = path.join(IMAGE_DIR, path.basename(stagedFilename));
  if (driver === 'postfile') {
    try { return (await postfileUpload(full, originalName || stagedFilename, mime)).url; }
    finally { unlinkQuiet(full); }
  }
  return path.basename(stagedFilename);
}

export async function deleteAudio({ storageDriver, audio, storageFileId, storageKey, storageParts }) {
  if (storageDriver === 'postfile') {
    if (storageParts?.length) await deleteParts(storageParts);
    else if (storageFileId) await postfileDelete(storageFileId, storageKey);
    return;
  }
  if (audio) unlinkQuiet(path.join(AUDIO_DIR, path.basename(audio)));
}

/** Images stored on PostFile are not tracked by file id, so replacing/deleting one leaves the remote copy behind. */
export function deleteImage(ref) {
  if (!ref || /^https?:\/\//.test(ref)) return;
  unlinkQuiet(path.join(IMAGE_DIR, path.basename(ref)));
}

export const isRemoteRef = (ref) => /^https?:\/\//.test(ref || '');
