// =============================================================================
// core/selftest.js  —  integration test for the core engine.
// Creates a bare "remote" + a working clone, then exercises validation,
// already-applied detection, and a real cherry-pick run via Session.
//   npm test
// =============================================================================
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('./git');
const { Session, findLatestResume } = require('./session');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-test-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  console.log('Workspace:', root);

  // Keep the tool's own config/ and logs/ out of this run: the bridge remembers
  // repos and writes audit logs, and a test must not touch the real ones.
  process.env.CPS_DATA_DIR = root;

  // bare remote + clone
  fs.mkdirSync(remote);
  sh(remote, ['init', '--bare', '-b', 'main']);
  sh(root, ['clone', remote, 'work']);
  sh(work, ['config', 'user.email', 'test@example.com']);
  sh(work, ['config', 'user.name', 'Tester']);

  // main branch: base + 3 feature commits
  const writeCommit = (file, content, msg) => {
    fs.writeFileSync(path.join(work, file), content);
    sh(work, ['add', '-A']);
    sh(work, ['commit', '-m', msg]);
    return sh(work, ['rev-parse', 'HEAD']).trim();
  };
  writeCommit('base.txt', 'base\n', 'base');
  sh(work, ['push', 'origin', 'main']);
  const c1 = writeCommit('a.txt', 'alpha\n', 'add alpha');
  const c2 = writeCommit('b.txt', 'bravo\n', 'add bravo');
  const c3 = writeCommit('c.txt', 'charlie\n', 'add charlie');
  sh(work, ['push', 'origin', 'main']);

  // client branch off base (only has base.txt)
  sh(work, ['checkout', '-b', 'client', 'HEAD~3']);
  sh(work, ['push', 'origin', 'client']);
  sh(work, ['checkout', 'main']);

  console.log('\n[git ops]');
  ok(await g.isGitRepo(work), 'isGitRepo true');
  ok(!(await g.isGitRepo(root)), 'isGitRepo false outside');
  ok(await g.branchExistsOnRemote(work, 'client'), 'remote branch client exists');
  ok(!(await g.branchExistsOnRemote(work, 'nope')), 'missing remote branch detected');

  const analysis = await g.analyzeCommitList(work, [c1, c2, c2, 'zzzz', 'deadbeef']);
  ok(analysis.valid.length === 2, 'analyzeCommitList: 2 valid');
  ok(analysis.duplicates.length === 1, 'analyzeCommitList: 1 duplicate');
  ok(analysis.badFormat.length === 1, 'analyzeCommitList: 1 bad format (zzzz)');
  ok(analysis.notFound.length === 1, 'analyzeCommitList: 1 not found (deadbeef)');

  const info = await g.commitInfo(work, c1);
  ok(info && info.subject === 'add alpha' && !info.isMerge, 'commitInfo basic');

  // fresh checkout of client (what the real flow does)
  await g.fetch(work);
  const co = await g.checkoutFreshFromRemote(work, 'client');
  ok(co.ok, 'checkoutFreshFromRemote ok');
  ok((await g.currentBranch(work)) === 'client', 'now on client');

  // already-applied: none of c1..c3 are on client yet
  const infos = [];
  for (const c of [c1, c2, c3]) infos.push(await g.commitInfo(work, c));
  const aa = await g.alreadyApplied(work, 'client', infos);
  ok(aa.remaining.length === 3 && aa.applied.length === 0, 'alreadyApplied: 3 remaining');

  console.log('\n[Session — normal run, push each]');
  const logDir = path.join(root, 'logs', 'run1');
  const session = new Session({
    repoPath: work, branch: 'client', pushMode: 'each', runMode: 'normal',
    commits: infos, logDir, originalTotal: 3, preSkipped: 0,
  });
  const events = [];
  let summary = null;
  session.on('progress', (e) => events.push(e.status));
  session.on('summary', (e) => { summary = e; });
  await new Promise((resolve) => { session.on('done', resolve); session.run(); });
  ok(session.counters.succeeded === 3, `3 succeeded (got ${session.counters.succeeded})`);
  ok(session.counters.failed === 0, '0 failed');
  ok(fs.existsSync(path.join(logDir, 'cherry-pick-log.txt')), 'log file written');

  // A finished run must leave nothing to resume — otherwise the next session
  // opens with a bogus "previous session found" prompt.
  ok(!fs.existsSync(path.join(logDir, '.cherry-pick-progress')),
    'clean finish removes the progress file');
  ok(summary && summary.progressLeft === false,
    'summary reports no progress file left after a clean finish');

  // files now exist on client and were pushed
  ok(fs.existsSync(path.join(work, 'a.txt')) && fs.existsSync(path.join(work, 'c.txt')), 'cherry-picked files present');
  const remoteLog = sh(work, ['log', '--oneline', 'origin/client']);
  ok(/add alpha/.test(remoteLog) && /add charlie/.test(remoteLog), 'commits pushed to origin/client');

  console.log('\n[Session — re-run detects already applied]');
  const aa2 = await g.alreadyApplied(work, 'client', infos);
  ok(aa2.applied.length === 3, `all 3 now already-applied (got ${aa2.applied.length})`);

  console.log('\n[Session — aborted run keeps its progress file]');
  // A fresh set of commits and a second client branch, so this is independent
  // of the run above (whose commits are now already applied).
  sh(work, ['checkout', 'main']);
  const d1 = writeCommit('d.txt', 'delta\n', 'add delta');
  const d2 = writeCommit('e.txt', 'echo\n', 'add echo');
  const d3 = writeCommit('f.txt', 'foxtrot\n', 'add foxtrot');
  sh(work, ['push', 'origin', 'main']);
  sh(work, ['checkout', '-b', 'client2', 'HEAD~4']);
  sh(work, ['push', 'origin', 'client2']);

  const dInfos = [];
  for (const c of [d1, d2, d3]) dInfos.push(await g.commitInfo(work, c));
  const logDir2 = path.join(root, 'logs', 'run2');
  const aborted = new Session({
    repoPath: work, branch: 'client2', pushMode: 'batch', runMode: 'normal',
    commits: dInfos, logDir: logDir2, originalTotal: 3, preSkipped: 0,
  });
  let summary2 = null;
  aborted.on('summary', (e) => { summary2 = e; });
  // Stop after the first commit: run() re-checks `aborted` at the top of each
  // iteration, so commit 1 completes and saves progress, then the loop breaks.
  aborted.on('progress', () => { aborted.aborted = true; });
  await new Promise((resolve) => { aborted.on('done', resolve); aborted.run(); });

  const prog2 = path.join(logDir2, '.cherry-pick-progress');
  ok(fs.existsSync(prog2), 'an aborted run keeps its progress file');
  ok(summary2 && summary2.progressLeft === true,
    'summary reports a progress file left after an abort');
  const resumable = findLatestResume(path.join(root, 'logs'), work);
  ok(resumable && resumable.file === prog2,
    'findLatestResume offers the aborted run, not the completed one');

  console.log('\n[bridge — repo memory & resume]');
  const { createBridge } = require('./bridge');
  const store = require('./repostore');
  const sent = [];
  const bridge = createBridge((o) => sent.push(o), { transport: 'selftest' });
  const call = async (msg) => {
    sent.length = 0;
    await bridge.handle(msg);
    return sent.find((m) => m.type === 'result');
  };

  const pf = await call({ cmd: 'preflight', id: 'p1', repoPath: work });
  ok(pf && pf.ok === true, 'preflight succeeds for a real repo');
  ok(store.list().some((r) => r.path === path.resolve(work)),
    'a repo that passes preflight is remembered');

  const lr = await call({ cmd: 'listRepos', id: 'p2' });
  ok(lr && lr.ok && Array.isArray(lr.data.repos) && lr.data.repos.length >= 1,
    'listRepos returns the remembered repos');
  ok(lr && lr.data.repos[0].exists === true, 'listRepos annotates whether the path still exists');

  await call({ cmd: 'pinRepo', id: 'p3', repoPath: work, pinned: true });
  ok(store.list()[0].pinned === true, 'pinRepo pins the repo');

  const badPf = await call({ cmd: 'preflight', id: 'p4', repoPath: path.join(root, 'not-a-repo') });
  ok(badPf && badPf.ok === false, 'preflight still fails for a non-repo');
  ok(!store.list().some((r) => r.path.endsWith('not-a-repo')),
    'a path that fails preflight is not remembered');

  // The bug this release fixes: a finished run must not be offered for resume.
  const fr = await call({ cmd: 'findResume', id: 'p5', logBase: path.join(root, 'logs'), repoPath: work });
  ok(fr && fr.ok && fr.data.found === true, 'findResume finds the aborted run for this repo');
  ok(fr && fr.data.file === prog2, 'findResume returns the interrupted session, not the completed one');
  const frOther = await call({
    cmd: 'findResume', id: 'p6', logBase: path.join(root, 'logs'), repoPath: path.join(root, 'elsewhere'),
  });
  ok(frOther && frOther.ok && frOther.data.found === false,
    'findResume reports nothing for an unrelated repo');

  await call({ cmd: 'forgetRepo', id: 'p7', repoPath: work });
  ok(!store.list().some((r) => r.path === path.resolve(work)), 'forgetRepo drops the repo');

  const pr = await call({ cmd: 'probe', id: 'p8' });
  ok(pr && pr.ok && typeof pr.data.git === 'string' && /\d+\.\d+/.test(pr.data.git),
    'probe reports the git version so the UI can refuse to start without it');
  bridge.dispose();

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  // best-effort cleanup
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
