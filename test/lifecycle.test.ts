import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import smartRouter, { install } from "../index.ts";
import { LEVEL_ENTRY, ROUTING_REGISTRY_KEY } from "../src/constants.ts";
import { processSlot } from "../src/owners.ts";
import { createRouter, DEFAULT_LIMITS } from "../src/router.ts";
import { ASTRA, DEEPSEEK, KIMI, NOW, SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeHost, FakeRuntime, FakeSession, load, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded, LoadOptions } from "./support/pi.ts";

const HANDLERS = [
  "session_start",
  "input",
  "before_agent_start",
  "turn_start",
  "message_end",
  "agent_settled",
  "session_before_compact",
  "session_before_tree",
  "session_shutdown",
];
/**
 * Events whose handler could change what a selection sends. The router registers none: a model
 * picked by hand is sent as it is. Nor does it answer a selection: model_select only showed the
 * removed local-only pin's status item.
 */
const NEVER_HANDLED = ["before_provider_request", "cache_warming_decision", "tool_call", "model_select"];

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

describe("a session_start step that fails leaves the others to run", () => {
  const throwing = (message: string) => () => {
    throw new Error(message);
  };
  /** A seed read that fails, as a locked or damaged session index does. */
  const failSeed = (message: string) => (loaded: Loaded): void => {
    (loaded.session.ctx.sessionManager as unknown as Record<string, unknown>).getRecentActiveEntries = throwing(message);
  };
  /** Another extension's pi.routing.registry.v1: it passes pi-cache-optimizer's shape check, but its registerRouter throws. */
  const breakRegistry = (): void => {
    (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTING_REGISTRY_KEY)] = { version: 1, registerRouter: throwing("broken registry"), getRouter: () => undefined };
  };
  const ROSTER_LIMITS = { auto: { contextWindow: 128_000, maxTokens: 32_000 }, local: { contextWindow: 262_144, maxTokens: 81_920 } };
  /** Hera's version 2 roster, under which a resumed session's level is seeded after the last responder. */
  const HERA_V2 = fixture("roster-hera-v2.json");
  const V2_LIMITS = { auto: { contextWindow: 128_000, maxTokens: 32_000 }, local: { contextWindow: 262_144, maxTokens: 81_920 } };
  /** The level record a session at HIGH left, which session_start reads after the seed. */
  const heldHigh = (session: Loaded["session"]): void => session.appendCustom(LEVEL_ENTRY, { v: 1, at: NOW - 60_000, scope: "personal", source: "tag", tier: "high", asked: "high", tag: "high", ref: SOL });
  const conflict = "Virtual model smart-router/auto conflicts with a registered model";

  interface Case {
    readonly name: string;
    readonly reason: "new" | "fork" | "resume";
    /** The selection the session starts on, which the router must leave as it is. */
    readonly restored: string;
    /** What breaks, after the factory ran and before session_start. */
    readonly breaks: (loaded: Loaded) => void;
    readonly options?: Partial<LoadOptions>;
    readonly roster?: string | null;
    /** The level role session_start seeds after the last responder, when the row's session holds one (heldHigh). */
    readonly held?: string;
    /** The failure reported, or undefined when no notice can be shown at all. */
    readonly failure: string | undefined;
    /** Whether the roster is read: false where the agent directory cannot be found, or no roster file exists. */
    readonly rosterRead: boolean;
    /** Whether session_start registers both models again: not when registering is what throws. */
    readonly registersAgain: boolean;
    /** Whether the last responder is seeded: not when the seed read is what throws. */
    readonly seeded: boolean;
  }

  const cases: readonly Case[] = [
    {
      name: "/new, when the seed read of the new session throws",
      reason: "new",
      restored: KIMI,
      breaks: failSeed("database is locked"),
      roster: HERA_V2,
      held: "high",
      failure: "database is locked",
      rosterRead: true,
      registersAgain: true,
      seeded: false,
    },
    { name: "a fork, when another extension's routing registry throws", reason: "fork", restored: KIMI, breaks: breakRegistry, failure: "broken registry", rosterRead: true, registersAgain: true, seeded: true },
    {
      name: "/new, when registering the models again throws",
      reason: "new",
      restored: KIMI,
      breaks: (loaded) => {
        loaded.host.api.registerVirtualModel = throwing(conflict);
      },
      failure: conflict,
      rosterRead: true,
      registersAgain: false,
      seeded: true,
    },
    {
      name: "/new, when Pi's agent directory cannot be found",
      reason: "new",
      restored: KIMI,
      breaks: () => {},
      options: { build: (pi, options) => createRouter(pi, { ...options, agentDir: throwing("HOME is not set") }) },
      failure: "HOME is not set",
      rosterRead: false,
      registersAgain: true,
      seeded: true,
    },
    {
      name: "/new, when no notice can be shown and the roster is missing",
      reason: "new",
      restored: KIMI,
      breaks: (loaded) => {
        (loaded.session.ctx.ui as unknown as Record<string, unknown>).notify = throwing("the terminal is gone");
      },
      roster: null,
      failure: undefined,
      rosterRead: false,
      registersAgain: true,
      seeded: true,
    },
    {
      name: "a resume, when the seed read throws, restored on a model picked by hand",
      reason: "resume",
      restored: KIMI,
      breaks: failSeed("Cycle in session ancestry at e3"),
      roster: HERA_V2,
      held: "high",
      failure: "Cycle in session ancestry at e3",
      rosterRead: true,
      registersAgain: true,
      seeded: false,
    },
    {
      name: "a resume, when the seed read throws, restored on smart-router/local",
      reason: "resume",
      restored: "smart-router/local",
      breaks: failSeed("Cycle in session ancestry at e3"),
      roster: HERA_V2,
      held: "high",
      failure: "Cycle in session ancestry at e3",
      rosterRead: true,
      registersAgain: true,
      seeded: false,
    },
  ];

  for (const row of cases) {
    test(row.name, async (t) => {
      const loaded = load({ dir: agentDir(t, row.roster === undefined ? {} : { roster: row.roster }), runtime: new FakeRuntime(), now: () => NOW, ...row.options });
      loaded.session.appendAssistant(assistant(DEEPSEEK, { timestamp: NOW - 60_000 }));
      if (row.held !== undefined) heldHigh(loaded.session);
      row.breaks(loaded);
      loaded.session.select(row.restored);
      const registrations = loaded.runtime.registrations;
      await loaded.host.emit("session_start", { reason: row.reason });
      const messages = loaded.session.notices.map((notice) => notice.message);
      if (row.failure === undefined) {
        assert.deepEqual(messages, [], "no notice can be shown, and the handler's failure reaches nothing");
      } else {
        assert.ok(messages.includes(`pi-smart-router: the session_start handler failed: ${row.failure}`), `the failed step is reported: ${JSON.stringify(messages)}`);
      }
      const limits = row.roster === HERA_V2 ? V2_LIMITS : ROSTER_LIMITS;
      assert.deepEqual(loaded.router?.limits(), row.rosterRead ? limits : { auto: DEFAULT_LIMITS, local: DEFAULT_LIMITS }, row.rosterRead ? "the roster was read" : "no roster could be read");
      assert.equal(loaded.runtime.registrations - registrations, row.registersAgain ? 2 : 0, row.registersAgain ? "both models were registered again" : "registering again failed");
      for (const id of ["auto", "local"] as const) assert.ok(loaded.runtime.find("smart-router", id) !== undefined, `smart-router/${id} is registered`);
      if (row.registersAgain) {
        assert.equal(loaded.runtime.find("smart-router", "local")?.contextWindow, (row.rosterRead ? limits : { local: DEFAULT_LIMITS }).local.contextWindow, "with the limits the roster gave");
      }
      assert.equal(loaded.router?.record(loaded.session.id)?.last?.ref, row.seeded ? DEEPSEEK : undefined, row.seeded ? "the last responder was seeded" : "the seed read failed");
      if (row.held !== undefined) assert.equal(loaded.router?.record(loaded.session.id)?.levelRole, row.held, "the step after the failed seed still ran: the session's level was seeded");
      assert.deepEqual([`${loaded.session.model?.provider}/${loaded.session.model?.id}`, loaded.host.selections.length], [row.restored, 0], "the selection the session started on is left as it is");
    });
  }
});
