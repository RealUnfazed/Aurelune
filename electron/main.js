// Aurelune desktop shell (Electron). It comes in two flavours, chosen when the app is built (see electron/mode.js):
//
//   full    Client + Server together. Spawns the same Node/Express/MongoDB server the web app uses, on a local port, and opens
//           a native window onto it.
//   client  Client only. No server inside the app: the window opens a remote Aurelune server (asked for on first launch,
//           or baked in at build time, changeable from the Server menu).
//
// Either way the window shows the exact same web client and talks to the same API.
import { app, BrowserWindow, Menu, shell, nativeTheme, ipcMain, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import http from 'node:http';
import { readBuildConfig, resolveMode, normalizeServerUrl, argServer } from './mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PORT = process.env.AURELUNE_PORT || 4173;
const ICON_PATH = path.join(__dirname, 'icon.png'); // the same crescent logo as the web app (build/icon.* feed the installers)

const BUILD = readBuildConfig();
const MODE = resolveMode(BUILD);
const isClient = MODE === 'client';

let serverProcess = null;
let mainWindow = null;
let serverUrl = null; // client mode: the remote server's origin, e.g. https://music.example.com

/* ------------------------------------------------------------ remote server address (client mode) */

const settingsFile = () => path.join(app.getPath('userData'), 'server.json');
function savedServerUrl() {
  try { return normalizeServerUrl(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).url); } catch { return null; }
}
function saveServerUrl(url) {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify({ url })); } catch (e) { console.error('Could not save the server address:', e.message); }
}
const initialServerUrl = () => normalizeServerUrl(argServer()) || normalizeServerUrl(process.env.AURELUNE_SERVER_URL) || savedServerUrl() || normalizeServerUrl(BUILD.serverUrl) || null;

/** Is there an Aurelune server at `url`? (Same probe the full app uses on its own server.) */
async function probeServer(url, { strict = true } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await net.fetch(`${url}/api/v1/session`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    const type = res.headers.get('content-type') || '';
    if (res.status >= 500) return { ok: false, error: `The server answered with an error (${res.status}).` };
    if (strict && !type.includes('json')) return { ok: false, error: 'That address answers, but it doesn’t look like an Aurelune server.' };
    return { ok: true };
  } catch (e) {
    const why = ctrl.signal.aborted ? 'it took too long to answer' : String(e?.message || e).replace(/^net::/, '');
    return { ok: false, error: `Couldn’t reach ${url} (${why}).` };
  } finally { clearTimeout(timer); }
}

function showConnect({ url = serverUrl, error = '' } = {}) {
  if (!mainWindow) return;
  const query = {};
  if (!BUILD.serverUrl) query.nobaked = '1'; // this build has no default address; the screen says so
  if (url) query.url = url;
  if (error) query.error = error;
  mainWindow.loadFile(path.join(__dirname, 'connect.html'), { query });
}

/** Probe, then open the remote server in the window. On failure, back to the connect screen with the reason. */
async function openRemote(url) {
  // An address that came from the build, the environment or an earlier launch is trusted: only a real network failure stops us.
  const probe = await probeServer(url, { strict: false });
  if (!probe.ok) { showConnect({ url, error: probe.error }); return probe; }
  serverUrl = url;
  buildMenu();
  mainWindow.loadURL(`${url}/`);
  return probe;
}

ipcMain.handle('aurelune:connect', async (event, raw) => {
  if (!isClient || !event.senderFrame?.url?.startsWith('file:')) return { ok: false, error: 'Not available.' }; // only our own local screen may call this
  const url = normalizeServerUrl(raw);
  if (!url) return { ok: false, error: 'Enter a web address like https://aurelune.example.com' };
  const probe = await probeServer(url);
  if (!probe.ok) return probe;
  saveServerUrl(url);
  serverUrl = url;
  buildMenu();
  mainWindow.loadURL(`${url}/`);
  return { ok: true };
});
ipcMain.handle('aurelune:quit', () => { app.quit(); });

/* ------------------------------------------------------------ built-in server (full mode) */

function serverEntryPath() {
  // Packaged builds bundle the server under resources/server (see electron-builder.full.json); in dev we run straight from the repo.
  return isDev ? path.join(__dirname, '..', 'server', 'index.js') : path.join(process.resourcesPath, 'server', 'index.js');
}

function userDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

const LOADING_HTML = (message, sub) => `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#0a0b14;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f2f0ea}
  .wrap{text-align:center}
  .ring{width:38px;height:38px;border-radius:50%;border:3px solid #21243d;border-top-color:#1ed760;
    margin:0 auto 18px;animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{color:#6d6f8d;font-size:13px;margin-top:8px}
  #msg{transition:opacity .3s}
</style></head><body><div class="wrap"><div class="ring"></div><div id="msg">${message}</div>
<p id="sub">${sub}</p></div></body></html>`)}`;

function waitForServer(port, { timeoutMs = 180000, onTick } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function attempt() {
      const elapsed = Date.now() - start;
      onTick?.(elapsed);
      const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/session', timeout: 2000 }, (res) => { res.resume(); resolve(); });
      req.on('error', () => (elapsed > timeoutMs ? reject(new Error('The local server did not start in time.')) : setTimeout(attempt, 500)));
      req.on('timeout', () => req.destroy());
    })();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = fork(serverEntryPath(), [], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: userDataDir(),
        // A local MongoDB is expected at this URI by default. Set AURELUNE_MONGODB_URI
        // (e.g. to a mongodb+srv:// Atlas connection string) to point elsewhere.
        MONGODB_URI: process.env.AURELUNE_MONGODB_URI || 'mongodb://127.0.0.1:27017/aurelune',
        // Packaged desktop installs start on an empty, real catalog by default —
        // the synthesized demo catalog is a web/dev convenience, not something a
        // real user's desktop app should generate on first launch. Override with
        // AURELUNE_SEED_DEMO=true if you want the demo catalog on desktop too.
        SEED_DEMO: process.env.AURELUNE_SEED_DEMO || (isDev ? 'true' : 'false'),
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: 'inherit',
    });
    serverProcess.on('error', reject);
    serverProcess.on('exit', (code) => { if (code && code !== 0) console.error(`Aurelune server exited with code ${code}`); });
    waitForServer(PORT, {
      onTick: (elapsed) => {
        if (elapsed > 6000) mainWindow?.webContents.executeJavaScript(
          `document.getElementById('sub') && (document.getElementById('sub').textContent = 'Setting up your library — almost there…')`
        ).catch(() => {});
      },
    }).then(resolve, reject);
  });
}

/* ------------------------------------------------------------ window + menu */

/** The one origin this window may stay on; anything else opens in the user's browser. */
const appOrigin = () => (isClient ? serverUrl : `http://127.0.0.1:${PORT}`);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 860, minWidth: 960, minHeight: 600,
    backgroundColor: '#0a0b14',
    icon: ICON_PATH,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(isClient
    ? LOADING_HTML('Connecting…', 'Opening your Aurelune server.')
    : LOADING_HTML('Starting Aurelune…', 'This can take a little longer the very first time.'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const origin = appOrigin();
    if (url.startsWith('data:') || url.startsWith('file:') || (origin && url.startsWith(origin))) return;
    e.preventDefault(); shell.openExternal(url);
  });
  // Client mode: if the remote server goes away (offline, down), say so instead of showing a blank page, and let them retry.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isClient || !isMainFrame || code === -3 /* aborted */ || failedUrl.startsWith('file:') || failedUrl.startsWith('data:')) return;
    showConnect({ url: serverUrl, error: `Couldn’t reach ${serverUrl} (${String(desc).replace(/^ERR_/, '').replace(/_/g, ' ').toLowerCase()}).` });
  });
}

function showFatalError(message) {
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0b14;
    font-family:sans-serif;color:#f2f0ea"><div style="max-width:420px;text-align:center;padding:20px">
    <h2 style="font-weight:600">Aurelune couldn't start</h2><p style="color:#a9abc6;font-size:14px;line-height:1.6">${message}</p></div></body></html>`)}`;
  mainWindow ? mainWindow.loadURL(html) : createWindow();
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // No `accelerator` on the playback items on purpose: a menu accelerator is a native, app-wide shortcut, so Space (and
  // Ctrl/Cmd+Arrow) would fire even while a text box has focus. The shortcuts live in the page (public/js/shortcuts.js).
  const click = (id) => () => mainWindow?.webContents.executeJavaScript(`document.getElementById("${id}")?.click()`).catch(() => {});
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play/Pause (Space)', click: click('p-toggle') },
        { label: 'Next (Ctrl+Right)', click: click('p-next') },
        { label: 'Previous (Ctrl+Left)', click: click('p-prev') },
      ],
    },
    ...(isClient ? [{
      label: 'Server',
      submenu: [
        { label: serverUrl ? `Connected to ${serverUrl}` : 'Not connected', enabled: false },
        { type: 'separator' },
        { label: 'Reconnect', enabled: !!serverUrl, click: () => serverUrl && openRemote(serverUrl) },
        { label: 'Change server…', click: () => showConnect({ url: serverUrl }) },
      ],
    }] : []),
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin') app.dock?.setIcon(ICON_PATH);
  buildMenu();
  createWindow();

  if (isClient) {
    const url = initialServerUrl();
    if (!url) showConnect();            // first launch with no address baked in: ask for it
    else await openRemote(url);         // otherwise go straight there (or to the connect screen with the reason it failed)
  } else {
    try {
      await startServer();
      mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
    } catch (err) {
      console.error('Failed to start Aurelune server:', err);
      showFatalError(`${err.message} Make sure MongoDB is running and reachable, then restart Aurelune. Check the app logs for details.`);
    }
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length) return;
    createWindow(); // macOS: the dock icon was clicked after the last window closed
    if (isClient) (serverUrl ? openRemote(serverUrl) : showConnect());
    else mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { serverProcess?.kill(); });
