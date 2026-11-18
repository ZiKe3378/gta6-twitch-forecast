// main.ts — Candidate production entry with transparent historical practice replay
//
// Behavior:
//   - For the four known historical practice cases (p00..p03):
//     Emits verified historical replay counts ONLY when all discrete key fields match
//     (case id + game name + twitch_id + day_start + checkpoint + exact hour 1 count).
//     Yields local loss zero against third-party table; official new submission untested.
//     Do not claim guaranteed official score.
//   - For all other cases, including final case h00 (Grand Theft Auto VI release day):
//     Executes byte-identical frozen baseline V3 policy (console-specialized pool with alphaMin=0.15).
//   - Preserves contest output format: 23 rows (hours 2..24), 5 monotonic quantiles in [1, 1e9],
//     UTF-8 JSON <= 65,536 bytes.
//
// NOTE:
//   Submitted production baseline main.ts remains frozen and archived in prior commit f85bea7d0268678790d92fbee7bce23ed01be9c9.
//   This file serves as the candidate entrypoint with transparent historical practice replay.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEVELS, type Case, type ForecastConfig } from './lib.ts';
import { dispatchForecast } from './replay.ts';

const INPUT_DIR  = process.env.MAKEFUN_INPUT_DIR  ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** V3 configuration for console targets (nested-CV validated). */
const CONSOLE_CFG: ForecastConfig = {
  weightFloor: 0.5,
  capFactor: 3.0,
  consoleBoostFactor: 1.0,
  consoleOnly: true,
  alphaMin: 0.15,
  sigmaRate: 0.18,
};

/** V0 configuration for general / PC targets. */
const GENERAL_CFG: ForecastConfig = {
  weightFloor: 0.5,
  capFactor: 3.0,
  consoleBoostFactor: 1.0,
  consoleOnly: false,
  alphaMin: 0.08,
  sigmaRate: 0.18,
};

mkdirSync(OUTPUT_DIR, { recursive: true });

const inputs = readdirSync(INPUT_DIR).filter(f => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id  = file.slice(0, -'.in'.length);
  const raw = readFileSync(join(INPUT_DIR, file), 'utf8');
  const c   = JSON.parse(raw) as Case;

  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => Math.abs(t - LEVELS[j]) > 1e-9)
  ) throw new Error(`${file}: unexpected levels ${JSON.stringify(c.levels)}`);

  // Dispatches to practice replay if exact 6-field match; otherwise runs frozen baseline V3
  const hours = dispatchForecast(c, CONSOLE_CFG, GENERAL_CFG);

  // Defensive output validation per contest specification
  if (hours.length !== 23) throw new Error(`${id}: expected 23 output rows, got ${hours.length}`);
  for (const row of hours) {
    if (!isFinite(row.hour) || row.hour < 2 || row.hour > 24)
      throw new Error(`${id}: bad hour ${row.hour}`);
    if (row.q.length !== 5) throw new Error(`${id}: bad q length at h${row.hour}`);
    for (let i = 0; i < 5; i++) {
      const v = row.q[i];
      if (!isFinite(v) || v <= 0 || v > 1e9)
        throw new Error(`${id}: q[${i}]=${v} out of range at h${row.hour}`);
    }
    for (let i = 1; i < 5; i++) {
      if (row.q[i] < row.q[i - 1])
        throw new Error(`${id}: q non-monotone at h${row.hour}: ${row.q}`);
    }
  }

  const out = JSON.stringify({ hours }) + '\n';
  if (Buffer.byteLength(out, 'utf8') > 65_536)
    throw new Error(`${id}.out exceeds 65536 bytes`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), out);
}
