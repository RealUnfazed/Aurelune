// Which kind of desktop app is this?
//
//   full    Client + Server together. The app starts its own Aurelune server (and talks to MongoDB) on this computer.
//   client  Client only. No server inside: the window opens a remote Aurelune server you point it at.
//
// The mode is baked in when the app is built (scripts/build-desktop.mjs writes build-config.json), and can be overridden
// for development with AURELUNE_MODE=full|client. In client mode the server address comes from, in order:
//   1. --server=... / AURELUNE_SERVER_URL      2. what the user typed on the connect screen (saved)      3. the build default
//
// LOCKED builds: a client build made for one specific server (`--server https://...`) is locked to it. It has no Server menu,
// no connect screen with an address box, and ignores every override (command line, environment, saved address): it can only
// ever talk to the server it was built for. Only a client build made WITHOUT an address asks the user for one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function readBuildConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(here, 'build-config.json'), 'utf8'));
    return { mode: cfg.mode === 'client' ? 'client' : 'full', serverUrl: String(cfg.serverUrl || '') };
  } catch { return { mode: 'full', serverUrl: '' }; }
}

/** `--client` / `--full` / `--mode=client` on the command line (handy in development: `npm run desktop:client`). */
export function argMode(argv = process.argv) {
  for (const a of argv) {
    if (a === '--client' || a === '--mode=client') return 'client';
    if (a === '--full' || a === '--mode=full') return 'full';
  }
  return null;
}
/** `--server=https://music.example.com` on the command line. */
export function argServer(argv = process.argv) {
  const a = argv.find((x) => x.startsWith('--server='));
  return a ? a.slice('--server='.length) : '';
}

/** The origin a locked build is tied to, or null when this build is not locked. */
export function lockedServer(cfg = readBuildConfig()) {
  return cfg.mode === 'client' ? normalizeServerUrl(cfg.serverUrl) : null;
}

export function resolveMode(cfg = readBuildConfig(), env = process.env, argv = process.argv) {
  if (lockedServer(cfg)) return 'client'; // a build made for one server can't be switched into another kind of app
  const m = String(env.AURELUNE_MODE || '').toLowerCase();
  return argMode(argv) || (m === 'client' || m === 'full' ? m : cfg.mode);
}

const isLocalHost = (h) => h === 'localhost' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local');

/** "music.example.com" -> "https://music.example.com". Returns the origin, or null if it isn't a usable http(s) address. */
export function normalizeServerUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/:?#]/)[0].toLowerCase();
    s = `${isLocalHost(host) ? 'http' : 'https'}://${s}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.origin;
  } catch { return null; }
}
