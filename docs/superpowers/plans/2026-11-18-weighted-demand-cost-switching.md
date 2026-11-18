# Weighted Demand and Cost-Aware Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `smart-router/auto` takes the level a prompt needs from a weighted blend of Jev and upstream's heuristics, picks the model by expected cost with each model's cache counted, compacts before it steps down, moves a stuck run up one level, and loses the pin, the five-minute hold and the fit hold.

**Architecture:**

- Five new pure modules: `src/triage/tier-features.ts` (upstream's scoring, vendored), `src/settings.ts` (the two roster sections and their defaults), `src/demand.ts` (the blend and its guards), `src/cost.ts` (expected cost and the choice), `src/ledger.ts` (what a session knows of each model's cache, its runs and its prompts).
- `src/decide.ts` keeps the plan of a run. `planLevel` becomes: the needed level (a tag's, else the demand's), then `chooseModel`, which prices the first available model of each level from the needed one up. `climb` stays as the resolution for a level with no model of its own available.
- `src/route.ts` gains two request-time rules: a run that starts without a prompt goes through `chooseModel` at the level the session last needed, and a run whose last three tool calls failed identically moves up one level, once.
- `src/router.ts` feeds the ledger from `message_end`, `agent_settled`, `session_compact` and `session_tree`, seeds it on resume from the bounded read it already makes, and hands the figures to the plan and to each route.

**Tech Stack:** TypeScript run by Node's type stripping (no build), `node:test`, no runtime dependency; `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` 1.5.2 as devDependencies.

**Spec:** `docs/superpowers/specs/2026-11-18-weighted-demand-cost-switching-design.md`. Read it before any task. Where this plan and the spec differ on a value, the plan's value is the later decision and is marked **(plan)**.

## Global Constraints

- Runtime code (`index.ts`, `src/`) opens no connection, starts no process, sets no timer and writes no file. `test/scan.test.ts` enforces it, comments included: no `fetch(`, `setTimeout`, `import(`, `require(`, `WebSocket`, `.getEntries`, `.getBranch` anywhere under `src/`, and no import outside `node:path`, `node:crypto`, the two Pi packages and relative paths.
- New pure modules read no clock: every time is passed in.
- Session history is read only through the bounded readers (`getRecentActiveEntries`, `getLatestCustomEntry`) and, where present, `getHistoryMetrics`. Each is detected, never assumed.
- Nothing the router keeps, records, shows or logs holds prompt text or a digest of it.
- No test contacts Jev, a model or the network. The behaviour suite (`test/behaviour.test.ts`) runs only under `npm run check:sandbox`.
- Never read or write `~/.pi`, `~/.config/pi`, any `auth.json`, `~/.ssh`, `~/.gnupg` or `~/.password-store`.
- `src/check-cli.ts` and everything it value-imports stay free of Pi's packages and of `decide.ts`, `router.ts` and `jev.ts` (`test/check.test.ts`, "imports nothing of Pi's"). `src/settings.ts` is in that closure.
- TypeScript: `erasableSyntaxOnly` (no enums, namespaces or parameter properties), `verbatimModuleSyntax` (`import type` for types), `.ts` import specifiers, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (optional fields by conditional spread).
- Signed commits only (`git commit -S`), one logical change each, explicit paths staged. Never push, tag, stash, reset or amend a commit another task built on.
- Every commit message ends with these two lines:

  ```
  Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018B4HUkdAyftaLb6vwV1a85
  ```

- Words: in code a level is a `Tier` (`low`, `medium`, `high`, `super`). "Hold" has two meanings in this repository. The level hold (`hold:sticky`, `hold:fit`, `reopen:idle`, `stickyIdleMinutes`) is removed here. The unreachable-server holds (`Holds`, `holdFrom`, `HELD_REASON`, `strictHolds`, `unreachableMinutes`) are a different feature and stay untouched.
- Thinking effort is not changed by this plan. One thing follows from the spec's finding: a model's cached size counts only when the effort about to be sent is the effort of its last answer (Task 9).
- Exact values, from the spec unless marked:

  | Setting | Value |
  |---|---|
  | `demand.jevWeight`, `demand.heuristicsWeight` | 4 **(plan; the spec's first figure was 3)**, 1 |
  | `demand.minConfidence`, `demand.closeCall` | 0.6, 0.1 |
  | `demand.cuts` | 0.75, 1.5, 2.25 |
  | `demand.deepSessionFloor` | `medium`, for more than 100,000 tokens or more than 1,000 entries on the branch **(plan: entries, which Pi counts without a read, stand in for the spec's messages)** |
  | `demand.weights` | upstream's defaults with `requirement_low` and `cluster_signal` 0 |
  | `switching.margin`, `switching.horizonCap` | 0.15, 5 |
  | `switching.cacheSurvival` | `[[60,0.97],[300,0.92],[1200,0.87],[1800,0.79],[3600,0.66],[7200,0.5],[21600,0.38],[86400,0.11]]` |
  | Run shape with fewer than 3 runs | 5 requests, 800 output tokens, 1,500 tokens of growth, 120 seconds |
  | Chance the current level is needed again | share of the last 10 prompts; 0.5 with fewer than 3; never under 0.2 |
  | Summary size assumed for a compaction **(plan)** | 4,000 tokens; the conversation after it is `keepRecentTokens` + 4,000 |
  | Escalation | 3 failed tool results in a row, same tool, same first 256 characters; one level; once per run |

## Review Focus

The inputs the spec implies but its own test list does not name, most likely first. Each has its test in the task named.

1. **A session resumed after Pi restarts.** The ledger starts empty, and a session whose model is warm would look cold and move down. The ledger is seeded from the bounded read at `session_start` (Task 10, "a resumed session keeps its model's cache").
2. **A level model with no price.** A catalog entry whose input or output price is zero or missing would win every comparison. Such a figure is missing, not free: the run takes the needed level's own model and says the cost is unknown (Task 9, "a model without a price makes the cost unknown").
3. **`/thinking` changed in mid-session, or a role with a fixed level.** The next request to the same model misses its cache. The cached size counts only at the same effort (Task 9, "a change of effort zeroes the cached size").
4. **The same model id on two accounts.** `openai-codex-2/gpt-6-astra` and `openai-codex-3/gpt-6-astra` share nothing. The ledger is keyed by `provider/id` (Task 5, "two accounts with one model id keep separate figures").
5. **A session file written by an earlier version.** Level records with `source: "keyword"` and `asked`, and a `smart-router.pin` entry, must still be read without failing: resume, `/smart-router was` and the old-pin notice depend on it (Task 8, "an earlier version's record still reads"; Task 6, "an old pin entry is ignored, with one notice").

## Working notes

- Work in `/Users/johnw/src/fork/pi-smart-router-weighted-demand`, branch `feat/weighted-demand`. Never touch `~/src/fork/pi-smart-router` (John's checkout) or any other clone. `node_modules` is already installed here from the unchanged lockfile; do not run `npm install`.
- The gate is `npm run check` (types, every unit suite, the pack check). Baseline on `1c01202f`: 32 suite files, 1,509 tests, all passing. One file: `node test/run.mjs test/<name>.test.ts`.
- The behaviour suite: `npm run check:sandbox` (macOS `sandbox-exec`). Run it in every task that changes `src/router.ts`, `src/route.ts`, `src/decide.ts`, `src/commands.ts` or `test/behaviour.test.ts`. New Pi-runtime scenarios are appended to `test/behaviour.test.ts`; a new file would run unsandboxed and fail.
- Tests: `import assert from "node:assert/strict"; import test, { describe } from "node:test";`. `describe` names a subject, `test` completes the sentence, every assertion carries a message naming the case. A test may never be weakened or deleted to get green, except the tests this plan names as deleted with the behaviour they covered.
- When an existing test's expectation changes, the new expectation must follow from a rule in the spec, named in the assertion's message.
- Upstream is cloned read-only at `/Users/johnw/src/fork/pi-smart-router-upstream-survey` (tag `v1.4.0` = `54bee53d908a81260a34b94cbe124bfd61f57df7`). Never edit it.
- If a step's expected output does not appear, stop and report what happened. Do not change a vendored file, a pinned value or an assertion to make it appear.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/triage/tier-features.ts` | upstream's twelve-signal low-intensity score, unchanged but for imports | 1 |
| `src/triage/types.ts` | the upstream types that file reads | 1 |
| `scripts/vendor-drift.mjs` | compares the vendored files with an upstream clone | 1 |
| `src/settings.ts` | `demand` and `switching`: types, ranges, defaults, fixed figures | 2 |
| `src/roster.ts`, `src/check.ts` | parse the two sections; read them back in plain words | 2, 7, 8 |
| `src/demand.ts` | Jev's term, the heuristics' term, the blend, the guards, the level | 3 |
| `src/cost.ts` | survival, rates, a run's expected cost, the choice | 4 |
| `src/ledger.ts` | per-session figures: caches, run shapes, prompts' needs | 5 |
| `src/pin.ts` (deleted), `src/selection.ts`, `src/commands.ts`, `src/errors.ts`, `src/owners.ts` | the pin's removal and its three notices | 6 |
| `src/decide.ts` | need, `chooseModel`, `climb`, version 1 without a hold | 7, 8, 9 |
| `src/jev.ts`, `src/tiers.ts`, `src/records.ts` | the answer without a close-call tier; the record and footer forms | 8, 10 |
| `src/router.ts` | facts for the demand, the ledger's feed, the figures | 8, 10, 11 |
| `src/stuck.ts`, `src/route.ts` | the stuck-run test; runs without a prompt; escalation | 11 |
| `scripts/review-demand.ts` | replays recorded prompts for a training review | 13 |

---

### Task 1: Vendor upstream's low-intensity scoring

**Files:**
- Create: `src/triage/tier-features.ts`, `src/triage/types.ts`, `scripts/vendor-drift.mjs`
- Modify: `README.md:1511-1515` (the sentence on vendored files), `test/scan.test.ts:54-57`
- Test: `test/tier-features.test.ts`

**Interfaces:**
- Consumes: `triage`, `CYCLOMATIC_THRESHOLD` and `TriageResult` from `src/triage/triage-engine.ts`.
- Produces, from `src/triage/tier-features.ts` (upstream's own names and signatures):

  ```ts
  export interface LowIntensityWeights { /* twelve readonly numbers, upstream's keys */ }
  export const DEFAULT_LOW_INTENSITY_WEIGHTS: Readonly<LowIntensityWeights>;
  export function buildTierFeatures(request: RoutingRequest, triage: TriageResult, hydraRequirements?: RequirementVector, clusterMatch?: ClusterMatchResult): TierFeatureVector;
  export function scoreLowIntensity(features: TierFeatureVector, weights?: LowIntensityWeights, options?: { readonly cyclomaticThreshold?: number }): number;
  ```

  and from `src/triage/types.ts`:

  ```ts
  export type TurnType = "planning" | "tool_result" | "subagent" | "main_loop" | "unknown";
  /** Upstream's three tiers, used only by the cluster fields. Not the fork's levels (src/tiers.ts). */
  export type Tier = "zero-tier" | "economical-cloud" | "frontier-cloud";
  export interface Message { readonly role: string }
  export interface RoutingRequest { readonly prompt_text: string; readonly messages?: readonly Message[]; readonly turn_type?: TurnType; readonly estimated_input_tokens?: number }
  export interface RequirementVector { readonly reasoning: number; readonly code_gen: number; readonly tool_use: number }
  export type ClusterMatchConfidence = "high" | "low" | "none";
  export interface ClusterMatchResult { readonly clusterId: string; readonly tierBias: Tier; readonly similarity: number; readonly margin: number; readonly confidence: ClusterMatchConfidence; readonly elapsedMs: number }
  ```

- [ ] **Step 1: Write the failing tests** in `test/tier-features.test.ts`. A request is built as the fork will build it: `buildTierFeatures({ prompt_text, turn_type, messages, ...(tokens === undefined ? {} : { estimated_input_tokens: tokens }) }, triage(prompt_text))`. `DESIGN` is the defaults with `requirement_low: 0, cluster_signal: 0`. `deepRoles` is 20 messages whose roles alternate `user`, `tool`.

  ```ts
  const close = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 5e-5, `${what}: ${actual} is not ${expected}`);

  test("scores upstream's own examples as upstream does", () => {
    close(score("what is 2+2 ?", "main_loop", [], undefined, DEFAULT_LOW_INTENSITY_WEIGHTS), 0.72043, "a trivial question, upstream's weights");
    close(score("what is 2+2 ?", "main_loop", [], undefined, DESIGN), 0.70274, "a trivial question, the design's weights");
    close(score(PLANNING, "planning", [], undefined, DESIGN), 0.32619, "a planning prompt");
    close(score("continue", "main_loop", deepRoles, 150_002, DESIGN), 0.55845, "a terse prompt in a deep session");
  });
  test("leaves a zero-weight signal out of the mean, and gives 0.5 when every weight is zero", () => { /* ZERO weights -> 0.5; one-hot turn_type: main_loop 0.55, planning 0 */ });
  test("counts a missing requirement vector as easy, which is why the design zeroes that weight", () => { /* one-hot requirement_low on any request -> 1 */ });
  ```

  `PLANNING` is `"Plan the architecture for a distributed payment service with migration strategy"`. Add upstream's four inequality tests from `tests/unit/tier-features.test.ts:106-170` in the upstream clone, ported to `node:test` as `test/triage.test.ts` ported the triage tests.

- [ ] **Step 2: Run** `node test/run.mjs test/tier-features.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Vendor the file.** `git -C /Users/johnw/src/fork/pi-smart-router-upstream-survey show 54bee53d908a81260a34b94cbe124bfd61f57df7:src/domain/routing/tier-features.ts` is the source (blob `011ed2c7d30cb5c594f09c79150719b7619a17cb`). The only changes allowed: the header below goes on top; the four type imports point at `./types.ts` and `./triage-engine.ts`; the one value import becomes `import { CYCLOMATIC_THRESHOLD } from "./triage-engine.ts";`. If `tsc` refuses a line under the fork's stricter flags, make the smallest typing change and list it in the header under "Changes".

  ```ts
  // Vendored from beettlle/pi-smart-router, src/domain/routing/tier-features.ts, at commit
  // 54bee53d908a81260a34b94cbe124bfd61f57df7 (v1.4.0). MIT License, Copyright (c) 2026 beettlle and
  // contributors; the full text is in this repository's LICENSE.
  // Changes: the import specifiers, and the upstream types this file reads, which are in types.ts.
  // scripts/vendor-drift.mjs compares this file with upstream.
  ```

- [ ] **Step 4: Write `src/triage/types.ts`** with exactly the types in Interfaces.

- [ ] **Step 5: Run** `node test/run.mjs test/tier-features.test.ts test/scan.test.ts`. Expected: PASS. Add to `test/scan.test.ts` beside the triage-engine assertion that `src/triage/tier-features.ts` is among the scanned files.

- [ ] **Step 6: Write `scripts/vendor-drift.mjs`**: `node scripts/vendor-drift.mjs <upstream clone> [revision]`. For `triage-engine.ts`, `entropy-check.ts` (both from `src/domain/triage/`) and `tier-features.ts` (from `src/domain/routing/`) it prints, per file: whether upstream changed between the vendored commit and the revision (default `HEAD`), and a unified diff of the local file against upstream at the vendored commit after normalising import specifiers and dropping the fork's header. It uses `node:child_process` with `git -C`; it is a development script, outside `src/`, not shipped. Run it against the upstream clone. Expected: "unchanged upstream" three times and no diff.

- [ ] **Step 7:** Widen the README sentence at 1511-1515 to name `tier-features.ts` and the commit. Run `npm run check`. Expected: PASS.

- [ ] **Step 8: Commit** `src/triage/tier-features.ts src/triage/types.ts scripts/vendor-drift.mjs test/tier-features.test.ts test/scan.test.ts README.md` as "Vendor upstream's low-intensity scoring".

---

### Task 2: The roster's `demand` and `switching` sections

**Files:**
- Create: `src/settings.ts`
- Modify: `src/roster.ts` (`V2_TOP_KEYS` at :558, `RosterV2` at :121-137, the version 2 result at :745-757), `src/check.ts` (`describeRouting` at :118-129), `test/support/host.ts` (`RosterJsonV2` at :592)
- Test: `test/roster-v2.test.ts`, `test/check.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_LOW_INTENSITY_WEIGHTS`, `LowIntensityWeights` (Task 1); `Tier`, `TIERS`, `isTier`.
- Produces, from `src/settings.ts` (no Pi import, no clock):

  ```ts
  export const SIGNALS = ["prompt_shortness", "token_shortness", "cyclomatic_low", "trivial_signal", "complex_inverse", "triage_verdict", "turn_type", "no_tool_context", "message_shallow", "prose_ratio", "requirement_low", "cluster_signal"] as const;
  export type SurvivalTable = ReadonlyArray<readonly [seconds: number, chance: number]>;
  export interface DemandSettings {
    readonly jevWeight: number; readonly heuristicsWeight: number;
    readonly minConfidence: number; readonly closeCall: number;
    readonly cuts: readonly [number, number, number];
    readonly deepSessionFloor: Tier;
    readonly weights: LowIntensityWeights;
  }
  export interface SwitchingSettings { readonly margin: number; readonly horizonCap: number; readonly cacheSurvival: SurvivalTable }
  export const DESIGN_WEIGHTS: LowIntensityWeights;      // upstream's defaults, requirement_low and cluster_signal 0
  export const DEFAULT_DEMAND: DemandSettings;           // the Global Constraints values
  export const DEFAULT_SWITCHING: SwitchingSettings;
  export const DEEP_SESSION_TOKENS = 100_000;
  export const DEEP_SESSION_ENTRIES = 1_000;
  export const RUN_DEFAULTS = { requests: 5, output: 800, growth: 1_500, seconds: 120 } as const;
  export const RUNS_KEPT = 10;
  export const RUNS_NEEDED = 3;
  export const AGAIN_DEFAULT = 0.5;
  export const AGAIN_MIN = 0.2;
  export const SUMMARY_TOKENS = 4_000;
  ```

  and on the roster: `RosterV2.demand: DemandSettings` and `RosterV2.switching: SwitchingSettings`, always present.

- [ ] **Step 1: Write the failing tests.** In `test/roster-v2.test.ts`, `describe("the demand and switching sections")`:

  ```ts
  test("a roster without them gets the defaults", () => { /* rosterFixtureV2("roster-hera-v2-fallback.json"): deepEqual(roster.demand, DEFAULT_DEMAND); deepEqual(roster.switching, DEFAULT_SWITCHING) */ });
  test("a section that gives one setting keeps the defaults for the rest", () => { /* switching: { margin: 0.3 } -> margin 0.3, horizonCap 5, the default table; demand: { weights: { turn_type: 0.3 } } -> turn_type 0.3, triage_verdict 0.18, requirement_low 0 */ });
  test("refuses what the checker promises to refuse", () => {
    for (const [section, expected] of [
      [{ demand: { jevWeight: -1 } }, "demand.jevWeight: must be a number from 0 to 100"],
      [{ demand: { jevWeight: 0, heuristicsWeight: 0 } }, "demand: jevWeight and heuristicsWeight cannot both be 0"],
      [{ demand: { cuts: [0.75, 0.5, 2.25] } }, "demand.cuts: must be three numbers that ascend, each above 0 and below 3"],
      [{ demand: { cuts: [0.75, 1.5] } }, "demand.cuts: must be three numbers that ascend, each above 0 and below 3"],
      [{ demand: { deepSessionFloor: "top" } }, "demand.deepSessionFloor: must be one of low, medium, high, super"],
      [{ demand: { weights: { turn_type: -0.1 } } }, "demand.weights.turn_type: must be a number from 0 to 100"],
      [{ demand: { weights: { speed: 1 } } }, "demand.weights: unknown key"],
      [{ demand: { weights: ALL_ZERO } }, "demand.weights: cannot all be 0"],
      [{ switching: { margin: 1 } }, "switching.margin: must be a number from 0 to 0.9"],
      [{ switching: { horizonCap: 0 } }, "switching.horizonCap: must be a whole number of runs from 1 to 20"],
      [{ switching: { cacheSurvival: [[300, 0.9], [60, 0.8]] } }, SURVIVAL_PROBLEM],
      [{ switching: { cacheSurvival: [[60, 0.8], [300, 0.9]] } }, SURVIVAL_PROBLEM],
      [{ switching: { cacheSurvival: [] } }, SURVIVAL_PROBLEM],
    ] as const) { /* parseRoster of the fixture with the section merged: ok false, error starts with expected */ }
  });
  ```

  `SURVIVAL_PROBLEM` is `"switching.cacheSurvival: must be 1 to 32 pairs of [seconds, chance], the seconds rising and the chances from 1 to 0 never rising"`. "unknown key" errors keep the wording `object()` gives today. In `test/check.test.ts`, assert that the report of the fallback fixture contains, in this order and exactly:

  ```
  Demand: Jev's answer counts 4 and the heuristics 1 at full confidence; under 60% confidence the heuristics can only raise the level.
    LOW under 0.75, MEDIUM under 1.5, HIGH under 2.25, SUPER from there; within 0.1 under a cut takes the level above.
    A conversation over 100,000 tokens or 1,000 entries is never under MEDIUM.
    Heuristic weights: triage_verdict 0.18, turn_type 0.18, complex_inverse 0.14, trivial_signal 0.1, cyclomatic_low 0.08, prompt_shortness 0.06, token_shortness 0.05, no_tool_context 0.05, message_shallow 0.03, prose_ratio 0.03, requirement_low 0, cluster_signal 0.
  Switching: a move must cost at least 15% less than staying; lighter prompts in a row are priced up to 5 runs ahead.
    A model's cache is taken to survive 97% up to 1 min, 92% up to 5 min, 87% up to 20 min, 79% up to 30 min, 66% up to 1 h, 50% up to 2 h, 38% up to 6 h, 11% up to 24 h, and not after.
  ```

  Weights are listed by weight, largest first, ties in `SIGNALS` order. A time is `N h` when whole hours, else `N min` when whole minutes, else `N s`.

- [ ] **Step 2: Run** `node test/run.mjs test/roster-v2.test.ts test/check.test.ts`. Expected: FAIL.

- [ ] **Step 3: Write `src/settings.ts`** as in Interfaces, with the ranges the error texts state.

- [ ] **Step 4: Parse the sections in `src/roster.ts`**, following `classifierSettings` (:605-631) as the model: `function demandSettings(value: unknown): DemandSettings` and `function switchingSettings(value: unknown): SwitchingSettings`, each given `own(root, "demand")` or `own(root, "switching")`, returning the defaults for `undefined`. Add both keys to `V2_TOP_KEYS`. They are checked after `classifier` and before `local`; extend the order test at `test/roster-v2.test.ts:851` accordingly. Version 1 refuses both keys, as it refuses any unknown key.

- [ ] **Step 5: Add `demandLines(roster: RosterV2): string[]` and `switchingLines(roster: RosterV2): string[]`** to `src/check.ts` and spread them in `describeRouting` after `describeV2`'s lines.

- [ ] **Step 6: Run** `npm run check`. Expected: PASS, including "imports nothing of Pi's".

- [ ] **Step 7: Commit** as "Parse the roster's demand and switching sections".

---

### Task 3: Demand

**Files:**
- Create: `src/demand.ts`
- Test: `test/demand.test.ts`

**Interfaces:**
- Consumes: `buildTierFeatures`, `scoreLowIntensity` (Task 1); `DemandSettings`, `SIGNALS`, `DEEP_SESSION_TOKENS`, `DEEP_SESSION_ENTRIES` (Task 2); `triage`; `capText` from `src/classify.ts`; `type JevOutcome` from `src/jev.ts`; `Tier`, `TIERS`, `tierRank`.
- Produces:

  ```ts
  /** How many recent messages feed the heuristics: upstream's MESSAGE_COUNT_NORM. */
  export const HEURISTIC_MESSAGES = 20;
  export interface PromptFacts {
    /** The conversation's size in tokens before this prompt, from the latest usage. */
    readonly contextTokens: number | undefined;
    /** The roles of the latest messages, oldest first, at most HEURISTIC_MESSAGES; "tool" for a tool result. */
    readonly roles: readonly string[];
    /** The branch's entry count, where Pi's history metrics give one. */
    readonly entries: number | undefined;
  }
  export type DemandGuard = "low-confidence" | "close-call" | "risky" | "deep-session";
  export interface Demand {
    /** 0 (LOW) to 3 (SUPER), before the floors. */
    readonly value: number;
    readonly tier: Tier;
    readonly jev?: { readonly value: number; readonly confidence: number };
    /** The heuristics' value, upstream's score, and the three signals that raise it most, each with its share of 1 - score. */
    readonly heuristics: { readonly value: number; readonly score: number; readonly top: ReadonlyArray<readonly [signal: string, share: number]> };
    /** The guards that changed the result, in the order applied. */
    readonly guards: readonly DemandGuard[];
  }
  export interface DemandInput { readonly text: string; readonly planning: boolean; readonly risky: boolean; readonly jev: JevOutcome | undefined; readonly facts: PromptFacts }
  export function tierOfDemand(value: number, settings: Pick<DemandSettings, "cuts" | "closeCall">): { readonly tier: Tier; readonly closeCall: boolean };
  export function demandOf(input: DemandInput, settings: DemandSettings): Demand;
  ```

- [ ] **Step 1: Write the failing tests.** `FRESH` is `{ contextTokens: undefined, roles: [], entries: undefined }`; `DEEP` is `{ contextTokens: 150_000, roles: <20 alternating "user","tool">, entries: 400 }`; `SHALLOW` is `DEEP` with `contextTokens: 50_000`. The tables are 80% answers: `LOW = { low: 0.8, medium: 0.1, high: 0.05, super: 0.05 }`, `MEDIUM = { low: 0.1, medium: 0.8, high: 0.05, super: 0.05 }`, `HIGH = { low: 0.05, medium: 0.1, high: 0.8, super: 0.05 }`, `SUPER = { low: 0.05, medium: 0.05, high: 0.1, super: 0.8 }`. `answer(p)` builds a `JevOutcome` of kind `answer`. Values are asserted within 1e-3; tiers and guards exactly.

  ```ts
  describe("the heuristics alone", () => {
    test("give each kind of prompt the level the design's weights imply", () => {
      for (const [text, planning, facts, value, tier] of [
        ["what is 2+2 ?", false, FRESH, 0.8918, "medium"],
        ["fix the typo in the README", false, FRESH, 0.5112, "low"],
        [PLANNING, true, FRESH, 2.0214, "high"],
        ["Implement a concurrent rate limiter with a token bucket and add tests for it", false, FRESH, 1.3802, "medium"],
        ["continue", false, DEEP, 1.3246, "medium"],
      ] as const) { /* jev undefined, risky false: value, tier, guards [] and no jev term */ }
    });
    test("name the three signals that raise the demand most, and their shares add up to 1 - score", () => { /* "continue", DEEP: top has 3 entries, descending; sum of all shares === 1 - score is checked by summing with a one-hot loop in the test */ });
    test("agree in direction with the keyword classifier's own examples", () => { /* three prompts each that test/classify.test.ts classifies as planning, complex, trivial and default, FRESH: every planning one is above every trivial one; no planning one is LOW; no trivial one is above MEDIUM */ });
  });
  describe("a confident Jev", () => {
    test("keeps the level it gives on a neutral prompt, at both ends of the scale", () => {
      for (const [table, text, facts, value, tier, guards] of [
        [LOW, "what is 2+2 ?", FRESH, 0.479, "low", []],
        [LOW, "continue", SHALLOW, 0.5821, "low", []],
        [MEDIUM, "what is 2+2 ?", FRESH, 1.0123, "medium", []],
        [HIGH, "fix the typo in the README", FRESH, 1.5312, "high", []],
        [SUPER, "what is 2+2 ?", FRESH, 2.2314, "super", ["close-call"]],
        [SUPER, "continue", DEEP, 2.3344, "super", []],
      ] as const) { /* ... */ }
    });
    test("is moved one level by heuristics that disagree strongly", () => {
      /* LOW + PLANNING (planning true), FRESH: 0.748, "medium", ["close-call"]; SUPER + "fix the typo in the README", FRESH: 2.1408, "high", [] */
    });
  });
  describe("the guards", () => {
    test("an unsure Jev can only raise the heuristics' level", () => {
      /* { low: 0.4, medium: 0.3, high: 0.2, super: 0.1 } + PLANNING, FRESH: value 2.0214 (the heuristics'), "high", ["low-confidence"] */
      /* { low: 0.1, medium: 0.2, high: 0.3, super: 0.4 } + "what is 2+2 ?", FRESH: value 1.5738 (the blend), "high", [] */
    });
    test("a risky operation is never under HIGH, and a very deep session never under the floor", () => {
      /* LOW + "what is 2+2 ?", FRESH, risky true: "high", ["risky"], value still 0.479 */
      /* { low: 0.9, medium: 0.1, high: 0, super: 0 } + "continue", DEEP: value 0.3662, "medium", ["deep-session"] */
      /* the same with entries 1_001 and contextTokens 50_000: "medium", ["deep-session"]; with deepSessionFloor "low": "low", [] */
    });
    test("a Jev that failed, or weights that silence one side, leave the other to decide", () => {
      /* kind "failure": equal to jev undefined; heuristicsWeight 0 with HIGH: value 1.85; jevWeight 0 with HIGH: the heuristics' value */
    });
  });
  describe("tierOfDemand", () => {
    test("cuts the scale at 0.75, 1.5 and 2.25, and sends a close call up", () => {
      for (const [value, tier, closeCall] of [[0, "low", false], [0.64, "low", false], [0.65, "medium", true], [0.75, "medium", false], [1.39, "medium", false], [1.41, "high", true], [1.5, "high", false], [2.15, "super", true], [2.25, "super", false], [3, "super", false]] as const) { /* ... */ }
    });
  });
  ```

- [ ] **Step 2: Run** `node test/run.mjs test/demand.test.ts`. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement `demandOf` and `tierOfDemand`.** The order is fixed:

  1. `capped = capText(text)`; the request is `{ prompt_text: capped, turn_type: planning ? "planning" : "main_loop", messages: facts.roles.map((role) => ({ role })) }`, plus `estimated_input_tokens: facts.contextTokens + Math.ceil(capped.length / 4)` when `contextTokens` is known. `score = scoreLowIntensity(buildTierFeatures(request, triage(capped)), settings.weights)`; the heuristics' value is `3 * (1 - score)`.
  2. Jev's term, for an outcome of kind `answer` whose probabilities sum above 0: the value is the expected rank (`low` 0 to `super` 3) and the confidence is the largest probability, both after dividing by the sum.
  3. The blend is `(jevWeight * confidence * jevValue + heuristicsWeight * heuristicsValue) / (jevWeight * confidence + heuristicsWeight)`; without a Jev term, or with a zero denominator, it is the heuristics' value.
  4. Low confidence: with a Jev term whose confidence is under `minConfidence`, the value is the larger of the blend and the heuristics' value; the guard is recorded only when the heuristics' value was the larger.
  5. `tierOfDemand`: the first level whose cut is above the value, or the level above it when the cut is within `closeCall` (compare with the `1e-9` allowance `src/tiers.ts` uses); the guard `close-call` when that happened.
  6. Floors, each recorded only when it raises the level: `risky` to `high`; then `deep-session` to `deepSessionFloor` when `contextTokens > DEEP_SESSION_TOKENS` or `entries > DEEP_SESSION_ENTRIES`.
  7. A signal's share is `weight * (1 - s) / (sum of weights)`, where `s` is `scoreLowIntensity` with that one weight set to 1 and the rest 0. Only signals with a weight above 0 are listed.

- [ ] **Step 4: Run** `node test/run.mjs test/demand.test.ts`, then `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** as "Compute a prompt's demand from Jev and the heuristics".

---

### Task 4: Cost

**Files:**
- Create: `src/cost.ts`
- Test: `test/cost.test.ts`, `test/cost-sequences.test.ts`

**Interfaces:**
- Consumes: `SwitchingSettings`, `SurvivalTable` (Task 2); `Tier`.
- Produces:

  ```ts
  /** Dollars per token at the conversation's size. `input` is what uncached input costs. */
  export interface Rates { readonly input: number; readonly cacheRead: number; readonly output: number }
  /** A catalog price: dollars per million tokens, with Pi's request-wide tiers. */
  export interface CatalogCost { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly tiers?: ReadonlyArray<{ readonly inputTokensAbove: number; readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }> | undefined }
  export interface Candidate {
    readonly ref: string; readonly tier: Tier; readonly rates: Rates;
    /** Tokens of the conversation this model has cached. */
    readonly cached: number;
    /** Seconds since its last answer; undefined when it has none. */
    readonly idle: number | undefined;
    /** The cache lifetime in seconds its catalog entry states, when it states one. */
    readonly lifetime?: number | undefined;
    /** Whether Pi compacts before this model takes the conversation. */
    readonly compacts: boolean;
  }
  export interface Workload { readonly tokens: number; readonly requests: number; readonly output: number; readonly growth: number; readonly seconds: number; readonly horizon: number }
  export interface Compaction { readonly summary: number; readonly after: number }
  export interface Priced { readonly ref: string; readonly tier: Tier; readonly cost: number; readonly leaving: number; readonly cached: number; readonly survival: number; readonly compacts: boolean }
  export interface CostChoice { readonly chosen: Priced; readonly priced: readonly Priced[]; readonly outcome: "stayed" | "moved" | "only" }
  export function survival(table: SurvivalTable, idleSeconds: number | undefined): number;
  /** A candidate's chance: 1 up to a stated lifetime and 0 after it; else the table's. */
  export function survivalOf(candidate: Pick<Candidate, "idle" | "lifetime">, table: SurvivalTable, extraSeconds?: number): number;
  export function ratesOf(cost: CatalogCost | undefined, tokens: number, writes: boolean): Rates | undefined;
  export function runCost(candidate: Candidate, workload: Workload, table: SurvivalTable): number;
  export function chooseByCost(input: { readonly candidates: readonly Candidate[]; readonly current: string | undefined; readonly workload: Workload; readonly again: number; readonly settings: SwitchingSettings; readonly compaction: Compaction }): CostChoice;
  ```

  `Priced.cost` includes `leaving`. `candidates` come lowest level first.

- [ ] **Step 1: Write the failing tests** in `test/cost.test.ts`. The rates are John's catalog prices per token: `ASTRA = { input: 8e-6, cacheRead: 0.4e-6, output: 40e-6 }`, `SOL = { input: 2e-6, cacheRead: 0.1e-6, output: 10e-6 }`, `TERRA = { input: 1e-6, cacheRead: 0.05e-6, output: 5e-6 }`, `LUNA = { input: 0.1e-6, cacheRead: 0.01e-6, output: 0.5e-6 }`. `warmAstra` is astra with `cached: 150_000, idle: 30`; every other candidate has `cached: 0, idle: undefined`; none compacts. `work(requests, seconds, horizon)` is `{ tokens: 150_000, requests, output: 1_000, growth: 0, seconds, horizon }`; `again` is 0.5. Costs are asserted within 5e-5.

  ```ts
  describe("the spec's worked examples", () => {
    for (const [name, lowest, workload, stay, move, mover, outcome] of [
      ["a MEDIUM prompt, a run of one request", "medium", work(1, 60, 1), 0.1342, 0.2006, "terra", "stayed"],
      ["a MEDIUM prompt, a run of 20 requests over 20 minutes", "medium", work(20, 1200, 1), 2.0342, 0.5122, "terra", "moved"],
      ["a LOW prompt, a run of one request", "low", work(1, 60, 1), 0.1342, 0.0611, "luna", "moved"],
      ["a MEDIUM prompt, one request, the third in a row", "medium", work(1, 60, 3), 0.3342, 0.2256, "terra", "moved"],
    ] as const) test(name, () => { /* candidates from `lowest` up; priced astra.cost === stay, priced[mover].cost === move (leaving 0.0456, 0.1197, 0.0456, 0.0456), outcome, chosen.ref */ });
  });
  describe("survival", () => {
    test("is the chance of the first pair whose seconds are not less than the idle time, and zero past the last", () => {
      for (const [idle, chance] of [[0, 0.97], [60, 0.97], [61, 0.92], [300, 0.92], [301, 0.87], [86_400, 0.11], [86_401, 0], [undefined, 0]] as const) { /* default table */ }
    });
    test("a model whose catalog entry states a lifetime is certain up to it and gone after it", () => { /* survivalOf({ idle: 299, lifetime: 300 }) 1; idle 300 -> 1; idle 301 -> 0; idle 200 with extraSeconds 200 -> 0; lifetime undefined -> the table's; idle undefined -> 0 */ });
  });
  describe("ratesOf", () => {
    test("takes the tier the conversation's size falls in, and the cache-write price where the provider reports writes", () => {
      /* cost { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }] }:
         150_000, false -> { input: 8e-6, cacheRead: 0.4e-6, output: 40e-6 }; 272_000, false -> the same; 272_001, false -> { 16e-6, 0.8e-6, 60e-6 }; 150_000, true -> input 10e-6 */
    });
    test("a model without a price makes the cost unknown", () => {
      /* undefined; all zeros; input 0 with output 5; a negative or non-finite figure: each gives undefined. cacheRead 0 with input 2: cacheRead counts as input (no discount known) */
    });
  });
  describe("chooseByCost", () => {
    test("keeps the current model unless another is cheaper by the margin", () => { /* stay 1.00 against 0.86 -> stayed; against 0.84 -> moved; margin 0 with equal costs -> stayed */ });
    test("takes the cheapest when the current model is not a candidate, the lowest level on a tie", () => { /* current undefined, or a ref not among them: outcome "only", leaving 0 everywhere */ });
    test("a candidate too small for the conversation is priced with the summary and the smaller conversation", () => {
      /* current A = ASTRA rates, cached 180_000, idle 30, compacts false; B = TERRA rates, compacts true; workload { tokens: 200_000, requests: 10, output: 1_000, growth: 1_500, seconds: 120, horizon: 1 }; compaction { summary: 4_000, after: 24_000 }; again 0.5:
         A.cost 1.52264; B.cost 0.62524 with leaving 0.0912; outcome "moved" */
    });
    test("when the current model itself must compact, staying pays for the summary too and leaves nothing behind", () => { /* A compacts true: A.cost = 0.43304 + runCost at 24_000 tokens with nothing cached; A.leaving 0 */ });
  });
  ```

  In `test/cost-sequences.test.ts`, a small simulator in the test file: a clock, and per model the size it has cached and when it last answered. Each step is `[need, requests, seconds]`; the conversation is 150,000 tokens and does not grow; 1,000 output tokens per request; 30 seconds pass between a run's end and the next prompt. Three policies choose a model for a step: `rule` (`chooseByCost` with the horizon and the chance the level is needed again computed from the steps so far, as Task 5 defines them), `high` (always astra) and `follow` (always the needed level's model). A step is charged `runCost` of the model that took it, with what that model had cached; the model then has the whole conversation cached.

  ```ts
  for (const [name, steps] of [
    ["alternating heavy and light prompts", repeat(10, [["super", 5, 300], ["medium", 1, 60]])],
    ["alternating heavy and long lighter runs", repeat(10, [["super", 5, 300], ["medium", 5, 300]])],
    ["a long stretch of lighter work", [["super", 5, 300], ...repeat(12, [["medium", 5, 300]])]],
    ["one light prompt among heavy ones", [...repeat(3, [["super", 5, 300]]), ["low", 1, 60], ...repeat(3, [["super", 5, 300]])]],
    ["a burst of light prompts", [["super", 5, 300], ...repeat(8, [["low", 1, 60]]), ["super", 5, 300]]],
  ] as const) test(`${name}: the rule never costs more than staying high, nor more than following the level by over the margin`, () => {
    /* total(rule) <= total(high) * (1 + 1e-9); total(rule) <= total(follow) * 1.15 */
  });
  test("the first sequence stays on the stronger model throughout, and the second moves each time", () => { /* the models taken: all astra; astra, terra alternating */ });
  ```

- [ ] **Step 2: Run** both files. Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement.**

  `runCost`, with `N = max(1, round(requests * horizon))`, `W = min(cached, tokens)`, `p = survivalOf(candidate, table)`:

  ```
  first   p * (W * cacheRead + (tokens - W) * input) + (1 - p) * tokens * input
  later   for i = 2..N:  (tokens + (i - 2) * growth) * cacheRead + growth * input
  output  N * output tokens * output rate
  ```

  `chooseByCost`, with `c` the current model when it is among the candidates:

  - A candidate that does not compact costs `runCost`. Unless it is `c`, it also carries `leaving = again * (1 - survivalOf(c, table, seconds * horizon)) * min(c.cached, tokens) * (c.input - c.cacheRead)`.
  - A candidate that compacts costs the summary plus `runCost` at `compaction.after` tokens with nothing cached. The summary is one request on `c` (on the candidate itself when there is no `c`): the "first" line above for `c`, plus `compaction.summary * c.output`. Unless it is `c`, it carries `leaving = again * compaction.after * (c.input - c.cacheRead)`.
  - The cheapest total wins, the lowest level on a tie. `c` keeps the run unless the cheapest total is under `c`'s total times `1 - margin`. The outcome is `stayed`, `moved`, or `only` when there is no `c`.

- [ ] **Step 4: Run** both files, then `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** as "Price a run on each adequate model".

---

### Task 5: The session ledger

**Files:**
- Create: `src/ledger.ts`
- Test: `test/ledger.test.ts`

**Interfaces:**
- Consumes: `RUN_DEFAULTS`, `RUNS_KEPT`, `RUNS_NEEDED`, `AGAIN_DEFAULT`, `AGAIN_MIN` (Task 2); `Tier`, `tierRank`; `clampThinkingLevel` and the types `Api`, `Model`, `ModelThinkingLevel`, `Usage` from `@earendil-works/pi-ai`.
- Produces:

  ```ts
  /** A model's last answer on the branch since the conversation was last rewritten. */
  export interface Seen { readonly tokens: number; readonly at: number; readonly effort: string | undefined }
  export interface RunStat { readonly requests: number; readonly output: number; readonly growth: number; readonly seconds: number }
  export interface PromptNeed { readonly need: Tier; readonly took: Tier }
  export interface Answer { readonly ref: string; readonly provider: string; readonly usage: Usage; readonly effort: string | undefined; readonly startedAt: number; readonly at: number }
  export interface Ledger {
    readonly seen: Map<string, Seen>;
    /** Providers whose usage has reported cache writes. */
    readonly writes: Set<string>;
    readonly runs: RunStat[];
    readonly needs: PromptNeed[];
    /** The run under way: its first request's start, its requests and output so far, its first and latest prompt sizes, its latest answer's time. */
    run: { readonly startedAt: number; requests: number; output: number; readonly first: number; last: number; endedAt: number } | undefined;
    /** The latest answer, any model's. */
    latest: { readonly ref: string; readonly tokens: number } | undefined;
  }
  export function newLedger(): Ledger;
  /** The effort a level becomes on a model: Pi's clamp, then the model's own map. */
  export function effortOf(model: Model<Api>, level: ModelThinkingLevel): string;
  export function answerOf(message: { readonly provider: string; readonly model: string; readonly usage: Usage; readonly timestamp?: number; readonly thinkingLevel?: ModelThinkingLevel; readonly providerThinkingLevel?: string }, model: Model<Api> | undefined, at: number): Answer;
  /** An answer that ended without an error: the model's cache, the provider's writes, the run under way. */
  export function noteAnswer(ledger: Ledger, answer: Answer): void;
  /** The same for an answer read back at session start: caches and writes, no run. */
  export function seedAnswer(ledger: Ledger, answer: Answer): void;
  export function noteRunEnd(ledger: Ledger): void;
  export function notePrompt(ledger: Ledger, need: Tier, took: Tier): void;
  /** A compaction or a move in the session tree: no model has the conversation cached. */
  export function forgetCaches(ledger: Ledger): void;
  export function runShape(ledger: Ledger): RunStat;
  export function horizonFor(ledger: Ledger, need: Tier, cap: number): number;
  export function againChance(ledger: Ledger, tier: Tier): number;
  ```

- [ ] **Step 1: Write the failing tests.**

  ```ts
  describe("a model's cache", () => {
    test("is the prompt size of its last answer: input, cached read and cache write, not output", () => { /* usage { input: 20_000, cacheRead: 130_000, cacheWrite: 0, output: 1_000 } -> seen tokens 150_000, at, effort */ });
    test("two accounts with one model id keep separate figures", () => { /* "openai-codex-2/gpt-6-astra" and "openai-codex-3/gpt-6-astra" */ });
    test("is forgotten for every model when the same model's next prompt is smaller: the conversation was rewritten", () => { /* A 150_000, B 151_000, B 40_000 -> seen has only B at 40_000 */ });
    test("is kept when another model's first prompt counts fewer tokens: tokenizers differ", () => { /* A 150_000 then B 120_000 -> both kept */ });
    test("is forgotten for every model by forgetCaches, which keeps the runs and the prompts", () => { /* seen.size 0, latest undefined; runs, needs and writes unchanged */ });
    test("records a provider's cache writes, and ignores an answer without usage", () => { /* cacheWrite 5 -> writes has the provider; all-zero usage -> no Seen, the run still counts the request */ });
  });
  describe("effortOf", () => {
    test("is the level the model maps it to, after Pi's clamp", () => { /* a model with thinkingLevelMap { off: null, minimal: "low", low: "low", medium: "medium", high: "high" }: minimal -> "low", low -> "low", high -> "high", off -> "low" */ });
    test("answerOf prefers the provider's own effort, else maps the recorded level, else knows none", () => { /* providerThinkingLevel "xhigh" with thinkingLevel "low" -> "xhigh"; thinkingLevel "minimal" on that model -> "low"; neither, or no catalog model -> undefined; startedAt is the message's timestamp, else `at` */ });
  });
  describe("the run shape", () => {
    test("is the defaults until three runs have ended", () => { /* deepEqual(runShape(ledger), RUN_DEFAULTS) after 0 and after 2 runs */ });
    test("is the median of each figure over the last ten runs", () => {
      /* three runs: requests 2, 4, 9 -> 4; a run of answers at prompt sizes 100_000, 101_500, 104_000 with outputs 500, 700, 900 started at t and ended at t + 90_000 ms -> RunStat { requests: 3, output: 700, growth: 2_000, seconds: 90 }; an eleventh run drops the first; an even count takes the mean of the middle two */
    });
    test("a run of one request grows by nothing, and seeding counts no run", () => { /* one answer then noteRunEnd -> growth 0; seedAnswer three times then noteRunEnd -> runs is empty */ });
  });
  describe("the horizon and the chance a level is needed again", () => {
    test("the horizon is 1 plus the lighter prompts in a row that stayed on a stronger model, up to the cap", () => {
      /* needs [] -> 1; [{medium, super}, {medium, super}] and need medium -> 3; the same and need low -> 1 (they needed more than low); [{low, super}, {medium, super}] and need medium -> 3; [{medium, medium}, {medium, super}] -> 2; seven such -> 5 */
    });
    test("the chance is the share of the last ten prompts that needed the level or more, 0.5 until three, never under 0.2", () => {
      /* [] -> 0.5; two prompts -> 0.5; needs super, medium, medium, medium for tier super -> 0.25; ten that needed low for tier super -> 0.2; for tier low -> 1 */
    });
  });
  ```

- [ ] **Step 2: Run** `node test/run.mjs test/ledger.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `noteAnswer`: with `tokens = input + cacheRead + cacheWrite`, when `ledger.latest` is the same ref and `tokens` is smaller, clear `seen` first; then, for `tokens > 0`, set `seen` and `latest`; add the provider to `writes` when `cacheWrite > 0`; open the run at `answer.startedAt` if none is open, and add the request, its output, its `tokens` (when above 0) and `answer.at`. `noteRunEnd` turns an open run with at least one request into a `RunStat` (`output` per request; `growth` is `(last - first) / (requests - 1)`, never negative, 0 for one request; `seconds` from `startedAt` to `endedAt`), keeps the last `RUNS_KEPT`, and closes it. `notePrompt` keeps the last ten. `horizonFor` counts back from the latest prompt while an entry's need is at most `need` and it took a level above `need`.

- [ ] **Step 4: Run** the file, then `npm run check`. Expected: PASS.

- [ ] **Step 5: Commit** as "Keep each session's cache, run and prompt figures".

---

### Task 6: Remove the local-only pin

**Files:**
- Delete: `src/pin.ts`, `test/pin.test.ts`
- Modify: `index.ts:15,18,46`, `src/router.ts`, `src/route.ts:45-50,167,348,394`, `src/resolve.ts:71-76,140-142`, `src/selection.ts`, `src/commands.ts`, `src/errors.ts`, `src/jev.ts:152-185`, `src/check.ts:38-50,89,102`, `src/owners.ts`, `src/local.ts:110`, `AGENTS.md:23,31,36`, `README.md` (section "The local-only pin", 1271-1366, and every mention)
- Test: `test/pin-removed.test.ts` (new), and the edits listed in Step 5

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `ResolveContext` without `pinned`; `localOnly` is true exactly for `smart-router/local`; `policy` is always `policyFromRoster(roster)`.
  - `RouteInput` without `pin`; `contextFor(ctx, roster, id, scope?)` and `CommandHost.resolver(ctx, roster, id, scope?)` without a pin argument; `JevGate` without `pinned`; `UnroutableContext` without `pinned`; `TagIgnored` without `"pinned"`.
  - `ENV_PIN` and `PIN_ENTRY` stay in `src/constants.ts`, for the notices only.
  - In `src/errors.ts`:

    ```ts
    /** Said once at session start when PI_SMART_ROUTER_LOCAL_ONLY is set. */
    export function pinEnvNotice(): string;
    /** Said once in a session on smart-router/auto whose latest pin entry says it was pinned. */
    export function pinEntryNotice(): string;
    /** The answer to `/smart-router local ...`, whatever follows. */
    export const PIN_REMOVED: string;
    ```

    with these texts:
    - `pinEnvNotice`: `pi-smart-router: PI_SMART_ROUTER_LOCAL_ONLY is set, but the local-only pin has been removed and keeps nothing local. Select smart-router/local to route locally.`
    - `pinEntryNotice`: `pi-smart-router: an earlier version pinned this session to local models. The pin has been removed and is ignored: smart-router/auto routes by level here. Select smart-router/local to route locally.`
    - `PIN_REMOVED`: `The local-only pin has been removed. To route locally, select the local model: /model smart-router/local`

- [ ] **Step 1: Write the failing tests** in `test/pin-removed.test.ts`, with `test/support/pi.ts`'s fake host:

  ```ts
  test("the environment switch is ignored, with one notice at session start", async (t) => { /* slot.env.on latched from "1": start() -> notices has pinEnvNotice() exactly once; smart-router/auto with a Jev LOW answer routes to the low level's Codex model, not a local one; a second session_start in the process says it again for that session only */ });
  test("an old pin entry is ignored, with one notice", async (t) => { /* session.appendCustom(PIN_ENTRY, { v: 1, on: true, at: NOW, policy: { providers: ["omlx-hera"], hosts: [] } }) before start, selection smart-router/auto: one pinEntryNotice(); routes by level; a second prompt says nothing more; with an entry that says off, or a selection that is not smart-router/auto, no notice */ });
  test("a malformed pin entry is ignored without a notice and without failing", async (t) => { /* data 7, data { on: "yes" } */ });
  test("/smart-router local answers that the pin is gone, whatever follows", async (t) => { /* "local", "local on", "local off", "local status": each returns PIN_REMOVED; no entry is appended; the selection is unchanged */ });
  test("smart-router/local still routes only to the local role, inside the roster's local policy", async (t) => { /* as test/local.test.ts does today, without a pin */ });
  ```

- [ ] **Step 2: Run** `node test/run.mjs test/pin-removed.test.ts`. Expected: FAIL.

- [ ] **Step 3: Remove the pin from `src/`.** Every site, by file:
  - `src/pin.ts`: delete. `src/local.ts`: delete `parsePolicy`, which only the pin used.
  - `src/owners.ts`: keep the slot's shape exactly (`Slot.env.on`, `Slot.env.policy`, `Slot.handoffs`, `isSlot`), because the slot is shared by every loaded copy through `Symbol.for("jwiegley.pi-smart-router.v1")` and an unknown shape fails closed. `env.on` now only records that the variable was set; `env.policy` and `handoffs` are no longer written or read. Say so in their comments. Keep `envSwitchOn` and `latchEnvPin`.
  - `src/router.ts`: remove `pinOf`, `UNPINNED`, `carry`, `latchEnvPolicy`, the pin handoff in `shutdown`, `showStatus`/`showPinStatus` and its `model_select` and `finally` calls, `selectLocal`, and the `pinned` inputs of `planInput`, `scopeRefusal`, `sayResend`, `contextFor`, `prepare`, `activeRoute`, `plan` and `computeLimits`. Add the two notices: `pinEnvNotice()` in `start` when `slot.env.on`; `pinEntryNotice()` once per session (a flag on `Session`), at `start` and at an idle input, whichever comes first with the selection on `smart-router/auto` and `getLatestCustomEntry(PIN_ENTRY, { scope: "active" })` holding a record whose `on` is `true`.
  - `src/route.ts`: remove `Pin` and `RouteInput.pin`; `workUnpinned` becomes "the scope is work"; `settle` passes no `pinned`.
  - `src/resolve.ts`: remove `pinned` and the `PIN_POLICY_CHANGED` check in `resolveCandidate`.
  - `src/selection.ts`: remove `STATUS_PINNED`, `showPinStatus`, `coveredByPin` and the pin argument of `localSelection` and `switchToLocal`; keep what `scopeWork` and the manual-choice rule use. Remove `STATUS_KEY` from `src/constants.ts` if nothing else sets it.
  - `src/commands.ts`: the `local` branch of `run()` returns `PIN_REMOVED` for any option; remove `localOn`, `localOff`, `localStatus`, `earlierRemote`, the unpin questions, the `Pin:` status line and `CommandHost.pinOf`, `selectLocal`, `showStatus`; reword `USAGE`, `LOCAL_IN_WORK`, `LOCAL_IN_ANY` and the last sentence of `egress` so that none mentions the pin.
  - `src/errors.ts`: remove `PIN_POLICY_CHANGED`, `resumeNotice`, `carriedNotice`, `carryFailedNotice`, `TAG_IGNORED.pinned` and the pinned branches of `unroutable`; `historyNotice` says that without the bounded readers the router's models refuse, with no word about a pin.
  - `src/jev.ts`: remove `JevGate.pinned` and its test in `jevAsk`. `src/check.ts`: remove `pinnedLine`; `localLines` loses "pinned or not".
  - Comments that mention the pin in `src/scope.ts`, `src/prompts.ts`, `src/roster.ts`, `src/decide.ts`, `src/records.ts`.

- [ ] **Step 4: Check that nothing is left.** Run `grep -rnE "\bpin\b|\bPin\b|pinned|Pinned|PIN_|unpin" index.ts src`. Expected: only `ENV_PIN`, `PIN_ENTRY`, `latchEnvPin`, `envSwitchOn`, the three notices and their callers, the slot's kept fields, and comments that say the pin was removed.

- [ ] **Step 5: Bring the tests along.** Delete the tests that exist only for the pin; rewrite those that also cover something that stays, keeping every assertion that is not about the pin:
  - Delete: `test/pin.test.ts` (move "a step that fails leaves the others to run", :382, to `test/lifecycle.test.ts`, and "a Pi without bounded history", :468, to `test/route.test.ts` with the new notice text); `test/owners.test.ts` "the environment switch" (:84-146), except the parsing of the variable's values, which stays; `test/selection.test.ts` "a model picked by hand under the pin" (:316-382), :412, :448, "the pin's status item" (:488-513), :544, :559; `test/commands.test.ts` "local" (:281-362) and "local off in work scope" (:838-978); `test/errors.test.ts:205`; `test/jev.test.ts:205`; `test/route.test.ts:268`; `test/router-levels.test.ts:281,298,447`; `test/fallback.test.ts:447,462` and the pinned half of :748; `test/scope.test.ts:314,708,810,943`; the pinned half of `test/cache-optimizer.test.ts:151`; `test/failover.test.ts:275`; `test/unreachable.test.ts:364`; `test/prompts.test.ts:550`; `test/decide.test.ts:231`.
  - Rewrite: `test/commands.test.ts:116,147,451,471,533,560`; `test/errors.test.ts` rows :49-53 and :64-66, :118, :136, :193; `test/check.test.ts:77,98,104`; `test/jev.test.ts:180`; `test/route.test.ts:367,478,519,586,654`; `test/router-levels.test.ts:1324,1744,1807`; `test/fallback.test.ts:652`; `test/scope.test.ts:119,548,644,675,733,767,923`; `test/prompts.test.ts:507-540`; `test/decide.test.ts:404,461`; `test/resolve.test.ts:176-189`.
  - Support: `test/support/pi.ts:36,41,408-421` (`pin`, `unpin`, `pinEntries` go; `appendCustom` serves the new tests); `test/support/host.ts:74,538,655`; the `$comment` of the four roster fixtures that says "and the pin".
  - `test/behaviour.test.ts`: delete scenario 20 (:551), both Q6 scenarios (:818, :866) and L4's "pinned" subtest (:1208); turn L4's `PI_SMART_ROUTER_LOCAL_ONLY` subtest into "the environment switch is ignored, with a notice, and the run goes by level"; in scenarios 6-11 and 26 drop `local on` and keep the manual-choice and compaction assertions; in §5.1 (:889) keep the half without a pin; in L9 (:1634) drop `Pin: off` and the pin sentence of the egress line.

  These line numbers are from `1c01202f`; find each test by its name.

- [ ] **Step 6: Documents.** In `README.md` replace the three pin sections (1271-1366) with one short section, "Routing locally", that says: select `smart-router/local`; the pin of earlier versions is gone; `PI_SMART_ROUTER_LOCAL_ONLY` and old pin entries are ignored with a notice. Remove or reword every other mention (the removal list in the spec's "What is removed"; search for "pin"). Update `AGENTS.md:23,31,36`.

- [ ] **Step 7: Run** `npm run check`, then `npm run check:sandbox`. Expected: both PASS.

- [ ] **Step 8: Commit** as "Remove the local-only pin".

---

### Task 7: Remove the level hold and the fit hold

**Files:**
- Modify: `src/decide.ts` (:1-24, :75-97, :233-249, :276-281, :298-316, :319-372, :374-416, :422-445), `src/roster.ts` (:115, :129, :550, :753), `src/constants.ts:61`, `src/check.ts`, `src/router.ts:649`, `src/records.ts:44,133-137`
- Test: `test/decide.test.ts`, `test/route.test.ts`, `test/fallback.test.ts`, `test/router-levels.test.ts`, `test/roster.test.ts`, `test/roster-v2.test.ts`, `test/check.test.ts`, `test/behaviour.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `Roster` (both versions) without `stickyIdleMinutes`, with `ignored: readonly string[]`: the settings the file gives that this version ignores, by path, in the order `["stickyIdleMinutes", "classifier.closeCall"]`. This task records only the first.
  - `PlanInput` without `held`. `PlanInput.compaction: CompactionFigures` replaces `PlanInput.reserve`:

    ```ts
    export interface CompactionFigures { readonly enabled: boolean; readonly reserve: number; readonly keepRecent: number }
    /** Pi's compaction settings under smart-router/<id>: enabled, the reserve (its modelOverrides entry first) and keepRecentTokens, each Pi's default when unset. */
    export function compactionFor(settings: unknown, id: VirtualId): CompactionFigures;
    ```

    `reserveFor` goes. `fits(p, model)` takes `Pick<PlanInput, "last" | "text" | "now"> & { readonly reserve: number }`.
  - `climb(p, section, start, code, checkFit: boolean)`: with `checkFit` false it is "from `start` upward, the first level with an available candidate".
  - `Plan.code` no longer takes `hold:sticky`, `hold:fit` or `reopen:idle`. `PickOptions.prefer` goes.

- [ ] **Step 1: Write the failing tests.** In `test/decide.test.ts`:

  ```ts
  describe("nothing holds a session by time", () => {
    test("version 1: a run that classifies lower moves down at once, whatever the last response's age", () => { /* last = a thinker response 10 s ago; a trivial prompt -> the trivial role, code "signal:trivial" */ });
    test("version 2: a tagged LOW after a SUPER response 10 s ago goes to LOW", () => { /* code "tag", level.tier "low" */ });
    test("version 2: an untagged run goes to the level Jev gives, lower or higher than the last response's", () => { /* interim rule until Task 8: Jev's top choice, else the keywords' */ });
  });
  describe("a conversation too large for a model", () => {
    test("with compaction enabled, holds nothing and steps up nothing: the run goes to its level and Pi compacts", () => { /* compaction { enabled: true, reserve: 16_384, keepRecent: 20_000 }, last usage 250_000 tokens, tag low, low's window 128_000 -> level.tier "low", steppedUp false */ });
    test("with compaction disabled, a tagged run steps up to the first level whose model fits", () => { /* the same with enabled false -> the first level with a window that fits, code "step-up", steppedUp true */ });
    test("with compaction disabled and no level that fits, the highest available level takes it", () => { /* every window 128_000, last usage 250_000: level.tier "super", code "step-up" */ });
  });
  ```

  In `test/roster-v2.test.ts` and `test/roster.test.ts`: `stickyIdleMinutes: 5` is accepted, is not on the roster, and puts `"stickyIdleMinutes"` in `ignored`; a roster without it has `ignored` empty; `stickyIdleMinutes: -1` is still refused with today's text. In `test/check.test.ts`: the report of a roster that gives it contains `stickyIdleMinutes is accepted and ignored: nothing holds a session on a model by time.` and the report of one that does not, no such line. `compactionFor`: unset settings give `{ enabled: true, reserve: 16_384, keepRecent: 20_000 }`; `compaction: { enabled: false, reserveTokens: 64_000, keepRecentTokens: 5_000, modelOverrides: { "smart-router/auto": { reserveTokens: 8_000 } } }` gives `{ enabled: false, reserve: 8_000, keepRecent: 5_000 }` for `auto` and reserve 64,000 for `local`.

- [ ] **Step 2: Run** the three files. Expected: FAIL.

- [ ] **Step 3: Implement.** In `planUserTurn`'s version 1 path, the role is `rc.roster.routing[signal]` and the pick is `pickInRole(rc, role, { fallback: true, code: \`signal:${signal}\` })`. In `planLevel`, delete the `sticky` block and the retry from the run's own level; the start is the asked level or the risky floor, and `climb` runs once with `checkFit: !p.compaction.enabled`. Delete `tierOf` if nothing else uses it. Rewrite the file's header comment (:1-24) to say what the file does now. In `src/roster.ts`, `minutes(...)` still validates `stickyIdleMinutes` in both versions; the value is dropped and the path recorded. `src/router.ts:649` passes `compaction: compactionFor(pi.getSettings(), id)` and no `held`.

- [ ] **Step 4: Bring the tests along.**
  - Delete, with the hold they tested: `test/decide.test.ts` :97, :103, :108, :113, :130, :634; `test/fallback.test.ts:341`; `test/route.test.ts:429` (keep its part on the reserve as a `compactionFor` test).
  - Rewrite: `test/decide.test.ts` :122, :619, :627, :646, :673, :684 (becomes the compaction-disabled case above), :694, :732, :746, and the property tests at :362 and :815 (no `stickyIdleMinutes`, no hold codes; add the property "with compaction enabled no plan has code `step-up` unless a level had no available candidate"); `test/fallback.test.ts` :359, :369, :388; `test/router-levels.test.ts:1833`.
  - `test/behaviour.test.ts`: L1 (:1088) no longer asserts `hold:sticky`: its second prompt, rated lower, goes to the lower level; L2 (:1132) becomes "a tagged level too small for the conversation is compacted for, not stepped past", asserting a compaction happened before the run's first request and that the tagged level's model answered; add its twin with `compaction: { enabled: false }`, which keeps today's step-up and notice; L9 (:1648, :1666) loses the hold lines.
  - Any integration test whose later untagged prompt rates lower relied on the hold without saying so (`test/behaviour.test.ts:1162` notes one). Each such expectation changes to the lower level, with "nothing holds a session by time" in its message.

- [ ] **Step 5: Run** `npm run check`, then `npm run check:sandbox`. Expected: both PASS.

- [ ] **Step 6: Documents.** Remove the hold and the fit hold from `README.md` (24-26, 201-206, 223, 436-439, 463-464, 512, 684-687, 804, 818-823, 828-833, 852): `stickyIdleMinutes` is described as accepted and ignored.

- [ ] **Step 7: Commit** as "Remove the level hold and the fit hold".

---

### Task 8: The demand decides the needed level

**Files:**
- Modify: `src/decide.ts` (`LevelInput`, `LevelSource`, `PlanLevel`, `PlanInput`, `planLevel`), `src/jev.ts` (:25-34, :108-149, :202-219), `src/tiers.ts` (:29-48), `src/roster.ts` (`classifierSettings` :605-631), `src/records.ts`, `src/commands.ts` (:168-173, :347-357), `src/check.ts`, `src/router.ts` (:617-629, :640-654, :717-792), `src/route.ts` (`boundedHistory` :143-154)
- Test: `test/decide.test.ts`, `test/jev.test.ts`, `test/tiers.test.ts`, `test/router-levels.test.ts`, `test/commands.test.ts`, `test/check.test.ts`, `test/behaviour.test.ts`

**Interfaces:**
- Consumes: `demandOf`, `Demand`, `PromptFacts`, `HEURISTIC_MESSAGES` (Task 3); `RosterV2.demand` (Task 2).
- Produces:

  ```ts
  /** What decided a version 2 run's level: a tag, the blend with Jev's answer, the heuristics alone, or a floor that raised it. */
  export type LevelSource = "tag" | "jev" | "heuristics" | "floor";
  export interface PlanLevel {
    readonly scope: Scope;
    /** The level the prompt needs: its tag's, else its demand's after the guards. */
    readonly need: Tier;
    /** The level whose model takes the run: `need`, or a higher one. */
    readonly tier: Tier;
    readonly source: LevelSource;
    /** The risky operation that raised the run to HIGH. */
    readonly trigger?: RiskyTrigger;
    /** An untagged run's demand. */
    readonly demand?: Demand;
    /** Whether `tier` is above `need` because each level between had no available model, or none that fits with compaction disabled. */
    readonly steppedUp: boolean;
    readonly returnedToFirst: boolean;
    readonly jev?: JevOutcome;
    readonly fallback?: true;
  }
  ```

  `asked` and `start` go. `PlanInput` gains `facts: PromptFacts`. `JevOutcome`'s answer loses `tier`; `interpret(result, model, ms)` and `JevSettings` lose `closeCall`; `closeCallTier` and `keywordTier` go from `src/tiers.ts`. `Roster.ignored` records `"classifier.closeCall"` when the file gives it. In `src/route.ts`:

  ```ts
  /** The branch's entry count from Pi's history metrics, where this Pi has them. */
  export function activeEntries(sessionManager: unknown): number | undefined;
  ```

  The record (`LevelRecord`, still `v: 1`) writes `need` where it wrote `asked`, writes `source` with the new values, and gains `demand?: Demand`. `readLevelRecord` also accepts the earlier `source: "keyword"` and a record with `asked` and no `need` (its `need` is its `tier`).

  The footer and the history note:

  ```ts
  /** "tag"; else "demand 1.3", then ", jev timeout" when Jev was asked and gave no answer, then ", floor" when a floor raised the level. */
  export function levelNote(level: PlanLevel): string;
  /** `${scope} ${LABEL of need} → ${modelId} (${levelNote}${fallback ? "; fallback" : ""})` */
  export function footerText(level: PlanLevel, modelId: string, fallback?: boolean): string;
  ```

- [ ] **Step 1: Write the failing tests.** In `test/decide.test.ts`, with `facts` `FRESH` unless stated and the 80% tables of Task 3:

  ```ts
  describe("the needed level", () => {
    test("is the blend's when Jev answers", () => { /* SUPER + "go ahead": level.need "super", source "jev", demand.value 2.23 within 0.01, demand.guards ["close-call"]; LOW + "go ahead": "low" */ });
    test("is the heuristics' when Jev fails or was not asked", () => { /* jev failure "timeout" + PLANNING: need "high" (2.02), source "heuristics", level.jev is the failure; no jev at all + "fix the typo in the README": "low" */ });
    test("is raised by the risky floor and by a very deep session, and says so", () => { /* LOW + "git rm the build directory": need "high", source "floor", trigger "destructive-git"; LOW + "continue" with facts { contextTokens: 150_000, roles: 20, entries: 400 }: need "medium", source "floor", no trigger */ });
    test("is the tag's for a tagged run, which has no demand", () => { /* tag low + a risky text: need "low", source "tag", demand undefined */ });
  });
  ```

  In `test/router-levels.test.ts`: the footer tests at :1804 keep their prompts and answers, and their strings become, in the file's order: `personal HIGH → gpt-6.1-sol (tag)` unchanged; `personal MEDIUM → gpt-6.1-terra (demand 0.9, jev timeout)`; `personal HIGH → gpt-6.1-sol (demand 1.6)`; for "go ahead again" with 45% MEDIUM and 40% HIGH, `personal MEDIUM → gpt-6.1-terra (demand 1.3)` (an unsure Jev no longer takes the higher of two close leaders; the blend is 1.31); for "rename foo to bar" with no LOW model available, `personal LOW → gpt-6.1-terra (demand 0.4)` beside the step-up notice; the held case goes with the hold; without a classifier, `personal MEDIUM → gpt-6.1-terra (demand 0.9)`; for "force push the branch" with a LOW answer, `personal HIGH → gpt-6.1-sol (demand 0.7, floor)`; in work scope, `work LOW → gpt-6-luna (demand 0.5)`. `personal LOW → z-ai/glm-5.3-flash (tag; fallback)` is unchanged. Add:

  ```ts
  test("the heuristics read one bounded window of the conversation, shared with Jev's context", async (t) => { /* a session with 30 messages: getRecentActiveEntries is called once per planned prompt with { type: "message", limit: 24 } (4 x the classifier's 6 messages, at least 20); with classifier.context.messages 0 the limit is 20 and Jev's request carries no recent turns */ });
  test("a tagged run reads no window", async (t) => { /* "x #high": getRecentActiveEntries is not called with type "message" during the input */ });
  test("an earlier version's record still reads", async (t) => { /* appendCustom(LEVEL_ENTRY, { v: 1, at: NOW, scope: "personal", source: "keyword", tier: "high", asked: "medium", keyword: { signal: "default", reason: "triage:x" } }): start() does not fail, and /smart-router was low appends a correction that refers to it */ });
  test("a run's record holds its demand and no prompt text", async (t) => { /* the record's demand equals the plan's; JSON.stringify of the level entries holds no MARK, as at :1781 */ });
  ```

  In `test/jev.test.ts`: the answer has no `tier`; `interpret` takes three arguments. In `test/check.test.ts`: `classifier.closeCall is accepted and ignored: demand.closeCall decides a close call.` appears when the roster gives it.

- [ ] **Step 2: Run** the changed files. Expected: FAIL.

- [ ] **Step 3: Implement the level.** In `planLevel`: a tag gives `need` and source `tag`. Otherwise `demandOf({ text: p.text, planning: signal === "planning", risky: riskyTrigger(p.text) !== undefined, jev: p.level?.jev, facts: p.facts }, rc.roster.demand)` gives `need = demand.tier`; the source is `floor` when the guards include `risky` or `deep-session`, else `jev` when Jev answered, else `heuristics`; `trigger` is set when the guard `risky` is among them. `climb` then runs from `need`.

- [ ] **Step 4: Gather the facts in `src/router.ts`.** In `planInput`, for an untagged idle input on `smart-router/auto` under a version 2 roster in a scope that reads, read the window once: `history.getRecentActiveEntries({ type: "message", limit: Math.max(4 * messages, HEURISTIC_MESSAGES) })`, where `messages` is the classifier's `context.messages`, or 0 without a classifier. `askFor` takes those entries instead of reading its own; the facts take the last `HEURISTIC_MESSAGES` of them: each entry's `message.role`, with `toolResult` as `tool`. `contextTokens` is `calculateContextTokens(record.last.usage)` when there is a usage; `entries` is `activeEntries(sessionManager)`. An extension's resend, which reuses its message's level, reads the window again for its own facts. `plan()` passes `facts`; a tagged run passes `{ contextTokens, roles: [], entries }`.

- [ ] **Step 5: The record, the footer, the history line and the status.** `levelRecord` writes `need` and `demand`; `describeEntry` (commands.ts:168) keeps its form with the new note; `classifierLine` (:347) no longer shows `closeCall`. Remove `closeCallTier`, `keywordTier` and their tests.

- [ ] **Step 6: Bring the tests along.** Every test that expected the keywords' level for an untagged run without a Jev answer now expects the heuristics' (Task 3's table gives the values: a planning prompt in a fresh session is HIGH, not SUPER; a complex one MEDIUM unless its demand reaches 1.4). Every test that built a `PlanLevel` literal with `asked` and `start` (`TAGGED_HIGH` at `test/router-levels.test.ts:51` and its like) uses `need`. In `test/behaviour.test.ts`, L8's footer becomes `personal HIGH → gpt-6.1-sol (demand 0.7, floor)` and the level block's other footers follow the same rule.

- [ ] **Step 7: Run** `npm run check`, then `npm run check:sandbox`. Expected: both PASS.

- [ ] **Step 8: Commit** as "Take a prompt's level from its demand".

---

### Task 9: Choose the model by cost

**Files:**
- Modify: `src/decide.ts`, `src/roster.ts` (a helper beside `roleOf`), `src/route.ts:375-379` (`levelFor`)
- Test: `test/choose.test.ts` (new), `test/decide.test.ts`

**Interfaces:**
- Consumes: `chooseByCost`, `ratesOf`, `Candidate`, `Workload`, `Priced` (Task 4); `Ledger`, `effortOf`, `runShape`, `horizonFor`, `againChance` (Task 5); `SUMMARY_TOKENS`, `RosterV2.switching` (Task 2); `CompactionFigures`, `climb`, `fits` (Task 7).
- Produces, in `src/roster.ts`:

  ```ts
  /** The thinking level a role sends: its fixed one, or the selected one. */
  export function roleLevel(roster: Roster, roleName: string, selected: Level): Level;
  ```

  (`levelFor` in `src/route.ts` now calls it.) In `src/decide.ts`:

  ```ts
  /** What the cost rule reads of the session. */
  export interface CostFigures { readonly ledger: Ledger; readonly thinking: ModelThinkingLevel }
  export type CostTerms =
    | { readonly outcome: "unknown"; readonly why: "no usage yet" | "no price" | "the clock went backwards" }
    | { readonly outcome: "stayed" | "moved" | "only"; readonly chosen: string; readonly priced: readonly Priced[]; readonly workload: Workload; readonly again: number };
  export interface Chosen { readonly tier: Tier; readonly decision: Decision; readonly steppedUp: boolean; readonly cost?: CostTerms }
  export function chooseModel(input: { readonly rc: ResolveContext; readonly section: ScopeSection; readonly need: Tier; readonly code: string; readonly last: LastResponder | undefined; readonly promptTokens: number; readonly compaction: CompactionFigures; readonly figures: CostFigures | undefined; readonly priced: boolean }): Chosen;
  ```

  `PlanInput` gains `figures?: CostFigures` beside the `compaction` it has since Task 7. `PlanLevel` gains `cost?: CostTerms`.

- [ ] **Step 1: Write the failing tests** in `test/choose.test.ts`. The catalog is `v2Catalog`-like with John's prices on the personal level models (`model(ASTRA, { contextWindow: 272_000, cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 } })`, sol 2/10/0.1/2.5, terra 1/5/0.05/1.25, luna 0.1/0.5/0.01/0.125); the roster is `roster-hera-v2-fallback.json`; `last` is an astra response 30 s before `rc.now` with usage `{ input: 0, cacheRead: 149_000, cacheWrite: 0, output: 1_000 }`; the ledger has astra seen at 149,000 tokens then, effort `high`, and three ended runs of one request, 1,000 output tokens, no growth, 60 s; `thinking` is `high`; `promptTokens` 0.

  ```ts
  describe("with the needed level's own model available", () => {
    test("a MEDIUM prompt on a warm astra stays there when the run is short", () => { /* need medium: decision.choice.ref is astra, tier "super", steppedUp false, cost.outcome "stayed", cost.chosen astra, cost.priced lists terra, sol, astra with their tiers */ });
    test("and moves to terra when lighter prompts keep coming", () => { /* ledger.needs = two { need: medium, took: super }: horizon 3 -> terra, tier "medium", outcome "moved" */ });
    test("a run that needs more than the current model moves up at once, to the cheapest adequate model", () => { /* last = a terra response, need super: astra, outcome "only" */ });
    test("a current model that is not one of the scope's level models is no candidate and leaves nothing behind", () => { /* last = openrouter/z-ai/glm-5.3-flash: outcome "only", every leaving 0 */ });
  });
  describe("missing figures", () => {
    test("no usage yet: the needed level's own model, and the cost is unknown", () => { /* last undefined -> terra for need medium, cost { outcome: "unknown", why: "no usage yet" } */ });
    test("a model without a price makes the cost unknown", () => { /* sol's cost all zero -> why "no price", the pick is the needed level's own */ });
    test("a clock that went backwards makes the cost unknown", () => { /* astra seen 5 s after rc.now */ });
    test("no figures at all: today's resolution, and no cost", () => { /* figures undefined -> climb's pick, cost undefined */ });
  });
  describe("a change of effort zeroes the cached size", () => {
    test("the selected level differs from the level of the model's last answer", () => { /* thinking "low" (effort "low" on astra) against seen effort "high": astra's cached is 0 in cost.priced and it no longer keeps a short MEDIUM run */ });
    test("two levels the model maps to one effort leave it alone", () => { /* astra's thinkingLevelMap sends minimal and low to "low": seen effort "low", thinking "minimal" -> cached 149_000 */ });
    test("a role that fixes its level is priced at that level, whatever is selected", () => { /* the roster's super role with thinking "high", selected "low": cached counts */ });
    test("an answer whose effort is not known counts as the same effort", () => { /* seen effort undefined */ });
  });
  describe("the needed level without a model of its own", () => {
    test("goes to the scope's chain, then up, as before, with no cost", () => { /* terra cooling: need medium -> the chain's first model, fallback code, cost undefined */ });
  });
  describe("a conversation larger than a candidate's window", () => {
    test("with compaction enabled the candidate stays, priced with a summary on the current model", () => { /* terra's window 128_000, last usage 200_000 tokens on astra: priced terra has compacts true; with ten-request runs in the ledger terra wins */ });
    test("with compaction disabled it is no candidate, and a needed level that does not fit steps up", () => { /* need medium -> sol (window 272_000), steppedUp true, code "step-up", cost undefined */ });
  });
  describe("a tagged run", () => {
    test("is never priced", () => { /* priced false: the tagged level's first available model, cost undefined */ });
  });
  ```

- [ ] **Step 2: Run** `node test/run.mjs test/choose.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `chooseModel`.**

  1. Without figures, or with `priced` false: `climb` from `need`, with `checkFit` when `compaction.enabled` is false. Return its level, decision and `steppedUp`.
  2. The candidates: for each level from `need` up, `pickInRole(rc, section.levels[level].role, { fallback: false, code })`; a level whose pick fails is skipped, and so is one whose model the conversation does not fit while compaction is disabled; a model already taken by a lower level is skipped. The conversation is `calculateContextTokens(last.usage) + promptTokens`.
  3. When the first candidate is not at `need`: as in 1.
  4. Missing figures, in this order: no `last.usage` or a conversation of 0 tokens ("no usage yet"); a candidate for which `ratesOf(model.cost, tokens, ledger.writes.has(provider))` is undefined ("no price"); a candidate seen after `rc.now` ("the clock went backwards"). Then the decision is the candidate at `need`, with `cost: { outcome: "unknown", why }`.
  5. Otherwise build each `Candidate`: `cached` is the ledger's size for that model, at most the conversation, and 0 when the model's last effort is known and differs from `effortOf(model, roleLevel(roster, role, figures.thinking))`; `idle` is the seconds since it was seen; `lifetime` is the catalog entry's `promptCache.short`, else its `promptCache.long`, when that is a positive number; `compacts` is "compaction is enabled and the conversation does not fit". The workload is `runShape(ledger)` with the conversation's size and `horizonFor(ledger, need, switching.horizonCap)`. The current model is `last.ref` when it is a candidate; `again` is `againChance(ledger, its level)`, or `AGAIN_DEFAULT` without one. The compaction is `{ summary: SUMMARY_TOKENS, after: compaction.keepRecent + SUMMARY_TOKENS }`.
  6. `chooseByCost` gives the model; the decision is that level's pick, and `cost` carries the outcome, the priced list, the workload and `again`.

  `planLevel` calls `chooseModel` with `priced: tag === undefined` and `promptTokens: estimateTokens` of the prompt, and puts `cost` in the level. Until Task 10 the router passes no figures, so nothing changes in a running session.

- [ ] **Step 4: Run** `npm run check`, then `npm run check:sandbox`. Expected: both PASS.

- [ ] **Step 5: Commit** as "Choose among adequate models by expected cost".

---

### Task 10: Feed the ledger, and plan by cost

**Files:**
- Modify: `src/route.ts` (`SessionRecord` :115-140, `routeOwned` :410-437), `src/router.ts` (`responder`/`seed` :415-434, `seedLevel` :436-446, `start` :558-591, `plan` :640-654, `planInput` :785-791, `messageEnd` :835-867, `settle` :875-884, `wire` :992-1062), `src/records.ts`, `src/commands.ts` (`statusText` :374-400), `src/errors.ts`
- Test: `test/router-cost.test.ts` (new), `test/router-levels.test.ts`, `test/commands.test.ts`, `test/lifecycle.test.ts`

**Interfaces:**
- Consumes: `newLedger`, `answerOf`, `noteAnswer`, `seedAnswer`, `noteRunEnd`, `notePrompt`, `forgetCaches` (Task 5); `CostFigures`, `CostTerms` (Task 9).
- Produces: `SessionRecord` gains `readonly ledger: Ledger`, `need: Tier | undefined` (the level the session's last planned run needed; it replaces `levelRole`) and `runTier: Tier | undefined` (the level whose model the run under way is on). The record gains `cost`. The footer note gains the cost phrase:

  ```ts
  /** After the demand: "; stayed, $0.10 vs $0.16" (the current model against the cheapest other), "; moved, $0.63 vs $2.00" (the chosen model against the current one), "; cost unknown", or nothing. */
  export function costNote(cost: CostTerms | undefined): string;
  /** The terms behind a level, for /smart-router status: the demand line and the cost line. */
  export function decisionLines(level: PlanLevel): string[];
  ```

  Money is `$` and two decimals. `decisionLines` gives, for an untagged level with a known cost, two lines of this form (the figures here are an illustration):

  ```
    Demand 1.32 → MEDIUM: Jev 1.05 at 80%, heuristics 1.32 (turn_type 0.09, token_shortness 0.06, no_tool_context 0.06).
    Cost of 5 requests, horizon 1: gpt-6-astra $0.42 (149,000 cached, 97%); gpt-6.1-terra $0.31 (nothing cached; leaving gpt-6-astra $0.05).
  ```

  The demand line ends with `; floors: risky, deep-session` when floors applied, and says `no Jev answer (timeout)` in place of the Jev term when there was none. The cost line lists the candidates the stronger first, marks one that compacts with `, after a compaction`, and is `Cost unknown: <why>.` for an unknown cost. A tagged level gives no lines.

- [ ] **Step 1: Write the failing tests** in `test/router-cost.test.ts`, with the priced catalog of Task 9 and `hera`-like helpers copied from `test/router-levels.test.ts`:

  ```ts
  describe("the ledger's feed", () => {
    test("each answer that ends without an error is noted, with its effort; an aborted or failed one is not", async (t) => { /* message_end with thinkingLevel "high" -> record.ledger.seen has the ref at input+cacheRead+cacheWrite; stopReason "aborted" and "error" leave it unchanged */ });
    test("a run's shape is noted when the agent settles", async (t) => { /* three runs through say/firstRequest/finish -> record.ledger.runs.length 3 */ });
    test("a compaction and a move in the tree forget every cache", async (t) => { /* host.emit("session_compact", ...) and ("session_tree", ...) */ });
    test("a resumed session keeps its model's cache", async (t) => { /* session.appendAssistant of an astra response 30 s ago before start(): after start the ledger has astra seen, and a short MEDIUM prompt stays on astra */ });
    test("seeding stops at a rewrite: a response before a smaller prompt of the same model is not counted", async (t) => { /* branch: terra at 90_000, astra at 150_000, astra at 30_000 -> after start the ledger has only astra, at 30_000 */ });
  });
  describe("a planned run", () => {
    test("stays on the warm stronger model for a short lighter prompt, and the footer says so", async (t) => { /* after three one-request SUPER runs on astra: footer `personal MEDIUM → gpt-6-astra (demand 1.0; stayed, $0.13 vs $0.20)`; the history entry's level has need "medium", tier "super" */ });
    test("moves at the first lighter prompt while the session's runs are long: the default shape is five requests", async (t) => { /* one SUPER run, then a MEDIUM prompt: terra, "moved" */ });
    test("moves down when lighter prompts keep coming, and says what it compared", async (t) => { /* the third in a row: `personal MEDIUM → gpt-6.1-terra (demand 1.0; moved, $0.23 vs $0.33)` */ });
    test("says the cost is unknown on a session's first prompt", async (t) => { /* `personal MEDIUM → gpt-6.1-terra (demand 1.0; cost unknown)` */ });
    test("counts each prompt's need and the level it took", async (t) => { /* record.ledger.needs after two prompts; record.need */ });
    test("a hand-picked model is never priced or moved", async (t) => { /* selection = a physical model: no plan, no footer, the ledger still notes its answers */ });
    test("a work session never leaves the work account, whatever the prices", async (t) => { /* work scope: every candidate's provider is the work-bound alias */ });
  });
  describe("what the session records and shows", () => {
    test("the record gains the cost terms and holds no prompt text", async (t) => { /* the level entry's cost has outcome, chosen, requests, horizon, again and one row per candidate; JSON.stringify of the entries holds no MARK */ });
    test("/smart-router status shows the terms of the last decision", async (t) => { /* the two decisionLines after "Last decision:" */ });
  });
  ```

  The exact dollar figures are those `chooseByCost` gives for the test's own ledger; compute them in the test from `runCost` rather than copying these.

- [ ] **Step 2: Run** `node test/run.mjs test/router-cost.test.ts`. Expected: FAIL.

- [ ] **Step 3: Feed the ledger.** `newRecord()` makes a ledger. `messageEnd`: after the existing success path, `noteAnswer(record.ledger, answerOf(message, ctx.modelRegistry.find(message.provider, message.model), now()))`; never for an error or an abort. `settle`: `noteRunEnd`, and clear `runTier`. `wire`: `session_compact` and `session_tree` call `forgetCaches` for the session's record, guarded like the other handlers. `start`: the entries `seed` already reads become answers, oldest first, through `seedAnswer`, each with its entry's time; `seedLevel` returns the latest record's `need` (or `tier` for an earlier version's record) into `record.need`.

- [ ] **Step 4: Plan with figures.** `plan()` passes `figures: { ledger: record.ledger, thinking: pi.getThinkingLevel() }` beside the compaction figures it already passes. When the run's first request consumes a plan with a level (`routeOwned`), `notePrompt(record.ledger, level.need, level.tier)`, `record.need = level.need` and `record.runTier = level.tier`. `levelRole` goes: `levelToReturnTo` keeps today's rule (a run without a prompt, on a model of the scope's chain, returns to its level) by reading `record.need` and the scope's role for it. Task 11 replaces that rule.

- [ ] **Step 5: Show it.** `levelNote` appends `costNote(level.cost)`; `levelRecord` writes `cost` (the outcome, and for a known cost the chosen ref, `requests`, `horizon`, `again` and per candidate `ref`, `tier`, `cost`, `leaving`, `cached`, `survival`, `compacts`); `statusText` prints `decisionLines` of the last history entry's level under "Last decision:".

- [ ] **Step 6: Bring the tests along.** Tests that set or read `levelRole` use `need`. The catalogs of the existing suites carry no prices, so their runs have an unknown cost: their footers gain `; cost unknown` only where the session already had a usage. Update those strings.

- [ ] **Step 7: Run** `npm run check`, then `npm run check:sandbox`. Expected: both PASS.

- [ ] **Step 8: Commit** as "Feed the ledger and plan each run by cost".

---

### Task 11: Runs without a prompt, and a stuck run

**Files:**
- Create: `src/stuck.ts`
- Modify: `src/route.ts` (`RouteInput` :163-169, `routeOwned` :410-437), `src/router.ts` (`prepare` :361-371, `api.routeOwned` :965-978), `src/errors.ts`
- Test: `test/stuck.test.ts` (new), `test/route.test.ts`, `test/fallback.test.ts`, `test/router-cost.test.ts`

**Interfaces:**
- Consumes: `chooseModel`, `climb` behaviour through it, `CostFigures` (Task 9); `record.need`, `record.runTier` (Task 10).
- Produces:

  ```ts
  // src/stuck.ts
  export const STUCK_FAILURES = 3;
  export const STUCK_CHARS = 256;
  /** Whether the run's last three tool results all failed, with one tool and one text: the same first STUCK_CHARS characters. */
  export function stuck(messages: readonly unknown[]): boolean;
  ```

  `RouteInput` gains `figures: CostFigures | undefined` and `compaction: CompactionFigures`. `SessionRecord` gains `escalated: boolean`, cleared when the agent settles. In `src/errors.ts`: `escalationNotice(from: Tier, to: Tier, modelId: string): string`, which reads `pi-smart-router: this run's last three tool calls failed the same way, so it moves up from MEDIUM to HIGH (gpt-6.1-sol).`

  History codes: `run:need` for a run without a prompt, `escalate` for the move up.

- [ ] **Step 1: Write the failing tests.** In `test/stuck.test.ts`, with messages in Pi's shape (`{ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp }`):

  ```ts
  test("three failed results in a row with one tool and one text are a stuck run", () => { /* user, assistant, fail(bash, "No such file"), assistant, fail(bash, "No such file"), assistant, fail(bash, "No such file") -> true */ });
  test("three failures that differ are ordinary work", () => { /* different texts; different tools; one success among them; only two; each -> false */ });
  test("only the first 256 characters of the text are compared", () => { /* equal up to 256, different after -> true; different at character 200 -> false */ });
  test("only the run under way counts: results before the latest user message do not", () => { /* two failures, a user message, one failure -> false */ });
  test("results of one assistant message count one by one, and anything that is not a message is passed over", () => { /* three parallel failed calls -> true; undefined, 7, {} among the messages do not throw */ });
  ```

  In `test/router-cost.test.ts`:

  ```ts
  describe("a run that starts without a prompt", () => {
    test("takes the level its session last needed, through the same choice", async (t) => { /* a planned MEDIUM run settles on terra; a custom run's first request (reason "continuation", no plan, no run pick) with terra cooling goes to the chain; with terra back, to terra, code "run:need" */ });
    test("stays on a warm stronger model when that is cheaper, as a prompt's run would", async (t) => { /* three one-request runs on astra, need medium recorded, then a custom run: astra, code "run:need" */ });
    test("a session that never planned a run sticks to its last responder, as before", async (t) => { /* record.need undefined */ });
  });
  describe("escalation", () => {
    test("a stuck run moves up one level, once, with a notice", async (t) => { /* a MEDIUM run on terra; a continuation whose messages end in three identical failures routes to sol; the notice is escalationNotice("medium", "high", "gpt-6.1-sol"); record.runTier "high"; a further continuation with three more failures stays on sol */ });
    test("a run at SUPER, a tagged run, smart-router/local and a version 1 roster are never escalated", async (t) => { /* each: a continuation whose messages end in three identical failures routes to the run's own model, and no notice is shown */ });
    test("the next run starts from its own level again", async (t) => { /* escalated cleared at agent_settled */ });
    test("when the level above has no available model the run goes on to the next, as a step-up would", async (t) => { /* sol cooling: the escalation reaches the chain or astra by climb's rules */ });
  });
  ```

  Rewrite the two tests that assert `return:level` (`test/fallback.test.ts:610,652`) to the rule above: the code is `run:need`.

- [ ] **Step 2: Run** the files. Expected: FAIL.

- [ ] **Step 3: Implement `stuck`.** Walk the messages from the end; stop at a message whose role is `user`; collect messages whose role is `toolResult`, newest first, until three; all three need `isError === true`, one `toolName`, and one text, where the text is the `text` blocks of `content` joined with a newline and cut to `STUCK_CHARS`. Upstream compares a hash of those characters; comparing the characters themselves is the same test without the hash.

- [ ] **Step 4: Route.** In `routeOwned`, on `smart-router/auto` under a version 2 roster:
  - No plan, not a retry, no run pick yet, and `record.need` set (this replaces `levelToReturnTo`, which goes): `chooseModel({ rc, section, need: record.need, code: "run:need", last: record.last, promptTokens: 0, compaction: input.compaction, figures: input.figures, priced: true })`; then `notePrompt`, `record.runTier`, as for a plan.
  - A continuation with a run pick, `record.runTier` below `super`, `record.escalated` false, the run's level not from a tag, and `stuck(request.messages)`: `chooseModel` at the level above `record.runTier` with `code: "escalate"` and `priced: false`. When it gives a model other than the run's, that is the decision; `record.escalated = true` and `record.runTier` is its level.
  `prepare` fills `figures` with the session's ledger and the request's own thinking level, and `compaction` from Pi's settings. `api.routeOwned` shows `escalationNotice` when the decision's code is `escalate`, beside the notice it already shows for a move onto the chain.

- [ ] **Step 5: Run** `npm run check`, then `npm run check:sandbox`. Expected: both PASS.

- [ ] **Step 6: Commit** as "Route promptless runs by need, and move a stuck run up".

---

### Task 12: Behaviour in Pi's runtime

**Files:**
- Modify: `test/support/host.ts` (`FauxModel` :150-155, `response` :959, `RosterJsonV2` :592), `test/behaviour.test.ts` (append)

**Interfaces:**
- Consumes: everything above, through Pi's own runtime.
- Produces: `FauxModel` gains `cost?` (a model's own price, over its spec's); `response(faux, init)` accepts `usage?: Partial<Usage>` and `thinkingLevel?`. A fleet helper `pricedLevelsFleet(limits?)` gives the personal and work level models John's prices and windows of 272,000, unless `limits` gives a model another.

- [ ] **Step 1: Append the scenarios**, each a top-level `test` named `C<n> ...` with `TIMEOUT`, built like L1-L10:

  1. `C1 a heavier prompt moves up at once` (Jev LOW then Jev SUPER: luna, then astra).
  2. `C2 a lighter prompt stays on the warm stronger model when runs are short, and the footer shows the two costs` (three SUPER prompts answered in one request each first: with fewer than three runs the default shape of five requests applies, and the move pays).
  3. `C3 lighter prompts in a row move down, and the session then stays down` (continuing C2's start: the third MEDIUM prompt goes to terra; the fourth stays on terra).
  4. `C4 a tag goes to its level whatever the costs`.
  5. `C5 a conversation too large for the cheaper model is compacted before the move` (a history of 200,000 tokens on astra, a fleet in which terra's window is 128,000, and a MEDIUM prompt: exactly one compaction, its summary request answered by astra, then the run's request by terra).
  6. `C6 with compaction disabled there is no such move: the run goes to the first level that fits`.
  7. `C7 three identical failed tool calls move the run up one level, with a notice` (the faux model calls `read` on a missing path three times; the fourth request is answered by the level above).
  8. `C8 three different failures do not` (three different missing paths).
  9. `C9 a version 2 roster without demand or switching routes with the defaults` (the fixture as it is).
  10. `C10 a version 1 roster moves at every prompt its keywords say to, with no hold`.
  11. `C11 a work session never leaves the work account` (every provider called is the work alias, across a LOW, a SUPER and an escalation).
  12. `C12 no request is added to a prompt: one Jev call and one model call per planned one-request run` (counts from `world.jev.calls` and `world.counts()`).
  13. `C13 a session an earlier version pinned routes by level, with one notice` (a prebuilt history that holds a `smart-router.pin` entry saying on).

  The environment switch has its scenario since Task 6 (L4); do not repeat it.

- [ ] **Step 2: Run** `npm run check:sandbox`. Expected: PASS, with the thirteen new tests listed. A scenario that cannot be built as described is reported, not reshaped into something that passes.

- [ ] **Step 3: Commit** as "Cover demand and cost switching in Pi's runtime".

---

### Task 13: The review script

**Files:**
- Create: `scripts/review-demand.ts`, `test/fixtures/session-review.jsonl`
- Modify: `tsconfig.json` (`include` gains `scripts/**/*.ts`)
- Test: `test/review.test.ts`

**Interfaces:**
- Consumes: `demandOf`, `tierOfDemand` (Task 3); `DEFAULT_DEMAND` (Task 2); `classify`, `riskyTrigger`.
- Produces:

  ```ts
  export interface ReviewRow { readonly at: number; readonly truth: Tier; readonly truthFrom: "tag" | "correction"; readonly heuristics: Tier; readonly jev: Tier | undefined; readonly blend: Tier; readonly took: Tier }
  export interface Review { readonly rows: readonly ReviewRow[]; readonly judged: number; readonly agree: { readonly heuristics: number; readonly jev: number; readonly blend: number }; readonly unjudged: number }
  /** Replays one session file's recorded runs. Reads the file's lines; contacts nothing. */
  export function reviewSession(lines: Iterable<string>, settings: DemandSettings): Review;
  ```

  Run as `node --experimental-strip-types scripts/review-demand.ts <session.jsonl>...`: it prints, per file and in total, how many runs had a truth (a tag, or a later `/smart-router was` correction that refers to the run), and how often the heuristics alone, Jev's top choice alone and the blend gave that level. It prints no prompt text.

- [ ] **Step 1: Write the fixture and the failing test.** `test/fixtures/session-review.jsonl` is a hand-written session of six entries chains (`id`, `parentId`, `timestamp`, `type`): user messages with invented text, assistant messages with usage, three `smart-router.level` records (one tagged `high`, one untagged with Jev probabilities and a later correction to `low`, one untagged without either), and the correction. The test asserts `judged` 2, `unjudged` 1, each row's four levels, and that the printed report contains none of the fixture's prompt texts.

- [ ] **Step 2: Run** `node test/run.mjs test/review.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** A run's prompt is the latest user message before its record on the record's parent chain; its facts are the latest assistant usage before that prompt, the roles of up to 20 messages before it, and the count of entries before it. The script takes paths only from its arguments, never a default directory.

- [ ] **Step 4: Run** `npm run check`. Expected: PASS. Do not run the script on any real session: that waits for John's word.

- [ ] **Step 5: Commit** as "Add the demand review script".

---

### Task 14: Documents, version and the release gates

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `AGENTS.md`, `package.json:3`, `package-lock.json`, `test/package.test.ts:39,106`

- [ ] **Step 1: README.** Rewrite "Levels" (788) and "Routing in detail" (649) for demand and cost: the blend with its defaults, the guards, the candidates, the cost formula in words with the spec's four worked examples, cache survival, the effort rule, compaction before a move, runs without a prompt, escalation. Add the two sections to "Fields in version 2" (507) and to "Changing the routing" (539), with the JSON of the spec's "Roster additions" at the plan's values. "Records and training" (1367) names the new record fields and the review script, and says the script runs on John's sessions only at his word. "Commands" (1419) loses `local on|off|status`. Say plainly, where the deep-session floor is described, that with the default floor a conversation over 100,000 tokens never routes to LOW.

- [ ] **Step 2: CHANGELOG.** A `## [1.4.0-jw.5] - <date of the release>` entry in the form of the jw.4 entry: Added (demand, cost choice, ledger, escalation, the two roster sections, the review script, the vendored scoring), Changed (levels from the blend; `stickyIdleMinutes` and `classifier.closeCall` accepted and ignored; compaction before a move), Removed (the pin, the level hold, the fit hold), and the decisions John took on 2026-11-18 in his words from the spec.

- [ ] **Step 3: AGENTS.md.** The rule on the classifier's one request no longer says "never under the pin"; add that `scripts/` holds development scripts that never run in a session and that `scripts/review-demand.ts` reads only the files it is given.

- [ ] **Step 4: Version.** `1.4.0-jw.5` in `package.json`, `package-lock.json` (both places) and `test/package.test.ts:39,106`.

- [ ] **Step 5: Run** `npm run check`, then `npm run check:sandbox`. Expected: both PASS; the pack check names `1.4.0-jw.5` and ships `src/settings.ts`, `src/demand.ts`, `src/cost.ts`, `src/ledger.ts`, `src/stuck.ts`, `src/triage/tier-features.ts`, `src/triage/types.ts` and no file under `scripts/`.

- [ ] **Step 6: Commit** as "Document demand and cost switching, as 1.4.0-jw.5".

- [ ] **Step 7: The mutant check.** In a copy of the worktree, not this clone: run `npm run check` once as the control and confirm it passes there. Then apply at least 30 single mutations across `src/demand.ts`, `src/cost.ts`, `src/ledger.ts`, `src/stuck.ts` and `chooseModel` in `src/decide.ts` (a flipped comparison, an off-by-one, a dropped guard, a swapped price, a removed floor, a wrong default), running `npm run check` for each. Report each as caught, missed, skipped or broken. Every missed mutant gets a test in this clone, committed as "Cover <what the mutant showed>", before the work is called done.

- [ ] **Step 8: Stop.** Nothing is pushed or tagged. Report the branch's commits, the two gates' last lines and the mutant table.

---

## Held for John

**Thinking effort by turn type.** John chose "Yes, as upstream does" on 2026-11-18, and the same day the design found that a change of effort discards the cache on his ChatGPT-account models. The spec's "Thinking effort" has the evidence and his three choices. No task here changes the effort a request is sent with. When he rules, that part is planned and built on top of this branch.

**Every push, tag and activation** needs John's word at that time, as does a run of the review script on his sessions.
