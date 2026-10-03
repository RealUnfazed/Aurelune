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
import {
  POSTFILE_API_KEY, POSTFILE_API_BASE, POSTFILE_MAX_MB, AUDIO_DIR, IMAGE_DIR, availableDrivers, defaultDriver,
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

async function pf(pathname, { method = 'GET', body, headers = {}, timeoutMs = 120000 } = {}) {
  let res;
  let url = POSTFILE_API_BASE + pathname;
  try {
    // Follow redirects ourselves: fetch drops the X-API-Key header when a redirect crosses hosts
    // (e.g. postfile.net -> www.postfile.net), which would turn a good request into a silent failure.
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, {
        method, body, redirect: 'manual', headers: { 'X-API-Key': POSTFILE_API_KEY, ...headers }, signal: AbortSignal.timeout(timeoutMs),
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

/** POST /v1/upload — multipart, field "file". Used when the file passes through this server. */
export async function postfileUpload(filePath, filename, contentType) {
  const bytes = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename);
  return normalizeFile(await pf('/v1/upload', { method: 'POST', body: form }));
}

/** DELETE /v1/files/{id} — best effort; never throws (a failed cleanup must not block a delete). */
export async function postfileDelete(fileId) {
  try { await pf(`/v1/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }); }
  catch (err) { if (err.status !== 404) console.error(`Could not delete PostFile file ${fileId}: ${err.message}`); }
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
      const f = await postfileUpload(full, originalName || stagedFilename, mime);
      return { driver, ref: f.url, fileId: f.fileId };
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

export async function deleteAudio({ storageDriver, audio, storageFileId }) {
  if (storageDriver === 'postfile') { if (storageFileId) await postfileDelete(storageFileId); return; }
  if (audio) unlinkQuiet(path.join(AUDIO_DIR, path.basename(audio)));
}

/** Images stored on PostFile are not tracked by file id, so replacing/deleting one leaves the remote copy behind. */
export function deleteImage(ref) {
  if (!ref || /^https?:\/\//.test(ref)) return;
  unlinkQuiet(path.join(IMAGE_DIR, path.basename(ref)));
}

export const isRemoteRef = (ref) => /^https?:\/\//.test(ref || '');
