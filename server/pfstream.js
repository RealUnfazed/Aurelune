// Streaming PostFile audio through this server, when the browser can't (or shouldn't) fetch PostFile's CDN itself:
//
//  * A file stored as several parts is stitched back into ONE seekable stream here. Range requests are honoured across
//    the part boundaries, so the audio element sees an ordinary file and the listener never notices the seams.
//  * A single-part file can be proxied the same way (`?proxy=1`, or STREAM_PROXY=always). Same-origin audio is what the
//    Web Audio equalizer needs: browsers silence cross-origin audio that isn't served with CORS headers.
//
// Only the *route* is login-gated; the part URLs on PostFile's CDN stay public, as they always were.
import { once } from 'node:events';
import crypto from 'node:crypto';
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
async function pump(stream, res, isGone, max = Infinity) {
  let n = 0;
  for await (const chunk of stream) {
    if (isGone()) { stream.destroy(); break; }
    n += chunk.length;
    if (!res.write(chunk)) await once(res, 'drain').catch(() => {});
    if (n >= max) { stream.destroy(); break; } // got everything that was asked for: don't keep pulling the rest from the host
  }
  return n;
}

function wireAbort(req, res) {
  const ac = new AbortController();
  let gone = false;
  const bye = () => { gone = true; ac.abort(); };
  req.on('close', bye);
  res.on('close', bye);
  return { signal: ac.signal, gone: () => gone, abort: () => ac.abort() };
}

/**
 * Browser caching for PostFile audio served through here. The bytes of a PostFile object never change (a new upload gets a new
 * URL), so the browser may keep them: looping a song, seeking back, or replaying it later is then answered from the browser's own
 * cache instead of downloading the file from this server (and out of your hosting bandwidth) again. `private` keeps shared caches
 * (CDNs, proxies) out of it; the route is still login-gated for every first fetch. Returns true when it answered 304.
 */
export function cacheable(req, res, url, maxAge = 86400) {
  const etag = `"${crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20)}"`;
  res.set({ ETag: etag, 'Cache-Control': `private, max-age=${maxAge}` });
  if (req.headers['if-none-match'] === etag) { res.status(304).end(); return true; }
  return false;
}

/** One logical file made of `parts` ([{url, size}]) played as a single stream. */
export async function streamParts(req, res, parts, mime) {
  const total = parts.reduce((n, p) => n + p.size, 0);
  if (cacheable(req, res, parts.map((p) => p.url).join('|'))) return;
  const rg = parseRange(req.headers.range, total);
  if (!rg) { res.removeHeader('ETag'); res.removeHeader('Cache-Control'); return res.status(416).set('Content-Range', `bytes */${total}`).end(); }
  const { start, end, partial } = rg;
  res.status(partial ? 206 : 200).set({
    'Content-Type': mime || 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
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

/** Size of a CDN file from a HEAD request (0 when the host doesn't say). */
async function headLength(url, signal) {
  try {
    const r = await fetch(assertTrustedUrl(url), { method: 'HEAD', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    return r.ok ? Number(r.headers.get('content-length')) || 0 : 0;
  } catch { return 0; }
}

/**
 * Proxies one CDN file and ALWAYS behaves like a proper range-capable file server, whatever the host does.
 * If the host honours Range we pass its 206 through. If it ignores Range and sends the whole file (200), we cut the
 * requested window out ourselves and answer 206 with the right Content-Range, so seeking in the player works. (Passing the
 * host's 200 straight through is what made the player jump back to the start whenever you seeked.)
 */
export async function proxyFile(req, res, url, mime, knownSize = 0) {
  if (cacheable(req, res, url)) return;
  const { signal, gone, abort } = wireAbort(req, res);
  const wanted = req.headers.range;
  let up;
  try {
    up = await fetch(assertTrustedUrl(url), { headers: wanted ? { Range: wanted } : {}, signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
  } catch (e) {
    if (gone()) return;
    res.removeHeader('ETag'); res.removeHeader('Cache-Control'); // never let an error be cached
    throw new HttpError(502, 'Could not reach the file host', 'storage_unreachable');
  }
  if (up.status === 416) { res.removeHeader('ETag'); res.removeHeader('Cache-Control'); return res.status(416).set('Content-Range', up.headers.get('content-range') || '*/0').end(); }
  if (up.status !== 200 && up.status !== 206) { up.body?.cancel().catch(() => {}); res.removeHeader('ETag'); res.removeHeader('Cache-Control'); throw new HttpError(502, `The file host answered ${up.status}`, 'storage_error'); }
  const type = mime || up.headers.get('content-type') || 'audio/mpeg';
  const expose = 'Content-Range, Accept-Ranges, Content-Length';

  // The host ignored Range and is sending everything: cut the window out here.
  // The real CDN answers 200 WITHOUT a Content-Length (streamed). So the length comes from what we stored when the file was uploaded,
  // and failing that from a HEAD request. Without a length nothing below can seek, which is the "jumps to the start" bug.
  let whole = up.status === 200 ? Number(up.headers.get('content-length')) || Number(knownSize) || 0 : 0;
  if (up.status === 200 && !whole && wanted) whole = await headLength(url, signal);
  if (wanted && up.status === 200 && whole) {
    const rg = parseRange(wanted, whole);
    if (!rg) { up.body?.cancel().catch(() => {}); return res.status(416).set('Content-Range', `bytes */${whole}`).end(); }
    if (rg.partial) {
      res.status(206).set({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': rg.end - rg.start + 1, 'Content-Range': `bytes ${rg.start}-${rg.end}/${whole}`, 'Access-Control-Expose-Headers': expose });
      const src = Readable.fromWeb(up.body); src.on('error', () => {}); // the abort below ends it with an error nobody needs to hear about
      const win = src.pipe(sliceTransform(rg.start, rg.end)); win.on('error', () => {});
      try { await pump(win, res, gone, rg.end - rg.start + 1); res.end(); }
      catch { res.destroy(); }
      abort(); // the rest of the file isn't needed
      return;
    }
  }

  res.status(up.status).set({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Expose-Headers': expose });
  for (const h of ['content-length', 'content-range']) { const v = up.headers.get(h); if (v) res.set(h, v); }
  if (up.status === 200 && whole && !res.get('content-length')) res.set('Content-Length', whole); // lets the browser see the size, so it can seek
  const body = Readable.fromWeb(up.body); body.on('error', () => {});
  try { await pump(body, res, gone); res.end(); }
  catch { res.destroy(); }
}
