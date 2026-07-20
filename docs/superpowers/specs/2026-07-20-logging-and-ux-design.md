# Cherry-Pick Studio — audit logging, live status, branch dropdown

Date: 2026-07-20

Three additive features. The cherry-pick `Session` engine is untouched; changes
live in a new `core/tracklog.js`, `core/bridge.js`, `core/git.js`, the two
transport entry files (`server/server.js`, `desktop-electron/main.js`), and the
frontend.

## A. Transaction & error logging

Every user action from both transports flows through `bridge.handle(msg)` — the
single instrumentation point.

**Module `core/tracklog.js`** — `createTracker(meta)` returns
`{ begin(cmd, params) -> seq, error(seq, cmd, params, err), close() }`.

- **Per session:** each bridge instance (one web connection / one desktop
  window) gets a `sessionId` and an identity record. Files are named
  `<YYYYMMDD-HHMMSS>_<sessionId>`.
- **Identity (user + machine + action):** `meta.transport` (`web`|`desktop`),
  `meta.user` (OS username, desktop) or `meta.client` (remote IP, web), plus the
  server's own OS username and hostname. No secrets/tokens are ever logged.
- **Track scope = every command + inputs:** `handle()` calls
  `tracker.begin(cmd, params)` before the switch, writing one entry per command
  (`{ts, sessionId, seq, transport, user, machine, cmd, params}`). `params` is
  the incoming message minus `cmd`/`id`; the serialized form is capped (~8 KB) to
  avoid runaway rows.
- **Error log:** business failures (`fail()`), thrown exceptions (`catch`), and
  session `error` events call `tracker.error(seq, cmd, params, err)`, writing
  `{ts, sessionId, seq, cmd, params, error, stack}`. Each error carries the
  triggering command + inputs and is traceable to the full command sequence via
  `sessionId`.
- **Both formats:** every entry is appended to a `.jsonl` (machine-queryable)
  and a `.log` (human-readable timestamped line).
- **Location:** always the tool's own `logs/` — `logs/tranclogs/` (created at
  session start) and `logs/errorlog/` (created lazily on first error). Never the
  user's custom run-log folder.
- **Safety:** all writes are wrapped so a logging failure can never break a run.

**Wiring:** `server.js` → `createBridge(send, {transport:'web', client:
req.socket.remoteAddress})`; `main.js` → `createBridge(send, {transport:
'desktop', user: os.userInfo().username})`. `createBridge(send, meta={})` keeps
the old single-arg call working (e.g. selftest).

## B. Live "current process" status
A persistent status pill in the header (`#activity`), next to the transport
badge. `setActivity(text)` updates it. `withBusy(btn, label, fn)` sets the pill
to `label` on start and back to `Ready` on finish, so every setup operation
(repo check, fetch, validate, analyze) shows live. `setRunStatus` mirrors the
run phase into the pill too, so during a cherry-pick it shows the current
phase while the run-column banner keeps the per-commit detail.

## C. Searchable origin-branch dropdown
- **`core/git.js listRemoteBranches(repoPath)`** → `git ls-remote --heads
  origin`, parsed to branch names (live list, independent of local fetch state);
  returns `[]` on any failure.
- **Bridge command `listBranches`** → `{ branches }`.
- **Frontend:** the branch `<input>` gains `list="branchList"` and a sibling
  `<datalist id="branchList">`. After a successful repo check, `runRepoCheck`
  requests `listBranches` and fills the datalist with one `<option>` per branch —
  native type-to-search + dropdown, zero dependencies. The Check flow is
  unchanged. If listing fails, the input stays a plain text box (no hard error).

## Verification
- `npm test` (core selftest) still passes — `createBridge` back-compat and no
  engine change.
- Boot the web UI: confirm no console errors, header shows "Ready", branch
  datalist populates after repo check, and `logs/tranclogs/` gains a session
  file with entries for each command.
- Force an error (invalid repo path) and confirm an `logs/errorlog/` file is
  written with the command + message.
