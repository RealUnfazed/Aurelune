import { Track, Episode, Like, EpisodeProgress, Album, Show, Playlist, Creator } from './db.js';
import { imgUrl, artUrl, artColor } from './util.js';

/* Public catalog rules: only published, non-moderated items. Creators must be approved
   to upload, and suspending a creator flips `hidden` on everything they own. */
export const VISIBLE = { published: true, hidden: false };
export const VISIBLE_META = { hidden: false };

export const TRACK_POP = [{ path: 'artist', select: 'name slug verified' }, { path: 'album', select: 'title cover' }];
export const EPISODE_POP = [
  { path: 'show', select: 'title cover language' },
  { path: 'artist', select: 'name slug' },
];

export const findTracks = (filter = {}) => Track.find({ ...filter, ...VISIBLE }).populate(TRACK_POP).lean();
export const findEpisodes = (filter = {}) => Episode.find({ ...filter, ...VISIBLE }).populate(EPISODE_POP).lean();
export const findAlbums = (filter = {}) => Album.find({ ...filter, ...VISIBLE_META }).populate('artist', 'name slug verified').lean();
export const findShows = (filter = {}) => Show.find({ ...filter, ...VISIBLE_META }).populate('artist', 'name slug').lean();

const sid = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/* ---------- DTOs ---------- */

export function creatorDTO(a) {
  if (!a) return null;
  return {
    id: sid(a), type: 'artist', name: a.name, slug: a.slug, bio: a.bio, verified: !!a.verified,
    focus: a.focus, links: a.links || [],
    image: imgUrl(a.image) || artUrl('artist', sid(a), a.name),
    color: artColor('artist' + sid(a)),
  };
}
const creatorRef = (a) => (a ? { id: sid(a), name: a.name, slug: a.slug, verified: !!a.verified } : null);

export function trackDTO(t, liked = false) {
  const albumId = sid(t.album);
  const cover = imgUrl(t.cover) || imgUrl(t.album?.cover) || artUrl(albumId ? 'album' : 'track', albumId || sid(t), t.title);
  return {
    id: sid(t), type: 'track', title: t.title,
    artist: creatorRef(t.artist),
    album: albumId ? { id: albumId, title: t.album.title } : null,
    credits: t.credits, genre: t.genre, duration_ms: t.durationMs, explicit: !!t.explicit,
    track_no: t.trackNo, plays: t.plays, has_lyrics: !!t.lyrics,
    synced_lyrics: /\[\d{1,3}:\d{2}/.test(t.lyrics || ''),
    cover, color: artColor(albumId ? 'album' + albumId : 'track' + sid(t)),
    stream_url: `/api/v1/stream/track/${sid(t)}`,
    created_at: t.createdAt, liked,
  };
}

export function albumDTO(al, trackCount) {
  return {
    id: sid(al), type: 'album', title: al.title, kind: al.kind, description: al.description,
    artist: creatorRef(al.artist),
    cover: imgUrl(al.cover) || artUrl('album', sid(al), al.title),
    color: artColor('album' + sid(al)),
    released_at: al.releasedAt, track_count: trackCount,
  };
}

export function showDTO(s, episodeCount) {
  return {
    id: sid(s), type: 'show', title: s.title, description: s.description, category: s.category,
    language: s.language, explicit: !!s.explicit,
    creator: creatorRef(s.artist),
    cover: imgUrl(s.cover) || artUrl('show', sid(s), s.title),
    color: artColor('show' + sid(s)),
    episode_count: episodeCount,
  };
}

export function episodeDTO(e, progress = null) {
  return {
    id: sid(e), type: 'episode', title: e.title, description: e.description,
    show: { id: sid(e.show), title: e.show?.title, language: e.show?.language },
    creator: creatorRef(e.artist),
    duration_ms: e.durationMs, season: e.season, number: e.number, plays: e.plays,
    has_transcript: !!e.transcript,
    cover: imgUrl(e.show?.cover) || artUrl('show', sid(e.show), e.show?.title),
    color: artColor('show' + sid(e.show)),
    stream_url: `/api/v1/stream/episode/${sid(e)}`,
    published_at: e.publishedAt,
    progress_ms: progress?.positionMs ?? 0, completed: !!progress?.completed,
  };
}

/* ---------- Hydration ---------- */

export async function likedSet(userId, ids) {
  if (!userId || !ids.length) return new Set();
  const rows = await Like.find({ user: userId, track: { $in: ids } }).select('track').lean();
  return new Set(rows.map((r) => String(r.track)));
}

export async function tracksToDTO(rows, userId) {
  const liked = await likedSet(userId, rows.map((r) => r._id));
  return rows.map((r) => trackDTO(r, liked.has(String(r._id))));
}

export async function episodesToDTO(rows, userId) {
  const prog = new Map();
  if (userId && rows.length) {
    const ps = await EpisodeProgress.find({ user: userId, episode: { $in: rows.map((r) => r._id) } }).lean();
    ps.forEach((p) => prog.set(String(p.episode), p));
  }
  return rows.map((r) => episodeDTO(r, prog.get(String(r._id))));
}

export async function albumsToDTO(rows) {
  if (!rows.length) return [];
  const counts = await Track.aggregate([
    { $match: { album: { $in: rows.map((r) => r._id) }, ...VISIBLE } },
    { $group: { _id: '$album', n: { $sum: 1 } } },
  ]);
  const m = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((r) => albumDTO(r, m.get(String(r._id)) || 0));
}

export async function showsToDTO(rows) {
  if (!rows.length) return [];
  const counts = await Episode.aggregate([
    { $match: { show: { $in: rows.map((r) => r._id) }, ...VISIBLE } },
    { $group: { _id: '$show', n: { $sum: 1 } } },
  ]);
  const m = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((r) => showDTO(r, m.get(String(r._id)) || 0));
}

/** Playlists (lean docs with `user` populated) -> DTOs with a 4-cover collage and totals. */
export async function playlistsToDTO(rows) {
  const firstIds = rows.flatMap((p) => p.items.slice(0, 4).map((i) => i.track));
  const allIds = [...new Set(rows.flatMap((p) => p.items.map((i) => String(i.track))))];
  const cover = new Map();
  const dur = new Map();
  if (allIds.length) {
    const ts = await Track.find({ _id: { $in: allIds } }).select('title cover album durationMs published hidden').populate('album', 'cover').lean();
    ts.forEach((t) => dur.set(String(t._id), t));
    for (const t of ts) cover.set(String(t._id), imgUrl(t.cover) || imgUrl(t.album?.cover) || artUrl(t.album ? 'album' : 'track', sid(t.album) || sid(t), t.title));
  }
  void firstIds;
  return rows.map((p) => {
    const live = p.items.filter((i) => { const t = dur.get(String(i.track)); return t && t.published && !t.hidden; });
    return {
      id: sid(p), type: 'playlist', title: p.title, description: p.description, is_public: !!p.isPublic,
      owner: { id: sid(p.user), username: p.user?.username, display_name: p.user?.displayName },
      track_count: live.length,
      duration_ms: live.reduce((n, i) => n + (dur.get(String(i.track))?.durationMs || 0), 0),
      covers: live.slice(0, 4).map((i) => cover.get(String(i.track))),
      color: artColor('playlist' + sid(p)),
      updated_at: p.updatedAt,
    };
  });
}

export const findPlaylists = (filter) => Playlist.find(filter).populate('user', 'username displayName').lean();

export const userPublic = (u) => ({ id: sid(u), username: u.username, display_name: u.displayName, bio: u.bio, created_at: u.createdAt });

export { sid, Creator };
