import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { chooseByCost, runCost } from "../src/cost.ts";
import type { Candidate, Rates, Workload } from "../src/cost.ts";
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

/** One prompt as it happened: the level it needed and the level of the model that took it. */
interface Taken {
  readonly need: Tier;
  readonly taken: Tier;
}

/** 1 plus the steps, counted back from the latest, that needed this level or less and were taken above it; at most the cap. */
function horizonOf(history: readonly Taken[], need: Tier): number {
  let count = 0;
  for (let i = history.length - 1; i >= 0 && count < DEFAULT_SWITCHING.horizonCap; i--) {
    const step = history[i]!;
    if (tierRank(step.need) <= tierRank(need) && tierRank(step.taken) > tierRank(need)) count++;
    else break;
  }
  return Math.min(1 + count, DEFAULT_SWITCHING.horizonCap);
}

/** The share of the last ten steps that needed the current model's level or more: 0.5 with fewer than three, never under 0.2. */
function againOf(history: readonly Taken[], level: Tier): number {
  if (history.length < 3) return 0.5;
  const recent = history.slice(-10);
  const share = recent.filter((step) => tierRank(step.need) >= tierRank(level)).length / recent.length;
  return Math.max(0.2, share);
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
  const history: Taken[] = [];
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
        horizon: horizonOf(history, need),
      };
      const choice = chooseByCost({
        candidates: MODELS.filter((m) => tierRank(m.tier) >= tierRank(need)).map(candidate),
        current: current?.ref,
        workload,
        again: current === undefined ? 0.5 : againOf(history, current.tier),
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
    history.push({ need, taken: model.tier });
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

describe("the test's horizon helper", () => {
  test("counts lighter steps taken above the level, and is capped at the setting", () => {
    const lighter: Taken = { need: "medium", taken: "super" };
    for (const [count, expected] of [[0, 1], [1, 2], [4, 5], [5, 5], [7, 5]] as const) {
      assert.equal(horizonOf(repeat(count, [lighter]), "medium"), expected, `${count} qualifying steps: horizon ${expected}, never over the cap`);
    }
    assert.equal(horizonOf([lighter, { need: "super", taken: "super" }], "medium"), 1, "a step that needed more ends the count");
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
