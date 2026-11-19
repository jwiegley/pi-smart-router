// What a session knows about each model's prompt cache, the shape of its recent runs and the level
// each recent prompt needed. Pure: it reads no clock and no file, every time and figure comes in.
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

import { AGAIN_DEFAULT, AGAIN_MIN, RUN_DEFAULTS, RUNS_KEPT, RUNS_NEEDED } from "./settings.ts";
import { tierRank } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** A model's last answer on the branch since the conversation was last rewritten. */
export interface Seen {
  readonly tokens: number;
  readonly at: number;
  readonly effort: string | undefined;
}

/** One run's figures: requests, output tokens per request, prompt growth per request, seconds. */
export interface RunStat {
  readonly requests: number;
  readonly output: number;
  readonly growth: number;
  readonly seconds: number;
}

/** The level a prompt needed, and the level whose model answered it. */
export interface PromptNeed {
  readonly need: Tier;
  readonly took: Tier;
}

export interface Answer {
  readonly ref: string;
  readonly provider: string;
  readonly usage: Usage;
  readonly effort: string | undefined;
  readonly startedAt: number;
  readonly at: number;
}

export interface Ledger {
  readonly seen: Map<string, Seen>;
  /** Providers whose usage has reported cache writes. */
  readonly writes: Set<string>;
  readonly runs: RunStat[];
  readonly needs: PromptNeed[];
  /**
   * The run under way: its first request's start, its requests and output so far, its first and
   * latest prompt sizes, its latest answer's time, and how many of its requests came before the
   * last compaction or move in the tree (its growth is measured only over the answers after one).
   */
  run:
    | { readonly startedAt: number; requests: number; output: number; readonly first: number; last: number; endedAt: number; readonly before: number }
    | undefined;
  /** The latest answer, any model's. */
  latest: { readonly ref: string; readonly tokens: number } | undefined;
}

export function newLedger(): Ledger {
  return { seen: new Map(), writes: new Set(), runs: [], needs: [], run: undefined, latest: undefined };
}

/** The effort a level becomes on a model: Pi's clamp, then the model's own map. */
export function effortOf(model: Model<Api>, level: ModelThinkingLevel): string {
  const clamped = clampThinkingLevel(model, level);
  const mapped = model.thinkingLevelMap?.[clamped];
  return typeof mapped === "string" ? mapped : clamped;
}

export function answerOf(
  message: {
    readonly provider: string;
    readonly model: string;
    readonly usage: Usage;
    readonly timestamp?: number;
    readonly thinkingLevel?: ModelThinkingLevel;
    readonly providerThinkingLevel?: string;
  },
  model: Model<Api> | undefined,
  at: number,
): Answer {
  const effort =
    message.providerThinkingLevel ?? (message.thinkingLevel !== undefined && model !== undefined ? effortOf(model, message.thinkingLevel) : undefined);
  return {
    ref: `${message.provider}/${message.model}`,
    provider: message.provider,
    usage: message.usage,
    effort,
    startedAt: message.timestamp ?? at,
    at,
  };
}

const USAGE_FIGURES = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

/**
 * Whether a usage's figures are all numbers that can be counted: finite and not negative. A usage
 * with any other figure (undefined, NaN, infinite, negative, not a number) is no usage at all: the
 * ledger records nothing from it, and the cost rule treats the session as having none yet.
 */
export function usable(usage: unknown): usage is Usage {
  if (typeof usage !== "object" || usage === null) return false;
  const figures = usage as Record<string, unknown>;
  return USAGE_FIGURES.every((key) => {
    const value = figures[key];
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  });
}

function promptTokens(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** The model's cache and the provider's writes; returns the prompt size this answer reported. */
function remember(ledger: Ledger, answer: Answer): number {
  const tokens = promptTokens(answer.usage);
  if (tokens > 0) {
    if (ledger.latest?.ref === answer.ref && tokens < ledger.latest.tokens) ledger.seen.clear();
    ledger.seen.set(answer.ref, { tokens, at: answer.at, effort: answer.effort });
    ledger.latest = { ref: answer.ref, tokens };
  }
  if (answer.usage.cacheWrite > 0) ledger.writes.add(answer.provider);
  return tokens;
}

/** An answer that ended without an error: the model's cache, the provider's writes, the run under way. Nothing from a usage that is not numbers. */
export function noteAnswer(ledger: Ledger, answer: Answer): void {
  if (!usable(answer.usage)) return;
  const tokens = remember(ledger, answer);
  // A run whose first answers reported no usage takes its first prompt size from the first that did.
  const open = ledger.run ?? { startedAt: answer.startedAt, requests: 0, output: 0, first: tokens, last: tokens, endedAt: answer.at, before: 0 };
  ledger.run = {
    startedAt: open.startedAt,
    requests: open.requests + 1,
    output: open.output + answer.usage.output,
    first: open.first === 0 ? tokens : open.first,
    last: tokens > 0 ? tokens : open.last,
    endedAt: answer.at,
    before: open.before,
  };
}

/** The same for an answer read back at session start: caches and writes, no run. */
export function seedAnswer(ledger: Ledger, answer: Answer): void {
  if (!usable(answer.usage)) return;
  remember(ledger, answer);
}

export function noteRunEnd(ledger: Ledger): void {
  const run = ledger.run;
  if (run === undefined) return;
  ledger.run = undefined;
  if (run.requests < 1) return;
  const steps = run.requests - run.before - 1;
  ledger.runs.push({
    requests: run.requests,
    output: run.output / run.requests,
    growth: steps > 0 ? Math.max(0, (run.last - run.first) / steps) : 0,
    seconds: Math.max(0, (run.endedAt - run.startedAt) / 1_000),
  });
  if (ledger.runs.length > RUNS_KEPT) ledger.runs.splice(0, ledger.runs.length - RUNS_KEPT);
}

export function notePrompt(ledger: Ledger, need: Tier, took: Tier): void {
  ledger.needs.push({ need, took });
  if (ledger.needs.length > RUNS_KEPT) ledger.needs.splice(0, ledger.needs.length - RUNS_KEPT);
}

/**
 * A compaction or a move in the session tree: no model has the conversation cached. A run under way
 * keeps its requests, output and time, and measures its growth again from the next answer.
 */
export function forgetCaches(ledger: Ledger): void {
  ledger.seen.clear();
  ledger.latest = undefined;
  const { run } = ledger;
  if (run !== undefined) ledger.run = { ...run, first: 0, last: 0, before: run.requests };
}

/**
 * A move in the session tree to another leaf: no model has that branch cached, and the runs and
 * prompts, which are counted on the branch, start afresh. Whether a provider reports cache writes is
 * a fact about the provider, and stays.
 */
export function forgetBranch(ledger: Ledger): void {
  ledger.seen.clear();
  ledger.latest = undefined;
  ledger.runs.length = 0;
  ledger.needs.length = 0;
  ledger.run = undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const high = sorted[middle] ?? 0;
  return sorted.length % 2 === 1 ? high : ((sorted[middle - 1] ?? high) + high) / 2;
}

export function runShape(ledger: Ledger): RunStat {
  if (ledger.runs.length < RUNS_NEEDED) return RUN_DEFAULTS;
  const kept = ledger.runs.slice(-RUNS_KEPT);
  return {
    requests: median(kept.map((run) => run.requests)),
    output: median(kept.map((run) => run.output)),
    growth: median(kept.map((run) => run.growth)),
    seconds: median(kept.map((run) => run.seconds)),
  };
}

/** 1 plus the lighter prompts in a row, latest first, that stayed on a stronger model, up to the cap. */
export function horizonFor(ledger: Ledger, need: Tier, cap: number): number {
  const wanted = tierRank(need);
  let streak = 0;
  for (let i = ledger.needs.length - 1; i >= 0; i--) {
    const entry = ledger.needs[i];
    if (entry === undefined || tierRank(entry.need) > wanted || tierRank(entry.took) <= wanted) break;
    streak += 1;
  }
  return Math.min(cap, 1 + streak);
}

/** The chance a prompt needs this level or more: its share of the last prompts, AGAIN_DEFAULT with too few, never under AGAIN_MIN. */
export function againChance(ledger: Ledger, tier: Tier): number {
  const recent = ledger.needs.slice(-RUNS_KEPT);
  if (recent.length < RUNS_NEEDED) return AGAIN_DEFAULT;
  const wanted = tierRank(tier);
  const share = recent.filter((entry) => tierRank(entry.need) >= wanted).length / recent.length;
  return Math.max(AGAIN_MIN, share);
}
