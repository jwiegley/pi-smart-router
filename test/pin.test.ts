import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";

import { ENV_PIN, PIN_ENTRY, ROUTING_REGISTRY_KEY } from "../src/constants.ts";
import { carriedNotice, PIN_POLICY_CHANGED, resumeNotice } from "../src/errors.ts";
import { EMPTY_POLICY, policyFromRoster } from "../src/local.ts";
import type { LocalPolicy } from "../src/local.ts";
import { processSlot } from "../src/owners.ts";
import { describePin, leaveHandoff, pinOff, pinOn, readPin, takeHandoff } from "../src/pin.ts";
import type { PinReading } from "../src/pin.ts";
import { createRouter } from "../src/router.ts";
import { FakeCatalog, GLM, heraModels, KIMI, model, NOW, rosterFixture } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, load, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded, LoadOptions } from "./support/pi.ts";

const HERA = rosterFixture("roster-hera.json");
const POLICY = policyFromRoster(HERA);
const LAN_BOX = "lan-box/qwen-9";
const LAN_POLICY: LocalPolicy = { refs: [LAN_BOX], providers: ["lan-box"], hosts: ["10.0.0.9"] };
const AT = new Date(NOW).toISOString();

beforeEach(resetSlot);
afterEach(resetSlot);

/** A session manager whose latest pin entry is `entry`. */
function holding(entry: unknown): object {
  return { getLatestCustomEntry: () => entry, getRecentActiveEntries: () => [] };
}

const custom = (data: unknown, type = "custom") => ({ type, customType: PIN_ENTRY, data, id: "e1", parentId: null, timestamp: AT });
const OFF_ENV = { on: false, policy: undefined };
const pinOf = (loaded: Loaded): PinReading => readPin(loaded.session.ctx.sessionManager, processSlot().env);

function withEnv(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env[ENV_PIN];
  if (value === undefined) delete process.env[ENV_PIN];
  else process.env[ENV_PIN] = value;
  return run().finally(() => {
    if (saved === undefined) delete process.env[ENV_PIN];
    else process.env[ENV_PIN] = saved;
  });
}

describe("the pin entry", () => {
  test("/smart-router local on records the roster's local policy, and the pin is read over the whole session", async (t) => {
    const loaded = await start({ dir: agentDir(t), now: () => NOW });
    assert.equal(pinOf(loaded).on, false);
    await loaded.host.command("smart-router", "local on");
    assert.deepEqual(loaded.session.pinEntries(), [{ v: 1, on: true, at: AT, local: { refs: [GLM], providers: ["omlx-hera"], hosts: ["hera.lan"] } }]);
    assert.deepEqual(pinOf(loaded), { on: true, policy: POLICY, entry: "on", at: AT, env: false });
    assert.ok(loaded.session.boundedReads.some((read) => JSON.stringify(read) === JSON.stringify({ customType: PIN_ENTRY, scope: "all" })));
    assert.equal(loaded.session.model?.id, "local", "the selection moved from smart-router/auto to smart-router/local");
    assert.equal(loaded.session.statuses.get("smart-router"), "local models");
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("the read fails closed: only an explicit custom {v: 1, on: false} entry unpins", () => {
    const malformed: PinReading = { on: true, policy: EMPTY_POLICY, entry: "malformed", at: undefined, env: false };
    const cases: Array<[string, unknown, Partial<PinReading>]> = [
      ["no entry", undefined, { on: false, policy: EMPTY_POLICY, entry: "none" }],
      ["an unpinning entry", custom(pinOff(NOW)), { on: false, entry: "off", at: AT }],
      ["an unpinning entry without a time", custom({ v: 1, on: false }), { on: false, entry: "off", at: undefined }],
      ["a pinning entry", custom(pinOn(POLICY, NOW)), { on: true, policy: POLICY, entry: "on", at: AT }],
      ["a pinning entry recorded without a policy", custom({ v: 1, on: true, at: AT }), { on: true, policy: EMPTY_POLICY, entry: "on" }],
      ["a custom_message of the type", custom({ v: 1, on: false }, "custom_message"), malformed],
      ["another version", custom({ v: 2, on: false }), malformed],
      ["on that is not a boolean", custom({ v: 1, on: "false" }), malformed],
      ["an unknown key", custom({ v: 1, on: false, by: "another extension" }), malformed],
      ["an unpinning entry that carries a policy", custom({ ...pinOff(NOW), local: pinOn(POLICY, NOW).local }), malformed],
      ["a time that is not a string", custom({ v: 1, on: false, at: 5 }), malformed],
      ["data that is not an object", custom("off"), malformed],
      ["no data", { type: "custom", customType: PIN_ENTRY }, malformed],
      ["a policy with a cloud host", custom({ v: 1, on: true, local: { refs: [KIMI], providers: ["openrouter"], hosts: ["openrouter.ai"] } }), malformed],
      ["a policy whose model is outside its providers", custom({ v: 1, on: true, local: { refs: [KIMI], providers: ["omlx-hera"], hosts: ["hera.lan"] } }), malformed],
      ["a policy with an extra key", custom({ v: 1, on: true, local: { ...pinOn(POLICY, NOW).local, blockTools: [] } }), malformed],
      ["an entry of another type", { ...custom(pinOff(NOW)), customType: "other" }, malformed],
    ];
    for (const [name, entry, expected] of cases) {
      const reading = readPin(holding(entry), OFF_ENV);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(reading[key as keyof PinReading], value, `${name}: ${key}`);
    }
  });

  test("a session whose pin cannot be read counts as pinned, with an empty policy", () => {
    const unreadable = { on: true, policy: EMPTY_POLICY, entry: "unreadable", at: undefined, env: false };
    assert.deepEqual(readPin(undefined, OFF_ENV), unreadable);
    assert.deepEqual(readPin({ getLatestCustomEntry: () => undefined }, OFF_ENV), unreadable, "no bounded reader");
    const failing = { getLatestCustomEntry: () => assert.fail("index unavailable"), getRecentActiveEntries: () => [] };
    assert.deepEqual(readPin(failing, OFF_ENV), unreadable, "a reader that throws");
  });

  test("the latest entry wins", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: "local" });
    loaded.session.pin(POLICY);
    loaded.session.unpin();
    assert.equal(pinOf(loaded).on, false);
    loaded.session.pin(LAN_POLICY);
    assert.deepEqual(pinOf(loaded).policy, LAN_POLICY);
    loaded.session.appendCustom(PIN_ENTRY, { v: 1, on: false }, "custom_message");
    assert.deepEqual([pinOf(loaded).on, pinOf(loaded).policy], [true, EMPTY_POLICY], "a stray custom_message after an unpin pins");
  });

  test("the environment switch pins every session no entry pins, with its latched policy", () => {
    const env = { on: true, policy: POLICY };
    assert.deepEqual(readPin(holding(undefined), env), { on: true, policy: POLICY, entry: "none", at: undefined, env: true });
    assert.deepEqual(readPin(holding(custom(pinOff(NOW))), env), { on: true, policy: POLICY, entry: "off", at: AT, env: true });
    assert.deepEqual(readPin(holding(custom(pinOn(LAN_POLICY, NOW))), env).policy, LAN_POLICY, "a session's own pin keeps its recorded policy");
    assert.deepEqual(readPin(holding(custom({ v: 9 })), env).policy, EMPTY_POLICY);
    assert.deepEqual(readPin(holding(undefined), { on: true, policy: undefined }).policy, EMPTY_POLICY, "nothing latched yet: nothing qualifies");
    assert.match(describePin(readPin(holding(custom(pinOff(NOW))), env)), /^on, by PI_SMART_ROUTER_LOCAL_ONLY, .*the switch pins every session/);
  });
});

describe("the recorded policy", () => {
  async function edited(t: Parameters<typeof agentDir>[0]) {
    const dir = agentDir(t);
    const catalog = new FakeCatalog([...heraModels(), model(LAN_BOX, { baseUrl: "http://10.0.0.9:8080/v1", contextWindow: 32_768, maxTokens: 8_192 })]);
    const pinned = await start({ dir, runtime: new FakeRuntime(catalog), select: "local", id: "pinned", setup: (session) => session.pin(POLICY) });
    const roster = JSON.parse(fixture("roster-hera.json"));
    roster.roles[0].models = [LAN_BOX];
    roster.local = { role: "local", providers: ["lan-box"], hosts: ["10.0.0.9"] };
    writeFileSync(join(dir, "smart-router.json"), JSON.stringify(roster));
    utimesSync(join(dir, "smart-router.json"), new Date(), new Date(Date.now() + 5_000));
    await pinned.host.command("smart-router", "reload");
    return { dir, catalog, pinned };
  }

  test("a roster edit cannot widen it: the new local model is refused until John pins again", async (t) => {
    const { dir, catalog, pinned } = await edited(t);
    const signal = pinned.session.startRun();
    let message = "";
    assert.throws(
      () => pinned.runtime.route("local", request("continuation", { signal })),
      (error: unknown) => {
        message = error instanceof Error ? error.message : "";
        return true;
      },
    );
    assert.ok(message.includes(`${LAN_BOX}: ${PIN_POLICY_CHANGED}`), message);
    assert.match(message, /Nothing was sent\. Run \/smart-router local on to accept the roster's local role, or run \/smart-router local off\.$/);
    assert.equal(isRetryableAssistantError(assistant("smart-router/local", { stopReason: "error", errorMessage: message })), false);
    // An unpinned session follows the roster.
    const unpinned = await start({ dir, runtime: new FakeRuntime(catalog), select: "local", id: "unpinned" });
    assert.equal(routed(unpinned.runtime.route("local", request("direct"))), LAN_BOX);
    // Pinning again accepts the roster's new local section.
    pinned.session.endRun();
    await pinned.host.command("smart-router", "local on");
    assert.deepEqual(pinOf(pinned).policy, LAN_POLICY);
    const next = pinned.session.startRun();
    assert.equal(routed(pinned.runtime.route("local", request("continuation", { signal: next }))), LAN_BOX);
  });

  test("a model the recorded policy holds stays allowed after the edit", async (t) => {
    const { pinned } = await edited(t);
    await pinned.host.choose(GLM);
    assert.equal(pinned.session.model?.provider, "omlx-hera", "GLM, chosen directly, is still local under the recorded policy");
    await pinned.host.choose(LAN_BOX);
    assert.equal(pinned.session.model?.provider, "omlx-hera", "the roster's new local model is not, so the choice was reverted");
  });
});

describe("handoffs", () => {
  test("/new and a fork carry the pin, keyed by the new session's file: two concurrent forks both inherit", async (t) => {
    const dir = agentDir(t);
    const a = await start({ dir, id: "a", file: "/sessions/a.jsonl", select: "local", setup: (session) => session.pin(POLICY) });
    const b = await start({ dir, id: "b", file: "/sessions/b.jsonl", runtime: new FakeRuntime(), select: "local", setup: (session) => session.pin(LAN_POLICY) });
    const c = await start({ dir, id: "c", file: "/sessions/c.jsonl", runtime: new FakeRuntime(), select: "local", setup: (session) => session.pin(POLICY) });
    await a.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/a-fork.jsonl" });
    await b.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/b-fork.jsonl" });
    await c.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/c-new.jsonl" });
    assert.equal(processSlot().handoffs.size, 3);
    const inherited: Array<[string, LocalPolicy]> = [
      ["/sessions/b-fork.jsonl", LAN_POLICY],
      ["/sessions/a-fork.jsonl", POLICY],
      ["/sessions/c-new.jsonl", POLICY],
    ];
    for (const [file, policy] of inherited) {
      // A new session starts on the settings default, a cloud model.
      const child = await start({ dir, id: file, file, runtime: new FakeRuntime(), select: KIMI });
      assert.deepEqual(pinOf(child), { on: true, policy, entry: "on", at: pinOf(child).at, env: false }, file);
      assert.equal(child.session.model?.id, "local", `${file}: switched to smart-router/local`);
      assert.ok(child.session.notices.some((notice) => /pinned to local models, as the session it came from was/.test(notice.message)), file);
    }
    assert.equal(processSlot().handoffs.size, 0, "each handoff is taken once");
  });

  test("a pin that cannot be recorded in the new session says so", async (t) => {
    const dir = agentDir(t);
    const parent = await start({ dir, id: "parent", file: "/sessions/p.jsonl", select: "local", setup: (session) => session.pin(POLICY) });
    await parent.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/p-new.jsonl" });
    const child = load({ dir, id: "child", file: "/sessions/p-new.jsonl", runtime: new FakeRuntime() });
    child.host.api.appendEntry = () => {
      throw new Error("the session file is read-only");
    };
    child.session.select(KIMI);
    await child.host.emit("session_start", { reason: "new" });
    assert.ok(
      child.session.notices.some(
        (notice) =>
          notice.type === "error" &&
          notice.message === "pi-smart-router: the session this one came from was pinned to local models, but its pin could not be recorded here (the session file is read-only). Run /smart-router local on before you send anything.",
      ),
    );
  });

  test("an in-memory session, quitting or reloading leaves no handoff", async (t) => {
    const dir = agentDir(t);
    const memory = await start({ dir, id: "memory", select: "local", setup: (session) => session.pin(POLICY) });
    await memory.host.emit("session_shutdown", { reason: "fork" });
    for (const reason of ["quit", "reload"]) {
      const loaded = await start({ dir, id: reason, file: `/sessions/${reason}.jsonl`, runtime: new FakeRuntime(), select: "local", setup: (session) => session.pin(POLICY) });
      await loaded.host.emit("session_shutdown", { reason, targetSessionFile: `/sessions/${reason}-next.jsonl` });
    }
    assert.equal(processSlot().handoffs.size, 0);
  });

  test("an unpinned session, or one only the switch pins, hands nothing on", async (t) => {
    const dir = agentDir(t);
    const plain = await start({ dir, id: "plain", file: "/sessions/plain.jsonl" });
    await plain.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/plain-new.jsonl" });
    assert.equal(processSlot().handoffs.size, 0);
    await withEnv("1", async () => {
      const env = await start({ dir, id: "env", file: "/sessions/env.jsonl", runtime: new FakeRuntime() });
      assert.equal(pinOf(env).on, true);
      await env.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/env-fork.jsonl" });
      assert.equal(processSlot().handoffs.size, 0, "the latch pins the fork without a handoff");
      const fork = await start({ dir, id: "env-fork", file: "/sessions/env-fork.jsonl", runtime: new FakeRuntime() });
      assert.equal(pinOf(fork).on, true);
      assert.deepEqual(fork.session.pinEntries(), []);
    });
  });

  test("leaving a pinned session by resume leaves only a notice, shown when the resumed session is not pinned", async (t) => {
    const dir = agentDir(t);
    for (const [target, pinnedThere] of [
      ["/sessions/old.jsonl", false],
      ["/sessions/old-pinned.jsonl", true],
    ] as const) {
      const leaving = await start({ dir, id: `${target}-from`, file: "/sessions/current.jsonl", runtime: new FakeRuntime(), select: "local", setup: (session) => session.pin(POLICY) });
      await leaving.host.emit("session_shutdown", { reason: "resume", targetSessionFile: target });
      const resumed = await start({
        dir,
        id: target,
        file: target,
        runtime: new FakeRuntime(),
        select: "local",
        ...(pinnedThere ? { setup: (session: Loaded["session"]) => session.pin(POLICY) } : {}),
      });
      assert.equal(resumed.session.notices.some((notice) => notice.message === resumeNotice()), !pinnedThere, target);
      assert.equal(pinOf(resumed).on, pinnedThere, "a resume never pins");
      assert.deepEqual(resumed.session.pinEntries().length, pinnedThere ? 1 : 0);
    }
  });

  test("a resume notice never replaces a pin left for the same file, and a malformed handoff pins with an empty policy", () => {
    const slot = processSlot();
    const pinned: PinReading = { on: true, policy: POLICY, entry: "on", at: AT, env: false };
    leaveHandoff(slot, "fork", "/sessions/x.jsonl", pinned);
    leaveHandoff(slot, "resume", "/sessions/x.jsonl", pinned);
    assert.deepEqual(takeHandoff(slot, "/sessions/x.jsonl"), { kind: "pin", policy: POLICY });
    assert.equal(takeHandoff(slot, "/sessions/x.jsonl"), undefined);
    slot.handoffs.set("/sessions/y.jsonl", { kind: "pin", policy: { refs: [KIMI], providers: ["openrouter"], hosts: ["openrouter.ai"] } });
    assert.deepEqual(takeHandoff(slot, "/sessions/y.jsonl"), { kind: "pin", policy: EMPTY_POLICY });
    slot.handoffs.set("/sessions/z.jsonl", "garbage");
    assert.deepEqual(takeHandoff(slot, "/sessions/z.jsonl"), { kind: "pin", policy: EMPTY_POLICY });
    leaveHandoff(slot, "fork", "/sessions/m.jsonl", { ...pinned, policy: EMPTY_POLICY, entry: "malformed" });
    assert.deepEqual(takeHandoff(slot, "/sessions/m.jsonl"), { kind: "pin", policy: EMPTY_POLICY }, "a malformed pin carries over as a pin");
    for (const target of [undefined, "", 7]) leaveHandoff(slot, "fork", target, pinned);
    assert.equal(slot.handoffs.size, 0);
  });
});

describe("session_start keeps the pin when another of its steps fails", () => {
  const LOCAL = "smart-router/local";
  const selection = (loaded: Loaded): string => `${loaded.session.model?.provider}/${loaded.session.model?.id}`;
  const reported = (loaded: Loaded, reason: string): boolean =>
    loaded.session.notices.some((notice) => notice.message === `pi-smart-router: the session_start handler failed: ${reason}`);

  const throwing = (message: string) => () => {
    throw new Error(message);
  };
  /** A seed read that fails, as a locked or damaged session index does. */
  const failSeed = (loaded: Loaded, message: string): void => {
    (loaded.session.ctx.sessionManager as unknown as Record<string, unknown>).getRecentActiveEntries = throwing(message);
  };
  /** Another extension's pi.routing.registry.v1: it passes pi-cache-optimizer's shape check, but its registerRouter throws. */
  const breakRegistry = (): void => {
    (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTING_REGISTRY_KEY)] = { version: 1, registerRouter: throwing("broken registry"), getRouter: () => undefined };
  };

  /** A pinned session leaves by /new or a fork, and the new session starts on a cloud model after `breaks` broke one of its steps. */
  async function inherit(
    t: Parameters<typeof agentDir>[0],
    reason: "new" | "fork",
    breaks: (child: Loaded) => void,
    { roster, ...options }: Partial<LoadOptions> & { readonly roster?: string | null } = {},
  ): Promise<Loaded> {
    const dir = agentDir(t, roster === undefined ? {} : { roster });
    const parent = await start({ dir, id: "parent", file: "/sessions/p.jsonl", select: "local", setup: (session) => session.pin(POLICY) });
    await parent.host.emit("session_shutdown", { reason, targetSessionFile: "/sessions/child.jsonl" });
    assert.equal(processSlot().handoffs.size, 1);
    const child = load({ dir, id: "child", file: "/sessions/child.jsonl", runtime: new FakeRuntime(), now: () => NOW, ...options });
    breaks(child);
    child.session.select(KIMI);
    await child.host.emit("session_start", { reason });
    return child;
  }

  /** The new session recorded the pin it carried, took its handoff, and switched to smart-router/local. */
  function assertCarried(child: Loaded): void {
    assert.deepEqual(pinOf(child), { on: true, policy: POLICY, entry: "on", at: AT, env: false }, "the pin was recorded in the new session");
    assert.equal(processSlot().handoffs.size, 0, "the handoff was taken");
    assert.equal(selection(child), LOCAL, "the cloud selection was switched to smart-router/local");
    assert.equal(child.session.statuses.get("smart-router"), "local models");
  }

  function assertPinned(child: Loaded, failure: string): void {
    assertCarried(child);
    assert.ok(child.session.notices.some((notice) => notice.message === carriedNotice()));
    assert.ok(reported(child, failure), JSON.stringify(child.session.notices));
  }

  test("/new, when the seed read of the new session throws", async (t) => {
    assertPinned(await inherit(t, "new", (child) => failSeed(child, "database is locked")), "database is locked");
  });

  test("a fork, when another extension's routing registry throws", async (t) => {
    assertPinned(await inherit(t, "fork", breakRegistry), "broken registry");
  });

  test("/new, when registering the models again throws", async (t) => {
    const conflict = "Virtual model smart-router/auto conflicts with a registered model";
    assertPinned(
      await inherit(t, "new", (child) => {
        child.host.api.registerVirtualModel = throwing(conflict);
      }),
      conflict,
    );
  });

  test("/new, when Pi's agent directory cannot be found", async (t) => {
    const build: NonNullable<LoadOptions["build"]> = (pi, options) => createRouter(pi, { ...options, agentDir: throwing("HOME is not set") });
    assertPinned(await inherit(t, "new", () => {}, { build }), "HOME is not set");
  });

  test("a resume, when the seed read throws: the restored cloud selection is switched at once", async (t) => {
    const loaded = load({ dir: agentDir(t), id: "resumed", file: "/sessions/r.jsonl", setup: (session) => session.pin(POLICY) });
    failSeed(loaded, "Cycle in session ancestry at e3");
    loaded.session.select(KIMI);
    await loaded.host.emit("session_start", { reason: "resume" });
    assert.equal(selection(loaded), LOCAL);
    assert.equal(loaded.session.statuses.get("smart-router"), "local models");
    assert.ok(reported(loaded, "Cycle in session ancestry at e3"));
  });

  test("/new, when no notice can be shown and the roster is missing", async (t) => {
    // Every notice fails, the carried pin's and the missing roster's alike.
    const breakNotices = (child: Loaded): void => {
      (child.session.ctx.ui as unknown as Record<string, unknown>).notify = throwing("the terminal is gone");
    };
    assertCarried(await inherit(t, "new", breakNotices, { roster: null }));
  });

  test("a step that fails leaves the others to run", async (t) => {
    breakRegistry();
    const loaded = load({ dir: agentDir(t), runtime: new FakeRuntime() });
    loaded.session.appendAssistant(assistant(KIMI, { timestamp: NOW - 60_000 }));
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "resume" });
    assert.ok(reported(loaded, "broken registry"));
    assert.deepEqual(loaded.router?.limits(), { auto: { contextWindow: 128_000, maxTokens: 32_000 }, local: { contextWindow: 262_144, maxTokens: 81_920 } }, "the roster was read");
    assert.equal(loaded.runtime.find("smart-router", "local")?.contextWindow, 262_144, "both models were registered again with its limits");
    assert.equal(loaded.router?.record(loaded.session.id)?.last?.ref, KIMI, "the last responder was seeded");
  });
});

describe("/smart-router local off", () => {
  test("asks first, defaulting to No, then unpins, clears the lock and keeps the selection", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: "local", setup: (session) => session.pin(POLICY), now: () => NOW });
    await loaded.host.command("smart-router", "local off");
    assert.deepEqual(loaded.session.dialogs, ["Unpin this session from local models?"]);
    assert.equal(pinOf(loaded).on, true, "the dialog's default answer is No");
    const record = loaded.router?.record("session-1");
    assert.ok(record !== undefined);
    record.guard.lock = { since: NOW, model: KIMI, cause: "conflict" };
    loaded.session.confirmAnswer = true;
    await loaded.host.command("smart-router", "local off");
    assert.deepEqual(loaded.session.pinEntries().at(-1), { v: 1, on: false, at: AT });
    assert.deepEqual([pinOf(loaded).on, pinOf(loaded).entry], [false, "off"]);
    assert.equal(record.guard.lock, undefined);
    assert.equal(loaded.session.statuses.get("smart-router"), undefined);
    assert.equal(loaded.session.model?.id, "local", "the selection stays as it is");
    assert.match(loaded.session.notices.at(-1)?.message ?? "", /no longer pinned, and the selection stays smart-router\/local\. The next requests may go to cloud models\.$/);
  });

  test("refuses without dialogs, under the environment switch, and where pins cannot be read", async (t) => {
    const dir = agentDir(t);
    const headless = await start({ dir, id: "headless", select: "local", setup: (session) => session.pin(POLICY) });
    headless.session.hasUI = false;
    headless.session.confirmAnswer = true;
    await headless.host.command("smart-router", "local off");
    assert.deepEqual([headless.session.dialogs, headless.session.pinEntries().length, pinOf(headless).on], [[], 1, true]);
    assert.match(headless.session.notices.at(-1)?.message ?? "", /asks for confirmation, and this mode has no dialogs/);
    await withEnv("yes", async () => {
      const env = await start({ dir, id: "env", runtime: new FakeRuntime(), select: "local", setup: (session) => session.pin(POLICY) });
      env.session.confirmAnswer = true;
      await env.host.command("smart-router", "local off");
      assert.deepEqual([env.session.dialogs, env.session.pinEntries().length], [[], 1]);
      assert.match(env.session.notices.at(-1)?.message ?? "", /PI_SMART_ROUTER_LOCAL_ONLY pins every session in this process/);
    });
    resetSlot();
    const unbounded = await start({ dir, id: "unbounded", runtime: new FakeRuntime(), bounded: false, select: "local" });
    unbounded.session.confirmAnswer = true;
    await unbounded.host.command("smart-router", "local off");
    assert.deepEqual(unbounded.session.dialogs, []);
    assert.match(unbounded.session.notices.at(-1)?.message ?? "", /cannot read pin entries/);
  });
});

test("a Pi without bounded history counts every session as pinned, and says so", async (t) => {
  const loaded = load({ dir: agentDir(t), bounded: false });
  loaded.session.select(KIMI);
  await loaded.host.emit("session_start", { reason: "startup" });
  assert.match(loaded.session.notices[0]?.message ?? "", /every session counts as pinned to local models because its pin cannot be read/);
  assert.equal(loaded.session.model?.id, "local", "the cloud selection was switched to smart-router/local, which refuses");
  assert.equal(loaded.session.wholeHistoryReads, 0);
});
