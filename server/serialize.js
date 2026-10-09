import { Track, Episode, Like, EpisodeLike, EpisodeProgress, Album, Show, Playlist, Creator } from './db.js';
import { imgUrlArt, artUrl, artColor } from './util.js';
import { Types } from 'mongoose';
import { notBlocked, notBlockedShows, blockedShowIds, isBlocked, viewerOwns, viewerOwnIds, viewerIsAdmin } from './privacy.js';
import { STREAM_PROXY } from './config.js';

/* Public catalog rules: only published, non-moderated items. Creators must be approved
   to upload, and suspending a creator flips `hidden` on everything they own. */
export const publicFilter = () => ({ published: true, hidden: false, ...notBlocked('artist'), ...notBlockedShows() });
export const metaFilter = () => ({ hidden: false, ...notBlocked('artist') });
/**
 * What a particular viewer may see. Everyone sees published, non-moderated items; creators additionally see their
 * own private (unpublished) ones. `ownIds` are the ids of the creator pages the viewer owns.
 */
export const visibleTo = (ownIds) => (ownIds?.length
  ? { hidden: false, ...notBlocked('artist'), ...notBlockedShows(), $or: [{ published: true }, { artist: { $in: ownIds } }, { collabAccepted: { $in: ownIds } }] }
  : publicFilter());
/** Items a creator page is credited on as a collaborator (accepted invitations only). */
export const collabOf = (creatorIds) => ({ collabAccepted: { $in: [].concat(creatorIds) } });

const COLLAB_POP = { path: 'collabs.creator', select: 'name slug verified isPrivate' };
export const TRACK_POP = [{ path: 'artist', select: 'name slug verified' }, { path: 'album', select: 'title cover' }, COLLAB_POP];
export const EPISODE_POP = [
  { path: 'show', select: 'title cover language published' },
  { path: 'artist', select: 'name slug' },
  COLLAB_POP,
];

// $and keeps a caller's own $or (as in search) from clashing with the visibility rule's $or.
export const findTracks = (filter = {}, ownIds) => Track.find({ $and: [filter, visibleTo(ownIds)] }).populate(TRACK_POP).lean();
export const findEpisodes = (filter = {}, ownIds) => Episode.find({ $and: [filter, visibleTo(ownIds)] }).populate(EPISODE_POP).lean();
export const findAlbums = (filter = {}) => Album.find({ ...filter, ...metaFilter() }).populate('artist', 'name slug verified').lean();
/**
 * Podcasts the viewer may see. A private podcast is for its owner and admins only. A podcast with nothing to listen to yet
 * (no episode this viewer can see) isn't advertised either, so a freshly created, empty show doesn't show up on everyone's home
 * page; its owner still sees it. Pass `empty: true` where it should stay reachable (opening it by link, a followed show).
 * Returns an array: `sort` is a Mongo sort object, `limit` is applied after the filtering.
 */
export async function findShows(filter = {}, { own, sort, limit, empty = false } = {}) {
  const hide = blockedShowIds();
  const q = Show.find({ $and: [filter, metaFilter(), hide.length ? { _id: { $nin: hide } } : {}] }).populate('artist', 'name slug');
  if (sort) q.sort(sort);
  if (limit) q.limit(limit * 4); // headroom: some may be dropped below
  let rows = await q.lean();
  if (!empty && rows.length) {
    const withEpisodes = new Set((await Episode.distinct('show', { $and: [{ show: { $in: rows.map((r) => r._id) } }, visibleTo(own)] })).map(String));
    rows = rows.filter((r) => withEpisodes.has(String(r._id)) || viewerOwns(r.artist) || viewerIsAdmin());
  }
  return limit ? rows.slice(0, limit) : rows;
}

/** True when the browser would fetch the audio from PostFile's CDN itself (a redirect). Multi-part files and STREAM_PROXY=always are served by us. */
const isExternal = (d) => d.storageDriver === 'postfile' && !(d.storageParts?.length > 1) && STREAM_PROXY !== 'always';

const sid = (v) => (v && v._id ? String(v._id) : v ? String(v) : null);

/* ---------- DTOs ---------- */

export function creatorDTO(a) {
  if (!a) return null;
  return {
    id: sid(a), type: 'artist', name: a.name, slug: a.slug, bio: a.bio, verified: !!a.verified,
    focus: a.focus, links: a.links || [], private: !!a.isPrivate,
    image: imgUrlArt(a.image, artUrl('artist', sid(a), a.name)) || artUrl('artist', sid(a), a.name),
    color: artColor('artist' + sid(a)),
  };
}
/**
 * Other pages credited on an item. Everyone sees the accepted ones; an unanswered invitation is visible only to the page that
 * owns the item and to the invited page's owner (and admins). Collaborators on a private page the viewer can't see are left out.
 */
function collabList(item) {
  const owner = viewerOwns(item.artist) || viewerIsAdmin();
  return (item.collabs || []).filter((c) => c.creator?.name && !isBlocked(c.creator) && (c.status === 'accepted' || owner || viewerOwns(c.creator)))
    .map((c) => ({ id: sid(c.creator), name: c.creator.name, slug: c.creator.slug, verified: !!c.creator.verified, status: c.status }));
}
const creatorRef = (a) => (a ? { id: sid(a), name: a.name, slug: a.slug, verified: !!a.verified } : null);

export function trackDTO(t, liked = false) {
  const albumId = sid(t.album);
  const art = artUrl(albumId ? 'album' : 'track', albumId || sid(t), t.title);
  const cover = imgUrlArt(t.cover, art) || imgUrlArt(t.album?.cover, art) || art;
  return {
    id: sid(t), type: 'track', title: t.title,
    artist: creatorRef(t.artist),
    album: albumId ? { id: albumId, title: t.album.title } : null,
    credits: t.credits, genre: t.genre, duration_ms: t.durationMs, explicit: !!t.explicit,
    collaborators: collabList(t),
    track_no: t.trackNo, plays: t.plays, has_lyrics: !!t.lyrics,
    synced_lyrics: /\[\d{1,3}:\d{2}/.test(t.lyrics || ''),
    cover, color: artColor(albumId ? 'album' + albumId : 'track' + sid(t)),
    stream_url: `/api/v1/stream/track/${sid(t)}`, external: isExternal(t), downloadable: t.downloadsAllowed !== false,
    created_at: t.createdAt, liked,
    private: t.published === false, // only its owner ever receives a private item
  };
}

export function albumDTO(al, trackCount) {
  return {
    id: sid(al), type: 'album', title: al.title, kind: al.kind, description: al.description,
    artist: creatorRef(al.artist),
    cover: imgUrlArt(al.cover, artUrl('album', sid(al), al.title)) || artUrl('album', sid(al), al.title),
    color: artColor('album' + sid(al)),
    released_at: al.releasedAt, track_count: trackCount,
  };
}

export function showDTO(s, episodeCount) {
  return {
    id: sid(s), type: 'show', title: s.title, description: s.description, category: s.category,
    language: s.language, explicit: !!s.explicit, private: s.published === false,
    creator: creatorRef(s.artist),
    cover: imgUrlArt(s.cover, artUrl('show', sid(s), s.title)) || artUrl('show', sid(s), s.title),
    color: artColor('show' + sid(s)),
    episode_count: episodeCount,
  };
}

export function episodeDTO(e, progress = null, liked = false) {
  return {
    id: sid(e), type: 'episode', title: e.title, description: e.description,
    show: { id: sid(e.show), title: e.show?.title, language: e.show?.language },
    creator: creatorRef(e.artist), collaborators: collabList(e),
    duration_ms: e.durationMs, season: e.season, number: e.number, plays: e.plays,
    has_transcript: !!e.transcript,
    cover: imgUrlArt(e.show?.cover, artUrl('show', sid(e.show), e.show?.title)) || artUrl('show', sid(e.show), e.show?.title),
    color: artColor('show' + sid(e.show)),
    stream_url: `/api/v1/stream/episode/${sid(e)}`, external: isExternal(e), downloadable: e.downloadsAllowed !== false,
    published_at: e.publishedAt, private: e.published === false || e.show?.published === false, liked,
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
  const likedEps = new Set();
  if (userId && rows.length) (await EpisodeLike.find({ user: userId, episode: { $in: rows.map((r) => r._id) } }).select('episode').lean()).forEach((l) => likedEps.add(String(l.episode)));
  if (userId && rows.length) {
    const ps = await EpisodeProgress.find({ user: userId, episode: { $in: rows.map((r) => r._id) } }).lean();
    ps.forEach((p) => prog.set(String(p.episode), p));
  }
  return rows.map((r) => episodeDTO(r, prog.get(String(r._id)), likedEps.has(String(r._id))));
}

export async function albumsToDTO(rows) {
  if (!rows.length) return [];
  const counts = await Track.aggregate([
    { $match: { album: { $in: rows.map((r) => r._id) }, ...publicFilter() } },
    { $group: { _id: '$album', n: { $sum: 1 } } },
  ]);
  const m = new Map(counts.map((c) => [String(c._id), c.n]));
  return rows.map((r) => albumDTO(r, m.get(String(r._id)) || 0));
}

export async function showsToDTO(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r._id);
  const count = async (filter) => new Map((await Episode.aggregate([
    { $match: { show: { $in: ids }, ...filter } },
    { $group: { _id: '$show', n: { $sum: 1 } } },
  ])).map((c) => [String(c._id), c.n]));
  // What the viewer can see (an owner also sees their private episodes) vs. what everyone can: a podcast is only listed for
  // other people once it has at least one public episode.
  const own = viewerOwnIds().map((i) => new Types.ObjectId(i));
  const [seen, pub] = await Promise.all([count(visibleTo(own)), count(publicFilter())]);
  return rows.map((r) => ({ ...showDTO(r, seen.get(String(r._id)) || 0), public_episode_count: pub.get(String(r._id)) || 0 }));
}

/** Playlists (lean docs with `user` populated) -> DTOs with a 4-cover collage and totals. */
export async function playlistsToDTO(rows) {
  const allIds = [...new Set(rows.flatMap((p) => p.items.map((i) => String(i.track))))];
  const cover = new Map();
  const dur = new Map();
  if (allIds.length) {
    const ts = await Track.find({ _id: { $in: allIds } }).select('title cover album durationMs published hidden artist').populate('album', 'cover').lean();
    ts.forEach((t) => dur.set(String(t._id), t));
    for (const t of ts) { const art = artUrl(t.album ? 'album' : 'track', sid(t.album) || sid(t), t.title); cover.set(String(t._id), imgUrlArt(t.cover, art) || imgUrlArt(t.album?.cover, art) || art); }
  }
  return rows.map((p) => {
    // Items are stored oldest-first; the cover is built from the most recently added songs, newest first.
    const live = p.items
      .map((i, n) => ({ i, n }))
      .filter(({ i }) => { const t = dur.get(String(i.track)); return t && t.published && !t.hidden && !isBlocked(t.artist); })
      .sort((a, b) => (new Date(b.i.addedAt || 0) - new Date(a.i.addedAt || 0)) || (b.n - a.n))
      .map(({ i }) => i);
    // Distinct covers only: ten songs from one album should not tile the same picture four times.
    const distinct = [...new Set(live.map((i) => cover.get(String(i.track))))];
    // Like Spotify: 4+ different covers -> a 2x2 collage of the last four added; 1-3 -> the latest song's cover on its
    // own; an empty playlist -> generated art that is unique to the playlist.
    let covers; let coverKind;
    if (distinct.length >= 4) { covers = distinct.slice(0, 4); coverKind = 'collage'; }
    else if (distinct.length) { covers = [distinct[0]]; coverKind = 'single'; }
    else { covers = [artUrl('playlist', sid(p), p.title)]; coverKind = 'generated'; }
    return {
      id: sid(p), type: 'playlist', title: p.title, description: p.description, is_public: !!p.isPublic,
      owner: { id: sid(p.user), username: p.user?.username, display_name: p.user?.displayName },
      track_count: live.length,
      duration_ms: live.reduce((n, i) => n + (dur.get(String(i.track))?.durationMs || 0), 0),
      covers, cover: covers[0], cover_kind: coverKind, color: artColor('playlist' + sid(p)),
      pinned: !!p.pinnedAt, pinned_at: p.pinnedAt || null,
      updated_at: p.updatedAt,
    };
  });
}

export const findPlaylists = (filter) => Playlist.find(filter).populate('user', 'username displayName').lean();

export const userPublic = (u) => ({ id: sid(u), username: u.username, display_name: u.displayName, bio: u.bio, created_at: u.createdAt });

export { sid, Creator };
