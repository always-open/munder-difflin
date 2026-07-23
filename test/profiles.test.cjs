'use strict';
/**
 * Agent Profiles (#105) tests. Self-contained, no test framework — run with
 * `node test/profiles.test.cjs` (mirrors test/breaker.test.cjs). Transpiles the
 * relevant TS with the bundled `typescript` compiler and requires the emitted
 * CJS, stubbing the runtime imports (electron + the shared modules) so the pure
 * helpers can be exercised in plain node.
 *
 * Focus:
 *   1. spawn-env merge precedence (main config.ts `mergeSpawnEnv`): the profile
 *      env is present AND the integration-broker token is NEVER clobbered — broker
 *      keys always win, disjoint keys union cleanly.
 *   2. profile CRUD reducers (main config.ts + the renderer store/config.ts mirror):
 *      add / replace-by-id / remove round-trip, immutably.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const Module = require('module');

/** Transpile a project TS file to CJS and require it, stubbing its runtime
 *  imports (electron + shared modules) so pure helpers load in plain node. */
function loadTs(relPath) {
  const SRC = path.join(__dirname, '..', relPath);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
  const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    }
  }).outputText;
  const file = path.join(out, 'mod.js');
  fs.writeFileSync(file, js, 'utf8');

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return { app: { getPath: () => os.tmpdir() } };
    if (request.endsWith('shared/agentProvider')) {
      return {
        autoModeFlagForProvider: () => '',
        inferAgentProvider: () => 'claude',
        providerPreset: () => ({}),
        isClaudeProvider: () => true,
        AGENT_PROVIDER_PRESETS: []
      };
    }
    if (request.endsWith('shared/mcpCatalog')) return { defaultMcpDefaults: () => ({}) };
    if (request.endsWith('shared/integrations')) return {};
    return origLoad.apply(this, arguments);
  };
  try {
    delete require.cache[file];
    return require(file);
  } finally {
    Module._load = origLoad;
  }
}

const main = loadTs('src/main/config.ts');
const rc = loadTs('src/renderer/src/store/config.ts');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

// ── 1) spawn-env merge precedence (mergeSpawnEnv) ────────────────────────────

test('mergeSpawnEnv includes the profile env', () => {
  const merged = main.mergeSpawnEnv({ CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' }, {});
  assert.equal(merged.CLAUDE_CONFIG_DIR, '/Users/me/.claude-work');
});

test('broker keys win — a profile can NEVER clobber the capability token', () => {
  // A hostile/careless profile tries to set the broker token; the broker's real
  // token must survive intact.
  const profileEnv = { MD_BROKER_TOKEN: 'attacker-supplied', MD_BROKER_URL: 'http://evil', FOO: 'bar' };
  const brokerEnv = { MD_BROKER_TOKEN: 'real-capability-token', MD_BROKER_URL: 'http://127.0.0.1:9' };
  const merged = main.mergeSpawnEnv(profileEnv, brokerEnv);
  assert.equal(merged.MD_BROKER_TOKEN, 'real-capability-token', 'broker token clobbered by profile');
  assert.equal(merged.MD_BROKER_URL, 'http://127.0.0.1:9', 'broker url clobbered by profile');
  assert.equal(merged.FOO, 'bar', 'disjoint profile key should survive');
});

test('mergeSpawnEnv unions disjoint keys (the common CLAUDE_CONFIG_DIR case)', () => {
  const merged = main.mergeSpawnEnv(
    { CLAUDE_CONFIG_DIR: '/p' },
    { MD_BROKER_TOKEN: 't', MD_BROKER_URL: 'u' }
  );
  assert.deepEqual(merged, { CLAUDE_CONFIG_DIR: '/p', MD_BROKER_TOKEN: 't', MD_BROKER_URL: 'u' });
});

test('mergeSpawnEnv tolerates undefined args', () => {
  assert.deepEqual(main.mergeSpawnEnv(undefined, undefined), {});
  assert.deepEqual(main.mergeSpawnEnv({ A: '1' }, undefined), { A: '1' });
  assert.deepEqual(main.mergeSpawnEnv(undefined, { B: '2' }), { B: '2' });
});

// ── 2) profile CRUD reducers (main + renderer mirror) ────────────────────────

function crudRoundTrip(mod, label) {
  test(`${label}: upsert appends a new profile`, () => {
    const next = mod.upsertProfile(undefined, { id: 'a', label: 'A' });
    assert.deepEqual(next, [{ id: 'a', label: 'A' }]);
  });

  test(`${label}: upsert replaces an existing profile by id (in place)`, () => {
    const start = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const next = mod.upsertProfile(start, { id: 'a', label: 'A2', env: { X: '1' } });
    assert.equal(next.length, 2);
    assert.deepEqual(next[0], { id: 'a', label: 'A2', env: { X: '1' } });
    assert.deepEqual(next[1], { id: 'b', label: 'B' });
    // immutability — the original list is untouched
    assert.deepEqual(start[0], { id: 'a', label: 'A' });
  });

  test(`${label}: remove drops the matching id`, () => {
    const start = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    const next = mod.removeProfile(start, 'a');
    assert.deepEqual(next, [{ id: 'b', label: 'B' }]);
    assert.equal(start.length, 2, 'original list must be untouched');
  });

  test(`${label}: remove of a missing id is a no-op`, () => {
    const start = [{ id: 'a', label: 'A' }];
    assert.deepEqual(mod.removeProfile(start, 'zzz'), [{ id: 'a', label: 'A' }]);
    assert.deepEqual(mod.removeProfile(undefined, 'zzz'), []);
  });

  test(`${label}: full add → edit → delete round-trip`, () => {
    let list = mod.upsertProfile(undefined, { id: 'work', label: 'Work', env: { CLAUDE_CONFIG_DIR: '/w' } });
    list = mod.upsertProfile(list, { id: 'personal', label: 'Personal' });
    assert.equal(list.length, 2);
    // edit the first
    list = mod.upsertProfile(list, { id: 'work', label: 'Work', env: { CLAUDE_CONFIG_DIR: '/w2' } });
    assert.equal(list.find((p) => p.id === 'work').env.CLAUDE_CONFIG_DIR, '/w2');
    // delete the second
    list = mod.removeProfile(list, 'personal');
    assert.deepEqual(list.map((p) => p.id), ['work']);
  });
}

crudRoundTrip(main, 'main config.ts');
crudRoundTrip(rc, 'renderer store/config.ts');

process.exit(failures ? 1 : 0);
