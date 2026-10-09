import { icon } from './icons.js';
import { registerItem } from './ui.js';
import { downloads } from './downloads.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60), r = s % 60;
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}m`;
  return `${m}:${String(r).padStart(2, '0')}`;
}
export const fmtMinutes = (ms) => `${Math.round(ms / 60000)} min`;
export const fmtCount = (n) => n == null ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);

export function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
export function fmtRelative(d) {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(d);
}

export const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

export const artistLink = (a) => a ? `<a href="#/artist/${a.slug || a.id}" class="tlink">${esc(a.name)}${a.verified ? ' ' + icon('check', 'verified-inline') : ''}</a>` : '';

/** Primary artist plus accepted collaborators, as links ("Ava, Ben") or plain text. Pending invitations are only for the Studio. */
const credited = (item) => [item.artist || item.creator, ...(item.collaborators || []).filter((c) => c.status !== 'pending')].filter(Boolean);
export const bylineHtml = (item) => credited(item).map(artistLink).join(', ');
export const bylineText = (item) => credited(item).map((a) => a.name).join(', ');

/* ---------------- Cards (used in horizontal shelves & grids) ---------------- */

/* "Liked Songs" tile: the user picks a glyph and a colour, like Spotify's pinned Liked Songs. */
export const LIKED_ICONS = { heart: 'heartFill', star: 'starFilled', bolt: 'bolt', flame: 'flame', moon: 'moon', note: 'note' };
export const LIKED_COLORS = {
  green: 'linear-gradient(135deg,#0f7a3a,#1ed760)', purple: 'linear-gradient(135deg,#450af5,#c4efd9)', pink: 'linear-gradient(135deg,#d6286b,#ffb3d1)',
  blue: 'linear-gradient(135deg,#1e3a8a,#5eb1ff)', orange: 'linear-gradient(135deg,#c2410c,#ffc371)', gray: 'linear-gradient(135deg,#3a3a3a,#9a9a9a)',
};
export function likedTile(style = {}, extraClass = '') {
  const glyph = LIKED_ICONS[style.icon] || 'heartFill';
  return `<span class="liked-tile ${extraClass}" data-g="${glyph}" style="background:${LIKED_COLORS[style.color] || LIKED_COLORS.green}">${icon(glyph)}</span>`;
}

/** Tile for "Liked Episodes" (podcasts): its own fixed look so it's never confused with Liked Songs. */
export const episodesTile = (extraClass = '') => `<span class="liked-tile ${extraClass}" style="background:linear-gradient(135deg,#7a2ff7,#ff8fb1)">${icon('podcast')}</span>`;

/** Small padlock shown beside private (creator-only) tracks and episodes. */
export const lockBadge = () => `<span class="lock-badge" title="Private: only you can see and play this">${icon('lock')}</span>`;

export function trackCard(t) {
  registerItem(t);
  return `<div class="card" data-play-card="${t.id}" data-id="${t.id}" style="cursor:pointer">
    <div class="art-wrap">
      <img src="${t.cover}" alt="" loading="lazy">
      <button class="play-btn sm play-overlay" data-play-card="${t.id}" aria-label="Play ${esc(t.title)}">${icon('play')}</button>
    </div>
    <div class="title">${t.private ? lockBadge() : ''}${esc(t.title)}</div>
    <div class="sub">${esc(bylineText(t))}</div>
  </div>`;
}
export function albumCard(a) {
  registerItem(a);
  return `<div class="card" data-open="album" data-id="${a.id}">
    <div class="art-wrap">
      <img src="${a.cover}" alt="" loading="lazy">
      <button class="play-btn sm play-overlay" data-play-album="${a.id}" aria-label="Play ${esc(a.title)}">${icon('play')}</button>
    </div>
    <div class="title">${esc(a.title)}</div>
    <div class="sub">${a.kind === 'single' ? 'Single' : a.kind === 'ep' ? 'EP' : 'Album'} · ${esc(a.artist?.name || '')}</div>
  </div>`;
}
export function artistCard(a) {
  registerItem(a);
  return `<div class="card round" data-open="artist" data-id="${a.slug || a.id}">
    <div class="art-wrap"><img src="${a.image}" alt="" loading="lazy"></div>
    <div class="title">${a.private ? lockBadge() : ''}${esc(a.name)}${a.verified ? ' ' + icon('check', 'verified-inline') : ''}</div>
    <div class="sub">Artist</div>
  </div>`;
}
export function showCard(s) {
  registerItem(s);
  return `<div class="card" data-open="show" data-id="${s.id}">
    <div class="art-wrap">
      <img src="${s.cover}" alt="" loading="lazy">
      <button class="play-btn sm play-overlay" data-play-show="${s.id}" aria-label="Play latest episode">${icon('play')}</button>
    </div>
    <div class="title">${s.private ? lockBadge() : ''}${esc(s.title)}</div>
    <div class="sub">${esc(s.creator?.name || 'Podcast')}${s.episode_count === 0 ? ' · No episodes yet' : ''}</div>
  </div>`;
}
/** A playlist's picture: a 2x2 collage of the last four added songs, a single cover, or generated art when it's empty. */
export function playlistArt(p, extraClass = '') {
  const imgs = (p?.covers?.length ? p.covers : [p?.id ? `/art/playlist/${p.id}.svg` : '']).filter(Boolean).slice(0, 4);
  const many = imgs.length >= 4;
  return `<div class="collage${many ? '' : ' n1'} ${extraClass}">${(many ? imgs : imgs.slice(0, 1)).map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</div>`;
}

export function playlistCard(p) {
  registerItem(p);
  return `<div class="card" data-open="playlist" data-id="${p.id}">
    <div class="art-wrap">${playlistArt(p)}</div>
    <div class="title">${esc(p.title)}</div>
    <div class="sub">By ${esc(p.owner?.display_name || 'someone')}</div>
  </div>`;
}
export function episodeCard(e) {
  registerItem(e);
  return `<div class="card" data-play-card="${e.id}" data-kind="episode" style="cursor:pointer">
    <div class="art-wrap">
      <img src="${e.cover}" alt="" loading="lazy">
      <button class="play-btn sm play-overlay" data-play-card="${e.id}" data-kind="episode" aria-label="Play ${esc(e.title)}">${icon('play')}</button>
    </div>
    <div class="title">${e.private ? lockBadge() : ''}${esc(e.title)}</div>
    <div class="sub">${esc(e.show?.title || e.creator?.name || 'Podcast')}</div>
  </div>`;
}
export function cardFor(item) {
  if (item.type === 'track') return trackCard(item);
  if (item.type === 'album') return albumCard(item);
  if (item.type === 'artist') return artistCard(item);
  if (item.type === 'show') return showCard(item);
  if (item.type === 'playlist') return playlistCard(item);
  if (item.type === 'episode') return episodeCard(item);
  return '';
}

export function shelf(title, items, { link } = {}) {
  if (!items?.length) return '';
  return `<div class="shelf">
    <div class="section-head"><h2 class="section-title">${esc(title)}</h2>${link ? `<a class="link-more" href="${link}">Show all</a>` : ''}</div>
    <div class="shelf-row scrollbar">${items.map(cardFor).join('')}</div>
  </div>`;
}

/* ---------------- Download button ---------------- */

const DL_LABEL = {
  none: 'Download for offline listening', downloading: 'Downloading… tap to cancel', done: 'Downloaded — tap to remove',
  locked: 'Downloaded — go online to renew (offline licence ran out)',
};
function dlInner(state, progress) {
  if (state === 'downloading') {
    const p = progress > 0 ? progress : 0.25, c = 2 * Math.PI * 8.5;
    return `<svg class="dl-ring ${progress > 0 ? '' : 'spin'}" viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5" stroke="currentColor" opacity="0.25"/><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 12 12)"/><rect x="9.6" y="9.6" width="4.8" height="4.8" rx="1" fill="currentColor" stroke="none"/></svg>`;
  }
  return state === 'done' ? icon('downloadDone') : state === 'locked' ? icon('lock') : icon('download');
}
/** The download button that sits next to a like button. Empty when this browser can't store downloads or the creator turned them off. */
export function dlButton(item, cls = '') {
  if (!downloads.supported || !item || (item.type !== 'track' && item.type !== 'episode')) return '';
  const key = `${item.type}:${item.id}`;
  const state = downloads.statusKey(key, item.downloadable !== false);
  if (state === 'blocked') return '';
  return `<button class="like-btn dl-btn dl-${state} ${cls}" data-dl="${key}" data-dl-ok="${item.downloadable === false ? 0 : 1}" data-dl-state="${state}" aria-label="${DL_LABEL[state]}" title="${DL_LABEL[state]}">${dlInner(state, downloads.progressKey(key))}</button>`;
}
/** Re-draws every download button on the page in place (progress, finished, removed). */
export function refreshDlButtons(root = document) {
  root.querySelectorAll('[data-dl]').forEach((b) => {
    const key = b.dataset.dl;
    const state = downloads.statusKey(key, b.dataset.dlOk !== '0');
    if (state === 'blocked') { b.remove(); return; }
    const prev = b.dataset.dlState;
    b.className = b.className.replace(/\bdl-(none|downloading|done|locked)\b/, `dl-${state}`);
    b.setAttribute('aria-label', DL_LABEL[state]); b.title = DL_LABEL[state];
    if (state === 'downloading') {
      const ring = b.querySelector('.dl-ring');
      const p = downloads.progressKey(key);
      if (prev === 'downloading' && ring && p > 0) { const c = 2 * Math.PI * 8.5; ring.classList.remove('spin'); ring.querySelectorAll('circle')[1].setAttribute('stroke-dasharray', `${(c * p).toFixed(1)} ${c.toFixed(1)}`); }
      else b.innerHTML = dlInner(state, p);
    } else if (prev !== state) b.innerHTML = dlInner(state, 0);
    b.dataset.dlState = state;
  });
}

/* ---------------- Track rows (used in album/playlist/liked/history views) ---------------- */

export function trackRow(t, i, { showArtist = true, showAlbum = false, ctx = '' } = {}) {
  registerItem(t);
  const sub = [showArtist ? bylineHtml(t) : '', showAlbum && t.album ? `<a href="#/album/${t.album.id}" class="tlink">${esc(t.album.title)}</a>` : '']
    .filter(Boolean).join(' · ');
  return `<div class="trow" data-row="track" data-id="${t.id}" data-ctx="${ctx}">
    <div class="idx">
      <span class="num">${i}</span>
      <span class="eq"><i class="equalizer"><i></i><i></i><i></i></i></span>
      <span class="play-hover"><button class="icon-btn" style="width:24px;height:24px;background:none" data-play-row="${t.id}">${icon('play')}</button></span>
    </div>
    <div class="trow-main">
      <div class="trow-cover"><img src="${t.cover}" alt="" loading="lazy"></div>
      <div class="trow-text">
        <div class="t">${t.private ? lockBadge() : ''}${esc(t.title)}</div>
        <div class="s">${sub || '&nbsp;'}</div>
      </div>
    </div>
    <div class="trow-right">
      ${t.explicit ? '<span class="trow-explicit">E</span>' : ''}
      <div class="trow-actions">
        <button class="like-btn ${t.liked ? 'on' : ''}" data-like="${t.id}" aria-label="Like">${icon(t.liked ? 'heartFill' : 'heart')}</button>
        ${dlButton(t)}
        <button class="like-btn" data-more="${t.id}" aria-label="More options">${icon('more')}</button>
      </div>
      <span>${fmtDuration(t.duration_ms)}</span>
    </div>
  </div>`;
}

export function trackList(tracks, opts = {}) {
  if (!tracks?.length) return `<div class="empty"><div class="icon">${icon('disc')}</div><h3>Nothing here yet</h3><p>Tracks will show up here once there are some.</p></div>`;
  return `<div class="row-list">${tracks.map((t, i) => trackRow(t, opts.numbered === false ? '' : (t.track_no || i + 1), opts)).join('')}</div>`;
}

export function episodeRow(e) {
  registerItem(e);
  const pct = e.duration_ms ? Math.min(100, (e.progress_ms / e.duration_ms) * 100) : 0;
  return `<div class="erow" data-row="episode" data-id="${e.id}">
    <div class="cover"><img src="${e.cover}" alt="" loading="lazy"></div>
    <div class="body">
      <div class="date">${fmtDate(e.published_at)}${e.season > 1 || e.number ? ` · S${e.season} E${e.number}` : ''}</div>
      <div class="title">${e.private ? lockBadge() : ''}${esc(e.title)}</div>
      <div class="desc">${esc(e.description)}</div>
      <div class="foot">
        <button class="play-btn sm" data-play-row="${e.id}">${icon(e.completed ? 'play' : 'play')}</button>
        <button class="like-btn ${e.liked ? 'on' : ''}" data-like-ep="${e.id}" aria-label="${e.liked ? 'Remove from Liked Episodes' : 'Save to Liked Episodes'}" title="${e.liked ? 'Remove from Liked Episodes' : 'Save to Liked Episodes'}">${icon(e.liked ? 'heartFill' : 'heart')}</button>
        ${dlButton(e)}
        ${pct > 0 ? `<div class="progress-mini"><i style="width:${pct}%"></i></div>` : ''}
        <span class="dur">${e.completed ? 'Played' : fmtDuration(e.duration_ms - (e.progress_ms || 0))}</span>
      </div>
    </div>
  </div>`;
}

/* ---------------- Misc ---------------- */

export function verifiedBadge() { return `<span class="verified-badge">${icon('check')}</span>`; }

export function skeletonShelf(n = 6, title = false) {
  return `${title ? skHead() : ''}<div class="shelf-row">${Array.from({ length: n }).map(() => `<div class="card"><div class="skeleton art-wrap"></div><div class="skeleton" style="height:14px;width:70%;margin-top:10px;border-radius:4px"></div><div class="skeleton" style="height:11px;width:45%;margin-top:6px;border-radius:4px"></div></div>`).join('')}</div>`;
}

/* ---- Loading placeholders that match the page they stand in for (header, buttons, rows), so nothing jumps when the data arrives ---- */
const skLine = (w, h, mt = 0) => `<div class="skeleton sk-line" style="width:${w};height:${h}px;margin-top:${mt}px"></div>`;
const skHead = (w = 150) => `<div class="section-head">${skLine(`${w}px`, 22)}</div>`;
const skTracks = (n, numbered = true) => `<div class="row-list">${Array.from({ length: n }).map((_, i) => `<div class="sk-trow"><div class="sk-idx">${numbered ? skLine('12px', 12) : ''}</div><div class="sk-main"><div class="skeleton sk-cover-s"></div><div style="flex:1;min-width:0">${skLine(`${38 + ((i * 17) % 34)}%`, 13)}${skLine(`${22 + ((i * 11) % 20)}%`, 10, 7)}</div></div>${skLine('34px', 11)}</div>`).join('')}</div>`;
const skEpisodes = (n) => Array.from({ length: n }).map(() => `<div class="erow"><div class="skeleton sk-ecover"></div><div class="body">${skLine('90px', 11)}${skLine('55%', 15, 10)}${skLine('92%', 11, 12)}${skLine('70%', 11, 6)}<div class="sk-actions" style="margin:14px 0 0">${skLine('36px', 36).replace('sk-line', 'sk-line sk-round')}${skLine('160px', 4)}</div></div></div>`).join('');
const skHeader = (round = false) => `<div class="sk-header"><div class="skeleton sk-cover${round ? ' round' : ''}"></div><div class="sk-meta">${skLine('70px', 12)}${skLine('min(420px,80%)', 40, 12)}${skLine('min(300px,60%)', 13, 14)}</div></div>`;
const skActions = (follow = false) => `<div class="sk-actions"><div class="skeleton sk-play"></div>${follow ? skLine('96px', 36).replace('sk-line', 'sk-line sk-pill') : ''}</div>`;

/** Placeholder shaped like the page being opened: 'home' | 'artist' | 'detail' (album/playlist/liked) | 'show' | 'genre' | 'library'. */
export function skeletonPage(kind = 'home') {
  switch (kind) {
    case 'artist': return `${skHeader(true)}${skActions(true)}${skHead(90)}${skTracks(5)}${skeletonShelf(6, true)}`;
    case 'detail': return `${skHeader()}${skActions()}${skTracks(8)}`;
    case 'show': return `${skHeader()}${skActions(true)}${skLine('min(560px,90%)', 13)}${skLine('min(480px,80%)', 13, 8)}<div style="height:22px"></div>${skHead(100)}${skEpisodes(4)}`;
    case 'genre': return `${skLine('220px', 34)}${skLine('90px', 13, 12)}<div style="height:22px"></div>${skTracks(8, false)}`;
    case 'library': return `${skLine('230px', 34)}<div style="height:18px"></div>${skLine('150px', 40).replace('sk-line', 'sk-line sk-pill')}${skHead(110)}<div class="grid">${Array.from({ length: 8 }).map(() => `<div class="card"><div class="skeleton art-wrap"></div>${skLine('70%', 14, 12)}${skLine('40%', 11, 7)}</div>`).join('')}</div>`;
    default: return `<div class="hero-band">${skLine('min(340px,70%)', 34)}${skLine('min(420px,85%)', 14, 12)}</div>${skeletonShelf(6, true)}${skeletonShelf(6, true)}${skeletonShelf(6, true)}`;
  }
}
