// =============================================================================
// core/selftest-units.js  —  unit tests for the git-free core modules.
// Kept separate from selftest.js (which clones real repos and pushes) so these
// run in milliseconds.
//   npm run test:units      — just these
//   npm test                — these, then the git integration suite
// =============================================================================
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

// A scratch dir per test group, wired in through CPS_DATA_DIR.
function scratch(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cps-${name}-`));
  return dir;
}

function testPaths() {
  console.log('\n[paths]');
  const paths = require('./paths');
  const toolRoot = path.join(__dirname, '..');

  const prev = process.env.CPS_DATA_DIR;
  delete process.env.CPS_DATA_DIR;
  ok(paths.dataRoot() === toolRoot, 'dataRoot defaults to the tool folder');
  ok(paths.logsDir() === path.join(toolRoot, 'logs'), 'logsDir is <tool>/logs by default');
  ok(paths.configDir() === path.join(toolRoot, 'config'), 'configDir is <tool>/config by default');
  ok(
    paths.assetDir('frontend') === path.join(toolRoot, 'frontend'),
    'assetDir is a passthrough in a dev checkout'
  );

  const dir = scratch('paths');
  process.env.CPS_DATA_DIR = dir;
  ok(paths.dataRoot() === dir, 'CPS_DATA_DIR overrides dataRoot');
  ok(paths.logsDir() === path.join(dir, 'logs'), 'CPS_DATA_DIR moves logsDir');
  ok(paths.configDir() === path.join(dir, 'config'), 'CPS_DATA_DIR moves configDir');
  ok(
    paths.assetDir('frontend') === path.join(toolRoot, 'frontend'),
    'CPS_DATA_DIR does not move assets (they ship with the code)'
  );

  if (prev === undefined) delete process.env.CPS_DATA_DIR;
  else process.env.CPS_DATA_DIR = prev;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}

  // The packaged branch can't be exercised without a real asar bundle, so it is
  // tested through the pure resolver instead.
  const R = paths.resolveDataRoot;
  const roaming = 'C:\\Users\\x\\AppData\\Roaming';
  ok(
    R({ packaged: true, appData: roaming, home: 'C:\\Users\\x', toolRoot: 'T' }) ===
      path.join(roaming, 'cherry-pick-studio', 'data'),
    'packaged run writes under APPDATA, not the read-only bundle'
  );
  // %APPDATA%\cherry-pick-studio IS Electron's own userData folder (Chromium
  // keeps Cache, GPUCache, Local State and Preferences there). Our logs and
  // config must not be strewn among those, or a cache cleanup takes them out.
  ok(
    R({ packaged: true, appData: roaming, home: 'C:\\Users\\x', toolRoot: 'T' }) !==
      path.join(roaming, 'cherry-pick-studio'),
    "packaged data root is namespaced away from Electron's Chromium profile"
  );
  ok(
    R({ packaged: true, appData: '', home: '/home/x', toolRoot: 'T' }) ===
      path.join('/home/x', '.cherry-pick-studio', 'data'),
    'packaged run falls back to the home dir when APPDATA is absent'
  );
  ok(
    R({ dataDirEnv: '/override', packaged: true, appData: 'C:\\AD', home: '/h', toolRoot: 'T' }) === '/override',
    'CPS_DATA_DIR wins over the packaged location'
  );
  ok(R({ packaged: false, toolRoot: 'T' }) === 'T', 'unpackaged run uses the tool folder');
}

// Runs `fn` with CPS_DATA_DIR pointed at a throwaway folder, then cleans up.
// repostore reads the env on every call, so each group gets a clean store.
function withStore(name, fn) {
  const dir = scratch(name);
  const prev = process.env.CPS_DATA_DIR;
  process.env.CPS_DATA_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CPS_DATA_DIR;
    else process.env.CPS_DATA_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Deterministic, ordered timestamps — Date.now() collides inside one millisecond,
// which would make the ordering and eviction assertions flaky.
const at = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function testRepoStore() {
  console.log('\n[repostore]');
  const store = require('./repostore');

  // 6 — round-trip
  withStore('rs-round', (dir) => {
    const repo = path.join(dir, 'repoA');
    fs.mkdirSync(repo);
    store.remember(repo, 'rel-2026-07', at(1));
    const list = store.list();
    ok(list.length === 1, 'remember then list returns one entry');
    ok(list[0].path === repo, 'path round-trips');
    ok(list[0].branch === 'rel-2026-07', 'branch round-trips');
    ok(list[0].lastUsed === at(1), 'lastUsed round-trips');
    ok(list[0].pinned === false, 'entries start unpinned');
    ok(list[0].exists === true, 'an existing local path reports exists true');
    ok(fs.existsSync(path.join(dir, 'config', 'repos.json')), 'writes config/repos.json');
  });

  // 7 — upsert, not duplicate; branch is only overwritten when supplied
  withStore('rs-upsert', (dir) => {
    const repo = path.join(dir, 'repoA');
    store.remember(repo, 'main', at(1));
    store.setPinned(repo, true);
    store.remember(repo, '', at(2));
    const list = store.list();
    ok(list.length === 1, 're-remembering updates in place instead of duplicating');
    ok(list[0].lastUsed === at(2), 'lastUsed is bumped');
    ok(list[0].branch === 'main', 'an empty branch does not erase the remembered one');
    ok(list[0].pinned === true, 'upsert preserves the pin');
    store.remember(repo, 'dev', at(3));
    ok(store.list()[0].branch === 'dev', 'a supplied branch replaces the remembered one');
  });

  // 8 — Windows paths are case-insensitive
  withStore('rs-case', (dir) => {
    store.remember(path.join(dir, 'RepoA'), 'main', at(1));
    store.remember(path.join(dir, 'repoa'), 'dev', at(2));
    const list = store.list();
    if (process.platform === 'win32') {
      ok(list.length === 1, 'differently-cased paths collapse to one entry on win32');
      ok(list[0].path === path.join(dir, 'RepoA'), 'the first-seen casing is kept');
    } else {
      ok(list.length === 2, 'paths are case-sensitive off win32');
    }
  });

  // 9 + 10 — the cap evicts the oldest unpinned, never a pinned entry
  withStore('rs-cap', (dir) => {
    store.remember(path.join(dir, 'keeper'), 'main', at(0));
    store.setPinned(path.join(dir, 'keeper'), true);
    for (let i = 1; i <= 20; i++) store.remember(path.join(dir, 'r' + i), 'main', at(i));
    const list = store.list();
    const unpinned = list.filter((r) => !r.pinned);
    ok(unpinned.length === 15, `15 unpinned kept (got ${unpinned.length})`);
    ok(!unpinned.some((r) => r.path.endsWith('r1')), 'the oldest unpinned entry was evicted');
    ok(unpinned.some((r) => r.path.endsWith('r20')), 'the newest unpinned entry survived');
    ok(list.some((r) => r.pinned && r.path.endsWith('keeper')), 'the pinned entry survived eviction');
    ok(list.length === 16, 'pinned entries do not count toward the cap');
  });

  // 11 — ordering
  withStore('rs-order', (dir) => {
    store.remember(path.join(dir, 'old'), 'main', at(1));
    store.remember(path.join(dir, 'new'), 'main', at(3));
    store.remember(path.join(dir, 'pinnedOld'), 'main', at(2));
    store.setPinned(path.join(dir, 'pinnedOld'), true);
    const names = store.list().map((r) => path.basename(r.path));
    ok(names[0] === 'pinnedOld', 'pinned entries sort first');
    ok(names[1] === 'new' && names[2] === 'old', 'unpinned entries sort newest-used first');
  });

  // 12 — a corrupt or foreign file must not throw
  withStore('rs-corrupt', (dir) => {
    const file = path.join(dir, 'config', 'repos.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json');
    let threw = false;
    let list = null;
    try { list = store.list(); } catch (_) { threw = true; }
    ok(!threw && Array.isArray(list) && list.length === 0, 'corrupt JSON reads as an empty list');
    fs.writeFileSync(file, JSON.stringify({ version: 99, repos: [{ path: 'X' }] }));
    ok(store.list().length === 0, 'an unknown version reads as an empty list');
    store.remember(path.join(dir, 'r'), 'main', at(1));
    ok(store.list().length === 1, 'a corrupt file is replaced rather than appended to');
  });

  // 13 — remove / setPinned, including unknown paths
  withStore('rs-mutate', (dir) => {
    store.remember(path.join(dir, 'a'), 'main', at(1));
    store.remember(path.join(dir, 'b'), 'main', at(2));
    store.remove(path.join(dir, 'a'));
    ok(store.list().length === 1 && store.list()[0].path.endsWith('b'), 'remove drops one entry');
    let threw = false;
    try {
      store.remove(path.join(dir, 'nope'));
      store.setPinned(path.join(dir, 'nope'), true);
    } catch (_) { threw = true; }
    ok(!threw, 'removing or pinning an unknown path is a no-op, not an error');
    ok(store.list().length === 1, 'the no-ops left the store alone');
    store.setPinned(path.join(dir, 'b'), true);
    ok(store.list()[0].pinned === true, 'setPinned pins');
    store.setPinned(path.join(dir, 'b'), false);
    ok(store.list()[0].pinned === false, 'setPinned unpins');
  });

  // 14 — a dead UNC path must not be stat-ed; existsSync would block for seconds
  withStore('rs-unc', () => {
    store.remember('\\\\server\\share\\repo', 'main', at(1));
    ok(store.list()[0].exists === null, 'a UNC path reports exists null rather than being stat-ed');
  });

  // a missing local path is reported honestly
  withStore('rs-missing', (dir) => {
    store.remember(path.join(dir, 'gone'), 'main', at(1));
    ok(store.list()[0].exists === false, 'a missing local path reports exists false');
  });
}

// Write a .cherry-pick-progress in the same key=value format _saveProgress uses.
// `mtime` is set explicitly so the newest-wins assertion cannot be flaky.
function writeProgress(dir, { repoPath, remaining, branch = 'client', mtime }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.cherry-pick-progress');
  fs.writeFileSync(
    file,
    [
      `repo_path=${repoPath}`,
      `branch=${branch}`,
      'push_mode=each',
      'run_mode=normal',
      'last_completed_index=0',
      'total_commits=3',
      'succeeded=1',
      'skipped=0',
      'conflicts_resolved=0',
      'failed=0',
      `remaining_commits=${remaining}`,
    ].join('\n') + '\n'
  );
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function testFindLatestResume() {
  console.log('\n[findLatestResume]');
  const { findLatestResume } = require('./session');

  // 4 — the reported bug: a finished run must not offer to resume.
  withStore('fr-done', (dir) => {
    const base = path.join(dir, 'logs');
    const repo = path.join(dir, 'repoA');
    writeProgress(path.join(base, '01-01-2026_AM', '10-00-00_AM'), { repoPath: repo, remaining: '' });
    ok(findLatestResume(base, repo) === null, 'a completed run is not offered for resume');
  });

  // 3 — only the interrupted run for THIS repo qualifies.
  withStore('fr-filter', (dir) => {
    const base = path.join(dir, 'logs');
    const repoA = path.join(dir, 'repoA');
    const repoB = path.join(dir, 'repoB');
    const wanted = writeProgress(path.join(base, 'd1', 'r1'), { repoPath: repoA, remaining: 'aaa1111 bbb2222' });
    writeProgress(path.join(base, 'd1', 'r2'), { repoPath: repoA, remaining: '' });
    writeProgress(path.join(base, 'd1', 'r3'), { repoPath: repoB, remaining: 'ccc3333' });
    const hit = findLatestResume(base, repoA);
    ok(hit && hit.file === wanted, 'picks the interrupted run belonging to this repo');
    ok(hit && hit.data.remaining_commits === 'aaa1111 bbb2222', 'returns the parsed progress data');
    const hitB = findLatestResume(base, repoB);
    ok(hitB && hitB.data.remaining_commits === 'ccc3333', 'a different repo gets its own session');
  });

  // 5 — newest wins when several interrupted runs match.
  withStore('fr-newest', (dir) => {
    const base = path.join(dir, 'logs');
    const repo = path.join(dir, 'repoA');
    writeProgress(path.join(base, 'd1', 'older'), {
      repoPath: repo, remaining: 'old1111', mtime: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = writeProgress(path.join(base, 'd1', 'newer'), {
      repoPath: repo, remaining: 'new2222', mtime: new Date('2026-06-01T00:00:00Z'),
    });
    const hit = findLatestResume(base, repo);
    ok(hit && hit.file === newer, 'the most recent interrupted run wins');
    ok(hit && hit.mtimeMs === new Date('2026-06-01T00:00:00Z').getTime(),
      'the write time comes back so the resume prompt can be dated');
  });

  // Windows path comparison must ignore case and trailing separators.
  withStore('fr-case', (dir) => {
    const base = path.join(dir, 'logs');
    const repo = path.join(dir, 'RepoA');
    writeProgress(path.join(base, 'd1', 'r1'), { repoPath: repo, remaining: 'aaa1111' });
    const probe = process.platform === 'win32' ? path.join(dir, 'repoa') + path.sep : repo;
    ok(findLatestResume(base, probe) !== null, 'repo match tolerates casing and a trailing separator');
    ok(findLatestResume(base, path.join(dir, 'other')) === null, 'an unrelated repo finds nothing');
  });

  // Robustness: a junk file must not hide a valid one, and a missing base is fine.
  withStore('fr-junk', (dir) => {
    const base = path.join(dir, 'logs');
    const repo = path.join(dir, 'repoA');
    fs.mkdirSync(path.join(base, 'd1', 'bad'), { recursive: true });
    fs.writeFileSync(path.join(base, 'd1', 'bad', '.cherry-pick-progress'), 'not-key-values');
    const good = writeProgress(path.join(base, 'd1', 'ok'), { repoPath: repo, remaining: 'aaa1111' });
    const hit = findLatestResume(base, repo);
    ok(hit && hit.file === good, 'an unparseable progress file is skipped, not fatal');
    ok(findLatestResume(path.join(dir, 'no-such-dir'), repo) === null, 'a missing log base returns null');
  });
}

// GET a URL, resolving { status, body } or rejecting.
function httpGet(url) {
  return new Promise((resolve, reject) => {
    require('http')
      .get(url, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', reject);
  });
}

async function testServer() {
  console.log('\n[server]');
  const srv = require('../server/server');

  // 1 — port 0 lets the OS pick, and the caller is told which one.
  const { server, port } = await srv.start({ port: 0 });
  ok(typeof port === 'number' && port > 0, `start() reports its port (got ${port})`);

  const health = await httpGet(`http://127.0.0.1:${port}/health`);
  ok(health.status === 200 && /"ok":true/.test(health.body), 'the started server serves /health');
  const index = await httpGet(`http://127.0.0.1:${port}/`);
  ok(index.status === 200 && /Cherry-Pick Studio/.test(index.body), 'it serves the frontend');

  // 2 — loopback only: the bridge runs git against any local path.
  ok(server.address().address === '127.0.0.1', 'it binds 127.0.0.1, not every interface');

  await new Promise((r) => server.close(r));
  let refusedAfterClose = false;
  try { await httpGet(`http://127.0.0.1:${port}/health`); } catch (_) { refusedAfterClose = true; }
  ok(refusedAfterClose, 'close() releases the port');

  // A busy port must REJECT, not crash. ws mirrors the http server's 'error'
  // onto itself, so an unhandled one there kills the process — which in the
  // packaged app would mean the --web window dying instead of showing the error.
  const held = await srv.start({ port: 0 });
  let rejectedCode = null;
  try {
    await srv.start({ port: held.port });
  } catch (err) {
    rejectedCode = err.code;
  }
  ok(rejectedCode === 'EADDRINUSE', `a busy port rejects with EADDRINUSE (got ${rejectedCode})`);
  await new Promise((r) => held.server.close(r));

  // 3 — requiring the module must not start anything. If it did, the child's
  // event loop would stay alive on the listener and the process would hang.
  const entry = path.join(__dirname, '..', 'server', 'server.js');
  const exited = await new Promise((resolve) => {
    require('child_process').execFile(
      process.execPath,
      ['-e', `require(${JSON.stringify(entry)})`],
      { timeout: 4000 },
      (err) => resolve(!(err && err.killed))
    );
  });
  ok(exited, 'requiring server.js starts no listener (the process exits)');
}

async function testGitProbe() {
  console.log('\n[git probe]');
  const g = require('./git');

  const v = await g.gitVersion();
  ok(typeof v === 'string' && /\d+\.\d+/.test(v), `gitVersion returns a version (got ${v})`);

  // The whole point of the probe: on a machine without git it must report
  // "absent" rather than throwing, so the UI can say what to install.
  // Simulated with a child process whose PATH cannot resolve git.
  const script =
    `require(${JSON.stringify(path.join(__dirname, 'git.js'))})` +
    `.gitVersion().then(v => console.log('RESULT:' + JSON.stringify(v)),` +
    ` e => console.log('THREW:' + e.message))`;
  const out = await new Promise((resolve) => {
    require('child_process').execFile(
      process.execPath,
      ['-e', script],
      { timeout: 10000, env: { ...process.env, PATH: '', Path: '' } },
      (err, stdout, stderr) => resolve(String(stdout || '') + String(stderr || ''))
    );
  });
  ok(/RESULT:null/.test(out), `gitVersion resolves null when git is absent (got ${out.trim()})`);
}

async function main() {
  testPaths();
  testRepoStore();
  testFindLatestResume();
  await testServer();
  await testGitProbe();
  console.log(`\nUNIT RESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
