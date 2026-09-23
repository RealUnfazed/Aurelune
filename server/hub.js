// In-memory "now playing" state + Server-Sent-Events fan-out.
const state = new Map();     // userId -> { item, position_ms, is_playing, device, updated_at }
const listeners = new Map(); // userId -> Set<res>

export function setPlayer(userId, payload) {
  const s = { ...payload, updated_at: Date.now() };
  state.set(userId, s);
  const set = listeners.get(userId);
  if (set) for (const res of set) res.write(`event: player\ndata: ${JSON.stringify(s)}\n\n`);
  return s;
}

export function getPlayer(userId) {
  const s = state.get(userId);
  if (!s) return null;
  // A "playing" heartbeat that stopped arriving more than 45s ago means the tab went away.
  const stale = Date.now() - s.updated_at > 45000;
  return stale && s.is_playing ? { ...s, is_playing: false, stale: true } : s;
}

export function subscribe(userId, res) {
  if (!listeners.has(userId)) listeners.set(userId, new Set());
  listeners.get(userId).add(res);
  const cur = getPlayer(userId);
  if (cur) res.write(`event: player\ndata: ${JSON.stringify(cur)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => {
    clearInterval(ping);
    listeners.get(userId)?.delete(res);
  });
}
