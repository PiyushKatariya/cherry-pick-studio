# Cherry-Pick Studio — UI fixes design

Date: 2026-07-20

Five frontend fixes/improvements to the wizard. All changes are confined to
`frontend/index.html`, `frontend/app.js`, and `frontend/styles.css`. The core
git engine (`core/`) and both transports (`server/`, `desktop-electron/`) are
untouched.

## Problems being solved

1. **Step 4 "Options" stays editable after the plan is built.** Steps 1–3 lock
   with a 🔒 badge once committed, but Step 4 never does, so push strategy, run
   mode, log folder, and scan depth remain changeable after `Analyze & build
   plan` — inconsistent and misleading (scan depth actually affects the plan).
2. **The resume choice can be ignored.** When a prior session is found, the
   Resume / Start-fresh banner is non-blocking; the wizard is usable without
   choosing.
3. **Reorder does nothing on desktop.** The Reorder button uses
   `window.prompt()`, which Electron's renderer does not implement (returns
   null, logs a warning). Works in the browser build, silently no-ops on desktop.
4. **No way to add/update/delete commit IDs after building the plan.** Step 3
   locks after validation; the only way to change the commit list is a full
   New session.
5. **Scan-depth control is clunky.** It is an always-visible number input whose
   semantics (blank = 200, 0 = exact-hash only) are non-obvious.

## Design

### 1. Lock all of Step 4 when the plan is built
In the `analyzeRunBtn` success path (only when a non-empty plan is produced),
call `completeStep('step-options')` in addition to the existing
`lockControls($('analyzeRunBtn'))`. This applies the 🔒 badge and disables all
Step 4 controls. Undone by *New session* (`resetSession` already reopens
`step-options`) and by the new *Edit commits* flow (#3).

### 2. Blocking modal for the resume choice
Remove the `#resumeBanner` element and its two handlers. In `checkResume`, when
a session is found, call a new `modalResume(data, file)` that uses the existing
`showModal`/`hideModal` overlay (no outside-click / dismiss). Two choices:
- **Resume** — pre-fill branch, commits, push mode, run mode from the saved
  session and reopen `step-branch`/`step-commits` (the current `resumeStartBtn`
  behavior), then hide the modal.
- **Start fresh** — delete the progress file (current `resumeIgnoreBtn`
  behavior), then hide the modal.

`resetSession` is updated to stop referencing `#resumeBanner`.

### 3. "Edit commits" button
Add an **✏ Edit commits** button to the Step 5 `#orderActions` row. On click:
- `reopenStep('step-commits')` and `reopenStep('step-options')`
- clear `state.plan`, `state.applied`, `state.preSkipped`; clear
  `#orderTableWrap` and `#appliedNote`; hide `#orderActions`
- `unlockControls($('analyzeRunBtn'))` and re-lock Step 5 (`lock('step-order')`
  stays open only after re-validate)

The user then edits the textarea (add/remove/change IDs), clicks *Validate
commits* (existing handler re-locks Step 3 and unlocks Step 5), then *Analyze &
build plan* to rebuild the plan.

### 4. Drag-and-drop reorder
Remove the `#reorderBtn` element and its `prompt()` handler. In `renderPlan`:
- add a leading drag-handle cell (⠿) per row and set `draggable="true"` on rows
- track the dragged row index; on `dragover` allow drop; on `drop` splice
  `state.plan` to the new position and re-render (rows renumber automatically)
- add a `Drag rows to reorder` hint above/below the table

Update the two former `reorderBtn` references: the `done`-event backstop
(`app.js` ~180) and the `startBtn` handler (~466) no longer disable it. Runs
freeze dragging for free via the existing `.setup.run-active { pointer-events:
none; }` rule.

### 5. Scan depth → checkbox + conditional textbox
Replace the scan-depth number input with:
- a checkbox `#scanDeepChk` labelled "Deep-scan branch for already-applied
  commits (patch-id)", **unchecked by default**
- a number input `#scanDepth` (default value 200) shown only when the checkbox
  is checked (toggled via a `change` listener adding/removing `.hidden`)

In `analyzeRun`, compute `scanDepth = scanDeepChk.checked ? (parseInt(scanDepth
.value,10) || 200) : 0` and always send it. `core/git.js alreadyApplied`
already treats `0` as exact-hash-only, so the default is the fast path.

## Out of scope
Competitor-inspired features (`-x` provenance, multi-target branches, auto-open
PR, etc.) are tracked separately and not part of this change.

## Verification
No frontend test harness exists (`npm test` covers `core/` only). Verify by
manual walkthrough in both the browser (`npm run web`) and desktop (`npm run
desktop`) builds:
- Step 4 locks after Analyze; New session and Edit re-open it.
- Resume modal blocks the page until a choice is made.
- Reorder works by dragging in the desktop app.
- Edit commits reopens Steps 3–4 and rebuilds the plan.
- Scan checkbox off → exact-hash only; on → textbox with depth.
