import { api, getActivePage, setActivePage } from './api.js';
import { player, fmtTime, EQ_BANDS_HZ } from './player.js';
import { getUser, setUser, isCreatorApproved, isAdmin, applyAnimations } from './store.js';
import { toast, openModal, confirmDialog, setActiveList, registerItem, getItem, notifyPlaylistsChanged } from './ui.js';
import { icon } from './icons.js';
import { getStorageOptions, planUpload, describeRoute, uploadTrack, uploadEpisode, UploadError } from './uploader.js';
import {
  esc, fmtDuration, fmtMinutes, fmtCount, fmtDate, fmtRelative, initials, artistLink, bylineHtml,
  shelf, cardFor, trackList, trackRow, episodeRow, skeletonShelf, albumCard, artistCard, showCard, playlistCard, playlistArt, lockBadge, likedTile, episodesTile, LIKED_ICONS, LIKED_COLORS, trackCard,
} from './components.js';

const loading = (root) => { root.innerHTML = `<div class="section-head"><h2 class="section-title">&nbsp;</h2></div>${skeletonShelf()}${skeletonShelf()}`; };

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/* ============================================================ Home ============================================================ */

async function home(root) {
  loading(root);
  const data = await api.get('/home');
  const user = getUser();
  root.innerHTML = `
    <div class="hero-band">
      <h1>${greeting()}${user ? `, ${esc(user.display_name.split(' ')[0])}` : ''}</h1>
      <p>Here's what's moving in your corner of Aurelune tonight.</p>
    </div>
    ${data.private_tracks?.length ? shelf('Only you can see these', data.private_tracks) : ''}
    ${data.recent?.length ? shelf('Jump back in', data.recent) : ''}
    ${data.from_follows?.length ? shelf('New from artists you follow', data.from_follows) : ''}
    ${shelf('Trending this week', data.trending)}
    ${shelf('New releases', data.new_albums, { link: '#/genres' })}
    ${shelf('Artists to discover', data.artists)}
    ${data.new_episodes?.length ? shelf('Fresh episodes', data.new_episodes) : ''}
    ${data.shows?.length ? shelf('Podcasts on Aurelune', data.shows) : ''}
    ${data.playlists?.length ? shelf('Playlists worth a listen', data.playlists) : ''}
    ${data.genres?.length ? `<div class="shelf"><div class="section-head"><h2 class="section-title">Browse genres</h2></div><div class="chip-row">${data.genres.map((g) => `<a class="chip" href="#/genre/${encodeURIComponent(g.name)}">${esc(g.name)}</a>`).join('')}</div></div>` : ''}
  `;
  [data.private_tracks, data.recent, data.from_follows, data.trending, data.new_episodes].forEach((l) => l && l.forEach(registerItem));
}

/* ============================================================ Search ============================================================ */

async function search(root, params) {
  const q = params.q || '';
  root.innerHTML = `
    <div class="search-hero" style="max-width:640px;margin-bottom:8px">
      <input type="text" id="search-input" placeholder="Songs, artists, podcasts, playlists…" value="${esc(q)}"
        style="width:100%;background:var(--raised);border:1px solid var(--hairline-2);border-radius:var(--radius-round);padding:15px 20px;font-size:16px;color:var(--text);outline:none">
    </div>
    <div id="search-results"></div>`;
  const input = root.querySelector('#search-input');
  const results = root.querySelector('#search-results');
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);

  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    const val = input.value.trim();
    history.replaceState(null, '', val ? `#/search?q=${encodeURIComponent(val)}` : '#/search');
    t = setTimeout(() => runSearch(val), 260);
  });

  async function runSearch(query) {
    if (!query) { results.innerHTML = await genreBrowser(); return; }
    results.innerHTML = skeletonShelf(4);
    const d = await api.get('/search', { q: query });
    if (input.value.trim() !== query) return; // stale response
    if (!d.tracks.length && !d.artists.length && !d.albums.length && !d.shows.length && !d.episodes.length && !d.playlists.length) {
      results.innerHTML = `<div class="empty"><div class="icon">${icon('search')}</div><h3>No results for "${esc(query)}"</h3><p>Try a different spelling or a broader term.</p></div>`;
      return;
    }
    setActiveList(d.tracks);
    results.innerHTML = `
      ${d.tracks.length ? `<div class="section-head"><h2 class="section-title">Songs</h2></div>${trackList(d.tracks.slice(0, 8))}` : ''}
      ${shelf('Artists', d.artists)}
      ${shelf('Albums', d.albums)}
      ${shelf('Podcasts', d.shows)}
      ${shelf('Playlists', d.playlists)}
      ${d.episodes.length ? `<div class="section-head"><h2 class="section-title">Episodes</h2></div>${d.episodes.map(episodeRow).join('')}` : ''}
    `;
  }
  runSearch(q);
}

async function genreBrowser() {
  const d = await api.get('/genres');
  if (!d.genres.length) return '';
  return `<div class="section-head"><h2 class="section-title">Browse all</h2></div><div class="chip-row">${d.genres.map((g) => `<a class="chip" href="#/genre/${encodeURIComponent(g.name)}">${esc(g.name)}</a>`).join('')}</div>`;
}

async function genre(root, params) {
  loading(root);
  const d = await api.get(`/genres/${encodeURIComponent(params.name)}`);
  setActiveList(d.tracks);
  root.innerHTML = `<h1 class="page-title">${esc(d.genre)}</h1><p class="page-sub">${d.tracks.length} tracks</p>${trackList(d.tracks, { numbered: false })}`;
}

/* ============================================================ Artist ============================================================ */

async function artist(root, params) {
  loading(root);
  const d = await api.get(`/artists/${encodeURIComponent(params.id)}`);
  const a = d.artist;
  setActiveList(d.top_tracks);
  root.innerHTML = `
    <div class="detail-header artist">
      <div class="cover"><img src="${a.image}" alt=""></div>
      <div class="meta">
        <div class="kind">Artist${a.private ? ` <span class="private-note">${lockBadge()}Private page: only you and admins can see this</span>` : ''}</div>
        <h1>${esc(a.name)}${a.verified ? ' ' + icon('check', 'verified-inline') : ''}</h1>
        <div class="facts"><span>${fmtCount(d.monthly_listeners)} monthly listeners</span><span class="dot"></span><span>${fmtCount(d.followers)} followers</span></div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="play-btn" id="play-all">${icon('play')}</button>
      <button class="btn ${d.is_following ? 'btn-ghost' : 'btn-outline'}" id="follow-btn">${d.is_following ? 'Following' : 'Follow'}</button>
    </div>
    ${d.top_tracks.length ? `<div class="section-head"><h2 class="section-title">Popular</h2></div>${trackList(d.top_tracks.slice(0, 10), { showArtist: d.top_tracks.some((t) => t.artist?.id !== a.id) })}` : ''}
    ${shelf('Albums & singles', d.albums)}
    ${shelf('Podcasts', d.shows)}
    ${d.featured_episodes?.length ? `<div class="section-head"><h2 class="section-title">Featured on episodes</h2></div>${d.featured_episodes.map((e) => episodeRow(e)).join('')}` : ''}
    ${a.bio ? `<div class="section-head"><h2 class="section-title">About</h2></div><p style="color:var(--text-dim);font-size:14.5px;line-height:1.7;max-width:640px">${esc(a.bio)}</p>${a.links?.length ? `<div class="chip-row" style="margin-top:14px">${a.links.map((l) => `<a class="chip" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || 'Link')}</a>`).join('')}</div>` : ''}` : ''}
  `;
  root.querySelector('#play-all')?.addEventListener('click', () => d.top_tracks.length && player.playQueue(d.top_tracks, 0, { source: 'artist_page' }));
  root.querySelector('#follow-btn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget; const on = btn.textContent.trim() === 'Following';
    btn.disabled = true;
    try {
      await (on ? api.del(`/me/following/artists/${a.id}`) : api.put(`/me/following/artists/${a.id}`));
      btn.textContent = on ? 'Follow' : 'Following'; btn.className = `btn ${on ? 'btn-outline' : 'btn-ghost'}`;
    } catch (err) { toast(err.message, { err: true }); }
    btn.disabled = false;
  });
}

/* ============================================================ Album ============================================================ */

async function album(root, params) {
  loading(root);
  const d = await api.get(`/albums/${params.id}`);
  const a = d.album;
  setActiveList(d.tracks);
  const totalMs = d.tracks.reduce((n, t) => n + t.duration_ms, 0);
  root.innerHTML = `
    <div class="detail-header">
      <div class="cover"><img src="${a.cover}" alt=""></div>
      <div class="meta">
        <div class="kind">${a.kind === 'single' ? 'Single' : a.kind === 'ep' ? 'EP' : 'Album'}</div>
        <h1>${esc(a.title)}</h1>
        <div class="facts">${artistLink(a.artist)}<span class="dot"></span><span>${new Date(a.released_at).getFullYear()}</span><span class="dot"></span><span>${a.track_count} songs, ${fmtDuration(totalMs)}</span></div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="play-btn" id="play-all">${icon('play')}</button>
      <button class="icon-btn ${d.is_saved ? 'on' : ''}" id="save-btn" aria-label="Save album">${icon(d.is_saved ? 'heartFill' : 'heart')}</button>
    </div>
    ${trackList(d.tracks, { showArtist: false })}
    ${a.description ? `<p style="color:var(--text-dim);font-size:13.5px;margin-top:24px;max-width:600px">${esc(a.description)}</p>` : ''}
  `;
  root.querySelector('#play-all').addEventListener('click', () => d.tracks.length && player.playQueue(d.tracks, 0, { source: 'album_page' }));
  root.querySelector('#save-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget; const on = btn.classList.contains('on'); btn.disabled = true;
    try { await (on ? api.del(`/me/saved/albums/${a.id}`) : api.put(`/me/saved/albums/${a.id}`)); btn.classList.toggle('on'); btn.innerHTML = icon(on ? 'heart' : 'heartFill'); }
    catch (err) { toast(err.message, { err: true }); }
    btn.disabled = false;
  });
}

/* ============================================================ Show (podcast) ============================================================ */

async function show(root, params) {
  loading(root);
  const d = await api.get(`/shows/${params.id}`);
  const s = d.show;
  setActiveList(d.episodes);
  root.innerHTML = `
    <div class="detail-header">
      <div class="cover"><img src="${s.cover}" alt=""></div>
      <div class="meta">
        <div class="kind">Podcast${s.private ? ` <span class="private-note">${lockBadge()}Private podcast: only you and admins can see this</span>` : ''}</div>
        <h1>${esc(s.title)}</h1>
        <div class="facts">${artistLink(s.creator)}<span class="dot"></span><span>${s.episode_count} episodes</span>${s.category ? `<span class="dot"></span><span>${esc(s.category)}</span>` : ''}</div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="play-btn" id="play-latest">${icon('play')}</button>
      <button class="btn ${d.is_following ? 'btn-ghost' : 'btn-outline'}" id="follow-btn">${d.is_following ? 'Following' : 'Follow'}</button>
    </div>
    ${s.description ? `<p style="color:var(--text-dim);font-size:14px;line-height:1.65;max-width:640px;margin-bottom:26px">${esc(s.description)}</p>` : ''}
    <div class="section-head"><h2 class="section-title">Episodes</h2></div>
    <div>${d.episodes.map(episodeRow).join('') || `<div class="empty"><div class="icon">${icon('podcast')}</div><h3>No episodes yet</h3></div>`}</div>
  `;
  root.querySelector('#play-latest').addEventListener('click', () => d.episodes.length && player.playQueue(d.episodes, 0, { source: 'show_page' }));
  root.querySelector('#follow-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget; const on = btn.textContent.trim() === 'Following'; btn.disabled = true;
    try { await (on ? api.del(`/me/following/shows/${s.id}`) : api.put(`/me/following/shows/${s.id}`)); btn.textContent = on ? 'Follow' : 'Following'; btn.className = `btn ${on ? 'btn-outline' : 'btn-ghost'}`; }
    catch (err) { toast(err.message, { err: true }); }
    btn.disabled = false;
  });
}

/* ============================================================ Playlist ============================================================ */

async function playlist(root, params) {
  loading(root);
  const d = await api.get(`/playlists/${params.id}`);
  const p = d.playlist;
  setActiveList(d.tracks);
  root.innerHTML = `
    <div class="detail-header">
      <div class="cover">${playlistArt(p)}</div>
      <div class="meta">
        <div class="kind">${p.is_public ? 'Public playlist' : 'Private playlist'}</div>
        <h1 ${d.is_owner ? 'contenteditable spellcheck="false" id="pl-title"' : ''}>${esc(p.title)}</h1>
        <div class="facts"><span>By ${esc(p.owner?.display_name || '')}</span><span class="dot"></span><span>${p.track_count} songs</span></div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="play-btn" id="play-all">${icon('play')}</button>
      ${d.is_owner ? `<button class="icon-btn pin-toggle ${p.pinned ? 'on' : ''}" id="pl-pin" aria-label="${p.pinned ? 'Unpin' : 'Pin to sidebar top'}" title="${p.pinned ? 'Unpin from the top of your sidebar' : 'Pin to the top of your sidebar'}">${icon(p.pinned ? 'pinFilled' : 'pin')}</button>` : ''}
      ${d.is_owner ? `<button class="icon-btn" id="pl-settings" aria-label="Playlist settings">${icon('more')}</button>` : ''}
    </div>
    ${trackList(d.tracks, { showAlbum: true })}
  `;
  root.querySelector('#play-all').addEventListener('click', () => d.tracks.length && player.playQueue(d.tracks, 0, { source: 'playlist_page' }));

  if (d.is_owner) {
    const titleEl = root.querySelector('#pl-title');
    let saveT = null;
    titleEl.addEventListener('input', () => {
      clearTimeout(saveT);
      saveT = setTimeout(() => api.patch(`/playlists/${p.id}`, { title: titleEl.textContent.trim() || 'Untitled' }).catch(() => {}), 700);
    });
    root.querySelector('#pl-settings').addEventListener('click', () => openPlaylistSettings(p, () => playlist(root, params)));
    root.querySelector('#pl-pin').addEventListener('click', async () => {
      try {
        await (p.pinned ? api.del(`/playlists/${p.id}/pin`) : api.put(`/playlists/${p.id}/pin`));
        toast(p.pinned ? 'Unpinned' : 'Pinned to the top of your sidebar');
        notifyPlaylistsChanged(); playlist(root, params);
      } catch (err) { toast(err.message, { err: true }); }
    });

    // Remove-from-playlist buttons, added onto each row's action area.
    root.querySelectorAll('.trow[data-row="track"]').forEach((row) => {
      const actions = row.querySelector('.trow-actions');
      const btn = document.createElement('button');
      btn.className = 'like-btn'; btn.setAttribute('aria-label', 'Remove from playlist'); btn.innerHTML = icon('x');
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.del(`/playlists/${p.id}/tracks/${row.dataset.id}`).catch((err) => toast(err.message, { err: true }));
        notifyPlaylistsChanged();
        playlist(root, params);
      });
      actions.appendChild(btn);
    });
  }
}

function openPlaylistSettings(p, onChange) {
  const m = openModal({
    title: 'Playlist settings',
    body: `
      <div class="field"><label>Description</label><textarea id="pl-desc">${esc(p.description || '')}</textarea></div>
      <div class="switch-row"><div class="copy"><div class="title">Public playlist</div><div class="desc">Anyone with the link can view and play it.</div></div><div class="switch ${p.is_public ? 'on' : ''}" id="pl-public"></div></div>
      <div style="margin-top:22px;border-top:1px solid var(--hairline);padding-top:18px"><button class="btn btn-danger" id="pl-delete">${icon('trash')} Delete playlist</button></div>
    `,
    footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="pl-save">Save changes</button>`,
  });
  let isPublic = p.is_public;
  m.el.querySelector('#pl-public').addEventListener('click', (e) => { isPublic = !isPublic; e.currentTarget.classList.toggle('on'); });
  m.el.querySelector('#pl-save').addEventListener('click', async () => {
    await api.patch(`/playlists/${p.id}`, { description: m.el.querySelector('#pl-desc').value, is_public: isPublic }).catch((err) => toast(err.message, { err: true }));
    m.close(); onChange();
  });
  m.el.querySelector('#pl-delete').addEventListener('click', async () => {
    if (!(await confirmDialog('This playlist will be permanently deleted.'))) return;
    await api.del(`/playlists/${p.id}`).catch((err) => toast(err.message, { err: true }));
    notifyPlaylistsChanged();
    m.close(); location.hash = '#/library';
  });
}

export async function addToPlaylistModal(track) {
  const [{ playlists }, mine] = await Promise.all([api.get('/me/playlists'), Promise.resolve(null)]);
  const m = openModal({
    title: `Add "${track.title}" to playlist`,
    body: `
      <button class="btn btn-outline" id="pl-new" style="width:100%;margin-bottom:14px;justify-content:flex-start">${icon('plus')} New playlist</button>
      <div style="display:flex;flex-direction:column;gap:2px">
        ${playlists.map((p) => `<button class="nav-item pick-row" data-pick="${p.id}" style="width:100%"><span class="pl-thumb">${playlistArt(p)}</span><span class="pick-text"><b>${esc(p.title)}</b><small>${p.track_count} song${p.track_count === 1 ? '' : 's'}</small></span></button>`).join('') || '<p style="color:var(--text-faint);font-size:13.5px">You don\'t have any playlists yet.</p>'}
      </div>`,
  });
  m.el.querySelectorAll('[data-pick]').forEach((btn) => btn.addEventListener('click', async () => {
    try { const r = await api.post(`/playlists/${btn.dataset.pick}/tracks`, { track_ids: [track.id] }); toast(r.added ? 'Added to playlist' : 'Already in that playlist'); if (r.added) notifyPlaylistsChanged(); }
    catch (err) { toast(err.message, { err: true }); }
    m.close();
  }));
  m.el.querySelector('#pl-new').addEventListener('click', async () => {
    m.close();
    const created = await api.post('/playlists', { title: 'New Playlist', track_ids: [track.id] }).catch((err) => { toast(err.message, { err: true }); return null; });
    if (created) { notifyPlaylistsChanged(); toast('Playlist created'); location.hash = `#/playlist/${created.playlist.id}`; }
  });
}

/* ============================================================ Library ============================================================ */

async function library(root) {
  loading(root);
  const d = await api.get('/library');
  root.innerHTML = `
    <h1 class="page-title">Your library</h1>
    <div class="detail-actions" style="margin-bottom:8px">
      <button class="btn btn-primary" id="new-playlist">${icon('plus')} New playlist</button>
    </div>
    <div class="section-head"><h2 class="section-title">Playlists</h2></div>
    <div class="grid">
      <div class="card" id="liked-card">
        <div class="art-wrap">${likedTile(getUser()?.liked_style || {}, 'big')}</div>
        <div class="title">Liked Songs</div><div class="sub">${d.liked_count} songs</div>
      </div>
 <div class="card" id="liked-eps-card">
        <div class="art-wrap">${episodesTile('big')}</div>
        <div class="title">Liked Episodes</div><div class="sub">${d.liked_episodes_count || 0} episodes</div>
      </div>
      ${d.playlists.map((p) => `<div class="card" data-open="playlist" data-id="${p.id}"><div class="art-wrap">${playlistArt(p)}</div><div class="title">${esc(p.title)}</div><div class="sub">${p.track_count} songs</div></div>`).join('')}
    </div>
    ${shelf('Artists you follow', d.artists, {})}
    ${shelf('Saved albums', d.albums, {})}
    ${shelf('Podcasts you follow', d.shows, {})}
    ${!d.playlists.length && !d.artists.length && !d.albums.length && !d.shows.length && !d.liked_count && !d.liked_episodes_count ? `<div class="empty"><div class="icon">${icon('library')}</div><h3>Your library is quiet</h3><p>Songs you like, follow, or save will show up here.</p></div>` : ''}
  `;
  root.querySelector('#liked-card').addEventListener('click', () => location.hash = '#/liked');
  root.querySelector('#liked-eps-card').addEventListener('click', () => location.hash = '#/liked-episodes');
  root.querySelector('#new-playlist').addEventListener('click', async () => {
    const created = await api.post('/playlists', { title: 'New Playlist' }).catch((err) => { toast(err.message, { err: true }); return null; });
    if (created) { notifyPlaylistsChanged(); location.hash = `#/playlist/${created.playlist.id}`; }
  });
}

async function liked(root) {
  loading(root);
  const d = await api.get('/me/likes', { limit: 300 });
  setActiveList(d.tracks);
  const style = getUser()?.liked_style || {};
  root.innerHTML = `
    <div class="detail-header">
      <button class="cover liked-cover" id="liked-cover" title="Change icon" aria-label="Change the Liked Songs icon">${likedTile(style, 'big')}<span class="liked-edit">${icon('edit')}</span></button>
      <div class="meta"><div class="kind">Playlist</div><h1>Liked Songs</h1><div class="facts"><span>${d.total} songs</span></div></div>
    </div>
    <div class="detail-actions"><button class="play-btn" id="play-all">${icon('play')}</button></div>
    ${trackList(d.tracks, { showAlbum: true })}
  `;
  root.querySelector('#play-all').addEventListener('click', () => d.tracks.length && player.playQueue(d.tracks, 0, { source: 'liked_songs' }));
  root.querySelector('#liked-cover').addEventListener('click', () => customizeLiked(() => liked(root)));
}

async function likedEpisodes(root) {
  loading(root);
  const d = await api.get('/me/likes/episodes', { limit: 300 });
  setActiveList(d.episodes);
  root.innerHTML = `
    <div class="detail-header">
      <div class="cover">${episodesTile('big')}</div>
      <div class="meta"><div class="kind">Podcasts</div><h1>Liked Episodes</h1><div class="facts"><span>${d.total} episode${d.total === 1 ? '' : 's'}</span></div></div>
    </div>
    <div class="detail-actions"><button class="play-btn" id="play-all">${icon('play')}</button></div>
    ${d.episodes.length ? d.episodes.map(episodeRow).join('') : `<div class="empty"><div class="icon">${icon('podcast')}</div><h3>No liked episodes yet</h3><p>Tap the heart on a podcast episode to save it here. Songs you like go to Liked Songs.</p></div>`}
  `;
  root.querySelector('#play-all').addEventListener('click', () => d.episodes.length && player.playQueue(d.episodes, 0, { source: 'liked_episodes' }));
}

/** Pick the glyph and colour of your Liked Songs tile (shown in the sidebar and on its page). */
export function customizeLiked(done) {
  const cur = { icon: getUser()?.liked_style?.icon || 'heart', color: getUser()?.liked_style?.color || 'green' };
  const m = openModal({
    title: 'Liked Songs icon',
    body: `<div class="liked-preview" id="lk-preview">${likedTile(cur, 'big')}</div>
      <div class="field"><label>Icon</label><div class="lk-grid" id="lk-icons">${Object.keys(LIKED_ICONS).map((k) => `<button type="button" class="lk-opt ${k === cur.icon ? 'on' : ''}" data-icon="${k}" aria-label="${k}">${icon(LIKED_ICONS[k])}</button>`).join('')}</div></div>
      <div class="field"><label>Colour</label><div class="lk-grid" id="lk-colors">${Object.keys(LIKED_COLORS).map((k) => `<button type="button" class="lk-opt lk-color ${k === cur.color ? 'on' : ''}" data-color="${k}" aria-label="${k}" style="background:${LIKED_COLORS[k]}"></button>`).join('')}</div></div>`,
    footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="lk-save">Save</button>`,
  });
  const redraw = () => {
    m.el.querySelector('#lk-preview').innerHTML = likedTile(cur, 'big');
    m.el.querySelectorAll('[data-icon]').forEach((b) => b.classList.toggle('on', b.dataset.icon === cur.icon));
    m.el.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('on', b.dataset.color === cur.color));
  };
  m.el.addEventListener('click', (e) => {
    const i = e.target.closest('[data-icon]'); const c = e.target.closest('[data-color]');
    if (i) { cur.icon = i.dataset.icon; redraw(); }
    if (c) { cur.color = c.dataset.color; redraw(); }
  });
  m.el.querySelector('#lk-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // capture now: currentTarget is null after any await
    btn.disabled = true;
    try {
      const r = await api.patch('/me', { liked_icon: cur.icon, liked_color: cur.color });
      setUser(r.user); notifyPlaylistsChanged(); m.close(); done?.();
      toast('Liked Songs icon updated');
    } catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
  });
}

/* ============================================================ History & stats ============================================================ */

function barsChart(rows, key, max) {
  const m = max || Math.max(1, ...rows.map((r) => r[key]));
  return `<div class="bars-chart">${rows.map((r) => `<div class="bar-col"><div class="bar" style="height:${Math.max(2, (r[key] / m) * 100)}%" title="${r[key]} min"></div><div class="lbl">${r.label}</div></div>`).join('')}</div>`;
}

async function historyView(root) {
  root.innerHTML = `<h1 class="page-title">Listening history</h1><p class="page-sub">Loading…</p>`;
  const tz = -new Date().getTimezoneOffset();
  const range = 'month';
  const [stats, topTracks, topArtists, hist] = await Promise.all([
    api.get('/me/stats', { range, tz_offset: tz }),
    api.get('/me/top/tracks', { range, limit: 8 }),
    api.get('/me/top/artists', { range, limit: 8 }),
    api.get('/me/history', { limit: 30 }),
  ]);
  setActiveList(hist.items.filter((h) => h.kind === 'track' && !h.item.removed).map((h) => h.item));

  function historyRow(h, i) {
    const it = h.item;
    if (it.removed) return `<div class="trow" style="opacity:.5"><div class="idx">${i + 1}</div><div class="trow-main"><div class="trow-text"><div class="t">Removed item</div></div></div><div class="trow-right"><span style="color:var(--text-faint)">${fmtRelative(h.played_at)}</span></div></div>`;
    registerItem(it);
    const sub = h.kind === 'episode' ? esc(it.show?.title || it.creator?.name || '') : bylineHtml(it);
    return `<div class="trow" data-row="${h.kind}" data-id="${it.id}">
      <div class="idx"><span class="num">${i + 1}</span><span class="eq"><i class="equalizer"><i></i><i></i><i></i></i></span><span class="play-hover"><button class="icon-btn" style="width:24px;height:24px;background:none" data-play-row="${it.id}">${icon('play')}</button></span></div>
      <div class="trow-main"><div class="trow-cover"><img src="${it.cover}" loading="lazy"></div><div class="trow-text"><div class="t">${esc(it.title)}</div><div class="s">${sub}</div></div></div>
      <div class="trow-right"><span style="color:var(--text-faint)">${fmtRelative(h.played_at)}</span></div>
    </div>`;
  }

  const dayRows = stats.by_day.map((d) => ({ minutes: d.minutes, label: new Date(d.date).getDate() % 5 === 0 ? new Date(d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '' }));
  const hourRows = stats.by_hour.map((h) => ({ minutes: h.minutes, label: '' }));

  root.innerHTML = `
    <div class="section-head" style="margin-top:0"><h1 class="page-title" style="margin-bottom:0">Listening history</h1>
      <div style="display:flex;gap:8px">
        <a class="btn btn-outline btn-sm" href="/api/v1/me/history.csv">${icon('download')} CSV</a>
        <button class="btn btn-outline btn-sm" id="export-json">${icon('download')} Full export</button>
      </div>
    </div>
    <div class="stat-cards">
      <div class="stat-card"><div class="n">${fmtMinutes(stats.minutes * 60000)}</div><div class="l">Listened this month</div></div>
      <div class="stat-card"><div class="n">${stats.plays}</div><div class="l">Plays</div></div>
      <div class="stat-card"><div class="n">${stats.unique_artists}</div><div class="l">Artists</div></div>
      <div class="stat-card"><div class="n">${stats.streak_days}</div><div class="l">Day streak</div></div>
    </div>
    <div class="section-head"><h2 class="section-title">Minutes per day</h2></div>
    ${barsChart(dayRows, 'minutes')}
    <div class="section-head"><h2 class="section-title">When you listen</h2></div>
    <div class="hour-chart">${hourRows.map((h, i) => `<div class="bar" style="height:${Math.max(2, (h.minutes / Math.max(1, ...hourRows.map(x => x.minutes))) * 100)}%" title="${i}:00 — ${h.minutes} min"></div>`).join('')}</div>
    <div class="field-row" style="margin-top:34px">
      <div style="flex:1">
        <div class="section-head" style="margin-top:0"><h2 class="section-title">Top tracks</h2></div>
        <div class="top-list">${topTracks.items.map((it, i) => trackRow(it.track, i + 1, { showArtist: true })).join('') || '<p style="color:var(--text-faint);font-size:13px">Not enough plays yet.</p>'}</div>
      </div>
      <div style="flex:1">
        <div class="section-head" style="margin-top:0"><h2 class="section-title">Top artists</h2></div>
        <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr))">${topArtists.items.map((it) => artistCard(it.artist)).join('') || '<p style="color:var(--text-faint);font-size:13px">Not enough plays yet.</p>'}</div>
      </div>
    </div>
    <div class="section-head"><h2 class="section-title">Recently played</h2></div>
    <div class="row-list">${hist.items.map((h, i) => historyRow(h, i)).join('') || '<p style="color:var(--text-faint);font-size:13px">Nothing played yet.</p>'}</div>
    <p style="color:var(--text-faint);font-size:12.5px;margin-top:20px">Want to build something with this data? Every number on this page is also available over the <a href="#/developer" style="color:var(--gold-hi)">Aurelune API</a> — the same one this page calls.</p>
  `;
  root.querySelector('#export-json').addEventListener('click', () => { window.open('/api/v1/me/export', '_blank'); });
}

/* ============================================================ Studio (creator dashboard) ============================================================ */

let studioRoot = null; // the element the Studio renders into, so the page switcher can re-render it

async function studio(root, { newPage = false } = {}) {
  studioRoot = root;
  root.innerHTML = `<p class="page-sub">Loading your studio…</p>`;
  let d;
  try { d = await api.get('/studio'); }
  catch (e) {
    if (e.code !== 'no_such_page') throw e;
    setActivePage(''); // the remembered page no longer exists (removed, or a different account signed in)
    d = await api.get('/studio');
  }
  if (d.creator && getActivePage() !== d.creator.id) setActivePage(d.creator.id);
  if (newPage && d.slots?.can_create) return studioRequestForm(root, {}, { d, isNew: true });
  if (!d.creator) return studioRequestForm(root, {}, { d });
  if (d.creator.status !== 'approved') return studioPending(root, d.creator, d);
  return studioDashboard(root, d);
}

/** Row of the account's creator pages with a "New page" button, shown only when there is something to switch to or add. */
function pageSwitcher(d, { adding = false } = {}) {
  const pages = d?.pages || [];
  const slots = d?.slots;
  if (!slots || (pages.length <= 1 && !slots.can_create)) return '';
  const active = getActivePage();
  const note = slots.unlimited ? `${slots.used} page${slots.used === 1 ? '' : 's'}, no limit`
    : slots.can_create ? `${slots.used} of ${slots.limit} pages used`
    : slots.used > slots.limit ? `${slots.used} pages. Your limit is now ${slots.limit}, so you can't add more. Ask an admin if you need more`
    : `${slots.used} of ${slots.limit} pages used. Ask an admin if you need more`;
  return `<div class="page-switch">
    <div class="ps-list" role="tablist" aria-label="Your creator pages">
      ${pages.map((p) => `<button type="button" class="ps-item ${!adding && p.id === active ? 'active' : ''}" data-page="${p.id}" role="tab" title="${esc(p.name)} (${p.status})">
        <img src="${esc(p.image)}" alt=""><span class="ps-name">${p.private ? lockBadge() : ''}${esc(p.name)}</span><i class="ps-dot ${p.status}"></i></button>`).join('')}
      ${slots.can_create ? `<button type="button" class="ps-item ps-add ${adding ? 'active' : ''}" data-new-page>${icon('plus')}<span class="ps-name">New page</span></button>` : ''}
    </div>
    <div class="ps-note">${esc(note)}</div>
  </div>`;
}

function wirePageSwitcher(root) {
  root.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { setActivePage(b.dataset.page); studio(studioRoot || root); }));
  root.querySelector('[data-new-page]')?.addEventListener('click', () => studio(studioRoot || root, { newPage: true }));
}

function studioRequestForm(root, prefill = {}, { d = null, isNew = false, pageId = null, embedded = false } = {}) {
  const first = !d?.pages?.length;
  root.innerHTML = `
    ${embedded ? '' : pageSwitcher(d, { adding: isNew })}
    ${embedded ? '' : `<h1 class="page-title">${isNew ? 'Add another creator page' : 'Set up your creator page'}</h1>
    <p class="page-sub">${isNew ? 'A separate page with its own name, music, shows and followers. An admin reviews it before it goes live.' : 'Tell listeners who you are. An admin reviews every request before it goes live.'}</p>`}
    <div style="max-width:480px">
      <div class="field"><label>Name</label><input type="text" id="f-name" value="${esc(prefill.name || '')}" placeholder="Your artist or show name"></div>
      <div class="field"><label>What will you publish?</label>
        <select id="f-focus">
          <option value="music" ${prefill.focus !== 'podcasts' && prefill.focus !== 'both' ? 'selected' : ''}>Music</option>
          <option value="podcasts" ${prefill.focus === 'podcasts' ? 'selected' : ''}>Podcasts</option>
          <option value="both" ${prefill.focus === 'both' ? 'selected' : ''}>Both</option>
        </select>
      </div>
      <div class="field"><label>Bio</label><textarea id="f-bio" placeholder="A couple of sentences for your page.">${esc(prefill.bio || '')}</textarea></div>
      <button class="btn btn-primary" id="submit-request">Submit for review</button>
      ${isNew && !first ? `<button class="btn btn-ghost" id="cancel-new" style="margin-left:8px">Cancel</button>` : ''}
    </div>`;
  wirePageSwitcher(root);
  root.querySelector('#cancel-new')?.addEventListener('click', () => studio(studioRoot || root));
  root.querySelector('#submit-request').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const name = root.querySelector('#f-name').value.trim();
    if (!name) return toast('Give your page a name', { err: true });
    btn.disabled = true;
    try {
      const out = await api.post('/studio/request', { name, focus: root.querySelector('#f-focus').value, bio: root.querySelector('#f-bio').value.trim(), ...(pageId ? { page_id: pageId } : {}) });
      if (out.creator?.id) setActivePage(out.creator.id); // jump to the page that was just created or re-submitted
      const me = await api.get('/me'); setUser(me.user);
      toast('Request submitted');
      studio(studioRoot || root);
    } catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
  });
}

function studioPending(root, c, d) {
  const status = c.status;
  root.innerHTML = `
    ${pageSwitcher(d)}
    <h1 class="page-title">${esc(c.name)}</h1>
    <div class="callout ${status === 'pending' ? 'warn' : 'err'}" style="max-width:520px">
      ${status === 'pending' ? `<b>${esc(c.name)}</b> is waiting for review. This usually doesn't take long.`
        : status === 'suspended' ? `<b>${esc(c.name)}</b> has been suspended.${c.review_note ? ` ${esc(c.review_note)}` : ''}`
        : `Your request for <b>${esc(c.name)}</b> wasn't approved.${c.review_note ? ` ${esc(c.review_note)}` : ''}`}
    </div>
    ${status === 'rejected' ? `<div style="margin-top:20px;max-width:480px" id="retry-slot"></div>` : ''}
    ${status === 'pending' || status === 'rejected' ? `<div style="margin-top:16px"><button class="btn btn-ghost btn-sm" id="drop-page">Withdraw this request</button></div>` : ''}
  `;
  wirePageSwitcher(root);
  if (status === 'rejected') studioRequestForm(root.querySelector('#retry-slot'), c, { d, pageId: c.id, embedded: true });
  root.querySelector('#drop-page')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`Withdraw the request for “${esc(c.name)}”? This frees up the page slot.`, { confirmText: 'Withdraw' }))) return;
    try {
      await api.del(`/studio/pages/${c.id}`);
      setActivePage('');
      const me = await api.get('/me'); setUser(me.user);
      studio(studioRoot || root);
    } catch (err) { toast(err.message, { err: true }); }
  });
}

const STUDIO_TABS = [['overview', 'Overview'], ['tracks', 'Tracks'], ['albums', 'Albums'], ['shows', 'Podcasts'], ['collabs', 'Collaborations'], ['profile', 'Profile']];

function studioDashboard(root, d, activeTab = 'overview') {
  const c = d.creator;
  root.innerHTML = `
    ${pageSwitcher(d)}
    <div class="section-head" style="margin-top:0">
      <div><h1 class="page-title" style="margin-bottom:2px">${esc(c.name)}</h1><p style="color:var(--text-dim);font-size:13.5px">Your creator studio</p></div>
      <a class="link-more" href="#/artist/${c.slug}">View public page</a>
    </div>
    <div class="tabs">${STUDIO_TABS.filter(([k]) => k !== 'shows' || c.focus !== 'music').filter(([k]) => k !== 'albums' || c.focus !== 'podcasts').map(([k, l]) => `<button data-tab="${k}" class="${k === activeTab ? 'active' : ''}">${l}${k === 'collabs' && d.pending_invites ? ` <span class="tab-badge">${d.pending_invites}</span>` : ''}</button>`).join('')}</div>
    <div id="tab-body"></div>`;
  wirePageSwitcher(root);
  const body = root.querySelector('#tab-body');
  const reload = (tab) => api.get('/studio').then((fresh) => studioDashboard(root, fresh, tab));
  const renderers = {
    overview: () => studioOverview(body, d, reload),
    tracks: () => studioTracks(body, d, reload),
    albums: () => studioAlbums(body, d, reload),
    shows: () => studioShows(body, d, reload),
    collabs: () => studioCollabs(body, d, reload),
    profile: () => studioProfile(body, d, reload),
  };
  root.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => studioDashboard(root, d, btn.dataset.tab)));
  renderers[activeTab]();
}

function studioOverview(body, d, reload) {
  const s = d.stats;
  const max = Math.max(1, ...s.by_day.map((x) => x.plays));
  body.innerHTML = `
    <div class="stat-cards">
      <div class="stat-card"><div class="n">${fmtCount(s.followers)}</div><div class="l">Followers</div></div>
      <div class="stat-card"><div class="n">${fmtCount(s.total_plays)}</div><div class="l">All-time plays</div></div>
      <div class="stat-card"><div class="n">${fmtCount(s.listeners_30d)}</div><div class="l">Listeners (30d)</div></div>
      <div class="stat-card"><div class="n">${fmtCount(s.minutes_30d)}</div><div class="l">Minutes (30d)</div></div>
    </div>
    <div class="section-head"><h2 class="section-title">Plays per day</h2></div>
    <div class="bars-chart">${s.by_day.map((x) => `<div class="bar-col"><div class="bar" style="height:${Math.max(2, (x.plays / max) * 100)}%" title="${x.plays} plays"></div><div class="lbl"></div></div>`).join('')}</div>
  `;
}

function uploadDropzone(id, accept, label) {
  return `<label class="file-drop" id="${id}-drop">
    <input type="file" id="${id}" accept="${accept}">
    <div class="icon">${icon('upload')}</div>
    <div class="txt"><b id="${id}-name">${label}</b><br>or drag a file here</div>
  </label>`;
}
function wireDropzone(root, id) {
  const input = root.querySelector(`#${id}`);
  input.addEventListener('change', () => { const n = root.querySelector(`#${id}-name`); if (input.files[0]) n.textContent = input.files[0].name; });
  return input;
}

const STORAGE_LABEL = { local: 'This server', postfile: 'PostFile' };
const STORAGE_NOTE = {
  local: 'Stored encrypted on this server and streamed only to signed-in listeners.',
  postfile: 'Hosted on PostFile. Anyone who has a file’s link can download it, and it isn’t encrypted — that’s how PostFile works.',
};

/**
 * Renders the storage picker into `#slotId`. The dropdown only appears when there's a real choice; a short,
 * honest note about what the chosen option means is always shown. With `fileInputId`, the whole slot stays
 * hidden until a file is picked (so editing a title doesn't show storage options nobody needs).
 */
function mountStorage(root, slotId, { fileInputId, onChange } = {}) {
  const slot = root.querySelector(`#${slotId}`);
  let driver = null;
  if (fileInputId) {
    slot.style.display = 'none';
    root.querySelector(`#${fileInputId}`).addEventListener('change', (e) => { slot.style.display = e.target.files[0] ? '' : 'none'; });
  }
  getStorageOptions().then((opts) => {
    driver = opts.default;
    if (!opts.drivers.length) {
      slot.innerHTML = '<div class="callout err" style="font-size:12.5px">Uploads aren’t set up on this server yet. The site owner needs to set <b>POSTFILE_API_KEY</b> (or run on a host with a persistent disk).</div>';
      return;
    }
    slot.innerHTML = `${opts.drivers.length > 1 ? `<div class="field"><label>Store file on</label><select data-storage>${opts.drivers.map((dr) => `<option value="${dr}" ${dr === opts.default ? 'selected' : ''}>${STORAGE_LABEL[dr]}</option>`).join('')}</select></div>` : ''}<div class="callout" data-storage-note style="font-size:12.5px"></div>`;
    const sel = slot.querySelector('[data-storage]');
    const refresh = () => { driver = sel ? sel.value : opts.default; slot.querySelector('[data-storage-note]').textContent = STORAGE_NOTE[driver]; onChange?.(); };
    sel?.addEventListener('change', refresh);
    refresh();
  }).catch(() => { slot.innerHTML = ''; });
  return { driver: () => driver };
}

/** Checks an image against the chosen storage and host limits before it's sent anywhere. */
async function prepareImage(file, storage) {
  const opts = await getStorageOptions();
  if (!opts.drivers.length) return { error: 'Uploads aren’t set up on this server yet.' };
  const driver = storage.driver() || opts.default;
  const plan = planUpload({ file, kind: 'image', driver, opts });
  return plan.route === 'blocked' ? { error: plan.reason } : { driver };
}

/** Public/Private pill: clicking it flips the item (handled by wireVisibility). */
const visPill = (published, attr = 'data-toggle-vis') => `<button type="button" class="vis-pill ${published ? 'public' : 'private'}" ${attr}="${published ? '1' : '0'}" title="${published ? 'Public: click to make private' : 'Private: only you can see it. Click to make public'}">${published ? 'Public' : `${icon('lock')} Private`}</button>`;
function wireVisibility(body, kind, reload, attr = 'data-toggle-vis') {
  body.querySelectorAll(`[${attr}]`).forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.closest('tr, [data-id]').dataset.id;
    const makePrivate = btn.getAttribute(attr) === '1';
    btn.disabled = true;
    try {
      await api.patch(`/studio/${kind}/${id}`, { visibility: makePrivate ? 'private' : 'public' });
      toast(makePrivate ? 'Now private: only you can find and play it' : 'Now public');
      reload(kind === 'tracks' ? 'tracks' : 'shows');
    } catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
  }));
}

function studioTracks(body, d, reload) {
  body.innerHTML = `
    <div class="detail-actions" style="margin-bottom:18px"><button class="btn btn-primary" id="upload-track">${icon('upload')} Upload track</button></div>
    <table class="data-table"><thead><tr><th></th><th>Title</th><th>Album</th><th>Plays</th><th>Storage</th><th>Visibility</th><th></th></tr></thead>
    <tbody>${d.tracks.map((t) => `<tr data-id="${t.id}">
      <td><div class="mini-cover"><img src="${t.cover}"></div></td>
      <td>${esc(t.title)}${t.collaborators?.length ? `<div style="color:var(--text-faint);font-size:12px">with ${t.collaborators.map((c) => esc(c.name) + (c.status === 'pending' ? ' (invited)' : '')).join(', ')}</div>` : ''}</td><td>${esc(t.album?.title || '—')}</td><td>${fmtCount(t.plays)}</td><td>${STORAGE_LABEL[t.storage] || 'This server'}</td>
      <td>${visPill(t.published)}</td>
      <td style="text-align:right"><button class="icon-btn" data-edit-track>${icon('edit')}</button> <button class="icon-btn" data-del-track>${icon('trash')}</button></td>
    </tr>`).join('') || `<tr><td colspan="7" style="text-align:center;color:var(--text-faint);padding:30px">No tracks yet.</td></tr>`}</tbody></table>
  `;
  body.querySelector('#upload-track').addEventListener('click', () => trackFormModal(null, d, reload));
  wireVisibility(body, 'tracks', reload);
  body.querySelectorAll('[data-edit-track]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.closest('tr').dataset.id;
    const full = await api.get(`/studio/tracks/${id}`);
    trackFormModal(full.track, d, reload);
  }));
  body.querySelectorAll('[data-del-track]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.closest('tr').dataset.id;
    if (!(await confirmDialog('This track will be permanently deleted.'))) return;
    await api.del(`/studio/tracks/${id}`).catch((err) => toast(err.message, { err: true }));
    reload('tracks');
  }));
}

/**
 * "Credit other artists" field: type to search existing artist pages, click to add. Pages you own are credited at once;
 * anyone else's get an invitation and appear on the item once they accept.
 */
function collabPicker(mount, initial = []) {
  let chosen = initial.map((c) => ({ id: c.id, name: c.name, status: c.status }));
  mount.innerHTML = `
    <div class="field"><label>Collaborators</label>
      <div class="collab-chips" data-chips></div>
      <div class="collab-search"><input type="text" data-q placeholder="Search artists to credit…" autocomplete="off"><div class="collab-results" data-results hidden></div></div>
      <span class="hint">Your own other pages are credited right away. Other artists get an invitation, and the track shows on their page once they accept.</span>
    </div>`;
  const chips = mount.querySelector('[data-chips]'), q = mount.querySelector('[data-q]'), results = mount.querySelector('[data-results]');
  const drawChips = () => {
    chips.innerHTML = chosen.map((c) => `<span class="chip collab-chip" data-id="${c.id}">${esc(c.name)}${c.status === 'pending' ? ' <em>invited</em>' : ''}<button type="button" data-rm aria-label="Remove ${esc(c.name)}">×</button></span>`).join('');
    chips.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { chosen = chosen.filter((c) => c.id !== b.parentElement.dataset.id); drawChips(); }));
  };
  let timer = 0, seq = 0;
  const search = async () => {
    const mine = ++seq;
    let artists = [];
    try { artists = (await api.get('/studio/artists', { q: q.value.trim() })).artists; } catch { /* leave the list empty */ }
    if (mine !== seq) return;
    const fresh = artists.filter((a) => !chosen.some((c) => c.id === a.id));
    results.hidden = !fresh.length && !q.value.trim();
    results.innerHTML = fresh.length
      ? fresh.map((a) => `<button type="button" class="collab-opt" data-id="${a.id}" data-name="${esc(a.name)}" data-mine="${a.mine ? 1 : 0}"><img src="${a.image}" alt=""><span>${esc(a.name)}</span>${a.mine ? '<small>your page</small>' : ''}</button>`).join('')
      : '<div class="collab-none">No artists found</div>';
    results.querySelectorAll('.collab-opt').forEach((o) => o.addEventListener('click', () => {
      if (chosen.length >= 8) return toast('You can credit up to 8 other pages', { err: true });
      chosen.push({ id: o.dataset.id, name: o.dataset.name, status: o.dataset.mine === '1' ? 'accepted' : 'pending' });
      q.value = ''; results.hidden = true; drawChips();
    }));
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 220); });
  q.addEventListener('focus', search);
  document.addEventListener('click', (e) => { if (!mount.contains(e.target)) results.hidden = true; });
  drawChips();
  return { ids: () => chosen.map((c) => c.id) };
}

function studioCollabs(body, d, reload) {
  body.innerHTML = '<p class="page-sub">Loading…</p>';
  api.get('/studio/collabs').then(({ collabs }) => {
    const row = (c) => `<tr data-kind="${c.kind}" data-id="${c.id}" data-page="${c.page.id}">
      <td><div class="mini-cover"><img src="${c.cover}"></div></td>
      <td>${esc(c.title)}<div style="color:var(--text-faint);font-size:12px">${c.kind === 'episode' ? 'Episode' : 'Song'} by ${esc(c.by.name)}</div></td>
      <td>${esc(c.page.name)}</td>
      <td style="text-align:right;white-space:nowrap">${c.status === 'pending'
        ? '<button class="btn btn-primary btn-sm" data-answer="accept">Accept</button> <button class="btn btn-ghost btn-sm" data-answer="decline">Decline</button>'
        : '<span style="color:var(--text-faint);font-size:12px;margin-right:10px">Credited</span><button class="btn btn-ghost btn-sm" data-answer="decline">Leave</button>'}</td></tr>`;
    const pending = collabs.filter((c) => c.status === 'pending'), done = collabs.filter((c) => c.status !== 'pending');
    body.innerHTML = `
      <p style="color:var(--text-dim);font-size:13.5px;margin-bottom:18px;max-width:620px">Other artists can credit your pages on their songs and episodes. Accepted ones show on your page and in your search results; you can leave any time.</p>
      <div class="section-head"><h2 class="section-title">Invitations</h2></div>
      ${pending.length ? `<table class="data-table"><tbody>${pending.map(row).join('')}</tbody></table>` : '<p style="color:var(--text-faint);margin-bottom:24px">No invitations waiting.</p>'}
      <div class="section-head"><h2 class="section-title">Credited on</h2></div>
      ${done.length ? `<table class="data-table"><tbody>${done.map(row).join('')}</tbody></table>` : '<p style="color:var(--text-faint)">Nothing yet.</p>'}`;
    body.querySelectorAll('[data-answer]').forEach((b) => b.addEventListener('click', async (e) => {
      const btn = e.currentTarget; // capture now: currentTarget is null after any await
      const tr = btn.closest('tr'); const act = btn.dataset.answer;
      btn.disabled = true;
      try {
        await api.post(`/studio/collabs/${tr.dataset.kind}/${tr.dataset.id}/${act}`, { page_id: tr.dataset.page });
        toast(act === 'accept' ? 'Added to your page' : 'Done');
        reload('collabs');
      } catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
    }));
  }).catch((err) => { body.innerHTML = `<p class="page-sub">${esc(err.message)}</p>`; });
}

function trackFormModal(existing, d, reload) {
  const isEdit = !!existing;
  const m = openModal({
    title: isEdit ? 'Edit track' : 'Upload a track',
    wide: true,
    body: `
      ${!isEdit ? uploadDropzone('tf-audio', 'audio/*', 'Choose an audio file') : ''}
      ${!isEdit ? '<div class="hint" id="tf-route-hint" style="margin-top:8px;font-size:12.5px;color:var(--text-dim)"></div><div id="tf-storage-slot" style="margin-top:14px"></div>' : ''}
      <div class="field" style="margin-top:16px"><label>Title</label><input type="text" id="tf-title" value="${esc(existing?.title || '')}" placeholder="Track title (or leave blank to use the file tags)"></div>
      <div class="field-row">
        <div class="field"><label>Genre</label><input type="text" id="tf-genre" value="${esc(existing?.genre || '')}" placeholder="e.g. Indie Pop"></div>
        <div class="field"><label>Album</label><select id="tf-album"><option value="">None (single)</option>${d.albums.map((a) => `<option value="${a.id}" ${existing?.album?.id === a.id ? 'selected' : ''}>${esc(a.title)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Credits</label><input type="text" id="tf-credits" value="${esc(existing?.credits || '')}" placeholder="Written and produced by…"></div>
      <div id="tf-collabs"></div>
      <div class="field"><label>Lyrics</label><textarea id="tf-lyrics" placeholder="Plain text, or LRC with [mm:ss.xx] / [hh:mm:ss.xx] timestamps for synced lyrics" style="min-height:120px">${esc(existing?.lyrics || '')}</textarea><span class="hint">Lines like [00:12.50] sync to playback automatically. Past an hour use [HH:MM:SS.xx], for example [01:02:03.50].</span></div>
      <div class="switch-row"><div class="copy"><div class="title">Explicit content</div></div><div class="switch ${existing?.explicit ? 'on' : ''}" id="tf-explicit"></div></div>
      <div class="switch-row"><div class="copy"><div class="title">Public</div><div class="desc">Turn off to make it private: only you can find, play and see it. Everyone else never knows it exists.</div></div><div class="switch ${existing?.published !== false ? 'on' : ''}" id="tf-published"></div></div>
    `,
    footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="tf-save">${isEdit ? 'Save changes' : 'Upload'}</button>`,
  });
  const collabs = collabPicker(m.el.querySelector('#tf-collabs'), existing?.collaborators || []);
  if (!isEdit) wireDropzone(m.el, 'tf-audio');
  const storage = isEdit ? null : mountStorage(m.el, 'tf-storage-slot', { onChange: () => updateRouteHint() });
  async function updateRouteHint() {
    const f = m.el.querySelector('#tf-audio')?.files[0];
    const hint = m.el.querySelector('#tf-route-hint');
    if (!hint) return;
    if (!f) { hint.textContent = ''; return; }
    const opts = await getStorageOptions();
    const plan = planUpload({ file: f, kind: 'audio', driver: storage.driver() || opts.default, opts });
    hint.textContent = describeRoute(plan);
    hint.style.color = plan.route === 'blocked' ? 'var(--pink)' : 'var(--text-dim)';
  }
  m.el.querySelector('#tf-audio')?.addEventListener('change', updateRouteHint);
  let explicit = !!existing?.explicit, published = existing?.published !== false;
  m.el.querySelector('#tf-explicit').addEventListener('click', (e) => { explicit = !explicit; e.currentTarget.classList.toggle('on'); });
  m.el.querySelector('#tf-published').addEventListener('click', (e) => { published = !published; e.currentTarget.classList.toggle('on'); });
  m.el.querySelector('#tf-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const audioFile = m.el.querySelector('#tf-audio')?.files[0];
    if (!isEdit && !audioFile) return toast('Choose an audio file', { err: true });
    const meta = {
      title: m.el.querySelector('#tf-title').value.trim(), genre: m.el.querySelector('#tf-genre').value.trim(),
      album_id: m.el.querySelector('#tf-album').value, credits: m.el.querySelector('#tf-credits').value.trim(),
      lyrics: m.el.querySelector('#tf-lyrics').value, explicit, published, collaborators: JSON.stringify(collabs.ids()),
    };
    btn.disabled = true; btn.textContent = isEdit ? 'Saving…' : 'Uploading…';
    try {
      if (isEdit) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(meta)) fd.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : v);
        await api.patchForm(`/studio/tracks/${existing.id}`, fd);
      } else {
        const opts = await getStorageOptions();
        if (!opts.drivers.length) throw new UploadError('Uploads aren’t set up on this server yet.', 'blocked');
        await uploadTrack({ file: audioFile, meta, driver: storage.driver() || opts.default, opts, onProgress: (p) => { btn.textContent = `Uploading… ${Math.round(p * 100)}%`; } });
      }
      toast(isEdit ? 'Track updated' : 'Track uploaded');
      m.close(); reload('tracks');
    } catch (err) { toast(err.message, { err: true }); btn.disabled = false; btn.textContent = isEdit ? 'Save changes' : 'Upload'; }
  });
}

function studioAlbums(body, d, reload) {
  body.innerHTML = `
    <div class="detail-actions" style="margin-bottom:18px"><button class="btn btn-primary" id="new-album">${icon('plus')} New release</button></div>
    <div class="grid">${d.albums.map((a) => `<div class="card" data-id="${a.id}"><div class="art-wrap"><img src="${a.cover}"></div><div class="title">${esc(a.title)}</div><div class="sub">${a.track_count} tracks</div>
      <div style="display:flex;gap:6px;margin-top:8px"><button class="btn btn-outline btn-sm" data-edit-album style="flex:1">Edit</button><button class="icon-btn" data-del-album>${icon('trash')}</button></div>
    </div>`).join('') || '<p style="color:var(--text-faint)">No releases yet.</p>'}</div>
  `;
  body.querySelector('#new-album').addEventListener('click', () => albumFormModal(null, reload));
  body.querySelectorAll('[data-edit-album]').forEach((b) => b.addEventListener('click', (e) => {
    const id = e.currentTarget.closest('.card').dataset.id;
    albumFormModal(d.albums.find((a) => a.id === id), reload);
  }));
  body.querySelectorAll('[data-del-album]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.closest('.card').dataset.id;
    if (!(await confirmDialog('Tracks in this release will become standalone singles.'))) return;
    await api.del(`/studio/albums/${id}`).catch((err) => toast(err.message, { err: true }));
    reload('albums');
  }));
}

function albumFormModal(existing, reload) {
  const isEdit = !!existing;
  const m = openModal({
    title: isEdit ? 'Edit release' : 'New release',
    body: `
      ${uploadDropzone('af-cover', 'image/*', existing ? 'Replace cover art' : 'Cover art (optional)')}
      <div id="af-storage-slot" style="margin-top:12px"></div>
      <div class="field" style="margin-top:16px"><label>Title</label><input type="text" id="af-title" value="${esc(existing?.title || '')}"></div>
      <div class="field-row">
        <div class="field"><label>Type</label><select id="af-kind"><option value="album" ${existing?.kind === 'album' ? 'selected' : ''}>Album</option><option value="ep" ${existing?.kind === 'ep' ? 'selected' : ''}>EP</option><option value="single" ${existing?.kind === 'single' ? 'selected' : ''}>Single</option></select></div>
        <div class="field"><label>Release date</label><input type="date" id="af-date" value="${existing ? new Date(existing.released_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="field"><label>Description</label><textarea id="af-desc">${esc(existing?.description || '')}</textarea></div>
    `,
    footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="af-save">${isEdit ? 'Save' : 'Create'}</button>`,
  });
  wireDropzone(m.el, 'af-cover');
  const storage = mountStorage(m.el, 'af-storage-slot', { fileInputId: 'af-cover' });
  m.el.querySelector('#af-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // capture now: currentTarget is null after any await
    const fd = new FormData();
    const cover = m.el.querySelector('#af-cover').files[0];
    if (cover) { const r = await prepareImage(cover, storage); if (r.error) return toast(r.error, { err: true }); fd.append('cover', cover); fd.append('storage', r.driver); }
    fd.append('title', m.el.querySelector('#af-title').value.trim());
    fd.append('kind', m.el.querySelector('#af-kind').value);
    fd.append('released_at', m.el.querySelector('#af-date').value);
    fd.append('description', m.el.querySelector('#af-desc').value);
    if (!fd.get('title')) return toast('Give it a title', { err: true });
    btn.disabled = true;
    try { await (isEdit ? api.patchForm(`/studio/albums/${existing.id}`, fd) : api.postForm('/studio/albums', fd)); m.close(); reload('albums'); }
    catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
  });
}

function studioShows(body, d, reload) {
  body.innerHTML = `
    <div class="detail-actions" style="margin-bottom:18px"><button class="btn btn-primary" id="new-show">${icon('plus')} New podcast</button></div>
    <div id="shows-list">${d.shows.map((s) => `<div class="callout" style="display:flex;gap:14px;align-items:center;margin-bottom:12px" data-id="${s.id}">
      <div class="mini-cover" style="width:52px;height:52px"><img src="${s.cover}"></div>
      <div style="flex:1"><b style="color:var(--text)">${s.private ? lockBadge() : ''}${esc(s.title)}</b><div style="font-size:12.5px">${s.episode_count} episode${s.episode_count === 1 ? '' : 's'}${s.public_episode_count === 0 && !s.private ? ' · listeners can\'t see this podcast until it has a public episode' : ''}</div></div>
      ${visPill(!s.private, 'data-toggle-show-vis')}
      <button class="btn btn-outline btn-sm" data-add-ep>Add episode</button>
      <button class="btn btn-outline btn-sm" data-edit-show>Edit</button>
      <button class="icon-btn" data-del-show>${icon('trash')}</button>
    </div>`).join('') || '<p style="color:var(--text-faint)">No podcasts yet.</p>'}</div>
    <div class="section-head"><h2 class="section-title">Episodes</h2></div>
    <table class="data-table"><thead><tr><th>Title</th><th>Show</th><th>Plays</th><th>Storage</th><th>Visibility</th><th></th></tr></thead>
    <tbody>${d.episodes.map((ep) => `<tr data-id="${ep.id}"><td>${esc(ep.title)}</td><td>${esc(ep.show.title)}</td><td>${fmtCount(ep.plays)}</td><td>${STORAGE_LABEL[ep.storage] || 'This server'}</td><td>${visPill(ep.published)}</td>
      <td style="text-align:right"><button class="icon-btn" data-del-ep>${icon('trash')}</button></td></tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:24px">No episodes yet.</td></tr>`}</tbody></table>
  `;
  body.querySelector('#new-show').addEventListener('click', () => showFormModal(null, reload));
  wireVisibility(body, 'episodes', reload);
  wireVisibility(body, 'shows', reload, 'data-toggle-show-vis');
  body.querySelectorAll('[data-edit-show]').forEach((b) => b.addEventListener('click', (e) => showFormModal(d.shows.find((s) => s.id === e.currentTarget.closest('[data-id]').dataset.id), reload)));
  body.querySelectorAll('[data-add-ep]').forEach((b) => b.addEventListener('click', (e) => episodeFormModal(e.currentTarget.closest('[data-id]').dataset.id, reload)));
  body.querySelectorAll('[data-del-show]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.closest('[data-id]').dataset.id;
    if (!(await confirmDialog('This podcast and all its episodes will be deleted.'))) return;
    await api.del(`/studio/shows/${id}`).catch((err) => toast(err.message, { err: true }));
    reload('shows');
  }));
  body.querySelectorAll('[data-del-ep]').forEach((b) => b.addEventListener('click', async (e) => {
    const id = e.currentTarget.closest('tr').dataset.id;
    if (!(await confirmDialog('This episode will be permanently deleted.'))) return;
    await api.del(`/studio/episodes/${id}`).catch((err) => toast(err.message, { err: true }));
    reload('shows');
  }));
}

function showFormModal(existing, reload) {
  const isEdit = !!existing;
  const m = openModal({
    title: isEdit ? 'Edit podcast' : 'New podcast',
    body: `
      ${uploadDropzone('sf-cover', 'image/*', existing ? 'Replace cover art' : 'Cover art (optional)')}
      <div id="sf-storage-slot" style="margin-top:12px"></div>
      <div class="field" style="margin-top:16px"><label>Title</label><input type="text" id="sf-title" value="${esc(existing?.title || '')}"></div>
      <div class="field-row">
        <div class="field"><label>Category</label><input type="text" id="sf-category" value="${esc(existing?.category || '')}" placeholder="e.g. Technology"></div>
        <div class="field"><label>Language</label><input type="text" id="sf-lang" value="${esc(existing?.language || 'en')}" placeholder="en"></div>
      </div>
      <div class="field"><label>Description</label><textarea id="sf-desc">${esc(existing?.description || '')}</textarea></div>
      <div class="switch-row"><div class="copy"><div class="title">Explicit content</div></div><div class="switch ${existing?.explicit ? 'on' : ''}" id="sf-explicit"></div></div>
      <div class="switch-row"><div class="copy"><div class="title">Public</div><div class="desc">Turn off to make the whole podcast private: only you and admins can find it, and its episodes with it. A public podcast also stays out of listeners' sight until it has a public episode.</div></div><div class="switch ${existing?.private ? '' : 'on'}" id="sf-public"></div></div>
    `,
    footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="sf-save">${isEdit ? 'Save' : 'Create'}</button>`,
  });
  wireDropzone(m.el, 'sf-cover');
  const storage = mountStorage(m.el, 'sf-storage-slot', { fileInputId: 'sf-cover' });
  let explicit = !!existing?.explicit;
  m.el.querySelector('#sf-explicit').addEventListener('click', (e) => { explicit = !explicit; e.currentTarget.classList.toggle('on'); });
  let showPublic = !existing?.private;
  m.el.querySelector('#sf-public').addEventListener('click', (e) => { showPublic = !showPublic; e.currentTarget.classList.toggle('on'); });
  m.el.querySelector('#sf-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // capture now: currentTarget is null after any await
    const fd = new FormData();
    const cover = m.el.querySelector('#sf-cover').files[0];
    if (cover) { const r = await prepareImage(cover, storage); if (r.error) return toast(r.error, { err: true }); fd.append('cover', cover); fd.append('storage', r.driver); }
    fd.append('title', m.el.querySelector('#sf-title').value.trim());
    fd.append('category', m.el.querySelector('#sf-category').value.trim());
    fd.append('language', m.el.querySelector('#sf-lang').value.trim());
    fd.append('description', m.el.querySelector('#sf-desc').value);
    fd.append('explicit', explicit ? '1' : '0');
    fd.append('visibility', showPublic ? 'public' : 'private');
    if (!fd.get('title')) return toast('Give it a title', { err: true });
    btn.disabled = true;
    try { await (isEdit ? api.patchForm(`/studio/shows/${existing.id}`, fd) : api.postForm('/studio/shows', fd)); m.close(); reload('shows'); }
    catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
  });
}

function episodeFormModal(showId, reload) {
  const m = openModal({
    title: 'Add an episode', wide: true,
    body: `
      ${uploadDropzone('ef-audio', 'audio/*', 'Choose an audio file')}
      <div class="hint" id="ef-route-hint" style="margin-top:8px;font-size:12.5px;color:var(--text-dim)"></div><div id="ef-storage-slot" style="margin-top:14px"></div>
      <div class="field" style="margin-top:16px"><label>Title</label><input type="text" id="ef-title" placeholder="Episode title"></div>
      <div class="field-row">
        <div class="field"><label>Season</label><input type="number" id="ef-season" value="1" min="1"></div>
        <div class="field"><label>Number</label><input type="number" id="ef-number" value="1" min="1"></div>
      </div>
      <div id="ef-collabs"></div>
      <div class="field"><label>Description</label><textarea id="ef-desc" placeholder="What's this episode about?"></textarea></div>
      <div class="field"><label>Transcript</label><textarea id="ef-transcript" placeholder="Optional full transcript" style="min-height:100px"></textarea></div>
      <div class="switch-row"><div class="copy"><div class="title">Public</div><div class="desc">Turn off to make it private: only you can find and play it.</div></div><div class="switch on" id="ef-public"></div></div>
    `,
    footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="ef-save">Upload</button>`,
  });
  const epCollabs = collabPicker(m.el.querySelector('#ef-collabs'), []);
  wireDropzone(m.el, 'ef-audio');
  const storage = mountStorage(m.el, 'ef-storage-slot', { onChange: () => updateRouteHint() });
  async function updateRouteHint() {
    const f = m.el.querySelector('#ef-audio').files[0];
    const hint = m.el.querySelector('#ef-route-hint');
    if (!f) { hint.textContent = ''; return; }
    const opts = await getStorageOptions();
    const plan = planUpload({ file: f, kind: 'audio', driver: storage.driver() || opts.default, opts });
    hint.textContent = describeRoute(plan);
    hint.style.color = plan.route === 'blocked' ? 'var(--pink)' : 'var(--text-dim)';
  }
  m.el.querySelector('#ef-audio').addEventListener('change', updateRouteHint);
  let epPublic = true;
  m.el.querySelector('#ef-public').addEventListener('click', (e) => { epPublic = !epPublic; e.currentTarget.classList.toggle('on'); });
  m.el.querySelector('#ef-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const audio = m.el.querySelector('#ef-audio').files[0];
    if (!audio) return toast('Choose an audio file', { err: true });
    const meta = {
      title: m.el.querySelector('#ef-title').value.trim(), season: m.el.querySelector('#ef-season').value, number: m.el.querySelector('#ef-number').value,
      description: m.el.querySelector('#ef-desc').value, transcript: m.el.querySelector('#ef-transcript').value, published: epPublic, collaborators: JSON.stringify(epCollabs.ids()),
    };
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const opts = await getStorageOptions();
      if (!opts.drivers.length) throw new UploadError('Uploads aren’t set up on this server yet.', 'blocked');
      await uploadEpisode({ showId, file: audio, meta, driver: storage.driver() || opts.default, opts, onProgress: (p) => { btn.textContent = `Uploading… ${Math.round(p * 100)}%`; } });
      toast(epPublic ? 'Episode published' : 'Episode saved as private'); m.close(); reload('shows');
    } catch (err) { toast(err.message, { err: true }); btn.disabled = false; btn.textContent = 'Upload'; }
  });
}

function studioProfile(body, d, reload) {
  const c = d.creator;
  body.innerHTML = `
    <div style="max-width:480px">
      ${uploadDropzone('pf-image', 'image/*', 'Replace profile image')}
      <div id="pf-storage-slot" style="margin-top:12px"></div>
      <div class="field" style="margin-top:16px"><label>Name</label><input type="text" id="pf-name" value="${esc(c.name)}"></div>
      <div class="field"><label>Bio</label><textarea id="pf-bio">${esc(c.bio || '')}</textarea></div>
      <div class="switch-row"><div class="copy"><div class="title">Public page</div><div class="desc">Turn off to make this page private: only you and Aurelune admins can find or open it, along with its songs, albums and podcasts. Nobody else sees it in search, recommendations or on your followers' pages. Flip it back any time.</div></div><div class="switch ${c.private ? '' : 'on'}" id="pf-public"></div></div>
      <button class="btn btn-primary" id="pf-save">Save changes</button>
    </div>`;
  wireDropzone(body, 'pf-image');
  const storage = mountStorage(body, 'pf-storage-slot', { fileInputId: 'pf-image' });
  let pagePublic = !c.private;
  body.querySelector('#pf-public').addEventListener('click', (e) => { pagePublic = !pagePublic; e.currentTarget.classList.toggle('on'); });
  body.querySelector('#pf-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget; // capture now: currentTarget is null after any await
    const fd = new FormData();
    const img = body.querySelector('#pf-image').files[0];
    if (img) { const r = await prepareImage(img, storage); if (r.error) return toast(r.error, { err: true }); fd.append('image', img); fd.append('storage', r.driver); }
    fd.append('name', body.querySelector('#pf-name').value.trim());
    fd.append('bio', body.querySelector('#pf-bio').value);
    fd.append('visibility', pagePublic ? 'public' : 'private');
    btn.disabled = true;
    try { await api.patchForm('/studio/profile', fd); toast(pagePublic ? 'Profile updated' : 'Profile updated: this page is now private'); reload('profile'); }
    catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
  });
}

/* ============================================================ Admin ============================================================ */

const ADMIN_TABS = [['overview', 'Overview'], ['creators', 'Creator requests'], ['reports', 'Reports'], ['users', 'Users']];

async function admin(root, params, tab = 'overview') {
  root.innerHTML = `<div class="tabs">${ADMIN_TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div><div id="admin-body"><p class="page-sub">Loading…</p></div>`;
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => admin(root, params, b.dataset.tab)));
  const body = root.querySelector('#admin-body');
  if (tab === 'overview') {
    const o = await api.get('/admin/overview');
    body.innerHTML = `<div class="stat-cards">
      <div class="stat-card"><div class="n">${fmtCount(o.users)}</div><div class="l">Listeners</div></div>
      <div class="stat-card"><div class="n">${fmtCount(o.creators)}</div><div class="l">Approved creators</div></div>
      <div class="stat-card"><div class="n">${o.pending_requests}</div><div class="l">Pending requests</div></div>
      <div class="stat-card"><div class="n">${fmtCount(o.tracks)}</div><div class="l">Tracks</div></div>
      <div class="stat-card"><div class="n">${fmtCount(o.episodes)}</div><div class="l">Episodes</div></div>
      <div class="stat-card"><div class="n">${fmtCount(o.plays_24h)}</div><div class="l">Plays (24h)</div></div>
    </div>`;
  } else if (tab === 'creators') {
    const renderCreators = async (status) => {
      const { creators } = await api.get('/admin/creators', { status });
      body.innerHTML = `
        <div class="chip-row" style="margin-bottom:18px">${['pending', 'approved', 'rejected', 'suspended'].map((s) => `<button class="chip ${s === status ? 'active' : ''}" data-status="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
        <table class="data-table"><thead><tr><th></th><th>Name</th><th>Owner</th><th>Focus</th><th>Requested</th><th></th></tr></thead>
        <tbody>${creators.map((c) => `<tr data-id="${c.id}">
          <td><div class="mini-cover" style="border-radius:50%"><img src="${c.image}"></div></td>
          <td>${esc(c.name)}</td><td>${esc(c.user.username)}<br><span style="color:var(--text-faint);font-size:11.5px">${esc(c.user.email)}</span></td><td>${esc(c.focus)}</td><td>${fmtRelative(c.requested_at)}</td>
          <td style="text-align:right;white-space:nowrap">
            ${status === 'pending' ? `<button class="btn btn-sm btn-primary" data-act="approve">Approve</button> <button class="btn btn-sm btn-danger" data-act="reject">Reject</button>`
              : status === 'approved' ? `<button class="btn btn-sm btn-outline" data-act="${c.verified ? 'verify-off' : 'verify'}">${c.verified ? 'Unverify' : 'Verify'}</button> <button class="btn btn-sm btn-danger" data-act="suspend">Suspend</button>`
              : `<button class="btn btn-sm btn-outline" data-act="reinstate">Reinstate</button>`}
          </td>
        </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:24px">Nothing here.</td></tr>`}</tbody></table>
      `;
      body.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => renderCreators(b.dataset.status)));
      body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async (e) => {
        const id = e.currentTarget.closest('tr').dataset.id;
        const act = e.currentTarget.dataset.act;
        const map = { approve: 'approve', reject: 'reject', suspend: 'suspend', reinstate: 'reinstate', verify: 'verify', 'verify-off': 'verify' };
        const body2 = act === 'verify' ? { verified: true } : act === 'verify-off' ? { verified: false } : {};
        await api.post(`/admin/creators/${id}/${map[act]}`, body2).catch((err) => toast(err.message, { err: true }));
        renderCreators(status);
      }));
    };
    renderCreators('pending');
  } else if (tab === 'users') {
    const limitLabel = (u) => (u.creator_limit_unlimited ? 'Unlimited' : String(u.creator_limit));
    const renderUsers = async (q = '') => {
      const { users } = await api.get('/admin/users', { q });
      body.innerHTML = `
        <div class="search-box" style="margin-bottom:18px;max-width:320px">${icon('search')}<input id="u-search" placeholder="Search users" value="${esc(q)}"></div>
        <table class="data-table"><thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Creator pages</th><th>Joined</th><th></th></tr></thead>
        <tbody>${users.map((u) => `<tr data-id="${u.id}" data-name="${esc(u.username)}"><td>${esc(u.username)}</td><td>${esc(u.email)}</td><td><span class="status-pill approved">${u.role}</span></td>
          <td><b>${u.creator_pages_used}</b> / ${limitLabel(u)}${u.creator_limit_custom ? '' : ' <span style="color:var(--text-faint);font-size:11.5px">(default)</span>'}
            <button class="btn btn-sm btn-ghost" data-limit style="margin-left:6px">Change</button></td>
          <td>${fmtDate(u.created_at)}</td>
          <td style="text-align:right"><button class="btn btn-sm btn-outline" data-toggle-role="${u.role === 'admin' ? 'listener' : 'admin'}">${u.role === 'admin' ? 'Remove admin' : 'Make admin'}</button></td></tr>`).join('')}</tbody></table>`;
      body.querySelector('#u-search').addEventListener('input', (e) => { clearTimeout(body._t); body._t = setTimeout(() => renderUsers(e.target.value), 300); });
      body.querySelectorAll('[data-toggle-role]').forEach((b) => b.addEventListener('click', async (e) => {
        const id = e.currentTarget.closest('tr').dataset.id; const role = e.currentTarget.dataset.toggleRole;
        await api.patch(`/admin/users/${id}`, { role }).catch((err) => toast(err.message, { err: true }));
        renderUsers(q);
      }));
      body.querySelectorAll('[data-limit]').forEach((b) => b.addEventListener('click', (e) => {
        const tr = e.currentTarget.closest('tr');
        const u = users.find((x) => x.id === tr.dataset.id);
        const m = openModal({
          title: `Creator pages for ${esc(u.username)}`,
          body: `<p style="color:var(--text-dim);font-size:13.5px;line-height:1.6;margin-bottom:14px">${u.creator_pages_used} page${u.creator_pages_used === 1 ? '' : 's'} in use. Rejected requests don't count. Lowering the limit never removes pages they already have; it only stops new ones.</p>
            <div class="field"><label>How many pages may this account have?</label>
              <select id="cl-mode">
                <option value="default" ${!u.creator_limit_custom ? 'selected' : ''}>Server default</option>
                <option value="number" ${u.creator_limit_custom && !u.creator_limit_unlimited ? 'selected' : ''}>A set number</option>
                <option value="unlimited" ${u.creator_limit_unlimited && u.creator_limit_custom ? 'selected' : ''}>Unlimited</option>
              </select></div>
            <div class="field" id="cl-num-field"><label>Number of pages</label><input type="number" id="cl-num" min="0" max="10000" step="1" value="${u.creator_limit_unlimited ? 2 : u.creator_limit}"></div>`,
          footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="cl-save">Save</button>`,
        });
        const mode = m.el.querySelector('#cl-mode'), numField = m.el.querySelector('#cl-num-field');
        const sync = () => { numField.style.display = mode.value === 'number' ? '' : 'none'; };
        mode.addEventListener('change', sync); sync();
        m.el.querySelector('#cl-save').addEventListener('click', async (ev) => {
          const btn = ev.currentTarget;
          const creator_limit = mode.value === 'default' ? null : mode.value === 'unlimited' ? 'unlimited' : Number(m.el.querySelector('#cl-num').value);
          if (mode.value === 'number' && !(Number.isInteger(creator_limit) && creator_limit >= 0)) return toast('Enter a whole number, 0 or more', { err: true });
          btn.disabled = true;
          try { await api.patch(`/admin/users/${u.id}`, { creator_limit }); m.close(); toast('Saved'); renderUsers(q); }
          catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
        });
      }));
    };
    renderUsers();
  } else if (tab === 'reports') {
    const REASON_LABELS = { copyright: 'Copyright concern', inappropriate: 'Inappropriate content', spam: 'Spam or misleading', wrong_metadata: 'Wrong metadata', other: 'Other' };
    const renderReports = async (status = 'open') => {
      const { reports } = await api.get('/admin/reports', { status });
      body.innerHTML = `
        <div class="chip-row" style="margin-bottom:18px">${['open', 'reviewed', 'dismissed'].map((s) => `<button class="chip ${s === status ? 'active' : ''}" data-status="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
        <table class="data-table"><thead><tr><th>Item</th><th>Kind</th><th>Reason</th><th>Reported by</th><th>When</th><th></th></tr></thead>
        <tbody>${reports.map((rp) => `<tr data-id="${rp.id}">
          <td>${esc(rp.item_title)}${rp.note ? `<div style="color:var(--text-faint);font-size:11.5px;margin-top:3px;max-width:220px">${esc(rp.note)}</div>` : ''}</td>
          <td>${esc(rp.kind)}</td><td>${esc(REASON_LABELS[rp.reason] || rp.reason)}</td>
          <td>${esc(rp.user.username)}</td><td>${fmtRelative(rp.created_at)}</td>
          <td style="text-align:right;white-space:nowrap">
            ${status === 'open' ? `<button class="btn btn-sm btn-outline" data-act="reviewed">Mark reviewed</button> <button class="btn btn-sm btn-outline" data-act="dismissed">Dismiss</button>`
              : `<button class="btn btn-sm btn-outline" data-act="reopen">Reopen</button>`}
          </td>
        </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-faint);padding:24px">Nothing here.</td></tr>`}</tbody></table>
      `;
      body.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => renderReports(b.dataset.status)));
      body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async (e) => {
        const btn = e.currentTarget; // capture now: currentTarget is null after any await
        const id = btn.closest('tr').dataset.id;
        await api.post(`/admin/reports/${id}/${btn.dataset.act}`, {}).catch((err) => toast(err.message, { err: true }));
        renderReports(status);
      }));
    };
    renderReports();
  }
}

/* ============================================================ Settings ============================================================ */

async function settings(root, params, tab = 'account') {
  const user = getUser();
  const tabs = [['account', 'Account'], ['appearance', 'Appearance'], ['sound', 'Sound'], ['password', 'Password'], ['developer', 'Developer']];
  root.innerHTML = `
    <h1 class="page-title">Settings</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="settings-body" style="max-width:560px"></div>`;
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => settings(root, params, b.dataset.tab)));
  const body = root.querySelector('#settings-body');
  if (tab === 'appearance') {
    let anim = user.animations !== false;
    body.innerHTML = `
      <div class="switch-row"><div class="copy"><div class="title">Animations</div><div class="desc">Smooth transitions, the moving now-playing indicator and the glow behind the player. Turn this off if you prefer a still interface. It does not follow your device\'s "reduce motion" setting: this switch decides.</div></div><div class="switch ${anim ? 'on' : ''}" id="s-anim" role="switch" aria-checked="${anim}" tabindex="0"></div></div>`;
    const sw = body.querySelector('#s-anim');
    const flip = async () => {
      anim = !anim; sw.classList.toggle('on', anim); sw.setAttribute('aria-checked', String(anim));
      applyAnimations(anim); // immediately, then saved to the account
      try { const r = await api.patch('/me', { animations: anim }); setUser(r.user); }
      catch (err) { toast(err.message, { err: true }); }
    };
    sw.addEventListener('click', flip);
    sw.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
  } else if (tab === 'account') {
    body.innerHTML = `
      <div class="field"><label>Display name</label><input type="text" id="s-name" value="${esc(user.display_name)}"></div>
      <div class="field"><label>Bio</label><textarea id="s-bio">${esc(user.bio || '')}</textarea></div>
      <div class="switch-row"><div class="copy"><div class="title">Share my activity</div><div class="desc">Let others see your public playlists, top artists, and what you're playing right now.</div></div><div class="switch ${user.share_activity ? 'on' : ''}" id="s-share"></div></div>
      <button class="btn btn-primary" id="s-save" style="margin-top:14px">Save changes</button>
      <div style="margin-top:34px;border-top:1px solid var(--hairline);padding-top:20px">
        <button class="btn btn-outline" id="s-logout">${icon('logout')} Sign out</button>
      </div>`;
    let share = !!user.share_activity;
    body.querySelector('#s-share').addEventListener('click', (e) => { share = !share; e.currentTarget.classList.toggle('on'); });
    body.querySelector('#s-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget; // capture now: currentTarget is null after any await
      btn.disabled = true;
      try {
        const r = await api.patch('/me', { display_name: body.querySelector('#s-name').value.trim(), bio: body.querySelector('#s-bio').value, share_activity: share });
        setUser(r.user); toast('Saved');
      } catch (err) { toast(err.message, { err: true }); }
      btn.disabled = false;
    });
    body.querySelector('#s-logout').addEventListener('click', async () => { await api.post('/auth/logout', {}); location.reload(); });
  } else if (tab === 'sound') {
    await soundPanel(body);
  } else if (tab === 'password') {
    body.innerHTML = `
      <div class="field"><label>Current password</label><input type="password" id="p-current"></div>
      <div class="field"><label>New password</label><input type="password" id="p-next"></div>
      <button class="btn btn-primary" id="p-save">Update password</button>`;
    body.querySelector('#p-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget; // capture now: currentTarget is null after any await
      btn.disabled = true;
      try {
        await api.put('/me/password', { current: body.querySelector('#p-current').value, next: body.querySelector('#p-next').value });
        toast('Password updated'); body.querySelector('#p-current').value = ''; body.querySelector('#p-next').value = '';
      } catch (err) { toast(err.message, { err: true }); }
      btn.disabled = false;
    });
  } else if (tab === 'developer') {
    await developerPanel(body);
  }
}

async function soundPanel(body) {
  const d = await api.get('/me/eq');
  let bands = d.bands.slice();
  let preset = d.preset;

  const fmtHz = (hz) => hz >= 1000 ? `${hz / 1000}kHz` : `${hz}Hz`;

  function render() {
    body.innerHTML = `
      <p style="color:var(--text-dim);font-size:13.5px;margin-bottom:8px">Applied live in your browser during playback, and remembered on every device you sign into.</p>
      <p style="color:var(--text-faint);font-size:12.5px;margin-bottom:18px">Applies to every song and episode, wherever it is stored. Audio from PostFile is processed directly when its host allows it, and otherwise is relayed through Aurelune so the equalizer can still work on it.</p>
      <div class="chip-row" id="eq-presets" style="margin-bottom:28px">
        ${Object.keys(d.presets).map((k) => `<button class="chip ${preset === k ? 'active' : ''}" data-preset="${k}">${esc(d.labels[k])}</button>`).join('')}
        <button class="chip ${preset === 'custom' ? 'active' : ''}" data-preset="custom" ${preset === 'custom' ? '' : 'style="display:none"'} id="chip-custom">Custom</button>
      </div>
      <div style="display:flex;gap:22px;justify-content:space-between;padding:0 6px 8px">
        ${EQ_BANDS_HZ.map((hz, i) => `
          <div class="eq-band">
            <span class="eq-val" id="eq-val-${i}">${bands[i] > 0 ? '+' : ''}${bands[i]}</span>
            <div class="eq-slider-wrap"><input class="eq-slider" type="range" min="-12" max="12" step="1" value="${bands[i]}" data-band="${i}"></div>
            <span class="eq-freq">${fmtHz(hz)}</span>
          </div>`).join('')}
      </div>
    `;
    body.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => applyPreset(btn.dataset.preset)));
    body.querySelectorAll('.eq-slider').forEach((sl) => sl.addEventListener('input', () => onSlider(Number(sl.dataset.band), Number(sl.value))));
  }

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.put('/me/eq', preset === 'custom' ? { bands } : { preset }).catch((err) => toast(err.message, { err: true }));
    }, 500);
  }

  function applyPreset(key) {
    preset = key;
    bands = key === 'custom' ? bands : d.presets[key].slice();
    player.setEQBands(bands);
    render();
    scheduleSave();
  }

  function onSlider(i, val) {
    bands[i] = val;
    preset = 'custom';
    document.getElementById(`eq-val-${i}`).textContent = (val > 0 ? '+' : '') + val;
    player.setEQBands(bands);
    body.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === 'custom'));
    document.getElementById('chip-custom').style.display = '';
    scheduleSave();
  }

  render();
}

async function developerPanel(body) {
  const { scopes, tokens } = await api.get('/me/tokens');
  body.innerHTML = `
    <p style="color:var(--text-dim);font-size:13.5px;margin-bottom:18px">Personal API tokens let you (or anything you build) read your Aurelune data — listening history, now-playing, playlists — from outside the app. <a href="#/developer" style="color:var(--gold-hi)">See the full API reference</a>.</p>
    <button class="btn btn-primary" id="new-token" style="margin-bottom:20px">${icon('plus')} Create token</button>
    <div id="token-list">${tokens.map((t) => `<div class="token-row" data-id="${t.id}">
      <div><div class="name">${esc(t.name)}</div><div class="meta">${t.prefix}… · ${t.scopes.join(', ')} · ${t.last_used_at ? `last used ${fmtRelative(t.last_used_at)}` : 'never used'}</div></div>
      <button class="icon-btn" data-revoke>${icon('trash')}</button>
    </div>`).join('') || '<p style="color:var(--text-faint);font-size:13px">No tokens yet.</p>'}</div>
  `;
  body.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.closest('[data-id]').dataset.id; // read before any await: event.currentTarget is null once the handler has yielded
    if (!(await confirmDialog('Anything using this token will stop working immediately.'))) return;
    await api.del(`/me/tokens/${id}`).catch((err) => toast(err.message, { err: true }));
    developerPanel(body);
  }));
  body.querySelector('#new-token').addEventListener('click', () => {
    const m = openModal({
      title: 'New API token',
      body: `
        <div class="field"><label>Name</label><input type="text" id="t-name" placeholder="e.g. My discord bot"></div>
        <div class="field"><label>Scopes</label><div class="scope-grid">${Object.entries(scopes).map(([k, d]) => `<label class="scope-opt"><input type="checkbox" value="${k}"><span><span class="t">${k}</span><br><span class="d">${esc(d)}</span></span></label>`).join('')}</div></div>
      `,
      footer: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="t-create">Create</button>`,
    });
    m.el.querySelector('#t-create').addEventListener('click', async (e) => {
      const btn = e.currentTarget; // capture now: currentTarget is null after any await
      const name = m.el.querySelector('#t-name').value.trim();
      const picked = [...m.el.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
      if (!name) return toast('Name your token', { err: true });
      if (!picked.length) return toast('Pick at least one scope', { err: true });
      btn.disabled = true;
      try {
        const r = await api.post('/me/tokens', { name, scopes: picked });
        m.close();
        const shown = openModal({ title: 'Copy your token', body: `<p style="font-size:13.5px;color:var(--text-dim);margin-bottom:12px">${r.note}</p><div class="token-secret">${esc(r.token)}</div>`, footer: `<button class="btn btn-primary" data-close>Done</button>` });
        shown.el.querySelector('[data-close]').addEventListener('click', shown.close);
        developerPanel(body);
      } catch (err) { toast(err.message, { err: true }); btn.disabled = false; }
    });
  });
}

/* ============================================================ Developer API docs ============================================================ */

async function developer(root) {
  const d = await api.get('/docs');
  const groups = {};
  d.endpoints.forEach((e) => { (groups[e.group] ||= []).push(e); });
  root.innerHTML = `
    <h1 class="page-title">${esc(d.name)}</h1>
    <p class="page-sub">${esc(d.auth)}</p>
    <div class="callout" style="margin-bottom:26px">${d.notes.map(esc).join('<br>')}</div>
    ${Object.entries(groups).map(([g, eps]) => `
      <div class="section-head"><h2 class="section-title">${esc(g)}</h2></div>
      ${eps.map((e) => `<div class="docs-endpoint">
        <div class="row1"><span class="docs-method">${e.method}</span><span class="docs-path">${d.base}${esc(e.path)}</span>${e.scope ? `<span class="docs-scope">${e.scope} scope</span>` : ''}</div>
        <div class="docs-desc">${esc(e.desc)}</div>
      </div>`).join('')}
    `).join('')}
    <div class="section-head"><h2 class="section-title">Manage your tokens</h2></div>
    <a class="btn btn-primary" href="#/settings/developer">${icon('key')} Go to Developer settings</a>
  `;
}

/* ============================================================ Fallback ============================================================ */

function notfound(root) {
  root.innerHTML = `<div class="empty"><div class="icon">${icon('disc')}</div><h3>Nothing here</h3><p>That page doesn't exist. <a href="#/" style="color:var(--gold-hi)">Go home</a>.</p></div>`;
}

/* ============================================================ Full-page lyrics (auto-scrolling, click-to-seek) ============================================================ */

function lyricsPage(root) {
  let userScrolling = false;

  function shell(item) {
    return `
      <div class="lyrics-page">
        <div class="lyrics-page-bg" style="background-image:url('${item.cover}')"></div>
        <button class="icon-btn lp-close" id="lp-close" aria-label="Close">${icon('x')}</button>
        <div class="lyrics-page-head">
          <div class="lp-cover" style="background:${item.color}"><img src="${item.cover}" alt=""></div>
          <div class="lp-meta">
            <div class="lp-title">${esc(item.title)}</div>
            <div class="lp-artist">${bylineHtml(item)}</div>
          </div>
        </div>
        <div class="lyrics-page-body scrollbar" id="lp-body"></div>
        <button class="btn btn-primary lp-sync-btn" id="lp-sync" style="display:none">${icon('repeat')} Sync</button>
      </div>`;
  }

  function bodyHtml() {
    const lyr = player.lyrics;
    if (player.lyricsState === 'error') return `<div class="lp-status">Couldn't load the lyrics.<br><button class="btn btn-secondary" id="lp-retry" style="margin-top:12px">Try again</button></div>`;
    if (player.lyricsState === 'loading' || !lyr) return `<p class="lp-status">Loading lyrics…</p>`;
    if (!lyr.plain) return `<p class="lp-status">${player.current?.type === 'episode' ? 'Episodes don’t have lyrics.' : 'No lyrics for this one yet.'}</p>`;
    if (!lyr.synced) return `<div class="lp-plain">${esc(lyr.plain)}</div>`;
    return lyr.lines.map((line, i) => `<p class="lp-line" data-i="${i}" data-t="${line.t}">${esc(line.text) || '&nbsp;'}</p>`).join('');
  }

  let lastIdx = -2;
  function highlight(force) {
    const body = root.querySelector('#lp-body');
    if (!body || !player.lyrics?.synced) return;
    const idx = player.activeLyricIndex();
    if (idx === lastIdx && !force) return; // nothing changed: leave the DOM alone
    lastIdx = idx;
    body.querySelectorAll('.lp-line.active').forEach((el) => el.classList.remove('active'));
    const cur = body.querySelector(`.lp-line[data-i="${idx}"]`);
    cur?.classList.add('active');
    if (userScrolling && !force) return;
    cur?.scrollIntoView({ block: 'center', behavior: force ? 'auto' : 'smooth' });
  }

  function renderBody() {
    const body = root.querySelector('#lp-body');
    if (!body) return;
    body.innerHTML = bodyHtml();
    userScrolling = false;
    lastIdx = -2;
    root.querySelector('#lp-sync').style.display = 'none';
    body.querySelector('#lp-retry')?.addEventListener('click', () => player.retryLyrics());
    highlight(true);
  }

  let lastItemId = null;
  function full() {
    const item = player.current;
    if (!item) { root.innerHTML = `<div class="empty"><div class="icon">${icon('lyrics')}</div><h3>Nothing playing</h3><p>Play a song to see its lyrics here.</p></div>`; lastItemId = null; return; }
    lastItemId = item.id;
    root.innerHTML = shell(item);
    root.querySelector('#lp-close').addEventListener('click', () => history.back());
    const body = root.querySelector('#lp-body');
    body.addEventListener('wheel', onUserScroll, { passive: true });
    body.addEventListener('touchmove', onUserScroll, { passive: true });
    body.addEventListener('click', (e) => {
      const line = e.target.closest('.lp-line[data-i]');
      if (!line) return;
      // Clicking a line means "play from here": follow the song again, light the clicked line immediately.
      userScrolling = false;
      root.querySelector('#lp-sync').style.display = 'none';
      player.seekToLyric(Number(line.dataset.i));
      highlight(true);
    });
    root.querySelector('#lp-sync').addEventListener('click', () => { userScrolling = false; root.querySelector('#lp-sync').style.display = 'none'; highlight(true); });
    renderBody();
  }
  function onUserScroll() {
    if (userScrolling) return;
    userScrolling = true;
    const btn = root.querySelector('#lp-sync');
    if (btn) btn.style.display = 'flex';
  }

  const onTime = () => highlight(false);
  const onChange = () => { if (player.current?.id !== lastItemId) full(); };
  const onLyrics = () => renderBody();
  player.addEventListener('time', onTime);
  player.addEventListener('change', onChange);
  player.addEventListener('lyrics', onLyrics);
  // timeupdate only fires ~4x a second, which makes lines light up late; while the page is open follow the clock every frame.
  let raf = 0;
  const frame = () => { if (player.isPlaying) highlight(false); raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);

  full();

  return () => {
    cancelAnimationFrame(raf);
    player.removeEventListener('time', onTime);
    player.removeEventListener('change', onChange);
    player.removeEventListener('lyrics', onLyrics);
  };
}

export const Views = {
  home, search, genre, artist, album, show, playlist, library, liked, likedEpisodes, customizeLiked, historyView, studio, admin, settings, developer, notfound, lyricsPage,
};
