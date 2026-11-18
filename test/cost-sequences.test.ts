import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { chooseByCost, runCost } from "../src/cost.ts";
import type { Candidate, Rates, Workload } from "../src/cost.ts";
import { againChance, horizonFor, newLedger, notePrompt } from "../src/ledger.ts";
import type { Ledger } from "../src/ledger.ts";
import { DEFAULT_SWITCHING } from "../src/settings.ts";
import { tierRank } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";

const TABLE = DEFAULT_SWITCHING.cacheSurvival;
const MARGIN = DEFAULT_SWITCHING.margin;

const TOKENS = 150_000;
const OUTPUT = 1_000;
/** Seconds that pass between the end of a run and the next prompt. */
const BETWEEN = 30;
const COMPACTION = { summary: 4_000, after: 24_000 } as const;

interface Model {
  readonly ref: string;
  readonly tier: Tier;
  readonly rates: Rates;
}

const MODELS: readonly Model[] = [
  { ref: "luna", tier: "low", rates: { input: 0.1e-6, cacheRead: 0.01e-6, output: 0.5e-6 } },
  { ref: "terra", tier: "medium", rates: { input: 1e-6, cacheRead: 0.05e-6, output: 5e-6 } },
  { ref: "sol", tier: "high", rates: { input: 2e-6, cacheRead: 0.1e-6, output: 10e-6 } },
  { ref: "astra", tier: "super", rates: { input: 8e-6, cacheRead: 0.4e-6, output: 40e-6 } },
];

function modelOf(tier: Tier): Model {
  const found = MODELS.find((model) => model.tier === tier);
  assert.ok(found, `a model of the ${tier} level`);
  return found;
}

type Step = readonly [need: Tier, requests: number, seconds: number];

function repeat<T>(times: number, items: readonly T[]): T[] {
  return Array.from({ length: times }, () => items).flat();
}

/** A ledger that has noted these prompts, each the level it needed and the level of the model that took it. */
function ledgerOf(prompts: ReadonlyArray<readonly [need: Tier, took: Tier]>): Ledger {
  const ledger = newLedger();
  for (const [need, took] of prompts) notePrompt(ledger, need, took);
  return ledger;
}

type Policy = "rule" | "high" | "follow";

interface Outcome {
  readonly total: number;
  readonly models: readonly string[];
}

function simulate(policy: Policy, steps: readonly Step[]): Outcome {
  let clock = 0;
  const cached = new Map<string, number>();
  const answered = new Map<string, number>();
  // The session's ledger, fed as the router feeds it: each prompt's need and the level that took it.
  const ledger = newLedger();
  const models: string[] = [];
  let current: Model | undefined;
  let total = 0;

  for (const [need, requests, seconds] of steps) {
    const candidate = (model: Model): Candidate => {
      const last = answered.get(model.ref);
      return {
        ref: model.ref,
        tier: model.tier,
        rates: model.rates,
        cached: cached.get(model.ref) ?? 0,
        idle: last === undefined ? undefined : clock - last,
        compacts: false,
      };
    };
    let model: Model;
    if (policy === "high") model = modelOf("super");
    else if (policy === "follow") model = modelOf(need);
    else {
      const workload: Workload = {
        tokens: TOKENS,
        requests,
        output: OUTPUT,
        growth: 0,
        seconds,
        horizon: horizonFor(ledger, need, DEFAULT_SWITCHING.horizonCap),
      };
      const choice = chooseByCost({
        candidates: MODELS.filter((m) => tierRank(m.tier) >= tierRank(need)).map(candidate),
        current: current?.ref,
        workload,
        again: current === undefined ? 0.5 : againChance(ledger, current.tier),
        settings: DEFAULT_SWITCHING,
        compaction: COMPACTION,
      });
      model = MODELS.find((m) => m.ref === choice.chosen.ref)!;
    }
    // The step is charged what it really costs: its own requests, with what the model had cached.
    total += runCost(candidate(model), { tokens: TOKENS, requests, output: OUTPUT, growth: 0, seconds, horizon: 1 }, TABLE);
    clock += seconds;
    cached.set(model.ref, TOKENS);
    answered.set(model.ref, clock);
    clock += BETWEEN;
    notePrompt(ledger, need, model.tier);
    models.push(model.ref);
    current = model;
  }
  return { total, models };
}

const SEQUENCES: ReadonlyArray<readonly [name: string, steps: readonly Step[]]> = [
  ["alternating heavy and light prompts", repeat(10, [["super", 5, 300], ["medium", 1, 60]] as const)],
  ["alternating heavy and long lighter runs", repeat(10, [["super", 5, 300], ["medium", 5, 300]] as const)],
  ["a long stretch of lighter work", [["super", 5, 300], ...repeat(12, [["medium", 5, 300]] as const)]],
  ["one light prompt among heavy ones", [...repeat(3, [["super", 5, 300]] as const), ["low", 1, 60], ...repeat(3, [["super", 5, 300]] as const)]],
  ["a burst of light prompts", [["super", 5, 300], ...repeat(8, [["low", 1, 60]] as const), ["super", 5, 300]]],
];

describe("the ledger's horizon, as the sequences feed it", () => {
  test("counts lighter steps taken above the level, and is capped at the setting", () => {
    const lighter = ["medium", "super"] as const;
    for (const [count, expected] of [[0, 1], [1, 2], [4, 5], [5, 5], [7, 5]] as const) {
      assert.equal(
        horizonFor(ledgerOf(repeat(count, [lighter])), "medium", DEFAULT_SWITCHING.horizonCap),
        expected,
        `${count} qualifying steps: horizon ${expected}, never over the cap`,
      );
    }
    assert.equal(horizonFor(ledgerOf([lighter, ["super", "super"]]), "medium", DEFAULT_SWITCHING.horizonCap), 1, "a step that needed more ends the count");
  });
});

describe("the rule over a sequence of prompts", () => {
  for (const [name, steps] of SEQUENCES) {
    test(`${name}: the rule never costs more than staying high, nor more than following the level by over the margin`, () => {
      const rule = simulate("rule", steps);
      const high = simulate("high", steps);
      const follow = simulate("follow", steps);
      assert.ok(rule.total <= high.total * (1 + 1e-9), `${name}: rule ${rule.total} against always high ${high.total}`);
      assert.ok(rule.total <= follow.total * (1 + MARGIN), `${name}: rule ${rule.total} against following the level ${follow.total}`);
    });
  }

  test("the first sequence stays on the stronger model throughout, and the second moves each time", () => {
    const first = simulate("rule", SEQUENCES[0]![1]);
    assert.deepEqual(first.models, repeat(20, ["astra"]), "alternating heavy and light prompts: every step on astra");
    const second = simulate("rule", SEQUENCES[1]![1]);
    assert.deepEqual(second.models, repeat(10, ["astra", "terra"]), "alternating heavy and long lighter runs: astra, terra alternating");
  });
});
