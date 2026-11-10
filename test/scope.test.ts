import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import { ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY, PIN_ENTRY, SCOPE_ENTRY, STATUS_KEY } from "../src/constants.ts";
import { directoryFailedNotice, directoryNotice, scopeCarriedNotice, scopeCarryFailedNotice, scopeUnreadable, scopeUnserved } from "../src/errors.ts";
import { policyFromRoster } from "../src/local.ts";
import { processSlot, scopeLatched } from "../src/owners.ts";
import { parseScopeEntry, readScope, scopeEntry, underDirectory } from "../src/scope.ts";
import type { ScopeEntryData, ScopeState } from "../src/scope.ts";
import { CHATGPT, DEEPSEEK, FakeCatalog, GLM, heraModels, model, NOW, rosterFixture, SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, load, request, resetSlot, routed, start } from "./support/pi.ts";
import type { FakeSession, Loaded, LoadOptions } from "./support/pi.ts";

const HERA_V2 = fixture("roster-hera-v2.json");
const WORK_DIRECTORY = "/Users/johnw/src/positron";
const APP = "/Users/johnw/src/positron/app";
const PLANNING = "plan the migration to the new store";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const NATIVE_TERRA = "openai-codex/gpt-6.1-terra";
const AT = new Date(NOW).toISOString();
const OK_WORK_LATCH: ScopeState = { kind: "ok", scope: "work", source: "latch" };
const OK_WORK_ENTRY: ScopeState = { kind: "ok", scope: "work", source: "entry" };
const OK_PERSONAL_ENTRY: ScopeState = { kind: "ok", scope: "personal", source: "entry" };
const DEFAULT: ScopeState = { kind: "ok", scope: "personal", source: "default" };

beforeEach(resetSlot);
afterEach(resetSlot);

/** A Codex model, as Hera's catalog lists them. */
const codex = (ref: string): Model<Api> => model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 });

/** Hera's catalog with the medium Codex model of each work account, so that work scope can route. */
const workCatalog = (): FakeCatalog => new FakeCatalog([...heraModels(), codex(WORK_TERRA), codex(NATIVE_TERRA)]);

/** A session manager whose latest scope entry is `entry`. */
function holding(entry: unknown): object {
  return { getLatestCustomEntry: () => entry, getRecentActiveEntries: () => [] };
}

const custom = (data: unknown, type = "custom") => ({ type, customType: SCOPE_ENTRY, data, id: "e1", parentId: null, timestamp: AT });

/** The session's scope, read as the router reads it. */
const scopeOf = (loaded: Loaded): ScopeState => readScope(loaded.session.ctx.sessionManager, scopeLatched(processSlot()));

/** The data of the session's scope entries, oldest first. */
const scopeEntries = (loaded: Loaded): unknown[] => loaded.session.entries.filter((entry) => entry.customType === SCOPE_ENTRY).map((entry) => entry.data);

const messages = (loaded: Loaded): string[] => loaded.session.notices.map((notice) => notice.message);

/** A scope recorded by /smart-router scope, before the session starts. */
const recorded =
  (scope: ScopeEntryData["scope"]) =>
  (session: FakeSession): void =>
    session.appendCustom(SCOPE_ENTRY, scopeEntry(scope, "command", NOW - 60_000));

/** Load a session on smart-router/auto and start it for a reason. */
async function begin(options: LoadOptions, reason = "startup"): Promise<Loaded> {
  const loaded = load({ now: () => NOW, ...options });
  loaded.session.select("auto");
  await loaded.host.emit("session_start", { reason });
  return loaded;
}

/** Run with PI_SMART_ROUTER_SCOPE set to `value`, or unset, and restore it afterwards. */
async function withScope(value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env[ENV_SCOPE];
  if (value === undefined) delete process.env[ENV_SCOPE];
  else process.env[ENV_SCOPE] = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env[ENV_SCOPE];
    else process.env[ENV_SCOPE] = saved;
  }
}

/** A refusal: exactly `expected`, which says that nothing was sent and is never retried. */
function refuses(run: () => unknown, expected: Error, label: string): void {
  let text = "";
  assert.throws(
    run,
    (error: unknown) => {
      text = error instanceof Error ? error.message : String(error);
      return true;
    },
    label,
  );
  assert.equal(text, expected.message, label);
  assert.match(text, /Nothing was sent\./, label);
  assert.equal(isRetryableAssistantError(assistant("smart-router/auto", { stopReason: "error", errorMessage: text })), false, text);
}

test("the names: the scope's entry and switch, the level's entry, and a status item that is not the pin's", () => {
  assert.deepEqual([SCOPE_ENTRY, ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY], ["smart-router.scope", "PI_SMART_ROUTER_SCOPE", "smart-router.level", "smart-router-level"]);
  assert.notEqual(LEVEL_KEY, STATUS_KEY);
  assert.notEqual(SCOPE_ENTRY, PIN_ENTRY);
});

describe("a scope entry", () => {
  test("is read exactly as the router writes it", () => {
    for (const scope of ["personal", "work"] as const) {
      for (const by of ["command", "directory", "carried"] as const) {
        const data = scopeEntry(scope, by, NOW);
        assert.deepEqual(data, { v: 1, scope, by, at: NOW });
        assert.deepEqual(parseScopeEntry(custom(data)), data, `${scope} by ${by}`);
      }
    }
  });

  test("anything else is malformed: unknown keys, another version, and a scope that is neither personal nor work", () => {
    const good = scopeEntry("work", "command", NOW);
    const cases: Array<[string, unknown]> = [
      ["an unknown key", custom({ ...good, by: "command", note: "x" })],
      ["a key another extension added", custom({ ...good, local: { refs: [] } })],
      ["version 2", custom({ ...good, v: 2 })],
      ["version as text", custom({ ...good, v: "1" })],
      ["no version", custom({ scope: "work", by: "command", at: NOW })],
      ["the scope Work", custom({ ...good, scope: "Work" })],
      ["the scope team", custom({ ...good, scope: "team" })],
      ["no scope", custom({ v: 1, by: "command", at: NOW })],
      ["another recorder", custom({ ...good, by: "user" })],
      ["no recorder", custom({ v: 1, scope: "work", at: NOW })],
      ["a time as text", custom({ ...good, at: AT })],
      ["a time that is not finite", custom({ ...good, at: Number.POSITIVE_INFINITY })],
      ["no time", custom({ v: 1, scope: "work", by: "command" })],
      ["data that is not an object", custom("work")],
      ["data that is an array", custom([good])],
      ["no data", { type: "custom", customType: SCOPE_ENTRY }],
      ["a custom_message of the type", custom(good, "custom_message")],
      ["an entry of another type", { ...custom(good), customType: PIN_ENTRY }],
      ["not an entry", "work"],
      ["null", null],
    ];
    for (const [name, entry] of cases) assert.equal(parseScopeEntry(entry), undefined, name);
  });
});

describe("readScope", () => {
  test("the latch comes first: a personal entry, a malformed one, and an unreadable session are all in work scope", () => {
    assert.deepEqual(readScope(holding(custom(scopeEntry("personal", "command", NOW))), true), OK_WORK_LATCH);
    assert.deepEqual(readScope(holding(custom({ v: 9 })), true), OK_WORK_LATCH);
    assert.deepEqual(readScope(undefined, true), OK_WORK_LATCH);
  });

  test("then the session's latest entry, then personal", () => {
    assert.deepEqual(readScope(holding(undefined), false), DEFAULT);
    assert.deepEqual(readScope(holding(null), false), DEFAULT);
    assert.deepEqual(readScope(holding(custom(scopeEntry("work", "directory", NOW))), false), OK_WORK_ENTRY);
    assert.deepEqual(readScope(holding(custom(scopeEntry("personal", "carried", NOW))), false), OK_PERSONAL_ENTRY);
  });

  test("fails closed: a malformed entry, a session without the bounded readers and a reader that throws are unreadable", () => {
    const unreadable = (state: ScopeState, pattern: RegExp, label: string): void => {
      assert.equal(state.kind, "unreadable", label);
      if (state.kind === "unreadable") assert.match(state.reason, pattern, label);
    };
    unreadable(readScope(holding(custom({ v: 1, scope: "work" })), false), /^the latest smart-router\.scope entry is not one the router wrote$/, "malformed");
    unreadable(readScope(holding(custom(scopeEntry("work", "command", NOW), "custom_message")), false), /not one the router wrote/, "a custom_message");
    unreadable(readScope(undefined, false), /no bounded session history/, "no session manager");
    unreadable(readScope({ getLatestCustomEntry: () => undefined }, false), /no bounded session history/, "no recent-entries reader");
    const failing = { getLatestCustomEntry: () => assert.fail("database is locked"), getRecentActiveEntries: () => [] };
    unreadable(readScope(failing, false), /^reading its smart-router\.scope entries failed: database is locked$/, "a reader that throws");
  });

  test("reads the latest entry over the whole session with the bounded reader, and the latch reads nothing", () => {
    const calls: unknown[][] = [];
    const manager = {
      getLatestCustomEntry: (...args: unknown[]) => {
        calls.push(args);
        return undefined;
      },
      getRecentActiveEntries: () => [],
    };
    readScope(manager, false);
    assert.deepEqual(calls, [[SCOPE_ENTRY, { scope: "all" }]]);
    readScope(manager, true);
    assert.equal(calls.length, 1);
  });
});

test("underDirectory matches whole path segments, as text, and ignores a trailing slash", () => {
  const cases: Array<[string, string[], boolean]> = [
    ["/x/work", ["/x/work"], true],
    ["/x/work/a", ["/x/work"], true],
    ["/x/work/a/b", ["/x/work"], true],
    ["/x/workshop", ["/x/work"], false],
    ["/x/work/", ["/x/work"], true],
    ["/x/work//", ["/x/work"], true],
    ["/x/wor", ["/x/work"], false],
    ["/x", ["/x/work"], false],
    ["/X/work", ["/x/work"], false],
    ["/y/z", ["/x/work", "/y"], true],
    ["/y/z", [], false],
    ["/x/work", ["/x/work/"], true],
    ["/x/workshop", ["/x/work/"], false],
    ["/x", ["/"], true],
    ["/", ["/"], true],
    ["", ["/x/work"], false],
    ["", ["/"], false],
    ["x/work", ["/x/work"], false],
    ["/x/work", [""], false],
    ["/x/work", ["x/work"], false],
  ];
  for (const [cwd, directories, expected] of cases) assert.equal(underDirectory(cwd, directories), expected, `${cwd} under ${JSON.stringify(directories)}`);
});

describe("handoffs", () => {
  test("/new and a fork each record a carried entry of the scope an entry set, keyed by the new session's file", async (t) => {
    const dir = agentDir(t);
    const parents = [
      ["a", "new", "work"],
      ["b", "fork", "work"],
      ["c", "fork", "personal"],
    ] as const;
    for (const [id, reason, scope] of parents) {
      const parent = await begin({ dir, id, file: `/sessions/${id}.jsonl`, runtime: new FakeRuntime(), setup: recorded(scope) });
      await parent.host.emit("session_shutdown", { reason, targetSessionFile: `/sessions/${id}-${reason}.jsonl` });
    }
    assert.equal(processSlot().scopeHandoffs?.size, 3);
    assert.equal(processSlot().handoffs.size, 0, "the pin's handoffs are untouched");
    for (const [id, reason, scope] of parents) {
      const file = `/sessions/${id}-${reason}.jsonl`;
      const child = await begin({ dir, id: file, file, runtime: new FakeRuntime() }, reason);
      assert.deepEqual(scopeEntries(child), [{ v: 1, scope, by: "carried", at: NOW }], file);
      assert.deepEqual(scopeOf(child), { kind: "ok", scope, source: "entry" }, file);
      assert.deepEqual(child.session.notices, [{ type: "info", message: scopeCarriedNotice(scope) }], file);
    }
    assert.equal(processSlot().scopeHandoffs?.size, 0, "each handoff is taken once");
    assert.equal(scopeCarriedNotice("work"), "pi-smart-router: this session is in work scope, as the session it came from was.");
  });

  test("the latch's scope is carried too, so the new session stays in work scope wherever it is resumed", async (t) => {
    await withScope("work", async () => {
      const dir = agentDir(t);
      const parent = await begin({ dir, id: "parent", file: "/sessions/p.jsonl", runtime: new FakeRuntime() });
      assert.deepEqual(scopeOf(parent), OK_WORK_LATCH);
      await parent.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/p-fork.jsonl" });
      const child = await begin({ dir, id: "child", file: "/sessions/p-fork.jsonl", runtime: new FakeRuntime() }, "fork");
      assert.deepEqual(scopeEntries(child), [{ v: 1, scope: "work", by: "carried", at: NOW }]);
      assert.deepEqual(readScope(child.session.ctx.sessionManager, false), OK_WORK_ENTRY, "without the latch, the entry keeps it in work scope");
    });
  });

  test("a personal default, an unreadable scope, quitting, reloading, resuming and an in-memory session leave no scope handoff", async (t) => {
    const dir = agentDir(t);
    const plain = await begin({ dir, id: "plain", file: "/sessions/plain.jsonl" });
    await plain.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/plain-new.jsonl" });
    assert.equal(processSlot().scopeHandoffs?.size ?? 0, 0, "a personal default");
    const child = await begin({ dir, id: "plain-new", file: "/sessions/plain-new.jsonl", runtime: new FakeRuntime() }, "new");
    assert.deepEqual([scopeEntries(child), scopeOf(child), messages(child)], [[], DEFAULT, []]);
    // A scope that cannot be read is not carried: its value is unknown, and work scope would send the
    // new session's text to the work account. A fork keeps the entries of its branch anyway.
    const malformed = await begin({ dir, id: "malformed", file: "/sessions/m.jsonl", runtime: new FakeRuntime(), setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    assert.equal(scopeOf(malformed).kind, "unreadable");
    await malformed.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/m-fork.jsonl" });
    for (const reason of ["quit", "reload", "resume"]) {
      const loaded = await begin({ dir, id: reason, file: `/sessions/${reason}.jsonl`, runtime: new FakeRuntime(), setup: recorded("work") });
      await loaded.host.emit("session_shutdown", { reason, targetSessionFile: `/sessions/${reason}-next.jsonl` });
    }
    const memory = await begin({ dir, id: "memory", runtime: new FakeRuntime(), setup: recorded("work") });
    await memory.host.emit("session_shutdown", { reason: "new" });
    await memory.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "" });
    assert.equal(processSlot().scopeHandoffs?.size ?? 0, 0);
  });

  test("a pinned work session hands on its pin and its scope, each in its own map", async (t) => {
    const dir = agentDir(t);
    const pinned = await begin({
      dir,
      id: "pinned",
      file: "/sessions/pinned.jsonl",
      setup: (session) => {
        session.pin(policyFromRoster(rosterFixture("roster-hera.json")));
        recorded("work")(session);
      },
    });
    await pinned.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/pinned-new.jsonl" });
    assert.deepEqual([processSlot().handoffs.size, processSlot().scopeHandoffs?.size], [1, 1]);
    assert.deepEqual(processSlot().scopeHandoffs?.get("/sessions/pinned-new.jsonl"), "work");
    const child = await begin({ dir, id: "child", file: "/sessions/pinned-new.jsonl", runtime: new FakeRuntime() }, "new");
    assert.deepEqual(scopeEntries(child), [{ v: 1, scope: "work", by: "carried", at: NOW }]);
    assert.equal(child.session.pinEntries().length, 1, "the pin was carried too");
    assert.deepEqual([processSlot().handoffs.size, processSlot().scopeHandoffs?.size], [0, 0]);
  });

  test("a scope that cannot be recorded in the new session says so", async (t) => {
    const dir = agentDir(t);
    const parent = await begin({ dir, id: "parent", file: "/sessions/p.jsonl", setup: recorded("work") });
    await parent.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/p-new.jsonl" });
    const child = load({ dir, id: "child", file: "/sessions/p-new.jsonl", runtime: new FakeRuntime(), now: () => NOW });
    child.host.api.appendEntry = () => {
      throw new Error("the session file is read-only");
    };
    child.session.select("auto");
    await child.host.emit("session_start", { reason: "new" });
    const notice = scopeCarryFailedNotice("work", "the session file is read-only");
    assert.equal(
      notice,
      "pi-smart-router: the session this one came from was in work scope, but its scope could not be recorded here (the session file is read-only). Run /smart-router scope work before you send anything.",
    );
    assert.deepEqual(child.session.notices, [{ type: "error", message: notice }]);
    assert.equal(processSlot().scopeHandoffs?.size, 0, "the handoff was taken");
  });
});

describe("the work directories", () => {
  const NOTICE = `pi-smart-router: this session is in work scope because ${APP} is under ${WORK_DIRECTORY}.`;

  test("a session under one starts in work scope, records it and says why, at every kind of start", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    assert.equal(directoryNotice(APP, WORK_DIRECTORY), NOTICE);
    for (const reason of ["startup", "new", "fork", "reload", "resume"]) {
      const loaded = await begin({ dir, id: reason, cwd: APP, runtime: new FakeRuntime() }, reason);
      assert.deepEqual(scopeEntries(loaded), [{ v: 1, scope: "work", by: "directory", at: NOW }], reason);
      assert.deepEqual(scopeOf(loaded), OK_WORK_ENTRY, reason);
      assert.deepEqual(loaded.session.notices, [{ type: "info", message: NOTICE }], reason);
      // Once recorded, the entry decides, so a later start records nothing more.
      await loaded.host.emit("session_start", { reason: "reload" });
      assert.equal(scopeEntries(loaded).length, 1, reason);
    }
    const slash = await begin({ dir, id: "slash", cwd: `${WORK_DIRECTORY}/`, runtime: new FakeRuntime() });
    assert.deepEqual([scopeOf(slash), messages(slash)], [OK_WORK_ENTRY, [`pi-smart-router: this session is in work scope because ${WORK_DIRECTORY}/ is under ${WORK_DIRECTORY}.`]]);
  });

  test("a resumed session there that has turns but no scope entry moves to work scope", async (t) => {
    const loaded = await begin(
      {
        dir: agentDir(t, { roster: HERA_V2 }),
        cwd: APP,
        setup: (session) => {
          session.entries.push({ type: "message", id: "u0", parentId: null, timestamp: AT, message: { role: "user", content: "fix the build", timestamp: NOW - 120_000 } });
          session.appendAssistant(assistant(SOL, { timestamp: NOW - 60_000 }));
        },
      },
      "resume",
    );
    assert.deepEqual(scopeEntries(loaded), [{ v: 1, scope: "work", by: "directory", at: NOW }]);
    assert.deepEqual(scopeOf(loaded), OK_WORK_ENTRY);
    assert.deepEqual(messages(loaded), [NOTICE]);
  });

  test("a session there with a personal entry stays personal, and so does one a fork or /new carried personal", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const resumed = await begin({ dir, id: "resumed", cwd: APP, setup: recorded("personal") }, "resume");
    assert.deepEqual([scopeEntries(resumed).length, scopeOf(resumed), messages(resumed)], [1, OK_PERSONAL_ENTRY, []]);
    const parent = await begin({ dir, id: "parent", file: "/sessions/p.jsonl", runtime: new FakeRuntime(), setup: recorded("personal") });
    await parent.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/p-new.jsonl" });
    const child = await begin({ dir, id: "child", cwd: APP, file: "/sessions/p-new.jsonl", runtime: new FakeRuntime() }, "new");
    assert.deepEqual(scopeEntries(child), [{ v: 1, scope: "personal", by: "carried", at: NOW }]);
    assert.deepEqual([scopeOf(child), messages(child)], [OK_PERSONAL_ENTRY, [scopeCarriedNotice("personal")]]);
  });

  test("a session outside them, a version 1 roster, the latch and an unreadable scope record nothing", async (t) => {
    const hera = agentDir(t, { roster: HERA_V2 });
    for (const cwd of ["/Users/johnw/src/positronic", "/Users/johnw/src", "/nonexistent"]) {
      const outside = await begin({ dir: hera, id: cwd, cwd, runtime: new FakeRuntime() });
      assert.deepEqual([scopeEntries(outside), scopeOf(outside), messages(outside)], [[], DEFAULT, []], cwd);
    }
    const v1 = await begin({ dir: agentDir(t), id: "v1", cwd: APP, runtime: new FakeRuntime() });
    assert.deepEqual([scopeEntries(v1), scopeOf(v1), messages(v1)], [[], DEFAULT, []], "version 1");
    const malformed = await begin({ dir: hera, id: "malformed", cwd: APP, runtime: new FakeRuntime(), setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    assert.deepEqual([scopeEntries(malformed).length, scopeOf(malformed).kind, messages(malformed)], [1, "unreadable", []], "unreadable");
    await withScope("work", async () => {
      const latched = await begin({ dir: hera, id: "latched", cwd: APP, runtime: new FakeRuntime() });
      assert.deepEqual([scopeEntries(latched), scopeOf(latched), messages(latched)], [[], OK_WORK_LATCH, []], "the latch");
    });
  });

  test("a scope that cannot be recorded says so", async (t) => {
    const loaded = load({ dir: agentDir(t, { roster: HERA_V2 }), cwd: APP, now: () => NOW });
    loaded.host.api.appendEntry = () => {
      throw new Error("the session file is read-only");
    };
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "resume" });
    const notice = directoryFailedNotice(APP, WORK_DIRECTORY, "the session file is read-only");
    assert.equal(
      notice,
      `pi-smart-router: this session belongs in work scope because ${APP} is under ${WORK_DIRECTORY}, but its scope could not be recorded (the session file is read-only). Run /smart-router scope work before you send anything.`,
    );
    assert.deepEqual(loaded.session.notices, [{ type: "error", message: notice }]);
    assert.deepEqual(scopeOf(loaded), DEFAULT);
  });
});

describe("smart-router/auto refuses a scope it cannot serve", () => {
  test("a version 1 roster with PI_SMART_ROUTER_SCOPE=work, on every path, sending nothing; smart-router/local still routes to the LAN model", async (t) => {
    await withScope("work", async () => {
      const loaded = await begin({ dir: agentDir(t) });
      const refusal = scopeUnserved("auto", "work", 1);
      assert.equal(
        refusal.message,
        "smart-router/auto: this session is in work scope, which a version 1 roster does not serve. Nothing was sent. Give the roster a work scope (version 2), or choose a model with /model.",
      );
      // The owned run: the prompt plans, and the run's first request refuses.
      await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
      const signal = loaded.session.startRun();
      refuses(() => loaded.runtime.route("auto", request("user", { signal })), refusal, "the owned run");
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal })), refusal, "a continuation");
      loaded.session.endRun();
      refuses(() => loaded.runtime.route("auto", request("direct")), refusal, "a direct request without a plan");
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal: new AbortController().signal })), refusal, "a foreign request");
      assert.equal(routed(loaded.runtime.route("local", request("direct"))), GLM);
      assert.deepEqual(
        loaded.router?.record(loaded.session.id)?.history.map((entry) => [entry.virtual, entry.ref]),
        [["local", GLM]],
        "only the local request reached a model",
      );
    });
  });

  test("an unreadable scope, which routing resolves in work scope, the narrower one", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const malformed = await begin({ dir, id: "malformed", runtime: new FakeRuntime(workCatalog()), setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 1, scope: "work" }) });
    const unreadable = scopeUnreadable("auto", "the latest smart-router.scope entry is not one the router wrote");
    assert.equal(
      unreadable.message,
      "smart-router/auto: this session's scope cannot be read (the latest smart-router.scope entry is not one the router wrote). Nothing was sent. Record it again with /smart-router scope work or /smart-router scope personal, or choose a model with /model.",
    );
    refuses(() => malformed.runtime.route("auto", request("direct")), unreadable, "a malformed entry");
    const signal = malformed.session.startRun();
    refuses(() => malformed.runtime.route("auto", request("continuation", { signal })), unreadable, "the owned run");
    malformed.session.endRun();
    assert.equal(routed(malformed.runtime.route("local", request("direct"))), GLM, "smart-router/local stays on the LAN");
    // What pi-cache-optimizer is told shows the scope routing resolves in: work, not personal.
    assert.deepEqual(
      [malformed.router?.activeRoute("auto")?.provider, malformed.router?.activeRoute("auto")?.modelId],
      ["openai-codex-3", "gpt-6.1-terra"],
    );
    const personal = await begin({ dir, id: "personal", runtime: new FakeRuntime(workCatalog()) });
    assert.equal(personal.router?.activeRoute("auto")?.modelId, "deepseek/deepseek-v4.1-flash-1017");

    const locked = await begin({ dir, id: "locked", runtime: new FakeRuntime(workCatalog()) });
    const manager = locked.session.ctx.sessionManager as unknown as Record<string, unknown>;
    const latest = manager.getLatestCustomEntry as (customType: string, options?: unknown) => unknown;
    manager.getLatestCustomEntry = (customType: string, options?: unknown) => {
      if (customType === SCOPE_ENTRY) throw new Error("database is locked");
      return latest(customType, options);
    };
    refuses(() => locked.runtime.route("auto", request("direct")), scopeUnreadable("auto", "reading its smart-router.scope entries failed: database is locked"), "a reader that throws");
    assert.equal(routed(locked.runtime.route("local", request("direct"))), GLM);
  });

  test("a version 2 roster without the session's scope", async (t) => {
    const work = agentDir(t, { roster: fixture("roster-work.json") });
    const personal = await begin({ dir: work, id: "personal", runtime: new FakeRuntime(workCatalog()) });
    refuses(() => personal.runtime.route("auto", request("direct")), scopeUnserved("auto", "personal", 2), "a work-only roster in personal scope");
    assert.equal(
      scopeUnserved("auto", "personal", 2).message,
      "smart-router/auto: this session is in personal scope, which the roster does not serve. Nothing was sent. Give the roster a personal scope, or choose a model with /model.",
    );
    const v2 = JSON.parse(HERA_V2);
    delete v2.scopes.work;
    v2.roles = v2.roles.filter((role: { name: string }) => !role.name.startsWith("work-"));
    delete v2.accounts["openai-codex-3"];
    const personalOnly = agentDir(t, { roster: JSON.stringify(v2) });
    await withScope("work", async () => {
      const latched = await begin({ dir: personalOnly, id: "latched", runtime: new FakeRuntime(workCatalog()) });
      assert.equal(latched.session.notices.length, 0, "the roster is valid");
      refuses(() => latched.runtime.route("auto", request("direct")), scopeUnserved("auto", "work", 2), "a personal-only roster in work scope");
      assert.equal(routed(latched.runtime.route("local", request("direct"))), GLM);
    });
  });

  test("a version 2 roster that serves the session's scope routes within it", async (t) => {
    const hera = agentDir(t, { roster: HERA_V2 });
    const personal = await begin({ dir: hera, id: "personal", runtime: new FakeRuntime(workCatalog()) });
    assert.equal(routed(personal.runtime.route("auto", request("direct"))), DEEPSEEK, "personal medium: terra on the personal account is not in this catalog");
    const directory = await begin({ dir: hera, id: "directory", cwd: APP, runtime: new FakeRuntime(workCatalog()) });
    assert.equal(routed(directory.runtime.route("auto", request("direct"))), WORK_TERRA);
    await withScope("work", async () => {
      const latched = await begin({ dir: hera, id: "latched", runtime: new FakeRuntime(workCatalog()), setup: recorded("personal") });
      assert.equal(routed(latched.runtime.route("auto", request("direct"))), WORK_TERRA, "the latch outranks a personal entry");
      const machine = await begin({ dir: agentDir(t, { roster: fixture("roster-work.json") }), id: "machine", runtime: new FakeRuntime(workCatalog()) });
      assert.equal(routed(machine.runtime.route("auto", request("direct"))), NATIVE_TERRA, "a work machine");
    });
  });
});

test("a session started before the latch was set is in work scope once any instance latches it", async (t) => {
  const dir = agentDir(t, { roster: HERA_V2 });
  const before = await start({ dir, id: "before", runtime: new FakeRuntime(workCatalog()), now: () => NOW });
  assert.deepEqual(scopeOf(before), DEFAULT);
  await withScope("work", async () => {
    await start({ dir, id: "after", runtime: new FakeRuntime(workCatalog()), now: () => NOW });
  });
  assert.deepEqual(scopeOf(before), OK_WORK_LATCH);
  assert.equal(routed(before.runtime.route("auto", request("direct"))), WORK_TERRA);
});
