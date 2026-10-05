// Client-side upload orchestration. Three possible routes for a file:
//
//  proxy    Send it through Aurelune in one request (multipart to /studio/...). Fine everywhere
//           for files that fit the host's request-body cap.
//  chunked  Slice the file into ~3 MB pieces, send each as its own small request, then submit the
//           normal form with the upload id. Needed on hosts that cap request bodies (Vercel: ~4.5 MB).
//           The server joins the pieces, so tags, duration and artwork are still read automatically.
//           (PostFile doesn't allow uploads straight from a browser, so everything goes via the server.)
//  parts    Big PostFile audio on a host that caps request bodies. The pieces are grouped into parts of ~40 MB; after
//           each part's pieces arrive the server hands that part to PostFile (rotating over its API keys) in a request of
//           its own, so nothing runs long. The server plays the parts back as one file; listeners never notice.
//  blocked  Neither works (over the size limit, or an image too big for the host).
import { api } from './api.js';

const MB = 1024 * 1024;
// Vercel's cap is 4.5 MB for the whole request body; stay under it to leave room for multipart overhead + fields.
export const PROXY_LIMIT_BYTES = 4 * MB;
export const DEFAULT_CHUNK_BYTES = 3 * MB;

export class UploadError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

let optsPromise = null;
export const getStorageOptions = () => (optsPromise ||= api.get('/studio/storage-options').catch((e) => { optsPromise = null; throw e; }));

/** Pure decision function: which route can this file take? */
export function planUpload({ file, kind, driver, opts }) {
  const maxMb = opts.max_mb || 50;
  // Servers that know about parts (they send part_bytes) accept anything up to max_mb; older ones cap PostFile at one upload.
  const tooBig = file.size > maxMb * MB;
  if (tooBig && (driver === 'postfile' || (kind === 'audio' && opts.part_bytes))) {
    return { route: 'blocked', reason: `That file is over the ${maxMb} MB limit${driver === 'postfile' && !opts.part_bytes ? ' for PostFile uploads' : ''}.` };
  }
  if (!(opts.serverless && file.size > PROXY_LIMIT_BYTES)) return { route: 'proxy' };
  if (kind === 'audio' && opts.chunked) {
    const size = opts.chunk_bytes || DEFAULT_CHUNK_BYTES;
    const chunks = Math.ceil(file.size / size);
    if (driver === 'postfile' && opts.part_bytes && file.size > opts.part_bytes) {
      const perPart = Math.max(1, Math.floor(opts.part_bytes / size)); // part_bytes is a whole number of chunks
      return { route: 'parts', chunks, chunkBytes: size, chunksPerPart: perPart, parts: Math.ceil(chunks / perPart) };
    }
    return { route: 'chunked', chunks, chunkBytes: size };
  }
  if (kind === 'image') return { route: 'blocked', reason: "Images over 4 MB can't be uploaded on this host. Resize it and try again." };
  return { route: 'blocked', reason: "This file is too large to send through this server (about 4 MB is the most this host accepts)." };
}

/** Short, honest note for the UI about what the chosen route means. */
export function describeRoute(plan) {
  if (plan.route === 'parts') return `Large file: it will be split into ${plan.parts} parts and sent to storage one after another, then played back as a single file. This can take a while — keep this window open.`;
  if (plan.route === 'chunked') return `Large file: it will upload in ${plan.chunks} pieces. This can take a little while — keep this window open.`;
  if (plan.route === 'blocked') return plan.reason;
  return '';
}

/* ------------------------------ browser helpers (swappable in tests) ------------------------------ */

const newUploadId = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function putChunk(uploadId, index, blob) {
  return api.putRaw(`/studio/chunks/${uploadId}/${index}`, blob);
}

/** Sends one piece, retrying a few times. A 4xx (not signed in, too big…) can't be fixed by retrying. */
async function sendOne(put, wait, uploadId, i, blob, label) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await put(uploadId, i, blob); return; }
    catch (e) {
      lastErr = e;
      if (e?.status >= 400 && e?.status < 500 && e.status !== 408 && e.status !== 429) break;
      await wait(600 * (attempt + 1));
    }
  }
  throw new UploadError(`Upload stopped at ${label}: ${lastErr.message}`, 'network');
}

/** Sends every piece (sequentially, each retried a few times) and returns what the final form must carry. */
async function sendChunks(file, plan, { onProgress, deps }) {
  const put = deps.putChunk || putChunk;
  const wait = deps.sleep || sleep;
  const uploadId = (deps.newUploadId || newUploadId)();
  for (let i = 0; i < plan.chunks; i++) {
    const blob = file.slice(i * plan.chunkBytes, Math.min(file.size, (i + 1) * plan.chunkBytes));
    await sendOne(put, wait, uploadId, i, blob, `piece ${i + 1} of ${plan.chunks}`);
    onProgress?.(((i + 1) / plan.chunks) * 0.9); // the last 10% is the server joining the pieces and handing them to storage
  }
  return { upload_id: uploadId, chunk_count: plan.chunks, filename: file.name };
}

/** Length of an audio file as the browser sees it (ms), or 0. Lets a part-by-part upload know the real duration without the whole file on the server. */
export function probeDuration(file, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let url, done = false;
    const el = new Audio();
    const finish = (ms) => { if (done) return; done = true; try { URL.revokeObjectURL(url); } catch { /* ignore */ } el.removeAttribute('src'); resolve(ms); };
    try { url = URL.createObjectURL(file); } catch { return resolve(0); }
    el.preload = 'metadata';
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : 0);
    el.onerror = () => finish(0);
    setTimeout(() => finish(0), timeoutMs);
    el.src = url;
  });
}

/** Part-by-part: pieces for part N, then ask the server to hand part N to PostFile. Returns what the final form must carry. */
async function sendParts(file, plan, { onProgress, deps }) {
  const put = deps.putChunk || putChunk;
  const wait = deps.sleep || sleep;
  const flush = deps.flushPart || ((uploadId, n, body) => api.post(`/studio/uploads/${uploadId}/parts/${n}`, body));
  const uploadId = (deps.newUploadId || newUploadId)();
  const durationMs = await (deps.probeDuration || probeDuration)(file).catch(() => 0);
  let sent = 0;
  for (let n = 0; n < plan.parts; n++) {
    const first = n * plan.chunksPerPart, last = Math.min(plan.chunks, first + plan.chunksPerPart);
    for (let i = first; i < last; i++) {
      const blob = file.slice(i * plan.chunkBytes, Math.min(file.size, (i + 1) * plan.chunkBytes));
      await sendOne(put, wait, uploadId, i, blob, `part ${n + 1} of ${plan.parts}, piece ${i + 1 - first}`);
      onProgress?.((++sent / plan.chunks) * 0.9 * 0.85);
    }
    const body = { first_chunk: first, chunk_count: last - first, filename: file.name, total_size: file.size, duration_ms: durationMs || undefined };
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) { // idempotent on the server, so retrying a part is safe
      try { await flush(uploadId, n, body); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        // 4xx other than a timeout/rate-limit/"some pieces missing" means retrying won't help
        if (e?.status >= 400 && e?.status < 500 && ![408, 409, 429].includes(e.status) && e.code !== 'incomplete_upload') break;
        await wait(1500 * (attempt + 1));
      }
    }
    if (lastErr) throw new UploadError(`Storage stopped at part ${n + 1} of ${plan.parts}: ${lastErr.message}`, 'network');
    onProgress?.(0.9 * (0.85 + 0.15 * ((n + 1) / plan.parts)));
  }
  return { upload_session: uploadId, filename: file.name };
}

function buildForm(file, extra, meta, driver) {
  const fd = new FormData();
  if (file) fd.append('audio', file);
  fd.append('storage', driver);
  for (const [k, v] of Object.entries({ ...extra, ...meta })) fd.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? ''));
  return fd;
}

async function submit({ path, file, meta, driver, opts, onProgress, deps }) {
  const plan = planUpload({ file, kind: 'audio', driver, opts });
  if (plan.route === 'blocked') throw new UploadError(plan.reason, 'blocked');
  if (plan.route === 'chunked' || plan.route === 'parts') {
    const extra = await (plan.route === 'parts' ? sendParts : sendChunks)(file, plan, { onProgress, deps });
    const out = await api.postForm(path, buildForm(null, extra, meta, driver));
    onProgress?.(1);
    return { ...out, route: plan.route };
  }
  return { ...(await api.postForm(path, buildForm(file, {}, meta, driver))), route: 'proxy' };
}

/* ------------------------------ public entry points ------------------------------ */

export const uploadTrack = ({ file, meta, driver, opts, onProgress, deps = {} }) =>
  submit({ path: '/studio/tracks', file, meta, driver, opts, onProgress, deps });

export const uploadEpisode = ({ showId, file, meta, driver, opts, onProgress, deps = {} }) =>
  submit({ path: `/studio/shows/${showId}/episodes`, file, meta, driver, opts, onProgress, deps });
