import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
// On Vercel the bundled files' location relative to this module isn't something I can verify from
// here, so fall back to the process working directory (Vercel's documented base for runtime file reads).
export const PUBLIC_DIR = [path.join(ROOT, 'public'), path.join(process.cwd(), 'public')].find((p) => fs.existsSync(path.join(p, 'index.html')))
  || path.join(ROOT, 'public');
export const APP_NAME = 'Aurelune';

/** True when running as a Vercel function: no persistent disk, no long-lived process. */
export const IS_SERVERLESS = !!process.env.VERCEL;
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Only /tmp is writable (and ephemeral) on Vercel — used purely to stage an upload for a moment.
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : IS_SERVERLESS ? '/tmp/aurelune-data' : path.join(ROOT, 'data');
export const AUDIO_DIR = path.join(DATA_DIR, 'uploads', 'audio');
export const IMAGE_DIR = path.join(DATA_DIR, 'uploads', 'img');

export const PORT = Number(process.env.PORT || 3000); // ignored on Vercel — it routes requests to the function itself
export const SESSION_COOKIE = 'aur_session';
export const SESSION_DAYS = 30;
export const SECURE_COOKIES = IS_PRODUCTION && process.env.INSECURE_COOKIES !== 'true';
// Big files are fine on PostFile: anything over one part is split across several uploads (see storage.js).
export const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 600);
export const MAX_IMAGE_MB = Number(process.env.MAX_IMAGE_MB || 8);
// How many creator pages a new account may have. An admin can raise or lower this per user (or make it unlimited).
export const DEFAULT_CREATOR_PAGES = Math.max(0, Math.floor(Number(process.env.DEFAULT_CREATOR_PAGES ?? 1)) || 0) || 1;
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@aurelune.local';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// The synthesized demo catalog writes files to disk — never sensible on a serverless deployment.
export const SEED_DEMO = IS_SERVERLESS ? process.env.SEED_DEMO === 'true' : process.env.SEED_DEMO !== 'false';

/* ---------------------------- Upload storage ---------------------------- */
// 'local'    files on this server's disk, AES-encrypted at rest, streamed through the server
// 'postfile' files hosted on postfile.net; streaming redirects to their CDN (public URL, no encryption)
// One key, or several (POSTFILE_API_KEYS="key1,key2,key3", separated by commas, spaces or new lines). Uploads rotate
// across them and fail over to the next one when a key is out of quota, rate-limited or rejected.
const splitKeys = (v) => String(v || '').split(/[\s,;]+/).filter(Boolean);
export const POSTFILE_API_KEYS = [...new Set([...splitKeys(process.env.POSTFILE_API_KEYS), ...splitKeys(process.env.POSTFILE_API_KEY)])];
export const POSTFILE_API_BASE = (process.env.POSTFILE_API_BASE || 'https://postfile.net').replace(/\/+$/, '');
// On serverless hosts a request body is capped (~4.5 MB on Vercel), so big files are sent to us in pieces and joined here.
export const CHUNK_BYTES = 3 * 1024 * 1024;
export const CHUNKED_UPLOAD = IS_SERVERLESS || process.env.FORCE_CHUNKED_UPLOAD === 'true';
export const POSTFILE_MAX_MB = Number(process.env.POSTFILE_MAX_MB || 50); // per-file cap of the PostFile plan; raise on a paid plan
// A file bigger than one part is cut into parts of this size (rounded down to whole 3 MB relay chunks, always under the plan cap)
// and each part is uploaded as its own PostFile file, to a different key where there are several. Listeners never see the seam.
const wantedPartMb = Math.max(6, Math.min(Number(process.env.POSTFILE_PART_MB || 40), POSTFILE_MAX_MB - 2));
export const PART_BYTES = Math.max(1, Math.floor((wantedPartMb * 1024 * 1024) / CHUNK_BYTES)) * CHUNK_BYTES;
// 'auto': the browser plays PostFile's CDN directly when that CDN allows the equalizer (CORS), otherwise through this server.
// 'always': every PostFile track is streamed through this server (equalizer guaranteed, costs bandwidth here).
export const STREAM_PROXY = (process.env.STREAM_PROXY || 'auto').toLowerCase() === 'always' ? 'always' : 'auto';

export const LOCAL_STORAGE_AVAILABLE = !IS_SERVERLESS;
export const POSTFILE_AVAILABLE = POSTFILE_API_KEYS.length > 0;

export function availableDrivers() {
  const out = [];
  if (LOCAL_STORAGE_AVAILABLE) out.push('local');
  if (POSTFILE_AVAILABLE) out.push('postfile');
  return out;
}

export function defaultDriver() {
  const avail = availableDrivers();
  const wanted = (process.env.STORAGE_DRIVER || '').toLowerCase();
  if (avail.includes(wanted)) return wanted;
  return avail[0] || null;
}

// A read-only filesystem must not crash the app at import time (serverless, read-only containers).
for (const d of [DATA_DIR, AUDIO_DIR, IMAGE_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); }
  catch (err) { console.warn(`${APP_NAME}: could not create ${d} (${err.code}). Fine on read-only/serverless hosts.`); }
}
