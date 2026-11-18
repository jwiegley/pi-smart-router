import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { chooseByCost, ratesOf, runCost, survival, survivalOf } from "../src/cost.ts";
import type { Candidate, CatalogCost, Compaction, Rates, Workload } from "../src/cost.ts";
import { DEFAULT_SWITCHING } from "../src/settings.ts";
import { tierRank, TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";

const TABLE = DEFAULT_SWITCHING.cacheSurvival;
const TOLERANCE = 5e-5;

const ASTRA: Rates = { input: 8e-6, cacheRead: 0.4e-6, output: 40e-6 };
const SOL: Rates = { input: 2e-6, cacheRead: 0.1e-6, output: 10e-6 };
const TERRA: Rates = { input: 1e-6, cacheRead: 0.05e-6, output: 5e-6 };
const LUNA: Rates = { input: 0.1e-6, cacheRead: 0.01e-6, output: 0.5e-6 };

const MODELS: ReadonlyArray<readonly [ref: string, tier: Tier, rates: Rates]> = [
  ["luna", "low", LUNA],
  ["terra", "medium", TERRA],
  ["sol", "high", SOL],
  ["astra", "super", ASTRA],
];

const NO_COMPACTION: Compaction = { summary: 4_000, after: 24_000 };

function candidate(ref: string, tier: Tier, rates: Rates, over: Partial<Candidate> = {}): Candidate {
  return { ref, tier, rates, cached: 0, idle: undefined, compacts: false, ...over };
}

function warmAstra(): Candidate {
  return candidate("astra", "super", ASTRA, { cached: 150_000, idle: 30 });
}

/** The candidates from `lowest` up, lowest first, with astra the warm current model. */
function from(lowest: Tier): Candidate[] {
  return MODELS.filter(([, tier]) => tierRank(tier) >= tierRank(lowest)).map(([ref, tier, rates]) =>
    ref === "astra" ? warmAstra() : candidate(ref, tier, rates),
  );
}

function work(requests: number, seconds: number, horizon: number): Workload {
  return { tokens: 150_000, requests, output: 1_000, growth: 0, seconds, horizon };
}

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < TOLERANCE, `${message}: ${actual} is not within ${TOLERANCE} of ${expected}`);
}

function priceOf(choice: ReturnType<typeof chooseByCost>, ref: string) {
  const found = choice.priced.find((entry) => entry.ref === ref);
  assert.ok(found, `${ref} is priced`);
  return found;
}

describe("the spec's worked examples", () => {
  for (const [name, lowest, workload, stay, move, mover, leaving, outcome] of [
    ["a MEDIUM prompt, a run of one request", "medium", work(1, 60, 1), 0.1342, 0.2006, "terra", 0.0456, "stayed"],
    ["a MEDIUM prompt, a run of 20 requests over 20 minutes", "medium", work(20, 1200, 1), 2.0342, 0.5122, "terra", 0.1197, "moved"],
    ["a LOW prompt, a run of one request", "low", work(1, 60, 1), 0.1342, 0.0611, "luna", 0.0456, "moved"],
    ["a MEDIUM prompt, one request, the third in a row", "medium", work(1, 60, 3), 0.3342, 0.2256, "terra", 0.0456, "moved"],
  ] as const) {
    test(name, () => {
      const choice = chooseByCost({
        candidates: from(lowest),
        current: "astra",
        workload,
        again: 0.5,
        settings: DEFAULT_SWITCHING,
        compaction: NO_COMPACTION,
      });
      near(priceOf(choice, "astra").cost, stay, `${name}: staying on astra`);
      assert.equal(priceOf(choice, "astra").leaving, 0, `${name}: the current model leaves nothing behind`);
      near(priceOf(choice, mover).cost, move, `${name}: moving to ${mover}`);
      near(priceOf(choice, mover).leaving, leaving, `${name}: what leaving astra costs`);
      assert.equal(choice.outcome, outcome, `${name}: the outcome`);
      assert.equal(choice.chosen.ref, outcome === "stayed" ? "astra" : mover, `${name}: the model chosen`);
    });
  }

  test("each candidate's cost is its run plus its leaving", () => {
    const choice = chooseByCost({
      candidates: from("medium"),
      current: "astra",
      workload: work(1, 60, 1),
      again: 0.5,
      settings: DEFAULT_SWITCHING,
      compaction: NO_COMPACTION,
    });
    for (const entry of choice.priced) {
      const source = from("medium").find((c) => c.ref === entry.ref)!;
      near(entry.cost, runCost(source, work(1, 60, 1), TABLE) + entry.leaving, `${entry.ref}: Priced.cost includes leaving`);
    }
  });
});

describe("survival", () => {
  test("is the chance of the first pair whose seconds are not less than the idle time, and zero past the last", () => {
    for (const [idle, chance] of [
      [0, 0.97],
      [60, 0.97],
      [61, 0.92],
      [300, 0.92],
      [301, 0.87],
      [86_400, 0.11],
      [86_401, 0],
      [undefined, 0],
    ] as const) {
      assert.equal(survival(TABLE, idle), chance, `idle ${String(idle)} seconds`);
    }
  });

  test("a model whose catalog entry states a lifetime is certain up to it and gone after it", () => {
    assert.equal(survivalOf({ idle: 299, lifetime: 300 }, TABLE), 1, "idle 299, lifetime 300");
    assert.equal(survivalOf({ idle: 300, lifetime: 300 }, TABLE), 1, "idle 300, lifetime 300: still certain");
    assert.equal(survivalOf({ idle: 301, lifetime: 300 }, TABLE), 0, "idle 301, lifetime 300");
    assert.equal(survivalOf({ idle: 200, lifetime: 300 }, TABLE, 200), 0, "idle 200 and 200 more is past 300");
    assert.equal(survivalOf({ idle: 200, lifetime: 300 }, TABLE, 100), 1, "idle 200 and 100 more is 300");
    assert.equal(survivalOf({ idle: 30, lifetime: undefined }, TABLE), 0.97, "no stated lifetime uses the table");
    assert.equal(survivalOf({ idle: 30 }, TABLE, 300), 0.87, "extra seconds count against the table");
    assert.equal(survivalOf({ idle: undefined, lifetime: 300 }, TABLE), 0, "no answer yet: nothing cached");
    assert.equal(survivalOf({ idle: undefined }, TABLE), 0, "no answer yet and no lifetime");
  });
});

describe("ratesOf", () => {
  const priced: CatalogCost = {
    input: 8,
    output: 40,
    cacheRead: 0.4,
    cacheWrite: 10,
    tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
  };

  test("takes the tier the conversation's size falls in, and the cache-write price where the provider reports writes", () => {
    const base = { input: 8e-6, cacheRead: 0.4e-6, output: 40e-6 };
    const upper = { input: 16e-6, cacheRead: 0.8e-6, output: 60e-6 };
    const same = (actual: Rates | undefined, expected: Rates, message: string): void => {
      assert.ok(actual, `${message}: priced`);
      near(actual.input * 1e6, expected.input * 1e6, `${message}: input`);
      near(actual.cacheRead * 1e6, expected.cacheRead * 1e6, `${message}: cacheRead`);
      near(actual.output * 1e6, expected.output * 1e6, `${message}: output`);
    };
    same(ratesOf(priced, 150_000, false), base, "150,000 tokens");
    same(ratesOf(priced, 272_000, false), base, "exactly at the tier's edge is still the base price");
    same(ratesOf(priced, 272_001, false), upper, "one token past the edge");
    near((ratesOf(priced, 150_000, true) ?? { input: NaN }).input * 1e6, 10, "cache writes reported: input is the write price");
    near((ratesOf(priced, 300_000, true) ?? { input: NaN }).input * 1e6, 20, "cache writes in the upper tier");
    same(ratesOf({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, tiers: undefined }, 150_000, false), base, "tiers undefined");
  });

  test("a model without a price makes the cost unknown", () => {
    assert.equal(ratesOf(undefined, 1000, false), undefined, "no cost at all");
    assert.equal(ratesOf({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 1000, false), undefined, "all zeros");
    assert.equal(ratesOf({ input: 0, output: 5, cacheRead: 0, cacheWrite: 0 }, 1000, false), undefined, "free input");
    assert.equal(ratesOf({ input: 2, output: 0, cacheRead: 0, cacheWrite: 0 }, 1000, false), undefined, "free output");
    assert.equal(ratesOf({ input: -1, output: 5, cacheRead: 0, cacheWrite: 0 }, 1000, false), undefined, "negative input");
    assert.equal(ratesOf({ input: 2, output: 5, cacheRead: -1, cacheWrite: 0 }, 1000, false), undefined, "negative cache read");
    assert.equal(ratesOf({ input: Number.NaN, output: 5, cacheRead: 0, cacheWrite: 0 }, 1000, false), undefined, "NaN input");
    assert.equal(ratesOf({ input: 2, output: Number.POSITIVE_INFINITY, cacheRead: 0, cacheWrite: 0 }, 1000, false), undefined, "infinite output");
    assert.equal(
      ratesOf({ input: 2, output: 5, cacheRead: 1, cacheWrite: 0, tiers: [{ inputTokensAbove: 10, input: 0, output: 5, cacheRead: 1, cacheWrite: 0 }] }, 1000, false),
      undefined,
      "an unpriced tier the conversation falls in",
    );
    const noDiscount = ratesOf({ input: 2, output: 5, cacheRead: 0, cacheWrite: 0 }, 1000, false);
    assert.ok(noDiscount, "a zero cache-read price with a real input price is priced");
    near(noDiscount.cacheRead * 1e6, 2, "a zero cache-read price counts as input: no discount is known");
    const withWrites = ratesOf({ input: 2, output: 5, cacheRead: 0, cacheWrite: 2.5 }, 1000, true);
    assert.ok(withWrites, "a zero cache-read price with cache writes reported is priced");
    near(withWrites.input * 1e6, 2.5, "writes reported: uncached input is the write price");
    near(withWrites.cacheRead * 1e6, 2, "writes reported: a zero cache-read price counts at the catalog's input price, not the write price");
  });
});

describe("chooseByCost", () => {
  /** Two candidates with fixed total costs: output only, one request, nothing cached or leaving. */
  function twoAt(stay: number, other: number, over: { margin?: number } = {}) {
    const rate = (dollars: number): Rates => ({ input: 1e-9, cacheRead: 1e-9, output: dollars / 1_000 });
    // With no conversation tokens only output counts: 1,000 tokens at `dollars / 1000` each.
    const workload: Workload = { tokens: 0, requests: 1, output: 1_000, growth: 0, seconds: 0, horizon: 1 };
    return chooseByCost({
      candidates: [candidate("low-model", "medium", rate(other)), candidate("high-model", "super", rate(stay))],
      current: "high-model",
      workload,
      again: 0.5,
      settings: { ...DEFAULT_SWITCHING, margin: over.margin ?? 0.15 },
      compaction: NO_COMPACTION,
    });
  }

  test("keeps the current model unless another is cheaper by the margin", () => {
    const stayed = twoAt(1.0, 0.86);
    near(priceOf(stayed, "high-model").cost, 1.0, "the current model's cost");
    near(priceOf(stayed, "low-model").cost, 0.86, "the other's cost");
    assert.equal(stayed.outcome, "stayed", "0.86 against 1.00 is not 15% cheaper");
    assert.equal(stayed.chosen.ref, "high-model", "stayed on the current model");
    const moved = twoAt(1.0, 0.84);
    assert.equal(moved.outcome, "moved", "0.84 against 1.00 is cheaper by more than 15%");
    assert.equal(moved.chosen.ref, "low-model", "moved to the cheaper model");
    const equal = twoAt(1.0, 1.0, { margin: 0 });
    assert.equal(equal.outcome, "stayed", "equal costs with margin 0 stay: a move must be cheaper");
    assert.equal(equal.chosen.ref, "high-model", "stayed on the current model at equal cost");
    const cheaper = twoAt(1.0, 0.999, { margin: 0 });
    assert.equal(cheaper.outcome, "moved", "with margin 0 any cheaper model takes the run");
  });

  test("takes the cheapest when the current model is not a candidate, the lowest level on a tie", () => {
    const candidates = from("medium").map((c) => ({ ...c, cached: 0, idle: undefined }));
    for (const current of [undefined, "luna"]) {
      const choice = chooseByCost({
        candidates,
        current,
        workload: work(1, 60, 1),
        again: 0.5,
        settings: DEFAULT_SWITCHING,
        compaction: NO_COMPACTION,
      });
      assert.equal(choice.outcome, "only", `current ${String(current)}: no current model among the candidates`);
      assert.equal(choice.chosen.ref, "terra", `current ${String(current)}: the cheapest takes the run`);
      for (const entry of choice.priced) assert.equal(entry.leaving, 0, `current ${String(current)}: ${entry.ref} leaves nothing behind`);
    }
    const warm = chooseByCost({
      candidates: from("medium"),
      current: undefined,
      workload: work(1, 60, 1),
      again: 0.5,
      settings: DEFAULT_SWITCHING,
      compaction: NO_COMPACTION,
    });
    assert.equal(warm.chosen.ref, "astra", "a stronger model whose cache is warm can cost less than a cold one");
    assert.equal(warm.outcome, "only", "still no current model");
    const same = candidate("a", "medium", TERRA);
    const sameHigher = candidate("b", "high", TERRA);
    const tied = chooseByCost({
      candidates: [sameHigher, same],
      current: undefined,
      workload: work(1, 60, 1),
      again: 0.5,
      settings: DEFAULT_SWITCHING,
      compaction: NO_COMPACTION,
    });
    assert.equal(tied.chosen.ref, "a", "equal costs: the lowest level, whatever the order given");
  });

  test("a candidate too small for the conversation is priced with the summary and the smaller conversation", () => {
    const workload: Workload = { tokens: 200_000, requests: 10, output: 1_000, growth: 1_500, seconds: 120, horizon: 1 };
    const compaction: Compaction = { summary: 4_000, after: 24_000 };
    const a = candidate("A", "super", ASTRA, { cached: 180_000, idle: 30 });
    const b = candidate("B", "medium", TERRA, { compacts: true });
    const choice = chooseByCost({ candidates: [b, a], current: "A", workload, again: 0.5, settings: DEFAULT_SWITCHING, compaction });
    near(priceOf(choice, "A").cost, 1.52264, "A, staying: its warm cache over the whole conversation");
    near(priceOf(choice, "B").cost, 0.62524, "B, compacting: the summary on A, then the smaller conversation, plus leaving");
    near(priceOf(choice, "B").leaving, 0.0912, "B's leaving: the smaller conversation at A's uncached premium");
    assert.equal(priceOf(choice, "B").compacts, true, "B is marked as compacting");
    assert.equal(choice.outcome, "moved", "the compacting candidate wins by more than the margin");
    assert.equal(choice.chosen.ref, "B", "the compacting candidate is chosen");
  });

  test("when the current model itself must compact, staying pays for the summary too and leaves nothing behind", () => {
    const workload: Workload = { tokens: 200_000, requests: 10, output: 1_000, growth: 1_500, seconds: 120, horizon: 1 };
    const compaction: Compaction = { summary: 4_000, after: 24_000 };
    const a = candidate("A", "super", ASTRA, { cached: 180_000, idle: 30, compacts: true });
    const b = candidate("B", "medium", TERRA, { compacts: true });
    const choice = chooseByCost({ candidates: [b, a], current: "A", workload, again: 0.5, settings: DEFAULT_SWITCHING, compaction });
    const afterwards = runCost({ ...a, cached: 0, idle: undefined }, { ...workload, tokens: 24_000 }, TABLE);
    near(priceOf(choice, "A").cost, 0.43304 + afterwards, "A: the summary on itself, then the run at 24,000 tokens with nothing cached");
    near(priceOf(choice, "A").cost, 1.24104, "A: the same, pinned");
    assert.equal(priceOf(choice, "A").leaving, 0, "A leaves nothing behind");
    // B's summary is also written by A, so B costs the same summary plus its own run, plus leaving.
    near(priceOf(choice, "B").cost, 0.43304 + runCost({ ...b }, { ...workload, tokens: 24_000 }, TABLE) + 0.0912, "B: the same summary on A");
  });

  test("a current model with a negative cached size leaves nothing behind", () => {
    const current = candidate("A", "super", ASTRA, { cached: -50_000, idle: 30 });
    const other = candidate("B", "medium", TERRA);
    const choice = chooseByCost({
      candidates: [other, current],
      current: "A",
      workload: work(1, 60, 1),
      again: 0.5,
      settings: DEFAULT_SWITCHING,
      compaction: NO_COMPACTION,
    });
    assert.equal(priceOf(choice, "B").leaving, 0, "a negative cached size is no cache: leaving costs nothing, never less");
  });

  test("with no current model a compacting candidate writes its own summary", () => {
    const workload: Workload = { tokens: 200_000, requests: 10, output: 1_000, growth: 1_500, seconds: 120, horizon: 1 };
    const b = candidate("B", "medium", TERRA, { compacts: true });
    const choice = chooseByCost({
      candidates: [b],
      current: undefined,
      workload,
      again: 0.5,
      settings: DEFAULT_SWITCHING,
      compaction: { summary: 4_000, after: 24_000 },
    });
    // Summary on B: 200,000 tokens at 1e-6 plus 4,000 output at 5e-6; then 10 requests at 24,000 tokens.
    const summary = 200_000 * 1e-6 + 4_000 * 5e-6;
    near(choice.chosen.cost, summary + runCost(b, { ...workload, tokens: 24_000 }, TABLE), "B's own summary and the smaller run");
    assert.equal(choice.chosen.leaving, 0, "nothing to leave");
    assert.equal(choice.outcome, "only", "no current model");
  });

  test("a run is at least one request, and every candidate comes back priced in the order given", () => {
    const candidates = TIERS.map((tier) => candidate(tier, tier, TERRA));
    const choice = chooseByCost({
      candidates,
      current: undefined,
      workload: { tokens: 1_000, requests: 0, output: 100, growth: 0, seconds: 0, horizon: 1 },
      again: 0.5,
      settings: DEFAULT_SWITCHING,
      compaction: NO_COMPACTION,
    });
    assert.deepEqual(choice.priced.map((entry) => entry.ref), [...TIERS], "priced in the order the candidates came");
    near(choice.chosen.cost, 1_000 * 1e-6 + 100 * 5e-6, "zero requests still price the first");
    assert.throws(
      () =>
        chooseByCost({ candidates: [], current: undefined, workload: work(1, 60, 1), again: 0.5, settings: DEFAULT_SWITCHING, compaction: NO_COMPACTION }),
      /at least one candidate/,
      "no candidates is a caller's error",
    );
  });
});
