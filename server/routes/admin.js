import { Router } from 'express';
import {
  User, Creator, Track, Album, Show, Episode, Play, Session, Report, Playlist,
} from '../db.js';
import { requireAdmin } from '../auth.js';
import { oid, bad, notFound, str, truthy, likeEscape, clampInt } from '../util.js';
import { creatorDTO } from '../serialize.js';

const r = Router();
r.use('/admin', requireAdmin);

r.get('/admin/overview', async (_req, res) => {
  const day = new Date(Date.now() - 86400000), week = new Date(Date.now() - 7 * 86400000);
  const [users, creators, pending, tracks, episodes, plays24, plays7] = await Promise.all([
    User.countDocuments(), Creator.countDocuments({ status: 'approved' }), Creator.countDocuments({ status: 'pending' }),
    Track.countDocuments(), Episode.countDocuments(), Play.countDocuments({ playedAt: { $gte: day } }), Play.countDocuments({ playedAt: { $gte: week } }),
  ]);
  res.json({ users, creators, pending_requests: pending, tracks, episodes, plays_24h: plays24, plays_7d: plays7 });
});

r.get('/admin/creators', async (req, res) => {
  const q = ['pending', 'approved', 'rejected', 'suspended'].includes(req.query.status) ? { status: req.query.status } : {};
  const rows = await Creator.find(q).populate('user', 'username email displayName').sort({ requestedAt: -1 }).limit(200).lean();
  res.json({
    creators: rows.map((c) => ({
      ...creatorDTO(c), status: c.status, review_note: c.reviewNote || null, requested_at: c.requestedAt,
      user: { id: String(c.user._id), username: c.user.username, email: c.user.email },
    })),
  });
});

async function setHidden(creatorId, hidden) {
  await Promise.all([Track, Album, Show, Episode].map((M) => M.updateMany({ artist: creatorId }, { $set: { hidden } })));
}

r.post('/admin/creators/:id/:action', async (req, res) => {
  const c = await Creator.findById(oid(req.params.id));
  if (!c) throw notFound('Creator page not found');
  const note = str(req.body.note, 400);
  switch (req.params.action) {
    case 'approve': c.status = 'approved'; c.reviewNote = note || null; c.reviewedAt = new Date(); await setHidden(c._id, false); break;
    case 'reject': c.status = 'rejected'; c.reviewNote = note || 'Your request was not approved.'; c.reviewedAt = new Date(); break;
    case 'suspend': c.status = 'suspended'; c.reviewNote = note || 'Suspended by moderators.'; c.reviewedAt = new Date(); await setHidden(c._id, true); break;
    case 'reinstate': c.status = 'approved'; c.reviewNote = null; c.reviewedAt = new Date(); await setHidden(c._id, false); break;
    case 'verify': c.verified = truthy(req.body.verified ?? true); break;
    default: throw bad('Unknown action');
  }
  await c.save();
  res.json({ ok: true, status: c.status, verified: c.verified });
});

r.post('/admin/tracks/:id/hide', async (req, res) => {
  const t = await Track.findByIdAndUpdate(oid(req.params.id), { hidden: truthy(req.body.hidden ?? true) }, { new: true });
  if (!t) throw notFound();
  res.json({ ok: true, hidden: t.hidden });
});
r.post('/admin/episodes/:id/hide', async (req, res) => {
  const e = await Episode.findByIdAndUpdate(oid(req.params.id), { hidden: truthy(req.body.hidden ?? true) }, { new: true });
  if (!e) throw notFound();
  res.json({ ok: true, hidden: e.hidden });
});

r.get('/admin/users', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = q ? { $or: [{ username: new RegExp(likeEscape(q), 'i') }, { email: new RegExp(likeEscape(q), 'i') }] } : {};
  const rows = await User.find(filter).sort({ createdAt: -1 }).limit(clampInt(req.query.limit, 50, 1, 200)).lean();
  res.json({ users: rows.map((u) => ({ id: String(u._id), username: u.username, email: u.email, display_name: u.displayName, role: u.role, created_at: u.createdAt })) });
});

r.patch('/admin/users/:id', async (req, res) => {
  const u = await User.findById(oid(req.params.id));
  if (!u) throw notFound('User not found');
  if (!['listener', 'admin'].includes(req.body.role)) throw bad('Role must be listener or admin');
  if (String(u._id) === String(req.user._id) && req.body.role !== 'admin') throw bad('You cannot remove your own admin role');
  u.role = req.body.role;
  await u.save();
  res.json({ ok: true, role: u.role });
});

r.delete('/admin/users/:id/sessions', async (req, res) => {
  await Session.deleteMany({ user: oid(req.params.id) });
  res.json({ ok: true });
});

/* ------------------------------ Reports ------------------------------ */

const REPORT_MODEL = { track: Track, episode: Episode, artist: Creator, album: Album, show: Show, playlist: Playlist };
const REPORT_TITLE_FIELD = { track: 'title', episode: 'title', artist: 'name', album: 'title', show: 'title', playlist: 'title' };

r.get('/admin/reports', async (req, res) => {
  const status = ['open', 'reviewed', 'dismissed'].includes(req.query.status) ? req.query.status : 'open';
  const reports = await Report.find({ status }).populate('user', 'username displayName').sort({ createdAt: -1 }).limit(200).lean();
  const byKind = {};
  reports.forEach((rp) => (byKind[rp.kind] ||= []).push(rp.item));
  const titles = new Map();
  for (const [kind, ids] of Object.entries(byKind)) {
    const Model = REPORT_MODEL[kind];
    const field = REPORT_TITLE_FIELD[kind];
    const rows = await Model.find({ _id: { $in: ids } }).select(field).lean();
    rows.forEach((row) => titles.set(`${kind}:${row._id}`, row[field]));
  }
  res.json({
    reports: reports.map((rp) => ({
      id: String(rp._id), kind: rp.kind, item_id: String(rp.item), item_title: titles.get(`${rp.kind}:${rp.item}`) || '(deleted)',
      reason: rp.reason, note: rp.note, status: rp.status, created_at: rp.createdAt,
      user: { id: String(rp.user._id), username: rp.user.username, display_name: rp.user.displayName },
    })),
  });
});

r.post('/admin/reports/:id/:action', async (req, res) => {
  if (!['reviewed', 'dismissed', 'reopen'].includes(req.params.action)) throw bad('Unknown action');
  const status = req.params.action === 'reopen' ? 'open' : req.params.action;
  const rp = await Report.findByIdAndUpdate(oid(req.params.id), { status }, { new: true });
  if (!rp) throw notFound('Report not found');
  res.json({ ok: true, status: rp.status });
});

export default r;
