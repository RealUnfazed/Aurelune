// Aurelune desktop shell (Electron). Spawns the same Node/Express/MongoDB
// server the web app uses, on a local port, and opens a native window onto
// it — the same approach Discord and Slack use for their desktop clients.
// The web app, the desktop app, and any mobile WebView wrapper all run the
// exact same client code and talk to the exact same API.
import { app, BrowserWindow, Menu, shell, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const PORT = process.env.AURELUNE_PORT || 4173;

let serverProcess = null;
let mainWindow = null;

function serverEntryPath() {
  // Packaged builds bundle the server under resources/server via electron-builder's
  // extraResources; in dev we run straight from the repo.
  return isDev ? path.join(__dirname, '..', 'server', 'index.js') : path.join(process.resourcesPath, 'server', 'index.js');
}

function userDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

const LOADING_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0;background:#0a0b14;display:flex;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f2f0ea}
  .wrap{text-align:center}
  .ring{width:38px;height:38px;border-radius:50%;border:3px solid #21243d;border-top-color:#e7b155;
    margin:0 auto 18px;animation:spin 0.9s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  p{color:#6d6f8d;font-size:13px;margin-top:8px}
  #msg{transition:opacity .3s}
</style></head><body><div class="wrap"><div class="ring"></div><div id="msg">Starting Aurelune…</div>
<p id="sub">This can take a little longer the very first time.</p></div></body></html>`)}`;

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360, height: 860, minWidth: 960, minHeight: 600,
    backgroundColor: '#0a0b14',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    show: false,
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(LOADING_HTML);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`) && !url.startsWith('data:')) { e.preventDefault(); shell.openExternal(url); }
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
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play/Pause', accelerator: 'Space', click: () => mainWindow?.webContents.executeJavaScript('document.getElementById("p-toggle")?.click()') },
        { label: 'Next', accelerator: 'CmdOrCtrl+Right', click: () => mainWindow?.webContents.executeJavaScript('document.getElementById("p-next")?.click()') },
        { label: 'Previous', accelerator: 'CmdOrCtrl+Left', click: () => mainWindow?.webContents.executeJavaScript('document.getElementById("p-prev")?.click()') },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  buildMenu();
  createWindow();
  try {
    await startServer();
    mainWindow.loadURL(`http://127.0.0.1:${PORT}/`);
  } catch (err) {
    console.error('Failed to start Aurelune server:', err);
    showFatalError(`${err.message} Make sure MongoDB is running and reachable, then restart Aurelune. Check the app logs for details.`);
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { serverProcess?.kill(); });
