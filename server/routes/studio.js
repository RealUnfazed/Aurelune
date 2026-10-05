import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Creator, Track, Album, Show, Episode, Follow, Play, Like, EpisodeLike, UploadChunk, UploadSession } from '../db.js';
import { requireAuth, sessionOnly, requireApprovedCreator, myCreator, myCreators, wantedPage, creatorLimitFor, usedSlots } from '../auth.js';
import { tracksToDTO, albumsToDTO, showsToDTO, episodesToDTO, creatorDTO, TRACK_POP, EPISODE_POP, sid } from '../serialize.js';
import { isBlocked, notBlocked } from '../privacy.js';
import { upload, inspectAudio, inspectBuffer, stageCover, mimeFor, isAudioName, cleanupUploads } from '../uploads.js';
import { storeAudio, storeImage, deleteAudio, deleteImage, resolveDriver, uploadPart, deleteParts, partsNeeded, poolStatus } from '../storage.js';
import { oid, bad, notFound, forbidden, str, truthy, clampInt, uniqueSlug, imgUrl, isOid, likeEscape } from '../util.js';
import { availableDrivers, defaultDriver, IS_SERVERLESS, CHUNKED_UPLOAD, CHUNK_BYTES, PART_BYTES, POSTFILE_API_KEYS, MAX_AUDIO_MB, AUDIO_DIR } from '../config.js';

const r = Router();
const asOwner = [requireAuth, sessionOnly];
const media = upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }, { name: 'image', maxCount: 1 }]);

/** Wrap upload handlers so half-finished uploads never leave orphan files behind (local ones, or parts already sent to PostFile). */
const withUploads = (fn) => async (req, res, next) => {
  try { await fn(req, res); }
  catch (e) {
    cleanupUploads(req);
    const sess = req.files?.audio?.[0]?.session;
    if (sess) { deleteParts(sess.parts); UploadSession.deleteOne({ uploadId: sess.uploadId }).catch(() => {}); }
    next(e);
  }
};
const fileOf = (req, field) => req.files?.[field]?.[0];

/** Public/private for a track or episode. `visibility: "private"` (or `published: false`) keeps it visible to its creator only. */
const publishedFlag = (b, fallback = true) => ('visibility' in b ? String(b.visibility).toLowerCase() !== 'private' : 'published' in b ? truthy(b.published) : fallback);

const parseLinks = (v) => {
  let arr = v;
  if (typeof v === 'string') { try { arr = JSON.parse(v); } catch { arr = []; } }
  return (Array.isArray(arr) ? arr : []).slice(0, 8)
    .map((l) => ({ label: str(l.label, 30), url: str(l.url, 200) }))
    .filter((l) => /^https?:\/\//i.test(l.url));
};
const FOCUS = ['music', 'podcasts', 'both'];

/** Uploads a cover image via the requested driver and returns a DB-ready ref, or undefined if none given. */
async function coverRef(req, driver, field = 'cover') {
  const file = fileOf(req, field);
  if (!file) return undefined;
  return storeImage(file.filename, { driver, originalName: file.originalname, mime: file.mimetype });
}

/* ------------------------------ Storage options (for the upload UI) ------------------------------ */

r.get('/studio/storage-options', requireAuth, async (_req, res) => {
  // `serverless` tells the UI request bodies are capped (~4.5 MB on Vercel); `chunked` is how bigger files get through anyway.
  res.json({
    drivers: availableDrivers(), default: defaultDriver(), serverless: IS_SERVERLESS,
    chunked: CHUNKED_UPLOAD, chunk_bytes: CHUNK_BYTES, max_mb: MAX_AUDIO_MB,
    // PostFile files bigger than part_bytes are cut into parts automatically (and spread over keys, if there are several).
    part_bytes: PART_BYTES, postfile_keys: POSTFILE_API_KEYS.length,
  });
});

/* ------------------------------ Chunked uploads (for hosts that cap request bodies) ------------------------------
 * The browser slices the audio file into ~3 MB pieces and PUTs each one here (every request stays far below
 * Vercel's 4.5 MB cap). The pieces wait in MongoDB (any serverless instance can see them); when the normal
 * create-track / create-episode form arrives with an `upload_id`, they are joined into one staged file and the
 * request carries on exactly as if that file had been attached — tags, duration and artwork included.
 */
const UPLOAD_ID = /^[a-f0-9]{32}$/;
const MAX_CHUNKS = 400;

r.put('/studio/chunks/:uploadId/:index', requireApprovedCreator, express.raw({ type: () => true, limit: '4mb' }), async (req, res) => {
  const { uploadId } = req.params;
  const index = Number(req.params.index);
  if (!UPLOAD_ID.test(uploadId)) throw bad('Invalid upload id');
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNKS) throw bad('Invalid chunk number');
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('Empty chunk');
  // Re-sending a chunk after a network hiccup is safe: it just replaces the earlier copy.
  await UploadChunk.updateOne(
    { uploadId, index },
    { $set: { creator: req.creator._id, data: req.body, createdAt: new Date() } },
    { upsert: true },
  );
  res.json({ ok: true, index, bytes: req.body.length });
});

/* ------------------------------ Big files: one PostFile part per request ------------------------------
 * A 200 MB podcast can't be joined and re-uploaded inside one 60-second serverless request. Instead the browser sends the
 * relay chunks for part N and then calls this to hand part N to PostFile (to the next API key in rotation). The create
 * request that follows only has to point at the finished session.
 */
const MAX_PARTS = 60;

r.post('/studio/uploads/:uploadId/parts/:n', requireApprovedCreator, express.json({ limit: '20kb' }), async (req, res) => {
  const { uploadId } = req.params;
  const n = Number(req.params.n);
  const b = req.body || {};
  if (!UPLOAD_ID.test(uploadId)) throw bad('Invalid upload id');
  if (!availableDrivers().includes('postfile')) throw bad('PostFile storage is not configured on this server', 'bad_storage');
  const filename = String(b.filename || '');
  if (!isAudioName(filename)) throw bad('Unsupported audio type. Use MP3, M4A, AAC, OGG, OPUS, FLAC or WAV.', 'bad_audio');
  const total = Number(b.total_size);
  if (!Number.isInteger(total) || total < 1) throw bad('Missing file size');
  if (total > MAX_AUDIO_MB * 1048576) throw bad(`That file is over the ${MAX_AUDIO_MB} MB limit.`, 'too_large');
  const partCount = partsNeeded(total);
  if (!Number.isInteger(n) || n < 0 || n >= partCount || partCount > MAX_PARTS) throw bad('Invalid part number');
  const first = Number(b.first_chunk), count = Number(b.chunk_count);
  if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 1 || count > MAX_CHUNKS) throw bad('Invalid chunk range');

  let sess = await UploadSession.findOne({ uploadId });
  if (sess && String(sess.creator) !== String(req.creator._id)) throw forbidden('That upload belongs to someone else');
  if (!sess) {
    sess = await UploadSession.findOneAndUpdate({ uploadId }, { $setOnInsert: { uploadId, creator: req.creator._id, filename, totalSize: total, partCount } }, { upsert: true, new: true });
  }
  if (sess.totalSize !== total || sess.partCount !== partCount) throw bad('This upload changed size part-way through. Start it again.');

  const done = sess.parts.find((p) => p.index === n);
  if (!done) {
    const rows = await UploadChunk.find({ uploadId, creator: req.creator._id, index: { $gte: first, $lt: first + count } }).sort({ index: 1 });
    if (rows.length !== count || rows.some((c, i) => c.index !== first + i)) throw bad(`Some pieces of part ${n + 1} never arrived (${rows.length} of ${count}). Please try again.`, 'incomplete_upload');
    const buf = Buffer.concat(rows.map((c) => Buffer.from(c.data)));
    const expected = Math.min(PART_BYTES, total - n * PART_BYTES);
    if (buf.length !== expected) throw bad(`Part ${n + 1} arrived with the wrong size (${buf.length} of ${expected} bytes). Please try again.`, 'incomplete_upload');

    const set = {};
    const clientMs = Number(b.duration_ms);
    if (Number.isFinite(clientMs) && clientMs >= 1000 && clientMs < 48 * 3600e3) set.durationMs = Math.round(clientMs);
    if (n === 0) { // tags and artwork live at the start of the file
      const t = await inspectBuffer(buf, filename, total);
      const { pic, durationMs, ...tags } = t;
      set.tags = { ...tags, durationMs };
      if (pic && pic.data.length <= 3 * 1048576) { set.cover = Buffer.from(pic.data); set.coverExt = pic.ext; }
    }
    const part = await uploadPart(buf, filename, mimeFor(filename), n, partCount);
    const upd = await UploadSession.updateOne({ uploadId, 'parts.index': { $ne: n } }, { $push: { parts: { index: n, ...part } }, ...(Object.keys(set).length ? { $set: set } : {}) });
    if (!upd.modifiedCount) await deleteParts([part]); // a retry of the same part won the race; drop the extra copy
  }
  UploadChunk.deleteMany({ uploadId, creator: req.creator._id, index: { $gte: first, $lt: first + count } }).catch(() => {});
  res.json({ ok: true, index: n, parts: partCount });
});

/** Presents a finished part-session as `req.files.audio`, as assembleChunks does for a joined file. */
async function sessionAudio(req) {
  const sess = await UploadSession.findOne({ uploadId: String(req.body.upload_session), creator: req.creator._id });
  if (!sess) throw bad('That upload expired or was never started. Please try again.', 'incomplete_upload');
  const parts = [...sess.parts].sort((a, b) => a.index - b.index);
  if (parts.length !== sess.partCount || parts.some((p, i) => p.index !== i) || parts.reduce((k, p) => k + p.size, 0) !== sess.totalSize) {
    throw bad(`Some parts of the upload never arrived (${parts.length} of ${sess.partCount}). Please try again.`, 'incomplete_upload');
  }
  const o = sess.toObject();
  o.parts = parts.map((p) => ({ index: p.index, fileId: p.fileId, url: p.url, size: p.size, key: p.key }));
  return { fieldname: 'audio', originalname: sess.filename, filename: '', size: sess.totalSize, mimetype: mimeFor(sess.filename), session: o };
}

/** What inspectAudio would return, for an audio file that was handed to PostFile in parts. */
async function infoFromSession(sess) {
  const t = sess.tags || {};
  return {
    durationMs: sess.durationMs || t.durationMs || 0, title: t.title || '', genre: t.genre || '', trackNo: t.trackNo || 0, lyrics: t.lyrics || '',
    cover: await stageCover(sess.cover?.buffer ? Buffer.from(sess.cover.buffer) : sess.cover ? Buffer.from(sess.cover) : null, sess.coverExt),
  };
}
const storedFromSession = (sess) => ({
  driver: 'postfile', ref: sess.parts[0].url, fileId: sess.parts[0].fileId,
  parts: sess.parts.length > 1 ? sess.parts.map(({ fileId, url, size, key }) => ({ fileId, url, size, key })) : undefined, size: sess.totalSize,
  key: sess.parts.length === 1 ? sess.parts[0].key : undefined,
});
const inspectUpload = (audio) => (audio.session ? infoFromSession(audio.session) : inspectAudio(audio.filename));

/** Joins uploaded chunks into a staged file and presents it as `req.files.audio`, as multer would have. */
async function assembleChunks(req, _res, next) {
  if (req.body?.upload_session && !req.files?.audio?.length) {
    try { req.files = { ...(req.files || {}), audio: [await sessionAudio(req)] }; return next(); } catch (e) { return next(e); }
  }
  const uploadId = req.body?.upload_id;
  if (!uploadId || req.files?.audio?.length) return next();
  const staged = { path: null };
  try {
    if (!UPLOAD_ID.test(String(uploadId))) throw bad('Invalid upload id');
    const count = Number(req.body.chunk_count);
    const name = String(req.body.filename || '');
    if (!Number.isInteger(count) || count < 1 || count > MAX_CHUNKS) throw bad('Invalid chunk count');
    if (!isAudioName(name)) throw bad('Unsupported audio type. Use MP3, M4A, AAC, OGG, OPUS, FLAC or WAV.', 'bad_audio');
    const rows = await UploadChunk.find({ uploadId, creator: req.creator._id }).select('index').sort({ index: 1 }).lean();
    if (rows.length !== count || rows.some((c, i) => c.index !== i)) {
      throw bad(`Some pieces of the upload never arrived (${rows.length} of ${count}). Please try again.`, 'incomplete_upload');
    }
    const filename = crypto.randomBytes(12).toString('hex') + path.extname(name).toLowerCase();
    staged.path = path.join(AUDIO_DIR, filename);
    resolveDriver(req.body.storage);
    const maxBytes = MAX_AUDIO_MB * 1024 * 1024;
    const out = fs.createWriteStream(staged.path);
    let size = 0;
    try {
      for (let i = 0; i < count; i++) {
        const c = await UploadChunk.findOne({ uploadId, index: i, creator: req.creator._id }).select('data');
        if (!c) throw bad('A piece of the upload went missing. Please try again.', 'incomplete_upload');
        const buf = Buffer.from(c.data);
        size += buf.length;
        if (size > maxBytes) throw bad(`That file is over the ${Math.round(maxBytes / 1048576)} MB limit.`, 'too_large');
        if (!out.write(buf)) await new Promise((r2) => out.once('drain', r2));
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    req.files = { ...(req.files || {}), audio: [{ fieldname: 'audio', originalname: name, filename, path: staged.path, size, mimetype: mimeFor(filename) }] };
    UploadChunk.deleteMany({ uploadId, creator: req.creator._id }).catch(() => {});
    next();
  } catch (e) {
    if (staged.path) fs.promises.unlink(staged.path).catch(() => {});
    next(e);
  }
}

/* ------------------------------ Applying for a creator page ------------------------------ */

const slotsOf = (user, pages) => {
  const limit = creatorLimitFor(user), used = usedSlots(pages);
  return { used, limit: Number.isFinite(limit) ? limit : null, unlimited: !Number.isFinite(limit), can_create: used < limit };
};
const pageBrief = (c) => ({ id: sid(c), name: c.name, slug: c.slug, status: c.status, private: !!c.isPrivate, image: creatorDTO(c).image });

/**
 * Apply for a creator page. An account can hold several: how many is up to the admins (per account), with a
 * server-wide default. With `page_id` the person is fixing and re-submitting one of their own rejected pages;
 * without it a brand-new page is created, if they still have a free slot.
 */
r.post('/studio/request', ...asOwner, async (req, res) => {
  const name = str(req.body.name, 60);
  if (name.length < 2) throw bad('Pick a name for your page (2+ characters)');
  const focus = FOCUS.includes(req.body.focus) ? req.body.focus : 'music';
  const pages = await myCreators(req.user._id);
  const data = { name, bio: str(req.body.bio, 1000), focus, links: parseLinks(req.body.links), status: 'pending', requestedAt: new Date(), reviewNote: null };

  if (req.body.page_id) {
    const existing = pages.find((c) => sid(c) === String(req.body.page_id));
    if (!existing) throw notFound('Unknown creator page');
    if (existing.status === 'approved') throw bad('That page is already approved. Edit it from the studio', 'already_approved');
    if (existing.status === 'suspended') throw forbidden('This page is suspended. Contact the moderators.');
    const c = await Creator.findByIdAndUpdate(existing._id, data, { new: true });
    return res.json({ creator: creatorDTO(c), status: c.status, slots: slotsOf(req.user, pages) });
  }

  const slots = slotsOf(req.user, pages);
  if (!slots.can_create) {
    throw forbidden(`You already have ${slots.used} creator page${slots.used === 1 ? '' : 's'}, the most your account allows. Ask an admin if you need more.`, 'creator_limit');
  }
  const c = await Creator.create({ ...data, user: req.user._id, slug: await uniqueSlug(name) });
  res.status(201).json({ creator: creatorDTO(c), status: c.status, slots: slotsOf(req.user, [...pages, c]) });
});

/** Remove a page that never went live (pending or rejected), freeing its slot. Approved pages hold content and stay. */
r.delete('/studio/pages/:id', ...asOwner, async (req, res) => {
  const c = await Creator.findOne({ _id: oid(req.params.id), user: req.user._id });
  if (!c) throw notFound('Unknown creator page');
  if (!['pending', 'rejected'].includes(c.status)) throw bad('Only a page that has not been approved can be removed here. Ask an admin to remove a live page.', 'page_live');
  deleteImage(c.image);
  await c.deleteOne();
  res.json({ ok: true });
});

/* ------------------------------ Studio dashboard ------------------------------ */

r.get('/studio', ...asOwner, async (req, res) => {
  const pages = await myCreators(req.user._id);
  const wanted = wantedPage(req);
  // The page the Studio asked for, else the first approved one, else the first of any kind.
  const c = wanted ? pages.find((p) => sid(p) === wanted) : (pages.find((p) => p.status === 'approved') || pages[0]);
  const pageIds = pages.map((p) => p._id);
  const pendingInvites = (await Promise.all([Track, Episode].map((M) => M.countDocuments({ collabPending: { $in: pageIds } })))).reduce((a, b) => a + b, 0);
  const meta = { pages: pages.map(pageBrief), slots: slotsOf(req.user, pages), pending_invites: pendingInvites };
  if (wanted && !c) throw notFound('Unknown creator page', 'no_such_page');
  if (!c) return res.json({ creator: null, ...meta });
  const base = { ...meta, creator: { ...creatorDTO(c), status: c.status, review_note: c.reviewNote || null, requested_at: c.requestedAt } };
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
    tracks: trackDtos.map((t, i) => ({ ...t, published: tracks[i].published, hidden: tracks[i].hidden, storage: tracks[i].storageDriver })),
    albums: await albumsToDTO(albums),
    shows: await showsToDTO(shows),
    episodes: (await episodesToDTO(episodes, null)).map((e, i) => ({ ...e, published: episodes[i].published, hidden: episodes[i].hidden, storage: episodes[i].storageDriver })),
  });
});

r.patch('/studio/profile', ...asOwner, media, withUploads(async (req, res) => {
  const c = await myCreator(req.user._id, wantedPage(req));
  if (!c) throw notFound('No creator page yet');
  if ('name' in req.body) { const n = str(req.body.name, 60); if (n.length < 2) throw bad('Name is too short'); c.name = n; }
  if ('bio' in req.body) c.bio = str(req.body.bio, 1000);
  if (FOCUS.includes(req.body.focus)) c.focus = req.body.focus;
  if ('links' in req.body) c.links = parseLinks(req.body.links);
  // Private page: only this account (and admins) can see the page and everything on it.
  if ('visibility' in req.body) c.isPrivate = String(req.body.visibility).toLowerCase() === 'private';
  else if ('private' in req.body) c.isPrivate = truthy(req.body.private);
  const img = fileOf(req, 'image');
  if (img) {
    const driver = resolveDriver(req.body.storage);
    const ref = await storeImage(img.filename, { driver, originalName: img.originalname, mime: img.mimetype });
    deleteImage(c.image);
    c.image = ref;
  }
  await c.save();
  res.json({ creator: creatorDTO(c) });
}));

/* ------------------------------ Collaborations ------------------------------
 * A track or episode can credit other creator pages. Crediting one of your own other pages is instant; crediting someone
 * else's page sends an invitation that their owner accepts or declines in the Studio. Only accepted collaborators are shown
 * publicly and get the item on their page; they can also leave later (which just removes them).
 */
const MAX_COLLABS = 8;
const idList = (v) => {
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = v.split(','); } }
  return [...new Set((Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter(isOid))];
};

/** The new `collabs` array for an item, from the list of page ids the uploader picked. Existing answers are kept. */
async function buildCollabs(req, artistId, input, previous = []) {
  const want = idList(input).filter((id) => id !== String(artistId));
  if (want.length > MAX_COLLABS) throw bad(`You can credit up to ${MAX_COLLABS} other pages on one item`);
  const found = want.length ? await Creator.find({ _id: { $in: want }, status: 'approved' }).select('_id user').lean() : [];
  const visible = found.filter((c) => !isBlocked(c._id)); // other people's private pages can't be discovered, so can't be invited
  if (visible.length !== want.length) throw bad('One of those artist pages could not be found', 'unknown_artist');
  const before = new Map(previous.map((c) => [String(c.creator?._id ?? c.creator), c]));
  return want.map((id) => {
    const c = visible.find((v) => String(v._id) === id);
    const prev = before.get(id);
    const mine = String(c.user) === String(req.user._id);
    return { creator: c._id, status: mine ? 'accepted' : (prev?.status || 'pending'), invitedAt: prev?.invitedAt || new Date() };
  });
}

/** Typeahead for the collaborator picker. */
r.get('/studio/artists', requireApprovedCreator, async (req, res) => {
  const q = str(req.query.q, 60);
  const re = q ? new RegExp(likeEscape(q), 'i') : null;
  const rows = await Creator.find({ status: 'approved', _id: { $ne: req.creator._id }, ...(re ? { name: re } : {}), ...notBlocked('_id') })
    .sort({ verified: -1, name: 1 }).limit(10).lean();
  res.json({ artists: rows.map((c) => ({ ...creatorDTO(c), mine: String(c.user) === String(req.user._id) })) });
});

const COLLAB_KINDS = { track: { Model: Track, pop: TRACK_POP }, episode: { Model: Episode, pop: EPISODE_POP } };

/** Invitations (and accepted credits) for the pages this account owns. */
r.get('/studio/collabs', ...asOwner, async (req, res) => {
  const pages = await myCreators(req.user._id);
  const ids = pages.map((p) => p._id);
  const out = [];
  for (const [kind, { Model, pop }] of Object.entries(COLLAB_KINDS)) {
    const rows = await Model.find({ $or: [{ collabAccepted: { $in: ids } }, { collabPending: { $in: ids } }] }).populate(pop).sort({ createdAt: -1 }).limit(100).lean();
    const dtos = await (kind === 'track' ? tracksToDTO(rows, null) : episodesToDTO(rows, null));
    rows.forEach((row, i) => {
      if (isBlocked(row.artist?._id)) return;
      for (const c of row.collabs) {
        const page = pages.find((p) => String(p._id) === String(c.creator?._id ?? c.creator));
        if (!page) continue;
        out.push({
          kind, id: sid(row), title: row.title, cover: dtos[i].cover, status: c.status, invited_at: c.invitedAt,
          by: { id: sid(row.artist), name: row.artist.name, slug: row.artist.slug }, page: { id: sid(page), name: page.name },
        });
      }
    });
  }
  out.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || new Date(b.invited_at) - new Date(a.invited_at));
  res.json({ collabs: out, pending: out.filter((c) => c.status === 'pending').length });
});

/** accept | decline (declining an accepted credit is how a collaborator leaves). */
r.post('/studio/collabs/:kind/:id/:action', ...asOwner, async (req, res) => {
  const K = COLLAB_KINDS[req.params.kind];
  if (!K || !['accept', 'decline'].includes(req.params.action)) throw notFound();
  const doc = await K.Model.findById(oid(req.params.id));
  if (!doc) throw notFound('Not found');
  const mine = new Set((await myCreators(req.user._id)).map((p) => sid(p)));
  const only = req.body?.page_id ? String(req.body.page_id) : null;
  const entries = (doc.collabs || []).filter((c) => mine.has(String(c.creator)) && (!only || String(c.creator) === only));
  if (!entries.length) throw notFound('No invitation for you on that item');
  if (req.params.action === 'accept') for (const c of entries) c.status = 'accepted';
  else doc.collabs = doc.collabs.filter((c) => !entries.includes(c));
  await doc.save();
  res.json({ ok: true, status: req.params.action === 'accept' ? 'accepted' : 'declined' });
});

/* ------------------------------ Tracks ------------------------------ */

async function ownAlbum(creator, id) {
  if (!id || id === 'null' || id === '') return null;
  if (!isOid(id)) throw bad('Unknown album');
  const al = await Album.findOne({ _id: id, artist: creator._id }).select('_id').lean();
  if (!al) throw bad('That album is not yours');
  return al._id;
}

r.post('/studio/tracks', requireApprovedCreator, media, assembleChunks, withUploads(async (req, res) => {
  const audio = fileOf(req, 'audio');
  if (!audio) throw bad('Choose an audio file to upload', 'no_audio');
  const driver = resolveDriver(req.body.storage);
  const collabs = await buildCollabs(req, req.creator._id, req.body.collaborators); // validated before anything is stored
  if (audio.session && driver !== 'postfile') throw bad('Parts were uploaded to PostFile, so this has to be a PostFile upload', 'bad_storage');
  const info = await inspectUpload(audio); // reads tags/duration/embedded art from the still-local staged file (or from the session of a part-by-part upload)
  if (info.durationMs < 1000) throw bad('That audio file is empty or too short');
  const cover = fileOf(req, 'cover');
  const filenameTitle = path.basename(audio.originalname, path.extname(audio.originalname)).replace(/[_-]+/g, ' ');
  const albumId = await ownAlbum(req.creator, req.body.album_id);
  let trackNo = clampInt(req.body.track_no, info.trackNo || 0, 0, 999);
  if (!trackNo) trackNo = albumId ? (await Track.countDocuments({ album: albumId })) + 1 : 1;

  // Cover priority: an explicitly uploaded cover, else the artwork embedded in the audio file itself.
  let coverField = cover ? await coverRef(req, driver) : undefined;
  if (!coverField && info.cover) coverField = await storeImage(info.cover, { driver, originalName: info.cover, mime: 'image/jpeg' });
  else if (info.cover) deleteImage(info.cover);

  const stored = audio.session ? storedFromSession(audio.session) : await storeAudio(audio.filename, { driver, originalName: audio.originalname, mime: mimeFor(audio.filename) });
  const t = await Track.create({
    artist: req.creator._id, album: albumId,
    title: str(req.body.title, 120) || info.title || filenameTitle,
    credits: str(req.body.credits, 200), genre: str(req.body.genre, 40) || info.genre,
    durationMs: info.durationMs, audio: stored.ref, storageDriver: stored.driver, storageFileId: stored.fileId, storageKey: stored.key, storageParts: stored.parts, audioSize: stored.size, mime: mimeFor(audio.originalname),
    cover: coverField,
    lyrics: (typeof req.body.lyrics === 'string' ? req.body.lyrics : info.lyrics).slice(0, 40000),
    explicit: truthy(req.body.explicit), trackNo,
    published: publishedFlag(req.body),
    collabs,
  });
  if (audio.session) UploadSession.deleteOne({ uploadId: audio.session.uploadId }).catch(() => {});
  const [row] = await Track.find({ _id: t._id }).populate(TRACK_POP).lean();
  res.status(201).json({ track: (await tracksToDTO([row], null))[0] });
}));

r.get('/studio/tracks/:id', requireApprovedCreator, async (req, res) => {
  const t = await Track.findOne({ _id: oid(req.params.id), artist: req.creator._id }).populate(TRACK_POP).lean();
  if (!t) throw notFound('Track not found');
  res.json({ track: { ...(await tracksToDTO([t], null))[0], lyrics: t.lyrics, published: t.published, hidden: t.hidden, storage: t.storageDriver } });
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
  if ('published' in b || 'visibility' in b) t.published = publishedFlag(b, t.published);
  if ('track_no' in b) t.trackNo = clampInt(b.track_no, t.trackNo, 0, 999);
  if ('collaborators' in b) t.collabs = await buildCollabs(req, t.artist, b.collaborators, t.collabs);
  if ('album_id' in b) t.album = await ownAlbum(req.creator, b.album_id);
  const cover = fileOf(req, 'cover');
  if (cover) {
    const ref = await coverRef(req, resolveDriver(req.body.storage));
    deleteImage(t.cover);
    t.cover = ref;
  } else if (truthy(b.remove_cover)) { deleteImage(t.cover); t.cover = undefined; }
  await t.save();
  const [row] = await Track.find({ _id: t._id }).populate(TRACK_POP).lean();
  res.json({ track: { ...(await tracksToDTO([row], null))[0], lyrics: t.lyrics, published: t.published } });
}));

r.delete('/studio/tracks/:id', requireApprovedCreator, async (req, res) => {
  const t = await Track.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!t) throw notFound('Track not found');
  await deleteAudio(t); deleteImage(t.cover);
  await t.deleteOne();
  await Like.deleteMany({ track: t._id });
  res.json({ ok: true });
});

/* ------------------------------ Albums ------------------------------ */

r.post('/studio/albums', requireApprovedCreator, media, withUploads(async (req, res) => {
  const title = str(req.body.title, 120);
  if (!title) throw bad('Give the release a title');
  const kind = ['album', 'single', 'ep'].includes(req.body.kind) ? req.body.kind : 'album';
  const cover = await coverRef(req, resolveDriver(req.body.storage));
  const al = await Album.create({
    artist: req.creator._id, title, kind, description: str(req.body.description, 600), cover,
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
  const ref = await coverRef(req, resolveDriver(req.body.storage));
  if (ref) { deleteImage(al.cover); al.cover = ref; }
  await al.save();
  res.json({ album: (await albumsToDTO([{ ...al.toObject(), artist: req.creator }]))[0] });
}));

r.delete('/studio/albums/:id', requireApprovedCreator, async (req, res) => {
  const al = await Album.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!al) throw notFound('Release not found');
  await Track.updateMany({ album: al._id }, { $set: { album: null } }); // tracks stay as standalone songs
  deleteImage(al.cover);
  await al.deleteOne();
  res.json({ ok: true });
});

/* ------------------------------ Podcasts ------------------------------ */

r.post('/studio/shows', requireApprovedCreator, media, withUploads(async (req, res) => {
  const title = str(req.body.title, 120);
  if (!title) throw bad('Give the show a title');
  const cover = await coverRef(req, resolveDriver(req.body.storage));
  const s = await Show.create({
    artist: req.creator._id, title, description: str(req.body.description, 1500), category: str(req.body.category, 40),
    language: str(req.body.language, 8) || 'en', explicit: truthy(req.body.explicit), cover,
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
  const ref = await coverRef(req, resolveDriver(req.body.storage));
  if (ref) { deleteImage(s.cover); s.cover = ref; }
  await s.save();
  res.json({ show: (await showsToDTO([{ ...s.toObject(), artist: req.creator }]))[0] });
}));

r.delete('/studio/shows/:id', requireApprovedCreator, async (req, res) => {
  const s = await Show.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!s) throw notFound('Show not found');
  const eps = await Episode.find({ show: s._id }).select('audio storageDriver storageFileId storageKey storageParts').lean();
  await Promise.all(eps.map((e) => deleteAudio(e)));
  await Episode.deleteMany({ show: s._id });
  await EpisodeLike.deleteMany({ episode: { $in: eps.map((e) => e._id) } });
  deleteImage(s.cover);
  await s.deleteOne();
  res.json({ ok: true });
});

r.post('/studio/shows/:id/episodes', requireApprovedCreator, media, assembleChunks, withUploads(async (req, res) => {
  const show = await Show.findOne({ _id: oid(req.params.id), artist: req.creator._id }).lean();
  if (!show) throw notFound('Show not found');
  const audio = fileOf(req, 'audio');
  if (!audio) throw bad('Choose an audio file for this episode', 'no_audio');
  const driver = resolveDriver(req.body.storage);
  const collabs = await buildCollabs(req, req.creator._id, req.body.collaborators);
  if (audio.session && driver !== 'postfile') throw bad('Parts were uploaded to PostFile, so this has to be a PostFile upload', 'bad_storage');
  const info = await inspectUpload(audio);
  if (info.cover) deleteImage(info.cover); // episodes use the show's own cover, not per-episode art
  const stored = audio.session ? storedFromSession(audio.session) : await storeAudio(audio.filename, { driver, originalName: audio.originalname, mime: mimeFor(audio.filename) });
  const last = await Episode.findOne({ show: show._id }).sort({ season: -1, number: -1 }).select('season number').lean();
  const title = str(req.body.title, 140) || info.title || path.basename(audio.originalname, path.extname(audio.originalname));
  const ep = await Episode.create({
    show: show._id, artist: req.creator._id, title, description: str(req.body.description, 5000),
    audio: stored.ref, storageDriver: stored.driver, storageFileId: stored.fileId, storageKey: stored.key, storageParts: stored.parts, audioSize: stored.size, mime: mimeFor(audio.originalname), durationMs: info.durationMs,
    season: clampInt(req.body.season, last?.season || 1, 1, 99),
    number: clampInt(req.body.number, (last?.number || 0) + 1, 1, 9999),
    transcript: String(req.body.transcript || '').slice(0, 200000),
    published: publishedFlag(req.body),
    collabs,
  });
  if (audio.session) UploadSession.deleteOne({ uploadId: audio.session.uploadId }).catch(() => {});
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
  if ('published' in b || 'visibility' in b) e.published = publishedFlag(b, e.published);
  if ('season' in b) e.season = clampInt(b.season, e.season, 1, 99);
  if ('number' in b) e.number = clampInt(b.number, e.number, 1, 9999);
  if ('collaborators' in b) e.collabs = await buildCollabs(req, e.artist, b.collaborators, e.collabs);
  await e.save();
  const [row] = await Episode.find({ _id: e._id }).populate(EPISODE_POP).lean();
  res.json({ episode: (await episodesToDTO([row], null))[0] });
});

r.delete('/studio/episodes/:id', requireApprovedCreator, async (req, res) => {
  const e = await Episode.findOne({ _id: oid(req.params.id), artist: req.creator._id });
  if (!e) throw notFound('Episode not found');
  await deleteAudio(e);
  await e.deleteOne();
  await EpisodeLike.deleteMany({ episode: e._id });
  res.json({ ok: true });
});

export default r;
