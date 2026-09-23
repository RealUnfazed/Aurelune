import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {
  Creator, Track, Episode, Album, Show, Follow, ShowFollow, AlbumSave, Play, Playlist, EpisodeProgress,
} from '../db.js';
import {
  findTracks, findEpisodes, findAlbums, findShows, findPlaylists, tracksToDTO, episodesToDTO, albumsToDTO, showsToDTO,
  playlistsToDTO, creatorDTO, albumDTO, showDTO, episodeDTO, VISIBLE, sid,
} from '../serialize.js';
import { oid, isOid, notFound, likeEscape, clampInt, lyricsPayload, HttpError } from '../util.js';
import { AUDIO_DIR } from '../config.js';

const r = Router();
const uidOf = (req) => req.user?._id;

const orderLike = (items, ids) => {
  const m = new Map(items.map((i) => [String(i._id), i]));
  return ids.map((id) => m.get(String(id))).filter(Boolean);
};

/* ------------------------------ Home ------------------------------ */

r.get('/home', async (req, res) => {
  const uid = uidOf(req);
  const week = new Date(Date.now() - 7 * 86400000);

  const trendingAgg = Play.aggregate([
    { $match: { kind: 'track', playedAt: { $gte: week } } },
    { $group: { _id: '$item', n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 12 },
  ]);

  const [trendAgg, newAlbums, creators, newEpisodes, shows, genres, pls] = await Promise.all([
    trendingAgg,
    findAlbums().sort({ releasedAt: -1 }).limit(12),
    Creator.find({ status: 'approved', focus: { $ne: 'podcasts' } }).sort({ verified: -1, createdAt: -1 }).limit(12).lean(),
    findEpisodes().sort({ publishedAt: -1 }).limit(8),
    findShows().sort({ createdAt: -1 }).limit(10),
    Track.aggregate([{ $match: { ...VISIBLE, genre: { $ne: '' } } }, { $group: { _id: '$genre', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 14 }]),
    findPlaylists({ isPublic: true, 'items.0': { $exists: true } }).sort({ updatedAt: -1 }).limit(8),
  ]);

  let trendRows = trendAgg.length ? orderLike(await findTracks({ _id: { $in: trendAgg.map((t) => t._id) } }), trendAgg.map((t) => t._id)) : [];
  if (trendRows.length < 10) {
    const have = trendRows.map((t) => t._id);
    const fill = await findTracks({ _id: { $nin: have } }).sort({ plays: -1, createdAt: -1 }).limit(12 - trendRows.length);
    trendRows = trendRows.concat(fill);
  }

  const out = {
    trending: await tracksToDTO(trendRows, uid),
    new_albums: await albumsToDTO(newAlbums),
    artists: creators.map(creatorDTO),
    new_episodes: await episodesToDTO(newEpisodes, uid),
    shows: await showsToDTO(shows),
    genres: genres.map((g) => ({ name: g._id, tracks: g.n })),
    playlists: await playlistsToDTO(pls),
    recent: [], from_follows: [],
  };

  if (uid) {
    const plays = await Play.find({ user: uid }).sort({ playedAt: -1 }).limit(60).select('kind item').lean();
    const seen = new Set(); const picks = [];
    for (const p of plays) { const k = p.kind + p.item; if (!seen.has(k)) { seen.add(k); picks.push(p); if (picks.length >= 8) break; } }
    const tIds = picks.filter((p) => p.kind === 'track').map((p) => p.item);
    const eIds = picks.filter((p) => p.kind === 'episode').map((p) => p.item);
    const [tRows, eRows] = await Promise.all([
      tIds.length ? findTracks({ _id: { $in: tIds } }) : [],
      eIds.length ? findEpisodes({ _id: { $in: eIds } }) : [],
    ]);
    const tD = new Map((await tracksToDTO(tRows, uid)).map((t) => [t.id, t]));
    const eD = new Map((await episodesToDTO(eRows, uid)).map((e) => [e.id, e]));
    out.recent = picks.map((p) => (p.kind === 'track' ? tD.get(String(p.item)) : eD.get(String(p.item)))).filter(Boolean);

    const follows = await Follow.find({ user: uid }).select('artist').lean();
    if (follows.length) out.from_follows = await tracksToDTO(await findTracks({ artist: { $in: follows.map((f) => f.artist) } }).sort({ createdAt: -1 }).limit(10), uid);
  }
  res.json(out);
});

/* ------------------------------ Search ------------------------------ */

r.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (!q) return res.json({ query: '', tracks: [], artists: [], albums: [], shows: [], episodes: [], playlists: [] });
  const re = new RegExp(likeEscape(q), 'i');
  const starts = (s) => (String(s).toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1);
  const uid = uidOf(req);

  const creators = await Creator.find({ status: 'approved', name: re }).limit(12).lean();
  const cIds = creators.map((c) => c._id);

  const [tracks, albums, shows, episodes, pls] = await Promise.all([
    findTracks({ $or: [{ title: re }, { genre: re }, { credits: re }, { artist: { $in: cIds } }] }).sort({ plays: -1 }).limit(20),
    findAlbums({ $or: [{ title: re }, { artist: { $in: cIds } }] }).limit(12),
    findShows({ $or: [{ title: re }, { artist: { $in: cIds } }] }).limit(10),
    findEpisodes({ $or: [{ title: re }, { description: re }] }).sort({ publishedAt: -1 }).limit(10),
    findPlaylists({ isPublic: true, title: re, 'items.0': { $exists: true } }).limit(8),
  ]);
  const sortT = tracks.sort((a, b) => starts(a.title) - starts(b.title)).slice(0, 12);
  res.json({
    query: q,
    tracks: await tracksToDTO(sortT, uid),
    artists: creators.sort((a, b) => starts(a.name) - starts(b.name)).slice(0, 8).map(creatorDTO),
    albums: await albumsToDTO(albums.sort((a, b) => starts(a.title) - starts(b.title))),
    shows: await showsToDTO(shows),
    episodes: await episodesToDTO(episodes, uid),
    playlists: await playlistsToDTO(pls),
  });
});

/* ------------------------------ Tracks ------------------------------ */

r.get('/tracks', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(isOid).slice(0, 50);
  const rows = ids.length ? await findTracks({ _id: { $in: ids } }) : [];
  res.json({ tracks: await tracksToDTO(orderLike(rows, ids), uidOf(req)) });
});

r.get('/tracks/:id', async (req, res) => {
  const [t] = await findTracks({ _id: oid(req.params.id) }).limit(1);
  if (!t) throw notFound('Track not found');
  res.json({ track: (await tracksToDTO([t], uidOf(req)))[0] });
});

r.get('/tracks/:id/lyrics', async (req, res) => {
  const t = await Track.findOne({ _id: oid(req.params.id), ...VISIBLE }).select('lyrics title').lean();
  if (!t) throw notFound('Track not found');
  res.json({ track_id: String(t._id), ...lyricsPayload(t.lyrics) });
});

/* ------------------------------ Creators / albums / shows ------------------------------ */

r.get('/artists/:id', async (req, res) => {
  const key = req.params.id;
  const a = await Creator.findOne(isOid(key) ? { _id: key } : { slug: key }).lean();
  if (!a || a.status !== 'approved') throw notFound('Artist not found');
  const uid = uidOf(req);
  const month = new Date(Date.now() - 30 * 86400000);
  const [top, albums, shows, followers, isFollowing, listeners, total] = await Promise.all([
    findTracks({ artist: a._id }).sort({ plays: -1, createdAt: -1 }).limit(10),
    findAlbums({ artist: a._id }).sort({ releasedAt: -1 }),
    findShows({ artist: a._id }).sort({ createdAt: -1 }),
    Follow.countDocuments({ artist: a._id }),
    uid ? Follow.exists({ user: uid, artist: a._id }) : null,
    Play.distinct('user', { creator: a._id, playedAt: { $gte: month } }),
    Track.countDocuments({ artist: a._id, ...VISIBLE }),
  ]);
  res.json({
    artist: creatorDTO(a), followers, is_following: !!isFollowing, monthly_listeners: listeners.length, track_count: total,
    top_tracks: await tracksToDTO(top, uid), albums: await albumsToDTO(albums), shows: await showsToDTO(shows),
  });
});

r.get('/albums/:id', async (req, res) => {
  const [al] = await findAlbums({ _id: oid(req.params.id) }).limit(1);
  if (!al) throw notFound('Album not found');
  const uid = uidOf(req);
  const tracks = await findTracks({ album: al._id }).sort({ trackNo: 1, createdAt: 1 });
  const saved = uid ? await AlbumSave.exists({ user: uid, album: al._id }) : null;
  res.json({ album: albumDTO(al, tracks.length), tracks: await tracksToDTO(tracks, uid), is_saved: !!saved });
});

r.get('/shows/:id', async (req, res) => {
  const [s] = await findShows({ _id: oid(req.params.id) }).limit(1);
  if (!s) throw notFound('Show not found');
  const uid = uidOf(req);
  const eps = await findEpisodes({ show: s._id }).sort({ publishedAt: -1 });
  const following = uid ? await ShowFollow.exists({ user: uid, show: s._id }) : null;
  res.json({ show: showDTO(s, eps.length), episodes: await episodesToDTO(eps, uid), is_following: !!following });
});

r.get('/episodes/:id', async (req, res) => {
  const [e] = await findEpisodes({ _id: oid(req.params.id) }).limit(1);
  if (!e) throw notFound('Episode not found');
  const dto = (await episodesToDTO([e], uidOf(req)))[0];
  res.json({ episode: { ...dto, transcript: e.transcript || '' } });
});

/* ------------------------------ Genres ------------------------------ */

r.get('/genres', async (_req, res) => {
  const g = await Track.aggregate([{ $match: { ...VISIBLE, genre: { $ne: '' } } }, { $group: { _id: '$genre', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 60 }]);
  res.json({ genres: g.map((x) => ({ name: x._id, tracks: x.n })) });
});

r.get('/genres/:name', async (req, res) => {
  const re = new RegExp(`^${likeEscape(req.params.name)}$`, 'i');
  const rows = await findTracks({ genre: re }).sort({ plays: -1, createdAt: -1 }).limit(60);
  res.json({ genre: req.params.name, tracks: await tracksToDTO(rows, uidOf(req)) });
});

/* ------------------------------ Streaming ------------------------------ */
// Range requests (seeking) are handled by res.sendFile. Owners can preview unpublished items.

async function streamFile(req, res, Model, id) {
  const doc = await Model.findById(oid(id)).select('audio mime published hidden artist').lean();
  if (!doc) throw notFound();
  if (!doc.published || doc.hidden) {
    const own = req.user && (await Creator.exists({ _id: doc.artist, user: req.user._id }));
    if (!own) throw notFound();
  }
  const file = path.join(AUDIO_DIR, path.basename(doc.audio));
  if (!fs.existsSync(file)) throw new HttpError(410, 'Audio file is missing on the server', 'file_missing');
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  res.sendFile(file, { acceptRanges: true, headers: { 'Content-Type': doc.mime } });
}
r.get('/stream/track/:id', (req, res) => streamFile(req, res, Track, req.params.id));
r.get('/stream/episode/:id', (req, res) => streamFile(req, res, Episode, req.params.id));

export default r;
