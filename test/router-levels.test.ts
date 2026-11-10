// The router's input on a version 2 roster: a trailing tag is removed with an input transform, Jev
// is asked through Pi's model registry (an untagged message waits for its answer, a tagged one
// only records its opinion), and the run is planned with the tier chosen. Unit tests on the fake
// host of test/support/pi.ts; no Pi runtime is started.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { Api, ClassifierResult, Model } from "@earendil-works/pi-ai";

import { ENV_PIN, ENV_SCOPE, SCOPE_ENTRY } from "../src/constants.ts";
import { JEV_INSTRUCTIONS } from "../src/jev.ts";
import { policyFromRoster } from "../src/local.ts";
import { createRouter } from "../src/router.ts";
import { scopeEntry } from "../src/scope.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, DEEPSEEK, FakeCatalog, GLM, GLM_CLOUD, HERA_LAN, heraModels, KIMI, model, NOW, rosterFixtureV2, SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, load, request, resetSlot, routed, start } from "./support/pi.ts";
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
const TAGGED_HIGH = { scope: "personal", tier: "high", asked: "high", start: "high", source: "tag", steppedUp: false, returnedToFirst: false } as const;

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

/** What the router makes of Jev's answer to a question it asked at NOW: a tier, and no time spent. */
function outcome(probabilities: Record<Tier, number>, tier: Tier) {
  return { kind: "answer", model: JEV, choice: tier, tier, probabilities, confidence: probabilities[tier], ms: 0 } as const;
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

/** The run ends: a response from `ref`, then agent_settled. */
async function finish(loaded: Loaded, ref: string, init: Parameters<typeof assistant>[1] = {}): Promise<void> {
  await loaded.host.emit("message_end", { message: assistant(ref, init) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
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
  test("is removed with a transform, and the run goes to its tier at once while Jev's opinion is asked without waiting", { timeout: 10_000 }, async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = () => new Promise(() => {});
    assert.deepEqual(await say(loaded, "go ahead #high"), [{ action: "transform", text: "go ahead" }]);
    assert.equal(calls(loaded), 1, "Jev was asked once, and the input did not wait for an answer that never comes");
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

  test("has no effect in a pinned session: removed with a notice, and Jev is not asked", async (t) => {
    const policy = policyFromRoster(rosterFixtureV2("roster-hera-v2.json"));
    const loaded = await hera(t, { select: "local", setup: (session) => session.pin(policy) });
    assert.deepEqual(await say(loaded, "x #low"), [{ action: "transform", text: "x" }]);
    assert.equal(calls(loaded), 0);
    assert.match(lastNotice(loaded)?.message ?? "", /no effect/);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: "pi-smart-router: the LOW tag was removed and has no effect, because this session is pinned to local models." });
    assert.deepEqual([recordOf(loaded)?.plan?.signal, recordOf(loaded)?.pendingLevel], ["local", undefined], "the run is planned on the local role");
    // The pin's refusal comes first: a selection outside its policy sends nothing, tag or not.
    loaded.session.force(KIMI);
    for (const text of ["x #low", "#low"]) {
      assert.deepEqual(await say(loaded, text), [{ action: "handled" }], text);
      assert.match(lastNotice(loaded)?.message ?? "", /is not local, so the prompt was not sent/, text);
    }
  });

  test("has no effect under PI_SMART_ROUTER_LOCAL_ONLY, and Jev is not asked", async (t) => {
    await withEnv(ENV_PIN, "1", async () => {
      const loaded = await hera(t);
      assert.equal(loaded.session.model?.id, "local", "the latch switched the selection to smart-router/local");
      assert.deepEqual(await say(loaded, "x #low"), [{ action: "transform", text: "x" }]);
      assert.deepEqual(await say(loaded, "x"), [undefined]);
      assert.equal(calls(loaded), 0);
      assert.match(lastNotice(loaded)?.message ?? "", /the LOW tag was removed and has no effect, because this session is pinned to local models/);
    });
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
    const level = { scope: "personal", tier: "low", asked: "low", start: "low", source: "jev", steppedUp: false, returnedToFirst: false, jev };
    const pending = recordOf(loaded)?.pendingLevel;
    assert.equal(typeof pending?.token, "number");
    assert.deepEqual(pending && { ...pending, token: 0 }, { token: 0, level, keyword: { signal: "trivial", reason: "triage:keyword_economical" }, at: NOW, jev });
    assert.equal(firstRequest(loaded), LUNA);
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level, level);
  });

  test("goes where Jev says, not where the keywords would", async (t) => {
    const loaded = await hera(t);
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "go ahead");
    assert.equal(firstRequest(loaded), LUNA, "the keywords would take terra");
  });

  test("goes to the keywords' tier when Jev fails, times out or answers outside the four tiers", async (t) => {
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
        recordOf(loaded)?.history.at(-1)?.level,
        { scope: "personal", tier: "medium", asked: "medium", start: "medium", source: "keyword", steppedUp: false, returnedToFirst: false, jev: { kind: "failure", model: JEV, failure, ms: 0 } },
        name,
      );
    }
  });

  test("goes to the keywords' tier, and nothing is sent, when the roster's classifier is not in the registry", async (t) => {
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
    assert.equal(recordOf(none)?.plan?.level?.source, "keyword");
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
    assert.deepEqual([recordOf(loaded)?.plan?.level?.asked, recordOf(loaded)?.plan?.level?.source], ["high", "tag"]);
    await settled();
    const failed = { kind: "failure", model: JEV, failure: "error", ms: 0 };
    assert.deepEqual(recordOf(loaded)?.pendingLevel?.jev, failed, "the opinion failed");
    assert.deepEqual(await say(loaded, huge), [undefined]);
    assert.deepEqual([recordOf(loaded)?.plan?.level?.source, recordOf(loaded)?.plan?.level?.jev], ["keyword", failed]);
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
    assert.deepEqual(await say(old, "go ahead #high"), [{ action: "transform", text: "go ahead" }]);
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

  test("of two messages waiting for Jev, only the later one plans, whichever answer comes first", { timeout: 10_000 }, async (t) => {
    for (const laterFirst of [true, false]) {
      resetSlot();
      const loaded = await hera(t, { id: `later-first-${laterFirst}` });
      const answers = [deferred<ClassifierResult>(), deferred<ClassifierResult>()];
      const pending = answers.map((answer) => answer.promise);
      loaded.runtime.answer = () => pending.shift() ?? Promise.reject(new Error("one call per message"));
      const one = say(loaded, "go ahead");
      await settled();
      const two = say(loaded, "rename foo to bar");
      await settled();
      const [earlier, later] = answers;
      const name = `the later answer came ${laterFirst ? "first" : "last"}`;
      if (laterFirst) {
        later?.resolve(jevAnswer(HIGH));
        assert.deepEqual(await two, [undefined], name);
        earlier?.resolve(jevAnswer(LOW));
        assert.deepEqual(await one, [undefined], name);
      } else {
        earlier?.resolve(jevAnswer(LOW));
        assert.deepEqual(await one, [undefined], name);
        later?.resolve(jevAnswer(HIGH));
        assert.deepEqual(await two, [undefined], name);
      }
      assert.deepEqual([recordOf(loaded)?.plan?.level?.tier, recordOf(loaded)?.plan?.level?.source], ["high", "jev"], name);
      assert.equal(recordOf(loaded)?.pendingLevel?.level.tier, "high", name);
      assert.equal(firstRequest(loaded), SOL, name);
    }
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

describe("the tier's model", () => {
  test("a tier with no available model passes the run up, with a notice", async (t) => {
    const runtime = heraRuntime();
    for (const ref of [LUNA, NYX_QWEN, HERA_QWEN]) runtime.catalog.unavailable.add(ref);
    const loaded = await hera(t, { runtime });
    assert.deepEqual(await say(loaded, "x #low"), [{ action: "transform", text: "x" }]);
    assert.equal(firstRequest(loaded), TERRA);
    assert.deepEqual(lastNotice(loaded), { type: "info", message: "pi-smart-router: no LOW model can take this run, so it goes to MEDIUM (gpt-6.1-terra)." });
    assert.deepEqual(recordOf(loaded)?.history.at(-1)?.level, { scope: "personal", tier: "medium", asked: "low", start: "low", source: "tag", steppedUp: true, returnedToFirst: false });
  });

  test("the step-up notice names the tier the pick started at, which the risky floor can raise above the one asked for", async (t) => {
    const runtime = heraRuntime();
    for (const ref of [SOL, GLM_CLOUD]) runtime.catalog.unavailable.add(ref);
    const loaded = await hera(t, { runtime });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    await say(loaded, "force push the branch");
    assert.equal(firstRequest(loaded), ASTRA);
    assert.deepEqual(lastNotice(loaded), { type: "info", message: "pi-smart-router: no HIGH model can take this run, so it goes to SUPER (gpt-6-astra)." });
    const level = recordOf(loaded)?.history.at(-1)?.level;
    assert.deepEqual([level?.asked, level?.start, level?.tier, level?.source], ["low", "high", "super", "floor"]);
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

  test("smart-router/auto has no pick in a scope it refuses, and smart-router/local is not refused", async (t) => {
    await withEnv(ENV_SCOPE, "work", async () => {
      const loaded = await start({ dir: agentDir(t), runtime: heraRuntime(), now: () => NOW });
      assert.throws(() => loaded.runtime.route("auto", request("direct")), /work scope, which a version 1 roster does not serve/);
      assert.equal(brief(loaded), undefined);
      assert.equal(brief(loaded, "local"), `${GLM} selected`);
    });
  });
});
