import assert from "node:assert/strict";
import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

import { ENV_SCOPE, LEVEL_ENTRY, PIN_ENTRY, SCOPE_ENTRY } from "../src/constants.ts";
import { policyFromRoster } from "../src/local.ts";
import { clock } from "../src/resolve.ts";
import { createRouter } from "../src/router.ts";
import { scopeEntry } from "../src/scope.ts";
import { ASTRA, DEEPSEEK, FakeCatalog, GLM, GLM_CLOUD, heraModels, KIMI, model, NOW, OPENROUTER, rosterFixture, rosterFixtureV2, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, load, request, resetSlot, start } from "./support/pi.ts";
import type { FakeSession, Loaded, LoadOptions } from "./support/pi.ts";

const POLICY = policyFromRoster(rosterFixture("roster-hera.json"));
const AT = new Date(NOW).toISOString();
const QWEN = "openrouter/qwen/qwen-9-max";
const USAGE = "Usage: /smart-router [status] | history [n] | local on|off|status | scope [work|personal|status] | was low|medium|high|super | reload";
const HERA_V2 = fixture("roster-hera-v2.json");
const POLICY_V2 = policyFromRoster(rosterFixtureV2("roster-hera-v2.json"));
const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";
const WORK_LUNA = "openai-codex-3/gpt-6-luna";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const WORK_ASTRA = "openai-codex-3/gpt-6-astra";
const JEV = "openrouter/typesafe/jev-1.14";

beforeEach(resetSlot);
afterEach(resetSlot);

/** Hera's catalog, with prices on DeepSeek and a small model the reload test moves into the worker role. */
function priced(): FakeRuntime {
  const models = heraModels().map((entry) =>
    `${entry.provider}/${entry.id}` === DEEPSEEK ? { ...entry, cost: { input: 0.27, output: 1.1, cacheRead: 0, cacheWrite: 0 } } : entry,
  );
  return new FakeRuntime(new FakeCatalog([...models, model(QWEN, { baseUrl: OPENROUTER, contextWindow: 64_000, maxTokens: 8_000 })]));
}

const COMMANDS = [
  { name: "warden", source: "extension" },
  { name: "subs", source: "extension" },
  { name: "btw", source: "prompt" },
  { name: "skill:subagent", source: "skill" },
] as unknown as SlashCommandInfo[];
const TOOLS = ["read", "bash", "web_fetch", "batch_web_fetch", "web_search", "subagent", "agent_browser", "subagent"].map((name) => ({ name })) as unknown as ToolInfo[];
const EGRESS =
  "The pin covers smart-router/auto and smart-router/local only. Still able to send data off this machine: a model picked by hand with /model, which is sent as it is; /warden (pi-warden's judge sends redacted context to its backend while it is enabled); /subs (Multi-Pass can move the session to another subscription); the tools agent_browser, batch_web_fetch, subagent, web_fetch, web_search; Pi's own /share, /export and /bug.";
/** EGRESS with Hera's version 2 classifier behind the model picked by hand, as an unpinned session's status lists it. */
const EGRESS_JEV = EGRESS.replace(
  "which is sent as it is; ",
  `which is sent as it is; the classifier ${JEV} (smart-router/auto sends it each message and the recent conversation, redacted); `,
);

async function answer(loaded: Loaded, args: string): Promise<{ readonly message: string; readonly type: string }> {
  const before = loaded.session.notices.length;
  await loaded.host.command("smart-router", args);
  assert.equal(loaded.session.notices.length, before + 1, `/smart-router ${args} shows one notice`);
  const notice = loaded.session.notices.at(-1);
  assert.ok(notice !== undefined);
  return notice;
}

async function hera(t: Parameters<typeof agentDir>[0], files: Parameters<typeof agentDir>[1] = {}): Promise<Loaded> {
  const loaded = await start({ dir: agentDir(t, files), runtime: priced(), now: () => NOW });
  loaded.host.commandList = COMMANDS;
  loaded.host.tools = TOOLS;
  return loaded;
}

/** A session on Hera's version 2 roster and the priced catalog, with smart-router/auto selected, the clock at `now` and the session prepared by `setup`. */
async function heraV2(t: Parameters<typeof agentDir>[0], options: Partial<Omit<LoadOptions, "dir">> & { readonly select?: string } = {}): Promise<Loaded> {
  const loaded = await start({ dir: agentDir(t, { roster: HERA_V2 }), runtime: priced(), now: () => NOW, ...options });
  loaded.host.commandList = COMMANDS;
  loaded.host.tools = TOOLS;
  return loaded;
}

/** Record work scope in a session, as /smart-router scope work does. */
const workEntry = (session: FakeSession): void => session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - 60_000));

/** The data of the session's entries of one type, oldest first. */
const entriesOf = (loaded: Loaded, customType: string): Array<Record<string, unknown>> =>
  loaded.session.entries.filter((entry) => entry.customType === customType).map((entry) => entry.data as Record<string, unknown>);

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

/** A prompt's whole run: the idle input, the run's first request, the answer from the model it routed to, and the run's end. */
async function routeRun(loaded: Loaded, text: string): Promise<string> {
  await loaded.host.emit("input", { text, source: "interactive" });
  const signal = loaded.session.startRun();
  const route = loaded.runtime.route("auto", request("user", { signal }));
  const ref = `${route.model.provider}/${route.model.id}`;
  await loaded.host.emit("message_end", { message: assistant(ref) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
  return ref;
}

describe("status", () => {
  test("shows the roster, selection, pin, every role's candidates, accounts, routing, the last decision and what can still leave", async (t) => {
    const dir = agentDir(t);
    const loaded = await start({ dir, runtime: priced(), now: () => NOW });
    loaded.host.commandList = COMMANDS;
    loaded.host.tools = TOOLS;
    const { message, type } = await answer(loaded, "");
    assert.equal(type, "info");
    assert.equal(
      message,
      [
        "pi-smart-router status",
        `Roster: ${join(dir, "smart-router.json")}: valid, loaded at ${clock(NOW)}`,
        "Selection: smart-router/auto, thinking high",
        "Pin: off",
        "Roles on this host, cheapest first:",
        `  local (the local role; thinking max): ${GLM} ok`,
        `  worker: ${DEEPSEEK} ok ($0.27/$1.1 per 1M)`,
        `  thinker: ${KIMI} ok`,
        "  coder: openrouter/z-ai/glm-5.3 ok",
        `  engineer: ${SOL} ok`,
        `  architect: ${ASTRA} ok`,
        "Accounts:",
        '  openai-codex-2: bound to the Multi-Pass label "personal"; Multi-Pass labels it "personal"; auth configured (stored)',
        "Routing: default worker, trivial worker, complex engineer, planning architect; fallback engineer → coder, architect → thinker",
        "Last decision: none yet",
        EGRESS,
      ].join("\n"),
    );
    assert.deepEqual(await answer(loaded, "status"), { message, type });
  });

  test("shows each candidate's resolver reason, the pin's recorded policy and the last decision, and no lock line", async (t) => {
    const loaded = await hera(t);
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: "You've hit your usage limit." }) });
    await loaded.host.emit("input", { text: "plan the migration to the new store", source: "interactive" });
    const signal = loaded.session.startRun();
    loaded.runtime.route("auto", request("user", { signal }));
    loaded.session.endRun();
    await loaded.host.command("smart-router", "local on");
    // A model picked by hand under the pin is no conflict: status shows it as the selection, and no lock.
    await loaded.host.choose(KIMI);
    const picked = (await answer(loaded, "status")).message.split("\n");
    assert.ok(picked.includes(`Selection: ${KIMI}, thinking high`), picked.join("\n"));
    assert.ok(!picked.some((line) => /^Lock:|locked/.test(line)), picked.join("\n"));
    await loaded.host.choose("smart-router/local");
    const { message } = await answer(loaded, "status");
    const lines = message.split("\n");
    assert.ok(lines.includes(`Pin: on since ${AT}, with models ${GLM}; providers omlx-hera; hosts hera.lan`), message);
    assert.ok(!lines.some((line) => /^Lock:|locked/.test(line)), message);
    assert.ok(lines.includes(`  engineer: ${SOL} cooling-until-${clock(NOW + 30 * 60_000)}`), message);
    assert.ok(lines.includes("Selection: smart-router/local, thinking high"), message);
    assert.ok(lines.some((line) => new RegExp(`^Last decision: \\d\\d:\\d\\d:\\d\\d smart-router/auto user: architect → ${ASTRA.replace(/\//g, "\\/")} \\(signal:planning, planning:plan-words\\)$`).test(line)), message);
  });

  test("never shows a credential or an account label from Pi's auth status", async (t) => {
    const loaded = await hera(t);
    const registry = loaded.runtime.registry as unknown as Record<string, unknown>;
    registry.getProviderAuthStatus = () => ({ configured: true, source: "stored", label: "john@example.com" });
    const { message } = await answer(loaded, "status");
    assert.doesNotMatch(message, /john@example\.com/);
    assert.match(message, /auth configured \(stored\)/);
  });

  test("on the other hosts, shows the native login as an acknowledgement the router cannot verify", async (t) => {
    const loaded = await hera(t, { roster: fixture("roster-other-hosts.json") });
    const { message } = await answer(loaded, "status");
    assert.ok(
      message.includes(
        '  openai-codex: a native login acknowledged as "personal"; the router cannot verify a native login; run /smart-router status after every /login, /logout or /subs change; auth configured (stored)',
      ),
      message,
    );
    assert.ok(message.includes("  architect: openai-codex/gpt-6-astra not-in-catalog"), message);
  });

  test("shows a missing, invalid, unsafe or relative roster, and no roles", async (t) => {
    const cases: Array<[string, Parameters<typeof agentDir>[1], RegExp]> = [
      ["missing", { roster: null }, /smart-router\.json: missing, checked at \d\d:\d\d$/m],
      ["invalid", { roster: "{ nope" }, /smart-router\.json: invalid \(JSON syntax error/],
    ];
    for (const [name, files, pattern] of cases) {
      resetSlot();
      const loaded = await hera(t, files);
      const { message } = await answer(loaded, "status");
      assert.match(message, pattern, name);
      assert.doesNotMatch(message, /Roles on this host/, name);
    }
    resetSlot();
    const dir = agentDir(t);
    chmodSync(join(dir, "smart-router.json"), 0o664);
    const unsafe = await start({ dir, runtime: priced() });
    assert.match((await answer(unsafe, "status")).message, /smart-router\.json: unsafe \(.*writable by its group or by others/);
    resetSlot();
    const relative = await start({ dir: "relative/agent", runtime: priced() });
    assert.match((await answer(relative, "status")).message, /^Roster: relative\/agent\/smart-router\.json: invalid \(PI_CODING_AGENT_DIR is relative \(relative\/agent\)\), checked at \d\d:\d\d$/m);
  });

  test("warns about a fallback that moves a run onto Codex's API from another", async (t) => {
    const roster = JSON.parse(fixture("roster-hera.json"));
    roster.routing.fallback = { worker: "engineer", architect: "thinker" };
    const loaded = await hera(t, { roster: JSON.stringify(roster) });
    const warnings = (await answer(loaded, "status")).message.split("\n").filter((line) => line.startsWith("Warning:"));
    assert.deepEqual(warnings, [
      "Warning: the fallback worker → engineer moves a run onto the openai-codex-responses API mid-run, with a system prompt pi-cache-optimizer may have rewritten for worker, which Codex can refuse.",
    ]);
  });

  test("shows a version 2 roster's roles and accounts, with no routing line and no fallback warning", async (t) => {
    const loaded = await hera(t, { roster: fixture("roster-hera-v2.json") });
    const { message, type } = await answer(loaded, "status");
    assert.equal(type, "info", message);
    const lines = message.split("\n");
    assert.ok(lines.includes("Roles on this host, cheapest first:"), message);
    assert.ok(lines.includes("Accounts:"), message);
    // The session is in personal scope, so auto reaches only the personal levels.
    assert.ok(lines.includes(`  super: ${ASTRA} ok, ${KIMI} ok`), message);
    assert.ok(lines.includes("  work-super (smart-router/auto never routes here): openai-codex-3/gpt-6-astra excluded"), message);
    assert.deepEqual(
      lines.filter((line) => line.startsWith("Routing:") || line.startsWith("Warning:")),
      [],
    );
  });

  test("reports a failure instead of throwing", async (t) => {
    const dir = agentDir(t);
    let broken = false;
    const loaded = load({
      dir,
      build: (pi, options) =>
        createRouter(pi, {
          ...options,
          agentDir: () => {
            if (broken) throw new Error("the agent directory is gone");
            return dir;
          },
        }),
    });
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "startup" });
    broken = true;
    assert.deepEqual(await answer(loaded, "status"), { type: "error", message: "pi-smart-router: /smart-router failed: the agent directory is gone" });
  });
});

describe("history", () => {
  test("lists recent decisions with their codes, oldest first, ten by default and at most fifty", async (t) => {
    const loaded = await hera(t);
    assert.equal((await answer(loaded, "history")).message, "pi-smart-router: no routing decisions in this session yet.");
    for (let index = 0; index < 12; index += 1) loaded.runtime.route("auto", request("direct", { previous: { model: loaded.runtime.physical(KIMI), thinkingLevel: "high" } }));
    loaded.runtime.route("auto", request("direct"));
    const ten = (await answer(loaded, "history")).message.split("\n");
    assert.equal(ten[0], "pi-smart-router: the last 10 routing decisions, oldest first:");
    assert.equal(ten.length, 11);
    assert.match(ten.at(-1) ?? "", new RegExp(`^  \\d\\d:\\d\\d:\\d\\d smart-router/auto direct: worker → ${DEEPSEEK.replace(/\//g, "\\/")} \\(direct:default\\)$`));
    assert.match(ten[1] ?? "", /thinker → openrouter\/moonshotai\/kimi-k3\.1-pro \(direct:previous\)$/);
    assert.equal((await answer(loaded, "history 2")).message.split("\n").length, 3);
    assert.equal((await answer(loaded, "history 99")).message.split("\n").length, 14, "every decision kept, capped at fifty");
    for (const args of ["history 0", "history x", "history 1 2", "history -3"]) {
      assert.deepEqual(await answer(loaded, args), { type: "warning", message: USAGE }, args);
    }
  });
});

describe("local", () => {
  test("on pins, switches the selection, warns about turns that already left, and lists what can still leave", async (t) => {
    const loaded = await hera(t);
    loaded.session.appendAssistant(assistant(SOL, { timestamp: NOW - 60_000 }));
    loaded.session.appendAssistant(assistant("smart-router/auto", { api: "pi-virtual", stopReason: "error", errorMessage: "refused" }));
    const { message, type } = await answer(loaded, "local on");
    assert.equal(type, "info");
    assert.deepEqual(message.split("\n"), [
      `pi-smart-router: this session is pinned to local models, with models ${GLM}; providers omlx-hera; hosts hera.lan.`,
      "The selection is smart-router/local now.",
      `Earlier turns of this branch went to ${SOL}, which is not local: they have already left this machine, and the pin protects only what follows.`,
      EGRESS,
    ]);
    assert.deepEqual(loaded.session.pinEntries(), [{ v: 1, on: true, at: AT, local: { refs: [GLM], providers: ["omlx-hera"], hosts: ["hera.lan"] } }]);
    assert.equal(loaded.session.statuses.get("smart-router"), "local models");
  });

  test("on does not warn when the latest response came from a local model, and keeps a local selection", async (t) => {
    const loaded = await hera(t);
    await loaded.host.choose(GLM);
    loaded.session.appendAssistant(assistant(SOL, { timestamp: NOW - 120_000 }));
    loaded.session.appendAssistant(assistant(GLM, { timestamp: NOW - 60_000 }));
    const { message } = await answer(loaded, "local on");
    assert.deepEqual(message.split("\n").slice(0, 2), [`pi-smart-router: this session is pinned to local models, with models ${GLM}; providers omlx-hera; hosts hera.lan.`, EGRESS]);
    assert.equal(loaded.session.model?.provider, "omlx-hera");
  });

  test("on asks for local routing, so it selects smart-router/local over a model picked by hand outside the policy; a later pick by hand is kept", async (t) => {
    const loaded = await hera(t);
    await loaded.host.choose(KIMI);
    const { message, type } = await answer(loaded, "local on");
    assert.equal(type, "info");
    assert.equal(message.split("\n")[1], "The selection is smart-router/local now.");
    assert.equal(loaded.session.model?.id, "local");
    // After the command, the selection is John's again: a pick by hand stays, and the pin's item is not shown over it.
    await loaded.host.choose(KIMI);
    assert.deepEqual([`${loaded.session.model?.provider}/${loaded.session.model?.id}`, loaded.session.statuses.get("smart-router")], [KIMI, undefined]);
    assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [undefined], "and its prompt is sent");
  });

  test("on, when smart-router/local cannot be selected, says that the selection stays and is sent as it is", async (t) => {
    const loaded = await hera(t);
    await loaded.host.choose(KIMI);
    loaded.host.setModel = async () => false;
    const { message, type } = await answer(loaded, "local on");
    assert.equal(type, "warning");
    assert.equal(
      message.split("\n")[1],
      `The selection ${KIMI} could not be switched to smart-router/local and stays as it is. Choose smart-router/local with /model: the pin routes only the router's own two models, and a model picked by hand is sent as it is.`,
    );
    assert.equal(`${loaded.session.model?.provider}/${loaded.session.model?.id}`, KIMI);
    assert.equal(loaded.session.statuses.get("smart-router"), undefined);
  });

  test("on with an invalid roster pins with an empty policy and says how to fix it", async (t) => {
    const loaded = await hera(t, { roster: "{ nope" });
    const { message, type } = await answer(loaded, "local on");
    assert.equal(type, "warning");
    assert.match(message, /^pi-smart-router: this session is pinned to local models, but the roster is invalid, so the pin has an empty policy and no model qualifies\. Fix the roster, then run \/smart-router local on again\.$/m);
    assert.deepEqual(loaded.session.pinEntries(), [{ v: 1, on: true, at: AT, local: { refs: [], providers: [], hosts: [] } }]);
    assert.equal(loaded.session.model?.id, "local");
  });

  test("on without a local section pins with an empty policy", async (t) => {
    const roster = JSON.parse(fixture("roster-hera.json"));
    delete roster.local;
    const loaded = await hera(t, { roster: JSON.stringify(roster) });
    assert.match((await answer(loaded, "local on")).message, /but the roster has no local section, so the pin has an empty policy/);
  });

  test("on where pins cannot be read refuses", async (t) => {
    const loaded = await start({ dir: agentDir(t), bounded: false });
    assert.match((await answer(loaded, "local on")).message, /cannot read pin entries .* so every session already counts as pinned/);
    assert.deepEqual(loaded.session.pinEntries(), []);
  });

  test("status shows the pin and what can still leave", async (t) => {
    const loaded = await hera(t);
    assert.deepEqual((await answer(loaded, "local status")).message.split("\n"), ["pi-smart-router: pin off.", EGRESS]);
    loaded.session.pin(POLICY);
    assert.match((await answer(loaded, "local")).message, /^pi-smart-router: pin on since /);
  });
});

describe("reload", () => {
  test("reads both files again now and registers both models again when their limits changed", async (t) => {
    const dir = agentDir(t);
    const path = join(dir, "smart-router.json");
    const loaded = await start({ dir, runtime: priced(), now: () => NOW });
    const definitions = loaded.host.definitions.length;
    const unchanged = await answer(loaded, "reload");
    assert.equal(unchanged.message, `pi-smart-router: reloaded the roster, ${path}: valid, loaded at ${clock(NOW)}; Multi-Pass's labels read.`);
    assert.equal(loaded.host.definitions.length, definitions, "unchanged limits: nothing registered");
    const roster = JSON.parse(fixture("roster-hera.json"));
    roster.roles[1].models = [QWEN];
    writeFileSync(path, JSON.stringify(roster));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    const { message, type } = await answer(loaded, "reload");
    assert.equal(type, "info");
    assert.match(message, /and registered both models again with their new limits\.$/);
    assert.equal(loaded.host.definitions.length, definitions + 2);
    assert.deepEqual(loaded.router?.limits().auto, { contextWindow: 64_000, maxTokens: 8_000 });
    writeFileSync(path, "{ nope");
    const broken = await answer(loaded, "reload");
    assert.equal(broken.type, "warning");
    assert.match(broken.message, /smart-router\.json: invalid \(JSON syntax error/);
  });

  test("unknown subcommands get the usage", async (t) => {
    const loaded = await hera(t);
    for (const args of ["bogus", "status now", "local maybe", "local on now", "reload now", "scope team", "scope work now", "scope Work", "was", "was trivial", "was h", "was high now"]) {
      assert.deepEqual(await answer(loaded, args), { type: "warning", message: USAGE }, args);
    }
    assert.equal(loaded.host.commands.get("smart-router")?.description, "Smart Router: status, history [n], local on|off|status, scope [work|personal|status], was low|medium|high|super, reload");
  });
});


describe("status under a version 2 roster", () => {
  test("shows the scope, the roles, each account in the session's scope, every scope's levels, the classifier, and the classifier among what can still leave", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await start({ dir, runtime: priced(), now: () => NOW });
    loaded.host.commandList = COMMANDS;
    loaded.host.tools = TOOLS;
    const { message, type } = await answer(loaded, "status");
    assert.equal(type, "info");
    assert.equal(
      message,
      [
        "pi-smart-router status",
        `Roster: ${join(dir, "smart-router.json")}: valid, loaded at ${clock(NOW)}`,
        "Selection: smart-router/auto, thinking high",
        "Pin: off",
        "Scope: personal (default)",
        "Roles on this host, cheapest first:",
        `  local (the local role; thinking max): ${GLM} ok`,
        `  low: ${LUNA} not-in-catalog, ${NYX_QWEN} not-in-catalog, ${HERA_QWEN} not-in-catalog`,
        `  medium: ${TERRA} not-in-catalog, ${DEEPSEEK} ok ($0.27/$1.1 per 1M)`,
        `  high: ${SOL} ok, ${GLM_CLOUD} ok`,
        `  super: ${ASTRA} ok, ${KIMI} ok`,
        `  work-low (smart-router/auto never routes here): ${WORK_LUNA} excluded`,
        `  work-medium (smart-router/auto never routes here): ${WORK_TERRA} excluded`,
        `  work-high (smart-router/auto never routes here): ${WORK_SOL} excluded`,
        `  work-super (smart-router/auto never routes here): ${WORK_ASTRA} excluded`,
        "Accounts:",
        '  openai-codex-2: bound to the Multi-Pass label "personal"; Multi-Pass labels it "personal"; auth configured (stored)',
        '  openai-codex-3: bound to the Multi-Pass label "Positron work"; refused: the roster binds openai-codex-3 to the work scope, but this session is in the personal scope; auth configured (stored)',
        `Levels (personal): LOW → ${LUNA} not-in-catalog, ${NYX_QWEN} not-in-catalog, ${HERA_QWEN} not-in-catalog; MEDIUM → ${TERRA} not-in-catalog, ${DEEPSEEK} ok; HIGH → ${SOL} ok, ${GLM_CLOUD} ok; SUPER → ${ASTRA} ok, ${KIMI} ok`,
        `Levels (work): LOW → ${WORK_LUNA} not-in-catalog; MEDIUM → ${WORK_TERRA} not-in-catalog; HIGH → ${WORK_SOL} ok; SUPER → ${WORK_ASTRA} not-in-catalog`,
        `Classifier: ${JEV}, 1000 ms, close call 0.15`,
        "Last decision: none yet",
        EGRESS_JEV,
      ].join("\n"),
    );
  });

  test("in work scope, checks each account in work scope, so the work alias is not refused there and the personal one is", async (t) => {
    const loaded = await heraV2(t, { setup: workEntry });
    const lines = (await answer(loaded, "status")).message.split("\n");
    assert.ok(lines.includes("Scope: work (entry)"), lines.join("\n"));
    assert.deepEqual(
      lines.filter((line) => line.startsWith("  openai-codex-")),
      [
        '  openai-codex-2: bound to the Multi-Pass label "personal"; refused: the roster binds openai-codex-2 to the personal scope, but this session is in the work scope; auth configured (stored)',
        '  openai-codex-3: bound to the Multi-Pass label "Positron work"; Multi-Pass labels it "Positron work"; auth configured (stored)',
      ],
    );
  });

  test("a roster without a classifier says so, and lists no classifier among what can still leave; a pinned session lists none either", async (t) => {
    const roster = JSON.parse(HERA_V2);
    delete roster.classifier;
    const none = await hera(t, { roster: JSON.stringify(roster) });
    const lines = (await answer(none, "status")).message.split("\n");
    assert.ok(lines.includes("Classifier: none, so the keyword classifier decides every level"), lines.join("\n"));
    assert.equal(lines.at(-1), EGRESS);
    resetSlot();
    const pinned = await heraV2(t, { select: "local", setup: (session) => session.pin(POLICY_V2) });
    assert.equal((await answer(pinned, "status")).message.split("\n").at(-1), EGRESS);
    assert.deepEqual((await answer(pinned, "local status")).message.split("\n").slice(1), [EGRESS]);
    resetSlot();
    const unpinned = await heraV2(t);
    assert.deepEqual((await answer(unpinned, "local status")).message.split("\n"), ["pi-smart-router: pin off.", EGRESS_JEV]);
  });
});

describe("no lock", () => {
  const lockLines = (message: string): string[] => message.split("\n").filter((line) => /^Lock:|locked/.test(line));

  test("status and local status show no lock line, in work scope, pinned or personal, however often a model is picked by hand", async (t) => {
    const pinnedWork = (session: FakeSession): void => {
      workEntry(session);
      session.pin(POLICY_V2);
    };
    for (const [id, setup] of [["work", workEntry], ["pinned", pinnedWork], ["personal", undefined]] as const) {
      const loaded = await heraV2(t, { id, runtime: priced(), ...(setup === undefined ? {} : { setup }) });
      for (const ref of [KIMI, SOL, KIMI, SOL]) await loaded.host.choose(ref);
      assert.deepEqual(lockLines((await answer(loaded, "status")).message), [], id);
      assert.deepEqual(lockLines((await answer(loaded, "local status")).message), [], id);
      assert.equal(`${loaded.session.model?.provider}/${loaded.session.model?.id}`, SOL, id);
    }
  });
});

describe("history under a version 2 roster", () => {
  test("a run's planned request ends with its scope, tier and what decided it", async (t) => {
    const loaded = await heraV2(t);
    await loaded.host.emit("input", { text: "x #high", source: "interactive" });
    const signal = loaded.session.startRun();
    loaded.runtime.route("auto", request("user", { signal }));
    loaded.runtime.route("auto", request("continuation", { signal }));
    loaded.session.endRun();
    const lines = (await answer(loaded, "history")).message.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[1] ?? "", /^ {2}\d\d:\d\d:\d\d smart-router\/auto user: high → openai-codex-2\/gpt-6\.1-sol \(tag, triage:no_fast_path\) \[personal HIGH \(tag\)\]$/);
    assert.match(lines[2] ?? "", /^ {2}\d\d:\d\d:\d\d smart-router\/auto continuation: high → openai-codex-2\/gpt-6\.1-sol \(stick:run\)$/);
  });
});

describe("scope", () => {
  const MOVE = "Move this session to personal scope?\nIts earlier turns are work content, and the next requests would send them to personal accounts.";
  const KEEP_WORK = "Keep this session in work scope";
  const TO_PERSONAL = "Move it to personal scope (earlier turns are work content)";
  const STAYS = { type: "info", message: "pi-smart-router: the session stays in work scope." };

  test("work records an entry; status, the default subcommand, reads the scope as routing does", async (t) => {
    const loaded = await heraV2(t);
    assert.deepEqual(await answer(loaded, "scope"), { type: "info", message: "pi-smart-router: scope personal (default)." });
    assert.deepEqual(await answer(loaded, "scope work"), { type: "info", message: "pi-smart-router: scope work (entry)." });
    assert.deepEqual(await answer(loaded, "scope status"), { type: "info", message: "pi-smart-router: scope work (entry)." });
    assert.deepEqual(entriesOf(loaded, SCOPE_ENTRY), [{ v: 1, scope: "work", by: "command", at: NOW }]);
  });

  test("work with a roster that serves no work scope says smart-router/auto refuses, and the way out, which the latch narrows", async (t) => {
    const loaded = await hera(t);
    assert.deepEqual(await answer(loaded, "scope work"), {
      type: "warning",
      message:
        "pi-smart-router: scope work (entry).\nIt is in work scope, which a version 1 roster does not serve, so smart-router/auto refuses its requests: give the roster a work scope (version 2), or run /smart-router scope personal.",
    });
    resetSlot();
    await withScope("work", async () => {
      const latched = await hera(t);
      assert.deepEqual(await answer(latched, "scope work"), {
        type: "warning",
        message:
          "pi-smart-router: scope work (latch).\nIt is in work scope, which a version 1 roster does not serve, so smart-router/auto refuses its requests: give the roster a work scope (version 2).",
      });
    });
  });

  test("work in a pinned session records the entry and leaves the selection: smart-router/local routes locally there, and a model picked by hand is sent as it is", async (t) => {
    const loaded = await heraV2(t, { select: "local", setup: (session) => session.pin(POLICY_V2) });
    assert.deepEqual(await answer(loaded, "scope work"), { type: "info", message: "pi-smart-router: scope work (entry)." });
    assert.equal(`${loaded.session.model?.provider}/${loaded.session.model?.id}`, "smart-router/local");
    await loaded.host.choose(KIMI);
    assert.deepEqual(await answer(loaded, "scope work"), {
      type: "info",
      message: `pi-smart-router: scope work (entry).\nThe selection stays ${KIMI}. A model picked by hand is sent as it is, in work scope too.`,
    });
    assert.equal(`${loaded.session.model?.provider}/${loaded.session.model?.id}`, KIMI);
  });

  test("work leaves a model picked by hand selected, and says that it is sent as it is; nothing is selected in its place", async (t) => {
    for (const ref of [KIMI, SOL, WORK_SOL, GLM]) {
      resetSlot();
      const loaded = await heraV2(t);
      await loaded.host.choose(ref);
      const selections = loaded.host.selections.length;
      assert.deepEqual(await answer(loaded, "scope work"), {
        type: "info",
        message: `pi-smart-router: scope work (entry).\nThe selection stays ${ref}. A model picked by hand is sent as it is, in work scope too.`,
      });
      assert.deepEqual([`${loaded.session.model?.provider}/${loaded.session.model?.id}`, loaded.host.selections.length], [ref, selections], ref);
      assert.deepEqual(await loaded.host.emit("input", { text: "fix the build", source: "interactive" }), [undefined], `${ref}: the next prompt is sent`);
    }
  });

  test("work leaves smart-router/local selected, and says that it routes to the local models without the pin", async (t) => {
    const loaded = await heraV2(t, { select: "local" });
    assert.deepEqual(await answer(loaded, "scope work"), {
      type: "info",
      message:
        "pi-smart-router: scope work (entry).\nThe selection stays smart-router/local. In work scope smart-router/local routes to the local models without the pin, so its next requests go to them, not to the work account.",
    });
    assert.deepEqual([`${loaded.session.model?.provider}/${loaded.session.model?.id}`, loaded.host.selections.length], ["smart-router/local", 0]);
    // Under a roster that serves no work scope it says the same of smart-router/local, and warns that smart-router/auto refuses.
    resetSlot();
    const v1 = await hera(t);
    await v1.host.choose("smart-router/local");
    assert.deepEqual(await answer(v1, "scope work"), {
      type: "warning",
      message:
        "pi-smart-router: scope work (entry).\nThe selection stays smart-router/local. In work scope smart-router/local routes to the local models without the pin, so its next requests go to them, not to the work account.\nIt is in work scope, which a version 1 roster does not serve, so smart-router/auto refuses its requests: give the roster a work scope (version 2), or run /smart-router scope personal.",
    });
  });

  test("personal leaves the selection as it is, a model picked by hand and either of the router's", async (t) => {
    for (const ref of [KIMI, "smart-router/local", "smart-router/auto"]) {
      resetSlot();
      const loaded = await heraV2(t, { setup: workEntry });
      if (ref !== "smart-router/auto") await loaded.host.choose(ref);
      const selections = loaded.host.selections.length;
      loaded.session.dialogKeys = ["down", "enter"];
      assert.deepEqual(await answer(loaded, "scope personal"), { type: "warning", message: "pi-smart-router: scope personal (entry)." });
      assert.deepEqual([`${loaded.session.model?.provider}/${loaded.session.model?.id}`, loaded.host.selections.length], [ref, selections], ref);
    }
  });

  test("status reads the work directories as the roster lists them now, and an unreadable scope says why", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await start({ dir, id: "acme", cwd: "/Users/johnw/src/acme/app", runtime: priced(), now: () => NOW });
    const roster = JSON.parse(HERA_V2);
    roster.scopes.work.directories = ["/Users/johnw/src/acme"];
    const path = join(dir, "smart-router.json");
    writeFileSync(path, JSON.stringify(roster));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    assert.deepEqual(await answer(loaded, "scope status"), { type: "info", message: "pi-smart-router: scope work (directory)." });
    assert.deepEqual(entriesOf(loaded, SCOPE_ENTRY), [], "the scope command records nothing it was not asked to");
    const malformed = await heraV2(t, { id: "malformed", setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    assert.deepEqual(await answer(malformed, "scope"), {
      type: "warning",
      message:
        "pi-smart-router: this session's scope cannot be read (the latest smart-router.scope entry is not one the router wrote), so smart-router/auto refuses it until /smart-router scope work or /smart-router scope personal records it again.",
    });
  });

  test("personal from work asks, with the answer that keeps work scope first, so Enter keeps it; only the second answer moves the session", async (t) => {
    const loaded = await heraV2(t, { setup: workEntry });
    assert.deepEqual(await answer(loaded, "scope personal"), STAYS);
    assert.deepEqual(loaded.session.dialogs, [{ title: MOVE, options: [KEEP_WORK, TO_PERSONAL] }]);
    for (const keys of [["escape"], [], ["down"], ["down", "escape"], ["down", "up", "enter"]] as const) {
      loaded.session.dialogKeys = [...keys];
      assert.deepEqual(await answer(loaded, "scope personal"), STAYS, keys.join(" "));
    }
    assert.equal(entriesOf(loaded, SCOPE_ENTRY).length, 1, "nothing was written");
    loaded.session.dialogKeys = ["down", "enter"];
    assert.deepEqual(await answer(loaded, "scope personal"), { type: "warning", message: "pi-smart-router: scope personal (entry)." });
    assert.deepEqual(entriesOf(loaded, SCOPE_ENTRY).at(-1), { v: 1, scope: "personal", by: "command", at: NOW });
    // From personal there is nothing to confirm.
    const dialogs = loaded.session.dialogs.length;
    assert.deepEqual(await answer(loaded, "scope personal"), { type: "info", message: "pi-smart-router: scope personal (entry)." });
    assert.equal(loaded.session.dialogs.length, dialogs);
  });

  test("an RPC client's answer moves the session only when it is exactly the second answer", async (t) => {
    const loaded = await heraV2(t, { setup: workEntry });
    const ui = loaded.session.ctx.ui as unknown as Record<string, unknown>;
    for (const reply of ["Yes", "Move it to personal scope", ` ${TO_PERSONAL}`, KEEP_WORK, "", undefined]) {
      ui.select = async () => reply;
      assert.deepEqual(await answer(loaded, "scope personal"), STAYS, String(reply));
    }
    ui.select = async () => TO_PERSONAL;
    assert.deepEqual(await answer(loaded, "scope personal"), { type: "warning", message: "pi-smart-router: scope personal (entry)." });
  });

  test("personal from the work scope the work directories give asks too, before its entry is recorded and after", async (t) => {
    const dir = agentDir(t, { roster: HERA_V2 });
    const loaded = await start({ dir, id: "acme", cwd: "/Users/johnw/src/acme/app", runtime: priced(), now: () => NOW });
    const roster = JSON.parse(HERA_V2);
    roster.scopes.work.directories = ["/Users/johnw/src/acme"];
    const path = join(dir, "smart-router.json");
    writeFileSync(path, JSON.stringify(roster));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    assert.deepEqual(await answer(loaded, "scope personal"), STAYS);
    assert.deepEqual([loaded.session.dialogs.length, entriesOf(loaded, SCOPE_ENTRY)], [1, []], "work (directory), unrecorded");
    const recorded = await heraV2(t, { id: "recorded", cwd: "/Users/johnw/src/positron/app" });
    assert.deepEqual(entriesOf(recorded, SCOPE_ENTRY).map((entry) => entry.by), ["directory"]);
    assert.deepEqual(await answer(recorded, "scope personal"), STAYS);
    assert.equal(recorded.session.dialogs.length, 1);
  });

  test("personal under PI_SMART_ROUTER_SCOPE is refused, without a dialog", async (t) => {
    await withScope("work", async () => {
      const loaded = await heraV2(t);
      loaded.session.dialogKeys = ["down", "enter"];
      assert.deepEqual(await answer(loaded, "scope personal"), {
        type: "warning",
        message: "pi-smart-router: PI_SMART_ROUTER_SCOPE pins every session of this process to work scope, so this one cannot be moved to personal.",
      });
      assert.deepEqual([loaded.session.dialogs, entriesOf(loaded, SCOPE_ENTRY)], [[], []]);
      assert.deepEqual(await answer(loaded, "scope"), { type: "info", message: "pi-smart-router: scope work (latch)." });
      // Work is recorded all the same, so the session stays in work scope wherever it is resumed.
      assert.deepEqual(await answer(loaded, "scope work"), { type: "info", message: "pi-smart-router: scope work (latch)." });
      assert.deepEqual(entriesOf(loaded, SCOPE_ENTRY), [{ v: 1, scope: "work", by: "command", at: NOW }]);
    });
  });

  test("personal without dialogs is refused, and from an unreadable scope it asks", async (t) => {
    const headless = await heraV2(t, { id: "headless", setup: workEntry });
    headless.session.hasUI = false;
    assert.deepEqual(await answer(headless, "scope personal"), {
      type: "warning",
      message: "pi-smart-router: /smart-router scope personal asks for confirmation, and this mode has no dialogs, so the session stays in work scope.",
    });
    assert.deepEqual([headless.session.dialogs, entriesOf(headless, SCOPE_ENTRY).length], [[], 1]);
    const malformed = await heraV2(t, { id: "malformed", setup: (session) => session.appendCustom(SCOPE_ENTRY, { v: 9 }) });
    malformed.session.dialogKeys = ["down", "enter"];
    assert.deepEqual(await answer(malformed, "scope personal"), { type: "warning", message: "pi-smart-router: scope personal (entry)." });
    assert.equal(malformed.session.dialogs.length, 1);
  });
});

describe("was", () => {
  test("after a routed run, appends a correction that refers to the run, and a correction after it refers to the same run", async (t) => {
    let now = NOW;
    const loaded = await start({ dir: agentDir(t, { roster: HERA_V2 }), runtime: priced(), now: () => now });
    assert.equal(await routeRun(loaded, "x #super"), ASTRA);
    const [run] = entriesOf(loaded, LEVEL_ENTRY);
    assert.deepEqual([run?.at, run?.source, run?.tier, run?.ref], [NOW, "tag", "super", ASTRA]);
    now = NOW + 60_000;
    assert.deepEqual(await answer(loaded, "was high"), { type: "info", message: "pi-smart-router: recorded that the last run should have been HIGH." });
    now = NOW + 120_000;
    assert.deepEqual(await answer(loaded, "was LOW"), { type: "info", message: "pi-smart-router: recorded that the last run should have been LOW." });
    assert.deepEqual(entriesOf(loaded, LEVEL_ENTRY).slice(1), [
      { v: 1, at: NOW + 60_000, scope: "personal", source: "correction", tier: "high", refers: NOW },
      { v: 1, at: NOW + 120_000, scope: "personal", source: "correction", tier: "low", refers: NOW },
    ]);
    assert.ok(
      loaded.session.boundedReads.some((read) => isDeepStrictEqual(read, { customType: LEVEL_ENTRY, scope: "active" })),
      "the latest level entry of the branch, through the bounded reader",
    );
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("while a run is in flight, corrects that run, which has no record until it settles: a session's first run, and a later one", async (t) => {
    let now = NOW;
    const loaded = await start({ dir: agentDir(t, { roster: HERA_V2 }), runtime: priced(), now: () => now });
    /** A prompt whose run has started, as Pi starts it, made its first request, and not yet settled. */
    const inFlight = async (text: string, prompt: string): Promise<void> => {
      await loaded.host.emit("input", { text, source: "interactive" });
      const signal = loaded.session.startRun();
      await loaded.host.emit("before_agent_start", { messageType: "user", prompt });
      loaded.runtime.route("auto", request("user", { signal }));
    };
    const settles = async (ref: string): Promise<void> => {
      await loaded.host.emit("message_end", { message: assistant(ref) });
      await loaded.host.emit("agent_settled", { aborted: false });
      loaded.session.endRun();
    };
    await inFlight("x #super", "x");
    now = NOW + 10_000;
    assert.deepEqual(await answer(loaded, "was high"), { type: "info", message: "pi-smart-router: recorded that the last run should have been HIGH." });
    await settles(ASTRA);
    now = NOW + 60_000;
    await inFlight("y #high", "y");
    now = NOW + 70_000;
    // The correction names the run's scope, whatever the session's is by then.
    assert.equal((await answer(loaded, "scope work")).message, "pi-smart-router: scope work (entry).");
    assert.deepEqual(await answer(loaded, "was super"), { type: "info", message: "pi-smart-router: recorded that the last run should have been SUPER." });
    await settles(SOL);
    assert.deepEqual(
      entriesOf(loaded, LEVEL_ENTRY).map((entry) => [entry.source, entry.at, entry.scope, entry.tier, entry.refers]),
      [
        ["correction", NOW + 10_000, "personal", "high", NOW],
        ["tag", NOW, "personal", "super", undefined],
        ["correction", NOW + 70_000, "personal", "super", NOW + 60_000],
        ["tag", NOW + 60_000, "personal", "high", undefined],
      ],
    );
  });

  test("while idle, a message that planned but whose run has not started is not the run corrected", async (t) => {
    let now = NOW;
    const loaded = await start({ dir: agentDir(t, { roster: HERA_V2 }), runtime: priced(), now: () => now });
    assert.equal(await routeRun(loaded, "x #super"), ASTRA);
    now = NOW + 60_000;
    // A later extension handles this message, so its run never starts, and its level stays pending.
    await loaded.host.emit("input", { text: "y #high", source: "interactive" });
    assert.equal(loaded.router?.record(loaded.session.id)?.pendingLevel?.at, NOW + 60_000);
    assert.deepEqual(await answer(loaded, "was low"), { type: "info", message: "pi-smart-router: recorded that the last run should have been LOW." });
    assert.equal(entriesOf(loaded, LEVEL_ENTRY).at(-1)?.refers, NOW);
  });

  test("after a run ends and before its record is written, corrects that run, not the one before it (W1)", async (t) => {
    let now = NOW;
    const loaded = await start({ dir: agentDir(t, { roster: HERA_V2 }), runtime: priced(), now: () => now });
    assert.equal(await routeRun(loaded, "x #super"), ASTRA);
    now = NOW + 60_000;
    await loaded.host.emit("input", { text: "y #high", source: "interactive" });
    const signal = loaded.session.startRun();
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "y" });
    loaded.runtime.route("auto", request("user", { signal }));
    await loaded.host.emit("message_end", { message: assistant(SOL) });
    // The run is over, so the session is idle, but an extension's agent_settled handler that runs
    // before the router's still holds the run's end: the run's record is not written yet.
    loaded.session.endRun();
    now = NOW + 70_000;
    assert.deepEqual(await answer(loaded, "was low"), { type: "info", message: "pi-smart-router: recorded that the last run should have been LOW." });
    await loaded.host.emit("agent_settled", { aborted: false });
    assert.deepEqual(
      entriesOf(loaded, LEVEL_ENTRY).map((entry) => [entry.source, entry.at, entry.tier, entry.refers]),
      [
        ["tag", NOW, "super", undefined],
        ["correction", NOW + 70_000, "low", NOW + 60_000],
        ["tag", NOW + 60_000, "high", undefined],
      ],
    );
  });

  test("while a custom message's run is under way, a level no run took is never the run corrected (W2)", async (t) => {
    let now = NOW;
    const loaded = await start({ dir: agentDir(t, { roster: HERA_V2 }), runtime: priced(), now: () => now });
    assert.equal(await routeRun(loaded, "x #super"), ASTRA);
    now = NOW + 60_000;
    // A later extension handles this message, so its run never starts, and its level stays pending.
    await loaded.host.emit("input", { text: "y #high", source: "interactive" });
    assert.equal(loaded.router?.record(loaded.session.id)?.pendingLevel?.at, NOW + 60_000);
    // A custom message's run starts, before Pi reaches the router's before_agent_start, and after.
    loaded.session.startRun();
    now = NOW + 70_000;
    assert.deepEqual(await answer(loaded, "was low"), { type: "info", message: "pi-smart-router: recorded that the last run should have been LOW." });
    await loaded.host.emit("before_agent_start", { messageType: "custom", message: { role: "custom", customType: "goal-x", content: "continue", display: false, timestamp: NOW } });
    now = NOW + 80_000;
    assert.deepEqual(await answer(loaded, "was medium"), { type: "info", message: "pi-smart-router: recorded that the last run should have been MEDIUM." });
    assert.deepEqual(
      entriesOf(loaded, LEVEL_ENTRY).slice(1).map((entry) => [entry.at, entry.tier, entry.refers]),
      [
        [NOW + 70_000, "low", NOW],
        [NOW + 80_000, "medium", NOW],
      ],
      "both name the latest run, never the level no run took",
    );
  });

  test("with no routed run in the session, says so and records nothing: a new session, and a version 1 roster's runs, which have no level", async (t) => {
    const fresh = await heraV2(t, { id: "fresh" });
    const v1 = await hera(t);
    assert.equal(await routeRun(v1, "x"), DEEPSEEK);
    for (const loaded of [fresh, v1]) {
      assert.deepEqual(await answer(loaded, "was high"), { type: "warning", message: "pi-smart-router: no routed run to correct in this session yet." }, loaded.session.id);
      assert.deepEqual(entriesOf(loaded, LEVEL_ENTRY), [], loaded.session.id);
    }
  });

  test("does not correct a latest level entry the router did not write", async (t) => {
    const loaded = await heraV2(t);
    await routeRun(loaded, "x #high");
    const malformed: ReadonlyArray<readonly [unknown, "custom" | "custom_message"]> = [
      [{ v: 2, at: NOW, scope: "personal", source: "tag", tier: "high" }, "custom"],
      [{ v: 1, at: NOW, scope: "personal", source: "correction", tier: "high" }, "custom"],
      ["high", "custom"],
      [{ v: 1, at: NOW, scope: "personal", source: "tag", tier: "high" }, "custom_message"],
    ];
    for (const [data, type] of malformed) {
      loaded.session.appendCustom(LEVEL_ENTRY, data, type);
      const before = loaded.session.entries.length;
      assert.deepEqual(await answer(loaded, "was low"), {
        type: "warning",
        message: "pi-smart-router: the latest smart-router.level entry is not one the router wrote, so there is no run to correct.",
      });
      assert.equal(loaded.session.entries.length, before, JSON.stringify(data));
    }
  });
});

describe("local off in work scope", () => {
  const UNPINS = ["down", "enter"] as const;
  const selection = (loaded: Loaded): string => `${loaded.session.model?.provider}/${loaded.session.model?.id}`;
  /** A pinned session in work scope, or with a scope entry the router did not write, on smart-router/local. */
  const pinnedWork = (t: Parameters<typeof agentDir>[0], id: string, scope: unknown = scopeEntry("work", "command", NOW - 60_000)) =>
    heraV2(t, {
      id,
      select: "local",
      setup: (session) => {
        session.appendCustom(SCOPE_ENTRY, scope);
        session.pin(POLICY_V2);
      },
    });

  const LOCAL_IN_WORK = "In work scope smart-router/local routes to the local models without the pin, so its next requests go to them, not to the work account.";
  const STAYS_LOCAL = "pi-smart-router: this session is no longer pinned, and the selection stays smart-router/local.";

  test("leaves smart-router/local selected, and says that its requests still go to the local models", async (t) => {
    const loaded = await pinnedWork(t, "work");
    loaded.session.dialogKeys = [...UNPINS];
    assert.deepEqual(await answer(loaded, "local off"), {
      type: "warning",
      message: `${STAYS_LOCAL} ${LOCAL_IN_WORK}`,
    });
    assert.deepEqual([selection(loaded), loaded.host.selections.length], ["smart-router/local", 0], "unpinning selects nothing");
    assert.deepEqual(entriesOf(loaded, PIN_ENTRY).at(-1), { v: 1, on: false, at: AT });
    assert.equal(loaded.session.statuses.get("smart-router"), undefined, "the pin's item is cleared");
  });

  test("leaves smart-router/auto selected, and says the next requests go to the work account", async (t) => {
    const loaded = await pinnedWork(t, "auto");
    await loaded.host.choose("smart-router/auto");
    loaded.session.dialogKeys = [...UNPINS];
    assert.deepEqual(await answer(loaded, "local off"), {
      type: "warning",
      message: "pi-smart-router: this session is no longer pinned, and the selection stays smart-router/auto. It is in work scope, so the next requests go to the work account.",
    });
  });

  test("leaves a model picked by hand selected, a work Codex model or any other, and says that it is sent as it is", async (t) => {
    for (const ref of [WORK_SOL, KIMI, SOL]) {
      resetSlot();
      const loaded = await pinnedWork(t, "hand");
      await loaded.host.choose(ref);
      const selections = loaded.host.selections.length;
      loaded.session.dialogKeys = [...UNPINS];
      assert.deepEqual(await answer(loaded, "local off"), {
        type: "warning",
        message: `pi-smart-router: this session is no longer pinned, and the selection stays ${ref}. A model picked by hand is sent as it is, in work scope too.`,
      });
      assert.deepEqual([selection(loaded), loaded.host.selections.length], [ref, selections], ref);
    }
  });

  test("with a scope that cannot be read, leaves the selection, and says that the router's model refuses until a scope is recorded", async (t) => {
    const UNTIL = "until /smart-router scope work or /smart-router scope personal records it again";
    const WHY = "Its scope cannot be read (the latest smart-router.scope entry is not one the router wrote)";
    const local = await pinnedWork(t, "unreadable", { v: 9 });
    local.session.dialogKeys = [...UNPINS];
    assert.deepEqual(await answer(local, "local off"), { type: "warning", message: `${STAYS_LOCAL} ${WHY}, so smart-router/local refuses its requests, as smart-router/auto does, ${UNTIL}.` });
    resetSlot();
    const auto = await pinnedWork(t, "unreadable-auto", { v: 9 });
    await auto.host.choose("smart-router/auto");
    auto.session.dialogKeys = [...UNPINS];
    assert.deepEqual(await answer(auto, "local off"), {
      type: "warning",
      message: `pi-smart-router: this session is no longer pinned, and the selection stays smart-router/auto. ${WHY}, so smart-router/auto refuses its requests ${UNTIL}.`,
    });
  });

  test("in work scope, asks with the work account as where smart-router/auto's next requests go", async (t) => {
    const loaded = await pinnedWork(t, "work");
    await answer(loaded, "local off");
    assert.deepEqual(loaded.session.dialogs, [
      {
        title: "Unpin this session from local models?\nIt is in work scope, so smart-router/auto's next requests go to the work account. Earlier turns stay where they are.",
        options: ["No, keep the pin", "Yes, unpin"],
      },
    ]);
  });

  test("with a roster that serves no work scope, or did not load, says that smart-router/auto refuses, and the way out: the roster, and outside the latch /smart-router scope personal", async (t) => {
    const UNSERVED_V1 = "It is in work scope, which a version 1 roster does not serve, so smart-router/auto refuses its requests: give the roster a work scope (version 2)";
    const unpinned = (loaded: Loaded) => {
      loaded.session.dialogKeys = [...UNPINS];
      return answer(loaded, "local off");
    };
    const stays = `${STAYS_LOCAL} ${LOCAL_IN_WORK}`;
    await withScope("work", async () => {
      const latched = await start({ dir: agentDir(t), id: "latched", select: "local", now: () => NOW, setup: (session) => session.pin(POLICY) });
      assert.deepEqual(await unpinned(latched), { type: "warning", message: `${stays} ${UNSERVED_V1}.` });
      assert.equal(selection(latched), "smart-router/local");
    });
    resetSlot();
    const entry = await start({ dir: agentDir(t), id: "entry", select: "local", now: () => NOW, setup: (session) => {
      workEntry(session);
      session.pin(POLICY);
    } });
    assert.deepEqual(await unpinned(entry), { type: "warning", message: `${stays} ${UNSERVED_V1}, or run /smart-router scope personal.` });
    const roster = JSON.parse(HERA_V2);
    delete roster.scopes.work;
    roster.roles = roster.roles.filter((role: { name: string }) => !role.name.startsWith("work-"));
    delete roster.accounts["openai-codex-3"];
    const personalOnly = await start({ dir: agentDir(t, { roster: JSON.stringify(roster) }), id: "personal-only", select: "local", now: () => NOW, setup: (session) => {
      workEntry(session);
      session.pin(POLICY_V2);
    } });
    assert.deepEqual(await unpinned(personalOnly), {
      type: "warning",
      message: `${stays} It is in work scope, which the roster does not serve, so smart-router/auto refuses its requests: give the roster a work scope, or run /smart-router scope personal.`,
    });
    const dir = agentDir(t, { roster: HERA_V2 });
    const broken = await start({ dir, id: "broken", select: "local", runtime: priced(), now: () => NOW, setup: (session) => {
      workEntry(session);
      session.pin(POLICY_V2);
    } });
    const path = join(dir, "smart-router.json");
    writeFileSync(path, "{ nope");
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    assert.deepEqual(await unpinned(broken), {
      type: "warning",
      message: `${stays} It is in work scope, but the roster did not load, so smart-router/auto refuses its requests until it is fixed; see /smart-router status.`,
    });
  });

  test("a session that is not pinned says so, and its selection is left as it is", async (t) => {
    const loaded = await heraV2(t, { id: "unpinned", setup: workEntry });
    await loaded.host.choose(KIMI);
    assert.deepEqual(await answer(loaded, "local off"), { type: "info", message: "pi-smart-router: this session is not pinned." });
    assert.equal(selection(loaded), KIMI);
  });

  test("in personal scope, keeps the selection and says the next requests may go to cloud models, as before", async (t) => {
    const loaded = await heraV2(t, { select: "local", setup: (session) => session.pin(POLICY_V2) });
    loaded.session.dialogKeys = [...UNPINS];
    assert.deepEqual(await answer(loaded, "local off"), {
      type: "warning",
      message: "pi-smart-router: this session is no longer pinned, and the selection stays smart-router/local. The next requests may go to cloud models.",
    });
  });
});
