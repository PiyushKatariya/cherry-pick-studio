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
const { Session } = require('./session');

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
  session.on('progress', (e) => events.push(e.status));
  await new Promise((resolve) => { session.on('done', resolve); session.run(); });
  ok(session.counters.succeeded === 3, `3 succeeded (got ${session.counters.succeeded})`);
  ok(session.counters.failed === 0, '0 failed');
  ok(fs.existsSync(path.join(logDir, 'cherry-pick-log.txt')), 'log file written');

  // files now exist on client and were pushed
  ok(fs.existsSync(path.join(work, 'a.txt')) && fs.existsSync(path.join(work, 'c.txt')), 'cherry-picked files present');
  const remoteLog = sh(work, ['log', '--oneline', 'origin/client']);
  ok(/add alpha/.test(remoteLog) && /add charlie/.test(remoteLog), 'commits pushed to origin/client');

  console.log('\n[Session — re-run detects already applied]');
  const aa2 = await g.alreadyApplied(work, 'client', infos);
  ok(aa2.applied.length === 3, `all 3 now already-applied (got ${aa2.applied.length})`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  // best-effort cleanup
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
