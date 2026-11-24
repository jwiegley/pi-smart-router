// The provider order, the scope models smart-router/personal and smart-router/work, and
// /smart-router scope local. Fake catalogs only: no Pi, no model and no network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import { checkRoster } from "../src/check.ts";
import { ENV_SCOPE, SCOPE_ENTRY } from "../src/constants.ts";
import { hasOrderScope, orderedRoster, orderFor, providersOf, reorder, roleOwners, withScopeOrder } from "../src/order.ts";
import { parseRoster } from "../src/roster.ts";
import type { RosterV2 } from "../src/roster.ts";
import { scopeEntry } from "../src/scope.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { CHATGPT, FakeCatalog, HERA_LAN, model, NOW, OPENROUTER } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, failure, FakeRuntime, footerOf, previous, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded, LoadOptions } from "./support/pi.ts";

beforeEach(resetSlot);
afterEach(resetSlot);

const CODEX = "openai-codex";
const CLAUDE = "claude-code";
const WORK_CODEX = "openai-codex-3";
const WORK_CLAUDE = "claude-code-2";
const NYX = "nyx/qwen";
const HERA_QWEN = "omlx-hera/qwen";
const HERA_DEEP = "omlx-hera/deepseek";
const NYX_LAN = "https://nyx.lan:443/v1";

// Rosters are edited here as plain JSON values.
type Json = any;

/**
 * A roster shaped like Clio's: each personal tier lists Codex, Claude and OpenRouter, in that
 * order; each work tier lists the work Codex alias and the work Claude instance; LOW and MEDIUM
 * fall back to local roles, which smart-router/local also serves.
 */
function config(edit?: (roster: Json) => void): Json {
  const v = JSON.parse(fixture("roster-hera-v2.json"));
  delete v.exclude;
  delete v.classifier;
  v.accounts = {
    [CODEX]: { native: "personal" },
    [CLAUDE]: { native: "personal" },
    [WORK_CODEX]: { multiPassLabel: "Positron work", scope: "work" },
    [WORK_CLAUDE]: { native: "Positron work", scope: "work" },
  };
  v.roles = v.roles.filter((role: Json) => role.name !== "local");
  for (const tier of TIERS) {
    v.roles.find((role: Json) => role.name === tier).models = [`${CODEX}/${tier}`, `${CLAUDE}/${tier}`, `openrouter/vendor/${tier}`];
    v.roles.find((role: Json) => role.name === `work-${tier}`).models = [`${WORK_CODEX}/${tier}`, `${WORK_CLAUDE}/${tier}`];
  }
  v.roles.unshift({ name: "local-low", models: [NYX, HERA_QWEN] }, { name: "local-medium", models: [HERA_DEEP] });
  v.local = { role: "local-low", levels: { low: "local-low", medium: "local-medium", high: null, super: null }, providers: ["nyx", "omlx-hera"], hosts: ["nyx.lan", "hera.lan"] };
  for (const scope of ["personal", "work"]) {
    v.scopes[scope].levels.low.fallback = ["local-low"];
    v.scopes[scope].levels.medium.fallback = ["local-medium"];
  }
  edit?.(v);
  return v;
}

function parsed(value: Json): RosterV2 {
  const result = parseRoster(JSON.stringify(value));
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.ok(result.value.version === 2);
  return result.value;
}

function invalid(value: Json, expected: string): void {
  const result = parseRoster(JSON.stringify(value));
  assert.equal(result.ok, false, expected);
  if (!result.ok) assert.equal(result.error, expected);
}

function catalog(): FakeCatalog {
  const codex = { api: "openai-codex-responses", baseUrl: CHATGPT } as const;
  return new FakeCatalog([
    model(NYX, { baseUrl: NYX_LAN }),
    model(HERA_QWEN, { baseUrl: HERA_LAN }),
    model(HERA_DEEP, { baseUrl: HERA_LAN }),
    ...TIERS.flatMap((tier) => [
      model(`${CODEX}/${tier}`, codex),
      model(`${CLAUDE}/${tier}`, { baseUrl: "process://claude-code" }),
      model(`openrouter/vendor/${tier}`),
      model(`${WORK_CODEX}/${tier}`, codex),
      model(`${WORK_CLAUDE}/${tier}`, { baseUrl: "process://claude-code" }),
    ]),
  ]);
}

interface Options extends Partial<Omit<LoadOptions, "dir">> {
  readonly roster?: Json;
  readonly select?: string;
  readonly dir?: string;
}

async function open(t: TestContext, options: Options = {}): Promise<Loaded> {
  const { roster, dir, ...rest } = options;
  return start({ dir: dir ?? agentDir(t, { roster: JSON.stringify(roster ?? config()) }), runtime: new FakeRuntime(catalog()), now: () => NOW, ...rest });
}

const workEntry = (session: Loaded["session"]): void => session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - 60_000));
const selection = (loaded: Loaded): string => `${loaded.session.model?.provider}/${loaded.session.model?.id}`;
const scopeEntries = (loaded: Loaded): unknown[] => loaded.session.entries.filter((entry) => entry.customType === SCOPE_ENTRY).map((entry) => entry.data);

/** /smart-router ARGS, and the one notice it shows. */
async function say(loaded: Loaded, args: string): Promise<{ readonly type: string; readonly message: string }> {
  const before = loaded.session.notices.length;
  await loaded.host.command("smart-router", args);
  assert.equal(loaded.session.notices.length, before + 1, `/smart-router ${args} shows one notice`);
  return loaded.session.notices.at(-1)!;
}

type Own = "auto" | "personal" | "work" | "local";

/** A tagged prompt's run on one of the router's models: the model its first request goes to. The run is left in flight. */
async function begin(loaded: Loaded, id: Own, tier: Tier): Promise<string> {
  await loaded.host.emit("input", { text: `do the thing #${tier}`, source: "interactive" });
  return routed(loaded.runtime.route(id, request("user", { signal: loaded.session.startRun() })));
}

async function settle(loaded: Loaded): Promise<void> {
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
}

/** A tagged prompt's whole run: the model its first request goes to. */
async function run(loaded: Loaded, id: Own, tier: Tier): Promise<string> {
  const ref = await begin(loaded, id, tier);
  await settle(loaded);
  return ref;
}

/** The model a tier goes to once `ref`, which took its run, fails with an account error. */
async function after(loaded: Loaded, id: Own, tier: Tier, ref: string): Promise<string> {
  await loaded.host.emit("message_end", { message: assistant(ref, { stopReason: "error", errorMessage: "401 unauthorized", content: [] }) });
  return run(loaded, id, tier);
}

function refuses(call: () => unknown, pattern: RegExp): void {
  assert.throws(call, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.match(error.message, /Nothing was sent\./);
    return true;
  });
}

async function withEnv(value: string, body: () => Promise<void>): Promise<void> {
  const saved = process.env[ENV_SCOPE];
  process.env[ENV_SCOPE] = value;
  try {
    await body();
  } finally {
    if (saved === undefined) delete process.env[ENV_SCOPE];
    else process.env[ENV_SCOPE] = saved;
  }
}

const modelsIn = (roster: RosterV2, name: string): readonly string[] => roster.roles.find((role) => role.name === name)!.models;
const sorted = (items: readonly string[]): string[] => [...items].sort();

describe("the order, as a view over the roster", () => {
  test("reorder puts the listed providers first, in the listed order, and keeps every model", () => {
    const models = ["a/1", "b/1", "c/1", "a/2", "d/1"];
    assert.deepEqual(reorder(models, ["c", "a"]), ["c/1", "a/1", "a/2", "b/1", "d/1"]);
    assert.deepEqual(reorder(models, ["b"]), ["b/1", "a/1", "c/1", "a/2", "d/1"]);
    assert.deepEqual(reorder(models, ["a"]), ["a/1", "a/2", "b/1", "c/1", "d/1"], "every model of the provider, in the order the role lists them");
    const settled = ["a/1", "a/2", "b/1"];
    assert.equal(reorder(settled, ["a"]), settled, "an order that moves nothing returns the list itself");
    assert.equal(reorder(models, ["nobody"]), models);
    for (const order of [["d", "c", "b", "a"], ["b", "zz"], []]) assert.deepEqual(sorted(reorder(models, order)), sorted(models), order.join());
  });

  test("each scope owns its level and chain roles, and the local scope owns the local roles wherever they are named", () => {
    const roster = parsed(config((v) => {
      v.roles.push({ name: "spare", models: ["openrouter/vendor/spare"] }, { name: "idle", models: ["openrouter/vendor/idle"] });
      v.scopes.personal.fallback = ["spare"];
    }));
    const owners = roleOwners(roster);
    assert.deepEqual(owners.get("high"), { scope: "personal", tier: "high" });
    assert.deepEqual(owners.get("work-super"), { scope: "work", tier: "super" });
    assert.deepEqual(owners.get("spare"), { scope: "personal" });
    assert.deepEqual(owners.get("local-low"), { scope: "local", tier: "low" }, "a level's local fallback is the local scope's");
    assert.deepEqual(owners.get("local-medium"), { scope: "local", tier: "medium" });
    assert.equal(owners.get("idle"), undefined, "a role nothing routes to has no order");
    assert.deepEqual(providersOf(roster, "personal"), [CODEX, CLAUDE, "openrouter"]);
    assert.deepEqual(providersOf(roster, "work"), [WORK_CODEX, WORK_CLAUDE]);
    assert.deepEqual(providersOf(roster, "local"), ["nyx", "omlx-hera"]);
    assert.deepEqual(providersOf(roster, "local", "medium"), ["omlx-hera"]);
    assert.deepEqual(providersOf(roster, "local", "high"), []);
  });

  test("a view changes only the order: every role of every scope keeps exactly its models, and the roster itself is untouched", () => {
    const roster = parsed(config());
    const before = JSON.stringify(roster);
    const view = orderedRoster(roster, { personal: { all: [CLAUDE] }, work: { all: [WORK_CLAUDE], tiers: { super: [WORK_CODEX] } }, local: { all: ["omlx-hera"] } });
    assert.ok(view.version === 2);
    for (const role of roster.roles) assert.deepEqual(sorted(modelsIn(view, role.name)), sorted(role.models), role.name);
    assert.deepEqual(view.roles.map((role) => role.name), roster.roles.map((role) => role.name), "the ladder keeps its order");
    for (const tier of TIERS) assert.deepEqual(modelsIn(view, tier), [`${CLAUDE}/${tier}`, `${CODEX}/${tier}`, `openrouter/vendor/${tier}`], tier);
    assert.deepEqual(modelsIn(view, "work-low"), [`${WORK_CLAUDE}/low`, `${WORK_CODEX}/low`]);
    assert.deepEqual(modelsIn(view, "work-super"), [`${WORK_CODEX}/super`, `${WORK_CLAUDE}/super`], "a tier's own order comes before its scope's");
    assert.deepEqual(modelsIn(view, "local-low"), [HERA_QWEN, NYX]);
    assert.equal(JSON.stringify(roster), before);
    const { roles: _roles, ...rest } = view;
    const { roles: _given, ...given } = roster;
    assert.deepEqual(rest, given, "nothing but the roles differs");
  });

  test("no order is the roster itself, and one order gives one view", () => {
    const roster = parsed(config());
    assert.equal(orderedRoster(roster), roster);
    assert.equal(orderedRoster(roster, undefined), roster);
    assert.equal(orderedRoster(roster, { personal: { all: [CODEX] } }), roster, "the roster's own order moves nothing");
    const order = { personal: { all: [CLAUDE] } };
    assert.equal(orderedRoster(roster, order), orderedRoster(roster, { personal: { all: [CLAUDE] } }));
    assert.notEqual(orderedRoster(roster, order), roster);
    const v1 = parseRoster(fixture("roster-hera.json"));
    assert.ok(v1.ok);
    assert.equal(orderedRoster(v1.value, order), v1.value, "a version 1 roster has no tiers to order");
  });

  test("a session's order replaces the roster's, a tier's replaces the scope's, and dropping both leaves nothing", () => {
    const roster = parsed(config((v) => { v.providerOrder = { personal: [CLAUDE] }; }));
    assert.deepEqual(orderFor(roster, undefined, "personal"), { providers: [CLAUDE], source: "roster" });
    assert.equal(orderFor(roster, undefined, "work"), undefined);
    const session = withScopeOrder(undefined, "personal", { all: ["openrouter"], tiers: { high: [CODEX] } });
    assert.deepEqual(orderFor(roster, session, "personal", "low"), { providers: ["openrouter"], source: "session" });
    assert.deepEqual(orderFor(roster, session, "personal", "high"), { providers: [CODEX], source: "session" });
    assert.equal(withScopeOrder(session, "personal", undefined), undefined);
    assert.equal(withScopeOrder(session, "personal", { tiers: {} }), undefined);
    assert.deepEqual(withScopeOrder(session, "work", { all: [WORK_CLAUDE] }), { ...session, work: { all: [WORK_CLAUDE] } });
    assert.ok(hasOrderScope(roster, "local") && hasOrderScope(roster, "work"));
  });
});

describe("providerOrder in the roster", () => {
  test("a roster without it parses as before: no such key, and the roster is its own view", () => {
    const roster = parsed(config());
    assert.equal("providerOrder" in roster, false);
    assert.equal(orderedRoster(roster), roster);
    const hera = parseRoster(fixture("roster-hera-v2.json"));
    assert.ok(hera.ok && hera.value.version === 2);
    assert.equal("providerOrder" in hera.value, false);
  });

  test("a valid order is kept as written, for any of the three scopes", () => {
    const roster = parsed(config((v) => { v.providerOrder = { personal: [CLAUDE, CODEX], work: [WORK_CLAUDE], local: ["omlx-hera"], $comment: "Claude first this month" }; }));
    assert.deepEqual(roster.providerOrder, { personal: [CLAUDE, CODEX], work: [WORK_CLAUDE], local: ["omlx-hera"] });
    assert.deepEqual(parsed(config((v) => { v.providerOrder = {}; })).providerOrder, {});
  });

  test("a malformed order is refused with its place", () => {
    const bad = (order: Json, expected: string, edit?: (v: Json) => void): void => invalid(config((v) => { v.providerOrder = order; edit?.(v); }), expected);
    bad([CLAUDE], "providerOrder: must be an object");
    bad({ everyone: [CLAUDE] }, "providerOrder.everyone: unknown key");
    bad({ personal: CLAUDE }, "providerOrder.personal: must be an array");
    bad({ personal: [] }, "providerOrder.personal: must not be empty");
    bad({ personal: [CLAUDE, 7] }, "providerOrder.personal[1]: must be a non-empty string");
    bad({ personal: [CLAUDE, CLAUDE] }, `providerOrder.personal[1]: "${CLAUDE}" is listed twice`);
    bad({ personal: ["anthropic"] }, `providerOrder.personal[0]: "anthropic" is the provider of no model in the personal scope's roles`);
    bad({ personal: [WORK_CLAUDE] }, `providerOrder.personal[0]: "${WORK_CLAUDE}" is the provider of no model in the personal scope's roles`);
    bad({ work: [CLAUDE] }, `providerOrder.work[0]: "${CLAUDE}" is the provider of no model in the work scope's roles`);
    bad({ personal: ["nyx"] }, `providerOrder.personal[0]: "nyx" is the provider of no model in the personal scope's roles`);
    bad({ local: [CODEX] }, `providerOrder.local[0]: "${CODEX}" is the provider of no model in a local role`);
    const noWork = (v: Json): void => {
      delete v.scopes.work;
      v.roles = v.roles.filter((role: Json) => !role.name.startsWith("work-"));
      delete v.accounts[WORK_CODEX];
      delete v.accounts[WORK_CLAUDE];
    };
    bad({ work: [WORK_CLAUDE] }, "providerOrder.work: the roster has no work scope", noWork);
    const v1 = JSON.parse(fixture("roster-hera.json"));
    v1.providerOrder = { personal: ["openrouter"] };
    invalid(v1, "providerOrder: unknown key");
  });

  test("a session starts in the roster's order, the check reads it back, and prefer reset returns to it", async (t) => {
    const roster = config((v) => { v.providerOrder = { personal: [CLAUDE], local: ["omlx-hera"] }; });
    const loaded = await open(t, { roster });
    for (const tier of TIERS) assert.equal(await run(loaded, "auto", tier), `${CLAUDE}/${tier}`, tier);
    assert.equal(routed(loaded.runtime.route("local", request("direct"))), HERA_QWEN);
    const report = checkRoster(JSON.stringify(roster));
    assert.ok(report.ok);
    const text = report.lines.join("\n");
    assert.match(text, new RegExp(`HIGH\\s+${CLAUDE}/high, then ${CODEX}/high, then openrouter/vendor/high`));
    assert.match(text, /Provider order, applied above:/);
    assert.match(text, new RegExp(`  personal: ${CLAUDE}\\n  local: omlx-hera`));
    assert.doesNotMatch(checkRoster(JSON.stringify(config())).lines.join("\n"), /Provider order/, "a roster without one says nothing of it");
    await say(loaded, "prefer codex");
    assert.equal(await run(loaded, "auto", "high"), `${CODEX}/high`);
    const reset = await say(loaded, "prefer reset");
    assert.equal(reset.message, "pi-smart-router: the provider order is the roster's again in every scope.");
    assert.equal(await run(loaded, "auto", "high"), `${CLAUDE}/high`, "the roster's own order, not the order the models are written in");
    assert.match((await say(loaded, "status")).message, new RegExp(`Provider order \\(personal\\): ${CLAUDE} \\(the roster's providerOrder\\)`));
  });
});

describe("/smart-router prefer", () => {
  for (const tier of TIERS) {
    test(`prefer claude sends personal ${tier} to Claude, then Codex, then OpenRouter; prefer codex swaps them back`, async (t) => {
      const loaded = await open(t);
      assert.equal(await run(loaded, "auto", tier), `${CODEX}/${tier}`, "as the roster is written");
      const answer = await say(loaded, "prefer claude");
      assert.equal(answer.type, "info");
      assert.match(answer.message, new RegExp(`^pi-smart-router: the personal scope now tries ${CLAUDE} first\\. This session only: the roster file is unchanged, and a new session starts from it\\.`));
      assert.equal(await begin(loaded, "auto", tier), `${CLAUDE}/${tier}`);
      await settle(loaded);
      assert.equal(await after(loaded, "auto", tier, `${CLAUDE}/${tier}`), `${CODEX}/${tier}`, "Claude's account cools, and the tier's next model takes it");
      assert.equal(await after(loaded, "auto", tier, `${CODEX}/${tier}`), `openrouter/vendor/${tier}`);
      const other = await open(t, { id: "swap" });
      await say(other, "prefer claude");
      await say(other, "prefer codex");
      assert.equal(await run(other, "auto", tier), `${CODEX}/${tier}`);
    });
  }

  test("a whole order is taken as given, and a part of a provider's id names it", async (t) => {
    const loaded = await open(t);
    const answer = await say(loaded, "prefer openrouter claude codex");
    assert.match(answer.message, new RegExp(`the personal scope now tries openrouter, then ${CLAUDE}, then ${CODEX} first`));
    for (const tier of TIERS) {
      assert.equal(await run(loaded, "auto", tier), `openrouter/vendor/${tier}`, tier);
      assert.match(answer.message, new RegExp(`${tier.toUpperCase()}\\s+openrouter/vendor/${tier}, then ${CLAUDE}/${tier}, then ${CODEX}/${tier}  \\(role ${tier}\\)`));
    }
    await say(loaded, `prefer ${CLAUDE}`);
    assert.equal(await run(loaded, "auto", "low"), `${CLAUDE}/low`, "an order for every tier replaces the one before it");
  });

  test("one tier can have an order of its own, and resetting it leaves the scope's", async (t) => {
    const loaded = await open(t);
    const answer = await say(loaded, "prefer high claude");
    assert.match(answer.message, /the personal scope's HIGH tier now tries claude-code first/);
    assert.equal(await run(loaded, "auto", "high"), `${CLAUDE}/high`);
    for (const tier of ["low", "medium", "super"] as const) assert.equal(await run(loaded, "auto", tier), `${CODEX}/${tier}`, tier);
    await say(loaded, "prefer openrouter");
    assert.equal(await run(loaded, "auto", "high"), "openrouter/vendor/high", "an order for every tier is the whole scope's");
    await say(loaded, "prefer SUPER claude");
    assert.equal(await run(loaded, "auto", "super"), `${CLAUDE}/super`);
    assert.match((await say(loaded, "status")).message, new RegExp(`Provider order \\(personal\\): openrouter \\(this session, by /smart-router prefer\\); this session, SUPER ${CLAUDE}`));
    const reset = await say(loaded, "prefer super reset");
    assert.match(reset.message, /^pi-smart-router: the personal provider order of SUPER is the roster's again\./);
    assert.equal(await run(loaded, "auto", "super"), "openrouter/vendor/super");
    await say(loaded, "prefer personal reset");
    assert.equal(await run(loaded, "auto", "super"), `${CODEX}/super`);
  });

  test("the order is the session's alone: it writes no entry and no file, and a new session starts from the roster as written", async (t) => {
    const dir = agentDir(t, { roster: JSON.stringify(config()) });
    const path = join(dir, "smart-router.json");
    const before = { text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs, files: readdirSync(dir).sort() };
    const loaded = await open(t, { dir });
    const entries = loaded.session.entries.length;
    await say(loaded, "prefer claude");
    await say(loaded, "prefer local hera");
    await say(loaded, "prefer high openrouter");
    assert.equal(await run(loaded, "auto", "medium"), `${CLAUDE}/medium`);
    // The run's own level record is the only entry the session gained.
    assert.deepEqual(loaded.session.entries.slice(entries).map((entry) => entry.customType), ["smart-router.level"], "no entry holds the order");
    assert.deepEqual({ text: readFileSync(path, "utf8"), mtime: statSync(path).mtimeMs, files: readdirSync(dir).sort() }, before, "the agent directory is as it was");
    assert.equal(loaded.router?.record(loaded.session.id)?.order !== undefined, true);
    // A reload of the roster keeps the session's order; the session's end drops it.
    await say(loaded, "reload");
    assert.equal(await run(loaded, "auto", "medium"), `${CLAUDE}/medium`);
    await loaded.host.emit("session_shutdown", { reason: "new" });
    const next = await open(t, { dir, id: "next" });
    for (const tier of TIERS) assert.equal(await run(next, "auto", tier), `${CODEX}/${tier}`, tier);
    assert.equal(routed(next.runtime.route("local", request("direct"))), NYX);
    assert.equal(next.router?.record("next")?.order, undefined);
    // A session resumed under its old id starts from the roster too.
    await next.host.emit("session_shutdown", { reason: "quit" });
    const resumed = await open(t, { dir });
    assert.equal(await run(resumed, "auto", "medium"), `${CODEX}/medium`);
  });

  test("one session's order is not another's", async (t) => {
    const dir = agentDir(t, { roster: JSON.stringify(config()) });
    const runtime = new FakeRuntime(catalog());
    const first = await start({ dir, runtime, id: "first", now: () => NOW });
    const second = await start({ dir, runtime, id: "second", now: () => NOW });
    await say(first, "prefer claude");
    assert.equal(routed(runtime.route("auto", request("continuation", { signal: first.session.startRun() }))), `${CLAUDE}/medium`);
    assert.equal(routed(runtime.route("auto", request("continuation", { signal: second.session.startRun() }))), `${CODEX}/medium`);
  });

  test("the work scope takes any order of its own providers, by command from any session", async (t) => {
    const loaded = await open(t, { setup: workEntry });
    for (const tier of TIERS) assert.equal(await run(loaded, "auto", tier), `${WORK_CODEX}/${tier}`, tier);
    const answer = await say(loaded, "prefer claude");
    assert.match(answer.message, new RegExp(`the work scope now tries ${WORK_CLAUDE} first`), "in a work session the order is the work scope's");
    for (const tier of TIERS) {
      assert.equal(await begin(loaded, "auto", tier), `${WORK_CLAUDE}/${tier}`, tier);
      await settle(loaded);
    }
    assert.equal(await after(loaded, "auto", "high", `${WORK_CLAUDE}/high`), `${WORK_CODEX}/high`);
    const personal = await open(t, { id: "personal" });
    const named = await say(personal, "prefer work super codex-3");
    assert.match(named.message, new RegExp(`the work scope's SUPER tier now tries ${WORK_CODEX} first`));
    assert.equal(await run(personal, "auto", "super"), `${CODEX}/super`, "the personal tiers are as they were");
  });

  test("the local roles take an order too, on smart-router/local and as a level's fallback", async (t) => {
    const loaded = await open(t, { select: "local" });
    assert.equal(await run(loaded, "local", "low"), NYX);
    const answer = await say(loaded, "prefer hera");
    assert.match(answer.message, /the local scope now tries omlx-hera first/);
    assert.equal(await run(loaded, "local", "low"), HERA_QWEN, "on smart-router/local the order is the local roles'");
    assert.equal(await run(loaded, "local", "medium"), HERA_DEEP);
    // The same role is personal LOW's fallback: with every cloud model of the tier gone, its order is the local one.
    const auto = await open(t, { id: "auto" });
    for (const ref of [`${CODEX}/low`, `${CLAUDE}/low`, "openrouter/vendor/low"]) auto.runtime.catalog.unavailable.add(ref);
    assert.equal(await run(auto, "auto", "low"), NYX);
    await say(auto, "prefer local omlx-hera nyx");
    assert.equal(await run(auto, "auto", "low"), HERA_QWEN);
    await say(auto, "prefer claude");
    assert.equal(await run(auto, "auto", "low"), HERA_QWEN, "the personal order does not reach the local roles");
  });

  test("an order names only providers the scope's tiers already hold; anything else is refused and changes nothing", async (t) => {
    const loaded = await open(t);
    const refused = async (args: string, pattern: RegExp): Promise<void> => {
      const answer = await say(loaded, args);
      assert.equal(answer.type, "warning", args);
      assert.match(answer.message, pattern, args);
      assert.match(answer.message, /Nothing was changed\.$/, args);
      assert.equal(loaded.router?.record(loaded.session.id)?.order, undefined, args);
    };
    await refused(`prefer ${WORK_CLAUDE}`, new RegExp(`the personal scope has models of ${CODEX}, ${CLAUDE}, openrouter, and "${WORK_CLAUDE}" names none of them`));
    await refused(`prefer ${WORK_CODEX}`, /names none of them/);
    await refused("prefer anthropic", /"anthropic" names none of them/);
    await refused("prefer nyx", /"nyx" names none of them/);
    await refused(`prefer work ${CODEX}-2`, new RegExp(`the work scope has models of ${WORK_CODEX}, ${WORK_CLAUDE}, and "${CODEX}-2" names none of them`));
    await refused("prefer local codex", /the local scope has models of nyx, omlx-hera, and "codex" names none of them/);
    await refused("prefer claude claude", new RegExp(`${CLAUDE} is named twice`));
    await refused("prefer o", /"o" names openai-codex and claude-code and openrouter; write one in full/);
    await refused("prefer local high hera", /the local scope's HIGH tier has no models to order/);
    assert.equal(await run(loaded, "auto", "high"), `${CODEX}/high`);
    const v1 = await start({ dir: agentDir(t), id: "v1" });
    assert.deepEqual(await say(v1, "prefer claude"), { type: "warning", message: "pi-smart-router: a version 1 roster has no tiers to order. Nothing was changed." });
  });

  test("the limits follow the order: the models are registered again when their first candidates change", async (t) => {
    const loaded = await open(t);
    const small = model(`${CLAUDE}/low`, { baseUrl: "process://claude-code", contextWindow: 50_000, maxTokens: 4_000 });
    loaded.runtime.catalog.add(small);
    const definitions = loaded.host.definitions.length;
    const answer = await say(loaded, "prefer claude");
    assert.match(answer.message, /The models were registered again with their new limits\./);
    assert.equal(loaded.host.definitions.length, definitions + 4);
    assert.deepEqual(loaded.router?.limits().personal, { contextWindow: 50_000, maxTokens: 4_000 });
    assert.deepEqual(loaded.router?.limits().auto, { contextWindow: 50_000, maxTokens: 4_000 });
    assert.equal(loaded.runtime.find("smart-router", "personal")?.contextWindow, 50_000);
    assert.doesNotMatch((await say(loaded, "prefer claude")).message, /registered again/, "the same order registers nothing");
  });
});

describe("/smart-router tiers and status", () => {
  test("tiers lists each scope, its tiers and each tier's own and fallback models, in the session's order", async (t) => {
    const loaded = await open(t, { roster: config((v) => {
      v.roles.push({ name: "spare", models: ["openrouter/vendor/spare"] });
      v.scopes.personal.fallback = ["spare"];
    }) });
    loaded.runtime.catalog.add(model("openrouter/vendor/spare"));
    const plain = (await say(loaded, "tiers")).message.split("\n");
    assert.equal(plain[0], "pi-smart-router tiers: this session is in personal scope (default), on smart-router/auto.");
    assert.equal(plain[1], "Provider order: as the roster lists each role, in every scope.");
    assert.ok(plain.includes("personal (smart-router/personal, and smart-router/auto in a personal session):"));
    assert.ok(plain.includes(`  LOW    ${CODEX}/low, then ${CLAUDE}/low, then openrouter/vendor/low  (role low); then its local fallback ${NYX} (role local-low), then ${HERA_QWEN} (role local-low)`));
    assert.ok(plain.includes(`  SUPER  ${CODEX}/super, then ${CLAUDE}/super, then openrouter/vendor/super  (role super)`));
    assert.ok(plain.includes("  then, for every tier, the fallback chain: openrouter/vendor/spare (role spare)"));
    assert.ok(plain.includes("work (smart-router/work, and smart-router/auto in a work session):"));
    assert.ok(plain.includes(`  HIGH   ${WORK_CODEX}/high, then ${WORK_CLAUDE}/high  (role work-high)`));
    assert.ok(plain.includes("local (smart-router/local):"));
    assert.ok(plain.includes(`  LOW    ${NYX}, then ${HERA_QWEN}  (role local-low)`));
    assert.ok(plain.includes("  HIGH   refused: no models"));
    await say(loaded, "prefer claude");
    await say(loaded, "prefer local hera");
    const ordered = (await say(loaded, "tiers")).message.split("\n");
    assert.ok(ordered.includes(`Provider order (personal): ${CLAUDE} (this session, by /smart-router prefer)`));
    assert.ok(ordered.includes("Provider order (local): omlx-hera (this session, by /smart-router prefer)"));
    assert.ok(ordered.includes(`  LOW    ${CLAUDE}/low, then ${CODEX}/low, then openrouter/vendor/low  (role low); then its local fallback ${HERA_QWEN} (role local-low), then ${NYX} (role local-low)`));
    assert.ok(ordered.includes(`  HIGH   ${WORK_CODEX}/high, then ${WORK_CLAUDE}/high  (role work-high)`), "the work scope keeps the roster's order");
    const one = (await say(loaded, "prefer work")).message;
    assert.match(one, /^pi-smart-router tiers:/, "prefer with a scope and no provider shows that scope");
    assert.doesNotMatch(one, /personal \(smart-router\/personal/);
  });

  test("status shows the scope, what set it, the selection, and every tier in the order in effect", async (t) => {
    const loaded = await open(t);
    const plain = (await say(loaded, "status")).message;
    assert.match(plain, /^Selection: smart-router\/auto, thinking high$/m);
    assert.match(plain, /^Scope: personal \(default\)$/m);
    assert.doesNotMatch(plain, /Provider order/);
    assert.match(plain, new RegExp(`Levels \\(personal\\): LOW → ${CODEX}/low ok, ${CLAUDE}/low ok, openrouter/vendor/low ok, ${NYX} ok, ${HERA_QWEN} ok; MEDIUM → ${CODEX}/medium ok`));
    await say(loaded, "prefer claude");
    await say(loaded, "scope work");
    await say(loaded, "prefer claude");
    const status = (await say(loaded, "status")).message;
    assert.match(status, /^Selection: smart-router\/work, thinking high$/m);
    assert.match(status, /^Scope: work \(entry\)$/m);
    assert.match(status, new RegExp(`^Provider order \\(personal\\): ${CLAUDE} \\(this session, by /smart-router prefer\\)$`, "m"));
    assert.match(status, new RegExp(`^Provider order \\(work\\): ${WORK_CLAUDE} \\(this session, by /smart-router prefer\\)$`, "m"));
    assert.match(status, new RegExp(`Levels \\(personal\\): LOW → ${CLAUDE}/low [^,]+, ${CODEX}/low`));
    assert.match(status, new RegExp(`Levels \\(work\\): LOW → ${WORK_CLAUDE}/low ok, ${WORK_CODEX}/low ok, ${NYX} ok, ${HERA_QWEN} ok; MEDIUM → ${WORK_CLAUDE}/medium ok`));
    assert.match(status, new RegExp(`^  work-high[^:]*: ${WORK_CLAUDE}/high ok[^,]*, ${WORK_CODEX}/high ok`, "m"), "the roles are listed in the order in effect");
  });
});

describe("smart-router/personal and smart-router/work", () => {
  test("each routes its own scope's tiers, and smart-router/local is as it was", async (t) => {
    const personal = await open(t, { select: "personal" });
    for (const tier of TIERS) assert.equal(await run(personal, "personal", tier), `${CODEX}/${tier}`, tier);
    assert.equal(routed(personal.runtime.route("personal", request("direct"))), `${CODEX}/medium`);
    assert.deepEqual(scopeEntries(personal), [], "a personal session needs no entry");
    const work = await open(t, { id: "work", select: "work", setup: workEntry });
    for (const tier of TIERS) assert.equal(await run(work, "work", tier), `${WORK_CODEX}/${tier}`, tier);
    const local = await open(t, { id: "local", select: "local" });
    assert.equal(await run(local, "local", "low"), NYX);
    assert.equal(await run(local, "local", "medium"), HERA_DEEP);
    await local.host.emit("input", { text: "think hard #high", source: "interactive" });
    refuses(() => local.runtime.route("local", request("user", { signal: local.session.startRun() })), /^smart-router\/local: /);
  });

  test("smart-router/auto still takes its scope from the session: the default, an entry, a work directory", async (t) => {
    assert.equal(await run(await open(t), "auto", "high"), `${CODEX}/high`);
    assert.equal(await run(await open(t, { id: "entry", setup: workEntry }), "auto", "high"), `${WORK_CODEX}/high`);
    const directory = await open(t, { id: "directory", cwd: "/Users/johnw/src/positron/app" });
    assert.equal(await run(directory, "auto", "high"), `${WORK_CODEX}/high`);
    assert.deepEqual(scopeEntries(directory).map((entry: any) => entry.by), ["directory"]);
    assert.equal(selection(directory), "smart-router/auto", "and no selection of its own is made");
  });

  test("selecting smart-router/work makes the session a work session, as /smart-router scope work does", async (t) => {
    const loaded = await open(t);
    assert.equal(await run(loaded, "auto", "high"), `${CODEX}/high`);
    await loaded.host.choose("smart-router/work");
    assert.deepEqual(scopeEntries(loaded), [{ v: 1, scope: "work", by: "command", at: NOW }]);
    assert.match(loaded.session.notices.at(-1)?.message ?? "", /^pi-smart-router: this session is in work scope because smart-router\/work is selected\./);
    assert.equal(await run(loaded, "work", "high"), `${WORK_CODEX}/high`);
    assert.deepEqual(await say(loaded, "scope"), { type: "info", message: "pi-smart-router: scope work (entry)." });
    // The scope holds whatever is selected next: auto follows it, and personal refuses.
    await loaded.host.choose("smart-router/auto");
    assert.equal(await run(loaded, "auto", "high"), `${WORK_CODEX}/high`);
    assert.equal(scopeEntries(loaded).length, 1, "nothing is recorded twice");
    // A session that starts on the model, as a new session whose default it is does.
    const fresh = await open(t, { id: "fresh", select: "work" });
    assert.deepEqual(scopeEntries(fresh), [{ v: 1, scope: "work", by: "command", at: NOW }]);
    assert.equal(routed(fresh.runtime.route("work", request("direct"))), `${WORK_CODEX}/medium`);
    // A selection written without a model_select is caught at the next idle prompt.
    const forced = await open(t, { id: "forced" });
    forced.session.force("smart-router/work");
    assert.equal(await run(forced, "work", "low"), `${WORK_CODEX}/low`);
    assert.equal(scopeEntries(forced).length, 1);
  });

  test("selecting smart-router/personal in a work session asks first; declined, the session stays work and the model refuses", async (t) => {
    const loaded = await open(t, { setup: workEntry });
    await loaded.host.choose("smart-router/personal");
    assert.equal(loaded.session.dialogs.length, 1);
    assert.match(loaded.session.dialogs[0]?.title ?? "", /^Move this session to personal scope\?\nAny earlier turns are work content/);
    assert.deepEqual(loaded.session.dialogs[0]?.options, ["Keep this session in work scope", "Move it to personal scope (any earlier turns are work content)"]);
    assert.deepEqual(loaded.session.notices.at(-1), {
      type: "warning",
      message:
        "pi-smart-router: the session stays in work scope.\nsmart-router/personal routes only a session in personal scope, so it refuses this session's requests: choose smart-router/work or smart-router/auto with /model.",
    });
    assert.equal(selection(loaded), "smart-router/personal", "the selection is John's, and stays");
    assert.equal(scopeEntries(loaded).length, 1, "no entry was written");
    refuses(
      () => loaded.runtime.route("personal", request("direct")),
      /^smart-router\/personal: this session is in work scope, and smart-router\/personal routes only a session in personal scope\. Nothing was sent\. Run \/smart-router scope personal, which asks first, or choose smart-router\/work, smart-router\/auto or a work Codex model with \/model\.$/,
    );
    await loaded.host.emit("input", { text: "ship it #high", source: "interactive" });
    refuses(() => loaded.runtime.route("personal", request("user", { signal: loaded.session.startRun() })), /routes only a session in personal scope/);
    await settle(loaded);
    assert.deepEqual(loaded.runtime.classifyCalls, [], "and nothing is asked of a classifier");
    assert.equal(loaded.router?.record(loaded.session.id)?.history.length, 0, "no request was routed");
  });

  test("accepted, the session moves to personal scope and the model routes", async (t) => {
    const loaded = await open(t, { setup: workEntry });
    loaded.session.dialogKeys = ["down", "enter"];
    await loaded.host.choose("smart-router/personal");
    assert.deepEqual(loaded.session.notices.at(-1), { type: "warning", message: "pi-smart-router: scope personal (entry)." });
    assert.deepEqual(scopeEntries(loaded).at(-1), { v: 1, scope: "personal", by: "command", at: NOW });
    assert.equal(await run(loaded, "personal", "high"), `${CODEX}/high`);
    // In a personal session the selection asks nothing.
    await loaded.host.choose("smart-router/auto");
    await loaded.host.choose("smart-router/personal");
    assert.equal(loaded.session.dialogs.length, 1);
  });

  test("a restored or cycled selection never asks, and a mode without dialogs keeps work scope", async (t) => {
    const restored = await open(t, { select: "personal", setup: workEntry });
    assert.deepEqual(restored.session.dialogs, []);
    refuses(() => restored.runtime.route("personal", request("direct")), /routes only a session in personal scope/);
    const cycled = await open(t, { id: "cycled", setup: workEntry });
    await cycled.host.choose("smart-router/personal", "cycle");
    assert.deepEqual(cycled.session.dialogs, []);
    refuses(() => cycled.runtime.route("personal", request("direct")), /routes only a session in personal scope/);
    const headless = await open(t, { id: "headless", setup: workEntry });
    headless.session.hasUI = false;
    await headless.host.choose("smart-router/personal");
    assert.deepEqual([headless.session.dialogs, scopeEntries(headless).length], [[], 1]);
    refuses(() => headless.runtime.route("personal", request("direct")), /routes only a session in personal scope/);
    const unreadable = await open(t, { id: "unreadable", select: "personal", setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    refuses(() => unreadable.runtime.route("personal", request("direct")), /^smart-router\/personal: this session's scope cannot be read/);
    refuses(() => unreadable.runtime.route("work", request("direct")), /^smart-router\/work: this session's scope cannot be read/);
  });

  test("smart-router/work in a session that could not be made a work session refuses, and says how", async (t) => {
    const loaded = await open(t);
    refuses(
      () => loaded.runtime.route("work", request("direct")),
      /^smart-router\/work: this session is in personal scope, and smart-router\/work routes only a session in work scope\. Nothing was sent\. Run \/smart-router scope work, or choose smart-router\/personal or smart-router\/auto with \/model\.$/,
    );
    const failing = await open(t, { id: "failing" });
    (failing.host.api as unknown as Record<string, unknown>).appendEntry = () => { throw new Error("the session is read-only"); };
    await failing.host.choose("smart-router/work");
    assert.deepEqual(failing.session.notices.at(-1), {
      type: "error",
      message:
        "pi-smart-router: smart-router/work is selected, but work scope could not be recorded in this session (the session is read-only), so smart-router/work refuses its requests. Run /smart-router scope work.",
    });
    assert.deepEqual(scopeEntries(failing), []);
    refuses(() => failing.runtime.route("work", request("direct")), /routes only a session in work scope/);
    const notices = failing.session.notices.length;
    await failing.host.emit("input", { text: "again", source: "interactive" });
    assert.equal(failing.session.notices.length, notices, "it is tried once for a selection, and said once");
  });

  test("a roster without a work scope leaves smart-router/work refusing, and a version 1 roster too", async (t) => {
    const roster = config((v) => {
      delete v.scopes.work;
      v.roles = v.roles.filter((role: Json) => !role.name.startsWith("work-"));
      delete v.accounts[WORK_CODEX];
      delete v.accounts[WORK_CLAUDE];
    });
    const loaded = await open(t, { roster, select: "work" });
    refuses(() => loaded.runtime.route("work", request("direct")), /^smart-router\/work: this session is in work scope, which the roster does not serve/);
    assert.deepEqual(loaded.router?.limits().work, { contextWindow: 128_000, maxTokens: 16_384 });
    const v1 = await start({ dir: agentDir(t), id: "v1", select: "personal" });
    assert.match(routed(v1.runtime.route("personal", request("direct"))), /^openrouter\//, "a version 1 roster serves personal scope");
    await v1.host.choose("smart-router/work");
    refuses(() => v1.runtime.route("work", request("direct")), /^smart-router\/work: this session is in work scope, which a version 1 roster does not serve/);
  });
});

describe("/smart-router scope and the selection agree", () => {
  test("scope work, personal and local each select that scope's model, and status says the same scope", async (t) => {
    const loaded = await open(t);
    assert.deepEqual(await say(loaded, "scope work"), { type: "info", message: "pi-smart-router: scope work (entry).\nThe selection is now smart-router/work." });
    assert.equal(selection(loaded), "smart-router/work");
    assert.equal(scopeEntries(loaded).length, 1, "the selection that follows records nothing more");
    assert.equal(await run(loaded, "work", "high"), `${WORK_CODEX}/high`);
    loaded.session.dialogKeys = ["down", "enter"];
    assert.deepEqual(await say(loaded, "scope personal"), { type: "warning", message: "pi-smart-router: scope personal (entry).\nThe selection is now smart-router/personal." });
    assert.equal(selection(loaded), "smart-router/personal");
    assert.equal(loaded.session.dialogs.length, 1, "asked once, by the command");
    assert.equal(await run(loaded, "personal", "high"), `${CODEX}/high`);
    assert.deepEqual(await say(loaded, "scope local"), {
      type: "info",
      message: "pi-smart-router: The selection is now smart-router/local. This session now routes only to the local models. The session's own scope stays personal (entry).",
    });
    assert.equal(selection(loaded), "smart-router/local");
    assert.equal(scopeEntries(loaded).length, 2, "scope local records no scope");
    assert.equal(await run(loaded, "local", "low"), NYX);
    assert.deepEqual(await say(loaded, "scope"), {
      type: "info",
      message: "pi-smart-router: scope personal (entry). smart-router/local is selected, so this session routes only to the local models.",
    });
    assert.match((await say(loaded, "scope local")).message, /smart-router\/local is already selected/);
    // Back from local: the scope's own model again.
    assert.deepEqual(await say(loaded, "scope personal"), { type: "info", message: "pi-smart-router: scope personal (entry).\nThe selection is now smart-router/personal." });
    const status = (await say(loaded, "status")).message;
    assert.match(status, /^Selection: smart-router\/personal, thinking high$/m);
    assert.match(status, /^Scope: personal \(entry\)$/m);
  });

  test("a model picked by hand is never replaced", async (t) => {
    const loaded = await open(t);
    const picked = `openrouter/vendor/high`;
    await loaded.host.choose(picked);
    const selections = loaded.host.selections.length;
    assert.match((await say(loaded, "scope work")).message, new RegExp(`The selection stays ${picked}\\. A model picked by hand is sent as it is, in work scope too\\.`));
    loaded.session.dialogKeys = ["down", "enter"];
    assert.deepEqual(await say(loaded, "scope personal"), { type: "warning", message: "pi-smart-router: scope personal (entry)." });
    assert.deepEqual([selection(loaded), loaded.host.selections.length], [picked, selections]);
    // scope local is a request for the local model, so it is selected.
    assert.match((await say(loaded, "scope local")).message, /The selection is now smart-router\/local\./);
  });

  test("scope local in a work session keeps the session a work session", async (t) => {
    const loaded = await open(t, { setup: workEntry });
    assert.match((await say(loaded, "scope local")).message, /The session's own scope stays work \(entry\)\.$/);
    assert.equal(await run(loaded, "local", "low"), NYX);
    await say(loaded, "scope work");
    assert.equal(selection(loaded), "smart-router/work");
    assert.equal(await run(loaded, "work", "low"), `${WORK_CODEX}/low`);
  });
});

describe("the safeguards hold under any order and on the scope models", () => {
  /** Every model a scope's tiers reach under an order, with each earlier candidate's account failing in turn. */
  async function reached(loaded: Loaded, id: Own, tier: Tier): Promise<string[]> {
    const refs: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      let ref: string;
      try {
        ref = await begin(loaded, id, tier);
      } catch {
        await settle(loaded);
        break;
      }
      await settle(loaded);
      if (refs.includes(ref)) break;
      refs.push(ref);
      loaded.runtime.catalog.unavailable.add(ref);
    }
    return refs;
  }

  test("a personal session reaches no work-bound account, whatever its order", async (t) => {
    for (const order of ["prefer claude", "prefer openrouter claude codex", "prefer local hera", "prefer work claude"]) {
      resetSlot();
      const loaded = await open(t, { id: order });
      await say(loaded, order);
      for (const id of ["auto", "personal"] as const) {
        if (id === "personal") await loaded.host.choose("smart-router/personal");
        for (const tier of TIERS) {
          const refs = await reached(loaded, id, tier);
          assert.ok(refs.length >= 3, `${order}, ${id} ${tier}: ${refs.join(", ")}`);
          for (const ref of refs) assert.doesNotMatch(ref, new RegExp(`^(${WORK_CODEX}|${WORK_CLAUDE})/`), `${order}, ${id} ${tier}`);
          for (const ref of refs) loaded.runtime.catalog.unavailable.delete(ref);
        }
      }
    }
  });

  test("a work session reaches only work-bound accounts and its levels' declared local fallbacks, whatever its order", async (t) => {
    for (const order of ["prefer claude", "prefer codex claude", "prefer personal claude", "prefer local hera"]) {
      resetSlot();
      const loaded = await open(t, { id: order, setup: workEntry });
      await say(loaded, order);
      for (const id of ["auto", "work"] as const) {
        if (id === "work") await loaded.host.choose("smart-router/work");
        for (const tier of TIERS) {
          // A tier with nothing left passes its run up, so the walk covers the tiers above it too.
          const refs = await reached(loaded, id, tier);
          for (const own of [`${WORK_CODEX}/${tier}`, `${WORK_CLAUDE}/${tier}`]) assert.ok(refs.includes(own), `${order}, ${id} ${tier}: ${refs.join(", ")}`);
          for (const ref of refs) {
            assert.ok(ref.startsWith(`${WORK_CODEX}/`) || ref.startsWith(`${WORK_CLAUDE}/`) || [NYX, HERA_QWEN, HERA_DEEP].includes(ref), `${order}, ${id} ${tier}: ${ref}`);
          }
          for (const ref of refs) loaded.runtime.catalog.unavailable.delete(ref);
        }
      }
    }
  });

  test("a local candidate put first must still be on a local host", async (t) => {
    const loaded = await open(t, { select: "local" });
    // The preferred provider's model answers from a host that is not local.
    loaded.runtime.catalog.add(model(HERA_QWEN, { baseUrl: OPENROUTER }));
    await say(loaded, "prefer hera");
    assert.equal(await run(loaded, "local", "low"), NYX, "the order cannot bring in a model the local policy refuses");
    assert.match((await say(loaded, "status")).message, new RegExp(`${HERA_QWEN} not-local`));
    const auto = await open(t, { id: "auto" });
    auto.runtime.catalog.add(model(HERA_QWEN, { baseUrl: OPENROUTER }));
    for (const ref of [`${CODEX}/low`, `${CLAUDE}/low`, "openrouter/vendor/low"]) auto.runtime.catalog.unavailable.add(ref);
    await say(auto, "prefer local hera");
    assert.equal(await run(auto, "auto", "low"), NYX);
  });

  test("the work latch holds: smart-router/personal refuses, asks nothing, and no order reaches a personal account", async (t) => {
    await withEnv("work", async () => {
      const loaded = await open(t);
      await say(loaded, "prefer claude");
      await say(loaded, "prefer personal claude");
      assert.equal(await run(loaded, "auto", "high"), `${WORK_CLAUDE}/high`);
      await loaded.host.choose("smart-router/personal");
      assert.deepEqual(loaded.session.dialogs, [], "the latch is not asked about");
      assert.match(loaded.session.notices.at(-1)?.message ?? "", /PI_SMART_ROUTER_SCOPE pins every session of this process to work scope/);
      refuses(
        () => loaded.runtime.route("personal", request("direct")),
        /^smart-router\/personal: this session is in work scope, and smart-router\/personal routes only a session in personal scope\. Nothing was sent\. Choose smart-router\/work, smart-router\/auto or a work Codex model with \/model\.$/,
      );
      assert.match((await say(loaded, "scope personal")).message, /cannot be moved to personal/);
      assert.equal(selection(loaded), "smart-router/personal", "a refused move selects nothing");
      await loaded.host.choose("smart-router/work");
      assert.equal(await run(loaded, "work", "high"), `${WORK_CLAUDE}/high`);
      assert.deepEqual(scopeEntries(loaded), [], "the latch needs no entry");
    });
  });

  test("a personal-only process refuses smart-router/work and records nothing, and refuses a work session on every model", async (t) => {
    await withEnv("personal-only", async () => {
      const loaded = await open(t);
      await loaded.host.choose("smart-router/work");
      assert.deepEqual(scopeEntries(loaded), [], "selecting the model records no work scope here");
      refuses(
        () => loaded.runtime.route("work", request("direct")),
        /^smart-router\/work: work scope is disabled for the router on this personal-only host\. Nothing was sent\. Choose smart-router\/personal or smart-router\/auto with \/model\.$/,
      );
      await loaded.host.emit("input", { text: "ship it #high", source: "interactive" });
      assert.deepEqual(scopeEntries(loaded), [], "nor does the next prompt");
      assert.match((await say(loaded, "scope work")).message, /work scope is disabled for the router on this personal-only host; nothing was changed/);
      assert.equal(selection(loaded), "smart-router/work", "a refused scope selects nothing");
      await say(loaded, "prefer personal claude");
      await loaded.host.choose("smart-router/personal");
      assert.equal(await run(loaded, "personal", "high"), `${CLAUDE}/high`);
      const restored = await open(t, { id: "restored", setup: workEntry });
      for (const id of ["auto", "personal", "work", "local"] as const) {
        refuses(() => restored.runtime.route(id, request("direct")), /work scope is disabled for the router/);
      }
    });
  });

  test("a pick outside a scope model's own scope is caught again where every pick is checked", async (t) => {
    const { assertSafe } = await import("../src/route.ts");
    const { resolveContext, Cooldowns } = await import("../src/resolve.ts");
    const { policyFromRoster } = await import("../src/local.ts");
    const roster = parsed(config());
    const cat = catalog();
    const rc = (virtualId: "personal" | "work", scope: "personal" | "work") =>
      resolveContext({ roster, catalog: cat, labels: undefined, cooldowns: new Cooldowns(), now: NOW, virtualId, localOnly: false, policy: policyFromRoster(roster), scope });
    const personal = { ref: `${CODEX}/high`, role: "high", model: cat.find(CODEX, "high")!, code: "test", fallback: false };
    const work = { ref: `${WORK_CODEX}/high`, role: "work-high", model: cat.find(WORK_CODEX, "high")!, code: "test", fallback: false };
    assert.doesNotThrow(() => assertSafe("personal", rc("personal", "personal"), personal as never));
    assert.throws(() => assertSafe("personal", rc("personal", "work"), work as never), /is routed in work scope, which smart-router\/personal never routes in/);
    assert.throws(() => assertSafe("work", rc("work", "personal"), personal as never), /is routed in personal scope, which smart-router\/work never routes in/);
    assert.throws(() => assertSafe("personal", rc("personal", "personal"), work as never), /smart-router\/personal:/);
  });
});

describe("a run under way keeps its level when the session's scope changes", () => {
  const levelRecords = (loaded: Loaded): Json[] => loaded.session.entries.filter((entry) => entry.customType === "smart-router.level").map((entry) => entry.data as Json);

  /** A SUPER run in personal scope, its first answer in, then /smart-router scope work while it runs. */
  async function superThenWork(t: TestContext, roster?: Json): Promise<{ loaded: Loaded; first: string; signal: AbortSignal }> {
    const loaded = await open(t, roster === undefined ? {} : { roster });
    await loaded.host.emit("input", { text: "plan the research #super", source: "interactive" });
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "plan the research" });
    const signal = loaded.session.startRun();
    const first = routed(loaded.runtime.route("auto", request("user", { signal })));
    assert.equal(first, `${CODEX}/super`);
    await loaded.host.emit("message_end", { message: assistant(first) });
    await say(loaded, "scope work");
    assert.equal(selection(loaded), "smart-router/work");
    return { loaded, first, signal };
  }

  test("personal SUPER, then /smart-router scope work: the run's continuations go to work SUPER, never to MEDIUM", async (t) => {
    const { loaded, first, signal } = await superThenWork(t);
    const next = routed(loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, first) })));
    assert.equal(next, `${WORK_CODEX}/super`);
    // The run stays there: the next continuation sticks to the work model like any other.
    await loaded.host.emit("message_end", { message: assistant(next) });
    assert.equal(routed(loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, next) }))), next);
    const history = (await say(loaded, "history")).message;
    assert.match(history, /run:level/);
  });

  test("the footer and the run's level record name the level, the scope and the model the run ended on", async (t) => {
    const { loaded, first, signal } = await superThenWork(t);
    const next = routed(loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, first) })));
    assert.match(footerOf(loaded) ?? "", /^super .*→ super$/, `the footer: ${footerOf(loaded)}`);
    assert.match((await say(loaded, "status")).message, /^Scope: work \(entry\)$/m);
    await loaded.host.emit("message_end", { message: assistant(next) });
    await settle(loaded);
    const record = levelRecords(loaded).at(-1);
    assert.ok(record !== undefined, "the run wrote its level record");
    assert.equal(record.scope, "work");
    assert.equal(record.tier, "super");
    assert.equal(record.need, "super");
    assert.equal(record.ref, next);
  });

  test("with no work SUPER model the continuation is refused: nothing is sent, and no lower level takes it", async (t) => {
    const roster = config((v) => {
      v.roles.find((role: Json) => role.name === "work-super").models = [`${WORK_CODEX}/absent`];
    });
    const { loaded, first, signal } = await superThenWork(t, roster);
    refuses(() => loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, first) })), /smart-router\/work/);
    // The refusal changed nothing: the same request is refused again, and MEDIUM is there to be taken.
    refuses(() => loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, first) })), /smart-router\/work/);
    await settle(loaded);
    assert.equal(await run(loaded, "work", "medium"), `${WORK_CODEX}/medium`);
  });

  test("a retry of content the personal model refused is still refused after the move: it reaches no work model", async (t) => {
    const { loaded, first, signal } = await superThenWork(t);
    const failed = failure(loaded.runtime, first, "403 Forbidden: content_filter: the request was flagged by moderation");
    refuses(() => loaded.runtime.route("work", request("retry", { signal, failed, previous: previous(loaded.runtime, first) })), /refused content is never sent to another model/);
  });

  test("what the cache optimizer is told after the move is the model the run's next request takes", async (t) => {
    const { loaded, first, signal } = await superThenWork(t);
    const told = loaded.router?.activeRoute("work");
    const next = routed(loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, first) })));
    assert.equal(`${told?.provider}/${told?.modelId}`, next);
    assert.equal(next, `${WORK_CODEX}/super`);
  });

  test("a moved run whose level has no work model climbs, and its record says it stepped up, with no cost from the scope it left", async (t) => {
    const roster = config((v) => {
      v.roles.find((role: Json) => role.name === "work-high").models = [`${WORK_CODEX}/absent`];
    });
    const loaded = await open(t, { roster });
    // Untagged: the personal plan is priced where the session has figures, and may carry a cost.
    const prompt = "review the design of the migration and its risks in depth";
    await loaded.host.emit("input", { text: `${prompt} #high`, source: "interactive" });
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt });
    const signal = loaded.session.startRun();
    const first = routed(loaded.runtime.route("auto", request("user", { signal })));
    assert.equal(first, `${CODEX}/high`);
    await loaded.host.emit("message_end", { message: assistant(first) });
    await say(loaded, "scope work");
    const next = routed(loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, first) })));
    assert.equal(next, `${WORK_CODEX}/super`);
    await loaded.host.emit("message_end", { message: assistant(next) });
    await settle(loaded);
    const record = levelRecords(loaded).at(-1);
    assert.ok(record !== undefined);
    assert.deepEqual([record.scope, record.need, record.tier, record.steppedUp, record.ref], ["work", "high", "super", true, next]);
    assert.equal(record.cost, undefined);
    assert.doesNotMatch(JSON.stringify(record), new RegExp(`${CODEX}/|${CLAUDE}/|openrouter/`));
  });

  test("no request of the moved run reaches a personal model, whatever it names as previous", async (t) => {
    const { loaded, first, signal } = await superThenWork(t);
    for (const prior of [first, `${CLAUDE}/super`, `openrouter/vendor/super`]) {
      const ref = routed(loaded.runtime.route("work", request("continuation", { signal, previous: previous(loaded.runtime, prior) })));
      assert.ok(ref.startsWith(`${WORK_CODEX}/`) || ref.startsWith(`${WORK_CLAUDE}/`), `${prior} → ${ref}`);
      assert.equal(ref, `${WORK_CODEX}/super`);
    }
    // A retry of the moved run's first work request stays in work scope at SUPER too.
    const retried = routed(loaded.runtime.route("work", request("retry", { signal, previous: previous(loaded.runtime, first) })));
    assert.equal(retried, `${WORK_CODEX}/super`);
  });

  test("a work run cannot be moved back: the session stays in work scope and the run on its work model", async (t) => {
    const loaded = await open(t, { setup: workEntry });
    await loaded.host.emit("input", { text: "review it #high", source: "interactive" });
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "review it" });
    const signal = loaded.session.startRun();
    const first = routed(loaded.runtime.route("auto", request("user", { signal })));
    assert.equal(first, `${WORK_CODEX}/high`);
    await loaded.host.emit("message_end", { message: assistant(first) });
    assert.equal((await say(loaded, "scope personal")).message, "pi-smart-router: the session stays in work scope.");
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, first) }))), first);
  });

  test("a run that stays in its scope is not moved: a change of router model alone keeps its model", async (t) => {
    const loaded = await open(t);
    await loaded.host.emit("input", { text: "plan it #super", source: "interactive" });
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "plan it" });
    const signal = loaded.session.startRun();
    const first = routed(loaded.runtime.route("auto", request("user", { signal })));
    await loaded.host.emit("message_end", { message: assistant(first) });
    assert.equal(routed(loaded.runtime.route("personal", request("continuation", { signal, previous: previous(loaded.runtime, first) }))), first);
    assert.doesNotMatch((await say(loaded, "history")).message, /run:level/);
  });
});
