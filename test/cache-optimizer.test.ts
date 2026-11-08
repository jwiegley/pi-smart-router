import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isRoutingRegistry, routingRegistry } from "../src/cache-optimizer.ts";
import type { RouterAdapter } from "../src/cache-optimizer.ts";
import { ROUTING_REGISTRY_KEY } from "../src/constants.ts";
import { policyFromRoster } from "../src/local.ts";
import { processSlot } from "../src/owners.ts";
import { ASTRA, DEEPSEEK, FakeCatalog, GLM, GLM_CLOUD, heraModels, KIMI, NOW, rosterFixture, SOL } from "./support/catalog.ts";
import { ensureRoutingRegistry, hashSessionId, isRouterAdapterV1, isRoutingRegistryV1, keepsSystemPrompt, registryValue, resolveActiveRoute } from "./support/co.ts";
import type { Registry, Snapshot } from "./support/co.ts";
import { agentDir, assistant, FakeRuntime, load, previous, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded } from "./support/pi.ts";

const PLANNING = "plan the migration to the new store";
const TRIVIAL = "Format this file";

beforeEach(resetSlot);
afterEach(resetSlot);

/** What pi-cache-optimizer reads for a session's selection at one of its hooks. */
const seen = (loaded: Loaded): Snapshot | undefined => resolveActiveRoute(loaded.session.ctx);
/** The model it reads, with the status. */
const brief = (loaded: Loaded): string | undefined => {
  const snapshot = seen(loaded);
  return snapshot === undefined ? undefined : `${snapshot.provider}/${snapshot.modelId} ${snapshot.status}`;
};
const adapter = (): RouterAdapter => {
  const found = (registryValue() as Registry).getRouter("smart-router");
  assert.ok(isRouterAdapterV1(found), "the router's adapter is registered");
  return found as RouterAdapter;
};

describe("the registry", () => {
  test("is created in the shape pi-cache-optimizer accepts when there is none, and the optimizer reuses it", async (t) => {
    assert.equal(registryValue(), undefined);
    await start({ dir: agentDir(t) });
    const created = registryValue();
    assert.ok(isRoutingRegistryV1(created));
    assert.ok(isRoutingRegistry(created));
    assert.equal(ensureRoutingRegistry(), created, "the optimizer, loading later, reuses it");
    assert.equal(adapter(), processSlot().adapter?.adapter);
  });

  test("is reused when pi-cache-optimizer created it first", async (t) => {
    const optimizers = ensureRoutingRegistry();
    await start({ dir: agentDir(t) });
    assert.equal(registryValue(), optimizers);
    assert.equal(optimizers.getRouter("smart-router"), processSlot().adapter?.adapter);
  });

  test("replaces a value of another shape or version, as pi-cache-optimizer does", async (t) => {
    for (const value of [{ version: 2 }, { version: 2, registerRouter: () => () => undefined, getRouter: () => undefined }, { version: 1, getRouter: () => undefined }]) {
      resetSlot();
      (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTING_REGISTRY_KEY)] = value;
      await start({ dir: agentDir(t), runtime: new FakeRuntime() });
      assert.notEqual(registryValue(), value);
      assert.ok(isRoutingRegistryV1(registryValue()));
      assert.equal(routingRegistry(), registryValue());
      assert.ok(isRouterAdapterV1(adapter()));
    }
  });

  test("the one the router creates behaves as pi-cache-optimizer's: it refuses a malformed adapter and unregisters only its own", () => {
    const registry = routingRegistry();
    for (const bad of [{}, { virtualProvider: " ", resolveActiveRoute: () => undefined }, { virtualProvider: "x" }]) {
      registry.registerRouter(bad as unknown as RouterAdapter)();
      assert.equal(registry.getRouter("x"), undefined);
    }
    const first: RouterAdapter = { virtualProvider: " smart-router ", resolveActiveRoute: () => undefined };
    const second: RouterAdapter = { virtualProvider: "smart-router", resolveActiveRoute: () => undefined };
    const dropFirst = registry.registerRouter(first);
    assert.equal(registry.getRouter("smart-router"), first, "the provider is trimmed");
    const dropSecond = registry.registerRouter(second);
    dropFirst();
    assert.equal(registry.getRouter("smart-router"), second, "a replaced adapter's unregister leaves its successor");
    dropSecond();
    assert.equal(registry.getRouter("smart-router"), undefined);
  });
});

describe("the answer for a session", () => {
  test("is the run's plan as planned, then the run's pick as selected, then a prediction", async (t) => {
    const loaded = await start({ dir: agentDir(t), id: "019a-co", now: () => NOW });
    assert.deepEqual(seen(loaded), {
      virtualProvider: "smart-router",
      virtualModelId: "auto",
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4.1-flash-1017",
      api: "openai-completions",
      status: "selected",
      sessionIdHash: hashSessionId("019a-co"),
      timestamp: NOW,
    });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    const planned = seen(loaded);
    assert.deepEqual([`${planned?.provider}/${planned?.modelId}`, planned?.status, planned?.api], [ASTRA, "planned", "openai-codex-responses"]);
    assert.equal(keepsSystemPrompt(planned?.api), true, "so the optimizer leaves the planned Codex run's system prompt alone");
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: PLANNING });
    assert.equal(brief(loaded), `${ASTRA} planned`);
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), ASTRA);
    assert.equal(brief(loaded), `${ASTRA} selected`, "the run's pick");
    await loaded.host.emit("message_end", { message: assistant(ASTRA) });
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    assert.equal(brief(loaded), `${ASTRA} selected`, "after the run, a prediction from the last responder");
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    assert.equal(brief(loaded), `${KIMI} selected`);
  });

  test("is what a custom-triggered run will pick after a resume: the prediction from the restored last responder", async (t) => {
    const loaded = load({ dir: agentDir(t), runtime: new FakeRuntime() });
    loaded.session.appendAssistant(assistant(SOL, { timestamp: NOW - 60_000 }));
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "resume" });
    assert.equal(brief(loaded), `${SOL} selected`);
    await loaded.host.emit("before_agent_start", { messageType: "custom" });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal }))), SOL, "the run picks what the optimizer saw");
  });

  test("follows the role's fallback while the last responder is cooling", async (t) => {
    const loaded = await start({ dir: agentDir(t), now: () => NOW });
    await loaded.host.emit("message_end", { message: assistant(SOL) });
    assert.equal(brief(loaded), `${SOL} selected`);
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: "You've hit your usage limit.", timestamp: NOW + 1 }) });
    assert.equal(brief(loaded), `${GLM_CLOUD} selected`);
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal }))), GLM_CLOUD, "and so does the run");
  });

  test("for smart-router/local is the local role's model", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: "local" });
    assert.equal(brief(loaded), `${GLM} selected`);
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    assert.equal(brief(loaded), `${GLM} planned`);
  });

  test("is nothing when the plan found no model, because the run's first request refuses", async (t) => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(ASTRA);
    catalog.unavailable.add(KIMI);
    const loaded = await start({ dir: agentDir(t), runtime: new FakeRuntime(catalog) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    assert.equal(seen(loaded), undefined);
    const signal = loaded.session.startRun();
    assert.throws(() => loaded.runtime.route("auto", request("user", { signal })), /Nothing was sent/);
  });

  test("stays local under the pin, and is nothing for smart-router/auto, which refuses there", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: "local", setup: (session) => session.pin(policyFromRoster(rosterFixture("roster-hera.json"))) });
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    assert.equal(brief(loaded), `${GLM} selected`);
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    assert.equal(brief(loaded), `${GLM} planned`);
    loaded.session.force("auto");
    assert.equal(seen(loaded), undefined, "the plan was made for smart-router/local, and smart-router/auto's first request never takes it");
  });

  test("is the run's pick while its request is in flight, even when that model stopped resolving since", async (t) => {
    const catalog = new FakeCatalog(heraModels());
    const loaded = await start({ dir: agentDir(t), runtime: new FakeRuntime(catalog) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    const signal = loaded.session.startRun();
    loaded.runtime.route("auto", request("user", { signal }));
    catalog.unavailable.add(ASTRA);
    // pi-cache-optimizer's provider hooks for that request fire after route() picked astra.
    assert.equal(brief(loaded), `${ASTRA} selected`);
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    assert.equal(brief(loaded), `${DEEPSEEK} selected`, "after the run, the prediction: no response yet, so the default role");
  });
});

describe("only the owner's own loop changes the answer", () => {
  test("a direct route between input and before_agent_start leaves the plan, and so does a foreign request", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    assert.equal(brief(loaded), `${ASTRA} planned`);
    // Pre-run compaction summarizes on the previous model.
    assert.equal(routed(loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, KIMI) }))), KIMI);
    assert.equal(brief(loaded), `${ASTRA} planned`);
    // goal-x's auditor routes through the parent's closure with its own signal.
    loaded.runtime.route("auto", request("user", { signal: new AbortController().signal }));
    assert.equal(brief(loaded), `${ASTRA} planned`);
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: PLANNING });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), ASTRA);
  });

  test("a compaction inside the run leaves the run's pick", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
    const signal = loaded.session.startRun();
    loaded.runtime.route("auto", request("user", { signal }));
    loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, KIMI) }));
    assert.equal(brief(loaded), `${ASTRA} selected`, "the run's own provider hooks still see the run's model");
  });

  test("a nested session that shares the runtime and loads the router cannot change the parent's answer", async (t) => {
    const runtime = new FakeRuntime();
    const dir = agentDir(t);
    const parent = await start({ dir, runtime, id: "parent" });
    await parent.host.emit("input", { text: PLANNING, source: "interactive" });
    const nested = load({ dir, runtime, id: "nested" });
    nested.session.select("auto");
    nested.runtime.route("auto", request("direct", { previous: previous(runtime, KIMI) }));
    assert.equal(brief(parent), `${ASTRA} planned`);
    assert.equal(seen(nested), undefined, "a session that never started is no owner, and the adapter answers nothing for it");
  });
});

describe("sessions and hints", () => {
  test("nothing without a session hint, for an unknown session, or for another virtual model", async (t) => {
    const loaded = await start({ dir: agentDir(t), id: "known" });
    const hash = hashSessionId("known");
    assert.equal(adapter().resolveActiveRoute("auto"), undefined);
    assert.equal(adapter().resolveActiveRoute("auto", {}), undefined);
    assert.equal(adapter().resolveActiveRoute("auto", { sessionIdHash: "" }), undefined);
    assert.equal(adapter().resolveActiveRoute("auto", { sessionIdHash: hashSessionId("unknown") }), undefined);
    assert.equal(adapter().resolveActiveRoute("other", { sessionIdHash: hash }), undefined);
    assert.equal(adapter().resolveActiveRoute("auto", { sessionIdHash: hash })?.modelId, "deepseek/deepseek-v4.1-flash-1017");
    const nameless = { ...loaded.session.ctx, sessionManager: { ...loaded.session.ctx.sessionManager, getSessionId: () => "" }, model: loaded.session.model };
    assert.equal(resolveActiveRoute(nameless as typeof loaded.session.ctx), undefined, "the optimizer sends no hint for a session without an id");
  });

  test("two concurrent sessions never see each other's answer", async (t) => {
    const dir = agentDir(t);
    const a = await start({ dir, id: "a", runtime: new FakeRuntime() });
    const b = await start({ dir, id: "b", runtime: new FakeRuntime() });
    await a.host.emit("input", { text: PLANNING, source: "interactive" });
    await b.host.emit("input", { text: TRIVIAL, source: "interactive" });
    assert.deepEqual([brief(a), brief(b)], [`${ASTRA} planned`, `${DEEPSEEK} planned`]);
    const signal = a.session.startRun();
    a.runtime.route("auto", request("user", { signal }));
    assert.deepEqual([brief(a), brief(b)], [`${ASTRA} selected`, `${DEEPSEEK} planned`]);
    assert.deepEqual([seen(a)?.sessionIdHash, seen(b)?.sessionIdHash], [hashSessionId("a"), hashSessionId("b")]);
  });

  test("never throws", async (t) => {
    const loaded = await start({ dir: agentDir(t), id: "fragile" });
    const hash = hashSessionId("fragile");
    const router = loaded.router as unknown as Record<string, unknown>;
    router.activeRoute = () => {
      throw new Error("broken");
    };
    assert.equal(adapter().resolveActiveRoute("auto", { sessionIdHash: hash }), undefined);
    loaded.session.dispose();
    assert.equal(adapter().resolveActiveRoute("auto", { sessionIdHash: hash }), undefined, "an owner whose context went stale is dropped");
  });
});

describe("registration", () => {
  test("one adapter, registered when the first owner arrives and unregistered after the last leaves", async (t) => {
    const dir = agentDir(t);
    const a = await start({ dir, id: "a", runtime: new FakeRuntime() });
    const registry = registryValue() as Registry;
    const first = registry.getRouter("smart-router");
    const b = await start({ dir, id: "b", runtime: new FakeRuntime() });
    assert.equal(registry.getRouter("smart-router"), first, "the second owner reuses it");
    await a.host.emit("session_shutdown", { reason: "quit" });
    assert.equal(registry.getRouter("smart-router"), first, "an owner is still live");
    assert.ok(seen(b) !== undefined, "and it still answers for the remaining owner");
    await b.host.emit("session_shutdown", { reason: "quit" });
    assert.equal(registry.getRouter("smart-router"), undefined);
    assert.equal(processSlot().adapter, undefined);
  });

  test("/reload and a new session leave exactly one adapter, which answers for the live session", async (t) => {
    const dir = agentDir(t);
    const before = await start({ dir, id: "one", file: "/sessions/one.jsonl" });
    await before.host.emit("session_shutdown", { reason: "reload" });
    before.session.dispose();
    const after = await start({ dir, id: "one", file: "/sessions/one.jsonl" });
    await after.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/two.jsonl" });
    after.session.dispose();
    const next = await start({ dir, id: "two", file: "/sessions/two.jsonl" });
    const registry = registryValue() as Registry;
    assert.equal(registry.getRouter("smart-router"), processSlot().adapter?.adapter);
    assert.deepEqual([...processSlot().owners].map((owner) => owner.sessionId), ["two"]);
    assert.ok(seen(next) !== undefined);
  });

  test("takes its place back when something else registered for smart-router", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    const ours = processSlot().adapter?.adapter;
    const registry = registryValue() as Registry;
    registry.registerRouter({ virtualProvider: "smart-router", resolveActiveRoute: () => undefined });
    assert.notEqual(registry.getRouter("smart-router"), ours);
    await loaded.host.emit("session_start", { reason: "reload" });
    assert.ok(seen(loaded) !== undefined);
    assert.equal(registry.getRouter("smart-router"), processSlot().adapter?.adapter);
  });
});
