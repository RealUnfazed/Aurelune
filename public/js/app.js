import { api } from './api.js';
import { player, fmtTime } from './player.js';
import { getUser, setUser, onUserChange, isCreatorApproved, isAdmin, applyScale, getScale, uiScale, uiWidth, uiHeight } from './store.js';
import { toast, openModal, getActiveList, getItem, bus, openContextMenu, closeContextMenu } from './ui.js';
import { icon, Icon } from './icons.js';
import { esc, fmtDuration, artistLink, bylineHtml, bylineText, playlistArt, likedTile, episodesTile, dlButton, refreshDlButtons } from './components.js';
import { downloads, wipeDownloads } from './downloads.js';
import { Views, addToPlaylistModal } from './views.js';
import { initTopSearch } from './topsearch.js';
import { watchMarquee } from './marquee.js';
import './imgfallback.js';
import './shortcuts.js';

// Phones: 100vh is the *tallest* the viewport gets (address bar hidden), so a full-height app overshoots the visible screen
// and its last rows slide under the fixed player bar. Track the real visible height in a CSS variable instead.
applyScale(getScale(), { save: false }); // the interface scale of this device (Settings → Appearance); 100% leaves the page untouched
(() => {
  const set = () => document.documentElement.style.setProperty('--app-h', `${uiHeight()}px`); // CSS px: the scaled interface is shorter than the window
  set();
  window.addEventListener('resize', set);
  window.addEventListener('orientationchange', set);
  window.addEventListener('aur-scale', set);
})();


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
      <div class="nav-brand">${Icon.logo}<span class="brand-text">Aurelune</span><button class="nav-collapse-btn" id="nav-collapse" aria-label="Collapse sidebar">${icon('chevronLeft')}</button></div>
      ${NAV_ITEMS.map(([href, key, label, out, filled]) => `<a class="nav-item" data-navkey="${key}" href="#${href}">
          <span class="nav-icon-outline">${icon(out)}</span><span class="nav-icon-filled">${icon(filled)}</span><span class="nav-label">${label}</span>
        </a>`).join('')}
      <a class="nav-item" data-navkey="downloads" href="#/downloads"><span class="nav-icon-outline">${icon('download')}</span><span class="nav-icon-filled">${icon('download')}</span><span class="nav-label">Downloads</span></a>
      <div class="nav-sep"></div>
      <div class="nav-section-label">Playlists</div>
      <div class="nav-playlists scrollbar" id="nav-playlists"></div>
      <div class="nav-resize-handle" id="nav-resize"></div>
    </nav>
    <div class="main-col">
      <div class="topbar">
        <div class="topbar-nav">
          <button class="icon-btn" id="nav-back" aria-label="Back">${icon('chevronLeft')}</button>
          <button class="icon-btn" id="nav-forward" aria-label="Forward">${icon('chevronRight')}</button>
        </div>
        <form class="search-box" id="topbar-search" role="search" autocomplete="off">
          ${icon('search')}
          <input id="topbar-search-input" type="search" placeholder="What do you want to play?" aria-label="Search" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" role="combobox" aria-expanded="false" aria-controls="ts-panel">
          <button type="button" class="ts-clear" id="ts-clear" aria-label="Clear search" hidden>${icon('x')}</button>
          <div class="ts-panel" id="ts-panel" role="listbox" hidden></div>
        </form>
        <div class="topbar-spacer"></div>
        ${offlineBoot ? '<span class="offline-pill" title="No connection: only your downloads and settings are available">Offline</span>' : ''}
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
    <div class="side-panel" id="now-playing-panel">
      <div class="sp-head">
        <div class="sp-tabs">
          <button class="sp-tab active" data-nptab="playing">Now Playing</button>
          <button class="sp-tab" data-nptab="queue">Queue</button>
        </div>
        <button class="icon-btn" id="np-close">${icon('x')}</button>
      </div>
      <div class="sp-body scrollbar" id="np-body"></div>
    </div>
  `;
}

function updateNavActive(key) {
  document.querySelectorAll('[data-navkey]').forEach((el) => el.classList.toggle('active', el.dataset.navkey === key));
}

let sidebarData = { playlists: [], liked: { count: 0, icon: 'heart', color: 'green' }, likedEpisodes: { count: 0 } };
async function refreshSidebarPlaylists() {
  const el = document.getElementById('nav-playlists');
  if (!el) return;
  try {
    const d = await api.get('/me/playlists');
    sidebarData = { playlists: d.playlists, liked: d.liked || sidebarData.liked, likedEpisodes: d.liked_episodes || sidebarData.likedEpisodes };
    renderSidebarPlaylists();
  } catch { /* non-fatal */ }
}
function renderSidebarPlaylists() {
  const el = document.getElementById('nav-playlists');
  if (!el) return;
  const { playlists, liked } = sidebarData;
  const n = (c) => `${c} song${c === 1 ? '' : 's'}`;
  const likedRow = `<a class="nav-item pl-nav liked-nav" href="#/liked" data-liked="1" title="Liked Songs" aria-label="Liked Songs"><span class="pl-thumb">${likedTile(liked)}</span><span class="pl-nav-text"><b>Liked Songs</b><small>${icon('pinFilled')} Playlist · ${n(liked.count)}</small></span></a>`;
  const epRow = `<a class="nav-item pl-nav liked-nav" href="#/liked-episodes" data-liked-ep="1" title="Liked Episodes" aria-label="Liked Episodes"><span class="pl-thumb">${episodesTile()}</span><span class="pl-nav-text"><b>Liked Episodes</b><small>${icon('pinFilled')} Podcasts · ${sidebarData.likedEpisodes.count} episode${sidebarData.likedEpisodes.count === 1 ? '' : 's'}</small></span></a>`;
  el.innerHTML = likedRow + epRow + playlists.map((p) => `<a class="nav-item pl-nav${p.pinned ? ' pinned' : ''}" href="#/playlist/${p.id}" data-pl="${p.id}" title="${esc(p.title)}" aria-label="${esc(p.title)}"><span class="pl-thumb">${playlistArt(p)}</span><span class="pl-nav-text"><b>${esc(p.title)}</b><small>${p.pinned ? icon('pinFilled') + ' ' : ''}Playlist · ${n(p.track_count)}</small></span><button type="button" class="pl-pin" data-pin="${p.id}" aria-label="${p.pinned ? 'Unpin' : 'Pin'} ${esc(p.title)}" title="${p.pinned ? 'Unpin' : 'Pin to top'}">${icon(p.pinned ? 'pinFilled' : 'pin')}</button></a>`).join('');
}
export async function setPinned(id, pinned) {
  try {
    await (pinned ? api.put(`/playlists/${id}/pin`) : api.del(`/playlists/${id}/pin`));
    toast(pinned ? 'Pinned to the top of your sidebar' : 'Unpinned');
    bus.dispatchEvent(new Event('playlists-changed'));
  } catch (err) { toast(err.message, { err: true }); }
}
// One set of listeners for the whole list (rows are re-rendered often).
(function wireSidebarPlaylists() {
  document.addEventListener('click', (e) => {
    const pin = e.target.closest?.('.nav-playlists [data-pin]');
    if (!pin) return;
    e.preventDefault(); e.stopPropagation();
    const row = sidebarData.playlists.find((p) => p.id === pin.dataset.pin);
    setPinned(pin.dataset.pin, !row?.pinned);
  }, true);
  document.addEventListener('contextmenu', (e) => {
    const row = e.target.closest?.('.nav-playlists .pl-nav');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.likedEp) {
      const m = openContextMenu(e.clientX, e.clientY, `<button class="ctx-item" data-act="open">${icon('podcast')}Open Liked Episodes</button>`);
      m.addEventListener('click', () => { closeContextMenu(); location.hash = '#/liked-episodes'; });
      return;
    }
    if (row.dataset.liked) {
      const m = openContextMenu(e.clientX, e.clientY, `<button class="ctx-item" data-act="open">${icon('queue')}Open Liked Songs</button><button class="ctx-item" data-act="icon">${icon('edit')}Change icon…</button>`);
      m.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-act]')?.dataset.act; if (!act) return; closeContextMenu();
        if (act === 'open') location.hash = '#/liked'; else Views.customizeLiked?.();
      });
      return;
    }
    const p = sidebarData.playlists.find((x) => x.id === row.dataset.pl);
    if (!p) return;
    const m = openContextMenu(e.clientX, e.clientY, `<button class="ctx-item" data-act="open">${icon('queue')}Open playlist</button><button class="ctx-item" data-act="pin">${icon(p.pinned ? 'pinFilled' : 'pin')}${p.pinned ? 'Unpin from top' : 'Pin to top'}</button>`);
    m.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act; if (!act) return; closeContextMenu();
      if (act === 'open') location.hash = `#/playlist/${p.id}`; else setPinned(p.id, !p.pinned);
    });
  });
})();
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
  { re: /^\/liked-episodes$/, key: 'library', view: (root) => Views.likedEpisodes(root) },
  { re: /^\/downloads$/, key: 'downloads', view: (root) => Views.downloadsView(root) },
  { re: /^\/history$/, key: 'history', view: (root) => Views.historyView(root) },
  { re: /^\/studio$/, key: 'studio', view: (root) => Views.studio(root) },
  { re: /^\/admin$/, key: 'admin', view: (root) => { if (!isAdmin()) return Views.notfound(root); return Views.admin(root, {}); } },
  { re: /^\/settings(?:\/([^/]+))?$/, key: 'settings', view: (root, m) => Views.settings(root, {}, m[1] || 'account') },
  { re: /^\/developer$/, view: (root) => Views.developer(root) },
  { re: /^\/lyrics$/, key: 'lyrics', view: (root) => Views.lyricsPage(root) },
];

let viewCleanup = null;
async function router() {
  const { path, query } = parseHash();
  const match = ROUTES.find((r) => r.re.test(path));
  const root = document.getElementById('view');
  if (!root) return;
  // Opened without a connection: only the pages that work from this device are reachable (downloads, settings, the full-screen lyrics).
  if (offlineBoot && !['downloads', 'settings', 'lyrics'].includes(match?.key)) { location.replace('#/downloads'); return; }
  updateNavActive(match?.key || '');
  document.getElementById('content')?.scrollTo(0, 0);
  try {
    viewCleanup?.(); viewCleanup = null;
    if (!match) { Views.notfound(root); return; }
    viewCleanup = (await match.view(root, path.match(match.re), query)) || null;
  } catch (err) {
    console.error(err);
    root.innerHTML = `<div class="empty"><h3>Something went wrong</h3><p>${esc(err.message || '')}</p></div>`;
  }
}

/* ============================================================ Player bar ============================================================ */

/** The title of what is playing, linked to its album (songs) or podcast (episodes) when there is one. On a phone a tap on it opens the full player instead. */
function titleLink(item) {
  const to = item.type === 'episode' ? (item.show?.id && `#/show/${item.show.id}`) : (item.album?.id && `#/album/${item.album.id}`);
  return to ? `<a class="tlink title-link" href="${to}">${esc(item.title)}</a>` : esc(item.title);
}

function renderPlayerBar() {
  const bar = document.getElementById('player-bar');
  const item = player.current;
  if (!item) { bar.className = 'player-bar empty'; bar.innerHTML = ''; if (fpOpen) closeFullPlayer(); return; }
  bar.className = 'player-bar';
  const isEp = item.type === 'episode';
  bar.innerHTML = `
    <div class="pnow">
      <div class="pnow-cover"><img src="${item.cover}" alt=""><div class="equalizer eq-lg ${player.isPlaying ? '' : 'paused'}" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>
      <div class="pnow-text">
        <div class="t mq">${titleLink(item)}</div>
        <div class="s mq">${bylineHtml(item) || '&nbsp;'}</div>
      </div>
      <div class="pnow-acts">
        <button class="like-btn ${item.liked ? 'on' : ''}" id="bar-like" aria-label="${isEp ? 'Save to Liked Episodes' : 'Like'}">${icon(item.liked ? 'heartFill' : 'heart')}</button>
        ${dlButton(item, 'bar-dl')}
      </div>
      <div class="pnow-mobile-controls">
        <button class="icon-btn" id="p-prev-m" aria-label="Previous" style="background:none">${icon('prev')}</button>
        <button class="play-btn sm white" id="p-toggle-m" aria-label="Play/Pause">${icon(player.isPlaying ? 'pause' : 'play')}</button>
        <button class="icon-btn" id="p-next-m" aria-label="Next" style="background:none">${icon('next')}</button>
      </div>
    </div>
    <div class="pbar pmini" id="p-bar-m" aria-hidden="true"><div class="fill" id="p-fill-m"></div></div>
    <div class="pcenter">
      <div class="ptransport ${isEp ? 'ep' : ''}">
        <button class="icon-btn ${player.shuffle ? 'on' : ''}" id="p-shuffle" aria-label="Shuffle" title="Shuffle">${icon('shuffle')}</button>
        <button class="icon-btn" id="p-prev" aria-label="Previous" title="Previous">${icon('prev')}</button>
        ${isEp ? `<button class="icon-btn skip15" id="p-back" aria-label="Back 15 seconds" title="Back 15 seconds">${icon('skipBack')}</button>` : ''}
        <button class="play-btn sm white" id="p-toggle" aria-label="Play/Pause">${icon(player.isPlaying ? 'pause' : 'play')}</button>
        ${isEp ? `<button class="icon-btn skip15" id="p-fwd" aria-label="Forward 15 seconds" title="Forward 15 seconds">${icon('skipFwd')}</button>` : ''}
        <button class="icon-btn" id="p-next" aria-label="Next" title="Next">${icon('next')}</button>
        <button class="icon-btn ${player.repeat !== 'off' ? 'on' : ''}" id="p-repeat" aria-label="Repeat${player.repeat === 'one' ? ' one' : ''}" title="Repeat">${icon(player.repeat === 'one' ? 'repeatOne' : 'repeat')}</button>
      </div>
      <div class="pseek">
        <span class="time" id="p-cur">0:00</span>
        <div class="pbar" id="p-bar" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100"><div class="fill" id="p-fill"></div><div class="knob" id="p-knob"></div></div>
        <span class="time" id="p-dur">${fmtTime((item.duration_ms || 0) / 1000)}</span>
      </div>
    </div>
    <div class="pright">
      <button class="icon-btn ${document.getElementById('now-playing-panel')?.classList.contains('open') && npTab === 'playing' ? 'on' : ''}" id="p-lyrics" aria-label="Now playing">${icon('lyrics')}</button>
      <button class="icon-btn ${document.getElementById('now-playing-panel')?.classList.contains('open') && npTab === 'queue' ? 'on' : ''}" id="p-queue" aria-label="Queue">${icon('queue')}</button>
      <div class="pvol">
        <button class="icon-btn" id="p-mute" aria-label="Mute" style="width:30px;height:30px;background:none">${icon(player.muted || player.volume === 0 ? 'volumeMute' : 'volume')}</button>
        <div class="pbar" id="v-bar" role="slider" tabindex="0" aria-label="Volume" aria-valuemin="0" aria-valuemax="100"><div class="fill" id="v-fill" style="width:${(player.muted ? 0 : player.volume) * 100}%"></div><div class="knob" id="v-knob" style="left:${(player.muted ? 0 : player.volume) * 100}%"></div></div>
      </div>
    </div>`;

  bar.querySelector('#p-toggle').addEventListener('click', () => player.toggle());
  bar.querySelector('#p-prev').addEventListener('click', () => player.prev());
  bar.querySelector('#p-next').addEventListener('click', () => player.next());
  bar.querySelector('#p-toggle-m').addEventListener('click', () => player.toggle());
  bar.querySelector('#p-prev-m').addEventListener('click', () => player.prev());
  bar.querySelector('#p-next-m').addEventListener('click', () => player.next());
  bar.querySelector('#p-back')?.addEventListener('click', () => player.skip(-15));
  bar.querySelector('#p-fwd')?.addEventListener('click', () => player.skip(15));
  bar.querySelector('#p-shuffle')?.addEventListener('click', () => player.toggleShuffle());
  bar.querySelector('#p-repeat')?.addEventListener('click', () => player.cycleRepeat());
  bar.querySelector('#bar-like')?.addEventListener('click', async (e) => {
    const on = item.liked; e.currentTarget.disabled = true;
    try { await (on ? api.del(likePath(item)) : api.put(likePath(item))); item.liked = !on; renderPlayerBar(); bus.dispatchEvent(new Event('playlists-changed')); }
    catch (err) { toast(err.message, { err: true }); }
  });
  watchMarquee(bar.querySelectorAll('.pnow-text .mq'));
  hideSeekTip();
  for (const id of ['#p-bar', '#p-bar-m']) {
    wireSlider(bar.querySelector(id), {
      tip: id === '#p-bar',
      onInput: (f) => { seekDrag = { f }; updateSeek(); },       // live preview while dragging
      onCommit: (f) => { seekDrag = null; player.seekFraction(f); updateSeek(); },
      onCancel: () => { seekDrag = null; updateSeek(); },
      onStep: (dir) => player.seekTo(Math.max(0, player.position + dir * 5)),
    });
  }
  wireSlider(bar.querySelector('#v-bar'), {
    onInput: (f) => player.setVolume(f), onCommit: (f) => player.setVolume(f),
    onStep: (dir) => player.setVolume(player.volume + dir * 0.05),
  });
  bar.querySelector('#p-mute').addEventListener('click', () => player.toggleMute());
  bar.querySelector('#p-lyrics').addEventListener('click', () => toggleNowPlayingPanel('playing'));
  bar.querySelector('#p-queue').addEventListener('click', () => toggleNowPlayingPanel('queue'));
  // Phones: tapping the mini player (anywhere but a button) opens the full-screen player.
  bar.querySelector('.pnow').addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a?.classList.contains('title-link') && isPhone()) { e.preventDefault(); openFullPlayer(); return; } // the song title is the big tap target on a phone
    if (e.target.closest('button, a') || !isPhone()) return;
    openFullPlayer();
  });
  updateSeek();
  if (fpOpen) renderFullPlayer();
}

/**
 * Draggable slider for the progress and volume bars. Pointer events cover mouse, touch and pen, and the
 * move/up listeners live on `document` so the drag keeps working even if the bar is re-rendered mid-drag
 * (the element is looked up again by id on every move).
 */
let seekDrag = null; // { f } while the user is dragging the progress bar; null otherwise
function wireSlider(el, { onInput, onCommit, onCancel, onStep, tip }) {
  if (!el) return;
  const id = el.id;
  let dragging = false;
  const frac = (clientX) => {
    const r = (document.getElementById(id) || el).getBoundingClientRect();
    return r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  // Hover time box: follows the mouse along the bar and shows where a click would land.
  if (tip) {
    el.addEventListener('pointermove', (e) => { if (!dragging && e.pointerType === 'mouse') showSeekTip(document.getElementById(id) || el, e.clientX, frac(e.clientX)); });
    el.addEventListener('pointerleave', () => { if (!dragging) hideSeekTip(); });
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    dragging = true;
    (document.getElementById(id) || el).classList.add('dragging');
    let last = frac(e.clientX);
    onInput(last);
    if (tip) showSeekTip(document.getElementById(id) || el, e.clientX, last);
    const move = (ev) => { last = frac(ev.clientX); onInput(last); if (tip) showSeekTip(document.getElementById(id) || el, ev.clientX, last); };
    const end = (ev, cancelled) => {
      dragging = false;
      if (tip) hideSeekTip();
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.getElementById(id)?.classList.remove('dragging');
      if (cancelled) onCancel?.(); else onCommit(frac(ev.clientX));
    };
    const up = (ev) => end(ev, false);
    const cancel = (ev) => end(ev, true);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
  });
  el.addEventListener('keydown', (e) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (dir && onStep) { e.preventDefault(); onStep(dir); }
  });
}

/* The "time under the pointer" box shown above a progress bar (hover on desktop, while dragging on touch). */
let seekTipEl = null;
function showSeekTip(bar, clientX, f) {
  const dur = player.durationSec;
  if (!bar?.isConnected || !dur) return hideSeekTip();
  if (!seekTipEl) {
    seekTipEl = document.createElement('div');
    seekTipEl.className = 'seek-tip'; seekTipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(seekTipEl);
  }
  seekTipEl.textContent = fmtTime(f * dur);
  seekTipEl.classList.add('show');
  const z = uiScale(), r = bar.getBoundingClientRect(); // pointer + rect are real pixels, the tip is placed in CSS pixels
  const half = seekTipEl.offsetWidth / 2 + 6;
  const x = Math.min(uiWidth() - half, Math.max(half, clientX / z));
  seekTipEl.style.left = x + 'px';
  seekTipEl.style.top = (r.top / z - 10) + 'px';
}
function hideSeekTip() { seekTipEl?.classList.remove('show'); }

function updateSeek() {
  updateFullSeek();
  const fill = document.getElementById('p-fill'), knob = document.getElementById('p-knob'), cur = document.getElementById('p-cur');
  if (!fill) return;
  const dur = player.durationSec;
  const t = seekDrag ? seekDrag.f * dur : player.position;
  const pct = dur ? Math.min(100, Math.max(0, (t / dur) * 100)) : 0;
  fill.style.width = pct + '%'; knob.style.left = pct + '%';
  const mini = document.getElementById('p-fill-m'); if (mini) mini.style.width = pct + '%';
  cur.textContent = fmtTime(t);
  document.getElementById('p-bar')?.setAttribute('aria-valuenow', String(Math.round(pct)));
  document.getElementById('p-dur') && (document.getElementById('p-dur').textContent = fmtTime(dur));
  if (!seekDrag) updateLyricsHighlight();
}

/* ============================================================ Full-screen player (phones) ============================================================
   The mini bar on a phone only has room for previous / play / next. Tapping it opens this sheet, which has everything the desktop
   bar has (shuffle, repeat, like, seek with times) plus shortcuts to lyrics, the queue and sound settings. Podcast episodes also get
   back-15 / forward-15. Swipe down or tap the chevron to close. */
let fpOpen = false;
// "Phone layout" follows the scaled interface: at 150% a 1000 px window is a 666 px-wide interface, like browser zoom.
function isPhone() { return uiWidth() <= 720; }

function openFullPlayer() {
  if (!player.current || !isPhone()) return;
  fpOpen = true;
  let el = document.getElementById('full-player');
  if (!el) {
    el = document.createElement('div');
    el.id = 'full-player'; el.className = 'full-player';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Now playing');
    document.body.appendChild(el);
    wireFullPlayerSwipe(el);
  }
  renderFullPlayer();
  document.body.classList.add('fp-open');
}
function closeFullPlayer() {
  fpOpen = false;
  document.getElementById('full-player')?.remove();
  document.body.classList.remove('fp-open');
  hideSeekTip();
}

function renderFullPlayer() {
  const el = document.getElementById('full-player');
  if (!el) return;
  const item = player.current;
  if (!item || !isPhone()) return closeFullPlayer();
  const isEp = item.type === 'episode';
  const open = (tab) => { closeFullPlayer(); if (!npOpen || npTab !== tab) toggleNowPlayingPanel(tab); };
  el.innerHTML = `
    <img class="fp-bg" src="${item.cover}" alt="">
    <div class="fp-top">
      <button class="icon-btn fp-close" id="fp-close" aria-label="Close player">${icon('chevronDown')}</button>
      <div class="fp-label">${isEp ? 'Playing episode' : 'Now playing'}</div>
      <span class="fp-top-spacer"></span>
    </div>
    <div class="fp-art"><img src="${item.cover}" alt=""></div>
    <div class="fp-meta">
      <div class="fp-meta-text"><div class="fp-title mq">${esc(item.title)}</div><div class="fp-by mq">${bylineHtml(item)}</div></div>
      <button class="like-btn ${item.liked ? 'on' : ''}" id="fp-like" aria-label="${isEp ? 'Save to Liked Episodes' : 'Like'}">${icon(item.liked ? 'heartFill' : 'heart')}</button>
      ${dlButton(item, 'fp-dl')}
    </div>
    <div class="fp-seek">
      <div class="pbar fp-bar" id="fp-bar" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100"><div class="fill" id="fp-fill"></div><div class="knob" id="fp-knob"></div></div>
      <div class="fp-times"><span id="fp-cur">0:00</span><span id="fp-dur">${fmtTime(player.durationSec)}</span></div>
    </div>
    <div class="fp-transport">
      <button class="icon-btn fp-side ${player.shuffle ? 'on' : ''}" id="fp-shuffle" aria-label="Shuffle">${icon('shuffle')}</button>
      <button class="icon-btn fp-skip" id="fp-prev" aria-label="Previous">${icon('prev')}</button>
      <button class="play-btn fp-play" id="fp-toggle" aria-label="Play/Pause">${icon(player.isPlaying ? 'pause' : 'play')}</button>
      <button class="icon-btn fp-skip" id="fp-next" aria-label="Next">${icon('next')}</button>
      <button class="icon-btn fp-side ${player.repeat !== 'off' ? 'on' : ''}" id="fp-repeat" aria-label="Repeat${player.repeat === 'one' ? ' one' : ''}">${icon(player.repeat === 'one' ? 'repeatOne' : 'repeat')}</button>
    </div>
    ${isEp ? `<div class="fp-skiprow"><button class="fp-jump" id="fp-back" aria-label="Back 15 seconds">${icon('skipBack')}<span>15 s back</span></button><button class="fp-jump" id="fp-fwd" aria-label="Forward 15 seconds">${icon('skipFwd')}<span>15 s forward</span></button></div>` : ''}
    <div class="fp-extras">
      ${!isEp ? `<button class="fp-extra" id="fp-lyrics">${icon('lyrics')}<span>Lyrics</span></button>` : `<button class="fp-extra" id="fp-lyrics">${icon('lyrics')}<span>Details</span></button>`}
      <button class="fp-extra" id="fp-sound">${icon('chart')}<span>Sound</span></button>
      <button class="fp-extra" id="fp-queue">${icon('queue')}<span>Queue</span></button>
    </div>`;
  const $ = (s) => el.querySelector(s);
  $('#fp-close').addEventListener('click', closeFullPlayer);
  $('#fp-toggle').addEventListener('click', () => player.toggle());
  $('#fp-prev').addEventListener('click', () => player.prev());
  $('#fp-next').addEventListener('click', () => player.next());
  $('#fp-shuffle')?.addEventListener('click', () => player.toggleShuffle());
  $('#fp-repeat')?.addEventListener('click', () => player.cycleRepeat());
  $('#fp-back')?.addEventListener('click', () => player.skip(-15));
  $('#fp-fwd')?.addEventListener('click', () => player.skip(15));
  $('#fp-like').addEventListener('click', async (e) => {
    const btn = e.currentTarget, on = item.liked; btn.disabled = true;
    try { await (on ? api.del(likePath(item)) : api.put(likePath(item))); item.liked = !on; renderPlayerBar(); bus.dispatchEvent(new Event('playlists-changed')); }
    catch (err) { btn.disabled = false; toast(err.message, { err: true }); }
  });
  $('#fp-lyrics').addEventListener('click', () => open('playing'));
  $('#fp-queue').addEventListener('click', () => open('queue'));
  $('#fp-sound').addEventListener('click', () => { closeFullPlayer(); location.hash = '#/settings/sound'; });
  el.querySelectorAll('.fp-by a').forEach((a) => a.addEventListener('click', closeFullPlayer));
  wireSlider($('#fp-bar'), {
    tip: true,
    onInput: (f) => { seekDrag = { f }; updateSeek(); },
    onCommit: (f) => { seekDrag = null; player.seekFraction(f); updateSeek(); },
    onCancel: () => { seekDrag = null; updateSeek(); },
    onStep: (dir) => player.seekTo(Math.max(0, player.position + dir * 5)),
  });
  watchMarquee(el.querySelectorAll('.fp-meta-text .mq'));
  updateFullSeek();
}

function updateFullSeek() {
  const fill = document.getElementById('fp-fill');
  if (!fill) return;
  const dur = player.durationSec;
  const t = seekDrag ? seekDrag.f * dur : player.position;
  const pct = dur ? Math.min(100, Math.max(0, (t / dur) * 100)) : 0;
  fill.style.width = pct + '%';
  document.getElementById('fp-knob').style.left = pct + '%';
  document.getElementById('fp-cur').textContent = fmtTime(t);
  document.getElementById('fp-dur').textContent = fmtTime(dur);
  document.getElementById('fp-bar')?.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function wireFullPlayerSwipe(el) {
  let y0 = null, x0 = 0, dy = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.pbar, button, a')) { y0 = null; return; }
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0;
    el.classList.add('swiping');
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0 && dy > Math.abs(e.touches[0].clientX - x0)) el.style.transform = `translateY(${dy / uiScale()}px)`;
  }, { passive: true });
  const end = () => {
    el.classList.remove('swiping');
    const far = y0 != null && dy > 110;
    y0 = null; el.style.transform = '';
    if (far) closeFullPlayer();
  };
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
}
{ let was = isPhone(); const chk = () => { const now = isPhone(); if (was && !now) closeFullPlayer(); was = now; }; window.addEventListener('resize', chk); window.addEventListener('aur-scale', chk); }
window.addEventListener('hashchange', () => { if (fpOpen) closeFullPlayer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && fpOpen) closeFullPlayer(); });

let npOpen = false;
let npTab = 'playing';

function toggleNowPlayingPanel(tab) {
  const panel = document.getElementById('now-playing-panel');
  if (npOpen && npTab === tab) { npOpen = false; }
  else { npOpen = true; npTab = tab; }
  panel.classList.toggle('open', npOpen);
  document.getElementById('app')?.classList.toggle('np-open', npOpen); // on wide screens the panel is a column and pushes the page aside
  panel.querySelectorAll('.sp-tab').forEach((t) => t.classList.toggle('active', t.dataset.nptab === npTab));
  document.getElementById('p-lyrics')?.classList.toggle('on', npOpen && npTab === 'playing');
  document.getElementById('p-queue')?.classList.toggle('on', npOpen && npTab === 'queue');
  if (npOpen) renderNowPlayingBody();
}

function renderNowPlayingBody() {
  const body = document.getElementById('np-body');
  if (!body) return;
  npTab === 'queue' ? renderQueueTab(body) : renderPlayingTab(body);
}

function lyricsPreviewHtml() {
  const l = player.lyrics;
  if (player.lyricsState === 'error') return `<p class="np-dim">Couldn't load lyrics. <button class="link-more" id="np-lyrics-retry" style="background:none;border:none;cursor:pointer">Try again</button></p>`;
  if (player.lyricsState === 'loading' || !l) return `<p class="np-dim">Loading lyrics…</p>`;
  if (!l.plain) return `<p class="np-dim">No lyrics for this one.</p>`;
  if (!l.synced) return `<div class="lyrics-plain">${esc(l.plain.split('\n').slice(0, 6).join('\n'))}</div>`;
  const idx = Math.max(0, player.activeLyricIndex());
  const first = Math.max(0, idx - 1);
  return l.lines.slice(first, idx + 4).map((line, i) => `<div class="lyrics-line ${first + i === idx ? 'active' : ''}" data-lyric="${first + i}">${esc(line.text) || '&nbsp;'}</div>`).join('');
}

function renderPlayingTab(body) {
  const item = player.current;
  if (!item) { body.innerHTML = `<div class="empty" style="padding:40px 10px"><div class="icon">${icon('disc')}</div><h3>Nothing playing</h3></div>`; return; }
  const isEp = item.type === 'episode';
  body.innerHTML = `
    <div class="np-cover"><img src="${item.cover}" alt=""></div>
    <div class="np-title">${esc(item.title)}</div>
    <div class="np-artist">${bylineHtml(item)}</div>
    ${item.credits ? `<div class="np-credits">${esc(item.credits)}</div>` : ''}
    ${!isEp ? `
      <div class="np-section-head"><span>Lyrics</span><a href="#/lyrics" id="np-expand-lyrics">Expand</a></div>
      <div class="np-lyrics-preview">${lyricsPreviewHtml()}</div>
    ` : ''}
    ${player.queue.length > player.index + 1 ? `
      <div class="np-section-head"><span>Next in queue</span><button class="link-more" id="np-see-queue" style="background:none;border:none;cursor:pointer">See all</button></div>
      <div class="row-list">${player.queue.slice(player.index + 1, player.index + 4).map((it) => `
        <div class="trow-main" style="padding:6px 4px"><div class="trow-cover"><img src="${it.cover}"></div><div class="trow-text"><div class="t">${esc(it.title)}</div><div class="s">${esc(bylineText(it))}</div></div></div>
      `).join('')}</div>
    ` : ''}
  `;
  body.querySelector('#np-see-queue')?.addEventListener('click', () => toggleNowPlayingPanel('queue'));
}

function renderQueueTab(body) {
  if (!player.queue.length) { body.innerHTML = `<p class="np-dim">Queue is empty.</p>`; return; }
  body.innerHTML = `<div class="queue-list">${player.queue.map((it, i) => `
    <div class="trow ${i === player.index ? 'playing' : ''}" data-qi="${i}">
      <div class="trow-main"><div class="trow-cover"><img src="${it.cover}"></div><div class="trow-text"><div class="t">${esc(it.title)}</div><div class="s">${esc(bylineText(it))}</div></div></div>
      <button class="icon-btn" data-remove="${i}" style="width:28px;height:28px;background:none" aria-label="Remove">${icon('x')}</button>
    </div>`).join('')}</div>`;
  body.querySelectorAll('[data-qi]').forEach((row) => row.addEventListener('click', (e) => {
    if (e.target.closest('[data-remove]')) return;
    player.index = Number(row.dataset.qi); player._load(); renderQueueTab(body);
  }));
  body.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); player.removeFromQueue(Number(e.currentTarget.dataset.remove)); }));
}

function updateLyricsHighlight() {
  if (!npOpen || npTab !== 'playing') return;
  const preview = document.querySelector('.np-lyrics-preview');
  if (preview) preview.innerHTML = lyricsPreviewHtml();
}

function updateVolumeUI() {
  const fill = document.getElementById('v-fill'), knob = document.getElementById('v-knob'), muteBtn = document.getElementById('p-mute');
  if (!fill) return;
  const pct = (player.muted ? 0 : player.volume) * 100;
  fill.style.width = pct + '%';
  knob.style.left = pct + '%';
  if (muteBtn) muteBtn.innerHTML = icon(player.muted || player.volume === 0 ? 'volumeMute' : 'volume');
}

function updateAmbient() {
  const bar = document.getElementById('ambient-bar');
  if (!bar) return;
  const item = player.current;
  if (item?.color) document.documentElement.style.setProperty('--ambient', item.color);
  bar.classList.toggle('on', !!item && player.isPlaying);
}

player.addEventListener('change', () => { renderPlayerBar(); if (npOpen) renderNowPlayingBody(); updateAmbient(); });
player.addEventListener('time', updateSeek);
player.addEventListener('volume', updateVolumeUI);
player.addEventListener('lyrics', () => { if (npOpen && npTab === 'playing') renderPlayingTab(document.getElementById('np-body')); });
player.addEventListener('queue', () => { if (npOpen) renderNowPlayingBody(); });
// The lyrics preview is re-rendered as the song plays, so its clicks are handled from the document.
document.addEventListener('click', (e) => {
  if (e.target.closest('#np-lyrics-retry')) { player.retryLyrics(); return; }
  const line = e.target.closest('.np-lyrics-preview [data-lyric]');
  if (line) player.seekToLyric(Number(line.dataset.lyric));
});

/* ============================================================ Global delegated actions ============================================================ */

const REPORT_REASONS = [
  ['wrong_metadata', 'Wrong title, artist, or artwork'],
  ['copyright', 'Copyright concern'],
  ['inappropriate', 'Inappropriate content'],
  ['spam', 'Spam or misleading'],
  ['other', 'Something else'],
];

function openReportModal(kind, id, label) {
  closeContextMenu();
  const m = openModal({
    title: `Report "${esc(label)}"`,
    body: `
      <div class="field"><label>Reason</label><select id="rp-reason">${REPORT_REASONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select></div>
      <div class="field"><label>Anything else? (optional)</label><textarea id="rp-note" placeholder="A few details help us look into it faster."></textarea></div>`,
    footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="rp-send">Submit report</button>`,
  });
  m.el.querySelector('#rp-send').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // capture now: currentTarget is null after any await
    btn.disabled = true;
    try {
      await api.post('/reports', { kind, item_id: id, reason: m.el.querySelector('#rp-reason').value, note: m.el.querySelector('#rp-note').value });
      toast('Thanks — our team will take a look.');
      m.close();
    } catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
  });
}

function shareUrl(item) {
  if (item.type === 'track') return item.album ? `${location.origin}/#/album/${item.album.id}` : `${location.origin}/#/artist/${item.artist?.slug || item.artist?.id || ''}`;
  if (item.type === 'episode') return `${location.origin}/#/show/${item.show?.id || ''}`;
  if (item.type === 'artist') return `${location.origin}/#/artist/${item.slug || item.id}`;
  if (item.type === 'album') return `${location.origin}/#/album/${item.id}`;
  if (item.type === 'show') return `${location.origin}/#/show/${item.id}`;
  if (item.type === 'playlist') return `${location.origin}/#/playlist/${item.id}`;
  return location.origin;
}
async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast('Could not copy — your browser blocked clipboard access', { err: true }); }
}

function ctxItem(action, iconName, label, extraCls = '') {
  return `<button class="ctx-item ${extraCls}" data-ctx="${action}">${icon(iconName)}<span>${label}</span></button>`;
}
function ctxLink(href, iconName, label) {
  return `<a class="ctx-item" href="${href}">${icon(iconName)}<span>${label}</span></a>`;
}

const dlState = (item) => (item.type === 'track' || item.type === 'episode' ? downloads.status(item) : 'blocked');
const DL_MENU = { none: 'Download', downloading: 'Cancel download', done: 'Remove download', locked: 'Remove download' };

/** The download button everywhere: start, cancel while it runs, remove when it is done. */
async function toggleDownload(key, known) {
  const [type, id] = key.split(':');
  const cur = player.current;
  const item = known || (cur && cur.type === type && String(cur.id) === id ? cur : null) || getItem(type, id)
    || player.queue.find((x) => x.type === type && String(x.id) === id) || downloads.index.get(key)?.item;
  if (!item) return;
  const st = downloads.status(item);
  if (st === 'downloading') { downloads.cancel(item); toast('Download cancelled'); return; }
  if (st === 'done' || st === 'locked') { await downloads.remove(item); toast('Removed from downloads'); return; }
  try {
    await downloads.download(item);
    toast(`“${item.title}” is ready to play offline`);
  } catch (err) { if (err.code !== 'cancelled') toast(err.message, { err: true }); }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-dl]');
  if (!b) return;
  e.stopPropagation(); e.preventDefault();
  toggleDownload(b.dataset.dl);
}, true);
downloads.addEventListener('change', () => refreshDlButtons());
player.addEventListener('notice', (e) => toast(e.detail.message, { err: !!e.detail.err }));

function openTrackMenu(item, x, y) {
  const hasAlbum = !!item.album?.id;
  const embeddable = item.type === 'track' || item.type === 'episode';
  const html = `
    ${ctxItem('play', 'play', 'Play')}
    ${ctxItem('next', 'next', 'Play next')}
    ${ctxItem('queue', 'queue', 'Add to queue')}
    ${item.type === 'track' ? ctxItem('playlist', 'plus', 'Add to playlist') : ''}
    ${dlState(item) === 'blocked' || !downloads.supported ? '' : ctxItem('download', dlState(item) === 'done' || dlState(item) === 'locked' ? 'downloadDone' : 'download', DL_MENU[dlState(item)])}
    ${item.type === 'episode' ? ctxItem('likeep', item.liked ? 'heartFill' : 'heart', item.liked ? 'Remove from Liked Episodes' : 'Save to Liked Episodes') : ''}
    <div class="ctx-sep"></div>
    ${item.artist ? ctxLink(`#/artist/${item.artist.slug || item.artist.id}`, 'mic', 'Go to artist') : ''}
    ${hasAlbum ? ctxLink(`#/album/${item.album.id}`, 'album', 'Go to album') : ''}
    ${item.show ? ctxLink(`#/show/${item.show.id}`, 'podcast', 'Go to show') : ''}
    <div class="ctx-sep"></div>
    ${ctxItem('share', 'globe', 'Share link')}
    ${embeddable ? ctxItem('embed', 'chevronDown', 'Share embed code') : ''}
    ${item.type === 'track' ? `<div class="ctx-sep"></div>${ctxItem('exclude', 'x', 'Exclude from your taste')}` : ''}
    <div class="ctx-sep"></div>
    ${ctxItem('report', 'shield', 'Report', 'danger')}
  `;
  const el = openContextMenu(x, y, html);
  el.querySelector('[data-ctx="play"]').addEventListener('click', () => { closeContextMenu(); player.playQueue([item], 0, { source: 'context_menu' }); });
  el.querySelector('[data-ctx="next"]').addEventListener('click', () => { closeContextMenu(); player.playNext(item); toast('Playing next'); });
  el.querySelector('[data-ctx="queue"]').addEventListener('click', () => { closeContextMenu(); player.addToQueue(item); toast('Added to queue'); });
  el.querySelector('[data-ctx="playlist"]')?.addEventListener('click', () => { closeContextMenu(); addToPlaylistModal(item); });
  el.querySelector('[data-ctx="share"]').addEventListener('click', () => copyText(shareUrl(item), 'Link copied'));
  el.querySelector('[data-ctx="download"]')?.addEventListener('click', () => { closeContextMenu(); toggleDownload(`${item.type}:${item.id}`, item); });
  el.querySelector('[data-ctx="likeep"]')?.addEventListener('click', async () => {
    closeContextMenu();
    try {
      await (item.liked ? api.del(`/me/likes/episodes/${item.id}`) : api.put(`/me/likes/episodes/${item.id}`));
      item.liked = !item.liked; toast(item.liked ? 'Saved to Liked Episodes' : 'Removed from Liked Episodes');
      document.querySelectorAll(`[data-like-ep="${item.id}"]`).forEach((b) => { b.classList.toggle('on', item.liked); b.innerHTML = icon(item.liked ? 'heartFill' : 'heart'); });
      if (player.current?.id === item.id) player.current.liked = item.liked, renderPlayerBar();
      bus.dispatchEvent(new Event('playlists-changed'));
    } catch (err) { toast(err.message, { err: true }); }
  });
  el.querySelector('[data-ctx="embed"]')?.addEventListener('click', () => {
    const src = `${location.origin}/embed/${item.type}/${item.id}`;
    copyText(`<iframe src="${src}" width="100%" height="80" frameborder="0" allow="autoplay"></iframe>`, 'Embed code copied');
  });
  el.querySelector('[data-ctx="exclude"]')?.addEventListener('click', async () => {
    closeContextMenu();
    try { await api.put(`/me/excluded/${item.id}`); toast("Won't recommend this again"); } catch (err) { toast(err.message, { err: true }); }
  });
  el.querySelector('[data-ctx="report"]').addEventListener('click', () => openReportModal(item.type, item.id, item.title));
}

/** A lighter menu for artist/album/show/playlist cards: play (if applicable), open, share, report. */
function openItemMenu(item, x, y) {
  const canPlay = ['album', 'show', 'playlist'].includes(item.type);
  const openHref = `#/${item.type === 'artist' ? 'artist' : item.type}/${item.slug || item.id}`;
  const html = `
    ${canPlay ? ctxItem('play', 'play', 'Play') : ''}
    ${ctxLink(openHref, item.type === 'artist' ? 'mic' : item.type === 'album' ? 'album' : item.type === 'show' ? 'podcast' : 'queue', 'Open')}
    <div class="ctx-sep"></div>
    ${ctxItem('share', 'globe', 'Share link')}
    <div class="ctx-sep"></div>
    ${ctxItem('report', 'shield', 'Report', 'danger')}
  `;
  const el = openContextMenu(x, y, html);
  el.querySelector('[data-ctx="play"]')?.addEventListener('click', async () => {
    closeContextMenu();
    try {
      if (item.type === 'album') { const d = await api.get(`/albums/${item.id}`); d.tracks.length && player.playQueue(d.tracks, 0, { source: 'context_menu' }); }
      else if (item.type === 'show') { const d = await api.get(`/shows/${item.id}`); d.episodes.length && player.playQueue(d.episodes, 0, { source: 'context_menu' }); }
      else if (item.type === 'playlist') { const d = await api.get(`/playlists/${item.id}`); d.tracks.length && player.playQueue(d.tracks, 0, { source: 'context_menu' }); }
    } catch (err) { toast(err.message, { err: true }); }
  });
  el.querySelector('[data-ctx="share"]').addEventListener('click', () => copyText(shareUrl(item), 'Link copied'));
  el.querySelector('[data-ctx="report"]').addEventListener('click', () => openReportModal(item.type, item.id, item.title || item.name));
}

// Songs go to Liked Songs, podcast episodes to Liked Episodes.
const likePath = (item) => (item.type === 'episode' ? `/me/likes/episodes/${item.id}` : `/me/likes/${item.id}`);

async function toggleLikeEpisode(id, btn) {
  const on = btn.classList.contains('on');
  btn.disabled = true;
  try {
    await (on ? api.del(`/me/likes/episodes/${id}`) : api.put(`/me/likes/episodes/${id}`));
    btn.classList.toggle('on'); btn.innerHTML = icon(on ? 'heart' : 'heartFill');
    btn.title = btn.ariaLabel = on ? 'Save to Liked Episodes' : 'Remove from Liked Episodes';
    const item = getItem('episode', id); if (item) item.liked = !on;
    if (player.current?.id === id) player.current.liked = !on, renderPlayerBar();
    toast(on ? 'Removed from Liked Episodes' : 'Saved to Liked Episodes');
    bus.dispatchEvent(new Event('playlists-changed'));
  } catch (err) { toast(err.message, { err: true }); }
  btn.disabled = false;
}

async function toggleLike(id, btn) {
  const on = btn.classList.contains('on');
  btn.disabled = true;
  try {
    await (on ? api.del(`/me/likes/${id}`) : api.put(`/me/likes/${id}`));
    btn.classList.toggle('on'); btn.innerHTML = icon(on ? 'heart' : 'heartFill');
    const item = getItem('track', id); if (item) item.liked = !on;
    if (player.current?.id === id) player.current.liked = !on, renderPlayerBar();
    bus.dispatchEvent(new Event('playlists-changed'));
  } catch (err) { toast(err.message, { err: true }); }
  btn.disabled = false;
}

document.addEventListener('contextmenu', (e) => {
  const rowEl = e.target.closest('[data-row]');
  if (rowEl) {
    const item = getItem(rowEl.dataset.row, rowEl.dataset.id);
    if (item) { e.preventDefault(); openTrackMenu(item, e.clientX, e.clientY); }
    return;
  }
  const playCard = e.target.closest('[data-play-card]');
  if (playCard) {
    const item = getItem(playCard.dataset.kind || 'track', playCard.dataset.playCard);
    if (item) { e.preventDefault(); openTrackMenu(item, e.clientX, e.clientY); }
    return;
  }
  const openCard = e.target.closest('.card[data-open]');
  if (openCard) {
    const item = getItem(openCard.dataset.open, openCard.dataset.id);
    if (item) { e.preventDefault(); openItemMenu(item, e.clientX, e.clientY); }
  }
});

document.addEventListener('click', async (e) => {
  const likeEp = e.target.closest('[data-like-ep]');
  if (likeEp) { e.stopPropagation(); return toggleLikeEpisode(likeEp.dataset.likeEp, likeEp); }
  const likeBtn = e.target.closest('[data-like]');
  if (likeBtn) { e.stopPropagation(); return toggleLike(likeBtn.dataset.like, likeBtn); }

  const moreBtn = e.target.closest('[data-more]');
  if (moreBtn) {
    e.stopPropagation();
    const item = getItem('track', moreBtn.dataset.more);
    if (item) { const r = moreBtn.getBoundingClientRect(); openTrackMenu(item, r.left, r.bottom + 4); }
    return;
  }

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
    <a href="#/downloads">Downloads</a>
    <a href="#/settings/storage">Storage &amp; downloads</a>
    <a href="#/studio">For Creators</a>
    ${isAdmin() ? '<a href="#/admin">Admin</a>' : ''}
    <div class="sep"></div>
    <button id="menu-logout">Log out</button>`;
  anchor.appendChild(avatarMenuEl);
  avatarMenuEl.querySelectorAll('a').forEach((a) => a.addEventListener('click', closeAvatarMenu));
  avatarMenuEl.querySelector('#menu-logout').addEventListener('click', async () => { await wipeDownloads(); try { await api.post('/auth/logout', {}); } catch { /* offline */ } try { localStorage.removeItem('aur_user'); } catch { /* none */ } location.reload(); });
}
document.addEventListener('click', (e) => { if (avatarMenuEl && !e.target.closest('.avatar-menu') && !e.target.closest('#avatar-btn') && !e.target.closest('#mobile-more')) closeAvatarMenu(); });
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && (e.target.id === 'avatar-btn' || e.target.id === 'mobile-more')) { e.preventDefault(); e.target.click(); }
});

/* ============================================================ Sidebar collapse + resize ============================================================ */

const NAV_MIN = 180, NAV_MAX = 360, NAV_COLLAPSED_W = 84, NAV_DEFAULT_W = 232;

function wireSidebar() {
  const nav = document.querySelector('.nav');
  const collapsed = localStorage.getItem('aur_nav_collapsed') === '1';
  const savedW = parseInt(localStorage.getItem('aur_nav_w'), 10);
  const validSavedW = savedW >= NAV_MIN && savedW <= NAV_MAX ? savedW : NAV_DEFAULT_W;
  if (collapsed) { nav.classList.add('collapsed'); document.documentElement.style.setProperty('--nav-w', NAV_COLLAPSED_W + 'px'); }
  else document.documentElement.style.setProperty('--nav-w', validSavedW + 'px');

  document.getElementById('nav-collapse').addEventListener('click', () => {
    const isCollapsed = nav.classList.toggle('collapsed');
    localStorage.setItem('aur_nav_collapsed', isCollapsed ? '1' : '0');
    const w = isCollapsed ? NAV_COLLAPSED_W : (parseInt(localStorage.getItem('aur_nav_w'), 10) || NAV_DEFAULT_W);
    document.documentElement.style.setProperty('--nav-w', w + 'px');
  });

  const handle = document.getElementById('nav-resize');
  let dragging = false;
  handle.addEventListener('mousedown', (e) => {
    if (nav.classList.contains('collapsed')) return;
    dragging = true; handle.classList.add('dragging'); e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(NAV_MAX, Math.max(NAV_MIN, (e.clientX - nav.getBoundingClientRect().left) / uiScale()));
    document.documentElement.style.setProperty('--nav-w', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    localStorage.setItem('aur_nav_w', parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-w'), 10));
  });
}

function wireTopbar() {
  document.getElementById('nav-back').addEventListener('click', () => history.back());
  document.getElementById('nav-forward').addEventListener('click', () => history.forward());
  document.getElementById('avatar-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleAvatarMenu(e.currentTarget.parentElement, false); });
  document.getElementById('mobile-more').addEventListener('click', (e) => { e.stopPropagation(); toggleAvatarMenu(e.currentTarget.parentElement, true); });
}

/* ============================================================ Boot ============================================================ */

let offlineBoot = false;
/** The last signed-in user, kept so the app can open with no connection (downloads, settings). */
const cachedUser = () => { try { return JSON.parse(localStorage.getItem('aur_user') || 'null'); } catch { return null; } };

async function boot() {
  let user;
  try {
    ({ user } = await api.get('/session'));
    try { user ? localStorage.setItem('aur_user', JSON.stringify(user)) : localStorage.removeItem('aur_user'); } catch { /* storage blocked */ }
  } catch (err) {
    if (err.code !== 'network_error') throw err;
    user = cachedUser();
    if (!user) { // never signed in here, and no connection
      document.getElementById('app').innerHTML = `<div class="auth-screen"><div class="auth-card"><div class="auth-brand">${Icon.logo}<span>Aurelune</span></div><p style="text-align:center;color:var(--text-dim);margin:18px 0">You're offline. Connect to the internet to sign in.</p><button class="btn btn-primary" onclick="location.reload()">Try again</button></div></div>`;
      window.addEventListener('online', () => location.reload(), { once: true });
      return;
    }
    offlineBoot = true;
    window.addEventListener('online', () => location.reload(), { once: true });
  }
  setUser(user);
  if (!user) { await wipeDownloads(); return renderAuth(); } // signed out (or the session ended): downloads don't outlive it
  downloads.init(user.id);

  const app = document.getElementById('app');
  app.classList.remove('no-auth');
  app.innerHTML = shellHtml();
  document.getElementById('np-close').addEventListener('click', () => toggleNowPlayingPanel(npTab));
  document.querySelectorAll('#now-playing-panel .sp-tab').forEach((t) => t.addEventListener('click', () => {
    if (npTab === t.dataset.nptab) return;
    npTab = t.dataset.nptab;
    document.querySelectorAll('#now-playing-panel .sp-tab').forEach((x) => x.classList.toggle('active', x === t));
    document.getElementById('p-lyrics')?.classList.toggle('on', npTab === 'playing');
    document.getElementById('p-queue')?.classList.toggle('on', npTab === 'queue');
    renderNowPlayingBody();
  }));
  wireTopbar();
  wireSidebar();
  initTopSearch({ api, player, icon, esc });
  if (user.eq?.bands) player.setEQBands(user.eq.bands);
  refreshSidebarPlaylists();
  renderPlayerBar();
  router();
}

window.addEventListener('hashchange', router);
onUserChange(() => { const n = document.querySelector('#avatar-btn .name'); if (n) n.textContent = getUser().display_name; });
boot();
// Lets the app open with no connection (offline downloads). Needs https or localhost; harmlessly absent elsewhere.
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
