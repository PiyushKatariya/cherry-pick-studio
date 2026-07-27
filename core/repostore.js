// =============================================================================
// core/repostore.js
// Owns config/repos.json — the list of repositories the user has worked with,
// so they can pick one instead of retyping a path every session.
//
// Repos are remembered automatically when they pass the wizard's Check step.
// Pinned entries sort to the top and are never evicted; unpinned ones are capped
// so the list stays short.
//
// Everything here is best-effort by design: the repo list is a convenience, and
// a failure to read or write it must never block a cherry-pick. Nothing throws.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const VERSION = 1;
const UNPINNED_CAP = 15;

const storeFile = () => path.join(paths.configDir(), 'repos.json');

// Windows paths are case-insensitive, so D:\Repo and d:\repo are one repo.
// Only the comparison key is folded — the stored path keeps the user's casing.
function key(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function read() {
  try {
    const obj = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (!obj || obj.version !== VERSION || !Array.isArray(obj.repos)) return [];
    return obj.repos.filter((r) => r && typeof r.path === 'string' && r.path);
  } catch (_) {
    return []; // missing, empty, corrupt, or written by a future version
  }
}

// Atomic: a half-written temp file can never become the real one.
function write(repos) {
  try {
    fs.mkdirSync(paths.configDir(), { recursive: true });
    const tmp = storeFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, repos }, null, 2) + '\n');
    fs.renameSync(tmp, storeFile());
    return true;
  } catch (_) {
    return false;
  }
}

// Pinned first, then most-recently-used first within each group.
function sortEntries(repos) {
  return repos.slice().sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return String(b.lastUsed || '').localeCompare(String(a.lastUsed || ''));
  });
}

// Keep every pinned entry; trim the unpinned tail to the cap.
function evict(repos) {
  const pinned = repos.filter((r) => r.pinned);
  const unpinned = repos
    .filter((r) => !r.pinned)
    .sort((a, b) => String(b.lastUsed || '').localeCompare(String(a.lastUsed || '')))
    .slice(0, UNPINNED_CAP);
  return pinned.concat(unpinned);
}

// existsSync against an unreachable network share blocks for seconds, and this
// runs while the user is opening the dropdown — so UNC paths report "unknown"
// and render as normal rather than being probed.
function existsOf(p) {
  if (p.startsWith('\\\\') || p.startsWith('//')) return null;
  try {
    return fs.existsSync(p);
  } catch (_) {
    return null;
  }
}

function stamp(now) {
  if (now instanceof Date) return now.toISOString();
  return now || new Date().toISOString();
}

function list() {
  return sortEntries(read()).map((r) => ({
    path: r.path,
    branch: r.branch || '',
    pinned: !!r.pinned,
    lastUsed: r.lastUsed || '',
    exists: existsOf(r.path),
  }));
}

// Upsert by path. An empty/absent `branch` leaves the remembered one alone, so
// the preflight call (which knows no branch yet) cannot erase it.
// `now` is injectable so ordering is deterministic under test.
function remember(repoPath, branch, now) {
  if (!repoPath) return false;
  const resolved = path.resolve(repoPath);
  const k = key(resolved);
  const repos = read();
  const existing = repos.find((r) => key(r.path) === k);
  if (existing) {
    existing.lastUsed = stamp(now);
    if (branch) existing.branch = branch;
  } else {
    repos.push({ path: resolved, branch: branch || '', pinned: false, lastUsed: stamp(now) });
  }
  return write(evict(repos));
}

function setPinned(repoPath, pinned) {
  const k = key(repoPath);
  const repos = read();
  const entry = repos.find((r) => key(r.path) === k);
  if (!entry) return false;
  entry.pinned = !!pinned;
  return write(repos);
}

function remove(repoPath) {
  const k = key(repoPath);
  const repos = read();
  const kept = repos.filter((r) => key(r.path) !== k);
  if (kept.length === repos.length) return false;
  return write(kept);
}

module.exports = { list, remember, setPinned, remove, storeFile, UNPINNED_CAP };
