// The router's input on a version 2 roster: a trailing tag is removed with an input transform, Jev
// is asked through Pi's model registry (an untagged message waits for its answer, a tagged one
// only records its opinion), and the run is planned with the tier chosen. Unit tests on the fake
// host of test/support/pi.ts; no Pi runtime is started.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { Api, ClassifierResult, Model } from "@earendil-works/pi-ai";
import type { InputEventResult } from "@earendil-works/pi-coding-agent";

import { ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY, SCOPE_ENTRY } from "../src/constants.ts";
import { HEURISTIC_MESSAGES } from "../src/demand.ts";
import { isRecord } from "../src/files.ts";
import { readLevelRecord } from "../src/records.ts";
import { JEV_INSTRUCTIONS } from "../src/jev.ts";
import { createRouter } from "../src/router.ts";
import { scopeEntry } from "../src/scope.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, DEEPSEEK, FakeCatalog, GLM, GLM_CLOUD, HERA_LAN, heraModels, KIMI, model, NOW, SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, failure as failedRequest, FakeRuntime, load, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded, LoadOptions } from "./support/pi.ts";

const HERA_V2 = fixture("roster-hera-v2.json");
const JEV = "openrouter/typesafe/jev-1.14";
const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";
const WORK_LUNA = "openai-codex-3/gpt-6-luna";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const WORK_ASTRA = "openai-codex-3/gpt-6-astra";
const ACME = "/Users/johnw/src/acme";
const ACME_APP = "/Users/johnw/src/acme/app";
/** Hera's personal descriptions, which Jev reads as its criteria. */
const PERSONAL: Readonly<Record<Tier, string>> = {
  low: "Mechanical or trivial work that follows a clear specification",
  medium: "Engineering, implementation and validation",
  high: "Deep thought, review, and the design of verification",
  super: "Deep thought, research, design and planning",
};
const LOW: Record<Tier, number> = { low: 0.8, medium: 0.1, high: 0.05, super: 0.05 };
const MEDIUM: Record<Tier, number> = { low: 0.1, medium: 0.8, high: 0.05, super: 0.05 };
const HIGH: Record<Tier, number> = { low: 0.05, medium: 0.1, high: 0.8, super: 0.05 };
const SUPER: Record<Tier, number> = { low: 0.05, medium: 0.05, high: 0.1, super: 0.8 };
/** A tagged run's level when it goes to its tag's tier. */
const TAGGED_HIGH = { scope: "personal", need: "high", tier: "high", source: "tag", steppedUp: false, returnedToFirst: false } as const;

beforeEach(resetSlot);
afterEach(resetSlot);

/** A Codex model, as Hera's catalog lists them. */
const codex = (ref: string): Model<Api> => model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 });

/** Hera's catalog with every model of its version 2 roster: both Codex accounts, OpenRouter, Nyx and Hera's Qwen. */
const v2Catalog = (): FakeCatalog =>
  new FakeCatalog([
    ...heraModels(),
    codex(LUNA),
    codex(TERRA),
    model(NYX_QWEN, { baseUrl: "https://nyx.lan/v1", contextWindow: 98_304 }),
    model(HERA_QWEN, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
    codex(WORK_LUNA),
    codex(WORK_TERRA),
    codex(WORK_ASTRA),
  ]);

/** A runtime over that catalog whose registry finds Jev. Every classify call fails until a test scripts it. */
function heraRuntime(): FakeRuntime {
  const runtime = new FakeRuntime(v2Catalog());
  runtime.addClassifier(JEV);
  return runtime;
}

type HeraOptions = Partial<Omit<LoadOptions, "dir">> & { readonly roster?: string; readonly select?: string };

/** A session on Hera's version 2 roster, or `roster`, with smart-router/auto selected and the clock at NOW. */
function hera(t: TestContext, options: HeraOptions = {}): Promise<Loaded> {
  const { roster = HERA_V2, ...rest } = options;
  return start({ dir: agentDir(t, { roster }), runtime: heraRuntime(), now: () => NOW, ...rest });
}

/** Jev's answer with these probabilities: its choice is the most probable tier. */
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

/** A classification that failed, as pi-ai reports one. */
function jevFailure(errorMessage: string): ClassifierResult {
  return { api: "typesafe-system-one", provider: "openrouter", model: "typesafe/jev-1.14", answers: {}, stopReason: "error", errorMessage, timestamp: NOW };
}

/** What the router makes of Jev's answer to a question it asked at NOW: its choice and probabilities, and no time spent. */
function outcome(probabilities: Record<Tier, number>, choice: Tier) {
  return { kind: "answer", model: JEV, choice, probabilities, confidence: probabilities[choice], ms: 0 } as const;
}

/** A level without its demand, which an untagged run's level always has and a tagged run's never. */
function withoutDemand<T extends { readonly source?: unknown; readonly demand?: unknown }>(level: T | undefined): Omit<T, "demand"> | undefined {
  if (level === undefined) return undefined;
  const { demand, ...rest } = level;
  assert.equal(demand !== undefined, level.source !== "tag", `an untagged run has a demand, and a tagged run none: ${JSON.stringify(level)}`);
  return rest;
}

function close(actual: number | undefined, expected: number, message: string): void {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.01, `${message}: ${actual} is not within 0.01 of ${expected}`);
}

/** A promise the test settles. */
function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Let every callback of a settled promise run. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const recordOf = (loaded: Loaded) => loaded.router?.record(loaded.session.id);
const lastNotice = (loaded: Loaded) => loaded.session.notices.at(-1);
const calls = (loaded: Loaded): number => loaded.runtime.classifyCalls.length;

/** A message typed while the session is idle, unless `init` says otherwise. */
function say(loaded: Loaded, text: string, init: Record<string, unknown> = {}): Promise<unknown[]> {
  return loaded.host.emit("input", { text, source: "interactive", ...init });
}

/** Start the run and route its first request. */
function firstRequest(loaded: Loaded): string {
  const signal = loaded.session.startRun();
  return routed(loaded.runtime.route("auto", request("user", { signal })));
}

/**
 * Start a prompt's run as Pi's _startRun does once the prompt's input handlers have returned: the
 * session turns busy, before_agent_start carries the prompt (expanded, when Pi expands a template
 * or skill), and the run's first request routes.
 */
async function runPrompt(loaded: Loaded, prompt: string): Promise<string> {
  const signal = loaded.session.startRun();
  await loaded.host.emit("before_agent_start", { messageType: "user", prompt });
  return routed(loaded.runtime.route("auto", request("user", { signal })));
}

/** An extension loaded after the router, whose async input handler can hold a message, handle it or transform it. */
function laterExtension(loaded: Loaded) {
  const holds = new Map<string, Promise<void>>();
  const handled = new Set<string>();
  const transforms = new Map<string, string>();
  loaded.host.api.on("input", async (event): Promise<InputEventResult | undefined> => {
    const gate = holds.get(event.text);
    if (gate !== undefined) await gate;
    if (handled.has(event.text)) return { action: "handled" };
    const to = transforms.get(event.text);
    return to === undefined ? undefined : { action: "transform", text: to };
  });
  return { holds, handled, transforms };
}

/** Pi's examples/extensions/input-transform.ts, loaded after the router. */
function inputTransform(loaded: Loaded): void {
  loaded.host.api.on("input", async (event, ctx): Promise<InputEventResult> => {
    if (event.source === "extension") return { action: "continue" };
    if (event.text.startsWith("?quick ")) return { action: "transform", text: `Respond briefly in 1-2 sentences: ${event.text.slice(7).trim()}` };
    if (event.text.toLowerCase() === "ping") {
      ctx.ui.notify("pong", "info");
      return { action: "handled" };
    }
    return { action: "continue" };
  });
}

const UNMATCHED = "pi-smart-router: a tagged message's level could not be matched to the run that started, so it was dropped.";
/**
 * The rule a run follows when its first request has no plan of its own, on smart-router/auto under a
 * version 2 roster: a prompt's run whose message's plan could not be matched to it is planned by
 * nothing, as a custom message's run is (design, "Requests inside a run").
 */
const RUN_NEED = "a run that starts without a plan takes the level its session last needed and goes through the same choice (run:need), never another message's plan";
const GOAL_X = { role: "custom", customType: "goal-x", content: "continue", display: false, timestamp: NOW };

/** Two messages that overlap a Jev wait, and the two answers, settled when the test says. */
async function overlap(loaded: Loaded, first: string, second: string) {
  const answers = [deferred<ClassifierResult>(), deferred<ClassifierResult>()] as const;
  const queue = answers.map((answer) => answer.promise);
  loaded.runtime.answer = () => queue.shift() ?? Promise.reject(new Error("one call per message"));
  const one = say(loaded, first);
  await settled();
  const two = say(loaded, second);
  await settled();
  assert.equal(calls(loaded), 2, "both messages are waiting for Jev");
  return { one, two, earlier: answers[0], later: answers[1] };
}

/** The run ends: a response from `ref`, then agent_settled. */
async function finish(loaded: Loaded, ref: string, init: Parameters<typeof assistant>[1] = {}): Promise<void> {
  await loaded.host.emit("message_end", { message: assistant(ref, init) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
}

/** A message entry on the branch, as Pi records one. */
function messageEntry(session: Loaded["session"], message: Record<string, unknown>): void {
  session.entries.push({ type: "message", id: `e${session.entries.length}`, parentId: null, timestamp: new Date(NOW).toISOString(), message });
}

/** A user message on the branch, as Pi records one. */
function userEntry(session: Loaded["session"], text: string): void {
  session.entries.push({ type: "message", id: `e${session.entries.length}`, parentId: null, timestamp: new Date(NOW).toISOString(), message: { role: "user", content: text, timestamp: NOW } });
}

async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

describe("a trailing tag", () => {
  test("is removed with a transform, and the run goes to its tier at once while Jev's opinion is asked without waiting", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = () => new Promise(() => {});
    const first = await Promise.race([say(loaded, "go ahead #high"), settled().then(() => "it waited")]);
    assert.deepEqual(first, [{ action: "transform", text: "go ahead" }], "the input returns before an answer that never comes");
    assert.equal(calls(loaded), 1, "Jev was asked once");
    assert.equal(recordOf(loaded)?.pendingLevel?.jev, "pending");
    assert.equal(firstRequest(loaded), SOL);
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level, TAGGED_HIGH);
  });

  test("is never a last word an object inherits: the message keeps it, with no notice, and Jev reads all of it", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(MEDIUM);
    for (const text of ["add a logger parameter to the constructor", "what is the __proto__"]) {
      assert.deepEqual(await say(loaded, text), [undefined], text);
      assert.equal(loaded.runtime.classifyCalls.at(-1)?.context.state.message, text, text);
      assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.plan?.level?.source], ["medium", "jev"], text);
    }
    assert.deepEqual(loaded.session.notices, []);
  });

  test("leaves a later extension the text without it; a message that is only a tag reaches no later extension", async (t) => {
    const loaded = await hera(t);
    const seen: string[] = [];
    loaded.host.api.on("input", (event) => {
      seen.push(event.text);
    });
    assert.deepEqual(await say(loaded, "go ahead #H"), [{ action: "transform", text: "go ahead" }, undefined]);
    assert.deepEqual(await say(loaded, "#h"), [{ action: "handled" }]);
    assert.deepEqual(seen, ["go ahead"]);
  });

  test("that is the whole message sends nothing, with a notice, and plans no run", async (t) => {
    const loaded = await hera(t);
    assert.deepEqual(await say(loaded, "#low"), [{ action: "handled" }]);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: "pi-smart-router: the message was only a LOW tag, so nothing was sent. Put the tag at the end of a message." });
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, calls(loaded)], [undefined, undefined, 0]);
    assert.deepEqual(await say(loaded, "  #S \n"), [{ action: "handled" }]);
    assert.match(lastNotice(loaded)?.message ?? "", /only a SUPER tag/);
  });

  test("is removed even when the handler fails after reading it, and the failure is reported once", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    let broken = false;
    const loaded = load({
      dir,
      runtime: heraRuntime(),
      build: (pi, options) =>
        createRouter(pi, {
          ...options,
          agentDir: () => {
            if (broken) throw new Error("the agent directory is gone");
            return dir;
          },
        }),
    });
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "startup" });
    broken = true;
    assert.deepEqual(await say(loaded, "go ahead #high"), [{ action: "transform", text: "go ahead" }]);
    assert.deepEqual(await say(loaded, "and this"), [undefined]);
    assert.deepEqual(loaded.session.notices, [{ type: "warning", message: "pi-smart-router: the input handler failed: the agent directory is gone" }]);
  });

  test("has no effect while a run is under way: removed with a notice, Jev is not asked, and the run's plan stays", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead");
    const plan = recordOf(loaded)?.plan;
    const pending = recordOf(loaded)?.pendingLevel;
    assert.ok(plan !== undefined && pending !== undefined);
    loaded.session.startRun();
    const before = calls(loaded);
    for (const streamingBehavior of ["steer", "followUp"]) {
      assert.deepEqual(await say(loaded, "x #low", { streamingBehavior }), [{ action: "transform", text: "x" }], streamingBehavior);
      assert.equal(calls(loaded), before, `${streamingBehavior}: Jev is not asked`);
      assert.deepEqual(lastNotice(loaded), {
        type: "warning",
        message: "pi-smart-router: the LOW tag was removed and has no effect, because a run is under way, and it keeps its model until it ends.",
      });
      assert.equal(recordOf(loaded)?.plan, plan, streamingBehavior);
      assert.equal(recordOf(loaded)?.pendingLevel, pending, streamingBehavior);
    }
  });

  test("has no effect off smart-router/auto: removed with a notice, and Jev is not asked", async (t) => {
    const local = await hera(t, { select: "local" });
    assert.deepEqual(await say(local, "x #high"), [{ action: "transform", text: "x" }]);
    assert.deepEqual(lastNotice(local), {
      type: "warning",
      message: "pi-smart-router: the HIGH tag was removed and has no effect, because only smart-router/auto routes by level, and the selection is smart-router/local.",
    });
    assert.deepEqual([recordOf(local)?.plan?.signal, recordOf(local)?.pendingLevel], ["local", undefined]);
    const physical = await hera(t, { id: "physical", select: SOL });
    assert.deepEqual(await say(physical, "x #high"), [{ action: "transform", text: "x" }]);
    assert.match(lastNotice(physical)?.message ?? "", /no effect, because only smart-router\/auto routes by level, and the selection is openai-codex-2\/gpt-6\.1-sol\.$/);
    assert.equal(recordOf(physical)?.plan, undefined);
    assert.deepEqual([calls(local), calls(physical)], [0, 0]);
  });

  test("has no effect in a scope smart-router/auto refuses, where nothing is planned and Jev is not asked", async (t) => {
    const unreadable = await hera(t, { id: "unreadable", setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    const unserved = await start({ dir: agentDir(t, { roster: fixture("roster-work.json") }), runtime: heraRuntime(), id: "unserved", now: () => NOW });
    for (const loaded of [unreadable, unserved]) {
      const name = loaded.session.id;
      loaded.runtime.answer = async () => jevAnswer(LOW);
      assert.deepEqual(await say(loaded, "go ahead"), [undefined], name);
      assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, recordOf(loaded)?.lastInput], [undefined, undefined, undefined], name);
      assert.deepEqual(await say(loaded, "go ahead #high"), [{ action: "transform", text: "go ahead" }], name);
      assert.deepEqual(
        loaded.session.notices,
        [{ type: "warning", message: "pi-smart-router: the HIGH tag was removed and has no effect, because smart-router/auto refuses this session's scope." }],
        `${name}: the notice, and no step-up`,
      );
      assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, recordOf(loaded)?.lastInput, calls(loaded)], [undefined, undefined, undefined, 0], name);
    }
  });

  test("has no effect under a version 1 roster: removed with a notice, Jev is not asked, and the run is planned as version 1 plans", async (t) => {
    const loaded = await start({ dir: agentDir(t), runtime: heraRuntime(), now: () => NOW });
    assert.deepEqual(await say(loaded, "x #high"), [{ action: "transform", text: "x" }]);
    assert.match(lastNotice(loaded)?.message ?? "", /version 2 roster/);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: "pi-smart-router: the HIGH tag was removed and has no effect, because levels need a version 2 roster." });
    assert.equal(calls(loaded), 0);
    assert.deepEqual([recordOf(loaded)?.plan?.code, recordOf(loaded)?.plan?.level, recordOf(loaded)?.pendingLevel], ["signal:default", undefined, undefined]);
    assert.equal(firstRequest(loaded), DEEPSEEK);
  });
});

describe("an untagged message", () => {
  test("waits for Jev's answer, whose tier routes the run", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    assert.deepEqual(await say(loaded, "rename foo to bar"), [undefined]);
    assert.equal(calls(loaded), 1);
    assert.deepEqual(loaded.runtime.classifyCalls[0]?.options, { timeoutMs: 1000, maxRetries: 0 });
    const jev = outcome(LOW, "low");
    const pending = recordOf(loaded)?.pendingLevel;
    const demand = pending?.level.demand;
    close(demand?.value, 0.39, "the blend of 80% LOW and the heuristics for a trivial rename");
    // The untagged run is priced with the session's figures; with no usage yet a missing figure is said: cost unknown.
    const level = { scope: "personal", need: "low", tier: "low", source: "jev", demand, steppedUp: false, returnedToFirst: false, jev, cost: { outcome: "unknown", why: "no usage yet" } };
    assert.equal(typeof pending?.token, "number");
    // The message's text is held as a digest, the same one the last input holds.
    assert.match(pending?.digest ?? "", /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(recordOf(loaded)?.lastInput?.digest, pending?.digest);
    assert.deepEqual(
      pending && { ...pending, token: 0, digest: "" },
      { token: 0, digest: "", level, keyword: { signal: "trivial", reason: "triage:keyword_economical" }, at: NOW, jev, started: false },
      "the pending level, its cost unknown: a missing figure is said (no usage yet)",
    );
    assert.equal(firstRequest(loaded), LUNA);
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level, level, "the history's level, its cost unknown: a missing figure is said (no usage yet)");
  });

  test("goes where Jev says, not where the keywords would", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead");
    assert.equal(firstRequest(loaded), LUNA, "the keywords would take terra");
  });

  test("goes to the heuristics' level when Jev fails, times out or answers outside the four tiers", async (t) => {
    const outside: ClassifierResult = { ...jevAnswer(LOW), answers: { level: { type: "choice", choice: "trivial", probabilities: LOW, confidence: 0.8 } } };
    const cases: ReadonlyArray<readonly [string, ClassifierResult, string]> = [
      ["an error", jevFailure("Provider returned error"), "error"],
      ["a timeout", jevFailure("Request timed out after 1000ms"), "timeout"],
      ["a choice outside the tiers", outside, "malformed"],
    ];
    for (const [name, result, failure] of cases) {
      resetSlot();
      const loaded = await hera(t, { id: name });
      loaded.runtime.answer = async () => result;
      assert.deepEqual(await say(loaded, "go ahead"), [undefined], name);
      assert.equal(firstRequest(loaded), TERRA, name);
      assert.deepEqual(
        withoutDemand(recordOf(loaded)?.history.at(-1)?.level),
        {
          scope: "personal",
          need: "medium",
          tier: "medium",
          source: "heuristics",
          steppedUp: false,
          returnedToFirst: false,
          jev: { kind: "failure", model: JEV, failure, ms: 0 },
          cost: { outcome: "unknown", why: "no usage yet" },
        },
        `${name}: without an answer the heuristics decide alone, and rate "go ahead" MEDIUM; with no usage yet a missing figure is said: cost unknown`,
      );
    }
  });

  test("goes to the heuristics' level, and nothing is sent, when the roster's classifier is not in the registry", async (t) => {
    const roster = JSON.parse(HERA_V2);
    roster.classifier.model = "openrouter/typesafe/jev-1.13";
    const loaded = await hera(t, { roster: JSON.stringify(roster) });
    assert.deepEqual(await say(loaded, "go ahead"), [undefined]);
    assert.equal(calls(loaded), 0);
    assert.equal(firstRequest(loaded), TERRA);
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level?.jev, { kind: "failure", model: "openrouter/typesafe/jev-1.13", failure: "unavailable", ms: 0 });
  });

  test("asks Jev only on smart-router/auto, under a version 2 roster with a classifier, in a scope that can be read", async (t) => {
    const local = await hera(t, { id: "local", select: "local" });
    const physical = await hera(t, { id: "physical", select: KIMI });
    const roster = JSON.parse(HERA_V2);
    delete roster.classifier;
    const none = await hera(t, { id: "none", roster: JSON.stringify(roster) });
    const unreadable = await hera(t, { id: "unreadable", setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    for (const loaded of [local, physical, none, unreadable]) {
      loaded.runtime.answer = async () => jevAnswer(LOW);
      assert.deepEqual(await say(loaded, "go ahead"), [undefined], loaded.session.id);
      assert.equal(calls(loaded), 0, loaded.session.id);
    }
    assert.equal(recordOf(none)?.plan?.level?.source, "heuristics", "without a classifier the heuristics decide alone");
    assert.equal(recordOf(none)?.plan?.level?.jev, undefined, "a roster without a classifier asks nothing, so nothing failed");
  });
});

describe("Jev's request", () => {
  test("holds the text without its tag, the conversation before it within the roster's caps, and the scope's descriptions", async (t) => {
    const roster = JSON.parse(HERA_V2);
    roster.classifier.context = { messages: 2, messageChars: 200, totalChars: 1000 };
    const long = `the second question ${"x".repeat(300)}`;
    const loaded = await hera(t, {
      roster: JSON.stringify(roster),
      setup: (session) => {
        userEntry(session, "the first question");
        session.appendAssistant(assistant(SOL, { content: [{ type: "text", text: "the first answer" }] }));
        userEntry(session, long);
        session.appendAssistant(assistant(SOL, { content: [{ type: "text", text: "the second answer" }] }));
      },
    });
    loaded.runtime.answer = async () => jevAnswer(HIGH);
    await say(loaded, "go ahead #high");
    const call = loaded.runtime.classifyCalls[0];
    assert.deepEqual(call?.context.state, {
      message: "go ahead",
      recent: [
        { role: "user", text: long.slice(-200) },
        { role: "assistant", text: "the second answer" },
      ],
    });
    assert.deepEqual(call?.context.questions, { level: { type: "choice", instructions: JEV_INSTRUCTIONS, criteria: PERSONAL } });
    assert.ok(
      loaded.session.boundedReads.some((read) => isDeepStrictEqual(read, { type: "message", limit: 8 })),
      "one bounded read of the branch's messages, four for each message Jev reads",
    );
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("holds no conversation, and reads none, when the roster's caps allow no messages", async (t) => {
    const roster = JSON.parse(HERA_V2);
    roster.classifier.context = { messages: 0 };
    const loaded = await hera(t, { roster: JSON.stringify(roster), setup: (session) => userEntry(session, "the first question") });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead");
    assert.deepEqual(loaded.runtime.classifyCalls[0]?.context.state, { message: "go ahead", recent: [] });
    assert.ok(!loaded.session.boundedReads.some((read) => isDeepStrictEqual(read, { type: "message", limit: 0 })), "no read with a limit of none");
  });

  test("the heuristics read one bounded window of the conversation, shared with Jev's context", async (t) => {
    /** A session whose branch holds 30 messages, a question and an answer in turn. */
    const thirty = (session: Loaded["session"]): void => {
      for (let i = 0; i < 15; i += 1) {
        userEntry(session, `question ${i}`);
        session.appendAssistant(assistant(SOL, { content: [{ type: "text", text: `answer ${i}` }] }));
      }
    };
    const messageReads = (loaded: Loaded, from: number): unknown[] =>
      loaded.session.boundedReads.slice(from).filter((read) => isRecord(read) && read.type === "message");
    const loaded = await hera(t, { setup: thirty });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    for (const text of ["go ahead", "and the docs"]) {
      const mark = loaded.session.boundedReads.length;
      await say(loaded, text);
      assert.deepEqual(messageReads(loaded, mark), [{ type: "message", limit: 24 }], `${text}: one read per planned prompt, four for each of the classifier's 6 messages and at least ${HEURISTIC_MESSAGES}`);
      await finish(loaded, await runPrompt(loaded, text));
    }
    assert.deepEqual(
      loaded.runtime.classifyCalls[0]?.context.state,
      { message: "go ahead", recent: [12, 13, 14].flatMap((i) => [{ role: "user", text: `question ${i}` }, { role: "assistant", text: `answer ${i}` }]) },
      "Jev's context is the classifier's 6 latest messages of the same window",
    );
    resetSlot();
    const roster = JSON.parse(HERA_V2);
    roster.classifier.context = { messages: 0 };
    const none = await hera(t, { id: "none", roster: JSON.stringify(roster), setup: thirty });
    none.runtime.answer = async () => jevAnswer(LOW);
    const mark = none.session.boundedReads.length;
    await say(none, "go ahead");
    assert.deepEqual(messageReads(none, mark), [{ type: "message", limit: HEURISTIC_MESSAGES }], "with no messages for Jev, the heuristics still read their twenty");
    assert.deepEqual(none.runtime.classifyCalls[0]?.context.state.recent, [], "and Jev's request carries no recent turns");
  });

  test("a branch of more than 1,000 entries, as Pi's history metrics count them, needs at least MEDIUM", async (t) => {
    for (const [entries, footer] of [
      [1_000, "personal LOW → gpt-6-luna (demand 0.5; cost unknown)"],
      [1_001, "personal MEDIUM → gpt-6.1-terra (demand 0.5, floor; cost unknown)"],
    ] as const) {
      resetSlot();
      const loaded = await hera(t, { id: `entries-${entries}` });
      // John's Pi counts the branch's entries without a read; the npm Pi has no such reader.
      (loaded.session.ctx.sessionManager as unknown as Record<string, unknown>).getHistoryMetrics = () => ({ session_active_entries: entries });
      loaded.runtime.answer = async () => jevAnswer(LOW);
      await say(loaded, "go ahead");
      assert.equal(
        loaded.session.statuses.get(LEVEL_KEY),
        footer,
        `${entries} entries: a very deep session gets at least MEDIUM, from more than 1,000 entries; with no usage yet a missing figure is said: cost unknown`,
      );
    }
  });

  test("the roles of the window reach the demand: a tool result in it marks tools in play", async (t) => {
    const roster = JSON.parse(HERA_V2);
    delete roster.classifier;
    const demandWith = async (id: string, last: Record<string, unknown>) => {
      resetSlot();
      const loaded = await hera(t, {
        id,
        roster: JSON.stringify(roster),
        setup: (session) => {
          userEntry(session, "the first question");
          session.appendAssistant(assistant(SOL, { content: [{ type: "text", text: "the first answer" }] }));
          messageEntry(session, last);
        },
      });
      await say(loaded, "go ahead");
      return recordOf(loaded)?.plan?.level?.demand;
    };
    const tool = await demandWith("tool", { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "a file" }], isError: false, timestamp: NOW });
    const user = await demandWith("user", { role: "user", content: "the second question", timestamp: NOW });
    assert.ok(tool !== undefined && user !== undefined, "both runs have a demand");
    assert.ok(
      tool.heuristics.value > user.heuristics.value,
      `a tool result marks tools in play, which raises the heuristics' value (no_tool_context): ${tool.heuristics.value} > ${user.heuristics.value}`,
    );
  });

  test("a ! shell run in the window counts as the user's message, and a !! one does not count", async (t) => {
    const roster = JSON.parse(HERA_V2);
    delete roster.classifier;
    const demandWith = async (id: string, extra: readonly Record<string, unknown>[]) => {
      resetSlot();
      const loaded = await hera(t, {
        id,
        roster: JSON.stringify(roster),
        setup: (session) => {
          userEntry(session, "the first question");
          session.appendAssistant(assistant(SOL, { content: [{ type: "text", text: "the first answer" }] }));
          for (const message of extra) messageEntry(session, message);
        },
      });
      await say(loaded, "go ahead");
      return recordOf(loaded)?.plan?.level?.demand;
    };
    const bash = { role: "bashExecution", command: "ls", output: "a b", exitCode: 0, cancelled: false, truncated: false, timestamp: NOW };
    const without = await demandWith("without", []);
    const shell = await demandWith("shell", [bash]);
    const user = await demandWith("user", [{ role: "user", content: "ls", timestamp: NOW }]);
    const hidden = await demandWith("hidden", [{ ...bash, excludeFromContext: true }]);
    assert.notDeepEqual(shell, without, "a ! shell run is a message the model sees, so it counts");
    assert.deepEqual(shell, user, "Pi sends a ! shell run as a user message");
    assert.deepEqual(hidden, without, "Pi keeps a !! shell run out of the model's context, so it does not count");
  });

  test("a tagged run reads no window", async (t) => {
    // Without a classifier no opinion is asked either, so whatever is read for a tagged run is the demand's.
    const roster = JSON.parse(HERA_V2);
    delete roster.classifier;
    const loaded = await hera(t, { roster: JSON.stringify(roster), setup: (session) => userEntry(session, "the first question") });
    const messageReads = (from: number): unknown[] => loaded.session.boundedReads.slice(from).filter((read) => isRecord(read) && read.type === "message");
    let mark = loaded.session.boundedReads.length;
    await say(loaded, "x #high");
    assert.deepEqual(messageReads(mark), [], "a tagged run's level is its tag's: it reads no window for a demand");
    assert.equal(recordOf(loaded)?.plan?.level?.source, "tag");
    await finish(loaded, await runPrompt(loaded, "x"));
    mark = loaded.session.boundedReads.length;
    await say(loaded, "y");
    assert.deepEqual(messageReads(mark), [{ type: "message", limit: HEURISTIC_MESSAGES }], "an untagged run without a classifier reads the heuristics' twenty");
  });

  test("is not sent when the conversation cannot be read: Jev fails as an error, and the heuristics decide alone", async (t) => {
    const loaded = await hera(t);
    // The session's index fails for the message read once the session has started.
    const manager = loaded.session.ctx.sessionManager as unknown as Record<string, unknown>;
    const read = manager.getRecentActiveEntries as (filter?: { type?: string }) => unknown[];
    manager.getRecentActiveEntries = (filter: { type?: string } = {}) => {
      if (filter.type === "message") throw new Error("the session index is locked");
      return read(filter);
    };
    loaded.runtime.answer = async () => jevAnswer(LOW);
    assert.deepEqual(await say(loaded, "go ahead"), [undefined], "nothing throws out of the input handler");
    assert.equal(calls(loaded), 0, "no request is sent to Jev");
    const level = recordOf(loaded)?.plan?.level;
    assert.deepEqual(level?.jev, { kind: "failure", model: JEV, failure: "error", ms: 0 }, "Jev fails as an error, as when its own read threw");
    assert.deepEqual([level?.source, level?.need, level?.demand?.jev], ["heuristics", "medium", undefined], "without an answer the heuristics decide alone: 0.89, MEDIUM");
    assert.equal(loaded.session.statuses.get(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (demand 0.9, jev error; cost unknown)", "with no usage yet a missing figure is said: cost unknown");
    assert.deepEqual(loaded.session.notices, [], "no failure is reported beyond the footer");
    // A tagged run does not use the shared window: it goes to its tag's level at once.
    await finish(loaded, await runPrompt(loaded, "go ahead"));
    await say(loaded, "x #high");
    await settled();
    assert.deepEqual([recordOf(loaded)?.plan?.level?.source, recordOf(loaded)?.plan?.level?.need], ["tag", "high"], "the tag decides");
    assert.equal(loaded.session.statuses.get(LEVEL_KEY), "personal HIGH → gpt-6.1-sol (tag)");
    assert.equal(calls(loaded), 0, "its opinion's own read fails before anything is sent, as before");
  });

  test("reads the work scope's descriptions in a work session", async (t) => {
    const roster = JSON.parse(HERA_V2);
    for (const tier of TIERS) roster.scopes.work.levels[tier].describe = `work: ${tier}`;
    const loaded = await hera(t, { roster: JSON.stringify(roster), setup: (session) => session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW)) });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead");
    assert.deepEqual(loaded.runtime.classifyCalls[0]?.context.questions.level, {
      type: "choice",
      instructions: JEV_INSTRUCTIONS,
      criteria: { low: "work: low", medium: "work: medium", high: "work: high", super: "work: super" },
    });
    assert.equal(firstRequest(loaded), WORK_LUNA);
  });

  test("that cannot be built, such as for text too long to redact, fails before anything is sent; the tag is still removed and the run planned", { timeout: 60_000 }, async (t) => {
    // redact() throws a RangeError on a single run of millions of characters.
    const huge = "a".repeat(6_000_000);
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const tagged = await say(loaded, `${huge} #high`);
    assert.equal(tagged.length, 1);
    assert.ok(isDeepStrictEqual(tagged[0], { action: "transform", text: huge }), "the transform, without the tag");
    assert.deepEqual([recordOf(loaded)?.plan?.level?.need, recordOf(loaded)?.plan?.level?.source], ["high", "tag"]);
    await settled();
    const failed = { kind: "failure", model: JEV, failure: "error", ms: 0 };
    assert.deepEqual(recordOf(loaded)?.pendingLevel?.jev, failed, "the opinion failed");
    assert.deepEqual(await say(loaded, huge), [undefined]);
    assert.deepEqual([recordOf(loaded)?.plan?.level?.source, recordOf(loaded)?.plan?.level?.jev], ["heuristics", failed], "a failed request leaves the heuristics to decide alone");
    assert.equal(calls(loaded), 0, "nothing was sent");
  });
});

describe("an extension's resend of the last message's text", () => {
  test("keeps the level its tag gave it, and Jev is not asked again", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    assert.deepEqual(await say(loaded, "go ahead #high"), [{ action: "transform", text: "go ahead" }]);
    assert.equal(calls(loaded), 1);
    // The run fails, and pi-idle-check sends its text again.
    assert.equal(firstRequest(loaded), SOL);
    await finish(loaded, SOL, { stopReason: "error", errorMessage: "terminated" });
    assert.deepEqual(await say(loaded, "go ahead", { source: "extension" }), [undefined]);
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.plan?.level?.source], ["high", "tag"]);
    assert.equal(calls(loaded), 1, "no second call");
    assert.equal(firstRequest(loaded), SOL);
    loaded.session.endRun();
    // Typed again, the same text is a new message, and Jev decides.
    await say(loaded, "go ahead");
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.plan?.level?.source, calls(loaded)], ["low", "jev", 2]);
  });
});

describe("the pending level and the last input", () => {
  test("a custom message's run drops them with the plan; the prompt's own run keeps them", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead #high");
    const kept = [recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, recordOf(loaded)?.lastInput];
    assert.ok(kept.every((value) => value !== undefined));
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "go ahead" });
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, recordOf(loaded)?.lastInput], kept);
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: { role: "custom", customType: "goal-x", content: "continue", display: false, timestamp: NOW } });
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, recordOf(loaded)?.lastInput], [undefined, undefined, undefined]);
  });

  test("an idle input that plans no level drops them, so a later resend of the text is a new message", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead #high");
    await loaded.host.choose(KIMI);
    await say(loaded, "something else");
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, recordOf(loaded)?.lastInput], [undefined, undefined, undefined]);
    await loaded.host.choose("smart-router/auto");
    await say(loaded, "go ahead", { source: "extension" });
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.plan?.level?.source, calls(loaded)], ["low", "jev", 2]);
  });
});

describe("a session replaced, or a newer input, during the wait", () => {
  test("a tagged message returns its transform at once, and its opinion arriving after /new leaves the new session's pending level untouched", { timeout: 10_000 }, async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const runtime = heraRuntime();
    const late = deferred<ClassifierResult>();
    runtime.answer = () => late.promise;
    const old = await start({ dir, runtime, id: "old", file: "/sessions/old.jsonl", now: () => NOW });
    const first = await Promise.race([say(old, "go ahead #high"), settled().then(() => "it waited")]);
    assert.deepEqual(first, [{ action: "transform", text: "go ahead" }], "the transform comes back at once");
    await old.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/new.jsonl" });
    old.session.dispose();
    const fresh = await start({ dir, runtime, id: "new", file: "/sessions/new.jsonl", now: () => NOW });
    runtime.answer = async () => jevAnswer(MEDIUM);
    await say(fresh, "carry on #low");
    await settled();
    const before = structuredClone(fresh.router?.record("new")?.pendingLevel);
    assert.deepEqual(before?.jev, outcome(MEDIUM, "medium"));
    late.resolve(jevAnswer(SUPER));
    await settled();
    assert.deepEqual(fresh.router?.record("new")?.pendingLevel, before);
    assert.equal(old.router?.record("old"), undefined, "the old session's records went with it");
  });

  test("an untagged message still waiting when /new arrives resolves without throwing and plans nothing", { timeout: 10_000 }, async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const runtime = heraRuntime();
    const late = deferred<ClassifierResult>();
    runtime.answer = () => late.promise;
    const old = await start({ dir, runtime, id: "old", file: "/sessions/old.jsonl", now: () => NOW });
    const waiting = say(old, "go ahead");
    await settled();
    assert.equal(runtime.classifyCalls.length, 1, "the message waits for Jev");
    await old.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/new.jsonl" });
    old.session.dispose();
    const fresh = await start({ dir, runtime, id: "new", file: "/sessions/new.jsonl", now: () => NOW });
    late.resolve(jevAnswer(LOW));
    assert.deepEqual(await waiting, [undefined]);
    assert.equal(old.router?.record("old"), undefined, "nothing was planned for the session that ended");
    assert.deepEqual([fresh.router?.record("new")?.plan, fresh.router?.record("new")?.pendingLevel], [undefined, undefined]);
  });

  // Pi tells the extension that a session ends before it makes the session's context stale. In
  // that window the context still answers, so only the router's own check of the session's record
  // keeps a late answer from planning.
  test("an untagged message's answer that arrives after the session's shutdown, while its context still answers, plans nothing and shows no level", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    const late = deferred<ClassifierResult>();
    loaded.runtime.answer = () => late.promise;
    const waiting = say(loaded, "go ahead");
    await settled();
    assert.equal(calls(loaded), 1, "the message waits for Jev");
    const left = recordOf(loaded);
    await loaded.host.emit("session_shutdown", { reason: "quit" });
    const notices = loaded.session.notices.length;
    late.resolve(jevAnswer(LOW));
    assert.deepEqual(await waiting, [undefined]);
    assert.equal(loaded.session.statuses.get(LEVEL_KEY), undefined, "no level is shown");
    assert.equal(loaded.session.notices.length, notices, "and nothing is said");
    assert.deepEqual([left?.plan, left?.pendingLevel, left?.lastInput], [undefined, undefined, undefined], "the record the session left holds no plan");
    assert.equal(recordOf(loaded), undefined, "and the session has no record again");
  });

  test("a tagged run's opinion that arrives after the session's shutdown does not land in the record the session left", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    const late = deferred<ClassifierResult>();
    loaded.runtime.answer = () => late.promise;
    await say(loaded, "go ahead #high");
    const left = recordOf(loaded);
    assert.equal(left?.pendingLevel?.jev, "pending");
    await loaded.host.emit("session_shutdown", { reason: "quit" });
    late.resolve(jevAnswer(SUPER));
    await settled();
    assert.equal(left?.pendingLevel?.jev, "pending", "the opinion is dropped: the record is no longer the session's");
    assert.equal(recordOf(loaded), undefined);
  });

  test("a tagged run's opinion lands in its own pending level, never in a later message's", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    const first = deferred<ClassifierResult>();
    loaded.runtime.answer = () => first.promise;
    await say(loaded, "go ahead #high");
    assert.equal(recordOf(loaded)?.pendingLevel?.jev, "pending");
    first.resolve(jevAnswer(LOW));
    await settled();
    assert.deepEqual(recordOf(loaded)?.pendingLevel?.jev, outcome(LOW, "low"), "its own opinion lands");
    const second = deferred<ClassifierResult>();
    loaded.runtime.answer = () => second.promise;
    await say(loaded, "now this #super");
    const dropped = recordOf(loaded)?.pendingLevel;
    loaded.runtime.answer = async () => jevAnswer(MEDIUM);
    await say(loaded, "and this #low");
    await settled();
    const latest = structuredClone(recordOf(loaded)?.pendingLevel);
    assert.deepEqual(latest?.jev, outcome(MEDIUM, "medium"));
    second.resolve(jevAnswer(SUPER));
    await settled();
    assert.deepEqual(recordOf(loaded)?.pendingLevel, latest, "a late opinion does not land in a later message's pending level");
    assert.equal(dropped?.jev, "pending", "nor in the pending level the next message dropped");
  });

  test("of two messages overlapping a Jev wait, an earlier answer that comes first plans its own message, whose run uses that plan", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    const { one, two, earlier, later } = await overlap(loaded, "go ahead", "rename foo to bar");
    earlier.resolve(jevAnswer(LOW));
    assert.deepEqual(await one, [undefined]);
    const own = recordOf(loaded)?.pendingLevel;
    // Its input handlers have returned, so Pi starts the earlier message's run.
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level?.jev, outcome(LOW, "low"));
    later.resolve(jevAnswer(HIGH));
    assert.deepEqual(await two, [undefined]);
    assert.equal(recordOf(loaded)?.plan, undefined, "the later message found the session busy, and planned nothing");
    assert.ok(own !== undefined && recordOf(loaded)?.pendingLevel === own, "the run's pending level is its own");
    assert.deepEqual(own?.jev, outcome(LOW, "low"));
  });

  test("of two messages overlapping a Jev wait, a later answer that comes first plans the later message; the earlier message's run never takes that plan", { timeout: 10_000 }, async (t) => {
    for (const earlierRunsFirst of [true, false]) {
      resetSlot();
      const loaded = await hera(t, { id: `earlier-runs-first-${earlierRunsFirst}` });
      const { one, two, earlier, later } = await overlap(loaded, "go ahead", "rename foo to bar");
      later.resolve(jevAnswer(HIGH));
      assert.deepEqual(await two, [undefined]);
      const its = recordOf(loaded)?.pendingLevel;
      earlier.resolve(jevAnswer(LOW));
      assert.deepEqual(await one, [undefined]);
      const name = earlierRunsFirst ? "Pi starts the earlier message's run first" : "Pi starts the later message's run first";
      assert.ok(its !== undefined && recordOf(loaded)?.pendingLevel === its, `${name}: the earlier message planned nothing over the later one's plan`);
      assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, its?.jev], ["high", outcome(HIGH, "high")], name);
      if (earlierRunsFirst) {
        assert.equal(await runPrompt(loaded, "go ahead"), TERRA, name);
        assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level], ["stick:default", undefined], `${name}: it routes unplanned`);
        assert.equal(recordOf(loaded)?.pendingLevel, undefined, `${name}: and the later message's level and Jev answer are not its`);
      } else {
        assert.equal(await runPrompt(loaded, "rename foo to bar"), SOL, name);
        assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level?.jev, outcome(HIGH, "high"), name);
      }
    }
  });

  test("a run whose prompt Pi expanded, or a later extension changed, keeps the plan of the only message since the last run; with two messages it goes unplanned", { timeout: 10_000 }, async (t) => {
    const expanded = '<skill name="review" location="/skills/review/SKILL.md">\nReview the change.\n</skill>\n\nsrc/a.ts';
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    assert.deepEqual(await say(loaded, "/skill:review src/a.ts #high"), [{ action: "transform", text: "/skill:review src/a.ts" }]);
    assert.equal(await runPrompt(loaded, expanded), SOL, "the tag's tier");
    assert.equal(recordOf(loaded)?.history.at(-1)?.level?.source, "tag");
    await finish(loaded, SOL);
    // Each run starts the count again: the next single message's changed prompt keeps its plan too.
    assert.deepEqual(await say(loaded, "/skill:review src/a.ts #super"), [{ action: "transform", text: "/skill:review src/a.ts" }]);
    assert.equal(await runPrompt(loaded, expanded), ASTRA, "the tag's tier");
    await finish(loaded, ASTRA);
    // Two messages since the last run, and a prompt that is neither's text: it cannot be told whose.
    const waiting = deferred<ClassifierResult>();
    loaded.runtime.answer = () => waiting.promise;
    const one = say(loaded, "/skill:review src/b.ts");
    await settled();
    loaded.runtime.answer = async () => jevAnswer(LOW);
    assert.deepEqual(await say(loaded, "/skill:review src/c.ts #high"), [{ action: "transform", text: "/skill:review src/c.ts" }]);
    assert.equal(recordOf(loaded)?.plan?.level?.tier, "high");
    assert.equal(await runPrompt(loaded, expanded.replace("a.ts", "c.ts")), ASTRA, `the last run's SUPER, not the dropped plan's HIGH: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["run:need", undefined, undefined], RUN_NEED);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: UNMATCHED }, "the dropped plan carried a tag");
    waiting.resolve(jevAnswer(LOW));
    assert.deepEqual(await one, [undefined]);
  });

  test("a message whose session started a run during the wait plans nothing", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    const late = deferred<ClassifierResult>();
    loaded.runtime.answer = () => late.promise;
    const waiting = say(loaded, "go ahead");
    await settled();
    // An extension's custom message starts a run meanwhile.
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: { role: "custom", customType: "goal-x", content: "continue", display: false, timestamp: NOW } });
    loaded.session.startRun();
    late.resolve(jevAnswer(LOW));
    assert.deepEqual(await waiting, [undefined]);
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, recordOf(loaded)?.lastInput], [undefined, undefined, undefined]);
  });
});

describe("a message a later extension's input handler holds, handles or changes", () => {
  test("typed while a run streamed and held until it ended, its own run takes no plan of a message that planned meanwhile (B8)", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    await say(loaded, "go ahead");
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    const [holdM, holdX] = [deferred<void>(), deferred<void>()];
    later.holds.set("fix the failing test", holdM.promise);
    later.holds.set("design the new storage layer", holdX.promise);
    // M is typed while the run streams, so Pi passes streamingBehavior "steer", and the later handler holds it.
    const m = say(loaded, "fix the failing test", { streamingBehavior: "steer" });
    await settled();
    await finish(loaded, LUNA);
    // X is typed once the run has ended: idle and tagged, it plans at the router, then the later handler holds it.
    const x = say(loaded, "design the new storage layer #super");
    await settled();
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.pendingLevel?.level.tier, recordOf(loaded)?.pendingLevel?.level.source], ["super", "super", "tag"]);
    // M's handlers return first. Pi is no longer streaming, so M starts a run of its own, with its own prompt.
    holdM.resolve();
    await m;
    assert.equal(await runPrompt(loaded, "fix the failing test"), LUNA, `the last run's LOW, not X's SUPER: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["run:need", undefined, undefined], RUN_NEED);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: UNMATCHED }, "X's dropped plan carried a tag");
    holdX.resolve();
    await x;
  });

  test("a tagged message typed while a run streamed is told its tag has no effect, and its own run, held until that run ended, takes no plan", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    await say(loaded, "go ahead");
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    const [holdM, holdX] = [deferred<void>(), deferred<void>()];
    later.holds.set("fix the failing test", holdM.promise);
    later.holds.set("design the new storage layer", holdX.promise);
    const m = say(loaded, "fix the failing test #low", { streamingBehavior: "steer" });
    await settled();
    assert.match(lastNotice(loaded)?.message ?? "", /the LOW tag was removed and has no effect, because a run is under way/);
    await finish(loaded, LUNA);
    const x = say(loaded, "design the new storage layer #super");
    await settled();
    holdM.resolve();
    assert.deepEqual(await m, [{ action: "transform", text: "fix the failing test" }, undefined]);
    assert.equal(await runPrompt(loaded, "fix the failing test"), LUNA, "its own run's prompt is its text without the tag");
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], [undefined, undefined]);
    holdX.resolve();
    await x;
  });

  test("a message a later extension rewrites into an earlier message's text keeps its plan: a prompt's run forgets its own text, the count starts again with it, and steers are not counted", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    later.transforms.set("!!", "go ahead");
    await say(loaded, "go ahead");
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    assert.deepEqual(await say(loaded, "and the docs", { streamingBehavior: "steer" }), [undefined, undefined]);
    await finish(loaded, LUNA);
    // "!!" repeats the last message: the later extension turns it into "go ahead", an earlier message's text.
    assert.deepEqual(await say(loaded, "!! #high"), [
      { action: "transform", text: "!!" },
      { action: "transform", text: "go ahead" },
    ]);
    assert.equal(await runPrompt(loaded, "go ahead"), SOL, "the tag's tier");
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.level?.source, loaded.session.notices], ["tag", []]);
  });

  test("the same with an untagged message that planned by Jev, or by version 1's keywords (B9)", async (t) => {
    for (const version of [2, 1] as const) {
      resetSlot();
      const loaded = await hera(t, { id: `v${version}`, roster: version === 2 ? HERA_V2 : fixture("roster-hera.json") });
      loaded.runtime.answer = async () => jevAnswer(SUPER);
      const later = laterExtension(loaded);
      await say(loaded, "hello");
      const first = await runPrompt(loaded, "hello");
      const [holdM, holdX] = [deferred<void>(), deferred<void>()];
      later.holds.set("fix the failing test", holdM.promise);
      later.holds.set("plan the migration to the new store", holdX.promise);
      const m = say(loaded, "fix the failing test", { streamingBehavior: "steer" });
      await settled();
      await finish(loaded, first);
      const x = say(loaded, "plan the migration to the new store");
      await settled();
      const planned = recordOf(loaded)?.plan;
      assert.deepEqual([planned?.signal, planned?.decision.ok && planned.decision.choice.ref], ["planning", ASTRA], `version ${version}: X planned`);
      holdM.resolve();
      await m;
      assert.equal(await runPrompt(loaded, "fix the failing test"), first, version === 2 ? `version 2: the last run's level, not X's: ${RUN_NEED}` : "version 1: the last responder");
      assert.deepEqual(
        [recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel, loaded.session.notices],
        [version === 2 ? "run:need" : "stick:last", undefined, undefined, []],
        `version ${version}: neither X's plan nor its level, and no tag to tell of${version === 2 ? `; ${RUN_NEED}` : ""}`,
      );
      holdX.resolve();
      await x;
    }
  });

  test("held across a custom message's run, its own run takes no plan of a message that planned after that run (B14)", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    const [holdA, holdX] = [deferred<void>(), deferred<void>()];
    later.holds.set("fix the failing test", holdA.promise);
    later.holds.set("design the new storage layer", holdX.promise);
    const a = say(loaded, "fix the failing test");
    await settled();
    assert.equal(recordOf(loaded)?.plan?.level?.tier, "low", "A planned");
    // A goal-x continuation starts and ends a run while A is held; that run drops A's plan.
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: GOAL_X });
    loaded.session.startRun();
    await finish(loaded, KIMI);
    const x = say(loaded, "design the new storage layer #super");
    await settled();
    holdA.resolve();
    await a;
    assert.equal(await runPrompt(loaded, "fix the failing test"), KIMI, "the last responder, not X's SUPER");
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["stick:last", undefined, undefined]);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: UNMATCHED });
    holdX.resolve();
    await x;
  });

  test("a tagged message held across a custom message's run: that run drops the tagged plan and says so, and the message's own run goes unplanned without a second notice (E11)", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    const hold = deferred<void>();
    later.holds.set("design the new storage layer", hold.promise);
    const a = say(loaded, "design the new storage layer #super");
    await settled();
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.plan?.level?.source, loaded.session.notices], ["super", "tag", []]);
    // A goal-x continuation starts a run while A is held: the run is not A's, so A's level is lost.
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: GOAL_X });
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel, loaded.session.notices], [undefined, undefined, [{ type: "warning", message: UNMATCHED }]]);
    loaded.session.startRun();
    await finish(loaded, KIMI);
    hold.resolve();
    await a;
    assert.equal(await runPrompt(loaded, "design the new storage layer"), KIMI, "the last responder, not A's SUPER");
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level], ["stick:last", undefined]);
    assert.deepEqual(loaded.session.notices, [{ type: "warning", message: UNMATCHED }], "said once, at the custom message's run");
  });

  test("a custom message's run drops an untagged plan, or a tagged plan whose run has ended, without a notice", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(SUPER);
    const later = laterExtension(loaded);
    const hold = deferred<void>();
    later.holds.set("design the new storage layer", hold.promise);
    const a = say(loaded, "design the new storage layer");
    await settled();
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.plan?.level?.source], ["super", "jev"]);
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: GOAL_X });
    loaded.session.startRun();
    await finish(loaded, KIMI);
    hold.resolve();
    await a;
    assert.equal(await runPrompt(loaded, "design the new storage layer"), KIMI);
    await finish(loaded, KIMI);
    // A tagged message's own run takes its level, and the run's end drops the plan: a goal-x
    // continuation after it has nothing to say.
    await say(loaded, "rename foo to bar #low");
    assert.equal(await runPrompt(loaded, "rename foo to bar"), LUNA);
    await finish(loaded, LUNA);
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: GOAL_X });
    assert.deepEqual(loaded.session.notices, []);
  });

  test("after a message Pi's input-transform example handled, a tagged message it changes runs without its level, and says so (B13)", async (t) => {
    const plain = await hera(t, { id: "plain" });
    plain.runtime.answer = async () => jevAnswer(LOW);
    inputTransform(plain);
    await say(plain, "hello");
    await runPrompt(plain, "hello");
    await finish(plain, KIMI);
    // With no other message since the last run, the changed prompt still keeps its tag's level.
    assert.deepEqual(await say(plain, "?quick sketch the parser #low"), [
      { action: "transform", text: "?quick sketch the parser" },
      { action: "transform", text: "Respond briefly in 1-2 sentences: sketch the parser" },
    ]);
    assert.equal(await runPrompt(plain, "Respond briefly in 1-2 sentences: sketch the parser"), LUNA);
    assert.deepEqual(plain.session.notices, []);
    for (const version of [2, 1] as const) {
      const loaded = await hera(t, { id: `ping-v${version}`, roster: version === 2 ? HERA_V2 : fixture("roster-hera.json") });
      loaded.runtime.answer = async () => jevAnswer(LOW);
      inputTransform(loaded);
      await say(loaded, "hello");
      await runPrompt(loaded, "hello");
      await finish(loaded, KIMI);
      // "ping" is handled after the router, so it never runs, and the next changed prompt matches neither message.
      assert.deepEqual(await say(loaded, "ping"), [undefined, { action: "handled" }]);
      await say(loaded, version === 2 ? "?quick sketch the design of the parser #low" : "?quick sketch the design of the parser");
      assert.ok(recordOf(loaded)?.plan !== undefined, `version ${version}: the message planned`);
      // Version 2: "hello"'s run needed LOW, so the unplanned run goes to LOW's luna, whoever answered last. Version 1 has no levels: it sticks to the last responder.
      assert.equal(
        await runPrompt(loaded, "Respond briefly in 1-2 sentences: sketch the design of the parser"),
        version === 2 ? LUNA : KIMI,
        version === 2 ? `version 2: unplanned, so the last run's LOW: ${RUN_NEED}` : "version 1: unplanned, so the last responder",
      );
      assert.equal(recordOf(loaded)?.history.at(-1)?.code, version === 2 ? "run:need" : "stick:last", version === 2 ? `version 2: ${RUN_NEED}` : "version 1");
      // Version 1 has no tags, so its unplanned run says nothing.
      assert.deepEqual(lastNotice(loaded), version === 2 ? { type: "warning", message: UNMATCHED } : { type: "info", message: "pong" }, `version ${version}`);
    }
  });
});

describe("a message held through another message's whole run", () => {
  /** A steer held by a later handler through the run it was typed in and the whole next run (E1-E4). */
  async function heldSteer(loaded: Loaded, later: ReturnType<typeof laterExtension>) {
    await say(loaded, "go ahead");
    const first = await runPrompt(loaded, "go ahead");
    const holdS = deferred<void>();
    later.holds.set("fix the failing test", holdS.promise);
    const s = say(loaded, "fix the failing test", { streamingBehavior: "steer" });
    await settled();
    await finish(loaded, first);
    // X1: the next message, typed idle and not held, runs to its end while S is still held.
    await say(loaded, "rename foo to bar");
    const second = await runPrompt(loaded, "rename foo to bar");
    await finish(loaded, second);
    return { s, release: () => holdS.resolve(), second };
  }

  test("a steer's own run takes no plan of a tagged message that planned after the next message's whole run (E1)", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    const { s, release, second } = await heldSteer(loaded, later);
    const holdX = deferred<void>();
    later.holds.set("design the new storage layer", holdX.promise);
    const x = say(loaded, "design the new storage layer #super");
    await settled();
    assert.equal(recordOf(loaded)?.plan?.level?.tier, "super", "X2 planned");
    release();
    await s;
    assert.equal(await runPrompt(loaded, "fix the failing test"), second, `the last run's level, not X2's SUPER: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["run:need", undefined, undefined], RUN_NEED);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: UNMATCHED });
    holdX.resolve();
    await x;
  });

  test("the same when a later extension handles the tagged message, which never runs (E2)", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    const { s, release, second } = await heldSteer(loaded, later);
    later.handled.add("design the new storage layer");
    assert.deepEqual(await say(loaded, "design the new storage layer #super"), [{ action: "transform", text: "design the new storage layer" }, { action: "handled" }]);
    release();
    await s;
    assert.equal(await runPrompt(loaded, "fix the failing test"), second, `the last run's level: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["run:need", undefined, undefined], RUN_NEED);
  });

  test("the same with an untagged message whose Jev answer is SUPER: the steer's run takes neither its plan nor its answer (E3)", async (t) => {
    const loaded = await hera(t);
    // "go ahead" and "rename foo to bar" are answered LOW, the held X2 SUPER.
    const answers = [LOW, LOW, SUPER];
    loaded.runtime.answer = async () => jevAnswer(answers.shift() ?? MEDIUM);
    const later = laterExtension(loaded);
    const { s, release, second } = await heldSteer(loaded, later);
    const holdX = deferred<void>();
    later.holds.set("plan the migration to the new store", holdX.promise);
    const x = say(loaded, "plan the migration to the new store");
    await settled();
    assert.equal(recordOf(loaded)?.plan?.level?.jev?.kind, "answer", "X2 planned by Jev");
    release();
    await s;
    assert.equal(await runPrompt(loaded, "fix the failing test"), second, `the last run's level: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["run:need", undefined, undefined], RUN_NEED);
    holdX.resolve();
    await x;
  });

  test("the same under version 1: the steer's run takes no planning plan (E4)", async (t) => {
    const loaded = await hera(t, { roster: fixture("roster-hera.json") });
    const later = laterExtension(loaded);
    const { s, release, second } = await heldSteer(loaded, later);
    const holdX = deferred<void>();
    later.holds.set("plan the migration to the new store", holdX.promise);
    const x = say(loaded, "plan the migration to the new store");
    await settled();
    assert.equal(recordOf(loaded)?.plan?.code, "signal:planning", "X2 planned");
    release();
    await s;
    assert.equal(await runPrompt(loaded, "fix the failing test"), second);
    assert.equal(recordOf(loaded)?.history.at(-1)?.code, "stick:last");
    holdX.resolve();
    await x;
  });

  test("an RPC message held through another message's whole run takes no plan of a tagged message Pi's input-transform example then handles (E5c)", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    inputTransform(loaded);
    const holdA = deferred<void>();
    later.holds.set("rename foo to bar", holdA.promise);
    const a = say(loaded, "rename foo to bar", { source: "rpc" });
    await settled();
    // B arrives while A is held (RPC prompts are not awaited one by one), plans, runs and ends.
    await say(loaded, "go ahead", { source: "rpc" });
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    await finish(loaded, KIMI);
    assert.deepEqual(await say(loaded, "ping #high", { source: "rpc" }), [{ action: "transform", text: "ping" }, undefined, { action: "handled" }]);
    assert.equal(recordOf(loaded)?.plan?.level?.tier, "high", "ping planned before the example handled it");
    holdA.resolve();
    await a;
    // B's run needed LOW; kimi answered it, but the unplanned run goes through the choice at LOW.
    assert.equal(await runPrompt(loaded, "rename foo to bar"), LUNA, `the last run's LOW, not ping's HIGH: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["run:need", undefined, undefined], RUN_NEED);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: UNMATCHED });
  });

  test("a run whose prompt is not text takes no plan, and its handler does not fail (F5)", async (t) => {
    for (const prompt of [undefined, null, 42, { text: "design the new storage layer" }]) {
      resetSlot();
      const loaded = await hera(t, { id: `prompt-${typeof prompt}-${String(prompt)}` });
      loaded.runtime.answer = async () => jevAnswer(LOW);
      await say(loaded, "design the new storage layer #super");
      assert.equal(recordOf(loaded)?.plan?.level?.tier, "super", "the tagged message planned");
      const signal = loaded.session.startRun();
      await loaded.host.emit("before_agent_start", { messageType: "user", prompt });
      assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), TERRA, `${String(prompt)}: the default level, not the plan's SUPER`);
      assert.deepEqual(
        [recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel],
        ["stick:default", undefined, undefined],
        String(prompt),
      );
      assert.deepEqual(loaded.session.notices, [{ type: "warning", message: UNMATCHED }], `${String(prompt)}: the dropped tag is told, and no handler failed`);
    }
  });

  test("a held steer typed again keeps its memory: the retyped message's run forgets one of the two, and the steer's own run takes no other plan (F1)", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    await say(loaded, "go ahead");
    const first = await runPrompt(loaded, "go ahead");
    const holdS = deferred<void>();
    later.holds.set("fix the failing test", holdS.promise);
    const s = say(loaded, "fix the failing test", { streamingBehavior: "steer" });
    await settled();
    await finish(loaded, first);
    // The same text, typed again while the steer is held, is not held: it plans, runs and ends.
    later.holds.delete("fix the failing test");
    await say(loaded, "fix the failing test");
    const retyped = await runPrompt(loaded, "fix the failing test");
    await finish(loaded, retyped);
    const holdX = deferred<void>();
    later.holds.set("design the new storage layer", holdX.promise);
    const x = say(loaded, "design the new storage layer #super");
    await settled();
    assert.equal(recordOf(loaded)?.plan?.level?.tier, "super", "X planned");
    holdS.resolve();
    await s;
    assert.equal(await runPrompt(loaded, "fix the failing test"), retyped, `the last run's level, not X's SUPER: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], ["run:need", undefined, undefined], RUN_NEED);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: UNMATCHED });
    holdX.resolve();
    await x;
  });

  test("remembers the 64 most recent messages whose runs have not started, forgetting the oldest first", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    /** A held steer's own run, after a tagged message planned: unplanned while the steer is remembered. */
    const strayRun = async (text: string, release: () => void, held: Promise<unknown[]>, name: string): Promise<void> => {
      await say(loaded, `${name} #super`);
      release();
      await held;
      assert.equal(await runPrompt(loaded, text), LUNA, `${text} is remembered, so its run takes no plan: ${RUN_NEED}`);
      assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level], ["run:need", undefined], `${text}: ${RUN_NEED}`);
    };
    await say(loaded, "go ahead");
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    // Seventy steers while the run streams; a later handler holds the last.
    const hold69 = deferred<void>();
    later.holds.set("steer 69", hold69.promise);
    const steers: Array<Promise<unknown[]>> = [];
    for (let index = 0; index < 70; index += 1) steers.push(say(loaded, `steer ${index}`, { streamingBehavior: "steer" }));
    await settled();
    assert.equal(recordOf(loaded)?.remembered.size, 64, "steers 6 to 69: the six oldest are forgotten");
    await finish(loaded, LUNA);
    // The newest is kept, not refused for want of room.
    await strayRun("steer 69", () => hold69.resolve(), Promise.all(steers).then(() => []), "design the new storage layer");
    // The tagged message forgot "steer 6", and that run forgot "steer 69". During the run, "steer 7",
    // now the oldest, is typed again and held: it becomes the most recent instead of the next to go,
    // so "steer 71" forgets "steer 8", and the tagged message after the run forgets "steer 9".
    const hold7 = deferred<void>();
    later.holds.set("steer 7", hold7.promise);
    const again = say(loaded, "steer 7", { streamingBehavior: "steer" });
    await settled();
    await say(loaded, "steer 70", { streamingBehavior: "steer" });
    await say(loaded, "steer 71", { streamingBehavior: "steer" });
    assert.equal(recordOf(loaded)?.remembered.size, 64);
    await finish(loaded, LUNA);
    await strayRun("steer 7", () => hold7.resolve(), again, "design the new cache layer");
  });
});

describe("what the router keeps of a message's text", () => {
  /** Every string in a value, keys included, through objects, arrays, Sets and Maps. */
  const stringsIn = (value: unknown, seen = new Set<unknown>()): string[] => {
    if (typeof value === "string") return [value];
    if (typeof value !== "object" || value === null || seen.has(value)) return [];
    seen.add(value);
    const parts: unknown[] = value instanceof Map ? [...value.entries()].flat() : value instanceof Set ? [...value] : Object.entries(value).flat();
    return parts.flatMap((part) => stringsIn(part, seen));
  };

  test("is a digest under each router's own key: the records hold neither the text nor its bare hash", async (t) => {
    const MARK = "quixotic-zebra";
    const texts = [`${MARK} rename foo to bar`, `${MARK} and the tests`] as const;
    const bare = texts.flatMap((text) =>
      (["utf8", "utf16le"] as const).flatMap((input) => (["hex", "base64", "base64url"] as const).map((output) => createHash("sha256").update(text, input).digest(output))),
    );
    const digestsOf = async (id: string) => {
      resetSlot();
      const loaded = await hera(t, { id });
      loaded.runtime.answer = async () => jevAnswer(LOW);
      const check = (when: string): void => {
        const strings = stringsIn(recordOf(loaded));
        assert.deepEqual(strings.filter((value) => value.includes(MARK)), [], `${id}, ${when}: no text`);
        assert.deepEqual(strings.filter((value) => bare.includes(value)), [], `${id}, ${when}: no bare hash`);
      };
      // A tagged message plans and its run starts, and a steer comes before the run's first request.
      await say(loaded, `${texts[0]} #high`);
      const signal = loaded.session.startRun();
      await loaded.host.emit("before_agent_start", { messageType: "user", prompt: texts[0] });
      await say(loaded, texts[1], { streamingBehavior: "steer" });
      check("before the first request");
      const record = recordOf(loaded);
      assert.ok(record?.plan !== undefined && record.planDigest !== undefined && record.pendingLevel !== undefined && record.lastInput !== undefined, id);
      const digests = { plan: record.planDigest, pending: record.pendingLevel.digest, last: record.lastInput.digest, remembered: [...record.remembered.keys()] };
      // The first request takes the plan and records the run's level.
      assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), SOL);
      await finish(loaded, SOL);
      assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level?.source, "tag");
      check("after the run");
      return digests;
    };
    const one = await digestsOf("one");
    const two = await digestsOf("two");
    assert.deepEqual([one.pending, one.last, one.remembered.length], [one.plan, one.plan, 1], "one router digests a text the same each time; the run forgot its own");
    assert.notEqual(two.plan, one.plan, "another router's digest of the same text differs");
    assert.notDeepEqual(two.remembered, one.remembered);
  });

  test("tells apart exactly the texts that differ, even by a lone surrogate alone", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    await say(loaded, "go ahead");
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    // M and X differ only in their last UTF-16 code unit, a lone surrogate each, which UTF-8 would make the same.
    const [m, x] = ["fix the failing test \uD800", "fix the failing test \uD801"] as const;
    const [holdM, holdX] = [deferred<void>(), deferred<void>()];
    later.holds.set(m, holdM.promise);
    later.holds.set(x, holdX.promise);
    const heldM = say(loaded, m, { streamingBehavior: "steer" });
    await settled();
    await finish(loaded, LUNA);
    const heldX = say(loaded, `${x} #super`);
    await settled();
    assert.equal(recordOf(loaded)?.plan?.level?.tier, "super");
    holdM.resolve();
    await heldM;
    assert.equal(await runPrompt(loaded, m), LUNA, `M's run takes no plan of X's: ${RUN_NEED}`);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level], ["run:need", undefined], RUN_NEED);
    holdX.resolve();
    await heldX;
  });
});

describe("the tier's model", () => {
  test("a tier with no available model passes the run up, with a notice", async (t) => {
    const runtime = heraRuntime();
    for (const ref of [LUNA, NYX_QWEN, HERA_QWEN]) runtime.catalog.unavailable.add(ref);
    const loaded = await hera(t, { runtime });
    assert.deepEqual(await say(loaded, "x #low"), [{ action: "transform", text: "x" }]);
    assert.equal(firstRequest(loaded), TERRA);
    assert.deepEqual(lastNotice(loaded), { type: "info", message: "pi-smart-router: no LOW model can take this run, so it goes to MEDIUM (gpt-6.1-terra)." });
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level, { scope: "personal", need: "low", tier: "medium", source: "tag", steppedUp: true, returnedToFirst: false });
  });

  test("the step-up notice names the level the run needs, which the risky floor can raise above the demand's", async (t) => {
    const runtime = heraRuntime();
    for (const ref of [SOL, GLM_CLOUD]) runtime.catalog.unavailable.add(ref);
    const loaded = await hera(t, { runtime });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "force push the branch");
    assert.equal(firstRequest(loaded), ASTRA);
    assert.deepEqual(lastNotice(loaded), { type: "info", message: "pi-smart-router: no HIGH model can take this run, so it goes to SUPER (gpt-6-astra)." });
    const level = recordOf(loaded)?.history.at(-1)?.level;
    assert.deepEqual(
      [level?.demand?.guards, level?.need, level?.tier, level?.source],
      [["close-call", "risky"], "high", "super", "floor"],
      "the demand of 0.67 is a close call to MEDIUM, and the risky guard raises it to HIGH, where the pick starts",
    );
  });

  test("a refusal names the tiers the run stepped up to as step-ups, not fallbacks", async (t) => {
    const runtime = heraRuntime();
    for (const ref of [TERRA, DEEPSEEK, SOL, GLM_CLOUD, ASTRA, KIMI]) runtime.catalog.unavailable.add(ref);
    const loaded = await hera(t, { runtime });
    await say(loaded, "x #medium");
    const signal = loaded.session.startRun();
    const none = "not among the available models";
    assert.throws(() => loaded.runtime.route("auto", request("user", { signal })), {
      message:
        `smart-router/auto: no model can take this request (medium: ${TERRA}: ${none}; ${DEEPSEEK}: ${none}; step-up high: ${SOL}: ${none}; ${GLM_CLOUD}: ${none}; ` +
        `step-up super: ${ASTRA}: ${none}; ${KIMI}: ${none}). Nothing was sent. See /smart-router status, or choose a model with /model.`,
    });
  });

  test("a tier returns to its first model as soon as that model's cooldown ends", async (t) => {
    let clock = NOW;
    const loaded = await hera(t, { now: () => clock });
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: "You've hit your usage limit." }) });
    await say(loaded, "x #high");
    assert.equal(firstRequest(loaded), GLM_CLOUD, "sol is cooling");
    await finish(loaded, GLM_CLOUD);
    clock = NOW + 31 * 60_000;
    await say(loaded, "y #high");
    assert.equal(firstRequest(loaded), SOL);
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level, { ...TAGGED_HIGH, returnedToFirst: true });
  });
});

describe("the work directories' scope", () => {
  test("is recorded at the start of a run that had no input, such as a custom message's", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await start({ dir, cwd: ACME_APP, runtime: heraRuntime(), now: () => NOW });
    const roster = JSON.parse(HERA_V2);
    roster.scopes.work.directories = ["/Users/johnw/src/positron", ACME];
    writeFileSync(join(dir, "smart-router.json"), JSON.stringify(roster));
    await loaded.host.command("smart-router", "reload");
    const scopeEntries = (): unknown[] => loaded.session.entries.filter((entry) => entry.customType === SCOPE_ENTRY).map((entry) => entry.data);
    assert.deepEqual(scopeEntries(), [], "a reload records nothing");
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: { role: "custom", customType: "goal-x", content: "continue", display: false, timestamp: NOW } });
    assert.deepEqual(scopeEntries(), [{ v: 1, scope: "work", by: "directory", at: NOW }]);
    assert.deepEqual(lastNotice(loaded), { type: "info", message: `pi-smart-router: this session is in work scope because ${ACME_APP} is under ${ACME}.` });
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "go ahead" });
    assert.equal(scopeEntries().length, 1, "once");
  });
});

describe("what pi-cache-optimizer is told", () => {
  const brief = (loaded: Loaded, id: "auto" | "local" = "auto"): string | undefined => {
    const route = loaded.router?.activeRoute(id);
    return route === undefined ? undefined : `${route.provider}/${route.modelId} ${route.status}`;
  };

  test("a plan made in another scope is not the run's: as the run's first request does, it goes by the session's scope", async (t) => {
    const loaded = await hera(t);
    await say(loaded, "x #high");
    assert.equal(brief(loaded), `${SOL} planned`);
    loaded.session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW));
    assert.equal(brief(loaded), `${WORK_TERRA} selected`);
    assert.equal(firstRequest(loaded), WORK_TERRA);
  });

  test("smart-router/auto has no pick in a scope it refuses, and smart-router/local has its LAN pick in work scope", async (t) => {
    await withEnv(ENV_SCOPE, "work", async () => {
      const loaded = await start({ dir: agentDir(t), runtime: heraRuntime(), now: () => NOW });
      assert.throws(() => loaded.runtime.route("auto", request("direct")), /work scope, which a version 1 roster does not serve/);
      assert.equal(brief(loaded), undefined);
      assert.equal(routed(loaded.runtime.route("local", request("direct"))), GLM);
      assert.equal(brief(loaded, "local"), `${GLM} selected`);
    });
  });
});

describe("a run's record", () => {
  /** The data of the session's level entries, oldest first. */
  const levelEntries = (loaded: Loaded): Array<Record<string, unknown>> =>
    loaded.session.entries.filter((entry) => entry.customType === LEVEL_ENTRY).map((entry) => entry.data as Record<string, unknown>);
  /** The same without their demand, which an untagged run's entry holds and a tagged run's never. */
  const withoutDemands = (loaded: Loaded): Array<Record<string, unknown> | undefined> => levelEntries(loaded).map((record) => withoutDemand(record));

  test("is one smart-router.level entry, appended when the run settles: its level, the keywords, Jev's answer, the demand and the model that answered", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "rename foo to bar");
    assert.equal(firstRequest(loaded), LUNA);
    await loaded.host.emit("message_end", { message: assistant(LUNA) });
    assert.deepEqual(levelEntries(loaded), [], "nothing before the run settles");
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    assert.deepEqual(withoutDemands(loaded), [
      {
        v: 1,
        at: NOW,
        scope: "personal",
        source: "jev",
        tier: "low",
        need: "low",
        keyword: { signal: "trivial", reason: "triage:keyword_economical" },
        jev: { model: JEV, choice: "low", probabilities: LOW, confidence: 0.8, ms: 0 },
        cost: { outcome: "unknown", why: "no usage yet" },
        ref: LUNA,
      },
    ], "the run's record, with its cost: with no usage yet a missing figure is said, cost unknown");
    assert.ok(
      loaded.session.entries.filter((entry) => entry.customType === LEVEL_ENTRY).every((entry) => entry.type === "custom"),
      "a custom entry, which no model sees",
    );
    assert.equal(recordOf(loaded)?.pendingLevel, undefined, "the pending level is dropped");
    await loaded.host.emit("agent_settled", { aborted: false });
    assert.equal(levelEntries(loaded).length, 1, "a settle without a pending level records nothing");
  });

  test("is not written for a run whose plan no longer applies at its first request: the run took no level (P6)", async (t) => {
    const loaded = await hera(t);
    await say(loaded, "Rename the helper #low");
    assert.deepEqual([recordOf(loaded)?.plan?.level?.scope, recordOf(loaded)?.pendingLevel?.level.tier], ["personal", "low"]);
    // /smart-router scope work, typed before the run's first request: the plan was made for personal scope.
    loaded.session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW));
    assert.equal(await runPrompt(loaded, "Rename the helper"), WORK_TERRA, "work's medium level, where a run without a plan goes");
    assert.equal(recordOf(loaded)?.pendingLevel, undefined, "the dropped plan took its level with it");
    await finish(loaded, WORK_TERRA);
    assert.deepEqual(levelEntries(loaded), [], "a run without a level of its own records nothing");
  });

  test("is written with the planned level, and no model, for a run whose first request smart-router/auto refuses because the scope moved to one the roster does not serve", async (t) => {
    const roster = JSON.parse(HERA_V2);
    delete roster.scopes.work;
    roster.roles = roster.roles.filter((role: { name: string }) => !role.name.startsWith("work-"));
    delete roster.accounts["openai-codex-3"];
    const loaded = await hera(t, { roster: JSON.stringify(roster) });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "Rename the helper #low");
    await settled();
    assert.deepEqual([recordOf(loaded)?.plan?.level?.scope, recordOf(loaded)?.pendingLevel?.level.tier], ["personal", "low"]);
    // /smart-router scope work, typed before the run's first request: the roster has no work scope.
    loaded.session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW));
    const signal = loaded.session.startRun();
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "Rename the helper" });
    assert.throws(() => loaded.runtime.route("auto", request("user", { signal })), /this session is in work scope, which the roster does not serve/);
    assert.deepEqual(
      [recordOf(loaded)?.plan?.level?.scope, recordOf(loaded)?.pendingLevel?.level.tier, recordOf(loaded)?.history.length],
      ["personal", "low", 0],
      "the request was refused before its plan was looked at: the plan and its level are still there, and nothing was routed",
    );
    await finish(loaded, "smart-router/auto", { api: "pi-virtual", stopReason: "error", errorMessage: "refused" });
    assert.deepEqual(levelEntries(loaded), [
      {
        v: 1,
        at: NOW,
        scope: "personal",
        source: "tag",
        tier: "low",
        need: "low",
        tag: "low",
        keyword: { signal: "trivial", reason: "triage:keyword_economical" },
        jev: { model: JEV, choice: "low", probabilities: LOW, confidence: 0.8, ms: 0 },
      },
    ]);
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel], [undefined, undefined], "the settle dropped both");
  });

  test("is written with the planned level for a run whose plan a later message's plan without a level replaced before the run started", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    // A later extension holds the first message after the router has planned it.
    const { holds } = laterExtension(loaded);
    const gate = deferred<void>();
    holds.set("go ahead", gate.promise);
    const { one, two, earlier, later } = await overlap(loaded, "go ahead", "rename foo to bar");
    earlier.resolve(jevAnswer(LOW));
    await settled();
    const own = recordOf(loaded)?.pendingLevel;
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, own?.level.tier], ["low", "low"], "the first message planned LOW");
    // /model smart-router/local, while the first message is held and the second waits for Jev.
    assert.equal(await loaded.host.choose("smart-router/local"), true);
    later.resolve(jevAnswer(HIGH));
    assert.deepEqual(await two, [undefined, undefined]);
    const replaced = recordOf(loaded)?.plan;
    assert.deepEqual([replaced?.virtualId, replaced?.level, recordOf(loaded)?.pendingLevel === own], ["local", undefined, true], "the second message's plan has no level, and the pending level is still the first's");
    gate.resolve();
    assert.deepEqual(await one, [undefined, undefined]);
    // The first message's run starts: the plan is the second message's, so it is dropped, and the level stays.
    const signal = loaded.session.startRun();
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "go ahead" });
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.pendingLevel === own], [undefined, true]);
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM);
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.code, recordOf(loaded)?.history.at(-1)?.level], ["stick:default", undefined], "the request routes unplanned, with no plan to find stale");
    await finish(loaded, GLM);
    assert.deepEqual(withoutDemands(loaded), [
      {
        v: 1,
        at: NOW,
        scope: "personal",
        source: "jev",
        tier: "low",
        need: "low",
        keyword: { signal: "default", reason: "triage:no_fast_path" },
        jev: { model: JEV, choice: "low", probabilities: LOW, confidence: 0.8, ms: 0 },
        cost: { outcome: "unknown", why: "no usage yet" },
        ref: GLM,
      },
    ], "the planned level's record, with its cost: with no usage yet a missing figure is said, cost unknown");
  });

  test("is not written for a level a custom message's run dropped: neither that run nor the message's own run, started after it, leaves an entry", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    const hold = deferred<void>();
    later.holds.set("design the new storage layer", hold.promise);
    const held = say(loaded, "design the new storage layer #super");
    await settled();
    assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.pendingLevel?.level.tier], ["super", "super"], "the message planned SUPER");
    // A goal-x continuation starts a run while the message is held: the run is not the message's.
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: GOAL_X });
    assert.equal(recordOf(loaded)?.pendingLevel, undefined, "the custom message's run dropped the level");
    loaded.session.startRun();
    await finish(loaded, KIMI);
    assert.deepEqual(levelEntries(loaded), [], "a custom message's run has no level of its own");
    hold.resolve();
    await held;
    assert.equal(await runPrompt(loaded, "design the new storage layer"), KIMI, "the message's own run goes unplanned, on smart-router/auto");
    await finish(loaded, KIMI);
    assert.deepEqual(levelEntries(loaded), [], "and the dropped level is not recorded");
  });

  test("is not written for a level a newer idle message replaced: the held message's own run, started after the newer one's, leaves no entry", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const later = laterExtension(loaded);
    const hold = deferred<void>();
    later.holds.set("design the new storage layer", hold.promise);
    const held = say(loaded, "design the new storage layer #super");
    await settled();
    const first = recordOf(loaded)?.pendingLevel;
    assert.equal(first?.level.tier, "super", "the held message planned SUPER");
    // A second message arrives while the session is still idle, and is planned in the first one's place.
    await say(loaded, "rename foo to bar #low");
    const second = recordOf(loaded)?.pendingLevel;
    assert.deepEqual([second === first, second?.level.tier], [false, "low"], "the pending level is the newer message's");
    assert.equal(await runPrompt(loaded, "rename foo to bar"), LUNA);
    await finish(loaded, LUNA);
    hold.resolve();
    await held;
    assert.equal(await runPrompt(loaded, "design the new storage layer"), LUNA, "the held message's own run goes unplanned, on smart-router/auto");
    assert.deepEqual([recordOf(loaded)?.history.at(-1)?.level, recordOf(loaded)?.pendingLevel], [undefined, undefined]);
    await finish(loaded, LUNA);
    assert.deepEqual(
      levelEntries(loaded).map((record) => [record.source, record.tier, record.ref]),
      [["tag", "low", LUNA]],
      "one entry, the newer message's run's: the held message's SUPER is not recorded",
    );
  });

  test("keeps the planned level for a run that stays on a model picked by hand after its message was planned, and loses it when the selection moves on to smart-router/local", async (t) => {
    // The run stays on the hand-picked model: none of its requests reach the router.
    const stays = await hera(t, { id: "stays" });
    await say(stays, "x #high");
    assert.equal(await stays.host.choose(KIMI), true);
    stays.session.startRun();
    await stays.host.emit("before_agent_start", { messageType: "user", prompt: "x" });
    await finish(stays, KIMI);
    // The same, and the hand-picked model ends on an error: no model answered.
    assert.equal(await stays.host.choose("smart-router/auto"), true);
    await say(stays, "y #low");
    assert.equal(await stays.host.choose(KIMI), true);
    stays.session.startRun();
    await stays.host.emit("before_agent_start", { messageType: "user", prompt: "y" });
    await finish(stays, KIMI, { stopReason: "error", errorMessage: "terminated" });
    assert.deepEqual(
      levelEntries(stays).map((record) => [record.source, record.tier, "ref" in record ? record.ref : "no ref"]),
      [
        ["tag", "high", KIMI],
        ["tag", "low", "no ref"],
      ],
    );
    // The run starts on the hand-picked model, the selection moves to smart-router/local, and a
    // steer's request is the run's first to reach the router: the plan was made for smart-router/auto.
    const moves = await hera(t, { id: "moves" });
    await say(moves, "x #high");
    assert.equal(await moves.host.choose(KIMI), true);
    const signal = moves.session.startRun();
    await moves.host.emit("before_agent_start", { messageType: "user", prompt: "x" });
    await moves.host.emit("message_end", { message: assistant(KIMI, { stopReason: "toolUse" }) });
    assert.equal(recordOf(moves)?.pendingLevel?.level.tier, "high", "the run holds its level on the hand-picked model");
    assert.equal(await moves.host.choose("smart-router/local"), true);
    assert.equal(routed(moves.runtime.route("local", request("user", { signal }))), GLM);
    assert.equal(recordOf(moves)?.pendingLevel, undefined, "the plan no longer applies, and takes the level with it");
    await finish(moves, GLM);
    assert.deepEqual(levelEntries(moves), []);
  });

  test("names the model that answered, after a retry moved the run", async (t) => {
    const loaded = await hera(t);
    await say(loaded, "x #high");
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), SOL);
    const limit = "You've hit your usage limit.";
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: limit }) });
    assert.equal(routed(loaded.runtime.route("auto", request("retry", { signal, failed: failedRequest(loaded.runtime, SOL, limit) }))), GLM_CLOUD);
    await finish(loaded, GLM_CLOUD);
    assert.deepEqual(
      levelEntries(loaded).map((record) => [record.source, record.tier, record.ref]),
      [["tag", "high", GLM_CLOUD]],
    );
  });

  test("names the model of the run's last answer that ended without an error, and no model when none answered", async (t) => {
    const loaded = await hera(t);
    // An answer, then a turn that ends on an error: the answer's model is named.
    await say(loaded, "x #high");
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), SOL);
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "toolUse" }) });
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: "terminated" }) });
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    // A run that ends on "terminated" before any answer.
    await say(loaded, "y #high");
    assert.equal(firstRequest(loaded), SOL);
    await finish(loaded, SOL, { stopReason: "error", errorMessage: "terminated" });
    // A run refused at its first request: the error is the router's own, and no model answered.
    for (const ref of [SOL, GLM_CLOUD, ASTRA, KIMI]) loaded.runtime.catalog.unavailable.add(ref);
    await say(loaded, "z #high");
    const refused = loaded.session.startRun();
    assert.throws(() => loaded.runtime.route("auto", request("user", { signal: refused })), /no model can take this request/);
    await finish(loaded, "smart-router/auto", { api: "pi-virtual", stopReason: "error", errorMessage: "refused" });
    assert.deepEqual(
      levelEntries(loaded).map((record) => [record.tier, "ref" in record ? record.ref : "no ref"]),
      [
        ["high", SOL],
        ["high", "no ref"],
        ["high", "no ref"],
      ],
    );
  });

  test("names only an answer of its own run, never one from a run whose end never came", async (t) => {
    const loaded = await hera(t);
    await say(loaded, "x #high");
    assert.equal(firstRequest(loaded), SOL);
    await loaded.host.emit("message_end", { message: assistant(SOL) });
    // No agent_settled for that run: the next input drops its level unrecorded.
    loaded.session.endRun();
    await say(loaded, "y #high");
    assert.equal(await runPrompt(loaded, "y"), SOL);
    await finish(loaded, SOL, { stopReason: "error", errorMessage: "terminated" });
    assert.deepEqual(
      levelEntries(loaded).map((record) => [record.tier, "ref" in record ? record.ref : "no ref"]),
      [["high", "no ref"]],
    );
  });

  test("names the model that answered when a switch moved the run to smart-router/local", async (t) => {
    const loaded = await hera(t);
    await say(loaded, "x #high");
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), SOL);
    // /smart-router local on, or /model, puts smart-router/local in charge of the run's next turn.
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal }))), GLM);
    await finish(loaded, GLM);
    assert.deepEqual(
      levelEntries(loaded).map((record) => [record.tier, record.ref]),
      [["high", GLM]],
    );
  });

  test("an aborted run's record says so", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "rename foo to bar");
    assert.equal(firstRequest(loaded), LUNA);
    await loaded.host.emit("message_end", { message: assistant(LUNA, { stopReason: "aborted" }) });
    await loaded.host.emit("agent_settled", { aborted: true });
    loaded.session.endRun();
    assert.deepEqual(
      levelEntries(loaded).map((record) => [record.ref, record.aborted]),
      [[LUNA, true]],
    );
  });

  test("a tagged run records its tag and Jev's opinion, or that the opinion had not come when the run settled", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    const late = deferred<ClassifierResult>();
    loaded.runtime.answer = () => late.promise;
    await say(loaded, "x #high");
    assert.equal(firstRequest(loaded), SOL);
    await finish(loaded, SOL);
    // The opinion that comes after the run settled changes nothing recorded.
    late.resolve(jevAnswer(MEDIUM));
    await settled();
    loaded.runtime.answer = async () => jevAnswer(MEDIUM);
    await say(loaded, "y #high");
    await settled();
    assert.equal(firstRequest(loaded), SOL);
    await finish(loaded, SOL);
    const tagged = {
      v: 1,
      at: NOW,
      scope: "personal",
      source: "tag",
      tier: "high",
      need: "high",
      tag: "high",
      keyword: { signal: "default", reason: "triage:no_fast_path" },
      ref: SOL,
    };
    assert.deepEqual(levelEntries(loaded), [
      { ...tagged, jev: { late: true } },
      { ...tagged, jev: { model: JEV, choice: "medium", probabilities: MEDIUM, confidence: 0.8, ms: 0 } },
    ]);
  });

  test("carries the floor's trigger, a step-up and a return to the tier's first candidate", async (t) => {
    let clock = NOW;
    const runtime = heraRuntime();
    const loaded = await hera(t, { runtime, now: () => clock });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "force push the branch");
    await finish(loaded, firstRequest(loaded));
    for (const ref of [LUNA, NYX_QWEN, HERA_QWEN]) runtime.catalog.unavailable.add(ref);
    await say(loaded, "x #low");
    await finish(loaded, firstRequest(loaded));
    runtime.catalog.unavailable.clear();
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: "You've hit your usage limit." }) });
    await say(loaded, "y #high");
    await finish(loaded, firstRequest(loaded));
    clock = NOW + 31 * 60_000;
    await say(loaded, "z #high");
    await finish(loaded, firstRequest(loaded));
    const pick = (record: Record<string, unknown>) => [record.source, record.need, record.tier, record.trigger, record.steppedUp, record.returnedToFirst, record.ref];
    assert.deepEqual(
      levelEntries(loaded).map(pick),
      [
        ["floor", "high", "high", "destructive-git", undefined, undefined, SOL],
        ["tag", "low", "medium", undefined, true, undefined, TERRA],
        ["tag", "high", "high", undefined, undefined, undefined, GLM_CLOUD],
        ["tag", "high", "high", undefined, undefined, true, SOL],
      ],
      "a record's need is after the floors: a risky run needs at least HIGH",
    );
  });

  test("a resend that reused a tagged message's level records the tag, and no opinion of Jev's", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead #high");
    await settled();
    assert.equal(firstRequest(loaded), SOL);
    await finish(loaded, SOL, { stopReason: "error", errorMessage: "terminated" });
    // pi-idle-check sends the text again, and Jev is not asked again.
    await say(loaded, "go ahead", { source: "extension" });
    assert.equal(firstRequest(loaded), SOL);
    await finish(loaded, SOL);
    const records = levelEntries(loaded);
    assert.deepEqual(
      records.map((record) => [record.source, record.tag, record.ref]),
      [
        ["tag", "high", undefined],
        ["tag", "high", SOL],
      ],
      "the first run ended on terminated, so no model answered it",
    );
    assert.deepEqual(records[0]?.jev, { model: JEV, choice: "low", probabilities: LOW, confidence: 0.8, ms: 0 });
    assert.equal(records[1] !== undefined && "jev" in records[1], false, "the resend asked Jev nothing");
  });

  test("a resend that reused an untagged message's level records that message's answer from Jev again, and Jev is not asked again", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead");
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    await finish(loaded, LUNA);
    // pi-idle-check sends the text again.
    await say(loaded, "go ahead", { source: "extension" });
    assert.equal(await runPrompt(loaded, "go ahead"), LUNA);
    await finish(loaded, LUNA);
    const answer = { model: JEV, choice: "low", probabilities: LOW, confidence: 0.8, ms: 0 };
    assert.deepEqual(
      levelEntries(loaded).map((record) => [record.source, record.tier, record.jev]),
      [
        ["jev", "low", answer],
        ["jev", "low", answer],
      ],
    );
    assert.equal(calls(loaded), 1, "one question, for the first message");
  });

  test("a run without a level records nothing: a physical selection, smart-router/local and a version 1 roster", async (t) => {
    const physical = await hera(t, { id: "physical", select: KIMI });
    const local = await hera(t, { id: "local", select: "local" });
    const v1 = await hera(t, { id: "v1", roster: fixture("roster-hera.json") });
    for (const loaded of [physical, local, v1]) {
      loaded.runtime.answer = async () => jevAnswer(LOW);
      for (const [text, prompt] of [
        ["rename foo to bar", "rename foo to bar"],
        ["go ahead #high", "go ahead"],
      ] as const) {
        await say(loaded, text);
        const signal = loaded.session.startRun();
        await loaded.host.emit("before_agent_start", { messageType: "user", prompt });
        const selected = loaded.session.model;
        const ref = selected?.provider === "smart-router" ? routed(loaded.runtime.route(selected.id === "local" ? "local" : "auto", request("user", { signal }))) : KIMI;
        await finish(loaded, ref);
      }
      assert.deepEqual(levelEntries(loaded), [], loaded.session.id);
      assert.equal(loaded.session.statuses.has(LEVEL_KEY), false, `${loaded.session.id}: the footer's level item is never set`);
    }
  });

  test("that cannot be appended is reported, and the run's plan, pick and level are dropped all the same", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "rename foo to bar");
    assert.equal(firstRequest(loaded), LUNA);
    loaded.host.api.appendEntry = () => {
      throw new Error("the session file is read-only");
    };
    await finish(loaded, LUNA);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: "pi-smart-router: the agent_settled handler failed: the session file is read-only" });
    assert.deepEqual([recordOf(loaded)?.plan, recordOf(loaded)?.runPick, recordOf(loaded)?.pendingLevel], [undefined, undefined, undefined]);
  });

  test("an earlier version's record still reads", async (t) => {
    const earlier = { v: 1, at: NOW, scope: "personal", source: "keyword", tier: "high", asked: "medium", keyword: { signal: "default", reason: "triage:x" } };
    const loaded = await hera(t, { setup: (session) => session.appendCustom(LEVEL_ENTRY, earlier) });
    assert.deepEqual(loaded.session.notices, [], "start() reads it without a failure");
    const entry = loaded.session.entries.find((candidate) => candidate.customType === LEVEL_ENTRY);
    assert.deepEqual(readLevelRecord(entry), { v: 1, at: NOW, scope: "personal", source: "keyword", tier: "high", need: "high" }, "an earlier record's need is its tier");
    assert.equal(readLevelRecord({ ...entry, data: { ...earlier, need: "ultra" } }), undefined, "a need that is no level is no record the router wrote");
    assert.equal(recordOf(loaded)?.need, "high", "a resumed session's level is its earlier record's tier, read as its need (levelRole became need)");
    await loaded.host.command("smart-router", "was low");
    assert.deepEqual(levelEntries(loaded).at(-1), { v: 1, at: NOW, scope: "personal", source: "correction", tier: "low", refers: NOW }, "/smart-router was corrects the run of the earlier record");
  });

  test("a run's record holds its demand and no prompt text", async (t) => {
    const MARK = "quixotic-zebra";
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, `${MARK} rename foo to bar`);
    const demand = recordOf(loaded)?.pendingLevel?.level.demand;
    assert.ok(demand !== undefined, "an untagged run has a demand");
    await finish(loaded, await runPrompt(loaded, `${MARK} rename foo to bar`));
    const records = levelEntries(loaded);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0]?.demand, demand, "the record's demand is the plan's");
    assert.equal(records[0]?.need, "low", "and so is its need");
    const text = JSON.stringify(records);
    assert.ok(!text.includes(MARK), text);
  });

  test("holds no prompt text, and no digest of it", async (t) => {
    const MARK = "quixotic-zebra";
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    const digests: string[] = [];
    for (const [typed, prompt] of [
      [`${MARK} rename foo to bar #high`, `${MARK} rename foo to bar`],
      [`${MARK} and the tests`, `${MARK} and the tests`],
    ] as const) {
      await say(loaded, typed);
      const digest = recordOf(loaded)?.pendingLevel?.digest;
      assert.ok(digest !== undefined, typed);
      digests.push(digest);
      await finish(loaded, await runPrompt(loaded, prompt));
    }
    const records = levelEntries(loaded);
    assert.equal(records.length, 2);
    const text = JSON.stringify(records);
    assert.ok(!text.includes(MARK), text);
    for (const digest of digests) assert.ok(!text.includes(digest), text);
  });
});

describe("the footer", () => {
  const footer = (loaded: Loaded): string | undefined => loaded.session.statuses.get(LEVEL_KEY);

  test("shows a planned run's scope, tier, model and what decided it, under its own key", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = () => new Promise(() => {});
    await say(loaded, "x #high");
    assert.equal(footer(loaded), "personal HIGH → gpt-6.1-sol (tag)");
    assert.deepEqual([...loaded.session.statuses.keys()], [LEVEL_KEY], "the level's item is the only status item the router sets");
  });

  test("after a Jev timeout, names the demand and the timeout", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevFailure("Request timed out after 1000ms");
    await say(loaded, "go ahead");
    assert.equal(footer(loaded), "personal MEDIUM → gpt-6.1-terra (demand 0.9, jev timeout; cost unknown)", "without an answer the heuristics decide alone: 0.89, MEDIUM; with no usage yet a missing figure is said: cost unknown");
  });

  test("names the demand, rounded to one decimal, which an unsure answer pulls less than a sure one", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer({ low: 0.05, medium: 0.1, high: 0.824, super: 0.026 });
    await say(loaded, "go ahead");
    assert.equal(footer(loaded), "personal HIGH → gpt-6.1-sol (demand 1.6; cost unknown)", "the blend of 82% HIGH and the heuristics is 1.61, HIGH; with no usage yet a missing figure is said: cost unknown");
    // An unsure Jev no longer takes the higher of two close leaders: the blend is 1.31, MEDIUM.
    loaded.runtime.answer = async () => jevAnswer({ low: 0.05, medium: 0.45, high: 0.4, super: 0.1 });
    await say(loaded, "go ahead again");
    assert.equal(
      footer(loaded),
      "personal MEDIUM → gpt-6.1-terra (demand 1.3; cost unknown)",
      "an unsure Jev no longer takes the higher of two close leaders: the blend is 1.31; with no usage yet a missing figure is said: cost unknown",
    );
  });

  test("after a step-up, names the level the run needs and its demand, while history names the level that took it; after a higher run, a lower answer moves down", async (t) => {
    const runtime = heraRuntime();
    for (const ref of [LUNA, NYX_QWEN, HERA_QWEN]) runtime.catalog.unavailable.add(ref);
    const stepped = await hera(t, { id: "stepped", runtime });
    stepped.runtime.answer = async () => jevAnswer(LOW);
    await say(stepped, "rename foo to bar");
    assert.equal(footer(stepped), "personal LOW → gpt-6.1-terra (demand 0.4)", "no LOW model is available, so the run steps up: the footer names the level the prompt needs");
    assert.equal(lastNotice(stepped)?.message, "pi-smart-router: no LOW model can take this run, so it goes to MEDIUM (gpt-6.1-terra).", "beside the step-up notice");
    await finish(stepped, firstRequest(stepped));
    await stepped.host.command("smart-router", "history");
    assert.match(lastNotice(stepped)?.message ?? "", / \[personal MEDIUM \(demand 0\.4\)\]$/, "history keeps its form, with the new note");
    const down = await hera(t, { id: "down" });
    down.runtime.answer = async () => jevAnswer(HIGH);
    await say(down, "go ahead");
    await finish(down, firstRequest(down));
    // The latest response came from HIGH a moment ago; the run goes to LOW all the same.
    down.runtime.answer = async () => jevAnswer(LOW);
    await say(down, "and the docs");
    assert.equal(
      footer(down),
      "personal LOW → gpt-6-luna (demand 0.5; cost unknown)",
      "nothing holds a session by time: the blend of 80% LOW and the heuristics is 0.50 with the last response's 1,000 tokens; this catalog has no prices, so a missing figure is said: cost unknown",
    );
  });

  test("names the heuristics' demand without a classifier, the floor that raised a run, and work scope in a work session", async (t) => {
    const roster = JSON.parse(HERA_V2);
    delete roster.classifier;
    const none = await hera(t, { id: "none", roster: JSON.stringify(roster) });
    await say(none, "go ahead");
    assert.equal(footer(none), "personal MEDIUM → gpt-6.1-terra (demand 0.9; cost unknown)", "without a classifier the heuristics decide alone: 0.89, MEDIUM; with no usage yet a missing figure is said: cost unknown");
    const floor = await hera(t, { id: "floor" });
    floor.runtime.answer = async () => jevAnswer(LOW);
    await say(floor, "force push the branch");
    assert.equal(footer(floor), "personal HIGH → gpt-6.1-sol (demand 0.7, floor; cost unknown)", "the demand of 0.67 is raised to HIGH by the risky floor; with no usage yet a missing figure is said: cost unknown");
    const work = await hera(t, { id: "work", setup: (session) => session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW)) });
    work.runtime.answer = async () => jevAnswer(LOW);
    await say(work, "go ahead");
    assert.equal(footer(work), "work LOW → gpt-6-luna (demand 0.5; cost unknown)", "the blend of 80% LOW and the heuristics is 0.48, LOW; with no usage yet a missing figure is said: cost unknown");
  });

  test("at message_end, names the model that answered for the run's route; a model the route did not pick changes nothing", async (t) => {
    const loaded = await hera(t);
    await say(loaded, "x #high");
    const signal = loaded.session.startRun();
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "x" });
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), SOL);
    const limit = "You've hit your usage limit.";
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: limit }) });
    assert.equal(footer(loaded), "personal HIGH → gpt-6.1-sol (tag)", "an error is no answer");
    assert.equal(routed(loaded.runtime.route("auto", request("retry", { signal, failed: failedRequest(loaded.runtime, SOL, limit) }))), GLM_CLOUD);
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    assert.equal(footer(loaded), "personal HIGH → gpt-6.1-sol (tag)", "the route did not pick KIMI");
    await loaded.host.emit("message_end", { message: assistant(GLM_CLOUD) });
    assert.equal(footer(loaded), "personal HIGH → z-ai/glm-5.3 (tag)");
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    assert.equal(footer(loaded), "personal HIGH → z-ai/glm-5.3 (tag)", "it stays once the run settled");
  });

  test("is cleared by a run without a level of its own, and by a plan that found no model", async (t) => {
    const runtime = heraRuntime();
    const loaded = await hera(t, { runtime });
    await say(loaded, "x #high");
    await finish(loaded, await runPrompt(loaded, "x"));
    assert.equal(footer(loaded), "personal HIGH → gpt-6.1-sol (tag)");
    // A goal-x continuation has no level.
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: GOAL_X });
    assert.deepEqual([loaded.session.statuses.has(LEVEL_KEY), footer(loaded)], [true, undefined]);
    loaded.session.endRun();
    await say(loaded, "x #high");
    assert.equal(footer(loaded), "personal HIGH → gpt-6.1-sol (tag)");
    for (const ref of [TERRA, DEEPSEEK, SOL, GLM_CLOUD, ASTRA, KIMI]) runtime.catalog.unavailable.add(ref);
    await say(loaded, "x #medium");
    assert.equal(footer(loaded), undefined);
  });
});

describe("/smart-router scope work", () => {
  const scopeEntries = (loaded: Loaded): unknown[] => loaded.session.entries.filter((entry) => entry.customType === SCOPE_ENTRY).map((entry) => entry.data);
  const selection = (loaded: Loaded): string | undefined => (loaded.session.model === undefined ? undefined : `${loaded.session.model.provider}/${loaded.session.model.id}`);

  test("records work scope and leaves a model picked by hand selected: nothing is routed until smart-router/auto is chosen, and then it goes to the work account", async (t) => {
    const loaded = await hera(t, { select: KIMI });
    await loaded.host.command("smart-router", "scope work");
    assert.deepEqual([selection(loaded), loaded.host.selections.length], [KIMI, 0], "changing the scope asks for no routing");
    assert.deepEqual(scopeEntries(loaded), [{ v: 1, scope: "work", by: "command", at: NOW }]);
    assert.deepEqual(lastNotice(loaded), {
      type: "info",
      message: `pi-smart-router: scope work (entry).\nThe selection stays ${KIMI}. A model picked by hand is sent as it is, in work scope too.`,
    });
    // On the model picked by hand, Jev is not asked and nothing is planned.
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead");
    assert.deepEqual([loaded.runtime.classifyCalls.length, recordOf(loaded)?.plan], [0, undefined]);
    // Asked for by hand, smart-router/auto routes the work session to the work account.
    assert.equal(await loaded.host.choose("smart-router/auto"), true);
    await say(loaded, "go ahead");
    assert.equal(firstRequest(loaded), WORK_LUNA);
  });

  test("leaves a work Codex model picked by hand selected too, and when nothing could be selected anyway", async (t) => {
    const kept = await hera(t, { id: "kept", select: WORK_LUNA });
    await kept.host.command("smart-router", "scope work");
    assert.deepEqual(
      [selection(kept), lastNotice(kept)],
      [WORK_LUNA, { type: "info", message: `pi-smart-router: scope work (entry).\nThe selection stays ${WORK_LUNA}. A model picked by hand is sent as it is, in work scope too.` }],
    );
    const stuck = await hera(t, { id: "stuck", select: KIMI });
    let attempts = 0;
    stuck.host.setModel = async () => {
      attempts += 1;
      return false;
    };
    await stuck.host.command("smart-router", "scope work");
    assert.deepEqual([selection(stuck), attempts, lastNotice(stuck)?.type], [KIMI, 0, "info"], "the command tries no switch");
  });
});
