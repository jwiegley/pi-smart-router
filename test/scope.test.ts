import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import { ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY, SCOPE_ENTRY } from "../src/constants.ts";
import { directoryFailedNotice, directoryNotice, scopeCarriedNotice, scopeCarryFailedNotice, scopeSelectedNotice, scopeUnreadable, scopeUnserved } from "../src/errors.ts";
import { processSlot, rememberedRoster, scopeLatched } from "../src/owners.ts";
import { createRouter } from "../src/router.ts";
import { BUILT_IN_DEFAULT, fromHostDefault, parseScopeEntry, readScope, scopeEntry, underDirectory, workDirectoryOf } from "../src/scope.ts";
import type { HostDefault, ScopeEntryData, ScopeState, WorkDirectories } from "../src/scope.ts";
import { CHATGPT, DEEPSEEK, FakeCatalog, GLM, heraModels, KIMI, model, NOW, SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { PIN_ENTRY } from "./support/legacy.ts";
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

test("the names: the scope's entry and switch, the level's entry, and a status item of its own", () => {
  assert.deepEqual([SCOPE_ENTRY, ENV_SCOPE, LEVEL_ENTRY, LEVEL_KEY], ["smart-router.scope", "PI_SMART_ROUTER_SCOPE", "smart-router.level", "smart-router-level"]);
  assert.notEqual(LEVEL_KEY, "smart-router", "never the key the removed pin's item used, which an earlier version may still set");
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
    assert.equal(processSlot().handoffs.size, 0, "the map the removed pin used stays empty");
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
  // session a fork or /new makes from it starts there too.
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

  test("a work session with an earlier version's pin entry hands on its scope, and nothing of the pin", async (t) => {
    const dir = agentDir(t);
    const pinned = await begin({
      dir,
      id: "pinned",
      file: "/sessions/pinned.jsonl",
      setup: (session) => {
        session.appendCustom(PIN_ENTRY, { v: 1, on: true, at: AT, local: { refs: [GLM], providers: ["omlx-hera"], hosts: ["hera.lan"] } });
        recorded("work")(session);
      },
    });
    await pinned.host.emit("session_shutdown", { reason: "new", targetSessionFile: "/sessions/pinned-new.jsonl" });
    assert.deepEqual([processSlot().handoffs.size, processSlot().scopeHandoffs?.size], [0, 1], "only the scope is handed on");
    assert.deepEqual(processSlot().scopeHandoffs?.get("/sessions/pinned-new.jsonl"), "work");
    const child = await begin({ dir, id: "child", file: "/sessions/pinned-new.jsonl", runtime: new FakeRuntime() }, "new");
    assert.deepEqual(scopeEntries(child), [{ v: 1, scope: "work", by: "carried", at: NOW }], "the scope is carried");
    assert.deepEqual(child.session.entries.filter((entry) => entry.customType === PIN_ENTRY), [], "no pin entry is written in the new session");
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

  test("smart-router/local still routes in a latched version 1 session whose smart-router/auto refuses, on every path", async (t) => {
    await withScope("work", async () => {
      const loaded = await begin({ dir: agentDir(t) });
      const refusal = scopeUnserved("auto", "work", 1, true);
      refuses(() => loaded.runtime.route("auto", request("direct")), refusal, "a direct request");
      const signal = loaded.session.startRun();
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal })), refusal, "the owned run");
      refuses(() => loaded.runtime.route("auto", request("continuation", { signal: new AbortController().signal })), refusal, "a foreign request");
      assert.equal(routed(loaded.runtime.route("local", request("continuation", { signal }))), GLM, "smart-router/local, on the same run's signal");
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
    // smart-router/local refuses no scope, so it routes to the LAN model here too.
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
  // Selecting smart-router/local is itself the request for local routing, so it routes in work scope
  // too (John's decision of 2026-11-16, "Let smart-router/local route in work scope"). The selection
  // is John's, and the router changes none.
  const localHistory = (loaded: Loaded): unknown[] => (loaded.router?.record(loaded.session.id)?.history ?? []).map((entry) => [entry.virtual, entry.reason, entry.role, entry.ref]);

  test("it routes every request to the LAN model, plans the run and tells pi-cache-optimizer of the pick; the selection stays and nothing is recorded", async (t) => {
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
    assert.deepEqual(loaded.session.entries.filter((entry) => entry.customType === PIN_ENTRY), [], "no pin entry is written");
    assert.deepEqual(messages(loaded), [], "and nothing is said");
    // smart-router/auto, in the same session, still routes only to the work account.
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
  });

  test("it never leaves the local role: with no local model it refuses, and offers the work account's models", async (t) => {
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

});

describe("smart-router/local in a scope that cannot be read", () => {
  // Selecting smart-router/local means local routing in every scope state, so it refuses no scope,
  // one that cannot be read included (John's decision of 2026-11-17, "Let local route there too").
  // Its requests carry no account, and the run resolves in work scope, the narrower one.
  const REASON = "the latest smart-router.scope entry is not one the router wrote";
  const malformed = (session: FakeSession): void => session.appendCustom(SCOPE_ENTRY, { v: 9 });
  const scopeEntries = (loaded: Loaded): unknown[] => loaded.session.entries.filter((entry) => entry.customType === SCOPE_ENTRY).map((entry) => entry.data);

  test("it routes every request to the LAN model, plans the run and tells pi-cache-optimizer of the pick; nothing records a scope, and smart-router/auto still refuses", async (t) => {
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
    assert.deepEqual(loaded.session.entries.filter((entry) => entry.customType === PIN_ENTRY), [], "no pin entry is written");
    assert.deepEqual(scopeEntries(loaded), [{ v: 9 }], "no scope is recorded");
    assert.deepEqual(scopeOf(loaded), { kind: "unreadable", reason: REASON }, "the scope still cannot be read");
    assert.deepEqual(messages(loaded), [], "and nothing is said");
    // smart-router/auto, in the same session, still refuses: it cannot tell which account to use.
    refuses(() => loaded.runtime.route("auto", request("direct")), scopeUnreadable("auto", REASON, true), "smart-router/auto");
    assert.equal(loaded.router?.activeRoute("auto"), undefined);
  });

  test("it never leaves the local role: with no local model it refuses rather than fall back, and nothing is sent", async (t) => {
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

  test("a roster that fails to load: a work Codex model on smart-router/auto, and smart-router/auto too on smart-router/local; in personal scope, any model", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const work = await begin({ dir, id: "work", runtime: new FakeRuntime(workCatalog()), setup: recorded("work") });
    const personal = await begin({ dir, id: "personal", runtime: new FakeRuntime(workCatalog()) });
    const path = join(dir, "smart-router.json");
    writeFileSync(path, "{ nope");
    for (const loaded of [work, personal]) await loaded.host.command("smart-router", "reload");
    const auto = refusalOf(() => work.runtime.route("auto", request("direct")));
    assert.match(auto, /^smart-router\/auto: the roster .*smart-router\.json is invalid \(JSON syntax error/);
    assert.ok(auto.endsWith("Nothing was sent. Fix it and send the prompt again, or choose a work Codex model with /model."), auto);
    assert.ok(refusalOf(() => work.runtime.route("local", request("direct"))).endsWith("Fix it and send the prompt again, or choose smart-router/auto or a work Codex model with /model."));
    assert.ok(refusalOf(() => personal.runtime.route("auto", request("direct"))).endsWith("Fix it and send the prompt again, or choose a model with /model."), personal.session.id);
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

describe("the host's default scope (rule 4)", () => {
  const ROSTER_WORK: HostDefault = { kind: "roster", scope: "work" };
  const ROSTER_PERSONAL: HostDefault = { kind: "roster", scope: "personal" };
  const UNKNOWN: HostDefault = { kind: "unknown", reason: "the host's default scope is unknown: for this test" };
  const OK_WORK_DEFAULT: ScopeState = { kind: "ok", scope: "work", source: "roster-default" };
  const OK_PERSONAL_DEFAULT: ScopeState = { kind: "ok", scope: "personal", source: "roster-default" };
  const UNKNOWN_STATE: ScopeState = { kind: "unreadable", reason: "the host's default scope is unknown: for this test", fromDefault: true };
  /** The answer /smart-router scope gives a session whose default is the roster's work scope. */
  const SCOPE_WORK_DEFAULT = "pi-smart-router: scope work (roster-default: this host's defaultScope in the roster).";

  /** Hera's version 2 roster with this defaultScope, or none. */
  const withDefault = (scope: "personal" | "work" | undefined, base: string = HERA_V2): string => {
    const roster = JSON.parse(base);
    if (scope === undefined) delete roster.defaultScope;
    else roster.defaultScope = scope;
    return JSON.stringify(roster);
  };

  /** Rewrite the roster with a later modification time, so the next load reads it. */
  const rewrite = (dir: string, text: string): void => {
    const path = join(dir, "smart-router.json");
    writeFileSync(path, text);
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
  };

  const scopeAnswer = async (loaded: Loaded): Promise<string | undefined> => {
    await loaded.host.command("smart-router", "scope");
    return loaded.session.notices.at(-1)?.message;
  };

  /** A whole run on smart-router/auto: its input, the run's start, its first request, its answer and its end. */
  async function run(loaded: Loaded, text: string): Promise<string> {
    await loaded.host.emit("input", { text, source: "interactive" });
    await loaded.host.emit("before_agent_start", { prompt: text });
    const signal = loaded.session.startRun();
    const ref = routed(loaded.runtime.route("auto", request("user", { signal })));
    await loaded.host.emit("message_end", { message: assistant(ref) });
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    return ref;
  }

  describe("readScope", () => {
    test("a session with no entry, under no work directory, takes the default: built in, the roster's, or unreadable when unknown", () => {
      assert.deepEqual(readScope(holding(undefined), false, undefined), DEFAULT, "no default passed: the built-in personal one");
      assert.deepEqual(readScope(holding(undefined), false, undefined, BUILT_IN_DEFAULT), DEFAULT);
      assert.deepEqual(readScope(holding(null), false, OUTSIDE, ROSTER_WORK), OK_WORK_DEFAULT);
      assert.deepEqual(readScope(holding(undefined), false, undefined, ROSTER_PERSONAL), OK_PERSONAL_DEFAULT, "a personal default the roster sets is the roster's");
      assert.deepEqual(readScope(holding(undefined), false, OUTSIDE, UNKNOWN), UNKNOWN_STATE);
    });

    test("the latch, an entry and the work directories all win over it, and an unreadable entry stays the entry's", () => {
      for (const host of [ROSTER_WORK, ROSTER_PERSONAL, UNKNOWN]) {
        const label = JSON.stringify(host);
        assert.deepEqual(readScope(holding(custom(scopeEntry("personal", "command", NOW))), true, undefined, host), OK_WORK_LATCH, label);
        assert.deepEqual(readScope(holding(undefined), true, OUTSIDE, host), OK_WORK_LATCH, label);
        assert.deepEqual(readScope(holding(custom(scopeEntry("personal", "command", NOW))), false, OUTSIDE, host), OK_PERSONAL_ENTRY, label);
        assert.deepEqual(readScope(holding(custom(scopeEntry("work", "carried", NOW))), false, OUTSIDE, host), OK_WORK_ENTRY, label);
        assert.deepEqual(readScope(holding(undefined), false, UNDER, host), OK_WORK_DIRECTORY, label);
        assert.deepEqual(readScope(holding(custom({ v: 9 })), false, OUTSIDE, host), { kind: "unreadable", reason: "the latest smart-router.scope entry is not one the router wrote" }, label);
      }
    });

    test("fromHostDefault marks what rule 4 gave, readable or not, and nothing else", () => {
      assert.deepEqual(
        [DEFAULT, OK_WORK_DEFAULT, OK_PERSONAL_DEFAULT, UNKNOWN_STATE, OK_WORK_LATCH, OK_WORK_ENTRY, OK_WORK_DIRECTORY, { kind: "unreadable", reason: "x" } as ScopeState].map(fromHostDefault),
        [true, true, true, true, false, false, false, false],
      );
    });
  });

  test("without defaultScope, a session outside the work directories is personal by the built-in default, as before", async (t) => {
    const loaded = await begin({ dir: agentDir(t, { roster: HERA_V2 }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
    assert.equal(await scopeAnswer(loaded), "pi-smart-router: scope personal (default).");
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK);
  });

  test("defaultScope work: a session with no entry is in work scope by the roster's default, routes there, and is told nothing", async (t) => {
    const loaded = await begin({ dir: agentDir(t, { roster: withDefault("work") }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
    assert.equal(await scopeAnswer(loaded), SCOPE_WORK_DEFAULT);
    assert.deepEqual(readScope(loaded.session.ctx.sessionManager, false, undefined, ROSTER_WORK), OK_WORK_DEFAULT);
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA);
    assert.deepEqual(messages(loaded).slice(0, -1), [], "nothing is said at session start");
  });

  test("the default records nothing: not at session start, at an idle input, at a run's start or after a run, at any kind of start", async (t) => {
    const dir = agentDir(t, { roster: withDefault("work") });
    for (const reason of ["startup", "new", "fork", "reload", "resume"]) {
      const loaded = await begin({ dir, id: reason, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) }, reason);
      assert.deepEqual(scopeEntries(loaded), [], `${reason}: session start`);
      await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
      assert.deepEqual(scopeEntries(loaded), [], `${reason}: an idle input`);
      assert.equal(await run(loaded, "and the tests"), WORK_TERRA, reason);
      assert.deepEqual(scopeEntries(loaded), [], `${reason}: a run`);
      // A run without an input, as a custom message's or goal-x's continuation, starts here too.
      await loaded.host.emit("before_agent_start", { messageType: "custom" });
      assert.deepEqual(scopeEntries(loaded), [], `${reason}: a run without an input`);
      await loaded.host.emit("session_start", { reason: "reload" });
      assert.deepEqual([scopeEntries(loaded), messages(loaded)], [[], []], `${reason}: nothing recorded and nothing said`);
      assert.deepEqual(scopeOf(loaded), DEFAULT, `${reason}: without the roster's default, nothing in the session says work`);
    }
  });

  test("the latch and an entry still win over the default", async (t) => {
    const dir = agentDir(t, { roster: withDefault("work") });
    const personal = await begin({ dir, id: "personal", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()), setup: recorded("personal") });
    assert.equal(await scopeAnswer(personal), "pi-smart-router: scope personal (entry).");
    assert.equal(routed(personal.runtime.route("auto", request("direct"))), DEEPSEEK);
    const personalHost = agentDir(t, { roster: withDefault("personal") });
    const work = await begin({ dir: personalHost, id: "work", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()), setup: recorded("work") });
    assert.equal(await scopeAnswer(work), "pi-smart-router: scope work (entry).");
    await withScope("work", async () => {
      const latched = await begin({ dir: personalHost, id: "latched", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      assert.equal(await scopeAnswer(latched), "pi-smart-router: scope work (latch).");
      assert.equal(routed(latched.runtime.route("auto", request("direct"))), WORK_TERRA);
      assert.deepEqual(scopeEntries(latched), []);
    });
  });

  test("the work directories still win over the default and still record their entry, under either default", async (t) => {
    for (const scope of ["personal", "work"] as const) {
      const loaded = await begin({ dir: agentDir(t, { roster: withDefault(scope) }), cwd: APP, runtime: new FakeRuntime(workCatalog()) });
      assert.deepEqual(scopeEntries(loaded), [{ v: 1, scope: "work", by: "directory", at: NOW }], scope);
      assert.deepEqual(messages(loaded), [directoryNotice(APP, WORK_DIRECTORY)], scope);
      assert.equal(await scopeAnswer(loaded), "pi-smart-router: scope work (entry).", scope);
    }
  });

  test("a roster whose default changes moves a session with no entry at the next roster load, and still records nothing", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await begin({ dir, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
    const pinned = await begin({ dir, id: "pinned", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()), setup: recorded("personal") });
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK);
    rewrite(dir, withDefault("work"));
    // The next idle input reads the edited roster; the route reads the roster as it is now.
    await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), WORK_TERRA, "work scope after the load");
    assert.equal(await scopeAnswer(loaded), SCOPE_WORK_DEFAULT);
    assert.equal(routed(pinned.runtime.route("auto", request("direct"))), DEEPSEEK, "a session with an entry stays where its entry puts it");
    // And back: no entry was recorded, so the default moves the session again, without asking.
    rewrite(dir, HERA_V2);
    await loaded.host.command("smart-router", "reload");
    assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK);
    assert.equal(await scopeAnswer(loaded), "pi-smart-router: scope personal (default).");
    assert.deepEqual([scopeEntries(loaded), loaded.session.dialogs], [[], []]);
  });

  test("a fork or /new carries nothing for the default: the new session reads the same default for itself", async (t) => {
    const dir = agentDir(t, { roster: withDefault("work") });
    for (const reason of ["new", "fork"] as const) {
      const parent = await begin({ dir, id: `p-${reason}`, file: `/sessions/p-${reason}.jsonl`, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      await parent.host.emit("session_shutdown", { reason, targetSessionFile: `/sessions/p-${reason}-child.jsonl` });
      assert.equal(processSlot().scopeHandoffs?.size ?? 0, 0, reason);
      const child = await begin({ dir, id: `c-${reason}`, file: `/sessions/p-${reason}-child.jsonl`, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) }, reason);
      assert.deepEqual([scopeEntries(child), messages(child)], [[], []], reason);
      assert.equal(await scopeAnswer(child), SCOPE_WORK_DEFAULT, reason);
    }
  });

  describe("selecting smart-router/work records work scope where the default already gives it", () => {
    const WORK_ENTRY = { v: 1, scope: "work", by: "command", at: NOW };
    const SELECTED = { type: "info", message: scopeSelectedNotice() };
    const selectedNotices = (loaded: Loaded): number => messages(loaded).filter((message) => message === scopeSelectedNotice()).length;

    /** Load a session on `id` and start it for a reason, as Pi restores a selection with a session. */
    async function beginOn(options: LoadOptions, id: string, reason = "startup"): Promise<Loaded> {
      const loaded = load({ now: () => NOW, ...options });
      loaded.session.select(id);
      await loaded.host.emit("session_start", { reason });
      return loaded;
    }

    test("selected by hand: one work entry with the notice; a second selection, an idle input and a run record nothing more", async (t) => {
      const loaded = await begin({ dir: agentDir(t, { roster: withDefault("work") }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      assert.deepEqual(scopeEntries(loaded), []);
      await loaded.host.choose("smart-router/work");
      assert.deepEqual(scopeEntries(loaded), [WORK_ENTRY]);
      assert.deepEqual(loaded.session.notices.at(-1), SELECTED);
      assert.equal(await scopeAnswer(loaded), "pi-smart-router: scope work (entry).");
      assert.equal(routed(loaded.runtime.route("work", request("direct"))), WORK_TERRA);
      await loaded.host.choose("smart-router/auto");
      await loaded.host.choose("smart-router/work");
      await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
      await loaded.host.emit("before_agent_start", { prompt: "fix the build" });
      assert.deepEqual(scopeEntries(loaded), [WORK_ENTRY], "recorded once");
      assert.equal(selectedNotices(loaded), 1, "and said once");
    });

    test("smart-router/auto, selected by hand or at start, records nothing on the same host", async (t) => {
      const loaded = await begin({ dir: agentDir(t, { roster: withDefault("work") }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      // Away by cycling, which asks nothing, and back by hand: a selection of smart-router/auto.
      await loaded.host.choose("smart-router/personal", "cycle");
      await loaded.host.choose("smart-router/auto");
      await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
      assert.deepEqual([scopeEntries(loaded), selectedNotices(loaded)], [[], 0]);
      assert.equal(await scopeAnswer(loaded), SCOPE_WORK_DEFAULT);
    });

    test("once recorded, a roster whose default turns personal leaves the session in work scope; one without an entry moves", async (t) => {
      const dir = agentDir(t, { roster: withDefault("work") });
      const selected = await begin({ dir, id: "selected", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      const other = await begin({ dir, id: "other", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      await selected.host.choose("smart-router/work");
      await selected.host.choose("smart-router/auto");
      rewrite(dir, withDefault("personal"));
      // The next idle input of each session reads the edited roster.
      await selected.host.emit("input", { text: "fix the build", source: "interactive" });
      await other.host.emit("input", { text: "fix the build", source: "interactive" });
      assert.equal(await scopeAnswer(selected), "pi-smart-router: scope work (entry).");
      assert.equal(routed(selected.runtime.route("auto", request("direct"))), WORK_TERRA);
      assert.equal(routed(other.runtime.route("auto", request("direct"))), DEEPSEEK, "the session that only the default made work moves");
      assert.deepEqual([scopeEntries(selected), selected.session.dialogs], [[WORK_ENTRY], []]);
    });

    test("a fork or /new carries the recorded scope, and keeps it when the default turns personal", async (t) => {
      const dir = agentDir(t, { roster: withDefault("work") });
      const children: Loaded[] = [];
      for (const reason of ["new", "fork"] as const) {
        const parent = await begin({ dir, id: `p-${reason}`, file: `/sessions/p-${reason}.jsonl`, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
        await parent.host.choose("smart-router/work");
        await parent.host.emit("session_shutdown", { reason, targetSessionFile: `/sessions/p-${reason}-child.jsonl` });
        const child = await begin({ dir, id: `c-${reason}`, file: `/sessions/p-${reason}-child.jsonl`, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) }, reason);
        assert.deepEqual(scopeEntries(child), [{ v: 1, scope: "work", by: "carried", at: NOW }], reason);
        assert.deepEqual(messages(child), [scopeCarriedNotice("work")], reason);
        children.push(child);
      }
      rewrite(dir, withDefault("personal"));
      for (const child of children) {
        await child.host.emit("input", { text: "fix the build", source: "interactive" });
        assert.equal(await scopeAnswer(child), "pi-smart-router: scope work (entry).", child.session.id);
        assert.equal(routed(child.runtime.route("auto", request("direct"))), WORK_TERRA, child.session.id);
      }
    });

    test("a session restored on smart-router/work records at session start, once, at any kind of start", async (t) => {
      const dir = agentDir(t, { roster: withDefault("work") });
      for (const reason of ["startup", "resume", "reload", "new", "fork"]) {
        const loaded = await beginOn({ dir, id: reason, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) }, "work", reason);
        assert.deepEqual(scopeEntries(loaded), [WORK_ENTRY], reason);
        assert.deepEqual(messages(loaded), [scopeSelectedNotice()], reason);
        await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
        await loaded.host.emit("session_start", { reason: "reload" });
        assert.deepEqual([scopeEntries(loaded).length, selectedNotices(loaded)], [1, 1], `${reason}: nothing more`);
      }
    });

    test("under the latch, with a work entry or under a work directory, the selection records nothing more", async (t) => {
      const dir = agentDir(t, { roster: withDefault("work") });
      await withScope("work", async () => {
        const latched = await beginOn({ dir, id: "latched", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) }, "work");
        await latched.host.choose("smart-router/auto");
        await latched.host.choose("smart-router/work");
        assert.deepEqual([scopeEntries(latched), selectedNotices(latched)], [[], 0], "the latch needs no entry");
      });
      resetSlot();
      const entry = await beginOn({ dir, id: "entry", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()), setup: recorded("work") }, "work");
      await entry.host.choose("smart-router/auto");
      await entry.host.choose("smart-router/work");
      assert.deepEqual([scopeEntries(entry), selectedNotices(entry)], [[{ v: 1, scope: "work", by: "command", at: NOW - 60_000 }], 0], "an entry");
      const directory = await begin({ dir, id: "directory", cwd: APP, runtime: new FakeRuntime(workCatalog()) });
      await directory.host.choose("smart-router/work");
      assert.deepEqual(scopeEntries(directory).map((data: any) => data.by), ["directory"], "a work directory records its own entry, and the selection nothing more");
      // A work directory whose entry could not be written: the directory still gives work scope, so
      // the selection records nothing either, though it could now.
      const failing = load({ now: () => NOW, dir, id: "failing", cwd: APP, runtime: new FakeRuntime(workCatalog()) });
      const host = failing.host.api as unknown as Record<string, unknown>;
      const append = host.appendEntry;
      host.appendEntry = () => {
        throw new Error("the session is read-only");
      };
      failing.session.select("auto");
      await failing.host.emit("session_start", { reason: "startup" });
      host.appendEntry = append;
      assert.deepEqual(scopeEntries(failing), []);
      await failing.host.choose("smart-router/work");
      assert.deepEqual([scopeEntries(failing), selectedNotices(failing)], [[], 0]);
      assert.equal(await scopeAnswer(failing), "pi-smart-router: scope work (directory).");
    });

    test("a personal-only process is unchanged: the selection records nothing and the model refuses", async (t) => {
      const dir = agentDir(t, { roster: withDefault("work") });
      await withScope("personal-only", async () => {
        const loaded = await begin({ dir, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
        await loaded.host.choose("smart-router/work");
        await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
        assert.deepEqual([scopeEntries(loaded), selectedNotices(loaded)], [[], 0]);
        assert.throws(() => loaded.runtime.route("work", request("direct")), /work scope is disabled for the router/);
        const restored = await beginOn({ dir, id: "restored", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) }, "work");
        assert.deepEqual([scopeEntries(restored), selectedNotices(restored)], [[], 0]);
      });
    });
  });

  describe("leaving work scope the default gives asks, as from any work scope", () => {
    const MOVE = "Move this session to personal scope?\nAny earlier turns are work content, and the next requests would send them to personal accounts.";
    const OPTIONS = ["Keep this session in work scope", "Move it to personal scope (any earlier turns are work content)"];

    test("/smart-router scope personal asks, even in a session with no turns; Enter keeps work, and only the second answer moves it", async (t) => {
      const loaded = await begin({ dir: agentDir(t, { roster: withDefault("work") }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      assert.deepEqual(loaded.session.entries.filter((entry) => entry.type === "message"), [], "a session with no turns");
      await loaded.host.command("smart-router", "scope personal");
      assert.deepEqual(loaded.session.dialogs, [{ title: MOVE, options: OPTIONS }]);
      assert.equal(messages(loaded).at(-1), "pi-smart-router: the session stays in work scope.");
      assert.deepEqual(scopeEntries(loaded), []);
      loaded.session.dialogKeys = ["down", "enter"];
      await loaded.host.command("smart-router", "scope personal");
      assert.deepEqual(scopeEntries(loaded), [{ v: 1, scope: "personal", by: "command", at: NOW }]);
      assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK);
    });

    test("without dialogs it is refused, by the command and by selecting smart-router/personal, and nothing is recorded", async (t) => {
      const loaded = await begin({ dir: agentDir(t, { roster: withDefault("work") }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      loaded.session.hasUI = false;
      await loaded.host.command("smart-router", "scope personal");
      assert.equal(messages(loaded).at(-1), "pi-smart-router: /smart-router scope personal asks for confirmation, and this mode has no dialogs, so the session stays in work scope.");
      // A mode without dialogs shows no notice either: the selection is refused at its first request.
      const said = messages(loaded).length;
      await loaded.host.choose("smart-router/personal");
      assert.deepEqual([loaded.session.dialogs, scopeEntries(loaded), messages(loaded).length], [[], [], said]);
      refuses(() => loaded.runtime.route("personal", request("direct")), scopeMismatchOf(loaded), "smart-router/personal refuses the work session");
    });

    test("selecting smart-router/personal by hand asks the same question", async (t) => {
      const loaded = await begin({ dir: agentDir(t, { roster: withDefault("work") }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      await loaded.host.choose("smart-router/personal");
      assert.deepEqual(loaded.session.dialogs, [{ title: MOVE, options: OPTIONS }]);
      assert.deepEqual(scopeEntries(loaded), []);
    });

    /** The refusal smart-router/personal gives this session, as routing builds it. */
    function scopeMismatchOf(loaded: Loaded): Error {
      try {
        loaded.runtime.route("personal", request("direct"));
      } catch (error) {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^smart-router\/personal: this session is in work scope/);
        return error;
      }
      return assert.fail("smart-router/personal routed a work session");
    }
  });

  test("/smart-router status, tiers and scope local name the roster's default as the scope's source", async (t) => {
    const loaded = await begin({ dir: agentDir(t, { roster: withDefault("work") }), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
    await loaded.host.command("smart-router", "status");
    assert.deepEqual(
      (messages(loaded).at(-1) ?? "").split("\n").filter((line) => line.startsWith("Scope:")),
      ["Scope: work (roster-default: this host's defaultScope in the roster)"],
    );
    await loaded.host.command("smart-router", "tiers");
    assert.match(messages(loaded).at(-1) ?? "", /^pi-smart-router tiers: this session is in work scope \(roster-default: this host's defaultScope in the roster\), on smart-router\/auto\./);
    await loaded.host.command("smart-router", "scope local");
    assert.match(messages(loaded).at(-1) ?? "", /The session's own scope stays work \(roster-default: this host's defaultScope in the roster\)\.$/);
    assert.deepEqual(scopeEntries(loaded), []);
  });

  describe("while the roster fails to load", () => {
    /** The answer /smart-router scope gives a session with no entry while the host's default is unknown. */
    const unknownAnswer = (why: string): string =>
      `pi-smart-router: this session has no scope entry, and the host's default scope is unknown: ${why}. It is held in work scope until the roster loads or /smart-router scope work or /smart-router scope personal records one.`;
    const NO_ROSTER = "the roster does not load, and no valid roster loaded earlier in this process says it";
    const OLD_MEMORY = "the roster does not load, and the last valid one was loaded by another version of the router, which kept no default scope";

    test("the last valid roster's default holds, in this instance and in one built later in the process, and the slot keeps it", async (t) => {
      const dir = agentDir(t, { roster: withDefault("work") });
      const loaded = await begin({ dir, cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      assert.deepEqual(rememberedRoster(processSlot()), { directories: [WORK_DIRECTORY], defaultScope: "work" });
      writeFileSync(join(dir, "smart-router.json"), "{ nope");
      await loaded.host.command("smart-router", "reload");
      assert.equal(await scopeAnswer(loaded), SCOPE_WORK_DEFAULT, "still work by the last valid roster's default");
      const rebuilt = await begin({ dir, id: "rebuilt", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      assert.equal(await scopeAnswer(rebuilt), SCOPE_WORK_DEFAULT, "an instance that never saw a valid roster reads the process's memory");
      assert.deepEqual([scopeEntries(loaded), scopeEntries(rebuilt)], [[], []]);
      // A roster without the key is remembered as setting none: the built-in personal default.
      rewrite(dir, HERA_V2);
      await loaded.host.command("smart-router", "reload");
      assert.deepEqual(rememberedRoster(processSlot()), { directories: [WORK_DIRECTORY], defaultScope: null });
      writeFileSync(join(dir, "smart-router.json"), "{ nope");
      await loaded.host.command("smart-router", "reload");
      assert.equal(await scopeAnswer(loaded), "pi-smart-router: scope personal (default).");
    });

    test("a memory an earlier version kept, with no default, gives an unknown default: unreadable, held in work, never personal", async (t) => {
      const dir = agentDir(t, { roster: "{ nope" });
      // What an earlier load of the module kept: its directories alone.
      processSlot().lastRoster = { directories: [WORK_DIRECTORY] };
      const outside = await begin({ dir, id: "outside", file: "/sessions/outside.jsonl", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
      assert.deepEqual(scopeOf(outside), DEFAULT, "nothing in the session says a scope");
      assert.equal(await scopeAnswer(outside), unknownAnswer(OLD_MEMORY));
      // The memory's directories still count, and so does an entry.
      const under = await begin({ dir, id: "under", cwd: APP, runtime: new FakeRuntime(workCatalog()) });
      assert.deepEqual(scopeEntries(under), [{ v: 1, scope: "work", by: "directory", at: NOW }]);
      const personal = await begin({ dir, id: "personal", cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()), setup: recorded("personal") });
      assert.equal(await scopeAnswer(personal), "pi-smart-router: scope personal (entry).");
      // A request is refused for the roster, in the words for a work session.
      assert.throws(() => outside.runtime.route("auto", request("direct")), (error: unknown) => error instanceof Error && error.message.endsWith("Fix it and send the prompt again, or choose a work Codex model with /model."));
      // Leaving the unknown default for personal asks, as from work scope.
      await outside.host.command("smart-router", "scope personal");
      assert.equal(outside.session.dialogs.length, 1);
      assert.deepEqual(scopeEntries(outside), []);
      // A fork carries nothing for it, so nothing is recorded because of the default.
      await outside.host.emit("session_shutdown", { reason: "fork", targetSessionFile: "/sessions/outside-fork.jsonl" });
      assert.equal(processSlot().scopeHandoffs?.size ?? 0, 0);
    });

    test("with no valid roster ever loaded in the process the default is unknown; once a roster without the key loads, it is personal again", async (t) => {
      for (const roster of ["{ nope", null] as const) {
        resetSlot();
        const dir = agentDir(t, { roster });
        const loaded = await begin({ dir, id: String(roster), cwd: ACME_APP, runtime: new FakeRuntime(workCatalog()) });
        assert.equal(rememberedRoster(processSlot()), undefined, String(roster));
        assert.equal(await scopeAnswer(loaded), unknownAnswer(NO_ROSTER), String(roster));
        // Nothing can route while the roster fails to load, whatever the scope: every model refuses.
        for (const id of ["auto", "personal", "work", "local"] as const) {
          assert.throws(() => loaded.runtime.route(id, request("direct")), /Nothing was sent\./, `${String(roster)}: ${id}`);
        }
        assert.throws(() => loaded.runtime.route("auto", request("direct")), (error: unknown) => error instanceof Error && error.message.endsWith("or choose a work Codex model with /model."), "worded for a work session");
        await loaded.host.command("smart-router", "scope personal");
        assert.equal(loaded.session.dialogs.length, 1, `${String(roster)}: moving to personal asks`);
        loaded.session.hasUI = false;
        await loaded.host.command("smart-router", "scope personal");
        assert.equal(messages(loaded).at(-1), "pi-smart-router: /smart-router scope personal asks for confirmation, and this mode has no dialogs, so the session stays in work scope.");
        assert.deepEqual(scopeEntries(loaded), [], `${String(roster)}: nothing recorded`);
        // The roster is fixed, without the key: the session is personal by the built-in default.
        rewrite(dir, HERA_V2);
        await loaded.host.emit("input", { text: "fix the build", source: "interactive" });
        assert.equal(await scopeAnswer(loaded), "pi-smart-router: scope personal (default).", String(roster));
        assert.equal(routed(loaded.runtime.route("auto", request("direct"))), DEEPSEEK, String(roster));
      }
    });
  });
});
