import assert from "node:assert/strict";
import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";

import type { SlashCommandInfo, ToolInfo } from "@earendil-works/pi-coding-agent";

import { policyFromRoster } from "../src/local.ts";
import { clock } from "../src/resolve.ts";
import { createRouter } from "../src/router.ts";
import { ASTRA, DEEPSEEK, FakeCatalog, GLM, heraModels, KIMI, model, NOW, OPENROUTER, rosterFixture, SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, load, request, resetSlot, start } from "./support/pi.ts";
import type { Loaded } from "./support/pi.ts";

const POLICY = policyFromRoster(rosterFixture("roster-hera.json"));
const AT = new Date(NOW).toISOString();
const QWEN = "openrouter/qwen/qwen-9-max";

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
  "The pin covers the model only. Still able to send data off this machine: /warden (pi-warden's judge sends redacted context to its backend while it is enabled); /subs (Multi-Pass can move the session to another subscription); the tools agent_browser, batch_web_fetch, subagent, web_fetch, web_search; Pi's own /share, /export and /bug.";

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

  test("shows each candidate's resolver reason, the pin's recorded policy, the lock and the last decision", async (t) => {
    const loaded = await hera(t);
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: "You've hit your usage limit." }) });
    await loaded.host.emit("input", { text: "plan the migration to the new store", source: "interactive" });
    const signal = loaded.session.startRun();
    loaded.runtime.route("auto", request("user", { signal }));
    loaded.session.endRun();
    await loaded.host.command("smart-router", "local on");
    const record = loaded.router?.record("session-1");
    assert.ok(record !== undefined);
    record.guard.lock = { since: NOW, model: KIMI, cause: "conflict", policy: "pin" };
    const { message } = await answer(loaded, "status");
    const lines = message.split("\n");
    assert.ok(lines.includes(`Pin: on since ${AT}, with models ${GLM}; providers omlx-hera; hosts hera.lan`), message);
    assert.ok(lines.includes(`Lock: since ${clock(NOW)}: something keeps switching the selection to ${KIMI}. Prompts are refused and runs stopped until the selection stays local.`), message);
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
      assert.deepEqual(await answer(loaded, args), { type: "warning", message: "Usage: /smart-router [status] | history [n] | local on|off|status | reload" }, args);
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

  test("status shows the pin, the lock and what can still leave", async (t) => {
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
    for (const args of ["bogus", "status now", "local maybe", "local on now", "reload now"]) {
      assert.equal((await answer(loaded, args)).type, "warning", args);
    }
  });
});

