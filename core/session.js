// =============================================================================
// core/session.js
// The cherry-pick run engine, modelled as a pausable state machine.
//
// It emits events ('log', 'progress', 'await', 'summary', 'done', 'error') and,
// whenever it needs a human decision (merge -m choice, conflict resolution,
// push retry, review commit), it PAUSES by awaiting a promise that the caller
// resolves via session.respond(token, payload).
//
// This replaces the CLI's fragile stty / command-substitution prompting and so
// fixes the broken merge-commit menu and the review-mode-conflict commit bug.
// =============================================================================
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const g = require('./git');

const PROGRESS_FILE = '.cherry-pick-progress';

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(h)}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())} ${ampm}`;
}

class Session extends EventEmitter {
  /**
   * @param {object} cfg
   *   repoPath, branch, pushMode('each'|'batch'), runMode('normal'|'dry-run'|'review'),
   *   commits: ordered array of commitInfo to process,
   *   logDir, originalTotal, preSkipped, didStash, stashRef
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.repoPath = cfg.repoPath;
    this.branch = cfg.branch;
    this.pushMode = cfg.pushMode;
    this.runMode = cfg.runMode;
    this.commits = cfg.commits;
    this.logDir = cfg.logDir;

    this.counters = {
      total: cfg.originalTotal != null ? cfg.originalTotal : cfg.commits.length,
      succeeded: 0,
      skipped: cfg.preSkipped || 0,
      conflictsResolved: 0,
      failed: 0,
    };

    this.logFile =
      this.runMode === 'dry-run'
        ? path.join(this.logDir, 'dry-run-log.txt')
        : path.join(this.logDir, 'cherry-pick-log.txt');
    this.progressFile = path.join(this.logDir, PROGRESS_FILE);

    this._pending = null; // { token, resolve }
    this._tokenSeq = 0;
    this.aborted = false;
  }

  // ---- event helpers ------------------------------------------------------

  log(message, level = 'info') {
    const line = `${stamp()} | ${message}`;
    try {
      fs.appendFileSync(this.logFile, line + '\n');
    } catch (_) {}
    this.emit('log', { level, message });
  }

  // Pause and wait for a UI decision. Emits an 'await' event carrying a token;
  // resolves when respond(token, payload) is called.
  _waitFor(kind, payload) {
    const token = `t${++this._tokenSeq}`;
    this.emit('await', { token, kind, ...payload });
    return new Promise((resolve) => {
      this._pending = { token, resolve };
    });
  }

  respond(token, payload) {
    if (this._pending && this._pending.token === token) {
      const resolve = this._pending.resolve;
      this._pending = null;
      resolve(payload || {});
      return true;
    }
    return false;
  }

  // ---- progress file (resume) --------------------------------------------

  _saveProgress(index) {
    const remaining = this.commits
      .slice(index + 1)
      .map((c) => c.input)
      .join(' ');
    const body = [
      `repo_path=${this.repoPath}`,
      `branch=${this.branch}`,
      `push_mode=${this.pushMode}`,
      `run_mode=${this.runMode}`,
      `last_completed_index=${index}`,
      `total_commits=${this.counters.total}`,
      `succeeded=${this.counters.succeeded}`,
      `skipped=${this.counters.skipped}`,
      `conflicts_resolved=${this.counters.conflictsResolved}`,
      `failed=${this.counters.failed}`,
      `remaining_commits=${remaining}`,
    ].join('\n');
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.writeFileSync(this.progressFile, body + '\n');
    } catch (_) {}
  }

  // A finished run has nothing left to resume, so its progress file must go.
  // Leaving it behind is what made the wizard offer to "continue" sessions that
  // had already completed. Called from run() rather than _finish(), because
  // _finish() is skipped on an abort and so cannot tell the two outcomes apart.
  _clearProgress() {
    try {
      fs.unlinkSync(this.progressFile);
    } catch (_) {} // never fail a successful run over cleanup
  }

  // ---- main run -----------------------------------------------------------

  async run() {
    try {
      this.log('=== Cherry-Pick Studio Session ===');
      this.log(`Repository: ${this.repoPath}`);
      this.log(`Branch: ${this.branch}`);
      this.log(`Mode: ${this.runMode}`);
      this.log(`Push strategy: ${this.pushMode}`);
      this.log(`Total to process: ${this.commits.length}`);

      const total = this.commits.length;
      for (let i = 0; i < total; i++) {
        if (this.aborted) break;
        const c = this.commits[i];
        const cur = i + 1;

        this.emit('progress', {
          index: i,
          current: cur,
          total,
          commit: c,
          status: 'picking',
        });
        this.log(`[${cur}/${total}] Cherry-picking ${c.shortHash} — ${c.subject}`);

        // DRY RUN [Feature 8]
        if (this.runMode === 'dry-run') {
          this.counters.succeeded++;
          this.log(
            `DRY RUN: would cherry-pick ${c.shortHash}` +
              (c.isMerge ? ' (MERGE COMMIT — would ask -m option)' : '')
          );
          this.emit('progress', { index: i, current: cur, total, commit: c, status: 'dry-ok' });
          continue;
        }

        // Keep in sync with remote between per-commit pushes [Feature 18 — non-blocking]
        if (this.pushMode === 'each' && this.runMode === 'normal') {
          const pr = await g.pull(this.repoPath, this.branch);
          if (!pr.ok) this.log(`Pull warning (continuing): ${pr.output.trim()}`, 'warn');
        }

        // Merge commit handling [Feature 4]
        let mainline = null;
        if (c.isMerge) {
          const ans = await this._waitFor('merge', { commit: c });
          if (ans.choice === 'skip') {
            this.counters.skipped++;
            this.log(`SKIPPED (merge): ${c.shortHash}`, 'warn');
            this.emit('progress', { index: i, current: cur, total, commit: c, status: 'skipped' });
            this._saveProgress(i);
            continue;
          }
          mainline = ans.choice; // '1' or '2'
        }

        const noCommit = this.runMode === 'review';
        const res = await g.cherryPick(this.repoPath, c.input, { mainline, noCommit });

        if (res.status === 'ok') {
          this.counters.succeeded++;
          this.log(`SUCCESS: ${c.shortHash} — ${c.subject}`);
          this.emit('progress', { index: i, current: cur, total, commit: c, status: 'ok' });
          if (this.pushMode === 'each' && this.runMode === 'normal') await this._doPush();
        } else if (res.status === 'empty') {
          await g.skipCherryPick(this.repoPath);
          this.counters.skipped++;
          this.log(`SKIPPED (empty/already applied): ${c.shortHash}`, 'warn');
          this.emit('progress', { index: i, current: cur, total, commit: c, status: 'skipped' });
        } else if (res.status === 'conflict') {
          const outcome = await this._handleConflict(c, res.conflictedFiles);
          this.emit('progress', { index: i, current: cur, total, commit: c, status: outcome });
          if (outcome === 'aborted') {
            this.aborted = true;
            break;
          }
          if (outcome === 'ok' && this.pushMode === 'each' && this.runMode === 'normal') {
            await this._doPush();
          }
        }

        this._saveProgress(i);
      }

      if (!this.aborted) {
        await this._finish();
        this._clearProgress();
      }
      this._emitSummary();
      this.emit('done', { aborted: this.aborted, counters: this.counters });
    } catch (err) {
      this.log(`FATAL: ${err.message}`, 'error');
      this.emit('error', { message: err.message });
    }
  }

  // ---- conflict handling [Features 3, 16, 23] ----------------------------

  async _handleConflict(c, files) {
    this.log(`CONFLICT: ${c.shortHash} — ${files.join(', ')}`, 'warn');
    let current = files;
    while (true) {
      const ans = await this._waitFor('conflict', {
        commit: c,
        files: current,
        runMode: this.runMode,
      });

      if (ans.action === 'resolve') {
        const check = await g.conflictsResolved(this.repoPath);
        if (!check.resolved) {
          current = check.files;
          this.log(
            `Still unresolved (${check.reason}): ${check.files.join(', ')}`,
            'warn'
          );
          continue; // re-prompt with updated file list
        }
        await g.addAll(this.repoPath);
        if (this.runMode === 'review') {
          // Review mode must NOT create a commit — keep changes staged,
          // just clear the sequencer state. [fixes CLI review+conflict bug]
          await g.quitSequencer(this.repoPath);
          this.counters.conflictsResolved++;
          this.counters.succeeded++;
          this.log(`CONFLICT RESOLVED (staged, review mode): ${c.shortHash}`);
          return 'ok';
        }
        const cont = await g.continueCherryPick(this.repoPath);
        if (cont.ok) {
          this.counters.conflictsResolved++;
          this.counters.succeeded++;
          this.log(`CONFLICT RESOLVED: ${c.shortHash}`);
          return 'ok';
        }
        this.log(`cherry-pick --continue failed: ${cont.output.trim()}`, 'error');
        current = await g.conflictedFiles(this.repoPath);
        // loop again
      } else if (ans.action === 'skip') {
        await g.abortCherryPick(this.repoPath);
        this.counters.skipped++;
        this.log(`SKIPPED (conflict): ${c.shortHash}`, 'warn');
        return 'skipped';
      } else if (ans.action === 'abort') {
        await g.abortCherryPick(this.repoPath);
        this.log(`ABORTED by user at ${c.shortHash}`, 'error');
        return 'aborted';
      }
    }
  }

  // ---- push [Features 15, 17] --------------------------------------------

  async _doPush() {
    this.log(`Pushing to origin/${this.branch}...`);
    let res = await g.push(this.repoPath, this.branch, { force: false });
    if (res.ok) {
      this.log('PUSH: success');
      return true;
    }
    while (true) {
      const ans = await this._waitFor('push', { output: res.output });
      if (ans.action === 'force') {
        res = await g.push(this.repoPath, this.branch, { force: true });
        if (res.ok) {
          this.log('PUSH: success (force-with-lease)');
          return true;
        }
      } else if (ans.action === 'retry') {
        res = await g.push(this.repoPath, this.branch, { force: false });
        if (res.ok) {
          this.log('PUSH: success (retry)');
          return true;
        }
      } else if (ans.action === 'skip') {
        this.log('PUSH: skipped by user', 'warn');
        return false;
      } else if (ans.action === 'abort') {
        this.log('ABORTED by user during push', 'error');
        this.aborted = true;
        return false;
      }
    }
  }

  // ---- finish [Features 15, 23, 10] --------------------------------------

  async _finish() {
    if (this.pushMode === 'batch' && this.runMode === 'normal') {
      await this._doPush();
    }

    if (this.runMode === 'review') {
      const diff = await g.stagedDiff(this.repoPath);
      const ans = await this._waitFor('review', { diff });
      if (ans.action === 'commit') {
        const cm = await g.commit(this.repoPath, ans.message || 'Cherry-pick batch');
        if (cm.ok) {
          this.log('Review: all changes committed as one commit.');
          if (this.pushMode === 'each' || this.pushMode === 'batch') await this._doPush();
        } else {
          this.log(`Review commit failed: ${cm.output.trim()}`, 'error');
        }
      } else {
        await g.quitSequencer(this.repoPath);
        await g.resetHard(this.repoPath);
        this.log('Review: all changes discarded.', 'warn');
      }
    }
  }

  _emitSummary() {
    const abs = this.logDir;
    this.log(
      `SUMMARY: Total=${this.counters.total} Succeeded=${this.counters.succeeded} ` +
        `Skipped=${this.counters.skipped} Conflicts=${this.counters.conflictsResolved} ` +
        `Failed=${this.counters.failed}`
    );
    this.emit('summary', {
      counters: this.counters,
      mode: this.runMode,
      pushMode: this.pushMode,
      logDir: abs,
      logFile: this.logFile,
      progressFile: this.progressFile,
      // Only an interrupted run leaves one behind; the UI hides its "delete
      // progress file" button when there is nothing to delete.
      progressLeft: fs.existsSync(this.progressFile),
      didStash: this.cfg.didStash,
      stashRef: this.cfg.stashRef,
    });
  }
}

// Parse a .cherry-pick-progress file into an object. [Feature 22]
function parseProgressFile(file) {
  const out = {};
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

// Compare repo paths the way the filesystem does: resolved, trailing separator
// stripped, and case-insensitively on Windows.
function repoKey(p) {
  const resolved = path.resolve(String(p || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Find the one saved session worth resuming for `repoPath`, or null.
 *
 * A progress file only qualifies when it belongs to THIS repository and still
 * has commits left. Without both checks the wizard offers to "resume" runs that
 * already finished, or that belong to a completely different repo — every run
 * writes into the same shared logs/ tree.
 *
 * Of the qualifying files the most recently written wins.
 */
function findLatestResume(logBase, repoPath) {
  const want = repoKey(repoPath);
  const candidates = [];
  const stack = [logBase];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue; // unreadable or missing directory — nothing to resume from here
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name === PROGRESS_FILE) candidates.push(full);
    }
  }

  let best = null;
  for (const file of candidates) {
    let data;
    try {
      data = parseProgressFile(file);
    } catch (_) {
      continue;
    }
    if (!data || !data.repo_path) continue;
    if (repoKey(data.repo_path) !== want) continue;
    const remaining = String(data.remaining_commits || '').split(/\s+/).filter(Boolean);
    if (!remaining.length) continue; // the run finished — nothing to resume
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (_) {}
    if (!best || mtimeMs > best.mtimeMs) best = { file, data, mtimeMs };
  }
  return best ? { file: best.file, data: best.data, mtimeMs: best.mtimeMs } : null;
}

module.exports = { Session, parseProgressFile, findLatestResume, stamp, PROGRESS_FILE };
