// The settings that decide how the router weighs a prompt and when it moves a session to another
// model: their types, their defaults and the fixed figures the pure modules share. The roster's
// optional `demand` and `switching` sections (src/roster.ts) override the defaults; the checker
// (src/check.ts) reads them back. This module imports nothing of Pi's and reads no clock, so the
// standalone checker can reach it.
import { DEFAULT_LOW_INTENSITY_WEIGHTS } from "./triage/tier-features.ts";
import type { LowIntensityWeights } from "./triage/tier-features.ts";
import type { Tier } from "./tiers.ts";

/** The heuristic signals, in upstream's order; a weight is given for each. */
export const SIGNALS = [
  "prompt_shortness",
  "token_shortness",
  "cyclomatic_low",
  "trivial_signal",
  "complex_inverse",
  "triage_verdict",
  "turn_type",
  "no_tool_context",
  "message_shallow",
  "prose_ratio",
  "requirement_low",
  "cluster_signal",
] as const satisfies ReadonlyArray<keyof LowIntensityWeights>;

/** Pairs of [seconds idle, chance the model's cache survives that long]: the seconds rise, the chances fall from 1 to 0. */
export type SurvivalTable = ReadonlyArray<readonly [seconds: number, chance: number]>;

export interface DemandSettings {
  /** What Jev's answer and the heuristics each count for, at full confidence. */
  readonly jevWeight: number;
  readonly heuristicsWeight: number;
  /** Under this confidence in Jev's answer, the heuristics can only raise the level. */
  readonly minConfidence: number;
  /** A demand within this of a cut takes the level above. */
  readonly closeCall: number;
  /** The demand under which the level is low, medium and high; from the third cut it is super. */
  readonly cuts: readonly [number, number, number];
  /** The lowest level for a conversation over DEEP_SESSION_TOKENS tokens or DEEP_SESSION_ENTRIES entries. */
  readonly deepSessionFloor: Tier;
  readonly weights: LowIntensityWeights;
}

export interface SwitchingSettings {
  /** A move must cost more than this share less than staying: chooseByCost (src/cost.ts) stays at exactly this share. */
  readonly margin: number;
  /** How many lighter prompts in a row are priced ahead, at most. */
  readonly horizonCap: number;
  readonly cacheSurvival: SurvivalTable;
}

/** Upstream's weights, except that the two signals nothing computes here carry none. */
export const DESIGN_WEIGHTS: LowIntensityWeights = { ...DEFAULT_LOW_INTENSITY_WEIGHTS, requirement_low: 0, cluster_signal: 0 };

export const DEFAULT_DEMAND: DemandSettings = {
  jevWeight: 4,
  heuristicsWeight: 1,
  minConfidence: 0.6,
  closeCall: 0.1,
  cuts: [0.75, 1.5, 2.25],
  deepSessionFloor: "medium",
  weights: DESIGN_WEIGHTS,
};

export const DEFAULT_SWITCHING: SwitchingSettings = {
  margin: 0.15,
  horizonCap: 5,
  cacheSurvival: [
    [60, 0.97],
    [300, 0.92],
    [1200, 0.87],
    [1800, 0.79],
    [3600, 0.66],
    [7200, 0.5],
    [21_600, 0.38],
    [86_400, 0.11],
  ],
};

/**
 * A conversation over this many tokens, or with this many entries in its active context (Pi counts
 * them from the last compaction), is never under the deep-session floor.
 */
export const DEEP_SESSION_TOKENS = 100_000;
export const DEEP_SESSION_ENTRIES = 1_000;

/** The shape of a run when fewer than RUNS_NEEDED earlier runs are known. */
export const RUN_DEFAULTS = { requests: 5, output: 800, growth: 1_500, seconds: 120 } as const;
/** How many earlier runs are kept, and how many are needed before they replace RUN_DEFAULTS. */
export const RUNS_KEPT = 10;
export const RUNS_NEEDED = 3;

/** The chance the current level is needed again: its share of the kept runs, AGAIN_DEFAULT with too few, never under AGAIN_MIN. */
export const AGAIN_DEFAULT = 0.5;
export const AGAIN_MIN = 0.2;

/**
 * The size assumed for a compaction's summary: its output tokens, and its share of the conversation
 * after it.
 */
export const SUMMARY_TOKENS = 4_000;
