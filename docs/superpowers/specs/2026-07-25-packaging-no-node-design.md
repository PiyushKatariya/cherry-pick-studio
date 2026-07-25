# Packaging: run without Node, in both web and desktop modes — design

Date: 2026-07-25
Branch: `ui-fixes-2026-07`
Follows: `2026-07-25-resume-fix-and-saved-repos-design.md` (§7 recorded the
findings this spec builds on)

## Problem

The tool requires Node.js. `studio.ps1:136` checks for it and stops with
"Install it from: https://nodejs.org/" when it is missing, so a colleague who is
handed the folder cannot run anything. Both modes must work without Node — the
browser UI and the desktop app.

## 1. Approach

Ship a packaged Electron app. Electron's main process **is** Node, so one bundle
covers both modes: it opens the desktop window, and it can start the existing
Express server for the browser UI. No system Node, one artifact.

A bundled `node.exe` was considered and rejected: it yields web mode only, since
desktop mode needs the Electron binaries regardless.

**Deliverable** — a zip, unpacked anywhere, nothing installed:

```
Cherry-Pick-Studio-1.0.0-win-x64.zip        (~95 MB)
  Cherry-Pick Studio.exe
  Run Desktop.bat            → "%~dp0Cherry-Pick Studio.exe"
  Run Web (browser).bat      → "%~dp0Cherry-Pick Studio.exe" --web
  README.txt
```

Two `.bat` files rather than one in-app button, so the mode is chosen at launch.
That matters: the desktop window and a browser tab each create their own bridge
(IPC vs WebSocket) and are therefore **independent sessions**, not two views of
one. Choosing at launch removes any way to start two cherry-picks against one
repo by accident.

`%~dp0` makes each `.bat` resolve the exe next to itself, so the folder can live
anywhere. A `.bat` dragged out of the folder stops working — accepted, and
README.txt says to keep them together.

**git remains a prerequisite.** The engine shells out to `git` (`core/git.js:31`,
`:302`). Packaging removes the Node dependency and nothing else. README.txt states
this, and §5 makes the app say so plainly instead of failing obscurely.

## 2. `--web` mode

`desktop-electron/main.js:64` currently calls `createWindow()` unconditionally.
It gains a branch on `process.argv`.

With `--web` the main process starts the server and opens the default browser —
but it must still show **something**, because a GUI Electron process with no
window and no console cannot be stopped: nothing to Ctrl-C, nothing to close. So
`--web` opens a small always-on-top status window:

```
┌────────────────────────────────────────────┐
│  🍒  Cherry-Pick Studio — web mode         │
│                                            │
│  Running at  http://127.0.0.1:52413        │
│                                            │
│  [ Open in browser ]   [ Stop server ]     │
│                                            │
│  Closing this window stops the server.     │
└────────────────────────────────────────────┘
```

This is the whole stop mechanism, and it also gives the user the URL and a way to
reopen the tab. A tray icon was considered and rejected as more code for less
clarity.

The window is a small static page, `desktop-electron/web-status.html`, loaded
directly. It does not use the bridge or the wizard frontend, so it gets its own
minimal `desktop-electron/web-preload.js` exposing just `openBrowser()`, `stop()`
and an `onReady(port)` event — reusing `preload.js` would hand a status window the
whole command API for no reason.

This supersedes the previous spec's §7, which assumed electron-builder's
`portable` target. `zip` is used instead, so there is no self-extract to `%TEMP%`
on each launch and no matching first-start delay.

## 3. Server refactor

`server/server.js` hard-codes `PORT || 4317` at module scope and calls
`listen()` as a side effect of being required. Two problems for packaging: the
port cannot be chosen by the caller, and requiring the module starts a server.

Wrap the body in a function:

```
start({ port } = {}) -> Promise<{ server, port }>
```

- listens on `port ?? 0` — port 0 lets the OS assign a free one, and the resolved
  value comes back from `server.address().port`
- keeps the `HOST = '127.0.0.1'` bind from the previous spec (§4a there)
- a `require.main === module` block preserves today's `npm run web` behaviour
  exactly, including the console banner and `PORT` from the environment

This deletes the need for `studio.ps1:51 Get-FreePort` and its
`Win32_Process`/`Get-NetTCPConnection` port sniffing in the packaged path — the
app asks for port 0 and is told what it got. `studio.ps1` keeps its own logic for
the dev workflow, untouched.

## 4. Build configuration

`electron-builder` as a devDependency, driven from `package.json`:

| Setting | Value | Why |
|---|---|---|
| `target` | `zip` (win, x64) | Matches the deliverable. Avoids the `portable` target's self-extract-to-`%TEMP%` on every launch. |
| `files` | `core/**`, `frontend/**`, `desktop-electron/**`, `docs/**`, `package.json` | `server/**` too — web mode needs it. |
| `asarUnpack` | `frontend/**`, `docs/**` | See below. |
| `extraFiles` | the two `.bat` files, `README.txt` | Beside the exe. **Not** `extraResources`, which would bury them in `resources/` where `%~dp0` could not reach the exe. |
| `npmRebuild` | `false` | No native modules; `express`/`ws` are pure JS. |

`express` and `ws` stay in `dependencies` and ship inside the bundle. The previous
spec's §7 initially suggested excluding them; web-mode-in-the-exe makes them
required.

**Why `frontend/` and `docs/` are unpacked from the asar:**

1. `shell.openPath` (`main.js:60`) cannot open a file inside a virtual archive, so
   the Help button silently does nothing.
2. `express.static` delegates to the `send` module, which stats directories and
   streams files. Electron patches `fs` for asar, but this is a known rough edge;
   serving real files removes the risk rather than betting on it.

`core/paths.js` already handles the resulting `app.asar` → `app.asar.unpacked`
redirect via `assetDir()`, and `server/server.js` already calls it. No new work.

## 5. Fail clearly when git is missing

A packaged app handed to someone without git currently fails at the first
`execFile('git', ...)` with a raw `ENOENT`, surfaced as an unexplained error
string. Since packaging is precisely what puts the tool in front of people who
never set up a dev environment, add a startup probe:

- `core/git.js` gains `gitVersion()` — runs `git --version`, resolves the version
  string or `null`.
- The bridge gains a `probe` command returning `{ git: <version|null> }`.
- The frontend calls it on boot; when git is absent it shows a blocking banner
  with what to install and stops there, rather than letting the user reach Step 1
  and hit a confusing failure.

This is small, and it is the difference between "this tool is broken" and "install
git". It belongs with the change that creates the audience for it.

## 6. What already works, unchanged

Verified while writing the previous spec:

- `win.loadFile` on `frontend/index.html` — Electron's patched `fs` reads asar
- `git` via `execFile`/`spawn` — child processes are unaffected by asar
- `frontend/transport.js` picks IPC in the Electron window and WebSocket in a
  browser tab, entirely from whether `window.cps` exists
- `core/paths.js` already routes `logs/` and `config/` to
  `%APPDATA%\cherry-pick-studio\` when packaged, and it is unit-tested

## 7. Data location

Packaged runs write to `%APPDATA%\cherry-pick-studio\data\{logs,config}`, per
`core/paths.js`. Deliberately **not** next to the exe: the zip may be unpacked
somewhere read-only, and a per-user location survives replacing the folder with a
newer build. `CPS_DATA_DIR` still overrides for anyone who wants the data beside
the exe.

The `data` subfolder is required, not cosmetic — Electron already owns
`%APPDATA%\cherry-pick-studio` for Chromium's profile. See the findings in §9.

## 8. Error handling

| Failure | Behaviour |
|---|---|
| Port 0 cannot bind | The status window shows the error instead of a blank panel; the exe exits non-zero. |
| `--web` and the browser fails to open | The status window still shows the URL to copy manually. |
| Second launch while one is running | `app.requestSingleInstanceLock()` — focuses the existing window rather than starting a second server on a second port. |
| git missing | §5's banner. |
| `%APPDATA%` unwritable | `repostore` already degrades silently; session logging already uses `try/catch`. The run itself proceeds. |
| `.bat` separated from the exe | Fails with a plain "cannot find" from cmd. README.txt covers it. |

## 9. Testing

The suites from the previous spec keep passing unchanged — this spec adds a build,
not new core logic. Additions:

**Automated (`core/selftest-units.js`):**
1. `server.start({port:0})` resolves with a real port, serves `/health`, and
   `close()` releases it.
2. `start()` binds `127.0.0.1` — `server.address().address === '127.0.0.1'`.
3. Requiring `server/server.js` does **not** start a server (the
   `require.main` guard holds).
4. `gitVersion()` returns a version string on this machine.
5. `gitVersion()` resolves `null` rather than throwing when `git` is not on PATH
   (a stripped-PATH child process).

**Manual, against the built exe — all run with `PATH` stripped of every Node
directory, so each result below also re-proves the no-Node claim:**

| # | Check | Result |
|---|-------|--------|
| 6 | `Run Web (browser).bat` binds a free loopback port and serves the wizard | ✅ `127.0.0.1:50421`; browser connected over WS, badge "web" |
| 7 | Full cherry-pick of 2 commits through the packaged app | ✅ 2 succeeded, 0 failed; both landed on `origin/client` |
| 8 | Help guide reachable (proves the `asarUnpack` fix) | ✅ `/docs/Cherry-Pick-Studio-Guide.html` → 200 |
| 9 | Data lands in the namespaced folder | ✅ `%APPDATA%\cherry-pick-studio\data\logs\...` |
| 10 | Second launch does not start a second instance | ✅ 1 windowed process before and after |
| 11 | `Run Desktop.bat` opens the wizard and uses IPC, not a port | ✅ window opened, zero listening ports |
| 12 | The renderer really loads from inside `app.asar` | ✅ audit log shows a `desktop`-transport session issuing `listRepos` + `probe`, which only happens once `app.js` runs |
| 13 | Missing git is reported, not crashed into | ✅ stop screen shown when `PATH` lacked git too |
| 14 | A finished run leaves nothing to resume (the bug behind the previous spec) | ✅ no progress file written; re-checking the repo raised no modal; summary showed no "Delete progress file" button |

`PATH` was reduced to Git's `usr\bin` + `mingw64\bin` + `C:\Windows\system32`, with
`Get-Command node` confirming Node was unreachable in the launching shell. This
machine has Node installed, so this is the strongest evidence available short of a
clean VM — recorded as such, **not** as "tested on a machine without Node".

### Findings from building it

Two defects that only a real build could surface, both fixed:

1. **`%APPDATA%\cherry-pick-studio` is already Electron's `userData` directory** —
   Chromium fills it with `Cache`, `GPUCache`, `Local State` and `Preferences`,
   because `package.json` `name` is `cherry-pick-studio`. Writing `logs/` and
   `config/` alongside those would mix the audit trail into a browser cache, where
   a cache cleanup could delete it. `resolveDataRoot` now returns a `data`
   subfolder (§7), covered by a regression test asserting the bare path is *not*
   used.
2. **A port clash killed the process instead of rejecting.** `ws` mirrors the http
   server's `'error'` onto itself, so `EADDRINUSE` arrived on two emitters and the
   unhandled one crashed the app — meaning the `--web` status window would have
   vanished rather than showing the problem. `start()` now handles both emitters
   and rejects once.

## 10. Out of scope

- **Code signing.** An unsigned exe triggers Windows SmartScreen on first run and
  may be quarantined by corporate AV. Only a certificate (~$100–400/yr) fixes it;
  until then users click *More info → Run anyway*. Flagged in README.txt.
- **macOS and Linux targets.** Windows x64 only, matching the audience.
- **Auto-update.** No update channel; a new version is a new zip.
- **Bundling git.** Named here only because it is the obvious next question, and
  the answer is no.

## 11. Files touched

| File | Change |
|---|---|
| `desktop-electron/web-status.html` | **new** — the `--web` status window |
| `desktop-electron/web-preload.js` | **new** — minimal API for that window |
| `package.json` | `electron-builder` devDependency, `build` config, `dist` script |
| `desktop-electron/main.js` | `--web` branch, status window, single-instance lock, `cps:openWeb`/`cps:stopWeb` IPC |
| `server/server.js` | `start({port})` + `require.main` guard |
| `core/git.js` | `gitVersion()` |
| `core/bridge.js` | `probe` command |
| `frontend/app.js` | boot-time git probe + blocking banner |
| `frontend/styles.css` | banner style |
| `core/selftest-units.js` | tests 1–5 |
| `build/Run Desktop.bat`, `build/Run Web (browser).bat`, `build/README.txt` | **new** — shipped beside the exe |

`.gitignore` already lists `dist/`, so build output is ignored without a change.
