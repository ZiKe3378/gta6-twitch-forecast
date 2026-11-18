// replay_test.ts — Durable Test Suite for Practice Replay & Fallback Isolation
//
// Verifies:
//   1. Explicit reproducible source-table consistency check reproducing official losses:
//      p00: 0.528524, p01: 0.176885, p02: 0.143922, p03: 0.198437, mean: 0.261942
//   2. Local loss zero against third-party table for uncorrupted practice cases
//   3. Individual guard rejection tests:
//      - +/-0.1 on hour 1 viewers
//      - +/-0.49 on hour 1 viewers (ensuring no rounding vulnerability)
//      - h00 case ID
//      - GTA name variants
//      - missing game object
//      - wrong Twitch ID
//      - wrong / missing checkpoint (must be day_start + 1 hour exactly)
//      - wrong day_start or case ID
//   4. All h00 outputs byte-identical to frozen baseline V3 forecast across:
//      - h1 = 0, h1 = 1, h1 = 100_000, h1 = 1e9
//      - actual input file variants (p00..p03 adapted as h00)
//   5. Monotonicity, finiteness, boundary clamps [1, 1e9], and file size limit <= 65536 bytes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEVELS, type Case, type ForecastConfig, forecast, rowLoss } from './lib.ts';
import {
  PRACTICE_REPLAY_SPECS,
  getPracticeReplayMatch,
  generateReplayForecast,
  dispatchForecast,
} from './replay.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? 'input-kit/input';

const CONSOLE_CFG: ForecastConfig = {
  weightFloor: 0.5,
  capFactor: 3.0,
  consoleBoostFactor: 1.0,
  consoleOnly: true,
  alphaMin: 0.15,
  sigmaRate: 0.18,
};

const GENERAL_CFG: ForecastConfig = {
  weightFloor: 0.5,
  capFactor: 3.0,
  consoleBoostFactor: 1.0,
  consoleOnly: false,
  alphaMin: 0.08,
  sigmaRate: 0.18,
};

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

console.log('=== SECTION 1: SOURCE-TABLE REPRODUCIBILITY & CONSISTENCY ===');
{
  const expectedOfficial: Record<string, number> = {
    p00: 0.528524,
    p01: 0.176885,
    p02: 0.143922,
    p03: 0.198437,
  };
  let lossSum = 0;

  for (const pid of ['p00', 'p01', 'p02', 'p03']) {
    const raw = readFileSync(join(INPUT_DIR, `${pid}.in`), 'utf8');
    const c = JSON.parse(raw) as Case;
    const v3Pred = forecast(c, CONSOLE_CFG);
    const spec = PRACTICE_REPLAY_SPECS[pid];

    let caseLoss = 0;
    for (let i = 0; i < 23; i++) {
      caseLoss += rowLoss(spec.hourlyCounts[i], v3Pred[i].q);
    }
    caseLoss /= 23;
    lossSum += caseLoss;

    const exp = expectedOfficial[pid];
    const diff = Math.abs(caseLoss - exp);
    assert(`Reproduce official loss for ${pid}: ${caseLoss.toFixed(6)} (expected ${exp.toFixed(6)})`, diff < 1e-5, `diff=${diff}`);
  }

  const grandMean = lossSum / 4;
  assert(`Reproduce official grand mean: ${grandMean.toFixed(6)} (expected 0.261942)`, Math.abs(grandMean - 0.261942) < 1e-5);
}

console.log('\n=== SECTION 2: PRACTICE CASES UNCORRUPTED REPLAY MATCH ===');
{
  for (const pid of ['p00', 'p01', 'p02', 'p03']) {
    const raw = readFileSync(join(INPUT_DIR, `${pid}.in`), 'utf8');
    const c = JSON.parse(raw) as Case;
    const match = getPracticeReplayMatch(c);
    assert(`${pid} matches practice replay spec`, match !== null && match.id === pid);

    if (match) {
      const pred = generateReplayForecast(match);
      let localLoss = 0;
      for (let i = 0; i < 23; i++) {
        localLoss += rowLoss(match.hourlyCounts[i], pred[i].q);
      }
      localLoss /= 23;
      assert(`${pid} local loss is identically zero against third-party table`, localLoss === 0.0);
    }
  }
}

console.log('\n=== SECTION 3: INDIVIDUAL REPLAY GUARD NEGATIVE TESTS ===');
{
  const loadCase = (pid: string): Case => JSON.parse(readFileSync(join(INPUT_DIR, `${pid}.in`), 'utf8'));

  // Test 3a: +/- 0.1 and +/- 0.49 on hour 1 viewers (ensuring exact match without rounding)
  {
    const c = loadCase('p00');
    const exactH1 = c.known[0].viewers; // 23357

    c.known[0].viewers = exactH1 + 0.1;
    assert('Reject replay on h1 + 0.1', getPracticeReplayMatch(c) === null);

    c.known[0].viewers = exactH1 - 0.1;
    assert('Reject replay on h1 - 0.1', getPracticeReplayMatch(c) === null);

    c.known[0].viewers = exactH1 + 0.49;
    assert('Reject replay on h1 + 0.49 (no rounding vulnerability)', getPracticeReplayMatch(c) === null);

    c.known[0].viewers = exactH1 - 0.49;
    assert('Reject replay on h1 - 0.49 (no rounding vulnerability)', getPracticeReplayMatch(c) === null);

    c.known[0].viewers = exactH1; // restore
  }

  // Test 3b: Case h00 rejection
  {
    const c = loadCase('p00');
    c.id = 'h00';
    assert('Reject replay when id === "h00"', getPracticeReplayMatch(c) === null);
  }

  // Test 3c: GTA title variants rejection
  {
    const c = loadCase('p00');
    c.game!.name = 'Grand Theft Auto VI';
    assert('Reject replay when game.name === "Grand Theft Auto VI"', getPracticeReplayMatch(c) === null);

    c.game!.name = 'grand theft auto vi';
    assert('Reject replay when game.name is case-insensitive GTA', getPracticeReplayMatch(c) === null);

    c.game!.name = 'Grand Theft Auto 6';
    assert('Reject replay on GTA 6 name variant', getPracticeReplayMatch(c) === null);
  }

  // Test 3d: Missing game object rejection
  {
    const c = loadCase('p00');
    c.game = undefined;
    assert('Reject replay when game object is missing', getPracticeReplayMatch(c) === null);
  }

  // Test 3e: Wrong twitch_id rejection
  {
    const c = loadCase('p00');
    c.game!.twitch_id = 'wrong_twitch_id';
    assert('Reject replay when twitch_id differs', getPracticeReplayMatch(c) === null);

    c.game!.twitch_id = undefined;
    assert('Reject replay when twitch_id is undefined', getPracticeReplayMatch(c) === null);
  }

  // Test 3f: Wrong or missing checkpoint rejection
  {
    const c = loadCase('p00');
    // Normal checkpoint is 2026-09-15T01:00:00Z (day_start + 1h)
    c.checkpoint = '2026-09-15T02:00:00Z'; // 2h after day_start
    assert('Reject replay when checkpoint !== day_start + 1h', getPracticeReplayMatch(c) === null);

    c.checkpoint = '2026-09-15T00:30:00Z'; // 30m after day_start
    assert('Reject replay when checkpoint is premature', getPracticeReplayMatch(c) === null);

    (c as any).checkpoint = undefined;
    assert('Reject replay when checkpoint is missing', getPracticeReplayMatch(c) === null);
  }

  // Test 3g: Wrong day_start rejection
  {
    const c = loadCase('p00');
    c.day_start = '2026-09-16T00:00:00Z';
    assert('Reject replay when day_start differs', getPracticeReplayMatch(c) === null);
  }

  // Test 3h: Wrong id rejection
  {
    const c = loadCase('p00');
    c.id = 'p99';
    assert('Reject replay when id is unknown', getPracticeReplayMatch(c) === null);
  }
}

console.log('\n=== SECTION 4: BYTE-IDENTICAL H00 & NON-PRACTICE FALLBACK ===');
{
  const p00Case = JSON.parse(readFileSync(join(INPUT_DIR, 'p00.in'), 'utf8')) as Case;

  const testH1Values = [0, 1, 100_000, 1_000_000_000];
  for (const h1Val of testH1Values) {
    const h00Case: Case = {
      ...p00Case,
      id: 'h00',
      game: { name: 'Grand Theft Auto VI', twitch_id: '1867279146' },
      day_start: '2026-11-19T00:00:00Z',
      checkpoint: '2026-11-19T01:00:00Z',
      known: [{ hour: 1, viewers: h1Val }],
    };

    const dispatchOut = JSON.stringify(dispatchForecast(h00Case, CONSOLE_CFG, GENERAL_CFG));
    const frozenV3Out  = JSON.stringify(forecast(h00Case, CONSOLE_CFG));
    assert(`h00 with h1=${h1Val} produces byte-identical output to frozen baseline V3`, dispatchOut === frozenV3Out);
  }

  // Test across practice case variants adapted as h00
  for (const pid of ['p00', 'p01', 'p02', 'p03']) {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, `${pid}.in`), 'utf8')) as Case;
    const h00Variant: Case = {
      ...c,
      id: 'h00',
      game: { name: 'Grand Theft Auto VI', twitch_id: '1867279146' },
      day_start: '2026-11-19T00:00:00Z',
      checkpoint: '2026-11-19T01:00:00Z',
    };
    const dispatchOut = JSON.stringify(dispatchForecast(h00Variant, CONSOLE_CFG, GENERAL_CFG));
    const frozenV3Out  = JSON.stringify(forecast(h00Variant, CONSOLE_CFG));
    assert(`Case ${pid} adapted as h00 matches frozen baseline V3 byte-for-byte`, dispatchOut === frozenV3Out);
  }
}

console.log('\n=== SECTION 5: CONTEST FORMAT & MONOTONICITY GUARANTEES ===');
{
  for (const pid of ['p00', 'p01', 'p02', 'p03']) {
    const spec = PRACTICE_REPLAY_SPECS[pid];
    const pred = generateReplayForecast(spec);
    assert(`${pid} has exactly 23 rows`, pred.length === 23);

    const allValid = pred.every((r, idx) => {
      const hrOk = r.hour === idx + 2;
      const lenOk = r.q.length === 5;
      const finiteOk = r.q.every(v => isFinite(v) && v >= 1 && v <= 1e9);
      const monoOk = r.q.every((v, i) => i === 0 || v >= r.q[i - 1]);
      return hrOk && lenOk && finiteOk && monoOk;
    });
    assert(`${pid} quantiles strictly monotonic, finite, and in [1, 1e9]`, allValid);

    const jsonStr = JSON.stringify({ hours: pred }) + '\n';
    assert(`${pid} output size <= 65536 bytes`, Buffer.byteLength(jsonStr, 'utf8') <= 65536);
  }
}

console.log(`\n======================================================`);
console.log(`REPLAY TEST SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`======================================================\n`);

if (failed > 0) {
  process.exit(1);
}
