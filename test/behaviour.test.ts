// The behaviour suite: the router inside Pi 1.5's own runtime from npm. Test-only; never shipped.
// It runs only sandboxed: in the offline Nix build, or under sandbox-exec through
// `npm run check:sandbox`; ./support/sandboxed.ts, imported first, refuses anything else before
// Pi's runtime is evaluated.
//
// The numbered tests are the scenarios of design §8.2. The others check how a goal-x-style auditor
// routes (§5.1) and the refusal on an upstream Pi without the fork's bounded session reads. Each
// asserts which faux provider received each request, with the provider's call count;
// ./support/host.ts describes the harness. The local-only pin of earlier versions has been
// removed, with no trace left: L4 checks that PI_SMART_ROUTER_LOCAL_ONLY is ignored and shows
// nothing, and C13 that a session an earlier version pinned routes by level and shows nothing.
//
// Scenarios 6 to 9, 11 and 26, and L5, L6 and L10, once showed the guards that kept a pinned or
// work-scope session off a model picked by hand. Since John's decision of 2026-11-16 that a manual
// choice always wins, they show the opposite in Pi's own runtime: the model picked by hand stays
// selected and receives the request, whole, and the router's own two models still route only
// inside their policies.
//
// The L tests are the four levels' scenarios, the behaviour-suite list of the Jev-levels design, on
// version 2 rosters shaped like Hera's: both Codex accounts, OpenRouter and a local model, with
// Jev faked by a classifier provider registered through Pi's provider `classifiers` hook. L9
// checks that a version 1 roster's texts did not change. The C tests run the weighted demand and
// the cost rule in Pi's own runtime, on level models priced as John's are.
import "./support/sandboxed.ts";

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createBashToolDefinition, estimateTokens, SessionManager } from "@earendil-works/pi-coding-agent";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import type { RoutingRegistry } from "../src/cache-optimizer.ts";
import { EFFORT_KEY, ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY, ROUTING_REGISTRY_KEY, SCOPE_ENTRY, SLOT_KEY, VIRTUAL_IDS } from "../src/constants.ts";
import { runCost } from "../src/cost.ts";
import type { Rates, Workload } from "../src/cost.ts";
import type { Owner, Slot } from "../src/owners.ts";
import type { Limits, Router } from "../src/router.ts";
import type { SurvivalTable } from "../src/settings.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { keepsSystemPrompt } from "./support/co.ts";
import { fixture } from "./support/fixtures.ts";
import { ENV_PIN, PIN_ENTRY } from "./support/legacy.ts";
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
import type { Faux, FauxCall, FauxSpec, JevCall, Pi, RosterJsonV2, WorldOptions } from "./support/host.ts";

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

test("6. on smart-router/local: a cloud model set by hand stays selected, and its prompt reaches that model", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
  const said = pi.ui.notices.length;
  await pi.session.setModel(pi.model("cloud-a/m"));
  assert.equal(pi.selection(), "cloud-a/m", "the set is kept");
  await pi.prompt(PROMPTS.plain);
  assert.equal(pi.lastAssistant()?.stopReason, "stop", pi.lastAssistant()?.errorMessage);
  assert.equal(pi.lastAssistant()?.provider, "cloud-a");
  assert.deepEqual(called(world.counts()), { "cloud-a": 1 });
  assert.equal(pi.selection(), "cloud-a/m");
  assert.deepEqual(pi.ui.notices.slice(said), [], "and the router said nothing about it");
  // Chosen by hand again, smart-router/local routes to the local model.
  await pi.session.setModel(pi.model("smart-router/local"));
  await pi.prompt(PROMPTS.plain);
  assert.deepEqual(called(world.counts()), { "cloud-a": 1, "local-a": 1 });
});

test("7. from smart-router/local with a forced cloud selection, a custom-triggered run goes to that model: nothing is switched at turn_start", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
  pi.force("cloud-a/m");
  await pi.custom();
  assert.deepEqual(called(world.counts()), { "cloud-a": 1 });
  assert.equal(pi.lastAssistant()?.provider, "cloud-a");
  assert.equal(pi.selection(), "cloud-a/m");
});

for (const order of ["before", "after"] as const) {
  for (const trigger of ["a typed prompt", "a custom-triggered run"] as const) {
    test(`8. on smart-router/local against a competitor loaded ${order} the router, ${trigger}: the competitor's selection stands, and the router neither switches back nor locks`, TIMEOUT, async (t) => {
      const world = new World(t);
      const pi = await world.start({ select: "smart-router/local", [order]: [COMPETITOR_ENTRY] });
      if (trigger === "a typed prompt") {
        await pi.prompt(PROMPTS.plain);
      } else {
        pi.force("cloud-a/m");
        await pi.custom();
      }
      // The router cannot tell an extension's selection from John's, and it answers neither.
      assert.equal(pi.selection(), "codex-like/m", "the competitor switched the selection to codex-like, and it stayed there");
      assert.deepEqual(called(world.counts()), { "codex-like": 1 });
      assert.equal(pi.lastAssistant()?.provider, "codex-like");
      const codex = world.faux("codex-like");
      assert.ok(codex.calls.every((call) => call.payload !== null), "its request was sent whole");
      assert.deepEqual(pi.ui.saw(/locked|was not kept|not sent|was stopped|emptied/), []);
      assert.notEqual(pi.ui.status("smart-router"), "local models: locked");
    });
  }
}

test("9. from smart-router/local with a forced cloud selection over the threshold: compaction proceeds on that model, and so does the run", TIMEOUT, async (t) => {
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
  pi.force("cloud-a/m");
  await pi.custom();
  const starts = pi.eventsOf("compaction_start");
  const ends = pi.eventsOf("compaction_end");
  assert.ok(starts.some((event) => event.reason === "threshold"), "the pre-run threshold check started a compaction");
  assert.equal(ends.length, starts.length);
  assert.ok(
    ends.every((event) => !event.aborted && event.result !== undefined),
    "and the router cancelled none",
  );
  assert.deepEqual(pi.ui.saw(/compaction was cancelled/), []);
  assert.equal(pi.selection(), "cloud-a/m");
  assert.ok(cloud.calls.some((call) => call.summary), "the summary was asked of the model picked by hand");
  assert.ok(cloud.calls.some((call) => !call.summary), "and so was the run");
  assert.equal(pi.lastAssistant()?.provider, "cloud-a");
  const result = await pi.session.compact();
  assert.match(result.summary, /ok from cloud-a\/m/, "manual compaction proceeds too");
  assert.equal(world.faux("local-a").callCount, 0, JSON.stringify(world.counts()));
});

test("10. on smart-router/local, compaction summarizes on the local model", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
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

test("11. from smart-router/local with a forced cloud selection, navigation with a summary proceeds on that model, and so does navigation without one", TIMEOUT, async (t) => {
  const world = new World(t);
  const pi = await world.start({ select: "smart-router/local" });
  await pi.prompt("first");
  await pi.prompt("second");
  const target = userEntry(pi, 0);
  const leaf = pi.session.sessionManager.getLeafId();
  pi.force("cloud-a/m");
  const summarized = await pi.session.navigateTree(target, { summarize: true });
  assert.equal(summarized.cancelled, false);
  assert.notEqual(pi.session.sessionManager.getLeafId(), leaf, "the navigation with a summary moved the leaf");
  assert.deepEqual(pi.ui.saw(/the navigation with a summary was cancelled/), []);
  const cloud = world.faux("cloud-a");
  assert.ok(cloud.callCount >= 1 && cloud.calls.every((call) => call.summary), "the branch summary was asked of the model picked by hand");
  assert.ok(typeof leaf === "string");
  const plain = await pi.session.navigateTree(leaf, { summarize: false });
  assert.equal(plain.cancelled, false);
  assert.equal(pi.session.sessionManager.getLeafId(), leaf, "the navigation without a summary moved the leaf back");
  assert.equal(world.faux("local-a").callCount, 2, "the two prompts, and nothing since");
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
    ["codex-like/m", "cloud-b/m", "local-a/m"],
    "nothing holds a session by time: the plain prompt goes to its own role, the worker",
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

test("26. control: idle warming arms and sends the request's content again", TIMEOUT, async (t) => {
  const world = new World(t, WARMING);
  const pi = await world.start({ select: "codex-like/m" });
  await pi.prompt(PROMPTS.plain);
  await until(() => warmCalls(world).length > 0, 10_000, "a warm request");
  const [warm] = warmCalls(world);
  assert.ok(warm !== undefined && warm.payload !== null && typeof warm.payload === "object", "the warm request carries content");
  assert.match(JSON.stringify(warm.payload), /how are you today/);
});

test("26. from smart-router/local, a Codex-like model selected at turn_start is sent as it is: its payload is whole, and the router does not stop the warming Pi wanted", TIMEOUT, async (t) => {
  const world = new World(t, WARMING);
  const race = racer();
  const pi = await world.start({ select: "smart-router/local", extensions: [race.extension] });
  race.force = () => pi.force("codex-like/m");
  await pi.custom();
  race.force = undefined;
  const codex = world.faux("codex-like");
  assert.equal(codex.callCount, 1, "the forced request reached the provider");
  assert.ok(codex.calls[0]?.payload !== null && typeof codex.calls[0]?.payload === "object", "with its payload");
  assert.deepEqual(pi.ui.saw(/the request was emptied and the run stopped/), []);
  await until(() => warmCalls(world).length > 0, 10_000, "a warm request");
  const [warm] = warmCalls(world);
  assert.ok(warm !== undefined && warm.payload !== null && typeof warm.payload === "object", "the warm request carries content");
  assert.notEqual(pi.session.cacheWarmingStatus?.reason, "stopped by extension");
  assert.notEqual(pi.session.cacheWarmingStatus?.extensionOverride, true, "no extension overrode Pi's decision");
});

test("26. from smart-router/local, when a later extension asks for warming, the warm requests carry their content: the router empties none", TIMEOUT, async (t) => {
  const world = new World(t, WARMING);
  const race = racer();
  const insist: InlineExtension = { name: "insist", factory: (api) => void api.on("cache_warming_decision", () => ({ action: "warm" })) };
  const pi = await world.start({ select: "smart-router/local", extensions: [race.extension, insist] });
  race.force = () => pi.force("codex-like/m");
  await pi.custom();
  race.force = undefined;
  await until(() => warmCalls(world).length > 0, 10_000, "a warm request");
  const codex = world.faux("codex-like");
  assert.ok(codex.calls.length >= 2);
  assert.ok(
    codex.calls.every((call) => call.payload !== null && typeof call.payload === "object"),
    "every request reached the provider whole, warm requests included",
  );
});

test("§5.1. a goal-x-style auditor on the parent's runtime routes with the parent's context, on the selection it inherits", TIMEOUT, async (t) => {
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
  const auto = await audit(parent.selection());
  assert.equal(`${auto?.provider}/${auto?.model}`, "cloud-b/m");
  // The parent selects smart-router/local by hand, and an auditor started now inherits it and goes local.
  await parent.session.setModel(parent.model("smart-router/local"));
  const local = await audit(parent.selection());
  assert.equal(parent.selection(), "smart-router/local");
  assert.equal(`${local?.provider}/${local?.model}`, "local-a/m", "on the parent's smart-router/local, the auditor goes local");
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
 * levels take only the work account; the local role serves smart-router/local; Jev is
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
function levelsWorld(t: TestContext, options: { readonly roster?: RosterJsonV2; readonly fleet?: readonly FauxSpec[]; readonly compaction?: (typeof BASE_SETTINGS)["compaction"] } = {}): World {
  return new World(t, {
    roster: options.roster ?? rosterV2(),
    multiPass: LABELS,
    fleet: options.fleet ?? levelsFleet(),
    settings: { ...BASE_SETTINGS, ...(options.compaction === undefined ? {} : { compaction: options.compaction }), defaultProvider: "smart-router", defaultModel: "auto" },
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

test("L1 an untagged run rated lower moves down at once; a tag routes at once, never reaches the payload, and survives a resend", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  world.jev.answer(JEV.super);
  await pi.prompt("Survey the options for the session store");
  assert.equal(answered(pi), PERSONAL.super);
  // An untagged message that Jev puts at HIGH goes to HIGH's model, though SUPER's answered a moment ago.
  world.jev.answer(JEV.high);
  await pi.prompt("Check the error paths");
  assert.equal(answered(pi), PERSONAL.high, "nothing holds a session by time");
  assert.equal(
    await lastDecision(pi),
    "smart-router/auto user: high → openai-codex-2/gpt-6.1-sol (jev, triage:no_fast_path) [personal HIGH → gpt-6.1-sol (demand 1.6; cost unknown)]",
    "nothing holds a session by time: the blend of 80% HIGH and the heuristics is 1.6; these fakes carry no prices, so a missing figure is said: cost unknown",
  );

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
  assert.equal(await lastDecision(pi), "smart-router/auto user: high → openai-codex-2/gpt-6.1-sol (tag, triage:no_fast_path) [personal HIGH → gpt-6.1-sol (tag)]");
  const tagged = { source: "tag", tag: "high", tier: "high", jev: { late: true } };
  assert.deepEqual(fields(runRecords(pi).at(-1), tagged), tagged);

  // pi-idle-check resends the text without its tag: the run keeps the tag's level, where Jev would
  // now say SUPER, and Jev is not asked again.
  world.jev.answer(JEV.super);
  await pi.resend("Fix the parser");
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(world.jev.calls.length, 3, "no second classifier call");
  assert.equal(await lastDecision(pi), "smart-router/auto user: high → openai-codex-2/gpt-6.1-sol (tag, triage:no_fast_path) [personal HIGH → gpt-6.1-sol (tag)]");
  const resent = { source: "tag", tag: "high", tier: "high", jev: undefined };
  assert.deepEqual(fields(runRecords(pi).at(-1), resent), resent);
  assert.deepEqual(called(world.counts()), { "openai-codex-2": 4 });
});

/** A session on smart-router/auto whose conversation, 40,000 tokens, came last from MEDIUM's model; LOW's declares a 32k window. */
async function oversized(world: World): Promise<Pi> {
  const codex = world.faux("openai-codex-2");
  const sessionManager = history(world, "smart-router/auto", [["Load the fixtures", response(codex, { id: "gpt-6.1-terra", tokens: 40_000, timestamp: Date.now() - 1_000 })]]);
  return world.start({ sessionManager });
}

/** The requests of a trace, in order, as [model, summary or run]. */
const requestsOf = (trace: World["trace"]): Array<[string, string]> =>
  trace.flatMap((entry) => (entry.kind === "call" ? [[entry.call.ref, entry.call.summary ? "summary" : "run"] as [string, string]] : []));

test("L2 a tagged level too small for the conversation is compacted for, not stepped past", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: levelsFleet({ [PERSONAL.low]: { contextWindow: 32_000 } }) });
  const pi = await oversized(world);
  const mark = world.trace.length;
  await pi.prompt("Rename the helper #low");
  // Pi checks the request against the model it is routed to, finds the conversation over LUNA's
  // threshold, and compacts first: the summary goes direct to the latest responder, MEDIUM's model.
  assert.deepEqual(
    requestsOf(traceFrom(world, mark)),
    [
      [PERSONAL.medium, "summary"],
      [PERSONAL.low, "run"],
    ],
    "with compaction enabled a too-small model is compacted for: a summary before the run's first request, which LOW's model takes",
  );
  assert.deepEqual(
    pi.eventsOf("compaction_start").map((event) => event.reason),
    ["threshold"],
    "with compaction enabled a too-small model is compacted for",
  );
  assert.equal(answered(pi), PERSONAL.low, "with compaction enabled a too-small model is compacted for: the tagged level's model answered");
  assert.deepEqual(pi.ui.saw(/can take this run/), [], "with compaction enabled a too-small model is compacted for: no step-up, so no notice");
  assert.equal(pi.ui.status(LEVEL_KEY), "personal LOW → gpt-6-luna (tag)");
  // The run's request was routed first, to LOW; Pi then found it over LUNA's threshold, and the
  // summary went direct to the model that answered last.
  await pi.command("history 2");
  assert.deepEqual(
    notice(pi, /routing decisions/)
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^ {2}\d\d:\d\d:\d\d /, "")),
    [
      "smart-router/auto user: low → openai-codex-2/gpt-6-luna (tag, triage:keyword_economical) [personal LOW → gpt-6-luna (tag)]",
      "smart-router/auto direct: medium → openai-codex-2/gpt-6.1-terra (direct:previous)",
    ],
    "with compaction enabled a too-small model is compacted for",
  );
  // A record names a step-up only when there was one.
  const record = { source: "tag", tag: "low", need: "low", tier: "low", steppedUp: undefined, ref: PERSONAL.low };
  assert.deepEqual(fields(runRecords(pi).at(-1), record), record, "with compaction enabled a too-small model is compacted for");
});

test("L2b with compaction disabled, a tagged level steps up, with a notice, when the conversation does not fit", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: levelsFleet({ [PERSONAL.low]: { contextWindow: 32_000 } }), compaction: { enabled: false } });
  const pi = await oversized(world);
  const mark = world.trace.length;
  await pi.prompt("Rename the helper #low");
  assert.deepEqual(requestsOf(traceFrom(world, mark)), [[PERSONAL.medium, "run"]], "with compaction disabled, MEDIUM's model takes the run and nothing is summarized");
  assert.equal(answered(pi), PERSONAL.medium);
  assert.equal(notice(pi, /can take this run/), "pi-smart-router: no LOW model can take this run, so it goes to MEDIUM (gpt-6.1-terra).");
  assert.equal(pi.ui.status(LEVEL_KEY), "personal LOW → gpt-6.1-terra (tag)", "the footer names the level the prompt needs, beside the step-up notice");
  assert.equal(await lastDecision(pi), "smart-router/auto user: medium → openai-codex-2/gpt-6.1-terra (step-up, triage:keyword_economical) [personal LOW → gpt-6.1-terra (tag)]", "history in the footer's form: the level the run needs, and the model that took it after the arrow");
  const record = { source: "tag", tag: "low", need: "low", tier: "medium", steppedUp: true, ref: PERSONAL.medium };
  assert.deepEqual(fields(runRecords(pi).at(-1), record), record);
  assert.deepEqual(pi.eventsOf("compaction_start"), [], "compaction is disabled");
  assert.deepEqual(world.refCounts(), { [PERSONAL.medium]: 1 }, "LOW's model received nothing, and nothing was compacted");
});

test("L3 untagged runs follow the blend with Jev; an unsure close call stays lower; failure, refusal and timeout leave the heuristics to decide", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  const footer = (): string | undefined => pi.ui.status(LEVEL_KEY);
  world.jev.fail("System One API error (500): upstream connect error");
  await pi.prompt(PROMPTS.trivial);
  assert.equal(answered(pi), PERSONAL.low);
  assert.equal(footer(), "personal LOW → gpt-6-luna (demand 0.5, jev error; cost unknown)", "without an answer the heuristics decide alone: a trivial prompt is LOW; with no usage yet a missing figure is said: cost unknown");
  // pi-ai has no refusal branch: OpenRouter's refusal reaches the router as an error.
  world.jev.fail('System One API error (403): {"error":{"message":"The request was refused"}}');
  await pi.prompt(PROMPTS.plain);
  assert.equal(answered(pi), PERSONAL.medium);
  assert.equal(footer(), "personal MEDIUM → gpt-6.1-terra (demand 0.9, jev error; cost unknown)", "without an answer the heuristics decide alone: a plain prompt is MEDIUM; these fakes carry no prices, so a missing figure is said: cost unknown");
  // MEDIUM leads HIGH by little: an unsure Jev no longer takes the higher of two close leaders.
  world.jev.answer({ low: 0.05, medium: 0.45, high: 0.4, super: 0.1 });
  await pi.prompt("Walk me through the cache layer");
  assert.equal(answered(pi), PERSONAL.medium, "an unsure Jev no longer takes the higher of two close leaders: the blend is 1.34, MEDIUM");
  assert.equal(footer(), "personal MEDIUM → gpt-6.1-terra (demand 1.3; cost unknown)", "an unsure Jev no longer takes the higher of two close leaders: the blend is 1.34; these fakes carry no prices, so a missing figure is said: cost unknown");
  // A classifier that answers nothing: the run goes on with the heuristics' level once timeoutMs passes.
  world.jev.hang();
  const started = Date.now();
  await pi.prompt(PROMPTS.complex);
  const waited = Date.now() - started;
  assert.ok(waited < 1_500, `the run went on after ${waited} ms`);
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(footer(), "personal HIGH → gpt-6.1-sol (demand 1.8, jev timeout; cost unknown)", "without an answer the heuristics decide alone: a complex prompt here is HIGH, 1.77; these fakes carry no prices, so a missing figure is said: cost unknown");
  // A sure answer carries four fifths of the blend, where the heuristics alone would say MEDIUM.
  world.jev.answer(JEV.super);
  await pi.prompt("Hello again");
  assert.equal(answered(pi), PERSONAL.super);
  assert.equal(footer(), "personal SUPER → gpt-6-astra (demand 2.3; cost unknown)", "the blend of 80% SUPER and the heuristics is 2.25, SUPER; these fakes carry no prices, so a missing figure is said: cost unknown");
  // A choice outside the four tiers is a failure too.
  world.jev.answer(JEV.low, "other");
  await pi.prompt(PROMPTS.planning);
  assert.equal(answered(pi), PERSONAL.high, "the heuristics alone rate a planning prompt HIGH, not SUPER: 1.81");
  assert.equal(footer(), "personal HIGH → gpt-6.1-sol (demand 1.8, jev malformed; cost unknown)", "the heuristics alone rate a planning prompt HIGH, not SUPER: 1.81; these fakes carry no prices, so a missing figure is said: cost unknown");

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
      ["heuristics", "low", "error"],
      ["heuristics", "medium", "error"],
      ["jev", "medium", "medium"],
      ["heuristics", "high", "timeout"],
      ["jev", "super", "super"],
      ["heuristics", "high", "malformed"],
    ],
    "without an answer the heuristics decide alone; an unsure close call stays at the blend's MEDIUM; a planning prompt alone is HIGH",
  );
});

test("L4 no classifier call on local, for a steer, or without a classifier; PI_SMART_ROUTER_LOCAL_ONLY is ignored and shows nothing", TIMEOUT, async (t) => {
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

  await t.test("the environment switch is ignored and shows nothing, and the run goes by level", async (t) => {
    /** Notices that speak of the switch or the pin: John's ruling of 2026-11-18 leaves no trace of either. */
    const pinNotices = (): unknown[] => pi.ui.saw(/LOCAL_ONLY|\bpin\b|pinned/i);
    const world = levelsWorld(t);
    process.env[ENV_PIN] = "1";
    const pi = await world.start({ select: "smart-router/auto" });
    delete process.env[ENV_PIN];
    assert.equal(pi.selection(), "smart-router/auto", "the variable selects nothing");
    assert.deepEqual(pinNotices(), [], "nothing is shown for the variable at session start");
    // smart-router/auto routes by level: Jev is asked, and a LOW run goes to the LOW model, not a local one.
    world.jev.answer(JEV.low);
    await pi.prompt("Rename the helper");
    assert.equal(answered(pi), PERSONAL.low);
    assert.equal(world.jev.calls.length, 1, "Jev was asked");
    await pi.prompt("Fix the parser #high");
    assert.equal(answered(pi), PERSONAL.high, "a tag sets its run's level");
    assert.deepEqual(pinNotices(), [], "nor at the prompts");
    assert.equal(world.faux("local-a").callCount, 0, "nothing went to the local model");
    await pi.runtime.newSession();
    assert.deepEqual(pinNotices(), [], "nor in a new session of the process");
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
    assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (demand 0.9; cost unknown)", "without a classifier the heuristics decide alone: 0.89, MEDIUM; with no usage yet a missing figure is said: cost unknown");
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

  await t.test("an entry: work at once, carried into a fork and /new, and kept at resume", async (t) => {
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
    // The session's last selection is an OpenRouter model, as after a /model there.
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

    // Resumed, the work session's entry holds, and the selection it restored is kept: the model
    // picked by hand answers, and smart-router/auto, chosen again, goes to the work account.
    await pi.runtime.switchSession(work);
    assert.equal(pi.selection(), "openrouter/z-ai/glm-5.3");
    assert.deepEqual(pi.ui.saw(/was switched to smart-router\/auto|was not kept/), []);
    await pi.command("scope");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope work (entry).");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), "openrouter/z-ai/glm-5.3");
    await pi.session.setModel(pi.model("smart-router/auto"));
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), WORK.medium);
    // Resumed, the personal session is personal.
    await pi.runtime.switchSession(personal);
    await pi.command("scope");
    assert.equal(notice(pi, /^pi-smart-router: scope/), "pi-smart-router: scope personal (default).");
    await pi.prompt(PROMPTS.plain);
    assert.equal(answered(pi), PERSONAL.medium);
    assert.equal(world.faux("openrouter").callCount, 1, "OpenRouter answered only the one run on the model picked by hand");
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

test("L6 in work scope a hand-picked OpenRouter model stays selected and answers, and smart-router/auto's runs reach only the work account", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  await pi.command("scope work");
  const said = pi.ui.notices.length;
  // A model picked by hand outside the work account is kept, and answers.
  await pi.session.setModel(pi.model("openrouter/z-ai/glm-5.3"));
  assert.equal(pi.selection(), "openrouter/z-ai/glm-5.3");
  await pi.prompt("Check the error paths");
  assert.equal(answered(pi), "openrouter/z-ai/glm-5.3");
  // So is one of the work account's.
  await pi.session.setModel(pi.model(WORK.high));
  assert.equal(pi.selection(), WORK.high);
  await pi.prompt("Check the error paths");
  assert.equal(answered(pi), WORK.high);
  assert.deepEqual(pi.ui.notices.slice(said), [], "and the router said nothing about either");
  assert.deepEqual(world.jev.calls, [], "nor asked Jev about a message it does not route");
  await pi.session.setModel(pi.model("smart-router/auto"));
  const outside = { ...world.counts() };

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
  const routed = world.counts();
  assert.deepEqual(
    Object.keys(routed).filter((provider) => routed[provider] !== (outside[provider] ?? 0)),
    ["openai-codex-3"],
    "the router's own runs reached nothing but the work account",
  );

  // A selection written past model_select is sent as it is too: a prompt, and a run without one.
  pi.force("openrouter/z-ai/glm-5.3");
  await pi.prompt("Ship it");
  assert.equal(answered(pi), "openrouter/z-ai/glm-5.3");
  await pi.custom();
  assert.equal(pi.selection(), "openrouter/z-ai/glm-5.3");
  assert.equal(answered(pi), "openrouter/z-ai/glm-5.3");
  assert.equal(world.faux("openrouter").callCount, 3, "the three runs on the model picked by hand, and no other");
  assert.deepEqual(pi.ui.saw(/was not kept|not sent|was stopped|emptied|locked/), []);
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
  const { demand, ...rest } = a ?? {};
  assert.deepEqual(rest, {
    v: 1,
    at: a?.at,
    scope: "personal",
    source: "jev",
    tier: "medium",
    need: "medium",
    keyword: { signal: "default", reason: "triage:no_fast_path" },
    jev: { model: JEV_MODEL, choice: "medium", probabilities: JEV.medium, confidence: 0.8, ms },
    cost: { outcome: "unknown", why: "no usage yet" },
    ref: PERSONAL.medium,
  }, "run A's record, with its cost; with no usage yet a missing figure is said: cost unknown");
  const value = (demand as { readonly value?: unknown } | undefined)?.value;
  assert.ok(typeof value === "number" && Math.abs(value - 1.01) < 0.01, `the record holds the run's demand, the blend of 80% MEDIUM and the heuristics: ${String(value)}`);
  assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (demand 1.0; cost unknown)", "the blend of 80% MEDIUM and the heuristics is 1.01; with no usage yet a missing figure is said: cost unknown");
  // A command and a run without a prompt add no record. That run shows a footer of its own: the
  // level its session last needed, the model its choice took, and "run".
  await pi.command("status");
  await pi.custom();
  assert.equal(runRecords(pi).length, 1);
  assert.equal(
    pi.ui.status(LEVEL_KEY),
    "personal MEDIUM → gpt-6.1-terra (run; cost unknown)",
    "a run without a prompt shows its own footer at its first request (the controller's footer ruling, Task 11 fix round 1): run A's MEDIUM, terra, and the cost unknown, as this runtime's level models carry no price",
  );
  // Run B, tagged.
  await pi.prompt("Answer the zebra question #high");
  assert.equal(runRecords(pi).length, 2);
  const b = runRecords(pi)[1];
  const tagged = { scope: "personal", source: "tag", tag: "high", tier: "high", ref: PERSONAL.high };
  assert.deepEqual(fields(b, tagged), tagged);
  // Each record sits after its run's user message, which lacks the tag the record keeps.
  const trail = pi.session.sessionManager.getEntries().flatMap((entry) => {
    if (entry.type === "custom" && entry.customType === LEVEL_ENTRY) return [`record ${String((entry.data as Record<string, unknown>).source)}`];
    if (entry.type !== "message" || entry.message.role !== "user") return [];
    const { content } = entry.message;
    return [typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
  });
  assert.deepEqual(trail, ["Tidy the zebra notes", "record jev", "Answer the zebra question", "record tag"]);

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
  // the level of run C, the latest response.
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
  // The footer's level item has its own key, smart-router-level, and the effort item its own,
  // smart-router-effort (John, 2026-11-18: thinking effort exactly as upstream, which the footer
  // names); no other key ever carried text, and neither holds a prompt's text.
  const shown = pi.ui.statusLog.filter((item) => item.text !== undefined);
  assert.deepEqual([...new Set(shown.map((item) => item.key))], ["smart-router-level", "smart-router-effort"], "the level item, then from the first routed request on the effort item");
  assert.doesNotMatch(JSON.stringify(shown), /zebra/i, "no footer item holds a prompt's text");
  assert.equal(pi.ui.status("smart-router"), undefined, "the key the removed pin's item used is never set");
});

test("L8 the risky floor raises a Jev LOW to HIGH, and a tag overrides it", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const pi = await world.start({ select: "smart-router/auto" });
  const risky = "Unstage the generated files and git rm the build directory";
  world.jev.answer(JEV.low);
  await pi.prompt(risky);
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(pi.ui.status(LEVEL_KEY), "personal HIGH → gpt-6.1-sol (demand 0.7, floor; cost unknown)", "the blend of 80% LOW and the heuristics, 0.7, is raised to HIGH by the risky floor; with no usage yet a missing figure is said: cost unknown");
  const floor = { source: "floor", trigger: "destructive-git", need: "high", tier: "high" };
  assert.deepEqual(fields(runRecords(pi).at(-1), floor), floor);
  assert.equal((runRecords(pi).at(-1)?.jev as { readonly choice?: unknown } | undefined)?.choice, "low", "Jev said LOW");
  // Tagged, the same text goes where the tag says, down from HIGH at once.
  await pi.prompt(`${risky} #low`);
  assert.equal(answered(pi), PERSONAL.low);
  assert.equal(pi.ui.status(LEVEL_KEY), "personal LOW → gpt-6-luna (tag)");
  const tagged = { source: "tag", tag: "low", tier: "low", trigger: undefined };
  assert.deepEqual(fields(runRecords(pi).at(-1), tagged), tagged);
});

test("L9 a version 1 roster keeps its history and status text byte-identical, but for the removed pin's line, the egress line's opening and the thinking effort's line", TIMEOUT, async (t) => {
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
      "  <time> smart-router/auto user: worker → cloud-b/m (signal:default, triage:no_fast_path)",
    ].join("\n"),
  );
  await pi.command("status");
  assert.equal(
    untimed(notice(pi, /^pi-smart-router status/)),
    [
      "pi-smart-router status",
      `Roster: ${join(world.agentDir, "smart-router.json")}: valid, loaded at <time>`,
      `Selection: smart-router/auto, thinking ${pi.session.thinkingLevel}`,
      "Roles on this host, cheapest first:",
      "  local (the local role): local-a/m ok",
      "  worker: cloud-b/m ok",
      "  coder: cloud-c/m ok",
      "  engineer: cloud-a/m ok",
      "  architect: codex-like/m ok",
      "Routing: default worker, trivial worker, complex engineer, planning architect; fallback engineer → coder",
      "Last decision: <time> smart-router/auto user: worker → cloud-b/m (signal:default, triage:no_fast_path)",
      // John, 2026-11-18: thinking effort exactly as upstream, under a version 1 roster too. The
      // worker's model does not reason, so upstream's rule leaves the selected level (AR:280-286).
      "Thinking sent on the latest request: medium (as selected)",
      "Besides the models smart-router/auto and smart-router/local route to, these can send data off this machine: a model picked by hand with /model, which is sent as it is; Pi's own /share, /export and /bug.",
    ].join("\n"),
  );
  // A version 1 run has no level: no record, no scope entry, no footer item, and Jev is never asked,
  // though Pi's registry holds a classifier.
  assert.deepEqual(entriesOf(pi, LEVEL_ENTRY), []);
  assert.deepEqual(entriesOf(pi, SCOPE_ENTRY), []);
  assert.equal(pi.ui.statusLog.some((item) => item.key === "smart-router-level"), false);
  assert.deepEqual(world.jev.calls, []);
});

test("L10 where a session's scope reaches: the default goal-x auditor, a command-line fork, and pi-subagents children", TIMEOUT, async (t) => {
  await t.test("a scope an entry set: the default auditor routes in it, and pi --fork keeps it", async (t) => {
    const world = levelsWorld(t);
    const parent = await world.start({ persisted: true, select: "smart-router/auto" });
    await parent.command("scope work");
    await parent.prompt(PROMPTS.plain);
    assert.equal(answered(parent), WORK.medium);
    // goal-x's default auditor shares the parent's runtime, so its requests go through the parent's
    // route, with the parent's context and so its scope.
    const auditor = await auditorSession(world, parent, "smart-router/auto");
    t.after(() => auditor.dispose());
    await auditor.prompt(PROMPTS.plain);
    await auditor.waitForIdle();
    const audit = auditor.messages.filter((message): message is AssistantMessage => message.role === "assistant").at(-1);
    assert.equal(`${audit?.provider}/${audit?.model}`, WORK.medium);
    // pi --fork is SessionManager.forkFrom, which copies every entry of the session, the scope's too.
    const file = parent.session.sessionFile;
    assert.ok(file !== undefined);
    const forked = await world.start({ sessionManager: SessionManager.forkFrom(file, world.cwd, world.sessionDir), select: "smart-router/auto" });
    assert.deepEqual(scopeEntries(forked), [["work", "command"]]);
    await forked.prompt(PROMPTS.plain);
    assert.equal(answered(forked), WORK.medium);
    assert.equal(world.faux("openrouter").callCount, 0);
  });

  await t.test("a pi-subagents child starts with no entries, so a scope its parent's entry set does not reach it", async (t) => {
    const world = levelsWorld(t);
    const parent = await world.start({ select: "smart-router/auto" });
    await parent.command("scope work");
    const child = await world.start({ select: "openrouter/z-ai/glm-5.3" });
    await child.prompt(PROMPTS.plain);
    assert.equal(answered(child), "openrouter/z-ai/glm-5.3");
  });

  await t.test("under the latch, a child that loads the router is in work scope: its smart-router/auto goes to the work account, and a model it was given is kept, as in a child without the router", async (t) => {
    const world = levelsWorld(t);
    process.env[ENV_SCOPE] = "work";
    const routed = await world.start({ select: "smart-router/auto" });
    await routed.command("scope");
    assert.equal(notice(routed, /^pi-smart-router: scope/), "pi-smart-router: scope work (latch).");
    await routed.prompt(PROMPTS.plain);
    assert.equal(answered(routed), WORK.medium);
    // A child started on an explicit model keeps it, with the router or without.
    const given = await world.start({ select: "openrouter/z-ai/glm-5.3" });
    assert.equal(given.selection(), "openrouter/z-ai/glm-5.3");
    await given.prompt(PROMPTS.plain);
    assert.equal(answered(given), "openrouter/z-ai/glm-5.3");
    const bare = await world.start({ router: false, probe: false, select: "openrouter/z-ai/glm-5.3" });
    await bare.prompt(PROMPTS.plain);
    assert.equal(answered(bare), "openrouter/z-ai/glm-5.3");
    assert.equal(world.faux("openrouter").callCount, 2, "the two children on the explicit model, and no run of smart-router/auto");
  });
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

// ─── Demand and cost switching, in Pi's runtime ──────────────────────────────
//
// The C tests run the weighted demand and the cost rule in Pi's own runtime. Their level models
// carry John's prices (pricedLevelsFleet), and the faux replies report the usage a scenario scripts
// (response's `usage`), so that a footer's two costs can be worked out here, with runCost and the
// spec's leaving term, from the scenario's own figures: the conversation's size, what each model
// has cached, the run's shape, the horizon and the chance the current level is needed again. A
// model that answered within the last minute keeps its cache with the default table's first chance,
// 97%; the default run of 120 seconds, idle time included, falls in its second, 92%. A demand value
// comes from the heuristics as well as Jev, and is matched by its form only.

/** John's prices on the level models, dollars per million tokens (test/choose.test.ts). */
const PRICES: Readonly<Record<Tier, Model<Api>["cost"]>> = {
  low: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  medium: { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 },
  high: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  super: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
};

/** The level of each Codex model id. */
function tierOfId(id: string): Tier {
  const index = (CODEX_IDS as readonly string[]).indexOf(id);
  const tier = TIERS[index];
  if (tier === undefined) throw new Error(`no level model ${id}`);
  return tier;
}

/**
 * levelsFleet, with John's prices on the personal and work level models, which reason, as Codex
 * models do, so that a thinking level reaches them as it is; windows of 272,000 unless `limits`
 * gives a model another.
 */
function pricedLevelsFleet(limits: Readonly<Record<string, Partial<Limits>>> = {}): FauxSpec[] {
  return levelsFleet(limits).map((spec): FauxSpec => {
    if (spec.provider !== "openai-codex-2" && spec.provider !== "openai-codex-3") return spec;
    const models = (spec.models ?? []).map((entry) => (typeof entry === "string" ? entry : { ...entry, cost: PRICES[tierOfId(entry.id)] }));
    return { ...spec, reasoning: true, models };
  });
}

/** The default cache survival table (switching.cacheSurvival), which no roster here changes. */
const SURVIVAL: SurvivalTable = [
  [60, 0.97],
  [300, 0.92],
  [1200, 0.87],
  [1800, 0.79],
  [3600, 0.66],
  [7200, 0.5],
  [21600, 0.38],
  [86400, 0.11],
];

/** The run's shape with fewer than three runs measured: 5 requests, 800 output tokens, 1,500 tokens of growth, 120 seconds. */
const DEFAULT_SHAPE = { requests: 5, output: 800, growth: 1_500, seconds: 120 } as const;

const perToken = (tier: Tier): Rates => ({ input: PRICES[tier].input / 1e6, cacheRead: PRICES[tier].cacheRead / 1e6, output: PRICES[tier].output / 1e6 });

/** runCost for a level's model with `cached` tokens of the conversation, answered within the last minute (`warm`) or not since its cache was last forgotten. */
function expectedRun(tier: Tier, cached: number, warm: boolean, workload: Workload): number {
  return runCost({ ref: tier, tier, rates: perToken(tier), cached, idle: warm ? 1 : undefined, compacts: false }, workload, SURVIVAL);
}

/** What leaving the current model adds to another candidate (the spec): q · (1 − s) · Wc · (in_c − cr_c). */
function expectedLeaving(current: Tier, cached: number, again: number, survives: number): number {
  const rates = perToken(current);
  return again * (1 - survives) * cached * (rates.input - rates.cacheRead);
}

/** Dollars to the cent, as the footer writes them. */
const money = (dollars: number): string => `$${dollars.toFixed(2)}`;

/** Pi's estimate of a prompt, which the router adds to the conversation's size for a planned run. */
const promptSize = (text: string): number => estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: 0 });

/** A scripted reply that reports `cacheRead` tokens read from the cache, `input` tokens not, and `output`; no cache writes. */
function reply(codex: Faux, usage: { readonly input?: number; readonly cacheRead?: number; readonly output: number }): AssistantMessage {
  return response(codex, { usage: { input: usage.input ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: 0, output: usage.output } });
}

/** The footer, which must open with `head` followed by a demand: what it says after the demand. */
function afterDemand(pi: Pi, head: string): string {
  const footer = pi.ui.status(LEVEL_KEY) ?? "";
  const match = /^(.*) \(demand \d\.\d(.*)\)$/.exec(footer);
  assert.ok(match !== null && match[1] === head, `the footer "${footer}" opens with "${head} (demand"`);
  return match[2] ?? "";
}

/** The cost terms of the latest run's record. */
const costOf = (pi: Pi): Record<string, unknown> => (runRecords(pi).at(-1)?.cost ?? {}) as Record<string, unknown>;

/** The tokens of the conversation astra caches in the warm sessions, and the output of every scripted answer. */
const WARM = 150_000;
const OUT = 300;

/** A priced session whose three SUPER prompts astra answered, one request each, reading 150,000 tokens from its cache and writing 300. */
async function threeSuper(world: World): Promise<Pi> {
  const pi = await world.start({ select: "smart-router/auto" });
  const codex = world.faux("openai-codex-2");
  for (const text of ["Survey the options for the session store", "Survey the options for the queue", "Survey the options for the index"]) {
    world.jev.answer(JEV.super);
    codex.respond(reply(codex, { cacheRead: WARM, output: OUT }));
    await pi.prompt(text);
    assert.equal(answered(pi), PERSONAL.super, `three SUPER prompts first: "${text}"`);
  }
  return pi;
}

/** One measured run of one request, `horizon` runs deep: the shape three such runs give. */
const shortRuns = (tokens: number, horizon: number): Workload => ({ tokens, requests: 1, output: OUT, growth: 0, seconds: 0, horizon });

test("C1 a heavier prompt moves up at once", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  const codex = world.faux("openai-codex-2");
  const pi = await world.start({ select: "smart-router/auto" });
  world.jev.answer(JEV.low);
  codex.respond(reply(codex, { input: 2_000, output: OUT }));
  await pi.prompt("Rename the helper");
  assert.equal(answered(pi), PERSONAL.low);
  world.jev.answer(JEV.super);
  await pi.prompt("Survey the options for the session store");
  assert.equal(answered(pi), PERSONAL.super, "a heavier prompt moves up at once: SUPER's model answers the prompt right after LOW's");
  assert.equal(afterDemand(pi, "personal SUPER → gpt-6-astra"), "", "a heavier prompt moves up at once: the needed level's own model, with no current model among the candidates, compares nothing");
  const moved = { outcome: "only", chosen: PERSONAL.super, current: undefined };
  assert.deepEqual(fields(costOf(pi), moved), moved, "a heavier prompt moves up at once: luna, below the need, is no candidate");
  assert.deepEqual(world.refCounts(), { [PERSONAL.low]: 1, [PERSONAL.super]: 1 });
});

test("C2 a lighter prompt stays on the warm stronger model when runs are short, and the footer shows the two costs", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  const pi = await threeSuper(world);
  const codex = world.faux("openai-codex-2");
  const text = "Check the error paths";
  world.jev.answer(JEV.medium);
  codex.respond(reply(codex, { cacheRead: WARM, output: OUT }));
  await pi.prompt(text);
  assert.equal(answered(pi), PERSONAL.super, "a lighter prompt stays on the warm stronger model when runs are short");
  // Three runs of one request each are measured, so the run is one request; every prompt so far
  // needed SUPER, so astra's level is needed again for sure (q = 1).
  const workload = shortRuns(WARM + OUT + promptSize(text), 1);
  const stay = expectedRun("super", WARM, true, workload);
  const leaving = expectedLeaving("super", WARM, 1, 0.97);
  const cheapestOther = Math.min(expectedRun("medium", 0, false, workload), expectedRun("high", 0, false, workload)) + leaving;
  assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6-astra"), `; stayed, ${money(stay)} vs ${money(cheapestOther)}`, "the footer shows the two costs: astra's, and the cheapest move's");
  const terms = { outcome: "stayed", chosen: PERSONAL.super, current: PERSONAL.super, requests: 1, horizon: 1, again: 1 };
  assert.deepEqual(fields(costOf(pi), terms), terms, "a lighter prompt stays on the warm stronger model when runs are short");
  assert.deepEqual(world.refCounts(), { [PERSONAL.super]: 4 });
});

test("C3 lighter prompts in a row move down, and the session then stays down", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  const pi = await threeSuper(world);
  const codex = world.faux("openai-codex-2");
  const medium = async (text: string, usage: Parameters<typeof reply>[1]): Promise<number> => {
    world.jev.answer(JEV.medium);
    codex.respond(reply(codex, usage));
    await pi.prompt(text);
    return promptSize(text);
  };
  // The first lighter prompt is priced one run deep, the second two, the third three (the horizon);
  // the chance SUPER is needed again falls from 3/3 to 3/4 and 3/5.
  const expectations: Array<[number, number]> = [
    [1, 1],
    [2, 0.75],
    [3, 0.6],
  ];
  const texts = ["Check the error paths", "Review the retry loop", "Tidy the parser notes"];
  for (const [index, [horizon, again]] of expectations.entries()) {
    const text = texts[index] ?? "";
    const moves = index === 2;
    const size = await medium(text, moves ? { input: WARM + 1_000, output: OUT } : { cacheRead: WARM, output: OUT });
    const workload = shortRuns(WARM + OUT + size, horizon);
    const stay = expectedRun("super", WARM, true, workload);
    const leaving = expectedLeaving("super", WARM, again, 0.97);
    const terra = expectedRun("medium", 0, false, workload) + leaving;
    const sol = expectedRun("high", 0, false, workload) + leaving;
    if (moves) {
      assert.equal(answered(pi), PERSONAL.medium, "lighter prompts in a row move down: the third, priced three runs deep, goes to terra");
      assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6.1-terra"), `; moved, ${money(terra)} vs ${money(stay)}`, "the third lighter prompt moves down");
    } else {
      assert.equal(answered(pi), PERSONAL.super, `lighter prompt ${index + 1} of three stays on astra`);
      assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6-astra"), `; stayed, ${money(stay)} vs ${money(Math.min(terra, sol))}`, `lighter prompt ${index + 1} stays`);
    }
    const terms = { requests: 1, horizon, again };
    assert.deepEqual(fields(costOf(pi), terms), terms, `lighter prompt ${index + 1}: its horizon and q`);
  }
  // The session then stays down: terra, warm, against sol cold and astra warm, both with what
  // leaving terra costs. Every prompt so far needed MEDIUM or more (q = 1), and the last one took
  // its own level, so the horizon is 1 again.
  const terraCached = WARM + 1_000;
  const size = await medium("Then fix the parser notes", { cacheRead: terraCached, output: OUT });
  assert.equal(answered(pi), PERSONAL.medium, "the session then stays down");
  const workload = shortRuns(terraCached + OUT + size, 1);
  const leaving = expectedLeaving("medium", terraCached, 1, 0.97);
  const stay = expectedRun("medium", terraCached, true, workload);
  const others = Math.min(expectedRun("high", 0, false, workload) + leaving, expectedRun("super", WARM, true, workload) + leaving);
  assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6.1-terra"), `; stayed, ${money(stay)} vs ${money(others)}`, "the session then stays down");
  assert.deepEqual(world.refCounts(), { [PERSONAL.super]: 5, [PERSONAL.medium]: 2 });
});

test("C4 a tag goes to its level whatever the costs", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  // The session C2 starts from, where an untagged MEDIUM prompt stays on astra.
  const pi = await threeSuper(world);
  await pi.prompt("Check the error paths #medium");
  assert.equal(answered(pi), PERSONAL.medium, "a tag goes to its level whatever the costs");
  assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (tag)", "a tagged run is never priced");
  const tagged = { source: "tag", tag: "medium", need: "medium", tier: "medium", cost: undefined, ref: PERSONAL.medium };
  assert.deepEqual(fields(runRecords(pi).at(-1), tagged), tagged, "a tag goes to its level whatever the costs");
  // Back at SUPER by tag, the run goes to astra, though terra answered last.
  await pi.prompt("Survey the options once more #super");
  assert.equal(answered(pi), PERSONAL.super);
  assert.equal(pi.ui.status(LEVEL_KEY), "personal SUPER → gpt-6-astra (tag)");
});

test("C5 a conversation too large for the cheaper model is compacted before the move, when the runs repay the summary", TIMEOUT, async (t) => {
  // Terra's and sol's windows are too small for 200,000 tokens; astra's is not. Pi writes a
  // compaction's summary with a request of its own that no cache serves, so the summary costs the
  // conversation less what the compaction keeps (Pi's keepRecentTokens, 1 here) at astra's uncached
  // input price: about $1.76. A run repays that only when it is long, so the session's three
  // measured runs are of 30 requests each (29 reads, then an answer), every answer reading 200,000
  // tokens from astra's cache and writing 300.
  const small = { contextWindow: 128_000 };
  const world = levelsWorld(t, { fleet: pricedLevelsFleet({ [PERSONAL.medium]: small, [PERSONAL.high]: small }) });
  const codex = world.faux("openai-codex-2");
  writeFileSync(join(world.cwd, "notes.txt"), "zebra notes\n");
  const history200k = history(world, "smart-router/auto", [["Load the fixtures", response(codex, { id: "gpt-6-astra", tokens: 200_000 })]]);
  const pi = await world.start({ sessionManager: history200k, tools: ["read"] });
  const REQUESTS = 30;
  const SIZE = 200_000;
  for (const [run, text] of ["Survey the options for the session store", "Survey the options for the queue", "Survey the options for the index"].entries()) {
    world.jev.answer(JEV.super);
    codex.respond(
      ...Array.from({ length: REQUESTS }, (_, index): AssistantMessage => {
        const message = reply(codex, { cacheRead: SIZE, output: OUT });
        if (index < REQUESTS - 1) {
          message.content = [fauxToolCall("read", { path: "notes.txt" }, { id: `read-${run}-${index}` })];
          message.stopReason = "toolUse";
        }
        return message;
      }),
    );
    await pi.prompt(text);
    assert.equal(answered(pi), PERSONAL.super, `three long SUPER runs first: "${text}"`);
  }
  assert.equal(world.refCounts()[PERSONAL.super], 3 * REQUESTS, "three runs of 30 requests on astra");

  const text = "Check the error paths";
  world.jev.answer(JEV.medium);
  const mark = world.trace.length;
  await pi.prompt(text);
  // Pi keeps 1 token, so its cut falls inside the last run's turn: it summarizes the history before
  // that turn and, in a second request, the turn's prefix (compaction.js, a split turn).
  assert.deepEqual(
    requestsOf(traceFrom(world, mark)),
    [
      [PERSONAL.super, "summary"],
      [PERSONAL.super, "summary"],
      [PERSONAL.medium, "run"],
    ],
    "a conversation too large for the cheaper model is compacted before the move: the summary on astra, in two requests for a split turn, then the run on terra",
  );
  assert.deepEqual(
    pi.eventsOf("compaction_start").map((event) => event.reason),
    ["threshold"],
    "exactly one compaction",
  );
  assert.equal(answered(pi), PERSONAL.medium);
  // Three runs measured: 30 requests, 300 output tokens each, no growth; horizon 1; every prompt so
  // far needed SUPER, so q = 1. Astra stays at 30 requests, the first warm. Terra's cost is astra's
  // summary, uncached (the conversation less the 1 token kept, at the input price, and 4,000 tokens
  // at the output price), the run on what is left, the 1 token kept and the 4,000-token summary,
  // with nothing cached, and leaving astra: q times that size at its uncached premium.
  const tokens = SIZE + OUT + promptSize(text);
  const workload: Workload = { tokens, requests: REQUESTS, output: OUT, growth: 0, seconds: 0, horizon: 1 };
  const stay = expectedRun("super", SIZE, true, workload);
  const keep = 1;
  const after = keep + 4_000;
  const astra = perToken("super");
  const summary = (tokens - keep) * astra.input + 4_000 * astra.output;
  const terra = summary + expectedRun("medium", 0, false, { ...workload, tokens: after }) + 1 * after * (astra.input - astra.cacheRead);
  assert.ok(terra < stay * (1 - 0.15), `the compaction pays: ${terra} against ${stay}, by more than the margin`);
  assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6.1-terra"), `; moved, ${money(terra)} vs ${money(stay)}`, "the move is priced with its compaction, the summary uncached");
  const terms = { outcome: "moved", requests: REQUESTS, horizon: 1, again: 1 };
  assert.deepEqual(fields(costOf(pi), terms), terms, "the run's shape: 30 requests, one run deep, q = 1");
  const candidates = (costOf(pi).candidates ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(
    candidates.map((row) => [row.ref, row.compacts, row.cached, row.survival]),
    [
      [PERSONAL.medium, true, 0, 0],
      [PERSONAL.high, true, 0, 0],
      [PERSONAL.super, false, SIZE, 0.97],
    ],
    "terra and sol compact first, and show no cached size or survival, which their cost does not use",
  );
  assert.deepEqual(pi.ui.saw(/can take this run/), [], "no step-up");
});

test("C6 with compaction disabled there is no such move: the run goes to the first level that fits", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet({ [PERSONAL.medium]: { contextWindow: 128_000 } }), compaction: { enabled: false } });
  const codex = world.faux("openai-codex-2");
  const history200k = history(world, "smart-router/auto", [["Load the fixtures", response(codex, { id: "gpt-6-astra", tokens: 200_000 })]]);
  const pi = await world.start({ sessionManager: history200k });
  world.jev.answer(JEV.medium);
  const mark = world.trace.length;
  await pi.prompt("Check the error paths");
  assert.deepEqual(requestsOf(traceFrom(world, mark)), [[PERSONAL.high, "run"]], "with compaction disabled there is no such move: nothing is summarized, and HIGH's model takes the run");
  assert.deepEqual(pi.eventsOf("compaction_start"), [], "compaction is disabled");
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(notice(pi, /can take this run/), "pi-smart-router: no MEDIUM model can take this run, so it goes to HIGH (gpt-6.1-sol).");
  assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6.1-sol"), "", "a run that steps up is not priced");
  const record = { need: "medium", tier: "high", steppedUp: true, cost: undefined, ref: PERSONAL.high };
  assert.deepEqual(fields(runRecords(pi).at(-1), record), record, "with compaction disabled the run goes to the first level that fits");
});

/** A run of three tool calls that read `paths` in turn, then an answer. */
function readsThenAnswer(paths: readonly string[]): AssistantMessage[] {
  return [
    ...paths.map((path, index) => fauxAssistantMessage([fauxToolCall("read", { path }, { id: `read-${index + 1}` })], { stopReason: "toolUse" })),
    fauxAssistantMessage("done"),
  ];
}

/** The failed tool results of a session, as [tool, failed]. */
const toolResults = (pi: Pi): unknown[][] =>
  pi.session.messages.flatMap((message) => (message.role === "toolResult" ? [[message.toolName, message.isError]] : []));

test("C7 three identical failed tool calls move the run up one level, with a notice", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const codex = world.faux("openai-codex-2");
  const pi = await world.start({ select: "smart-router/auto", tools: ["read"] });
  world.jev.answer(JEV.medium);
  codex.respond(...readsThenAnswer(["missing.txt", "missing.txt", "missing.txt"]));
  await pi.prompt("Tidy the zebra notes");
  assert.deepEqual(
    toolResults(pi),
    [
      ["read", true],
      ["read", true],
      ["read", true],
    ],
    "Pi ran each read and it failed",
  );
  assert.deepEqual(
    codex.calls.map((call) => call.ref),
    [PERSONAL.medium, PERSONAL.medium, PERSONAL.medium, PERSONAL.high],
    "three identical failed tool calls move the run up one level: the fourth request goes to HIGH's model",
  );
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(count(pi, "pi-smart-router: this run's last three tool calls failed, so it moves up from MEDIUM to HIGH (gpt-6.1-sol)."), 1, "with a notice, once");
  assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-sol (demand 1.0; escalated)", "the footer follows the run up: the blend of 80% MEDIUM and the heuristics is 1.01 (L7)");
  assert.equal(await lastDecision(pi), "smart-router/auto continuation: high → openai-codex-2/gpt-6.1-sol (escalate)");
  const record = { need: "medium", tier: "medium", escalated: true, ref: PERSONAL.high };
  assert.deepEqual(fields(runRecords(pi).at(-1), record), record, "one record, which says the run escalated");
  assert.equal(runRecords(pi).length, 1);
});

test("C8 two failed tool calls and then one that succeeds do not", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const codex = world.faux("openai-codex-2");
  writeFileSync(join(world.cwd, "notes.txt"), "zebra notes\n");
  const pi = await world.start({ select: "smart-router/auto", tools: ["read"] });
  world.jev.answer(JEV.medium);
  codex.respond(...readsThenAnswer(["missing-1.txt", "missing-2.txt", "notes.txt", "missing-3.txt"]));
  await pi.prompt("Tidy the zebra notes");
  assert.deepEqual(toolResults(pi), [
    ["read", true],
    ["read", true],
    ["read", false],
    ["read", true],
  ]);
  assert.deepEqual(
    codex.calls.map((call) => call.ref),
    [PERSONAL.medium, PERSONAL.medium, PERSONAL.medium, PERSONAL.medium, PERSONAL.medium],
    "a success among the last three tool results makes no stuck run: the run stays on MEDIUM's model",
  );
  assert.deepEqual(pi.ui.saw(/moves up from/), [], "no stuck run: no notice");
  assert.equal(
    pi.ui.status(LEVEL_KEY),
    "personal MEDIUM → gpt-6.1-terra (demand 1.0; cost unknown)",
    "no stuck run: the footer is the plan's; on a session's first prompt there is no usage yet, so the cost is unknown",
  );
  assert.deepEqual(runRecords(pi).at(-1)?.cost, { outcome: "unknown", why: "no usage yet" }, "the run's record is written, and its cost is unknown for want of usage");
  assert.equal(runRecords(pi).at(-1)?.escalated, undefined, "no stuck run: the record does not say escalated");
});

test("C8b three different shell commands that each fail without output move the run up", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const codex = world.faux("openai-codex-2");
  // Pi's own bash tool, on a shell that runs nothing and exits 1 without output: the tests may start
  // no process, and what is under test is the text Pi's tool makes of such an exit.
  const silentShell: InlineExtension = {
    name: "silent-shell",
    factory: (api) => api.registerTool(createBashToolDefinition(world.cwd, { operations: { exec: async () => ({ exitCode: 1 }) } })),
  };
  const pi = await world.start({ select: "smart-router/auto", tools: ["bash"], extensions: [silentShell] });
  world.jev.answer(JEV.medium);
  const commands = ["test -e missing-1.txt", "test -e missing-2.txt", "test -e missing-3.txt"];
  codex.respond(
    ...commands.map((command, index) => fauxAssistantMessage([fauxToolCall("bash", { command }, { id: `bash-${index + 1}` })], { stopReason: "toolUse" })),
    fauxAssistantMessage("done"),
  );
  await pi.prompt("Tidy the zebra notes");
  const texts = pi.session.messages.flatMap((message) =>
    message.role === "toolResult" ? [[message.toolName, message.isError, message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n")]] : [],
  );
  const silent = "(no output)\n\nCommand exited with code 1";
  assert.deepEqual(
    texts,
    [
      ["bash", true, silent],
      ["bash", true, silent],
      ["bash", true, silent],
    ],
    "Pi ran each command, and each failed with its shell tool's one silent-failure text",
  );
  assert.deepEqual(
    codex.calls.map((call) => call.ref),
    [PERSONAL.medium, PERSONAL.medium, PERSONAL.medium, PERSONAL.high],
    "John's ruling of 2026-11-18, exactly upstream: three failed tool calls in a row are a stuck run whatever the calls were, so the fourth request goes to HIGH's model",
  );
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(count(pi, "pi-smart-router: this run's last three tool calls failed, so it moves up from MEDIUM to HIGH (gpt-6.1-sol)."), 1, "with a notice, once");
  assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-sol (demand 1.0; escalated)", "the footer follows the run up");
  const record = { need: "medium", tier: "medium", escalated: true, ref: PERSONAL.high };
  assert.deepEqual(fields(runRecords(pi).at(-1), record), record, "one record, which says the run escalated");
});

test("C9 a version 2 roster without demand or switching routes with the defaults", TIMEOUT, async (t) => {
  const text = fixture("roster-hera-v2.json");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual([parsed.version, "demand" in parsed, "switching" in parsed], [2, false, false], "the fixture has neither section");
  const world = new World(t, {
    roster: text,
    multiPass: LABELS,
    fleet: pricedLevelsFleet(),
    settings: { ...BASE_SETTINGS, defaultProvider: "smart-router", defaultModel: "auto" },
  });
  const codex = world.faux("openai-codex-2");
  const pi = await world.start({ sessionManager: history(world, "smart-router/auto", [["Load the fixtures", response(codex, { id: "gpt-6-astra", tokens: 60_000 })]]) });
  await pi.command("check");
  const check = notice(pi, /^pi-smart-router check/).split("\n");
  for (const line of [
    "Demand: Jev's answer counts 4 and the heuristics 1 at full confidence; under 60% confidence the heuristics can only raise the level.",
    "  LOW under 0.75, MEDIUM under 1.5, HIGH under 2.25, SUPER from there; within 0.1 under a cut takes the level above.",
    // "more than": chooseByCost (src/cost.ts) moves only when another model is cheaper by more than the margin.
    "Switching: a move must cost more than 15% less than staying; lighter prompts in a row are priced up to 5 runs ahead.",
    "  A model's cache is taken to survive 97% up to 1 min, 92% up to 5 min, 87% up to 20 min, 79% up to 30 min, 66% up to 1 h, 50% up to 2 h, 38% up to 6 h, 11% up to 24 h, and not after.",
  ]) {
    assert.ok(check.includes(line), `the defaults are in effect: ${line}`);
  }
  // The fixture's classifier is not in this runtime: the heuristics decide alone, and the cost rule
  // prices with the default figures.
  // Nothing measured yet: the default run of five requests, q = 0.5, horizon 1. Over five requests
  // astra's output outweighs its warm cache, and terra is cheaper by more than the default margin.
  const prompt = PROMPTS.plain;
  await pi.prompt(prompt);
  const workload: Workload = { tokens: 60_000 + promptSize(prompt), ...DEFAULT_SHAPE, horizon: 1 };
  const stay = expectedRun("super", 60_000, true, workload);
  const terra = expectedRun("medium", 0, false, workload) + expectedLeaving("super", 60_000, 0.5, 0.92);
  assert.ok(terra < stay * (1 - 0.15), `terra, ${terra}, is cheaper than astra, ${stay}, by more than 15%`);
  assert.equal(answered(pi), PERSONAL.medium, "routed with the defaults: the move pays");
  assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6.1-terra"), `, jev unavailable; moved, ${money(terra)} vs ${money(stay)}`, "routed with the defaults");
  const terms = { outcome: "moved", current: PERSONAL.super, requests: DEFAULT_SHAPE.requests, horizon: 1, again: 0.5 };
  assert.deepEqual(fields(costOf(pi), terms), terms, "routed with the defaults");
});

test("C10 a version 1 roster moves at every prompt its keywords say to, with no hold", TIMEOUT, async (t) => {
  // stickyIdleMinutes, the removed hold's setting, is accepted and ignored.
  const world = new World(t, { roster: { ...ROSTER, stickyIdleMinutes: 5 } });
  const pi = await world.start({ select: "smart-router/auto" });
  const answers: string[] = [];
  for (const text of [PROMPTS.complex, PROMPTS.plain, PROMPTS.complex, PROMPTS.trivial, PROMPTS.planning, PROMPTS.plain]) {
    await pi.prompt(text);
    const message = pi.lastAssistant();
    answers.push(`${message?.provider}/${message?.model}`);
  }
  assert.deepEqual(
    answers,
    ["cloud-a/m", "cloud-b/m", "cloud-a/m", "cloud-b/m", "codex-like/m", "cloud-b/m"],
    "a version 1 roster moves at every prompt its keywords say to, with no hold: each lighter prompt leaves the stronger model at once",
  );
  await pi.command("history 6");
  assert.deepEqual(
    notice(pi, /routing decisions/)
      .split("\n")
      .slice(1)
      .map((line) => /\((signal:\w+)/.exec(line)?.[1]),
    ["signal:complex", "signal:default", "signal:complex", "signal:trivial", "signal:planning", "signal:default"],
  );
  assert.deepEqual(entriesOf(pi, LEVEL_ENTRY), [], "a version 1 run has no level");
  assert.deepEqual(world.jev.calls, []);
});

test("C11 a work session never leaves the work account", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const work = world.faux("openai-codex-3");
  const pi = await world.start({ select: "smart-router/auto", tools: ["read"] });
  await pi.command("scope work");
  world.jev.answer(JEV.low);
  await pi.prompt("Rename the helper");
  assert.equal(answered(pi), WORK.low);
  world.jev.answer(JEV.super);
  await pi.prompt("Survey the options for the session store");
  assert.equal(answered(pi), WORK.super);
  world.jev.answer(JEV.medium);
  work.respond(...readsThenAnswer(["missing.txt", "missing.txt", "missing.txt"]));
  await pi.prompt("Tidy the zebra notes");
  assert.equal(answered(pi), WORK.high, "the escalation stays on the work account");
  assert.equal(count(pi, "pi-smart-router: this run's last three tool calls failed, so it moves up from MEDIUM to HIGH (gpt-6.1-sol)."), 1);
  assert.match(pi.ui.status(LEVEL_KEY) ?? "", /^work MEDIUM → gpt-6\.1-sol \(demand \d\.\d; escalated\)$/);
  assert.deepEqual(called(world.counts()), { "openai-codex-3": 6 }, "a work session never leaves the work account: a LOW, a SUPER and an escalated run of four requests");
  assert.deepEqual(
    work.calls.map((call) => call.ref),
    [WORK.low, WORK.super, WORK.medium, WORK.medium, WORK.medium, WORK.high],
  );
});

test("C12 no request is added to a prompt: one Jev call and one model call per planned one-request run", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  const codex = world.faux("openai-codex-2");
  const pi = await world.start({ select: "smart-router/auto" });
  const requests = (): number => Object.values(world.counts()).reduce((sum, value) => sum + value, 0);
  const prompts: Array<[Tier, string]> = [
    ["low", "Rename the helper"],
    ["super", "Survey the options for the session store"],
    ["medium", "Check the error paths"],
    ["high", "Review the retry loop"],
  ];
  for (const [index, [tier, text]] of prompts.entries()) {
    const before = [world.jev.calls.length, requests()];
    world.jev.answer(JEV[tier]);
    codex.respond(reply(codex, { input: 10_000 * (index + 1), output: OUT }));
    await pi.prompt(text);
    assert.deepEqual([world.jev.calls.length, requests()], [(before[0] ?? 0) + 1, (before[1] ?? 0) + 1], `no request is added to the ${tier} prompt: one Jev call and one model call`);
  }
  // The runs after the first were priced. The MEDIUM prompt's: astra warm with the 20,000 tokens it
  // read, against terra and sol cold; two runs measured, so the default shape; q = 0.5 with fewer
  // than three prompts; astra survives the run's 120 seconds at 92%.
  const third = { tokens: 20_000 + OUT + promptSize("Check the error paths"), ...DEFAULT_SHAPE, horizon: 1 };
  const leaving = expectedLeaving("super", 20_000, 0.5, 0.92);
  const terra = expectedRun("medium", 0, false, third) + leaving;
  assert.ok(terra < expectedRun("super", 20_000, true, third) * 0.85, "terra undercuts astra by more than the margin");
  // The HIGH prompt's: terra, below the need, is no candidate; sol cold is cheaper than astra with
  // its 20,000 tokens.
  const fourth = { tokens: 30_000 + OUT + promptSize("Review the retry loop"), ...DEFAULT_SHAPE, horizon: 1 };
  assert.ok(expectedRun("high", 0, false, fourth) < expectedRun("super", 20_000, true, fourth), "sol is cheaper than astra");
  const like = { outcome: undefined, why: undefined, chosen: undefined, current: undefined };
  assert.deepEqual(
    runRecords(pi).map((record) => fields(record.cost as Record<string, unknown> | undefined, like)),
    [
      { ...like, outcome: "unknown", why: "no usage yet" },
      { ...like, outcome: "only", chosen: PERSONAL.super },
      { ...like, outcome: "moved", chosen: PERSONAL.medium, current: PERSONAL.super },
      { ...like, outcome: "only", chosen: PERSONAL.high },
    ],
    "the runs after the first were priced, each with the outcome its figures give, and pricing sent nothing",
  );
});

test("C13 a session an earlier version pinned routes by level and shows nothing of the pin", TIMEOUT, async (t) => {
  const world = levelsWorld(t);
  const codex = world.faux("openai-codex-2");
  const pinned = history(world, "smart-router/auto", [["Load the fixtures", response(codex, { id: "gpt-6.1-terra", tokens: 1_000 })]]);
  pinned.appendCustomEntry(PIN_ENTRY, { v: 1, on: true, at: Date.now() - 60_000, local: { refs: ["local-a/m"], providers: ["local-a"], hosts: ["localhost"] } });
  const pi = await world.start({ sessionManager: pinned });
  world.jev.answer(JEV.low);
  await pi.prompt("Rename the helper");
  assert.equal(answered(pi), PERSONAL.low, "a session an earlier version pinned routes by level");
  world.jev.answer(JEV.super);
  await pi.prompt("Survey the options for the session store");
  assert.equal(answered(pi), PERSONAL.super);
  assert.deepEqual(pi.ui.saw(/\bpin\b|pinned/i), [], "John's ruling of 2026-11-18: the old pin entry is not looked for, and nothing is shown for it");
  assert.equal(world.faux("local-a").callCount, 0, "nothing went to the local model");
  assert.equal(world.jev.calls.length, 2, "Jev was asked for each prompt");
});

test("C14 right after a compaction the next prompt's cost is unknown, and the one after is priced again", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  const codex = world.faux("openai-codex-2");
  const pi = await world.start({ select: "smart-router/auto" });
  world.jev.answer(JEV.high);
  codex.respond(reply(codex, { cacheRead: WARM, output: OUT }));
  await pi.prompt("Review the retry loop");
  assert.equal(answered(pi), PERSONAL.high);
  // Pi's own compaction, as /compact runs it: sol writes the summary. Every model's cache is
  // forgotten when it ends, sol's 150,000 tokens with the rest.
  const mark = world.trace.length;
  await pi.session.compact();
  assert.deepEqual(requestsOf(traceFrom(world, mark)), [[PERSONAL.high, "summary"]]);
  assert.equal(pi.eventsOf("compaction_start").length, 1);

  world.jev.answer(JEV.low);
  const compacted = 80_000;
  codex.respond(reply(codex, { input: compacted, output: OUT }));
  await pi.prompt("Rename the helper");
  assert.equal(answered(pi), PERSONAL.low, "right after a compaction the needed level's own model answers");
  assert.equal(afterDemand(pi, "personal LOW → gpt-6-luna"), "; cost unknown", "right after a compaction the next prompt's cost is unknown");
  assert.deepEqual(costOf(pi), { outcome: "unknown", why: "no usage yet" }, "the conversation's size is unknown until the next answer");

  // The one after is priced again, and the forgotten cache decides it. luna, below the need, is no
  // candidate, so no leaving term; two runs measured, so the default shape. Had sol's cache from
  // before the compaction counted, sol warm would cost less than terra cold and take the run; it
  // was forgotten, so every candidate is cold and terra, the cheapest, takes it.
  const text = "Check the error paths";
  const workload: Workload = { tokens: compacted + OUT + promptSize(text), ...DEFAULT_SHAPE, horizon: 1 };
  const terra = expectedRun("medium", 0, false, workload);
  assert.ok(expectedRun("high", workload.tokens, true, workload) < terra, "sol with its cache counted would cost less than terra cold");
  assert.ok(terra < expectedRun("high", 0, false, workload), "with no cache, terra costs less than sol");
  world.jev.answer(JEV.medium);
  codex.respond(reply(codex, { cacheRead: compacted, output: OUT }));
  await pi.prompt(text);
  assert.equal(answered(pi), PERSONAL.medium, "the compaction forgot sol's cache: terra, not sol, takes the run");
  const priced = { outcome: "only", chosen: PERSONAL.medium, current: undefined };
  assert.deepEqual(fields(costOf(pi), priced), priced, "the prompt after that is priced again");
  assert.deepEqual(
    ((costOf(pi).candidates ?? []) as Array<Record<string, unknown>>).map((row) => [row.ref, row.cached]),
    [
      [PERSONAL.medium, 0],
      [PERSONAL.high, 0],
      [PERSONAL.super, 0],
    ],
    "no candidate has anything cached: sol's cache went with the compaction",
  );
  assert.equal(afterDemand(pi, "personal MEDIUM → gpt-6.1-terra"), "", "the needed level's own model, with no current model among the candidates, compares nothing");
});

/** One route request Pi's runtime made for a virtual model, and what the router returned. */
interface Routed {
  readonly reason: string;
  readonly thinkingLevel: string;
  readonly messages: ReadonlyArray<readonly [string, string]>;
  readonly ref: string;
  readonly routedLevel: string | undefined;
}

/** The text of a message's content. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: unknown) => (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : "")).join("\n");
}

/** Record every route request the session's runtime resolves from now on: its reason, level and messages as [role, text], and the route. */
function routesOf(pi: Pi): Routed[] {
  const runtime = pi.session.modelRuntime;
  const resolve = runtime.resolveModel.bind(runtime);
  const seen: Routed[] = [];
  runtime.resolveModel = async (model, messages, options) => {
    const route = await resolve(model, messages, options);
    seen.push({
      reason: options.reason,
      thinkingLevel: options.thinkingLevel,
      messages: messages.map((message) => [message.role, contentText(message.content)] as const),
      ref: `${route.model.provider}/${route.model.id}`,
      routedLevel: route.thinkingLevel,
    });
    return route;
  };
  return seen;
}

test("C15 a run an extension starts without a prompt takes the highest level of the last three prompts", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  const pi = await threeSuper(world);
  const codex = world.faux("openai-codex-2");
  world.jev.answer(JEV.medium);
  codex.respond(reply(codex, { cacheRead: WARM, output: OUT }));
  await pi.prompt("Check the error paths");
  assert.equal(answered(pi), PERSONAL.super, "the MEDIUM prompt stays on the warm astra, as in C2");
  const last = { need: "medium", tier: "super" };
  assert.deepEqual(fields(runRecords(pi).at(-1), last), last, "the session last needed MEDIUM, and SUPER's model took the run");
  const routes = routesOf(pi);
  const mark = codex.calls.length;
  codex.respond(reply(codex, { cacheRead: WARM, output: OUT }));
  await pi.custom("continue the review");
  // What Pi's runtime gives the router for such a run: a continuation, whose messages end with the
  // extension's message as a user message.
  assert.deepEqual(
    routes.map((route) => [route.reason, route.messages.at(-1)]),
    [["continuation", ["user", "continue the review"]]],
    "Pi routes a run an extension starts as a continuation, with the extension's message last, as a user message",
  );
  assert.equal(world.jev.calls.length, 4, "Jev is not asked for a run without a prompt");
  assert.equal(await lastDecision(pi), "smart-router/auto continuation: super → openai-codex-2/gpt-6-astra (run:need)", "the run goes through the run:need choice");
  assert.equal(
    pi.ui.status(LEVEL_KEY),
    "personal SUPER → gpt-6-astra (run)",
    "John's ruling of 2026-11-18: the run takes the highest level of the last three prompts (SUPER, SUPER, MEDIUM), SUPER, not the MEDIUM the session last needed; SUPER has no other candidate, so no cost is said",
  );
  assert.deepEqual(codex.calls.slice(mark).map((call) => call.ref), [PERSONAL.super], "the request really goes to the model the footer names");
  assert.equal(routes[0]?.ref, PERSONAL.super);
  assert.equal(runRecords(pi).length, 4, "no level record is written for the run without a prompt");
});

test("C16 a request carries the thinking level its price assumed", TIMEOUT, async (t) => {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  const codex = world.faux("openai-codex-2");
  const pi = await world.start({ select: "smart-router/auto" });
  pi.session.setThinkingLevel("high");
  world.jev.answer(JEV.high);
  const size = 20_000;
  codex.respond(reply(codex, { input: size, output: OUT }));
  await pi.prompt("Review the retry loop");
  assert.equal(answered(pi), PERSONAL.high);
  assert.equal(pi.lastAssistant()?.thinkingLevel, "high", "sol answered at high");
  // Another level, which sol is sent as another effort: its cache does not count.
  pi.session.setThinkingLevel("medium");
  const routes = routesOf(pi);
  const mark = codex.calls.length;
  const text = "Tidy the zebra notes";
  world.jev.answer(JEV.medium);
  codex.respond(reply(codex, { input: size + 1_000, output: OUT }));
  await pi.prompt(text);
  const candidates = (costOf(pi).candidates ?? []) as Array<Record<string, unknown>>;
  assert.deepEqual(
    candidates.map((row) => [row.ref, row.cached]),
    [
      [PERSONAL.medium, 0],
      [PERSONAL.high, 0],
      [PERSONAL.super, 0],
    ],
    "a request carries the thinking level its price assumed: sol, the current model, is priced with nothing cached at the new effort",
  );
  assert.equal(costOf(pi).current, PERSONAL.high);
  assert.equal(answered(pi), PERSONAL.medium);
  const workload: Workload = { tokens: size + OUT + promptSize(text), ...DEFAULT_SHAPE, horizon: 1 };
  assert.equal(
    afterDemand(pi, "personal MEDIUM → gpt-6.1-terra"),
    `; moved, ${money(expectedRun("medium", 0, false, workload))} vs ${money(expectedRun("high", 0, false, workload))}`,
    "with nothing cached on sol, leaving it costs nothing",
  );
  assert.deepEqual(
    routes.map((route) => [route.thinkingLevel, route.ref, route.routedLevel]),
    [["medium", PERSONAL.medium, "low"]],
    "John, 2026-11-18, thinking effort exactly as upstream: at medium an ordinary turn is sent low (adaptive-reasoning.ts:212), the effort the price assumed",
  );
  assert.deepEqual(
    codex.calls.slice(mark).map((call) => [call.ref, call.reasoning]),
    [[PERSONAL.medium, "low"]],
    "a request carries the thinking level its price assumed: the faux provider received low",
  );
  assert.equal(pi.lastAssistant()?.thinkingLevel, "low");
});

// ─── Thinking effort by turn type, in Pi's runtime ──────────────────────────
//
// John, 2026-11-18: "Exactly as upstream: effort follows each request's turn type." What Pi itself
// sends the provider, for a prompt's first request and for the request after its tool result.

/** A MEDIUM run on terra whose model reads one file and then answers; the levels the faux provider received, in order. */
async function readThenAnswerAt(t: TestContext, level: "medium" | "high"): Promise<{ readonly pi: Pi; readonly received: ReadonlyArray<readonly [string, string | undefined]> }> {
  const world = levelsWorld(t, { fleet: pricedLevelsFleet() });
  writeFileSync(join(world.cwd, "notes.txt"), "the lock order is a, then b\n");
  const codex = world.faux("openai-codex-2");
  const pi = await world.start({ select: "smart-router/auto", tools: ["read"] });
  pi.session.setThinkingLevel(level);
  assert.equal(pi.session.thinkingLevel, level, `the session is at ${level}`);
  world.jev.answer(JEV.medium);
  codex.respond(fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" }, { id: "read-1" })], { stopReason: "toolUse" }), fauxAssistantMessage("a, then b"));
  await pi.prompt("Tidy the zebra notes");
  return { pi, received: codex.calls.map((call) => [call.ref, call.reasoning] as const) };
}

test("C17 at medium, Pi sends each request the effort its turn type gives: low for the prompt, minimal after the tool result", TIMEOUT, async (t) => {
  const { pi, received } = await readThenAnswerAt(t, "medium");
  assert.deepEqual(
    received,
    [
      [PERSONAL.medium, "low"],
      [PERSONAL.medium, "minimal"],
    ],
    "adaptive-reasoning.ts:212: an ordinary turn low, the request after a tool result minimal; the faux provider received each",
  );
  assert.deepEqual(
    pi.assistants().map((message) => message.thinkingLevel),
    ["low", "minimal"],
    "Pi records the level each answer was sent at, which the ledger reads as its effort",
  );
  assert.equal(pi.ui.status(EFFORT_KEY), "thinking minimal (after a tool result)", "the footer says which effort the latest request carried, and why");
  assert.equal(pi.ui.status(LEVEL_KEY), "personal MEDIUM → gpt-6.1-terra (demand 1.0; cost unknown)", "the level item is unchanged");
});

test("C18 at any other level, here high, nothing changes: every request carries the selected level", TIMEOUT, async (t) => {
  const { pi, received } = await readThenAnswerAt(t, "high");
  assert.deepEqual(
    received,
    [
      [PERSONAL.medium, "high"],
      [PERSONAL.medium, "high"],
    ],
    "adaptive-reasoning.ts:335-345: a level other than medium is never lowered, and the table reaches no higher than high",
  );
  assert.equal(pi.ui.status(EFFORT_KEY), "thinking high (as selected, never lowered)");
});
