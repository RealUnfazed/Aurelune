import { api } from './api.js';
import { player, fmtTime } from './player.js';
import { getUser, setUser, onUserChange, isCreatorApproved, isAdmin } from './store.js';
import { toast, openModal, getActiveList, getItem, bus, openContextMenu, closeContextMenu } from './ui.js';
import { icon, Icon } from './icons.js';
import { esc, fmtDuration, artistLink } from './components.js';
import { Views, addToPlaylistModal } from './views.js';
import { initTopSearch } from './topsearch.js';

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
      <div class="nav-sep"></div>
      <a class="nav-item" data-navkey="studio" href="#/studio"><span class="nav-icon-outline">${icon('mic')}</span><span class="nav-label">For Creators</span></a>
      ${isAdmin() ? `<a class="nav-item" data-navkey="admin" href="#/admin"><span class="nav-icon-outline">${icon('shield')}</span><span class="nav-label">Admin</span></a>` : ''}
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
  { re: /^\/lyrics$/, key: 'lyrics', view: (root) => Views.lyricsPage(root) },
];

let viewCleanup = null;
async function router() {
  const { path, query } = parseHash();
  const match = ROUTES.find((r) => r.re.test(path));
  const root = document.getElementById('view');
  if (!root) return;
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
    <div class="pbar pmini" id="p-bar-m" aria-hidden="true"><div class="fill" id="p-fill-m"></div></div>
    <div class="pcenter">
      <div class="ptransport">
        <button class="icon-btn ${player.shuffle ? 'on' : ''}" id="p-shuffle" aria-label="Shuffle" style="${isEp ? 'visibility:hidden' : ''}">${icon('shuffle')}</button>
        <button class="icon-btn" id="p-prev" aria-label="Previous">${icon('prev')}</button>
        <button class="play-btn sm white" id="p-toggle" aria-label="Play/Pause">${icon(player.isPlaying ? 'pause' : 'play')}</button>
        <button class="icon-btn" id="p-next" aria-label="Next">${icon('next')}</button>
        <button class="icon-btn ${player.repeat !== 'off' ? 'on' : ''}" id="p-repeat" aria-label="Repeat${player.repeat === 'one' ? ' one' : ''}" style="${isEp ? 'visibility:hidden' : ''}">${icon(player.repeat === 'one' ? 'repeatOne' : 'repeat')}</button>
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
  bar.querySelector('#p-shuffle')?.addEventListener('click', () => player.toggleShuffle());
  bar.querySelector('#p-repeat')?.addEventListener('click', () => player.cycleRepeat());
  bar.querySelector('#bar-like')?.addEventListener('click', async (e) => {
    const on = item.liked; e.currentTarget.disabled = true;
    try { await (on ? api.del(`/me/likes/${item.id}`) : api.put(`/me/likes/${item.id}`)); item.liked = !on; renderPlayerBar(); }
    catch (err) { toast(err.message, { err: true }); }
  });
  for (const id of ['#p-bar', '#p-bar-m']) {
    wireSlider(bar.querySelector(id), {
      onInput: (f) => { seekDrag = { f }; updateSeek(); },       // live preview while dragging
      onCommit: (f) => { seekDrag = null; player.seekFraction(f); updateSeek(); },
      onCancel: () => { seekDrag = null; updateSeek(); },
      onStep: (dir) => player.seekTo(Math.max(0, player.audio.currentTime + dir * 5)),
    });
  }
  wireSlider(bar.querySelector('#v-bar'), {
    onInput: (f) => player.setVolume(f), onCommit: (f) => player.setVolume(f),
    onStep: (dir) => player.setVolume(player.volume + dir * 0.05),
  });
  bar.querySelector('#p-mute').addEventListener('click', () => player.toggleMute());
  bar.querySelector('#p-lyrics').addEventListener('click', () => toggleNowPlayingPanel('playing'));
  bar.querySelector('#p-queue').addEventListener('click', () => toggleNowPlayingPanel('queue'));
  updateSeek();
}

/**
 * Draggable slider for the progress and volume bars. Pointer events cover mouse, touch and pen, and the
 * move/up listeners live on `document` so the drag keeps working even if the bar is re-rendered mid-drag
 * (the element is looked up again by id on every move).
 */
let seekDrag = null; // { f } while the user is dragging the progress bar; null otherwise
function wireSlider(el, { onInput, onCommit, onCancel, onStep }) {
  if (!el) return;
  const id = el.id;
  const frac = (clientX) => {
    const r = (document.getElementById(id) || el).getBoundingClientRect();
    return r.width ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    (document.getElementById(id) || el).classList.add('dragging');
    let last = frac(e.clientX);
    onInput(last);
    const move = (ev) => { last = frac(ev.clientX); onInput(last); };
    const end = (ev, cancelled) => {
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

function updateSeek() {
  const fill = document.getElementById('p-fill'), knob = document.getElementById('p-knob'), cur = document.getElementById('p-cur');
  if (!fill) return;
  const dur = player.durationSec;
  const t = seekDrag ? seekDrag.f * dur : player.audio.currentTime;
  const pct = dur ? Math.min(100, Math.max(0, (t / dur) * 100)) : 0;
  fill.style.width = pct + '%'; knob.style.left = pct + '%';
  const mini = document.getElementById('p-fill-m'); if (mini) mini.style.width = pct + '%';
  cur.textContent = fmtTime(t);
  document.getElementById('p-bar')?.setAttribute('aria-valuenow', String(Math.round(pct)));
  document.getElementById('p-dur') && (document.getElementById('p-dur').textContent = fmtTime(dur));
  if (!seekDrag) updateLyricsHighlight();
}

let npOpen = false;
let npTab = 'playing';

function toggleNowPlayingPanel(tab) {
  const panel = document.getElementById('now-playing-panel');
  if (npOpen && npTab === tab) { npOpen = false; }
  else { npOpen = true; npTab = tab; }
  panel.classList.toggle('open', npOpen);
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
  if (!l) return `<p class="np-dim">Loading lyrics…</p>`;
  if (!l.plain) return `<p class="np-dim">No lyrics for this one.</p>`;
  if (!l.synced) return `<div class="lyrics-plain">${esc(l.plain.split('\n').slice(0, 6).join('\n'))}</div>`;
  const idx = Math.max(0, player.activeLyricIndex());
  const around = l.lines.slice(Math.max(0, idx - 1), idx + 4);
  return around.map((line, i) => `<div class="lyrics-line ${Math.max(0, idx - 1) + i === idx ? 'active' : ''}">${esc(line.text) || '&nbsp;'}</div>`).join('');
}

function renderPlayingTab(body) {
  const item = player.current;
  if (!item) { body.innerHTML = `<div class="empty" style="padding:40px 10px"><div class="icon">${icon('disc')}</div><h3>Nothing playing</h3></div>`; return; }
  const isEp = item.type === 'episode';
  body.innerHTML = `
    <div class="np-cover"><img src="${item.cover}" alt=""></div>
    <div class="np-title">${esc(item.title)}</div>
    <div class="np-artist">${item.artist ? artistLink(item.artist) : esc(item.creator?.name || '')}</div>
    ${item.credits ? `<div class="np-credits">${esc(item.credits)}</div>` : ''}
    ${!isEp ? `
      <div class="np-section-head"><span>Lyrics</span><a href="#/lyrics" id="np-expand-lyrics">Expand</a></div>
      <div class="np-lyrics-preview">${lyricsPreviewHtml()}</div>
    ` : ''}
    ${player.queue.length > player.index + 1 ? `
      <div class="np-section-head"><span>Next in queue</span><button class="link-more" id="np-see-queue" style="background:none;border:none;cursor:pointer">See all</button></div>
      <div class="row-list">${player.queue.slice(player.index + 1, player.index + 4).map((it) => `
        <div class="trow-main" style="padding:6px 4px"><div class="trow-cover"><img src="${it.cover}"></div><div class="trow-text"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.artist?.name || it.creator?.name || '')}</div></div></div>
      `).join('')}</div>
    ` : ''}
  `;
  body.querySelector('#np-see-queue')?.addEventListener('click', () => toggleNowPlayingPanel('queue'));
}

function renderQueueTab(body) {
  if (!player.queue.length) { body.innerHTML = `<p class="np-dim">Queue is empty.</p>`; return; }
  body.innerHTML = `<div class="queue-list">${player.queue.map((it, i) => `
    <div class="trow ${i === player.index ? 'playing' : ''}" data-qi="${i}">
      <div class="trow-main"><div class="trow-cover"><img src="${it.cover}"></div><div class="trow-text"><div class="t">${esc(it.title)}</div><div class="s">${esc(it.artist?.name || it.creator?.name || '')}</div></div></div>
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
    e.currentTarget.disabled = true;
    try {
      await api.post('/reports', { kind, item_id: id, reason: m.el.querySelector('#rp-reason').value, note: m.el.querySelector('#rp-note').value });
      toast('Thanks — our team will take a look.');
      m.close();
    } catch (err) { toast(err.message, { err: true }); e.currentTarget.disabled = false; }
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

function openTrackMenu(item, x, y) {
  const hasAlbum = !!item.album?.id;
  const embeddable = item.type === 'track' || item.type === 'episode';
  const html = `
    ${ctxItem('play', 'play', 'Play')}
    ${ctxItem('next', 'next', 'Play next')}
    ${ctxItem('queue', 'queue', 'Add to queue')}
    ${item.type === 'track' ? ctxItem('playlist', 'plus', 'Add to playlist') : ''}
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
    const w = Math.min(NAV_MAX, Math.max(NAV_MIN, e.clientX - nav.getBoundingClientRect().left));
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

async function boot() {
  const { user } = await api.get('/session');
  setUser(user);
  if (!user) return renderAuth();

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
