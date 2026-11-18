// chooseModel (src/decide.ts): among the models adequate for the level a prompt needs, the one the
// expected run costs least on, counting each model's prompt cache. The roster is John's routing
// of 2026-11-17 (test/fixtures/roster-hera-v2-fallback.json), the prices John's on the personal
// level models, and the session the spec's worked example: a 150,000-token conversation whose
// last answer came from astra 30 seconds ago, 149,000 tokens of it cached there at effort high,
// and three runs of one request, 1,000 output tokens, no growth and 60 seconds each.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Api, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";

import { runCost } from "../src/cost.ts";
import type { Candidate, Priced, Rates, Workload } from "../src/cost.ts";
import { chooseModel } from "../src/decide.ts";
import type { Chosen, CompactionFigures, CostFigures, LastResponder } from "../src/decide.ts";
import { newLedger } from "../src/ledger.ts";
import type { Ledger, RunStat } from "../src/ledger.ts";
import { DEFAULT_SWITCHING, SUMMARY_TOKENS } from "../src/settings.ts";
import { policyFromRoster } from "../src/local.ts";
import { Cooldowns, resolveContext } from "../src/resolve.ts";
import type { ResolveContext } from "../src/resolve.ts";
import { scopeSection } from "../src/roster.ts";
import type { RosterV2, ScopeSection } from "../src/roster.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, FakeCatalog, GLM, HERA_LABELS, HERA_LAN, model, NOW, rosterFixtureV2, SOL } from "./support/catalog.ts";

const ROSTER = rosterFixtureV2("roster-hera-v2-fallback.json");

const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const OR_GLM = "openrouter/z-ai/glm-5.3-flash";
const OR_QWEN = "openrouter/qwen/qwen3.8-27b";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";

/** John's prices, dollars per million tokens. */
const PRICES: Readonly<Record<string, Model<Api>["cost"]>> = {
  [LUNA]: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  [TERRA]: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
  [SOL]: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  [ASTRA]: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
};

const ENABLED: CompactionFigures = { enabled: true, reserve: 16_384, keepRecent: 20_000 };
const DISABLED: CompactionFigures = { ...ENABLED, enabled: false };
const TOLERANCE = 5e-5;

const codex = (ref: string, init: Partial<Model<Api>> = {}): Model<Api> =>
  model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000, cost: PRICES[ref]!, ...init });

/** The personal level models at John's prices, and the scope's chain, unpriced. */
function catalog(...replaced: Model<Api>[]): FakeCatalog {
  const result = new FakeCatalog([
    codex(LUNA),
    codex(TERRA),
    codex(SOL),
    codex(ASTRA),
    model(OR_GLM, { contextWindow: 200_000 }),
    model(OR_QWEN, { contextWindow: 131_072 }),
    model(GLM, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
    model(NYX_QWEN, { baseUrl: "https://nyx.lan/v1", contextWindow: 98_304 }),
    model(HERA_QWEN, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
  ]);
  for (const entry of replaced) result.add(entry);
  return result;
}

function context(options: { readonly catalog?: FakeCatalog; readonly cooldowns?: Cooldowns; readonly roster?: RosterV2 } = {}): ResolveContext {
  const roster = options.roster ?? ROSTER;
  return resolveContext({
    roster,
    catalog: options.catalog ?? catalog(),
    labels: HERA_LABELS,
    cooldowns: options.cooldowns ?? new Cooldowns(),
    now: NOW,
    virtualId: "auto",
    localOnly: false,
    policy: policyFromRoster(roster),
    scope: "personal",
  });
}

function personal(roster: RosterV2 = ROSTER): ScopeSection {
  const section = scopeSection(roster, "personal");
  assert.ok(section !== undefined, "the roster serves the personal scope");
  return section;
}

/** An answer of `tokens` in all: the last 1,000 its output, the rest read from the cache. */
function usageOf(tokens: number): Usage {
  return {
    input: 0,
    cacheRead: tokens - 1_000,
    cacheWrite: 0,
    output: 1_000,
    totalTokens: tokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function lastFrom(ref: string, tokens = 150_000): LastResponder {
  return { ref, at: NOW - 30_000, usage: usageOf(tokens) };
}

const SHORT_RUN: RunStat = { requests: 1, output: 1_000, growth: 0, seconds: 60 };

/** Astra seen 30 seconds ago at `tokens`, at effort high unless given, and three ended runs of `run`. */
function ledgerOf(options: { readonly tokens?: number; readonly at?: number; readonly effort?: string | undefined; readonly run?: RunStat } = {}): Ledger {
  const ledger = newLedger();
  const tokens = options.tokens ?? 149_000;
  ledger.seen.set(ASTRA, { tokens, at: options.at ?? NOW - 30_000, effort: "effort" in options ? options.effort : "high" });
  ledger.latest = { ref: ASTRA, tokens };
  for (let i = 0; i < 3; i++) ledger.runs.push(options.run ?? SHORT_RUN);
  return ledger;
}

interface ChooseOptions {
  readonly rc?: ResolveContext;
  readonly section?: ScopeSection;
  readonly need?: Tier;
  readonly code?: string;
  readonly last?: LastResponder | undefined;
  readonly compaction?: CompactionFigures;
  readonly figures?: CostFigures | undefined;
  readonly thinking?: ModelThinkingLevel;
  readonly ledger?: Ledger;
  readonly priced?: boolean;
  readonly promptTokens?: number;
}

function choose(options: ChooseOptions = {}): Chosen {
  return chooseModel({
    rc: options.rc ?? context(),
    section: options.section ?? personal(),
    need: options.need ?? "medium",
    code: options.code ?? "heuristics",
    last: "last" in options ? options.last : lastFrom(ASTRA),
    promptTokens: options.promptTokens ?? 0,
    compaction: options.compaction ?? ENABLED,
    figures: "figures" in options ? options.figures : { ledger: options.ledger ?? ledgerOf(), thinking: options.thinking ?? "high" },
    priced: options.priced ?? true,
  });
}

function pickOf(chosen: Chosen): readonly [string, Tier, string] {
  assert.ok(chosen.decision.ok, JSON.stringify(chosen.decision));
  return [chosen.decision.choice.ref, chosen.tier, chosen.decision.choice.code];
}

function pricedOf(chosen: Chosen): readonly Priced[] {
  const cost = chosen.cost;
  assert.ok(cost !== undefined && cost.outcome !== "unknown", `the cost rule priced the run: ${JSON.stringify(cost)}`);
  return cost.priced;
}

function entryOf(chosen: Chosen, ref: string): Priced {
  const found = pricedOf(chosen).find((entry) => entry.ref === ref);
  assert.ok(found !== undefined, `${ref} is priced`);
  return found;
}

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < TOLERANCE, `${message}: ${actual} is not within ${TOLERANCE} of ${expected}`);
}

describe("with the needed level's own model available", () => {
  test("a MEDIUM prompt on a warm astra stays there when the run is short", () => {
    const chosen = choose();
    assert.deepEqual(pickOf(chosen), [ASTRA, "super", "heuristics"], "staying on the warm astra costs less than moving by more than the margin");
    assert.equal(chosen.steppedUp, false, "a choice by cost is no step-up");
    assert.equal(chosen.cost?.outcome, "stayed", "astra is the current model and keeps the run");
    assert.ok(chosen.cost?.outcome === "stayed" && chosen.cost.chosen === ASTRA, "the cost names astra");
    assert.deepEqual(
      pricedOf(chosen).map((entry) => [entry.ref, entry.tier]),
      [
        [TERRA, "medium"],
        [SOL, "high"],
        [ASTRA, "super"],
      ],
      "every level from the needed one up is priced, lowest first",
    );
    near(entryOf(chosen, ASTRA).cost, 0.141572, "astra: 0.97 x (149,000 cached + 1,000 uncached) + 0.03 x 150,000 uncached, and 1,000 output");
    near(entryOf(chosen, TERRA).cost, 0.200296, "terra: 150,000 uncached and 1,000 output, plus leaving astra's cache");
    near(entryOf(chosen, SOL).cost, 0.355296, "sol: 150,000 uncached and 1,000 output, plus leaving astra's cache");
    assert.ok(chosen.cost?.outcome === "stayed" && chosen.cost.again === 0.5, "with no prompts noted, the chance astra's level is needed again is 0.5");
  });

  test("and moves to terra when lighter prompts keep coming", () => {
    const ledger = ledgerOf();
    ledger.needs.push({ need: "medium", took: "super" }, { need: "medium", took: "super" });
    const chosen = choose({ ledger });
    assert.deepEqual(pickOf(chosen), [TERRA, "medium", "heuristics"], "two MEDIUM prompts in a row stayed on astra: the horizon is 3");
    assert.equal(chosen.cost?.outcome, "moved", "terra undercuts astra by more than the margin");
    assert.ok(chosen.cost?.outcome === "moved" && chosen.cost.workload.horizon === 3, "the horizon is 3");
    near(entryOf(chosen, ASTRA).cost, 0.341572, "astra: three requests, the first warm");
    near(entryOf(chosen, TERRA).cost, 0.225296, "terra: three requests, the first cold, plus leaving astra's cache");
  });

  test("a run that needs more than the current model moves up at once, to the cheapest adequate model", () => {
    const chosen = choose({ need: "super", last: lastFrom(TERRA) });
    assert.deepEqual(pickOf(chosen), [ASTRA, "super", "heuristics"], "terra is below SUPER, so it is no candidate");
    assert.equal(chosen.cost?.outcome, "only", "without a current model among the candidates there is nothing to stay on");
    assert.deepEqual(pricedOf(chosen).map((entry) => entry.ref), [ASTRA], "only astra is adequate for SUPER");
  });

  test("a current model that is not one of the scope's level models is no candidate and leaves nothing behind", () => {
    const chosen = choose({ last: lastFrom(OR_GLM) });
    assert.equal(chosen.cost?.outcome, "only", "a chain model is never the current model of a cost choice");
    assert.deepEqual(
      pricedOf(chosen).map((entry) => entry.leaving),
      [0, 0, 0],
      "with no current model, leaving costs nothing",
    );
    assert.deepEqual(pickOf(chosen), [ASTRA, "super", "heuristics"], "astra's warm cache makes it the cheapest");
  });
});

describe("missing figures", () => {
  test("no usage yet: the needed level's own model, and the cost is unknown", () => {
    const chosen = choose({ last: undefined });
    assert.deepEqual(pickOf(chosen), [TERRA, "medium", "heuristics"], "no usage yet: the needed level's own model");
    assert.deepEqual(chosen.cost, { outcome: "unknown", why: "no usage yet" }, "no usage yet");
    assert.equal(chosen.steppedUp, false, "no usage yet");
    const zero = { ...usageOf(1_000), cacheRead: 0, output: 0, totalTokens: 0 };
    const empty = choose({ last: { ref: ASTRA, at: NOW - 30_000, usage: zero }, promptTokens: 50 });
    assert.deepEqual(pickOf(empty), [TERRA, "medium", "heuristics"], "a usage of 0 tokens is no usage either, whatever the prompt's size");
    assert.deepEqual(empty.cost, { outcome: "unknown", why: "no usage yet" }, "a usage of 0 tokens is no usage either, whatever the prompt's size");
    const unmeasured = choose({ last: { ref: ASTRA, at: NOW - 30_000 }, promptTokens: 50 });
    assert.deepEqual(unmeasured.cost, { outcome: "unknown", why: "no usage yet" }, "a last response without usage is no usage, whatever the prompt's size");
  });

  test("a model without a price makes the cost unknown", () => {
    const free = codex(SOL, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const chosen = choose({ rc: context({ catalog: catalog(free) }) });
    assert.deepEqual(pickOf(chosen), [TERRA, "medium", "heuristics"], "a missing price is not free: the needed level's own model");
    assert.deepEqual(chosen.cost, { outcome: "unknown", why: "no price" }, "sol has no price");
  });

  test("a clock that went backwards makes the cost unknown", () => {
    const chosen = choose({ ledger: ledgerOf({ at: NOW + 5_000 }) });
    assert.deepEqual(pickOf(chosen), [TERRA, "medium", "heuristics"], "a clock that went backwards: the needed level's own model");
    assert.deepEqual(chosen.cost, { outcome: "unknown", why: "the clock went backwards" }, "astra was seen after now");
  });

  test("the checks run in order: usage, then price, then the clock", () => {
    const free = codex(SOL, { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const both = { rc: context({ catalog: catalog(free) }), ledger: ledgerOf({ at: NOW + 5_000 }) };
    assert.deepEqual(choose({ ...both, last: undefined }).cost, { outcome: "unknown", why: "no usage yet" }, "no usage comes first");
    assert.deepEqual(choose(both).cost, { outcome: "unknown", why: "no price" }, "a missing price comes before the clock");
  });

  test("no figures at all: today's resolution, and no cost", () => {
    const chosen = choose({ figures: undefined });
    assert.deepEqual(pickOf(chosen), [TERRA, "medium", "heuristics"], "without figures the needed level's first available model, as climb picks");
    assert.equal(chosen.cost, undefined, "without figures there is no cost");
    assert.equal(chosen.steppedUp, false, "without figures");
  });
});

describe("a change of effort zeroes the cached size", () => {
  test("the selected level differs from the level of the model's last answer", () => {
    const chosen = choose({ thinking: "low" });
    assert.equal(entryOf(chosen, ASTRA).cached, 0, "astra would be sent effort low, and its last answer was at high");
    assert.deepEqual(pickOf(chosen), [TERRA, "medium", "heuristics"], "a cold astra no longer keeps a short MEDIUM run");
    assert.equal(chosen.cost?.outcome, "moved", "a cold astra no longer keeps a short MEDIUM run");
    near(entryOf(chosen, ASTRA).cost, 1.24, "astra: 150,000 uncached and 1,000 output");
    near(entryOf(chosen, TERRA).cost, 0.155, "terra: 150,000 uncached and 1,000 output; a cold astra leaves nothing behind");
  });

  test("two levels the model maps to one effort leave it alone", () => {
    const mapped = codex(ASTRA, { thinkingLevelMap: { minimal: "low", low: "low" } });
    const chosen = choose({ rc: context({ catalog: catalog(mapped) }), thinking: "minimal", ledger: ledgerOf({ effort: "low" }) });
    assert.equal(entryOf(chosen, ASTRA).cached, 149_000, "astra sends minimal as low, the effort of its last answer");
    assert.equal(chosen.cost?.outcome, "stayed", "a warm astra keeps a short MEDIUM run");
  });

  test("a role that fixes its level is priced at that level, whatever is selected", () => {
    const roster: RosterV2 = { ...ROSTER, roles: ROSTER.roles.map((role) => (role.name === "super" ? { ...role, thinking: "high" } : role)) };
    const chosen = choose({ rc: context({ roster }), section: personal(roster), thinking: "low" });
    assert.equal(entryOf(chosen, ASTRA).cached, 149_000, "the super role sends high whatever is selected, the effort of astra's last answer");
    assert.equal(chosen.cost?.outcome, "stayed", "a warm astra keeps a short MEDIUM run");
  });

  test("an answer whose effort is not known counts as the same effort", () => {
    const chosen = choose({ thinking: "low", ledger: ledgerOf({ effort: undefined }) });
    assert.equal(entryOf(chosen, ASTRA).cached, 149_000, "an unknown effort is not a known change");
    assert.equal(chosen.cost?.outcome, "stayed", "a warm astra keeps a short MEDIUM run");
  });
});

describe("the needed level without a model of its own", () => {
  test("goes to the scope's chain, then up, as before, with no cost", () => {
    const cooldowns = new Cooldowns();
    cooldowns.cool(TERRA, 1, NOW, 30);
    const chosen = choose({ rc: context({ cooldowns }) });
    assert.deepEqual(pickOf(chosen), [OR_GLM, "medium", "fallback:medium→openrouter"], "terra is cooling: the chain's first model, at MEDIUM");
    assert.equal(chosen.steppedUp, false, "the chain keeps the run's level");
    assert.equal(chosen.cost, undefined, "the chain is not priced");
    const gone = catalog();
    for (const ref of [OR_GLM, OR_QWEN, GLM, NYX_QWEN, HERA_QWEN]) gone.unavailable.add(ref);
    const up = choose({ rc: context({ catalog: gone, cooldowns }) });
    assert.deepEqual(pickOf(up), [SOL, "high", "step-up"], "with the chain unavailable too, the run steps up");
    assert.equal(up.steppedUp, true, "with the chain unavailable too, the run steps up");
    assert.equal(up.cost, undefined, "a step-up is not priced");
  });
});

describe("a conversation larger than a candidate's window", () => {
  const small = (): FakeCatalog => catalog(codex(TERRA, { contextWindow: 128_000 }));
  const long: RunStat = { requests: 10, output: 1_000, growth: 0, seconds: 600 };

  test("with compaction enabled the candidate stays, priced with a summary on the current model", () => {
    const chosen = choose({ rc: context({ catalog: small() }), last: lastFrom(ASTRA, 200_000), ledger: ledgerOf({ tokens: 199_000, run: long }) });
    assert.deepEqual(
      pricedOf(chosen).map((entry) => [entry.ref, entry.compacts]),
      [
        [TERRA, true],
        [SOL, false],
        [ASTRA, false],
      ],
      "200,000 tokens do not fit terra's 128,000 less the reserve: Pi compacts before terra takes it",
    );
    assert.deepEqual(pickOf(chosen), [TERRA, "medium", "heuristics"], "ten-request runs: terra wins even with the summary");
    assert.equal(chosen.cost?.outcome, "moved", "ten-request runs: terra wins even with the summary");
    near(entryOf(chosen, TERRA).cost, 0.468972, "terra: astra's summary, ten requests on 24,000 tokens, leaving astra");
    near(entryOf(chosen, ASTRA).cost, 1.252972, "astra: ten requests on 200,000 tokens, the first warm");
    near(entryOf(chosen, SOL).cost, 0.778306, "sol: ten requests on 200,000 tokens, the first cold, leaving astra");
  });

  test("with compaction disabled it is no candidate, and a needed level that does not fit steps up", () => {
    const chosen = choose({ rc: context({ catalog: small() }), last: lastFrom(ASTRA, 200_000), ledger: ledgerOf({ tokens: 199_000, run: long }), compaction: DISABLED });
    assert.deepEqual(pickOf(chosen), [SOL, "high", "step-up"], "terra is too small and Pi would not compact: the run steps up to sol");
    assert.equal(chosen.steppedUp, true, "terra does not fit");
    assert.equal(chosen.cost, undefined, "a step-up is not priced");
  });

  test("with compaction disabled, a higher level that does not fit is no candidate", () => {
    const tight = catalog(codex(SOL, { contextWindow: 128_000 }));
    const chosen = choose({ rc: context({ catalog: tight }), last: lastFrom(ASTRA, 200_000), ledger: ledgerOf({ tokens: 199_000 }), compaction: DISABLED });
    assert.deepEqual(
      pricedOf(chosen).map((entry) => entry.ref),
      [TERRA, ASTRA],
      "sol is too small and Pi would not compact: it is not priced",
    );
  });
});

describe("the new prompt", () => {
  // Sol's window less the reserve holds 111,616 tokens: a history of 111,600 fits alone, and not with a 50-token prompt.
  const tight = (): FakeCatalog => catalog(codex(SOL, { contextWindow: 128_000 }));
  const edge = lastFrom(ASTRA, 111_600);

  test("counts toward the conversation at a window's edge: the fit, and the cache's cap", () => {
    const alone = choose({ rc: context({ catalog: tight() }), last: edge, ledger: ledgerOf({ tokens: 200_000 }), compaction: DISABLED });
    assert.deepEqual(pricedOf(alone).map((entry) => entry.ref), [TERRA, SOL, ASTRA], "the history alone fits sol: with compaction disabled it is a candidate");
    const disabled = choose({ rc: context({ catalog: tight() }), last: edge, ledger: ledgerOf({ tokens: 200_000 }), compaction: DISABLED, promptTokens: 50 });
    assert.deepEqual(
      pricedOf(disabled).map((entry) => entry.ref),
      [TERRA, ASTRA],
      "history plus prompt no longer fits sol: with compaction disabled it is no candidate",
    );
    assert.equal(entryOf(disabled, ASTRA).cached, 111_650, "the cached size is capped by the conversation, history plus prompt");
    const enabled = choose({ rc: context({ catalog: tight() }), last: edge, ledger: ledgerOf({ tokens: 200_000 }), promptTokens: 50 });
    assert.equal(entryOf(enabled, SOL).compacts, true, "history plus prompt no longer fits sol: with compaction enabled Pi compacts first");
    assert.equal(entryOf(enabled, TERRA).compacts, false, "history plus prompt fits terra");
    assert.equal(entryOf(alone, ASTRA).cached, 111_600, "the cached size is capped by the conversation, the history alone without a prompt");
  });
});

describe("a candidate that compacts first", () => {
  // Terra's window is too small for 200,000 tokens; after the compaction it is sent 24,000. Its price
  // has a request-wide tier above 100,000 tokens, between the two sizes.
  const LOWER = PRICES[TERRA]!;
  const tiered = (upper: { input: number; output: number; cacheRead: number; cacheWrite: number }): FakeCatalog =>
    catalog(codex(TERRA, { contextWindow: 128_000, cost: { ...LOWER, tiers: [{ inputTokensAbove: 100_000, ...upper }] } }));
  const long: RunStat = { requests: 10, output: 1_000, growth: 0, seconds: 600 };
  const run = (rc: ResolveContext): Chosen => choose({ rc, last: lastFrom(ASTRA, 200_000), ledger: ledgerOf({ tokens: 199_000, run: long }) });
  const perToken = (cost: { input: number; output: number; cacheRead: number }): Rates => ({ input: cost.input / 1e6, cacheRead: cost.cacheRead / 1e6, output: cost.output / 1e6 });

  /** Terra's expected cost: astra's summary at 200,000 tokens, then the run on 24,000 tokens at `rates`, then leaving astra. */
  function expected(rates: Rates, leaving: number): number {
    const astra: Candidate = { ref: ASTRA, tier: "super", rates: perToken(PRICES[ASTRA]!), cached: 199_000, idle: 30, compacts: false };
    const once: Workload = { tokens: 200_000, requests: 1, output: 0, growth: 0, seconds: 0, horizon: 1 };
    const summary = runCost(astra, once, DEFAULT_SWITCHING.cacheSurvival) + SUMMARY_TOKENS * astra.rates.output;
    const fresh: Candidate = { ref: TERRA, tier: "medium", rates, cached: 0, idle: undefined, compacts: true };
    const after = 20_000 + SUMMARY_TOKENS;
    return summary + runCost(fresh, { tokens: after, requests: 10, output: 1_000, growth: 0, seconds: 600, horizon: 1 }, DEFAULT_SWITCHING.cacheSurvival) + leaving;
  }

  test("is priced at the rates of the size it is sent after the compaction", () => {
    const chosen = run(context({ catalog: tiered({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }) }));
    const terra = entryOf(chosen, TERRA);
    assert.equal(terra.compacts, true, "200,000 tokens do not fit terra: Pi compacts first");
    near(terra.cost, expected(perToken(LOWER), terra.leaving), "terra is sent 24,000 tokens, under the tier's 100,000: priced at the lower rates");
    near(terra.cost, 0.468972, "the lower rates are terra's untiered price: the same cost as without the tier");
  });

  test("is priced when only the tier of the size it is not sent lacks a price", () => {
    const chosen = run(context({ catalog: tiered({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }));
    assert.notEqual(chosen.cost?.outcome, "unknown", `terra is sent 24,000 tokens, whose price is known: ${JSON.stringify(chosen.cost)}`);
    near(entryOf(chosen, TERRA).cost, 0.468972, "terra is sent 24,000 tokens, under the unpriced tier: priced at the lower rates");
  });
});

describe("a model two levels share", () => {
  test("is priced once, at the lower level", () => {
    const section = personal();
    const shared: ScopeSection = { ...section, levels: { ...section.levels, super: section.levels.high } };
    const roster: RosterV2 = { ...ROSTER, scopes: { ...ROSTER.scopes, personal: shared } };
    const chosen = choose({ rc: context({ roster }), section: shared, need: "high" });
    assert.deepEqual(
      pricedOf(chosen).map((entry) => [entry.ref, entry.tier]),
      [[SOL, "high"]],
      "high and super both take sol: the lower level takes it, and super has no other",
    );
  });
});

describe("a tagged run", () => {
  test("is never priced", () => {
    const chosen = choose({ need: "low", code: "tag", priced: false });
    assert.deepEqual(pickOf(chosen), [LUNA, "low", "tag"], "a tag takes its level's first available model");
    assert.equal(chosen.cost, undefined, "a tagged run is never priced");
  });
});
