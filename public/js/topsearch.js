// The search box in the top bar: type and results appear right under it (no page change). Press Enter, or
// choose "See all results", to open the full search page instead. Arrow keys move through the results.
const RECENT_KEY = 'aur_recent_searches';
const DEBOUNCE_MS = 170;

const readRecents = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
const saveRecent = (q) => {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([q, ...readRecents().filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6))); } catch { /* storage unavailable */ }
};
const clearRecents = () => { try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ } };

export function initTopSearch({ api, player, icon, esc }) {
  const form = document.getElementById('topbar-search');
  const input = document.getElementById('topbar-search-input');
  const panel = document.getElementById('ts-panel');
  const clearBtn = document.getElementById('ts-clear');
  if (!form || !input || !panel) return;

  let items = [];      // flat list of selectable rows, in the order they appear (for the keyboard)
  let active = -1;
  let seq = 0;         // each request gets a number; a slow older answer must never overwrite a newer one
  let timer = null;
  let lastData = null;

  const open = () => { panel.hidden = false; input.setAttribute('aria-expanded', 'true'); };
  const close = () => { panel.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const syncClear = () => { clearBtn.hidden = !input.value; };

  /* ------------------------------ rendering ------------------------------ */

  const sub = {
    track: (t) => `Song · ${esc(t.artist?.name || '')}`,
    artist: () => 'Artist',
    album: (a) => `Album · ${esc(a.artist?.name || '')}`,
    show: (s) => `Podcast · ${esc(s.creator?.name || s.artist?.name || '')}`,
    episode: (e) => `Episode · ${esc(e.show?.title || e.creator?.name || '')}`,
    playlist: (p) => `Playlist · ${esc(p.owner?.display_name || p.owner?.username || '')}`,
  };
  const img = (kind, o) => (kind === 'artist' ? o.image : kind === 'playlist' ? o.covers?.[0] : o.cover) || '';

  function row(kind, o, i) {
    const title = esc(o.title || o.name || '');
    return `<button type="button" class="ts-row" role="option" data-i="${i}" id="ts-opt-${i}">
      <img class="${kind === 'artist' ? 'round' : ''}" src="${esc(img(kind, o))}" alt="" loading="lazy">
      <span class="ts-text"><span class="ts-title">${title}</span><span class="ts-sub">${sub[kind](o)}</span></span>
    </button>`;
  }

  function renderResults(d, q) {
    items = [];
    const sections = [
      ['Songs', 'track', d.tracks.slice(0, 5)],
      ['Artists', 'artist', d.artists.slice(0, 3)],
      ['Albums', 'album', d.albums.slice(0, 3)],
      ['Podcasts', 'show', d.shows.slice(0, 2)],
      ['Episodes', 'episode', d.episodes.slice(0, 3)],
      ['Playlists', 'playlist', d.playlists.slice(0, 2)],
    ].filter(([, , list]) => list.length);
    let html = '';
    for (const [label, kind, list] of sections) {
      html += `<div class="ts-head">${label}</div>`;
      for (const o of list) { html += row(kind, o, items.length); items.push({ kind, o, list }); }
    }
    if (!sections.length) {
      html = `<div class="ts-empty">No results for “${esc(q)}”</div>`;
    }
    html += `<button type="button" class="ts-row ts-all" role="option" data-i="${items.length}" id="ts-opt-${items.length}">${icon('search')}<span class="ts-text"><span class="ts-title">See all results for “${esc(q)}”</span></span></button>`;
    items.push({ kind: 'all', q });
    panel.innerHTML = html;
    active = -1;
    open();
  }

  function renderRecents() {
    const recents = readRecents();
    items = recents.map((q) => ({ kind: 'recent', q }));
    if (!recents.length) { panel.innerHTML = `<div class="ts-empty">Search songs, artists, albums, podcasts and playlists</div>`; items = []; }
    else {
      panel.innerHTML = `<div class="ts-head">Recent searches <button type="button" class="ts-link" id="ts-clear-recents">Clear</button></div>` +
        recents.map((q, i) => `<button type="button" class="ts-row" role="option" data-i="${i}" id="ts-opt-${i}">${icon('search')}<span class="ts-text"><span class="ts-title">${esc(q)}</span></span></button>`).join('');
    }
    active = -1;
    open();
  }

  function setActive(n) {
    panel.querySelectorAll('.ts-row.active').forEach((r) => r.classList.remove('active'));
    active = n;
    const el = n >= 0 ? panel.querySelector(`[data-i="${n}"]`) : null;
    if (el) { el.classList.add('active'); el.scrollIntoView({ block: 'nearest' }); input.setAttribute('aria-activedescendant', el.id); }
    else input.removeAttribute('aria-activedescendant');
  }

  /* ------------------------------ searching ------------------------------ */

  async function run(q) {
    const mine = ++seq;
    if (!lastData) { panel.innerHTML = `<div class="ts-empty">Searching…</div>`; items = []; open(); }
    try {
      const d = await api.get('/search', { q });
      if (mine !== seq || input.value.trim() !== q) return; // a newer keystroke superseded this answer
      lastData = d;
      renderResults(d, q);
    } catch {
      if (mine !== seq) return;
      panel.innerHTML = `<div class="ts-empty">Search isn’t available right now. Press Enter to try the full search page.</div>`;
      items = [];
    }
  }

  function onInput() {
    syncClear();
    clearTimeout(timer);
    const q = input.value.trim();
    seq++;
    if (!q) { lastData = null; renderRecents(); return; }
    timer = setTimeout(() => run(q), DEBOUNCE_MS);
  }

  /* ------------------------------ choosing ------------------------------ */

  const fullPage = (q) => {
    q = (q ?? input.value).trim();
    close();
    if (!q) { location.hash = '#/search'; return; }
    saveRecent(q);
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
    input.blur();
  };

  function choose(n) {
    const it = items[n];
    if (!it) return;
    if (it.kind === 'all') return fullPage(it.q);
    if (it.kind === 'recent') { input.value = it.q; syncClear(); return fullPage(it.q); }
    const q = input.value.trim();
    if (q) saveRecent(q);
    close();
    input.blur();
    const { kind, o } = it;
    if (kind === 'track') player.playQueue(it.list, Math.max(0, it.list.indexOf(o)), { source: 'search' });
    else if (kind === 'episode') player.playQueue([o], 0, { source: 'search' });
    else if (kind === 'artist') location.hash = `#/artist/${o.slug || o.id}`;
    else location.hash = `#/${kind}/${o.id}`; // album | show | playlist
  }

  /* ------------------------------ wiring ------------------------------ */

  input.addEventListener('input', onInput);
  input.addEventListener('focus', () => {
    if (!input.value.trim()) renderRecents();
    else if (lastData) { renderResults(lastData, input.value.trim()); }
    else onInput();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (panel.hidden) { onInput(); return; }
      e.preventDefault();
      if (!items.length) return;
      const next = e.key === 'ArrowDown' ? (active + 1) % items.length : (active - 1 + items.length) % items.length;
      setActive(next);
    } else if (e.key === 'Escape') {
      if (!panel.hidden) { e.preventDefault(); close(); } else input.blur();
    }
  });
  // Enter / the mobile keyboard's "search" key: a highlighted row opens that row, otherwise go to the full results page.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    if (active >= 0 && !panel.hidden) choose(active); else fullPage();
  });
  clearBtn.addEventListener('click', () => { input.value = ''; lastData = null; seq++; syncClear(); input.focus(); renderRecents(); });
  panel.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input while clicking inside the panel
  panel.addEventListener('click', (e) => {
    if (e.target.closest('#ts-clear-recents')) { clearRecents(); renderRecents(); return; }
    const r = e.target.closest('.ts-row');
    if (r) choose(Number(r.dataset.i));
  });
  panel.addEventListener('pointermove', (e) => { const r = e.target.closest('.ts-row'); if (r && Number(r.dataset.i) !== active) setActive(Number(r.dataset.i)); });
  document.addEventListener('pointerdown', (e) => { if (!panel.hidden && !form.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => {
    // "/" focuses the search box from anywhere (unless the user is typing somewhere)
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) {
      e.preventDefault(); input.focus();
    }
  });
  window.addEventListener('hashchange', () => {
    close();
    // Keep the box in step with the search page; empty it when the user leaves search.
    const m = /^#\/search\?(.*)$/.exec(location.hash);
    if (m) { input.value = new URLSearchParams(m[1]).get('q') || ''; lastData = null; }
    else if (document.activeElement !== input) { input.value = ''; lastData = null; }
    syncClear();
  });
  // Opening the app directly on a search URL
  const m0 = /^#\/search\?(.*)$/.exec(location.hash);
  if (m0) { input.value = new URLSearchParams(m0[1]).get('q') || ''; syncClear(); }
}
