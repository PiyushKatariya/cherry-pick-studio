// =============================================================================
// core/tracklog.js
// Per-session audit + error logging for Cherry-Pick Studio.
//
// createTracker(meta) returns a small logger bound to ONE session (one web
// connection or one desktop window). It records:
//   - every command the user issues + its inputs  -> logs/tranclogs/
//   - every failure (business error, exception, or session error) + context
//                                                   -> logs/errorlog/
// Each is written in BOTH .jsonl (machine-queryable) and .log (human-readable).
// Logging never throws: a failed write is swallowed so it can't break a run.
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Audit logs always live inside the tool's own logs/ folder (not the user's
// custom per-run log folder). tracklog.js sits in core/, so root is one level up.
const LOGS_ROOT = path.join(__dirname, '..', 'logs');
const TRANS_DIR = path.join(LOGS_ROOT, 'tranclogs');
const ERROR_DIR = path.join(LOGS_ROOT, 'errorlog');

const MAX_PARAMS_CHARS = 8192; // cap serialized params so one row can't run away

function pad(n) { return String(n).padStart(2, '0'); }

// Compact stamp for filenames: YYYYMMDD-HHMMSS (24h).
function fileStamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// Human-readable stamp for log lines: YYYY-MM-DD hh:mm:ss AM|PM.
function humanStamp(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(h)}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ampm}`;
}

// A short, filesystem-safe session id. Not cryptographic — just unique enough
// to correlate a session's transaction rows with its error rows.
function makeSessionId(d) {
  const rnd = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `${fileStamp(d)}-${rnd}`;
}

function safeAppend(file, text) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, text);
  } catch (_) { /* logging must never break the tool */ }
}

// Serialize params defensively: strip huge blobs, tolerate circular refs.
function serializeParams(params) {
  let s;
  try {
    s = JSON.stringify(params == null ? {} : params);
  } catch (_) {
    s = '"[unserializable params]"';
  }
  if (s.length > MAX_PARAMS_CHARS) s = s.slice(0, MAX_PARAMS_CHARS) + '…[truncated]';
  return s;
}

function createTracker(meta = {}) {
  const started = new Date();
  const sessionId = makeSessionId(started);

  const identity = {
    transport: meta.transport || 'unknown',
    user: meta.user || (() => { try { return os.userInfo().username; } catch (_) { return 'unknown'; } })(),
    client: meta.client || null,
    machine: (() => { try { return os.hostname(); } catch (_) { return 'unknown'; } })(),
  };

  const base = `${fileStamp(started)}_${sessionId}`;
  const transJsonl = path.join(TRANS_DIR, base + '.jsonl');
  const transLog = path.join(TRANS_DIR, base + '.log');
  const errJsonl = path.join(ERROR_DIR, base + '.jsonl');
  const errLog = path.join(ERROR_DIR, base + '.log');

  let seq = 0;

  const who = `${identity.transport}` +
    (identity.user ? ` user=${identity.user}` : '') +
    (identity.client ? ` client=${identity.client}` : '') +
    `@${identity.machine}`;

  // --- session header (transaction log) ---
  const header = { ts: humanStamp(started), sessionId, event: 'session-start', ...identity };
  safeAppend(transJsonl, JSON.stringify(header) + '\n');
  safeAppend(transLog, `${header.ts} | === session ${sessionId} start — ${who} ===\n`);

  // Record one command + its inputs. Returns the seq for later error correlation.
  function begin(cmd, params) {
    const n = ++seq;
    const d = new Date();
    const entry = { ts: humanStamp(d), sessionId, seq: n, ...identity, cmd, params: params == null ? {} : params };
    safeAppend(transJsonl, JSON.stringify(entry) + '\n');
    safeAppend(transLog, `${entry.ts} | seq=${n} | ${who} | cmd=${cmd} | ${serializeParams(params)}\n`);
    return n;
  }

  // Record a failure with the triggering command + inputs (+ stack if available).
  function error(atSeq, cmd, params, err) {
    const d = new Date();
    const message = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? String(err.stack) : null;
    const entry = {
      ts: humanStamp(d), sessionId, seq: atSeq, ...identity, cmd,
      params: params == null ? {} : params, error: message, stack,
    };
    safeAppend(errJsonl, JSON.stringify(entry) + '\n');
    safeAppend(errLog,
      `${entry.ts} | seq=${atSeq} | ${who} | cmd=${cmd} | ${serializeParams(params)}\n` +
      `    ERROR: ${message}\n` + (stack ? stack.split('\n').map((l) => '    ' + l).join('\n') + '\n' : ''));
  }

  function close() {
    const d = new Date();
    const entry = { ts: humanStamp(d), sessionId, event: 'session-end', commands: seq };
    safeAppend(transJsonl, JSON.stringify(entry) + '\n');
    safeAppend(transLog, `${entry.ts} | === session ${sessionId} end (${seq} commands) ===\n`);
  }

  return { sessionId, begin, error, close };
}

module.exports = { createTracker };
