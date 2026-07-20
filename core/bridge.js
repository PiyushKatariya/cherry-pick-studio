// =============================================================================
// core/bridge.js
// Transport-agnostic command handler. createBridge(send) returns { handle, dispose }.
//   - send(obj)  : transport pushes one JSON message to the client
//   - handle(msg): process one incoming client command
// The Express server (over WebSocket) and Electron (over IPC) both use this,
// so all behaviour lives in ONE place.
// =============================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const g = require('./git');
const { Session, parseProgressFile } = require('./session');
const { createTracker } = require('./tracklog');

// Default logs live INSIDE the tool folder (not in the target repo):
//   <cherry-pick-studio>/logs/<YYYYMMDD-hhmmAM|PM>/...
// bridge.js sits in core/, so the tool root is one level up.
const TOOL_LOGS_DIR = path.join(__dirname, '..', 'logs');

function timestampFolder() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  // Parent (date) folder format: DD-MM-YYYY_AM|PM  (e.g. 19-06-2026_AM)
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}_${ampm}`;
}

// Per-run subfolder, created fresh for each cycle inside the date folder.
// Format: hh-mm-ss_AM|PM  (e.g. 11-38-59_AM)
function runFolder() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
  const h12 = d.getHours() % 12 || 12;
  return `${pad(h12)}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${ampm}`;
}

function createBridge(send, meta = {}) {
  let session = null;
  const tracker = createTracker(meta);

  function wireSession(s) {
    s.on('log', (p) => send({ type: 'log', ...p }));
    s.on('progress', (p) => send({ type: 'progress', ...p }));
    s.on('await', (p) => send({ type: 'await', ...p }));
    s.on('summary', (p) => send({ type: 'summary', ...p }));
    s.on('done', (p) => send({ type: 'done', ...p }));
    s.on('error', (p) => {
      tracker.error(0, 'session.run', { repoPath: s.repoPath, branch: s.branch }, p && p.message);
      send({ type: 'error', ...p });
    });
  }

  async function handle(msg) {
    const id = msg.id;
    // Audit trail: record every command + its inputs (id/cmd stripped from params).
    const params = (() => { const { cmd, id: _id, ...rest } = msg || {}; return rest; })();
    const seq = tracker.begin(msg && msg.cmd, params);
    const reply = (data) => send({ type: 'result', id, ok: true, data });
    const sendFail = (error) => send({ type: 'result', id, ok: false, error: String(error) });
    const fail = (error) => { tracker.error(seq, msg.cmd, params, error); return sendFail(error); };

    try {
      switch (msg.cmd) {
        case 'preflight': {
          const repoPath = msg.repoPath;
          if (!fs.existsSync(repoPath)) return fail('Path does not exist.');
          const isRepo = await g.isGitRepo(repoPath);
          if (!isRepo) return fail('Not a git repository.');
          const pending = await g.pendingOps(repoPath);
          const worktree = await g.worktreeStatus(repoPath);
          return reply({ isRepo, pending, worktree });
        }

        case 'abortPending': {
          await g.abortPending(msg.repoPath);
          return reply({ ok: true });
        }

        case 'stash': {
          const ts = timestampFolder();
          const name = `cherry-pick-studio_${ts}`;
          const r = await g.stashPush(msg.repoPath, name);
          return r.ok ? reply(r) : fail(r.error);
        }

        case 'listBranches': {
          const branches = await g.listRemoteBranches(msg.repoPath);
          return reply({ branches });
        }

        case 'checkBranch': {
          await g.fetch(msg.repoPath);
          const existsRemote = await g.branchExistsOnRemote(msg.repoPath, msg.branch);
          if (!existsRemote) return reply({ existsRemote: false });
          const unpushed = await g.unpushedCommits(msg.repoPath, msg.branch);
          return reply({ existsRemote: true, unpushed });
        }

        case 'checkoutBranch': {
          const r = await g.checkoutFreshFromRemote(msg.repoPath, msg.branch);
          return r.ok ? reply({ ok: true }) : fail(r.error);
        }

        case 'analyzeCommits': {
          const raw = String(msg.rawText || '')
            .split(/[,\s]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const result = await g.analyzeCommitList(msg.repoPath, raw);
          return reply(result);
        }

        case 'analyzeRun': {
          // Resolve (in parallel), sort by epoch (oldest first), detect already-applied.
          const resolved = await g.mapLimit(msg.inputs, 8, (input) =>
            g.commitInfo(msg.repoPath, input)
          );
          const infos = resolved.filter(Boolean);
          infos.sort((a, b) => a.epoch - b.epoch);
          const aa = await g.alreadyApplied(msg.repoPath, msg.branch, infos, msg.scanDepth);
          return reply({
            ordered: aa.remaining,
            applied: aa.applied,
            scannedDepth: aa.scannedDepth,
          });
        }

        case 'findResume': {
          const base = msg.logBase || TOOL_LOGS_DIR;
          let found = null;
          try {
            if (fs.existsSync(base)) {
              const stack = [base];
              while (stack.length && !found) {
                const dir = stack.pop();
                for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                  const full = path.join(dir, ent.name);
                  if (ent.isDirectory()) stack.push(full);
                  else if (ent.name === '.cherry-pick-progress') {
                    found = full;
                    break;
                  }
                }
              }
            }
          } catch (_) {}
          if (!found) return reply({ found: false });
          return reply({ found: true, file: found, data: parseProgressFile(found) });
        }

        case 'start': {
          const c = msg.config;
          const logBase = c.logBase || TOOL_LOGS_DIR;
          // Parent = date folder (DD-MM-YYYY_AM|PM); inside it a fresh subfolder
          // per run (hh-mm-ss_AM|PM). A counter guards against same-second runs.
          const dateDir = path.join(logBase, timestampFolder());
          const sub = runFolder();
          let logDir = path.join(dateDir, sub);
          for (let n = 2; fs.existsSync(logDir); n++) logDir = path.join(dateDir, `${sub}_${n}`);
          fs.mkdirSync(logDir, { recursive: true });

          // Resolve ordered inputs to commit infos.
          const commits = [];
          for (const input of c.inputs) {
            const info = await g.commitInfo(c.repoPath, input);
            if (info) commits.push(info);
          }

          session = new Session({
            repoPath: c.repoPath,
            branch: c.branch,
            pushMode: c.pushMode,
            runMode: c.runMode,
            commits,
            logDir,
            originalTotal: c.originalTotal != null ? c.originalTotal : commits.length,
            preSkipped: c.preSkipped || 0,
            didStash: c.didStash || false,
            stashRef: c.stashRef || '',
          });
          wireSession(session);
          reply({ started: true, logDir });
          session.run(); // fire-and-forget; events stream over transport
          return;
        }

        case 'respond': {
          if (!session) return fail('No active session.');
          const okR = session.respond(msg.token, msg.payload);
          return reply({ accepted: okR });
        }

        case 'abortSession': {
          if (session) {
            session.aborted = true;
            // unblock any pending await with an abort decision
            if (session._pending) {
              const kind = msg.kind || '';
              const payload =
                kind === 'push' || kind === 'conflict'
                  ? { action: 'abort' }
                  : { choice: 'skip', action: 'abort' };
              session.respond(session._pending.token, payload);
            }
          }
          return reply({ ok: true });
        }

        case 'popStash': {
          const r = await g.stashPop(msg.repoPath);
          return r.ok ? reply({ ok: true }) : fail(r.output);
        }

        case 'deleteProgress': {
          try {
            fs.unlinkSync(msg.file);
          } catch (_) {}
          return reply({ ok: true });
        }

        default:
          return fail(`Unknown command: ${msg.cmd}`);
      }
    } catch (err) {
      tracker.error(seq, msg && msg.cmd, params, err);   // exception: keep the stack
      return sendFail(err.message);
    }
  }

  function dispose() {
    if (session) session.removeAllListeners();
    session = null;
    tracker.close();
  }

  return { handle, dispose };
}

module.exports = { createBridge, timestampFolder };
