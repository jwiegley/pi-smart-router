// Shared per-level local fallbacks. These tests use only fake catalogs and never start Pi.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { checkRoster } from "../src/check.ts";
import { pickInRole, planUserTurn } from "../src/decide.ts";
import { policyFromRoster } from "../src/local.ts";
import { Cooldowns, resolveContext } from "../src/resolve.ts";
import { autoRoles, candidatesOf, fallbackAfter, parseRoster } from "../src/roster.ts";
import { assertSafe } from "../src/route.ts";
import { FakeCatalog, HERA_LABELS, HERA_LAN, model, NOW } from "./support/catalog.ts";
import { fixture, write } from "./support/fixtures.ts";
import { agentDir, assistant, classifierModel, FakeRuntime, request, resetSlot, routed, start } from "./support/pi.ts";

beforeEach(resetSlot);
afterEach(resetSlot);

const LOCAL_LOW = "nyx/qwen";
const LOCAL_MEDIUM = "omlx-hera/deepseek";

function config(): any {
  const value = JSON.parse(fixture("roster-hera-v2.json"));
  value.roles = value.roles.map((role: any) => role.name === "local" ? { name: "local-low", models: [LOCAL_LOW] } : role);
  value.roles.find((role: any) => role.name === "low").models = ["openai-codex-2/gpt-6-luna"];
  value.roles.push({ name: "local-medium", models: [LOCAL_MEDIUM] });
  value.local = { role: "local-low", levels: { low: "local-low", medium: "local-medium", high: null, super: null }, providers: ["nyx", "omlx-hera"], hosts: ["nyx.lan", "hera.lan"] };
  for (const scope of ["personal", "work"]) {
    value.scopes[scope].levels.low.fallback = ["local-low"];
    value.scopes[scope].levels.medium.fallback = ["local-medium"];
  }
  return value;
}

function parsed(value: unknown) {
  const result = parseRoster(JSON.stringify(value));
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.value.version, 2);
  return result.value;
}

test("each scope reaches only its own level's shared local fallback", () => {
  const roster = parsed(config());
  assert.deepEqual(fallbackAfter(roster, "personal", "low"), ["local-low"]);
  assert.deepEqual(fallbackAfter(roster, "personal", "medium"), ["local-medium"]);
  assert.deepEqual(fallbackAfter(roster, "work", "work-low"), ["local-low"]);
  assert.deepEqual(fallbackAfter(roster, "work", "work-medium"), ["local-medium"]);
  assert.deepEqual(fallbackAfter(roster, "work", "work-high"), []);
  assert.deepEqual(candidatesOf(roster, "work", "work-low").map((entry) => entry.ref), ["openai-codex-3/gpt-6-luna", LOCAL_LOW]);
  assert.ok(autoRoles(roster, "work").has("local-low"));
  assert.deepEqual(policyFromRoster(roster).refs, [LOCAL_LOW, LOCAL_MEDIUM]);
});

test("a per-tier local fallback leads forward into its scope's shared chain", () => {
  const value = config();
  value.roles.push({ name: "spare-cloud", models: ["openrouter/vendor/spare"] });
  value.scopes.personal.fallback = ["spare-cloud"];
  const roster = parsed(value);
  assert.deepEqual(fallbackAfter(roster, "personal", "local-low"), ["spare-cloud"]);
  assert.deepEqual(fallbackAfter(roster, "work", "local-low"), []);
});

test("roster checker reports each tier's fallbacks and the empty local tiers", () => {
  const report = checkRoster(JSON.stringify(config()));
  assert.equal(report.ok, true);
  const lines = report.lines.join("\n");
  assert.match(lines, /LOW[^\n]*openai-codex-3\/gpt-6-luna[^\n]*nyx\/qwen/);
  assert.match(lines, /MEDIUM[^\n]*omlx-hera\/deepseek/);
  assert.match(lines, /HIGH[^\n]*refused/);
  assert.match(lines, /SUPER[^\n]*refused/);
});

test("roles can be explicitly disabled when no verified work account exists", () => {
  const value = config();
  const role = value.roles.find((entry: any) => entry.name === "work-high");
  role.models = [];
  assert.equal(parseRoster(JSON.stringify(value)).ok, false, "an accidentally empty role remains invalid");
  role.disabled = true;
  const roster = parsed(value);
  assert.deepEqual(roster.roles.find((entry) => entry.name === "work-high")?.models, []);
  const report = checkRoster(JSON.stringify(value));
  assert.equal(report.ok, true);
  assert.match(report.lines.join("\n"), /HIGH[^\n]*disabled/);
  role.models = ["openai-codex-3/gpt-6.1-sol"];
  assert.equal(parseRoster(JSON.stringify(value)).ok, false, "a disabled role cannot conceal candidates");
});

test("work local fallback requires an actual allowed local endpoint", () => {
  const roster = parsed(config());
  const catalog = new FakeCatalog([model(LOCAL_LOW, { baseUrl: "https://nyx.lan/v1" }), model(LOCAL_MEDIUM, { baseUrl: HERA_LAN })]);
  const context = () => resolveContext({ roster, catalog, labels: HERA_LABELS, cooldowns: new Cooldowns(), now: NOW, virtualId: "auto", localOnly: false, policy: policyFromRoster(roster), scope: "work" });
  const good = pickInRole(context(), "work-low", { fallback: true, code: "test" });
  assert.ok(good.ok);
  assert.equal(good.choice.ref, LOCAL_LOW);
  assert.doesNotThrow(() => assertSafe("auto", context(), good.choice));
  catalog.add(model(LOCAL_LOW, { baseUrl: "https://example.com/v1" }));
  const bad = pickInRole(context(), "work-low", { fallback: true, code: "test" });
  assert.equal(bad.ok, false, "a local-role provider pointing off-LAN must be refused");
  assert.throws(() => assertSafe("auto", context(), { ...good.choice, model: model(LOCAL_LOW, { baseUrl: "https://example.com/v1" }) }), /Nothing was sent/);
});

test("work fallback cannot name a personal or arbitrary cloud role", () => {
  const value = config();
  value.roles.push({ name: "untrusted-cloud", models: ["openrouter/vendor/model"] });
  value.scopes.work.levels.low.fallback = ["untrusted-cloud"];
  assert.equal(parseRoster(JSON.stringify(value)).ok, false);
});

test("a per-tier fallback names at most one local role", () => {
  const value = config();
  value.scopes.work.levels.low.fallback = ["local-low", "local-medium"];
  const result = parseRoster(JSON.stringify(value));
  assert.ok(!result.ok);
  assert.match(result.error, /may name only one local role/);
});

test("work Claude Code requires a work binding and never enters personal routing", () => {
  const value = config();
  const ref = "claude-code/claude-opus-5-5";
  value.roles.find((role: any) => role.name === "work-high").models.push(ref);
  value.accounts["claude-code"] = { native: "personal" };
  assert.equal(parseRoster(JSON.stringify(value)).ok, false);
  value.accounts["claude-code"] = { native: "Positron work", scope: "work" };
  const roster = parsed(value);
  const catalog = new FakeCatalog([model(ref, { baseUrl: "process://claude-code" })]);
  const make = (scope: "personal" | "work") => resolveContext({ roster, catalog, labels: HERA_LABELS, cooldowns: new Cooldowns(), now: NOW, virtualId: "auto", localOnly: false, policy: policyFromRoster(roster), scope });
  const work = pickInRole(make("work"), "work-high", { fallback: true, code: "test" });
  assert.ok(work.ok);
  assert.equal(work.choice.ref, ref);
  assert.doesNotThrow(() => assertSafe("auto", make("work"), work.choice));
  assert.equal(pickInRole(make("personal"), "work-high", { fallback: true, code: "test" }).ok, false);
});

test("local tier tags choose their local role, and empty tiers refuse", () => {
  const roster = parsed(config());
  const catalog = new FakeCatalog([model(LOCAL_LOW, { baseUrl: "https://nyx.lan/v1" }), model(LOCAL_MEDIUM, { baseUrl: HERA_LAN })]);
  const rc = resolveContext({ roster, catalog, labels: HERA_LABELS, cooldowns: new Cooldowns(), now: NOW, virtualId: "local", localOnly: true, policy: policyFromRoster(roster), scope: "work" });
  const plan = (tag: "low" | "medium" | "high" | "super") => planUserTurn({ rc, text: "test", last: undefined, now: NOW, compaction: { enabled: true, reserve: 0, keepRecent: 0 }, level: { tag }, facts: { contextTokens: undefined, roles: [], entries: undefined } });
  const low = plan("low");
  const medium = plan("medium");
  assert.ok(low.decision.ok);
  assert.equal(low.decision.choice.ref, LOCAL_LOW);
  assert.ok(medium.decision.ok);
  assert.equal(medium.decision.choice.ref, LOCAL_MEDIUM);
  const mediumChoice = medium.decision.choice;
  assert.doesNotThrow(() => assertSafe("local", rc, mediumChoice));
  assert.equal(plan("high").decision.ok, false);
  assert.equal(plan("super").decision.ok, false);
});

test("local tier tags route end-to-end without asking the cloud classifier", async (t) => {
  const value = config();
  value.classifier = { model: "openrouter/typesafe/jev-1.14" };
  const catalog = new FakeCatalog([model(LOCAL_LOW, { baseUrl: "https://nyx.lan/v1" }), model(LOCAL_MEDIUM, { baseUrl: HERA_LAN })]);
  const runtime = new FakeRuntime(catalog);
  runtime.classifiers.set("openrouter/typesafe/jev-1.14", classifierModel("openrouter/typesafe/jev-1.14"));
  const loaded = await start({ dir: agentDir(t, { roster: JSON.stringify(value) }), runtime, select: "local" });
  await loaded.host.command("smart-router", "status");
  const status = loaded.session.notices.at(-1)?.message ?? "";
  assert.match(status, /Levels \(work\):[^\n]*LOW →[^\n]*nyx\/qwen/);
  assert.match(status, /Levels \(local\):[^\n]*MEDIUM →[^\n]*omlx-hera\/deepseek[^\n]*HIGH → refused[^\n]*SUPER → refused/);
  await loaded.host.emit("input", { text: "test #medium", source: "interactive" });
  const first = loaded.session.startRun();
  assert.equal(routed(runtime.route("local", request("user", { signal: first }))), LOCAL_MEDIUM);
  await loaded.host.emit("message_end", { message: assistant(LOCAL_MEDIUM) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
  await loaded.host.emit("input", { text: "test #high", source: "interactive" });
  const second = loaded.session.startRun();
  assert.throws(() => runtime.route("local", request("user", { signal: second })), /local HIGH tier has no models.*Nothing was sent/);
  assert.deepEqual(runtime.classifyCalls, []);
  assert.ok(!loaded.session.notices.some((note) => /tag was removed and has no effect/i.test(note.message)));
});

test("a local tier disabled after planning refuses before sending", async (t) => {
  const value = config();
  value.local.levels.high = "local-medium";
  const dir = agentDir(t, { roster: JSON.stringify(value) });
  const runtime = new FakeRuntime(new FakeCatalog([model(LOCAL_LOW, { baseUrl: "https://nyx.lan/v1" }), model(LOCAL_MEDIUM, { baseUrl: HERA_LAN })]));
  const loaded = await start({ dir, runtime, select: "local" });
  await loaded.host.emit("input", { text: "test #high", source: "interactive" });
  value.local.levels.high = null;
  write(dir, "smart-router.json", JSON.stringify(value));
  await loaded.host.command("smart-router", "reload");
  const signal = loaded.session.startRun();
  assert.throws(() => runtime.route("local", request("user", { signal })), /local HIGH tier has no models.*Nothing was sent/);
});

test("an unplanned local-tier request refuses instead of silently choosing LOW", async (t) => {
  const runtime = new FakeRuntime(new FakeCatalog([model(LOCAL_LOW, { baseUrl: "https://nyx.lan/v1" }), model(LOCAL_MEDIUM, { baseUrl: HERA_LAN })]));
  const loaded = await start({ dir: agentDir(t, { roster: JSON.stringify(config()) }), runtime, select: "local" });
  await loaded.host.emit("input", { text: "test #high", source: "interactive" });
  await loaded.host.emit("before_agent_start", { messageType: "custom", message: "unplanned" });
  const signal = loaded.session.startRun();
  assert.throws(() => runtime.route("local", request("user", { signal })), /no local tier.*Nothing was sent/);
});
