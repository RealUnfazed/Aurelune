import { Router } from 'express';
import {
  Track, Episode, EpisodeLike, Creator, Album, Show, Like, Follow, ShowFollow, AlbumSave, Playlist, EpisodeProgress, Exclude, Report,
} from '../db.js';
import { scope, requireAuth, ownCreatorIds } from '../auth.js';
import { notBlocked, blockedShowIds } from '../privacy.js';
import {
  findTracks, findEpisodes, findPlaylists, tracksToDTO, episodesToDTO, albumsToDTO, showsToDTO, playlistsToDTO, creatorDTO, findAlbums, findShows,
  visibleTo, sid,
} from '../serialize.js';
import { oid, isOid, bad, notFound, str, truthy, clampInt, forbidden } from '../util.js';

const r = Router();
const mine = [requireAuth];

/** Pinned playlists first (most recently pinned on top), then by last change. */
const pinnedFirst = (a, b) => (!!b.pinnedAt - !!a.pinnedAt) || (new Date(b.pinnedAt || 0) - new Date(a.pinnedAt || 0)) || (new Date(b.updatedAt) - new Date(a.updatedAt));

const ordered = (rows, ids) => {
  const m = new Map(rows.map((x) => [String(x._id), x]));
  return ids.map((i) => m.get(String(i))).filter(Boolean);
};

/* ------------------------------ Library overview ------------------------------ */

r.get('/library', scope('library'), async (req, res) => {
  const uid = req.user._id;
  const [likedCount, likedEpisodes, follows, saves, sfollows, pls] = await Promise.all([
    Like.countDocuments({ user: uid }),
    EpisodeLike.countDocuments({ user: uid }),
    Follow.find({ user: uid }).sort({ createdAt: -1 }).lean(),
    AlbumSave.find({ user: uid }).sort({ createdAt: -1 }).lean(),
    ShowFollow.find({ user: uid }).sort({ createdAt: -1 }).lean(),
    findPlaylists({ user: uid }).sort({ updatedAt: -1 }),
  ]);
  const [artists, albums, shows] = await Promise.all([
    Creator.find({ $and: [{ _id: { $in: follows.map((f) => f.artist) }, status: 'approved' }, notBlocked('_id')] }).lean(),
    findAlbums({ _id: { $in: saves.map((s) => s.album) } }),
    findShows({ _id: { $in: sfollows.map((s) => s.show) } }, { empty: true }),
  ]);
  res.json({
    liked_count: likedCount, liked_episodes_count: likedEpisodes,
    playlists: await playlistsToDTO(pls.sort(pinnedFirst)),
    artists: ordered(artists, follows.map((f) => f.artist)).map(creatorDTO),
    albums: await albumsToDTO(ordered(albums, saves.map((s) => s.album))),
    shows: await showsToDTO(ordered(shows, sfollows.map((s) => s.show))),
  });
});

/* ------------------------------ Likes ------------------------------ */

r.get('/me/likes', scope('library'), async (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const offset = clampInt(req.query.offset, 0, 0, 1e6);
  const [total, likes] = await Promise.all([
    Like.countDocuments({ user: req.user._id }),
    Like.find({ user: req.user._id }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
  ]);
  const rows = ordered(await findTracks({ _id: { $in: likes.map((l) => l.track) } }, await ownCreatorIds(req)), likes.map((l) => l.track));
  const dtos = (await tracksToDTO(rows, req.user._id)).map((t) => ({ ...t, liked_at: likes.find((l) => String(l.track) === t.id)?.createdAt }));
  res.json({ total, offset, limit, tracks: dtos });
});

r.put('/me/likes/:id', scope('library'), async (req, res) => {
  const id = oid(req.params.id);
  if (!(await Track.exists({ $and: [{ _id: id }, visibleTo(await ownCreatorIds(req))] }))) throw notFound('Track not found');
  await Like.updateOne({ user: req.user._id, track: id }, { $setOnInsert: { user: req.user._id, track: id } }, { upsert: true });
  res.json({ liked: true });
});
r.delete('/me/likes/:id', scope('library'), async (req, res) => {
  await Like.deleteOne({ user: req.user._id, track: oid(req.params.id) });
  res.json({ liked: false });
});

/* ------------------------------ Liked episodes (podcasts) ------------------------------ */
// Separate from Liked Songs on purpose: songs -> /me/likes, podcast episodes -> /me/likes/episodes.

r.get('/me/likes/episodes', scope('library'), async (req, res) => {
  const limit = clampInt(req.query.limit, 100, 1, 500);
  const offset = clampInt(req.query.offset, 0, 0, 1e6);
  const [total, likes] = await Promise.all([
    EpisodeLike.countDocuments({ user: req.user._id }),
    EpisodeLike.find({ user: req.user._id }).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
  ]);
  const rows = ordered(await findEpisodes({ _id: { $in: likes.map((l) => l.episode) } }, await ownCreatorIds(req)), likes.map((l) => l.episode));
  const dtos = (await episodesToDTO(rows, req.user._id)).map((e) => ({ ...e, liked_at: likes.find((l) => String(l.episode) === e.id)?.createdAt }));
  res.json({ total, offset, limit, episodes: dtos });
});

r.put('/me/likes/episodes/:id', scope('library'), async (req, res) => {
  const id = oid(req.params.id);
  if (!(await Episode.exists({ $and: [{ _id: id }, visibleTo(await ownCreatorIds(req))] }))) throw notFound('Episode not found');
  await EpisodeLike.updateOne({ user: req.user._id, episode: id }, { $setOnInsert: { user: req.user._id, episode: id } }, { upsert: true });
  res.json({ liked: true });
});
r.delete('/me/likes/episodes/:id', scope('library'), async (req, res) => {
  await EpisodeLike.deleteOne({ user: req.user._id, episode: oid(req.params.id) });
  res.json({ liked: false });
});

/* ------------------------------ Follows / saves ------------------------------ */

const toggle = (path, Model, field, Target, extra = {}) => {
  r.put(path, scope('library'), async (req, res) => {
    const id = oid(req.params.id);
    if (!(await Target.exists({ $and: [{ _id: id }, typeof extra === 'function' ? extra() : extra] }))) throw notFound();
    await Model.updateOne({ user: req.user._id, [field]: id }, { $setOnInsert: { user: req.user._id, [field]: id } }, { upsert: true });
    res.json({ active: true });
  });
  r.delete(path, scope('library'), async (req, res) => {
    await Model.deleteOne({ user: req.user._id, [field]: oid(req.params.id) });
    res.json({ active: false });
  });
};
toggle('/me/following/artists/:id', Follow, 'artist', Creator, () => ({ status: 'approved', ...notBlocked('_id') }));
toggle('/me/following/shows/:id', ShowFollow, 'show', Show, () => ({ hidden: false, ...notBlocked('artist'), ...(blockedShowIds().length ? { _id: { $nin: blockedShowIds() } } : {}) }));
toggle('/me/saved/albums/:id', AlbumSave, 'album', Album, () => ({ hidden: false, ...notBlocked('artist') }));

/* ------------------------------ Playlists ------------------------------ */

const ownerOnly = async (req, id) => {
  const p = await Playlist.findById(oid(id));
  if (!p) throw notFound('Playlist not found');
  if (String(p.user) !== String(req.user._id)) throw forbidden('This is not your playlist');
  return p;
};

async function cleanTrackIds(list, ownIds) {
  const ids = [...new Set((Array.isArray(list) ? list : []).filter(isOid).map(String))].slice(0, 500);
  if (!ids.length) return [];
  const ok = await Track.find({ $and: [{ _id: { $in: ids } }, visibleTo(ownIds)] }).select('_id').lean();
  const okSet = new Set(ok.map((t) => String(t._id)));
  return ids.filter((i) => okSet.has(i));
}

r.get('/me/playlists', scope('playlists'), async (req, res) => {
  const rows = await findPlaylists({ user: req.user._id });
  const [liked, likedEps] = await Promise.all([Like.countDocuments({ user: req.user._id }), EpisodeLike.countDocuments({ user: req.user._id })]);
  res.json({
    playlists: await playlistsToDTO(rows.sort(pinnedFirst)),
    liked: { count: liked, icon: req.user.likedIcon || 'heart', color: req.user.likedColor || 'green' },
    liked_episodes: { count: likedEps, icon: req.user.likedEpisodesIcon || 'podcast', color: req.user.likedEpisodesColor || 'violet' },
  });
});

// Pin / unpin one of your own playlists (pinned ones lead the sidebar and library). Pinning is not an edit, so updatedAt stays put.
r.put('/playlists/:id/pin', scope('playlists'), async (req, res) => {
  const p = await ownerOnly(req, req.params.id);
  await Playlist.updateOne({ _id: p._id }, { $set: { pinnedAt: new Date() } }, { timestamps: false });
  res.json({ pinned: true });
});
r.delete('/playlists/:id/pin', scope('playlists'), async (req, res) => {
  const p = await ownerOnly(req, req.params.id);
  await Playlist.updateOne({ _id: p._id }, { $set: { pinnedAt: null } }, { timestamps: false });
  res.json({ pinned: false });
});

r.post('/playlists', scope('playlists'), async (req, res) => {
  const title = str(req.body.title, 80);
  if (!title) throw bad('Give the playlist a name');
  const ids = await cleanTrackIds(req.body.track_ids, await ownCreatorIds(req));
  const p = await Playlist.create({
    user: req.user._id, title, description: str(req.body.description, 300), isPublic: truthy(req.body.is_public),
    items: ids.map((t) => ({ track: t })),
  });
  const [dto] = await playlistsToDTO(await findPlaylists({ _id: p._id }));
  res.status(201).json({ playlist: dto });
});

r.get('/playlists/:id', async (req, res) => {
  const [p] = await findPlaylists({ _id: oid(req.params.id) }).limit(1);
  if (!p) throw notFound('Playlist not found');
  const isOwner = req.user && String(p.user._id) === String(req.user._id) && (!req.viaToken || req.scopes.has('playlists'));
  if (!p.isPublic && !isOwner) throw notFound('Playlist not found');
  const ids = p.items.map((i) => i.track);
  const rows = ordered(await findTracks({ _id: { $in: ids } }, await ownCreatorIds(req)), ids);
  const dtos = await tracksToDTO(rows, req.user?._id);
  const added = new Map(p.items.map((i) => [String(i.track), i.addedAt]));
  const [dto] = await playlistsToDTO([p]);
  res.json({ playlist: dto, is_owner: !!isOwner, tracks: dtos.map((t) => ({ ...t, added_at: added.get(t.id) })) });
});

r.patch('/playlists/:id', scope('playlists'), async (req, res) => {
  const p = await ownerOnly(req, req.params.id);
  if ('title' in req.body) { const t = str(req.body.title, 80); if (!t) throw bad('Name cannot be empty'); p.title = t; }
  if ('description' in req.body) p.description = str(req.body.description, 300);
  if ('is_public' in req.body) p.isPublic = truthy(req.body.is_public);
  await p.save();
  const [dto] = await playlistsToDTO(await findPlaylists({ _id: p._id }));
  res.json({ playlist: dto });
});

r.delete('/playlists/:id', scope('playlists'), async (req, res) => {
  const p = await ownerOnly(req, req.params.id);
  await p.deleteOne();
  res.json({ ok: true });
});

r.post('/playlists/:id/tracks', scope('playlists'), async (req, res) => {
  const p = await ownerOnly(req, req.params.id);
  const ids = await cleanTrackIds(req.body.track_ids || (req.body.track_id ? [req.body.track_id] : []), await ownCreatorIds(req));
  const have = new Set(p.items.map((i) => String(i.track)));
  const fresh = ids.filter((i) => !have.has(i));
  if (p.items.length + fresh.length > 5000) throw bad('Playlists hold up to 5,000 tracks');
  fresh.forEach((t) => p.items.push({ track: t }));
  await p.save();
  res.json({ added: fresh.length, skipped: ids.length - fresh.length });
});

r.delete('/playlists/:id/tracks/:trackId', scope('playlists'), async (req, res) => {
  const p = await ownerOnly(req, req.params.id);
  const before = p.items.length;
  p.items = p.items.filter((i) => String(i.track) !== String(req.params.trackId));
  await p.save();
  res.json({ removed: before - p.items.length });
});

r.put('/playlists/:id/order', scope('playlists'), async (req, res) => {
  const p = await ownerOnly(req, req.params.id);
  const order = (req.body.track_ids || []).map(String);
  const m = new Map(p.items.map((i) => [String(i.track), i]));
  const next = order.map((id) => m.get(id)).filter(Boolean);
  const rest = p.items.filter((i) => !order.includes(String(i.track)));
  p.items = [...next, ...rest];
  await p.save();
  res.json({ ok: true });
});

/* ------------------------------ Episode progress ------------------------------ */

r.put('/me/episodes/:id/progress', scope('library'), async (req, res) => {
  const id = oid(req.params.id);
  const ep = await Episode.findById(id).select('durationMs').lean();
  if (!ep) throw notFound();
  const pos = clampInt(req.body.position_ms, 0, 0, 1e9);
  const completed = truthy(req.body.completed) || (ep.durationMs > 0 && pos > ep.durationMs - 15000);
  await EpisodeProgress.updateOne({ user: req.user._id, episode: id }, { $set: { positionMs: completed ? 0 : pos, completed } }, { upsert: true });
  res.json({ ok: true, completed });
});

/* ------------------------------ Exclude from taste ------------------------------ */
// Tracks a listener asks not to see in Trending/Discover shelves again.

r.put('/me/excluded/:id', scope('library'), async (req, res) => {
  const id = oid(req.params.id);
  if (!(await Track.exists({ _id: id }))) throw notFound('Track not found');
  await Exclude.updateOne({ user: req.user._id, track: id }, { $setOnInsert: { user: req.user._id, track: id } }, { upsert: true });
  await Like.deleteOne({ user: req.user._id, track: id }); // excluding something you'd liked doesn't make sense to keep liked
  res.json({ excluded: true });
});
r.delete('/me/excluded/:id', scope('library'), async (req, res) => {
  await Exclude.deleteOne({ user: req.user._id, track: oid(req.params.id) });
  res.json({ excluded: false });
});

/* ------------------------------ Reports ------------------------------ */
// A real, admin-visible report — not a fake context-menu action.

const REPORT_KINDS = ['track', 'episode', 'artist', 'album', 'show', 'playlist'];
const REPORT_REASONS = ['copyright', 'inappropriate', 'spam', 'wrong_metadata', 'other'];

r.post('/reports', requireAuth, async (req, res) => {
  const kind = REPORT_KINDS.includes(req.body.kind) ? req.body.kind : null;
  const reason = REPORT_REASONS.includes(req.body.reason) ? req.body.reason : null;
  if (!kind || !isOid(req.body.item_id)) throw bad('Provide a valid kind and item_id');
  if (!reason) throw bad(`Reason must be one of: ${REPORT_REASONS.join(', ')}`);
  const report = await Report.create({ user: req.user._id, kind, item: req.body.item_id, reason, note: str(req.body.note, 500) });
  res.status(201).json({ ok: true, id: sid(report) });
});

export default r;
