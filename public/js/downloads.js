// Offline downloads: songs and podcast episodes kept on this device, encrypted, playable only inside Aurelune.
//
// How it works
//  * A licence. The server hands a signed-in listener a key (POST /downloads/license) that is valid for 30 days and is different
//    for every account and device. The browser imports it as a NON-extractable WebCrypto key and keeps it in IndexedDB, so the
//    raw key bytes are never written anywhere. Checking in again (the app does it whenever it is online) renews the 30 days.
//  * The audio is fetched once, cut into 1 MB pieces and each piece is AES-256-GCM encrypted with that key (fresh random IV, and
//    the item + piece number as authenticated data, so pieces can't be swapped or reordered). Only ciphertext is stored.
//  * Playing opens the item: pieces are read, decrypted in memory and handed to the player as a Blob. No file ever exists on disk
//    in a playable form, and nothing but Aurelune holds the key.
//  * When the licence runs out (30 days without a check-in), or the account signs out, the key is deleted: the pieces stay
//    unreadable until the device checks in again. A password change on the account rotates the key for every device.
//
// Honest limits: this keeps downloads Aurelune-only and stops casual copying. It is not DRM — a person who can run the app can in
// principle capture what their own speakers play, exactly as with any streaming service.
import { api } from './api.js';

const DB_NAME = 'aurelune-downloads';
const CHUNK = 1024 * 1024;
export const LIMITS = { perItem: 200 * 1048576, total: 2048 * 1048576, licenseDays: 30 };
const RENEW_AFTER_MS = 24 * 3600e3; // check in at most once a day while online
const EXT_KEY = 'aur_ext_mode';

const enc = new TextEncoder();
const supported = typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle && typeof Blob !== 'undefined';

export class DownloadError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const keyOf = (item) => `${item.type}:${item.id}`;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64urlToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
};

/* ------------------------------ IndexedDB ------------------------------ */

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        d.createObjectStore('meta');                       // 'license', 'device'
        d.createObjectStore('items', { keyPath: 'key' });  // one record per downloaded item (finished downloads only)
        d.createObjectStore('chunks');                     // `${itemKey}#${n}` -> ArrayBuffer(iv + ciphertext)
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
      rq.onblocked = () => reject(new Error('blocked'));
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
/** Runs `fn(stores)` in one transaction and resolves with its return value once the transaction has committed. */
async function tx(names, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(names, mode);
    let out;
    try { out = fn(Object.fromEntries(names.map((n) => [n, t.objectStore(n)]))); } catch (e) { try { t.abort(); } catch { /* done */ } return reject(e); }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  });
}
const wrap = (rq) => new Promise((resolve, reject) => { rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
const getOne = async (store, key) => { const d = await db(); return wrap(d.transaction(store).objectStore(store).get(key)); };
const getAll = async (store) => { const d = await db(); return wrap(d.transaction(store).objectStore(store).getAll()); };
const chunkRange = (key) => IDBKeyRange.bound(`${key}#`, `${key}#￿`);

/* ------------------------------ State ------------------------------ */

class Downloads extends EventTarget {
  constructor() {
    super();
    this.supported = supported;
    this.userId = null;
    this.license = null;          // { userId, device, issuedAt, expiresAt, kid, key: CryptoKey|null }
    this.index = new Map();       // item key -> record (finished downloads of the signed-in account)
    this.active = new Map();      // item key -> { progress (0..1, or -1 unknown), loaded, total, ac }
    this.ready = false;
    this._timer = null;
    this._renewing = null;
  }

  _emit(key) { this.dispatchEvent(new CustomEvent('change', { detail: { key } })); }

  /* ---------- lifecycle ---------- */

  /** Call once the signed-in user is known (also works offline). */
  async init(userId) {
    if (!supported || !userId) return;
    this.userId = userId;
    try {
      const lic = await getOne('meta', 'license');
      if (lic && lic.userId !== userId) await this.wipeAll();   // another account used this device: its downloads go
      else this.license = lic || null;
      const rows = await getAll('items');
      this.index = new Map(rows.filter((r) => r.userId === userId).map((r) => [r.key, r]));
      await this._dropExpiredKey();
      this._gc(); // orphaned pieces of downloads that never finished
    } catch { /* storage unavailable (private mode): downloads simply stay off */ this.supported = false; return; }
    this.ready = true;
    this._schedule();
    this._emit();
    this.checkIn().catch(() => {});
    window.addEventListener('online', () => this.checkIn().catch(() => {}));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.checkIn().catch(() => {}); });
  }

  async _gc() {
    try {
      const d = await db();
      const keys = await wrap(d.transaction('chunks').objectStore('chunks').getAllKeys());
      const stray = new Set();
      for (const k of keys) { const item = String(k).split('#')[0]; if (!this.index.has(item) && !this.active.has(item)) stray.add(item); }
      for (const item of stray) await tx(['chunks'], 'readwrite', (s) => s.chunks.delete(chunkRange(item)));
    } catch { /* best effort */ }
  }

  _schedule() {
    clearTimeout(this._timer);
    if (!this.license?.key) return;
    const ms = Math.min(2 ** 31 - 1, Math.max(1000, new Date(this.license.expiresAt) - Date.now()));
    this._timer = setTimeout(() => this._dropExpiredKey().then(() => this._schedule()), ms + 500);
  }

  async _dropExpiredKey() {
    if (this.license?.key && Date.now() >= new Date(this.license.expiresAt)) {
      this.license = { ...this.license, key: null };
      await tx(['meta'], 'readwrite', (s) => s.meta.put({ ...this.license }, 'license')).catch(() => {});
      this._emit();
    }
  }

  /* ---------- licence ---------- */

  _device() {
    try {
      let d = localStorage.getItem('aur_device');
      if (!d || !/^[A-Za-z0-9_-]{16,64}$/.test(d)) { d = (crypto.randomUUID?.() || hex(crypto.getRandomValues(new Uint8Array(16)))).replace(/-/g, ''); localStorage.setItem('aur_device', d); }
      return d;
    } catch { return this._memDevice ||= hex(crypto.getRandomValues(new Uint8Array(16))); }
  }

  get licenseValid() { return !!(this.license?.key && this.license.userId === this.userId && Date.now() < new Date(this.license.expiresAt)); }

  /** { state: 'none' | 'valid' | 'expired', expiresAt, daysLeft } for the Storage page. */
  licenseInfo() {
    const l = this.license;
    if (!l) return { state: 'none', expiresAt: null, daysLeft: 0 };
    const left = new Date(l.expiresAt) - Date.now();
    return { state: this.licenseValid ? 'valid' : 'expired', expiresAt: l.expiresAt, daysLeft: Math.max(0, Math.ceil(left / 86400e3)) };
  }

  /**
   * Renews the licence with the server (the 30-day check-in). Offline it does nothing. If the server says this device is no longer
   * signed in, every download is removed. If the account's key changed (password change), the copies that no longer open are removed.
   */
  checkIn({ force = false } = {}) {
    if (!supported || !this.userId) return Promise.resolve(false);
    if (!force && this.licenseValid && Date.now() - new Date(this.license.issuedAt) < RENEW_AFTER_MS) return Promise.resolve(true);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.resolve(false);
    if (this._renewing) return this._renewing;
    this._renewing = (async () => {
      let r;
      try { r = await api.post('/downloads/license', { device: this._device() }); }
      catch (e) {
        if (e.status === 401) { await this.wipeAll(); return false; } // signed out / account gone
        return false;                                                  // network or server trouble: keep what we have until it expires
      }
      const raw = b64urlToBytes(r.key);
      const kid = hex(await crypto.subtle.digest('SHA-256', raw)).slice(0, 12);
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
      raw.fill(0);
      this.license = { userId: String(r.user_id), device: r.device, issuedAt: r.issued_at, expiresAt: r.expires_at, kid, key };
      try { await tx(['meta'], 'readwrite', (s) => s.meta.put({ ...this.license }, 'license')); }
      catch { /* a browser that can't store a CryptoKey keeps it for this session only; the next launch checks in again */ }
      // Copies made under an older key (password changed since) can never be opened again: drop them.
      for (const rec of [...this.index.values()]) if (rec.kid !== kid) await this._removeKey(rec.key, false);
      this._schedule();
      this._emit();
      return true;
    })().finally(() => { this._renewing = null; });
    return this._renewing;
  }

  /* ---------- reading state ---------- */

  isDownloaded(item) { return !!item && this.index.has(keyOf(item)); }
  /** 'none' | 'blocked' (the creator turned downloads off) | 'downloading' | 'done' | 'locked' (done, but the licence has run out) */
  status(item) { return this.statusKey(keyOf(item), item.downloadable !== false); }
  statusKey(k, downloadable = true) {
    if (this.active.has(k)) return 'downloading';
    if (this.index.has(k)) return this.licenseValid ? 'done' : 'locked';
    return downloadable ? 'none' : 'blocked';
  }
  progress(item) { return this.active.get(keyOf(item))?.progress ?? 0; }
  progressKey(k) { return this.active.get(k)?.progress ?? 0; }
  record(item) { return this.index.get(keyOf(item)) || null; }

  list() { return [...this.index.values()].sort((a, b) => b.at - a.at); }
  usage() { let bytes = 0; for (const r of this.index.values()) bytes += r.stored || r.size; return { count: this.index.size, bytes, limit: LIMITS.total, perItem: LIMITS.perItem }; }

  /* ---------- download ---------- */

  async download(item) {
    if (!this.supported || !this.ready) throw new DownloadError('Downloads are not available in this browser.', 'unsupported');
    if (!item || (item.type !== 'track' && item.type !== 'episode')) throw new DownloadError('This can’t be downloaded.', 'bad_item');
    if (item.downloadable === false) throw new DownloadError('The creator turned off downloads for this one.', 'downloads_disabled');
    const key = keyOf(item);
    if (this.index.has(key) || this.active.has(key)) return;
    if (!this.licenseValid) {
      if (navigator.onLine === false) throw new DownloadError('You need to be online to download.', 'offline');
      await this.checkIn({ force: true });
      if (!this.licenseValid) throw new DownloadError('Couldn’t reach Aurelune to start the download. Try again in a moment.', 'license');
    }
    const used = this.usage().bytes;
    if (used >= LIMITS.total) throw new DownloadError(`Download storage is full (${Math.round(LIMITS.total / 1048576)} MB). Remove some in Settings → Storage.`, 'full');
    const ac = new AbortController();
    const st = { progress: -1, loaded: 0, total: 0, ac };
    this.active.set(key, st);
    this._emit(key);
    let written = 0;
    try {
      const { res, contentType } = await this._open(item, ac.signal);
      st.total = Number(res.headers.get('content-length')) || 0;
      if (st.total > LIMITS.perItem) throw new DownloadError(`Too big to download (limit ${Math.round(LIMITS.perItem / 1048576)} MB per item).`, 'too_big');
      if (st.total && used + st.total > LIMITS.total) throw new DownloadError('Not enough download storage left. Remove some in Settings → Storage.', 'full');
      await this._navQuotaCheck(st.total);
      const cryptoKey = this.license.key;
      const kid = this.license.kid;
      let n = 0, stored = 0;
      const putChunk = async (bytes) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${key}|${n}`) }, cryptoKey, bytes));
        const out = new Uint8Array(12 + ct.length);
        out.set(iv, 0); out.set(ct, 12);
        await tx(['chunks'], 'readwrite', (s) => s.chunks.put(out.buffer, `${key}#${n}`));
        n++; stored += out.length; written = n;
      };
      let buf = new Uint8Array(CHUNK), fill = 0, received = 0;
      const feed = async (piece) => {
        received += piece.length;
        if (received > LIMITS.perItem) throw new DownloadError(`Too big to download (limit ${Math.round(LIMITS.perItem / 1048576)} MB per item).`, 'too_big');
        if (used + received > LIMITS.total) throw new DownloadError('Not enough download storage left. Remove some in Settings → Storage.', 'full');
        let off = 0;
        while (off < piece.length) {
          const take = Math.min(CHUNK - fill, piece.length - off);
          buf.set(piece.subarray(off, off + take), fill);
          fill += take; off += take;
          if (fill === CHUNK) { await putChunk(buf); buf = new Uint8Array(CHUNK); fill = 0; }
        }
        st.loaded = received;
        st.progress = st.total ? Math.min(1, received / st.total) : -1;
        this._emit(key);
      };
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; await feed(value); }
      } else await feed(new Uint8Array(await res.arrayBuffer()));
      if (fill) await putChunk(buf.slice(0, fill));
      if (!received) throw new DownloadError('The file came back empty.', 'empty');
      if (st.total && received !== st.total) throw new DownloadError('The download was cut short. Try again.', 'short');
      if (ac.signal.aborted) throw new DownloadError('Cancelled.', 'cancelled');
      const rec = { key, id: item.id, type: item.type, userId: this.userId, kid, item: { ...item }, size: received, stored, chunks: n, mime: contentType, at: Date.now() };
      await tx(['items'], 'readwrite', (s) => s.items.put(rec));
      this.index.set(key, rec);
    } catch (e) {
      await tx(['chunks'], 'readwrite', (s) => s.chunks.delete(chunkRange(key))).catch(() => {});
      this.active.delete(key); this._emit(key);
      if (e instanceof DownloadError) throw e;
      if (ac.signal.aborted) throw new DownloadError('Cancelled.', 'cancelled');
      if (e?.name === 'QuotaExceededError') throw new DownloadError('This device is out of storage space for downloads.', 'quota');
      throw new DownloadError('The download failed. Check your connection and try again.', 'failed');
    }
    this.active.delete(key); this._emit(key);
  }

  cancel(item) { this.active.get(keyOf(item))?.ac.abort(); }

  /** Opens the download: the CDN directly when allowed (free for the host), otherwise through this server. */
  async _open(item, signal) {
    const base = `${item.stream_url}?dl=1`;
    let viaProxy = false;
    try { const v = JSON.parse(localStorage.getItem(EXT_KEY) || 'null'); viaProxy = v?.mode === 'proxy' && Date.now() - v.at < 24 * 3600e3; } catch { /* no storage */ }
    const urls = item.external && !viaProxy ? [base, `${base}&proxy=1`] : [item.external ? `${base}&proxy=1` : base];
    let last;
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal, credentials: 'same-origin' });
        if (res.status === 403) {
          const j = await res.json().catch(() => ({}));
          if (j?.error?.code === 'downloads_disabled') throw new DownloadError('The creator turned off downloads for this one.', 'downloads_disabled');
        }
        if (res.status === 401) throw new DownloadError('Sign in again to download.', 'unauthorized');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!/^(audio|video)\//.test(type)) type = 'audio/mpeg';
        return { res, contentType: type };
      } catch (e) {
        if (e instanceof DownloadError || signal.aborted) throw e;
        last = e;
      }
    }
    throw last || new Error('download failed');
  }

  async _navQuotaCheck(need) {
    try {
      const { quota, usage } = await navigator.storage.estimate();
      if (quota && need && quota - usage < need * 1.2 + 20 * 1048576) throw new DownloadError('This device doesn’t have enough free storage for that.', 'quota');
    } catch (e) { if (e instanceof DownloadError) throw e; }
  }

  /* ---------- playing ---------- */

  /**
   * Decrypts a downloaded item into a Blob for the player. Throws DownloadError with code:
   * 'missing' (not downloaded), 'license' (30 days without a check-in, or signed out: go online), 'revoked' / 'corrupt' (can't be opened any more; removed).
   */
  async open(item) {
    const rec = this.index.get(keyOf(item));
    if (!rec) throw new DownloadError('This isn’t downloaded.', 'missing');
    if (!this.licenseValid) throw new DownloadError('Your downloads need a quick check-in with Aurelune. Connect to the internet to keep listening offline.', 'license');
    if (rec.kid !== this.license.kid) { await this._removeKey(rec.key); throw new DownloadError('This download is no longer valid and was removed.', 'revoked'); }
    const d = await db();
    const parts = [];
    try {
      for (let i = 0; i < rec.chunks; i++) {
        const raw = await wrap(d.transaction('chunks').objectStore('chunks').get(`${rec.key}#${i}`));
        if (!raw) throw new Error('missing piece');
        const iv = new Uint8Array(raw, 0, 12);
        parts.push(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${rec.key}|${i}`) }, this.license.key, new Uint8Array(raw, 12))));
      }
    } catch {
      await this._removeKey(rec.key);
      throw new DownloadError('This download is damaged and was removed. Download it again.', 'corrupt');
    }
    const blob = new Blob(parts, { type: rec.mime || 'audio/mpeg' });
    return { blob, url: URL.createObjectURL(blob), size: blob.size };
  }

  /* ---------- removing ---------- */

  async _removeKey(key, emit = true) {
    await tx(['items', 'chunks'], 'readwrite', (s) => { s.items.delete(key); s.chunks.delete(chunkRange(key)); }).catch(() => {});
    this.index.delete(key);
    if (emit) this._emit(key);
  }
  remove(item) { this.cancel(item); return this._removeKey(keyOf(item)); }
  async removeAll() {
    for (const a of this.active.values()) a.ac.abort();
    await tx(['items', 'chunks'], 'readwrite', (s) => { s.items.clear(); s.chunks.clear(); }).catch(() => {});
    this.index.clear();
    this._emit();
  }
  /** Signing out (or the server refusing this device): everything goes, including the key. */
  async wipeAll() {
    clearTimeout(this._timer);
    this.license = null;
    for (const a of this.active.values()) a.ac.abort();
    await tx(['items', 'chunks', 'meta'], 'readwrite', (s) => { s.items.clear(); s.chunks.clear(); s.meta.delete('license'); }).catch(() => {});
    this.index.clear();
    this._emit();
  }
}

export const downloads = new Downloads();

/** Used on sign-out, before the page reloads: wipes without needing init() to have run. */
export async function wipeDownloads() {
  if (!supported) return;
  try { await downloads.wipeAll(); } catch { /* nothing stored */ }
}

export const fmtBytes = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
