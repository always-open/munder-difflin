'use strict';
/**
 * Hive router/persistence tests. Self-contained, no test framework — run with
 * `node test/hive-router.test.cjs` (mirrors test/breaker.test.cjs). hive.ts
 * imports only node builtins plus three self-contained shared modules
 * (claudeCommands, codexCommands→types, agentProvider, mcpCatalog), so the set
 * transpiles standalone with the bundled `typescript` compiler.
 *
 * Focus: the audit fixes —
 *   1. router-minted wire ids (agent-supplied id → client_id, never the filename);
 *   2. claim-before-deliver archiving (+ .sent recreation, unique archive names);
 *   3. quarantine grace for mid-write outbox files + quarantine logging;
 *   4. unknown-recipient bounce (refuse to sender, 'bounced' not 'message' log);
 *   5. logTail tail-read correctness past the 64KB window;
 *   6. writeTasks read-modify-write merge (god's cards survive, dismiss still works);
 *   7. debounced/coalesced async commit queue + flushSync + churn-file untrack.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const ts = require('typescript');

const REPO = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mod-'));
for (const rel of [
  'src/main/hive.ts',
  'src/shared/claudeCommands.ts',
  'src/shared/codexCommands.ts',
  'src/shared/agentProvider.ts',
  'src/shared/mcpCatalog.ts'
]) {
  const js = ts.transpileModule(fs.readFileSync(path.join(REPO, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const dest = path.join(out, rel.replace(/^src\//, '').replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, js, 'utf8');
}
const { HiveManager } = require(path.join(out, 'main', 'hive.js'));

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.stack || e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.stack || e.message}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fresh harness-home + HiveManager. No git unless a test inits it. */
function makeHive() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-t-'));
  const root = path.join(home, 'hive');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return { hive: new HiveManager(() => home), root };
}
function scaffoldAgent(root, id) {
  fs.mkdirSync(path.join(root, 'agents', id, 'inbox', '.done'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents', id, 'outbox', '.sent'), { recursive: true });
}
function writeRegistry(root, ids, godId = null) {
  const agents = {};
  for (const id of ids) agents[id] = { id, name: id, cwd: '/tmp', status: 'idle', lastSeen: Date.now() };
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId, agents }, null, 2));
}
const inboxFiles = (root, id) =>
  fs.readdirSync(path.join(root, 'agents', id, 'inbox')).filter((f) => f.endsWith('.json'));
const sentFiles = (root, id) =>
  fs.readdirSync(path.join(root, 'agents', id, 'outbox', '.sent')).filter((f) => f.endsWith('.json'));
const logLines = (root) =>
  fs.existsSync(path.join(root, 'log.jsonl'))
    ? fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const GIT = 'git -c user.name=T -c user.email=t@t -c commit.gpgsign=false';

// ── 1. router-assigned ids ───────────────────────────────────────────────────

test('router mints the wire id; agent-supplied id survives as client_id', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1'); scaffoldAgent(root, 'b1');
  writeRegistry(root, ['a1', 'b1']);
  fs.writeFileSync(path.join(root, 'agents', 'a1', 'outbox', 'msg.json'),
    JSON.stringify({ to: 'b1', act: 'inform', subject: 's', body: 'b', id: 'reply-breaker-999' }));
  assert.equal(hive.routeOnce(), 1);
  const files = inboxFiles(root, 'b1');
  assert.equal(files.length, 1);
  const msg = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'b1', 'inbox', files[0]), 'utf8'));
  assert.notEqual(msg.id, 'reply-breaker-999');
  assert.match(msg.id, /^\d{4}-\d{2}-\d{2}T/); // stamp()-shaped → sorts with the drain cursor
  assert.equal(msg.client_id, 'reply-breaker-999');
  assert.equal(files[0], `${msg.id}.json`);
  assert.equal(msg.from, 'a1');
});

test('two outbox files carrying the SAME id no longer overwrite each other', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1'); scaffoldAgent(root, 'b1');
  writeRegistry(root, ['a1', 'b1']);
  for (const f of ['m1.json', 'm2.json']) {
    fs.writeFileSync(path.join(root, 'agents', 'a1', 'outbox', f),
      JSON.stringify({ to: 'b1', act: 'inform', subject: f, id: 'dup-1' }));
  }
  assert.equal(hive.routeOnce(), 2);
  assert.equal(inboxFiles(root, 'b1').length, 2); // pre-fix: 1 (silent overwrite)
});

// ── 2. claim-before-deliver ──────────────────────────────────────────────────

test('missing .sent (clone-restored hive) is recreated; no duplicate storm', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1'); scaffoldAgent(root, 'b1');
  writeRegistry(root, ['a1', 'b1']);
  fs.rmSync(path.join(root, 'agents', 'a1', 'outbox', '.sent'), { recursive: true, force: true });
  fs.writeFileSync(path.join(root, 'agents', 'a1', 'outbox', 'msg.json'),
    JSON.stringify({ to: 'b1', act: 'inform', subject: 's' }));
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.routeOnce(), 0); // pre-fix: redelivered every tick forever
  assert.equal(inboxFiles(root, 'b1').length, 1);
  assert.equal(sentFiles(root, 'a1').length, 1);
});

test('archive names are unique — a reused msg.json never clobbers .sent history', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1'); scaffoldAgent(root, 'b1');
  writeRegistry(root, ['a1', 'b1']);
  const outbox = path.join(root, 'agents', 'a1', 'outbox');
  fs.writeFileSync(path.join(outbox, 'msg.json'), JSON.stringify({ to: 'b1', subject: 'first' }));
  hive.routeOnce();
  fs.writeFileSync(path.join(outbox, 'msg.json'), JSON.stringify({ to: 'b1', subject: 'second' }));
  hive.routeOnce();
  assert.equal(sentFiles(root, 'a1').length, 2); // pre-fix: 1 (same-name clobber)
  assert.equal(inboxFiles(root, 'b1').length, 2);
});

// ── 3. quarantine grace + logging ────────────────────────────────────────────

test('a fresh unparseable outbox file is left for the next tick, not quarantined', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1');
  writeRegistry(root, ['a1']);
  const bad = path.join(root, 'agents', 'a1', 'outbox', 'partial.json');
  fs.writeFileSync(bad, '{"to":"b1","body":"trunca'); // mid-write shape
  assert.equal(hive.routeOnce(), 0);
  assert.ok(fs.existsSync(bad), 'young malformed file must survive the sweep');
  assert.ok(!logLines(root).some((l) => l.kind === 'quarantine'));
});

test('an OLD malformed file is quarantined under a stamped bad- name AND logged', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1');
  writeRegistry(root, ['a1']);
  const bad = path.join(root, 'agents', 'a1', 'outbox', 'garbage.json');
  fs.writeFileSync(bad, 'not json at all');
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(bad, past, past);
  assert.equal(hive.routeOnce(), 0);
  assert.ok(!fs.existsSync(bad));
  const quarantined = sentFiles(root, 'a1').filter((f) => f.startsWith('bad-'));
  assert.equal(quarantined.length, 1);
  const q = logLines(root).filter((l) => l.kind === 'quarantine');
  assert.equal(q.length, 1);
  assert.equal(q[0].file, 'garbage.json');
});

// ── 4. unknown-recipient bounce ──────────────────────────────────────────────

test('mail to an unknown id bounces a refuse to the sender and logs bounced, not routed', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1');
  writeRegistry(root, ['a1']);
  fs.writeFileSync(path.join(root, 'agents', 'a1', 'outbox', 'ask.json'),
    JSON.stringify({ to: 'pam', act: 'request', subject: 'help', body: 'x' }));
  hive.routeOnce();
  const files = inboxFiles(root, 'a1');
  assert.equal(files.length, 1, 'sender must receive the bounce');
  const refuse = JSON.parse(fs.readFileSync(path.join(root, 'agents', 'a1', 'inbox', files[0]), 'utf8'));
  assert.equal(refuse.act, 'refuse');
  assert.equal(refuse.from, 'system');
  assert.equal(refuse.to, 'a1');
  assert.match(refuse.subject, /unknown agent "pam"/);
  assert.equal(refuse.requires_reply, false);
  const lines = logLines(root);
  const bounced = lines.filter((l) => l.kind === 'bounced');
  assert.equal(bounced.length, 1);
  assert.equal(bounced[0].to, 'pam');
  assert.equal(refuse.in_reply_to, bounced[0].id, 'refuse threads back to the original');
  assert.ok(!lines.some((l) => l.kind === 'message' && l.id === bounced[0].id),
    'a fully-bounced message must not be logged as routed');
});

test('send() to a known agent still routes and logs a message line', () => {
  const { hive, root } = makeHive();
  scaffoldAgent(root, 'a1'); scaffoldAgent(root, 'b1');
  writeRegistry(root, ['a1', 'b1']);
  const msg = hive.send({ to: 'b1', act: 'inform', subject: 'hello' }, 'a1');
  assert.equal(inboxFiles(root, 'b1').length, 1);
  assert.ok(logLines(root).some((l) => l.kind === 'message' && l.id === msg.id));
});

// ── 5. logTail tail-read ─────────────────────────────────────────────────────

test('logTail returns the exact last n lines from a file larger than the tail window', () => {
  const { hive, root } = makeHive();
  const pad = 'x'.repeat(180); // ~200B/line × 1000 ≈ 200KB ≫ 64KB window
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(JSON.stringify({ ts: i, i, pad }));
  fs.writeFileSync(path.join(root, 'log.jsonl'), lines.join('\n') + '\n');
  const tail = hive.logTail(50);
  assert.equal(tail.length, 50);
  assert.equal(tail[0].i, 950);
  assert.equal(tail[49].i, 999);
  assert.ok(!tail.some((e) => e.raw), 'no partial-line parse debris');
});

test('logTail on a small file still returns everything asked for', () => {
  const { hive, root } = makeHive();
  fs.writeFileSync(path.join(root, 'log.jsonl'), [1, 2, 3].map((i) => JSON.stringify({ i })).join('\n') + '\n');
  const tail = hive.logTail(10);
  assert.deepEqual(tail.map((e) => e.i), [1, 2, 3]);
});

// ── 6. writeTasks read-modify-write merge ────────────────────────────────────

const card = (id, over = {}) => ({
  id, title: id, status: 'todo', dependsOn: [], priority: 1,
  createdAt: new Date().toISOString(), ...over
});

test('a card god just added survives a stale whole-array write', () => {
  const { hive, root } = makeHive();
  const godCard = card('god-new'); // fresh createdAt → inside TASK_FRESH_MS
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [godCard] }));
  hive.writeTasks([card('mine')]); // stale renderer array that never saw god-new
  const after = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(after.map((t) => t.id).sort(), ['god-new', 'mine']);
});

test('an UNSERVED old disk card is kept (caller could not have meant to delete it)', () => {
  const { hive, root } = makeHive();
  const old = card('never-served', { createdAt: new Date(Date.now() - 60_000).toISOString() });
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [old] }));
  hive.writeTasks([]); // no tasks() read happened in this process
  const after = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(after.map((t) => t.id), ['never-served']);
});

test('the kanban dismiss flow still deletes: served + old card omitted → dropped', () => {
  const { hive, root } = makeHive();
  const doomed = card('doomed', { createdAt: new Date(Date.now() - 60_000).toISOString() });
  const keeper = card('keeper', { createdAt: new Date(Date.now() - 60_000).toISOString() });
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [doomed, keeper] }));
  hive.tasks(); // the dismiss flow re-reads the raw ledger right before writing
  hive.writeTasks([keeper]);
  const after = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(after.map((t) => t.id), ['keeper']);
});

test('a card the caller carries wins by id; no tmp residue in the hive root', () => {
  const { hive, root } = makeHive();
  const w = card('w', { createdAt: new Date(Date.now() - 60_000).toISOString() });
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [w] }));
  hive.writeTasks([{ ...w, status: 'done', result: 'shipped' }]);
  const after = JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks;
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'done');
  assert.equal(after[0].result, 'shipped');
  assert.ok(!fs.readdirSync(root).some((f) => f.includes('.tmp-')), 'atomic writes must clean up');
});

// ── 7. commit queue (async, coalesced) + flushSync + untrack migration ───────

(async () => {
  await testAsync('commit() coalesces; flushSync lands ONE commit synchronously', async () => {
    const { hive, root } = makeHive();
    hive.ensureHive(); // git init + queues 'hive: init'
    fs.writeFileSync(path.join(root, 'extra.txt'), 'x');
    hive.commit('hive: a');
    hive.commit('hive: b');
    // Nothing committed yet — the queue is debounced, not synchronous.
    assert.throws(() => execSync('git log --format=%s', { cwd: root, stdio: 'pipe' }));
    hive.flushSync();
    const log = execSync('git log --format=%s', { cwd: root, encoding: 'utf8' }).trim().split('\n');
    assert.equal(log.length, 1);
    assert.equal(log[0], 'hive: init (+2 coalesced)');
    const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
    assert.equal(status, '', `working tree must be clean, got: ${status}`);
  });

  await testAsync('a queued commit lands asynchronously after the debounce window', async () => {
    const { hive, root } = makeHive();
    hive.ensureHive();
    hive.flushSync(); // land init
    fs.writeFileSync(path.join(root, 'later.txt'), 'y');
    hive.commit('hive: later');
    await sleep(3000); // > COMMIT_DEBOUNCE_MS + git runtime
    const log = execSync('git log --format=%s', { cwd: root, encoding: 'utf8' }).trim().split('\n');
    assert.equal(log[0], 'hive: later');
    assert.equal(log.length, 2);
  });

  await testAsync('ensureHive gitignores + untracks the high-churn files on an existing hive', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-t-'));
    const root = path.join(home, 'hive');
    fs.mkdirSync(path.join(root, 'backups', 'stamp1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cost-ledger.jsonl'), '{"usd":1}\n');
    fs.writeFileSync(path.join(root, 'log.jsonl'), '{"ts":1}\n');
    fs.writeFileSync(path.join(root, 'backups', 'stamp1', 'b.md'), 'backup');
    execSync(`${GIT} init -q && ${GIT} add -A && ${GIT} commit -q -m seed`, { cwd: root });
    assert.match(execSync('git ls-files', { cwd: root, encoding: 'utf8' }), /cost-ledger\.jsonl/);
    const hive = new HiveManager(() => home);
    hive.ensureHive();
    await sleep(1500); // async `git rm --cached` migration
    hive.flushSync();
    const tracked = execSync('git ls-files', { cwd: root, encoding: 'utf8' });
    assert.ok(!/cost-ledger\.jsonl/.test(tracked), 'ledger must be untracked');
    assert.ok(!/log\.jsonl/.test(tracked), 'log must be untracked');
    assert.ok(!/backups\//.test(tracked), 'backups must be untracked');
    assert.ok(fs.existsSync(path.join(root, 'cost-ledger.jsonl')), '--cached keeps the working file');
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const want of ['cost-ledger.jsonl', 'log.jsonl', 'backups/', 'fleet.json', '*.tmp-*']) {
      assert.ok(ignore.includes(want), `.gitignore must cover ${want}`);
    }
  });

  process.exit(failures ? 1 : 0);
})();
