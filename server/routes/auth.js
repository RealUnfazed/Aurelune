import { Router } from 'express';
import { User, Session } from '../db.js';
import { attachUser, createSession, destroySession, requireAuth, sessionOnly, hashPassword, checkPassword, privateUser } from '../auth.js';
import { bad, str, truthy, HttpError } from '../util.js';
import { EQ_PRESETS, EQ_BANDS_HZ, EQ_PRESET_LABELS, isValidBands } from '../eq-presets.js';

const r = Router();

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const validUser = (u) => /^[a-z0-9_.]{3,24}$/.test(u);

r.post('/auth/signup', async (req, res) => {
  const username = str(req.body.username, 24).toLowerCase();
  const email = str(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const displayName = str(req.body.display_name, 60) || username;
  if (!validUser(username)) throw bad('Usernames are 3–24 characters: letters, numbers, dots or underscores', 'invalid_username');
  if (!validEmail(email)) throw bad('Enter a valid email address', 'invalid_email');
  if (password.length < 8) throw bad('Passwords need at least 8 characters', 'weak_password');
  if (await User.exists({ username })) throw new HttpError(409, 'That username is taken', 'username_taken');
  if (await User.exists({ email })) throw new HttpError(409, 'An account with that email already exists', 'email_taken');
  const firstUser = (await User.estimatedDocumentCount()) === 0;
  const user = await User.create({ username, email, displayName, passwordHash: hashPassword(password), role: firstUser ? 'admin' : 'listener' });
  const token = await createSession(res, user, req.get('user-agent'));
  res.status(201).json({ user: await privateUser(user), ...(truthy(req.body.token) ? { token } : {}) });
});

r.post('/auth/login', async (req, res) => {
  const login = str(req.body.login, 120).toLowerCase();
  const user = await User.findOne(login.includes('@') ? { email: login } : { username: login });
  if (!user || !checkPassword(String(req.body.password || ''), user.passwordHash)) throw new HttpError(401, 'Wrong username or password', 'bad_credentials');
  const token = await createSession(res, user, req.get('user-agent'));
  res.json({ user: await privateUser(user), ...(truthy(req.body.token) ? { token } : {}) });
});

r.post('/auth/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

r.get('/me', requireAuth, async (req, res) => res.json({ user: await privateUser(req.user) }));

// Lets the client boot without a 401 in the console when signed out.
r.get('/session', async (req, res) => res.json({ user: req.user ? await privateUser(req.user) : null }));

r.patch('/me', requireAuth, sessionOnly, async (req, res) => {
  const u = req.user;
  if ('display_name' in req.body) { const d = str(req.body.display_name, 60); if (!d) throw bad('Display name cannot be empty'); u.displayName = d; }
  if ('bio' in req.body) u.bio = str(req.body.bio, 300);
  if ('share_activity' in req.body) u.shareActivity = truthy(req.body.share_activity);
  await u.save();
  res.json({ user: await privateUser(u) });
});

r.put('/me/password', requireAuth, sessionOnly, async (req, res) => {
  if (!checkPassword(String(req.body.current || ''), req.user.passwordHash)) throw new HttpError(403, 'Current password is wrong', 'bad_credentials');
  const next = String(req.body.next || '');
  if (next.length < 8) throw bad('Passwords need at least 8 characters', 'weak_password');
  req.user.passwordHash = hashPassword(next);
  await req.user.save();
  await Session.deleteMany({ user: req.user._id }); // sign out everywhere
  const token = await createSession(res, req.user, req.get('user-agent'));
  res.json({ ok: true, ...(truthy(req.body.token) ? { token } : {}) });
});

r.get('/me/eq', requireAuth, async (req, res) => {
  const eq = req.user.eq || { preset: 'flat', bands: EQ_PRESETS.flat };
  res.json({ preset: eq.preset, bands: eq.bands, bands_hz: EQ_BANDS_HZ, presets: EQ_PRESETS, labels: EQ_PRESET_LABELS });
});

r.put('/me/eq', requireAuth, sessionOnly, async (req, res) => {
  const { preset, bands } = req.body;
  if (preset && preset !== 'custom') {
    if (!(preset in EQ_PRESETS)) throw bad('Unknown preset', 'unknown_preset');
    req.user.eq = { preset, bands: EQ_PRESETS[preset] };
  } else if (isValidBands(bands)) {
    req.user.eq = { preset: 'custom', bands };
  } else {
    throw bad('Provide a known preset name, or 7 custom band values between -12 and 12', 'invalid_eq');
  }
  await req.user.save();
  res.json({ preset: req.user.eq.preset, bands: req.user.eq.bands });
});

export default r;
