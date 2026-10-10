import { api } from './api.js';
import { downloads } from './downloads.js';

const REPEAT = ['off', 'all', 'one'];
/** Podcast speeds: 0.5x to 3.5x in steps of 0.1 (like Spotify). Songs always play at 1x. */
export const RATES = Array.from({ length: 31 }, (_, i) => Math.round((0.5 + i * 0.1) * 10) / 10);
/** What the sleep timer offers. `end` stops when the current song/episode finishes. */
export const SLEEP_OPTIONS = [{ min: 5 }, { min: 10 }, { min: 15 }, { min: 30 }, { min: 45 }, { min: 60 }, { end: true }];
const SLEEP_FADE_S = 8; // the sound fades out over the last seconds instead of cutting off

// Whether PostFile's CDN lets the browser process its audio (CORS) is a property of the CDN, not of a track, so it is remembered.
const EXT_KEY = 'aur_ext_mode';
function readExtMode() {
  try { const v = JSON.parse(localStorage.getItem(EXT_KEY) || 'null'); if (v?.mode === 'proxy' && Date.now() - v.at < 24 * 3600e3) return 'proxy'; } catch { /* no storage */ }
  return 'cors';
}
function saveExtMode(mode) { try { localStorage.setItem(EXT_KEY, JSON.stringify({ mode, at: Date.now() })); } catch { /* no storage */ } }
// Songs are downloaded whole into the browser and played from memory (see Player._startBlob): seeking, looping and the equalizer
// then never depend on how the host or CDN handles Range requests, CORS or caching. Anything bigger (long podcast episodes) streams.
// 0.1 s of silence. Played inside the user's click while the song downloads, so phones (iOS, Android WebView) that only allow
// audio to start from a tap keep allowing it once the real song is ready a moment later.
const UNLOCK_CLIP = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
const BLOB_MAX_BYTES = 30 * 1048576;
const BLOB_MAX_MS = 15 * 60e3;
const BLOB_CACHE_ITEMS = 4;
const BLOB_CACHE_BYTES = 160 * 1048576;
export const EQ_BANDS_HZ = [60, 150, 400, 1000, 2400, 6000, 15000];

/**
 * Owns the <audio> element, the queue, and reporting: pushes now-playing
 * state to /me/player (so any device or API integration can read what you're
 * doing right now) and records a play once enough of the item has been heard.
 */
class Player extends EventTarget {
  constructor() {
    super();
    // Two elements, both routed through the Web Audio equalizer graph (an element can only be wrapped once, and the
    // browser decides per element whether cross-origin audio may be processed):
    //  _elLocal  audio from this server — same-origin, always processable. PostFile tracks are also played here, through
    //            this server (`?proxy=1`), when PostFile's CDN doesn't allow cross-origin processing.
    //  _elCors   audio fetched straight from PostFile's CDN with CORS (crossOrigin=anonymous). Only usable when the CDN
    //            sends CORS headers; if the first load fails we fall back to the proxy and remember that.
    this._elLocal = new Audio();
    this._elCors = new Audio();
    this._elCors.crossOrigin = 'anonymous';
    this._extMode = readExtMode(); // 'cors' (try the CDN directly) | 'proxy' (go through this server)
    this.audio = this._elLocal; // the currently active element
    this.queue = [];       // array of item DTOs (track or episode)
    this.index = -1;
    this.shuffleOrder = null;
    this.repeat = 'off';   // off | all | one
    this.shuffle = false;
    this.volume = Number(localStorage.getItem('aur_volume') ?? 0.85);
    this.muted = false;
    let rate = 1; try { rate = Number(localStorage.getItem('aur_rate')) || 1; } catch { /* no storage */ }
    this.rate = RATES.includes(Math.round(rate * 10) / 10) ? Math.round(rate * 10) / 10 : 1; // podcast speed, remembered on this device
    this.sleep = null;     // null | { end: true } | { endsAt: ms since epoch, total: ms }
    this._sleepTimer = null; this._fade = 1; this._sleepSec = -1;
    this.lyrics = null;    // { synced, lines, plain } for the current track; null only while it is loading or failed
    this.lyricsState = 'none'; // 'none' (this item has no lyrics) | 'loading' | 'ready' | 'error'
    this._pinned = null;   // briefly pins the highlighted lyric line to the one the listener just clicked
    this.playRecorded = false;
    this._lastReport = 0;
    this._eqBands = EQ_BANDS_HZ.map(() => 0);
    this._eqNodes = null; // lazily created (needs a user gesture / first local play)
    for (const el of [this._elLocal, this._elCors]) { el.preload = 'metadata'; el.volume = this.volume; this._wireElement(el); }
    // Whole-song-in-memory playback (see _startBlob). Needs a real browser; `localStorage.aur_stream_mode = 'stream'` switches it off.
    let streamOnly = false; try { streamOnly = localStorage.getItem('aur_stream_mode') === 'stream'; } catch { /* no storage */ }
    this._blobCapable = typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function';
    this._canBlob = !streamOnly && typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL?.createObjectURL === 'function';
    this._blobs = new Map();   // item id -> { blob, url, size }, most recently used last
    this._noBlob = new Set();  // items whose blob playback failed once: stream those
    this._noDownload = new Set(); // downloaded items that couldn't be opened this session (licence, damage): play online instead
    this._loadSeq = 0;
    this.loading = false;      // a song is being downloaded before it starts
    this._wantPlay = true;
    this._pendingAt = 0;
    this._blobActive = false;  // the current item plays from a blob (always on the same-origin element)
    window.addEventListener('beforeunload', () => this._recordIfDue(true));
    this._wireMediaSession();
  }

  _wireElement(el) {
    const active = (fn) => () => { if (el === this.audio && !this.loading) fn(); }; // (events from the unlock clip while a song downloads are ignored)
    el.addEventListener('timeupdate', active(() => this._onTime()));
    el.addEventListener('ended', active(() => this._onEnded()));
    el.addEventListener('play', active(() => { this._report(true); this._emit(); }));
    el.addEventListener('pause', active(() => { this._report(true); this._emit(); }));
    el.addEventListener('loadedmetadata', active(() => this._emit()));
    el.addEventListener('loadedmetadata', () => this._applyRate()); // a new source resets the speed on some browsers
    el.addEventListener('seeked', active(() => this._checkSeek(el)));
    el.addEventListener('error', active(() => this._onElementError(el)));
  }

  /** A direct-from-CDN load that fails before any audio arrived is most likely CORS (or the CDN being unreachable from here):
   *  play the same track through this server instead, and remember it so the next PostFile track starts that way. */
  _onElementError(el) {
    if (this._blobActive && el === this.audio && this.current && !this.loading) {
      // The in-memory copy won't play (bad data): forget it and stream this song instead.
      const id = this.current.id, at = this._lastTime || 0, e = this._blobs.get(id);
      if (e) { this._blobs.delete(id); URL.revokeObjectURL(e.url); }
      this._noBlob.add(id); this._blobActive = false;
      return this._startStream(at);
    }
    if (el === this._elCors && this.current?.external && this.audio === el && el.readyState === 0 && !this._retriedViaProxy) {
      this._retriedViaProxy = true;
      this._extMode = 'proxy';
      saveExtMode('proxy');
      const resumeAt = el.currentTime || (this.current.progress_ms ? this.current.progress_ms / 1000 : 0);
      this._startCurrent(resumeAt);
      return;
    }
    // The stream broke part-way (a dropped connection, the server restarting, a seek whose request failed): carry on from where
    // the listener was, instead of leaving a dead player that restarts from 0 on the next press. Two tries per song.
    const at = this._seekWanted?.t ?? this._lastTime ?? 0;
    if (el === this.audio && this.current && at > 1 && (this._errRetries || 0) < 2) {
      this._errRetries = (this._errRetries || 0) + 1;
      if (el === this._elCors && this.current.external) { this._extMode = 'proxy'; saveExtMode('proxy'); } // the CDN stopped answering the player's requests: go through our server
      setTimeout(() => { if (el === this.audio && this.current) this._startCurrent(at); }, 600 * this._errRetries);
      return;
    }
    this._emit('error');
  }

  /** Builds the Web Audio graph the first time it's needed. An <audio> element can only ever be wrapped in a
   *  MediaElementSource once, and AudioContext needs a user gesture to run — so this is called lazily from play(),
   *  not the constructor. Both elements feed the same filter chain. */
  _ensureAudioGraph() {
    if (this._eqNodes) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // Web Audio unsupported: playback still works, EQ silently no-ops
    try {
      const ctx = new Ctx();
      const filters = EQ_BANDS_HZ.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.1;
        f.gain.value = this._eqBands[i] || 0;
        return f;
      });
      for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
      filters[filters.length - 1].connect(ctx.destination);
      this._eqNodes = { ctx, filters, wrapped: new Set() };
    } catch { /* if this fails for any reason, playback still works without EQ */ }
  }

  _wrap(el) {
    const g = this._eqNodes;
    if (!g || g.wrapped.has(el)) return;
    try { g.ctx.createMediaElementSource(el).connect(g.filters[0]); g.wrapped.add(el); }
    catch { /* leave this element unprocessed rather than silent */ }
  }

  /** True when the current track is running through the equalizer. */
  get eqActive() { return !!this._eqNodes?.wrapped.has(this.audio); }

  /** Applies EQ band gains (dB) live. Safe to call before playback has started. */
  setEQBands(bands) {
    this._eqBands = bands.slice();
    if (this._eqNodes) this._eqNodes.filters.forEach((f, i) => { f.gain.value = bands[i] || 0; });
  }

  get current() { return this.index >= 0 ? this.queue[this.index] : null; }
  get isPlaying() { return this.current && (this.loading ? this._wantPlay : !this.audio.paused && !this.audio.ended); }

  _emit(type = 'change') { this.dispatchEvent(new CustomEvent(type)); }

  _kindId(item) { return { kind: item.type === 'episode' ? 'episode' : 'track', id: item.id }; }

  /** Replace the queue and start playing at `startIndex`. */
  playQueue(items, startIndex = 0, { source = '' } = {}) {
    if (!items.length) return;
    this._recordIfDue(true);
    this.queue = items.slice();
    this.shuffleOrder = null;
    this.index = startIndex;
    this.source = source;
    this._load();
  }

  playNext(item) {
    if (!this.queue.length) return this.playQueue([item], 0);
    this.queue.splice(this.index + 1, 0, item);
    this._emit('queue');
  }
  addToQueue(item) {
    if (!this.queue.length) return this.playQueue([item], 0);
    this.queue.push(item);
    this._emit('queue');
  }
  removeFromQueue(i) {
    if (i === this.index) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this._emit('queue');
  }

  /** Chooses the element (and URL) for the current item and readies the EQ graph for it. */
  _selectElement() {
    const item = this.current;
    const viaCdn = !this._blobActive && !!item?.external && this._extMode === 'cors';
    const el = viaCdn ? this._elCors : this._elLocal;
    if (el !== this.audio) { this.audio.pause(); this.audio = el; }
    this._ensureAudioGraph();
    // The element must be wrapped before it plays — and only if its audio is processable (same-origin, or CORS-approved).
    this._wrap(el);
    if (this._eqNodes?.ctx.state === 'suspended') this._eqNodes.ctx.resume().catch(() => {});
    this._applyRate();
    return item?.external && !viaCdn && !this._blobActive ? `${item.stream_url}?proxy=1` : item?.stream_url;
  }

  _load() {
    const item = this.current;
    if (!item) return;
    this.playRecorded = false;
    this._pinned = null;
    this._retriedViaProxy = false;
    this._retriedSeekViaProxy = false;
    this._seekReloaded = false;
    this._seekWanted = null;
    this._errRetries = 0;
    this._lastTime = 0;
    this._resetLyrics(item);
    this._startCurrent(item.progress_ms ? item.progress_ms / 1000 : 0);
    this._fetchLyrics(item);
  }

  /** What is held in memory right now (for the Storage settings). */
  cacheInfo() { let bytes = 0; for (const e of this._blobs.values()) bytes += e.size; return { count: this._blobs.size, bytes, streamMode: !this._canBlob, supported: this._blobCapable }; }

  /** Frees the songs kept in memory. The one playing right now is kept (its audio element is reading it); it goes with the next song. */
  clearCache() {
    const playing = this._blobActive ? this.current?.id : null;
    for (const [id, e] of this._blobs) { if (id === playing) continue; this._blobs.delete(id); URL.revokeObjectURL(e.url); }
    this._noBlob.clear();
    return this.cacheInfo();
  }

  /** true = never keep songs in memory: always stream (the way it worked before). Remembered in this browser. */
  setStreamMode(on) {
    try { on ? localStorage.setItem('aur_stream_mode', 'stream') : localStorage.removeItem('aur_stream_mode'); } catch { /* no storage */ }
    this._canBlob = !on && this._blobCapable;
    if (on) this.clearCache();
  }

  _canBlobItem(item) {
    return this._canBlob && item?.type === 'track' && !this._noBlob.has(item.id) && (!item.duration_ms || item.duration_ms <= BLOB_MAX_MS);
  }

  _startCurrent(at) {
    this._abortLoad?.abort(); this._abortLoad = null; this.loading = false;
    const item = this.current;
    // A downloaded copy always wins (it works offline, and is the only way to play a long episode from memory).
    if (this._blobCapable && downloads.isDownloaded(item) && !this._noDownload.has(item.id)) return this._startBlob(item, at, true);
    if (this._canBlobItem(item)) return this._startBlob(item, at);
    this._blobActive = false;
    this._startStream(at);
  }

  _startStream(at) {
    const url = this._selectElement();
    this.audio.src = url;
    this.audio.currentTime = at || 0;
    this.audio.play().catch(() => this._emit());
    this._emit();
  }

  /**
   * Plays a song from memory: fetch the whole file once (a normal GET, no Range), keep it as a Blob, point the audio element at an
   * object URL. Why: once the bytes are in the browser, seeking is purely local, so it can't "jump to the start" whatever the host
   * does with Range; looping and going back to a song need no download at all; and the equalizer works because an object URL is
   * same-origin, so audio straight from PostFile's CDN no longer has to be proxied through this server (that is what burned the
   * hosting bandwidth). If PostFile's CDN refuses the cross-origin read, the same file is read through this server instead.
   */
  async _startBlob(item, at, offline = false) {
    const seq = ++this._loadSeq;
    const ac = new AbortController(); this._abortLoad = ac;
    this._blobActive = true; this._pendingAt = at || 0; this._wantPlay = true;
    this._selectElement(); // the same-origin element, wrapped by the equalizer graph, in the user's click context
    this.audio.pause();
    let entry = this._blobs.get(item.id);
    if (entry) { this._blobs.delete(item.id); this._blobs.set(item.id, entry); } // most recently used
    else {
      this.loading = true;
      try { this.audio.src = UNLOCK_CLIP; this.audio.play().catch(() => {}); } catch { /* ignore */ }
      this._emit();
      try { entry = offline ? await this._openDownload(item) : await this._downloadBlob(item, ac.signal); }
      catch (e) {
        if (seq !== this._loadSeq || ac.signal.aborted) return; // another song was chosen meanwhile
        this.loading = false; this._blobActive = false;
        if (offline) {
          // The copy on this device can't be opened right now. Online: just play it from the server. Offline: say why and stop.
          this._noDownload.add(item.id);
          const online = typeof navigator === 'undefined' || navigator.onLine !== false;
          this.dispatchEvent(new CustomEvent('notice', { detail: { message: e.message || 'This download can’t be played right now.', err: true } }));
          if (online) return this._startCurrent(this._pendingAt);
          this.audio.removeAttribute('src'); this.audio.load?.(); this._wantPlay = false;
          return this._emit();
        }
        this._noBlob.add(item.id); // couldn't buffer it: stream it the old way
        return this._startStream(this._pendingAt);
      }
      if (seq !== this._loadSeq) return;
      this._blobs.set(item.id, entry);
      this._trimBlobs(item.id);
    }
    this.loading = false;
    const el = this.audio;
    el.src = entry.url;
    el.currentTime = this._pendingAt || 0;
    if (this._wantPlay) el.play().catch(() => this._emit());
    this._emit();
  }

  /** Decrypts the downloaded copy. A lapsed licence is renewed first when we are online. */
  async _openDownload(item) {
    if (!downloads.licenseValid && navigator.onLine !== false) await downloads.checkIn({ force: true }).catch(() => {});
    return downloads.open(item);
  }

  async _downloadBlob(item, signal) {
    const base = item.stream_url;
    // PostFile files: try the CDN directly (free for you), then through this server. Everything else only has this server.
    const urls = item.external ? (this._extMode === 'proxy' ? [`${base}?proxy=1`] : [base, `${base}?proxy=1`]) : [base];
    let lastErr;
    for (const url of urls) {
      try {
        const r = await fetch(url, { signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const len = Number(r.headers.get('content-length')) || 0;
        if (len > BLOB_MAX_BYTES) { r.body?.cancel().catch(() => {}); const e = new Error('too big'); e.tooBig = true; throw e; }
        const buf = await r.arrayBuffer();
        if (len && buf.byteLength !== len) throw new Error('short read');
        if (!buf.byteLength || buf.byteLength > BLOB_MAX_BYTES) throw new Error('bad size');
        let type = (r.headers.get('content-type') || '').split(';')[0].trim();
        if (!/^(audio|video)\//.test(type)) type = 'audio/mpeg';
        const blob = new Blob([buf], { type });
        if (item.external && url === base && this._extMode !== 'cors') { this._extMode = 'cors'; saveExtMode('cors'); }
        return { blob, url: URL.createObjectURL(blob), size: blob.size };
      } catch (e) {
        if (signal.aborted || e.tooBig) throw e;
        lastErr = e;
        if (item.external && url === base) { this._extMode = 'proxy'; saveExtMode('proxy'); } // the CDN wouldn't allow it: go through our server
      }
    }
    throw lastErr || new Error('download failed');
  }

  /** Keeps the last few songs (never the one playing) so going back or looping is free, within a memory budget. */
  _trimBlobs(keepId) {
    let total = 0; for (const e of this._blobs.values()) total += e.size;
    for (const [id, e] of this._blobs) {
      if (this._blobs.size <= 1 || (this._blobs.size <= BLOB_CACHE_ITEMS && total <= BLOB_CACHE_BYTES)) break;
      if (id === keepId || id === this.current?.id) continue;
      this._blobs.delete(id); total -= e.size; URL.revokeObjectURL(e.url);
    }
  }

  /** Items without lyrics get an explicit empty result straight away, so the UI never waits on nothing. */
  _resetLyrics(item) {
    if (item.type === 'track' && item.has_lyrics) { this.lyrics = null; this.lyricsState = 'loading'; }
    else { this.lyrics = { synced: false, lines: [], plain: '' }; this.lyricsState = 'none'; }
  }

  _fetchLyrics(item) {
    if (this.lyricsState !== 'loading') return;
    api.get(`/tracks/${item.id}/lyrics`).then((l) => {
      if (this.current?.id !== item.id) return; // the listener moved on while this was in flight
      this.lyrics = l; this.lyricsState = 'ready'; this._emit('lyrics');
    }).catch(() => {
      if (this.current?.id !== item.id) return;
      this.lyrics = null; this.lyricsState = 'error'; this._emit('lyrics');
    });
  }

  retryLyrics() {
    const item = this.current;
    if (!item) return;
    this._resetLyrics(item);
    if (this.lyricsState === 'loading') { this._emit('lyrics'); this._fetchLyrics(item); }
  }

  /** Jump to a synced lyric line and make sure it plays (a click on a line means "from here"). */
  seekToLyric(i) {
    const line = this.lyrics?.lines?.[i];
    if (!line || !this.current) return;
    this._pinned = { i, t: line.t, until: performance.now() + 1500 };
    this.seekTo(line.t / 1000);
    if (this.loading ? !this._wantPlay : this.audio.paused) this.play(); // (while a song downloads, `audio` is the unlock clip: ask the player, not the element)
    this._emit('time');
  }

  toggle() {
    if (!this.current) return;
    if (this.loading) { this._wantPlay = !this._wantPlay; this._emit(); return; } // still downloading: just flip what happens when it's ready
    this._selectElement();
    this.audio.paused ? this.audio.play() : this.audio.pause();
  }
  play() { if (!this.current) return; if (this.loading) { this._wantPlay = true; this._emit(); return; } this._selectElement(); this.audio.play(); }
  pause() { if (this.loading) { this._wantPlay = false; this._emit(); return; } this.audio.pause(); }

  seekTo(seconds) {
    if (!this.current) return;
    const t = Math.max(0, seconds);
    if (this.loading) { this._pendingAt = t; this._emit('time'); return; } // applied when the song has finished downloading
    this._seekWanted = { t, id: this.current.id, el: this.audio };
    this.audio.currentTime = t;
  }

  /** After a seek lands far from where it was asked to: the server behind the audio ignored the Range request and sent the file
   *  from the start (seeking then "jumps to the beginning"). Straight from PostFile's CDN that means the CDN can't seek, so play this
   *  track through our own server, which always can, and carry on from the wanted spot. */
  _checkSeek(el) {
    const w = this._seekWanted; this._seekWanted = null;
    if (!w || w.el !== el || w.id !== this.current?.id || w.t < 3) return;
    if (Math.abs(el.currentTime - w.t) < 3) return;
    if (el === this._elCors && this.current?.external && !this._retriedSeekViaProxy) {
      this._retriedSeekViaProxy = true;
      this._extMode = 'proxy';
      saveExtMode('proxy');
      this._startCurrent(w.t);
      return;
    }
    // Last resort, whatever the host did: it still landed far from where the listener asked (usually at the start). Reload this song
    // once, positioned at the wanted spot from the beginning — the same way a song resumes — instead of leaving it wrong.
    if (!this._seekReloaded && !this._blobActive) {
      this._seekReloaded = true;
      this._startCurrent(w.t);
    }
  }
  /** Length in seconds. Streams don't always report a usable duration (NaN before metadata, Infinity for some
   *  CDNs), so fall back to the length we stored when the track was uploaded. */
  get durationSec() {
    // While a song downloads, the audio element holds the previous song or the 0.1 s unlock clip: its duration is meaningless here.
    // (Using it made a seek during the download land at ~0 of a 0.1 s clip, i.e. "it jumps back to the start".)
    if (this.loading) return (this.current?.duration_ms || 0) / 1000;
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d : (this.current?.duration_ms || 0) / 1000;
  }
  /** Where the listener is, in seconds. While a song is still downloading that is the spot they chose (or 0), not the unlock clip's clock. */
  get position() { return this.loading ? this._pendingAt || 0 : this.audio.currentTime; }
  /** Jump forward (positive) or back (negative) by some seconds, staying inside the song/episode. */
  skip(seconds) {
    if (!this.current) return;
    const d = this.durationSec;
    this.seekTo(Math.min(d || Infinity, Math.max(0, this.position + seconds)));
  }
  seekFraction(f) {
    const d = this.durationSec;
    if (d && Number.isFinite(f)) this.seekTo(Math.min(1, Math.max(0, f)) * d);
  }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this._applyVolume();
    this.muted = false;
    localStorage.setItem('aur_volume', this.volume);
    this._emit('volume');
  }
  toggleMute() { this.muted = !this.muted; this._applyVolume(); this._emit('volume'); }
  _applyVolume() { for (const el of [this._elLocal, this._elCors]) el.volume = this.muted ? 0 : this.volume * this._fade; }

  /* ------------------------------------------------------------ playback speed (podcasts) ------------------------------------------------------------ */

  /** The speed that applies right now: the chosen one for podcast episodes, always 1x for songs. */
  get effectiveRate() { return this.current?.type === 'episode' ? this.rate : 1; }
  setRate(r) {
    r = Math.round(Number(r) * 10) / 10;
    if (!RATES.includes(r)) return;
    this.rate = r;
    try { localStorage.setItem('aur_rate', String(r)); } catch { /* no storage */ }
    this._applyRate();
    this._emit('rate'); this._emit();
  }
  _applyRate() {
    const r = this.effectiveRate;
    for (const el of [this._elLocal, this._elCors]) {
      try { el.defaultPlaybackRate = r; el.playbackRate = r; el.preservesPitch = true; el.webkitPreservesPitch = true; } catch { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------ sleep timer ------------------------------------------------------------ */

  /** Starts the timer: `{ minutes }` stops playback after that long, `{ end: true }` after the current song/episode. Calling it again replaces it. */
  setSleep(opt) {
    this.clearSleep(true);
    if (opt?.end) this.sleep = { end: true };
    else if (opt?.minutes > 0) this.sleep = { endsAt: Date.now() + opt.minutes * 60e3, total: opt.minutes * 60e3 };
    else return this._emit('sleep');
    if (this.sleep.endsAt) this._sleepTimer = setInterval(() => this._sleepTick(), 250);
    this._emit('sleep');
  }
  clearSleep(quiet = false) {
    clearInterval(this._sleepTimer); this._sleepTimer = null;
    this.sleep = null; this._sleepSec = -1;
    if (this._fade !== 1) { this._fade = 1; this._applyVolume(); }
    if (!quiet) this._emit('sleep');
  }
  /** Seconds left (time mode), or null. */
  get sleepLeft() { return this.sleep?.endsAt ? Math.max(0, Math.ceil((this.sleep.endsAt - Date.now()) / 1000)) : null; }
  _sleepTick() {
    const s = this.sleep;
    if (!s?.endsAt) return;
    const left = (s.endsAt - Date.now()) / 1000;
    if (left <= 0) return this._sleepFire();
    if (left < SLEEP_FADE_S) { this._fade = Math.max(0, left / SLEEP_FADE_S); this._applyVolume(); }
    const sec = Math.ceil(left);
    if (sec !== this._sleepSec) { this._sleepSec = sec; this._emit('sleep'); }
  }
  _sleepFire() {
    this.pause();
    this.clearSleep(true); // (restores the volume after the pause, so the next play starts at full volume)
    this.dispatchEvent(new CustomEvent('notice', { detail: { message: 'Sleep timer ended: playback stopped. Good night.' } }));
    this._emit('sleep'); this._emit();
  }

  toggleShuffle() { this.shuffle = !this.shuffle; this.shuffleOrder = null; this._emit(); }
  cycleRepeat() { this.repeat = REPEAT[(REPEAT.indexOf(this.repeat) + 1) % REPEAT.length]; this._emit(); }

  _order() {
    if (!this.shuffle) return this.queue.map((_, i) => i);
    if (!this.shuffleOrder) {
      const rest = this.queue.map((_, i) => i).filter((i) => i !== this.index);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      this.shuffleOrder = [this.index, ...rest];
    }
    return this.shuffleOrder;
  }

  next(user = true) {
    this._recordIfDue(true);
    if (this.repeat === 'one' && !user) return this._replay();
    const order = this._order();
    const pos = order.indexOf(this.index);
    if (pos < order.length - 1) { this.index = order[pos + 1]; return this._load(); }
    if (this.repeat === 'all') { const first = order[0]; if (first === this.index) return this._replay(); this.index = first; return this._load(); }
    this.audio.pause(); this.audio.currentTime = 0; this._emit();
  }

  /** Plays the current item again from the start WITHOUT reloading it. Looping used to set the source again each time, which
   *  made the browser download the whole file (and the cover) again on every repeat. The audio is already buffered. */
  _replay() {
    this.playRecorded = false;
    this._pinned = null;
    this._selectElement();
    this.audio.currentTime = 0;
    this.audio.play().catch(() => this._emit());
    this._emit('time');
  }

  /** Previous always goes to the previous item. (It used to restart the current one when more than 4 s in, which reads as a bug:
   *  the song "jumps to the start". With nothing before it, or on repeat-all at the first item, it wraps or restarts.) */
  prev() {
    this._recordIfDue(true);
    const order = this._order();
    const pos = order.indexOf(this.index);
    if (pos > 0) { this.index = order[pos - 1]; this._load(); }
    else if (this.repeat === 'all' && order.length > 1) { this.index = order[order.length - 1]; this._load(); }
    else this.seekTo(0);
  }

  _onEnded() {
    this._recordIfDue(true);
    if (this.current?.type === 'episode') api.put(`/me/episodes/${this.current.id}/progress`, { completed: true }).catch(() => {});
    if (this.sleep?.end) { // "end of this song/episode": stop here, don't move on and don't loop
      this.clearSleep(true);
      this.dispatchEvent(new CustomEvent('notice', { detail: { message: 'Sleep timer ended: playback stopped. Good night.' } }));
      this._emit('sleep'); this._emit();
      return;
    }
    this.next(false);
  }

  _onTime() {
    if (this.sleep?.endsAt) this._sleepTick(); // (the interval can be throttled in a background tab; playback events still arrive)
    if (!this.audio.seeking && this.audio.currentTime > 0) this._lastTime = this.audio.currentTime;
    this._emit('time');
    this._recordIfDue(false);
    const now = performance.now();
    if (now - this._lastReport > 5000) { this._lastReport = now; this._report(true); }
    if (this.current?.type === 'episode' && Math.floor(this.audio.currentTime) % 10 === 0) {
      api.put(`/me/episodes/${this.current.id}/progress`, { position_ms: Math.floor(this.audio.currentTime * 1000) }).catch(() => {});
    }
  }

  _recordIfDue(force) {
    const item = this.current;
    if (!item || this.playRecorded) return;
    const ms = this.position * 1000;
    const need = Math.min(30000, (item.duration_ms || 60000) * 0.5);
    if (ms >= need || (force && ms > 2000)) {
      this.playRecorded = true;
      api.post('/me/plays', { kind: item.type === 'episode' ? 'episode' : 'track', id: item.id, ms_played: Math.round(ms), source: this.source || '' }).catch(() => {});
    }
  }

  _report(immediate) {
    const item = this.current;
    if (!item) return;
    const send = () => api.put('/me/player', {
      kind: item.type === 'episode' ? 'episode' : 'track', id: item.id,
      is_playing: !!this.isPlaying, position_ms: Math.round(this.position * 1000), device: 'web',
    }).catch(() => {});
    immediate ? send() : setTimeout(send, 300);
  }

  _wireMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    for (const [action, sign] of [['seekbackward', -1], ['seekforward', 1]]) {
      try { ms.setActionHandler(action, (d) => this.skip(sign * (d?.seekOffset || 15))); } catch { /* not supported here */ }
    }
    ms.setActionHandler('seekto', (d) => d.seekTime != null && this.seekTo(d.seekTime));
    this.addEventListener('change', () => {
      const item = this.current;
      if (!item) { ms.metadata = null; return; }
      ms.metadata = new MediaMetadata({
        title: item.title, artist: [item.artist || item.creator, ...(item.collaborators || []).filter((c) => c.status !== 'pending')].filter(Boolean).map((a) => a.name).join(', '),
        album: item.album?.title || item.show?.title || '', artwork: [{ src: item.cover, sizes: '400x400', type: 'image/svg+xml' }],
      });
      ms.playbackState = this.isPlaying ? 'playing' : 'paused';
    });
  }

  /** Active lyric line index for the current playback position, or -1. Binary search; a few ms of tolerance so a
   *  line lights up the moment it is sung (timeupdate only fires ~4x a second) and a click lands on the clicked line. */
  activeLyricIndex() {
    const lines = this.lyrics?.synced ? this.lyrics.lines : null;
    if (!lines?.length) return -1;
    const now = this.position * 1000;
    const pin = this._pinned;
    if (pin) {
      if (performance.now() < pin.until && Math.abs(now - pin.t) < 1500) return pin.i;
      this._pinned = null;
    }
    const t = now + 60;
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
}

export const player = new Player();
/** 3:07 for short items, 1:05:09 once it passes an hour (a 3-hour podcast should not read "185:09"). */
export const fmtTime = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
