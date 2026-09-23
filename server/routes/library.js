import { Router } from 'express';
import {
  Track, Episode, Creator, Album, Show, Like, Follow, ShowFollow, AlbumSave, Playlist, EpisodeProgress,
} from '../db.js';
import { scope, requireAuth } from '../auth.js';
import {
  findTracks, findPlaylists, tracksToDTO, albumsToDTO, showsToDTO, playlistsToDTO, creatorDTO, findAlbums, findShows,
  VISIBLE, sid,
} from '../serialize.js';
import { oid, isOid, bad, notFound, str, truthy, clampInt, forbidden } from '../util.js';

const r = Router();
const mine = [requireAuth];

const ordered = (rows, ids) => {
  const m = new Map(rows.map((x) => [String(x._id), x]));
  return ids.map((i) => m.get(String(i))).filter(Boolean);
};

/* ------------------------------ Library overview ------------------------------ */

r.get('/library', scope('library'), async (req, res) => {
  const uid = req.user._id;
  const [likedCount, follows, saves, sfollows, pls] = await Promise.all([
    Like.countDocuments({ user: uid }),
    Follow.find({ user: uid }).sort({ createdAt: -1 }).lean(),
    AlbumSave.find({ user: uid }).sort({ createdAt: -1 }).lean(),
    ShowFollow.find({ user: uid }).sort({ createdAt: -1 }).lean(),
    findPlaylists({ user: uid }).sort({ updatedAt: -1 }),
  ]);
  const [artists, albums, shows] = await Promise.all([
    Creator.find({ _id: { $in: follows.map((f) => f.artist) }, status: 'approved' }).lean(),
    findAlbums({ _id: { $in: saves.map((s) => s.album) } }),
    findShows({ _id: { $in: sfollows.map((s) => s.show) } }),
  ]);
  res.json({
    liked_count: likedCount,
    playlists: await playlistsToDTO(pls),
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
  const rows = ordered(await findTracks({ _id: { $in: likes.map((l) => l.track) } }), likes.map((l) => l.track));
  const dtos = (await tracksToDTO(rows, req.user._id)).map((t) => ({ ...t, liked_at: likes.find((l) => String(l.track) === t.id)?.createdAt }));
  res.json({ total, offset, limit, tracks: dtos });
});

r.put('/me/likes/:id', scope('library'), async (req, res) => {
  const id = oid(req.params.id);
  if (!(await Track.exists({ _id: id, ...VISIBLE }))) throw notFound('Track not found');
  await Like.updateOne({ user: req.user._id, track: id }, { $setOnInsert: { user: req.user._id, track: id } }, { upsert: true });
  res.json({ liked: true });
});
r.delete('/me/likes/:id', scope('library'), async (req, res) => {
  await Like.deleteOne({ user: req.user._id, track: oid(req.params.id) });
  res.json({ liked: false });
});

/* ------------------------------ Follows / saves ------------------------------ */

const toggle = (path, Model, field, Target, extra = {}) => {
  r.put(path, scope('library'), async (req, res) => {
    const id = oid(req.params.id);
    if (!(await Target.exists({ _id: id, ...extra }))) throw notFound();
    await Model.updateOne({ user: req.user._id, [field]: id }, { $setOnInsert: { user: req.user._id, [field]: id } }, { upsert: true });
    res.json({ active: true });
  });
  r.delete(path, scope('library'), async (req, res) => {
    await Model.deleteOne({ user: req.user._id, [field]: oid(req.params.id) });
    res.json({ active: false });
  });
};
toggle('/me/following/artists/:id', Follow, 'artist', Creator, { status: 'approved' });
toggle('/me/following/shows/:id', ShowFollow, 'show', Show, { hidden: false });
toggle('/me/saved/albums/:id', AlbumSave, 'album', Album, { hidden: false });

/* ------------------------------ Playlists ------------------------------ */

const ownerOnly = async (req, id) => {
  const p = await Playlist.findById(oid(id));
  if (!p) throw notFound('Playlist not found');
  if (String(p.user) !== String(req.user._id)) throw forbidden('This is not your playlist');
  return p;
};

async function cleanTrackIds(list) {
  const ids = [...new Set((Array.isArray(list) ? list : []).filter(isOid).map(String))].slice(0, 500);
  if (!ids.length) return [];
  const ok = await Track.find({ _id: { $in: ids }, ...VISIBLE }).select('_id').lean();
  const okSet = new Set(ok.map((t) => String(t._id)));
  return ids.filter((i) => okSet.has(i));
}

r.get('/me/playlists', scope('playlists'), async (req, res) => {
  res.json({ playlists: await playlistsToDTO(await findPlaylists({ user: req.user._id }).sort({ updatedAt: -1 })) });
});

r.post('/playlists', scope('playlists'), async (req, res) => {
  const title = str(req.body.title, 80);
  if (!title) throw bad('Give the playlist a name');
  const ids = await cleanTrackIds(req.body.track_ids);
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
  const rows = ordered(await findTracks({ _id: { $in: ids } }), ids);
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
  const ids = await cleanTrackIds(req.body.track_ids || (req.body.track_id ? [req.body.track_id] : []));
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

export default r;
