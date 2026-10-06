#!/usr/bin/env node
// Builds the Aurelune desktop installers in one of two modes:
//
//   full     Client + Server together. The installer contains the Aurelune server and starts it on the user's computer
//            (they need MongoDB reachable, see README). Output: dist-electron/full/
//   client   Client only. A small app with no server inside that opens a remote Aurelune server. Output: dist-electron/client/
//            With --server the app is LOCKED to that server: no Server menu, no address box, nothing to change.
//
// Usage:
//   npm run desktop:build                                   asks which mode
//   npm run desktop:build:full                              (same as: node scripts/build-desktop.mjs full)
//   npm run desktop:build:client -- --server https://music.example.com
//   node scripts/build-desktop.mjs client --server https://music.example.com --win --linux
//
// Options:  --server <url>   (client) lock the app to this server; leave out to let users type it on first launch
//           --win --mac --linux   which platforms to build (default: the one you are on; mac builds need a Mac)
//           --dir               unpacked app folder only, no installer (fast, for testing)
//           -- <args>           everything after a lone `--` is passed to electron-builder as is
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeServerUrl } from '../electron/mode.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'electron', 'build-config.json');
const stageDir = path.join(root, '.stage', 'full');
const log = (m) => console.log(`\x1b[36m[desktop]\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m[desktop]\x1b[0m ${m}`); process.exit(1); };

/* ---------- arguments ---------- */
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => { const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`)); if (i < 0) return undefined; return args[i].includes('=') ? args[i].split('=').slice(1).join('=') : args[i + 1]; };
let mode = args.find((a) => a === 'full' || a === 'client');
// The address can arrive in several ways; take whichever is there:
//   --server <url> / --server=<url>      a bare https://... argument      AURELUNE_SERVER_URL      npm_config_server
// (the last one is what npm sets when someone forgets the `--` and writes `npm run desktop:build:client --server <url>`:
//  npm then eats the flag itself instead of passing it on to this script)
const bareUrl = args.find((a) => /^https?:\/\//i.test(a));
let server = value('server') ?? bareUrl ?? process.env.AURELUNE_SERVER_URL ?? process.env.npm_config_server ?? '';
if (server === 'true') server = ''; // `--server` with nothing after it

if (!mode) {
  if (!process.stdin.isTTY) die('Say which build you want:  node scripts/build-desktop.mjs full|client   (see the top of this file)');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nWhat should the desktop app be?\n  1) Client + Server together  (the app runs its own server; nothing else needed but MongoDB)\n  2) Client only               (the app connects to your remote Aurelune server)\n');
  const a = (await rl.question('Choose 1 or 2: ')).trim();
  mode = a === '1' ? 'full' : a === '2' ? 'client' : die('Please answer 1 or 2.');
  if (mode === 'client' && !server) server = (await rl.question('Server address (e.g. https://music.example.com), or leave empty to ask on first launch: ')).trim();
  rl.close();
}

let serverUrl = '';
if (mode === 'client' && server) {
  serverUrl = normalizeServerUrl(server) || die(`"${server}" is not a usable web address. Use something like https://music.example.com`);
} else if (mode === 'full' && server) log('Ignoring --server: a full build runs its own server.');

/* ---------- full: stage the server + only its production dependencies ---------- */
// The installer must not drag in the whole development tree (Electron itself, the test tools, ...), so the server, the web
// client and `npm ci --omit=dev` go into .stage/full, and electron-builder copies from there.
function stageFull() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const stamp = JSON.stringify({ deps: pkg.dependencies, lock: fs.statSync(path.join(root, 'package-lock.json')).size });
  const serverDir = path.join(stageDir, 'server');
  const stampFile = path.join(stageDir, '.deps-stamp');
  const haveDeps = fs.existsSync(path.join(serverDir, 'node_modules')) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp;

  const keep = haveDeps ? path.join(stageDir, '.keep-node_modules') : null;
  if (keep) fs.renameSync(path.join(serverDir, 'node_modules'), keep); // reuse the installed dependencies, refresh the code
  fs.rmSync(serverDir, { recursive: true, force: true });
  fs.rmSync(path.join(stageDir, 'public'), { recursive: true, force: true });
  fs.mkdirSync(serverDir, { recursive: true });
  fs.cpSync(path.join(root, 'server'), serverDir, { recursive: true });
  fs.cpSync(path.join(root, 'public'), path.join(stageDir, 'public'), { recursive: true });
  // package.json next to the server tells Node its files are ES modules ("type": "module") and which packages to install.
  fs.writeFileSync(path.join(serverDir, 'package.json'), JSON.stringify({ name: 'aurelune-server', version: pkg.version, private: true, type: 'module', dependencies: pkg.dependencies }, null, 2));
  if (keep) { fs.renameSync(keep, path.join(serverDir, 'node_modules')); log('Server dependencies unchanged, reusing them.'); return; }

  log('Installing the server’s production dependencies (one time)…');
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(serverDir, 'package-lock.json'));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', serverDir], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die('npm install for the server failed.');
  fs.writeFileSync(stampFile, stamp);
}

/* ---------- run electron-builder ---------- */
const original = fs.readFileSync(configPath, 'utf8');
const restore = () => { try { fs.writeFileSync(configPath, original); } catch { /* ignore */ } };
process.on('SIGINT', () => { restore(); process.exit(130); });

log(mode === 'full' ? 'Building: Client + Server together' : serverUrl
  ? `Building: Client only, LOCKED to ${serverUrl} (no server options inside the app)`
  : 'Building: Client only. NO server address given, so the app will ask for one on first launch. (To bake it in: npm run desktop:build:client -- --server https://your-server)');
if (mode === 'full') stageFull();
fs.writeFileSync(configPath, JSON.stringify({ mode, serverUrl }, null, 2) + '\n');

const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(cli)) { restore(); die('electron-builder is not installed. Run `npm install` first.'); }
const builderArgs = [cli, '--config', path.join(root, `electron-builder.${mode}.json`)];
for (const p of ['win', 'mac', 'linux']) if (flag(p)) builderArgs.push(`--${p}`);
if (flag('dir')) builderArgs.push('--dir');
const dd = process.argv.indexOf('--');
if (dd > 0) builderArgs.push(...process.argv.slice(dd + 1)); // anything after `--` goes straight to electron-builder
const child = spawn(process.execPath, builderArgs, { cwd: root, stdio: 'inherit', env: process.env });
child.on('exit', (code) => {
  restore();
  if (code === 0) log(`Done. Output: dist-electron/${mode}/${mode === 'client' ? (serverUrl ? `  (locked to ${serverUrl})` : '  (asks for the server on first launch)') : ''}`);
  process.exit(code ?? 1);
});
