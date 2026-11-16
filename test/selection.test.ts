// A model picked by hand always stays selected and is sent as it is: John's decision of 2026-11-16,
// "Manual choice always wins", in work scope and under the pin alike. These tests pin the rule at
// every event the router hears, and that its policies still hold where they belong: in the routes
// of its own two models.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import type { Api, Model } from "@earendil-works/pi-ai";

import { ENV_PIN, ENV_SCOPE, PIN_ENTRY, SCOPE_ENTRY } from "../src/constants.ts";
import { directoryFailedNotice, directoryNotice, localInWorkScope } from "../src/errors.ts";
import { policyFromRoster } from "../src/local.ts";
import { processSlot } from "../src/owners.ts";
import { readPin } from "../src/pin.ts";
import { readScope, scopeEntry } from "../src/scope.ts";
import { coveredByPin, describeModel, localSelection, ownModel, STATUS_PINNED } from "../src/selection.ts";
import { CHATGPT, FakeCatalog, GLM, heraModels, KIMI, model, NATIVE_SOL, NOW, rosterFixture, rosterFixtureV2, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, FakeRuntime, load, request, resetSlot, routed, start } from "./support/pi.ts";
import type { FakeHost, FakeSession, Loaded, LoadOptions } from "./support/pi.ts";

const POLICY = policyFromRoster(rosterFixture("roster-hera.json"));
const LOCAL = "smart-router/local";
const AUTO = "smart-router/auto";
const OTHER_ROUTER = "other-router/auto";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const HERA_V2 = fixture("roster-hera-v2.json");
const POLICY_V2 = policyFromRoster(rosterFixtureV2("roster-hera-v2.json"));
/** Hera's version 2 work directory, and a directory under it. */
const WORK_DIRECTORY = "/Users/johnw/src/positron";
const APP = `${WORK_DIRECTORY}/app`;
/** Hera's catalog with the work account's medium model, so that routing in work scope reaches the account check, and another router's virtual model. */
const workCatalog = (): FakeCatalog =>
  new FakeCatalog([
    ...heraModels(),
    model(WORK_TERRA, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 }),
    model(OTHER_ROUTER, { api: "pi-virtual", baseUrl: "" }),
  ]);
/** Multi-Pass's labels with Hera's two aliases swapped: #3, the roster's work alias, labelled personal. */
const SWAPPED = JSON.stringify({
  subscriptions: [
    { provider: "openai-codex", index: 2, label: "Positron work" },
    { provider: "openai-codex", index: 3, label: "personal" },
  ],
});
/** The physical models a test picks by hand: OpenRouter, a personal Codex alias, native Codex, the work alias and a LAN model. */
const BY_HAND = [KIMI, SOL, NATIVE_SOL, WORK_SOL, GLM] as const;

beforeEach(resetSlot);
afterEach(resetSlot);

const selection = (loaded: Loaded): string | undefined =>
  loaded.session.model === undefined ? undefined : `${loaded.session.model.provider}/${loaded.session.model.id}`;
const messages = (loaded: Loaded): string[] => loaded.session.notices.map((notice) => notice.message);
const pinStatus = (loaded: Loaded): string | undefined => loaded.session.statuses.get("smart-router");

/** A session pinned to Hera's local policy, on smart-router/local unless `select` says otherwise. */
const pinned = (t: Parameters<typeof agentDir>[0], options: Partial<LoadOptions> & { readonly select?: string } = {}): Promise<Loaded> =>
  start({ dir: agentDir(t), select: "local", setup: (session) => session.pin(POLICY), now: () => NOW, ...options });

/** Record work scope in a session, as /smart-router scope work does. */
const workEntry = (session: FakeSession): void => session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - 60_000));

/** A session in work scope by its entry, on Hera's version 2 roster (or `roster`), Hera's Multi-Pass labels (or `multiPass`) and smart-router/auto. */
function working(
  t: Parameters<typeof agentDir>[0],
  options: Partial<LoadOptions> & { readonly select?: string; readonly roster?: string; readonly multiPass?: string } = {},
): Promise<Loaded> {
  const { roster = HERA_V2, multiPass, ...rest } = options;
  return start({ dir: agentDir(t, { roster, ...(multiPass === undefined ? {} : { multiPass }) }), runtime: new FakeRuntime(workCatalog()), setup: workEntry, now: () => NOW, ...rest });
}

/** Run with an environment variable set to `value`, and restore it afterwards. */
async function withEnv(name: string, value: string, run: () => Promise<void>): Promise<void> {
  const saved = process.env[name];
  process.env[name] = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

/** Make a session's entries unwritable, as a read-only session file does. */
function readOnly(host: FakeHost): void {
  host.api.appendEntry = () => {
    throw new Error("the session file is read-only");
  };
}

/** How many times a competitor switches the selection at most, so that a router that switched back would fail a test instead of looping forever. */
const COMPETITOR_SWITCHES = 5;

/**
 * Multi-Pass allowedSubs, roughly: whenever a smart-router model is selected, it selects `to`
 * instead, at most COMPETITOR_SWITCHES times, and counts its switches.
 */
function allowedSubs(host: FakeHost, to: string): { switches: number } {
  const state = { switches: 0 };
  host.api.on("model_select", async (event) => {
    if (state.switches >= COMPETITOR_SWITCHES || event.model.provider !== "smart-router") return;
    state.switches += 1;
    await host.choose(to);
  });
  return state;
}

function poison(loaded: Loaded): void {
  loaded.session.model = new Proxy({} as Model<Api>, {
    get() {
      throw new Error("model state corrupted");
    },
  });
}

/**
 * Everything a run does with a selection the router could once have stopped: the prompt, the start
 * of the turn, the provider request, cache warming, a compaction and a tree navigation with a
 * summary. Asserts that each goes on untouched, that the selection is still `ref`, that the router
 * selected nothing itself and that it said nothing.
 */
async function sendsAsItIs(loaded: Loaded, ref: string, label: string): Promise<void> {
  const said = loaded.session.notices.length;
  const selections = loaded.host.selections.length;
  const aborts = loaded.session.aborts;
  assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [undefined], `${label}: the prompt is sent`);
  const signal = loaded.session.startRun();
  await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
  assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: { input: "the conversation" } }), [], `${label}: no handler of the router's touches the payload`);
  assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), [], `${label}: no handler of the router's stops warming`);
  assert.deepEqual(await loaded.host.emit("input", { text: "also this", source: "interactive", streamingBehavior: "steer" }), [undefined], `${label}: a steer is sent`);
  assert.equal(signal.aborted, false, `${label}: the run is not aborted`);
  loaded.session.endRun();
  assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "threshold" }), [undefined], `${label}: compaction proceeds`);
  assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [undefined], `${label}: tree navigation with a summary proceeds`);
  assert.equal(selection(loaded), ref, `${label}: the selection is kept`);
  assert.equal(loaded.host.selections.length, selections, `${label}: the router selected nothing`);
  assert.equal(loaded.session.aborts, aborts, `${label}: nothing was aborted`);
  assert.deepEqual(messages(loaded).slice(said), [], `${label}: nothing is said`);
}

describe("the router's handlers", () => {
  test("it registers none for provider requests or cache warming, and its compaction and tree handlers answer nothing", async (t) => {
    const loaded = await pinned(t, { select: KIMI });
    assert.deepEqual([loaded.host.count("before_provider_request"), loaded.host.count("cache_warming_decision")], [0, 0]);
    assert.equal(loaded.host.count("tool_call"), 0, "and it blocks no tools (Q7)");
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [undefined]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [undefined]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: false } }), [undefined]);
  });

  test("a session's record holds no guard state: there is no lock to set", async (t) => {
    const loaded = await pinned(t);
    await loaded.host.choose(KIMI);
    await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
    const record = loaded.router?.record(loaded.session.id);
    assert.ok(record !== undefined, "the input made the session's record");
    assert.equal("guard" in record, false);
  });
});

describe("a model picked by hand in work scope", () => {
  test("stays selected, set or cycled, with no notice, and is sent as it is: the prompt, the turn, the payload, warming, compaction and a tree summary", async (t) => {
    const loaded = await working(t);
    for (const [index, ref] of BY_HAND.entries()) {
      const source = index % 2 === 0 ? "set" : "cycle";
      assert.equal(await loaded.host.choose(ref, source), true);
      assert.equal(selection(loaded), ref, `${ref} (${source})`);
      await sendsAsItIs(loaded, ref, `${ref} (${source})`);
    }
    assert.deepEqual(messages(loaded), [], "the router said nothing at all");
    assert.equal(
      loaded.host.selections.map((entry) => entry.model).join(" "),
      BY_HAND.join(" "),
      "every selection made is one the test made: the router made none",
    );
    assert.equal(pinStatus(loaded), undefined, "work scope has no status item");
  });

  test("the pick John reported: xai/grok-4.7 in work scope stays, and smart-router/auto is not selected again", async (t) => {
    const grok = "xai/grok-4.7";
    const runtime = new FakeRuntime(new FakeCatalog([...heraModels(), model(grok)]));
    const loaded = await working(t, { runtime });
    await loaded.host.choose(grok);
    assert.equal(selection(loaded), grok);
    assert.ok(!messages(loaded).some((message) => message.includes("was not kept")), "the warning he saw is gone");
    assert.deepEqual(messages(loaded), []);
    await sendsAsItIs(loaded, grok, grok);
  });

  test("a second pick at once is kept too: nothing counts picks, and no session is locked", async (t) => {
    const loaded = await working(t);
    await loaded.host.choose(KIMI);
    const signal = loaded.session.startRun();
    await loaded.host.choose(SOL);
    await loaded.host.choose(KIMI, "cycle");
    await loaded.host.choose(SOL, "cycle");
    assert.deepEqual([selection(loaded), signal.aborted, loaded.session.aborts, messages(loaded)], [SOL, false, 0, []]);
    loaded.session.endRun();
    await sendsAsItIs(loaded, SOL, "after four picks in the same instant");
  });

  test("another router's model and smart-router/local are kept as selections too", async (t) => {
    const loaded = await working(t);
    for (const ref of [OTHER_ROUTER, LOCAL, AUTO, LOCAL]) {
      await loaded.host.choose(ref);
      assert.equal(selection(loaded), ref);
    }
    assert.deepEqual(messages(loaded), []);
    assert.equal(loaded.host.selections.length, 4, "the router made none of them");
  });

  test("at turn_start nothing is switched and nothing is aborted, even when the selection was written without a model_select", async (t) => {
    const loaded = await working(t);
    loaded.session.force(KIMI);
    // A switch the router attempted would be seen here, and would fail.
    let attempts = 0;
    const setModel = loaded.host.setModel.bind(loaded.host);
    loaded.host.setModel = async (...args) => {
      attempts += 1;
      return setModel(...args);
    };
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([selection(loaded), signal.aborted, loaded.session.aborts, attempts, messages(loaded)], [KIMI, false, 0, 0, []]);
  });

  test("a work alias whose Multi-Pass label is not its binding's is kept when picked by hand, while smart-router/auto still refuses to route to it", async (t) => {
    const swapped = await working(t, { multiPass: SWAPPED });
    assert.throws(() => swapped.runtime.route("auto", request("direct")), /Multi-Pass labels openai-codex-3 "personal", not "Positron work"/, "routing refuses the alias");
    await swapped.host.choose(WORK_SOL);
    await sendsAsItIs(swapped, WORK_SOL, "the alias picked by hand");
    // The control: with Hera's labels, routing takes the alias.
    const labelled = await working(t, { id: "labelled", runtime: new FakeRuntime(workCatalog()) });
    assert.equal(routed(labelled.runtime.route("auto", request("direct"))), WORK_TERRA);
  });

  test("a work-bound account that is not Codex is kept when picked by hand", async (t) => {
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
    await sendsAsItIs(loaded, claude, claude);
  });

  test("is kept whatever put the session in work scope: its entry, its directory, the latch or a scope that cannot be read", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    // A session whose directory entry cannot be written keeps the directory as its scope's source.
    const directory = load({ dir, id: "directory", cwd: APP, runtime: new FakeRuntime(workCatalog()), now: () => NOW });
    readOnly(directory.host);
    directory.session.select("auto");
    await directory.host.emit("session_start", { reason: "startup" });
    assert.deepEqual(readScope(directory.session.ctx.sessionManager, false, { cwd: APP, directories: [WORK_DIRECTORY] }), { kind: "ok", scope: "work", source: "directory" });
    assert.deepEqual(messages(directory), [directoryFailedNotice(APP, WORK_DIRECTORY, "the session file is read-only")]);
    await directory.host.choose(KIMI);
    await sendsAsItIs(directory, KIMI, "the directory");
    const unreadable = await start({ dir, id: "unreadable", runtime: new FakeRuntime(workCatalog()), now: () => NOW, setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    assert.equal(readScope(unreadable.session.ctx.sessionManager, false, undefined).kind, "unreadable");
    await unreadable.host.choose(KIMI);
    await sendsAsItIs(unreadable, KIMI, "an unreadable scope");
    await withEnv(ENV_SCOPE, "work", async () => {
      const latched = await start({ dir, id: "latched", runtime: new FakeRuntime(workCatalog()), now: () => NOW });
      await latched.host.choose(KIMI);
      await sendsAsItIs(latched, KIMI, "the latch");
      // Under the latch the router's own model still routes only to the work account.
      assert.equal(routed(latched.runtime.route("auto", request("direct"))), WORK_TERRA);
    });
    // A personal session was never guarded, and is as it was.
    const personal = await start({ dir, id: "personal", runtime: new FakeRuntime(workCatalog()), now: () => NOW });
    await personal.host.choose(WORK_SOL);
    await sendsAsItIs(personal, WORK_SOL, "personal scope");
  });

  test("survives a competing extension: the router neither switches back nor locks, wherever the competitor loads", async (t) => {
    for (const order of ["before", "after"] as const) {
      resetSlot();
      let competitor = { switches: 0 };
      const loaded = await working(t, order === "before" ? { before: (host) => (competitor = allowedSubs(host, SOL)) } : {});
      if (order === "after") competitor = allowedSubs(loaded.host, SOL);
      const signal = loaded.session.startRun();
      await loaded.host.choose(LOCAL);
      assert.deepEqual([competitor.switches, selection(loaded), signal.aborted, messages(loaded)], [1, SOL, false, []], `${order}: the competitor's pick stands, and the router does not answer it`);
      loaded.session.endRun();
      await sendsAsItIs(loaded, SOL, order);
    }
  });

  test("a selection that cannot be read stops nothing either", async (t) => {
    const loaded = await working(t);
    poison(loaded);
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual(await loaded.host.emit("before_provider_request", { payload: {} }), []);
    assert.deepEqual(await loaded.host.emit("cache_warming_decision", { action: "warm" }), []);
    loaded.session.endRun();
    assert.deepEqual(await loaded.host.emit("session_before_compact", { reason: "manual" }), [undefined]);
    assert.deepEqual(await loaded.host.emit("session_before_tree", { preparation: { userWantsSummary: true } }), [undefined]);
    assert.deepEqual(await loaded.host.emit("input", { text: "hi", source: "interactive" }), [undefined], "the prompt is passed on");
    assert.deepEqual([signal.aborted, loaded.session.aborts], [false, 0]);
    assert.ok(!messages(loaded).some((message) => /denied|not sent|cancelled|stopped/.test(message)), messages(loaded).join("\n"));
  });
});

describe("a model picked by hand under the pin", () => {
  test("stays selected, set or cycled, with no notice, and is sent as it is: the prompt, the turn, the payload, warming, compaction and a tree summary", async (t) => {
    const loaded = await pinned(t);
    for (const [index, ref] of [KIMI, SOL, GLM, OTHER_ROUTER].entries()) {
      if (ref === OTHER_ROUTER) loaded.runtime.catalog.add(model(OTHER_ROUTER, { api: "pi-virtual", baseUrl: "" }));
      const source = index % 2 === 0 ? "set" : "cycle";
      assert.equal(await loaded.host.choose(ref, source), true);
      assert.equal(selection(loaded), ref, `${ref} (${source})`);
      await sendsAsItIs(loaded, ref, `${ref} (${source})`);
    }
    assert.deepEqual(messages(loaded), [], "the router said nothing at all");
    assert.equal(loaded.host.selections.length, 4, "the router made no selection of its own");
  });

  test("a second pick at once is kept too, and smart-router/auto can be selected", async (t) => {
    const loaded = await pinned(t);
    const signal = loaded.session.startRun();
    await loaded.host.choose(KIMI);
    await loaded.host.choose(SOL);
    await loaded.host.choose(AUTO);
    assert.deepEqual([selection(loaded), signal.aborted, loaded.session.aborts, messages(loaded)], [AUTO, false, 0, []]);
  });

  test("at turn_start nothing is switched and nothing is aborted", async (t) => {
    const loaded = await pinned(t);
    loaded.session.force(KIMI);
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.deepEqual([selection(loaded), signal.aborted, loaded.session.aborts, loaded.host.selections.length, messages(loaded)], [KIMI, false, 0, 0, []]);
  });

  test("under PI_SMART_ROUTER_LOCAL_ONLY too, and in a pinned work session", async (t) => {
    await withEnv(ENV_PIN, "1", async () => {
      const latched = await start({ dir: agentDir(t), id: "env", select: KIMI, now: () => NOW });
      assert.equal(readPin(latched.session.ctx.sessionManager, processSlot().env).env, true);
      assert.deepEqual([selection(latched), messages(latched)], [KIMI, []], "the restored pick is kept at start");
      await sendsAsItIs(latched, KIMI, "the environment switch");
    });
    resetSlot();
    const loaded = await working(t, {
      select: KIMI,
      setup: (session) => {
        workEntry(session);
        session.pin(POLICY_V2);
      },
    });
    assert.deepEqual(readScope(loaded.session.ctx.sessionManager, false, undefined), { kind: "ok", scope: "work", source: "entry" });
    assert.deepEqual([selection(loaded), messages(loaded)], [KIMI, []], "at start, the pick is kept");
    for (const ref of [WORK_SOL, GLM, KIMI]) {
      await loaded.host.choose(ref);
      await sendsAsItIs(loaded, ref, `pinned work session: ${ref}`);
    }
  });

  test("a pin that cannot be read counts as a pin for the router's own models, and stops no model picked by hand", async (t) => {
    const loaded = await start({ dir: agentDir(t), select: KIMI, now: () => NOW });
    const manager = loaded.session.ctx.sessionManager as unknown as Record<string, unknown>;
    const latest = manager.getLatestCustomEntry as (customType: string, options?: unknown) => unknown;
    manager.getLatestCustomEntry = (customType: string, options?: unknown) => {
      if (customType === PIN_ENTRY) throw new Error("index unavailable");
      return latest(customType, options);
    };
    assert.equal(readPin(manager, processSlot().env).entry, "unreadable");
    await sendsAsItIs(loaded, KIMI, "an unreadable pin");
    assert.throws(() => loaded.runtime.route("auto", request("direct")), { message: /^smart-router\/auto: no local model can take this request while this session is pinned to local models/ });
  });
});

describe("a restored selection", () => {
  test("in a work session, by its entry or its directory, is kept at session start; the directory is still recorded", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const byEntry = load({ dir, id: "entry", setup: workEntry, now: () => NOW });
    byEntry.session.select(KIMI);
    await byEntry.host.emit("session_start", { reason: "resume" });
    assert.deepEqual([selection(byEntry), byEntry.session.notices, byEntry.host.selections.length], [KIMI, [], 0]);
    await sendsAsItIs(byEntry, KIMI, "resumed by its entry");
    const byDirectory = load({ dir, id: "directory", cwd: APP, runtime: new FakeRuntime(), now: () => NOW });
    byDirectory.session.select(KIMI);
    await byDirectory.host.emit("session_start", { reason: "resume" });
    assert.deepEqual([selection(byDirectory), messages(byDirectory)], [KIMI, [directoryNotice(APP, WORK_DIRECTORY)]]);
    await sendsAsItIs(byDirectory, KIMI, "resumed under a work directory");
  });

  test("in a latched process is kept at session start, on every start reason", async (t) => {
    await withEnv(ENV_SCOPE, "work", async () => {
      const dir = agentDir(t, { roster: HERA_V2 });
      for (const reason of ["startup", "resume", "reload", "new", "fork"]) {
        const loaded = load({ dir, id: reason, runtime: new FakeRuntime(workCatalog()), now: () => NOW });
        loaded.session.select(SOL);
        await loaded.host.emit("session_start", { reason });
        assert.deepEqual([selection(loaded), messages(loaded), loaded.host.selections.length], [SOL, [], 0], reason);
        await sendsAsItIs(loaded, SOL, `latched, ${reason}`);
      }
    });
  });

  test("in a pinned session is kept at session start, and nothing is tried: a router that cannot select a model says nothing", async (t) => {
    const loaded = load({ dir: agentDir(t), setup: (session) => session.pin(POLICY), now: () => NOW });
    let attempts = 0;
    loaded.host.setModel = async () => {
      attempts += 1;
      return false;
    };
    loaded.session.select(SOL);
    await loaded.host.emit("session_start", { reason: "resume" });
    assert.deepEqual([selection(loaded), attempts, messages(loaded)], [SOL, 0, []]);
    assert.equal(pinStatus(loaded), undefined, "the pin's item is not shown over a model the pin does not route");
  });

  test("smart-router/local restored into a work session is kept, and its own route refuses", async (t) => {
    const loaded = await working(t, { select: "local" });
    assert.deepEqual([selection(loaded), messages(loaded), loaded.host.selections.length], [LOCAL, [], 0]);
    assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [undefined], "the prompt is passed on");
    assert.equal(loaded.router?.record(loaded.session.id)?.plan, undefined, "nothing is planned for a request the route refuses");
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.throws(() => loaded.runtime.route("local", request("user", { signal })), { message: localInWorkScope(true).message });
    assert.deepEqual([selection(loaded), signal.aborted, messages(loaded)], [LOCAL, false, []], "the refusal is the route's: the selection stays, and the router aborts nothing");
  });
});

describe("the router's own models still route only inside their policies", () => {
  test("smart-router/auto in work scope goes to the work account, whatever was picked by hand before", async (t) => {
    const loaded = await working(t);
    await loaded.host.choose(KIMI);
    await loaded.host.choose(AUTO);
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: { model: loaded.runtime.physical(KIMI), thinkingLevel: "high" } }))), WORK_TERRA, "never back to the model picked by hand");
  });

  test("under the pin, smart-router/local goes to the LAN model and smart-router/auto refuses, naming what to select or run", async (t) => {
    const loaded = await pinned(t);
    await loaded.host.choose(KIMI);
    await loaded.host.choose(LOCAL);
    assert.equal(routed(loaded.runtime.route("local", request("direct"))), GLM);
    await loaded.host.choose(AUTO);
    assert.deepEqual(await loaded.host.emit("input", { text: "plan the migration", source: "interactive" }), [undefined], "the prompt is passed on");
    const signal = loaded.session.startRun();
    await loaded.host.emit("turn_start", { turnIndex: 0, timestamp: NOW });
    assert.throws(() => loaded.runtime.route("auto", request("user", { signal })), {
      message:
        "smart-router/auto: no local model can take this request while this session is pinned to local models (local: omlx-hera/GLM-5.3-Flash-oQ4e-mtp: its role local is neither a routing target nor a fallback, so smart-router/auto never routes to it). Nothing was sent. Choose smart-router/local with /model, or run /smart-router local off.",
    });
    assert.deepEqual([selection(loaded), signal.aborted, messages(loaded)], [AUTO, false, []], "the refusal is the route's: the selection stays, and the router aborts nothing");
  });

  test("while the roster fails to load, a work session stays in work scope, its pick by hand is kept, and smart-router/auto refuses", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    // A session under the work directory whose entry cannot be written: its scope rests on the directories.
    const loaded = load({ dir, cwd: APP, now: () => NOW });
    readOnly(loaded.host);
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "startup" });
    writeFileSync(join(dir, "smart-router.json"), "{ nope");
    await loaded.host.command("smart-router", "reload");
    assert.match(loaded.session.notices.at(-1)?.message ?? "", /smart-router\.json: invalid \(JSON syntax error/);
    await loaded.host.choose(KIMI);
    await sendsAsItIs(loaded, KIMI, "with a broken roster");
    // Routing keeps no last-known-good copy, and the work directories of the last valid roster still hold the session in work scope.
    assert.throws(() => loaded.runtime.route("auto", request("direct")), /smart-router\.json is invalid \(JSON syntax error.*or choose a work Codex model with \/model\.$/);
    // An instance built later in the process, as /reload builds one, meets the broken roster first.
    const rebuilt = load({ dir, id: "rebuilt", cwd: APP, runtime: new FakeRuntime(), now: () => NOW });
    rebuilt.session.select(KIMI);
    await rebuilt.host.emit("session_start", { reason: "reload" });
    assert.equal(selection(rebuilt), KIMI);
    assert.equal(rebuilt.session.notices[0]?.message, directoryNotice(APP, WORK_DIRECTORY), "the directory still puts it in work scope, and is recorded");
    assert.ok(!messages(rebuilt).some((message) => message.includes("switched")), "and its selection is not switched");
  });
});

describe("the pin's status item", () => {
  test("shows while the pin covers the selection: either of the router's models or a physical model inside the policy; a model picked by hand outside it shows none", async (t) => {
    const loaded = await pinned(t);
    assert.equal(STATUS_PINNED, "local models");
    assert.equal(pinStatus(loaded), "local models");
    for (const [ref, shown] of [
      [KIMI, undefined],
      [GLM, "local models"],
      [SOL, undefined],
      [AUTO, "local models"],
      [LOCAL, "local models"],
    ] as const) {
      await loaded.host.choose(ref);
      assert.equal(pinStatus(loaded), shown, ref);
    }
  });

  test("shows nothing for an unpinned session, whatever is selected, and never says locked", async (t) => {
    const loaded = await start({ dir: agentDir(t) });
    assert.deepEqual([...loaded.session.statuses], [["smart-router", undefined]]);
    for (const ref of [KIMI, LOCAL, GLM]) {
      await loaded.host.choose(ref);
      assert.equal(pinStatus(loaded), undefined, ref);
    }
  });
});

describe("how the router reads a selection", () => {
  const pin = { on: true, policy: POLICY };
  const find = (ref: string): Model<Api> | undefined => {
    const runtime = new FakeRuntime(workCatalog());
    load({ dir: "/nonexistent", runtime });
    return runtime.find(ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1));
  };

  test("describeModel names a model by provider and id, and no model as such", () => {
    assert.deepEqual([describeModel({ provider: "openrouter", id: "z-ai/glm-5.3" }), describeModel(undefined)], ["openrouter/z-ai/glm-5.3", "no model"]);
  });

  test("ownModel: only smart-router/auto and smart-router/local, as Pi's virtual catalog entries, are the router's; every other model is one picked by hand", () => {
    assert.deepEqual(
      [LOCAL, AUTO, GLM, KIMI, WORK_SOL, OTHER_ROUTER].map((ref) => [ref, ownModel(find(ref))]),
      [
        [LOCAL, "local"],
        [AUTO, "auto"],
        [GLM, undefined],
        [KIMI, undefined],
        [WORK_SOL, undefined],
        [OTHER_ROUTER, undefined],
      ],
    );
    assert.equal(ownModel(undefined), undefined);
    assert.equal(ownModel({ provider: "smart-router", id: "auto", api: "openai-completions" }), undefined, "a physical model that only bears the name");
    assert.equal(ownModel({ provider: "smart-router", id: "other", api: "pi-virtual" }), undefined, "a virtual model of that provider the router does not register");
  });

  test("localSelection: what /smart-router local on leaves selected is smart-router/local or a physical model inside the pin's policy", () => {
    assert.deepEqual(
      [LOCAL, GLM, AUTO, KIMI, SOL, OTHER_ROUTER].map((ref) => [ref, localSelection(find(ref), pin)]),
      [
        [LOCAL, true],
        [GLM, true],
        [AUTO, false],
        [KIMI, false],
        [SOL, false],
        [OTHER_ROUTER, false],
      ],
    );
    assert.equal(localSelection(undefined, pin), false);
  });

  test("coveredByPin: the pin's item shows for either of the router's models, a physical model inside the policy and no model at all; never without a pin", () => {
    assert.deepEqual(
      [LOCAL, GLM, AUTO, KIMI, SOL, OTHER_ROUTER].map((ref) => [ref, coveredByPin(find(ref), pin)]),
      [
        [LOCAL, true],
        [GLM, true],
        [AUTO, true],
        [KIMI, false],
        [SOL, false],
        [OTHER_ROUTER, false],
      ],
    );
    assert.equal(coveredByPin(undefined, pin), true);
    assert.equal(coveredByPin(find(LOCAL), { on: false, policy: POLICY }), false);
  });
});
