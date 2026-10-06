// The web app itself needs nothing from Electron, so nothing is exposed to it. The only exception is the local "connect to a
// server" screen (a file:// page shipped inside the app): it gets one function to hand a server address to the main process.
// The remote Aurelune site never sees this.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('aureluneDesktop', {
    connect: (url) => ipcRenderer.invoke('aurelune:connect', String(url ?? '')),
    retry: () => ipcRenderer.invoke('aurelune:retry'),
    quit: () => ipcRenderer.invoke('aurelune:quit'),
  });
}
