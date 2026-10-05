// A creator can make their whole page private: nothing of theirs (page, songs, albums, podcasts, episodes) shows up for
// anyone except that creator's own account and admins. Instead of threading a "blocked creators" argument through
// every query, the set is worked out once per request and kept in AsyncLocalStorage; the shared query filters in
// serialize.js read it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Creator, Show } from './db.js';

const als = new AsyncLocalStorage();

/** Does the current viewer own this creator page? (Used to show collaboration invites only to the people they concern.) */
export const viewerOwns = (id) => !!id && !!als.getStore()?.mine?.has(String(id._id ?? id));
export const viewerIsAdmin = () => !!als.getStore()?.admin;
/** Ids (as strings) of the creator pages the current viewer owns. */
export const viewerOwnIds = () => [...(als.getStore()?.mine ?? [])];

/** Creator ids hidden from the current viewer (empty for admins; a creator's own private pages are never blocked for them). */
export const blockedCreatorIds = () => als.getStore()?.blocked ?? [];
export const isBlocked = (id) => !!id && blockedCreatorIds().some((b) => String(b) === String(id._id ?? id));

/** Private podcasts (shows) hidden from the current viewer: everyone's but their own; empty for admins. Their episodes go with them. */
export const blockedShowIds = () => als.getStore()?.blockedShows ?? [];
export const isShowBlocked = (id) => !!id && blockedShowIds().some((b) => String(b) === String(id._id ?? id));
/** `{ show: { $nin: [...] } }` when a private podcast is hidden from this viewer, otherwise `{}` (a no-op on tracks, which have no `show`). */
export const notBlockedShows = () => {
  const b = blockedShowIds();
  return b.length ? { show: { $nin: b } } : {};
};

/** `{ artist: { $nin: [...] } }` when something is blocked, otherwise `{}`. */
export const notBlocked = (field = 'artist') => {
  const b = blockedCreatorIds();
  return b.length ? { [field]: { $nin: b } } : {};
};

/** Every private creator id regardless of viewer (for things shown to *other* people, like a public now-playing). */
export async function allPrivateCreatorIds() {
  return (await Creator.find({ isPrivate: true }).select('_id').lean()).map((c) => c._id);
}

/** Express middleware: compute the blocked set for this request and run the rest of it inside that context. */
export async function privacyContext(req, _res, next) {
  try {
    const admin = req.user?.role === 'admin';
    const mine = req.user ? new Set((await Creator.find({ user: req.user._id }).select('_id').lean()).map((c) => String(c._id))) : new Set();
    let blocked = [], blockedShows = [];
    if (!admin) {
      const priv = await allPrivateCreatorIds();
      blocked = priv.filter((id) => !mine.has(String(id)));
      const privShows = await Show.find({ published: false }).select('_id artist').lean();
      blockedShows = privShows.filter((sh) => !mine.has(String(sh.artist))).map((sh) => sh._id);
    }
    als.run({ blocked, blockedShows, mine, admin }, next);
  } catch (e) { next(e); }
}
