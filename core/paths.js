// =============================================================================
// core/paths.js
// Resolves where the tool reads code from and where it WRITES data to.
//
// These differ once the tool is packaged: code lives in a read-only app.asar
// bundle, so logs/ and config/ have to move somewhere writable. Every module
// that touches the filesystem goes through here instead of building
// `__dirname/../<something>` itself.
// =============================================================================
'use strict';

const os = require('os');
const path = require('path');

// core/ sits one level below the tool root.
const TOOL_ROOT = path.join(__dirname, '..');

// Pure so it can be unit-tested without a packaged bundle. Precedence:
//   1. CPS_DATA_DIR   — explicit override (also the hook the tests use)
//   2. packaged app   — a writable per-user folder, since the bundle is not
//   3. tool folder    — the dev checkout, i.e. today's behaviour
// The `data` subfolder is not decoration: Electron already owns
// %APPDATA%\cherry-pick-studio as its userData directory and fills it with
// Chromium's profile (Cache, GPUCache, Local State, Preferences). Writing our
// logs and config alongside those would mix real user data with a browser cache,
// where anything that clears the cache could take the audit trail with it.
function resolveDataRoot({ dataDirEnv, packaged, appData, home, toolRoot }) {
  if (dataDirEnv) return dataDirEnv;
  if (packaged) {
    return appData
      ? path.join(appData, 'cherry-pick-studio', 'data')
      : path.join(home, '.cherry-pick-studio', 'data');
  }
  return toolRoot;
}

// True when running from inside an asar bundle. Deliberately avoids
// require('electron').app.isPackaged: this module is also loaded by the plain
// Node web server, where requiring electron throws.
function isPackaged() {
  return !!process.versions.electron && TOOL_ROOT.includes('app.asar');
}

function dataRoot() {
  return resolveDataRoot({
    dataDirEnv: process.env.CPS_DATA_DIR,
    packaged: isPackaged(),
    appData: process.env.APPDATA,
    home: os.homedir(),
    toolRoot: TOOL_ROOT,
  });
}

const logsDir = () => path.join(dataRoot(), 'logs');
const configDir = () => path.join(dataRoot(), 'config');

// Read-only assets that ship WITH the code, so they follow TOOL_ROOT and ignore
// CPS_DATA_DIR. Packaging unpacks these from the asar, so a packaged run has to
// look in app.asar.unpacked instead of app.asar.
function assetDir(name) {
  const dir = path.join(TOOL_ROOT, name);
  return isPackaged() ? dir.replace('app.asar', 'app.asar.unpacked') : dir;
}

module.exports = { dataRoot, logsDir, configDir, assetDir, resolveDataRoot, TOOL_ROOT };
