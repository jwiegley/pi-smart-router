// The router plans each run by cost: it feeds the session's ledger (src/ledger.ts) from the
// session's own answers, seeds it from the bounded read at session_start, forgets every cache at a
// compaction or a move in the tree, and gives chooseModel (src/decide.ts) the figures when it plans
// an untagged run on smart-router/auto. The footer, the run's record and /smart-router status say
// what the cost rule compared. The roster is John's routing of 2026-11-17
// (test/fixtures/roster-hera-v2-fallback.json), with John's prices on the level models of both
// scopes. Unit tests on the fake host of test/support/pi.ts; no Pi runtime is started.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import type { Api, ClassifierResult, Model, Usage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { LEVEL_ENTRY, LEVEL_KEY, SCOPE_ENTRY } from "../src/constants.ts";
import { runCost, survivalOf } from "../src/cost.ts";
import type { Candidate, Rates, Workload } from "../src/cost.ts";
import type { CostTerms, PlanLevel } from "../src/decide.ts";
import { stepUpNotice } from "../src/errors.ts";
import { effortOf } from "../src/ledger.ts";
import { decisionLines } from "../src/records.ts";
import { scopeEntry } from "../src/scope.ts";
import { DEFAULT_SWITCHING, RUN_DEFAULTS } from "../src/settings.ts";
import { tierLabel, TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, FakeCatalog, GLM, HERA_LAN, model, NOW, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, previous, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded, LoadOptions } from "./support/pi.ts";

const ROSTER = fixture("roster-hera-v2-fallback.json");
const JEV = "openrouter/typesafe/jev-1.14";
const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const OR_GLM = "openrouter/z-ai/glm-5.3-flash";
const OR_QWEN = "openrouter/qwen/qwen3.8-27b";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";
const WORK_LUNA = "openai-codex-3/gpt-6-luna";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const WORK_ASTRA = "openai-codex-3/gpt-6-astra";
const OWN: Readonly<Record<Tier, string>> = { low: LUNA, medium: TERRA, high: SOL, super: ASTRA };
const WORK_OWN: Readonly<Record<Tier, string>> = { low: WORK_LUNA, medium: WORK_TERRA, high: WORK_SOL, super: WORK_ASTRA };
const MARK = "quixotic-zebra";
const TABLE = DEFAULT_SWITCHING.cacheSurvival;

/** John's prices, dollars per million tokens, by model id: both accounts have the same. */
const PRICES: Readonly<Record<string, Model<Api>["cost"]>> = {
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
  "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "gpt-6-astra": { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
};

const idOf = (ref: string): string => ref.slice(ref.indexOf("/") + 1);
const priceOf = (ref: string): Model<Api>["cost"] => PRICES[idOf(ref)]!;

const codex = (ref: string, init: Partial<Model<Api>> = {}): Model<Api> =>
  model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000, cost: priceOf(ref), ...init });

/** Both accounts' level models at John's prices, the scope's chain unpriced, and `replaced` over them. */
function catalog(...replaced: Model<Api>[]): FakeCatalog {
  const result = new FakeCatalog([
    ...TIERS.map((tier) => codex(OWN[tier])),
    ...TIERS.map((tier) => codex(WORK_OWN[tier])),
    model(OR_GLM, { contextWindow: 200_000 }),
    model(OR_QWEN, { contextWindow: 131_072 }),
    model(GLM, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
    model(NYX_QWEN, { baseUrl: "https://nyx.lan/v1", contextWindow: 98_304 }),
    model(HERA_QWEN, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
  ]);
  for (const entry of replaced) result.add(entry);
  return result;
}

const ANSWER_SUPER: Record<Tier, number> = { low: 0, medium: 0, high: 0, super: 1 };
const ANSWER_MEDIUM: Record<Tier, number> = { low: 0, medium: 1, high: 0, super: 0 };
const ANSWER_LOW: Record<Tier, number> = { low: 1, medium: 0, high: 0, super: 0 };
/** A move in the session tree to another leaf, as Pi's session_tree event reports one. */
const TO_ANOTHER_LEAF = { newLeafId: "e-other", oldLeafId: "e-here" } as const;

function jevAnswer(probabilities: Record<Tier, number>): ClassifierResult {
  const choice = [...TIERS].sort((a, b) => probabilities[b] - probabilities[a])[0] ?? "medium";
  return {
    api: "typesafe-system-one",
    provider: "openrouter",
    model: "typesafe/jev-1.14",
    answers: { level: { type: "choice", choice, probabilities, confidence: probabilities[choice] } },
    stopReason: "stop",
    timestamp: NOW,
  };
}

/** An answer of `tokens` in all: the last 1,000 its output, the rest read from the cache. */
function usageOf(tokens: number): Usage {
  return { input: 0, cacheRead: tokens - 1_000, cacheWrite: 0, output: 1_000, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** A session's state: its clock, which only the test moves. */
interface Session {
  readonly loaded: Loaded;
  clock: number;
}

beforeEach(resetSlot);
afterEach(resetSlot);

/** A session on John's routing with smart-router/auto selected and the clock at NOW. */
async function session(t: TestContext, options: Partial<Omit<LoadOptions, "dir">> & { readonly select?: string; readonly catalog?: FakeCatalog } = {}): Promise<Session> {
  const { catalog: given, ...rest } = options;
  const runtime = new FakeRuntime(given ?? catalog());
  runtime.addClassifier(JEV);
  const state = { clock: NOW } as Session;
  (state as { loaded: Loaded }).loaded = await start({ dir: agentDir(t, { roster: ROSTER }), runtime, now: () => state.clock, ...rest });
  return state;
}

const recordOf = (state: Session) => {
  const record = state.loaded.router?.record(state.loaded.session.id);
  assert.ok(record !== undefined, "the session has a record");
  return record;
};
const footer = (state: Session): string | undefined => state.loaded.session.statuses.get(LEVEL_KEY);

/** A message typed while the session is idle, which Jev answers with these probabilities. */
async function say(state: Session, text: string, jev: Record<Tier, number>): Promise<PlanLevel> {
  state.loaded.runtime.answer = async () => jevAnswer(jev);
  await state.loaded.host.emit("input", { text, source: "interactive" });
  const level = recordOf(state).pendingLevel?.level;
  assert.ok(level !== undefined, `"${text}" planned a level`);
  return level;
}

/** The prompt's run starts and its first request routes, at the selected level unless given. */
async function route(state: Session, text: string, thinkingLevel = state.loaded.host.thinking) {
  const signal = state.loaded.session.startRun();
  await state.loaded.host.emit("before_agent_start", { messageType: "user", prompt: text });
  return state.loaded.runtime.route("auto", request("user", { signal, thinkingLevel }));
}

/** The run's one request answers a minute after it started, with `tokens` in all, and the run settles; the next prompt comes 30 seconds later. */
async function answer(state: Session, ref: string, tokens = 150_000, thinkingLevel = state.loaded.host.thinking): Promise<void> {
  const started = state.clock;
  state.clock += 60_000;
  await state.loaded.host.emit("message_end", { message: assistant(ref, { usage: usageOf(tokens), timestamp: started, thinkingLevel }) });
  await state.loaded.host.emit("agent_settled", { aborted: false });
  state.loaded.session.endRun();
  state.clock += 30_000;
}

/** A whole run: the message, its first request and its one answer, from the model the request went to. */
async function run(state: Session, text: string, jev: Record<Tier, number>): Promise<string> {
  await say(state, text, jev);
  const ref = routed(await route(state, text));
  await answer(state, ref);
  return ref;
}

const rates = (ref: string): Rates => {
  const price = priceOf(ref);
  return { input: price.input / 1e6, cacheRead: price.cacheRead / 1e6, output: price.output / 1e6 };
};

/** The new prompt's size, as Pi estimates a user message holding its text. */
const promptTokens = (text: string, at: number): number => estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: at });

/**
 * What the expected run costs on each personal level model from MEDIUM up, worked here from
 * runCost: astra the current model with `cached` tokens 30 seconds old, the others cold, each
 * other one carrying the cost of leaving astra.
 */
function expectedCosts(options: { readonly tokens: number; readonly cached: number; readonly shape: Omit<Workload, "tokens" | "horizon">; readonly horizon: number; readonly again: number }): Record<"terra" | "sol" | "astra", number> {
  const { tokens, cached, shape, horizon, again } = options;
  const workload: Workload = { tokens, horizon, ...shape };
  const astra: Candidate = { ref: ASTRA, tier: "super", rates: rates(ASTRA), cached: Math.min(cached, tokens), idle: 30, compacts: false };
  const premium = astra.rates.input - astra.rates.cacheRead;
  const leaving = again * (1 - survivalOf(astra, TABLE, shape.seconds * horizon)) * astra.cached * premium;
  const cold = (ref: string, tier: Tier): number => runCost({ ref, tier, rates: rates(ref), cached: 0, idle: undefined, compacts: false }, workload, TABLE) + leaving;
  return { terra: cold(TERRA, "medium"), sol: cold(SOL, "high"), astra: runCost(astra, workload, TABLE) };
}

const money = (value: number): string => `$${value.toFixed(2)}`;
const ONE_REQUEST = { requests: 1, output: 1_000, growth: 0, seconds: 60 } as const;

function knownCost(level: PlanLevel): Exclude<CostTerms, { readonly outcome: "unknown" }> {
  const { cost } = level;
  assert.ok(cost !== undefined && cost.outcome !== "unknown", `the run was priced: ${JSON.stringify(cost)}`);
  return cost;
}

const demandNote = (level: PlanLevel): string => {
  assert.ok(level.demand !== undefined, "an untagged run has a demand");
  return `demand ${level.demand.value.toFixed(1)}`;
};

/** Three one-request SUPER runs on astra, the first planned without a usage. */
async function threeSuperRuns(state: Session): Promise<void> {
  for (let i = 0; i < 3; i++) assert.equal(await run(state, `design the next part ${i}`, ANSWER_SUPER), ASTRA, `SUPER run ${i} goes to astra`);
}

describe("the ledger's feed", () => {
  test("each answer that ends without an error is noted, with its effort; an aborted or failed one is not", async (t) => {
    const state = await session(t);
    const { loaded } = state;
    const usage = { input: 20_000, cacheRead: 130_000, cacheWrite: 500, output: 1_000, totalTokens: 151_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    await loaded.host.emit("message_end", { message: assistant(SOL, { usage, thinkingLevel: "high" }) });
    const seen = recordOf(state).ledger.seen.get(SOL);
    assert.deepEqual(seen, { tokens: 150_500, at: NOW, effort: effortOf(loaded.runtime.physical(SOL), "high") }, "input, cache read and cache write, at the effort the level maps to");
    assert.ok(recordOf(state).ledger.writes.has("openai-codex-2"), "the provider reported a cache write");
    for (const stopReason of ["aborted", "error"] as const) {
      state.clock += 1_000;
      await loaded.host.emit("message_end", { message: assistant(SOL, { usage: usageOf(40_000), stopReason, ...(stopReason === "error" ? { errorMessage: "boom" } : {}) }) });
      assert.deepEqual(recordOf(state).ledger.seen.get(SOL), seen, `an answer that ended ${stopReason} is never noted`);
      assert.equal(recordOf(state).ledger.run?.requests, 1, `an answer that ended ${stopReason} counts no request`);
    }
  });

  test("a run's shape is noted when the agent settles", async (t) => {
    const state = await session(t);
    for (let i = 0; i < 3; i++) await run(state, `go on with part ${i}`, ANSWER_MEDIUM);
    const { runs } = recordOf(state).ledger;
    assert.equal(runs.length, 3, "three runs settled");
    assert.deepEqual(runs[2], { requests: 1, output: 1_000, growth: 0, seconds: 60 }, "one request of 1,000 output tokens, a minute long");
    assert.equal(recordOf(state).ledger.run, undefined, "no run is open after the agent settled");
  });

  test("a compaction and a move in the tree forget every cache", async (t) => {
    const state = await session(t);
    for (const event of ["session_compact", "session_tree"]) {
      await run(state, `go on ${event}`, ANSWER_MEDIUM);
      assert.ok(recordOf(state).ledger.seen.size > 0, `a model's cache is known before ${event}`);
      await state.loaded.host.emit(event, event === "session_tree" ? TO_ANOTHER_LEAF : {});
      assert.equal(recordOf(state).ledger.seen.size, 0, `${event} forgets every model's cache`);
      assert.equal(recordOf(state).ledger.latest, undefined, `${event} forgets the latest answer`);
      assert.equal(
        recordOf(state).ledger.runs.length > 0,
        event === "session_compact",
        event === "session_compact" ? "a compaction keeps the branch's runs" : "a move to another leaf starts the branch's runs afresh: runs are counted on the branch",
      );
    }
  });

  test("after a compaction the conversation's size is unknown until the next answer: the next prompt is not priced, and the run goes to the needed level", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    await state.loaded.host.emit("session_compact", {});
    assert.equal(recordOf(state).last?.ref, ASTRA, "the last responder is kept");
    assert.equal(recordOf(state).last?.usage, undefined, "its usage, the size before the compaction, is dropped");
    const level = await say(state, "go on", ANSWER_MEDIUM);
    assert.deepEqual(level.cost, { outcome: "unknown", why: "no usage yet" }, "a size the conversation no longer has is no usage: a missing figure is said");
    assert.equal(footer(state), `personal MEDIUM → gpt-6.1-terra (${demandNote(level)}; cost unknown)`, "the needed level's own model, and a missing figure is said: cost unknown");
    assert.equal(routed(await route(state, "go on")), TERRA, "the run goes to the needed level's own model");
    await answer(state, TERRA, 30_000);
    const next = await say(state, "go on again", ANSWER_MEDIUM);
    assert.notEqual(next.cost?.outcome, "unknown", `after the next answer the prompt is priced again: ${JSON.stringify(next.cost)}`);
  });

  test("a move to another leaf of the tree does the same and starts the branch's runs and needs afresh; a move to the same leaf changes nothing", async (t) => {
    const same = await session(t, { id: "same" });
    await threeSuperRuns(same);
    const before = recordOf(same);
    const seen = new Map(before.ledger.seen);
    const runs = [...before.ledger.runs];
    const needs = [...before.ledger.needs];
    const last = before.last;
    await same.loaded.host.emit("session_tree", { newLeafId: "e-here", oldLeafId: "e-here" });
    assert.deepEqual(
      [recordOf(same).ledger.seen, recordOf(same).ledger.runs, recordOf(same).ledger.needs, recordOf(same).last],
      [seen, runs, needs, last],
      "the leaf did not change: the caches, runs, needs and size are kept",
    );

    const moved = await session(t, { id: "moved" });
    await threeSuperRuns(moved);
    const writes = new Set(recordOf(moved).ledger.writes);
    await moved.loaded.host.emit("session_tree", TO_ANOTHER_LEAF);
    const { ledger } = recordOf(moved);
    assert.deepEqual([ledger.seen.size, ledger.runs, ledger.needs, ledger.run], [0, [], [], undefined], "another leaf: no cache, and the branch's runs and needs start afresh");
    assert.deepEqual(ledger.writes, writes, "the providers' cache writes are facts about the providers, and stay");
    assert.deepEqual([recordOf(moved).last?.ref, recordOf(moved).last?.usage], [ASTRA, undefined], "the size is unknown until the next answer");
    const level = await say(moved, "go on", ANSWER_MEDIUM);
    assert.deepEqual(level.cost, { outcome: "unknown", why: "no usage yet" }, "a size the conversation no longer has is no usage: a missing figure is said");
    assert.equal(routed(await route(moved, "go on")), TERRA, "the run goes to the needed level's own model");
  });

  test("a session started right after a compaction, as Pi's context usage says, is seeded without a size or a cache", async (t) => {
    const state = await session(t, {
      setup: (s) => {
        s.appendAssistant(assistant(ASTRA, { usage: usageOf(150_000), timestamp: NOW - 90_000, thinkingLevel: "high" }), new Date(NOW - 30_000).toISOString());
        // Pi's sign for "right after compaction, before the next response".
        (s.ctx as unknown as Record<string, unknown>).getContextUsage = () => ({ tokens: null, contextWindow: 272_000, percent: null });
      },
    });
    assert.equal(recordOf(state).ledger.seen.size, 0, "no answer is seeded into the ledger: no model has the compacted conversation cached");
    assert.deepEqual([recordOf(state).last?.ref, recordOf(state).last?.usage], [ASTRA, undefined], "the last responder is seeded without its size");
    const level = await say(state, "go on", ANSWER_MEDIUM);
    assert.deepEqual(level.cost, { outcome: "unknown", why: "no usage yet" }, "the first prompt's cost is unknown: a missing figure is said");
  });

  test("a session whose context usage cannot be read is seeded as before", async (t) => {
    for (const [name, read] of [
      ["undefined", () => undefined],
      ["a throw", () => { throw new Error("stale"); }],
      ["a known size", () => ({ tokens: 150_000, contextWindow: 272_000, percent: 55 })],
    ] as const) {
      resetSlot();
      const state = await session(t, {
        id: name,
        setup: (s) => {
          s.appendAssistant(assistant(ASTRA, { usage: usageOf(150_000), timestamp: NOW - 90_000, thinkingLevel: "high" }), new Date(NOW - 30_000).toISOString());
          (s.ctx as unknown as Record<string, unknown>).getContextUsage = read;
        },
      });
      assert.equal(recordOf(state).ledger.seen.get(ASTRA)?.tokens, 149_000, `${name}: astra is seeded warm, as before`);
      assert.ok(recordOf(state).last?.usage !== undefined, `${name}: the last responder keeps its size`);
    }
  });

  test("the deep-session floor does not read a size from before a compaction", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    await state.loaded.host.emit("session_compact", {});
    const level = await say(state, "rename foo to bar", ANSWER_LOW);
    assert.ok(level.demand !== undefined, "an untagged run has a demand");
    assert.equal(level.demand.guards.includes("deep-session"), false, "150,000 tokens were compacted away: no deep-session floor");
    assert.equal(level.need, "low", "Jev's LOW stands");
    assert.equal(routed(await route(state, "rename foo to bar")), LUNA, "the run goes to LOW's own model");
  });

  test("a resumed session keeps its model's cache", async (t) => {
    const state = await session(t, {
      setup: (s) => s.appendAssistant(assistant(ASTRA, { usage: usageOf(150_000), timestamp: NOW - 90_000, thinkingLevel: "high" }), new Date(NOW - 30_000).toISOString()),
    });
    const { ledger } = recordOf(state);
    assert.deepEqual(ledger.seen.get(ASTRA), { tokens: 149_000, at: NOW - 30_000, effort: "high" }, "astra is seen at its prompt size, at the entry's time");
    assert.deepEqual(ledger.runs, [], "seeding counts no run");
    const text = "go on";
    const level = await say(state, text, ANSWER_MEDIUM);
    const cost = knownCost(level);
    const astra = cost.priced.find((entry) => entry.ref === ASTRA);
    assert.deepEqual([astra?.cached, astra?.survival], [149_000, 0.97], "astra is priced with its cache, 30 seconds old, not as a cold model");
    const expected = expectedCosts({ tokens: 150_000 + promptTokens(text, NOW), cached: 149_000, shape: RUN_DEFAULTS, horizon: 1, again: 0.5 });
    assert.ok(Math.abs((astra?.cost ?? 0) - expected.astra) < 1e-9, `astra's cost is runCost's with the cache: ${astra?.cost} against ${expected.astra}`);
  });

  test("seeding stops at a rewrite: a response before a smaller prompt of the same model is not counted", async (t) => {
    const state = await session(t, {
      setup: (s) => {
        s.appendAssistant(assistant(TERRA, { usage: usageOf(91_000), timestamp: NOW - 300_000 }));
        s.appendAssistant(assistant(ASTRA, { usage: usageOf(151_000), timestamp: NOW - 200_000 }));
        s.appendAssistant(assistant(ASTRA, { usage: usageOf(31_000), timestamp: NOW - 100_000 }));
      },
    });
    const { ledger } = recordOf(state);
    assert.deepEqual([...ledger.seen.keys()], [ASTRA], "the rewrite forgot terra's cache");
    assert.equal(ledger.seen.get(ASTRA)?.tokens, 30_000, "astra at its size after the rewrite");
  });
});

describe("a planned run", () => {
  test("stays on the warm stronger model for a short lighter prompt, and the footer says so", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    const text = "go on";
    const level = await say(state, text, ANSWER_MEDIUM);
    const expected = expectedCosts({ tokens: 150_000 + promptTokens(text, state.clock), cached: 149_000, shape: ONE_REQUEST, horizon: 1, again: 1 });
    assert.ok(expected.astra < Math.min(expected.terra, expected.sol), `staying on astra is cheapest: ${JSON.stringify(expected)}`);
    assert.equal(
      footer(state),
      `personal MEDIUM → gpt-6-astra (${demandNote(level)}; stayed, ${money(expected.astra)} vs ${money(Math.min(expected.terra, expected.sol))})`,
      "the footer names the level the prompt needs, the model that keeps it and the two costs compared",
    );
    const planned = recordOf(state).plan;
    assert.deepEqual([planned?.level?.need, planned?.level?.tier, planned?.level?.steppedUp], ["medium", "super", false], "the plan's tier is the level of the model that keeps the run; no step-up");
    assert.ok(planned?.decision.ok === true && planned.decision.choice.role === "super" && planned.role === "super", "the plan's decision is that level's role pick");
    const routedTo = await route(state, text);
    assert.deepEqual([routedTo.model.provider, routedTo.model.id], ["openai-codex-2", "gpt-6-astra"], "the request really goes to astra, not to terra");
    const entry = recordOf(state).history.at(-1);
    assert.deepEqual([entry?.level?.need, entry?.level?.tier, entry?.role, entry?.ref], ["medium", "super", "super", ASTRA], "the history's entry has need medium, tier super");
  });

  test("moves at the first lighter prompt while the session's runs are long: the default shape is five requests", async (t) => {
    const state = await session(t);
    assert.equal(await run(state, "design the whole thing", ANSWER_SUPER), ASTRA, "the SUPER run goes to astra");
    const text = "go on";
    const level = await say(state, text, ANSWER_MEDIUM);
    const cost = knownCost(level);
    assert.deepEqual(
      [cost.workload.requests, cost.workload.output, cost.workload.growth, cost.workload.seconds, cost.workload.horizon],
      [5, 800, 1_500, 120, 1],
      "with fewer than three runs the default shape is priced",
    );
    const expected = expectedCosts({ tokens: 150_000 + promptTokens(text, state.clock), cached: 149_000, shape: RUN_DEFAULTS, horizon: 1, again: 0.5 });
    assert.ok(expected.terra < expected.astra * (1 - DEFAULT_SWITCHING.margin), `terra undercuts astra by the margin: ${JSON.stringify(expected)}`);
    assert.equal(footer(state), `personal MEDIUM → gpt-6.1-terra (${demandNote(level)}; moved, ${money(expected.terra)} vs ${money(expected.astra)})`, "the footer names the cost of the move and of staying");
    assert.equal(routed(await route(state, text)), TERRA, "the request goes to terra");
  });

  test("moves down when lighter prompts keep coming, and says what it compared", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    const expectations = [
      { horizon: 1, again: 1, outcome: "stayed" },
      { horizon: 2, again: 3 / 4, outcome: "stayed" },
      { horizon: 3, again: 3 / 5, outcome: "moved" },
    ] as const;
    for (const [index, { horizon, again, outcome }] of expectations.entries()) {
      const text = `go on with step ${index}`;
      const level = await say(state, text, ANSWER_MEDIUM);
      const cost = knownCost(level);
      assert.equal(cost.workload.horizon, horizon, `prompt ${index + 1}: each earlier lighter prompt that stayed on astra adds one to the horizon`);
      assert.equal(cost.again, again, `prompt ${index + 1}: the share of the prompts that needed SUPER`);
      assert.equal(cost.outcome, outcome, `prompt ${index + 1}`);
      const expected = expectedCosts({ tokens: 150_000 + promptTokens(text, state.clock), cached: 149_000, shape: ONE_REQUEST, horizon, again });
      const note =
        outcome === "stayed"
          ? `stayed, ${money(expected.astra)} vs ${money(Math.min(expected.terra, expected.sol))}`
          : `moved, ${money(expected.terra)} vs ${money(expected.astra)}`;
      const modelId = outcome === "stayed" ? "gpt-6-astra" : "gpt-6.1-terra";
      assert.equal(footer(state), `personal MEDIUM → ${modelId} (${demandNote(level)}; ${note})`, `prompt ${index + 1}`);
      const ref = routed(await route(state, text));
      assert.equal(ref, outcome === "stayed" ? ASTRA : TERRA, `prompt ${index + 1} goes where the cost said`);
      await answer(state, ref);
    }
  });

  test("says what it chose when the cost puts a run on a warm stronger model and no candidate answered last", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    // A model of no candidate level answers last: LOW's luna, picked by hand for a moment.
    await state.loaded.host.emit("message_end", { message: assistant(LUNA, { usage: usageOf(150_000), timestamp: state.clock, thinkingLevel: "high" }) });
    await state.loaded.host.emit("agent_settled", { aborted: false });
    const text = "go on";
    const level = await say(state, text, ANSWER_MEDIUM);
    const cost = knownCost(level);
    assert.deepEqual([cost.outcome, cost.current, cost.chosen], ["only", undefined, ASTRA], "luna is no candidate for MEDIUM, and astra's warm cache makes it the cheapest");
    // With no current model nothing is left behind: no cost of leaving.
    const expected = expectedCosts({ tokens: 150_000 + promptTokens(text, state.clock), cached: 149_000, shape: ONE_REQUEST, horizon: 1, again: 0 });
    assert.ok(expected.astra < expected.terra, `astra warm costs less than terra cold: ${JSON.stringify(expected)}`);
    assert.equal(
      footer(state),
      `personal MEDIUM → gpt-6-astra (${demandNote(level)}; chose, ${money(expected.astra)} vs ${money(expected.terra)})`,
      "a choice by cost with no current candidate names the chosen model's cost against the needed level's own model's",
    );
    assert.equal(routed(await route(state, text)), ASTRA, "the request goes to astra");
  });

  test("says nothing of the cost when no candidate answered last and the needed level's own model is chosen", async (t) => {
    const state = await session(t);
    assert.equal(await run(state, "go on", ANSWER_MEDIUM), TERRA, "the first MEDIUM run goes to terra");
    const level = await say(state, "design the whole thing", ANSWER_SUPER);
    const cost = knownCost(level);
    assert.deepEqual([cost.outcome, cost.chosen], ["only", ASTRA], "terra is below SUPER: astra, the needed level's own model, is the only candidate");
    assert.equal(footer(state), `personal SUPER → gpt-6-astra (${demandNote(level)})`, "the needed level's own model chosen with no current candidate: no note");
  });

  test("says the cost is unknown on a session's first prompt", async (t) => {
    const state = await session(t);
    const level = await say(state, "go on", ANSWER_MEDIUM);
    assert.deepEqual(level.cost, { outcome: "unknown", why: "no usage yet" }, "no usage yet");
    assert.equal(footer(state), `personal MEDIUM → gpt-6.1-terra (${demandNote(level)}; cost unknown)`, "the needed level's own model, and a missing figure is said: cost unknown");
  });

  test("counts each prompt's need and the level it took", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    await say(state, "go on", ANSWER_MEDIUM);
    await route(state, "go on");
    assert.equal(recordOf(state).need, "medium", "the session's last planned run needed MEDIUM");
    assert.equal(recordOf(state).runTier, "super", "the run under way is on SUPER's model");
    assert.deepEqual(
      recordOf(state).ledger.needs,
      [
        { need: "super", took: "super" },
        { need: "super", took: "super" },
        { need: "super", took: "super" },
        { need: "medium", took: "super" },
      ],
      "each prompt's need, and the level whose model took it",
    );
    await answer(state, ASTRA);
    assert.equal(recordOf(state).runTier, undefined, "no run is under way once the agent settled");
    assert.equal(recordOf(state).need, "medium", "the need outlives its run");
  });

  test("the price assumes the thinking level the request then carries", async (t) => {
    const state = await session(t);
    const { loaded } = state;
    assert.equal(await run(state, "design the whole thing", ANSWER_SUPER), ASTRA, "the SUPER run goes to astra at high");
    loaded.host.thinking = "low";
    const astraModel = loaded.runtime.physical(ASTRA);
    assert.notEqual(effortOf(astraModel, "low"), effortOf(astraModel, "high"), "astra sends low and high as two efforts");
    const level = await say(state, "design the rest", ANSWER_SUPER);
    const priced = knownCost(level).priced.find((entry) => entry.ref === ASTRA);
    assert.equal(priced?.cached, 0, "astra at the newly selected level is priced with nothing cached");
    const sent = await route(state, "design the rest");
    assert.deepEqual([routed(sent), sent.thinkingLevel], [ASTRA, "low"], "the request goes to astra at the level the price assumed");
    await answer(state, ASTRA, 150_000, sent.thinkingLevel);
    const again = await say(state, "design one more part", ANSWER_SUPER);
    assert.equal(knownCost(again).priced.find((entry) => entry.ref === ASTRA)?.cached, 149_000, "answered at that level, astra is warm for it");
  });

  test("a hand-picked model is never priced or moved", async (t) => {
    const state = await session(t, { select: ASTRA });
    const { loaded } = state;
    await loaded.host.emit("input", { text: "go on", source: "interactive" });
    assert.equal(recordOf(state).plan, undefined, "nothing is planned for a model picked by hand");
    assert.equal(loaded.session.statuses.has(LEVEL_KEY), false, "and the footer shows no level");
    loaded.session.startRun();
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "go on" });
    await answer(state, ASTRA);
    assert.equal(recordOf(state).ledger.seen.get(ASTRA)?.tokens, 149_000, "the ledger still notes its answers");
    assert.equal(recordOf(state).ledger.runs.length, 1, "and its runs");
    assert.deepEqual(recordOf(state).ledger.needs, [], "but no prompt's need: none was planned");
  });

  test("a work session never leaves the work account, whatever the prices", async (t) => {
    // Work's models at ten times John's prices, so that every personal model would be cheaper.
    const dear = (ref: string): Model<Api> => {
      const price = priceOf(ref);
      return codex(ref, { cost: { input: price.input * 10, output: price.output * 10, cacheRead: price.cacheRead * 10, cacheWrite: price.cacheWrite * 10 } });
    };
    const state = await session(t, { catalog: catalog(...TIERS.map((tier) => dear(WORK_OWN[tier]))), setup: (s) => s.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW)) });
    assert.equal(await run(state, "design the whole thing", ANSWER_SUPER), WORK_ASTRA, "the SUPER run goes to the work account's astra");
    const level = await say(state, "go on", ANSWER_MEDIUM);
    const cost = knownCost(level);
    assert.deepEqual(
      cost.priced.map((entry) => entry.ref),
      [WORK_TERRA, WORK_SOL, WORK_ASTRA],
      "every candidate is a work level model, on the work account",
    );
    assert.ok(routed(await route(state, "go on")).startsWith("openai-codex-3/"), "the request goes to the work account");
  });

  test("with Pi's compaction disabled, a level model the conversation does not fit is no candidate, and the run steps up", async (t) => {
    const state = await session(t, { catalog: catalog(codex(TERRA, { contextWindow: 128_000 })) });
    state.loaded.host.settings = { compaction: { enabled: false } };
    assert.equal(await run(state, "design the whole thing", ANSWER_SUPER), ASTRA, "the SUPER run goes to astra");
    const level = await say(state, "go on", ANSWER_MEDIUM);
    const planned = recordOf(state).plan;
    assert.ok(planned?.decision.ok === true, "the run has a model");
    assert.deepEqual([planned.decision.choice.ref, planned.code, level.tier, level.steppedUp], [SOL, "step-up", "high", true], "terra cannot hold 150,000 tokens and Pi would not compact: the run steps up to sol");
    assert.equal(level.cost, undefined, "a step-up is not priced");
    assert.deepEqual(state.loaded.session.notices.at(-1), { type: "info", message: stepUpNotice("medium", "high", "gpt-6.1-sol") }, "the step-up is said as before");
  });
});

describe("what the session records and shows", () => {
  test("the record gains the cost terms and holds no prompt text", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    const text = `${MARK} go on`;
    const level = await say(state, text, ANSWER_MEDIUM);
    const cost = knownCost(level);
    await answer(state, routed(await route(state, text)));
    const entries = state.loaded.session.entries.filter((entry) => entry.customType === LEVEL_ENTRY);
    const record = (entries.at(-1)?.data ?? {}) as Record<string, unknown>;
    assert.deepEqual(
      record.cost,
      {
        outcome: "stayed",
        chosen: ASTRA,
        current: ASTRA,
        requests: 1,
        horizon: 1,
        again: 1,
        candidates: cost.priced.map(({ ref, tier, cost: dollars, leaving, cached, survival, compacts }) => ({ ref, tier, cost: dollars, leaving, cached, survival, compacts })),
      },
      "the outcome, the chosen and current models, the run priced and one row per candidate",
    );
    assert.deepEqual(
      (record.cost as { candidates: Array<{ ref: string }> }).candidates.map((row) => row.ref),
      [TERRA, SOL, ASTRA],
      "one row per candidate",
    );
    const first = (entries[0]?.data ?? {}) as Record<string, unknown>;
    assert.deepEqual(first.cost, { outcome: "unknown", why: "no usage yet" }, "the first run's record says its cost was unknown, and why");
    const json = JSON.stringify(entries);
    assert.ok(!json.includes(MARK), json);
  });

  test("/smart-router status shows the terms of the latest decision, after the run's continuations too", async (t) => {
    const state = await session(t);
    await threeSuperRuns(state);
    const text = "go on";
    const level = await say(state, text, ANSWER_MEDIUM);
    await route(state, text);
    // A continuation of the run: its history entry carries no level.
    const { runtime } = state.loaded;
    const signal = state.loaded.session.controller?.signal;
    assert.ok(signal !== undefined, "the run is under way");
    runtime.route("auto", request("continuation", { signal, previous: previous(runtime, ASTRA) }));
    assert.equal(recordOf(state).history.at(-1)?.level, undefined, "the last history entry is the continuation's, without a level");
    await state.loaded.host.command("smart-router", "status");
    const status = state.loaded.session.notices.at(-1)?.message ?? "";
    const lines = status.split("\n");
    const at = lines.findIndex((line) => line.startsWith("Last decision: "));
    assert.ok(at >= 0, status);
    const { demand } = level;
    assert.ok(demand?.jev !== undefined, "Jev answered");
    const tokens = 150_000 + promptTokens(text, state.clock);
    const expected = expectedCosts({ tokens, cached: 149_000, shape: ONE_REQUEST, horizon: 1, again: 1 });
    const leaving = expected.terra - runCost({ ref: TERRA, tier: "medium", rates: rates(TERRA), cached: 0, idle: undefined, compacts: false }, { tokens, horizon: 1, ...ONE_REQUEST }, TABLE);
    const terms = [
      `  Demand ${demand.value.toFixed(2)} → ${tierLabel(level.need)}: Jev ${demand.jev.value.toFixed(2)} at ${Math.round(demand.jev.confidence * 100)}%, heuristics ${demand.heuristics.value.toFixed(2)} (${demand.heuristics.top
        .map(([signal, share]) => `${signal} ${share.toFixed(2)}`)
        .join(", ")})${demand.guards.length > 0 ? `; guards: ${demand.guards.join(", ")}` : ""}.`,
      `  Cost of 1 request, horizon 1: gpt-6-astra ${money(expected.astra)} (149,000 cached, 97%); gpt-6.1-sol ${money(expected.sol)} (nothing cached; leaving gpt-6-astra ${money(leaving)}); gpt-6.1-terra ${money(expected.terra)} (nothing cached; leaving gpt-6-astra ${money(leaving)}).`,
    ];
    assert.deepEqual(lines.slice(at + 1, at + 3), terms, "the latest decision's demand terms and each candidate's cost, the stronger first, though a continuation came after it");
    assert.deepEqual(decisionLines(level), terms, "decisionLines gives the same two lines");
  });

  test("decisionLines says why a cost is unknown, and that Jev gave no answer; a tagged level gives none", async (t) => {
    const state = await session(t);
    state.loaded.runtime.answer = async () => ({ ...jevAnswer(ANSWER_MEDIUM), answers: {}, stopReason: "error", errorMessage: "Request timed out after 1000ms" });
    await state.loaded.host.emit("input", { text: "go on", source: "interactive" });
    const level = recordOf(state).pendingLevel?.level;
    assert.ok(level?.demand !== undefined, "an untagged run has a demand");
    const lines = decisionLines(level);
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.ok(lines[0]?.includes(": no Jev answer (timeout), heuristics "), lines[0]);
    assert.equal(lines[1], "  Cost unknown: no usage yet.", "an unknown cost says why");
    await state.loaded.host.emit("input", { text: "go on #high", source: "interactive" });
    const tagged = recordOf(state).pendingLevel?.level;
    assert.ok(tagged !== undefined && tagged.source === "tag", "a tagged level");
    assert.deepEqual(decisionLines(tagged), [], "a tagged level gives no lines");
  });

  test("the demand line names every guard that applied, in the order applied, and none when none did", () => {
    const base: PlanLevel = {
      scope: "personal",
      need: "high",
      tier: "high",
      source: "jev",
      steppedUp: false,
      returnedToFirst: false,
      demand: { value: 1.42, tier: "high", jev: { value: 1.3, confidence: 0.7 }, heuristics: { value: 1.9, score: 0.37, top: [["turn_type", 0.09]] }, guards: ["close-call"] },
    };
    assert.deepEqual(
      decisionLines(base),
      ["  Demand 1.42 → HIGH: Jev 1.30 at 70%, heuristics 1.90 (turn_type 0.09); guards: close-call."],
      "a close call alone is named: any guard that applied",
    );
    const both: PlanLevel = { ...base, source: "floor", demand: { ...base.demand!, guards: ["close-call", "risky"] } };
    assert.match(decisionLines(both)[0] ?? "", /; guards: close-call, risky\.$/, "every guard, in the order the demand applied them");
    const none: PlanLevel = { ...base, demand: { ...base.demand!, guards: [] } };
    assert.match(decisionLines(none)[0] ?? "", /\(turn_type 0\.09\)\.$/, "no guard applied: nothing is said of guards");
  });
});
