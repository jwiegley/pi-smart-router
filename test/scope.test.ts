import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import { ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY, PIN_ENTRY, SCOPE_ENTRY, STATUS_KEY } from "../src/constants.ts";
import { directoryFailedNotice, directoryNotice, scopeCarriedNotice, scopeCarryFailedNotice, scopeUnreadable, scopeUnserved } from "../src/errors.ts";
import { policyFromRoster } from "../src/local.ts";
import { processSlot, scopeLatched } from "../src/owners.ts";
import { createRouter } from "../src/router.ts";
import { parseScopeEntry, readScope, scopeEntry, underDirectory, workDirectoryOf } from "../src/scope.ts";
import type { ScopeEntryData, ScopeState, WorkDirectories } from "../src/scope.ts";
import { CHATGPT, DEEPSEEK, FakeCatalog, GLM, heraModels, KIMI, model, NOW, rosterFixture, SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, load, request, resetSlot, routed, start } from "./support/pi.ts";
import type { FakeSession, Loaded, LoadOptions } from "./support/pi.ts";

const HERA_V2 = fixture("roster-hera-v2.json");
const WORK_DIRECTORY = "/Users/johnw/src/positron";
const APP = "/Users/johnw/src/positron/app";
/** A directory Hera's roster does not list until a test adds it. */
const ACME = "/Users/johnw/src/acme";
const ACME_APP = "/Users/johnw/src/acme/app";
const UNDER: WorkDirectories = { cwd: APP, directories: [WORK_DIRECTORY] };
const OUTSIDE: WorkDirectories = { cwd: ACME_APP, directories: [WORK_DIRECTORY] };
const PLANNING = "plan the migration to the new store";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const NATIVE_TERRA = "openai-codex/gpt-6.1-terra";
const AT = new Date(NOW).toISOString();
const OK_WORK_LATCH: ScopeState = { kind: "ok", scope: "work", source: "latch" };
const OK_WORK_ENTRY: ScopeState = { kind: "ok", scope: "work", source: "entry" };
const OK_PERSONAL_ENTRY: ScopeState = { kind: "ok", scope: "personal", source: "entry" };
const OK_WORK_DIRECTORY: ScopeState = { kind: "ok", scope: "work", source: "directory" };
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

/** The scope the latch and the session's entries give, without the work directories: what is recorded. */
const scopeOf = (loaded: Loaded): ScopeState => readScope(loaded.session.ctx.sessionManager, scopeLatched(processSlot()), undefined);

/** Rewrite Hera's version 2 roster with these work directories, with a later modification time. */
function listDirectories(dir: string, directories: readonly string[]): void {
  const roster = JSON.parse(HERA_V2);
  roster.scopes.work.directories = directories;
  const path = join(dir, "smart-router.json");
  writeFileSync(path, JSON.stringify(roster));
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));
}

/** How many times the session was told that the work directories put it in work scope. */
const directoryNotices = (loaded: Loaded, cwd: string, directory: string): number =>
  loaded.session.notices.filter((notice) => notice.message === directoryNotice(cwd, directory)).length;

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
  test("the latch comes first: a personal entry, a malformed one, an unreadable session and the work directories all give it", () => {
    assert.deepEqual(readScope(holding(custom(scopeEntry("personal", "command", NOW))), true, undefined), OK_WORK_LATCH);
    assert.deepEqual(readScope(holding(custom({ v: 9 })), true, undefined), OK_WORK_LATCH);
    assert.deepEqual(readScope(undefined, true, undefined), OK_WORK_LATCH);
    assert.deepEqual(readScope(holding(undefined), true, UNDER), OK_WORK_LATCH);
  });

  test("then the session's latest entry, then the work directories, then personal", () => {
    assert.deepEqual(readScope(holding(undefined), false, undefined), DEFAULT);
    assert.deepEqual(readScope(holding(null), false, undefined), DEFAULT);
    assert.deepEqual(readScope(holding(custom(scopeEntry("work", "directory", NOW))), false, undefined), OK_WORK_ENTRY);
    assert.deepEqual(readScope(holding(custom(scopeEntry("personal", "carried", NOW))), false, undefined), OK_PERSONAL_ENTRY);
    assert.deepEqual(readScope(holding(undefined), false, UNDER), OK_WORK_DIRECTORY);
    assert.deepEqual(readScope(holding(null), false, UNDER), OK_WORK_DIRECTORY);
    assert.deepEqual(readScope(holding(undefined), false, OUTSIDE), DEFAULT);
    assert.deepEqual(readScope(holding(undefined), false, { cwd: APP, directories: [] }), DEFAULT);
    assert.deepEqual(readScope(holding(custom(scopeEntry("personal", "command", NOW))), false, UNDER), OK_PERSONAL_ENTRY, "an entry outranks the directories");
  });

  test("fails closed: a malformed entry, a session without the bounded readers and a reader that throws are unreadable, under a work directory too", () => {
    const unreadable = (state: ScopeState, pattern: RegExp, label: string): void => {
      assert.equal(state.kind, "unreadable", label);
      if (state.kind === "unreadable") assert.match(state.reason, pattern, label);
    };
    unreadable(readScope(holding(custom({ v: 1, scope: "work" })), false, undefined), /^the latest smart-router\.scope entry is not one the router wrote$/, "malformed");
    unreadable(readScope(holding(custom(scopeEntry("work", "command", NOW), "custom_message")), false, undefined), /not one the router wrote/, "a custom_message");
    unreadable(readScope(undefined, false, undefined), /no bounded session history/, "no session manager");
    unreadable(readScope({ getLatestCustomEntry: () => undefined }, false, undefined), /no bounded session history/, "no recent-entries reader");
    const failing = { getLatestCustomEntry: () => assert.fail("database is locked"), getRecentActiveEntries: () => [] };
    unreadable(readScope(failing, false, undefined), /^reading its smart-router\.scope entries failed: database is locked$/, "a reader that throws");
    unreadable(readScope(holding(custom({ v: 1, scope: "work" })), false, UNDER), /not one the router wrote/, "malformed, under a work directory");
    unreadable(readScope(failing, false, UNDER), /database is locked/, "a reader that throws, under a work directory");
    unreadable(readScope(undefined, false, UNDER), /no bounded session history/, "no session manager, under a work directory");
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
    readScope(manager, false, UNDER);
    assert.deepEqual(calls, [[SCOPE_ENTRY, { scope: "all" }]]);
    readScope(manager, true, UNDER);
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
  assert.equal(workDirectoryOf(APP, ["/Users/johnw/src/positronic", "/Users/johnw/src", WORK_DIRECTORY]), "/Users/johnw/src", "the first that holds it, in roster order");
  assert.equal(workDirectoryOf(APP, [ACME]), undefined);
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
      assert.deepEqual(readScope(child.session.ctx.sessionManager, false, undefined), OK_WORK_ENTRY, "without the latch, the entry keeps it in work scope");
    });
  });

  test("a personal default, quitting, reloading, resuming and an in-memory session leave no scope handoff", async (t) => {
    const dir = agentDir(t);
    const plain = await begin({ dir, id: "plain", file: "/sessions/plain.jsonl" });
    await plain.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/plain-new.jsonl" });
    assert.equal(processSlot().scopeHandoffs?.size ?? 0, 0, "a personal default");
    const child = await begin({ dir, id: "plain-new", file: "/sessions/plain-new.jsonl", runtime: new FakeRuntime() }, "new");
    assert.deepEqual([scopeEntries(child), scopeOf(child), messages(child)], [[], DEFAULT, []]);
    for (const reason of ["quit", "reload", "resume"]) {
      const loaded = await begin({ dir, id: reason, file: `/sessions/${reason}.jsonl`, runtime: new FakeRuntime(), setup: recorded("work") });
      await loaded.host.emit("session_shutdown", { reason, targetSessionFile: `/sessions/${reason}-next.jsonl` });
    }
    const memory = await begin({ dir, id: "memory", runtime: new FakeRuntime(), setup: recorded("work") });
    await memory.host.emit("session_shutdown", { reason: "new" });
    await memory.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "" });
    assert.equal(processSlot().scopeHandoffs?.size ?? 0, 0);
  });

  // A scope that cannot be read holds its session as work scope (routing resolves it there), so the
  // session a fork or /new makes from it starts there too, as a malformed pin is carried as a pin.
  for (const reason of ["new", "fork"] as const) {
    test(`an unreadable scope is carried into a ${reason === "new" ? "/new" : "fork"} as work scope`, async (t) => {
      const dir = agentDir(t);
      const parent = await begin({ dir, id: "malformed", file: "/sessions/m.jsonl", runtime: new FakeRuntime(), setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
      assert.equal(scopeOf(parent).kind, "unreadable");
      await parent.host.emit("session_shutdown", { reason, targetSessionFile: `/sessions/m-${reason}.jsonl` });
      assert.equal(processSlot().scopeHandoffs?.get(`/sessions/m-${reason}.jsonl`), "work");
      const child = await begin({ dir, id: "child", file: `/sessions/m-${reason}.jsonl`, runtime: new FakeRuntime() }, reason);
      assert.deepEqual(scopeEntries(child), [{ v: 1, scope: "work", by: "carried", at: NOW }]);
      assert.deepEqual(scopeOf(child), OK_WORK_ENTRY);
      assert.deepEqual(child.session.notices, [{ type: "info", message: scopeCarriedNotice("work") }]);
    });
  }

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

  test("a scope is handed on even when Pi's agent directory cannot be found", async (t) => {
    const build: NonNullable<LoadOptions["build"]> = (pi, options) =>
      createRouter(pi, {
        ...options,
        agentDir: () => {
          throw new Error("HOME is not set");
        },
      });
    const parent = await begin({ dir: agentDir(t), id: "parent", file: "/sessions/p.jsonl", cwd: APP, build, setup: recorded("work") });
    await parent.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/p-new.jsonl" });
    assert.equal(processSlot().scopeHandoffs?.get("/sessions/p-new.jsonl"), "work");
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

  test("a scope that cannot be recorded says so once, and the session stays in work scope while the roster lists its directory", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = load({ dir, cwd: APP, file: "/sessions/read-only.jsonl", runtime: new FakeRuntime(workCatalog()), now: () => NOW });
    loaded.host.api.appendEntry = () => {
      throw new Error("the session file is read-only");
    };
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "resume" });
    const notice = directoryFailedNotice(APP, WORK_DIRECTORY, "the session file is read-only");
    assert.equal(
      notice,
      `pi-smart-router: this session is in work scope because ${APP} is under ${WORK_DIRECTORY}, but its scope could not be recorded (the session file is read-only), so it stays in work scope only while the roster lists that directory.`,
    );
    assert.deepEqual(loaded.session.notices, [{ type: "error", message: notice }]);
    assert.deepEqual([scopeOf(loaded), readScope(loaded.session.ctx.sessionManager, false, UNDER)], [DEFAULT, OK_WORK_DIRECTORY]);
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
    await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
    await loaded.host.emit("input", { text: "and the tests", source: "interactive" });
    assert.equal(loaded.session.notices.length, 1, "it tries once per session, so it says so once");
    // The work scope the directories gave it goes with a /new into the session it creates.
    await loaded.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/read-only-new.jsonl" });
    const child = await begin({ dir, id: "child", cwd: ACME_APP, file: "/sessions/read-only-new.jsonl", runtime: new FakeRuntime(workCatalog()) }, "new");
    assert.deepEqual(scopeEntries(child), [{ v: 1, scope: "work", by: "carried", at: NOW }]);
  });
});

describe("a roster that comes to list a running session's directory", () => {
  const NOTICE = `pi-smart-router: this session is in work scope because ${ACME_APP} is under ${ACME}.`;

  test("routes in personal scope until then; after /smart-router reload the next request routes in work scope, records one entry and says so once", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await begin({ dir, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK, "a directory the roster does not list: personal scope");
    await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
    assert.deepEqual([scopeEntries(loaded), messages(loaded)], [[], []]);
    listDirectories(dir, [WORK_DIRECTORY, ACME]);
    await loaded.host.command("smart-router", "reload");
    assert.equal(directoryNotice(ACME_APP, ACME), NOTICE);
    // The roster as it is now decides at once, before anything is recorded.
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA, "work scope at once");
    assert.deepEqual(scopeEntries(loaded), [], "recorded at the next idle input");
    await loaded.host.emit("input", { text: "and the tests", source: "interactive" });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal }))), WORK_TERRA, "the next request routes in work scope");
    loaded.session.endRun();
    assert.deepEqual(scopeEntries(loaded), [{ v: 1, scope: "work", by: "directory", at: NOW }]);
    assert.equal(directoryNotices(loaded, ACME_APP, ACME), 1);
    await loaded.host.emit("input", { text: "and the docs", source: "interactive" });
    await loaded.host.emit("session_start", { reason: "reload" });
    assert.deepEqual([scopeEntries(loaded).length, directoryNotices(loaded, ACME_APP, ACME)], [1, 1], "recorded once, and said once");
    // Recorded, the scope no longer depends on the roster.
    listDirectories(dir, [WORK_DIRECTORY]);
    await loaded.host.command("smart-router", "reload");
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
  });

  test("a roster edit is picked up at the next idle input, which records the entry, whatever the selection", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await begin({ dir, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
    const physical = load({ dir, id: "physical", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()), now: () => NOW });
    physical.session.select(KIMI);
    await physical.host.emit("session_start", { reason: "startup" });
    listDirectories(dir, [WORK_DIRECTORY, ACME]);
    for (const session of [loaded, physical]) {
      await session.host.emit("input", { text: "fix the build", source: "interactive" });
      assert.deepEqual(scopeEntries(session), [{ v: 1, scope: "work", by: "directory", at: NOW }], session.session.id);
      assert.deepEqual(messages(session), [NOTICE], session.session.id);
    }
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
  });

  test("a session with a personal entry stays personal across that reload", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await begin({ dir, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()), setup: recorded("personal") });
    listDirectories(dir, [WORK_DIRECTORY, ACME]);
    await loaded.host.command("smart-router", "reload");
    await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK);
    assert.deepEqual([scopeEntries(loaded).length, scopeOf(loaded), directoryNotices(loaded, ACME_APP, ACME)], [1, OK_PERSONAL_ENTRY, 0]);
  });

  test("the latch still wins: nothing is recorded, and the scope is the latch's", async (t) => {
    await withScope("work", async () => {
      const dir = agentDir(t, { roster: HERA_V2 });
      const loaded = await begin({ dir, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      listDirectories(dir, [WORK_DIRECTORY, ACME]);
      await loaded.host.command("smart-router", "reload");
      await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
      assert.deepEqual(readScope(loaded.session.ctx.sessionManager, scopeLatched(processSlot()), { cwd: ACME_APP, directories: [ACME] }), OK_WORK_LATCH);
      assert.deepEqual([scopeEntries(loaded), directoryNotices(loaded, ACME_APP, ACME)], [[], 0]);
      assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
    });
  });
});

describe("smart-router/auto refuses a scope it cannot serve", () => {
  test("a version 1 roster with PI_SMART_ROUTER_SCOPE=work, on every path, sending nothing", async (t) => {
    await withScope("work", async () => {
      const loaded = await begin({ dir: agentDir(t) });
      // A work session's way out names only the work account's models, and a version 1 roster binds no work account.
      const refusal = scopeUnserved("auto", "work", 1, true);
      assert.equal(
        refusal.message,
        "smart-router/auto: this session is in work scope, which a version 1 roster does not serve. Nothing was sent. Give the roster a work scope (version 2).",
      );
      // The owned run: the prompt plans nothing for a scope auto refuses, and the run's first request refuses.
      await loaded.host.emit("input", { text: PLANNING, source: "interactive" });
      assert.equal(loaded.router?.record(loaded.session.id)?.plan, undefined);
      const signal = loaded.session.startRun();
      refuses(() => loaded.runtime.route("auto", request("user", { signal })), refusal, "the owned run");
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal })), refusal, "a continuation");
      loaded.session.endRun();
      refuses(() => loaded.runtime.route("auto", request("direct")), refusal, "a direct request without a plan");
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal: new AbortController().signal })), refusal, "a foreign request");
      assert.deepEqual(loaded.router?.record(loaded.session.id)?.history, [], "no request reached a model");
    });
  });

  test("pinned too: the scope's refusal comes before the pin, so a pinned, latched version 1 session refuses smart-router/auto, and smart-router/local still routes", async (t) => {
    await withScope("work", async () => {
      const loaded = await begin({ dir: agentDir(t), setup: (session) => session.pin(policyFromRoster(rosterFixture("roster-hera.json"))) });
      const refusal = scopeUnserved("auto", "work", 1);
      refuses(() => loaded.runtime.route("auto", request("direct")), refusal, "a direct request");
      const signal = loaded.session.startRun();
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal })), refusal, "the owned run");
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal: new AbortController().signal })), refusal, "a foreign request");
      assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal }))), GLM, "smart-router/local, the pinned session's own route");
      loaded.session.endRun();
      assert.equal(routed(loaded.runtime.route("local", request("direct"))), GLM);
      assert.deepEqual(
        loaded.router?.record(loaded.session.id)?.history.map((entry) => [entry.virtual, entry.ref]),
        [
          ["local", GLM],
          ["local", GLM],
        ],
        "only the local requests reached a model",
      );
    });
  });

  test("an unreadable scope, which routing resolves in work scope, the narrower one", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const malformed = await begin({ dir, id: "malformed", runtime: new FakeRuntime(workCatalog()), setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 1, scope: "work" }) });
    // A scope that cannot be read counts as work scope, so only a work Codex model is offered.
    const unreadable = scopeUnreadable("auto", "the latest smart-router.scope entry is not one the router wrote", true);
    assert.equal(
      unreadable.message,
      "smart-router/auto: this session's scope cannot be read (the latest smart-router.scope entry is not one the router wrote). Nothing was sent. Record it again with /smart-router scope work or /smart-router scope personal, or choose a work Codex model with /model.",
    );
    refuses(() => malformed.runtime.route("auto", request("direct")), unreadable, "a malformed entry");
    const signal = malformed.session.startRun();
    refuses(() => malformed.runtime.route("auto", request("continuation", { signal })), unreadable, "the owned run");
    malformed.session.endRun();
    // smart-router/local refuses no scope, so without the pin it routes to the LAN model here too.
    assert.equal(routed(malformed.runtime.route("local", request("direct"))), GLM, "smart-router/local");
    // pi-cache-optimizer is told of no pick on smart-router/auto, which refuses this scope, and of smart-router/local's.
    assert.equal(malformed.router?.activeRoute("auto"), undefined);
    assert.equal(malformed.router?.activeRoute("local")?.modelId, "GLM-5.3-Flash-oQ4e-mtp");
    const personal = await begin({ dir, id: "personal", runtime: new FakeRuntime(workCatalog()) });
    assert.equal(personal.router?.activeRoute("auto")?.modelId, "deepseek/deepseek-v4.1-flash-1017");

    const locked = await begin({ dir, id: "locked", runtime: new FakeRuntime(workCatalog()) });
    const manager = locked.session.ctx.sessionManager as unknown as Record<string, unknown>;
    const latest = manager.getLatestCustomEntry as (customType: string, options?: unknown) => unknown;
    manager.getLatestCustomEntry = (customType: string, options?: unknown) => {
      if (customType === SCOPE_ENTRY) throw new Error("database is locked");
      return latest(customType, options);
    };
    refuses(() => locked.runtime.route("auto", request("direct")), scopeUnreadable("auto", "reading its smart-router.scope entries failed: database is locked", true), "a reader that throws");
    assert.equal(routed(locked.runtime.route("local", request("direct"))), GLM, "smart-router/local, with a reader that throws");
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
      refuses(() => latched.runtime.route("auto", request("direct")), scopeUnserved("auto", "work", 2, true), "a personal-only roster in work scope");
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

describe("smart-router/local in work scope", () => {
  // Selecting smart-router/local is itself the request for local routing, so work scope needs no
  // pin for it (John's decision of 2026-11-16, "Let smart-router/local route in work scope"). The
  // selection is John's, and the router changes none.
  const policy = policyFromRoster(rosterFixture("roster-hera.json"));
  const localHistory = (loaded: Loaded): unknown[] => (loaded.router?.record(loaded.session.id)?.history ?? []).map((entry) => [entry.virtual, entry.reason, entry.role, entry.ref]);

  test("without the pin it routes every request to the LAN model, plans the run and tells pi-cache-optimizer of the pick; the selection stays and nothing pins the session", async (t) => {
    const loaded = await begin({ dir: agentDir(t, { roster: HERA_V2 }), runtime: new FakeRuntime(workCatalog()), setup: recorded("work") });
    await loaded.host.choose("smart-router/local");
    assert.deepEqual(scopeOf(loaded), OK_WORK_ENTRY);
    assert.deepEqual(await loaded.host.emit("input", { text: PLANNING, source: "interactive" }), [undefined], "the prompt itself is passed on");
    const plan = loaded.router?.record(loaded.session.id)?.plan;
    assert.deepEqual([plan?.virtualId, plan?.localOnly, plan?.decision.ok && plan.decision.choice.ref], ["local", true, GLM], "the run is planned on the local role");
    assert.equal(loaded.router?.activeRoute("local")?.modelId, "GLM-5.3-Flash-oQ4e-mtp");
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM, "the owned run");
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal }))), GLM, "a continuation");
    loaded.session.endRun();
    assert.equal(routed(loaded.runtime.route("local", request("direct"))), GLM, "a compaction or summary");
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal: new AbortController().signal }))), GLM, "a foreign request");
    assert.deepEqual(
      localHistory(loaded),
      [
        ["local", "user", "local", GLM],
        ["local", "continuation", "local", GLM],
        ["local", "direct", "local", GLM],
        ["local", "continuation", "local", GLM],
      ],
      "every request went to the local role",
    );
    assert.equal(loaded.session.model?.id, "local", "the selection is left as it is");
    assert.deepEqual(loaded.session.entries.filter((entry) => entry.customType === PIN_ENTRY), [], "no pin is recorded");
    assert.deepEqual(messages(loaded), [], "and nothing is said");
    // smart-router/auto, in the same session, still routes only to the work account.
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
  });

  test("without the pin it never leaves the local role: with no local model it refuses, and offers the work account's models", async (t) => {
    const cloudOnly = new FakeCatalog([...heraModels().filter((entry) => `${entry.provider}/${entry.id}` !== GLM), codex(WORK_TERRA), codex(NATIVE_TERRA)]);
    const loaded = await begin({ dir: agentDir(t, { roster: HERA_V2 }), runtime: new FakeRuntime(cloudOnly), setup: recorded("work") });
    await loaded.host.choose("smart-router/local");
    const expected = new Error(
      `smart-router/local: no local model can take this request (local: ${GLM}: not in the catalog). Nothing was sent. Start the local model server and send the prompt again, or choose smart-router/auto or a work Codex model with /model.`,
    );
    const signal = loaded.session.startRun();
    refuses(() => loaded.runtime.route("local", request("user", { signal })), expected, "the owned run");
    loaded.session.endRun();
    refuses(() => loaded.runtime.route("local", request("direct")), expected, "a compaction or summary");
    assert.deepEqual(loaded.router?.record(loaded.session.id)?.history, [], "no request reached a model");
  });

  test("under a roster that serves no work scope it routes the same: version 1 under the latch, and a personal-only version 2", async (t) => {
    const v2 = JSON.parse(HERA_V2);
    delete v2.scopes.work;
    v2.roles = v2.roles.filter((role: { name: string }) => !role.name.startsWith("work-"));
    delete v2.accounts["openai-codex-3"];
    await withScope("work", async () => {
      const v1 = await begin({ dir: agentDir(t), id: "v1" });
      await v1.host.choose("smart-router/local");
      const signal = v1.session.startRun();
      assert.equal(routed(v1.runtime.route("local", request("user", { signal }))), GLM, "a version 1 roster, the owned run");
      v1.session.endRun();
      assert.equal(routed(v1.runtime.route("local", request("direct"))), GLM, "a version 1 roster, a direct request");
      refuses(() => v1.runtime.route("auto", request("direct")), scopeUnserved("auto", "work", 1, true), "smart-router/auto still refuses the scope");
      const personalOnly = await begin({ dir: agentDir(t, { roster: JSON.stringify(v2) }), id: "personal-only", runtime: new FakeRuntime(workCatalog()) });
      assert.equal(routed(personalOnly.runtime.route("local", request("direct"))), GLM, "a version 2 roster without a work scope");
      refuses(() => personalOnly.runtime.route("auto", request("direct")), scopeUnserved("auto", "work", 2, true), "smart-router/auto still refuses the scope");
    });
  });

  test("under the pin it routes to the LAN model, by an entry or under the latch; in personal scope it routes as before", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const pinned = await begin({ dir, id: "pinned", runtime: new FakeRuntime(workCatalog()), setup: (session) => {
      recorded("work")(session);
      session.pin(policy);
    } });
    assert.equal(routed(pinned.runtime.route("local", request("direct"))), GLM);
    assert.equal(pinned.router?.activeRoute("local")?.modelId, "GLM-5.3-Flash-oQ4e-mtp");
    const personal = await begin({ dir, id: "personal", runtime: new FakeRuntime(workCatalog()) });
    assert.equal(routed(personal.runtime.route("local", request("direct"))), GLM);
    await withScope("work", async () => {
      const latched = await begin({ dir, id: "latched", runtime: new FakeRuntime(workCatalog()), setup: (session) => session.pin(policy) });
      assert.equal(routed(latched.runtime.route("local", request("direct"))), GLM);
    });
  });
});

describe("smart-router/local in a scope that cannot be read", () => {
  // Selecting smart-router/local means local routing in every scope state, so it refuses no scope,
  // one that cannot be read included (John's decision of 2026-11-17, "Let local route there too").
  // Its requests carry no account, and the run resolves in work scope, the narrower one.
  const REASON = "the latest smart-router.scope entry is not one the router wrote";
  const malformed = (session: FakeSession): void => session.appendCustom(SCOPE_ENTRY, { v: 9 });
  const scopeEntries = (loaded: Loaded): unknown[] => loaded.session.entries.filter((entry) => entry.customType === SCOPE_ENTRY).map((entry) => entry.data);

  test("without the pin it routes every request to the LAN model, plans the run and tells pi-cache-optimizer of the pick; nothing pins the session or records a scope, and smart-router/auto still refuses", async (t) => {
    const loaded = await begin({ dir: agentDir(t, { roster: HERA_V2 }), runtime: new FakeRuntime(workCatalog()), setup: malformed });
    await loaded.host.choose("smart-router/local");
    assert.deepEqual(scopeOf(loaded), { kind: "unreadable", reason: REASON });
    assert.deepEqual(await loaded.host.emit("input", { text: PLANNING, source: "interactive" }), [undefined], "the prompt itself is passed on");
    const plan = loaded.router?.record(loaded.session.id)?.plan;
    assert.deepEqual([plan?.virtualId, plan?.localOnly, plan?.level, plan?.decision.ok && plan.decision.choice.ref], ["local", true, undefined, GLM], "the run is planned on the local role, with no level");
    assert.deepEqual(loaded.router?.activeRoute("local"), { provider: "omlx-hera", modelId: "GLM-5.3-Flash-oQ4e-mtp", api: plan?.decision.ok ? plan.decision.choice.model.api : undefined, status: "planned", at: NOW });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM, "the owned run");
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal }))), GLM, "a continuation");
    loaded.session.endRun();
    assert.equal(routed(loaded.runtime.route("local", request("direct"))), GLM, "a compaction or summary");
    assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal: new AbortController().signal }))), GLM, "a foreign request");
    assert.deepEqual(
      (loaded.router?.record(loaded.session.id)?.history ?? []).map((entry) => [entry.virtual, entry.reason, entry.role, entry.ref, entry.code]),
      [
        ["local", "user", "local", GLM, plan?.code],
        ["local", "continuation", "local", GLM, "stick:run"],
        ["local", "direct", "local", GLM, "direct:default"],
        ["local", "continuation", "local", GLM, "foreign:default"],
      ],
      "every request went to the local role, and the run's first took its plan",
    );
    assert.equal(loaded.session.model?.id, "local", "the selection is left as it is");
    assert.deepEqual(loaded.session.entries.filter((entry) => entry.customType === PIN_ENTRY), [], "no pin is recorded");
    assert.deepEqual(scopeEntries(loaded), [{ v: 9 }], "no scope is recorded");
    assert.deepEqual(scopeOf(loaded), { kind: "unreadable", reason: REASON }, "the scope still cannot be read");
    assert.deepEqual(messages(loaded), [], "and nothing is said");
    // smart-router/auto, in the same session, still refuses: it cannot tell which account to use.
    refuses(() => loaded.runtime.route("auto", request("direct")), scopeUnreadable("auto", REASON, true), "smart-router/auto");
    assert.equal(loaded.router?.activeRoute("auto"), undefined);
  });

  test("without the pin it never leaves the local role: with no local model it refuses rather than fall back, and nothing is sent", async (t) => {
    const cloudOnly = new FakeCatalog([...heraModels().filter((entry) => `${entry.provider}/${entry.id}` !== GLM), codex(WORK_TERRA), codex(NATIVE_TERRA)]);
    const loaded = await begin({ dir: agentDir(t, { roster: HERA_V2 }), runtime: new FakeRuntime(cloudOnly), setup: malformed });
    await loaded.host.choose("smart-router/local");
    const expected = /^smart-router\/local: no local model can take this request \(local: omlx-hera\/GLM-5\.3-Flash-oQ4e-mtp: not in the catalog\)\. Nothing was sent\. Start the local model server and send the prompt again, or /;
    const signal = loaded.session.startRun();
    assert.throws(() => loaded.runtime.route("local", request("user", { signal })), { message: expected }, "the owned run");
    loaded.session.endRun();
    assert.throws(() => loaded.runtime.route("local", request("direct")), { message: expected }, "a compaction or summary");
    assert.equal(loaded.router?.activeRoute("local"), undefined, "pi-cache-optimizer is told of no pick");
    assert.deepEqual(loaded.router?.record(loaded.session.id)?.history, [], "no request reached a model");
  });

  test("it routes the same whatever the roster serves and however the scope fails to read: a version 1 roster, a personal-only version 2, and a reader that throws", async (t) => {
    const v1 = await begin({ dir: agentDir(t), id: "v1", setup: malformed });
    await v1.host.choose("smart-router/local");
    const signal = v1.session.startRun();
    assert.equal(routed(v1.runtime.route("local", request("user", { signal }))), GLM, "a version 1 roster, the owned run");
    v1.session.endRun();
    assert.equal(routed(v1.runtime.route("local", request("direct"))), GLM, "a version 1 roster, a direct request");
    refuses(() => v1.runtime.route("auto", request("direct")), scopeUnreadable("auto", REASON, true), "smart-router/auto still refuses the scope");
    const v2 = JSON.parse(HERA_V2);
    delete v2.scopes.work;
    v2.roles = v2.roles.filter((role: { name: string }) => !role.name.startsWith("work-"));
    delete v2.accounts["openai-codex-3"];
    const personalOnly = await begin({ dir: agentDir(t, { roster: JSON.stringify(v2) }), id: "personal-only", runtime: new FakeRuntime(workCatalog()), setup: malformed });
    assert.equal(routed(personalOnly.runtime.route("local", request("direct"))), GLM, "a version 2 roster without a work scope");
    const locked = await begin({ dir: agentDir(t, { roster: HERA_V2 }), id: "locked", runtime: new FakeRuntime(workCatalog()) });
    await locked.host.choose("smart-router/local");
    const manager = locked.session.ctx.sessionManager as unknown as Record<string, unknown>;
    const latest = manager.getLatestCustomEntry as (customType: string, options?: unknown) => unknown;
    manager.getLatestCustomEntry = (customType: string, options?: unknown) => {
      if (customType === SCOPE_ENTRY) throw new Error("database is locked");
      return latest(customType, options);
    };
    assert.deepEqual(await locked.host.emit("input", { text: PLANNING, source: "interactive" }), [undefined]);
    assert.equal(locked.router?.record(locked.session.id)?.plan?.localOnly, true, "the run is planned");
    const run = locked.session.startRun();
    assert.equal(routed(locked.runtime.route("local", request("user", { signal: run }))), GLM, "a reader that throws, the owned run");
    locked.session.endRun();
    assert.deepEqual(messages(locked), [], "and no handler failed");
  });

  test("under the pin it routes as before", async (t) => {
    const loaded = await begin({
      dir: agentDir(t, { roster: HERA_V2 }),
      runtime: new FakeRuntime(workCatalog()),
      setup: (session) => {
        malformed(session);
        session.pin(policyFromRoster(rosterFixture("roster-hera.json")));
      },
    });
    assert.equal(routed(loaded.runtime.route("local", request("direct"))), GLM);
    assert.equal(loaded.router?.activeRoute("local")?.modelId, "GLM-5.3-Flash-oQ4e-mtp");
  });
});

describe("while the roster fails to load, the scope keeps the last valid roster's work directories", () => {
  /** A session whose scope entry cannot be written, so that its scope rests on the work directories. */
  async function unrecorded(options: LoadOptions): Promise<Loaded> {
    const loaded = load({ now: () => NOW, ...options });
    loaded.host.api.appendEntry = () => {
      throw new Error("the session file is read-only");
    };
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "startup" });
    return loaded;
  }
  const scopeAnswer = async (loaded: Loaded): Promise<string | undefined> => {
    await loaded.host.command("smart-router", "scope");
    return loaded.session.notices.at(-1)?.message;
  };

  test("in this instance, and in one built later in the process, as /reload builds one", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await unrecorded({ dir, cwd: APP });
    writeFileSync(join(dir, "smart-router.json"), "{ nope");
    await loaded.host.command("smart-router", "reload");
    assert.equal(await scopeAnswer(loaded), "pi-smart-router: scope work (directory).", "still in work scope by its directory");
    const rebuilt = await unrecorded({ dir, id: "rebuilt", cwd: APP, runtime: new FakeRuntime() });
    assert.equal(await scopeAnswer(rebuilt), "pi-smart-router: scope work (directory).", "an instance that never saw a valid roster reads the process's memory");
    // A session outside those directories is personal, as before the roster broke.
    const outside = await unrecorded({ dir, id: "outside", cwd: ACME_APP, runtime: new FakeRuntime() });
    assert.equal(await scopeAnswer(outside), "pi-smart-router: scope personal (default).");
  });

  test("an instance that reads its own older roster again leaves in the slot the one loaded last in the process", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const older = await start({ dir, id: "older", now: () => NOW });
    // A later instance loads an edited roster, which lists the directory its session works in.
    listDirectories(dir, [ACME]);
    const newer = await unrecorded({ dir, id: "newer", cwd: ACME_APP, runtime: new FakeRuntime() });
    assert.equal(await scopeAnswer(newer), "pi-smart-router: scope work (directory).");
    // The older instance routes by the roster it holds, which is no new load.
    assert.equal(routed(older.runtime.route("auto", request("direct"))), DEEPSEEK);
    writeFileSync(join(dir, "smart-router.json"), "{ nope");
    await newer.host.command("smart-router", "reload");
    assert.equal(await scopeAnswer(newer), "pi-smart-router: scope work (directory).", "the directory the last roster loaded lists");
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

describe("/smart-router status", () => {
  /** The lines of the session's status, and the lines that name its scope. */
  const scopeLines = async (loaded: Loaded): Promise<string[]> => {
    await loaded.host.command("smart-router", "status");
    return (loaded.session.notices.at(-1)?.message ?? "").split("\n").filter((line) => line.startsWith("Scope:"));
  };

  test("says when smart-router/auto refuses the session's scope: a scope that cannot be read, and a latched process whose roster has no work scope", async (t) => {
    const malformed = await begin({ dir: agentDir(t, { roster: HERA_V2 }), id: "malformed", setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    assert.deepEqual(await scopeLines(malformed), [
      "Scope: unreadable (the latest smart-router.scope entry is not one the router wrote), so smart-router/auto refuses every request until /smart-router scope work or /smart-router scope personal records it again.",
    ]);
    const v1Malformed = await begin({ dir: agentDir(t), id: "v1-malformed", setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    assert.equal((await scopeLines(v1Malformed)).length, 1, "a version 1 roster refuses it too");
    // A version 1 roster serves personal scope, and its status stays as it was.
    const plain = await begin({ dir: agentDir(t), id: "plain" });
    assert.deepEqual(await scopeLines(plain), []);
    // The latch holds for the rest of the process.
    await withScope("work", async () => {
      const v1 = await begin({ dir: agentDir(t), id: "v1" });
      assert.deepEqual(await scopeLines(v1), ["Scope: work (latch), which a version 1 roster does not serve, so smart-router/auto refuses every request."]);
      const v2 = JSON.parse(HERA_V2);
      delete v2.scopes.work;
      v2.roles = v2.roles.filter((role: { name: string }) => !role.name.startsWith("work-"));
      delete v2.accounts["openai-codex-3"];
      const personalOnly = await begin({ dir: agentDir(t, { roster: JSON.stringify(v2) }), id: "personal-only" });
      assert.deepEqual(await scopeLines(personalOnly), ["Scope: work (latch), which the roster does not serve, so smart-router/auto refuses every request."]);
      const served = await begin({ dir: agentDir(t, { roster: HERA_V2 }), id: "served", runtime: new FakeRuntime(workCatalog()) });
      assert.deepEqual(await scopeLines(served), ["Scope: work (latch)"]);
    });
  });
});

describe("in work scope, a refusal names only the models that keep the conversation on the work account", () => {
  /** The text a request's refusal carries. */
  const refusalOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return assert.fail("the request was routed");
  };

  test("a roster that fails to load: a work Codex model on smart-router/auto, and smart-router/auto too on smart-router/local; under the pin and in personal scope, any model", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const work = await begin({ dir, id: "work", runtime: new FakeRuntime(workCatalog()), setup: recorded("work") });
    const personal = await begin({ dir, id: "personal", runtime: new FakeRuntime(workCatalog()) });
    const pinned = await begin({ dir, id: "pinned", runtime: new FakeRuntime(workCatalog()), setup: (session) => {
      recorded("work")(session);
      session.pin(policyFromRoster(rosterFixture("roster-hera.json")));
    } });
    const path = join(dir, "smart-router.json");
    writeFileSync(path, "{ nope");
    for (const loaded of [work, personal, pinned]) await loaded.host.command("smart-router", "reload");
    const auto = refusalOf(() => work.runtime.route("auto", request("direct")));
    assert.match(auto, /^smart-router\/auto: the roster .*smart-router\.json is invalid \(JSON syntax error/);
    assert.ok(auto.endsWith("Nothing was sent. Fix it and send the prompt again, or choose a work Codex model with /model."), auto);
    assert.ok(refusalOf(() => work.runtime.route("local", request("direct"))).endsWith("Fix it and send the prompt again, or choose smart-router/auto or a work Codex model with /model."));
    for (const loaded of [personal, pinned]) {
      assert.ok(refusalOf(() => loaded.runtime.route("auto", request("direct"))).endsWith("Fix it and send the prompt again, or choose a model with /model."), loaded.session.id);
    }
  });

  test("a scope that cannot be read, under the pin: the pin's rules apply, so any model", async (t) => {
    const loaded = await begin({
      dir: agentDir(t, { roster: HERA_V2 }),
      runtime: new FakeRuntime(workCatalog()),
      setup: (session) => {
        session.appendCustom(SCOPE_ENTRY, { v: 9 });
        session.pin(policyFromRoster(rosterFixture("roster-hera.json")));
      },
    });
    refuses(() => loaded.runtime.route("auto", request("direct")), scopeUnreadable("auto", "the latest smart-router.scope entry is not one the router wrote"), "pinned");
    assert.match(refusalOf(() => loaded.runtime.route("auto", request("direct"))), /, or choose a model with \/model\.$/);
  });

  test("a roster that serves no work scope: outside the latch, /smart-router scope personal is a way out too", async (t) => {
    const v1 = await begin({ dir: agentDir(t), id: "v1", setup: recorded("work") });
    assert.equal(
      refusalOf(() => v1.runtime.route("auto", request("direct"))),
      "smart-router/auto: this session is in work scope, which a version 1 roster does not serve. Nothing was sent. Give the roster a work scope (version 2), or run /smart-router scope personal.",
    );
    const roster = JSON.parse(HERA_V2);
    delete roster.scopes.work;
    roster.roles = roster.roles.filter((role: { name: string }) => !role.name.startsWith("work-"));
    delete roster.accounts["openai-codex-3"];
    const v2 = await begin({ dir: agentDir(t, { roster: JSON.stringify(roster) }), id: "v2", setup: recorded("work") });
    assert.equal(
      refusalOf(() => v2.runtime.route("auto", request("direct"))),
      "smart-router/auto: this session is in work scope, which the roster does not serve. Nothing was sent. Give the roster a work scope, run /smart-router scope personal, or choose a work Codex model with /model.",
    );
  });

  test("no work model available: the refusal lists the tier and offers a work Codex model", async (t) => {
    const loaded = await begin({ dir: agentDir(t, { roster: HERA_V2 }), runtime: new FakeRuntime(), setup: recorded("work") });
    assert.equal(
      refusalOf(() => loaded.runtime.route("auto", request("direct"))),
      `smart-router/auto: no model can take this request (work-medium: ${WORK_TERRA}: not in the catalog). Nothing was sent. See /smart-router status, or choose a work Codex model with /model.`,
    );
  });
});
