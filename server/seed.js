// Seeds a demo catalog so a fresh install of Aurelune isn't an empty room.
// All audio is generated locally (see synth.js) — no copyrighted material is downloaded or bundled.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { connectDb, User, Creator, Album, Track, Show, Episode, Play, Like, Follow, Playlist } from './db.js';
import { hashPassword } from './auth.js';
import { ensureAdmin } from './bootstrap.js';
import { uniqueSlug } from './util.js';
import { AUDIO_DIR } from './config.js';
import { synthWav } from './synth.js';

const rand = () => crypto.randomBytes(12).toString('hex');
const daysAgo = (d) => new Date(Date.now() - d * 86400000);
const pick = (a, r) => a[Math.floor(r() * a.length)];
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function saveWav(seed, opts) {
  const buf = synthWav({ seed, ...opts });
  const file = rand() + '.wav';
  fs.writeFileSync(path.join(AUDIO_DIR, file), buf);
  return { file, ms: Math.round(opts.seconds * 1000) };
}

function lrc(lines, startSec, gap) {
  let t = startSec;
  const fmt = (s) => { const m = Math.floor(s / 60), sec = (s % 60).toFixed(2).padStart(5, '0'); return `[${String(m).padStart(2, '0')}:${sec}]`; };
  return lines.map((l) => { const line = `${fmt(t)}${l}`; t += gap; return line; }).join('\n');
}

const ARTISTS = [
  { name: 'Nocturne Radio', focus: 'music', scale: 'minor', bpm: 92, bio: 'Late-night synths and slow-motion drums, made for the drive home.' },
  { name: 'Glass Antlers', focus: 'music', scale: 'dorian', bpm: 118, bio: 'Four friends, one drum machine, and too much reverb.' },
  { name: 'Marigold Static', focus: 'music', scale: 'major', bpm: 104, bio: 'Warm, bright indie-pop from a bedroom studio that used to be a closet.' },
  { name: 'Halide', focus: 'music', scale: 'lydian', bpm: 128, bio: 'Instrumental electronic music built from field recordings and old synths.' },
  { name: 'The Paper Cranes', focus: 'music', scale: 'pent', bpm: 84, bio: 'Acoustic-leaning folk about small towns and long winters.' },
  { name: 'Deep Focus Collective', focus: 'podcasts', bio: 'Long, unhurried conversations about how people actually get things done.' },
  { name: 'The Night Shift', focus: 'podcasts', bio: 'Stories from people who work while the rest of the world sleeps.' },
];

const GENRES = { 'Nocturne Radio': 'Synthwave', 'Glass Antlers': 'Indie Rock', 'Marigold Static': 'Indie Pop', Halide: 'Electronic', 'The Paper Cranes': 'Folk' };
const TITLE_WORDS = ['Static', 'Harbor', 'Amber', 'Low Tide', 'Paper Moon', 'Halflight', 'Wires', 'Slow Bloom', 'Nightbus', 'Glass', 'Salt', 'Fault Line', 'Afterglow', 'Kite', 'Cassette', 'Vacant Lot', 'Marrow', 'Sea Glass', 'Ultraviolet', 'Tin Roof'];

async function main() {
  await connectDb();
  const force = process.argv.includes('--force');
  if (!force && (await Creator.estimatedDocumentCount()) > 0) {
    console.log('Creators already exist — run with --force to seed the demo catalog anyway (this only adds, it does not wipe).');
  }

  await ensureAdmin();

  let demo = await User.findOne({ username: 'demo' });
  if (!demo) demo = await User.create({ username: 'demo', email: 'demo@aurelune.local', displayName: 'Demo Listener', passwordHash: hashPassword('demo12345') });

  if (await Creator.estimatedDocumentCount() > 0 && !force) { await postSeed(); return; }

  const r = mulberry(20260101);
  const musicCreators = [];
  const showCreators = [];

  for (const a of ARTISTS) {
    const ownerEmail = a.name.toLowerCase().replace(/[^a-z]+/g, '.') + '@aurelune.local';
    let owner = await User.findOne({ email: ownerEmail });
    if (!owner) owner = await User.create({ username: a.name.toLowerCase().replace(/[^a-z0-9]+/g, ''), email: ownerEmail, displayName: a.name, passwordHash: hashPassword('artist12345') });
    const creator = await Creator.create({
      user: owner._id, name: a.name, slug: await uniqueSlug(a.name), bio: a.bio, focus: a.focus,
      status: 'approved', verified: r() > 0.4, requestedAt: daysAgo(120), reviewedAt: daysAgo(119),
    });
    if (a.focus === 'music') musicCreators.push({ ...a, creator }); else showCreators.push({ ...a, creator });
  }

  const allTracks = [];
  for (const a of musicCreators) {
    const albumCount = 1 + Math.floor(r() * 2);
    for (let ai = 0; ai < albumCount; ai++) {
      const isEp = r() > 0.5;
      const album = await Album.create({
        artist: a.creator._id, title: `${pick(TITLE_WORDS, r)} ${isEp ? 'EP' : ''}`.trim(), kind: isEp ? 'ep' : 'album',
        description: `${isEp ? 'An EP' : 'An album'} by ${a.name}.`, releasedAt: daysAgo(10 + Math.floor(r() * 300)),
      });
      const trackCount = isEp ? 3 + Math.floor(r() * 2) : 6 + Math.floor(r() * 5);
      for (let ti = 0; ti < trackCount; ti++) {
        const seconds = 26 + Math.floor(r() * 8); // short demo clips
        const seed = Math.floor(r() * 1e9);
        const root = 52 + Math.floor(r() * 12);
        const { file, ms } = saveWav(seed, { seconds, bpm: a.bpm + Math.floor((r() - 0.5) * 10), scale: a.scale, root, arp: r() > 0.3, pad: 0.5 + r() * 0.4 });
        const title = `${pick(TITLE_WORDS, r)}${r() > 0.7 ? ' (Reprise)' : ''}`;
        const hasLyrics = r() > 0.35;
        const lyricLines = ['Every light on the block is out but ours', 'We kept driving past the county line', 'Say you feel it too, say you feel it too', 'The static clears right before the chorus', 'Nobody warned me this would take so long', 'Hold the wheel, I will hold the silence'];
        const track = await Track.create({
          artist: a.creator._id, album: album._id, title, credits: `Written and produced by ${a.name}`,
          genre: GENRES[a.name], durationMs: ms, audio: file, mime: 'audio/wav',
          lyrics: hasLyrics ? lrc(lyricLines.sort(() => r() - 0.5).slice(0, 5), 4, Math.max(3, seconds / 7)) : '',
          explicit: r() > 0.85, trackNo: ti + 1, plays: Math.floor(r() * r() * 50000),
          createdAt: daysAgo(5 + Math.floor(r() * 280)),
        });
        allTracks.push(track);
      }
    }
  }

  for (const a of showCreators) {
    const show = await Show.create({ artist: a.creator._id, title: a.name, description: a.bio, category: 'Society & Culture', language: 'en' });
    const epCount = 4 + Math.floor(r() * 4);
    for (let ei = 0; ei < epCount; ei++) {
      const seconds = 30, seed = Math.floor(r() * 1e9);
      const { file, ms } = saveWav(seed, { seconds, bpm: 80, scale: 'major', root: 48, beat: false, arp: false, pad: 0.3 });
      await Episode.create({
        show: show._id, artist: a.creator._id, title: `Episode ${ei + 1}: ${pick(TITLE_WORDS, r)}`,
        description: 'A conversation recorded for this demo catalog.', audio: file, mime: 'audio/wav', durationMs: ms,
        season: 1, number: ei + 1, plays: Math.floor(r() * 4000), publishedAt: daysAgo(2 + ei * 6),
      });
    }
  }

  // A couple of public playlists and some demo-listener history so History/Stats aren't empty.
  const favorites = allTracks.sort(() => r() - 0.5).slice(0, 14);
  await Playlist.create({ user: demo._id, title: 'Late Night Drive', description: 'For empty highways.', isPublic: true, items: favorites.slice(0, 8).map((t) => ({ track: t._id })) });
  await Playlist.create({ user: demo._id, title: 'Focus', description: 'Low-key instrumentals.', isPublic: true, items: favorites.slice(8).map((t) => ({ track: t._id })) });
  await Like.insertMany(favorites.slice(0, 10).map((t) => ({ user: demo._id, track: t._id })), { ordered: false }).catch(() => {});
  await Follow.insertMany(musicCreators.slice(0, 3).map((a) => ({ user: demo._id, artist: a.creator._id })), { ordered: false }).catch(() => {});

  const plays = [];
  for (let i = 0; i < 220; i++) {
    const t = pick(allTracks, r);
    plays.push({ user: demo._id, kind: 'track', item: t._id, creator: t.artist, genre: t.genre, msPlayed: Math.floor(t.durationMs * (0.6 + r() * 0.4)), playedAt: daysAgo(r() * 60), source: pick(['search', 'artist_page', 'playlist', 'radio'], r) });
  }
  await Play.insertMany(plays);

  console.log(`Seeded ${musicCreators.length} music creators, ${showCreators.length} podcast creators, ${allTracks.length} tracks.`);
  await postSeed();
}

async function postSeed() {
  console.log('Demo listener: demo@aurelune.local / demo12345');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
  await main();
}
