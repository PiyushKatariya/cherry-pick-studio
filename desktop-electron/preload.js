// =============================================================================
// desktop-electron/preload.js
// Exposes a tiny, safe API to the renderer that mirrors the WebSocket protocol.
// The frontend's transport layer detects window.cps and uses IPC instead of WS.
// =============================================================================
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cps', {
  isElectron: true,
  // Renderer → main (commands)
  send: (msg) => ipcRenderer.invoke('cps:command', msg),
  // main → renderer (events)
  onEvent: (cb) => ipcRenderer.on('cps:event', (_e, obj) => cb(obj)),
  // Native folder picker
  pickFolder: () => ipcRenderer.invoke('cps:pickFolder'),
  // Open the user guide in the default browser
  openGuide: () => ipcRenderer.invoke('cps:openGuide'),
});
