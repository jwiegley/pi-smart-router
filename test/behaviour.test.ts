// The behaviour suite: the router inside Pi 1.5's own runtime from npm. Test-only; never shipped.
// It runs only sandboxed: in the offline Nix build, or under sandbox-exec through
// `npm run check:sandbox`; ./support/sandboxed.ts, imported first, refuses anything else before
// Pi's runtime is evaluated.
//
// The numbered tests are the scenarios of design §8.2. The others check John's pin decisions (Q6:
// /new and forks inherit the pin, resume says so, the environment switch latches), the pin's
// coverage of a goal-x-style auditor (§5.1), and the refusal on an upstream Pi without the fork's
// bounded session reads. Each asserts which faux provider received each request, with the
// provider's call count; ./support/host.ts describes the harness.
//
// The L tests are the four levels' scenarios, the behaviour-suite list of the Jev-levels design, on
// version 2 rosters shaped like Hera's: both Codex accounts, OpenRouter and a local model, with
// Jev faked by a classifier provider registered through Pi's provider `classifiers` hook. L9
// checks that a version 1 roster's texts did not change.
import "./support/sandboxed.ts";

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import type { RoutingRegistry } from "../src/cache-optimizer.ts";
import { ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY, ROUTING_REGISTRY_KEY, SCOPE_ENTRY, SLOT_KEY, VIRTUAL_IDS } from "../src/constants.ts";
import type { Owner, Slot } from "../src/owners.ts";
import type { Limits, Router } from "../src/router.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { keepsSystemPrompt } from "./support/co.ts";
import type { Snapshot } from "./support/co.ts";
import {
  auditorSession,
  BASE_SETTINGS,
  called,
  COMPETITOR_ENTRY,
  failure,
  gate,
  history,
  nestedSession,
  PROMPTS,
  response,
  ROSTER,
  until,
  withoutBoundedReaders,
  World,
} from "./support/host.ts";
import type { FauxCall, FauxSpec, JevCall, Pi, RosterJsonV2, WorldOptions } from "./support/host.ts";

const TIMEOUT = { timeout: 60_000 };

/** The entry id of the n-th user message (0-based) of a session. */
function userEntry(pi: Pi, index: number): string {
  const entries = pi.session.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user");
  const entry = entries[index];
  assert.ok(entry !== undefined, `user message ${index}`);
  return entry.id;
}

/** The text of the latest notice that matches. */
function notice(pi: Pi, pattern: RegExp): string {
  const found = pi.ui.saw(pattern).at(-1);
  assert.ok(found !== undefined, `a notice matching ${pattern}`);
  return found;
}

/** The trace from `from` on, as calls and probe records. */
function traceFrom(world: World, from = 0): World["trace"] {
  return world.trace.slice(from);
}

/** The first session request (not a summary) in a trace, and its index. */
function firstTurn(trace: World["trace"]): { readonly index: number; readonly call: FauxCall } {
  const index = trace.findIndex((entry) => entry.kind === "call" && !entry.call.summary);
  const entry = trace[index];
  assert.ok(entry?.kind === "call", "a session request reached a provider");
  return { index, call: entry.call };
}

/** What the probe resolved at the before_provider_headers right before the call at `index`. */
function headersBefore(trace: World["trace"], index: number): Snapshot | undefined {
  for (let at = index - 1; at >= 0; at -= 1) {
    const entry = trace[at];
    if (entry?.kind === "headers") return entry.route;
    if (entry?.kind === "call") break;
  }
  assert.fail("no before_provider_headers record precedes the call");
}

const ref = (route: Snapshot | undefined): string | undefined => (route === undefined ? undefined : `${route.provider}/${route.modelId}`);

test("1. both virtual models are listed and selectable, with limits recomputed from the roster", TIMEOUT, async (t) => {
  const world = new World(t, {
    fleet: [
      { provider: "local-a", baseUrl: "http://localhost:0", contextWindow: 262_144, maxTokens: 81_920 },
      { provider: "cloud-a", contextWindow: 272_000, maxTokens: 128_000 },
      { provider: "cloud-b", contextWindow: 128_000, maxTokens: 32_000 },
      { provider: "cloud-c", contextWindow: 200_000, maxTokens: 24_000 },
      { provider: "codex-like", api: "openai-codex-responses", contextWindow: 272_000, maxTokens: 128_000 },
    ],
  });
  const pi = await world.start({ select: "cloud-b/m" });
  const available = pi.session.modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`);
  assert.ok(available.includes("smart-router/auto") && available.includes("smart-router/local"), available.join(", "));
  const auto = pi.model("smart-router/auto");
  const local = pi.model("smart-router/local");
  assert.equal(auto.api, "pi-virtual");
  assert.equal(auto.name, "Smart Router (auto)");
  assert.equal(local.name, "Smart Router (local models)");
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    assert.equal(auto.thinkingLevelMap?.[level], level, `auto offers ${level}`);
  }
  // auto: the smallest window and output budget among the first candidates of the roles it reaches.
  assert.deepEqual([auto.contextWindow, auto.maxTokens], [128_000, 24_000]);
  assert.deepEqual([local.contextWindow, local.maxTokens], [262_144, 81_920]);
  await pi.session.setModel(auto);
  assert.equal(pi.selection(), "smart-router/auto");
  await pi.session.setModel(local);
  assert.equal(pi.selection(), "smart-router/local");
  assert.equal(pi.session.model?.contextWindow, 262_144, "the selection carries the recomputed limits");
});

test("2. a planning prompt goes to the planned role, and the response names the physical model", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.prompt(PROMPTS.planning);
  assert.deepEqual(called(world.counts()), { "codex-like": 1 });
  const answer = pi.lastAssistant();
  assert.equal(answer?.stopReason, "stop", answer?.errorMessage);
  assert.equal(`${answer?.provider}/${answer?.model}`, "codex-like/m");
  assert.equal(pi.selection(), "smart-router/auto", "the selection stays virtual");
});

test("3. a tool loop stays on one model and writes no router state", TIMEOUT, async (t) => {
  const world = new World(t);
  writeFileSync(join(world.cwd, "notes.txt"), "the lock order is a, then b\n");
  const engineer = world.faux("cloud-a");
  engineer.respond(fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "read-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("a, then b"));
  const pi = await world.start({ select: "smart-router/auto", tools: ["read"] });
  await pi.prompt(PROMPTS.complex);
  assert.deepEqual(called(world.counts()), { "cloud-a": 2 });
  assert.equal(pi.lastAssistant()?.provider, "cloud-a");
  const state = pi.session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi.virtual-model-state");
  assert.deepEqual(state, [], "route() returns no state, so Pi stores none");
  await pi.command("history");
  const [decisions] = pi.ui.saw(/routing decisions/);
  assert.match(decisions ?? "", /user: engineer → cloud-a\/m \(signal:complex/);
  assert.match(decisions ?? "", /continuation: engineer → cloud-a\/m \(stick:previous\)/);
});

test("4. resume keeps smart-router/auto; without the router Pi restores the last responder; the refusing models refuse", TIMEOUT, async (t) => {
  const world = new World(t);
  const first = await world.start({ persisted: true, select: "smart-router/auto" });
  await first.prompt(PROMPTS.plain);
  assert.equal(first.lastAssistant()?.provider, "cloud-b");
  const file = first.session.sessionFile;
  assert.ok(file !== undefined);
  await first.close();

  const resumed = await world.start({ sessionManager: world.open(file) });
  assert.equal(resumed.selection(), "smart-router/auto");
  await resumed.close();

  // Design §13 risk 7: without the extension, Pi restores the physical model that answered last.
  const bare = await world.start({ sessionManager: world.open(file), router: false });
  assert.equal(bare.selection(), "cloud-b/m");
  await bare.close();

  // A router that cannot be built (here, a process slot of another shape) leaves only the two
  // refusing models: the selection still resumes, and a prompt sends nothing.
  const store = globalThis as Record<symbol, unknown>;
  delete store[Symbol.for(SLOT_KEY)];
  store[Symbol.for(SLOT_KEY)] = { version: 0 };
  const stubs = await world.start({ sessionManager: world.open(file) });
  assert.equal(stubs.selection(), "smart-router/auto");
  assert.equal(stubs.ui.saw(/^pi-smart-router failed to load: .*unknown shape/).length, 1);
  const before = world.counts();
  await stubs.prompt(PROMPTS.plain);
  const answer = stubs.lastAssistant();
  assert.equal(answer?.stopReason, "error");
  assert.match(answer?.errorMessage ?? "", /^smart-router\/auto: pi-smart-router failed to load \(.*\)\. Nothing was sent\./);
  assert.deepEqual(world.counts(), before);
  assert.equal(stubs.eventsOf("auto_retry_start").length, 0);
});

test("5. smart-router/local without its local provider refuses: nothing is sent and nothing is retried", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local", providers: ["cloud-a", "cloud-b", "cloud-c", "codex-like"] });
  await pi.prompt(PROMPTS.plain);
  const answer = pi.lastAssistant();
  assert.equal(answer?.stopReason, "error");
  assert.equal(answer?.provider, "smart-router");
  assert.match(answer?.errorMessage ?? "", /^smart-router\/local: no local model can take this request \(local: local-a\/m: not in the catalog\)\. Nothing was sent\./);
  assert.deepEqual(called(world.counts()), {});
  assert.equal(pi.eventsOf("auto_retry_start").length, 0, "Pi does not retry a refusal");
});

test("6. pinned: a set to a cloud model is reverted, and a prompt under a cloud selection is refused", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
  await pi.command("local on");
  assert.equal(pi.ui.status(), "local models");
  await pi.session.setModel(pi.model("cloud-a/m"));
  assert.equal(pi.selection(), "smart-router/local", "the guard reverted the set");
  assert.equal(pi.ui.saw(/so cloud-a\/m was not kept, and the selection is smart-router\/local again/).length, 1);
  pi.force("cloud-a/m");
  const messages = pi.session.messages.length;
  await pi.prompt(PROMPTS.plain);
  assert.equal(pi.session.messages.length, messages, "the prompt was not sent");
  assert.equal(pi.ui.saw(/cloud-a\/m is not local, so the prompt was not sent/).length, 1);
  assert.deepEqual(called(world.counts()), {});
});

test("7. pinned with a forced cloud selection, a custom-triggered run is switched to local at turn_start", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
  await pi.command("local on");
  pi.force("cloud-a/m");
  await pi.custom();
  assert.deepEqual(called(world.counts()), { "local-a": 1 });
  assert.equal(pi.lastAssistant()?.provider, "local-a");
  assert.equal(pi.selection(), "smart-router/local");
});

for (const order of ["before", "after"] as const) {
  for (const trigger of ["a typed prompt", "a custom-triggered run"] as const) {
    test(`8. pinned against a competitor loaded ${order} the router, ${trigger}: codex-like receives nothing`, TIMEOUT, async (t) => {
      const world = new World(t);
      const pi = await world.start({ select: "smart-router/local", [order]: [COMPETITOR_ENTRY] });
      await pi.command("local on");
      if (trigger === "a typed prompt") {
        await pi.prompt(PROMPTS.plain);
      } else {
        pi.force("cloud-a/m");
        await pi.custom();
      }
      const fought = pi.session.sessionManager.getEntries().some((entry) => entry.type === "model_change" && entry.provider === "codex-like");
      assert.ok(fought, "the competitor did switch the selection to codex-like");
      const codex = world.faux("codex-like");
      assert.equal(codex.callCount, 0, JSON.stringify(world.counts()));
      assert.ok(
        codex.calls.every((call) => call.payload === null),
        "any payload codex-like would have sent is null",
      );
      assert.equal(world.faux("cloud-a").callCount, 0);
      const local = pi.lastAssistant()?.provider === "local-a";
      assert.ok(local || pi.ui.status() === "local models: locked", `ends on local-a or locked; status ${pi.ui.status()}, counts ${JSON.stringify(world.counts())}`);
    });
  }
}

test("9. pinned with a forced cloud selection over the threshold: every compaction is cancelled, and the cloud model gets nothing", TIMEOUT, async (t) => {
  const world = new World(t, {
    fleet: [{ provider: "local-a", baseUrl: "http://localhost:0" }, { provider: "cloud-a", contextWindow: 40_000 }, { provider: "cloud-b" }, { provider: "cloud-c" }, { provider: "codex-like", api: "openai-codex-responses" }],
  });
  const cloud = world.faux("cloud-a");
  const now = Date.now();
  const sessionManager = history(world, "cloud-a/m", [
    ["first", response(cloud, { tokens: 2_000, timestamp: now - 3_000 })],
    ["second", response(cloud, { tokens: 4_000, timestamp: now - 2_000 })],
    ["third", response(cloud, { tokens: 39_500, timestamp: now - 1_000 })],
  ]);
  const pi = await world.start({ sessionManager, select: "smart-router/local" });
  await pi.command("local on");
  assert.equal(pi.ui.saw(/Earlier turns of this branch went to cloud-a\/m/).length, 1);
  pi.force("cloud-a/m");
  await pi.custom();
  const starts = pi.eventsOf("compaction_start");
  const ends = pi.eventsOf("compaction_end");
  assert.ok(starts.some((event) => event.reason === "threshold"), "the pre-run threshold check started a compaction");
  assert.equal(ends.length, starts.length);
  assert.ok(
    ends.every((event) => event.aborted && event.result === undefined),
    "and the router cancelled each one",
  );
  assert.ok(pi.ui.saw(/cloud-a\/m is not local, so compaction was cancelled/).length >= 1);
  assert.equal(pi.selection(), "smart-router/local");
  pi.force("cloud-a/m");
  await assert.rejects(pi.session.compact(), /Compaction cancelled/, "manual compaction is cancelled too");
  assert.equal(cloud.callCount, 0, JSON.stringify(world.counts()));
  assert.equal(world.faux("local-a").callCount, 1);
  assert.equal(pi.lastAssistant()?.provider, "local-a");
});

test("10. pinned on smart-router/local, compaction summarizes on the local model", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
  await pi.command("local on");
  await pi.prompt("first");
  await pi.prompt("second");
  const local = world.faux("local-a");
  assert.equal(local.callCount, 2);
  const result = await pi.session.compact();
  assert.match(result.summary, /ok from local-a\/m/);
  // A cut inside the last turn asks for two summaries: the history and the turn's prefix.
  const summaries = local.calls.slice(2);
  assert.ok(summaries.length >= 1 && summaries.every((call) => call.summary), "every later request is a summary");
  assert.deepEqual(Object.keys(called(world.counts())), ["local-a"]);
});

test("11. pinned with a forced cloud selection, navigation with a summary is cancelled and navigation without one proceeds", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
  await pi.command("local on");
  await pi.prompt("first");
  await pi.prompt("second");
  const target = userEntry(pi, 0);
  const leaf = pi.session.sessionManager.getLeafId();
  pi.force("cloud-a/m");
  assert.deepEqual(await pi.session.navigateTree(target, { summarize: true }), { cancelled: true });
  assert.equal(pi.session.sessionManager.getLeafId(), leaf, "the cancelled navigation moved nothing");
  assert.equal(pi.ui.saw(/the navigation with a summary was cancelled/).length, 1);
  const plain = await pi.session.navigateTree(target, { summarize: false });
  assert.equal(plain.cancelled, false);
  assert.notEqual(pi.session.sessionManager.getLeafId(), leaf, "the navigation without a summary moved the leaf");
  assert.deepEqual(called(world.counts()), { "local-a": 2 });
});

test("12. pre-run compaction routes direct and leaves the plan: the optimizer sees the plan, and the first request takes it", TIMEOUT, async (t) => {
  const world = new World(t, {
    fleet: [
      { provider: "local-a", baseUrl: "http://localhost:0" },
      { provider: "cloud-a" },
      { provider: "cloud-b", contextWindow: 40_000 },
      { provider: "cloud-c" },
      { provider: "codex-like", api: "openai-codex-responses", ignoresAbort: true },
    ],
  });
  const worker = world.faux("cloud-b");
  const now = Date.now();
  const sessionManager = history(world, "smart-router/auto", [
    ["first", response(worker, { tokens: 2_000, timestamp: now - 3_000 })],
    ["second", response(worker, { tokens: 3_000, timestamp: now - 2_000 })],
    ["third", response(worker, { tokens: 39_500, stopReason: "aborted", timestamp: now - 1_000 })],
  ]);
  const pi = await world.start({ sessionManager });
  assert.equal(pi.selection(), "smart-router/auto");
  const mark = world.trace.length;
  await pi.prompt(PROMPTS.planning);
  const trace = traceFrom(world, mark);
  const summary = trace.findIndex((entry) => entry.kind === "call" && entry.call.summary);
  assert.ok(summary >= 0, "the aborted response over the threshold made Pi compact before the run");
  assert.equal(trace[summary]?.kind === "call" && trace[summary].call.provider, "cloud-b", "the compaction routed direct to the latest successful responder");
  const start = trace.findIndex((entry) => entry.kind === "before_agent_start");
  const seen = trace[start];
  assert.ok(seen?.kind === "before_agent_start" && start > summary, "before_agent_start follows the compaction");
  assert.equal(ref(seen.route), "codex-like/m", "the optimizer sees the plan, not the compaction's target");
  assert.equal(seen.route?.status, "planned");
  assert.ok(keepsSystemPrompt(seen.route?.api), "so it leaves the Codex run's system prompt alone");
  const first = firstTurn(trace);
  assert.ok(first.index > start);
  assert.equal(first.call.provider, "codex-like", "the first request takes the plan");
  assert.equal(world.faux("codex-like").callCount, 1);
});

test("13. in-request compaction leaves the run's pick: the optimizer sees it at the run's own request", TIMEOUT, async (t) => {
  const world = new World(t, {
    fleet: [
      { provider: "local-a", baseUrl: "http://localhost:0" },
      { provider: "cloud-a", contextWindow: 50_000 },
      { provider: "cloud-b", contextWindow: 200_000 },
      { provider: "cloud-c" },
      { provider: "codex-like", api: "openai-codex-responses", ignoresAbort: true },
    ],
  });
  const worker = world.faux("cloud-b");
  const now = Date.now();
  const sessionManager = history(world, "smart-router/auto", [
    ["first", response(worker, { tokens: 2_000, timestamp: now - 2_000 })],
    ["second", response(worker, { tokens: 60_000, timestamp: now - 1_000 })],
  ]);
  const pi = await world.start({ sessionManager });
  const mark = world.trace.length;
  await pi.prompt(PROMPTS.complex);
  const trace = traceFrom(world, mark);
  const summaries = trace.flatMap((entry, index) => (entry.kind === "call" && entry.call.summary ? [index] : []));
  assert.ok(summaries.length >= 1, "routing to the 50k engineer from a 60k context made Pi compact inside the request");
  const first = firstTurn(trace);
  assert.ok(summaries.every((index) => index < first.index), "the compaction ran before the run's request");
  assert.equal(first.call.provider, "cloud-a", "the run's request still goes to its pick");
  const seen = headersBefore(trace, first.index);
  assert.equal(ref(seen), "cloud-a/m", "the optimizer sees the run's pick at the run's request");
  assert.equal(seen?.status, "selected");
  // The design's stated cost (§3.9): the compaction's own request is judged by the run's model.
  for (const index of summaries) assert.equal(ref(headersBefore(trace, index)), "cloud-a/m");
});

test("14. steering typed while a slow pre-run compaction runs neither plans nor drops: the first request takes the plan", TIMEOUT, async (t) => {
  const world = new World(t, {
    fleet: [
      { provider: "local-a", baseUrl: "http://localhost:0" },
      { provider: "cloud-a" },
      { provider: "cloud-b", contextWindow: 40_000 },
      { provider: "cloud-c" },
      { provider: "codex-like", api: "openai-codex-responses", ignoresAbort: true },
    ],
  });
  const worker = world.faux("cloud-b");
  const slow = gate();
  worker.respond(slow.step);
  const now = Date.now();
  const sessionManager = history(world, "smart-router/auto", [
    ["first", response(worker, { tokens: 2_000, timestamp: now - 3_000 })],
    ["second", response(worker, { tokens: 3_000, timestamp: now - 2_000 })],
    ["third", response(worker, { tokens: 39_500, stopReason: "aborted", timestamp: now - 1_000 })],
  ]);
  const pi = await world.start({ sessionManager });
  const mark = world.trace.length;
  const run = pi.session.prompt(PROMPTS.complex);
  await slow.started;
  assert.equal(pi.session.isStreaming, true, "the run is starting while Pi summarizes");
  await pi.session.prompt("also check the lock order", { streamingBehavior: "steer" });
  slow.release();
  await run;
  await pi.session.waitForIdle();
  const first = firstTurn(traceFrom(world, mark));
  assert.equal(first.call.provider, "cloud-a", "the plan survived the steering and the slow summary");
  assert.match(first.call.lastUser, /lock order/, "and the steering went with the run's first request");
});

test("15. after a resume, a custom-triggered first run goes where the optimizer was told it would", TIMEOUT, async (t) => {
  const world = new World(t);
  const first = await world.start({ persisted: true, select: "smart-router/auto" });
  await first.prompt(PROMPTS.complex);
  assert.equal(first.lastAssistant()?.provider, "cloud-a");
  const file = first.session.sessionFile;
  assert.ok(file !== undefined);
  await first.close();

  const resumed = await world.start({ sessionManager: world.open(file) });
  const mark = world.trace.length;
  await resumed.custom();
  const trace = traceFrom(world, mark);
  const start = trace.find((entry) => entry.kind === "before_agent_start");
  assert.ok(start?.kind === "before_agent_start" && start.messageType === "custom");
  const call = firstTurn(trace).call;
  assert.equal(ref(start.route), call.ref, "the optimizer's model is the model that received the request");
  assert.equal(call.provider, "cloud-a", "the resumed session sticks to its last responder, not the default role");
});

for (const bind of [false, true]) {
  test(`16. a nested session on the parent's runtime that ${bind ? "binds its extensions" : "never binds"}: the parent keeps routing during and after it`, TIMEOUT, async (t) => {
    const world = new World(t);
    const parent = await world.start({ select: "smart-router/auto" });
    await parent.prompt(PROMPTS.complex);
    await parent.prompt(PROMPTS.complex);
    const route = (): unknown => parent.model("smart-router/auto");
    const own = route();
    const nested = await nestedSession(world, parent, { bind });
    const displaced = route();
    assert.notEqual(displaced, own, "the nested router replaced the parent's route");

    // During: each phase compacts (a direct request) and then prompts (an owner-loop request).
    await parent.session.compact();
    if (bind) assert.equal(route(), displaced, "a live sibling's registration is left alone");
    else assert.notEqual(route(), displaced, "a registration no live owner made is healed at the parent's next hook");
    await parent.prompt(PROMPTS.complex);
    const during = route();

    // After: the nested session is disposed without session_shutdown, so its context goes stale.
    nested.dispose();
    await parent.session.compact();
    if (bind) assert.notEqual(route(), during, "the route the disposed sibling left is healed at the parent's next hook");
    else assert.equal(route(), during, "nothing was left to heal");
    await parent.prompt(PROMPTS.complex);

    const errors = parent.assistants().filter((message) => message.stopReason === "error");
    assert.deepEqual(errors.map((message) => message.errorMessage), [], "no refusal, and no stale-route error, reached the parent");
    assert.equal(parent.eventsOf("compaction_end").filter((event) => event.result !== undefined).length, 2, "both compactions ran");
    const engineer = world.faux("cloud-a");
    assert.equal(engineer.sessionCalls(parent.sessionId).length, 4, "every owner-loop request went to the planned engineer");
    assert.ok(engineer.calls.filter((call) => call.summary).length >= 2, "both compactions summarized on the parent's previous model");
    assert.deepEqual(Object.keys(called(world.counts())), ["cloud-a"]);
  });
}

test("17. a pi-subagents-style child: without the router there is no smart-router/auto; with it, it routes, and smart-router/local stays local", TIMEOUT, async (t) => {
  const world = new World(t);
  const parent = await world.start({ select: "smart-router/auto" });
  // A foreground child gets a fresh runtime with the parent's providers and no extensions, so the
  // model it inherits is not in its catalog, and pi-subagents fails with "model not found".
  const bare = await world.start({ router: false, probe: false, select: "cloud-b/m" });
  assert.equal(bare.session.modelRuntime.getModel("smart-router", "auto"), undefined);
  // The managed entry registers the router for children, so a child loads it.
  const inherited = parent.selection();
  assert.equal(inherited, "smart-router/auto");
  const child = await world.start({ select: inherited });
  await child.prompt(PROMPTS.complex);
  assert.equal(child.lastAssistant()?.provider, "cloud-a");
  const local = await world.start({ select: "smart-router/local" });
  await local.prompt(PROMPTS.complex);
  assert.equal(local.lastAssistant()?.provider, "local-a");
  assert.deepEqual(called(world.counts()), { "cloud-a": 1, "local-a": 1 });
});

test("18. a usage-limit error cools the engineer, and the next custom-triggered run goes to its declared fallback", TIMEOUT, async (t) => {
  const world = new World(t);
  const engineer = world.faux("cloud-a");
  engineer.respond(fauxAssistantMessage("first answer"), failure("You exceeded your current quota: insufficient_quota"));
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.prompt(PROMPTS.complex);
  await pi.prompt(PROMPTS.complex);
  assert.match(pi.lastAssistant()?.errorMessage ?? "", /insufficient_quota/);
  assert.equal(pi.eventsOf("auto_retry_start").length, 0, "Pi does not retry a usage limit");
  await pi.custom();
  assert.equal(pi.lastAssistant()?.provider, "cloud-c", "the run went to the coder, the engineer's declared fallback");
  assert.deepEqual(called(world.counts()), { "cloud-a": 2, "cloud-c": 1 });
  await pi.command("history");
  assert.match(notice(pi, /routing decisions/), /continuation: coder → cloud-c\/m \(fallback:engineer→coder\)$/m);
  await pi.command("status");
  assert.match(notice(pi, /^pi-smart-router status/), /engineer: cloud-a\/m cooling-until-\d\d:\d\d/);
});

test("19. a retryable 429 retries the same model, and nothing is cooled", TIMEOUT, async (t) => {
  const world = new World(t);
  const engineer = world.faux("cloud-a");
  engineer.respond(failure("429 Too Many Requests"));
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.prompt(PROMPTS.complex);
  assert.equal(pi.eventsOf("auto_retry_start").length, 1);
  assert.equal(pi.lastAssistant()?.provider, "cloud-a");
  assert.equal(pi.lastAssistant()?.stopReason, "stop");
  await pi.custom();
  assert.equal(pi.lastAssistant()?.provider, "cloud-a", "no cooldown moved the next run");
  assert.deepEqual(called(world.counts()), { "cloud-a": 3 });
  await pi.command("history");
  assert.match(notice(pi, /routing decisions/), /retry: engineer → cloud-a\/m \(retry:same\)/);
  await pi.command("status");
  assert.match(notice(pi, /^pi-smart-router status/), /engineer: cloud-a\/m ok/);
});

test("20. the pin survives a resume through fresh services, and is enforced on the restored selection", TIMEOUT, async (t) => {
  const world = new World(t);
  const first = await world.start({ persisted: true, select: "smart-router/auto" });
  await first.command("local on");
  assert.equal(first.selection(), "smart-router/local");
  await first.prompt(PROMPTS.plain);
  assert.equal(first.lastAssistant()?.provider, "local-a");
  // A selection recorded behind the guards' back, as an extension that writes the session could.
  first.session.sessionManager.appendModelChange("cloud-a", "m");
  const file = first.session.sessionFile;
  assert.ok(file !== undefined);
  await first.close();

  const resumed = await world.start({ sessionManager: world.open(file) });
  assert.equal(resumed.selection(), "smart-router/local", "the restored cloud-a/m was switched at session_start");
  assert.equal(resumed.ui.saw(/its selection cloud-a\/m was switched to smart-router\/local/).length, 1);
  assert.equal(resumed.ui.status(), "local models");
  await resumed.command("local status");
  assert.match(notice(resumed, /^pi-smart-router: pin /), /^pi-smart-router: pin on since \S+, with models local-a\/m; providers local-a; hosts localhost\./);
  resumed.force("cloud-a/m");
  await resumed.custom();
  assert.equal(resumed.lastAssistant()?.provider, "local-a");
  assert.deepEqual(called(world.counts()), { "local-a": 2 });
});

test("21. max thinking is clamped per routed model, and a role's fixed level wins", TIMEOUT, async (t) => {
  const roster = structuredClone(ROSTER);
  roster.roles = roster.roles.map((role) => (role.name === "architect" ? { ...role, thinking: "low" } : role));
  const world = new World(t, {
    roster,
    fleet: [
      { provider: "local-a", baseUrl: "http://localhost:0" },
      { provider: "cloud-a", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
      { provider: "cloud-b", reasoning: true },
      { provider: "cloud-c", reasoning: true },
      { provider: "codex-like", api: "openai-codex-responses", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
    ],
  });
  const pi = await world.start({ select: "smart-router/auto" });
  pi.session.setThinkingLevel("max");
  assert.equal(pi.session.thinkingLevel, "max", "smart-router/auto offers max");
  await pi.prompt(PROMPTS.plain);
  await pi.prompt(PROMPTS.complex);
  await pi.prompt(PROMPTS.planning);
  await pi.session.setModel(pi.model("smart-router/local"));
  pi.session.setThinkingLevel("max");
  assert.equal(pi.session.thinkingLevel, "max", "smart-router/local offers max");
  await pi.prompt(PROMPTS.plain);
  const levels = pi.assistants().map((message) => `${message.provider}:${message.thinkingLevel}`);
  assert.deepEqual(levels, ["cloud-b:high", "cloud-a:max", "codex-like:low", "local-a:off"]);
});

test("22. before_provider_headers and before_provider_request resolve, through the registry, the model each provider received", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/auto" });
  const mark = world.trace.length;
  await pi.prompt(PROMPTS.planning);
  await pi.prompt(PROMPTS.plain);
  await pi.session.setModel(pi.model("smart-router/local"));
  await pi.prompt(PROMPTS.plain);
  const trace = traceFrom(world, mark);
  const calls = trace.flatMap((entry, index) => (entry.kind === "call" ? [{ index, call: entry.call }] : []));
  assert.deepEqual(
    calls.map(({ call }) => call.ref),
    ["codex-like/m", "codex-like/m", "local-a/m"],
    "the plain prompt held on the architect inside the idle window",
  );
  for (const { index, call } of calls) {
    assert.equal(ref(headersBefore(trace, index)), call.ref, `headers before the request to ${call.ref}`);
    const payload = trace.slice(index + 1).find((entry) => entry.kind === "payload" || entry.kind === "call");
    assert.ok(payload?.kind === "payload", `the request to ${call.ref} passed onPayload`);
    assert.equal(ref(payload.route), call.ref, `before_provider_request for the request to ${call.ref}`);
    assert.notEqual(call.payload, null);
  }
});

test("23. /reload and /new leave one registered adapter, one owner per live session, and no per-session state", TIMEOUT, async (t) => {
  // A new session starts on the settings default, which John may point at the router (design §9).
  const world = new World(t, { settings: { ...BASE_SETTINGS, defaultProvider: "smart-router", defaultModel: "auto" } });
  const pi = await world.start({ persisted: true, select: "smart-router/auto" });
  await pi.prompt(PROMPTS.plain);
  const store = globalThis as Record<symbol, unknown>;
  const slot = store[Symbol.for(SLOT_KEY)] as Slot;
  const registry = store[Symbol.for(ROUTING_REGISTRY_KEY)] as RoutingRegistry;
  const owners = (): Owner[] => [...slot.owners];
  const records = (owner: Owner | undefined, sessionId: string): unknown => (owner?.router as Router | undefined)?.record(sessionId);
  const answers = async (): Promise<void> => {
    const mark = world.trace.length;
    await pi.prompt(PROMPTS.plain);
    const trace = traceFrom(world, mark);
    const turn = firstTurn(trace);
    assert.equal(ref(headersBefore(trace, turn.index)), turn.call.ref, "the adapter answers for the live session");
  };

  const first = owners();
  assert.equal(first.length, 1);
  const sessionId = pi.sessionId;
  assert.ok(records(first[0], sessionId) !== undefined);
  await pi.session.reload();
  assert.equal(owners().length, 1);
  assert.notEqual(owners()[0], first[0], "the reloaded router joined in its own name");
  assert.equal(records(first[0], sessionId), undefined, "the unloaded instance kept no session state");
  assert.ok(slot.adapter !== undefined && registry.getRouter("smart-router") === slot.adapter.adapter, "one adapter, the slot's");
  await answers();

  const reloaded = owners()[0];
  await pi.runtime.newSession();
  assert.notEqual(pi.sessionId, sessionId);
  assert.equal(pi.selection(), "smart-router/auto");
  assert.deepEqual(owners().map((owner) => owner.sessionId), [pi.sessionId], "one owner, the new session");
  assert.equal(records(reloaded, sessionId), undefined);
  assert.ok(slot.adapter !== undefined && registry.getRouter("smart-router") === slot.adapter.adapter);
  await answers();
});

test("24a. a roster that names openai-codex-3 is invalid, and both models refuse", TIMEOUT, async (t) => {
  const roster = structuredClone(ROSTER);
  roster.roles.push({ name: "work", models: ["openai-codex-3/gpt-6.1-sol"] });
  const world = new World(t, { roster });
  const pi = await world.start({ select: "smart-router/auto" });
  assert.equal(pi.ui.saw(/is excluded by openai-codex-3\/\*.*refuse every request until it is fixed/).length, 1);
  await pi.prompt(PROMPTS.complex);
  assert.match(pi.lastAssistant()?.errorMessage ?? "", /^smart-router\/auto: the roster \S+ is invalid \(roles\[5\]\.models\[0\]: "openai-codex-3\/gpt-6\.1-sol" is excluded by openai-codex-3\/\*\)\. Nothing was sent\./);
  assert.deepEqual(called(world.counts()), {});
});

test("24b. after a direct turn on openai-codex-3, neither runs nor compaction go back to it, and openai-codex-2 takes its model id", TIMEOUT, async (t) => {
  const roster = structuredClone(ROSTER);
  roster.roles = roster.roles.map((role) => (role.name === "engineer" ? { ...role, models: ["openai-codex-2/gpt-6.1-sol"] } : role));
  roster.accounts = { "openai-codex-2": { multiPassLabel: "personal" } };
  const world = new World(t, {
    roster,
    multiPass: { subscriptions: [{ provider: "openai-codex", index: 2, label: "personal" }, { provider: "openai-codex", index: 3, label: "Positron work" }] },
  });
  const work = world.faux("openai-codex-3");
  const sessionManager = history(world, "smart-router/auto", [["picked directly", response(work, { timestamp: Date.now() - 1_000 })]]);
  const pi = await world.start({ sessionManager });
  await pi.custom();
  assert.equal(pi.lastAssistant()?.provider, "cloud-b", "a continuation whose previous model is openai-codex-3 goes to the default role");
  await pi.session.compact();
  assert.ok(world.faux("cloud-b").calls.some((call) => call.summary), "so does the compaction");
  await pi.prompt(PROMPTS.complex);
  assert.equal(`${pi.lastAssistant()?.provider}/${pi.lastAssistant()?.model}`, "openai-codex-2/gpt-6.1-sol");
  assert.equal(work.callCount, 0);
});

test("24c. with Multi-Pass labelling alias #2 Positron, a roster that binds openai-codex-2 refuses", TIMEOUT, async (t) => {
  const roster = structuredClone(ROSTER);
  roster.roles = roster.roles.map((role) => (role.name === "engineer" ? { ...role, models: ["openai-codex-2/gpt-6.1-sol"] } : role));
  roster.routing = { ...roster.routing, fallback: {} };
  roster.accounts = { "openai-codex-2": { multiPassLabel: "personal" } };
  const world = new World(t, { roster, multiPass: { subscriptions: [{ provider: "openai-codex", index: 2, label: "positron" }] } });
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.prompt(PROMPTS.complex);
  assert.match(
    pi.lastAssistant()?.errorMessage ?? "",
    /^smart-router\/auto: no model can take this request \(engineer: openai-codex-2\/gpt-6\.1-sol: Multi-Pass labels openai-codex-2 "positron", a refused label\)\. Nothing was sent\./,
  );
  assert.deepEqual(called(world.counts()), {});
  await pi.command("status");
  assert.match(notice(pi, /^pi-smart-router status/), /openai-codex-2: bound to the Multi-Pass label "personal"; refused: Multi-Pass labels openai-codex-2 "positron", a refused label/);
});

test("25. a content-filter refusal never moves the conversation to the declared fallback", TIMEOUT, async (t) => {
  const world = new World(t);
  const engineer = world.faux("cloud-a");
  // The first refusal is final for Pi; the second also reads as retryable, so Pi retries it.
  engineer.respond(
    fauxAssistantMessage("first answer"),
    failure("403 Forbidden: content_filter: the request was flagged by moderation"),
    failure("503 upstream error: content_filter flagged this request"),
  );
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.prompt(PROMPTS.complex);
  await pi.prompt(PROMPTS.complex);
  assert.match(pi.lastAssistant()?.errorMessage ?? "", /content_filter/);
  assert.equal(pi.eventsOf("auto_retry_start").length, 0);
  await pi.custom();
  assert.equal(pi.lastAssistant()?.provider, "cloud-a", "the refusal cooled nothing, so the next run stayed");
  assert.equal(pi.eventsOf("auto_retry_start").length, 1, "Pi retried the retryable-looking refusal");
  assert.equal(pi.lastAssistant()?.stopReason, "stop");
  assert.deepEqual(called(world.counts()), { "cloud-a": 4 });
  await pi.command("history");
  assert.match(notice(pi, /routing decisions/), /retry: engineer → cloud-a\/m \(retry:same\)/);
});

// Scenario 26. The warming model caches for 10.2 s, so Pi refreshes 200 ms after a request, and a
// cache write costs enough that Pi's own economics always choose to warm.
const WARMING: WorldOptions = {
  settings: { ...BASE_SETTINGS, cacheWarming: "idle" },
  fleet: [
    { provider: "local-a", baseUrl: "http://localhost:0" },
    { provider: "cloud-a" },
    { provider: "cloud-b" },
    { provider: "cloud-c" },
    { provider: "codex-like", api: "openai-codex-responses", ignoresAbort: true, promptCache: { short: 10.2 }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e9 } },
  ],
};

/** An extension that, at turn_start, writes the selection without model_select and without awaiting (design §13 risk 14). */
function racer(): { readonly extension: InlineExtension; force?: (() => void) | undefined } {
  const holder: { readonly extension: InlineExtension; force?: (() => void) | undefined } = {
    extension: {
      name: "racer",
      factory: (api) => {
        api.on("turn_start", () => {
          holder.force?.();
        });
      },
    },
  };
  return holder;
}

const warmCalls = (world: World): FauxCall[] => world.faux("codex-like").calls.filter((call) => call.maxTokens === 1);

test("26. control: unpinned, idle warming arms and sends the request's content again", TIMEOUT, async (t) => {
  const world = new World(t, WARMING);
  const pi = await world.start({ select: "codex-like/m" });
  await pi.prompt(PROMPTS.plain);
  await until(() => warmCalls(world).length > 0, 10_000, "a warm request");
  const [warm] = warmCalls(world);
  assert.ok(warm !== undefined && warm.payload !== null && typeof warm.payload === "object", "the warm request carries content");
  assert.match(JSON.stringify(warm.payload), /how are you today/);
});

test("26. pinned, a Codex-like request aborted by the payload barrier: its payload is empty, and the router stops the warming Pi wanted", TIMEOUT, async (t) => {
  const world = new World(t, WARMING);
  const race = racer();
  const pi = await world.start({ select: "smart-router/local", extensions: [race.extension] });
  await pi.command("local on");
  race.force = () => pi.force("codex-like/m");
  await pi.custom();
  race.force = undefined;
  const codex = world.faux("codex-like");
  assert.equal(codex.callCount, 1, "the forced request reached the provider");
  assert.equal(codex.calls[0]?.payload, null, "with an empty payload");
  assert.equal(pi.ui.saw(/a request to codex-like\/m would leave this machine, so the request was emptied and the run stopped/).length, 1);
  await until(() => pi.session.cacheWarmingStatus?.state === "inactive" && pi.session.cacheWarmingStatus.decision !== undefined, 10_000, "Pi's warming decision");
  const status = pi.session.cacheWarmingStatus;
  assert.equal(status?.decision?.action, "warm", "Pi's own economics chose to warm");
  assert.equal(status?.reason, "stopped by extension");
  assert.equal(status?.extensionOverride, true);
  assert.equal(codex.callCount, 1, "no warm request was sent");
});

test("26. pinned, when a later extension forces warming anyway, the warm requests carry no content", TIMEOUT, async (t) => {
  const world = new World(t, WARMING);
  const race = racer();
  const insist: InlineExtension = { name: "insist", factory: (api) => void api.on("cache_warming_decision", () => ({ action: "warm" })) };
  const pi = await world.start({ select: "smart-router/local", extensions: [race.extension, insist] });
  await pi.command("local on");
  race.force = () => pi.force("codex-like/m");
  await pi.custom();
  race.force = undefined;
  await until(() => warmCalls(world).length > 0, 10_000, "a warm request");
  const codex = world.faux("codex-like");
  assert.ok(codex.calls.length >= 2);
  assert.deepEqual(
    codex.calls.map((call) => call.payload),
    codex.calls.map(() => null),
    "the payload barrier empties every request, warm requests included",
  );
});

test("Q6. /new and a fork carry the pin; resuming an unpinned session after a pinned one says so", TIMEOUT, async (t) => {
  const world = new World(t, { settings: { ...BASE_SETTINGS, defaultProvider: "smart-router", defaultModel: "auto" } });
  const pi = await world.start({ persisted: true, select: "smart-router/auto" });
  await pi.prompt(PROMPTS.plain);
  const unpinned = pi.session.sessionFile;
  assert.ok(unpinned !== undefined);
  const pinEntries = (): unknown[] =>
    pi.session.sessionManager
      .getEntries()
      .flatMap((entry) => (entry.type === "custom" && entry.customType === "smart-router.pin" ? [entry.data] : []));

  await pi.runtime.newSession();
  await pi.prompt("first");
  await pi.command("local on");
  await pi.prompt("second");
  assert.equal(pi.lastAssistant()?.provider, "local-a");

  // A fork from before the pin entry: the branch it copies holds no pin, so only the handoff can carry it.
  await pi.runtime.fork(userEntry(pi, 0));
  assert.equal(pinEntries().length, 1, "the fork recorded the pin it carried");
  assert.equal(pi.ui.status(), "local models");
  assert.ok(pi.ui.saw(/this session is pinned to local models, as the session it came from was/).length >= 1);
  assert.equal(pi.selection(), "smart-router/local", "the default selection was switched at session_start");

  await pi.runtime.newSession();
  assert.equal(pinEntries().length, 1, "/new carried the pin");
  assert.equal(pi.selection(), "smart-router/local");
  await pi.prompt(PROMPTS.complex);
  assert.equal(pi.lastAssistant()?.provider, "local-a");

  await pi.runtime.switchSession(unpinned);
  assert.equal(pinEntries().length, 0);
  assert.equal(pi.ui.status(), undefined);
  assert.equal(pi.ui.saw(/the session you left was pinned to local models, and this one is not/).length, 1);
});

test("Q6. PI_SMART_ROUTER_LOCAL_ONLY pins every session of the process, latched at load", TIMEOUT, async (t) => {
  const world = new World(t, { settings: { ...BASE_SETTINGS, defaultProvider: "smart-router", defaultModel: "auto" } });
  process.env.PI_SMART_ROUTER_LOCAL_ONLY = "1";
  const pi = await world.start({ persisted: true, select: "smart-router/auto" });
  delete process.env.PI_SMART_ROUTER_LOCAL_ONLY;
  assert.equal(pi.selection(), "smart-router/local");
  assert.equal(pi.ui.status(), "local models");
  await pi.prompt(PROMPTS.complex);
  assert.equal(pi.lastAssistant()?.provider, "local-a");
  await pi.runtime.newSession();
  assert.equal(pi.selection(), "smart-router/local", "the switch stays latched after the variable is gone");
  await pi.command("local off");
  assert.equal(pi.ui.saw(/PI_SMART_ROUTER_LOCAL_ONLY pins every session in this process, so this one cannot be unpinned/).length, 1);
  await pi.prompt(PROMPTS.planning);
  assert.equal(pi.lastAssistant()?.provider, "local-a");
  assert.deepEqual(called(world.counts()), { "local-a": 2 });
});

test("§5.1. a goal-x-style auditor on the parent's runtime routes with the parent's context and obeys the parent's pin", TIMEOUT, async (t) => {
  const world = new World(t);
  const parent = await world.start({ select: "smart-router/auto" });
  const audit = async (selection: string | undefined): Promise<AssistantMessage | undefined> => {
    assert.ok(selection !== undefined);
    const auditor = await auditorSession(world, parent, selection);
    t.after(() => auditor.dispose());
    await auditor.prompt(PROMPTS.complex);
    await auditor.waitForIdle();
    return auditor.messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
  };
  // An auditor inherits the parent's selection. Its requests are foreign: they take the default
  // role and consume no plan.
  const unpinned = await audit(parent.selection());
  assert.equal(`${unpinned?.provider}/${unpinned?.model}`, "cloud-b/m");
  await parent.command("local on");
  const pinned = await audit(parent.selection());
  assert.equal(parent.selection(), "smart-router/local");
  assert.equal(`${pinned?.provider}/${pinned?.model}`, "local-a/m", "under the parent's pin, the auditor goes local");
  // An auditor still on smart-router/auto from before the pin has no allowed candidate: under the
  // pin only local models qualify, and auto never routes to the local role. It sends nothing.
  const stale = await audit("smart-router/auto");
  assert.equal(stale?.stopReason, "error");
  assert.match(stale?.errorMessage ?? "", /^smart-router\/auto: no local model can take this request while this session is pinned to local models \(.*\)\. Nothing was sent\./);
  assert.deepEqual(called(world.counts()), { "cloud-b": 1, "local-a": 1 });
  await parent.command("history");
  const decisions = notice(parent, /routing decisions/);
  assert.match(decisions, /user: worker → cloud-b\/m \(foreign:default\), foreign$/m);
  assert.match(decisions, /user: local → local-a\/m \(foreign:default\), foreign$/m);
});

test("on upstream Pi 1.5.0, without the fork's bounded session reads, both models refuse and say why", TIMEOUT, async (t) => {
  const restore = withoutBoundedReaders();
  t.after(restore);
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/auto" });
  assert.equal(pi.ui.saw(/this Pi has no bounded session history/).length, 1);
  await pi.prompt(PROMPTS.plain);
  assert.match(pi.lastAssistant()?.errorMessage ?? "", /^smart-router\/\w+: this Pi has no bounded session history \(getLatestCustomEntry and getRecentActiveEntries\)\. Nothing was sent\./);
  assert.deepEqual(called(world.counts()), {});
});

// ─── The four levels, on version 2 rosters ───────────────────────────────────

const CODEX_IDS = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-astra"] as const;
const OPENROUTER_IDS = ["deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3", "moonshotai/kimi-k3.1-pro"] as const;
/** The fake classifier's one model, which the version 2 rosters name; never OpenRouter's Jev. */
const JEV_MODEL = "jev-fake/jev";

/** Each tier's first model: on John's personal Codex account, and on the work account. */
const PERSONAL: Readonly<Record<Tier, string>> = {
  low: "openai-codex-2/gpt-6-luna",
  medium: "openai-codex-2/gpt-6.1-terra",
  high: "openai-codex-2/gpt-6.1-sol",
  super: "openai-codex-2/gpt-6-astra",
};
const WORK: Readonly<Record<Tier, string>> = {
  low: "openai-codex-3/gpt-6-luna",
  medium: "openai-codex-3/gpt-6.1-terra",
  high: "openai-codex-3/gpt-6.1-sol",
  super: "openai-codex-3/gpt-6-astra",
};

/** The personal SUPER level's second candidate. */
const KIMI_REF = "openrouter/moonshotai/kimi-k3.1-pro";

/** The descriptions Jev reads in each scope. Work's are worded apart, so a test can tell which scope's descriptions Jev read. */
const DESCRIBE: Readonly<Record<Tier, string>> = {
  low: "Mechanical or trivial work that follows a clear specification",
  medium: "Engineering, implementation and validation",
  high: "Deep thought, review, and the design of verification",
  super: "Deep thought, research, design and planning",
};
const WORK_DESCRIBE: Readonly<Record<Tier, string>> = {
  low: "At work: mechanical or trivial work that follows a clear specification",
  medium: "At work: engineering, implementation and validation",
  high: "At work: deep thought, review, and the design of verification",
  super: "At work: deep thought, research, design and planning",
};

/** Jev's answer with 80% on one tier. */
const JEV: Readonly<Record<Tier, Readonly<Record<Tier, number>>>> = {
  low: { low: 0.8, medium: 0.1, high: 0.05, super: 0.05 },
  medium: { low: 0.1, medium: 0.8, high: 0.05, super: 0.05 },
  high: { low: 0.05, medium: 0.1, high: 0.8, super: 0.05 },
  super: { low: 0.05, medium: 0.05, high: 0.1, super: 0.8 },
};

/** Multi-Pass's labels, as on Hera: alias #2 is John's personal account, #3 the work account. */
const LABELS = {
  subscriptions: [
    { provider: "openai-codex", index: 2, label: "personal" },
    { provider: "openai-codex", index: 3, label: "Positron work" },
  ],
};

/**
 * The level scenarios' fleet: both Codex accounts with one model per tier, OpenRouter with the
 * personal ladder's second candidates, and the local model. Each Codex and OpenRouter model declares
 * 272,000 and 128,000, and the local model 262,144 and 81,920, unless `limits` gives it others, by
 * ref.
 */
function levelsFleet(limits: Readonly<Record<string, Partial<Limits>>> = {}): FauxSpec[] {
  const models = (provider: string, ids: readonly string[]): Array<{ id: string; contextWindow: number; maxTokens: number }> =>
    ids.map((id) => ({ id, contextWindow: 272_000, maxTokens: 128_000, ...limits[`${provider}/${id}`] }));
  return [
    { provider: "local-a", baseUrl: "http://localhost:0", contextWindow: 262_144, maxTokens: 81_920, ...limits["local-a/m"] },
    { provider: "openai-codex-2", api: "openai-codex-responses", models: models("openai-codex-2", CODEX_IDS) },
    { provider: "openai-codex-3", api: "openai-codex-responses", models: models("openai-codex-3", CODEX_IDS) },
    { provider: "openrouter", models: models("openrouter", OPENROUTER_IDS) },
  ];
}

/**
 * A version 2 roster shaped like Hera's: personal levels take Codex first, then OpenRouter; work
 * levels take only the work account; the local role serves smart-router/local and the pin; Jev is
 * the fake classifier unless `classifier` is false.
 */
function rosterV2(options: { readonly directories?: readonly string[]; readonly classifier?: boolean } = {}): RosterJsonV2 {
  const levels = (prefix: string, describe: Readonly<Record<Tier, string>>) => ({
    low: { role: `${prefix}low`, describe: describe.low },
    medium: { role: `${prefix}medium`, describe: describe.medium },
    high: { role: `${prefix}high`, describe: describe.high },
    super: { role: `${prefix}super`, describe: describe.super },
  });
  return {
    version: 2,
    roles: [
      { name: "local", models: ["local-a/m"] },
      { name: "low", models: [PERSONAL.low] },
      { name: "medium", models: [PERSONAL.medium, "openrouter/deepseek/deepseek-v4.1-flash-1017"] },
      { name: "high", models: [PERSONAL.high, "openrouter/z-ai/glm-5.3"] },
      { name: "super", models: [PERSONAL.super, "openrouter/moonshotai/kimi-k3.1-pro"] },
      ...TIERS.map((tier) => ({ name: `work-${tier}`, models: [WORK[tier]] })),
    ],
    scopes: {
      personal: { levels: levels("", DESCRIBE) },
      work: { levels: levels("work-", WORK_DESCRIBE), ...(options.directories === undefined ? {} : { directories: [...options.directories] }) },
    },
    accounts: { "openai-codex-2": { multiPassLabel: "personal" }, "openai-codex-3": { multiPassLabel: "Positron work", scope: "work" } },
    ...(options.classifier === false ? {} : { classifier: { model: JEV_MODEL } }),
    local: { role: "local", providers: ["local-a"], hosts: ["localhost"] },
  };
}

/** A world for the level scenarios: their fleet, Multi-Pass's labels, a version 2 roster, and new sessions on smart-router/auto. */
function levelsWorld(t: TestContext, options: { readonly roster?: RosterJsonV2; readonly fleet?: readonly FauxSpec[] } = {}): World {
  return new World(t, {
    roster: options.roster ?? rosterV2(),
    multiPass: LABELS,
    fleet: options.fleet ?? levelsFleet(),
    settings: { ...BASE_SETTINGS, defaultProvider: "smart-router", defaultModel: "auto" },
  });
}

/** The model that answered the session's latest response, as provider/id; it must have answered. */
function answered(pi: Pi): string {
  const message = pi.lastAssistant();
  assert.ok(message !== undefined, "a response");
  assert.equal(message.stopReason, "stop", message.errorMessage);
  return `${message.provider}/${message.model}`;
}

/** The data of a session's custom entries of one type, oldest first, on every branch. */
function entriesOf(pi: Pi, customType: string): Array<Record<string, unknown>> {
  return pi.session.sessionManager
    .getEntries()
    .flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data as Record<string, unknown>] : []));
}

/** The level records of routed runs, oldest first: every level entry but the corrections. */
const runRecords = (pi: Pi): Array<Record<string, unknown>> => entriesOf(pi, LEVEL_ENTRY).filter((record) => record.source !== "correction");

/** A session's scope entries, as [scope, what recorded it]. */
const scopeEntries = (pi: Pi): unknown[][] => entriesOf(pi, SCOPE_ENTRY).map((entry) => [entry.scope, entry.by]);

/** The fields of a record that `like` names, to compare with `like`. */
function fields(record: Record<string, unknown> | undefined, like: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(like).map((key) => [key, record?.[key]]));
}

/** How many notices say exactly this. */
const count = (pi: Pi, text: string): number => pi.ui.notices.filter((item) => item.message === text).length;

/** The latest routing decision, as /smart-router history shows it, without its time. */
async function lastDecision(pi: Pi): Promise<string> {
  await pi.command("history 1");
  return (notice(pi, /routing decisions/).split("\n")[1] ?? "").replace(/^ {2}\d\d:\d\d:\d\d /, "");
}

/** The criteria of each question one classification asked. */
const criteriaOf = (call: JevCall | undefined): unknown[] => Object.values(call?.context.questions ?? {}).map((question) => question.criteria);

/** Wait until a gated request reaches its model; a run that ends first fails the test rather than leaving it waiting. */
async function reached(slow: { readonly started: Promise<void> }, run: Promise<unknown>): Promise<void> {
  const ended = run.then(() => "ended", () => "ended");
  assert.equal(await Promise.race([slow.started.then(() => "started"), ended]), "started", "the run ended before its request reached the model");
}

test("L1 a tag routes at once past hold:sticky, never reaches the payload, and survives a resend", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  world.jev.answer(JEV.super);
  await pi.prompt("Survey the options for the session store");
  assert.equal(answered(pi), PERSONAL.super);
  // An untagged message that Jev puts at HIGH stays on SUPER's model while the session is busy.
  world.jev.answer(JEV.high);
  await pi.prompt("Check the error paths");
  assert.equal(answered(pi), PERSONAL.super);
  assert.equal(await lastDecision(pi), "smart-router/auto user: super → openai-codex-2/gpt-6-astra (hold:sticky, triage:no_fast_path) [personal SUPER (jev HIGH 80%)]");

  // A tagged message goes to HIGH at once. Jev's opinion of it is asked, and the run does not wait for it.
  world.jev.hang();
  const codex = world.faux("openai-codex-2");
  const mark = codex.calls.length;
  await pi.prompt("Fix the parser #high");
  assert.equal(world.jev.calls.length, 3, "Jev was asked for its opinion");
  assert.equal(world.jev.calls[2]?.result, undefined, "and had not answered when the run ended");
  assert.equal(answered(pi), PERSONAL.high);
  const sent = codex.calls.slice(mark);
  assert.deepEqual(
    sent.map((call) => [call.ref, call.lastUser]),
    [[PERSONAL.high, "Fix the parser"]],
    "the model received the text without its tag",
  );
  assert.doesNotMatch(JSON.stringify(sent[0]?.payload), /#high/, "and so did the payload");
  assert.doesNotMatch(JSON.stringify(pi.session.messages), /#high/, "the session keeps no tag either");
  assert.equal(await lastDecision(pi), "smart-router/auto user: high → openai-codex-2/gpt-6.1-sol (tag, triage:no_fast_path) [personal HIGH (tag)]");
  const tagged = { source: "tag", tag: "high", tier: "high", jev: { late: true } };
  assert.deepEqual(fields(runRecords(pi).at(-1), tagged), tagged);

  // pi-idle-check resends the text without its tag: the run keeps the tag's level, where Jev would
  // now say SUPER, and Jev is not asked again.
  world.jev.answer(JEV.super);
  await pi.resend("Fix the parser");
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(world.jev.calls.length, 3, "no second classifier call");
  assert.equal(await lastDecision(pi), "smart-router/auto user: high → openai-codex-2/gpt-6.1-sol (tag, triage:no_fast_path) [personal HIGH (tag)]");
  const resent = { source: "tag", tag: "high", tier: "high", jev: undefined };
  assert.deepEqual(fields(runRecords(pi).at(-1), resent), resent);
  assert.deepEqual(called(world.counts()), { "openai-codex-2": 4 });
});

test("L2 a tagged level steps up, with a notice, when the conversation does not fit", TIMEOUT, async (t) => {
  // LOW's model declares a 32k window, and the conversation already holds 40,000 tokens.
  const world = levelsWorld(t, { fleet: levelsFleet({ [PERSONAL.low]: { contextWindow: 32_000 } }) });
  const codex = world.faux("openai-codex-2");
  const sessionManager = history(world, "smart-router/auto", [["Load the fixtures", response(codex, { id: "gpt-6.1-terra", tokens: 40_000, timestamp: Date.now() - 1_000 })]]);
  const pi = await world.start({ sessionManager });
  await pi.prompt("Rename the helper #low");
  assert.equal(answered(pi), PERSONAL.medium);
  assert.equal(notice(pi, /can take this run/), "pi-smart-router: no LOW model can take this run, so it goes to MEDIUM (gpt-6.1-terra).");
  assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (tag)");
  assert.equal(await lastDecision(pi), "smart-router/auto user: medium → openai-codex-2/gpt-6.1-terra (step-up, triage:keyword_economical) [personal MEDIUM (tag)]");
  const record = { source: "tag", tag: "low", asked: "low", tier: "medium", steppedUp: true, ref: PERSONAL.medium };
  assert.deepEqual(fields(runRecords(pi).at(-1), record), record);
  assert.deepEqual(world.refCounts(), { [PERSONAL.medium]: 1 }, "LOW's model received nothing, and nothing was compacted");
});

test("L3 untagged runs follow Jev; a close call goes higher; failure, refusal and timeout fall back to keywords", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  const footer = (): string | undefined => pi.ui.status(LEVEL_KEY);
  // Each run's tier is at least the one before it, so no hold applies.
  world.jev.fail("System One API error (500): upstream connect error");
  await pi.prompt(PROMPTS.trivial);
  assert.equal(answered(pi), PERSONAL.low);
  assert.equal(footer(), "personal LOW → gpt-6-luna (keywords; jev error)");
  // pi-ai has no refusal branch: OpenRouter's refusal reaches the router as an error.
  world.jev.fail('System One API error (403): {"error":{"message":"The request was refused"}}');
  await pi.prompt(PROMPTS.plain);
  assert.equal(answered(pi), PERSONAL.medium);
  assert.equal(footer(), "personal MEDIUM → gpt-6.1-terra (keywords; jev error)");
  // A close call: MEDIUM leads HIGH by less than closeCall, so the run goes to HIGH.
  world.jev.answer({ low: 0.05, medium: 0.45, high: 0.4, super: 0.1 });
  await pi.prompt("Walk me through the cache layer");
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(footer(), "personal HIGH → gpt-6.1-sol (jev 40%)");
  // A classifier that answers nothing: the run goes on with the keywords' tier once timeoutMs passes.
  world.jev.hang();
  const started = Date.now();
  await pi.prompt(PROMPTS.complex);
  const waited = Date.now() - started;
  assert.ok(waited < 1_500, `the run went on after ${waited} ms`);
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(footer(), "personal HIGH → gpt-6.1-sol (keywords; jev timeout)");
  // Jev's tier, where the keywords would say MEDIUM.
  world.jev.answer(JEV.super);
  await pi.prompt("Hello again");
  assert.equal(answered(pi), PERSONAL.super);
  assert.equal(footer(), "personal SUPER → gpt-6-astra (jev 80%)");
  // A choice outside the four tiers is a failure too.
  world.jev.answer(JEV.low, "other");
  await pi.prompt(PROMPTS.planning);
  assert.equal(answered(pi), PERSONAL.super);
  assert.equal(footer(), "personal SUPER → gpt-6-astra (keywords; jev malformed)");

  // Every request reached the classifier with the roster's deadline and no retries.
  assert.deepEqual(
    world.jev.calls.map((call) => [call.timeoutMs, call.maxRetries]),
    world.jev.calls.map(() => [1_000, 0]),
  );
  assert.equal(world.jev.calls.length, 6);
  assert.deepEqual(
    runRecords(pi).map((record) => {
      const jev = record.jev as { readonly failure?: string; readonly choice?: string } | undefined;
      return [record.source, record.tier, jev?.failure ?? jev?.choice];
    }),
    [
      ["keyword", "low", "error"],
      ["keyword", "medium", "error"],
      ["jev", "high", "medium"],
      ["keyword", "high", "timeout"],
      ["jev", "super", "super"],
      ["keyword", "super", "malformed"],
    ],
  );
});

test("L4 no classifier call when pinned, on local, with PI_SMART_ROUTER_LOCAL_ONLY, for a steer, or without a classifier", TIMEOUT, async (t) => {
  await t.test("pinned", async (t) => {
    const world = levelsWorld(t);
    const pi = await world.start({ select: "smart-router/auto" });
    await pi.command("local on");
    assert.equal(pi.selection(), "smart-router/local");
    await pi.prompt(PROMPTS.plain);
    await pi.prompt("Fix the parser #high");
    assert.equal(answered(pi), "local-a/m");
    assert.equal(notice(pi, /tag was removed/), "pi-smart-router: the HIGH tag was removed and has no effect, because this session is pinned to local models.");
    // smart-router/auto, forced back, is refused by the pin's guard before anything is planned.
    pi.force("smart-router/auto");
    await pi.prompt(PROMPTS.planning);
    assert.deepEqual(world.jev.calls, []);
    assert.deepEqual(called(world.counts()), { "local-a": 2 });
  });

  await t.test("on smart-router/local", async (t) => {
    const world = levelsWorld(t);
    const pi = await world.start({ select: "smart-router/local" });
    await pi.prompt(PROMPTS.plain);
    await pi.prompt("Fix the parser #high");
    assert.equal(answered(pi), "local-a/m");
    assert.equal(
      notice(pi, /tag was removed/),
      "pi-smart-router: the HIGH tag was removed and has no effect, because only smart-router/auto routes by level, and the selection is smart-router/local.",
    );
    assert.deepEqual(world.jev.calls, []);
    assert.deepEqual(called(world.counts()), { "local-a": 2 });
  });

  await t.test("with PI_SMART_ROUTER_LOCAL_ONLY", async (t) => {
    const world = levelsWorld(t);
    process.env.PI_SMART_ROUTER_LOCAL_ONLY = "1";
    const pi = await world.start({ select: "smart-router/auto" });
    delete process.env.PI_SMART_ROUTER_LOCAL_ONLY;
    assert.equal(pi.selection(), "smart-router/local");
    // The variable pins the session, not only its first selection: smart-router/auto, forced back,
    // is refused by the pin's guard, tag or not, and nothing reaches Jev or a cloud model.
    const refused =
      "pi-smart-router: this session is pinned to local models, and smart-router/auto is not local, so the prompt was not sent. Choose smart-router/local or a local model with /model, or run /smart-router local off.";
    pi.force("smart-router/auto");
    await pi.prompt(PROMPTS.planning);
    await pi.prompt("Fix the parser #high");
    assert.equal(count(pi, refused), 2, "both prompts were refused");
    assert.deepEqual(world.jev.calls, []);
    assert.deepEqual(called(world.counts()), {});
    // Back on smart-router/local, the session routes locally, still without Jev.
    pi.force("smart-router/local");
    await pi.prompt(PROMPTS.planning);
    await pi.prompt("Fix the parser #high");
    assert.equal(answered(pi), "local-a/m");
    assert.deepEqual(world.jev.calls, []);
    assert.deepEqual(called(world.counts()), { "local-a": 2 });
  });

  await t.test("for a steer or a follow-up", async (t) => {
    const world = levelsWorld(t);
    const pi = await world.start({ select: "smart-router/auto" });
    const slow = gate();
    world.faux("openai-codex-2").respond(slow.step);
    // A run without a message of its own, as goal-x's continuations start one, asks Jev nothing either.
    const run = pi.custom();
    await reached(slow, run);
    await pi.session.prompt("Also check the lock order", { streamingBehavior: "steer" });
    await pi.session.prompt("And the error paths #high", { streamingBehavior: "steer" });
    await pi.session.prompt("Then sum it up", { streamingBehavior: "followUp" });
    slow.release();
    await run;
    assert.deepEqual(world.jev.calls, []);
    assert.equal(
      notice(pi, /tag was removed/),
      "pi-smart-router: the HIGH tag was removed and has no effect, because a run is under way, and it keeps its model until it ends.",
    );
    assert.match(JSON.stringify(pi.session.messages), /And the error paths/);
    assert.doesNotMatch(JSON.stringify(pi.session.messages), /#high/, "the steer reached the model without its tag");
  });

  await t.test("without a classifier", async (t) => {
    const world = levelsWorld(t, { roster: rosterV2({ classifier: false }) });
    const pi = await world.start({ select: "smart-router/auto" });
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium);
    assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (keywords)");
    await pi.prompt("Fix the parser #high");
    assert.equal(answered(pi), PERSONAL.high);
    assert.deepEqual(world.jev.calls, []);
  });
});

test("L5 scope: the latch, the entry carried into /new and a fork, resume, directories, and confirmation for work to personal", TIMEOUT, async (t) => {
  /** What a session the work directories moved is told. */
  const moved = (world: World): string => `pi-smart-router: this session is in work scope because ${world.cwd} is under ${world.cwd}.`;

  await t.test("the latch puts every session of the process in work scope, and moving to personal is refused", async (t) => {
    const world = levelsWorld(t);
    process.env[ENV_SCOPE] = "work";
    const pi = await world.start({ persisted: true, select: "smart-router/auto" });
    delete process.env[ENV_SCOPE];
    await pi.command("scope");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope work (latch).");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    await pi.command("scope personal");
    assert.equal(
      notice(pi, /PI_SMART_ROUTER_SCOPE/),
      "pi-smart-router: PI_SMART_ROUTER_SCOPE pins every session of this process to work scope, so this one cannot be moved to personal.",
    );
    assert.deepEqual(pi.ui.dialogs, [], "it is refused without a question");
    await pi.runtime.newSession();
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium, "the latch holds after the variable is gone");
    assert.deepEqual(called(world.counts()), { "openai-codex-3": 2 });
  });

  await t.test("an entry: work at once, carried into a fork and /new, and enforced at resume", async (t) => {
    const world = levelsWorld(t);
    const pi = await world.start({ persisted: true, select: "smart-router/auto" });
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium);
    const personal = pi.session.sessionFile;
    await pi.runtime.newSession();
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium, "a default scope is not carried");
    await pi.command("scope work");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope work (entry).");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium, "personal to work takes effect at once");
    // A selection recorded behind the guards' back, as an extension that writes the session could.
    pi.session.sessionManager.appendModelChange("openrouter", "z-ai/glm-5.3");
    const work = pi.session.sessionFile;
    assert.ok(personal !== undefined && work !== undefined);

    // A fork from before the scope entry: the branch it copies holds none, so only the handoff can carry it.
    await pi.runtime.fork(userEntry(pi, 0));
    assert.deepEqual(scopeEntries(pi), [["work", "carried"]]);
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    await pi.runtime.newSession();
    assert.deepEqual(scopeEntries(pi), [["work", "carried"]]);
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    assert.equal(count(pi, "pi-smart-router: this session is in work scope, as the session it came from was."), 2);

    // Resumed, the work session's entry holds, and the work guard switches the selection it restored.
    await pi.runtime.switchSession(work);
    assert.equal(pi.selection(), "smart-router/auto");
    assert.equal(count(pi, "pi-smart-router: this session is in work scope, so its selection openrouter/z-ai/glm-5.3 was switched to smart-router/auto."), 1);
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    // Resumed, the personal session is personal.
    await pi.runtime.switchSession(personal);
    await pi.command("scope");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope personal (default).");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium);
    assert.equal(world.faux("openrouter").callCount, 0);
  });

  await t.test("work directories: a running session moves at its next idle input, recorded once, and a new session starts in work scope", async (t) => {
    const world = levelsWorld(t);
    const pi = await world.start({ persisted: true, select: "smart-router/auto" });
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium);
    // The roster now lists the session's directory. The next idle input reads it, records the scope, and routes in work scope.
    world.writeRoster(rosterV2({ directories: [world.cwd] }));
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    assert.deepEqual(scopeEntries(pi), [["work", "directory"]]);
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    assert.deepEqual(scopeEntries(pi), [["work", "directory"]], "the entry is recorded once");
    assert.equal(count(pi, moved(world)), 1, "and the session is told once");

    // A session that starts under a work directory starts in work scope.
    const other = await world.start({ persisted: true, select: "smart-router/auto" });
    assert.deepEqual(scopeEntries(other), [["work", "directory"]]);
    assert.equal(count(other, moved(world)), 1);
    await other.prompt(PROMPTS.plain);
    assert.equal(answered(other), WORK.medium);
  });

  await t.test("work directories at resume: a session with turns but no entry moves to work scope, one with a personal entry stays", async (t) => {
    const world = levelsWorld(t);
    const pi = await world.start({ persisted: true, select: "smart-router/auto" });
    await pi.prompt(PROMPTS.plain);
    const plain = pi.session.sessionFile;
    await pi.runtime.newSession();
    await pi.command("scope personal");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope personal (entry).");
    await pi.prompt(PROMPTS.plain);
    const kept = pi.session.sessionFile;
    assert.ok(plain !== undefined && kept !== undefined);
    world.writeRoster(rosterV2({ directories: [world.cwd] }));

    await pi.runtime.switchSession(plain);
    assert.deepEqual(scopeEntries(pi), [["work", "directory"]]);
    assert.equal(count(pi, moved(world)), 1);
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);

    await pi.runtime.switchSession(kept);
    await pi.command("scope");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope personal (entry).");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium);
  });

  await t.test("work to personal asks first, says the earlier turns are work content, and moves only on that answer", async (t) => {
    const world = levelsWorld(t);
    const pi = await world.start({ select: "smart-router/auto" });
    await pi.command("scope work");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    const question = {
      title: "Move this session to personal scope?\nIts earlier turns are work content, and the next requests would send them to personal accounts.",
      options: ["Keep this session in work scope", "Move it to personal scope (earlier turns are work content)"],
    };
    // Escape, and the first answer, keep work scope.
    pi.ui.answers.push(undefined, "Keep this session in work scope");
    await pi.command("scope personal");
    await pi.command("scope personal");
    assert.deepEqual(pi.ui.dialogs, [question, question]);
    assert.equal(count(pi, "pi-smart-router: the session stays in work scope."), 2);
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    // The second answer moves it.
    pi.ui.answers.push("Move it to personal scope (earlier turns are work content)");
    await pi.command("scope personal");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope personal (entry).");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium);
    assert.deepEqual(scopeEntries(pi), [
      ["work", "command"],
      ["personal", "command"],
    ]);
    assert.equal(pi.ui.dialogs.length, 3, "personal to work asked nothing");
  });
});

test("L6 the work guard switches a hand-picked OpenRouter model back, and work runs reach only the work account", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.command("scope work");
  // A model picked by hand outside the work account is switched back.
  await pi.session.setModel(pi.model("openrouter/z-ai/glm-5.3"));
  assert.equal(pi.selection(), "smart-router/auto");
  assert.equal(count(pi, "pi-smart-router: this session is in work scope, so openrouter/z-ai/glm-5.3 was not kept, and the selection is smart-router/auto again."), 1);
  // One of the work account's is kept, and answers.
  await pi.session.setModel(pi.model(WORK.high));
  assert.equal(pi.selection(), WORK.high);
  await pi.prompt("Check the error paths");
  assert.equal(answered(pi), WORK.high);
  await pi.session.setModel(pi.model("smart-router/auto"));

  // Every tier goes to the work account, and Jev reads the work scope's descriptions.
  for (const tier of TIERS) {
    await pi.prompt(`Look at the logs #${tier}`);
    assert.equal(answered(pi), WORK[tier]);
  }
  assert.equal(pi.ui.status(LEVEL_KEY), "work SUPER → gpt-6-astra (tag)");
  assert.equal(world.jev.calls.length, 4);
  assert.deepEqual(
    world.jev.calls.map((call) => criteriaOf(call)),
    world.jev.calls.map(() => [WORK_DESCRIBE]),
  );

  // A selection written past model_select: a prompt is refused, and a run without one is switched at turn_start.
  pi.force("openrouter/z-ai/glm-5.3");
  const messages = pi.session.messages.length;
  await pi.prompt("Ship it");
  assert.equal(pi.session.messages.length, messages, "the prompt was not sent");
  assert.equal(
    count(
      pi,
      "pi-smart-router: this session is in work scope, and openrouter/z-ai/glm-5.3 is outside it, so the prompt was not sent. Choose smart-router/auto or a work Codex model with /model, or run /smart-router scope personal.",
    ),
    1,
  );
  await pi.custom();
  assert.equal(pi.selection(), "smart-router/auto");
  assert.match(answered(pi), /^openai-codex-3\//);
  assert.deepEqual(Object.keys(called(world.counts())), ["openai-codex-3"], "nothing reached the personal account or OpenRouter");
});

test("L7 one smart-router.level record per run; /smart-router was appends a correction", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  writeFileSync(join(world.cwd, "zebra.txt"), "the zebra notes\n");
  const pi = await world.start({ select: "smart-router/auto", tools: ["read"] });
  // Run A: one record, which holds neither the prompt's text nor a digest of it.
  world.jev.answer(JEV.medium);
  await pi.prompt("Tidy the zebra notes");
  assert.equal(runRecords(pi).length, 1);
  const a = runRecords(pi)[0];
  const ms = (a?.jev as { readonly ms?: unknown } | undefined)?.ms;
  assert.equal(typeof a?.at, "number");
  assert.equal(typeof ms, "number");
  assert.deepEqual(a, {
    v: 1,
    at: a?.at,
    scope: "personal",
    source: "jev",
    tier: "medium",
    asked: "medium",
    keyword: { signal: "default", reason: "triage:no_fast_path" },
    jev: { model: JEV_MODEL, choice: "medium", probabilities: JEV.medium, confidence: 0.8, ms },
    ref: PERSONAL.medium,
  });
  assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (jev 80%)");
  // A command and a run without a level of its own add none, and that run shows no level.
  await pi.command("status");
  await pi.custom();
  assert.equal(runRecords(pi).length, 1);
  assert.equal(pi.ui.status(LEVEL_KEY), undefined);
  // Run B, tagged.
  await pi.prompt("Answer the zebra question #high");
  assert.equal(runRecords(pi).length, 2);
  const b = runRecords(pi)[1];
  const tagged = { scope: "personal", source: "tag", tag: "high", tier: "high", ref: PERSONAL.high };
  assert.deepEqual(fields(b, tagged), tagged);

  // A correction after the run settled labels that run, and nothing is sent again.
  const sent = world.refCounts();
  await pi.command("was low");
  assert.equal(notice(pi, /^pi-smart-router: recorded/), "pi-smart-router: recorded that the last run should have been LOW.");
  const corrected = entriesOf(pi, LEVEL_ENTRY).at(-1);
  assert.deepEqual(corrected, { v: 1, at: corrected?.at, scope: "personal", source: "correction", tier: "low", refers: b?.at });
  assert.deepEqual(world.refCounts(), sent);

  // A correction sent while a run streams labels the run in flight, before its own record exists.
  world.jev.answer(JEV.super);
  const slow = gate();
  world.faux("openai-codex-2").respond(slow.step);
  const run = pi.session.prompt("Summarize the zebra notes");
  await reached(slow, run);
  await pi.session.prompt("/smart-router was medium");
  slow.release();
  await run;
  await pi.session.waitForIdle();
  assert.equal(runRecords(pi).length, 3);
  const c = runRecords(pi)[2];
  const inFlight = { source: "jev", tier: "super", ref: PERSONAL.super };
  assert.deepEqual(fields(c, inFlight), inFlight);
  assert.deepEqual(
    entriesOf(pi, LEVEL_ENTRY).map((entry) => [entry.source, entry.tier, entry.refers]),
    [
      ["jev", "medium", undefined],
      ["tag", "high", undefined],
      ["correction", "low", b?.at],
      ["correction", "medium", c?.at],
      ["jev", "super", undefined],
    ],
  );

  // was reads the active branch: back before run C, the latest run on the branch is B.
  await pi.session.navigateTree(userEntry(pi, 2), { summarize: false });
  await pi.command("was super");
  const branch = { source: "correction", tier: "super", refers: b?.at };
  assert.deepEqual(fields(entriesOf(pi, LEVEL_ENTRY).at(-1), branch), branch);

  // Run D has a tool turn. Its continuation hits a usage limit that Pi retries, and the retry goes
  // to the level's next model, which answers: still one record, naming that model. Jev says SUPER,
  // the level of run C, the latest response, so no hold moves it.
  world.jev.answer(JEV.super);
  const codex = world.faux("openai-codex-2");
  codex.respond(
    fauxAssistantMessage([fauxToolCall("read", { path: "zebra.txt" }, { id: "read-1" })], { stopReason: "toolUse" }),
    failure("429 Too Many Requests: usage limit reached"),
  );
  const beforeD = world.refCounts();
  await pi.prompt("Read the zebra file and say what it holds");
  assert.equal(pi.eventsOf("auto_retry_start").length, 1, "Pi retried the continuation");
  const d = runRecords(pi).at(-1);
  assert.equal(runRecords(pi).length, 4, "one record for the run, not one per turn or response");
  const answeredBy = { source: "jev", tier: "super", ref: KIMI_REF };
  assert.deepEqual(fields(d, answeredBy), answeredBy);
  assert.equal(answered(pi), KIMI_REF);
  const afterD = world.refCounts();
  const runD = (ref: string): number => (afterD[ref] ?? 0) - (beforeD[ref] ?? 0);
  assert.deepEqual([runD(PERSONAL.super), runD(KIMI_REF)], [2, 1], "astra took the tool turn and the failed continuation, Kimi the retry");

  // No record holds the prompts' text, or a digest of it.
  const recorded = JSON.stringify(entriesOf(pi, LEVEL_ENTRY));
  assert.doesNotMatch(recorded, /zebra/i);
  assert.doesNotMatch(recorded, /[A-Za-z0-9+/]{43}=/);
  // The footer's level item has its own key, smart-router-level, and the pin's key never carried text.
  assert.deepEqual([...new Set(pi.ui.statusLog.filter((item) => item.text !== undefined).map((item) => item.key))], ["smart-router-level"]);
  assert.equal(pi.ui.status(), undefined);
});

test("L8 the risky floor raises a Jev LOW to HIGH, and a tag overrides it", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  const risky = "Unstage the generated files and git rm the build directory";
  world.jev.answer(JEV.low);
  await pi.prompt(risky);
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(pi.ui.status(LEVEL_KEY), "personal HIGH → gpt-6.1-sol (floor)");
  const floor = { source: "floor", trigger: "destructive-git", asked: "low", tier: "high" };
  assert.deepEqual(fields(runRecords(pi).at(-1), floor), floor);
  assert.equal((runRecords(pi).at(-1)?.jev as { readonly choice?: unknown } | undefined)?.choice, "low", "Jev said LOW");
  // Tagged, the same text goes where the tag says, down from HIGH at once.
  await pi.prompt(`${risky} #low`);
  assert.equal(answered(pi), PERSONAL.low);
  assert.equal(pi.ui.status(LEVEL_KEY), "personal LOW → gpt-6-luna (tag)");
  const tagged = { source: "tag", tag: "low", tier: "low", trigger: undefined };
  assert.deepEqual(fields(runRecords(pi).at(-1), tagged), tagged);
});

test("L9 a version 1 roster keeps its history and status text byte-identical", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.prompt(PROMPTS.complex);
  await pi.prompt(PROMPTS.planning);
  await pi.prompt(PROMPTS.plain);
  const untimed = (text: string): string => text.replace(/\b\d\d:\d\d:\d\d\b/g, "<time>").replace(/loaded at \d\d:\d\d\b/, "loaded at <time>");
  await pi.command("history");
  assert.equal(
    untimed(notice(pi, /routing decisions/)),
    [
      "pi-smart-router: the last 3 routing decisions, oldest first:",
      "  <time> smart-router/auto user: engineer → cloud-a/m (signal:complex, triage:keyword_frontier)",
      "  <time> smart-router/auto user: architect → codex-like/m (signal:planning, planning:plan-words)",
      "  <time> smart-router/auto user: architect → codex-like/m (hold:sticky, triage:no_fast_path)",
    ].join("\n"),
  );
  await pi.command("status");
  assert.equal(
    untimed(notice(pi, /^pi-smart-router status/)),
    [
      "pi-smart-router status",
      `Roster: ${join(world.agentDir, "smart-router.json")}: valid, loaded at <time>`,
      `Selection: smart-router/auto, thinking ${pi.session.thinkingLevel}`,
      "Pin: off",
      "Roles on this host, cheapest first:",
      "  local (the local role): local-a/m ok",
      "  worker: cloud-b/m ok",
      "  coder: cloud-c/m ok",
      "  engineer: cloud-a/m ok",
      "  architect: codex-like/m ok",
      "Routing: default worker, trivial worker, complex engineer, planning architect; fallback engineer → coder",
      "Last decision: <time> smart-router/auto user: architect → codex-like/m (hold:sticky, triage:no_fast_path)",
      "The pin covers the model only. Still able to send data off this machine: Pi's own /share, /export and /bug.",
    ].join("\n"),
  );
  // A version 1 run has no level: no record, no scope entry, no footer item, and Jev is never asked,
  // though Pi's registry holds a classifier.
  assert.deepEqual(entriesOf(pi, LEVEL_ENTRY), []);
  assert.deepEqual(entriesOf(pi, SCOPE_ENTRY), []);
  assert.equal(pi.ui.statusLog.some((item) => item.key === "smart-router-level"), false);
  assert.deepEqual(world.jev.calls, []);
});

test("1. under a version 2 roster, both models declare limits from every level of both scopes and the local role, whichever scope a session starts in", TIMEOUT, async (t) => {
  const world = levelsWorld(t, {
    fleet: levelsFleet({
      // The smallest output budget is a personal level's, the smallest window a work level's.
      [PERSONAL.low]: { contextWindow: 200_000, maxTokens: 32_000 },
      [WORK.low]: { contextWindow: 100_000, maxTokens: 64_000 },
      // A later candidate is no level's model while the one before it is available.
      "openrouter/deepseek/deepseek-v4.1-flash-1017": { contextWindow: 50_000, maxTokens: 8_000 },
      // The local model is smaller than any of auto's, and auto never routes to it.
      "local-a/m": { contextWindow: 20_000, maxTokens: 4_000 },
    }),
  });
  const declared = (pi: Pi): unknown[][] =>
    VIRTUAL_IDS.map((id) => {
      const model = pi.model(`smart-router/${id}`);
      return [id, model.contextWindow, model.maxTokens];
    });
  const expected = [
    ["auto", 100_000, 32_000],
    ["local", 20_000, 4_000],
  ];
  const pi = await world.start({ persisted: true, select: "smart-router/auto" });
  assert.deepEqual(declared(pi), expected, "in a personal session");
  await pi.command("scope work");
  await pi.runtime.newSession();
  await pi.command("scope");
  assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope work (entry).");
  assert.deepEqual(declared(pi), expected, "in a work session, by a fresh load of the router");
  await pi.command("reload");
  assert.doesNotMatch(notice(pi, /^pi-smart-router: reloaded/), /registered both models again/, "and reading the roster again changes nothing");
});
