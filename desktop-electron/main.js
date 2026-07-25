// =============================================================================
// desktop-electron/main.js
// Electron desktop wrapper, and the entry point for BOTH packaged modes.
//
//   <exe>          → desktop window; loads the SAME frontend and drives the SAME
//                    core bridge as the web server, only over IPC instead of WS.
//   <exe> --web    → starts server/server.js in-process and opens the browser,
//                    showing a small status window as the off switch.
//
// Electron's main process is Node, which is what lets one bundle serve both modes
// on a machine with no Node installed.
//   npm run desktop
// =============================================================================
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { createBridge } = require('../core/bridge');

const WEB_MODE = process.argv.includes('--web');

let win = null;
let bridge = null;
let webServer = null;
let webPort = 0;

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
  bridge = createBridge(send, { transport: 'desktop', user: (() => { try { return os.userInfo().username; } catch (_) { return null; } })() });

  win.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'));
  win.on('closed', () => {
    if (bridge) bridge.dispose();
    bridge = null;
    win = null;
  });
}

// ---- --web mode ------------------------------------------------------------

function stopWeb() {
  if (!webServer) return;
  try {
    webServer.close();
  } catch (_) {}
  webServer = null;
  webPort = 0;
}

// A small always-on-top panel showing the URL, with Open and Stop. Without a
// window there would be no way to stop a GUI process that has no console.
async function createWebStatusWindow() {
  win = new BrowserWindow({
    width: 470,
    height: 300,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Cherry-Pick Studio — web mode',
    webPreferences: {
      preload: path.join(__dirname, 'web-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => {
    stopWeb(); // closing the window IS the documented way to stop the server
    win = null;
  });

  // Load first, so the renderer's listeners exist before we report the port.
  await win.loadFile(path.join(__dirname, 'web-status.html'));

  try {
    const { start } = require('../server/server');
    const r = await start({ port: 0 }); // 0 → the OS hands us a free port
    webServer = r.server;
    webPort = r.port;
    if (win && !win.isDestroyed()) win.webContents.send('cps:web-ready', { port: webPort });
    await shell.openExternal(`http://127.0.0.1:${webPort}`);
  } catch (err) {
    // Show the failure in the window rather than dying silently — the user would
    // otherwise see a process that started and vanished.
    if (win && !win.isDestroyed()) {
      win.webContents.send('cps:web-error', { message: err.message });
    }
  }
}

ipcMain.handle('cps:webOpen', async () => {
  if (!webPort) return { ok: false };
  await shell.openExternal(`http://127.0.0.1:${webPort}`);
  return { ok: true };
});

ipcMain.handle('cps:webStop', () => {
  stopWeb();
  app.quit();
  return { ok: true };
});

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

// One instance only. A second launch would start a second server on a second
// port, splitting the user's work across two independent sessions.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    if (WEB_MODE) createWebStatusWindow();
    else createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (WEB_MODE) createWebStatusWindow();
        else createWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    stopWeb();
    if (process.platform !== 'darwin') app.quit();
  });
}
