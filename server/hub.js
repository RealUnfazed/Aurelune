// "Now playing" state, backed by MongoDB instead of an in-process Map, so it
// works correctly regardless of how many server/function instances are
// running (a hard requirement on serverless platforms like Vercel, where a
// PUT and a later GET can easily land on two different instances that share
// no memory — and a real bug fix for traditional clustered deployments too).
//
// The live SSE stream is polling-based and self-terminates after a short
// window; the browser's EventSource reconnects automatically (we send a
// `retry:` hint below), so from the user's side this still feels instant.
// This is deliberate: serverless function execution has a hard time limit
// (as low as 10s on some plans), so a stream that tries to stay open
// indefinitely would simply be killed mid-connection.
import { PlayerState } from './db.js';

const STALE_MS = 45000;   // a "playing" heartbeat older than this means the tab went away
const POLL_MS = 2500;     // how often the SSE loop checks for changes
const MAX_STREAM_MS = 9000; // self-close well under serverless function time limits; client reconnects

function shape(doc) {
  if (!doc) return null;
  const updatedAt = doc.updatedAt.getTime();
  const stale = doc.isPlaying && (Date.now() - updatedAt > STALE_MS);
  return {
    item: doc.item, is_playing: stale ? false : doc.isPlaying, position_ms: doc.positionMs,
    device: doc.device, updated_at: updatedAt, ...(stale ? { stale: true } : {}),
  };
}

export async function setPlayer(userId, payload) {
  const doc = await PlayerState.findOneAndUpdate(
    { user: userId },
    { item: payload.item, isPlaying: !!payload.is_playing, positionMs: payload.position_ms || 0, device: payload.device || 'web' },
    { upsert: true, new: true }
  ).lean();
  return shape(doc);
}

export async function getPlayer(userId) {
  const doc = await PlayerState.findOne({ user: userId }).lean();
  return shape(doc);
}

/** Streams `player` events for `userId` to `res` until MAX_STREAM_MS elapses, then ends the
 *  response — the client's EventSource auto-reconnects, so updates keep flowing near-live. */
export function subscribe(userId, res) {
  const start = Date.now();
  let last = null;
  const tick = async () => {
    if (res.writableEnded) return;
    if (Date.now() - start > MAX_STREAM_MS) return res.end();
    try {
      const cur = await getPlayer(userId);
      const snap = JSON.stringify(cur);
      if (snap !== last) { last = snap; res.write(`event: player\ndata: ${snap}\n\n`); }
      else res.write(': ping\n\n');
    } catch { /* transient DB hiccup — keep the connection alive and try again next tick */ }
    if (!res.writableEnded) setTimeout(tick, POLL_MS);
  };
  tick();
}
