# Cherry-Pick Studio

A **browser** and **desktop** UI for automating git cherry-picks into a client
branch — the graphical successor to the `cherry-pick-tool.sh` CLI. Both apps
share **one git engine** (`core/`) and **one frontend** (`frontend/`); only the
transport differs (WebSocket for web, IPC for desktop).

```
cherry-pick-studio/
├── core/               # git engine + run state machine (shared, no UI)
│   ├── git.js          # every git operation, structured results
│   ├── session.js      # pausable cherry-pick run (merge/conflict/push/review)
│   ├── bridge.js       # transport-agnostic command handler
│   └── selftest.js     # integration test (npm test)
├── server/server.js    # Express + WebSocket backend  → browser UI
├── desktop-electron/   # Electron wrapper (main.js, preload.js) → desktop app
├── frontend/           # shared HTML/CSS/JS UI (all CLI features)
└── web-flask/          # Python/Flask port — scaffold for later (see its README)
```

## Prerequisites

| | Browser (web) | Desktop (Electron) |
|---|---|---|
| Git 2.x | ✅ required | ✅ required |
| Node.js 18+ & npm | ✅ required | ✅ required |
| Python | not needed | not needed |

> The Flask port (`web-flask/`) is **not built yet** because Python isn't
> installed on this machine. See `web-flask/README.md` to enable it later.

## Install

```bash
cd cherry-pick-studio
npm install
```

## Run

**Browser UI**
```bash
npm run web          # → http://localhost:4317  (set PORT to change)
```

**Desktop app**
```bash
npm run desktop      # opens the Electron window
```

**Self-test** (creates a throwaway repo + remote and runs a real cherry-pick)
```bash
npm test
```

## How to use

1. **Repository** — enter (or *Browse…* in desktop) your repo path → **Check**.
   Surfaces pending operations (with an *Abort* button) and a dirty worktree
   (with *Auto-stash*).
2. **Client branch** — name the target branch → **Check**. Warns if your local
   branch has **unpushed commits** a fresh checkout would discard, then checks
   out a clean copy from `origin`.
3. **Commits** — paste comma/space-separated commit IDs → **Validate**
   (dedup + format + existence checks).
4. **Options** — push strategy (each / batch), run mode (normal / dry-run /
   review), and log folder.
5. **Review & order** — sorts by date, flags commits already on the target,
   lets you reorder, then **Start**.

During the run, modal dialogs handle **merge-commit `-m` choice**, **conflict
resolve/skip/abort**, **push retry / force-with-lease**, and **review-mode
commit/discard**. A live log and a final summary (with *Pop stash* / *Delete
progress file*) close it out.

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
```
