import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { ENV_SCOPE, SCOPE_ENTRY } from "../src/constants.ts";
import { directoryFailedNotice, directoryNotice } from "../src/errors.ts";
import { createGuards, newGuardState } from "../src/guards.ts";
import type { GuardOptions } from "../src/guards.ts";
import { policyFromRoster } from "../src/local.ts";
import { processSlot } from "../src/owners.ts";
import { readPin } from "../src/pin.ts";
import type { PinReading } from "../src/pin.ts";
import { readScope, scopeEntry } from "../src/scope.ts";
import type { ScopeState } from "../src/scope.ts";
import { CHATGPT, FakeCatalog, GLM, heraModels, KIMI, model, NATIVE_SOL, NOW, rosterFixture, rosterFixtureV2, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, FakeRuntime, load, request, resetSlot, routed, start } from "./support/pi.ts";
import type { FakeHost, FakeSession, Loaded, LoadOptions } from "./support/pi.ts";

const POLICY = policyFromRoster(rosterFixture("roster-hera.json"));
const LOCAL = "smart-router/local";
const AUTO = "smart-router/auto";
const OTHER_ROUTER = "other-router/auto";
const HERA_V2 = fixture("roster-hera-v2.json");
const POLICY_V2 = policyFromRoster(rosterFixtureV2("roster-hera-v2.json"));
/** Hera's version 2 work directory, and a directory under it. */
const WORK_DIRECTORY = "/Users/johnw/src/positron";
const APP = `${WORK_DIRECTORY}/app`;
/** A directory Hera's roster does not list until a test adds it, and a directory under it. */
const ACME = "/Users/johnw/src/acme";
const ACME_APP = `${ACME}/app`;
/** The work guard's way out of a lock, as its lock notices end. */
const WORK_WAY_OUT =
  "To get out: /new (the work scope carries over), a branch before any native Codex compaction checkpoint, smart-router/auto or a work Codex model chosen with /model, or /smart-router scope personal.";
/** Hera's catalog with the work account's medium model, so that routing in work scope reaches the account check. */
const workCatalog = (): FakeCatalog =>
  new FakeCatalog([...heraModels(), model("openai-codex-3/gpt-6.1-terra", { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 })]);
/** Multi-Pass's labels with Hera's two aliases swapped: #3, the roster's work alias, labelled personal. */
const SWAPPED = JSON.stringify({
  subscriptions: [
    { provider: "openai-codex", index: 2, label: "Positron work" },
    { provider: "openai-codex", index: 3, label: "personal" },
  ],
});

beforeEach(resetSlot);
afterEach(resetSlot);

const selection = (loaded: Loaded): string | undefined =>
  loaded.session.model === undefined ? undefined : `${loaded.session.model.provider}/${loaded.session.model.id}`;
const guardOf = (loaded: Loaded) => {
  const record = loaded.router?.record(loaded.session.id);
  assert.ok(record !== undefined, "the session has a record");
  return record.guard;
};
const lastNotice = (loaded: Loaded) => loaded.session.notices.at(-1);
const messages = (loaded: Loaded): string[] => loaded.session.notices.map((notice) => notice.message);

interface Clocked extends Loaded {
  /** Advance the router's clock. */
  advance(ms: number): void;
}

/** A session pinned to Hera's local policy, on smart-router/local, with a controllable clock. */
async function pinned(t: Parameters<typeof agentDir>[0], options: Partial<LoadOptions> & { readonly select?: string } = {}): Promise<Clocked> {
  let clock = NOW;
  const loaded = await start({
    dir: agentDir(t),
    select: "local",
    setup: (session) => session.pin(POLICY),
    now: () => clock,
    ...options,
  });
  return Object.assign(loaded, {
    advance(ms: number) {
      clock += ms;
    },
  });
}

/** Record work scope in a session, as /smart-router scope work does. */
const workEntry = (session: FakeSession): void => session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - 60_000));

/** A session in work scope by its entry, on Hera's version 2 roster (or `roster`), Hera's Multi-Pass labels (or `multiPass`) and smart-router/auto, with a controllable clock. */
async function working(
  t: Parameters<typeof agentDir>[0],
  options: Partial<LoadOptions> & { readonly select?: string; readonly roster?: string; readonly multiPass?: string } = {},
): Promise<Clocked> {
  let clock = NOW;
  const { roster = HERA_V2, multiPass, ...rest } = options;
  const loaded = await start({ dir: agentDir(t, { roster, ...(multiPass === undefined ? {} : { multiPass }) }), setup: workEntry, now: () => clock, ...rest });
  return Object.assign(loaded, {
    advance(ms: number) {
      clock += ms;
    },
  });
}

/** Run with PI_SMART_ROUTER_SCOPE set to `value`, and restore it afterwards. */
async function withScope(value: string, run: () => Promise<void>): Promise<void> {
  const saved = process.env[ENV_SCOPE];
  process.env[ENV_SCOPE] = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env[ENV_SCOPE];
    else process.env[ENV_SCOPE] = saved;
  }
}

/** Make a session's entries unwritable, as a read-only session file does. */
function readOnly(host: FakeHost): void {
  host.api.appendEntry = () => {
    throw new Error("the session file is read-only");
  };
}

/** Multi-Pass allowedSubs, roughly: whenever a smart-router model is selected, it selects `to` instead. */
function allowedSubs(host: FakeHost, to: string, active = true): { active: boolean } {
  const state = { active };
  host.api.on("model_select", async (event) => {
    if (state.active && event.model.provider === "smart-router") await host.choose(to);
  });
  return state;
}

/** A turn_start handler that selects `to` whatever the selection, as a checkpoint policy might. */
function forcesAtTurnStart(host: FakeHost, to: string): void {
  host.api.on("turn_start", async () => {
    const current = host.session.model;
    if (current === undefined || `${current.provider}/${current.id}` !== to) await host.choose(to);
  });
}

function poison(loaded: Loaded): void {
  loaded.session.model = new Proxy({} as Model<Api>, {
    get() {
      throw new Error("model state corrupted");
    },
  });
}

describe("model_select", () => {
  test("reverts a choice outside the policy to the previous model when that is allowed, else to smart-router/local", async (t) => {
    const loaded = await pinned(t);
    await loaded.host.choose(KIMI);
    assert.equal(selection(loaded), LOCAL);
    assert.match(lastNotice(loaded)?.message ?? "", /pinned to local models, so openrouter\/moonshotai\/kimi-k3\.1-pro was not kept, and the selection is smart-router\/local again\. Run \/smart-router local off to unpin\.$/);
    loaded.advance(2_000);
    await loaded.host.choose(GLM);
    assert.equal(selection(loaded), GLM, "a physical model inside the policy is allowed");
    loaded.advance(2_000);
    await loaded.host.choose(SOL, "cycle");
    assert.equal(selection(loaded), GLM, "a cycle is reverted to the previous model, which is allowed");
    loaded.advance(2_000);
    loaded.session.force("auto");
    await loaded.host.choose(KIMI);
    assert.equal(selection(loaded), LOCAL, "smart-router/auto is not allowed under the pin, so the revert goes to smart-router/local");
    loaded.advance(2_000);
    await loaded.host.choose("smart-router/auto");
    assert.equal(selection(loaded), LOCAL, "choosing smart-router/auto is reverted too");
    assert.equal(guardOf(loaded).lock, undefined);
  });

  test("an unpinned session's choices are left alone", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    await loaded.host.choose(SOL);
    await loaded.host.choose(KIMI);
    assert.equal(selection(loaded), KIMI);
    assert.equal(loaded.host.selections.length, 2);
  });

  test("reverts at most once a second; another choice outside the policy inside that second locks the session", async (t) => {
    const slow = await pinned(t, { id: "slow" });
    await slow.host.choose(KIMI);
    slow.advance(1_500);
    await slow.host.choose(SOL);
    assert.deepEqual([selection(slow), guardOf(slow).lock], [LOCAL, undefined], "outside the window, the router reverts again");
    resetSlot();
    const fast = await pinned(t, { id: "fast", runtime: new FakeRuntime() });
    await fast.host.choose(KIMI);
    fast.advance(500);
    const signal = fast.session.startRun();
    await fast.host.choose(SOL);
    assert.equal(selection(fast), SOL, "the router stops reverting");
    assert.deepEqual(guardOf(fast).lock, { since: NOW + 500, model: SOL, cause: "conflict" });
    assert.equal(signal.aborted, true, "a run in progress is aborted");
    assert.equal(fast.session.statuses.get("smart-router"), "local models: locked");
    const notice = lastNotice(fast);
    assert.equal(notice?.type, "error");
    assert.match(notice?.message ?? "", /something keeps switching it to openai-codex-2\/gpt-6\.1-sol, so it is locked/);
    assert.match(notice?.message ?? "", /Multi-Pass allowedSubs in this project.*native Codex compaction checkpoint/);
    assert.match(notice?.message ?? "", /To get out: \/new \(the pin carries over\).*\/smart-router local off\.$/);
  });

  test("a competitor that switches back from inside model_select locks the session, wherever it loads", async (t) => {
    for (const order of ["before", "after"] as const) {
      resetSlot();
      let competitor = { active: false };
      const options: Partial<LoadOptions> = order === "before" ? { before: (host) => (competitor = allowedSubs(host, SOL, false)) } : {};
      const loaded = await pinned(t, { ...options, runtime: new FakeRuntime() });
      if (order === "after") competitor = allowedSubs(loaded.host, SOL);
      competitor.active = true;
      await loaded.host.choose(KIMI);
      assert.equal(guardOf(loaded).lock?.model, SOL, order);
      assert.notEqual(selection(loaded), LOCAL, order);
    }
  });

  test("an allowed choice by someone else clears the lock", async (t) => {
    const loaded = await pinned(t);
    const competitor = allowedSubs(loaded.host, SOL);
    await loaded.host.choose(KIMI);
    assert.ok(guardOf(loaded).lock !== undefined);
    competitor.active = false;
    await loaded.host.choose(LOCAL);
    assert.equal(guardOf(loaded).lock, undefined);
    assert.equal(loaded.session.statuses.get("smart-router"), "local models");
    assert.match(lastNotice(loaded)?.message ?? "", /no longer locked/);
  });
});

describe("while locked", () => {
  test("prompts are refused, runs are stopped, compaction and summaries are cancelled, payloads emptied and warming stopped", async (t) => {
    const loaded = await pinned(t);
    const competitor = allowedSubs(loaded.host, SOL);
    await loaded.host.choose(KIMI);
    competitor.active = false;
    assert.ok(guardOf(loaded).lock !== undefined);
    assert.deepEqual(await loaded.host.emit("input", { text: "hello", source: "interactive" }), [{ action: "handled" }]);
    assert.match(lastNotice(loaded)?.message ?? "", /pinned to local models and locked, so the prompt was not sent/);
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.equal(signal.aborted, true);
    assert.equal(selection(loaded), SOL, "the router does not switch while locked");
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "threshold" }), [{ cancel: true }]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [{ cancel: true }]);
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: { input: "secret" } }), [null]);
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);
    // Even a local selection's payload is emptied while locked.
    loaded.session.force(GLM);
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [null]);
    assert.equal(loaded.host.count("tool_call"), 0, "the pin blocks no tools (Q7)");
  });

  test("another choice outside the policy aborts a run in progress, and the lock names it", async (t) => {
    const loaded = await pinned(t);
    const competitor = allowedSubs(loaded.host, SOL);
    await loaded.host.choose(KIMI);
    competitor.active = false;
    loaded.advance(10_000);
    const signal = loaded.session.startRun();
    await loaded.host.choose(KIMI);
    assert.equal(signal.aborted, true);
    assert.deepEqual(guardOf(loaded).lock, { since: NOW, model: KIMI, cause: "conflict" }, "the lock keeps when it began and names the latest model");
    assert.equal(selection(loaded), KIMI, "the router does not revert while locked");
  });

  test("an allowed selection that holds through turn_start clears the lock, and the run goes on", async (t) => {
    const loaded = await pinned(t);
    const competitor = allowedSubs(loaded.host, SOL);
    await loaded.host.choose(KIMI);
    competitor.active = false;
    loaded.session.force(LOCAL);
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([signal.aborted, guardOf(loaded).lock], [false, undefined]);
  });
});

describe("turn_start", () => {
  test("switches a selection outside the policy to smart-router/local before the request is prepared", async (t) => {
    const loaded = await pinned(t);
    loaded.session.force(KIMI);
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([selection(loaded), signal.aborted], [LOCAL, false]);
  });

  test("aborts when a competing handler switches back, wherever it loads, and never lets the cloud selection run", async (t) => {
    // In every variant the session ends on smart-router/local with the run going on, or locked
    // with the run aborted before its request is prepared.
    const variants: Array<[string, (host: FakeHost) => void, boolean, "local" | "locked"]> = [
      ["a model_select competitor loaded before", (host) => allowedSubs(host, SOL), true, "locked"],
      ["a model_select competitor loaded after", (host) => allowedSubs(host, SOL), false, "locked"],
      ["a turn_start competitor loaded before", (host) => forcesAtTurnStart(host, SOL), true, "local"],
      ["a turn_start competitor loaded after", (host) => forcesAtTurnStart(host, SOL), false, "locked"],
    ];
    for (const [name, competitor, first, outcome] of variants) {
      resetSlot();
      const loaded = await pinned(t, { runtime: new FakeRuntime(), ...(first ? { before: competitor } : {}) });
      if (!first) competitor(loaded.host);
      loaded.session.force(KIMI);
      const signal = loaded.session.startRun();
      await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
      if (outcome === "local") {
        assert.deepEqual([selection(loaded), signal.aborted, guardOf(loaded).lock], [LOCAL, false, undefined], name);
      } else {
        assert.deepEqual([selection(loaded), signal.aborted, guardOf(loaded).lock?.model], [SOL, true, SOL], name);
      }
    }
  });

  test("aborts when smart-router/local cannot be selected", async (t) => {
    const loaded = await pinned(t);
    loaded.session.force(KIMI);
    loaded.host.setModel = async () => false;
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.equal(signal.aborted, true);
    assert.match(lastNotice(loaded)?.message ?? "", /could not be switched to smart-router\/local, so the run was stopped before anything was sent/);
  });

  test("leaves an unpinned session alone", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: KIMI });
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([selection(loaded), signal.aborted], [KIMI, false]);
  });
});

describe("compaction and tree navigation", () => {
  test("compaction is cancelled under a selection outside the policy, and allowed on a local one", async (t) => {
    const loaded = await pinned(t);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [undefined]);
    loaded.session.force(KIMI);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "threshold" }), [{ cancel: true }]);
    assert.match(lastNotice(loaded)?.message ?? "", /kimi-k3\.1-pro is not local, so compaction was cancelled/);
    loaded.session.force(GLM);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "overflow" }), [undefined]);
    const plain = await start({ dir: agentDir(t), select: KIMI, runtime: new FakeRuntime(), id: "plain" });
    assert.deepEqual(await plain.host.emit("session_before_compact", { reason: "manual" }), [undefined]);
  });

  test("tree navigation is cancelled only when it summarizes", async (t) => {
    const loaded = await pinned(t);
    loaded.session.force(SOL);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: false } }), [undefined]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [{ cancel: true }]);
    loaded.session.force(LOCAL);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [undefined]);
  });
});

describe("the payload barrier and the warming guard", () => {
  test("empty the payload and abort for a physical model outside the policy or another router's model", async (t) => {
    const runtime = new FakeRuntime(new FakeCatalog([...heraModels(), model(OTHER_ROUTER, { api: "pi-virtual", baseUrl: "" })]));
    const loaded = await pinned(t, { runtime });
    const cases: Array<[string, unknown, unknown]> = [
      [LOCAL, undefined, undefined],
      [GLM, undefined, undefined],
      ["smart-router/auto", undefined, undefined],
      [SOL, null, { action: "stop" }],
      [KIMI, null, { action: "stop" }],
      [OTHER_ROUTER, null, { action: "stop" }],
    ];
    for (const [ref, payload, warming] of cases) {
      loaded.session.force(ref);
      const before = loaded.session.aborts;
      const signal = loaded.session.startRun();
      assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: { input: "secret" } }), [payload], ref);
      assert.equal(signal.aborted, payload === null, `${ref}: aborted`);
      assert.equal(loaded.session.aborts - before, payload === null ? 1 : 0, ref);
      assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [warming], ref);
      loaded.session.endRun();
    }
    assert.match(lastNotice(loaded)?.message ?? "", /a request to other-router\/auto would leave this machine, so the request was emptied and the run stopped/);
  });

  test("leave an unpinned session's requests alone", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: SOL });
    const signal = loaded.session.startRun();
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: { input: "x" } }), [undefined]);
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [undefined]);
    assert.equal(signal.aborted, false);
  });
});

describe("input", () => {
  test("is refused under a selection outside the policy, idle or busy, and plans a local run otherwise", async (t) => {
    const loaded = await pinned(t);
    await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
    assert.equal(loaded.router?.record(loaded.session.id)?.plan?.signal, "local", "a pinned local selection plans a local run");
    loaded.session.force(KIMI);
    assert.deepEqual(await loaded.host.emit("input", { text: "plan the migration", source: "interactive" }), [{ action: "handled" }]);
    assert.equal(loaded.router?.record(loaded.session.id)?.plan, undefined, "a refused idle prompt plans nothing, and drops the earlier plan");
    assert.match(lastNotice(loaded)?.message ?? "", /kimi-k3\.1-pro is not local, so the prompt was not sent\. Choose smart-router\/local or a local model with \/model, or run \/smart-router local off\.$/);
    loaded.session.startRun();
    assert.deepEqual(await loaded.host.emit("input", { text: "also this", source: "interactive", streamingBehavior: "steer" }), [{ action: "handled" }]);
  });
});

describe("session_start", () => {
  test("switches a restored selection outside the policy to smart-router/local", async (t) => {
    const loaded = await pinned(t, { select: KIMI });
    assert.equal(selection(loaded), LOCAL);
    assert.match(lastNotice(loaded)?.message ?? "", /pinned to local models, so its selection openrouter\/moonshotai\/kimi-k3\.1-pro was switched to smart-router\/local\.$/);
    assert.equal(loaded.session.statuses.get("smart-router"), "local models");
    const glm = await pinned(t, { select: GLM, runtime: new FakeRuntime(), id: "glm" });
    assert.equal(selection(glm), GLM, "a directly selected local model is kept");
  });

  test("locks the session when the restored selection cannot be switched", async (t) => {
    const loaded = load({ dir: agentDir(t), setup: (session) => session.pin(POLICY) });
    loaded.host.setModel = async () => false;
    loaded.session.select(SOL);
    await loaded.host.emit("session_start", { reason: "resume" });
    assert.deepEqual([selection(loaded), guardOf(loaded).lock?.cause], [SOL, "restore"]);
    assert.equal(loaded.session.statuses.get("smart-router"), "local models: locked");
    assert.match(lastNotice(loaded)?.message ?? "", /its restored selection openai-codex-2\/gpt-6\.1-sol is not local, and smart-router\/local could not be selected, so it is locked/);
  });

  test("shows no status item for an unpinned session", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    assert.deepEqual([...loaded.session.statuses], [["smart-router", undefined]]);
  });
});

describe("a guard that fails inside", () => {
  test("denies while the session is pinned", async (t) => {
    const loaded = await pinned(t);
    poison(loaded);
    const signal = loaded.session.startRun();
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [null]);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [{ cancel: true }]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [{ cancel: true }]);
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);
    assert.deepEqual(await loaded.host.emit("input", { text: "hi", source: "interactive" }), [{ action: "handled" }]);
    const before = loaded.session.aborts;
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.equal(loaded.session.aborts, before + 1);
    assert.ok(loaded.session.notices.some((notice) => /the before_provider_request guard failed \(model state corrupted\), so it denied/.test(notice.message)));
  });

  test("denies when the pin itself cannot be read", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: KIMI });
    const manager = loaded.session.ctx.sessionManager as unknown as Record<string, unknown>;
    manager.getLatestCustomEntry = () => {
      throw new Error("index unavailable");
    };
    assert.equal(readPin(manager, processSlot().env).entry, "unreadable");
    loaded.session.startRun();
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [null]);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [{ cancel: true }]);
  });

  test("allows when the session is unpinned", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: KIMI });
    poison(loaded);
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [undefined]);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [undefined]);
  });
});

describe("work guard", () => {
  // In an unpinned work-scope session, the selection stays on smart-router/auto or a model of the
  // work-bound Codex account (Hera's openai-codex-3), by the same hooks the pin uses, and a
  // violation is switched to smart-router/auto. While pinned, only the pin's rules apply.
  const reverted = (ref: string): string => `pi-smart-router: this session is in work scope, so ${ref} was not kept, and the selection is smart-router/auto again.`;
  const switchedAtStart = (ref: string): string => `pi-smart-router: this session is in work scope, so its selection ${ref} was switched to smart-router/auto.`;
  const LOCKED_EFFECTS = "so it is locked: prompts are refused, runs are stopped before anything is sent, compaction is cancelled, and provider requests are emptied.";
  const CAUSES =
    "The usual causes are Multi-Pass allowedSubs in this project (list smart-router there), or a branch that holds a native Codex compaction checkpoint, which codex-compat keeps on openai-codex.";

  test("choosing KIMI returns the selection to smart-router/auto with a notice; WORK_SOL is kept; SOL, plain openai-codex, a LAN model and smart-router/local are reverted", async (t) => {
    const loaded = await working(t);
    await loaded.host.choose(KIMI);
    assert.equal(selection(loaded), AUTO);
    assert.deepEqual(lastNotice(loaded), {
      type: "warning",
      message: "pi-smart-router: this session is in work scope, so openrouter/moonshotai/kimi-k3.1-pro was not kept, and the selection is smart-router/auto again.",
    });
    loaded.advance(2_000);
    await loaded.host.choose(WORK_SOL);
    assert.equal(selection(loaded), WORK_SOL, "the work account's Codex model is kept");
    assert.equal(lastNotice(loaded)?.message, reverted(KIMI), "and nothing is said");
    loaded.advance(2_000);
    await loaded.host.choose(SOL);
    assert.equal(selection(loaded), AUTO, "a personal Codex alias goes to smart-router/auto, not back to the previous model");
    assert.equal(lastNotice(loaded)?.message, reverted(SOL));
    for (const [ref, source] of [
      [NATIVE_SOL, "cycle"],
      [GLM, "set"],
      [LOCAL, "set"],
    ] as const) {
      loaded.advance(2_000);
      await loaded.host.choose(ref, source);
      assert.equal(selection(loaded), AUTO, ref);
      assert.equal(lastNotice(loaded)?.message, reverted(ref), ref);
    }
    assert.equal(guardOf(loaded).lock, undefined);
    assert.equal(loaded.session.statuses.get("smart-router"), undefined, "the work guard shows no status item");
  });

  test("a work alias whose Multi-Pass label is not its binding's is refused by hand too, as routing refuses it; with the binding's label it is kept", async (t) => {
    const swapped = await working(t, { id: "swapped", multiPass: SWAPPED, runtime: new FakeRuntime(workCatalog()) });
    assert.throws(() => swapped.runtime.route("auto", request("direct")), /Multi-Pass labels openai-codex-3 "personal", not "Positron work"/, "routing refuses the alias");
    await swapped.host.choose(WORK_SOL);
    assert.deepEqual([selection(swapped), lastNotice(swapped)?.message], [AUTO, reverted(WORK_SOL)]);
    swapped.session.force(WORK_SOL);
    const signal = swapped.session.startRun();
    await swapped.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([selection(swapped), signal.aborted], [AUTO, false], "turn_start switches it");
    swapped.session.force(WORK_SOL);
    assert.deepEqual(await swapped.host.emit("before_provider_request", { payload: { input: "work text" } }), [null]);
    assert.equal(lastNotice(swapped)?.message, "pi-smart-router: this session is in work scope, and a request to openai-codex-3/gpt-6.1-sol would go outside it, so the request was emptied and the run stopped.");
    assert.deepEqual(await swapped.host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);
    // The control: with Hera's labels, the same pick is the work account's, and it is kept.
    const labelled = await working(t, { id: "labelled", runtime: new FakeRuntime(workCatalog()) });
    assert.equal(routed(labelled.runtime.route("auto", request("direct"))), "openai-codex-3/gpt-6.1-terra", "routing takes the alias too");
    await labelled.host.choose(WORK_SOL);
    assert.deepEqual([selection(labelled), messages(labelled)], [WORK_SOL, []]);
    const sent = labelled.session.startRun();
    assert.deepEqual(await labelled.host.emit("before_provider_request", { payload: {} }), [undefined]);
    assert.equal(sent.aborted, false);
  });

  test("a work-bound account that is not Codex is no work account: picked by hand, it is refused", async (t) => {
    const roster = JSON.parse(HERA_V2);
    roster.accounts["anthropic-2"] = { multiPassLabel: "Positron work", scope: "work" };
    const multiPass = JSON.stringify({
      subscriptions: [
        { provider: "openai-codex", index: 2, label: "personal" },
        { provider: "openai-codex", index: 3, label: "Positron work" },
        { provider: "anthropic", index: 2, label: "Positron work" },
      ],
    });
    const claude = "anthropic-2/claude-opus";
    const loaded = await working(t, { roster: JSON.stringify(roster), multiPass, runtime: new FakeRuntime(new FakeCatalog([...heraModels(), model(claude)])) });
    assert.deepEqual(messages(loaded), [], "the roster is valid");
    await loaded.host.choose(claude);
    assert.deepEqual([selection(loaded), lastNotice(loaded)?.message], [AUTO, reverted(claude)]);
  });

  test("a pinned work session follows the pin's rules: smart-router/local is allowed, and smart-router/auto and a work Codex model are refused", async (t) => {
    const loaded = await working(t, {
      select: KIMI,
      setup: (session) => {
        workEntry(session);
        session.pin(POLICY_V2);
      },
    });
    assert.deepEqual(readScope(loaded.session.ctx.sessionManager, false, undefined), { kind: "ok", scope: "work", source: "entry" });
    assert.equal(selection(loaded), LOCAL, "at start, the pin switches to smart-router/local");
    assert.match(lastNotice(loaded)?.message ?? "", /pinned to local models, so its selection openrouter\/moonshotai\/kimi-k3\.1-pro was switched to smart-router\/local\.$/);
    // The switch at start counts as a revert, so the next choice comes after the window.
    loaded.advance(2_000);
    await loaded.host.choose(AUTO);
    assert.equal(selection(loaded), LOCAL);
    assert.match(lastNotice(loaded)?.message ?? "", /pinned to local models, so smart-router\/auto was not kept, and the selection is smart-router\/local again\. Run \/smart-router local off to unpin\.$/);
    loaded.advance(2_000);
    await loaded.host.choose(WORK_SOL);
    assert.equal(selection(loaded), LOCAL, "a work Codex model is not local");
    loaded.advance(2_000);
    await loaded.host.choose(GLM);
    assert.equal(selection(loaded), GLM, "a LAN model inside the pin's policy is kept");
    loaded.session.startRun();
    for (const [ref, payload] of [
      [AUTO, undefined],
      [WORK_SOL, null],
    ] as const) {
      loaded.session.force(ref);
      assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [payload], ref);
    }
    assert.equal(loaded.session.statuses.get("smart-router"), "local models");
    assert.ok(!messages(loaded).some((message) => message.includes("work scope")), "nothing is worded for work scope while pinned");
  });

  test("two disallowed choices within the window lock, with a notice worded for work scope and no status item", async (t) => {
    const slow = await working(t, { id: "slow" });
    await slow.host.choose(KIMI);
    slow.advance(1_500);
    await slow.host.choose(SOL);
    assert.deepEqual([selection(slow), guardOf(slow).lock], [AUTO, undefined], "outside the window, the router reverts again");
    resetSlot();
    const fast = await working(t, { id: "fast", runtime: new FakeRuntime() });
    await fast.host.choose(KIMI);
    fast.advance(500);
    const signal = fast.session.startRun();
    await fast.host.choose(SOL);
    assert.equal(selection(fast), SOL, "the router stops reverting");
    assert.deepEqual(guardOf(fast).lock, { since: NOW + 500, model: SOL, cause: "conflict" });
    assert.equal(signal.aborted, true, "a run in progress is aborted");
    assert.equal(fast.session.statuses.get("smart-router"), undefined, "a work lock has no status item");
    assert.deepEqual(lastNotice(fast), {
      type: "error",
      message: `pi-smart-router: this session is in work scope, and something keeps switching it to openai-codex-2/gpt-6.1-sol, ${LOCKED_EFFECTS} ${CAUSES} ${WORK_WAY_OUT}`,
    });
  });

  test("while locked, every guarded hook refuses: prompts, runs, compaction, summaries, payloads and warming", async (t) => {
    const loaded = await working(t);
    const competitor = allowedSubs(loaded.host, SOL);
    await loaded.host.choose(KIMI);
    competitor.active = false;
    assert.equal(guardOf(loaded).lock?.model, SOL, "the competitor won the revert, so the session is locked");
    assert.deepEqual(await loaded.host.emit("input", { text: "hello", source: "interactive" }), [{ action: "handled" }]);
    assert.deepEqual(lastNotice(loaded), { type: "warning", message: `pi-smart-router: this session is in work scope and locked, so the prompt was not sent. ${WORK_WAY_OUT}` });
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.equal(signal.aborted, true);
    assert.equal(selection(loaded), SOL, "the router does not switch while locked");
    assert.deepEqual(lastNotice(loaded), { type: "error", message: `pi-smart-router: this session is in work scope and locked, so the run was stopped before anything was sent. ${WORK_WAY_OUT}` });
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "threshold" }), [{ cancel: true }]);
    assert.equal(lastNotice(loaded)?.message, "pi-smart-router: this session is in work scope, and it is locked, so compaction was cancelled. Choose smart-router/auto with /model, then compact.");
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [{ cancel: true }]);
    assert.equal(
      lastNotice(loaded)?.message,
      "pi-smart-router: this session is in work scope, and it is locked, so the navigation with a summary was cancelled. Navigate without a summary, or choose smart-router/auto with /model first.",
    );
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: { input: "secret" } }), [null]);
    assert.deepEqual(lastNotice(loaded), { type: "error", message: "pi-smart-router: this session is in work scope, and it is locked, so the request was emptied and the run stopped." });
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);
    // Even an allowed selection's payload is emptied while locked.
    loaded.session.force(WORK_SOL);
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [null]);
    loaded.session.force(AUTO);
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);
    assert.equal(loaded.host.count("tool_call"), 0, "the guard blocks no tools (Q7)");
  });

  test("an allowed choice by someone else, or an allowed selection that holds through turn_start, clears the lock", async (t) => {
    const chosen = await working(t, { id: "chosen" });
    const competitor = allowedSubs(chosen.host, SOL);
    await chosen.host.choose(KIMI);
    competitor.active = false;
    assert.ok(guardOf(chosen).lock !== undefined);
    await chosen.host.choose(WORK_SOL);
    assert.deepEqual([selection(chosen), guardOf(chosen).lock], [WORK_SOL, undefined]);
    assert.deepEqual(lastNotice(chosen), { type: "info", message: "pi-smart-router: the selection stayed within work scope, so the session is no longer locked." });
    const held = await working(t, { id: "held", runtime: new FakeRuntime() });
    const other = allowedSubs(held.host, SOL);
    await held.host.choose(KIMI);
    other.active = false;
    assert.ok(guardOf(held).lock !== undefined);
    held.session.force(AUTO);
    const signal = held.session.startRun();
    await held.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([signal.aborted, guardOf(held).lock], [false, undefined]);
  });

  test("a competitor's selection restored after the revert is caught at turn_start and at the payload barrier", async (t) => {
    const loaded = await working(t);
    await loaded.host.choose(KIMI);
    assert.equal(selection(loaded), AUTO, "reverted");
    // A competitor writes the selection back without a model_select, as writing session.agent.state.model does.
    loaded.session.force(KIMI);
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([selection(loaded), signal.aborted], [AUTO, false], "switched to smart-router/auto before the request is prepared");
    // Written back again after turn_start, the request meets the payload barrier.
    loaded.session.force(KIMI);
    const before = loaded.session.aborts;
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: { input: "secret" } }), [null]);
    assert.deepEqual([signal.aborted, loaded.session.aborts - before], [true, 1]);
    assert.deepEqual(lastNotice(loaded), {
      type: "error",
      message: "pi-smart-router: this session is in work scope, and a request to openrouter/moonshotai/kimi-k3.1-pro would go outside it, so the request was emptied and the run stopped.",
    });
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);
  });

  test("a competitor that switches back at turn_start is caught wherever it loads, and the cloud selection never runs", async (t) => {
    // In every variant the session ends on smart-router/auto with the run going on, or locked with
    // the run aborted before its request is prepared.
    const variants: Array<[string, (host: FakeHost) => void, boolean, "auto" | "locked"]> = [
      ["a model_select competitor loaded before", (host) => allowedSubs(host, SOL), true, "locked"],
      ["a model_select competitor loaded after", (host) => allowedSubs(host, SOL), false, "locked"],
      ["a turn_start competitor loaded before", (host) => forcesAtTurnStart(host, SOL), true, "auto"],
      ["a turn_start competitor loaded after", (host) => forcesAtTurnStart(host, SOL), false, "locked"],
    ];
    for (const [name, competitor, first, outcome] of variants) {
      resetSlot();
      const loaded = await working(t, { runtime: new FakeRuntime(), ...(first ? { before: competitor } : {}) });
      if (!first) competitor(loaded.host);
      loaded.session.force(KIMI);
      const signal = loaded.session.startRun();
      await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
      if (outcome === "auto") {
        assert.deepEqual([selection(loaded), signal.aborted, guardOf(loaded).lock], [AUTO, false, undefined], name);
      } else {
        assert.deepEqual([selection(loaded), signal.aborted, guardOf(loaded).lock?.model], [SOL, true, SOL], name);
      }
    }
  });

  test("turn_start aborts when smart-router/auto cannot be selected", async (t) => {
    const loaded = await working(t);
    loaded.session.force(KIMI);
    loaded.host.setModel = async () => false;
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.equal(signal.aborted, true);
    assert.deepEqual(lastNotice(loaded), {
      type: "error",
      message:
        "pi-smart-router: this session is in work scope, and its selection openrouter/moonshotai/kimi-k3.1-pro could not be switched to smart-router/auto, so the run was stopped before anything was sent.",
    });
  });

  test("the payload barrier and the warming guard: a physical model outside work scope or another router's model is emptied and stopped", async (t) => {
    const runtime = new FakeRuntime(new FakeCatalog([...heraModels(), model(OTHER_ROUTER, { api: "pi-virtual", baseUrl: "" })]));
    const loaded = await working(t, { runtime });
    // The router's own two models route only within work scope's rules (smart-router/local to the
    // LAN, which no account holds), so their requests pass; the turn_start guard still switches
    // smart-router/local as a selection.
    const cases: Array<[string, unknown, unknown]> = [
      [AUTO, undefined, undefined],
      [LOCAL, undefined, undefined],
      [WORK_SOL, undefined, undefined],
      [SOL, null, { action: "stop" }],
      [NATIVE_SOL, null, { action: "stop" }],
      [KIMI, null, { action: "stop" }],
      [GLM, null, { action: "stop" }],
      [OTHER_ROUTER, null, { action: "stop" }],
    ];
    for (const [ref, payload, warming] of cases) {
      loaded.session.force(ref);
      const before = loaded.session.aborts;
      const signal = loaded.session.startRun();
      assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: { input: "secret" } }), [payload], ref);
      assert.equal(signal.aborted, payload === null, `${ref}: aborted`);
      assert.equal(loaded.session.aborts - before, payload === null ? 1 : 0, ref);
      assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [warming], ref);
      loaded.session.endRun();
    }
    assert.equal(lastNotice(loaded)?.message, "pi-smart-router: this session is in work scope, and a request to other-router/auto would go outside it, so the request was emptied and the run stopped.");
  });

  test("input under a selection outside work scope is refused, idle or busy; on smart-router/auto or a work Codex model it goes on", async (t) => {
    const loaded = await working(t);
    loaded.session.force(KIMI);
    assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [{ action: "handled" }]);
    assert.deepEqual(lastNotice(loaded), {
      type: "warning",
      message:
        "pi-smart-router: this session is in work scope, and openrouter/moonshotai/kimi-k3.1-pro is outside it, so the prompt was not sent. Choose smart-router/auto or a work Codex model with /model, or run /smart-router scope personal.",
    });
    loaded.session.force(LOCAL);
    assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [{ action: "handled" }]);
    assert.match(lastNotice(loaded)?.message ?? "", /work scope, and smart-router\/local is outside it, so the prompt was not sent\./);
    const refused = loaded.session.notices.length;
    for (const ref of [WORK_SOL, AUTO]) {
      loaded.session.force(ref);
      assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [undefined], ref);
    }
    assert.ok(!messages(loaded).slice(refused).some((message) => message.includes("was not sent")), "neither was refused");
    loaded.session.force(SOL);
    loaded.session.startRun();
    assert.deepEqual(await loaded.host.emit("input", { text: "also this", source: "interactive", streamingBehavior: "steer" }), [{ action: "handled" }]);
  });

  test("compaction is cancelled, and tree navigation with a summary too, under a selection outside work scope", async (t) => {
    const loaded = await working(t);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [undefined]);
    loaded.session.force(KIMI);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "threshold" }), [{ cancel: true }]);
    assert.equal(
      lastNotice(loaded)?.message,
      "pi-smart-router: this session is in work scope, and openrouter/moonshotai/kimi-k3.1-pro is outside it, so compaction was cancelled. Choose smart-router/auto with /model, then compact.",
    );
    loaded.session.force(WORK_SOL);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "overflow" }), [undefined]);
    loaded.session.force(SOL);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: false } }), [undefined]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [{ cancel: true }]);
    assert.equal(
      lastNotice(loaded)?.message,
      "pi-smart-router: this session is in work scope, and openai-codex-2/gpt-6.1-sol is outside it, so the navigation with a summary was cancelled. Navigate without a summary, or choose smart-router/auto with /model first.",
    );
    loaded.session.force(AUTO);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [undefined]);
  });

  test("resuming a work session whose selection is KIMI switches it to smart-router/auto at start, by its entry or its directory", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const byEntry = load({ dir, id: "entry", setup: workEntry, now: () => NOW });
    byEntry.session.select(KIMI);
    await byEntry.host.emit("session_start", { reason: "resume" });
    assert.equal(selection(byEntry), AUTO);
    assert.deepEqual(byEntry.session.notices, [{ type: "info", message: switchedAtStart(KIMI) }]);
    assert.equal(switchedAtStart(KIMI), "pi-smart-router: this session is in work scope, so its selection openrouter/moonshotai/kimi-k3.1-pro was switched to smart-router/auto.");
    assert.equal(byEntry.session.statuses.get("smart-router"), undefined);
    // The directory rule runs first, so a resumed session under a work directory is guarded at once.
    const byDirectory = load({ dir, id: "directory", cwd: APP, runtime: new FakeRuntime(), now: () => NOW });
    byDirectory.session.select(KIMI);
    await byDirectory.host.emit("session_start", { reason: "resume" });
    assert.equal(selection(byDirectory), AUTO);
    assert.deepEqual(messages(byDirectory), [directoryNotice(APP, WORK_DIRECTORY), switchedAtStart(KIMI)]);
    const kept = await working(t, { id: "kept", select: WORK_SOL, runtime: new FakeRuntime() });
    assert.deepEqual([selection(kept), messages(kept)], [WORK_SOL, []], "a work Codex model is kept");
  });

  test("a restored selection that cannot be switched locks the session at start", async (t) => {
    const loaded = load({ dir: agentDir(t, { roster: HERA_V2 }), setup: workEntry, now: () => NOW });
    loaded.host.setModel = async () => false;
    loaded.session.select(SOL);
    await loaded.host.emit("session_start", { reason: "resume" });
    assert.deepEqual([selection(loaded), guardOf(loaded).lock?.cause], [SOL, "restore"]);
    assert.equal(loaded.session.statuses.get("smart-router"), undefined);
    assert.deepEqual(lastNotice(loaded), {
      type: "error",
      message: `pi-smart-router: this session is in work scope, and its restored selection openai-codex-2/gpt-6.1-sol is outside work scope, and smart-router/auto could not be selected, ${LOCKED_EFFECTS} ${WORK_WAY_OUT}`,
    });
  });

  test("the work directories, the latch and an unreadable scope put a session under the guard; a personal one has none, on version 2 too", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    // A session whose directory entry cannot be written keeps the directory as its scope's source.
    const directory = load({ dir, id: "directory", cwd: APP, runtime: new FakeRuntime(), now: () => NOW });
    readOnly(directory.host);
    directory.session.select("auto");
    await directory.host.emit("session_start", { reason: "startup" });
    assert.deepEqual(readScope(directory.session.ctx.sessionManager, false, { cwd: APP, directories: [WORK_DIRECTORY] }), { kind: "ok", scope: "work", source: "directory" });
    await directory.host.choose(KIMI);
    assert.deepEqual([selection(directory), lastNotice(directory)?.message], [AUTO, reverted(KIMI)], "the directory");
    const unreadable = await start({ dir, id: "unreadable", runtime: new FakeRuntime(), now: () => NOW, setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    assert.equal(readScope(unreadable.session.ctx.sessionManager, false, undefined).kind, "unreadable");
    await unreadable.host.choose(KIMI);
    assert.equal(selection(unreadable), AUTO, "an unreadable scope is work scope, the narrower one");
    // Personal scope has no guard: a model picked by hand is sent as it is, even a work Codex model.
    const personal = await start({ dir, id: "personal", runtime: new FakeRuntime(), now: () => NOW });
    await personal.host.choose(KIMI);
    await personal.host.choose(WORK_SOL);
    assert.equal(selection(personal), WORK_SOL);
    personal.session.force(KIMI);
    const signal = personal.session.startRun();
    await personal.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual(await personal.host.emit("before_provider_request", { payload: {} }), [undefined]);
    assert.deepEqual([selection(personal), signal.aborted, messages(personal)], [KIMI, false, []]);
    await withScope("work", async () => {
      const latched = await start({ dir, id: "latched", runtime: new FakeRuntime(), now: () => NOW });
      await latched.host.choose(KIMI);
      assert.equal(selection(latched), AUTO, "the latch");
    });
  });

  test("a guard that fails inside denies in work scope", async (t) => {
    const loaded = await working(t);
    poison(loaded);
    const signal = loaded.session.startRun();
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [null]);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [{ cancel: true }]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [{ cancel: true }]);
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [{ action: "stop" }]);
    assert.deepEqual(await loaded.host.emit("input", { text: "hi", source: "interactive" }), [{ action: "handled" }]);
    const before = loaded.session.aborts;
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.equal(loaded.session.aborts, before + 1);
    assert.ok(messages(loaded).some((message) => /the before_provider_request guard failed \(model state corrupted\), so it denied/.test(message)));
  });

  describe("while the roster fails to load", () => {
    test("the scope and the guard keep the last valid roster's work directories and bindings, in this instance and in one built later in the process", async (t) => {
      let clock = NOW;
      const dir = agentDir(t, { roster: HERA_V2 });
      // A session under the work directory whose entry cannot be written: its scope rests on the directories.
      const loaded = load({ dir, cwd: APP, now: () => clock });
      readOnly(loaded.host);
      loaded.session.select("auto");
      await loaded.host.emit("session_start", { reason: "startup" });
      writeFileSync(join(dir, "smart-router.json"), "{ nope");
      await loaded.host.command("smart-router", "reload");
      assert.match(lastNotice(loaded)?.message ?? "", /smart-router\.json: invalid \(JSON syntax error/);
      await loaded.host.choose(KIMI);
      assert.deepEqual([selection(loaded), lastNotice(loaded)?.message], [AUTO, reverted(KIMI)], "still in work scope by its directory");
      clock += 2_000;
      await loaded.host.choose(WORK_SOL);
      assert.equal(selection(loaded), WORK_SOL, "the last valid roster binds openai-codex-3 to work scope");
      clock += 2_000;
      await loaded.host.choose(SOL);
      assert.equal(selection(loaded), AUTO, "and openai-codex-2 to personal scope");
      // Routing keeps no last-known-good copy: smart-router/auto still refuses.
      assert.throws(() => loaded.runtime.route("auto", request("direct")), /smart-router\.json is invalid \(JSON syntax error/);
      // An instance built later in the process, as /reload builds one, meets the broken roster first.
      const rebuilt = load({ dir, id: "rebuilt", cwd: APP, runtime: new FakeRuntime(), now: () => NOW });
      rebuilt.session.select(KIMI);
      await rebuilt.host.emit("session_start", { reason: "reload" });
      assert.equal(selection(rebuilt), AUTO);
      assert.equal(rebuilt.session.notices[0]?.message, directoryNotice(APP, WORK_DIRECTORY), "the directory still puts it in work scope, and is recorded");
      assert.equal(lastNotice(rebuilt)?.message, switchedAtStart(KIMI));
      await rebuilt.host.choose(WORK_SOL);
      assert.equal(selection(rebuilt), WORK_SOL);
      assert.ok(messages(loaded).includes(directoryFailedNotice(APP, WORK_DIRECTORY, "the session file is read-only")));
    });

    test("an instance that reads its own older roster again leaves in the slot the one loaded last in the process", async (t) => {
      const dir = agentDir(t, { roster: HERA_V2 });
      const older = await start({ dir, id: "older", now: () => NOW });
      const edited = JSON.parse(HERA_V2);
      edited.scopes.work.directories = [ACME];
      writeFileSync(join(dir, "smart-router.json"), JSON.stringify(edited));
      // A later instance loads the edited roster, which lists the directory its session works in.
      const newer = load({ dir, id: "newer", cwd: ACME_APP, runtime: new FakeRuntime(), now: () => NOW });
      readOnly(newer.host);
      newer.session.select("auto");
      await newer.host.emit("session_start", { reason: "startup" });
      // The older instance's guard reads the roster that instance holds, which lists only the first directory.
      await older.host.choose(KIMI);
      assert.equal(selection(older), KIMI, "a personal session");
      writeFileSync(join(dir, "smart-router.json"), "{ nope");
      await newer.host.command("smart-router", "reload");
      await newer.host.choose(KIMI);
      assert.deepEqual([selection(newer), lastNotice(newer)?.message], [AUTO, reverted(KIMI)], "the directory the last roster loaded lists");
    });

    test("the remembered bindings still meet Multi-Pass's labels: a work alias labelled otherwise stays refused", async (t) => {
      const dir = agentDir(t, { roster: HERA_V2, multiPass: SWAPPED });
      const loaded = await start({ dir, setup: workEntry, now: () => NOW });
      writeFileSync(join(dir, "smart-router.json"), "{ nope");
      await loaded.host.command("smart-router", "reload");
      assert.match(lastNotice(loaded)?.message ?? "", /smart-router\.json: invalid \(JSON syntax error/);
      await loaded.host.choose(WORK_SOL);
      assert.deepEqual([selection(loaded), lastNotice(loaded)?.message], [AUTO, reverted(WORK_SOL)], "the remembered binding names Positron work, and Multi-Pass labels the alias personal");
    });

    test("before any roster has loaded in the process, a work-scope session allows only smart-router/auto, which refuses", async (t) => {
      const loaded = await working(t, { roster: "{ nope" });
      await loaded.host.choose(WORK_SOL);
      assert.deepEqual([selection(loaded), lastNotice(loaded)?.message], [AUTO, reverted(WORK_SOL)], "no account is known to be the work account");
      assert.throws(() => loaded.runtime.route("auto", request("direct")), /smart-router\.json is invalid \(JSON syntax error/);
      loaded.advance(2_000);
      await loaded.host.choose(LOCAL);
      assert.equal(selection(loaded), AUTO);
      loaded.session.force(WORK_SOL);
      loaded.session.startRun();
      assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), [null]);
    });
  });

  describe("switchToAuto", () => {
    /** A second set of guards over a started session, reading its pin and its scope, with Hera's work account. */
    function guardsOver(loaded: Loaded, overrides: Partial<GuardOptions> = {}) {
      const state = newGuardState();
      return createGuards({
        pi: loaded.host.api,
        now: () => NOW,
        pinOf: (ctx) => readPin(ctx.sessionManager, processSlot().env),
        scopeOf: (ctx) => readScope(ctx.sessionManager, false, undefined),
        workAccount: (provider) => provider === "openai-codex-3",
        stateOf: () => state,
        ...overrides,
      });
    }

    test("in work scope, switches a selection outside it to smart-router/auto, and answers whether the selection is allowed afterwards", async (t) => {
      const loaded = await working(t);
      const guards = guardsOver(loaded);
      loaded.session.force(KIMI);
      assert.equal(await guards.switchToAuto(loaded.session.ctx), true);
      assert.equal(selection(loaded), AUTO);
      loaded.session.force(WORK_SOL);
      const selections = loaded.host.selections.length;
      assert.equal(await guards.switchToAuto(loaded.session.ctx), true);
      assert.deepEqual([selection(loaded), loaded.host.selections.length], [WORK_SOL, selections], "an allowed selection is left alone");
      loaded.session.force(KIMI);
      loaded.host.setModel = async () => false;
      assert.equal(await guards.switchToAuto(loaded.session.ctx), false, "smart-router/auto could not be selected");
      assert.equal(selection(loaded), KIMI);
    });

    test("acts only under the work policy: in personal scope it answers true, and under the pin it switches nothing", async (t) => {
      const loaded = await working(t);
      const personal: ScopeState = { kind: "ok", scope: "personal", source: "entry" };
      loaded.session.force(KIMI);
      assert.equal(await guardsOver(loaded, { scopeOf: () => personal }).switchToAuto(loaded.session.ctx), true);
      assert.equal(selection(loaded), KIMI);
      const pin: PinReading = { on: true, policy: POLICY_V2, entry: "on", at: undefined, env: false };
      const underPin = guardsOver(loaded, { pinOf: () => pin });
      assert.equal(await underPin.switchToAuto(loaded.session.ctx), false, "the pin does not allow KIMI");
      assert.equal(selection(loaded), KIMI, "and nothing was switched");
      loaded.session.force(GLM);
      assert.equal(await underPin.switchToAuto(loaded.session.ctx), true);
      assert.equal(selection(loaded), GLM);
    });
  });
});
