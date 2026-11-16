import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import smartRouter, { install } from "../index.ts";
import { processSlot } from "../src/owners.ts";
import { createRouter } from "../src/router.ts";
import { ASTRA, DEEPSEEK, KIMI } from "./support/catalog.ts";
import { agentDir, assistant, FakeHost, FakeRuntime, FakeSession, load, request, resetSlot, routed, start } from "./support/pi.ts";

const HANDLERS = [
  "session_start",
  "input",
  "before_agent_start",
  "turn_start",
  "message_end",
  "agent_settled",
  "model_select",
  "session_before_compact",
  "session_before_tree",
  "session_shutdown",
];
/** Events whose handler could change what a selection sends. The router registers none: a model picked by hand is sent as it is. */
const NEVER_HANDLED = ["before_provider_request", "cache_warming_decision", "tool_call"];

beforeEach(resetSlot);
afterEach(resetSlot);

test("the default export is the factory, and it registers both models with every thinking level", () => {
  assert.equal(typeof smartRouter, "function");
  const session = new FakeSession(new FakeRuntime());
  const host = new FakeHost(session);
  smartRouter(host.api);
  assert.deepEqual(
    host.definitions.map((definition) => [definition.provider, definition.id, definition.name, definition.thinkingLevels]),
    [
      ["smart-router", "auto", "Smart Router (auto)", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
      ["smart-router", "local", "Smart Router (local models)", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ],
  );
});

test("both models are registered first, and every handler is wired once, after the router is built", (t) => {
  const dir = agentDir(t);
  const host = new FakeHost(new FakeSession(new FakeRuntime()));
  const order: string[] = [];
  let built = false;
  install(host.api, (pi, options) => {
    order.push(...host.calls, "build");
    // The router is built without one pi.on call.
    const guarded = new Proxy(pi, {
      get: (target, property) => (property === "on" ? () => assert.fail("pi.on during construction") : Reflect.get(target, property, target)),
    });
    const router = createRouter(guarded, { ...options, agentDir: () => dir });
    built = true;
    return router;
  });
  assert.ok(built, "the router was built");
  assert.deepEqual(order, ["registerVirtualModel:auto", "registerVirtualModel:local", "build"]);
  assert.deepEqual(host.calls.slice(2), [...HANDLERS.map((event) => `on:${event}`), "registerCommand:smart-router"]);
  for (const event of HANDLERS) assert.equal(host.count(event), 1, event);
  for (const event of NEVER_HANDLED) assert.equal(host.count(event), 0, `${event}: the router empties no payload, stops no warming and blocks no tools (Q7)`);
});

test("the factory does no I/O: the files are first read at session_start", async (t) => {
  const dir = agentDir(t);
  const asked: string[] = [];
  const loaded = load({
    dir,
    build: (pi, options) =>
      createRouter(pi, {
        ...options,
        agentDir: () => {
          asked.push("agentDir");
          return dir;
        },
      }),
  });
  assert.deepEqual(asked, []);
  loaded.session.select("auto");
  await loaded.host.emit("session_start", { reason: "startup" });
  assert.ok(asked.length > 0);
});

test("a builder that throws leaves both models refusing with the load error, and only the notice handler", async (t) => {
  const loaded = load({
    dir: agentDir(t),
    build: () => {
      throw new Error("boom\n    at somewhere");
    },
  });
  assert.equal(loaded.router, undefined);
  assert.deepEqual(loaded.host.calls, ["registerVirtualModel:auto", "registerVirtualModel:local", "on:session_start"], "no handler or command of a router that failed to build");
  loaded.session.select("auto");
  for (const id of ["auto", "local"] as const) {
    let message = "";
    assert.throws(
      () => loaded.runtime.route(id, request("direct")),
      (error: unknown) => {
        message = error instanceof Error ? error.message : "";
        return true;
      },
    );
    assert.equal(message, `smart-router/${id}: pi-smart-router failed to load (boom). Nothing was sent. Choose a model with /model, or fix the cause and run /reload.`);
    assert.equal(isRetryableAssistantError(assistant(`smart-router/${id}`, { stopReason: "error", errorMessage: message })), false);
  }
  await loaded.host.emit("session_start", { reason: "startup" });
  assert.deepEqual(loaded.session.notices, [
    { type: "error", message: "pi-smart-router failed to load: boom. smart-router/auto and smart-router/local refuse every request until it loads." },
  ]);
  loaded.session.hasUI = false;
  await loaded.host.emit("session_start", { reason: "startup" });
  assert.equal(loaded.session.notices.length, 1, "no notice without a UI");
});

test("a router whose wiring fails leaves both models refusing, not routing through it", async (t) => {
  const dir = agentDir(t);
  const loaded = load({
    dir,
    build: (pi, options) => {
      const router = createRouter(pi, { ...options, agentDir: () => dir });
      return {
        ...router,
        wire(target: ExtensionAPI) {
          router.wire(target);
          throw new Error("wiring failed");
        },
      };
    },
  });
  loaded.session.select("auto");
  assert.throws(() => loaded.runtime.route("auto", request("direct")), { message: /^smart-router\/auto: pi-smart-router failed to load \(wiring failed\)\. Nothing was sent\./ });
});

test("the factory works through nix-config's staging proxy, which returns nothing from on() and register*()", async (t) => {
  const dir = agentDir(t);
  const runtime = new FakeRuntime();
  const session = new FakeSession(runtime);
  const host = new FakeHost(session);
  // The managed entry's proxy (config/ai/extensions/pi-warden-entry/index.ts in nix-config).
  const staged: Array<() => unknown> = [];
  let live = false;
  const api = new Proxy(host.api, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!live && typeof property === "string" && (property === "on" || property.startsWith("register"))) {
        return (...args: unknown[]) => {
          staged.push(() => Reflect.apply(value, target, args));
        };
      }
      return value.bind(target);
    },
  }) as ExtensionAPI;
  install(api, (pi, options) => createRouter(pi, { ...options, agentDir: () => dir }));
  assert.deepEqual(host.calls, [], "everything was staged");
  assert.equal(staged.length, 2 + HANDLERS.length + 1, "both models, every handler and the command");
  live = true;
  for (const register of staged) register();
  host.bind();
  session.select("auto");
  await host.emit("session_start", { reason: "startup" });
  assert.equal(host.definitions.length, 4, "session_start registered again through the live proxy");
  await host.emit("input", { text: "plan the migration", source: "interactive" });
  const signal = session.startRun();
  assert.equal(routed(runtime.route("auto", request("user", { signal }))), ASTRA);
  assert.equal(routed(runtime.route("auto", request("direct"))), DEEPSEEK);
});

test("session_shutdown empties the session's records and leaves the owner registry", async (t) => {
  const loaded = await start({ dir: agentDir(t) });
  await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
  const signal = loaded.session.startRun();
  loaded.runtime.route("auto", request("user", { signal }));
  await loaded.host.emit("message_end", { message: assistant(KIMI) });
  const record = loaded.router?.record("session-1");
  assert.ok(record !== undefined && record.history.length > 0 && record.runPick !== undefined && record.last !== undefined);
  assert.equal(processSlot().owners.size, 1);
  await loaded.host.emit("session_shutdown", { reason: "quit" });
  assert.equal(loaded.router?.record("session-1"), undefined);
  assert.equal(processSlot().owners.size, 0);
});

test("a new factory per session (/new, /resume, /reload) leaves one owner per live session", async (t) => {
  const dir = agentDir(t);
  const first = await start({ dir, id: "one" });
  await first.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/two.jsonl" });
  first.session.dispose();
  const second = await start({ dir, id: "two" });
  const third = await start({ dir, id: "three", runtime: new FakeRuntime() });
  assert.deepEqual([...processSlot().owners].map((owner) => owner.sessionId).sort(), ["three", "two"]);
  for (const loaded of [second, third]) for (const event of HANDLERS) assert.equal(loaded.host.count(event), 1);
  await second.host.emit("session_start", { reason: "reload" });
  assert.deepEqual([...processSlot().owners].map((owner) => owner.sessionId).sort(), ["three", "two"], "a second start replaces the owner");
});

test("no timer, socket or other handle outlives a session", async (t) => {
  const before = process.getActiveResourcesInfo().sort();
  const loaded = await start({ dir: agentDir(t) });
  await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
  const signal = loaded.session.startRun();
  loaded.runtime.route("auto", request("user", { signal }));
  await loaded.host.emit("message_end", { message: assistant(ASTRA) });
  await loaded.host.emit("agent_settled", { aborted: false });
  await loaded.host.emit("session_shutdown", { reason: "quit" });
  assert.deepEqual(process.getActiveResourcesInfo().sort(), before);
});
