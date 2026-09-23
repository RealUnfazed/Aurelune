import { Router } from 'express';
import { ApiToken } from '../db.js';
import { ALL_SCOPES, requireAuth, sessionOnly } from '../auth.js';
import { API_DOCS } from '../docs.js';
import { oid, bad, str, randomToken, sha256, notFound } from '../util.js';

const r = Router();

r.get('/docs', (_req, res) => res.json({ ...API_DOCS, scopes: ALL_SCOPES }));

r.get('/me/tokens', requireAuth, sessionOnly, async (req, res) => {
  const rows = await ApiToken.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({
    scopes: ALL_SCOPES,
    tokens: rows.map((t) => ({ id: String(t._id), name: t.name, prefix: t.prefix, scopes: t.scopes, created_at: t.createdAt, last_used_at: t.lastUsedAt || null })),
  });
});

r.post('/me/tokens', requireAuth, sessionOnly, async (req, res) => {
  const name = str(req.body.name, 40);
  if (!name) throw bad('Name your token so you remember what it is for');
  const scopes = (Array.isArray(req.body.scopes) ? req.body.scopes : []).filter((s) => s in ALL_SCOPES);
  if (!scopes.length) throw bad('Pick at least one scope');
  if ((await ApiToken.countDocuments({ user: req.user._id })) >= 20) throw bad('You can have up to 20 tokens. Revoke one first.');
  const secret = 'aur_' + randomToken(24);
  const t = await ApiToken.create({ user: req.user._id, name, tokenHash: sha256(secret), prefix: secret.slice(0, 10), scopes });
  res.status(201).json({ id: String(t._id), name, scopes, prefix: t.prefix, token: secret, note: 'Copy this now — it is never shown again.' });
});

r.delete('/me/tokens/:id', requireAuth, sessionOnly, async (req, res) => {
  const d = await ApiToken.deleteOne({ _id: oid(req.params.id), user: req.user._id });
  if (!d.deletedCount) throw notFound('Token not found');
  res.json({ ok: true });
});

export default r;
