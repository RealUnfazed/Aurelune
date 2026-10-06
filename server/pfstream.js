// Streaming PostFile audio through this server, when the browser can't (or shouldn't) fetch PostFile's CDN itself:
//
//  * A file stored as several parts is stitched back into ONE seekable stream here. Range requests are honoured across
//    the part boundaries, so the audio element sees an ordinary file and the listener never notices the seams.
//  * A single-part file can be proxied the same way (`?proxy=1`, or STREAM_PROXY=always). Same-origin audio is what the
//    Web Audio equalizer needs: browsers silence cross-origin audio that isn't served with CORS headers.
//
// Only the *route* is login-gated; the part URLs on PostFile's CDN stay public, as they always were.
import { once } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { assertTrustedUrl } from './storage.js';
import { HttpError } from './util.js';

const TIMEOUT_MS = 30000;

/** Opens bytes [a, b] (inclusive) of a CDN file as a stream. Works even if the CDN ignores Range (skips/limits locally). */
async function openRange(url, a, b, signal) {
  const res = await fetch(assertTrustedUrl(url), {
    headers: { Range: `bytes=${a}-${b ?? ''}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (res.status !== 206 && res.status !== 200) { res.body?.cancel().catch(() => {}); throw new HttpError(502, `The file host answered ${res.status}`, 'storage_error'); }
  let stream = Readable.fromWeb(res.body);
  if (res.status === 200 && (a > 0 || b != null)) stream = stream.pipe(sliceTransform(a, b)); // CDN sent the whole file
  return { stream, res };
}

function sliceTransform(a, b) {
  let pos = 0, done = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      const s = pos, e = pos + chunk.length; // chunk covers [s, e)
      pos = e;
      if (done || e <= a) return cb();
      const from = Math.max(0, a - s);
      const to = b == null ? chunk.length : Math.min(chunk.length, b + 1 - s);
      if (b != null && e > b) done = true;
      cb(null, to > from ? chunk.subarray(from, to) : undefined);
    },
  });
}

/**
 * Parses a Range header against a file of `total` bytes. An end past the file is clamped (browsers ask for fixed-size
 * windows like `bytes=0-1048575` even on small files), `bytes=-N` means the last N bytes, and `null` means "not satisfiable".
 */
export const parseRange = (header, total) => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return { start: 0, end: total - 1, partial: false };
  let start, end;
  if (!m[1]) { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; } // suffix range: the last N bytes
  else { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1; }
  if (!(start <= end) || start >= total) return null;
  return { start, end, partial: true };
};

/** Writes `stream` to `res`, honouring back-pressure. Returns the number of bytes written. */
async function pump(stream, res, isGone) {
  let n = 0;
  for await (const chunk of stream) {
    if (isGone()) { stream.destroy(); break; }
    n += chunk.length;
    if (!res.write(chunk)) await once(res, 'drain').catch(() => {});
  }
  return n;
}

function wireAbort(req, res) {
  const ac = new AbortController();
  let gone = false;
  const bye = () => { gone = true; ac.abort(); };
  req.on('close', bye);
  res.on('close', bye);
  return { signal: ac.signal, gone: () => gone };
}

/** One logical file made of `parts` ([{url, size}]) played as a single stream. */
export async function streamParts(req, res, parts, mime) {
  const total = parts.reduce((n, p) => n + p.size, 0);
  const rg = parseRange(req.headers.range, total);
  if (!rg) return res.status(416).set('Content-Range', `bytes */${total}`).end();
  const { start, end, partial } = rg;
  res.status(partial ? 206 : 200).set({
    'Content-Type': mime || 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
    'Cache-Control': 'private, max-age=0, no-store',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
  });
  if (partial) res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.flushHeaders?.();
  const { signal, gone } = wireAbort(req, res);

  try {
    let offset = 0; // where the current part begins inside the whole file
    for (const part of parts) {
      const pStart = offset, pEnd = offset + part.size - 1;
      offset += part.size;
      if (pEnd < start) continue;
      if (pStart > end) break;
      let a = Math.max(start, pStart) - pStart; // byte range wanted from this part
      const b = Math.min(end, pEnd) - pStart;
      // A part can drop mid-way (CDN hiccup). Pick up again from the exact byte, a couple of times, before giving up.
      for (let attempt = 0; a <= b; attempt++) {
        if (gone()) return;
        try {
          const { stream } = await openRange(part.url, a, b, signal);
          a += await pump(stream, res, gone);
          if (a <= b && gone()) return;
        } catch (e) {
          if (gone()) return;
          if (attempt >= 2) throw e;
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }
    res.end();
  } catch (e) {
    console.error(`Stitched stream failed: ${e.message}`);
    res.destroy(); // headers are out; the player just re-requests from where it stopped
  }
}

/** Proxies one CDN file with the listener's Range header (seeking works). */
export async function proxyFile(req, res, url, mime) {
  const { signal, gone } = wireAbort(req, res);
  let up;
  try {
    up = await fetch(assertTrustedUrl(url), { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  } catch (e) {
    if (gone()) return;
    throw new HttpError(502, 'Could not reach the file host', 'storage_unreachable');
  }
  if (up.status === 416) return res.status(416).set('Content-Range', up.headers.get('content-range') || '*/0').end();
  if (up.status !== 200 && up.status !== 206) { up.body?.cancel().catch(() => {}); throw new HttpError(502, `The file host answered ${up.status}`, 'storage_error'); }
  res.status(up.status).set({
    'Content-Type': mime || up.headers.get('content-type') || 'audio/mpeg', 'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=0, no-store',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
  });
  for (const h of ['content-length', 'content-range']) { const v = up.headers.get(h); if (v) res.set(h, v); }
  try { await pump(Readable.fromWeb(up.body), res, gone); res.end(); }
  catch { res.destroy(); }
}
