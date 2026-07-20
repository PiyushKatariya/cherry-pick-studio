// =============================================================================
// frontend/app.js  —  UI controller for Cherry-Pick Studio
// =============================================================================
(function () {
  'use strict';

  const T = window.Transport;
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const state = {
    repoPath: '',
    branch: '',
    valid: [],        // validated commit infos
    plan: [],         // ordered infos to run
    applied: [],      // already-applied infos
    preSkipped: 0,
    originalTotal: 0,
    didStash: false,
    stashRef: '',
  };

  function unlock(stepId) { $(stepId).classList.remove('locked'); }
  function lock(stepId) { $(stepId).classList.add('locked'); }

  // Run an async button action while disabling the button + showing a spinner.
  // Guards against double-clicks; restores the button when done (unless its step
  // has since been marked .done, in which case it stays disabled).
  async function withBusy(btn, label, fn) {
    if (btn.disabled) return;            // already in flight or locked
    const prevHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>${label || 'Working…'}`;
    try {
      return await fn();
    } finally {
      btn.innerHTML = prevHTML;
      const step = btn.closest('.step');
      // Keep the button disabled if its step is fully done, or if it was
      // explicitly locked during the action (e.g. a validated input's button).
      btn.disabled = !!(step && step.classList.contains('done')) || btn.classList.contains('field-locked');
    }
  }

  // Lock specific controls (input/textarea/button) so they can't be changed once
  // that part of a step has been validated. Leaves the rest of the step usable.
  function lockControls(...els) {
    els.forEach((el) => { if (el) { el.disabled = true; el.classList.add('field-locked'); } });
  }
  function unlockControls(...els) {
    els.forEach((el) => { if (el) { el.disabled = false; el.classList.remove('field-locked'); } });
  }

  // Mark a step as fully completed: locks all of its inputs/buttons + shows the
  // 🔒 badge, so earlier steps can't be edited once the user has moved forward.
  function completeStep(stepId) {
    const step = $(stepId);
    step.classList.add('done');
    step.querySelectorAll('input, textarea, button').forEach((el) => { el.disabled = true; el.classList.add('field-locked'); });
  }

  // Re-open a completed/locked step (used if the user resets / resumes a session).
  function reopenStep(stepId) {
    const step = $(stepId);
    step.classList.remove('done');
    step.querySelectorAll('input, textarea, button').forEach((el) => { el.disabled = false; el.classList.remove('field-locked'); });
  }

  // Freeze / unfreeze the whole setup column while a cherry-pick run is active.
  function freezeSetup(on) {
    document.querySelector('.setup').classList.toggle('run-active', on);
  }

  // Show / update / hide the live "process is running" banner so the user can
  // always tell whether a cherry-pick is actively working, paused, or finished.
  //   mode: 'running' | 'waiting' | 'hide'
  function setRunStatus(mode, text) {
    const el = $('runStatus');
    const bar = $('progressBarWrap');
    if (mode === 'hide') {
      el.classList.add('hidden');
      bar.classList.remove('active');
      return;
    }
    el.classList.remove('hidden');
    el.classList.toggle('waiting', mode === 'waiting');
    $('runStatusText').textContent = text ||
      (mode === 'waiting' ? 'Paused — waiting for your response' : 'Cherry-pick in progress');
    $('runDots').style.display = mode === 'waiting' ? 'none' : '';
    bar.classList.toggle('active', mode === 'running');   // animated stripes only while running
  }

  // Reset the whole wizard to a fresh state so the user can run another batch
  // WITHOUT closing & reopening the tool. The repo path text is kept (same repo,
  // most likely) but re-validated; everything downstream is cleared & re-locked.
  function resetSession() {
    // ---- state ----
    state.branch = '';
    state.valid = [];
    state.plan = [];
    state.applied = [];
    state.preSkipped = 0;
    state.originalTotal = 0;
    state.didStash = false;
    state.stashRef = '';

    // ---- inputs & status text ----
    $('branchName').value = '';
    $('commitInput').value = '';
    $('scanDeepChk').checked = false;
    $('scanDepth').value = '200';
    setStatus($('repoStatus'), '');
    setStatus($('branchStatus'), '');
    setStatus($('commitStatus'), '');
    setStatus($('appliedNote'), '');
    $('orderTableWrap').innerHTML = '';

    // ---- conditional rows back to hidden ----
    ['repoActions', 'abortPendingBtn', 'stashBtn', 'branchConfirm', 'orderActions', 'scanDepthWrap']
      .forEach((id) => $(id).classList.add('hidden'));

    // ---- re-open every step, then re-lock everything past step 1 ----
    ['step-repo', 'step-branch', 'step-commits', 'step-options', 'step-order'].forEach(reopenStep);
    ['step-branch', 'step-commits', 'step-options', 'step-order'].forEach(lock);

    // ---- progress + summary panes ----
    Object.keys(liRefs).forEach((k) => delete liRefs[k]);
    $('progressList').innerHTML = '';
    $('progressMeta').textContent = '';
    $('progressBar').style.width = '0';
    $('progressBarWrap').classList.add('hidden');
    setRunStatus('hide');
    $('summary').classList.add('hidden');
    $('summary').innerHTML = '';

    // ---- start button + freeze state ----
    const sb = $('startBtn');
    sb.disabled = false;
    if (startBtnLabel) sb.innerHTML = startBtnLabel;
    freezeSetup(false);

    $('repoPath').focus();
    appendLog('info', '— new session — paste the next batch when ready.');
  }

  function setStatus(el, html) { el.innerHTML = html; }
  function line(cls, txt) { return `<div class="${cls}">${txt}</div>`; }

  // ---- boot --------------------------------------------------------------
  T.init().then((kind) => {
    const b = $('transportBadge');
    b.textContent = kind === 'electron' ? 'desktop' : 'web';
    b.className = 'badge live';
    if (T.isElectron) $('browseBtn').classList.remove('hidden');
  });

  // ---- Help button: open the user guide ----------------------------------
  $('helpBtn').addEventListener('click', () => {
    if (T.isElectron && window.cps && window.cps.openGuide) window.cps.openGuide();
    else window.open('/docs/Cherry-Pick-Studio-Guide.html', '_blank');
  });

  // ---- New session (header): reset the wizard without restarting the tool --
  $('newSessionTopBtn').addEventListener('click', () => {
    const running = document.querySelector('.setup').classList.contains('run-active');
    if (running) { alert('A cherry-pick run is in progress — wait for it to finish first.'); return; }
    if (!confirm('Start a new session? This clears the current branch, commits, and plan.')) return;
    resetSession();
  });

  // ---- streamed events ---------------------------------------------------
  T.on('log', (e) => appendLog(e.level, e.message));
  T.on('progress', onProgress);
  T.on('await', onAwait);
  T.on('summary', onSummary);
  T.on('done', () => {
    appendLog('info', '— session finished —');
    // Backstop: if the run ended WITHOUT a summary (e.g. aborted), restore the
    // Start/Reorder buttons so the user can retry. If a summary already locked
    // the order step, leave it locked.
    if (!$('step-order').classList.contains('done')) {
      const sb = $('startBtn');
      sb.disabled = false;
      if (startBtnLabel) sb.innerHTML = startBtnLabel;
      freezeSetup(false);
    }
    setRunStatus('hide');
  });
  T.on('error', (e) => { appendLog('error', e.message); alert('Error: ' + e.message); });

  function appendLog(level, message) {
    const v = $('logView');
    const span = document.createElement('span');
    span.className = 'l-' + (level || 'info');
    span.textContent = message + '\n';
    v.appendChild(span);
    v.scrollTop = v.scrollHeight;
  }

  // =========================================================================
  // Step 1 — Repository
  // =========================================================================
  $('browseBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Browse…', async () => {
    const dir = await T.pickFolder();
    if (dir) $('repoPath').value = dir;
  }));

  // Core repo preflight — callable directly (so stash/abort can refresh the
  // status without going through the now-disabled Check button).
  async function runRepoCheck() {
    const repoPath = $('repoPath').value.trim();
    if (!repoPath) return;
    state.repoPath = repoPath;
    const s = $('repoStatus');
    setStatus(s, line('info', 'Checking…'));
    try {
      const r = await T.request('preflight', { repoPath });
      let html = line('ok', '✓ Valid git repository.');
      const acts = $('repoActions');
      acts.classList.remove('hidden');
      const pendingAny = r.pending.cherryPick || r.pending.merge || r.pending.rebase;
      if (pendingAny) {
        const which = [r.pending.cherryPick && 'cherry-pick', r.pending.merge && 'merge', r.pending.rebase && 'rebase'].filter(Boolean).join(', ');
        html += line('warn', `⚠ Pending operation in progress: ${which}.`);
        $('abortPendingBtn').classList.remove('hidden');
      } else {
        $('abortPendingBtn').classList.add('hidden');
      }
      if (!r.worktree.clean) {
        html += line('warn', `⚠ Working tree dirty: ${r.worktree.total} file(s) (${r.worktree.modified} modified, ${r.worktree.untracked} untracked).`);
        $('stashBtn').classList.remove('hidden');
      } else {
        html += line('ok', '✓ Working tree clean.');
        $('stashBtn').classList.add('hidden');
      }
      setStatus(s, html);
      // Validated OK → lock the repo path + Browse + Check so it can't change.
      // (Abort/Stash remain available; they're the only remediation actions.)
      lockControls($('repoPath'), $('browseBtn'), $('checkRepoBtn'));
      unlock('step-branch');
      checkResume();
    } catch (err) {
      setStatus(s, line('err', '✗ ' + err.message));
      lock('step-branch');
    }
  }

  $('checkRepoBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Checking…', runRepoCheck));

  $('abortPendingBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Aborting…', async () => {
    await T.request('abortPending', { repoPath: state.repoPath });
    await runRepoCheck();
  }));

  $('stashBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Stashing…', async () => {
    try {
      const r = await T.request('stash', { repoPath: state.repoPath });
      state.didStash = true;
      state.stashRef = r.ref;
      appendLog('info', `Auto-stashed as ${r.ref}`);
      await runRepoCheck();
    } catch (err) {
      alert('Stash failed: ' + err.message);
    }
  }));

  async function checkResume() {
    try {
      const r = await T.request('findResume', { repoPath: state.repoPath, logBase: $('logBase').value.trim() });
      if (!r.found) return;
      modalResume(r.data, r.file);
    } catch (_) {}
  }

  // A previous session was found — force a Resume / Start-fresh choice with a
  // blocking modal so the user can't accidentally proceed past it.
  function modalResume(d, file) {
    const remaining = (d.remaining_commits || '').split(' ').filter(Boolean).length;
    showModal(`
      <h3>⚠ Previous session found</h3>
      <p>An unfinished cherry-pick run was detected for this repository.</p>
      <div class="mono small">branch=${esc(d.branch)}  done=${esc(d.last_completed_index)}  total=${esc(d.total_commits)}  remaining=${remaining}</div>
      <div class="opt-row" data-a="resume"><b>Resume</b> — load this session's branch &amp; remaining commits into the wizard.</div>
      <div class="opt-row" data-a="fresh"><b>Start fresh</b> — discard the saved progress file and begin a new run.</div>
    `);
    $('modal').querySelectorAll('.opt-row').forEach((row) =>
      row.addEventListener('click', async () => {
        const a = row.dataset.a;
        hideModal();
        if (a === 'resume') {
          // Pre-fill the wizard from the saved session, then let the user press Start.
          $('branchName').value = d.branch;
          $('commitInput').value = (d.remaining_commits || '').split(' ').filter(Boolean).join(', ');
          document.querySelector(`input[name=push][value="${d.push_mode}"]`)?.click();
          document.querySelector(`input[name=mode][value="${d.run_mode}"]`)?.click();
          appendLog('info', 'Loaded previous session — check out the branch, validate, then Start.');
          // Re-open any steps locked by a prior run so the resumed session is editable.
          reopenStep('step-branch');
          reopenStep('step-commits');
          unlock('step-branch');
        } else {
          try { if (file) await T.request('deleteProgress', { file }); } catch (_) {}
          appendLog('info', 'Discarded previous session — starting fresh.');
        }
      })
    );
  }

  // =========================================================================
  // Step 2 — Branch
  // =========================================================================
  $('checkBranchBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Fetching…', async () => {
    const branch = $('branchName').value.trim();
    if (!branch) return;
    const s = $('branchStatus');
    setStatus(s, line('info', 'Fetching & checking remote…'));
    try {
      const r = await T.request('checkBranch', { repoPath: state.repoPath, branch });
      if (!r.existsRemote) {
        setStatus(s, line('err', `✗ Branch '${esc(branch)}' does not exist on origin.`));
        $('branchConfirm').classList.add('hidden');
        return;
      }
      let html = line('ok', `✓ '${esc(branch)}' exists on origin.`);
      if (r.unpushed && r.unpushed.length) {
        html += line('warn', `⚠ Local branch has ${r.unpushed.length} unpushed commit(s) that a fresh checkout will DISCARD:`);
        html += `<div class="mono small warn">${r.unpushed.map(esc).join('<br>')}</div>`;
      }
      setStatus(s, html);
      state.branch = branch;
      // Validated OK → lock the branch name + Check; only "Check out fresh" left.
      lockControls($('branchName'), $('checkBranchBtn'));
      $('branchConfirm').classList.remove('hidden');
    } catch (err) {
      setStatus(s, line('err', '✗ ' + err.message));
    }
  }));

  $('checkoutBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Checking out…', async () => {
    const s = $('branchStatus');
    try {
      await T.request('checkoutBranch', { repoPath: state.repoPath, branch: state.branch });
      setStatus(s, line('ok', `✓ Checked out fresh '${esc(state.branch)}' from remote.`));
      $('branchConfirm').classList.add('hidden');
      unlock('step-commits');
      unlock('step-options');
      // Repo + branch are now committed to — lock them so they can't be edited.
      completeStep('step-repo');
      completeStep('step-branch');
    } catch (err) {
      setStatus(s, line('err', '✗ ' + err.message));
    }
  }));

  // =========================================================================
  // Step 3 — Commits
  // =========================================================================
  $('analyzeCommitsBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Validating…', async () => {
    const rawText = $('commitInput').value;
    const s = $('commitStatus');
    setStatus(s, line('info', 'Validating…'));
    try {
      const r = await T.request('analyzeCommits', { repoPath: state.repoPath, rawText });
      let html = '';
      if (r.duplicates.length) html += line('warn', `⚠ Removed duplicates: ${r.duplicates.map(esc).join(', ')}`);
      if (r.badFormat.length) html += line('err', `✗ Bad format (need 7–40 hex): ${r.badFormat.map(esc).join(', ')}`);
      if (r.notFound.length) html += line('err', `✗ Not found in repo: ${r.notFound.map(esc).join(', ')}`);
      if (!r.valid.length) {
        html += line('err', 'No valid commits.');
        setStatus(s, html);
        return;
      }
      html += line('ok', `✓ ${r.valid.length} valid commit(s).`);
      state.valid = r.valid;
      setStatus(s, html);
      unlock('step-order');
      completeStep('step-commits');
    } catch (err) {
      setStatus(s, line('err', '✗ ' + err.message));
    }
  }));

  // ---- scan-depth: reveal the depth field only when deep-scan is enabled ----
  $('scanDeepChk').addEventListener('change', (e) => {
    $('scanDepthWrap').classList.toggle('hidden', !e.target.checked);
  });

  // ---- run mode hint ----
  document.querySelectorAll('input[name=mode]').forEach((r) =>
    r.addEventListener('change', () => {
      const v = document.querySelector('input[name=mode]:checked').value;
      $('modeHint').textContent =
        v === 'dry-run' ? 'Simulate everything — no files, commits, or pushes change.'
        : v === 'review' ? 'Apply all commits without committing; review the combined diff, then commit or discard.'
        : 'Cherry-pick and commit each commit individually.';
    })
  );

  // =========================================================================
  // Step 5 — Analyze run, order, start
  // =========================================================================
  $('analyzeRunBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Analyzing…', async () => {
    if (!state.valid.length) { alert('Validate commits first.'); return; }
    const note = $('appliedNote');
    setStatus(note, line('info', 'Sorting by date & scanning target branch…'));
    try {
      const inputs = state.valid.map((c) => c.input);
      // Deep-scan off (default) → exact-hash match only (scanDepth 0, fastest).
      // On → patch-scan the given number of recent branch commits (default 200).
      const deep = $('scanDeepChk').checked;
      const scanDepth = deep ? (parseInt($('scanDepth').value, 10) || 200) : 0;
      const params = { repoPath: state.repoPath, branch: state.branch, inputs, scanDepth };
      const r = await T.request('analyzeRun', params);
      state.plan = r.ordered;
      state.applied = r.applied;
      state.preSkipped = r.applied.length;
      state.originalTotal = state.valid.length;
      let html = '';
      if (r.applied.length) {
        html += line('warn', `⚠ ${r.applied.length} commit(s) already on target — will be SKIPPED:`);
        html += `<div class="mono small warn">${r.applied.map((c) => esc(c.shortHash + '  ' + c.subject)).join('<br>')}</div>`;
      }
      html += line('info', `Scanned ${r.scannedDepth} branch commits for equivalents.`);
      if (!state.plan.length) {
        html += line('warn', 'All commits already applied — nothing to do.');
        setStatus(note, html);
        $('orderActions').classList.add('hidden');
        $('orderTableWrap').innerHTML = '';
        return;
      }
      if (state.plan.length >= 100) html += line('warn', `⚠ Large batch: ${state.plan.length} commits.`);
      setStatus(note, html);
      renderPlan();
      $('orderActions').classList.remove('hidden');
      // Plan built → lock the Analyze button + the whole Options step, since
      // scan depth (and the rest of Step 4) fed into this plan. To change them,
      // use "Edit commits" (reopens steps 3–4) or "New session".
      lockControls($('analyzeRunBtn'));
      completeStep('step-options');
    } catch (err) {
      setStatus(note, line('err', '✗ ' + err.message));
    }
  }));

  function renderPlan() {
    const rows = state.plan.map((c, i) => {
      // Where did the user originally paste this commit? (order they entered)
      const pasted = state.valid.findIndex((v) => v.input === c.input) + 1;
      const moved = pasted && pasted !== i + 1;   // run order differs from paste order
      return `<tr class="${c.isMerge ? 'merge' : ''}" draggable="true" data-idx="${i}">
        <td class="drag" title="Drag to reorder">⠿</td>
        <td>${i + 1}</td>
        <td class="paste ${moved ? 'reordered' : 'muted'}">${pasted || '—'}</td>
        <td class="mono">${esc(c.shortHash)}</td>
        <td>${esc(c.author)}</td>
        <td class="mono">${esc(c.dateStr)}</td>
        <td>${esc(c.subject)}${c.isMerge ? ' <em>(merge)</em>' : ''}</td>
      </tr>`;
    }).join('');
    $('orderTableWrap').innerHTML =
      `<p class="hint">Commits run <b>top → bottom</b> (auto-sorted oldest → newest by date). <b>Drag a row</b> to reorder. <b>You pasted #</b> is the order you entered them — highlighted where the tool changed it.</p>
       <table class="ctable"><thead><tr><th></th><th>Run #</th><th>You pasted #</th><th>Hash</th><th>Author</th><th>Date &amp; time</th><th>Message</th></tr></thead><tbody id="planBody">${rows}</tbody></table>`;
    wirePlanDrag();
  }

  // Drag-and-drop reordering of plan rows (replaces the old prompt(), which
  // Electron's renderer does not implement). Dropping a row inserts it BEFORE
  // the row it's dropped on.
  let dragFrom = null;
  function wirePlanDrag() {
    const body = $('planBody');
    if (!body) return;
    body.querySelectorAll('tr').forEach((tr) => {
      tr.addEventListener('dragstart', (e) => {
        dragFrom = Number(tr.dataset.idx);
        e.dataTransfer.effectAllowed = 'move';
        tr.classList.add('dragging');
      });
      tr.addEventListener('dragend', () => {
        dragFrom = null;
        body.querySelectorAll('tr').forEach((r) => r.classList.remove('dragging', 'dragover'));
      });
      tr.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tr.classList.add('dragover');
      });
      tr.addEventListener('dragleave', () => tr.classList.remove('dragover'));
      tr.addEventListener('drop', (e) => {
        e.preventDefault();
        const to = Number(tr.dataset.idx);
        if (dragFrom === null || dragFrom === to) return;
        const [moved] = state.plan.splice(dragFrom, 1);
        const insertAt = dragFrom < to ? to - 1 : to;   // account for the removal shift
        state.plan.splice(insertAt, 0, moved);
        renderPlan();
      });
    });
  }

  // "Edit commits" — go back and add/remove/change the commit list after a plan
  // was built. Reopens Steps 3 (Commits) & 4 (Options), drops the built plan,
  // and returns the user to re-validate → re-analyze.
  $('editCommitsBtn').addEventListener('click', () => {
    reopenStep('step-commits');
    reopenStep('step-options');
    unlockControls($('analyzeRunBtn'));
    lock('step-order');
    state.plan = [];
    state.applied = [];
    state.preSkipped = 0;
    $('orderTableWrap').innerHTML = '';
    setStatus($('appliedNote'), '');
    setStatus($('commitStatus'), line('info', 'Edit the commit list below, then re-validate.'));
    $('orderActions').classList.add('hidden');
    $('commitInput').focus();
  });

  let startBtnLabel = '';
  $('startBtn').addEventListener('click', () => {
    if (!state.plan.length) return;
    const btn = $('startBtn');
    if (btn.disabled) return;                 // already running
    startBtnLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Running…';
    freezeSetup(true);                        // no editing any step while running
    $('progressList').innerHTML = '';
    $('summary').classList.add('hidden');
    $('progressBarWrap').classList.remove('hidden');
    setRunStatus('running', 'Starting cherry-pick…');
    const config = {
      repoPath: state.repoPath,
      branch: state.branch,
      pushMode: document.querySelector('input[name=push]:checked').value,
      runMode: document.querySelector('input[name=mode]:checked').value,
      logBase: $('logBase').value.trim(),
      inputs: state.plan.map((c) => c.input),
      originalTotal: state.originalTotal,
      preSkipped: state.preSkipped,
      didStash: state.didStash,
      stashRef: state.stashRef,
    };
    T.request('start', { config }).catch((e) => {
      alert(e.message);
      btn.disabled = false;
      if (startBtnLabel) btn.innerHTML = startBtnLabel;
      freezeSetup(false);
      setRunStatus('hide');
    });
  });

  // =========================================================================
  // Progress + awaits
  // =========================================================================
  const liRefs = {};
  function onProgress(e) {
    const key = e.commit.input;
    let li = liRefs[key];
    if (!li) {
      li = document.createElement('li');
      liRefs[key] = li;
      $('progressList').appendChild(li);
    }
    const icons = { picking: '⟳', ok: '✓', 'dry-ok': '✓', skipped: '⊘', aborted: '✗', failed: '✗' };
    li.className = e.status;
    li.innerHTML = `<span class="ic">${icons[e.status] || '•'}</span><span class="h">[${e.current}/${e.total}] ${esc(e.commit.shortHash)}</span><span>${esc(e.commit.subject)}</span>`;
    $('progressMeta').textContent = `${e.current} / ${e.total}`;
    const pct = Math.round(((e.status === 'picking' ? e.current - 1 : e.current) / e.total) * 100);
    $('progressBar').style.width = pct + '%';
    // Keep the live banner in sync with what's happening right now.
    if (e.status === 'picking') {
      setRunStatus('running', `Cherry-picking ${e.current}/${e.total}: ${e.commit.shortHash} — ${e.commit.subject}`);
    } else {
      setRunStatus('running', `Processed ${e.current}/${e.total} — continuing`);
    }
  }

  function onAwait(e) {
    // The engine has paused for a human decision — make that obvious.
    const waitText = {
      merge: 'Paused — choose how to handle the merge commit',
      conflict: 'Paused — resolve the conflict, then continue',
      push: 'Paused — push failed, choose what to do',
      review: 'Paused — review the combined diff',
    };
    setRunStatus('waiting', waitText[e.kind]);
    if (e.kind === 'merge') return modalMerge(e);
    if (e.kind === 'conflict') return modalConflict(e);
    if (e.kind === 'push') return modalPush(e);
    if (e.kind === 'review') return modalReview(e);
  }

  function showModal(html) {
    $('modal').innerHTML = html;
    $('modalOverlay').classList.remove('hidden');
  }
  function hideModal() { $('modalOverlay').classList.add('hidden'); }
  function answer(token, payload) {
    // Guard against a double-click sending two responses for one prompt.
    if ($('modalOverlay').classList.contains('hidden')) return;
    hideModal();
    setRunStatus('running', 'Resuming…');     // engine picks back up after the response
    T.fire('respond', { token, payload });
  }

  function modalMerge(e) {
    const c = e.commit;
    const parents = c.parents.map((p, i) => `<div class="mono small">Parent ${i + 1}: ${esc(p.label)}</div>`).join('');
    showModal(`
      <h3>⚠ Merge commit: ${esc(c.shortHash)}</h3>
      <p>${esc(c.subject)}</p>${parents}
      <div class="opt-row" data-c="1"><b>Use -m 1</b> — keep Parent 1 as mainline (usual for main/master); apply the feature changes.</div>
      <div class="opt-row" data-c="2"><b>Use -m 2</b> — keep Parent 2 as mainline.</div>
      <div class="opt-row" data-c="skip"><b>Skip</b> — do not cherry-pick this merge commit.</div>
    `);
    $('modal').querySelectorAll('.opt-row').forEach((row) =>
      row.addEventListener('click', () => answer(e.token, { choice: row.dataset.c }))
    );
  }

  function modalConflict(e) {
    const files = e.files.map(esc).join('<br>');
    showModal(`
      <h3>✗ Conflict — ${esc(e.commit.shortHash)}</h3>
      <p>Resolve the conflicts in these files using your editor / git tool, then click <b>I've resolved</b>:</p>
      <div class="files">${files}</div>
      ${e.runMode === 'review' ? '<p class="hint">Review mode: resolved changes stay staged (no commit is created).</p>' : ''}
      <div class="opt-row" data-a="resolve"><b>I've resolved</b> — re-check files & continue.</div>
      <div class="opt-row" data-a="skip"><b>Skip</b> — abort this commit, move to next.</div>
      <div class="opt-row" data-a="abort"><b>Abort</b> — stop the whole process.</div>
    `);
    $('modal').querySelectorAll('.opt-row').forEach((row) =>
      row.addEventListener('click', () => answer(e.token, { action: row.dataset.a }))
    );
  }

  function modalPush(e) {
    showModal(`
      <h3>✗ Push failed</h3>
      <div class="diff">${esc(e.output)}</div>
      <div class="opt-row" data-a="force"><b>Force-with-lease</b> — safer force push (respects others' pushes).</div>
      <div class="opt-row" data-a="retry"><b>Retry</b> — try a normal push again.</div>
      <div class="opt-row" data-a="skip"><b>Skip push</b> — continue; push manually later.</div>
      <div class="opt-row" data-a="abort"><b>Abort</b> — stop the whole process.</div>
    `);
    $('modal').querySelectorAll('.opt-row').forEach((row) =>
      row.addEventListener('click', () => answer(e.token, { action: row.dataset.a }))
    );
  }

  function modalReview(e) {
    const colored = esc(e.diff).split('\n').map((l) => {
      if (l.startsWith('+')) return `<span class="add">${l}</span>`;
      if (l.startsWith('-')) return `<span class="del">${l}</span>`;
      if (l.startsWith('@@') || l.startsWith('diff ')) return `<span class="hdr">${l}</span>`;
      return l;
    }).join('\n');
    showModal(`
      <h3>Review combined diff</h3>
      <div class="diff">${colored || '(no staged changes)'}</div>
      <div class="opt"><label class="opt-label">Commit message</label>
        <input id="reviewMsg" type="text" value="Cherry-pick batch" /></div>
      <div class="row">
        <button class="btn go" id="reviewCommit">Commit all as one</button>
        <button class="btn warn" id="reviewDiscard">Discard everything</button>
      </div>
    `);
    $('reviewCommit').addEventListener('click', () => answer(e.token, { action: 'commit', message: $('reviewMsg').value || 'Cherry-pick batch' }));
    $('reviewDiscard').addEventListener('click', () => answer(e.token, { action: 'discard' }));
  }

  // =========================================================================
  // Summary
  // =========================================================================
  function onSummary(e) {
    const c = e.counters;
    if (startBtnLabel) $('startBtn').innerHTML = startBtnLabel;
    freezeSetup(false);                       // run finished — unfreeze the column
    setRunStatus('hide');                     // stop the "in progress" banner
    // Run is done: lock the whole order/start step (Analyze, Reorder, Start).
    // To run another batch the user clicks "Start new session".
    completeStep('step-order');
    $('progressBar').style.width = '100%';
    const stashBtn = e.didStash
      ? `<button id="popStashBtn" class="btn small">Pop stash (${esc(e.stashRef)})</button>` : '';
    $('summary').innerHTML = `
      <h3>Cherry-pick summary</h3>
      <div class="grid">
        <div>Total</div><div class="num">${c.total}</div>
        <div>Succeeded</div><div class="num green">${c.succeeded}</div>
        <div>Skipped</div><div class="num yellow">${c.skipped}</div>
        <div>Conflicts resolved</div><div class="num cyan">${c.conflictsResolved}</div>
        <div>Failed</div><div class="num ${c.failed ? 'red' : 'green'}">${c.failed}</div>
        <div>Mode</div><div>${esc(e.mode)}</div>
        <div>Push</div><div>${esc(e.pushMode)}</div>
      </div>
      <div class="paths">Log: ${esc(e.logFile)}</div>
      <div class="row">
        <button id="newSessionBtn" class="btn small go">🔄 Start new session</button>
        ${stashBtn}
        <button id="delProgressBtn" class="btn small ghost">Delete progress file</button>
      </div>`;
    $('summary').classList.remove('hidden');
    const pop = $('popStashBtn');
    if (pop) pop.addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Popping…', async () => {
      try {
        await T.request('popStash', { repoPath: state.repoPath });
        appendLog('info', 'Stash popped.');
        lockControls(pop);                    // one-shot — stays disabled after success
      } catch (err) { alert('Pop failed: ' + err.message); }
    }));
    $('delProgressBtn').addEventListener('click', (ev) => withBusy(ev.currentTarget, 'Deleting…', async () => {
      try {
        await T.request('deleteProgress', { file: e.progressFile });
        appendLog('info', 'Progress file deleted.');
        lockControls(ev.currentTarget);       // one-shot — stays disabled after success
      } catch (err) { alert('Delete failed: ' + err.message); }
    }));
    $('newSessionBtn').addEventListener('click', resetSession);
  }
})();
