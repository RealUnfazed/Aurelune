import { Router } from 'express';
import {
  User, Creator, Track, Album, Show, Episode, Play, Session,
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

export default r;
