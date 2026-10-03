// Client-side upload orchestration. Three possible routes for a file:
//
//  proxy    Send it through Aurelune (multipart to /studio/...). Full features: tags, duration and
//           embedded artwork are read server-side. Fine everywhere except very large files on hosts
//           that cap request bodies (Vercel: ~4.5 MB).
//  direct   The browser posts the file straight to PostFile via a one-time intake link, then tells
//           Aurelune about it. Works for big files on Vercel, but Aurelune never sees the bytes, so
//           the browser measures duration and the creator types the title/genre.
//  blocked  Neither works (too big for the host and no direct route, or over PostFile's plan cap).
import { api } from './api.js';

const MB = 1024 * 1024;
// Vercel's cap is 4.5 MB for the whole request body; stay under it to leave room for multipart overhead + fields.
export const PROXY_LIMIT_BYTES = 4 * MB;

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
  if (kind === 'audio' && driver === 'postfile' && opts.direct_upload) return { route: 'direct' };
  if (kind === 'image') return { route: 'blocked', reason: "Images over 4 MB can't be uploaded on this host. Resize it and try again." };
  return { route: 'blocked', reason: "This file is too large to send through this server (about 4 MB is the most this host accepts), and direct upload isn't available." };
}

/** Short, honest note for the UI about what the chosen route means. */
export function describeRoute(plan) {
  if (plan.route === 'direct') return 'Large file: it will upload straight to PostFile. Title, genre and lyrics are used as typed — tags and artwork inside the file can’t be read automatically this way.';
  if (plan.route === 'blocked') return plan.reason;
  return '';
}

/* ------------------------------ browser-only helpers (swapped out in tests) ------------------------------ */

function measureDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); URL.revokeObjectURL(url); a.removeAttribute('src'); fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('timeout')), 15000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => (isFinite(a.duration) && a.duration > 0 ? finish(resolve, Math.round(a.duration * 1000)) : finish(reject, new Error('no duration')));
    a.onerror = () => finish(reject, new Error('unreadable'));
    a.src = url;
  });
}

/** POSTs the file to PostFile's intake URL. No cookies and no API key: the URL itself is the (one-time) credential. */
function postWithProgress(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);
      const detail = typeof body?.detail === 'string' ? body.detail : '';
      if (xhr.status === 413) return reject(new UploadError('PostFile says this file is too large for its plan.', 'too_large'));
      if (xhr.status === 403 || xhr.status === 410) return reject(new UploadError(`PostFile refused the upload${detail ? `: ${detail}` : ''}. The upload link may have expired — try again.`, 'refused'));
      reject(new UploadError(`PostFile returned an error (${xhr.status})${detail ? `: ${detail}` : ''}.`, 'server'));
    };
    // Status 0 = the browser never got a response. Typically the network is down, or PostFile doesn't allow
    // browser uploads from this site (CORS) — the browser doesn't tell us which.
    xhr.onerror = () => reject(new UploadError("Your browser couldn't upload directly to PostFile (network problem, or PostFile doesn't allow uploads from this site).", 'network'));
    xhr.ontimeout = () => reject(new UploadError('The upload to PostFile timed out.', 'network'));
    xhr.send(form);
  });
}

/* ------------------------------ direct route ------------------------------ */

async function directUploadAudio(file, { onProgress, deps }) {
  const measure = deps.measureDuration || measureDuration;
  const post = deps.post || postWithProgress;
  let durationMs;
  try { durationMs = await measure(file); } // measured first so a failure doesn't waste a PostFile intake link
  catch { throw new UploadError("Your browser couldn't read this file's length, so it can't be added this way. Try an MP3 or M4A.", 'duration'); }
  const link = await api.post('/studio/intake-link', { kind: 'audio' });
  const uploaded = await post(link.upload_url, file, onProgress);
  if (!uploaded?.file_id) throw new UploadError('PostFile accepted the upload but returned something unexpected.', 'response');
  return { fileId: uploaded.file_id, durationMs };
}

/* ------------------------------ public entry points ------------------------------ */

export async function uploadTrack({ file, meta, driver, opts, onProgress, deps = {} }) {
  const plan = planUpload({ file, kind: 'audio', driver, opts });
  if (plan.route === 'blocked') throw new UploadError(plan.reason, 'blocked');
  if (plan.route === 'direct') {
    const { fileId, durationMs } = await directUploadAudio(file, { onProgress, deps });
    return { ...(await api.post('/studio/tracks/from-remote', { ...meta, file_id: fileId, duration_ms: durationMs })), route: 'direct' };
  }
  const fd = new FormData();
  fd.append('audio', file);
  fd.append('storage', driver);
  for (const [k, v] of Object.entries(meta)) fd.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? ''));
  return { ...(await api.postForm('/studio/tracks', fd)), route: 'proxy' };
}

export async function uploadEpisode({ showId, file, meta, driver, opts, onProgress, deps = {} }) {
  const plan = planUpload({ file, kind: 'audio', driver, opts });
  if (plan.route === 'blocked') throw new UploadError(plan.reason, 'blocked');
  if (plan.route === 'direct') {
    const { fileId, durationMs } = await directUploadAudio(file, { onProgress, deps });
    return { ...(await api.post(`/studio/shows/${showId}/episodes/from-remote`, { ...meta, file_id: fileId, duration_ms: durationMs })), route: 'direct' };
  }
  const fd = new FormData();
  fd.append('audio', file);
  fd.append('storage', driver);
  for (const [k, v] of Object.entries(meta)) fd.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v ?? ''));
  return { ...(await api.postForm(`/studio/shows/${showId}/episodes`, fd)), route: 'proxy' };
}
