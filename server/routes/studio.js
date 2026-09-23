import { Router } from 'express';
import path from 'node:path';
import { Creator, Track, Album, Show, Episode, Follow, Play } from '../db.js';
import { requireAuth, sessionOnly, requireApprovedCreator, myCreator } from '../auth.js';
import { tracksToDTO, albumsToDTO, showsToDTO, episodesToDTO, creatorDTO, TRACK_POP, EPISODE_POP, sid } from '../serialize.js';
import { upload, inspectAudio, mimeFor, removeAudio, removeImage, cleanupUploads } from '../uploads.js';
import { oid, bad, notFound, forbidden, str, truthy, clampInt, uniqueSlug, imgUrl, isOid } from '../util.js';

const r = Router();
const asOwner = [requireAuth, sessionOnly];
const media = upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }, { name: 'image', maxCount: 1 }]);

/** Wrap upload handlers so half-finished uploads never leave orphan files behind. */
const withUploads = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { cleanupUploads(req); next(e); }
};
const fileOf = (req, field) => req.files?.[field]?.[0];

const parseLinks = (v) => {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = []; } }
  return (Array.isArray(arr) ? arr : []).slice(0, 8)
    .map((l) => ({ label: str(l.label, 30), url: str(l.url, 200) }))
    .filter((l) => /^https?:\/\//i.test(l.url));
};
const FOCUS = ['music', 'podcasts', 'both'];

/* ------------------------------ Applying for a creator page ------------------------------ */

r.post('/studio/request', ...asOwner, async (req, res) => {
  const name = str(req.body.name, 60);
  if (name.length < 2) throw bad('Pick a name for your page (2+ characters)');
  const focus = FOCUS.includes(req.body.focus) ? req.body.focus : 'music';
  const existing = await myCreator(req.user._id);
  if (existing && existing.status === 'approved') throw bad('Your page is already approved — edit it from the studio', 'already_approved');
  if (existing && existing.status === 'suspended') throw forbidden('This page is suspended. Contact the moderators.');
  const data = { name, bio: str(req.body.bio, 1000), focus, links: parseLinks(req.body.links), status: 'pending', requestedAt: new Date(), reviewNote: null };
  const c = existing
    ? await Creator.findByIdAndUpdate(existing._id, data, { new: true })
    : await Creator.create({ ...data, user: req.user._id, slug: await uniqueSlug(name) });
  res.status(existing ? 200 : 201).json({ creator: creatorDTO(c), status: c.status });
});

/* ------------------------------ Studio dashboard ------------------------------ */

r.get('/studio', ...asOwner, async (req, res) => {
  const c = await myCreator(req.user._id);
  if (!c) return res.json({ creator: null });
  const base = { creator: { ...creatorDTO(c), status: c.status, review_note: c.reviewNote || null, requested_at: c.requestedAt } };
  if (c.status !== 'approved') return res.json(base);

  const since = new Date(Date.now() - 30 * 86400000);
  const [tracks, albums, shows, followers, plays30, totalPlays] = await Promise.all([
    Track.find({ artist: c._id }).populate(TRACK_POP).sort({ createdAt: -1 }).lean(),
    Album.find({ artist: c._id }).populate('artist', 'name slug verified').sort({ releasedAt: -1 }).lean(),
    Show.find({ artist: c._id }).populate('artist', 'name slug').sort({ createdAt: -1 }).lean(),
    Follow.countDocuments({ artist: c._id }),
    Play.find({ creator: c._id, playedAt: { $gte: since } }).select('user playedAt msPlayed').lean(),
    Track.aggregate([{ $match: { artist: c._id } }, { $group: { _id: null, n: { $sum: '$plays' } } }]),
  ]);
  const episodes = await Episode.find({ artist: c._id }).populate(EPISODE_POP).sort({ publishedAt: -1 }).lean();
  const days = new Map();
  for (let i = 29; i >= 0; i--) days.set(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), 0);
  for (const p of plays30) { const k = p.playedAt.toISOString().slice(0, 10); if (days.has(k)) days.set(k, days.get(k) + 1); }
  const trackDtos = await tracksToDTO(tracks, null);
  res.json({
    ...base,
    stats: {
      followers, total_plays: totalPlays[0]?.n || 0, plays_30d: plays30.length,
      listeners_30d: new Set(plays30.map((p) => String(p.user))).size,
      minutes_30d: Math.round(plays30.reduce((n, p) => n + p.msPlayed, 0) / 60000),
      by_day: [...days].map(([date, plays]) => ({ date, plays })),
    },
    tracks: trackDtos.map((t, i) => ({ ...t, published: tracks[i].published, hidden: tracks[i].hidden })),
    albums: await albumsToDTO(albums),
    shows: await showsToDTO(shows),
    episodes: (await episodesToDTO(episodes, null)).map((e, i) => ({ ...e, published: episodes[i].published, hidden: episodes[i].hidden })),
  });
});

r.patch('/studio/profile', ...asOwner, media, withUploads(async (req, res) => {
  const c = await myCreator(req.user._id);
  if (!c) throw notFound('No creator page yet');
  if ('name' in req.body) { const n = str(req.body.name, 60); if (n.length < 2) throw bad('Name is too short'); c.name = n; }
  if ('bio' in req.body) c.bio = str(req.body.bio, 1000);
  if (FOCUS.includes(req.body.focus)) c.focus = req.body.focus;
  if ('links' in req.body) c.links = parseLinks(req.body.links);
  const img = fileOf(req, 'image');
  if (img) { removeImage(c.image); c.image = img.filename; }
  await c.save();
  res.json({ creator: creatorDTO(c) });
}));

/* ------------------------------ Tracks ------------------------------ */

async function ownAlbum(creator, id) {
  if (!id || id === 'null' || id === '') return null;
  if (!isOid(id)) throw bad('Unknown album');
  const al = await Album.findOne({ _id: id, artist: creator._id }).select('_id').lean();
  if (!al) throw bad('That album is not yours');
  return al._id;
}

r.post('/studio/tracks', requireApprovedCreator, media, withUploads(async (req, res) => {
  const audio = fileOf(req, 'audio');
  if (!audio) throw bad('Choose an audio file to upload', 'no_audio');
  const info = await inspectAudio(audio.filename);
  if (info.durationMs < 1000) throw bad('That audio file is empty or too short');
  const cover = fileOf(req, 'cover');
  const filenameTitle = path.basename(audio.originalname, path.extname(audio.originalname)).replace(/[_-]+/g, ' ');
  const albumId = await ownAlbum(req.creator, req.body.album_id);
  let trackNo = clampInt(req.body.track_no, info.trackNo || 0, 0, 999);
  if (!trackNo) trackNo = albumId ? (await Track.countDocuments({ album: albumId })) + 1 : 1;
  if (cover && info.cover) removeImage(info.cover);
  const t = await Track.create({
    artist: req.creator._id, album: albumId,
    title: str(req.body.title, 120) || info.title || filenameTitle,
    credits: str(req.body.credits, 200), genre: str(req.body.genre, 40) || info.genre,
    durationMs: info.durationMs, audio: audio.filename, mime: mimeFor(audio.filename),
    cover: cover?.filename || info.cover || undefined,
    lyrics: (typeof req.body.lyrics === 'string' ? req.body.lyrics : info.lyrics).slice(0, 40000),
    explicit: truthy(req.body.explicit), trackNo,
    published: 'published' in req.body ? truthy(req.body.published) : true,
  });
  const [row] = await Track.find({ _id: t._id }).populate(TRACK_POP).lean();
  res.status(201).json({ track: (await tracksToDTO([row], null))[0] });
}));

r.get('/studio/tracks/:id', requireApprovedCreator, async (req, res) => {
  const t = await Track.findOne({ _id: oid(req.params.id), artist: req.creator._id }).populate(TRACK_POP).lean();
  if (!t) throw notFound('Track not found');
  res.json({ track: { ...(await tracksToDTO([t], null))[0], lyrics: t.lyrics, published: t.published, hidden: t.hidden } });
});

r.patch('/studio/tracks/:id', requireApprovedCreator, media, withUploads(async (req, res) => {
  const t = await Track.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!t) throw notFound('Track not found');
  const b = req.body;
  if ('title' in b) { const v = str(b.title, 120); if (!v) throw bad('Title cannot be empty'); t.title = v; }
  if ('credits' in b) t.credits = str(b.credits, 200);
  if ('genre' in b) t.genre = str(b.genre, 40);
  if ('lyrics' in b) t.lyrics = String(b.lyrics || '').slice(0, 40000);
  if ('explicit' in b) t.explicit = truthy(b.explicit);
  if ('published' in b) t.published = truthy(b.published);
  if ('track_no' in b) t.trackNo = clampInt(b.track_no, t.trackNo, 0, 999);
  if ('album_id' in b) t.album = await ownAlbum(req.creator, b.album_id);
  const cover = fileOf(req, 'cover');
  if (cover) { removeImage(t.cover); t.cover = cover.filename; }
  if (truthy(b.remove_cover) && !cover) { removeImage(t.cover); t.cover = undefined; }
  await t.save();
  const [row] = await Track.find({ _id: t._id }).populate(TRACK_POP).lean();
  res.json({ track: { ...(await tracksToDTO([row], null))[0], lyrics: t.lyrics, published: t.published } });
}));

r.delete('/studio/tracks/:id', requireApprovedCreator, async (req, res) => {
  const t = await Track.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!t) throw notFound('Track not found');
  removeAudio(t.audio); removeImage(t.cover);
  await t.deleteOne();
  res.json({ ok: true });
});

/* ------------------------------ Albums ------------------------------ */

r.post('/studio/albums', requireApprovedCreator, media, withUploads(async (req, res) => {
  const title = str(req.body.title, 120);
  if (!title) throw bad('Give the release a title');
  const kind = ['album', 'single', 'ep'].includes(req.body.kind) ? req.body.kind : 'album';
  const cover = fileOf(req, 'cover');
  const al = await Album.create({
    artist: req.creator._id, title, kind, description: str(req.body.description, 600), cover: cover?.filename,
    releasedAt: req.body.released_at && !isNaN(Date.parse(req.body.released_at)) ? new Date(req.body.released_at) : new Date(),
  });
  res.status(201).json({ album: (await albumsToDTO([{ ...al.toObject(), artist: req.creator }]))[0] });
}));

r.patch('/studio/albums/:id', requireApprovedCreator, media, withUploads(async (req, res) => {
  const al = await Album.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!al) throw notFound('Release not found');
  if ('title' in req.body) { const t = str(req.body.title, 120); if (!t) throw bad('Title cannot be empty'); al.title = t; }
  if ('description' in req.body) al.description = str(req.body.description, 600);
  if (['album', 'single', 'ep'].includes(req.body.kind)) al.kind = req.body.kind;
  const cover = fileOf(req, 'cover');
  if (cover) { removeImage(al.cover); al.cover = cover.filename; }
  await al.save();
  res.json({ album: (await albumsToDTO([{ ...al.toObject(), artist: req.creator }]))[0] });
}));

r.delete('/studio/albums/:id', requireApprovedCreator, async (req, res) => {
  const al = await Album.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!al) throw notFound('Release not found');
  await Track.updateMany({ album: al._id }, { $set: { album: null } }); // tracks stay as standalone songs
  removeImage(al.cover);
  await al.deleteOne();
  res.json({ ok: true });
});

/* ------------------------------ Podcasts ------------------------------ */

r.post('/studio/shows', requireApprovedCreator, media, withUploads(async (req, res) => {
  const title = str(req.body.title, 120);
  if (!title) throw bad('Give the show a title');
  const cover = fileOf(req, 'cover');
  const s = await Show.create({
    artist: req.creator._id, title, description: str(req.body.description, 1500), category: str(req.body.category, 40),
    language: str(req.body.language, 8) || 'en', explicit: truthy(req.body.explicit), cover: cover?.filename,
  });
  res.status(201).json({ show: (await showsToDTO([{ ...s.toObject(), artist: req.creator }]))[0] });
}));

r.patch('/studio/shows/:id', requireApprovedCreator, media, withUploads(async (req, res) => {
  const s = await Show.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!s) throw notFound('Show not found');
  const b = req.body;
  if ('title' in b) { const t = str(b.title, 120); if (!t) throw bad('Title cannot be empty'); s.title = t; }
  if ('description' in b) s.description = str(b.description, 1500);
  if ('category' in b) s.category = str(b.category, 40);
  if ('language' in b) s.language = str(b.language, 8) || 'en';
  if ('explicit' in b) s.explicit = truthy(b.explicit);
  const cover = fileOf(req, 'cover');
  if (cover) { removeImage(s.cover); s.cover = cover.filename; }
  await s.save();
  res.json({ show: (await showsToDTO([{ ...s.toObject(), artist: req.creator }]))[0] });
}));

r.delete('/studio/shows/:id', requireApprovedCreator, async (req, res) => {
  const s = await Show.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!s) throw notFound('Show not found');
  const eps = await Episode.find({ show: s._id }).select('audio').lean();
  eps.forEach((e) => removeAudio(e.audio));
  await Episode.deleteMany({ show: s._id });
  removeImage(s.cover);
  await s.deleteOne();
  res.json({ ok: true });
});

r.post('/studio/shows/:id/episodes', requireApprovedCreator, media, withUploads(async (req, res) => {
  const show = await Show.findOne({ _id: oid(req.params.id), artist: req.creator._id }).lean();
  if (!show) throw notFound('Show not found');
  const audio = fileOf(req, 'audio');
  if (!audio) throw bad('Choose an audio file for this episode', 'no_audio');
  const info = await inspectAudio(audio.filename);
  if (info.cover) removeImage(info.cover);
  const last = await Episode.findOne({ show: show._id }).sort({ season: -1, number: -1 }).select('season number').lean();
  const title = str(req.body.title, 140) || info.title || path.basename(audio.originalname, path.extname(audio.originalname));
  const ep = await Episode.create({
    show: show._id, artist: req.creator._id, title, description: str(req.body.description, 5000),
    audio: audio.filename, mime: mimeFor(audio.filename), durationMs: info.durationMs,
    season: clampInt(req.body.season, last?.season || 1, 1, 99),
    number: clampInt(req.body.number, (last?.number || 0) + 1, 1, 9999),
    transcript: String(req.body.transcript || '').slice(0, 200000),
    published: 'published' in req.body ? truthy(req.body.published) : true,
  });
  const [row] = await Episode.find({ _id: ep._id }).populate(EPISODE_POP).lean();
  res.status(201).json({ episode: (await episodesToDTO([row], null))[0] });
}));

r.patch('/studio/episodes/:id', requireApprovedCreator, async (req, res) => {
  const e = await Episode.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!e) throw notFound('Episode not found');
  const b = req.body || {};
  if ('title' in b) { const t = str(b.title, 140); if (!t) throw bad('Title cannot be empty'); e.title = t; }
  if ('description' in b) e.description = str(b.description, 5000);
  if ('transcript' in b) e.transcript = String(b.transcript || '').slice(0, 200000);
  if ('published' in b) e.published = truthy(b.published);
  if ('season' in b) e.season = clampInt(b.season, e.season, 1, 99);
  if ('number' in b) e.number = clampInt(b.number, e.number, 1, 9999);
  await e.save();
  const [row] = await Episode.find({ _id: e._id }).populate(EPISODE_POP).lean();
  res.json({ episode: (await episodesToDTO([row], null))[0] });
});

r.delete('/studio/episodes/:id', requireApprovedCreator, async (req, res) => {
  const e = await Episode.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!e) throw notFound('Episode not found');
  removeAudio(e.audio);
  await e.deleteOne();
  res.json({ ok: true });
});

export default r;
