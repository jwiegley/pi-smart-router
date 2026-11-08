import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { policyFromRoster } from "../src/local.ts";
import { processSlot } from "../src/owners.ts";
import { readPin } from "../src/pin.ts";
import { FakeCatalog, GLM, heraModels, KIMI, model, NOW, rosterFixture, SOL } from "./support/catalog.ts";
import { agentDir, FakeRuntime, load, resetSlot, start } from "./support/pi.ts";
import type { FakeHost, Loaded, LoadOptions } from "./support/pi.ts";

const POLICY = policyFromRoster(rosterFixture("roster-hera.json"));
const LOCAL = "smart-router/local";
const OTHER_ROUTER = "other-router/auto";

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

interface Pinned extends Loaded {
  /** Advance the router's clock. */
  advance(ms: number): void;
}

/** A session pinned to Hera's local policy, on smart-router/local, with a controllable clock. */
async function pinned(t: Parameters<typeof agentDir>[0], options: Partial<LoadOptions> & { readonly select?: string } = {}): Promise<Pinned> {
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
