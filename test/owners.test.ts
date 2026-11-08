import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { afterEach, beforeEach, describe } from "node:test";

import { ENV_PIN, SLOT_KEY } from "../src/constants.ts";
import { stale } from "../src/errors.ts";
import { EMPTY_POLICY } from "../src/local.ts";
import { envSwitchOn, isLive, join, latchEnvPin, ownerBySignal, processSlot, sessionHash } from "../src/owners.ts";
import { envPin } from "../src/router.ts";
import { ASTRA, DEEPSEEK, KIMI, NOW, rosterFixture, SOL } from "./support/catalog.ts";
import { agentDir, assistant, FakeRuntime, load, previous, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded } from "./support/pi.ts";

const PLANNING = "plan the migration to the new store";

beforeEach(resetSlot);
afterEach(resetSlot);

/** Count the calls that reach an instance's dispatch, which is what its registered route calls. */
function countDispatch(loaded: Loaded): { count: number } {
  const router = loaded.router;
  assert.ok(router !== undefined);
  const original = router.dispatch;
  const counter = { count: 0 };
  router.dispatch = (...args) => {
    counter.count += 1;
    return original(...args);
  };
  return counter;
}

describe("the process slot", () => {
  test("is created once, hidden, and shared by every load", () => {
    const slot = processSlot();
    assert.equal(processSlot(), slot);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for(SLOT_KEY));
    assert.deepEqual([descriptor?.enumerable, descriptor?.writable], [false, false]);
    assert.deepEqual([slot.version, slot.owners.size, slot.env, slot.handoffs.size, slot.adapter], [1, 0, { on: false, policy: undefined }, 0, undefined]);
  });

  test("of another shape makes the factory fail closed: both models refuse, and no router handler is wired", async (t) => {
    (globalThis as Record<symbol, unknown>)[Symbol.for(SLOT_KEY)] = { version: 2 };
    assert.throws(() => processSlot(), /holds an unknown shape/);
    const loaded = load({ dir: agentDir(t) });
    assert.equal(loaded.router, undefined);
    assert.deepEqual([...loaded.host.handlers.keys()], ["session_start"]);
    loaded.session.select("auto");
    for (const id of ["auto", "local"] as const) {
      assert.throws(() => loaded.runtime.route(id, request("direct")), {
        message: new RegExp(`^smart-router/${id}: pi-smart-router failed to load \\(globalThis\\[Symbol\\.for\\("jwiegley\\.pi-smart-router\\.v1"\\)\\] holds an unknown shape`),
      });
    }
    await loaded.host.emit("session_start", { reason: "startup" });
    assert.deepEqual(loaded.session.notices.map((notice) => notice.type), ["error"]);
  });

  test("keys owners by pi-cache-optimizer's session hash", async (t) => {
    await start({ dir: agentDir(t), id: "019a-session" });
    const [owner] = processSlot().owners;
    assert.equal(owner?.hash, createHash("sha256").update("019a-session").digest("hex").slice(0, 16));
    assert.equal(sessionHash("019a-session"), owner?.hash);
  });
});

describe("the environment switch", () => {
  test("any non-blank value but 0, false or off turns it on; near misses fail closed", () => {
    for (const value of ["1", "on", "yes", "true", "no", "of", "flase", " ON ", "0x"]) assert.equal(envSwitchOn(value), true, value);
    for (const value of [undefined, "", "  ", "0", "false", "off", "OFF", " False "]) assert.equal(envSwitchOn(value), false, String(value));
  });

  test("is latched for the life of the process", () => {
    const slot = processSlot();
    assert.equal(latchEnvPin(slot, undefined), false);
    assert.equal(latchEnvPin(slot, "1"), true);
    assert.equal(latchEnvPin(slot, undefined), true, "removing the variable leaves it on");
    assert.equal(latchEnvPin(slot, "off"), true);
  });

  test("the factory latches it, and routing is pinned by it from then on", async (t) => {
    const saved = process.env[ENV_PIN];
    try {
      process.env[ENV_PIN] = "1";
      const first = await start({ dir: agentDir(t), id: "first" });
      delete process.env[ENV_PIN];
      const second = await start({ dir: agentDir(t), id: "second", runtime: new FakeRuntime() });
      assert.equal(processSlot().env.on, true);
      assert.deepEqual(envPin(second.session.ctx, rosterFixture("roster-hera.json"), processSlot()), { on: true, policy: EMPTY_POLICY });
      // With no policy latched for the switch, no model qualifies: the router refuses rather than guess.
      for (const loaded of [first, second]) {
        assert.throws(() => loaded.runtime.route("local", request("direct")), { message: /^smart-router\/local: no local model can take this request while this session is pinned/ });
        assert.throws(() => loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, KIMI) })), { message: /^smart-router\/auto: .*pinned to local models/ });
      }
    } finally {
      if (saved === undefined) delete process.env[ENV_PIN];
      else process.env[ENV_PIN] = saved;
    }
  });
});

describe("the dispatch", () => {
  test("an owner's loop requests reach it by run signal through another instance's route", async (t) => {
    const runtime = new FakeRuntime();
    const dir = agentDir(t);
    const parent = await start({ dir, runtime, id: "parent" });
    const parentRoute = runtime.virtual.get("smart-router/auto");
    await parent.host.emit("input", { text: PLANNING, source: "interactive" });
    // A nested session on the same runtime loads the router and binds, which replaces the route,
    // but never starts, as goal-x's auditor with project resources does. (The parent's next idle
    // prompt or turn_start would take the route back; this request comes before either.)
    const nested = load({ dir, runtime, id: "nested" });
    assert.notEqual(runtime.virtual.get("smart-router/auto"), parentRoute, "the nested registration replaced the parent's");
    const through = countDispatch(nested);
    const signal = parent.session.startRun();
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), ASTRA);
    assert.equal(through.count, 1, "the request went through the nested instance's route");
    assert.equal(parent.router?.record("parent")?.plan, undefined, "the parent's plan was consumed");
    assert.equal(parent.router?.record("parent")?.history.at(-1)?.code, "signal:planning");
    assert.deepEqual([nested.router?.record("parent"), nested.router?.record("nested")], [undefined, undefined]);
    nested.session.dispose();
    assert.equal(routed(runtime.route("auto", request("continuation", { signal, previous: previous(runtime, ASTRA) }))), ASTRA);
    assert.equal(parent.router?.record("parent")?.history.at(-1)?.code, "stick:previous");
    assert.equal(through.count, 2, "a disposed instance's route still sends the owner's loop to its owner");
  });

  test("a stale passed context makes the displaced owner register again and serve the request", async (t) => {
    const runtime = new FakeRuntime();
    const dir = agentDir(t);
    const parent = await start({ dir, runtime, id: "parent" });
    const nested = load({ dir, runtime, id: "nested" });
    nested.session.dispose();
    const registrations = runtime.registrations;
    assert.equal(routed(runtime.route("auto", request("direct", { previous: previous(runtime, KIMI) }))), KIMI);
    assert.equal(parent.router?.record("parent")?.history.at(-1)?.code, "direct:previous");
    assert.equal(runtime.registrations, registrations + 2, "the parent registered both models again");
    const counter = countDispatch(parent);
    runtime.route("auto", request("direct"));
    assert.equal(counter.count, 1, "the parent's own route is registered again");
  });

  test("with no displaced owner, a stale route refuses with the router's own error", async (t) => {
    const orphaned = new FakeRuntime();
    const dir = agentDir(t);
    const gone = await start({ dir, runtime: orphaned, id: "gone" });
    await gone.host.emit("session_shutdown", { reason: "quit" });
    gone.session.dispose();
    assert.throws(() => orphaned.route("auto", request("direct")), (error: unknown) => error instanceof Error && error.message === stale("auto").message);
    await start({ dir, runtime: new FakeRuntime(), id: "elsewhere" });
    assert.throws(() => orphaned.route("local", request("direct")), (error: unknown) => error instanceof Error && error.message === stale("local").message);
  });

  test("two displaced owners are ambiguous, and the router refuses instead of guessing", async (t) => {
    const dir = agentDir(t);
    const first = new FakeRuntime();
    const second = new FakeRuntime();
    await start({ dir, runtime: first, id: "a" });
    await start({ dir, runtime: second, id: "b" });
    load({ dir, runtime: first, id: "nested-a" }).session.dispose();
    const orphan = load({ dir, runtime: second, id: "nested-b" });
    orphan.session.dispose();
    assert.throws(() => second.route("auto", request("direct")), (error: unknown) => error instanceof Error && error.message === stale("auto").message);
  });

  test("a live sibling's registration is left alone; once the sibling is gone, the owner takes its route back", async (t) => {
    const runtime = new FakeRuntime();
    const dir = agentDir(t);
    const first = await start({ dir, runtime, id: "first" });
    const second = await start({ dir, runtime, id: "second" });
    const registrations = runtime.registrations;
    await first.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.equal(runtime.registrations, registrations, "the sibling is live");
    const one = first.session.startRun();
    const two = second.session.startRun();
    await first.host.emit("message_end", { message: assistant(KIMI) });
    assert.equal(routed(runtime.route("auto", request("continuation", { signal: one }))), KIMI);
    assert.equal(routed(runtime.route("auto", request("continuation", { signal: two }))), DEEPSEEK);
    assert.deepEqual(
      [first.router?.record("first")?.history.at(-1)?.code, second.router?.record("second")?.history.at(-1)?.code],
      ["stick:last", "stick:default"],
    );
    second.session.dispose();
    await first.host.emit("turn_start", { turnIndex: 1, timestamp: NOW });
    assert.equal(runtime.registrations, registrations + 2);
  });

  test("turn_start, compaction, tree navigation and idle prompts each heal a displaced registration", async (t) => {
    const dir = agentDir(t);
    for (const [event, payload] of [
      ["turn_start", { turnIndex: 0, timestamp: NOW }],
      ["session_before_compact", { reason: "manual" }],
      ["session_before_tree", { preparation: { userWantsSummary: false } }],
      ["input", { text: "hello", source: "interactive" }],
    ] as const) {
      resetSlot();
      const runtime = new FakeRuntime();
      const owner = await start({ dir, runtime, id: "owner" });
      load({ dir, runtime, id: "nested" }).session.dispose();
      const registrations = runtime.registrations;
      await owner.host.emit(event, payload);
      assert.equal(runtime.registrations, registrations + 2, event);
      await owner.host.emit(event, payload);
      assert.equal(runtime.registrations, registrations + 2, `${event}: healed once`);
    }
  });

  test("a prompt typed while busy does not heal", async (t) => {
    const dir = agentDir(t);
    const runtime = new FakeRuntime();
    const owner = await start({ dir, runtime, id: "owner" });
    load({ dir, runtime, id: "nested" }).session.dispose();
    owner.session.startRun();
    const registrations = runtime.registrations;
    await owner.host.emit("input", { text: "also this", source: "interactive", streamingBehavior: "steer" });
    assert.equal(runtime.registrations, registrations);
  });

  test("an owner whose context went stale without session_shutdown is dropped", async (t) => {
    const dir = agentDir(t);
    const slot = processSlot();
    const parent = await start({ dir, id: "parent" });
    const child = await start({ dir, runtime: new FakeRuntime(), id: "child" });
    assert.equal(slot.owners.size, 2);
    child.session.dispose();
    assert.equal(isLive(child.session.ctx), false);
    assert.equal(ownerBySignal(slot, new AbortController().signal), undefined);
    assert.deepEqual([...slot.owners].map((owner) => owner.sessionId), ["parent"]);
    const signal = parent.session.startRun();
    assert.equal(ownerBySignal(slot, signal)?.sessionId, "parent");
    const parentOwner = [...slot.owners][0];
    assert.ok(parentOwner !== undefined);
    const another = await start({ dir, runtime: new FakeRuntime(), id: "another" });
    another.session.dispose();
    assert.equal(slot.owners.size, 2);
    assert.equal(join(slot, parentOwner), true, "joining prunes the stale owner, leaving the parent alone");
    assert.deepEqual([...slot.owners].map((owner) => owner.sessionId), ["parent"]);
  });

  test("an owner-loop request never reaches a session that left", async (t) => {
    const runtime = new FakeRuntime();
    const dir = agentDir(t);
    const left = await start({ dir, runtime, id: "left" });
    const signal = left.session.startRun();
    await left.host.emit("session_shutdown", { reason: "quit" });
    assert.equal(ownerBySignal(processSlot(), signal), undefined);
    // Its own route still serves it as an ordinary request while its context is live.
    assert.equal(routed(runtime.route("auto", request("continuation", { signal, previous: previous(runtime, SOL) }))), SOL);
    assert.equal(left.router?.record("left")?.history.at(-1)?.code, "foreign:previous");
  });
});
