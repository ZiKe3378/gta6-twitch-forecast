# Offline Cross-Validation & Calibration Report

This document reports the local leave-one-launch-out (LOLO) evaluation of the empirical analogue forecasting model for make.fun competition **gta6-twitch-ccu-forecast-01**.

---

## 1. Methodology & Data Hygiene

### Unit of Independence
**Each launch is one independent observation.** 
Treating each hour as an independent sample (e.g. 667 hours across 29 games) produces false statistical confidence because the 23 hours within any single launch are strongly auto-correlated. All summary metrics are reported as **means of per-launch metrics** across independent launches ($N=22$ clean launches total, $N=7$ console-only).

### Data Leakage Controls
1. **Target-history exclusion**: *Grand Theft Auto VI category before release (2026-08-27 extended-look premiere)* is permanently excluded from all training and evaluation pools (it was a promotional trailer broadcast, not a game launch).
2. **Metadata hygiene**: The classifier strips all text following `Research note:` and uses strictly EA-existence (`early access` or `premium early` without `no`) and platform labels. It does not parse unlock timing or numeric peaks, and target history is ignored. (No verified prelaunch whitelist or explicit removal of inferred tokens is implemented).
3. **Early-access exclusion**: Titles with multi-day early access (e.g. *Hogwarts Legacy*, *Diablo IV*, *Starfield*, *Death Stranding 2*) have split launch curves and are excluded from the clean training pool.
4. **Duplicate Hourly Rows**: The first valid reading per hour is kept after stable timestamp sort (resolves duplicates deterministically without claiming permutation invariance for conflicting duplicate values).
5. **Strict LOO isolation & Hard Absence Assertions**: When evaluating held-out launch $k$, all records sharing `(name, day_start)` are removed from the training pool. For the target launch, only hour-1 ($p_1$) and ex-ante platform classification are known; no post-checkpoint points or future statistics are accessible. Runtime assertions verify that no held-out candidate appears in either inner or outer training pools.

---

## 2. Audit Note on Cross-Validation Leakage Correction

During Round 4 auditing, an earlier revision exhibited a property name mismatch in `validate.ts`: `outerExcludeKey` checked `g.dayStart` against `outerTarget.dayStart`, but the underlying Comparable schema uses `day_start`. Because `g.dayStart` evaluated to `undefined`, the filter failed to drop the held-out launch from its own training pool, resulting in artificially depressed training losses (~0.1888 for V3, ~0.2346 for V0).

Once corrected to `g.day_start` and protected by hard absence assertions, the verified leak-free losses are:
- **Frozen V0 Outer Console Loss**: **0.256383** (matching the verified Round 3 baseline of 0.2564).
- **Frozen V3 Outer Console Loss**: **0.225577** (matching the verified Round 3 baseline of 0.2256).
- **Genuinely Nested Selection Outer Console Loss**: **0.225577** (V3 chosen in 7 of 7 inner folds).

All metrics reported below reflect the verified, leak-free evaluation.

---

## 3. Model Selection: Nested Cross-Validation (V0 vs. V3)

To select hyperparameters without test-set leakage, an inner leave-one-launch-out loop was run inside each outer fold of the 7 console launches:
- **V0 (Reference)**: Full comparable pool, console weight boost $1.4\times$, $\alpha_{\min} = 0.08$.
- **V3 (Console-Specialized)**: Restricted to console-only launches, $\alpha_{\min} = 0.15$ (stronger heuristic prior shrinkage to compensate for small pool size). For PC targets, V3 defaults strictly to V0.

*(Note: Candidate variants were fixed after initial exploration on the same dataset; nested CV provides structured model selection between predeclared variants rather than fully untouched external holdout evidence).*

### Inner Selection Choices & Outer Results
| Held-Out Launch | Inner V0 Loss | Inner V3 Loss | Inner Choice | Outer Model Loss | V0 Loss | Base Loss | $\Delta$ vs. Base |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Ghost of Yōtei** | 0.2579 | 0.2280 | **V3** | **0.2794** | 0.3096 | 0.4734 | **-0.1940** |
| **Saros** | 0.2400 | 0.1952 | **V3** | **0.4318** | 0.3570 | 0.6011 | **-0.1694** |
| **Zelda: Tears of the Kingdom** | 0.2733 | 0.2419 | **V3** | **0.1768** | 0.2281 | 0.3086 | **-0.1318** |
| **FINAL FANTASY VII REBIRTH** | 0.2670 | 0.2289 | **V3** | **0.1287** | 0.1994 | 0.1734 | **-0.0447** |
| **The Last of Us Part II** | 0.2549 | 0.2072 | **V3** | **0.2609** | 0.2547 | 0.2470 | **+0.0139** |
| **Ghost of Tsushima** | 0.2788 | 0.2506 | **V3** | **0.1057** | 0.1859 | 0.2282 | **-0.1225** |
| **Stellar Blade** | 0.2644 | 0.2384 | **V3** | **0.1958** | 0.2600 | 0.3724 | **-0.1766** |

**Outcome**: V3 was chosen in **7 out of 7 folds** by inner validation.

### Aggregate Performance Summary (Evaluated on Same 7 Console Launches)
| Model | Mean Pinball Loss | Typical Miss | Cov 5% | Cov 25% | Cov 50% | Cov 75% | Cov 95% |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Nominal Target** | — | — | **5.0%** | **25.0%** | **50.0%** | **75.0%** | **95.0%** |
| **Nested Policy (V3)** | **0.2256** | 43.0% | 6.0% | 21.0% | 43.0% | 65.0% | **91.0%** |
| **Frozen V0 Reference** | 0.2564 | 37.5% | 2.0% | 13.0% | 42.0% | 98.0% | 100.0% |
| **House Baseline** | 0.3435 | 73.0% | 6.8% | 20.5% | 34.2% | 60.2% | 84.5% |

*(Note: Baseline figures are computed on the exact same 7 outer console targets; previous drafts inadvertently cited the official 4-practice summary numbers).*

*Note on Pinball vs Typical Miss*: The competition ranking metric is strictly mean pinball loss. While V0 produced a slightly lower median log error (37.5% vs 43.0%), V3 achieved a lower pinball loss (0.2256 vs 0.2564) and better calibrated quantiles (91% coverage at the 95th quantile vs. 100% over-coverage in V0).

---

## 4. Stress Tests

### Console Franchise Holdout (Sucker Punch / Ghost Series)
Simultaneously holding out both *Ghost of Tsushima* and *Ghost of Yōtei* from all training pools:
- **Ghost of Yōtei**: 
  - V0 (Reference): Loss = **0.3007** vs. Baseline **0.4734** ($\Delta = -0.1727$)
  - V3 (Production): Loss = **0.2788** vs. Baseline **0.4734** ($\Delta = -0.1946$)
- **Ghost of Tsushima**: 
  - V0 (Reference): Loss = **0.1938** vs. Baseline **0.2282** ($\Delta = -0.0344$)
  - V3 (Production): Loss = **0.1042** vs. Baseline **0.2282** ($\Delta = -0.1240$)

Both V0 and V3 beat the baseline on both games with the entire franchise excluded.

### Temporal Stress (Year Split)
Training strictly on pre-2023 games ($N=6$, only 2 console games) and evaluating on 2023+ console releases ($N=5$):
- **V0 (Reference)**: Loss = **0.3504** vs Baseline **0.3858** ($\Delta = -0.0354$, 95th coverage = **68.7%**)
- **V3 (Production)**: Loss = **0.3183** vs Baseline **0.3858** ($\Delta = -0.0675$, 95th coverage = **51.3%**)
- **Empirical Undercoverage Limitation**: When trained only on older games, coverage at the 95th quantile degrades sharply (51.3%–68.7% vs nominal 95.0%). This reflects the empirical vulnerability of small-sample pools under temporal regime shifts. The log-quantile shrinkage towards persistence is a regularizing heuristic, not a guarantee against tail failure under distribution shift.

---

## 5. Robustness Suite & Runtime Verification

Executed in `validate.ts`:
1. **Edge Values**: Handled $h_1 = 0$ (clamped to 1), $h_1 = 10^9$ (all outputs strictly $\le 10^9$), empty pool, and sparse pool ($<20$ hours) without errors.
2. **Deterministic Sort & Deduplication**: Shuffled and duplicated hourly rows in comparables produce identical results.
3. **Post-Checkpoint History Invariance**: Adding post-checkpoint data to target case `history` and `history_hourly` does not change predictions by a single byte.
4. **Isolated Process Runtimes**: 
   - **Isolated Node 22 Subprocess (`process.execPath`)**: Total cold process wall-clock time is ~130–220 ms per case (including VM initialization, TypeScript native stripping, JSON parse, forecast, and disk write).
   - **In-Memory Forecast Math**: ~1.8–3.4 ms per case.
   - **Budget Headroom**: Sandbox limit is 8,000 ms; our entry utilizes <3.0% of process wall-clock budget and <0.1% of computational budget.

---

## 6. Reproducibility

To run the complete validation and robustness suite locally with Node 22:
```bash
MAKEFUN_INPUT_DIR=input-kit/input node validate.ts
```
