import bcrypt from 'bcryptjs';
import { User, Session, ApiToken, Creator } from './db.js';
import { HttpError, randomToken, sha256, isOid } from './util.js';
import { creatorDTO } from './serialize.js';
import { SESSION_COOKIE, SESSION_DAYS, SECURE_COOKIES, DEFAULT_CREATOR_PAGES } from './config.js';

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

/** Every creator page an account owns, oldest first. */
export const myCreators = (userId) => Creator.find({ user: userId }).sort({ createdAt: 1, _id: 1 });

/**
 * The creator page a request is acting as. The Studio sends the page it has open in the `X-Creator-Page` header
 * (stateless, so it works across serverless instances and per browser tab). Without it we fall back to the
 * account's first approved page, then its first page of any kind.
 */
export async function myCreator(userId, wantedId) {
  if (wantedId) {
    if (!isOid(wantedId)) throw new HttpError(404, 'Unknown creator page', 'no_such_page');
    const c = await Creator.findOne({ _id: wantedId, user: userId });
    if (!c) throw new HttpError(404, 'Unknown creator page', 'no_such_page');
    return c;
  }
  const all = await myCreators(userId);
  return all.find((c) => c.status === 'approved') || all[0] || null;
}
/** Ids of every creator page the signed-in user owns (cached on the request), for "can see own private items" rules. */
export async function ownCreatorIds(req) {
  if (!req.user) return [];
  req._ownCreatorIds ??= (await Creator.find({ user: req.user._id }).select('_id').lean()).map((c) => c._id);
  return req._ownCreatorIds;
}
export const wantedPage = (req) => String(req.get?.('x-creator-page') || req.query?.page || '').trim() || null;

/** How many creator pages this account may hold: a number, or Infinity. */
export const creatorLimitFor = (u) => (u.creatorLimit === -1 ? Infinity : Number.isFinite(u.creatorLimit) && u.creatorLimit >= 0 ? u.creatorLimit : DEFAULT_CREATOR_PAGES);
/** A rejected page doesn't use up a slot: the person can fix it and re-apply, or just ask for a new one. */
export const usedSlots = (pages) => pages.filter((c) => c.status !== 'rejected').length;

export async function requireApprovedCreator(req, _res, next) {
  try {
    if (!req.user) throw new HttpError(401, 'Sign in first');
    if (req.viaToken) throw new HttpError(403, 'Not available to API tokens', 'session_required');
    const c = await myCreator(req.user._id, wantedPage(req));
    if (!c) throw new HttpError(403, 'Request a creator page first', 'no_creator_page');
    if (c.status !== 'approved') throw new HttpError(403, 'This creator page is not approved yet', 'not_approved');
    req.creator = c;
    next();
  } catch (e) { next(e); }
}

export async function privateUser(u) {
  const pages = await myCreators(u._id);
  const primary = pages.find((c) => c.status === 'approved') || pages[0] || null;
  const brief = (c) => ({ id: String(c._id), name: c.name, slug: c.slug, status: c.status, verified: !!c.verified, review_note: c.reviewNote || null, focus: c.focus, image: creatorDTO(c).image });
  const limit = creatorLimitFor(u);
  const used = usedSlots(pages);
  return {
    id: String(u._id), username: u.username, email: u.email, display_name: u.displayName, bio: u.bio,
    role: u.role, share_activity: !!u.shareActivity, created_at: u.createdAt,
    liked_style: { icon: u.likedIcon || 'heart', color: u.likedColor || 'green' },
    eq: { preset: u.eq?.preset || 'flat', bands: u.eq?.bands || [0, 0, 0, 0, 0, 0, 0] },
    creator: primary ? brief(primary) : null, // the page used when none is chosen (kept for older clients)
    creators: pages.map(brief),
    creator_slots: { used, limit: Number.isFinite(limit) ? limit : null, unlimited: !Number.isFinite(limit), can_create: used < limit },
  };
}
