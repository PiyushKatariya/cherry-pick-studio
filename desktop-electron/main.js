// =============================================================================
// desktop-electron/main.js
// Electron desktop wrapper. Loads the SAME frontend and drives the SAME core
// bridge as the web server — only the transport differs (IPC instead of WS).
//   npm run desktop
// =============================================================================
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { createBridge } = require('../core/bridge');

let win = null;
let bridge = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 820,
    minHeight: 600,
    title: 'Cherry-Pick Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // One bridge per window; events are pushed to the renderer over IPC.
  const send = (obj) => {
    if (win && !win.isDestroyed()) win.webContents.send('cps:event', obj);
  };
  bridge = createBridge(send);

  win.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  win.on('closed', () => {
    if (bridge) bridge.dispose();
    bridge = null;
    win = null;
  });
}

// Renderer → main commands.
ipcMain.handle('cps:command', async (_event, msg) => {
  if (bridge) bridge.handle(msg);
  return true;
});

// Native folder picker (replaces the .bat browse step). [run-cherry-pick.bat]
ipcMain.handle('cps:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

// Open the user guide (docs/Cherry-Pick-Studio-Guide.html) in the default browser.
ipcMain.handle('cps:openGuide', async () => {
  const guide = path.join(__dirname, '..', 'docs', 'Cherry-Pick-Studio-Guide.html');
  const err = await shell.openPath(guide);
  return err ? { ok: false, error: err } : { ok: true };
});

app.whenReady().then(() => {
  // Signal the renderer it is running inside Electron.
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
