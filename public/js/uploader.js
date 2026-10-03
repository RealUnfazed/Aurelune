// Client-side upload orchestration. Three possible routes for a file:
//
//  proxy    Send it through Aurelune in one request (multipart to /studio/...). Fine everywhere
//           for files that fit the host's request-body cap.
//  chunked  Slice the file into ~3 MB pieces, send each as its own small request, then submit the
//           normal form with the upload id. Needed on hosts that cap request bodies (Vercel: ~4.5 MB).
//           The server joins the pieces, so tags, duration and artwork are still read automatically.
//           (PostFile doesn't allow uploads straight from a browser, so everything goes via the server.)
//  blocked  Neither works (over PostFile's plan cap, or an image too big for the host).
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
  if (driver === 'postfile' && file.size > maxMb * MB) {
    return { route: 'blocked', reason: `That file is over the ${maxMb} MB limit for PostFile uploads.` };
  }
  if (!(opts.serverless && file.size > PROXY_LIMIT_BYTES)) return { route: 'proxy' };
  if (kind === 'audio' && opts.chunked) {
    const size = opts.chunk_bytes || DEFAULT_CHUNK_BYTES;
    return { route: 'chunked', chunks: Math.ceil(file.size / size), chunkBytes: size };
  }
  if (kind === 'image') return { route: 'blocked', reason: "Images over 4 MB can't be uploaded on this host. Resize it and try again." };
  return { route: 'blocked', reason: "This file is too large to send through this server (about 4 MB is the most this host accepts)." };
}

/** Short, honest note for the UI about what the chosen route means. */
export function describeRoute(plan) {
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

/** Sends every piece (sequentially, each retried a few times) and returns what the final form must carry. */
async function sendChunks(file, plan, { onProgress, deps }) {
  const put = deps.putChunk || putChunk;
  const wait = deps.sleep || sleep;
  const uploadId = (deps.newUploadId || newUploadId)();
  for (let i = 0; i < plan.chunks; i++) {
    const blob = file.slice(i * plan.chunkBytes, Math.min(file.size, (i + 1) * plan.chunkBytes));
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await put(uploadId, i, blob); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        // A 4xx means the server understood and said no (not signed in, file too big…): retrying can't help.
        if (e?.status >= 400 && e?.status < 500 && e.status !== 408 && e.status !== 429) break;
        await wait(600 * (attempt + 1));
      }
    }
    if (lastErr) throw new UploadError(`Upload stopped at piece ${i + 1} of ${plan.chunks}: ${lastErr.message}`, 'network');
    onProgress?.(((i + 1) / plan.chunks) * 0.9); // the last 10% is the server joining the pieces and handing them to storage
  }
  return { upload_id: uploadId, chunk_count: plan.chunks, filename: file.name };
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
  if (plan.route === 'chunked') {
    const extra = await sendChunks(file, plan, { onProgress, deps });
    const out = await api.postForm(path, buildForm(null, extra, meta, driver));
    onProgress?.(1);
    return { ...out, route: 'chunked' };
  }
  return { ...(await api.postForm(path, buildForm(file, {}, meta, driver))), route: 'proxy' };
}

/* ------------------------------ public entry points ------------------------------ */

export const uploadTrack = ({ file, meta, driver, opts, onProgress, deps = {} }) =>
  submit({ path: '/studio/tracks', file, meta, driver, opts, onProgress, deps });

export const uploadEpisode = ({ showId, file, meta, driver, opts, onProgress, deps = {} }) =>
  submit({ path: `/studio/shows/${showId}/episodes`, file, meta, driver, opts, onProgress, deps });
