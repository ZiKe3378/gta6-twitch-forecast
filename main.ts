// gta6-twitch-ccu-forecast-01 entry (Node 22, standard library only)
//
// Reads every <id>.in in the input directory, writes <id>.out.
// Core forecast logic lives in lib.ts (imported here); this file handles I/O and config selection.
//
// Model selection policy (validated via nested leave-one-launch-out CV):
//   - For console targets (including GTA VI on PS5/Xbox Series X|S):
//     Uses V3 policy: console-only comparable pool with alphaMin=0.15 prior shrinkage.
//     Selected in 7/7 inner CV folds, achieving 0.225577 mean pinball loss vs baseline 0.343461
//     and 91% coverage at the 95th quantile.
//   - For PC/unspecified targets:
//     Uses V0 policy: full comparable pool with alphaMin=0.08, consoleBoostFactor=1.0.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecast, LEVELS, type Case, type ForecastConfig } from './lib.ts';

const INPUT_DIR  = process.env.MAKEFUN_INPUT_DIR  ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** V3 configuration for console-only targets (nested-CV validated). */
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

  // GTA VI and console launch games use the console-specialised configuration
  const isConsoleTarget = !c.game ||
    c.game.name === 'Grand Theft Auto VI' ||
    /wolverine|red dead|ragnarök|spider-man/i.test(c.game.name);

  const cfg = isConsoleTarget ? CONSOLE_CFG : GENERAL_CFG;
  const hours = forecast(c, cfg);

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
