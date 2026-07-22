'use strict';
/**
 * Closing-time idle-and-clean fast-track tests (issue #59). Self-contained, no
 * framework — run with `node test/closing-time.test.cjs`. closingTime.ts has
 * only type-only imports, so it transpiles standalone.
 *
 * A worker that has been quiet ≥2min with an empty inbox is dropped from the
 * ACK roster (no wake-up turn, no shutdown hold); everyone else keeps the old
 * behavior — as does a controller constructed WITHOUT the idle probe.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src', 'main', 'closingTime.ts');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'closing-'));
const js = ts.transpileModule(fs.readFileSync(SRC, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
}).outputText;
fs.writeFileSync(path.join(out, 'closingTime.js'), js, 'utf8');
const { ClosingTimeController } = require(path.join(out, 'closingTime.js'));

function makeFloor({ idle = {}, backlog = {}, withProbe = true } = {}) {
  const sent = [];
  const steers = [];
  const hive = {
    registry: () => ({
      godId: 'god',
      agents: {
        god: { name: 'Michael', isGod: true },
        w1: { name: 'Jim' },
        w2: { name: 'Pam' },
        w3: { name: 'Kevin' }
      }
    }),
    send: (msg) => { sent.push(msg); },
    inboxBacklog: (id) => backlog[id] ?? 0
  };
  const control = { steer: (id, note) => steers.push({ id, note }), clearSteers: () => {} };
  let concluded = false;
  const ctl = new ClosingTimeController(
    hive,
    () => ['god', 'w1', 'w2', 'w3'],
    () => null,
    () => { concluded = true; },
    control,
    withProbe ? (id) => idle[id] : undefined
  );
  return { ctl, sent, steers, isConcluded: () => concluded };
}

let failures = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

test('idle+clean workers are fast-tracked out of the ACK roster', () => {
  const { ctl, sent, steers } = makeFloor({ idle: { w1: 500_000, w2: 3_000, w3: 500_000 }, backlog: { w3: 2 } });
  assert.equal(ctl.start().ok, true);
  const brief = sent[0].body;
  // w1: idle + empty inbox → skipped. w2: recently active → waited.
  // w3: idle but has BACKLOG (unread mail = undone work) → waited.
  assert.match(brief, /Fast-tracked by the harness[^\n]*Jim \(w1\)/);
  assert.ok(!/Fast-tracked by the harness[^\n]*Kevin/.test(brief), 'backlogged w3 must not be fast-tracked');
  assert.match(brief, /Active workers: [^\n]*Pam \(w2\)/);
  assert.match(brief, /Active workers: [^\n]*Kevin \(w3\)/);
  assert.match(brief, /DIRECTLY[^\n]*NOT a broadcast/i);
  // Steers reach only the waited-on workers (+ god), never a fast-tracked one.
  const steered = steers.map((s) => s.id).sort();
  assert.deepEqual(steered, ['god', 'w2', 'w3']);
});

test('fast-tracked workers are not required for COMPLETE', () => {
  const { ctl, sent, isConcluded } = makeFloor({ idle: { w1: 500_000, w2: 500_000, w3: 500_000 } });
  ctl.start();
  assert.match(sent[0].body, /fast-tracked them all; do steps 3 and 4 immediately/);
  ctl.onRouted({ from: 'god', subject: 'CLOSING-TIME-COMPLETE', body: '' }, ['human']);
  // Complete accepted with zero pending ACKs (teardown runs after a grace timer).
  assert.equal(ctl.isActive(), true, 'holds active through the teardown grace');
  assert.equal(isConcluded(), false, 'grace timer still pending — but no rejection was sent');
  assert.ok(!sent.some((m) => /conclusion rejected/.test(m.subject)), 'no rejection for fast-tracked workers');
});

test('without the idle probe every live worker is waited on (old behavior)', () => {
  const { ctl, sent, steers } = makeFloor({ idle: { w1: 500_000 }, withProbe: false });
  ctl.start();
  const brief = sent[0].body;
  assert.match(brief, /BROADCAST/);
  assert.ok(!/Fast-tracked/.test(brief));
  assert.deepEqual(steers.map((s) => s.id).sort(), ['god', 'w1', 'w2', 'w3']);
});

test('a busy worker still gates COMPLETE (verify path intact)', () => {
  const { ctl, sent } = makeFloor({ idle: { w1: 500_000, w2: 1_000, w3: 500_000 } });
  ctl.start();
  ctl.onRouted({ from: 'god', subject: 'CLOSING-TIME-COMPLETE', body: '' }, ['human']);
  assert.ok(sent.some((m) => /conclusion rejected/.test(m.subject)), 'w2 has not acked — must reject');
  ctl.onRouted({ from: 'w2', subject: 'CLOSING-TIME-ACK', body: '' }, ['god']);
  ctl.onRouted({ from: 'god', subject: 'CLOSING-TIME-COMPLETE', body: '' }, ['human']);
  assert.equal(ctl.isActive(), true, 'accepted after the last active worker acked');
});

process.exit(failures ? 1 : 0);
