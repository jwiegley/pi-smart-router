import assert from "node:assert/strict";
import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";

import { policyFromRoster } from "../src/local.ts";
import { assertSafe } from "../src/route.ts";
import {
  ASTRA,
  DEEPSEEK,
  FakeCatalog,
  GLM,
  GLM_CLOUD,
  HERA_LAN,
  heraContext,
  heraModels,
  KIMI,
  model,
  NOW,
  OPENROUTER,
  rosterFixture,
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

  test("under the pin, direct goes local, and auto never leaves the policy", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: "local", setup: (session) => session.pin(policyFromRoster(HERA)) });
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    assert.equal(routed(loaded.runtime.route("local", request("direct", { previous: previous(loaded.runtime, KIMI) }))), GLM);
    assert.equal(lastHistory(loaded)?.code, "direct:default");
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal, previous: previous(loaded.runtime, SOL) }))), GLM);
    refuses(() => loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, KIMI) })), /^smart-router\/auto: no local model can take this request while this session is pinned/);
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
    assert.match(missing.session.notices[0]?.message ?? "", /does not exist\. smart-router\/auto and smart-router\/local refuse every request/);
    resetSlot();
    const invalid = await start({ dir: agentDir(t, { roster: "{ nope" }) });
    refuses(() => invalid.runtime.route("auto", request("direct")), /is invalid \(JSON syntax error/);
    resetSlot();
    const dir = agentDir(t);
    const edited = await start({ dir });
    assert.equal(routed(edited.runtime.route("auto", request("direct"))), DEEPSEEK);
    writeFileSync(join(dir, "smart-router.json"), JSON.stringify({ version: 2 }));
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

  test("Hera's work alias is refused even when a roster names it", async (t) => {
    const roster = JSON.parse(fixture("roster-hera.json"));
    roster.roles.find((role: { name: string }) => role.name === "engineer").models = ["openai-codex-3/gpt-6.1-sol"];
    const loaded = await start({ dir: agentDir(t, { roster: JSON.stringify(roster) }) });
    refuses(() => loaded.runtime.route("auto", request("direct")), /is invalid \(roles\[4\]\.models\[0\]: "openai-codex-3\/gpt-6\.1-sol" is excluded by openai-codex-3\/\*\)/);
  });
});

describe("session state", () => {
  test("session_start registers both models again with limits from the roster", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const limits = loaded.host.definitions.map((definition) => [definition.id, definition.contextWindow, definition.maxTokens]);
    assert.deepEqual(limits, [
      ["auto", 128_000, 16_384],
      ["local", 128_000, 16_384],
      ["auto", 128_000, 32_000],
      ["local", 262_144, 81_920],
    ]);
    assert.equal(loaded.runtime.find("smart-router", "local")?.contextWindow, 262_144);
    assert.deepEqual(loaded.router?.limits(), { auto: { contextWindow: 128_000, maxTokens: 32_000 }, local: { contextWindow: 262_144, maxTokens: 81_920 } });
  });

  test("the limits skip roles with no available model and fall back to the defaults", async (t) => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(DEEPSEEK);
    catalog.remove(GLM);
    const loaded = await start({ dir: agentDir(t), runtime: new FakeRuntime(catalog) });
    assert.deepEqual(loaded.router?.limits(), { auto: { contextWindow: 200_000, maxTokens: 32_000 }, local: { contextWindow: 128_000, maxTokens: 16_384 } });
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
    const [seedRead, ...pinReads] = loaded.session.boundedReads;
    assert.deepEqual(seedRead, { type: "message", messageRole: "assistant", limit: 16 });
    assert.ok(pinReads.length > 0, "session_start reads the pin");
    for (const read of pinReads) assert.deepEqual(read, { customType: "smart-router.pin", scope: "all" }, "every other read is the pin's, over the whole session");
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

  test("the idle window runs from when the last response arrived, and the fit guard reads Pi's reserve", async (t) => {
    let clock = NOW;
    const loaded = await start({ dir: agentDir(t), now: () => clock });
    // DeepSeek's window is 128,000 tokens; the conversation holds 120,000.
    await loaded.host.emit("message_end", { message: assistant(ASTRA, { timestamp: NOW - 3_600_000, usage: { ...assistant(ASTRA).usage, totalTokens: 120_000 } }) });
    await loaded.host.emit("input", { text: TRIVIAL, source: "interactive" });
    assert.equal(record(loaded)?.plan?.code, "hold:sticky", "inside the idle window, although the request started an hour ago");
    clock = NOW + 6 * 60_000;
    await loaded.host.emit("input", { text: TRIVIAL, source: "interactive" });
    assert.equal(record(loaded)?.plan?.code, "hold:fit", "Pi's default reserve of 16,384 leaves 111,616");
    loaded.host.settings = { compaction: { reserveTokens: 64_000, modelOverrides: { "smart-router/auto": { reserveTokens: 4_096 } } } };
    await loaded.host.emit("input", { text: TRIVIAL, source: "interactive" });
    assert.equal(record(loaded)?.plan?.code, "reopen:idle", "the override for smart-router/auto leaves 123,904");
    loaded.host.settings = { compaction: { reserveTokens: 64_000 } };
    await loaded.host.emit("input", { text: TRIVIAL, source: "interactive" });
    assert.equal(record(loaded)?.plan?.code, "hold:fit");
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
      ["not the local role", heraContext({ localOnly: true }), safe, /which is (?:not in the local role|in a role smart-router\/auto never routes to)/],
      ["outside the policy", heraContext({ virtualId: "local" }), { ...glm, model: model(GLM, { baseUrl: OPENROUTER }) }, /which is outside the local policy/],
    ];
    for (const [name, context, choice, pattern] of cases) refuses(() => assertSafe(context.virtualId, context, choice), pattern, name);
    refuses(() => assertSafe("local", heraContext({ virtualId: "local" }), safe), /which is not in the local role; this is a bug in pi-smart-router/);
  });
});
