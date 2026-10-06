import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import {
  Creator, Track, Episode, Album, Show, Follow, ShowFollow, AlbumSave, Play, Playlist, EpisodeProgress, Exclude,
} from '../db.js';
import {
  findTracks, findEpisodes, findAlbums, findShows, findPlaylists, tracksToDTO, episodesToDTO, albumsToDTO, showsToDTO,
  playlistsToDTO, creatorDTO, albumDTO, showDTO, episodeDTO, publicFilter, visibleTo, collabOf, TRACK_POP, sid,
} from '../serialize.js';
import { ownCreatorIds } from '../auth.js';
import { notBlocked, isBlocked, isShowBlocked, allPrivateCreatorIds } from '../privacy.js';
import { oid, isOid, notFound, likeEscape, clampInt, lyricsPayload, HttpError } from '../util.js';
import { AUDIO_DIR, STREAM_PROXY } from '../config.js';
import { plainSize, streamDecryptedRange } from '../crypto-store.js';
import { assertTrustedUrl } from '../storage.js';
import { streamParts, proxyFile, parseRange } from '../pfstream.js';

const r = Router();
const uidOf = (req) => req.user?._id;

const orderLike = (items, ids) => {
  const m = new Map(items.map((i) => [String(i._id), i]));
  return ids.map((id) => m.get(String(id))).filter(Boolean);
};

/* ------------------------------ Home ------------------------------ */

r.get('/home', async (req, res) => {
  const uid = uidOf(req);
  const own = await ownCreatorIds(req);
  const week = new Date(Date.now() - 7 * 86400000);

  const trendingAgg = Play.aggregate([
    { $match: { kind: 'track', playedAt: { $gte: week } } },
    { $group: { _id: '$item', n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 12 },
  ]);

  const [trendAgg, newAlbums, creators, newEpisodes, shows, genres, pls] = await Promise.all([
    trendingAgg,
    findAlbums().sort({ releasedAt: -1 }).limit(12),
    Creator.find({ status: 'approved', focus: { $ne: 'podcasts' }, ...notBlocked('_id') }).sort({ verified: -1, createdAt: -1 }).limit(12).lean(),
    findEpisodes().sort({ publishedAt: -1 }).limit(8),
    findShows({}, { own, sort: { createdAt: -1 }, limit: 10 }),
    Track.aggregate([{ $match: { ...publicFilter(), genre: { $ne: '' } } }, { $group: { _id: '$genre', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 14 }]),
    findPlaylists({ isPublic: true, 'items.0': { $exists: true } }).sort({ updatedAt: -1 }).limit(8),
  ]);

  let trendRows = trendAgg.length ? orderLike(await findTracks({ _id: { $in: trendAgg.map((t) => t._id) } }), trendAgg.map((t) => t._id)) : [];
  const excluded = uid ? (await Exclude.find({ user: uid }).select('track').lean()).map((e) => e.track) : [];
  if (excluded.length) trendRows = trendRows.filter((t) => !excluded.some((e) => String(e) === String(t._id)));
  if (trendRows.length < 10) {
    const have = trendRows.map((t) => t._id).concat(excluded);
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
    recent: [], from_follows: [], private_tracks: [],
  };

  if (uid) {
    const plays = await Play.find({ user: uid }).sort({ playedAt: -1 }).limit(60).select('kind item').lean();
    const seen = new Set(); const picks = [];
    for (const p of plays) { const k = p.kind + p.item; if (!seen.has(k)) { seen.add(k); picks.push(p); if (picks.length >= 8) break; } }
    const tIds = picks.filter((p) => p.kind === 'track').map((p) => p.item);
    const eIds = picks.filter((p) => p.kind === 'episode').map((p) => p.item);
    const [tRows, eRows] = await Promise.all([
      tIds.length ? findTracks({ _id: { $in: tIds } }, own) : [],
      eIds.length ? findEpisodes({ _id: { $in: eIds } }, own) : [],
    ]);
    const tD = new Map((await tracksToDTO(tRows, uid)).map((t) => [t.id, t]));
    const eD = new Map((await episodesToDTO(eRows, uid)).map((e) => [e.id, e]));
    out.recent = picks.map((p) => (p.kind === 'track' ? tD.get(String(p.item)) : eD.get(String(p.item)))).filter(Boolean);

    // Creators also see their own private tracks on their feed (nobody else does).
    if (own.length) {
      const mine = await Track.find({ artist: { $in: own }, published: false, hidden: false }).populate(TRACK_POP).sort({ createdAt: -1 }).limit(10).lean();
      out.private_tracks = await tracksToDTO(mine, uid);
    }

    const follows = await Follow.find({ user: uid }).select('artist').lean();
    if (follows.length) out.from_follows = await tracksToDTO(await findTracks({ $or: [{ artist: { $in: follows.map((f) => f.artist) } }, collabOf(follows.map((f) => f.artist))] }, own).sort({ createdAt: -1 }).limit(10), uid);
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
  const own = await ownCreatorIds(req);

  const creators = await Creator.find({ status: 'approved', name: re, ...notBlocked('_id') }).limit(12).lean();
  const cIds = creators.map((c) => c._id);

  const [tracks, albums, shows, episodes, pls] = await Promise.all([
    findTracks({ $or: [{ title: re }, { genre: re }, { credits: re }, { artist: { $in: cIds } }, collabOf(cIds)] }, own).sort({ plays: -1 }).limit(20),
    findAlbums({ $or: [{ title: re }, { artist: { $in: cIds } }] }).limit(12),
    findShows({ $or: [{ title: re }, { artist: { $in: cIds } }] }, { own, limit: 10 }),
    findEpisodes({ $or: [{ title: re }, { description: re }, collabOf(cIds)] }, own).sort({ publishedAt: -1 }).limit(10),
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
  const rows = ids.length ? await findTracks({ _id: { $in: ids } }, await ownCreatorIds(req)) : [];
  res.json({ tracks: await tracksToDTO(orderLike(rows, ids), uidOf(req)) });
});

r.get('/tracks/:id', async (req, res) => {
  const [t] = await findTracks({ _id: oid(req.params.id) }, await ownCreatorIds(req)).limit(1);
  if (!t) throw notFound('Track not found');
  res.json({ track: (await tracksToDTO([t], uidOf(req)))[0] });
});

r.get('/tracks/:id/lyrics', async (req, res) => {
  const t = await Track.findOne({ $and: [{ _id: oid(req.params.id) }, visibleTo(await ownCreatorIds(req))] }).select('lyrics title').lean();
  if (!t) throw notFound('Track not found');
  res.json({ track_id: String(t._id), ...lyricsPayload(t.lyrics) });
});

/* ------------------------------ Creators / albums / shows ------------------------------ */

r.get('/artists/:id', async (req, res) => {
  const key = req.params.id;
  const a = await Creator.findOne(isOid(key) ? { _id: key } : { slug: key }).lean();
  if (!a || a.status !== 'approved' || isBlocked(a._id)) throw notFound('Artist not found');
  const uid = uidOf(req);
  const own = await ownCreatorIds(req);
  const month = new Date(Date.now() - 30 * 86400000);
  const mine = { $or: [{ artist: a._id }, collabOf(a._id)] }; // their own tracks plus those they are credited on
  const [top, albums, shows, followers, isFollowing, listeners, total, featured] = await Promise.all([
    findTracks(mine, own).sort({ plays: -1, createdAt: -1 }).limit(10),
    findAlbums({ artist: a._id }).sort({ releasedAt: -1 }),
    findShows({ artist: a._id }, { own, sort: { createdAt: -1 } }),
    Follow.countDocuments({ artist: a._id }),
    uid ? Follow.exists({ user: uid, artist: a._id }) : null,
    Play.distinct('user', { creator: a._id, playedAt: { $gte: month } }),
    Track.countDocuments({ ...mine, ...publicFilter() }),
    findEpisodes(collabOf(a._id), own).sort({ publishedAt: -1 }).limit(12),
  ]);
  res.json({
    artist: creatorDTO(a), followers, is_following: !!isFollowing, monthly_listeners: listeners.length, track_count: total,
    top_tracks: await tracksToDTO(top, uid), albums: await albumsToDTO(albums), shows: await showsToDTO(shows),
    featured_episodes: await episodesToDTO(featured, uid),
  });
});

r.get('/albums/:id', async (req, res) => {
  const [al] = await findAlbums({ _id: oid(req.params.id) }).limit(1);
  if (!al) throw notFound('Album not found');
  const uid = uidOf(req);
  const tracks = await findTracks({ album: al._id }, await ownCreatorIds(req)).sort({ trackNo: 1, createdAt: 1 });
  const saved = uid ? await AlbumSave.exists({ user: uid, album: al._id }) : null;
  res.json({ album: albumDTO(al, tracks.length), tracks: await tracksToDTO(tracks, uid), is_saved: !!saved });
});

r.get('/shows/:id', async (req, res) => {
  const [s] = await findShows({ _id: oid(req.params.id) }, { empty: true, limit: 1 });
  if (!s) throw notFound('Show not found');
  const uid = uidOf(req);
  const eps = await findEpisodes({ show: s._id }, await ownCreatorIds(req)).sort({ publishedAt: -1 });
  const following = uid ? await ShowFollow.exists({ user: uid, show: s._id }) : null;
  res.json({ show: showDTO(s, eps.length), episodes: await episodesToDTO(eps, uid), is_following: !!following });
});

r.get('/episodes/:id', async (req, res) => {
  const [e] = await findEpisodes({ _id: oid(req.params.id) }, await ownCreatorIds(req)).limit(1);
  if (!e) throw notFound('Episode not found');
  const dto = (await episodesToDTO([e], uidOf(req)))[0];
  res.json({ episode: { ...dto, transcript: e.transcript || '' } });
});

/* ------------------------------ Genres ------------------------------ */

r.get('/genres', async (_req, res) => {
  const g = await Track.aggregate([{ $match: { ...publicFilter(), genre: { $ne: '' } } }, { $group: { _id: '$genre', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 60 }]);
  res.json({ genres: g.map((x) => ({ name: x._id, tracks: x.n })) });
});

r.get('/genres/:name', async (req, res) => {
  const re = new RegExp(`^${likeEscape(req.params.name)}$`, 'i');
  const uid = uidOf(req);
  const excluded = uid ? (await Exclude.find({ user: uid }).select('track').lean()).map((e) => e.track) : [];
  const rows = await findTracks({ genre: re, ...(excluded.length ? { _id: { $nin: excluded } } : {}) }, await ownCreatorIds(req)).sort({ plays: -1, createdAt: -1 }).limit(60);
  res.json({ genre: req.params.name, tracks: await tracksToDTO(rows, uid) });
});

/* ------------------------------ Streaming ------------------------------ */
// Range requests (seeking) are handled by res.sendFile. Owners can preview unpublished items.

async function streamFile(req, res, Model, id) {
  if (!req.user) throw new HttpError(401, 'Sign in to stream audio', 'unauthorized');
  const doc = await Model.findById(oid(id)).select('audio mime published hidden artist show storageDriver storageParts collabs').lean();
  if (!doc) throw notFound();
  if (isBlocked(doc.artist) || isShowBlocked(doc.show)) throw notFound(); // lives on a private creator page or in a private podcast this viewer may not see
  if (!doc.published || doc.hidden) {
    // Private (or moderated) items: the owning account, and accepted collaborators' accounts, may still stream a private one.
    const mine = await ownCreatorIds(req);
    const ok = mine.some((id) => String(id) === String(doc.artist)) || (doc.published === false && !doc.hidden && (doc.collabs || []).some((c) => c.status === 'accepted' && mine.some((id) => String(id) === String(c.creator))));
    if (!ok) throw notFound();
  }
  if (doc.storageDriver === 'postfile') {
    res.set('Cache-Control', 'private, no-store');
    // A big file kept as several parts is always stitched together here, so it plays as one seekable stream.
    if (doc.storageParts?.length > 1) return streamParts(req, res, doc.storageParts, doc.mime);
    // Otherwise the bytes normally never touch this server: a redirect to PostFile's CDN (essential on Vercel, where
    // function responses are capped at 4.5 MB when buffered). The browser asks for ?proxy=1 only when it needs the audio
    // to be same-origin (the equalizer), or STREAM_PROXY=always says to do it for everyone.
    if (STREAM_PROXY === 'always' || req.query.proxy === '1') return proxyFile(req, res, doc.audio, doc.mime);
    return res.redirect(302, assertTrustedUrl(doc.audio));
  }
  const file = path.join(AUDIO_DIR, path.basename(doc.audio));
  let stat;
  try { stat = await fs.promises.stat(file); } catch { throw new HttpError(410, 'Audio file is missing on the server', 'file_missing'); }
  const total = plainSize(stat.size);
  const rg = parseRange(req.headers.range, total);
  if (!rg) return res.status(416).set('Content-Range', `bytes */${total}`).end();
  const { start, end } = rg;
  const status = rg.partial ? 206 : 200;
  res.status(status);
  res.set({
    'Content-Type': doc.mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Cache-Control': 'private, max-age=0, no-store', // decrypted per-request; never cache the plaintext
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
  });
  if (status === 206) res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  try { await streamDecryptedRange(file, res, start, end); } catch (e) { if (!res.headersSent) throw e; else res.destroy(); }
}
r.get('/stream/track/:id', (req, res, next) => streamFile(req, res, Track, req.params.id).catch(next));
r.get('/stream/episode/:id', (req, res, next) => streamFile(req, res, Episode, req.params.id).catch(next));

export default r;
