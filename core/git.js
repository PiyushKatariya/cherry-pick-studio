// =============================================================================
// core/git.js
// Pure git operations. No UI, no prompting. Every function returns structured
// data or throws. Shared by the Express web server and the Electron app.
// =============================================================================
'use strict';

const { execFile, spawn } = require('child_process');

// Run an async fn over items with bounded concurrency, preserving input order.
// Keeps us from spawning hundreds of git processes at once on Windows.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Run a git command in repoPath. Never throws on a non-zero exit; instead
 * returns { code, stdout, stderr }. Callers decide what a failure means.
 */
function git(repoPath, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: repoPath,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        ...opts,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

async function isGitRepo(repoPath) {
  const r = await git(repoPath, ['rev-parse', '--git-dir']);
  return r.code === 0;
}

// Detect pending merge/rebase/cherry-pick from `git status` text (avoids
// false positives from stale .git artifacts). [CLI Feature 2]
async function pendingOps(repoPath) {
  const r = await git(repoPath, ['status']);
  const s = r.stdout.toLowerCase();
  return {
    cherryPick: s.includes('you are currently cherry-picking'),
    merge:
      s.includes('you have unmerged paths') ||
      s.includes('all conflicts fixed but you are still merging'),
    rebase: s.includes('you are currently rebasing') || s.includes('rebase in progress'),
  };
}

async function abortPending(repoPath) {
  await git(repoPath, ['cherry-pick', '--abort']);
  await git(repoPath, ['merge', '--abort']);
  await git(repoPath, ['rebase', '--abort']);
}

// Working-tree status broken into counts. [CLI Feature 10]
async function worktreeStatus(repoPath) {
  const r = await git(repoPath, ['status', '--porcelain']);
  const lines = r.stdout.split('\n').filter((l) => l.length > 0);
  let modified = 0;
  let untracked = 0;
  for (const l of lines) {
    if (l.startsWith('??')) untracked++;
    else modified++;
  }
  return { clean: lines.length === 0, total: lines.length, modified, untracked, lines };
}

async function stashPush(repoPath, message) {
  const r = await git(repoPath, ['stash', 'push', '-u', '-m', message]);
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  const list = await git(repoPath, ['stash', 'list']);
  const ref = (list.stdout.split('\n')[0] || '').split(':')[0] || 'stash@{0}';
  return { ok: true, ref };
}

async function stashList(repoPath) {
  const r = await git(repoPath, ['stash', 'list']);
  return r.stdout.split('\n').filter(Boolean);
}

async function stashPop(repoPath) {
  const r = await git(repoPath, ['stash', 'pop']);
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------

async function fetch(repoPath) {
  return git(repoPath, ['fetch', 'origin']);
}

async function branchExistsOnRemote(repoPath, branch) {
  const r = await git(repoPath, ['ls-remote', '--heads', 'origin', branch]);
  return r.code === 0 && r.stdout.trim().length > 0;
}

async function localBranchExists(repoPath, branch) {
  const r = await git(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.code === 0;
}

async function currentBranch(repoPath) {
  const r = await git(repoPath, ['symbolic-ref', '--short', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : '';
}

// Local commits on `branch` that are NOT on origin/branch — these would be
// LOST by a fresh re-checkout. Surfaced so the UI can warn. [fixes CLI bug]
async function unpushedCommits(repoPath, branch) {
  if (!(await localBranchExists(repoPath, branch))) return [];
  const r = await git(repoPath, [
    'log',
    '--format=%h %s',
    `origin/${branch}..${branch}`,
  ]);
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean);
}

// Delete any stale local branch and check out a fresh copy from remote.
// [CLI gather_branch]
async function checkoutFreshFromRemote(repoPath, branch) {
  if (await localBranchExists(repoPath, branch)) {
    if ((await currentBranch(repoPath)) === branch) {
      await git(repoPath, ['checkout', '--detach']);
    }
    await git(repoPath, ['branch', '-D', branch]);
  }
  const r = await git(repoPath, ['checkout', '-b', branch, `origin/${branch}`]);
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  return { ok: true };
}

async function checkout(repoPath, branch) {
  return git(repoPath, ['checkout', branch]);
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

function isValidCommitFormat(id) {
  return /^[0-9a-fA-F]{7,40}$/.test(id);
}

async function commitExists(repoPath, id) {
  const r = await git(repoPath, ['cat-file', '-t', id]);
  return r.code === 0 && r.stdout.trim() === 'commit';
}

// Full info for one commit, including merge-commit parent details. [Features 4, 12, 13]
// One `git log` call gives metadata AND parent hashes (%P) — no extra cat-file.
// Parent labels are only fetched for actual merge commits (where the UI needs them).
async function commitInfo(repoPath, id) {
  const fmt = '%H%x1f%h%x1f%an%x1f%at%x1f%ad%x1f%P%x1f%s';
  const r = await git(repoPath, [
    'log',
    '-1',
    `--date=format:%Y-%m-%d %I:%M:%S %p`,
    `--format=${fmt}`,
    id,
  ]);
  if (r.code !== 0) return null;
  const [hash, shortHash, author, epoch, dateStr, parentStr, subject] = r.stdout
    .trim()
    .split('\x1f');

  const parentHashes = (parentStr || '').trim().split(/\s+/).filter(Boolean);
  const isMerge = parentHashes.length > 1;

  // Only merges need parent labels (the mainline picker); skip the lookups otherwise.
  let parents = [];
  if (isMerge) {
    parents = await Promise.all(
      parentHashes.map(async (phash) => {
        const pr = await git(repoPath, ['log', '-1', '--format=%h %s', phash]);
        return { hash: phash, label: pr.stdout.trim() };
      })
    );
  }

  return {
    input: id,
    hash,
    shortHash,
    author,
    epoch: parseInt(epoch, 10) || 0,
    dateStr,
    subject,
    isMerge,
    parents,
  };
}

// Validate, dedup, and resolve a list of raw commit IDs.
// Returns { valid:[info...], duplicates:[], badFormat:[], notFound:[] }. [Features 5, 6, 21]
async function analyzeCommitList(repoPath, rawIds) {
  const seen = new Set();
  const duplicates = [];
  const unique = [];
  for (const raw of rawIds) {
    const id = raw.trim();
    if (!id) continue;
    if (seen.has(id)) {
      duplicates.push(id);
    } else {
      seen.add(id);
      unique.push(id);
    }
  }

  const badFormat = [];
  const formatOk = [];
  for (const id of unique) {
    if (isValidCommitFormat(id)) formatOk.push(id);
    else badFormat.push(id);
  }

  // Resolve existence + info in parallel (bounded), preserving order.
  const resolved = await mapLimit(formatOk, 8, async (id) => {
    if (await commitExists(repoPath, id)) return { id, info: await commitInfo(repoPath, id) };
    return { id, info: null };
  });
  const notFound = [];
  const valid = [];
  for (const r of resolved) {
    if (r.info) valid.push(r.info);
    else notFound.push(r.id);
  }

  return { valid, duplicates, badFormat, notFound };
}

// Compute patch-ids for many commits in ONE streamed pipeline:
//   git log -p <logArgs> | git patch-id --stable
// patch-id prints "<patchId> <commitId>" per patch. We only buffer that small
// output in Node — never the (potentially huge) diff itself.
// Returns { set:Set<patchId>, byCommit:Map<commitHash, patchId> }.
function patchIdsPiped(repoPath, logArgs) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const set = new Set();
      const byCommit = new Map();
      for (const line of out.split('\n')) {
        const sp = line.indexOf(' ');
        if (sp === -1) continue;
        const pid = line.slice(0, sp).trim();
        const commit = line.slice(sp + 1).trim();
        if (!pid) continue;
        set.add(pid);
        if (commit) byCommit.set(commit, pid);
      }
      resolve({ set, byCommit });
    };
    try {
      const log = spawn('git', ['log', '-p', ...logArgs], { cwd: repoPath, windowsHide: true });
      const pid = spawn('git', ['patch-id', '--stable'], { cwd: repoPath, windowsHide: true });
      log.stdout.pipe(pid.stdin);
      pid.stdout.on('data', (d) => (out += d.toString()));
      pid.on('close', finish);
      pid.on('error', finish);
      log.on('error', finish);
      // Avoid unhandled EPIPE if one side closes early.
      log.stdout.on('error', () => {});
      pid.stdin.on('error', () => {});
    } catch (_) {
      finish();
    }
  });
}

// Which of `ids` are already on origin/branch (exact hash or patch-id match).
// [Feature 1] Bounded patch-id scan; reports the cap it used.
// Fast path: two `git log -p | git patch-id` pipelines instead of ~2*N spawns.
async function alreadyApplied(repoPath, branch, ids, scanDepth = 200) {
  // Sanitize: blank/invalid -> 200; 0 -> exact-hash match only (fastest).
  const depth = Number.isFinite(scanDepth) ? Math.max(0, Math.floor(scanDepth)) : 200;

  const exact = await git(repoPath, ['log', '--format=%H', `origin/${branch}`]);
  const branchHashes = new Set(exact.stdout.split('\n').filter(Boolean));

  // Patch-ids for the last `depth` branch commits — ONE pipeline. Skipped when depth=0.
  const branchPids =
    depth > 0
      ? await patchIdsPiped(repoPath, [`-${depth}`, `origin/${branch}`])
      : { set: new Set(), byCommit: new Map() };

  // Patch-ids for the input commits — ONE pipeline, keyed by full commit hash.
  const inputHashes = depth > 0 ? ids.map((i) => i.hash).filter(Boolean) : [];
  const inputPids =
    inputHashes.length > 0
      ? await patchIdsPiped(repoPath, ['--no-walk', ...inputHashes])
      : { set: new Set(), byCommit: new Map() };

  const applied = [];
  const remaining = [];
  for (const info of ids) {
    if (branchHashes.has(info.hash)) {
      applied.push(info);
      continue;
    }
    const pid = inputPids.byCommit.get(info.hash);
    if (pid && branchPids.set.has(pid)) applied.push(info);
    else remaining.push(info);
  }
  return { applied, remaining, scannedDepth: Math.min(depth, branchHashes.size) };
}

async function patchId(repoPath, ref) {
  return new Promise((resolve) => {
    const show = execFile(
      'git',
      ['show', ref],
      { cwd: repoPath, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return resolve('');
        execFile(
          'git',
          ['patch-id', '--stable'],
          { cwd: repoPath, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
          (e2, out2) => {
            if (e2) return resolve('');
            resolve((out2 || '').toString().trim().split(' ')[0] || '');
          }
        ).stdin.end(stdout);
      }
    );
    show.on && show.on('error', () => resolve(''));
  });
}

// ---------------------------------------------------------------------------
// Cherry-pick
// ---------------------------------------------------------------------------

// Returns { status: 'ok' | 'conflict' | 'empty' | 'error', conflictedFiles, output }
async function cherryPick(repoPath, id, { mainline = null, noCommit = false } = {}) {
  const args = ['cherry-pick'];
  if (noCommit) args.push('--no-commit');
  if (mainline) args.push('-m', String(mainline));
  args.push(id);

  const r = await git(repoPath, args);
  if (r.code === 0) return { status: 'ok', conflictedFiles: [], output: r.stdout + r.stderr };

  const conflicts = await conflictedFiles(repoPath);
  if (conflicts.length > 0) {
    return { status: 'conflict', conflictedFiles: conflicts, output: r.stdout + r.stderr };
  }
  // No conflicts but failed => empty / already applied
  return { status: 'empty', conflictedFiles: [], output: r.stdout + r.stderr };
}

async function conflictedFiles(repoPath) {
  const r = await git(repoPath, ['diff', '--name-only', '--diff-filter=U']);
  return r.stdout.split('\n').filter(Boolean);
}

// Files (staged or unstaged) that still contain conflict markers. [Feature 3]
async function filesWithConflictMarkers(repoPath) {
  // grep -lE across tracked, modified files for marker lines.
  const r = await git(repoPath, [
    'diff',
    '--name-only',
    'HEAD',
  ]);
  const files = r.stdout.split('\n').filter(Boolean);
  const offenders = [];
  for (const f of files) {
    const g = await git(repoPath, ['grep', '-lE', '^(<{7}|={7}|>{7})', '--', f]);
    if (g.code === 0 && g.stdout.trim()) offenders.push(f);
  }
  return offenders;
}

// True only if no unmerged paths AND no leftover conflict markers. [Feature 3]
async function conflictsResolved(repoPath) {
  const unmerged = await conflictedFiles(repoPath);
  if (unmerged.length > 0) return { resolved: false, files: unmerged, reason: 'unmerged' };
  const markers = await filesWithConflictMarkers(repoPath);
  if (markers.length > 0) return { resolved: false, files: markers, reason: 'markers' };
  return { resolved: true, files: [] };
}

async function addAll(repoPath) {
  return git(repoPath, ['add', '-A']);
}

// Continue without launching an editor (commit retained from the picked commit).
async function continueCherryPick(repoPath) {
  const r = await git(repoPath, ['cherry-pick', '--continue'], {
    env: { ...process.env, GIT_EDITOR: 'true' },
  });
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

async function abortCherryPick(repoPath) {
  return git(repoPath, ['cherry-pick', '--abort']);
}

async function skipCherryPick(repoPath) {
  return git(repoPath, ['cherry-pick', '--skip']);
}

// In review mode (--no-commit), a conflicted pick must NOT be committed.
// We just clear the CHERRY_PICK_HEAD sequencer state, leaving resolved
// changes staged. [fixes CLI review+conflict bug]
async function quitSequencer(repoPath) {
  return git(repoPath, ['cherry-pick', '--quit']);
}

// ---------------------------------------------------------------------------
// Push / pull / commit
// ---------------------------------------------------------------------------

async function pull(repoPath, branch) {
  const r = await git(repoPath, ['pull', 'origin', branch, '--ff-only']);
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

async function push(repoPath, branch, { force = false } = {}) {
  const args = ['push'];
  if (force) args.push('--force-with-lease');
  args.push('origin', branch);
  const r = await git(repoPath, args);
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

async function commit(repoPath, message) {
  const r = await git(repoPath, ['commit', '-m', message]);
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}

async function resetHard(repoPath) {
  return git(repoPath, ['reset', '--hard', 'HEAD']);
}

async function stagedDiff(repoPath) {
  const r = await git(repoPath, ['diff', '--cached']);
  return r.stdout;
}

module.exports = {
  git,
  mapLimit,
  isGitRepo,
  pendingOps,
  abortPending,
  worktreeStatus,
  stashPush,
  stashList,
  stashPop,
  fetch,
  branchExistsOnRemote,
  localBranchExists,
  currentBranch,
  unpushedCommits,
  checkoutFreshFromRemote,
  checkout,
  isValidCommitFormat,
  commitExists,
  commitInfo,
  analyzeCommitList,
  alreadyApplied,
  patchId,
  cherryPick,
  conflictedFiles,
  filesWithConflictMarkers,
  conflictsResolved,
  addAll,
  continueCherryPick,
  abortCherryPick,
  skipCherryPick,
  quitSequencer,
  pull,
  push,
  commit,
  resetHard,
  stagedDiff,
};
