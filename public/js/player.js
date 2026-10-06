import { api } from './api.js';

const REPEAT = ['off', 'all', 'one'];

// Whether PostFile's CDN lets the browser process its audio (CORS) is a property of the CDN, not of a track, so it is remembered.
const EXT_KEY = 'aur_ext_mode';
function readExtMode() {
  try { const v = JSON.parse(localStorage.getItem(EXT_KEY) || 'null'); if (v?.mode === 'proxy' && Date.now() - v.at < 24 * 3600e3) return 'proxy'; } catch { /* no storage */ }
  return 'cors';
}
function saveExtMode(mode) { try { localStorage.setItem(EXT_KEY, JSON.stringify({ mode, at: Date.now() })); } catch { /* no storage */ } }
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
    this.lyrics = null;    // { synced, lines, plain } for the current track; null only while it is loading or failed
    this.lyricsState = 'none'; // 'none' (this item has no lyrics) | 'loading' | 'ready' | 'error'
    this._pinned = null;   // briefly pins the highlighted lyric line to the one the listener just clicked
    this.playRecorded = false;
    this._lastReport = 0;
    this._eqBands = EQ_BANDS_HZ.map(() => 0);
    this._eqNodes = null; // lazily created (needs a user gesture / first local play)
    for (const el of [this._elLocal, this._elCors]) { el.preload = 'metadata'; el.volume = this.volume; this._wireElement(el); }
    window.addEventListener('beforeunload', () => this._recordIfDue(true));
    this._wireMediaSession();
  }

  _wireElement(el) {
    const active = (fn) => () => { if (el === this.audio) fn(); };
    el.addEventListener('timeupdate', active(() => this._onTime()));
    el.addEventListener('ended', active(() => this._onEnded()));
    el.addEventListener('play', active(() => { this._report(true); this._emit(); }));
    el.addEventListener('pause', active(() => { this._report(true); this._emit(); }));
    el.addEventListener('loadedmetadata', active(() => this._emit()));
    el.addEventListener('seeked', active(() => this._checkSeek(el)));
    el.addEventListener('error', active(() => this._onElementError(el)));
  }

  /** A direct-from-CDN load that fails before any audio arrived is most likely CORS (or the CDN being unreachable from here):
   *  play the same track through this server instead, and remember it so the next PostFile track starts that way. */
  _onElementError(el) {
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
  get isPlaying() { return !this.audio.paused && !this.audio.ended && this.current; }

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
    const viaCdn = !!item?.external && this._extMode === 'cors';
    const el = viaCdn ? this._elCors : this._elLocal;
    if (el !== this.audio) { this.audio.pause(); this.audio = el; }
    this._ensureAudioGraph();
    // The element must be wrapped before it plays — and only if its audio is processable (same-origin, or CORS-approved).
    this._wrap(el);
    if (this._eqNodes?.ctx.state === 'suspended') this._eqNodes.ctx.resume().catch(() => {});
    return item?.external && !viaCdn ? `${item.stream_url}?proxy=1` : item?.stream_url;
  }

  _load() {
    const item = this.current;
    if (!item) return;
    this.playRecorded = false;
    this._pinned = null;
    this._retriedViaProxy = false;
    this._retriedSeekViaProxy = false;
    this._seekWanted = null;
    this._errRetries = 0;
    this._lastTime = 0;
    this._resetLyrics(item);
    this._startCurrent(item.progress_ms ? item.progress_ms / 1000 : 0);
    this._fetchLyrics(item);
  }

  _startCurrent(at) {
    const url = this._selectElement();
    this.audio.src = url;
    this.audio.currentTime = at || 0;
    this.audio.play().catch(() => this._emit());
    this._emit();
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
    if (this.audio.paused) this.play();
    this._emit('time');
  }

  toggle() {
    if (!this.current) return;
    this._selectElement();
    this.audio.paused ? this.audio.play() : this.audio.pause();
  }
  play() { if (!this.current) return; this._selectElement(); this.audio.play(); }
  pause() { this.audio.pause(); }

  seekTo(seconds) {
    if (!this.current) return;
    const t = Math.max(0, seconds);
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
    }
  }
  /** Length in seconds. Streams don't always report a usable duration (NaN before metadata, Infinity for some
   *  CDNs), so fall back to the length we stored when the track was uploaded. */
  get durationSec() {
    const d = this.audio.duration;
    return Number.isFinite(d) && d > 0 ? d : (this.current?.duration_ms || 0) / 1000;
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
  _applyVolume() { for (const el of [this._elLocal, this._elCors]) el.volume = this.muted ? 0 : this.volume; }

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
    this.next(false);
  }

  _onTime() {
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
    const ms = this.audio.currentTime * 1000;
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
      is_playing: !this.audio.paused, position_ms: Math.round(this.audio.currentTime * 1000), device: 'web',
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
    const now = this.audio.currentTime * 1000;
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
