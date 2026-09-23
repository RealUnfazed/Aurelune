import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Creator } from './db.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || (status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'bad_request');
  }
}
export const bad = (msg, code) => new HttpError(400, msg, code);
export const notFound = (msg = 'Not found') => new HttpError(404, msg);
export const forbidden = (msg = 'You do not have access to this') => new HttpError(403, msg);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/** Validate a route param as an ObjectId, else 404 (never a 500). */
export const oid = (v) => {
  if (!mongoose.isValidObjectId(v) || String(v).length !== 24) throw notFound();
  return new mongoose.Types.ObjectId(String(v));
};
export const isOid = (v) => mongoose.isValidObjectId(v) && String(v).length === 24;

export function slugify(input) {
  const s = String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'creator';
}

export async function uniqueSlug(base) {
  const root = slugify(base);
  let slug = root, n = 1;
  while (await Creator.exists({ slug })) slug = `${root}-${++n}`;
  return slug;
}

export const likeEscape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const clampInt = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
};

export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true' || v === 'on';

/* ---------------- Lyrics ---------------- */

/** Parse LRC text into [{t, text}] (t in ms). Returns [] if the text has no timestamps. */
export function parseLrc(text) {
  if (!text) return [];
  const out = [];
  let offset = 0;
  const off = /\[offset:\s*(-?\d+)\s*\]/i.exec(text);
  if (off) offset = parseInt(off[1], 10);
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const line = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) {
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      out.push({ t: Math.max(0, (+m[1] * 60 + +m[2]) * 1000 + frac - offset), text: line });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export function lyricsPayload(raw) {
  const synced = parseLrc(raw);
  if (synced.length) return { synced: true, lines: synced, plain: synced.map((l) => l.text).join('\n') };
  const plain = (raw || '').replace(/\[[a-z]+:[^\]]*\]/gi, '').trim();
  return { synced: false, lines: [], plain };
}

/* ---------------- Generated cover art ---------------- */

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function artColor(seed) {
  const r = mulberry(hashSeed(String(seed)));
  const h = Math.floor(r() * 360);
  return `hsl(${h} 62% 52%)`;
}

/** Deterministic generative cover art (SVG). Every item without an uploaded image gets its own. */
export function artSvg(seed, round = false) {
  const r = mulberry(hashSeed(String(seed)));
  const h1 = Math.floor(r() * 360);
  const h2 = (h1 + 40 + Math.floor(r() * 110)) % 360;
  const h3 = (h2 + 60 + Math.floor(r() * 120)) % 360;
  const variant = Math.floor(r() * 4);
  const id = 'g' + hashSeed(String(seed)).toString(36);
  const bgA = `hsl(${h1} 48% 13%)`, bgB = `hsl(${h2} 52% 26%)`;
  const c1 = `hsl(${h1} 78% 66%)`, c2 = `hsl(${h2} 82% 70%)`, c3 = `hsl(${h3} 85% 76%)`;
  let shapes = '';
  if (variant === 0) {
    // moon + halo rings
    const cx = 170 + r() * 60, cy = 150 + r() * 70, rad = 70 + r() * 50;
    shapes += `<circle cx="${cx}" cy="${cy}" r="${rad * 2.4}" fill="url(#${id}h)"/>`;
    for (let i = 1; i <= 3; i++) shapes += `<circle cx="${cx}" cy="${cy}" r="${rad + i * 26}" fill="none" stroke="${c3}" stroke-opacity="${0.5 - i * 0.12}" stroke-width="${2.2 - i * 0.4}"/>`;
    shapes += `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="url(#${id}m)"/>`;
    shapes += `<circle cx="${cx + rad * 0.32}" cy="${cy - rad * 0.2}" r="${rad * 0.9}" fill="${bgA}" fill-opacity=".72"/>`;
  } else if (variant === 1) {
    // horizon waves
    for (let i = 0; i < 7; i++) {
      const y = 170 + i * 34, amp = 10 + r() * 26, ph = r() * 6;
      let d = `M0 ${y}`;
      for (let x = 0; x <= 400; x += 20) d += ` L${x} ${(y + Math.sin(x / 55 + ph) * amp).toFixed(1)}`;
      d += ' L400 400 L0 400 Z';
      shapes += `<path d="${d}" fill="hsl(${(h1 + i * 14) % 360} 70% ${18 + i * 7}%)" fill-opacity=".92"/>`;
    }
    shapes += `<circle cx="${120 + r() * 160}" cy="${95 + r() * 40}" r="${34 + r() * 22}" fill="${c3}"/>`;
  } else if (variant === 2) {
    // concentric arcs
    const cx = r() < .5 ? 0 : 400, cy = r() < .5 ? 400 : 0;
    for (let i = 9; i >= 1; i--) shapes += `<circle cx="${cx}" cy="${cy}" r="${i * 46}" fill="hsl(${(h1 + i * 17) % 360} 70% ${15 + (9 - i) * 5.5}%)" fill-opacity=".95"/>`;
    shapes += `<circle cx="${200 + (r() - .5) * 120}" cy="${200 + (r() - .5) * 120}" r="${20 + r() * 26}" fill="${c3}"/>`;
  } else {
    // dot field
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const dx = x - 4.5 - (r() - .5), dy = y - 4.5 - (r() - .5);
      const d = Math.hypot(dx, dy), s = Math.max(1.5, 20 - d * 4.2);
      shapes += `<circle cx="${20 + x * 40}" cy="${20 + y * 40}" r="${s.toFixed(1)}" fill="${d < 2.6 ? c3 : c2}" fill-opacity="${(0.95 - d * 0.14).toFixed(2)}"/>`;
    }
  }
  const clip = round ? `<clipPath id="${id}c"><circle cx="200" cy="200" r="200"/></clipPath>` : '';
  const open = round ? `<g clip-path="url(#${id}c)">` : '<g>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
<defs><linearGradient id="${id}b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset="1" stop-color="${bgB}"/></linearGradient>
<radialGradient id="${id}h"><stop offset="0" stop-color="${c2}" stop-opacity=".55"/><stop offset="1" stop-color="${c2}" stop-opacity="0"/></radialGradient>
<linearGradient id="${id}m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c3}"/><stop offset="1" stop-color="${c1}"/></linearGradient>${clip}</defs>
${open}<rect width="400" height="400" fill="url(#${id}b)"/>${shapes}</g></svg>`;
}

/* ---------------- URLs ---------------- */

export const imgUrl = (file) => (file ? `/media/img/${file}` : null);
export const artUrl = (kind, id, title = '') => `/art/${kind}/${id}.svg?s=${encodeURIComponent(String(title).slice(0, 24))}`;
