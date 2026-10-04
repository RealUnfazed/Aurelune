# Aurelune

A self-hosted, Spotify-class streaming platform for music and podcasts —
built on Node.js, Express, and MongoDB. Artists apply for a creator page,
upload tracks and albums with synced (LRC) lyrics, podcasters publish shows
and episodes, listeners get playlists, likes, follows, and a full listening
history with stats — and everything is also available over a documented,
token-authenticated **web API**, so you (or anyone) can build a bot, a
widget, or a companion app on top of your own data.

The same client runs three ways from one codebase, the way Discord's does:
a **web app**, a **desktop app** (Electron, wraps the web app in a native
window and manages the server for you), and a **mobile shell** (Capacitor,
points a native wrapper at your deployed server).

## Why "Aurelune"

Aurora + lune (moon). The whole visual identity — the generated cover art,
the color palette — leans into that: every track, album, and show that
doesn't have uploaded artwork gets a unique, deterministic generative
cover (a moon-and-aurora motif) rendered as SVG, so nothing ever looks
blank. It isn't the name of any existing music company or product.

## Features

- **Accounts & creator pages** — anyone can sign up; anyone can apply to
  become a creator (artist or podcaster). Admins approve, reject, verify,
  or suspend creator pages from a built-in admin panel.
- **Music** — albums/EPs/singles, per-track credits, genre, explicit flag,
  and **lyrics** with automatic LRC (`[mm:ss.xx]`) sync detection — paste
  timestamped lyrics and they'll scroll in time with playback, or paste
  plain lyrics and they'll show as a static sheet.
- **Podcasts** — shows with seasons/episodes, transcripts, and per-listener
  resume position.
- **Listening** — likes, follows (artists & shows), saved albums,
  playlists (drag-free reordering via the API, public/private sharing),
  queue, shuffle/repeat, Media Session integration (OS-level play/pause/
  next on your keyboard, lock screen, or car display).
- **"Grab my listening"** — a full history/stats page (minutes per day,
  time-of-day heatmap, top tracks/artists/genres, streaks), a one-click
  CSV export, and a full JSON data export.
- **A real web API** — every one of the above is exposed at `/api/v1` with
  scoped personal access tokens (create them under Settings → Developer),
  so a third-party integration only ever gets the access it asked for.
  Read the live reference in-app at **Settings → Developer → API
  reference**, or hit `GET /api/v1/docs`.
- **Now-playing, live** — `GET /api/v1/me/player` and a Server-Sent-Events
  stream at `/api/v1/me/player/stream` expose what you're playing right
  now, in real time, to anything you build (a Discord bot, a status
  overlay, a smart-home display).
- **Full-page lyrics** — an immersive, auto-scrolling lyrics view for any
  track with synced (LRC) lyrics: the current line highlights and the page
  scrolls itself as the song plays. Scroll away to read ahead and a "Sync"
  button appears to jump back in; click any line to seek playback to that
  moment.
- **Personal equalizer** — 11 presets (Bass Boost, Jazz, Rock, Vocal Boost…)
  plus a 7-band custom graphic EQ under Settings → Sound. It's applied live
  in the browser via Web Audio filters and remembered on your account, so
  it follows you to any device you sign into.
- **Right-click menus** that do real things — Play next, Add to queue, Add
  to playlist, Share a link, Share an embeddable player, Exclude a track
  from your recommendations, or Report it (visible to admins under
  Admin → Reports).
- **Ambient now-playing glow** — a soft color wash behind the interface
  that shifts with whatever's currently playing.
- **A sidebar that behaves like a real app** — collapsible to icons-only,
  freely resizable by dragging its edge, both remembered per browser.
- **Encrypted at rest** — every uploaded audio file is AES-256 encrypted on
  disk and decrypted on the fly per authenticated request; streaming
  requires a signed-in account. See "A note on file protection" below for
  what this does and doesn't guarantee.

## Requirements

- Node.js 18.17+
- MongoDB 6+ reachable at the URI you configure (a local `mongod`, a
  Docker container, or a hosted cluster like Atlas all work identically —
  Aurelune talks to it purely through Mongoose)

## Quick start

```bash
npm install
cp .env.example .env      # edit if you need to (a local Mongo needs no changes)
npm start
```

Open **http://localhost:3000**. On first run, if the database is empty,
Aurelune:

1. Creates an **admin account** — email/password printed to the console
   (or set `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` beforehand).
   **Change this password immediately** via Settings → Password.
2. Seeds a demo catalog — a handful of artists and a podcast, with real,
   playable audio. That audio is **not music** — it's generated on the
   fly by a tiny offline synthesizer (`server/synth.js`) so the app isn't
   blank on first launch, with zero copyright concerns. Log in as
   **demo / demo12345** to see a populated library, listening history,
   and stats immediately. Set `SEED_DEMO=false` to skip this.

To re-run the seeder manually against an existing database:
`npm run seed` (adds to what's there; safe to run once).

## Publishing real content

1. Sign up (or use an existing account) → the nav has a **For Creators**
   link → request a creator page (pick "music", "podcasts", or "both").
2. Sign in as the admin account → **Admin → Creator requests** → approve it.
3. Back in that account, **For Creators** now opens the **Studio**:
   upload tracks (drag in an MP3/M4A/FLAC/WAV/OGG file — title, genre, and
   embedded cover art are read automatically from the file's tags if you
   don't fill them in), group them into albums, or set up a podcast and
   add episodes.

Uploaded files are stored under `DATA_DIR/uploads` (`./data/uploads` by
default) — back that directory up along with your MongoDB data.

## A note on file protection

Every uploaded audio file is AES-256-CTR encrypted the moment it's saved —
what sits in `DATA_DIR/uploads/audio` is ciphertext, not a playable file.
Streaming decrypts on the fly, per request, only for a signed-in account
(anonymous requests get a 401, including for otherwise-public tracks).
This is real protection against the actual likely risk for a self-hosted
service: someone getting at your disk, a backup, or an old drive and
finding a folder of ready-to-play files.

It is **not** the same thing as licensed DRM (Widevine/FairPlay/PlayReady).
Those systems also stop an *authorized* listener's own device from ever
touching decoded audio, which needs a paid vendor license, a license
server, and hardware-backed key handling — not something any self-hosted
project builds from scratch. If your own browser can play a sound, your
own machine can, in principle, capture what it's playing; no software
fully closes that door, including Spotify's (stream-ripping tools exist
despite it). What's implemented here is the strongest realistic version of
"don't just leave raw files lying around," not a copy-protection system.

## Configuration

Every setting lives in `.env` locally, or in the Environment Variables
screen on Vercel (see `.env.example` for the full annotated list):
`MONGODB_URI`, `PORT`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `POSTFILE_API_KEY`,
`STORAGE_DRIVER`, `POSTFILE_MAX_MB`, `POSTFILE_API_BASE`, `AUDIO_ENCRYPTION_KEY`, `DATA_DIR`, `MAX_AUDIO_MB`,
`MAX_IMAGE_MB`, `SEED_DEMO`, `NODE_ENV`.

## Playlist pictures

A playlist's picture is built from its most recently added songs, as on Spotify: four different covers
make a 2x2 collage of the last four added; one to three covers show the latest song's cover on its own
(ten songs from one album never tile the same image four times); an empty playlist gets generated art
that is unique to it. It updates as songs are added or removed and appears in the sidebar, the library,
the playlist page, search and the "Add to playlist" picker.

## Pinned playlists and Liked Songs

The sidebar starts with **Liked Songs**, followed by your playlists. Pin a playlist with the pin button
that appears on hover, the right-click menu, or the pin button on the playlist page; pinned playlists
stay at the top (most recently pinned first), also in the Library. Liked Songs has an icon and colour you
can change: click its cover on the Liked Songs page, or right-click it in the sidebar. They are
shown as pictures only when the sidebar is collapsed. API: `PUT/DELETE /playlists/:id/pin`;
`PATCH /me {liked_icon, liked_color}`.

## Liked Songs vs. Liked Episodes

Songs and podcast episodes are liked separately. The heart on a song goes to **Liked Songs**; the heart on a
podcast episode (on its row, in the player bar, or in its right-click menu) goes to **Liked Episodes**, a
second default entry in the sidebar and library. API: songs `PUT/DELETE /me/likes/:trackId`, episodes
`PUT/DELETE /me/likes/episodes/:episodeId`, list with `GET /me/likes/episodes`.

## Private tracks and episodes

When uploading (or any time later, from **Studio → Tracks / Episodes**) a creator can make an item **private**:
turn off the **Public** switch, or click the Public/Private pill in the table. A private item is
visible, searchable and playable only to the account that owns the creator page (across all of that
account's pages). Everyone else, signed in or not, gets a 404 from every endpoint and never sees it in
search, genres, artist/album/show pages, the "now playing" API, embeds, or other people's playlists.
The owner sees it with a small lock, in an **Only you can see these** shelf on Home and in their own
search. Flip it back to Public at any time. Through the API: `visibility: "private" | "public"` on
`POST/PATCH /studio/tracks` and `/studio/episodes` (`published: false` still works).

## Several creator pages per account

One account can run more than one creator page, for example a band, a solo
project and a podcast. Each page has its own name, bio, image, tracks, albums,
shows, followers and stats, and each is reviewed and approved on its own.

- **How many:** new accounts get `DEFAULT_CREATOR_PAGES` pages (default 1). An
  admin can change that for any user in **Admin, Users, Change**: a set
  number, unlimited, or back to the server default. Lowering a limit never
  deletes pages the person already has. It only stops new ones.
- **Rejected requests** don't use up a slot. A page that is still pending or
  was rejected can be withdrawn by its owner. A live page can only be removed
  by an admin.
- **In the Studio:** a row at the top switches between pages, with a "New
  page" button while there are free slots. The chosen page is remembered per
  browser and sent as the `X-Creator-Page` header, so it works on Vercel
  without any server-side state.
- **Upgrading:** older databases had a unique index that allowed only one
  page per account. Aurelune removes it automatically on startup.

## Upload storage: local or PostFile

Artists choose where each upload goes. Both options coexist, so the same
codebase runs on your own machine and on Vercel.

| | **Local** | **PostFile** (postfile.net) |
|---|---|---|
| Where files live | `DATA_DIR` on the server's disk | PostFile's storage / CDN |
| Available on | self-hosted, Electron, any host with a persistent disk | everywhere, including Vercel |
| Protection | AES-256 encrypted at rest; streamed through the API only for signed-in users, with Range/seek support | **Not encrypted**; the API only hands the CDN link to signed-in users |
| Equalizer | yes | no (the browser can't process cross-origin audio; playback is plain) |
| Needs | nothing | `POSTFILE_API_KEY` |

If only one is available, the picker shows only that one. `STORAGE_DRIVER`
sets the default when both are.

## Deploying to Vercel

1. **Database.** Create a MongoDB Atlas cluster. Under *Network Access*
   allow `0.0.0.0/0`, because Vercel's outbound IPs aren't fixed. Copy the
   connection string.
2. **Push** this folder to a Git repo and import it in Vercel. No build
   command or output directory is needed. `vercel.json` routes every
   request to `api/index.js`, which wraps the Express app. `public/` is
   bundled with the function.
3. **Environment variables** (Project, Settings, Environment Variables):
   - `MONGODB_URI`: your Atlas string (**required**)
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`: **required**. In production no
     default-password admin is created, and the first signup does not
     become admin.
   - `POSTFILE_API_KEY`: needed for uploads, since Vercel has no
     persistent disk
   - optional: `POSTFILE_MAX_MB` (default 50), `SEED_DEMO=true` if you want
     sample content
4. Deploy, sign in as the admin, and approve creators from the admin page.

**Limits that matter on Vercel**

- **4.5 MB request body cap.** A song won't fit in one request. PostFile
  doesn't allow uploads straight from a browser (it sends no CORS headers),
  so large files are sent in pieces of about 3 MB. The browser sends the
  pieces to Aurelune, which keeps them in MongoDB for a short time, joins
  them, reads the tags and duration, and uploads the result to PostFile.
  Leftover pieces from an abandoned upload expire after 2 hours. This
  needs free space in your Atlas database while an upload is in progress
  (up to the file size).
- **No local disk.** The filesystem is read-only except `/tmp`, which is
  wiped, so the Local option is hidden on Vercel.
- **Function duration.** `vercel.json` sets 60s. The final step of a big
  upload (joining the pieces and sending them to PostFile) must finish in
  that time, which is comfortable for typical songs. For files near 50 MB
  on a slow link, raise `maxDuration` as far as your plan allows.
- **No long-lived connections.** The live "now playing" stream closes
  after about 9 seconds and the browser reconnects on its own. State is
  kept in MongoDB, not memory.
- **Bundle size** is 250 MB. `electron`, `electron-builder` and `jsdom`
  are dev-only, and `vercel.json` installs with `--omit=dev`.

Express's `PORT` only matters for local runs. Vercel ignores it, and
`server/index.js` (local) and `api/index.js` (Vercel) share the same
`server/app.js`. The Electron and Capacitor apps can point at your Vercel
URL, or run the local server.

## Tests

`npm test` runs the player logic test and the Studio upload UI test (jsdom)
in four hosting scenarios, with no database or network. `npm run mock:postfile`
starts a stand-in PostFile server on port 4010 (key `pf_mock_key`) so you can
try the PostFile path without an account: set `POSTFILE_API_KEY=pf_mock_key`
and `POSTFILE_API_BASE=http://localhost:4010`.

**Verified on a real deployment:** creating an upload link works against the
live PostFile API, and PostFile does not allow browser-to-PostFile uploads
(CORS), which is why uploads go through Aurelune. **Not verified:** the actual
file upload from Aurelune to PostFile (only tested against a mock built from
its docs). Try one small and one large upload after deploying.

## Desktop app (Electron)

```bash
npm run desktop          # launch it locally, same as `npm start` but in a native window
npm run desktop:build    # package installers into dist-electron/ (dmg/AppImage+deb/nsis)
```

The desktop app forks the exact same `server/index.js` as a child process
on a local port and points a `BrowserWindow` at it — the app's data lives
under your OS's app-data folder rather than the repo. It still needs a
MongoDB it can reach (local by default; point `AURELUNE_MONGODB_URI` at
Atlas or anywhere else for a zero-install experience). The demo catalog is
**off by default** for packaged desktop builds (set
`AURELUNE_SEED_DEMO=true` if you want it) since a real desktop install
shouldn't spend its first launch synthesizing placeholder audio.

## Mobile

Aurelune's web app depends on a live server (Node + MongoDB) it can talk
to, so a mobile build isn't a static bundle — it's a thin native shell
(via [Capacitor](https://capacitorjs.com)) pointed at your **deployed**
Aurelune server, the same pattern many production apps use to ship a web
app through the App Store / Play Store:

```bash
npm install --save-dev @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
```

Edit `capacitor.config.json` and set `server.url` to your deployed
server's HTTPS URL, then:

```bash
npx cap add ios       # requires Xcode
npx cap add android   # requires Android Studio / the Android SDK
npx cap open ios      # or: npx cap open android
```

That opens the native project so you can build, sign, and ship it. Native
SDKs (Xcode/Android Studio) aren't something that can be scripted for
you — they have to be installed and run on your own machine.

## The API

Full reference: run the app and open **Settings → Developer**, or fetch
`GET /api/v1/docs`. In short:

1. Settings → Developer → **Create token**, pick scopes (`profile`,
   `library`, `playlists`, `history`, `player`, `export`).
2. Call the API with `Authorization: Bearer aur_xxxxx`.

```bash
curl -H "Authorization: Bearer aur_xxxxx" http://localhost:3000/api/v1/me/history?limit=20
curl -H "Authorization: Bearer aur_xxxxx" http://localhost:3000/api/v1/me/stats?range=month
curl -H "Authorization: Bearer aur_xxxxx" http://localhost:3000/api/v1/me/export -o my-data.json
```

The now-playing stream is a standard SSE endpoint:

```js
const es = new EventSource('/api/v1/me/player/stream?access_token=aur_xxxxx');
es.addEventListener('player', (e) => console.log(JSON.parse(e.data)));
```

## Project structure

```
server/            Express API (app.js shared app, index.js local entry, storage.js PostFile client, routes/, db.js models, ...)
api/index.js       Vercel entry (wraps server/app.js); see vercel.json
test/, scripts/    offline tests and the mock PostFile server
public/            The web app — vanilla JS, no build step (js/, css/, fonts/)
electron/          Desktop shell (main.js forks server/index.js, opens a BrowserWindow)
capacitor.config.json   Mobile shell config (points at your deployed server)
```

No bundler, no framework, no build step for the web client — `public/`
is served as-is by Express, and the same files are what Electron and the
Capacitor shell load. Edit a `.js` file and refresh.

## Notes on the demo audio

`server/synth.js` is a small additive/subtractive synthesizer that turns a
few parameters (tempo, scale, seed) into a WAV file entirely in code — no
samples, no downloaded audio, nothing copyrighted. It exists purely so a
fresh install has something real to click play on. Swap in real uploads
through the Studio any time; the demo tracks are ordinary rows in the
database and can be deleted like anything else.
