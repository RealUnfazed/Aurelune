import { icon } from './icons.js';
import { registerItem } from './ui.js';

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

/* ---------------- Cards (used in horizontal shelves & grids) ---------------- */

export function trackCard(t) {
  registerItem(t);
  return `<div class="card" data-play-card="${t.id}" data-id="${t.id}" style="cursor:pointer">
    <div class="art-wrap">
      <img src="${t.cover}" alt="" loading="lazy">
      <button class="play-btn sm play-overlay" data-play-card="${t.id}" aria-label="Play ${esc(t.title)}">${icon('play')}</button>
    </div>
    <div class="title">${esc(t.title)}</div>
    <div class="sub">${esc(t.artist?.name || '')}</div>
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
    <div class="title">${esc(a.name)}${a.verified ? ' ' + icon('check', 'verified-inline') : ''}</div>
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
    <div class="title">${esc(s.title)}</div>
    <div class="sub">${esc(s.creator?.name || 'Podcast')}</div>
  </div>`;
}
export function playlistCard(p) {
  registerItem(p);
  const imgs = (p.covers?.length ? p.covers : ['/art/playlist/' + p.id + '.svg']).slice(0, 4);
  const cls = imgs.length > 1 ? '' : ' n1';
  return `<div class="card" data-open="playlist" data-id="${p.id}">
    <div class="art-wrap"><div class="collage${cls}">${imgs.map((u) => `<img src="${u}" alt="" loading="lazy">`).join('')}</div></div>
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
    <div class="title">${esc(e.title)}</div>
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

/* ---------------- Track rows (used in album/playlist/liked/history views) ---------------- */

export function trackRow(t, i, { showArtist = true, showAlbum = false, ctx = '' } = {}) {
  registerItem(t);
  const sub = [showArtist ? artistLink(t.artist) : '', showAlbum && t.album ? `<a href="#/album/${t.album.id}" class="tlink">${esc(t.album.title)}</a>` : '']
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
        <div class="t">${esc(t.title)}</div>
        <div class="s">${sub || '&nbsp;'}</div>
      </div>
    </div>
    <div class="trow-right">
      ${t.explicit ? '<span class="trow-explicit">E</span>' : ''}
      <div class="trow-actions">
        <button class="like-btn ${t.liked ? 'on' : ''}" data-like="${t.id}" aria-label="Like">${icon(t.liked ? 'heartFill' : 'heart')}</button>
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
      <div class="title">${esc(e.title)}</div>
      <div class="desc">${esc(e.description)}</div>
      <div class="foot">
        <button class="play-btn sm" data-play-row="${e.id}">${icon(e.completed ? 'play' : 'play')}</button>
        ${pct > 0 ? `<div class="progress-mini"><i style="width:${pct}%"></i></div>` : ''}
        <span class="dur">${e.completed ? 'Played' : fmtDuration(e.duration_ms - (e.progress_ms || 0))}</span>
      </div>
    </div>
  </div>`;
}

/* ---------------- Misc ---------------- */

export function verifiedBadge() { return `<span class="verified-badge">${icon('check')}</span>`; }

export function skeletonShelf(n = 6) {
  return `<div class="shelf-row">${Array.from({ length: n }).map(() => `<div class="card"><div class="skeleton art-wrap"></div><div class="skeleton" style="height:14px;width:70%;margin-top:10px;border-radius:4px"></div><div class="skeleton" style="height:11px;width:45%;margin-top:6px;border-radius:4px"></div></div>`).join('')}</div>`;
}
