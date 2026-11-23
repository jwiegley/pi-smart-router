import assert from "node:assert/strict";
import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import { isDeepStrictEqual } from "node:util";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { ModelRouteReason } from "@earendil-works/pi-coding-agent";

import { planUserTurn } from "../src/decide.ts";
import type { Choice, CompactionFigures } from "../src/decide.ts";
import { demandOf } from "../src/demand.ts";
import type { PromptFacts } from "../src/demand.ts";
import { noBoundedHistory } from "../src/errors.ts";
import type { ResolveContext } from "../src/resolve.ts";
import { activeEntries, assertSafe, newRecord, predict, routeOther, routeOwned } from "../src/route.ts";
import type { RouteInput, SessionRecord } from "../src/route.ts";
import {
  ASTRA,
  CHATGPT,
  DEEPSEEK,
  FakeCatalog,
  GLM,
  GLM_CLOUD,
  HERA_LAN,
  heraContext,
  heraModels,
  KIMI,
  model,
  NATIVE_SOL,
  NOW,
  OPENROUTER,
  rosterFixture,
  rosterFixtureV2,
  SOL,
  WORK_SOL,
} from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, failure, FakeRuntime, load, previous, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded } from "./support/pi.ts";

const SID = "session-1";
const PLANNING = "plan the migration to the new store";
const TRIVIAL = "Format this file";
const HERA = rosterFixture("roster-hera.json");
/** The compaction settings a plan made here is given; no plan here has a conversation to fit. */
const COMPACTION: CompactionFigures = { enabled: true, reserve: 0, keepRecent: 20_000 };
/** A new session's facts, as the router reads them: no usage, no messages, no entry count. */
const FRESH: PromptFacts = { contextTokens: undefined, roles: [], entries: undefined };

/** A Codex model, as Hera's catalog lists them. */
const codex = (ref: string): Model<Api> => model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 });

beforeEach(resetSlot);
afterEach(resetSlot);

const record = (loaded: Loaded) => loaded.router?.record(SID);
const lastHistory = (loaded: Loaded) => record(loaded)?.history.at(-1);

async function prompt(loaded: Loaded, text: string): Promise<AbortSignal> {
  await loaded.host.emit("input", { text, source: "interactive" });
  return loaded.session.startRun();
}

function refuses(run: () => unknown, pattern: RegExp, label = ""): string {
  let message = "";
  assert.throws(run, (error: unknown) => {
    message = error instanceof Error ? error.message : String(error);
    return true;
  }, label);
  assert.match(message, pattern, label);
  assert.match(message, /Nothing was sent\./, label);
  assert.equal(isRetryableAssistantError(assistant("smart-router/auto", { stopReason: "error", errorMessage: message })), false, message);
  return message;
}

describe("owner-loop requests", () => {
  test("a user request consumes the run's plan and deletes it, and returns no state", async (t) => {
    const loaded = await start({ dir: agentDir(t), now: () => NOW });
    const signal = await prompt(loaded, PLANNING);
    assert.equal(record(loaded)?.plan?.decision.ok, true);
    const route = loaded.runtime.route("auto", request("user", { signal }));
    assert.equal(routed(route), ASTRA);
    assert.equal(route.thinkingLevel, "high");
    assert.equal("state" in route, false);
    assert.equal(record(loaded)?.plan, undefined);
    assert.deepEqual(record(loaded)?.runPick, { id: "auto", ref: ASTRA, role: "architect" });
    assert.deepEqual(lastHistory(loaded), {
      at: NOW,
      virtual: "auto",
      reason: "user",
      signal: "planning",
      trigger: "planning:plan-words",
      role: "architect",
      ref: ASTRA,
      code: "signal:planning",
      foreign: false,
    });
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("a user request without a plan sticks, as steering and follow-ups do", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const signal = await prompt(loaded, PLANNING);
    loaded.runtime.route("auto", request("user", { signal }));
    const steering = loaded.runtime.route("auto", request("user", { signal, previous: previous(loaded.runtime, ASTRA) }));
    assert.equal(routed(steering), ASTRA);
    assert.equal(lastHistory(loaded)?.code, "stick:previous");
  });

  test("input typed while the session is busy neither plans nor drops the plan", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    const signal = loaded.session.startRun();
    await loaded.host.emit("input", { text: TRIVIAL, source: "interactive", streamingBehavior: "steer" });
    assert.equal(record(loaded)?.plan?.signal, "planning");
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), ASTRA);
  });

  test("a continuation returns previous, then the run's pick, then the last responder, then the default role", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const signal = await prompt(loaded, "Debug the deadlock in concurrent writes");
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), SOL);
    const withPrevious = loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, SOL) }));
    assert.deepEqual([routed(withPrevious), lastHistory(loaded)?.code, "state" in withPrevious], [SOL, "stick:previous", false]);
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal }))), SOL);
    assert.equal(lastHistory(loaded)?.code, "stick:run");
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    assert.equal(record(loaded)?.runPick, undefined);
    const next = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal: next }))), KIMI);
    assert.equal(lastHistory(loaded)?.code, "stick:last");
    const fresh = await start({ dir: agentDir(t), runtime: new FakeRuntime(), id: "session-2" });
    const run = fresh.session.startRun();
    assert.equal(routed(fresh.runtime.route("auto", request("continuation", { signal: run }))), DEEPSEEK);
    assert.equal(fresh.router?.record("session-2")?.history.at(-1)?.code, "stick:default");
  });

  test("a base auto cannot reach does not hold: auto never sticks to the local role", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, GLM) }))), DEEPSEEK);
    assert.equal(lastHistory(loaded)?.code, "stick:default");
  });

  test("a cooled base moves to its role's declared fallback", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: "You've hit your usage limit." }) });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, SOL) }))), GLM_CLOUD);
    assert.equal(lastHistory(loaded)?.code, "fallback:engineer→coder");
    await loaded.host.emit("message_end", { message: assistant(ASTRA, { stopReason: "error", errorMessage: "insufficient_quota", timestamp: NOW + 1 }) });
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, ASTRA) }))), KIMI);
    assert.equal(lastHistory(loaded)?.code, "fallback:architect→thinker");
  });

  test("a retry keeps the model on transient errors, 429 and overflow, and moves on limit errors", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const signal = loaded.session.startRun();
    for (const text of ["429 Too Many Requests", "rate limit exceeded", "overloaded_error", "prompt is too long: 300000 tokens > 272000 maximum", "terminated"]) {
      const route = loaded.runtime.route("auto", request("retry", { signal, failed: failure(loaded.runtime, SOL, text) }));
      assert.deepEqual([routed(route), lastHistory(loaded)?.code], [SOL, "retry:same"], text);
    }
    const moved = loaded.runtime.route("auto", request("retry", { signal, failed: failure(loaded.runtime, SOL, "You've hit your usage limit.") }));
    assert.deepEqual([routed(moved), lastHistory(loaded)?.code], [GLM_CLOUD, "fallback:engineer→coder"]);
    // The retry cooled sol, so the run's next request stays off it too.
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, SOL) }))), GLM_CLOUD);
  });

  test("a limit error moves to the next candidate of the same role first", async (t) => {
    const roster = JSON.parse(fixture("roster-hera.json"));
    roster.roles.find((role: { name: string }) => role.name === "engineer").models.push("openrouter/openai/gpt-6.1-pro");
    const runtime = new FakeRuntime(new FakeCatalog([...heraModels(), model("openrouter/openai/gpt-6.1-pro", { baseUrl: OPENROUTER })]));
    const loaded = await start({ dir: agentDir(t, { roster: JSON.stringify(roster) }), runtime });
    const signal = loaded.session.startRun();
    const moved = runtime.route("auto", request("retry", { signal, failed: failure(runtime, SOL, "403 Forbidden") }));
    assert.deepEqual([routed(moved), lastHistory(loaded)?.code], ["openrouter/openai/gpt-6.1-pro", "retry:next"]);
  });

  test("a content-filter refusal never moves and never cools", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const signal = loaded.session.startRun();
    const text = "403: the response was flagged by the content_filter";
    assert.equal(routed(loaded.runtime.route("auto", request("retry", { signal, failed: failure(loaded.runtime, SOL, text) }))), SOL);
    assert.equal(lastHistory(loaded)?.code, "retry:same");
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: text }) });
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, SOL) }))), SOL);
  });

  test("a content-filter refusal whose model can no longer take the retry is refused, never moved", async (t) => {
    // Pi retries this failure ("Provider returned error"), so the retry reaches the router.
    const text = "Provider returned error: the response was flagged by the content_filter";
    for (const withPrevious of [false, true]) {
      resetSlot();
      const catalog = new FakeCatalog(heraModels());
      const loaded = await start({ dir: agentDir(t), runtime: new FakeRuntime(catalog) });
      const signal = await prompt(loaded, "Debug the deadlock in concurrent writes");
      assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), SOL);
      const failed = failure(loaded.runtime, SOL, text);
      assert.equal(isRetryableAssistantError(failed.message), true, "Pi retries this failure");
      // sol stops resolving before the retry. Sticking would send the refused content through the
      // engineer's declared fallback to openrouter/z-ai/glm-5.3, or to previous on kimi.
      catalog.unavailable.add(SOL);
      const retry = withPrevious ? request("retry", { signal, failed, previous: previous(loaded.runtime, KIMI) }) : request("retry", { signal, failed });
      refuses(() => loaded.runtime.route("auto", retry), /^smart-router\/auto: openai-codex-2\/gpt-6\.1-sol refused this content and can no longer take the retry/, `previous: ${withPrevious}`);
      assert.deepEqual([record(loaded)?.history.length, record(loaded)?.runPick?.ref], [1, SOL], "the refused retry recorded no pick");
    }
  });

  test("a retry with no failed request routes as a continuation", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("retry", { signal, previous: previous(loaded.runtime, KIMI) }))), KIMI);
    assert.equal(lastHistory(loaded)?.code, "stick:previous");
  });

  test("a plan made for another selection is never used", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    loaded.session.select("local");
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM);
    assert.equal(record(loaded)?.plan, undefined);
  });
});

describe("direct and foreign requests", () => {
  test("direct prefers previous, then the session's last responder, then the default role", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    assert.equal(routed(loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, KIMI) }))), KIMI);
    assert.equal(lastHistory(loaded)?.code, "direct:previous");
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK);
    assert.equal(lastHistory(loaded)?.code, "direct:default");
    await loaded.host.emit("message_end", { message: assistant(ASTRA) });
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), ASTRA);
    assert.equal(lastHistory(loaded)?.code, "direct:last");
    assert.equal(routed(loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, GLM) }))), ASTRA, "auto never summarizes on the local role");
  });

  test("direct and foreign requests consume no plan and change nothing the adapter reads", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    const before = { plan: record(loaded)?.plan, runPick: record(loaded)?.runPick, last: record(loaded)?.last };
    assert.ok(before.plan !== undefined);
    loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, SOL) }));
    const foreignSignal = new AbortController().signal;
    const foreign = loaded.runtime.route("auto", request("continuation", { signal: foreignSignal, previous: previous(loaded.runtime, SOL) }));
    assert.equal(routed(foreign), SOL);
    assert.deepEqual([lastHistory(loaded)?.code, lastHistory(loaded)?.foreign], ["foreign:previous", true]);
    loaded.runtime.route("auto", request("user", { signal: foreignSignal }));
    assert.deepEqual([lastHistory(loaded)?.code, lastHistory(loaded)?.foreign], ["foreign:default", true]);
    assert.deepEqual({ plan: record(loaded)?.plan, runPick: record(loaded)?.runPick, last: record(loaded)?.last }, before);
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), ASTRA, "the owner's run still gets its plan");
  });

  test("a direct request that carries the run's signal routes as direct and leaves the run's pick", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const signal = await prompt(loaded, PLANNING);
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), ASTRA);
    const pick = { id: "auto", ref: ASTRA, role: "architect" };
    assert.deepEqual(record(loaded)?.runPick, pick, "the run's signal routes the owner's loop");
    // An extension's side call made during the run with { signal: ctx.signal }: Pi's
    // ModelRuntime.streamSimple routes it as direct, with the caller's signal.
    assert.equal(routed(loaded.runtime.route("auto", request("direct", { signal, previous: previous(loaded.runtime, KIMI) }))), KIMI);
    assert.equal(lastHistory(loaded)?.code, "direct:previous");
    assert.deepEqual(record(loaded)?.runPick, pick, "the run's pick, which the adapter reports, is unchanged");
  });

  test("on smart-router/local, direct and continuation requests go to the local role, whatever answered before", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: "local" });
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    assert.equal(routed(loaded.runtime.route("local", request("direct", { previous: previous(loaded.runtime, KIMI) }))), GLM, "direct goes local");
    assert.equal(lastHistory(loaded)?.code, "direct:default");
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal, previous: previous(loaded.runtime, SOL) }))), GLM, "a continuation goes local");
  });
});

describe("refusals", () => {
  test("smart-router/local refuses when its model is missing, unauthenticated or not local", async (t) => {
    const cases: Array<[string, (catalog: FakeCatalog) => void, RegExp]> = [
      ["absent", (catalog) => catalog.remove(GLM), /omlx-hera\/GLM-5\.3-Flash-oQ4e-mtp: not in the catalog/],
      ["unauthenticated", (catalog) => catalog.unauthenticated.add(GLM), /its provider has no credentials/],
      ["unavailable", (catalog) => catalog.unavailable.add(GLM), /not among the available models/],
      ["cloud", (catalog) => catalog.add(model(GLM, { baseUrl: OPENROUTER })), /host openrouter\.ai is not a local host/],
    ];
    for (const [name, edit, pattern] of cases) {
      resetSlot();
      const catalog = new FakeCatalog(heraModels());
      edit(catalog);
      const loaded = await start({ dir: agentDir(t), runtime: new FakeRuntime(catalog), select: "local" });
      const signal = loaded.session.startRun();
      const message = refuses(() => loaded.runtime.route("local", request("continuation", { signal })), pattern);
      assert.match(message, /^smart-router\/local: no local model can take this request \(local: /, name);
      assert.match(message, /choose another model with \/model\.$/, name);
    }
  });

  test("smart-router/local refuses without a local section", async (t) => {
    const roster = JSON.parse(fixture("roster-hera.json"));
    delete roster.local;
    const loaded = await start({ dir: agentDir(t, { roster: JSON.stringify(roster) }), select: "local" });
    refuses(() => loaded.runtime.route("local", request("direct")), /^smart-router\/local: the roster has no local section\./);
  });

  test("a missing, invalid or unsafe roster refuses, and an edit leaves no last-known-good copy", async (t) => {
    const missing = await start({ dir: agentDir(t, { roster: null }) });
    refuses(() => missing.runtime.route("auto", request("direct")), /smart-router\.json does not exist/);
    assert.match(missing.session.notices[0]?.message ?? "", /does not exist\. Every smart-router model refuses every request/);
    resetSlot();
    const invalid = await start({ dir: agentDir(t, { roster: "{ nope" }) });
    refuses(() => invalid.runtime.route("auto", request("direct")), /is invalid \(JSON syntax error/);
    resetSlot();
    const dir = agentDir(t);
    const edited = await start({ dir });
    assert.equal(routed(edited.runtime.route("auto", request("direct"))), DEEPSEEK);
    writeFileSync(join(dir, "smart-router.json"), JSON.stringify({ version: 3 }));
    utimesSync(join(dir, "smart-router.json"), new Date(), new Date(Date.now() + 5_000));
    await edited.host.emit("input", { text: TRIVIAL, source: "interactive" });
    refuses(() => edited.runtime.route("auto", request("direct")), /is invalid \(version: must be 1/);
    resetSlot();
    const loose = agentDir(t);
    chmodSync(join(loose, "smart-router.json"), 0o666);
    const unsafe = await start({ dir: loose });
    refuses(() => unsafe.runtime.route("auto", request("direct")), /is unsafe \(.*writable by its group or by others/);
  });

  test("a Pi without bounded history refuses every request", async (t) => {
    const loaded = await start({ dir: agentDir(t), bounded: false });
    refuses(() => loaded.runtime.route("auto", request("direct")), /no bounded session history/);
    const signal = loaded.session.startRun();
    refuses(() => loaded.runtime.route("auto", request("user", { signal })), /no bounded session history/);
    assert.match(loaded.session.notices[0]?.message ?? "", /no bounded session history/);
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("a Pi without bounded history says at session start that both models refuse, and a model picked by hand is still sent", async (t) => {
    const loaded = load({ dir: agentDir(t), bounded: false });
    loaded.session.select(KIMI);
    await loaded.host.emit("session_start", { reason: "startup" });
    assert.equal(
      loaded.session.notices[0]?.message,
      "pi-smart-router: this Pi has no bounded session history (getLatestCustomEntry and getRecentActiveEntries), so every smart-router model refuses every request. Run jwiegley/pi 1.5.0 or later.",
      "the notice says both models refuse, and nothing of a pin",
    );
    // The router's own models refuse there; a model picked by hand is left selected and sent as it is.
    assert.deepEqual([`${loaded.session.model?.provider}/${loaded.session.model?.id}`, loaded.host.selections.length], [KIMI, 0], "the selection is left as it is");
    assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [undefined], "its prompt is sent");
    for (const id of ["auto", "local"] as const) {
      assert.throws(() => loaded.runtime.route(id, request("direct")), { message: noBoundedHistory(id).message }, id);
    }
    assert.equal(loaded.session.wholeHistoryReads, 0, "no whole-history read");
  });

  test("Hera's work alias is refused even when a roster names it", async (t) => {
    const roster = JSON.parse(fixture("roster-hera.json"));
    roster.roles.find((role: { name: string }) => role.name === "engineer").models = ["openai-codex-3/gpt-6.1-sol"];
    const loaded = await start({ dir: agentDir(t, { roster: JSON.stringify(roster) }) });
    refuses(() => loaded.runtime.route("auto", request("direct")), /is invalid \(roles\[4\]\.models\[0\]: "openai-codex-3\/gpt-6\.1-sol" is excluded by openai-codex-3\/\*\)/);
  });
});

describe("session state", () => {
  test("session_start registers the models again with limits from the roster", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const limits = loaded.host.definitions.map((definition) => [definition.id, definition.contextWindow, definition.maxTokens]);
    assert.deepEqual(limits, [
      ["auto", 128_000, 16_384],
      ["local", 128_000, 16_384],
      ["personal", 128_000, 16_384],
      ["work", 128_000, 16_384],
      ["auto", 128_000, 32_000],
      ["local", 262_144, 81_920],
      // A version 1 roster serves personal scope alone: its model declares auto's limits, work's the defaults.
      ["personal", 128_000, 32_000],
      ["work", 128_000, 16_384],
    ]);
    assert.equal(loaded.runtime.find("smart-router", "local")?.contextWindow, 262_144);
    assert.deepEqual(loaded.router?.limits(), { auto: { contextWindow: 128_000, maxTokens: 32_000 }, local: { contextWindow: 262_144, maxTokens: 81_920 }, personal: { contextWindow: 128_000, maxTokens: 32_000 }, work: { contextWindow: 128_000, maxTokens: 16_384 } });
  });

  test("the limits skip roles with no available model and fall back to the defaults", async (t) => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(DEEPSEEK);
    catalog.remove(GLM);
    const loaded = await start({ dir: agentDir(t), runtime: new FakeRuntime(catalog) });
    assert.deepEqual(loaded.router?.limits(), { auto: { contextWindow: 200_000, maxTokens: 32_000 }, local: { contextWindow: 128_000, maxTokens: 16_384 }, personal: { contextWindow: 200_000, maxTokens: 32_000 }, work: { contextWindow: 128_000, maxTokens: 16_384 } });
  });

  test("session_start seeds the last responder from a bounded read of the branch", async (t) => {
    const loaded = load({ dir: agentDir(t), runtime: new FakeRuntime() });
    loaded.session.appendAssistant(assistant(KIMI, { timestamp: NOW - 60_000 }));
    loaded.session.appendAssistant(assistant(SOL, { stopReason: "error", errorMessage: "usage limit" }));
    loaded.session.appendAssistant(assistant("smart-router/auto", { api: "pi-virtual", stopReason: "error", errorMessage: "refused" }));
    loaded.session.appendAssistant(assistant(ASTRA, { stopReason: "aborted" }));
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "resume" });
    assert.equal(record(loaded)?.last?.ref, KIMI);
    assert.equal(record(loaded)?.last?.at, NOW - 60_000);
    const SEED = { type: "message", messageRole: "assistant", limit: 16 };
    // An earlier version's pin entry is never looked for (John, 2026-11-18: no trace of the pin).
    const PIN = { customType: "smart-router.pin", scope: "all" };
    const SCOPE = { customType: "smart-router.scope", scope: "all" };
    // The level a resumed session held: its latest level record, one bounded read of the branch.
    const LEVEL = { customType: "smart-router.level", scope: "active" };
    // The branch's latest compaction, one bounded read: an answer older than it seeds nothing. It
    // stops before the oldest entry the seed read returned (e0, KIMI's), so it never walks a branch
    // that was never compacted to its root.
    const COMPACTION = { type: "compaction", limit: 1, stopBeforeId: "e0" };
    const reads = loaded.session.boundedReads;
    assert.equal(reads.filter((read) => isDeepStrictEqual(read, SEED)).length, 1, "one read of the branch: the seed's");
    assert.equal(reads.filter((read) => isDeepStrictEqual(read, LEVEL)).length, 1, "and one of its latest level record");
    assert.equal(reads.filter((read) => isDeepStrictEqual(read, COMPACTION)).length, 1, "and one of its latest compaction entry: an answer older than the branch's latest compaction seeds nothing");
    assert.equal(reads.filter((read) => isDeepStrictEqual(read, PIN)).length, 0, "session_start on smart-router/auto does not look for an old pin entry: John's ruling of 2026-11-18, no trace of the pin");
    assert.ok(reads.some((read) => isDeepStrictEqual(read, SCOPE)), "and the scope");
    for (const read of reads) {
      assert.ok([SEED, LEVEL, COMPACTION, SCOPE].some((allowed) => isDeepStrictEqual(read, allowed)), `${JSON.stringify(read)}: every other read is the scope's, over the whole session`);
    }
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("message_end keeps the last responder and the cooldowns, and ignores router refusals", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("message_end", { message: assistant(KIMI, { usage: { ...assistant(KIMI).usage, totalTokens: 42 } }) });
    assert.deepEqual([record(loaded)?.last?.ref, record(loaded)?.last?.usage?.totalTokens], [KIMI, 42]);
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "aborted" }) });
    await loaded.host.emit("message_end", { message: { role: "user", content: "hi", timestamp: NOW } });
    assert.equal(record(loaded)?.last?.ref, KIMI);
    await loaded.host.emit("message_end", { message: assistant("smart-router/auto", { api: "pi-virtual", stopReason: "error", errorMessage: "usage limit" }) });
    await loaded.host.emit("message_end", { message: assistant(GLM, { stopReason: "error", errorMessage: "401 Unauthorized" }) });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal }))), GLM, "the local role is never cooled");
  });

  test("a custom-triggered run start drops the plan; agent_settled drops the plan and the run's pick", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: PLANNING });
    assert.ok(record(loaded)?.plan !== undefined, "a prompt's own run start keeps its plan");
    await loaded.host.emit("before_agent_start", { messageType: "custom" });
    assert.equal(record(loaded)?.plan, undefined);
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    const signal = loaded.session.startRun();
    loaded.runtime.route("auto", request("continuation", { signal }));
    assert.ok(record(loaded)?.runPick !== undefined && record(loaded)?.plan !== undefined);
    await loaded.host.emit("agent_settled", { aborted: false });
    assert.deepEqual([record(loaded)?.plan, record(loaded)?.runPick], [undefined, undefined]);
  });

  test("an idle prompt on a physical selection plans nothing and drops an earlier plan", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    loaded.session.select(KIMI);
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    assert.equal(record(loaded)?.plan, undefined);
  });

  test("thinking levels: a role's fixed level, else the selected level", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: "local" });
    const signal = loaded.session.startRun();
    assert.equal(loaded.runtime.route("local", request("continuation", { signal, thinkingLevel: "low" })).thinkingLevel, "max");
    assert.equal(loaded.runtime.route("auto", request("direct", { thinkingLevel: "minimal" })).thinkingLevel, "minimal");
    assert.equal(HERA.roles[0]?.thinking, "max");
  });
});

describe("the final assertions", () => {
  test("refuse any pick that breaks an invariant, as a bug, with nothing sent", () => {
    const rc = heraContext();
    const deepseek = rc.catalog.find("openrouter", "deepseek/deepseek-v4.1-flash-1017");
    assert.ok(deepseek !== undefined);
    const safe = { role: "worker", ref: DEEPSEEK, model: deepseek, code: "t" };
    assertSafe("auto", rc, safe);
    const glm = { role: "local", ref: GLM, model: model(GLM, { baseUrl: HERA_LAN }), code: "t" };
    assertSafe("local", heraContext({ virtualId: "local" }), glm);
    const cases: Array<[string, ReturnType<typeof heraContext>, Parameters<typeof assertSafe>[2], RegExp]> = [
      ["excluded", rc, { ...safe, role: "engineer", ref: WORK_SOL, model: model(WORK_SOL) }, /openai-codex-3\/gpt-6\.1-sol, which is excluded/],
      ["virtual", rc, { ...safe, model: model(DEEPSEEK, { api: "pi-virtual" }) }, /which is a virtual model/],
      ["another entry", rc, { ...safe, model: model(KIMI) }, /which is not the catalog entry of that name/],
      ["another role", rc, { ...safe, role: "thinker" }, /which is not in the role thinker/],
      ["unreachable by auto", rc, glm, /which is in a role smart-router\/auto never routes to/],
      ["not a local role", heraContext({ localOnly: true }), safe, /which is (?:not in a local role|in a role smart-router\/auto never routes to)/],
      ["outside the policy", heraContext({ virtualId: "local" }), { ...glm, model: model(GLM, { baseUrl: OPENROUTER }) }, /which is outside the local policy/],
    ];
    for (const [name, context, choice, pattern] of cases) refuses(() => assertSafe(context.virtualId, context, choice), pattern, name);
    refuses(() => assertSafe("local", heraContext({ virtualId: "local" }), safe), /which is not in a local role; this is a bug in pi-smart-router/);
  });

  test("the way out offers a work Codex model to a work session", () => {
    const work = heraContext({ scope: "work" });
    const deepseek = work.catalog.find("openrouter", "deepseek/deepseek-v4.1-flash-1017");
    assert.ok(deepseek !== undefined);
    const worker = { role: "worker", ref: DEEPSEEK, model: deepseek, code: "t" };
    refuses(() => assertSafe("auto", work, worker), /this is a bug in pi-smart-router\. Nothing was sent\. Choose a work Codex model with \/model\.$/);
  });

  test("a version 1 roster is unchanged in personal scope, and in work scope passes only a local-only pick", () => {
    const personal = heraContext();
    const work = heraContext({ scope: "work" });
    const deepseek = work.catalog.find("openrouter", "deepseek/deepseek-v4.1-flash-1017");
    assert.ok(deepseek !== undefined);
    const worker = { role: "worker", ref: DEEPSEEK, model: deepseek, code: "t" };
    const engineer = { role: "engineer", ref: SOL, model: model(SOL), code: "t" };
    const alias = { role: "engineer", ref: WORK_SOL, model: model(WORK_SOL), code: "t" };
    assertSafe("auto", personal, worker);
    assertSafe("auto", personal, engineer);
    refuses(() => assertSafe("auto", personal, alias), /openai-codex-3\/gpt-6\.1-sol, which is excluded/);
    refuses(
      () => assertSafe("auto", work, worker),
      /^smart-router\/auto: the router picked openrouter\/deepseek\/deepseek-v4\.1-flash-1017, which is outside this session's work scope, which a version 1 roster does not serve; this is a bug in pi-smart-router\./,
    );
    refuses(() => assertSafe("auto", work, engineer), /openai-codex-2\/gpt-6\.1-sol, which is outside this session's work scope, which a version 1 roster does not serve;/);
    refuses(() => assertSafe("auto", work, alias), /openai-codex-3\/gpt-6\.1-sol, which is excluded/);
    // A local-only request, smart-router/local's, keeps the local policy: a local model, which carries no account.
    const local = heraContext({ scope: "work", virtualId: "local" });
    assertSafe("local", local, { role: "local", ref: GLM, model: model(GLM, { baseUrl: HERA_LAN }), code: "t" });
    refuses(() => assertSafe("local", local, engineer), /openai-codex-2\/gpt-6\.1-sol, which is outside this session's work scope/);
  });
});

describe("a version 1 roster in work scope, past prepare()'s own refusal", () => {
  const VIRTUAL = model("smart-router/auto", { api: "pi-virtual", baseUrl: "" });
  const OUTSIDE = /which is outside this session's work scope, which a version 1 roster does not serve; this is a bug in pi-smart-router\./;
  const input = (rc: ResolveContext, reason: ModelRouteReason, record: SessionRecord = newRecord()): RouteInput => ({
    id: rc.virtualId,
    request: { ...request(reason), model: VIRTUAL },
    rc,
    record,
    figures: undefined,
    compaction: COMPACTION,
    depth: FRESH,
  });

  test("smart-router/auto refuses on every path that can reach a model, and nothing is sent or recorded", () => {
    const rc = heraContext({ scope: "work" });
    const planned = newRecord();
    planned.plan = planUserTurn({ rc, text: PLANNING, last: undefined, now: NOW, compaction: COMPACTION, facts: FRESH });
    assert.ok(planned.plan.decision.ok && planned.plan.decision.choice.ref === ASTRA, "the prompt planned astra");
    const paths: Array<[string, SessionRecord, (record: SessionRecord) => unknown]> = [
      ["the owned run", planned, (record) => routeOwned(input(rc, "user", record))],
      ["an owned continuation", newRecord(), (record) => routeOwned(input(rc, "continuation", record))],
      ["a direct request without a plan", newRecord(), (record) => routeOther(input(rc, "direct", record))],
      ["a foreign request", newRecord(), (record) => routeOther(input(rc, "continuation", record))],
    ];
    for (const [name, record, call] of paths) {
      refuses(() => call(record), OUTSIDE, name);
      assert.deepEqual([record.runPick, record.history], [undefined, []], name);
    }
  });

  test("smart-router/local still routes to the LAN model: a local-only request carries no account", () => {
    const record = newRecord();
    const local = heraContext({ scope: "work", virtualId: "local" });
    assert.equal(routed(routeOther(input(local, "direct", record))), GLM);
    assert.equal(routed(routeOwned(input(local, "user", record))), GLM);
    assert.deepEqual(
      record.history.map((entry) => [entry.ref, entry.code]),
      [
        [GLM, "direct:default"],
        [GLM, "stick:default"],
      ],
    );
  });
});

describe("a version 2 session's scope in the final assertions", () => {
  const HERA_V2 = rosterFixtureV2("roster-hera-v2.json");
  const pick = (role: string, ref: string): Choice => ({ role, ref, model: model(ref), code: "t" });

  test("a work-scope cloud pick must be on a work-bound supported account", () => {
    const work = heraContext({ roster: HERA_V2, scope: "work" });
    assertSafe("auto", work, pick("work-high", WORK_SOL));
    refuses(
      () => assertSafe("auto", work, pick("high", GLM_CLOUD)),
      /^smart-router\/auto: the router picked openrouter\/z-ai\/glm-5\.3, which is not on a work-bound Codex or Claude Code account or an allowed local endpoint, and this session is in work scope; this is a bug in pi-smart-router\./,
    );
    refuses(() => assertSafe("auto", work, pick("high", SOL)), /openai-codex-2\/gpt-6\.1-sol, which is not on a work-bound Codex or Claude Code account or an allowed local endpoint, and this session is in work scope;/);
    // A work-bound account that is not Codex, in a work level, as if validation had been bypassed.
    const claude = "anthropic-2/claude-opus";
    const anthropic = {
      ...HERA_V2,
      roles: HERA_V2.roles.map((role) => (role.name === "work-high" ? { ...role, models: [...role.models, claude] } : role)),
      accounts: new Map([...HERA_V2.accounts, ["anthropic-2", { kind: "multi-pass", label: "work", scope: "work" } as const]]),
    };
    refuses(() => assertSafe("auto", heraContext({ roster: anthropic, scope: "work" }), pick("work-high", claude)), /anthropic-2\/claude-opus, which is not on a work-bound Codex or Claude Code account/);
  });

  test("a personal-scope pick is never on a work-bound account", () => {
    const personal = heraContext({ roster: HERA_V2, scope: "personal" });
    assertSafe("auto", personal, pick("high", SOL));
    assertSafe("auto", personal, pick("high", GLM_CLOUD));
    refuses(() => assertSafe("auto", personal, pick("work-high", WORK_SOL)), /openai-codex-3\/gpt-6\.1-sol, which is excluded/);
    const workOnly = heraContext({ roster: rosterFixtureV2("roster-work.json"), scope: "personal" });
    refuses(() => assertSafe("auto", workOnly, pick("work-high", NATIVE_SOL)), /openai-codex\/gpt-6\.1-sol, which is on a work-bound account, and this session is in personal scope;/);
  });

  test("a local-only request in work scope keeps smart-router/local's rules: the local role, and never an account", () => {
    const local = heraContext({ roster: HERA_V2, scope: "work", virtualId: "local" });
    assertSafe("local", local, { role: "local", ref: GLM, model: model(GLM, { baseUrl: HERA_LAN }), code: "t" });
    refuses(() => assertSafe("local", local, pick("high", SOL)), /openai-codex-2\/gpt-6\.1-sol, which is not on a work-bound Codex or Claude Code account or an allowed local endpoint, and this session is in work scope;/);
    refuses(() => assertSafe("local", local, pick("high", GLM_CLOUD)), /openrouter\/z-ai\/glm-5\.3, which is not in a local role;/);
  });
});

describe("a version 2 roster's default role", () => {
  test("is the personal scope's medium level, and without a personal scope there is none", () => {
    const hera = predict(heraContext({ roster: rosterFixtureV2("roster-hera-v2.json") }), newRecord(), undefined, COMPACTION, FRESH);
    assert.ok(hera.ok, JSON.stringify(hera));
    assert.deepEqual([hera.choice.role, hera.choice.ref, hera.choice.code], ["medium", DEEPSEEK, "stick:default"], "terra is not in Hera's test catalog");
    assert.deepEqual(predict(heraContext({ roster: rosterFixtureV2("roster-work.json") }), newRecord(), undefined, COMPACTION, FRESH), {
      ok: false,
      attempts: [],
      problem: "the roster has no personal scope",
    });
  });

  test("is the session scope's medium level, and without that scope there is none", () => {
    const catalog = new FakeCatalog([...heraModels(), codex("openai-codex-3/gpt-6.1-terra"), codex("openai-codex/gpt-6.1-terra")]);
    const hera = predict(heraContext({ roster: rosterFixtureV2("roster-hera-v2.json"), scope: "work", catalog }), newRecord(), undefined, COMPACTION, FRESH);
    assert.ok(hera.ok, JSON.stringify(hera));
    assert.deepEqual([hera.choice.role, hera.choice.ref, hera.choice.code], ["work-medium", "openai-codex-3/gpt-6.1-terra", "stick:default"]);
    const work = predict(heraContext({ roster: rosterFixtureV2("roster-work.json"), scope: "work", catalog }), newRecord(), undefined, COMPACTION, FRESH);
    assert.ok(work.ok, JSON.stringify(work));
    assert.deepEqual([work.choice.role, work.choice.ref], ["work-medium", "openai-codex/gpt-6.1-terra"]);
    const v2 = rosterFixtureV2("roster-hera-v2.json");
    const { work: _work, ...personalScope } = v2.scopes;
    assert.deepEqual(predict(heraContext({ roster: { ...v2, scopes: personalScope }, scope: "work", catalog }), newRecord(), undefined, COMPACTION, FRESH), {
      ok: false,
      attempts: [],
      problem: "the roster has no work scope",
    });
  });

  test("a continuation holds the last responder only when the session's scope reaches it", () => {
    const hera = rosterFixtureV2("roster-hera-v2.json");
    const record = { ...newRecord(), last: { ref: WORK_SOL, at: NOW } };
    const work = predict(heraContext({ roster: hera, scope: "work" }), record, undefined, COMPACTION, FRESH);
    assert.ok(work.ok, JSON.stringify(work));
    assert.deepEqual([work.choice.role, work.choice.ref, work.choice.code], ["work-high", WORK_SOL, "stick:last"]);
    const personal = predict(heraContext({ roster: hera, scope: "personal" }), record, undefined, COMPACTION, FRESH);
    assert.ok(personal.ok, JSON.stringify(personal));
    assert.deepEqual([personal.choice.role, personal.choice.ref, personal.choice.code], ["medium", DEEPSEEK, "stick:default"]);
  });

  test("a direct request without a plan in personal scope routes to the medium level's first candidate", async (t) => {
    const runtime = new FakeRuntime(new FakeCatalog([...heraModels(), codex("openai-codex-2/gpt-6.1-terra")]));
    const loaded = await start({ dir: agentDir(t, { roster: fixture("roster-hera-v2.json") }), runtime });
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), "openai-codex-2/gpt-6.1-terra");
    assert.equal(lastHistory(loaded)?.code, "direct:default");
  });
});

describe("a version 2 run's plan", () => {
  const FRANCE = "What is the capital of France?";
  const TERRA = "openai-codex-2/gpt-6.1-terra";
  const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
  const HERA_V2 = rosterFixtureV2("roster-hera-v2.json");
  const VIRTUAL = model("smart-router/auto", { api: "pi-virtual", baseUrl: "" });
  /** A plain question's level without Jev: the heuristics alone rate it MEDIUM, 0.89, in a new session. */
  const HEURISTICS_MEDIUM = {
    need: "medium",
    tier: "medium",
    source: "heuristics",
    steppedUp: false,
    returnedToFirst: false,
    demand: demandOf({ text: FRANCE, planning: false, risky: false, jev: undefined, facts: FRESH }, HERA_V2.demand),
  } as const;
  const v2Catalog = (): FakeCatalog => new FakeCatalog([...heraModels(), codex(TERRA), codex(WORK_TERRA)]);
  const owned = (rc: ResolveContext, record: SessionRecord): RouteInput => ({
    id: rc.virtualId,
    request: { ...request("user"), model: VIRTUAL },
    rc,
    record,
    figures: undefined,
    compaction: COMPACTION,
    depth: FRESH,
  });

  test("puts its level in the run's history entry", async (t) => {
    const loaded = await start({ dir: agentDir(t, { roster: fixture("roster-hera-v2.json") }), runtime: new FakeRuntime(v2Catalog()), now: () => NOW });
    const signal = await prompt(loaded, FRANCE);
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), TERRA);
    assert.deepEqual(lastHistory(loaded), {
      at: NOW,
      virtual: "auto",
      reason: "user",
      signal: "default",
      trigger: "triage:no_fast_path",
      role: "medium",
      ref: TERRA,
      code: "heuristics",
      foreign: false,
      // This runtime's registry has no Jev, so the heuristics decided alone, and the level says why.
      // The router priced the untagged run with the session's figures, and with no usage yet a
      // missing figure is said: cost unknown.
      level: {
        scope: "personal",
        ...HEURISTICS_MEDIUM,
        jev: { kind: "failure", model: "openrouter/typesafe/jev-1.14", failure: "unavailable", ms: 0 },
        cost: { outcome: "unknown", why: "no usage yet" },
      },
    }, "the run's level, with its cost unknown: a missing figure is said (no usage yet)");
  });

  test("is used only in the scope it was made in", () => {
    const personal = heraContext({ roster: HERA_V2, catalog: v2Catalog() });
    const work = heraContext({ roster: HERA_V2, catalog: v2Catalog(), scope: "work" });
    const record = newRecord();
    record.plan = planUserTurn({ rc: personal, text: FRANCE, last: undefined, now: NOW, compaction: COMPACTION, facts: FRESH });
    assert.ok(record.plan.decision.ok && record.plan.decision.choice.ref === TERRA, "the prompt planned terra in personal scope");
    // By the run's first request the session is in work scope: the plan is dropped, and the run sticks there.
    assert.equal(routed(routeOwned(owned(work, record))), WORK_TERRA);
    assert.deepEqual(record.history.at(-1), {
      at: NOW,
      virtual: "auto",
      reason: "user",
      signal: undefined,
      trigger: undefined,
      role: "work-medium",
      ref: WORK_TERRA,
      code: "stick:default",
      foreign: false,
    });
    record.plan = planUserTurn({ rc: work, text: FRANCE, last: undefined, now: NOW, compaction: COMPACTION, facts: FRESH });
    assert.equal(routed(routeOwned(owned(work, record))), WORK_TERRA);
    assert.deepEqual([record.history.at(-1)?.code, record.history.at(-1)?.level], ["heuristics", { scope: "work", ...HEURISTICS_MEDIUM }], "without Jev the heuristics decide alone");
  });

  test("is never used under a version 1 roster, nor a version 1 plan under a version 2 roster", () => {
    const v2 = heraContext({ roster: HERA_V2, catalog: v2Catalog() });
    const v1 = heraContext({ catalog: v2Catalog() });
    const record = newRecord();
    record.plan = planUserTurn({ rc: v2, text: FRANCE, last: undefined, now: NOW, compaction: COMPACTION, facts: FRESH });
    assert.ok(record.plan.level !== undefined, "a version 2 plan carries its level");
    // The roster became version 1 before the run's first request: the plan is dropped, and the run sticks.
    assert.equal(routed(routeOwned(owned(v1, record))), DEEPSEEK);
    assert.deepEqual([record.history.at(-1)?.role, record.history.at(-1)?.code], ["worker", "stick:default"]);
    // And the other way: a version 1 plan, which has no level, is dropped under a version 2 roster.
    const other = newRecord();
    other.plan = planUserTurn({ rc: v1, text: FRANCE, last: undefined, now: NOW, compaction: COMPACTION, facts: FRESH });
    assert.equal(other.plan.level, undefined);
    assert.equal(routed(routeOwned(owned(v2, other))), TERRA);
    assert.deepEqual([other.history.at(-1)?.role, other.history.at(-1)?.code], ["medium", "stick:default"]);
  });

  test("a local-only plan, which has no level, is used as before", () => {
    const local = heraContext({ roster: HERA_V2, virtualId: "local" });
    const record = newRecord();
    record.plan = planUserTurn({ rc: local, text: FRANCE, last: undefined, now: NOW, compaction: COMPACTION, facts: FRESH });
    assert.equal(record.plan.level, undefined);
    assert.equal(routed(routeOwned(owned(local, record))), GLM);
    assert.deepEqual([record.history.at(-1)?.code, "level" in (record.history.at(-1) ?? {})], ["local", false]);
  });
});

describe("a stuck run's move up, by the rules alone", () => {
  const V2 = rosterFixtureV2("roster-hera-v2.json");
  const TERRA = "openai-codex-2/gpt-6.1-terra";
  const VIRTUAL = model("smart-router/auto", { api: "pi-virtual", baseUrl: "" });
  const catalog = (): FakeCatalog => new FakeCatalog([...heraModels(), codex(TERRA)]);
  /** A run whose bash calls failed three times in a row with one text. */
  const stuckMessages: Message[] = [
    { role: "user", content: [{ type: "text", text: "fix the build" }], timestamp: NOW },
    ...[0, 1, 2].flatMap((i): Message[] => [
      assistant(TERRA, { content: [{ type: "toolCall", id: `call-${i}`, name: "bash", arguments: {} }], stopReason: "toolUse" }),
      { role: "toolResult", toolCallId: `call-${i}`, toolName: "bash", content: [{ type: "text", text: "No such file" }], isError: true, timestamp: NOW },
    ]),
  ];
  /** A record whose run is under way on `ref`, at MEDIUM by its record, whatever made it so. */
  const underWay = (rc: ResolveContext, ref: string, role: string): SessionRecord => {
    const record = newRecord();
    record.runPick = { id: rc.virtualId, ref, role };
    record.runTier = "medium";
    return record;
  };
  const continuation = (rc: ResolveContext, record: SessionRecord, on: string): RouteInput => ({
    id: rc.virtualId,
    request: { ...request("continuation", { messages: stuckMessages, previous: { model: model(on), thinkingLevel: "high" } }), model: VIRTUAL },
    rc,
    record,
    figures: undefined,
    compaction: COMPACTION,
    depth: FRESH,
  });

  test("smart-router/auto under a version 2 roster moves a stuck MEDIUM run to HIGH: the control", () => {
    const rc = heraContext({ roster: V2, catalog: catalog() });
    const record = underWay(rc, TERRA, "medium");
    assert.equal(routed(routeOwned(continuation(rc, record, TERRA))), SOL, "HIGH's own model");
    assert.deepEqual([record.history.at(-1)?.code, record.runTier, record.escalated], ["escalate", "high", true], "the move up, once");
  });

  test("smart-router/local and a version 1 roster never move a run up, whatever the record says", () => {
    const cases: ReadonlyArray<readonly [string, ResolveContext, string, string]> = [
      ["smart-router/local", heraContext({ roster: V2, catalog: catalog(), virtualId: "local" }), GLM, "local"],
      ["a version 1 roster", heraContext({ catalog: catalog() }), DEEPSEEK, "worker"],
    ];
    for (const [name, rc, on, role] of cases) {
      const record = underWay(rc, on, role);
      const route = routeOwned(continuation(rc, record, on));
      assert.equal(routed(route), on, `${name}: the run stays on its model`);
      assert.deepEqual([record.history.at(-1)?.code, record.runTier, record.escalated], ["stick:previous", "medium", false], `${name}: no move up`);
    }
  });

  test("a tagged run, a run at SUPER and a run that moved up already stay where they are", () => {
    const rc = heraContext({ roster: V2, catalog: catalog() });
    const cases: ReadonlyArray<readonly [string, (record: SessionRecord) => void]> = [
      ["a tagged run", (record) => (record.runTagged = true)],
      ["a run at SUPER", (record) => (record.runTier = "super")],
      ["a run that moved up already", (record) => (record.escalated = true)],
    ];
    for (const [name, edit] of cases) {
      const record = underWay(rc, TERRA, "medium");
      edit(record);
      assert.equal(routed(routeOwned(continuation(rc, record, TERRA))), TERRA, name);
      assert.equal(record.history.at(-1)?.code, "stick:previous", name);
    }
  });

  test("a run already on the level above's own model is not moved: only a model other than the run's is a move", () => {
    // A MEDIUM run the cost rule put on SOL, HIGH's own model: the level above picks SOL again.
    const rc = heraContext({ roster: V2, catalog: catalog() });
    const record = underWay(rc, SOL, "high");
    assert.equal(routed(routeOwned(continuation(rc, record, SOL))), SOL, "the run stays on its model");
    assert.deepEqual(
      [record.history.at(-1)?.code, record.runTier, record.escalated],
      ["stick:previous", "medium", false],
      "no move up: the run keeps its level, and its one move up is still to come",
    );
  });
});

describe("a run without a prompt, by the rules alone", () => {
  const V2 = rosterFixtureV2("roster-hera-v2.json");
  const TERRA = "openai-codex-2/gpt-6.1-terra";
  const VIRTUAL = model("smart-router/auto", { api: "pi-virtual", baseUrl: "" });

  test("a retry that starts a run is a retry: it takes no level and notes no prompt", () => {
    // The router refused the run's first request, so no pick was kept; Pi retries it.
    const rc = heraContext({ roster: V2, catalog: new FakeCatalog([...heraModels(), codex(TERRA)]) });
    const record = newRecord();
    record.need = "medium";
    const input: RouteInput = {
      id: rc.virtualId,
      request: { ...request("retry", { messages: [{ role: "user", content: [{ type: "text", text: "go on" }], timestamp: NOW }], previous: { model: model(TERRA), thinkingLevel: "high" } }), model: VIRTUAL },
      rc,
      record,
      figures: undefined,
      compaction: COMPACTION,
      depth: FRESH,
    };
    routeOwned(input);
    assert.deepEqual(
      [record.ledger.needs.length, record.runTier, record.needRun],
      [0, undefined, undefined],
      "a retry is not a run without a prompt: it notes no prompt, takes no level and records no run at the session's need",
    );
  });
});

describe("activeEntries", () => {
  test("is the branch's entry count from Pi's history metrics, where this Pi has them", () => {
    assert.equal(activeEntries({ getHistoryMetrics: () => ({ session_active_entries: 1_200 }) }), 1_200);
    assert.equal(activeEntries({ getHistoryMetrics: () => ({ session_active_entries: 0 }) }), 0, "an empty branch counts none");
  });

  test("is undefined where Pi has no metrics, its reader throws, or the count is not a finite count", () => {
    const throwing = () => {
      throw new Error("the index is locked");
    };
    for (const [name, manager] of [
      ["no session manager", undefined],
      ["Pi 1.5.0's session manager, without metrics", { getRecentActiveEntries: () => [] }],
      ["a reader that throws", { getHistoryMetrics: throwing }],
      ["a getter that throws", Object.defineProperty({}, "getHistoryMetrics", { get: throwing })],
      ["metrics that are not an object", { getHistoryMetrics: () => 1_200 }],
      ["metrics without the count", { getHistoryMetrics: () => ({}) }],
      ["a negative count", { getHistoryMetrics: () => ({ session_active_entries: -1 }) }],
      ["an infinite count", { getHistoryMetrics: () => ({ session_active_entries: Number.POSITIVE_INFINITY }) }],
      ["a count that is not a number", { getHistoryMetrics: () => ({ session_active_entries: "1200" }) }],
      ["a count that is NaN", { getHistoryMetrics: () => ({ session_active_entries: Number.NaN }) }],
    ] as const) {
      assert.equal(activeEntries(manager), undefined, name);
    }
  });
});
