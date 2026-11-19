// What a run of requests costs on each model that could take it, counting what each model has in
// its prompt cache and how likely that cache still exists, and the choice among those costs.
//
// Pure: every figure, time included, is passed in. Nothing here reads a clock or Pi's registry;
// the caller turns a catalog price into `Rates` with `ratesOf` and hands over the sizes and idle
// times it knows.
import type { SurvivalTable, SwitchingSettings } from "./settings.ts";
import type { Tier } from "./tiers.ts";
import { tierRank } from "./tiers.ts";

/** Dollars per token at the conversation's size. `input` is what uncached input costs. */
export interface Rates {
  readonly input: number;
  readonly cacheRead: number;
  readonly output: number;
}

/** A catalog price: dollars per million tokens, with Pi's request-wide tiers. */
export interface CatalogCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly tiers?:
    | ReadonlyArray<{
        readonly inputTokensAbove: number;
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite: number;
      }>
    | undefined;
}

export interface Candidate {
  readonly ref: string;
  readonly tier: Tier;
  readonly rates: Rates;
  /** Tokens of the conversation this model has cached. */
  readonly cached: number;
  /** Seconds since its last answer; undefined when it has none. */
  readonly idle: number | undefined;
  /** The cache lifetime in seconds its catalog entry states, when it states one. */
  readonly lifetime?: number | undefined;
  /** Whether Pi compacts before this model takes the conversation. */
  readonly compacts: boolean;
}

/** The coming work: the conversation's size and the shape of the run, priced `horizon` runs deep. */
export interface Workload {
  readonly tokens: number;
  readonly requests: number;
  readonly output: number;
  readonly growth: number;
  readonly seconds: number;
  readonly horizon: number;
}

/**
 * What a compaction leaves: the summary's size, the conversation's size after it, and what it keeps
 * of the conversation as it is (Pi's keepRecentTokens), which its summary does not read.
 */
export interface Compaction {
  readonly summary: number;
  readonly after: number;
  readonly keep: number;
}

export interface Priced {
  readonly ref: string;
  readonly tier: Tier;
  /** Includes `leaving`. */
  readonly cost: number;
  /** What leaving the current model costs, already in `cost`; zero for the current model itself. */
  readonly leaving: number;
  /**
   * The candidate's cached size and its chance of surviving; both 0 for one that compacts, whose
   * cost uses neither.
   */
  readonly cached: number;
  readonly survival: number;
  readonly compacts: boolean;
}

export interface CostChoice {
  readonly chosen: Priced;
  readonly priced: readonly Priced[];
  readonly outcome: "stayed" | "moved" | "only";
}

/** The chance of the first pair whose seconds are not less than the idle time; zero past the last pair or with no answer. */
export function survival(table: SurvivalTable, idleSeconds: number | undefined): number {
  if (idleSeconds === undefined || !Number.isFinite(idleSeconds)) return 0;
  for (const [seconds, chance] of table) if (seconds >= idleSeconds) return chance;
  return 0;
}

/** A candidate's chance: 1 up to a stated lifetime and 0 after it; else the table's. `extraSeconds` is idle time still to come. */
export function survivalOf(candidate: Pick<Candidate, "idle" | "lifetime">, table: SurvivalTable, extraSeconds = 0): number {
  if (candidate.idle === undefined) return 0;
  // A negative idle time gets the table's first chance, or 1 with a lifetime. It is never priced:
  // chooseModel (decide.ts) rejects a model seen after now as a clock that went backwards.
  const idle = candidate.idle + extraSeconds;
  if (candidate.lifetime !== undefined) return idle <= candidate.lifetime ? 1 : 0;
  return survival(table, idle);
}

/** A figure that is a finite number above zero. */
export function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * The per-token rates at a conversation of `tokens`: the catalog's request-wide tier the size
 * falls in (the one with the highest `inputTokensAbove` below it), and, where the provider
 * reports cache writes, the cache-write price as the uncached input price. A price that is
 * missing, zero for input or output, negative or not finite is no price at all: undefined, never
 * free. A cache-read price of zero is not a discount anyone has stated, so it counts as input.
 */
export function ratesOf(cost: CatalogCost | undefined, tokens: number, writes: boolean): Rates | undefined {
  if (cost === undefined) return undefined;
  let level: Pick<CatalogCost, "input" | "output" | "cacheRead" | "cacheWrite"> = cost;
  let above = -Infinity;
  for (const tier of cost.tiers ?? []) {
    if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > above) {
      level = tier;
      above = tier.inputTokensAbove;
    }
  }
  if (!positive(level.input) || !positive(level.output) || !nonNegative(level.cacheRead)) return undefined;
  const input = writes && positive(level.cacheWrite) ? level.cacheWrite : level.input;
  if (!positive(input)) return undefined;
  const cacheRead = level.cacheRead > 0 ? level.cacheRead : level.input;
  return { input: input / 1e6, cacheRead: cacheRead / 1e6, output: level.output / 1e6 };
}

/** The first request of a run on a model: its cache, if it survives, at the read price; the rest at the input price. */
function firstRequest(candidate: Candidate, tokens: number, table: SurvivalTable): number {
  const { input, cacheRead } = candidate.rates;
  const warm = Math.min(Math.max(candidate.cached, 0), tokens);
  const p = survivalOf(candidate, table);
  return p * (warm * cacheRead + (tokens - warm) * input) + (1 - p) * tokens * input;
}

/** The expected cost of `workload` on a candidate that keeps the conversation as it is. */
export function runCost(candidate: Candidate, workload: Workload, table: SurvivalTable): number {
  const { tokens, growth } = workload;
  const { input, cacheRead, output } = candidate.rates;
  const requests = Math.max(1, Math.round(workload.requests * workload.horizon));
  const later = requests - 1;
  // For i = 2..N: (tokens + (i - 2) * growth) * cacheRead + growth * input, summed.
  const laterCost = later * tokens * cacheRead + growth * cacheRead * ((later * (later - 1)) / 2) + later * growth * input;
  return firstRequest(candidate, tokens, table) + laterCost + requests * workload.output * output;
}

/**
 * Prices the run on each candidate and picks one. The cheapest total takes the run, the lowest
 * level on a tie; the current model keeps it unless the cheapest saves more than the margin.
 * `candidates` come lowest level first and are not empty.
 */
export function chooseByCost(input: {
  readonly candidates: readonly Candidate[];
  readonly current: string | undefined;
  readonly workload: Workload;
  readonly again: number;
  readonly settings: SwitchingSettings;
  readonly compaction: Compaction;
}): CostChoice {
  const { candidates, workload, again, settings, compaction } = input;
  if (candidates.length === 0) throw new Error("chooseByCost needs at least one candidate");
  const table = settings.cacheSurvival;
  const current = input.current === undefined ? undefined : candidates.find((candidate) => candidate.ref === input.current);

  const priced = candidates.map((candidate): Priced => {
    const stays = candidate === current;
    let cost: number;
    let leaving = 0;
    if (candidate.compacts) {
      // The summary is one request on the current model (on the candidate when there is none). Pi
      // writes it with a request of its own that no cache serves (its own system prompt, the
      // serialized conversation, no cache retention), so its input is the conversation less what
      // the compaction keeps, at the uncached input price, and its output the summary's size. That
      // input is an upper bound, since Pi shortens long tool results before it sends them, and it
      // errs toward staying; the reasoning a summary may add, the wait and what it loses are not
      // priced. The run then starts on the smaller conversation with nothing cached.
      const writer = current ?? candidate;
      const summary = Math.max(0, workload.tokens - compaction.keep) * writer.rates.input + compaction.summary * writer.rates.output;
      const fresh: Candidate = { ...candidate, cached: 0, idle: undefined };
      cost = summary + runCost(fresh, { ...workload, tokens: compaction.after }, table);
      if (current !== undefined && !stays) {
        leaving = again * compaction.after * (current.rates.input - current.rates.cacheRead);
      }
    } else {
      cost = runCost(candidate, workload, table);
      if (current !== undefined && !stays) {
        const gone = 1 - survivalOf(current, table, workload.seconds * workload.horizon);
        leaving = again * gone * Math.min(Math.max(current.cached, 0), workload.tokens) * (current.rates.input - current.rates.cacheRead);
      }
    }
    return {
      ref: candidate.ref,
      tier: candidate.tier,
      cost: cost + leaving,
      leaving,
      cached: candidate.compacts ? 0 : candidate.cached,
      survival: candidate.compacts ? 0 : survivalOf(candidate, table),
      compacts: candidate.compacts,
    };
  });

  let cheapest = priced[0]!;
  for (const entry of priced) {
    if (entry.cost < cheapest.cost || (entry.cost === cheapest.cost && tierRank(entry.tier) < tierRank(cheapest.tier))) cheapest = entry;
  }
  if (current === undefined) return { chosen: cheapest, priced, outcome: "only" };
  const stayed = priced.find((entry) => entry.ref === current.ref)!;
  if (cheapest.cost < stayed.cost * (1 - settings.margin)) return { chosen: cheapest, priced, outcome: "moved" };
  return { chosen: stayed, priced, outcome: "stayed" };
}
