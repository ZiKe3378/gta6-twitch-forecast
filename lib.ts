// lib.ts — shared forecast logic for gta6-twitch-ccu-forecast-01 (Node 22, standard library only)
//
// Algorithm (accurate description):
//
//   For each forecast hour h = 2..24:
//   1. Collect log-ratios r_i = ln(v_h,i / v_1,i) from each comparable game i in the pool,
//      where v_1,i is that game's hour-1 viewers and v_h,i its hour-h viewers.
//   2. Assign weight w_i = min(1/(|ln(v_1,i)-ln(p1)|+WEIGHT_FLOOR), minW*CAP_FACTOR) · consoleBoost(i),
//      favouring comparables with similar launch-hour magnitude to the target's p1.
//      consoleBoost > 1 is applied to console-tier games only when the caller declares
//      the target is console (a known production-side fact, not inferred from data).
//   3. Compute the WEIGHTED EMPIRICAL INVERSE-CDF at each contest level tau over the
//      sorted (val, weight) pairs → five empirical log-ratio quantiles.
//   4. Blend each empirical log-ratio with the corresponding lognormal-prior log-ratio
//      (z_tau * sigma, the persistence baseline in log space) with mixing weight alpha(h):
//        blended_lr = alpha(h) * (z_tau * sigma(h)) + (1-alpha(h)) * empirical_lr(tau)
//      alpha grows from ALPHA_MIN at h=2 to ALPHA_MIN+0.22 at h=24, widening prior influence.
//      With an empty pool, alpha=1 → pure lognormal persistence prior.
//   5. Output quantile = clamp(p1 * exp(blended_lr), 1, 1e9), enforced non-decreasing.
//
// Comparable selection (all from case `comparables`, evaluated at forecast time):
//   – Exclude "Grand Theft Auto VI category before release" (pre-launch premiere, tier:target-history).
//   – Exclude tier:weak games (F2P / slow-burn, explicitly labelled in platforms/unlock).
//   – Exclude early-access-contaminated games: any game whose unlockClean string contains "early access"
//     or "early-access" (or "premium early") not immediately preceded by "no ".
//     Metadata policy: Strip `Research note:` and use only EA-existence and platform labels;
//     never parse unlock timing or numeric peaks, and target history is ignored.
//     (No verified prelaunch whitelist or explicit removal of inferred tokens is implemented).
//   – Exclude games with <20 release-day hourly points (insufficient shape information).
//   – Exclude games with hour-1 viewers < 1000 (too noisy for ratio estimation).
//   – Duplicate hourly rows: uses the first valid per-hour record after stable timestamp sort
//     (note: does not guarantee permutation invariance if input holds conflicting duplicate values for the same hour).
//   Optional: consoleOnly=true restricts the pool to console-tier games only.

export const LEVELS   = [0.05, 0.25, 0.5, 0.75, 0.95] as const;
export const Z_NORMAL = [-1.6449, -0.6745, 0.0, 0.6745, 1.6449] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface HourlyPoint  { from: string; viewers: number; channels?: number | null; reads?: number; }
export interface KnownRow     { hour: number; viewers: number; from?: string; until?: string; }
export interface ForecastRow  { hour: number; from?: string; until?: string; }
export interface GameMeta     { name: string; twitch_id?: string; }
export interface Comparable   { name: string; day_start: string; unlock: string; platforms: string; hourly: HourlyPoint[]; }
export interface Case {
  id: string; levels: number[];
  game?: GameMeta;
  known: KnownRow[]; forecast: ForecastRow[];
  comparables: Comparable[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export const clamp  = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
export const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Weighted empirical inverse-CDF at probability p.
 * Pairs MUST be pre-sorted ascending by value.
 * Returns NaN when inputs are empty.
 */
export function weightedECDFQuantile(sv: number[], sw: number[], p: number): number {
  const totalW = sw.reduce((s, w) => s + w, 0);
  if (totalW <= 0 || sv.length === 0) return NaN;
  let cum = 0;
  for (let i = 0; i < sv.length; i++) {
    cum += sw[i] / totalW;
    if (cum >= p) return sv[i];
  }
  return sv[sv.length - 1];
}

// ---------------------------------------------------------------------------
// Leakage-safe game classification
// ---------------------------------------------------------------------------
export type GameTier = 'skip' | 'weak' | 'console' | 'console_ea' | 'pc' | 'pc_ea';

export function classifyGame(g: Comparable): GameTier {
  if (g.name.startsWith('Grand Theft Auto VI category')) return 'skip';

  const platLower   = g.platforms.toLowerCase();
  // Strip post-launch curve observations ("Research note: ...") before timing-token scan
  const unlockClean = g.unlock.replace(/Research note:.*$/si, '').trim();

  if (/tier:\s*weak/i.test(unlockClean) || /free-to-play/i.test(platLower)) return 'weak';

  const hasPC = /\bpc\b|\bsteam\b|\bstadia\b/i.test(platLower);

  // EA existence: read strictly from prelaunch announcement metadata (unlockClean),
  // ignoring any post-launch Research note, and only when not negated by "no early access".
  const noEA  = /\bno\s+early[\s-]access\b/i.test(unlockClean);
  const hasEA = !noEA && (
    /\bearly[\s-]access\b/i.test(unlockClean) ||
    /\bpremium early\b/i.test(unlockClean)
  );

  if (!hasPC && hasEA) return 'console_ea';
  if (!hasPC)          return 'console';
  if (hasEA)           return 'pc_ea';
  return 'pc';
}

// ---------------------------------------------------------------------------
// Deduplicate comparables by (name, day_start) — first occurrence wins
// ---------------------------------------------------------------------------
export function dedupeComparables(comps: Comparable[]): Comparable[] {
  const seen = new Set<string>();
  return comps.filter(g => {
    const key = `${g.name}|||${g.day_start}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ---------------------------------------------------------------------------
// Extract release-day hourly viewers (hours 1-24, 1-based).
// Skips non-finite or negative viewers.
// Duplicate points: keeps first valid reading per hour after stable timestamp sort.
// (Resolves duplicates deterministically; does not guarantee permutation invariance
// if input holds conflicting duplicate values for the same hour).
// ---------------------------------------------------------------------------
export function releaseDayMap(g: Comparable): Map<number, number> {
  const dayMs  = new Date(g.day_start).getTime();
  const sorted = [...g.hourly].sort((a, b) => new Date(a.from).getTime() - new Date(b.from).getTime());
  const result = new Map<number, number>();
  for (const pt of sorted) {
    const v  = pt.viewers;
    if (!isFinite(v) || v < 0) continue;
    const hr = Math.round((new Date(pt.from).getTime() - dayMs) / 3_600_000) + 1;
    // Keep first valid point for each hour if duplicated
    if (hr >= 1 && hr <= 24 && !result.has(hr)) result.set(hr, v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Forecast configuration
// ---------------------------------------------------------------------------
export interface ForecastConfig {
  /** Weight floor in log-distance units (default 0.5 ≈ 65% ratio gap). */
  weightFloor?: number;
  /** Soft-cap: each weight ≤ minWeight * capFactor (default 3.0). */
  capFactor?: number;
  /**
   * Extra weight multiplier for console-tier games in the pool.
   * Apply > 1.0 only when the target is KNOWN to be console-only (e.g. GTA VI in production).
   * In CV, set based on the held-out game's actual tier — console targets get this boost;
   * PC targets get 1.0.
   * Default 1.0 (neutral).
   */
  consoleBoostFactor?: number;
  /**
   * When true, restrict pool to console-tier games only.
   * Appropriate only when the target is known console-only AND the pool is large enough.
   * With few console comparables, prefer consoleBoostFactor over hard exclusion.
   */
  consoleOnly?: boolean;
  /**
   * Minimum prior blend weight at h=2 (grows to alphaMin+0.22 at h=24).
   * Default 0.08. Increase (e.g. 0.15) when pool is very small (<10 games).
   */
  alphaMin?: number;
  /** Prior sigma rate: sigma(h) = sigmaRate * sqrt(h-1). Default 0.18. */
  sigmaRate?: number;
}

export const DEFAULT_CONFIG: Required<ForecastConfig> = {
  weightFloor: 0.5, capFactor: 3.0, consoleBoostFactor: 1.0,
  consoleOnly: false, alphaMin: 0.08, sigmaRate: 0.18,
};

// ---------------------------------------------------------------------------
// Core forecast function
// ---------------------------------------------------------------------------
export function forecast(
  c: Case,
  cfg: ForecastConfig = {},
  excludeKeys: Set<string> = new Set(),
): Array<{ hour: number; q: number[] }> {
  const { weightFloor, capFactor, consoleBoostFactor, consoleOnly, alphaMin, sigmaRate } =
    { ...DEFAULT_CONFIG, ...cfg };

  const knownH1 = c.known.find(k => k.hour === 1);
  if (!knownH1) throw new Error(`${c.id ?? '?'}: no hour-1 print`);
  const p1   = Math.max(1, knownH1.viewers);
  const lnP1 = Math.log(p1);

  // Build pool
  const MIN_HOURLY = 20;
  const MIN_H1     = 1000;

  interface PoolEntry { tier: GameTier; lnH1: number; ratiosByHour: Map<number, number>; }
  const entries: PoolEntry[] = [];

  for (const g of dedupeComparables(c.comparables)) {
    const key  = `${g.name}|||${g.day_start}`;
    if (excludeKeys.has(key)) continue;
    const tier = classifyGame(g);
    if (tier === 'skip' || tier === 'weak' || tier === 'console_ea' || tier === 'pc_ea') continue;
    if (consoleOnly && tier !== 'console') continue;

    const hrs = releaseDayMap(g);
    if (hrs.size < MIN_HOURLY) continue;
    const h1v = hrs.get(1) ?? 0;
    if (h1v < MIN_H1) continue;

    const lnH1        = Math.log(h1v);
    const ratiosByHour = new Map<number, number>();
    for (const [hr, v] of hrs) {
      if (hr >= 2 && hr <= 24 && isFinite(v) && v > 0)
        ratiosByHour.set(hr, Math.log(v) - lnH1);
    }
    entries.push({ tier, lnH1, ratiosByHour });
  }

  // Weights: inverse log-distance + optional console boost, soft-capped
  const rawW = entries.map(e => {
    const dist  = Math.abs(e.lnH1 - lnP1);
    const base  = 1.0 / (dist + weightFloor);
    const boost = (e.tier === 'console') ? consoleBoostFactor : 1.0;
    return base * boost;
  });
  const minW    = rawW.length > 0 ? Math.min(...rawW) : 1;
  const weights = rawW.map(w => Math.min(w, minW * capFactor));

  // Per-hour quantiles
  const alpha = (h: number) => alphaMin + 0.22 * Math.sqrt((h - 2) / 22);

  return c.forecast.map(({ hour: h }) => {
    const vals: number[] = [];
    const ws:   number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const lr = entries[i].ratiosByHour.get(h);
      if (lr !== undefined) { vals.push(lr); ws.push(weights[i]); }
    }
    const ord = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    const sv  = ord.map(i => vals[i]);
    const sw  = ord.map(i => ws[i]);

    const priorSigma = sigmaRate * Math.sqrt(h - 1);
    const a          = alpha(h);

    const q = (LEVELS as readonly number[]).map((tau, li) => {
      const z      = (Z_NORMAL as readonly number[])[li];
      const priorQ = z * priorSigma;
      const empirQ = sv.length > 0 ? weightedECDFQuantile(sv, sw, tau) : priorQ;
      const lr     = a * priorQ + (1 - a) * empirQ;
      return clamp(p1 * Math.exp(lr), 1, 1e9);
    });
    for (let i = 1; i < q.length; i++) if (q[i] < q[i - 1]) q[i] = q[i - 1];
    return { hour: h, q: q.map(round2) };
  });
}

// ---------------------------------------------------------------------------
// Persistence baseline (house baseline)
// q_tau(h) = p1 * exp(z_tau * 0.15 * sqrt(h-1)), clamped [1, 1e9]
// ---------------------------------------------------------------------------
export function baselineForecast(p1raw: number): Array<{ hour: number; q: number[] }> {
  const p1    = Math.max(1, p1raw);
  const SIGMA = 0.15;
  return Array.from({ length: 23 }, (_, i) => {
    const h = i + 2;
    const q = (Z_NORMAL as readonly number[]).map(z =>
      round2(clamp(p1 * Math.exp(z * SIGMA * Math.sqrt(h - 1)), 1, 1e9))
    );
    return { hour: h, q };
  });
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
export function pinball(y: number, q: number, tau: number): number {
  const lnY = Math.log(Math.max(1, y));
  const lnQ = Math.log(Math.max(1, q));
  const d   = lnY - lnQ;
  return 2 * Math.max(tau * d, (tau - 1) * d);
}

/** Mean pinball loss over all five quantile levels for one (hour, actual) pair */
export function rowLoss(actual: number, qs: number[]): number {
  return (LEVELS as readonly number[]).reduce(
    (sum, tau, li) => sum + pinball(actual, qs[li], tau), 0
  ) / LEVELS.length;
}
