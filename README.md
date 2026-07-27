# Cherry-Pick Studio

A **browser** and **desktop** UI for automating git cherry-picks into a client
branch — the graphical successor to the `cherry-pick-tool.sh` CLI. Both apps
share **one git engine** (`core/`) and **one frontend** (`frontend/`); only the
transport differs (WebSocket for web, IPC for desktop).

```
cherry-pick-studio/
├── core/                    # git engine + run state machine (shared, no UI)
│   ├── git.js               # every git operation, structured results
│   ├── session.js           # pausable cherry-pick run (merge/conflict/push/review)
│   ├── bridge.js            # transport-agnostic command handler
│   ├── paths.js             # where data is written (dev folder vs packaged)
│   ├── repostore.js         # the saved-repository list (config/repos.json)
│   ├── tracklog.js          # audit + error logging
│   ├── selftest-units.js    # fast, git-free unit tests
│   └── selftest.js          # integration test against a real repo
├── server/server.js         # Express + WebSocket backend  → browser UI
├── desktop-electron/        # Electron wrapper → desktop app AND --web mode
├── frontend/                # shared HTML/CSS/JS UI (all CLI features)
├── build/                   # app icon (icon.svg is the source of truth)
├── launchers/               # .bat files + README shipped beside the packaged exe
└── web-flask/               # Python/Flask port — scaffold for later (see its README)
```

## Two ways to run it

### A. Packaged app — nothing to install

`npm run dist` produces `dist/Cherry-Pick Studio-<version>-win-x64.zip`. Unzip it
anywhere and double-click:

| | |
|---|---|
| `Run Desktop.bat` | the app in its own window |
| `Run Web (browser).bat` | local server + your default browser |

**Node.js is not needed** — Electron's main process *is* Node, so the same bundle
serves both modes. Web mode shows a small status window with the URL; closing that
window stops the server.

**Git is still required.** The engine drives the real `git` command. If it is
missing the app says so at startup with install instructions, rather than failing
later with an obscure error.

### B. From source

```bash
npm install
npm run web          # browser UI  → http://localhost:4317  (set PORT to change)
npm run desktop      # Electron window
npm test             # unit suite, then the real-repo integration suite
npm run test:units   # just the fast git-free tests
npm run dist         # build the packaged zip
```

Prerequisites for running from source: **Git 2.x** and **Node.js 18+**. Python is
not needed — the Flask port (`web-flask/`) is a scaffold only.

The `.bat` launchers in the repo root (`run-cherry-pick-studio.bat`,
`run-desktop.bat`, `run-all.bat`) drive `studio.ps1`, which picks a free port and
starts whichever mode is not already running. Those are for a source checkout;
the packaged zip has its own launchers.

## How to use

1. **Repository** — type a path, pick one from the **saved list** (`▾`), or
   *Browse…* in desktop mode → **Check**. Surfaces pending operations (with an
   *Abort* button) and a dirty worktree (with *Auto-stash*).
2. **Client branch** — name the target branch → **Check**. Warns if your local
   branch has **unpushed commits** a fresh checkout would discard, then checks out
   a clean copy from `origin`.
3. **Commits** — paste comma/space-separated commit IDs → **Validate**
   (dedup + format + existence checks).
4. **Options** — push strategy (each / batch), run mode (normal / dry-run /
   review), log folder, and already-applied scan depth.
5. **Review & order** — sorts by date, flags commits already on the target, lets
   you drag rows to reorder, then **Start**.

During the run, modal dialogs handle **merge-commit `-m` choice**, **conflict
resolve/skip/abort**, **push retry / force-with-lease**, and **review-mode
commit/discard**. A live log and a final summary (with *Pop stash*) close it out.

### Saved repositories

Any repo that passes **Check** is remembered, along with the branch you last
checked out for it. Click `▾` in the repository field to pick one — that fills the
path, runs Check, and pre-fills the branch in Step 2.

- `📌` pins a repo to the top of the list; pinned entries are never dropped.
- `✕` forgets one. Nothing is ever removed automatically.
- A path that no longer exists is shown as `(missing)` rather than being deleted.
- Unpinned entries are capped at the 15 most recently used.

The list lives in `config/repos.json` (see *Where data is written*) and is plain
JSON you can edit by hand.

### Resuming an interrupted run

A run that is **aborted** leaves a `.cherry-pick-progress` file, and the next time
you check that repository you are offered **Resume** (load its branch and remaining
commits) or **Start fresh**. A run that *finishes* deletes its own progress file,
so a completed session never asks to be resumed.

## Where data is written

| | Running from source | Packaged app |
|---|---|---|
| Run logs | `<tool>/logs/` | `%APPDATA%\cherry-pick-studio\data\logs\` |
| Audit & error logs | `<tool>/logs/tranclogs`, `logs/errorlog` | same, under `data\logs\` |
| Saved repositories | `<tool>/config/repos.json` | `%APPDATA%\cherry-pick-studio\data\config\repos.json` |

The packaged app cannot write next to itself (the bundle is read-only), so it uses
your user profile — which also means replacing the folder with a newer build keeps
your logs and saved repos. Set **`CPS_DATA_DIR`** to override either location.

> The packaged path deliberately uses a `data\` subfolder: Electron already owns
> `%APPDATA%\cherry-pick-studio` for its own browser cache, and the audit trail
> must not be mixed in with something that gets cleared.

## Security note

The web server binds **`127.0.0.1` only**. It is not reachable from your network,
because the bridge runs git commands against any path on the machine. This also
avoids a Windows firewall prompt on first launch.

## Feature parity with the CLI

All 28 CLI features are preserved: pre-flight checks, idempotency / already-
applied detection (patch-id), pending-op & crash/resume detection, auto-stash,
fetch-before-start, epoch sorting, reorder, push strategies, dry-run & review
modes, conflict-marker verification, merge-commit handling, force-with-lease,
large-batch warning, session logging, and resume.

### Bugs from the CLI fixed by this rewrite
- **Merge-commit menu was swallowed** by command substitution in the shell
  script — here it's a proper dialog.
- **Review-mode conflict no longer force-commits** — resolved changes stay
  staged (`--quit` instead of `--continue`).
- **Crash/resume now works with custom log folders** (recursive search).
- **Fresh-checkout data loss is warned** (unpushed-commit detection) before
  the local branch is deleted.
- **`set -e` leak**, **patch-id O(n×100) scan**, and **summary/total math**
  issues are gone by construction.

### Later fixes
- **A completed run no longer offers to resume itself.** The engine deletes its
  progress file on a clean finish, and resume detection now matches the
  repository *and* checks that commits actually remain.
- **The web server no longer listens on every network interface.**

## Design specs

Each change set is designed before it is built; the specs live in
`docs/superpowers/specs/`. The most recent:

| Spec | Covers |
|---|---|
| `2026-07-25-resume-fix-and-saved-repos-design.md` | the stale resume prompt, the saved-repo picker, `core/paths.js`, loopback binding |
| `2026-07-25-packaging-no-node-design.md` | the packaged zip, `--web` mode, the git startup probe |
