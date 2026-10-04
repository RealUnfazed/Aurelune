// A tiny, self-contained embeddable player page — what "Share → Copy embed
// code" points at. Kept deliberately simple: it's meant to sit inside an
// <iframe> on someone else's page, not to be a second copy of the app.
// Streaming still requires a signed-in Aurelune session (see catalog.js),
// so a visitor who isn't logged in is offered a link to sign in instead.
import { Router } from 'express';
import { Track, Episode } from './db.js';
import { trackDTO, episodeDTO, TRACK_POP, EPISODE_POP, publicFilter } from './serialize.js';
import { esc } from './util.js';
import { privacyContext } from './privacy.js';

const r = Router();
r.use('/embed', privacyContext); // embeds are anonymous, so private creator pages are always hidden from them

function page({ title, subtitle, cover, color, streamUrl, kind }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Aurelune</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #121212; color: #fff; }
  .card { display: flex; align-items: center; gap: 14px; padding: 14px; height: 100%; }
  .cover { width: 64px; height: 64px; border-radius: 8px; overflow: hidden; flex: none; background: ${color || '#282828'}; }
  .cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .meta { min-width: 0; flex: 1; }
  .meta .t { font-weight: 700; font-size: 14.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta .s { font-size: 12.5px; color: #b3b3b3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
  .meta a { color: #b3b3b3; text-decoration: none; }
  .play { width: 44px; height: 44px; border-radius: 50%; background: #1ed760; border: none; color: #000; flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .play svg { width: 18px; height: 18px; }
  .signin { font-size: 12.5px; color: #1ed760; text-decoration: none; white-space: nowrap; }
  .brand { position: absolute; bottom: 4px; right: 10px; font-size: 10px; color: #6a6a6a; text-decoration: none; }
</style></head>
<body>
  <div class="card">
    <div class="cover"><img src="${esc(cover)}" alt=""></div>
    <div class="meta"><div class="t">${esc(title)}</div><div class="s">${esc(subtitle)}</div></div>
    <button class="play" id="play" aria-label="Play" style="display:none">
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z"/></svg>
    </button>
    <a class="signin" id="signin" href="/" target="_top" style="display:none">Sign in to play &rarr;</a>
  </div>
  <a class="brand" href="/" target="_top">Aurelune</a>
  <audio id="audio" src="${esc(streamUrl)}" preload="none"></audio>
  <script>
    const audio = document.getElementById('audio');
    const playBtn = document.getElementById('play');
    const signin = document.getElementById('signin');
    fetch('/api/v1/session', { credentials: 'same-origin' }).then(r => r.json()).then(d => {
      if (d.user) playBtn.style.display = 'flex'; else signin.style.display = 'inline';
    }).catch(() => { signin.style.display = 'inline'; });
    let playing = false;
    playBtn.addEventListener('click', () => {
      if (playing) { audio.pause(); } else { audio.play().catch(() => {}); }
    });
    audio.addEventListener('play', () => { playing = true; playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4.5" height="14" rx="1"/><rect x="13.5" y="5" width="4.5" height="14" rx="1"/></svg>'; });
    audio.addEventListener('pause', () => { playing = false; playBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5Z"/></svg>'; });
  </script>
</body></html>`;
}

r.get('/embed/track/:id', async (req, res, next) => {
  try {
    const t = await Track.findOne({ _id: req.params.id, ...publicFilter() }).populate(TRACK_POP).lean();
    if (!t) return res.status(404).send(page({ title: 'Not found', subtitle: 'This track is unavailable.', cover: '', streamUrl: '' }));
    const dto = trackDTO(t);
    res.send(page({ title: dto.title, subtitle: dto.artist?.name || '', cover: dto.cover, color: dto.color, streamUrl: dto.stream_url, kind: 'track' }));
  } catch (e) { next(e); }
});

r.get('/embed/episode/:id', async (req, res, next) => {
  try {
    const e = await Episode.findOne({ _id: req.params.id, ...publicFilter() }).populate(EPISODE_POP).lean();
    if (!e) return res.status(404).send(page({ title: 'Not found', subtitle: 'This episode is unavailable.', cover: '', streamUrl: '' }));
    const dto = episodeDTO(e);
    res.send(page({ title: dto.title, subtitle: dto.show?.title || '', cover: dto.cover, color: dto.color, streamUrl: dto.stream_url, kind: 'episode' }));
  } catch (e2) { next(e2); }
});

export default r;
