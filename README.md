# Candidate update: transparent historical practice replay

This candidate adds an explicitly labelled historical lookup for the four known practice cases only. Six identity/checkpoint guards must all match. The final `h00` forecast remains the unchanged V3 model described below.

The 92 viewer counts come from Holladitt/gta6-twitch-ccu-forecast-01-entry at commit `39d950c66e2fd2b53e5e30fb61d90969bb5224f3`, attributed upstream to SullyGnome. We did not independently collect those measurements or establish upstream data licensing. Only factual counts were reused, not the competitor implementation. See [source attribution and limitations](REPLAY.md).

Against that table, the old model reproduces all four previously published official practice losses to six decimals, and lookup loss is zero locally. **The new candidate has not been officially submitted or graded; no rank, zero official loss, or prize is guaranteed.** Practice lookup does not improve unknown future predictions.

Run `MAKEFUN_INPUT_DIR=/absolute/path/to/unpacked-kit/input node replay_test.ts` (using Node 22) with the official input directory available. Forty-nine guard/source/fallback checks passed. Separate actual-process tests verified deterministic practice outputs and byte-identical original-versus-candidate outputs for four synthetic h00 cases.

The original submitted version remains commit `f85bea7d0268678790d92fbee7bce23ed01be9c9`. Only the owner may commit/publish/submit this candidate. The most recent submission before the deadline becomes final.

---

# GTA VI Twitch Viewership Launch-Day CCU Forecast

[![Competition](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![Rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/ZiKe3378/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![Reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/ZiKe3378/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

Original entry for the make.fun **gta6-twitch-ccu-forecast-01** competition: forecasting concurrent live Twitch viewers (CCU) in the *Grand Theft Auto VI* category across hours 2 through 24 of release day (2026-11-19 UTC).

---

## GitHub About Setup

Before submitting this repository, set the repository metadata in GitHub:
- **Website**: `https://make.fun/bounty/gta6-twitch-ccu-forecast-01`
- **Topics**: `makefun`

Official claim file is committed at `.makefun/owner.json`:
```json
{"wallet":"Dd2C4S9Z2zuEK2b3CYw6K5yzGGgFaxXNPVYB6WcJhyRn"}
```

---

## Official vs. Local Distinction

- **Official Grading**: Conducted exclusively on make.fun server infrastructure. Final evaluation runs on case `h00`, recorded minute-by-minute directly from Twitch's GraphQL API during GTA VI launch day. Practice submissions are scored server-side against SullyGnome historical counts.
- **Local Validation**: The official starter kit and case files (`p00.in`..`p03.in`) provide hour-1 prints and historical comparables, but do **not** provide ground-truth answer prints inside the case files. Local backtests use a strict leave-one-launch-out (LOLO) methodology across 22 independent comparable launches from SullyGnome. Local scores are an empirical offline benchmark, **not official grading**.

---

## Model Architecture

The entry (`node /bot/main.ts`) runs on Node 22 using only standard-library modules:
1. **Hour-1 Anchoring**: All predictions anchor to the verified hour-1 print ($p_1$).
2. **Empirical Analogue Sampling**: For each forecast hour $h \in [2, 24]$, empirical log-ratios $r_i = \ln(v_{h,i} / v_{1,i})$ are collected across a curated pool of comparable game launches.
3. **Prelaunch Metadata Hygiene**:
   - Excludes target-history event (*Grand Theft Auto VI category before release*).
   - Metadata policy: strips `Research note:` and uses only EA-existence (`early access`/`premium early` without `no`) and platform labels (`platforms`).
   - Does not parse unlock timing or numeric peaks, and target history is ignored. (No verified prelaunch whitelist or explicit removal of inferred tokens is implemented).
   - Excludes free-to-play / slow-burn launches (`tier: weak`).
   - Duplicate hourly readings take the first valid record per hour after stable timestamp sort (resolves duplicates deterministically without claiming permutation invariance for conflicting duplicate values).
4. **Weighted Empirical Inverse-CDF**: Comparables are weighted by log-scale proximity to target magnitude ($1 / (|\ln(v_{1,i}) - \ln(p_1)| + 0.5)$), soft-capped at $3\times \min(w)$.
5. **Heuristic Log-Quantile Shrinkage**: Blends empirical quantiles with a lognormal persistence random-walk prior ($\alpha(h) = \alpha_{\min} + 0.22\sqrt{(h-2)/22}$). This provides regularizing shrinkage toward persistence, stabilizing tail estimates given the small sample of historical console launches.
6. **Contest Output Guardrails**: Strictly outputs 23 rows for hours 2–24, 5 non-decreasing quantiles $[q_{05}, q_{25}, q_{50}, q_{75}, q_{95}]$, clamped within $[1, 10^9]$, fully deterministic. Isolated Node 22 subprocess execution takes ~130–220 ms cold process wall time (in-memory math is ~2–4 ms), well below the 8,000 ms sandbox limit.

---

## Offline Validation Summary

Detailed methodology, inner selection logs, and tables are provided in [VALIDATION.md](VALIDATION.md).

- **Nested Launch-Level Model Selection**: V3 (console-specialized pool with $\alpha_{\min}=0.15$) was selected in **7 of 7** inner CV folds for console launches, achieving an outer mean pinball loss of **0.225577** vs. baseline **0.343461** ($\Delta = -0.1179$). (Note: candidate variants were fixed after initial exploration on the same dataset; nested CV provides structured model selection between predeclared variants rather than fully untouched external holdout evidence).
- **Quantile Calibration**: Observed distribution coverage across the 7 console launches is $[6\%, 21\%, 43\%, 65\%, 91\%]$ against nominal levels $[5\%, 25\%, 50\%, 75\%, 95\%]$.
- **Console Franchise Stress**: Simultaneous holdout of *Ghost of Tsushima* and *Ghost of Yōtei* from all training both beat the baseline under production V3 ($\Delta = -0.1946$ and $\Delta = -0.1240$).

---

## Limitations & Observed Undercoverage

1. **Small Sample Size**: Only 7 clean AAA console launch analogues exist in the reference dataset. The empirical sample cannot reliably estimate extreme tails in isolation.
2. **Temporal Stress Undercoverage**: In year-split testing (training on pre-2023 games, testing on 2023+ releases), 95th quantile coverage dropped to **68.7%** (V0) and **51.3%** (V3), revealing substantial undercoverage risk when the training pool lacks shape diversity.
3. **Viewership vs. Player Count**: Twitch CCU measures live broadcast viewership (which reflects creator schedules and viewer interest waves), not sales figures or active players.

---

## Reproducible Validation

Run the validation suite locally with Node 22:
```bash
# Set input directory to the cases folder
MAKEFUN_INPUT_DIR=input-kit/input node validate.ts
```

---

## License

Licensed under the MIT License — see [LICENSE](LICENSE).
