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
import "./support/sandboxed.ts";

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import type { RoutingRegistry } from "../src/cache-optimizer.ts";
import { ROUTING_REGISTRY_KEY, SLOT_KEY } from "../src/constants.ts";
import type { Owner, Slot } from "../src/owners.ts";
import type { Router } from "../src/router.ts";
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
import type { FauxCall, Pi, WorldOptions } from "./support/host.ts";

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
  const levels = pi.assistants().map((message) => `${message.provider}:${(message as { thinkingLevel?: string }).thinkingLevel}`);
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
  const roster = structuredClone(ROSTER) as { roles: Array<{ name: string; models: string[] }> };
  roster.roles.push({ name: "work", models: ["openai-codex-3/gpt-6.1-sol"] });
  const world = new World(t, { roster });
  const pi = await world.start({ select: "smart-router/auto" });
  assert.equal(pi.ui.saw(/is excluded by openai-codex-3\/\*.*refuse every request until it is fixed/).length, 1);
  await pi.prompt(PROMPTS.complex);
  assert.match(pi.lastAssistant()?.errorMessage ?? "", /^smart-router\/auto: the roster \S+ is invalid \(roles\[5\]\.models\[0\]: "openai-codex-3\/gpt-6\.1-sol" is excluded by openai-codex-3\/\*\)\. Nothing was sent\./);
  assert.deepEqual(called(world.counts()), {});
});

test("24b. after a direct turn on openai-codex-3, neither runs nor compaction go back to it, and openai-codex-2 takes its model id", TIMEOUT, async (t) => {
  const roster = structuredClone(ROSTER) as typeof ROSTER & { accounts?: unknown };
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
  const roster = structuredClone(ROSTER) as typeof ROSTER & { accounts?: unknown };
  roster.roles = roster.roles.map((role) => (role.name === "engineer" ? { ...role, models: ["openai-codex-2/gpt-6.1-sol"] } : role));
  roster.routing = { ...roster.routing, fallback: {} as typeof ROSTER.routing.fallback };
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
      .filter((entry) => entry.type === "custom" && entry.customType === "smart-router.pin")
      .map((entry) => (entry as { data?: unknown }).data);

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
