// =============================================================================
// desktop-electron/web-preload.js
// The API for the --web status window ONLY.
//
// Deliberately separate from preload.js: that exposes the whole command bridge,
// and a window whose entire job is showing a URL has no business holding it.
// =============================================================================
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cpsWeb', {
  openBrowser: () => ipcRenderer.invoke('cps:webOpen'),
  stop: () => ipcRenderer.invoke('cps:webStop'),
  onReady: (cb) => ipcRenderer.on('cps:web-ready', (_e, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('cps:web-error', (_e, d) => cb(d)),
});
