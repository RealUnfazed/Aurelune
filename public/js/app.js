import { api } from './api.js';
import { player, fmtTime } from './player.js';
import { getUser, setUser, onUserChange, isCreatorApproved, isAdmin } from './store.js';
import { toast, openModal, getActiveList, getItem, bus } from './ui.js';
import { icon, Icon } from './icons.js';
import { esc, fmtDuration } from './components.js';
import { Views, addToPlaylistModal } from './views.js';

/* ============================================================ Auth screen ============================================================ */

function renderAuth() {
  const app = document.getElementById('app');
  app.classList.add('no-auth');
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-aurora"><div class="a1"></div><div class="a2"></div><div class="a3"></div></div>
      <div class="auth-card">
        <div class="auth-brand">${Icon.logo}<span>Aurelune</span></div>
        <div class="auth-tabs"><button class="active" data-t="login">Sign in</button><button data-t="signup">Create account</button></div>
        <div id="auth-body"></div>
        <p class="auth-foot">A self-hosted home for the music and shows only you and your people upload.</p>
      </div>
    </div>`;
  const body = app.querySelector('#auth-body');
  const tabs = app.querySelectorAll('.auth-tabs button');

  function loginForm() {
    body.innerHTML = `
      <div class="field"><label>Username or email</label><input type="text" id="a-login" autocomplete="username"></div>
      <div class="field"><label>Password</label><input type="password" id="a-pass" autocomplete="current-password"></div>
      <button class="btn btn-primary" id="a-submit">Sign in</button>
      <p style="font-size:12px;color:var(--text-faint);margin-top:14px">Demo account: <b>demo</b> / <b>demo12345</b></p>`;
    body.querySelector('#a-submit').addEventListener('click', () => submit('/auth/login', { login: body.querySelector('#a-login').value.trim(), password: body.querySelector('#a-pass').value }));
    body.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && body.querySelector('#a-submit').click()));
  }
  function signupForm() {
    body.innerHTML = `
      <div class="field"><label>Username</label><input type="text" id="a-user" autocomplete="username" placeholder="letters, numbers, dots, underscores"></div>
      <div class="field"><label>Display name</label><input type="text" id="a-name" autocomplete="name"></div>
      <div class="field"><label>Email</label><input type="email" id="a-email" autocomplete="email"></div>
      <div class="field"><label>Password</label><input type="password" id="a-pass2" autocomplete="new-password"></div>
      <button class="btn btn-primary" id="a-submit">Create account</button>`;
    body.querySelector('#a-submit').addEventListener('click', () => submit('/auth/signup', {
      username: body.querySelector('#a-user').value.trim(), display_name: body.querySelector('#a-name').value.trim(),
      email: body.querySelector('#a-email').value.trim(), password: body.querySelector('#a-pass2').value,
    }));
    body.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && body.querySelector('#a-submit').click()));
  }
  async function submit(path, payload) {
    const btn = body.querySelector('#a-submit');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Please wait…';
    try {
      const r = await api.post(path, payload);
      setUser(r.user);
      boot();
    } catch (err) { toast(err.message, { err: true }); btn.disabled = false; btn.textContent = orig; }
  }
  tabs.forEach((t) => t.addEventListener('click', () => { tabs.forEach((x) => x.classList.remove('active')); t.classList.add('active'); t.dataset.t === 'login' ? loginForm() : signupForm(); }));
  loginForm();
}

/* ============================================================ App shell ============================================================ */

const NAV_ITEMS = [
  ['/', 'home', 'Home', 'home', 'homeFilled'],
  ['/search', 'search', 'Search', 'search', 'searchFilled'],
  ['/library', 'library', 'Your Library', 'library', 'libraryFilled'],
];

function shellHtml() {
  const user = getUser();
  return `
    <nav class="nav">
      <div class="nav-brand">${Icon.logo}<span>Aurelune</span></div>
      ${NAV_ITEMS.map(([href, key, label, out, filled]) => `<a class="nav-item" data-navkey="${key}" href="#${href}">
          <span class="nav-icon-outline">${icon(out)}</span><span class="nav-icon-filled">${icon(filled)}</span><span>${label}</span>
        </a>`).join('')}
      <div class="nav-sep"></div>
      <a class="nav-item" data-navkey="studio" href="#/studio"><span class="nav-icon-outline">${icon('mic')}</span><span>For Creators</span></a>
      ${isAdmin() ? `<a class="nav-item" data-navkey="admin" href="#/admin"><span class="nav-icon-outline">${icon('shield')}</span><span>Admin</span></a>` : ''}
      <div class="nav-sep"></div>
      <div class="nav-section-label">Playlists</div>
      <div class="nav-playlists scrollbar" id="nav-playlists"></div>
    </nav>
    <div class="main-col">
      <div class="topbar">
        <div class="topbar-nav">
          <button class="icon-btn" id="nav-back" aria-label="Back">${icon('chevronLeft')}</button>
          <button class="icon-btn" id="nav-forward" aria-label="Forward">${icon('chevronRight')}</button>
        </div>
        <button class="search-box" id="topbar-search" style="cursor:pointer">${icon('search')}<span style="color:var(--text-faint)">What do you want to play?</span></button>
        <div class="topbar-spacer"></div>
        <a class="icon-btn" href="#/history" aria-label="Listening history" data-navkey="history">${icon('chart')}</a>
        <div style="position:relative">
          <div class="avatar-btn" id="avatar-btn" role="button" tabindex="0"><span class="avatar">${esc((user.display_name || '?')[0]?.toUpperCase())}</span><span class="name">${esc(user.display_name)}</span>${icon('chevronDown')}</div>
        </div>
      </div>
      <div class="content scrollbar" id="content"><div id="view"></div></div>
    </div>
    <div class="player-bar empty" id="player-bar"></div>
    <nav class="mobile-tabbar" id="mobile-tabbar">
      ${NAV_ITEMS.map(([href, key, label, out, filled]) => `<a class="mtab" data-navkey="${key}" href="#${href}">
          <span class="nav-icon-outline">${icon(out)}</span><span class="nav-icon-filled">${icon(filled)}</span><span>${label}</span>
        </a>`).join('')}
      <div style="position:relative; flex:1; display:flex">
        <div class="mtab" id="mobile-more" role="button" tabindex="0" style="width:100%">${icon('more')}<span>More</span></div>
      </div>
    </nav>
    <div class="side-panel" id="lyrics-panel">
      <div class="sp-head"><h3>Lyrics</h3><button class="icon-btn" id="lyrics-close">${icon('x')}</button></div>
      <div class="sp-body scrollbar" id="lyrics-body"></div>
    </div>
    <div class="side-panel" id="queue-panel">
      <div class="sp-head"><h3>Queue</h3><button class="icon-btn" id="queue-close">${icon('x')}</button></div>
      <div class="sp-body scrollbar" id="queue-body"></div>
    </div>
  `;
}

function updateNavActive(key) {
  document.querySelectorAll('[data-navkey]').forEach((el) => el.classList.toggle('active', el.dataset.navkey === key));
}

async function refreshSidebarPlaylists() {
  const el = document.getElementById('nav-playlists');
  if (!el) return;
  try {
    const { playlists } = await api.get('/me/playlists');
    el.innerHTML = playlists.map((p) => `<a class="nav-item" href="#/playlist/${p.id}">${esc(p.title)}</a>`).join('') || '<div class="nav-section-label" style="padding-left:12px">No playlists yet</div>';
  } catch { /* non-fatal */ }
}
bus.addEventListener('playlists-changed', refreshSidebarPlaylists);

/* ============================================================ Router ============================================================ */

function parseHash() {
  let h = location.hash.slice(1) || '/';
  const [path, qs] = h.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

const ROUTES = [
  { re: /^\/$/, key: 'home', view: (root) => Views.home(root) },
  { re: /^\/search$/, key: 'search', view: (root, m, q) => Views.search(root, { q: q.q || '' }) },
  { re: /^\/genre\/([^/]+)$/, view: (root, m) => Views.genre(root, { name: decodeURIComponent(m[1]) }) },
  { re: /^\/artist\/([^/]+)$/, view: (root, m) => Views.artist(root, { id: m[1] }) },
  { re: /^\/album\/([^/]+)$/, view: (root, m) => Views.album(root, { id: m[1] }) },
  { re: /^\/show\/([^/]+)$/, view: (root, m) => Views.show(root, { id: m[1] }) },
  { re: /^\/playlist\/([^/]+)$/, view: (root, m) => Views.playlist(root, { id: m[1] }) },
  { re: /^\/library$/, key: 'library', view: (root) => Views.library(root) },
  { re: /^\/liked$/, key: 'library', view: (root) => Views.liked(root) },
  { re: /^\/history$/, key: 'history', view: (root) => Views.historyView(root) },
  { re: /^\/studio$/, key: 'studio', view: (root) => Views.studio(root) },
  { re: /^\/admin$/, key: 'admin', view: (root) => { if (!isAdmin()) return Views.notfound(root); return Views.admin(root, {}); } },
  { re: /^\/settings(?:\/([^/]+))?$/, key: 'settings', view: (root, m) => Views.settings(root, {}, m[1] || 'account') },
  { re: /^\/developer$/, view: (root) => Views.developer(root) },
];

async function router() {
  const { path, query } = parseHash();
  const match = ROUTES.find((r) => r.re.test(path));
  const root = document.getElementById('view');
  if (!root) return;
  updateNavActive(match?.key || '');
  document.getElementById('content')?.scrollTo(0, 0);
  try {
    if (!match) { Views.notfound(root); return; }
    await match.view(root, path.match(match.re), query);
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p>${esc(err.message || '')}</p></div>`;
  }
}

/* ============================================================ Player bar ============================================================ */

function renderPlayerBar() {
  const bar = document.getElementById('player-bar');
  const item = player.current;
  if (!item) { bar.className = 'player-bar empty'; bar.innerHTML = ''; return; }
  bar.className = 'player-bar';
  const isEp = item.type === 'episode';
  bar.innerHTML = `
    <div class="pnow">
      <div class="pnow-cover"><img src="${item.cover}" alt="">${player.isPlaying ? `<div class="equalizer"><i></i><i></i><i></i></div>` : ''}</div>
      <div class="pnow-text">
        <div class="t">${esc(item.title)}</div>
        <div class="s">${esc(item.artist?.name || item.creator?.name || '')}</div>
      </div>
      <button class="like-btn ${item.liked ? 'on' : ''}" id="bar-like" aria-label="Like" style="${isEp ? 'display:none' : ''}">${icon(item.liked ? 'heartFill' : 'heart')}</button>
      <div class="pnow-mobile-controls">
        <button class="icon-btn" id="p-prev-m" aria-label="Previous" style="background:none">${icon('prev')}</button>
        <button class="play-btn sm white" id="p-toggle-m" aria-label="Play/Pause">${icon(player.isPlaying ? 'pause' : 'play')}</button>
        <button class="icon-btn" id="p-next-m" aria-label="Next" style="background:none">${icon('next')}</button>
      </div>
    </div>
    <div class="pcenter">
      <div class="ptransport">
        <button class="icon-btn ${player.shuffle ? 'on' : ''}" id="p-shuffle" aria-label="Shuffle" style="${isEp ? 'visibility:hidden' : ''}">${icon('shuffle')}</button>
        <button class="icon-btn" id="p-prev" aria-label="Previous">${icon('prev')}</button>
        <button class="play-btn sm white" id="p-toggle" aria-label="Play/Pause">${icon(player.isPlaying ? 'pause' : 'play')}</button>
        <button class="icon-btn" id="p-next" aria-label="Next">${icon('next')}</button>
        <button class="icon-btn ${player.repeat !== 'off' ? 'on' : ''}" id="p-repeat" aria-label="Repeat" style="${isEp ? 'visibility:hidden' : ''}">${icon('repeat')}</button>
      </div>
      <div class="pseek">
        <span class="time" id="p-cur">0:00</span>
        <div class="pbar" id="p-bar"><div class="fill" id="p-fill"></div><div class="knob" id="p-knob"></div></div>
        <span class="time" id="p-dur">${fmtTime((item.duration_ms || 0) / 1000)}</span>
      </div>
    </div>
    <div class="pright">
      <button class="icon-btn ${document.getElementById('lyrics-panel')?.classList.contains('open') ? 'on' : ''}" id="p-lyrics" aria-label="Lyrics" style="${!item.has_lyrics ? 'visibility:hidden' : ''}">${icon('lyrics')}</button>
      <button class="icon-btn" id="p-queue" aria-label="Queue">${icon('queue')}</button>
      <div class="pvol">
        <button class="icon-btn" id="p-mute" aria-label="Mute" style="width:30px;height:30px;background:none">${icon(player.muted || player.volume === 0 ? 'volumeMute' : 'volume')}</button>
        <div class="pbar" id="v-bar"><div class="fill" id="v-fill" style="width:${(player.muted ? 0 : player.volume) * 100}%"></div><div class="knob" id="v-knob" style="left:${(player.muted ? 0 : player.volume) * 100}%"></div></div>
      </div>
    </div>`;

  bar.querySelector('#p-toggle').addEventListener('click', () => player.toggle());
  bar.querySelector('#p-prev').addEventListener('click', () => player.prev());
  bar.querySelector('#p-next').addEventListener('click', () => player.next());
  bar.querySelector('#p-toggle-m').addEventListener('click', () => player.toggle());
  bar.querySelector('#p-prev-m').addEventListener('click', () => player.prev());
  bar.querySelector('#p-next-m').addEventListener('click', () => player.next());
  bar.querySelector('#p-shuffle')?.addEventListener('click', () => player.toggleShuffle());
  bar.querySelector('#p-repeat')?.addEventListener('click', () => player.cycleRepeat());
  bar.querySelector('#bar-like')?.addEventListener('click', async (e) => {
    const on = item.liked; e.currentTarget.disabled = true;
    try { await (on ? api.del(`/me/likes/${item.id}`) : api.put(`/me/likes/${item.id}`)); item.liked = !on; renderPlayerBar(); }
    catch (err) { toast(err.message, { err: true }); }
  });
  wireSeekBar(bar.querySelector('#p-bar'), (f) => player.seekFraction(f));
  wireSeekBar(bar.querySelector('#v-bar'), (f) => player.setVolume(f));
  bar.querySelector('#p-mute').addEventListener('click', () => player.toggleMute());
  bar.querySelector('#p-lyrics').addEventListener('click', () => togglePanel('lyrics'));
  bar.querySelector('#p-queue').addEventListener('click', () => togglePanel('queue'));
  updateSeek();
}

let activeDrag = null; // { el, onSeek } — shared so we only ever need one pair of document listeners
function wireSeekBar(el, onSeek) {
  if (!el) return;
  el.addEventListener('mousedown', (e) => { activeDrag = { el, onSeek }; seekFromClientX(el, onSeek, e.clientX); });
}
function seekFromClientX(el, onSeek, clientX) {
  const r = el.getBoundingClientRect();
  onSeek(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
}
document.addEventListener('mousemove', (e) => activeDrag && seekFromClientX(activeDrag.el, activeDrag.onSeek, e.clientX));
document.addEventListener('mouseup', () => { activeDrag = null; });

function updateSeek() {
  const fill = document.getElementById('p-fill'), knob = document.getElementById('p-knob'), cur = document.getElementById('p-cur');
  if (!fill) return;
  const pct = player.audio.duration ? (player.audio.currentTime / player.audio.duration) * 100 : 0;
  fill.style.width = pct + '%'; knob.style.left = pct + '%';
  cur.textContent = fmtTime(player.audio.currentTime);
  updateLyricsHighlight();
}

let openSidePanel = null;
function togglePanel(which) {
  openSidePanel = openSidePanel === which ? null : which;
  document.getElementById('lyrics-panel').classList.toggle('open', openSidePanel === 'lyrics');
  document.getElementById('queue-panel').classList.toggle('open', openSidePanel === 'queue');
  document.getElementById('p-lyrics')?.classList.toggle('on', openSidePanel === 'lyrics');
  document.getElementById('p-queue')?.classList.toggle('on', openSidePanel === 'queue');
  if (openSidePanel === 'lyrics') renderLyricsPanel();
  if (openSidePanel === 'queue') renderQueuePanel();
}
function renderLyricsPanel() {
  const body = document.getElementById('lyrics-body');
  if (!body) return;
  const l = player.lyrics;
  if (!l) { body.innerHTML = `<p style="color:var(--text-faint);font-size:13.5px">Loading lyrics…</p>`; return; }
  if (!l.plain) { body.innerHTML = `<p style="color:var(--text-faint);font-size:13.5px">No lyrics for this track.</p>`; return; }
  body.innerHTML = l.synced
    ? l.lines.map((line, i) => `<div class="lyrics-line" data-i="${i}">${esc(line.text) || '&nbsp;'}</div>`).join('')
    : `<div class="lyrics-plain">${esc(l.plain)}</div>`;
}
function updateLyricsHighlight() {
  if (openSidePanel !== 'lyrics') return;
  const active = player.activeLyricIndex();
  document.querySelectorAll('.lyrics-line').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === active));
  const activeEl = document.querySelector(`.lyrics-line[data-i="${active}"]`);
  activeEl?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderQueuePanel() {
  const body = document.getElementById('queue-body');
  if (!body) return;
  if (!player.queue.length) { body.innerHTML = `<p style="color:var(--text-faint);font-size:13.5px">Queue is empty.</p>`; return; }
  body.innerHTML = `<div class="queue-list">${player.queue.map((it, i) => `
    <div class="trow ${i === player.index ? 'playing' : ''}" data-qi="${i}">
      <div class="trow-main"><div class="trow-cover"><img src="${it.cover}"></div><div class="trow-text"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.artist?.name || it.creator?.name || '')}</div></div></div>
      <button class="icon-btn" data-remove="${i}" style="width:28px;height:28px;background:none" aria-label="Remove">${icon('x')}</button>
    </div>`).join('')}</div>`;
  body.querySelectorAll('[data-qi]').forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove]')) return;
    player.index = Number(row.dataset.qi); player._load(); renderQueuePanel();
  }));
  body.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); player.removeFromQueue(Number(e.currentTarget.dataset.remove)); }));
}

function updateVolumeUI() {
  const fill = document.getElementById('v-fill'), knob = document.getElementById('v-knob'), muteBtn = document.getElementById('p-mute');
  if (!fill) return;
  const pct = (player.muted ? 0 : player.volume) * 100;
  fill.style.width = pct + '%';
  knob.style.left = pct + '%';
  if (muteBtn) muteBtn.innerHTML = icon(player.muted || player.volume === 0 ? 'volumeMute' : 'volume');
}

player.addEventListener('change', () => { renderPlayerBar(); if (openSidePanel === 'queue') renderQueuePanel(); });
player.addEventListener('time', updateSeek);
player.addEventListener('volume', updateVolumeUI);
player.addEventListener('lyrics', () => { if (openSidePanel === 'lyrics') renderLyricsPanel(); });
player.addEventListener('queue', () => { if (openSidePanel === 'queue') renderQueuePanel(); });

/* ============================================================ Global delegated actions ============================================================ */

function openTrackMenu(item) {
  const hasAlbum = item.album?.id;
  const m = openModal({
    title: esc(item.title),
    body: `<div style="display:flex;flex-direction:column;gap:2px">
      <button class="nav-item" data-act="next" style="width:100%">${icon('next')}<span>Play next</span></button>
      <button class="nav-item" data-act="queue" style="width:100%">${icon('queue')}<span>Add to queue</span></button>
      <button class="nav-item" data-act="playlist" style="width:100%">${icon('plus')}<span>Add to playlist</span></button>
      ${item.artist ? `<a class="nav-item" href="#/artist/${item.artist.slug || item.artist.id}" data-act="close" style="width:100%">${icon('mic')}<span>Go to artist</span></a>` : ''}
      ${hasAlbum ? `<a class="nav-item" href="#/album/${item.album.id}" data-act="close" style="width:100%">${icon('album')}<span>Go to album</span></a>` : ''}
    </div>`,
  });
  m.el.querySelector('[data-act="next"]')?.addEventListener('click', () => { player.playNext(item); toast('Playing next'); m.close(); });
  m.el.querySelector('[data-act="queue"]')?.addEventListener('click', () => { player.addToQueue(item); toast('Added to queue'); m.close(); });
  m.el.querySelector('[data-act="playlist"]')?.addEventListener('click', () => { m.close(); addToPlaylistModal(item); });
  m.el.querySelectorAll('[data-act="close"]').forEach((a) => a.addEventListener('click', () => m.close()));
}

async function toggleLike(id, btn) {
  const on = btn.classList.contains('on');
  btn.disabled = true;
  try {
    await (on ? api.del(`/me/likes/${id}`) : api.put(`/me/likes/${id}`));
    btn.classList.toggle('on'); btn.innerHTML = icon(on ? 'heart' : 'heartFill');
    const item = getItem('track', id); if (item) item.liked = !on;
    if (player.current?.id === id) player.current.liked = !on, renderPlayerBar();
  } catch (err) { toast(err.message, { err: true }); }
  btn.disabled = false;
}

document.addEventListener('click', async (e) => {
  const likeBtn = e.target.closest('[data-like]');
  if (likeBtn) { e.stopPropagation(); return toggleLike(likeBtn.dataset.like, likeBtn); }

  const moreBtn = e.target.closest('[data-more]');
  if (moreBtn) { e.stopPropagation(); const item = getItem('track', moreBtn.dataset.more); if (item) openTrackMenu(item); return; }

  const playCard = e.target.closest('[data-play-card]');
  if (playCard) { e.stopPropagation(); const item = getItem(playCard.dataset.kind || 'track', playCard.dataset.playCard); if (item) player.playQueue([item], 0, { source: 'card' }); return; }

  const playAlbumBtn = e.target.closest('[data-play-album]');
  if (playAlbumBtn) {
    e.stopPropagation(); const id = playAlbumBtn.dataset.playAlbum;
    try { const d = await api.get(`/albums/${id}`); d.tracks.length && player.playQueue(d.tracks, 0, { source: 'album_card' }); } catch (err) { toast(err.message, { err: true }); }
    return;
  }
  const playShowBtn = e.target.closest('[data-play-show]');
  if (playShowBtn) {
    e.stopPropagation(); const id = playShowBtn.dataset.playShow;
    try { const d = await api.get(`/shows/${id}`); d.episodes.length && player.playQueue(d.episodes, 0, { source: 'show_card' }); } catch (err) { toast(err.message, { err: true }); }
    return;
  }

  const playRowBtn = e.target.closest('[data-play-row]');
  const rowEl = e.target.closest('[data-row]');
  if ((playRowBtn || (rowEl && !e.target.closest('.trow-actions') && !e.target.closest('a'))) && rowEl) {
    const type = rowEl.dataset.row;
    const item = getItem(type, rowEl.dataset.id);
    if (item) {
      const list = getActiveList();
      const idx = list.findIndex((x) => x.id === item.id && x.type === item.type);
      player.playQueue(idx >= 0 ? list : [item], idx >= 0 ? idx : 0, { source: rowEl.dataset.ctx || 'list' });
    }
    return;
  }

  const openCard = e.target.closest('.card[data-open]');
  if (openCard && !e.target.closest('button')) { location.hash = `#/${openCard.dataset.open}/${openCard.dataset.id}`; return; }

  if (e.target.closest('#topbar-search')) { location.hash = '#/search'; setTimeout(() => document.getElementById('search-input')?.focus(), 30); }
});

/* ============================================================ Topbar (back/forward + avatar menu) ============================================================ */

let avatarMenuEl = null;
function closeAvatarMenu() { avatarMenuEl?.remove(); avatarMenuEl = null; }
function toggleAvatarMenu(anchor, upward = false) {
  if (avatarMenuEl) return closeAvatarMenu();
  if (!anchor) return;
  avatarMenuEl = document.createElement('div');
  avatarMenuEl.className = 'avatar-menu' + (upward ? ' above' : '');
  avatarMenuEl.innerHTML = `
    <a href="#/settings">Settings</a>
    <a href="#/studio">For Creators</a>
    ${isAdmin() ? '<a href="#/admin">Admin</a>' : ''}
    <div class="sep"></div>
    <button id="menu-logout">Log out</button>`;
  anchor.appendChild(avatarMenuEl);
  avatarMenuEl.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeAvatarMenu));
  avatarMenuEl.querySelector('#menu-logout').addEventListener('click', async () => { await api.post('/auth/logout', {}); location.reload(); });
}
document.addEventListener('click', (e) => { if (avatarMenuEl && !e.target.closest('.avatar-menu') && !e.target.closest('#avatar-btn') && !e.target.closest('#mobile-more')) closeAvatarMenu(); });
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && (e.target.id === 'avatar-btn' || e.target.id === 'mobile-more')) { e.preventDefault(); e.target.click(); }
});

function wireTopbar() {
  document.getElementById('nav-back').addEventListener('click', () => history.back());
  document.getElementById('nav-forward').addEventListener('click', () => history.forward());
  document.getElementById('avatar-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleAvatarMenu(e.currentTarget.parentElement, false); });
  document.getElementById('mobile-more').addEventListener('click', (e) => { e.stopPropagation(); toggleAvatarMenu(e.currentTarget.parentElement, true); });
}

/* ============================================================ Boot ============================================================ */

async function boot() {
  const { user } = await api.get('/session');
  setUser(user);
  if (!user) return renderAuth();

  const app = document.getElementById('app');
  app.classList.remove('no-auth');
  app.innerHTML = shellHtml();
  document.getElementById('lyrics-close').addEventListener('click', () => togglePanel('lyrics'));
  document.getElementById('queue-close').addEventListener('click', () => togglePanel('queue'));
  wireTopbar();
  refreshSidebarPlaylists();
  renderPlayerBar();
  router();
}

window.addEventListener('hashchange', router);
onUserChange(() => { const n = document.querySelector('#avatar-btn .name'); if (n) n.textContent = getUser().display_name; });
boot();
