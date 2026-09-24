import { api } from './api.js';

const REPEAT = ['off', 'all', 'one'];

/**
 * Owns the <audio> element, the queue, and reporting: pushes now-playing
 * state to /me/player (so any device or API integration can read what you're
 * doing right now) and records a play once enough of the item has been heard.
 */
class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.queue = [];       // array of item DTOs (track or episode)
    this.index = -1;
    this.shuffleOrder = null;
    this.repeat = 'off';   // off | all | one
    this.shuffle = false;
    this.volume = Number(localStorage.getItem('aur_volume') ?? 0.85);
    this.muted = false;
    this.lyrics = null;    // { synced, lines, plain } for the current track
    this.playRecorded = false;
    this.audio.volume = this.volume;
    this._lastReport = 0;

    this.audio.addEventListener('timeupdate', () => this._onTime());
    this.audio.addEventListener('ended', () => this._onEnded());
    this.audio.addEventListener('play', () => { this._report(true); this._emit(); });
    this.audio.addEventListener('pause', () => { this._report(true); this._emit(); });
    this.audio.addEventListener('loadedmetadata', () => this._emit());
    this.audio.addEventListener('error', () => this._emit('error'));
    window.addEventListener('beforeunload', () => this._recordIfDue(true));
    this._wireMediaSession();
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

  _load() {
    const item = this.current;
    if (!item) return;
    this.playRecorded = false;
    this.lyrics = null;
    this.audio.src = item.stream_url;
    this.audio.currentTime = item.progress_ms ? item.progress_ms / 1000 : 0;
    this.audio.play().catch(() => this._emit());
    this._emit();
    if (item.type === 'track' && item.has_lyrics) {
      api.get(`/tracks/${item.id}/lyrics`).then((l) => { this.lyrics = l; this._emit('lyrics'); }).catch(() => {});
    }
  }

  toggle() { this.current && (this.audio.paused ? this.audio.play() : this.audio.pause()); }
  play() { this.current && this.audio.play(); }
  pause() { this.audio.pause(); }

  seekTo(seconds) { if (this.current) this.audio.currentTime = Math.max(0, seconds); }
  seekFraction(f) { if (this.audio.duration) this.seekTo(f * this.audio.duration); }

  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    this.audio.volume = this.volume;
    this.muted = false;
    localStorage.setItem('aur_volume', this.volume);
    this._emit('volume');
  }
  toggleMute() { this.muted = !this.muted; this.audio.volume = this.muted ? 0 : this.volume; this._emit('volume'); }

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
    if (this.repeat === 'one' && !user) return this._load();
    const order = this._order();
    const pos = order.indexOf(this.index);
    if (pos < order.length - 1) { this.index = order[pos + 1]; return this._load(); }
    if (this.repeat === 'all') { this.index = order[0]; return this._load(); }
    this.audio.pause(); this.audio.currentTime = 0; this._emit();
  }

  prev() {
    if (this.audio.currentTime > 4) return this.seekTo(0);
    this._recordIfDue(true);
    const order = this._order();
    const pos = order.indexOf(this.index);
    if (pos > 0) { this.index = order[pos - 1]; this._load(); }
    else this.seekTo(0);
  }

  _onEnded() {
    this._recordIfDue(true);
    if (this.current?.type === 'episode') api.put(`/me/episodes/${this.current.id}/progress`, { completed: true }).catch(() => {});
    this.next(false);
  }

  _onTime() {
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
        title: item.title, artist: item.artist?.name || item.creator?.name || '',
        album: item.album?.title || item.show?.title || '', artwork: [{ src: item.cover, sizes: '400x400', type: 'image/svg+xml' }],
      });
      ms.playbackState = this.isPlaying ? 'playing' : 'paused';
    });
  }

  /** Active lyric line index for the current playback position, or -1. */
  activeLyricIndex() {
    if (!this.lyrics?.synced || !this.lyrics.lines.length) return -1;
    const t = this.audio.currentTime * 1000;
    let i = -1;
    for (let k = 0; k < this.lyrics.lines.length; k++) { if (this.lyrics.lines[k].t <= t) i = k; else break; }
    return i;
  }
}

export const player = new Player();
export const fmtTime = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};
