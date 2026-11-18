// validate.ts — Round 4: Nested launch-level model selection, Ghost franchise holdout, and robustness suite

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LEVELS, Z_NORMAL,
  type Comparable, type Case, type ForecastConfig,
  classifyGame, type GameTier,
  dedupeComparables, releaseDayMap,
  forecast, baselineForecast,
  rowLoss, pinball,
  clamp, DEFAULT_CONFIG,
} from './lib.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? 'input-kit/input';

// ===========================================================================
// SECTION 1: Edge-case & Robustness unit tests
// ===========================================================================
{
  console.log('\n=== EDGE CASE & ROBUSTNESS TESTS ===\n');
  let passed = 0; let failed = 0;
  const assert = (label: string, cond: boolean, detail = '') => {
    if (cond) { console.log(`  ✓ ${label}`); passed++; }
    else       { console.log(`  ✗ FAIL: ${label}${detail ? ' — ' + detail : ''}`); failed++; }
  };

  const makeCase = (h1: number, comps: Comparable[] = []): Case => ({
    id: 'test', levels: [...LEVELS],
    known:    [{ hour: 1, viewers: h1 }],
    forecast: Array.from({ length: 23 }, (_, i) => ({ hour: i + 2 })),
    comparables: comps,
  });

  { const rows = forecast(makeCase(0));
    assert('h1=0: all q in [1,1e9]', rows.every(r=>r.q.every(v=>isFinite(v)&&v>=1&&v<=1e9)));
    assert('h1=0: non-decreasing', rows.every(r=>r.q.every((v,i)=>i===0||v>=r.q[i-1]))); }

  { const rows = forecast(makeCase(1e9));
    assert('h1=1e9: all q ≤ 1e9', rows.every(r=>r.q.every(v=>isFinite(v)&&v>=1&&v<=1e9)), `h24 q95=${rows[22].q[4]}`);
    assert('h1=1e9: non-decreasing', rows.every(r=>r.q.every((v,i)=>i===0||v>=r.q[i-1]))); }

  { const rows = forecast(makeCase(100_000, []));
    assert('empty pool: all q valid', rows.every(r=>r.q.every(v=>isFinite(v)&&v>=1&&v<=1e9)));
    assert('empty pool: non-decreasing', rows.every(r=>r.q.every((v,i)=>i===0||v>=r.q[i-1]))); }

  { const sp: Comparable = { name:'Sp',day_start:'2020-01-01T00:00:00Z',unlock:'',platforms:'PS5',
      hourly:[{from:'2020-01-01T00:00:00Z',viewers:50000},{from:'2020-01-01T01:00:00Z',viewers:45000}] };
    const rows = forecast(makeCase(50_000,[sp]));
    assert('sparse pool (<20h): valid fallback', rows.every(r=>r.q.every(v=>isFinite(v)&&v>=1&&v<=1e9))); }

  { const ds2: Comparable = { name:'Death Stranding 2: On the Beach',day_start:'2025-06-26T00:00:00Z',
      platforms:'PS5',unlock:'Early access (Digital Deluxe) 2025-06-23 (data peak 141k on 06-23); standard unverified.',hourly:[] };
    assert('DS2: console_ea', classifyGame(ds2)==='console_ea', `got:${classifyGame(ds2)}`); }

  { const sf: Comparable = { name:'Starfield',day_start:'2023-09-06T00:00:00Z',
      platforms:'Xbox Series, PC',unlock:'Early access (Premium) began 2023-09-01 (data shows 2023-08-31 UTC 532k); standard unlock unverified.',hourly:[] };
    assert('Starfield: pc_ea', classifyGame(sf)==='pc_ea', `got:${classifyGame(sf)}`); }

  { const bf6: Comparable = { name:'BF6',day_start:'2025-10-10T00:00:00Z',platforms:'PC, PS5, Xbox Series',
      unlock:'Simultaneous across platforms, no early access; unlock unverified.',hourly:[] };
    assert('BF6 no-EA: pc', classifyGame(bf6)==='pc', `got:${classifyGame(bf6)}`); }

  { const g: Comparable = {name:'D',day_start:'2020-01-01T00:00:00Z',unlock:'',platforms:'PS5',hourly:[]};
    assert('dedupeComparables: deduplication works', dedupeComparables([g,g,{...g,platforms:'X'}]).length===1); }

  // Robustness test 1: Unsorted and duplicate hourly rows in comparable
  {
    const orig: Comparable = {
      name: 'UnsortedGame', day_start: '2025-01-01T00:00:00Z', unlock: 'Midnight local', platforms: 'PS5',
      hourly: [
        { from: '2025-01-01T03:00:00Z', viewers: 3000 },
        { from: '2025-01-01T01:00:00Z', viewers: 1000 },
        { from: '2025-01-01T00:00:00Z', viewers: 5000 },
        { from: '2025-01-01T01:00:00Z', viewers: 9999 }, // duplicate h2
        { from: '2025-01-01T02:00:00Z', viewers: 2000 },
      ]
    };
    const map = releaseDayMap(orig);
    assert('releaseDayMap: handles unsorted & duplicates deterministically',
      map.get(1) === 5000 && map.get(2) === 1000 && map.get(3) === 2000 && map.get(4) === 3000);
  }

  // Robustness test 2: Irrelevant post-checkpoint history in target case does NOT alter forecast
  {
    const c0 = JSON.parse(readFileSync(join(INPUT_DIR,'p00.in'),'utf8')) as Case;
    const r1 = JSON.stringify(forecast(c0, {consoleBoostFactor: 1.4}));
    const c0Corrupted = JSON.parse(JSON.stringify(c0)) as Case & { history?: any[]; history_hourly?: any[] };
    // Inject huge post-checkpoint readings into history
    c0Corrupted.history = [
      { at: '2026-09-15T12:00:00Z', viewers: 99999999, channels: 500 }
    ];
    c0Corrupted.history_hourly = [
      { from: '2026-09-15T12:00:00Z', viewers: 99999999, channels: 500, reads: 60 }
    ];
    const r2 = JSON.stringify(forecast(c0Corrupted, {consoleBoostFactor: 1.4}));
    assert('Irrelevant post-checkpoint history does not leak or affect forecast', r1 === r2);
  }

  // Robustness test 3: 42-comparable final-like input (simulate full final case pool)
  {
    const c0 = JSON.parse(readFileSync(join(INPUT_DIR,'p00.in'),'utf8')) as Case;
    // Duplicate comparables to test scaling up to 42+
    const c42: Case = {
      ...c0,
      comparables: [...c0.comparables, ...c0.comparables.slice(0, 10).map(x => ({ ...x, name: x.name + ' [Copy]' }))]
    };
    const t0 = Date.now();
    const rows42 = forecast(c42, {consoleBoostFactor: 1.4});
    const elapsed = Date.now() - t0;
    assert('Final-like 42+ comparables pool evaluates well under time cap',
      rows42.length === 23 && elapsed < 1000, `took ${elapsed}ms`);
  }

  console.log(`\nEdge & robustness tests: ${passed} passed, ${failed} failed\n`);
  if (failed>0) process.exitCode=1;
}

// ===========================================================================
// SECTION 2: Nested Launch-Level Model Selection (V0 vs V3)
// ===========================================================================
// Predeclared candidate policies:
//   V0: Console boost 1.4, FLOOR 0.5, alphaMin 0.08, full pool (reference)
//   V3: Console-only pool for console targets, alphaMin 0.15; PC targets strictly V0 (no alphaMin leakage)

const CFG_V0_CONSOLE: ForecastConfig = { weightFloor:0.5, capFactor:3.0, consoleBoostFactor:1.4, consoleOnly:false, alphaMin:0.08, sigmaRate:0.18 };
const CFG_V3_CONSOLE: ForecastConfig = { weightFloor:0.5, capFactor:3.0, consoleBoostFactor:1.0, consoleOnly:true,  alphaMin:0.15, sigmaRate:0.18 };
const CFG_PC_NEUTRAL: ForecastConfig = { weightFloor:0.5, capFactor:3.0, consoleBoostFactor:1.0, consoleOnly:false, alphaMin:0.08, sigmaRate:0.18 };

const caseData = JSON.parse(readFileSync(join(INPUT_DIR,'p00.in'),'utf8')) as {comparables:Comparable[]};
const allComps = dedupeComparables(caseData.comparables);

// Clean launches
interface EvalTarget {
  name: string;
  tier: GameTier;
  p1: number;
  dayStart: string;
  actuals: Map<number, number>;
}

const targets: EvalTarget[] = [];
for (const g of allComps) {
  const tier = classifyGame(g);
  if (tier==='skip'||tier==='weak'||tier==='console_ea'||tier==='pc_ea') continue;
  const hrs = releaseDayMap(g);
  if (hrs.size < 20) continue;
  const p1 = hrs.get(1) ?? 0;
  if (p1 < 1000) continue;
  targets.push({ name: g.name, tier, p1, dayStart: g.day_start, actuals: hrs });
}

const consoleTargets = targets.filter(t => t.tier === 'console');
const pcTargets      = targets.filter(t => t.tier === 'pc');

console.log(`Universal evaluation pool: ${targets.length} launches (${consoleTargets.length} console, ${pcTargets.length} PC)\n`);

// Helper to evaluate one target given a training pool and config
function scoreTarget(t: EvalTarget, trainPool: Comparable[], cfg: ForecastConfig) {
  const synthCase: Case = {
    id: t.name, levels: [...LEVELS],
    known: [{ hour: 1, viewers: t.p1 }],
    forecast: Array.from({ length: 23 }, (_, i) => ({ hour: i + 2 })),
    comparables: trainPool,
  };
  const pred = forecast(synthCase, cfg);
  let lossSum = 0;
  let scored = 0;
  const perHourLnErr: number[] = [];
  const hitsPerLevel = new Array<number>(5).fill(0);

  for (let i = 0; i < 23; i++) {
    const h = i + 2;
    const y = t.actuals.get(h);
    if (y === undefined || !isFinite(y) || y < 1) continue;
    lossSum += rowLoss(y, pred[i].q);
    perHourLnErr.push(Math.abs(Math.log(Math.max(1, y)) - Math.log(Math.max(1, pred[i].q[2]))));
    for (let li = 0; li < 5; li++) {
      if (y <= pred[i].q[li]) hitsPerLevel[li]++;
    }
    scored++;
  }
  return {
    meanLoss: lossSum / scored,
    scored,
    perHourLnErr,
    covLevels: hitsPerLevel.map(h => h / scored),
    pred,
  };
}

// ---------------------------------------------------------------------------
// Genuinely Nested Launch-Level Selection for Console Launches
// ---------------------------------------------------------------------------
console.log('=== NESTED LAUNCH-LEVEL MODEL SELECTION (CONSOLE SUBGROUP) ===');
console.log('Outer LOO: 1 held-out console launch.');
console.log('Inner LOO: Model choice (V0 vs V3) decided strictly on training console games.\n');

interface NestedConsoleResult {
  name: string;
  p1: number;
  chosenModel: 'V0' | 'V3';
  innerV0Loss: number;
  innerV3Loss: number;
  outerLoss: number;
  v0OuterLoss: number;
  v3OuterLoss: number;
  baseLoss: number;
  covLevels: number[];
}

const nestedConsoleResults: NestedConsoleResult[] = [];

for (let outerIdx = 0; outerIdx < consoleTargets.length; outerIdx++) {
  const outerTarget = consoleTargets[outerIdx];
  const outerExcludeKey = `${outerTarget.name}|||${outerTarget.dayStart}`;

  // Pool available for training outer model: all games EXCEPT outerTarget
  const outerTrainPool = allComps.filter(g => `${g.name}|||${g.day_start}` !== outerExcludeKey);
  if (outerTrainPool.some(g => g.name === outerTarget.name && g.day_start === outerTarget.dayStart)) {
    throw new Error(`CRITICAL LEAKAGE: outerTarget ${outerTarget.name} present in outerTrainPool!`);
  }
  const innerConsoleTargets = consoleTargets.filter((_, i) => i !== outerIdx);

  // Inner LOO across the 6 remaining console targets
  let innerV0Sum = 0;
  let innerV3Sum = 0;

  for (let innerIdx = 0; innerIdx < innerConsoleTargets.length; innerIdx++) {
    const innerTarget = innerConsoleTargets[innerIdx];
    const innerExcludeKey = `${innerTarget.name}|||${innerTarget.dayStart}`;
    // Pool for inner training: exclude both outerTarget and innerTarget
    const innerTrainPool = outerTrainPool.filter(g => `${g.name}|||${g.day_start}` !== innerExcludeKey);
    if (innerTrainPool.some(g => (g.name === outerTarget.name && g.day_start === outerTarget.dayStart) ||
                                 (g.name === innerTarget.name && g.day_start === innerTarget.dayStart))) {
      throw new Error(`CRITICAL LEAKAGE: held-out target present in innerTrainPool!`);
    }

    const resV0 = scoreTarget(innerTarget, innerTrainPool, CFG_V0_CONSOLE);
    const resV3 = scoreTarget(innerTarget, innerTrainPool, CFG_V3_CONSOLE);
    innerV0Sum += resV0.meanLoss;
    innerV3Sum += resV3.meanLoss;
  }

  const innerV0Mean = innerV0Sum / innerConsoleTargets.length;
  const innerV3Mean = innerV3Sum / innerConsoleTargets.length;
  // Decision rule: pick model with lower inner console pinball loss
  const chosenModel: 'V0' | 'V3' = innerV3Mean < innerV0Mean ? 'V3' : 'V0';
  const chosenCfg = chosenModel === 'V3' ? CFG_V3_CONSOLE : CFG_V0_CONSOLE;

  // Outer evaluation of chosen model on the held-out outerTarget
  const outerChosenRes = scoreTarget(outerTarget, outerTrainPool, chosenCfg);
  const outerV0Res     = scoreTarget(outerTarget, outerTrainPool, CFG_V0_CONSOLE);
  const outerV3Res     = scoreTarget(outerTarget, outerTrainPool, CFG_V3_CONSOLE);

  // Baseline
  const basePred = baselineForecast(outerTarget.p1);
  let baseSum = 0;
  for (let i = 0; i < 23; i++) {
    const y = outerTarget.actuals.get(i + 2);
    if (y) baseSum += rowLoss(y, basePred[i].q);
  }
  const baseLoss = baseSum / 23;

  nestedConsoleResults.push({
    name: outerTarget.name,
    p1: outerTarget.p1,
    chosenModel,
    innerV0Loss: innerV0Mean,
    innerV3Loss: innerV3Mean,
    outerLoss: outerChosenRes.meanLoss,
    v0OuterLoss: outerV0Res.meanLoss,
    v3OuterLoss: outerV3Res.meanLoss,
    baseLoss,
    covLevels: outerChosenRes.covLevels,
  });
}

console.log('Launch                        | Inner V0  | Inner V3  | Choice | Outer Loss | V0 Loss   | Base Loss | Δ vs Base');
console.log('------------------------------+-----------+-----------+--------+------------+-----------+-----------+-----------');
for (const r of nestedConsoleResults) {
  const dBase = r.outerLoss - r.baseLoss;
  console.log(
    `${r.name.slice(0,29).padEnd(29)} | ` +
    `${r.innerV0Loss.toFixed(4)}    | ${r.innerV3Loss.toFixed(4)}    | ` +
    `  ${r.chosenModel}   | ` +
    `${r.outerLoss.toFixed(4)}     | ${r.v0OuterLoss.toFixed(4)}    | ${r.baseLoss.toFixed(4)}    | ` +
    `${dBase >= 0 ? '+' : ''}${dBase.toFixed(4)}`
  );
}

const mean = (arr: number[]) => arr.reduce((s, x) => s + x, 0) / arr.length;
const nestedConsoleLoss = mean(nestedConsoleResults.map(r => r.outerLoss));
const v0ConsoleLoss     = mean(nestedConsoleResults.map(r => r.v0OuterLoss));
const v3ConsoleLoss     = mean(nestedConsoleResults.map(r => r.v3OuterLoss));
const baseConsoleLoss   = mean(nestedConsoleResults.map(r => r.baseLoss));
const nestedCovMean     = LEVELS.map((_, li) => mean(nestedConsoleResults.map(r => r.covLevels[li])));
const v0CovMean         = [0.02, 0.13, 0.42, 0.98, 1.00]; // from R3 table

console.log('\n--- Console Aggregate Comparison ---');
console.log(`Nested Model Outer Loss : ${nestedConsoleLoss.toFixed(6)}`);
console.log(`Frozen V0 Outer Loss    : ${v0ConsoleLoss.toFixed(6)}`);
console.log(`Frozen V3 Outer Loss    : ${v3ConsoleLoss.toFixed(6)}`);
console.log(`Baseline Outer Loss     : ${baseConsoleLoss.toFixed(6)}`);
console.log(`Nested Cov [5%,25%,50%,75%,95%]: [${nestedCovMean.map(c => (c*100).toFixed(0)+'%').join(' ')}]`);

// Baseline metrics on the EXACT same 7 console targets
const basePerLaunchMLE: number[] = [];
const baseHitsPerLevel = new Array<number>(5).fill(0);
let baseTotalHours = 0;
for (const target of consoleTargets) {
  const p1 = target.p1;
  const pred = baselineForecast(p1);
  const launchLnErrs: number[] = [];
  for (let i = 0; i < 23; i++) {
    const y = target.actuals.get(i + 2);
    if (!y) continue;
    launchLnErrs.push(Math.abs(Math.log(y) - Math.log(pred[i].q[2])));
    for (let li = 0; li < 5; li++) {
      if (y <= pred[i].q[li]) baseHitsPerLevel[li]++;
    }
    baseTotalHours++;
  }
  basePerLaunchMLE.push(launchLnErrs.reduce((a, b) => a + b, 0) / launchLnErrs.length);
}
const grandBaseMLE = basePerLaunchMLE.reduce((a, b) => a + b, 0) / basePerLaunchMLE.length;
const baseTypMiss = 100 * (Math.exp(grandBaseMLE) - 1);
const baseCovMean = baseHitsPerLevel.map(h => (h / baseTotalHours * 100).toFixed(1) + '%');
console.log(`Baseline Typical Miss   : ${baseTypMiss.toFixed(1)}%`);
console.log(`Baseline Cov [5%,25%,50%,75%,95%]: [${baseCovMean.join(' ')}]`);

// Check choices distribution
const v3Choices = nestedConsoleResults.filter(r => r.chosenModel === 'V3').length;
console.log(`\nInner Selection choices: V3 chosen in ${v3Choices}/7 folds, V0 in ${7 - v3Choices}/7 folds.`);

// ===========================================================================
// SECTION 3: Franchise Stress: Sucker Punch / Ghost Franchise
// ===========================================================================
console.log('\n=== SECTION 3: SUCKER PUNCH / GHOST FRANCHISE STRESS ===');
console.log('Simultaneously hold out Ghost of Tsushima AND Ghost of Yōtei from all training.');
const isGhost = (g: Comparable) => /ghost of/i.test(g.name);
const ghostGames = allComps.filter(isGhost);
const nonGhostPool = allComps.filter(g => !isGhost(g));
console.log(`Held-out: ${ghostGames.map(g => g.name).join(', ')} (2 launches)`);
console.log(`Training pool size: ${nonGhostPool.length} comparables\n`);

for (const g of ghostGames) {
  const target = targets.find(t => t.name === g.name)!;
  const resV0 = scoreTarget(target, nonGhostPool, CFG_V0_CONSOLE);
  const resV3 = scoreTarget(target, nonGhostPool, CFG_V3_CONSOLE);
  const basePred = baselineForecast(target.p1);
  let baseSum = 0;
  for (let i = 0; i < 23; i++) {
    const y = target.actuals.get(i + 2);
    if (y) baseSum += rowLoss(y, basePred[i].q);
  }
  const baseMean = baseSum / 23;
  const dV0 = resV0.meanLoss - baseMean;
  const dV3 = resV3.meanLoss - baseMean;
  console.log(`  ${g.name.padEnd(25)}`);
  console.log(`    V0 (Reference): loss=${resV0.meanLoss.toFixed(4)} base=${baseMean.toFixed(4)} Δ=${dV0 >= 0 ? '+' : ''}${dV0.toFixed(4)} (${dV0 < 0 ? '✓ beats baseline' : '✗ loses'})`);
  console.log(`    V3 (Production): loss=${resV3.meanLoss.toFixed(4)} base=${baseMean.toFixed(4)} Δ=${dV3 >= 0 ? '+' : ''}${dV3.toFixed(4)} (${dV3 < 0 ? '✓ beats baseline' : '✗ loses'})`);
}

// ===========================================================================
// SECTION 3b: Temporal Stress: Year-Split (Train <= 2022, Test >= 2023)
// ===========================================================================
console.log('\n=== SECTION 3b: TEMPORAL STRESS: YEAR-SPLIT (TRAIN <= 2022, TEST >= 2023) ===');
console.log('Train pool: only <= 2022 games (6 games total, 2 console). Test: >= 2023 console games (5 games).\n');

const oldGames = allComps.filter(g => new Date(g.day_start).getFullYear() <= 2022);
const newConsoleGames = allComps.filter(g => new Date(g.day_start).getFullYear() >= 2023 && classifyGame(g) === 'console');

let ysSumV0 = 0, ysSumV3 = 0, ysSumBase = 0;
let ysCov95_V0 = 0, ysCov95_V3 = 0;
let ysTotalHours = 0;

for (const g of newConsoleGames) {
  const hrs = releaseDayMap(g);
  const p1 = hrs.get(1) ?? 0;
  const synthCase: Case = {
    id: g.name, levels: [...LEVELS],
    known: [{ hour: 1, viewers: p1 }],
    forecast: Array.from({ length: 23 }, (_, i) => ({ hour: i + 2 })),
    comparables: oldGames,
  };
  const resV0 = forecast(synthCase, CFG_V0_CONSOLE);
  const resV3 = forecast(synthCase, CFG_V3_CONSOLE);
  const resBase = baselineForecast(p1);

  let lV0 = 0, lV3 = 0, lBase = 0;
  for (let i = 0; i < 23; i++) {
    const y = hrs.get(i + 2);
    if (!y) continue;
    lV0 += rowLoss(y, resV0[i].q);
    lV3 += rowLoss(y, resV3[i].q);
    lBase += rowLoss(y, resBase[i].q);
    if (y <= resV0[i].q[4]) ysCov95_V0++;
    if (y <= resV3[i].q[4]) ysCov95_V3++;
    ysTotalHours++;
  }
  ysSumV0 += lV0 / 23; ysSumV3 += lV3 / 23; ysSumBase += lBase / 23;
  console.log(`  ${g.name.slice(0, 30).padEnd(30)} | V0: ${(lV0/23).toFixed(4)} | V3: ${(lV3/23).toFixed(4)} | Base: ${(lBase/23).toFixed(4)}`);
}

const ysMeanV0 = ysSumV0 / newConsoleGames.length;
const ysMeanV3 = ysSumV3 / newConsoleGames.length;
const ysMeanBase = ysSumBase / newConsoleGames.length;
const ysCovPctV0 = (ysCov95_V0 / ysTotalHours * 100).toFixed(1);
const ysCovPctV3 = (ysCov95_V3 / ysTotalHours * 100).toFixed(1);

console.log('\n--- Year-Split Console Summary ---');
console.log(`V0 (Reference) Mean Loss : ${ysMeanV0.toFixed(4)} (95th Cov: ${ysCovPctV0}%)`);
console.log(`V3 (Production) Mean Loss: ${ysMeanV3.toFixed(4)} (95th Cov: ${ysCovPctV3}%)`);
console.log(`Baseline Mean Loss       : ${ysMeanBase.toFixed(4)}`);

console.log('\n=== SECTION 4: INDEPENDENT PRACTICE CASE RUNS (NODE 22 SUBPROCESS) ===\n');
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const nodeBinary = process.execPath;
const practiceFiles = ['p00.in', 'p01.in', 'p02.in', 'p03.in'];

for (const file of practiceFiles) {
  const fullPath = join(INPUT_DIR, file);
  const raw = readFileSync(fullPath, 'utf8');
  const c = JSON.parse(raw) as Case;
  const caseId = file.slice(0, -'.in'.length);

  // Measure in-memory forecast time with exact production CONSOLE_CFG
  const memT0 = process.hrtime.bigint();
  const memRes = forecast(c, CFG_V3_CONSOLE);
  const memMs = Number(process.hrtime.bigint() - memT0) / 1e6;

  // Run exact main.ts as an isolated subprocess
  const tempInDir = mkdtempSync(join(tmpdir(), 'mf-in-'));
  const tempOutDir = mkdtempSync(join(tmpdir(), 'mf-out-'));
  try {
    // Copy the single case file into isolated input directory
    const tempInFile = join(tempInDir, file);
    writeFileSync(tempInFile, raw);

    // Run 1: Measure wall-clock time including Node process startup and file I/O (8s timeout)
    const procT0 = process.hrtime.bigint();
    execFileSync(nodeBinary, ['main.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, MAKEFUN_INPUT_DIR: tempInDir, MAKEFUN_OUTPUT_DIR: tempOutDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000,
    });
    const procMs1 = Number(process.hrtime.bigint() - procT0) / 1e6;

    const outFile = join(tempOutDir, `${caseId}.out`);
    const outBytes = readFileSync(outFile);
    const sha1 = createHash('sha256').update(outBytes).digest('hex');

    // Run 2: Test determinism (8s timeout)
    const procT2 = process.hrtime.bigint();
    execFileSync(nodeBinary, ['main.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, MAKEFUN_INPUT_DIR: tempInDir, MAKEFUN_OUTPUT_DIR: tempOutDir },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 8000,
    });
    const procMs2 = Number(process.hrtime.bigint() - procT2) / 1e6;
    const sha2 = createHash('sha256').update(readFileSync(outFile)).digest('hex');
    const isDet = sha1 === sha2;

    // Strict schema and boundary checks on saved output
    const parsed = JSON.parse(outBytes.toString('utf8'));
    const topKeys = Object.keys(parsed);
    const hasOnlyHoursKey = topKeys.length === 1 && topKeys[0] === 'hours';
    const rows = parsed.hours;
    const hoursSet = new Set<number>();
    const validRows = Array.isArray(rows) && rows.length === 23 &&
      rows.every((r: any, idx: number) => {
        hoursSet.add(r.hour);
        const rKeys = Object.keys(r);
        const hasExactRowKeys = rKeys.length === 2 && 'hour' in r && 'q' in r;
        return (
          hasExactRowKeys &&
          r.hour === idx + 2 &&
          Array.isArray(r.q) && r.q.length === 5 &&
          r.q.every((v: number) => isFinite(v) && v >= 1 && v <= 1e9) &&
          r.q.every((v: number, i: number) => i === 0 || v >= r.q[i - 1])
        );
      });
    const allHoursUnique = hoursSet.size === 23;
    const sizeOk = outBytes.byteLength <= 65536;

    const schemaPass = hasOnlyHoursKey && validRows && allHoursUnique && sizeOk;

    // Hard assert: must exit non-zero on failed schema, determinism or runtime check
    if (!isDet) throw new Error(`CRITICAL DETERMINISM FAILURE: ${file} produced differing SHA-256 hashes`);
    if (!schemaPass) throw new Error(`CRITICAL SCHEMA FAILURE: ${file} failed output format requirements`);
    if (procMs1 > 8000 || procMs2 > 8000) throw new Error(`CRITICAL RUNTIME FAILURE: ${file} exceeded 8000ms sandbox cap`);

    console.log(
      `  ${file}: ${c.game?.name?.padEnd(25)} | ` +
      `Process Wall: ${procMs1.toFixed(0)}ms / ${procMs2.toFixed(0)}ms | ` +
      `In-memory: ${memMs.toFixed(1)}ms | ` +
      `Size: ${outBytes.byteLength}B | ` +
      `Det: ✓ | Schema: ✓`
    );
  } finally {
    rmSync(tempInDir, { recursive: true, force: true });
    rmSync(tempOutDir, { recursive: true, force: true });
  }
}
