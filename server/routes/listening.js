import { Router } from 'express';
import {
  Track, Episode, Creator, Play, Like, Follow, ShowFollow, AlbumSave, Playlist, User,
} from '../db.js';
import { scope } from '../auth.js';
import {
  trackDTO, episodeDTO, tracksToDTO, creatorDTO, findPlaylists, playlistsToDTO, TRACK_POP, EPISODE_POP, userPublic, sid,
} from '../serialize.js';
import { setPlayer, getPlayer, subscribe } from '../hub.js';
import { oid, isOid, bad, notFound, clampInt, truthy, forbidden } from '../util.js';

const r = Router();

/* ------------------------------ Item lookup (history shows removed items too) ------------------------------ */

async function hydrateItems(plays) {
  const tIds = [...new Set(plays.filter((p) => p.kind === 'track').map((p) => String(p.item)))];
  const eIds = [...new Set(plays.filter((p) => p.kind === 'episode').map((p) => String(p.item)))];
  const [ts, es] = await Promise.all([
    tIds.length ? Track.find({ _id: { $in: tIds } }).populate(TRACK_POP).lean() : [],
    eIds.length ? Episode.find({ _id: { $in: eIds } }).populate(EPISODE_POP).lean() : [],
  ]);
  const map = new Map();
  ts.forEach((t) => map.set('track' + t._id, trackDTO(t)));
  es.forEach((e) => map.set('episode' + e._id, episodeDTO(e)));
  return map;
}

const rangeStart = (range) => {
  const days = { day: 1, week: 7, month: 30, '6months': 182, year: 365 }[range];
  return days ? new Date(Date.now() - days * 86400000) : new Date(0);
};

/* ------------------------------ Player state (now playing) ------------------------------ */

const itemCache = new Map();
async function itemFor(kind, id) {
  const key = kind + id;
  if (itemCache.has(key)) return itemCache.get(key);
  const row = kind === 'track'
    ? await Track.findById(id).populate(TRACK_POP).lean()
    : await Episode.findById(id).populate(EPISODE_POP).lean();
  if (!row) return null;
  const dto = kind === 'track' ? trackDTO(row) : episodeDTO(row);
  if (itemCache.size > 400) itemCache.delete(itemCache.keys().next().value);
  itemCache.set(key, dto);
  return dto;
}

r.put('/me/player', scope('player'), async (req, res) => {
  const kind = req.body.kind === 'episode' ? 'episode' : 'track';
  if (!isOid(req.body.id)) throw bad('Missing item id');
  const item = await itemFor(kind, req.body.id);
  if (!item) throw notFound('Item not found');
  const s = setPlayer(String(req.user._id), {
    item, is_playing: truthy(req.body.is_playing),
    position_ms: clampInt(req.body.position_ms, 0, 0, 1e9),
    device: String(req.body.device || 'web').slice(0, 40),
  });
  res.json({ ok: true, updated_at: s.updated_at });
});

r.get('/me/player', scope('player'), async (req, res) => {
  const s = getPlayer(String(req.user._id));
  if (s) return res.json(s);
  const last = await Play.findOne({ user: req.user._id }).sort({ playedAt: -1 }).lean();
  const item = last ? (await hydrateItems([last])).get(last.kind + last.item) : null;
  res.json({ item: item || null, is_playing: false, position_ms: 0, updated_at: last?.playedAt?.getTime?.() || null, last_played: true });
});

// Server-Sent Events: a live feed of playback changes for widgets, bots, overlays, presence integrations…
r.get('/me/player/stream', scope('player'), (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  subscribe(String(req.user._id), res);
});

/* ------------------------------ Recording plays ------------------------------ */

r.post('/me/plays', scope('history'), async (req, res) => {
  const kind = req.body.kind === 'episode' ? 'episode' : 'track';
  const id = oid(req.body.id);
  const ms = clampInt(req.body.ms_played, 0, 0, 1e8);
  const doc = kind === 'track'
    ? await Track.findById(id).select('durationMs artist genre').lean()
    : await Episode.findById(id).select('durationMs artist').lean();
  if (!doc) throw notFound('Item not found');
  const need = Math.min(30000, (doc.durationMs || 60000) * 0.5);
  if (ms < need) return res.status(202).json({ counted: false, reason: 'too_short' });
  const play = await Play.create({
    user: req.user._id, kind, item: id, creator: doc.artist, genre: doc.genre || '',
    msPlayed: ms, source: String(req.body.source || '').slice(0, 60),
    playedAt: req.viaToken && req.body.played_at ? new Date(req.body.played_at) : new Date(),
  });
  (kind === 'track' ? Track : Episode).updateOne({ _id: id }, { $inc: { plays: 1 } }).catch(() => {});
  res.status(201).json({ counted: true, id: sid(play) });
});

r.patch('/me/plays/:id', scope('history'), async (req, res) => {
  const ms = clampInt(req.body.ms_played, 0, 0, 1e8);
  await Play.updateOne({ _id: oid(req.params.id), user: req.user._id, msPlayed: { $lt: ms } }, { $set: { msPlayed: ms } });
  res.json({ ok: true });
});

/* ------------------------------ History ------------------------------ */

function playDTO(p, items) {
  const item = items.get(p.kind + p.item);
  return {
    id: sid(p), kind: p.kind, played_at: p.playedAt, ms_played: p.msPlayed, source: p.source,
    item: item || { id: String(p.item), type: p.kind, title: '(removed)', removed: true },
  };
}

r.get('/me/history', scope('history'), async (req, res) => {
  const limit = clampInt(req.query.limit, 50, 1, 1000);
  const q = { user: req.user._id };
  if (req.query.kind === 'track' || req.query.kind === 'episode') q.kind = req.query.kind;
  const range = {};
  if (req.query.before && !isNaN(Date.parse(req.query.before))) range.$lt = new Date(req.query.before);
  if (req.query.after && !isNaN(Date.parse(req.query.after))) range.$gt = new Date(req.query.after);
  if (Object.keys(range).length) q.playedAt = range;
  const rows = await Play.find(q).sort({ playedAt: -1 }).limit(limit + 1).lean();
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = await hydrateItems(page);
  res.json({
    items: page.map((p) => playDTO(p, items)),
    next_before: more ? page[page.length - 1].playedAt : null,
  });
});

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
r.get('/me/history.csv', scope('history'), async (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="aurelune-history.csv"' });
  res.write('\ufeffplayed_at,kind,title,artist_or_show,album,minutes_played,source\n');
  let before = null;
  for (;;) {
    const q = { user: req.user._id, ...(before ? { playedAt: { $lt: before } } : {}) };
    const rows = await Play.find(q).sort({ playedAt: -1 }).limit(1000).lean();
    if (!rows.length) break;
    const items = await hydrateItems(rows);
    for (const p of rows) {
      const it = items.get(p.kind + p.item);
      res.write([p.playedAt.toISOString(), p.kind, it?.title, it?.artist?.name || it?.creator?.name, it?.album?.title || it?.show?.title, (p.msPlayed / 60000).toFixed(2), p.source].map(csvCell).join(',') + '\n');
    }
    before = rows[rows.length - 1].playedAt;
    if (rows.length < 1000) break;
  }
  res.end();
});

/* ------------------------------ Top lists & stats ------------------------------ */

const matchFor = (req, extra = {}) => ({ user: req.user._id, playedAt: { $gte: rangeStart(req.query.range) }, ...extra });

r.get('/me/top/tracks', scope('history'), async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const agg = await Play.aggregate([
    { $match: matchFor(req, { kind: 'track' }) },
    { $group: { _id: '$item', plays: { $sum: 1 }, ms: { $sum: '$msPlayed' } } },
    { $sort: { plays: -1, ms: -1 } }, { $limit: limit },
  ]);
  const rows = await Track.find({ _id: { $in: agg.map((a) => a._id) } }).populate(TRACK_POP).lean();
  const dtos = new Map((await tracksToDTO(rows, req.user._id)).map((t) => [t.id, t]));
  res.json({ range: req.query.range || 'all', items: agg.map((a) => ({ plays: a.plays, minutes: Math.round(a.ms / 60000), track: dtos.get(String(a._id)) })).filter((x) => x.track) });
});

r.get('/me/top/artists', scope('history'), async (req, res) => {
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const agg = await Play.aggregate([
    { $match: matchFor(req, { creator: { $ne: null } }) },
    { $group: { _id: '$creator', plays: { $sum: 1 }, ms: { $sum: '$msPlayed' } } },
    { $sort: { plays: -1, ms: -1 } }, { $limit: limit },
  ]);
  const rows = await Creator.find({ _id: { $in: agg.map((a) => a._id) } }).lean();
  const m = new Map(rows.map((c) => [String(c._id), c]));
  res.json({ range: req.query.range || 'all', items: agg.map((a) => ({ plays: a.plays, minutes: Math.round(a.ms / 60000), artist: creatorDTO(m.get(String(a._id))) })).filter((x) => x.artist.id) });
});

r.get('/me/top/genres', scope('history'), async (req, res) => {
  const agg = await Play.aggregate([
    { $match: matchFor(req, { kind: 'track', genre: { $ne: '' } }) },
    { $group: { _id: '$genre', plays: { $sum: 1 }, ms: { $sum: '$msPlayed' } } },
    { $sort: { plays: -1 } }, { $limit: 12 },
  ]);
  res.json({ range: req.query.range || 'all', items: agg.map((a) => ({ genre: a._id, plays: a.plays, minutes: Math.round(a.ms / 60000) })) });
});

r.get('/me/stats', scope('history'), async (req, res) => {
  const match = matchFor(req);
  const tz = clampInt(req.query.tz_offset, 0, -840, 840) * 60000; // minutes east of UTC -> ms
  const dayKey = (d) => new Date(d.getTime() + tz).toISOString().slice(0, 10);

  const [tot, uniqueTracks, uniqueArtists, recent] = await Promise.all([
    Play.aggregate([{ $match: match }, { $group: { _id: null, plays: { $sum: 1 }, ms: { $sum: '$msPlayed' } } }]),
    Play.distinct('item', { ...match, kind: 'track' }),
    Play.distinct('creator', match),
    Play.find({ user: req.user._id, playedAt: { $gte: new Date(Date.now() - 400 * 86400000) } }).sort({ playedAt: -1 }).limit(60000).select('playedAt msPlayed').lean(),
  ]);

  // Last 30 days per day, and hour-of-day distribution (in the caller's timezone)
  const days = new Map();
  for (let i = 29; i >= 0; i--) days.set(dayKey(new Date(Date.now() - i * 86400000)), 0);
  const hours = Array(24).fill(0);
  const allDays = new Set();
  const since = match.playedAt.$gte;
  for (const p of recent) {
    const k = dayKey(p.playedAt);
    allDays.add(k);
    if (days.has(k)) days.set(k, days.get(k) + p.msPlayed);
    if (p.playedAt >= since) hours[new Date(p.playedAt.getTime() + tz).getUTCHours()] += p.msPlayed;
  }
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const k = dayKey(new Date(Date.now() - i * 86400000));
    if (allDays.has(k)) streak++; else if (i === 0) continue; else break;
  }
  res.json({
    range: req.query.range || 'all',
    plays: tot[0]?.plays || 0, minutes: Math.round((tot[0]?.ms || 0) / 60000),
    unique_tracks: uniqueTracks.length, unique_artists: uniqueArtists.filter(Boolean).length,
    streak_days: streak,
    by_day: [...days].map(([date, ms]) => ({ date, minutes: Math.round(ms / 60000) })),
    by_hour: hours.map((ms, hour) => ({ hour, minutes: Math.round(ms / 60000) })),
  });
});

/* ------------------------------ Full export ------------------------------ */

r.get('/me/export', scope('export'), async (req, res) => {
  const uid = req.user._id;
  const [likes, follows, sfollows, saves, pls] = await Promise.all([
    Like.find({ user: uid }).sort({ createdAt: -1 }).lean(),
    Follow.find({ user: uid }).lean(), ShowFollow.find({ user: uid }).lean(), AlbumSave.find({ user: uid }).lean(),
    Playlist.find({ user: uid }).lean(),
  ]);
  const tIds = [...new Set([...likes.map((l) => String(l.track)), ...pls.flatMap((p) => p.items.map((i) => String(i.track)))])];
  const tracks = await Track.find({ _id: { $in: tIds } }).populate(TRACK_POP).lean();
  const tm = new Map(tracks.map((t) => [String(t._id), t]));
  const slim = (t) => t && { id: sid(t), title: t.title, artist: t.artist?.name, album: t.album?.title || null };

  const history = [];
  let before = null;
  for (;;) {
    const rows = await Play.find({ user: uid, ...(before ? { playedAt: { $lt: before } } : {}) }).sort({ playedAt: -1 }).limit(2000).lean();
    if (!rows.length) break;
    const items = await hydrateItems(rows);
    for (const p of rows) {
      const it = items.get(p.kind + p.item);
      history.push({ played_at: p.playedAt, kind: p.kind, id: String(p.item), title: it?.title, by: it?.artist?.name || it?.creator?.name, ms_played: p.msPlayed, source: p.source });
    }
    before = rows[rows.length - 1].playedAt;
    if (rows.length < 2000) break;
  }
  const payload = {
    exported_at: new Date().toISOString(), service: 'Aurelune',
    profile: { username: req.user.username, display_name: req.user.displayName, email: req.user.email, created_at: req.user.createdAt },
    liked: likes.map((l) => ({ liked_at: l.createdAt, ...slim(tm.get(String(l.track))) })),
    playlists: pls.map((p) => ({ title: p.title, description: p.description, public: p.isPublic, tracks: p.items.map((i) => slim(tm.get(String(i.track)))).filter(Boolean) })),
    following: { artists: follows.map((f) => String(f.artist)), shows: sfollows.map((f) => String(f.show)), albums: saves.map((f) => String(f.album)) },
    history,
  };
  res.set('Content-Disposition', 'attachment; filename="aurelune-export.json"');
  res.json(payload);
});

/* ------------------------------ Public profiles ------------------------------ */

async function publicUser(name) {
  const u = await User.findOne({ username: String(name).toLowerCase() });
  if (!u) throw notFound('No such listener');
  return u;
}

r.get('/users/:username', async (req, res) => {
  const u = await publicUser(req.params.username);
  const pls = await findPlaylists({ user: u._id, isPublic: true, 'items.0': { $exists: true } }).sort({ updatedAt: -1 }).limit(12);
  const out = { user: userPublic(u), playlists: await playlistsToDTO(pls), sharing: !!u.shareActivity, top_artists: [] };
  if (u.shareActivity) {
    const agg = await Play.aggregate([
      { $match: { user: u._id, creator: { $ne: null }, playedAt: { $gte: new Date(Date.now() - 30 * 86400000) } } },
      { $group: { _id: '$creator', plays: { $sum: 1 } } }, { $sort: { plays: -1 } }, { $limit: 8 },
    ]);
    const cs = await Creator.find({ _id: { $in: agg.map((a) => a._id) } }).lean();
    const m = new Map(cs.map((c) => [String(c._id), c]));
    out.top_artists = agg.map((a) => creatorDTO(m.get(String(a._id)))).filter((a) => a.id);
  }
  res.json(out);
});

r.get('/users/:username/now-playing', async (req, res) => {
  const u = await publicUser(req.params.username);
  if (!u.shareActivity) throw forbidden('This listener keeps their activity private');
  const s = getPlayer(String(u._id));
  res.json(s ? { is_playing: s.is_playing, item: s.item, position_ms: s.position_ms, updated_at: s.updated_at } : { is_playing: false, item: null });
});

export default r;
