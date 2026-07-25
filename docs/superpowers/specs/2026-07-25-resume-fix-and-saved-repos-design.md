# Resume-prompt fix + saved repo list — design

Date: 2026-07-25
Branch: `ui-fixes-2026-07`

## Problem

Two reports from the same user session:

1. **Stale resume prompt.** The user picked a repo, cherry-picked commits onto a
   client branch, and the run completed. On the next session the wizard still
   showed "⚠ Previous session found — continue last session", offering to resume
   a run that had already finished.

2. **Repo has to be typed or browsed every time.** The user works across several
   repos and re-enters the path on every launch. They want the repos they use
   kept in a file, offered back at load time, with browsing for a new one still
   available.

A third requirement surfaced mid-discussion — running the tool on a machine with
no Node installed, in **both** web and desktop modes. That is a packaging concern,
independent of the two above, and gets its own spec. This spec builds the seams
packaging needs (§4, §4a) so that work does not have to reopen these files.
See §7.

## 1. Root cause — stale resume prompt

Two defects combine. Either alone would produce the bug.

| # | Location | Defect |
|---|----------|--------|
| 1 | `core/session.js:308` `_finish()` | `.cherry-pick-progress` is written after every commit (`_saveProgress`, line 99) and **never removed on a clean finish**. A completed run leaves a "resume me" file behind. |
| 2 | `core/bridge.js:131` `findResume` | Walks the whole `logs/` tree, returns the **first** `.cherry-pick-progress` found in arbitrary DFS order, and checks neither `repo_path` against the repo the user just picked nor whether any commits remain. |

So after any completed run, the next repo **Check** finds the leftover file and
raises the modal — with `remaining=0`, against a repo that may not even be the
one in the file.

The summary panel's "Delete progress file" button (`frontend/app.js:815`) is a
manual workaround for defect 1 and should not be needed on a clean run.

## 2. Fix — resume detection

### 2.1 The session cleans up after itself

`Session.run()` deletes `this.progressFile` when the loop finishes and
`this.aborted` is false. An aborted run keeps its file — that is the only state
worth resuming.

The deletion goes in `run()` rather than `_finish()` because `_finish()` is
skipped entirely on an abort (`session.js:208`), so it cannot distinguish the two
outcomes. `run()` owns the `aborted` flag and is the only place that knows a run
ended cleanly.

Deletion is best-effort (`try/catch`, matching `_saveProgress`); a failed unlink
must not fail the run, because §2.2 makes a leftover file harmless anyway.

Dry runs never reach `_saveProgress` (the dry-run branch `continue`s at
`session.js:157`), so they write no progress file and need no special case.

### 2.2 Resume lookup becomes correct and testable

Move the lookup out of the bridge's `switch` into an exported, unit-testable
function in `core/session.js`, beside `parseProgressFile`:

```
findLatestResume(logBase, repoPath) -> { file, data } | null
```

It collects **every** `.cherry-pick-progress` under `logBase`, then keeps only
entries where both hold:

- `repo_path` matches `repoPath` — compared via `path.resolve()`, and
  case-insensitively on `win32`
- `remaining_commits` is non-empty after splitting on whitespace

Of the survivors it returns the newest by file `mtime`. `bridge.findResume`
becomes a delegation that maps `null` → `{ found: false }` and a hit →
`{ found: true, file, data }`, preserving today's reply contract so
`checkResume()` in the frontend needs no change to its shape.

This also neutralises the progress files already sitting in `logs/` from before
the fix: completed ones have no remaining commits, and interrupted ones belonging
to other repos no longer match. **No cleanup migration, and the existing log
folders stay intact as an audit trail.**

### 2.3 UI consequences

- `_emitSummary` adds `progressLeft: boolean` to its payload. `onSummary`
  renders the "Delete progress file" button only when it is true, so a clean run
  no longer offers to delete a file that is already gone.
- `modalResume` shows the repo path and the progress file's `mtime`, so a
  legitimate prompt is identifiable rather than anonymous.

The Resume / Start-fresh choice itself is unchanged.

## 3. Saved repo list

Auto-remember with pinning. Stored in the tool folder as `config/repos.json`
(added to `.gitignore` alongside `logs/`).

### 3.1 `core/repostore.js` — new module

One responsibility: own `config/repos.json`. Depends only on `fs`, `path`, and
`core/paths.js` (§4).

| Function | Behaviour |
|----------|-----------|
| `list()` | Pinned first (most recently used first), then unpinned (same order). Each entry annotated `exists` (see below). |
| `remember(repoPath, branch)` | Upsert by normalised path. Bumps `lastUsed`; sets `branch` only when one is supplied; preserves `pinned`. Unpinned entries capped at **15** — oldest `lastUsed` dropped. Pinned entries are never dropped and never count toward the cap. |
| `setPinned(repoPath, on)` | Toggles the pin. |
| `remove(repoPath)` | Forgets one entry. |

Record shape:

```json
{
  "version": 1,
  "repos": [
    { "path": "D:\\Projects\\ClientA", "branch": "rel-2026-07",
      "pinned": true, "lastUsed": "2026-07-25T14:20:11.000Z" }
  ]
}
```

Path normalisation for matching: `path.resolve()`, then `toLowerCase()` on `win32`
only. The stored `path` keeps the casing the user typed; matching ignores it.

`exists` is `fs.existsSync(path)` for local paths, but **`null` (unknown) for UNC
paths** (`\\server\share\…`), which are rendered as normal rather than
`(missing)`. `existsSync` against an unreachable network share blocks for seconds,
and `listRepos` populates the dropdown — one dead share must not hang the picker.

Writes are atomic — write `repos.json.tmp`, then `fs.renameSync` over the target
— so an interrupted write cannot leave a half-file. A missing, empty, corrupt, or
wrong-`version` file reads as an empty list and **never throws**; the repo list
is a convenience and must not be able to block the wizard.

### 3.2 Bridge commands

Three new cases in `core/bridge.js`, each a thin delegation to `repostore`:

- `listRepos` → `{ repos }`
- `pinRepo` `{ repoPath, pinned }` → `{ ok }`
- `forgetRepo` `{ repoPath }` → `{ ok }`

Two existing cases gain a `remember()` call on their success path:

- `preflight` — after the repo validates as a git repo. This is the
  "passed **Check**" moment, so every checked repo is remembered.
- `checkoutBranch` — after a successful fresh checkout, recording the branch the
  user actually committed to.

Both calls are best-effort: a `repostore` failure is logged via the existing
`tracker` and does not turn a successful preflight into an error reply.

### 3.3 Frontend — `frontend/combo.js` (new)

`frontend/app.js` is 835 lines and its branch combobox (`app.js:273-350`) is 78
lines of keyboard, ARIA, and mouse logic that the repo picker needs verbatim.
Rather than clone it, extract the mechanics:

```
createCombo({ input, listBox, container, renderRow, onChoose, onRowAction })
  -> { setData, hide, open }
```

The module owns filtering, active-row tracking, arrow/Enter/Escape handling,
`aria-activedescendant`, the outside-click close, and the `input.disabled` guard.
Each call site supplies its own `renderRow`. The branch combobox is rebuilt on it
with no behaviour change; `app.js` drops back under 800 lines.

`onRowAction(name, item)` handles clicks on controls inside a row (pin, forget)
without selecting the row or closing the list.

### 3.4 Frontend — repo picker

`index.html`: wrap `#repoPath` in `.combo`, add `<ul id="repoListBox">` and a `▾`
caret button inside the field. The caret matters for discoverability — the branch
combo opens on focus, but nothing focuses `#repoPath` on first load.

Row contents: path (primary), remembered branch (dim), `(missing)` marker,
`📌` pin toggle, `✕` forget.

Behaviour:

- Opens on caret click, focus, or typing; filters on substring, as the branch
  combo does.
- Choosing a row fills the path and calls `runRepoCheck()` directly — that
  function already exists (`app.js:230`) precisely so Check can be triggered
  without the button. Check is read-only, so this safely turns a two-click action
  into one.
- After a chosen repo's Check succeeds, its remembered `branch` prefills step 2's
  input. The user still presses step 2's own Check; nothing is validated on their
  behalf.
- A path that no longer exists renders greyed with `(missing)` but stays
  selectable, so the user sees the real error instead of silence. **Entries are
  never auto-deleted** — removal is always the explicit `✕`.
- On boot, when the list is non-empty, a hint under the field points at it
  ("3 saved repos — click ▾ to pick one, or Browse for a new one"). **The path is
  never silently prefilled**, so Check can never fire against a repo the user did
  not look at.
- `lockControls($('repoPath'), ...)` after a successful Check already disables the
  input; the combo's `input.disabled` guard keeps the list shut, and the caret is
  disabled with it.

`resetSession()` re-enables the caret and refreshes the list, so a repo
remembered during the previous session appears without a restart.

## 4. `core/paths.js` — writable data root

Both `core/bridge.js:20` (`TOOL_LOGS_DIR`) and `core/tracklog.js:21`
(`LOGS_ROOT`) hard-code `path.join(__dirname, '..', 'logs')`. `config/repos.json`
would follow the same pattern and inherit the same limitation: inside a packaged
app that directory is read-only (§7).

One small module resolves the root, in precedence order:

1. `process.env.CPS_DATA_DIR`, when set — also the hook the tests use
2. the packaged-app location, when running from a read-only bundle
3. the tool folder — today's behaviour, and the default for a dev checkout

```
paths.dataRoot()        -> <root>
paths.logsDir()         -> <root>/logs
paths.configDir()       -> <root>/config
paths.assetDir(name)    -> <tool>/<name>, redirected to app.asar.unpacked
                           when running from a packaged bundle
```

`assetDir` exists because §7's packaging unpacks `frontend/` and `docs/` from the
asar, so read-only asset paths need the `app.asar` → `app.asar.unpacked` swap. It
is a plain passthrough in a dev checkout.

`bridge.js` and `tracklog.js` switch to these helpers. For a normal `npm start`
or `npm run desktop` the resolved paths are byte-identical to today's, so this is
a no-op refactor for existing users — it just stops the packaging work from
having to reopen three files.

## 4a. Bind the web server to loopback

`server/server.js:48` calls `server.listen(PORT)`, which binds every interface.
Any machine on the same network can therefore reach the WebSocket bridge, and the
bridge executes git operations against arbitrary paths on the user's disk. Change
it to `server.listen(PORT, '127.0.0.1')`.

This is included here rather than in the packaging spec because the exposure
exists today. It also pre-empts the Windows Firewall prompt an unsigned packaged
exe would otherwise trigger on first run. The trade-off is that the web UI stops
being reachable from another machine — not a use case worth keeping for a tool
that drives local git checkouts.

## 5. Error handling

| Failure | Behaviour |
|---------|-----------|
| `repos.json` missing / corrupt / unknown `version` | Reads as empty list; the picker shows the plain input. Never throws. |
| `repos.json` unwritable | `remember`/`pin`/`forget` fail silently, logged via `tracker`. The wizard is unaffected. |
| Progress file unlink fails on clean finish | Ignored. §2.2's filtering makes a leftover file harmless. |
| Progress file unparseable | Skipped by `findLatestResume`; other candidates still considered. |
| Saved repo path deleted since it was stored | Rendered `(missing)`; selecting it runs Check, which reports "Path does not exist." through the existing error path. |
| `listRepos` request fails | Picker degrades to a plain text input — the same fallback `populateBranchList` already uses. |

The rule throughout: the repo list and the resume prompt are conveniences. Any
failure in them degrades to today's behaviour and never blocks a cherry-pick.

## 6. Testing

`core/selftest.js` (run by `npm test`) is a real integration test — it builds a
bare remote plus a working clone in a temp dir and drives `Session` end to end.
Extend it in the same style, using `CPS_DATA_DIR` pointed at the temp workspace.

**Resume (§2):**
1. After the existing successful 3-commit run, assert the progress file is
   **gone**.
2. Run a session aborted mid-way; assert its progress file **survives**.
3. Build a temp log tree holding three progress files — one interrupted for repo
   A, one completed (empty `remaining_commits`) for repo A, one interrupted for
   repo B — and assert `findLatestResume(base, A)` returns only the first.
4. Assert `findLatestResume` returns `null` when the only candidate is complete —
   the exact reported bug.
5. Assert the newest-by-mtime candidate wins when two interrupted files match.

**Repo store (§3.1):**
6. `remember` then `list` round-trips path, branch, and `lastUsed`.
7. Re-remembering a path updates it in place rather than duplicating, and
   preserves `pinned`.
8. On `win32`, differently-cased paths resolve to one entry.
9. 20 unpinned repos → 15 kept, oldest dropped.
10. A pinned entry survives that eviction and does not count toward the cap.
11. `list` orders pinned before unpinned, each newest-used first.
12. Corrupt JSON → empty list, no throw.
13. `remove` and `setPinned` behave, including for an unknown path (no-op).
14. A UNC path (`\\server\share\repo`) comes back with `exists: null`, not
    `false` — proving the blocking stat is skipped.

**Paths (§4):**
15. `CPS_DATA_DIR` is honoured; unset resolves to the tool folder.
16. `assetDir('frontend')` is a passthrough in a dev checkout.

**Frontend and server** have no test harness, so they get a manual checklist in
the PR description:

- List opens via caret, focus, and typing; arrows and Enter select; Escape and
  outside-click close.
- Pin reorders without closing the list; forget removes without closing it.
- A missing path renders `(missing)` and surfaces the Check error when selected.
- The list stays shut while the repo input is locked after a successful Check.
- The branch combobox behaves exactly as it did before the extraction.
- **§4a:** `npm run web` still serves the UI on `http://localhost:<port>`, and the
  same port on the machine's LAN IP now refuses the connection.

## 7. Out of scope — packaging (next spec)

Agreed sequencing: this spec ships first, then a separate spec packages the tool
as a portable Electron exe so it runs with no Node installed — offering **both
web and desktop modes**, per the follow-up requirement. Findings already verified,
recorded so that spec need not rediscover them.

### 7.1 Both modes from one exe

Electron's main process is Node, so the packaged app can start the existing
Express server itself. No second artifact and no system Node:

| Launch | Behaviour |
|--------|-----------|
| `Cherry-Pick Studio.exe` | Desktop window + IPC bridge — as `npm run desktop` today |
| `Cherry-Pick Studio.exe --web` | Main process starts `server/server.js` on a free loopback port, opens the default browser, shows no window |
| Desktop UI → "Open in browser" | Starts the same server on demand from the running app |

`ELECTRON_RUN_AS_NODE=1 <exe> server/server.js` is an alternative that runs the
bundled binary as a plain Node interpreter with no Chromium. The `--web` flag is
preferred: one entry point, no environment juggling inside the `.bat` launchers.

A bundled `node.exe` was considered and rejected for this requirement — it yields
web mode only, since desktop mode needs the Electron binaries regardless.

### 7.2 Works unchanged under `app.asar`

`win.loadFile` on `frontend/index.html` (Electron's patched `fs` reads asar
transparently); `git` via `execFile`/`spawn` in `core/git.js` (child processes are
unaffected by asar); the `frontend/transport.js` Electron branch (already how
`npm run desktop` runs).

### 7.3 Blockers

1. `core/bridge.js:20` — `logs/` resolves inside the read-only asar, so `start`'s
   `fs.mkdirSync` throws and **every run fails with an error reply**. Resolved by
   §4.
2. `core/tracklog.js:21` — same path bug in the audit logger. Its writes go
   through `safeAppend`'s `try/catch` (line 51), so the symptom is the audit and
   error trail **silently vanishing**, not a crash. Resolved by §4.
3. `desktop-electron/main.js:60` — `shell.openPath` cannot open a docs file
   inside a virtual archive, so **Help silently does nothing**. Needs
   `asarUnpack: ["docs/**"]`.
4. **`express` and `ws` must stay bundled.** They are only used by
   `server/server.js`, but web mode now lives inside the exe, so they remain in
   `dependencies` and ship in the app.
5. **Assets must be unpacked:** `asarUnpack: ["frontend/**", "docs/**"]`.
   `express.static` delegates to the `send` module, which stats directories and
   streams files — a known rough edge against asar paths. Serving real files
   removes the risk instead of betting on it, and covers blocker 3 too. Requires
   `paths.assetDir()` (§4).
6. **Port selection must move into the app.** `server/server.js:14` hard-codes
   `PORT || 4317` and relies on `studio.ps1:51 Get-FreePort` passing a free port
   via env. There is no PowerShell inside the exe, so wrap the server body in
   `start({ port } = {})` that listens on `port ?? 0` and returns the assigned
   port, keeping a `require.main === module` block so `npm run web` is unchanged.
   The packaged app requests port 0 and lets the OS pick, which removes the
   `Get-FreePort` / `Win32_Process` sniffing path entirely for packaged users.
7. **Single-instance lock.** `app.requestSingleInstanceLock()`, so a second launch
   focuses the existing window rather than starting a second server on a second
   port.

Loopback binding is handled in §4a of this spec, ahead of packaging.

### 7.4 Launchers

`run-desktop.bat` → the exe; `run-cherry-pick-studio.bat` → the exe with `--web`;
`run-all.bat` → both. `studio.ps1` stays as-is for the dev/Node workflow, so a
source checkout keeps working with `npm start` / `npm run desktop`.

### 7.5 Not fixable in code

An unsigned exe triggers Windows SmartScreen on first run and may be quarantined
by corporate AV — only a signing certificate removes that. The portable target
extracts to `%TEMP%` per launch, so the first start is a couple of seconds slower
and data must live outside the bundle (§4). **git remains a prerequisite either
way** — packaging removes the Node dependency, not the git one. Expect roughly
90–110 MB for the exe, covering both modes.

## 8. Files touched

| File | Change |
|------|--------|
| `core/paths.js` | **new** — writable data root + asset path resolution |
| `core/repostore.js` | **new** — `config/repos.json` owner |
| `frontend/combo.js` | **new** — extracted combobox mechanics |
| `core/session.js` | delete progress file on clean finish; export `findLatestResume`; `progressLeft` in summary |
| `core/bridge.js` | delegate `findResume`; add `listRepos`/`pinRepo`/`forgetRepo`; `remember()` on preflight + checkout; use `paths.logsDir()` |
| `core/tracklog.js` | use `paths.logsDir()` |
| `server/server.js` | bind to `127.0.0.1` (§4a) |
| `frontend/app.js` | repo picker; rebuild branch combo on `combo.js`; conditional delete-progress button; richer resume modal |
| `frontend/index.html` | repo combo markup + caret; load `combo.js` |
| `frontend/styles.css` | repo row styles (branch, missing, pin, forget) |
| `core/selftest.js` | tests 1–16 |
| `.gitignore` | add `config/` (the tool's data dir, alongside `logs/`) |
