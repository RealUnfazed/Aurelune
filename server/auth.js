import bcrypt from 'bcryptjs';
import { User, Session, ApiToken, Creator } from './db.js';
import { HttpError, randomToken, sha256 } from './util.js';
import { SESSION_COOKIE, SESSION_DAYS, SECURE_COOKIES } from './config.js';

export const ALL_SCOPES = {
  profile: 'Read your profile and account info',
  library: 'Read your liked songs, follows and saved albums',
  playlists: 'Read and manage your playlists',
  history: 'Read your listening history and stats',
  player: 'Read what you are playing right now (and stream it live)',
  export: 'Download a full export of your data',
};

const cookieOpts = () => ({
  httpOnly: true, sameSite: 'lax', secure: SECURE_COOKIES, path: '/',
  maxAge: SESSION_DAYS * 86400 * 1000,
});

export const hashPassword = (pw) => bcrypt.hashSync(pw, 11);
export const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

/** Creates a session. Web clients get a cookie; native clients (Electron/Capacitor) also get the token. */
export async function createSession(res, user, ua = '') {
  const token = randomToken(32);
  await Session.create({
    tokenHash: sha256(token), user: user._id, userAgent: String(ua).slice(0, 200),
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86400 * 1000),
  });
  res.cookie(SESSION_COOKIE, token, cookieOpts());
  return token;
}

export async function destroySession(req, res) {
  const t = req.cookies?.[SESSION_COOKIE] || bearerOf(req);
  if (t) await Session.deleteOne({ tokenHash: sha256(String(t)) });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

const bearerOf = (req) => {
  const auth = req.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.query.access_token || '');
};

/**
 * Sets req.user / req.scopes.
 *  - session cookie or session token  -> full access
 *  - API token (aur_...)              -> only the scopes it was created with
 */
export async function attachUser(req, _res, next) {
  req.user = null; req.scopes = null; req.viaToken = false;
  try {
    const bearer = bearerOf(req);
    if (bearer) {
      const h = sha256(String(bearer));
      const tok = await ApiToken.findOne({ tokenHash: h });
      if (tok) {
        const u = await User.findById(tok.user);
        if (!u) throw new HttpError(401, 'Token owner no longer exists', 'invalid_token');
        if (!tok.lastUsedAt || Date.now() - tok.lastUsedAt > 60000) { tok.lastUsedAt = new Date(); tok.save().catch(() => {}); }
        req.user = u; req.scopes = new Set(tok.scopes); req.viaToken = true;
        return next();
      }
      const s = await Session.findOne({ tokenHash: h, expiresAt: { $gt: new Date() } });
      if (!s) throw new HttpError(401, 'Invalid, expired or revoked token', 'invalid_token');
      req.user = await User.findById(s.user);
      return next();
    }
    const cookie = req.cookies?.[SESSION_COOKIE];
    if (cookie) {
      const s = await Session.findOne({ tokenHash: sha256(cookie), expiresAt: { $gt: new Date() } });
      if (s) req.user = await User.findById(s.user);
    }
    next();
  } catch (e) { next(e); }
}

export const requireAuth = (req, _res, next) =>
  req.user ? next() : next(new HttpError(401, 'Sign in to do that', 'unauthorized'));

/** Session users pass; API tokens must include the scope. */
export const scope = (name) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Sign in or provide an API token', 'unauthorized'));
  if (req.viaToken && !req.scopes.has(name)) return next(new HttpError(403, `This token is missing the "${name}" scope`, 'insufficient_scope'));
  next();
};

/** Only for actions that change account security or content — never available to scoped API tokens. */
export const sessionOnly = (req, _res, next) =>
  req.viaToken ? next(new HttpError(403, 'Not available to API tokens', 'session_required')) : next();

export const requireAdmin = (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Sign in first'));
  if (req.viaToken || req.user.role !== 'admin') return next(new HttpError(403, 'Admins only'));
  next();
};

export const myCreator = (userId) => Creator.findOne({ user: userId });

export async function requireApprovedCreator(req, _res, next) {
  try {
    if (!req.user) throw new HttpError(401, 'Sign in first');
    if (req.viaToken) throw new HttpError(403, 'Not available to API tokens', 'session_required');
    const c = await myCreator(req.user._id);
    if (!c) throw new HttpError(403, 'Request a creator page first', 'no_creator_page');
    if (c.status !== 'approved') throw new HttpError(403, 'Your creator page is not approved yet', 'not_approved');
    req.creator = c;
    next();
  } catch (e) { next(e); }
}

export async function privateUser(u) {
  const c = await myCreator(u._id);
  return {
    id: String(u._id), username: u.username, email: u.email, display_name: u.displayName, bio: u.bio,
    role: u.role, share_activity: !!u.shareActivity, created_at: u.createdAt,
    creator: c ? { id: String(c._id), name: c.name, slug: c.slug, status: c.status, verified: !!c.verified, review_note: c.reviewNote || null, focus: c.focus } : null,
  };
}
