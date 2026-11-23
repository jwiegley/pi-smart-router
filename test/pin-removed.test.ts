// The local-only pin of earlier versions is gone: smart-router/local is how a session routes
// locally. No trace of it is left (John, 2026-11-18): PI_SMART_ROUTER_LOCAL_ONLY is not read and an
// earlier version's pin entry is not looked for, and neither produces a notice; a session file
// that holds such an entry still loads and routes by level. /smart-router local is an unknown
// subcommand, answered with the usage. Unit tests on the fake host of test/support/pi.ts; no Pi
// runtime is started.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import type { Api, ClassifierResult, Model } from "@earendil-works/pi-ai";

import { processSlot } from "../src/owners.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { CHATGPT, FakeCatalog, GLM, heraModels, KIMI, model, NOW, OPENROUTER } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { ENV_PIN, PIN_ENTRY } from "./support/legacy.ts";
import { agentDir, FakeRuntime, request, resetSlot, routed, start } from "./support/pi.ts";
import type { Loaded, LoadOptions } from "./support/pi.ts";

const HERA_V2 = fixture("roster-hera-v2.json");
const JEV = "openrouter/typesafe/jev-1.14";
const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const AT = new Date(NOW).toISOString();
const LOW: Record<Tier, number> = { low: 0.8, medium: 0.1, high: 0.05, super: 0.05 };

/** The entry /smart-router local on wrote before the pin was removed. */
const OLD_PIN = { v: 1, on: true, at: AT, local: { refs: [GLM], providers: ["omlx-hera"], hosts: ["hera.lan"] } };
/** A pin entry of another shape that still says the session was pinned. */
const OTHER_PIN = { v: 1, on: true, at: NOW, policy: { providers: ["omlx-hera"], hosts: [] } };
/** The entry /smart-router local off wrote. */
const OLD_UNPIN = { v: 1, on: false, at: AT };

beforeEach(resetSlot);
afterEach(resetSlot);

const codex = (ref: string): Model<Api> => model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 });

/** Hera's catalog with the Codex models of its version 2 roster, and a registry that finds Jev. */
function heraRuntime(extra: readonly Model<Api>[] = []): FakeRuntime {
  const runtime = new FakeRuntime(new FakeCatalog([...heraModels(), codex(LUNA), codex(TERRA), ...extra]));
  runtime.addClassifier(JEV);
  return runtime;
}

type HeraOptions = Partial<Omit<LoadOptions, "dir">> & { readonly roster?: string; readonly select?: string };

/** A session on Hera's version 2 roster, or `roster`, with smart-router/auto selected unless `select` says otherwise. */
function hera(t: TestContext, options: HeraOptions = {}): Promise<Loaded> {
  const { roster = HERA_V2, ...rest } = options;
  return start({ dir: agentDir(t, { roster }), runtime: heraRuntime(), now: () => NOW, ...rest });
}

/** Jev's answer with these probabilities: its choice is the most probable tier. */
function jevAnswer(probabilities: Record<Tier, number>): ClassifierResult {
  const choice = [...TIERS].sort((a, b) => probabilities[b] - probabilities[a])[0] ?? "medium";
  return {
    api: "typesafe-system-one",
    provider: "openrouter",
    model: "typesafe/jev-1.14",
    answers: { level: { type: "choice", choice, probabilities, confidence: probabilities[choice] } },
    stopReason: "stop",
    timestamp: NOW,
  };
}

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

/** The notices that speak of the pin or its switch: none may be shown. */
const pinNotices = (loaded: Loaded): string[] =>
  loaded.session.notices.map((notice) => notice.message).filter((message) => /\bpin\b|pinned|LOCAL_ONLY/i.test(message));
const failures = (loaded: Loaded): string[] => loaded.session.notices.map((notice) => notice.message).filter((message) => / handler failed: /.test(message));
const pinEntries = (loaded: Loaded): number => loaded.session.entries.filter((entry) => entry.customType === PIN_ENTRY).length;
const selection = (loaded: Loaded): string => `${loaded.session.model?.provider}/${loaded.session.model?.id}`;
/** The session's reads of the old pin entry, as its bounded reader received them. */
const pinReads = (loaded: Loaded): unknown[] =>
  loaded.session.boundedReads.filter((read) => typeof read === "object" && read !== null && (read as { customType?: unknown }).customType === PIN_ENTRY);

/** Run `body` with process.env replaced by a view that records the names read through it. */
async function watchingEnv(body: (names: string[]) => Promise<void>): Promise<void> {
  const saved = process.env;
  const names: string[] = [];
  process.env = new Proxy(saved, {
    get(target, key, receiver) {
      if (typeof key === "string") names.push(key);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  try {
    await body(names);
  } finally {
    process.env = saved;
  }
}

/** An idle message, answered LOW by Jev, then its run's first request on smart-router/auto. */
async function lowRun(loaded: Loaded, text = "rename foo to bar"): Promise<string> {
  loaded.runtime.answer = async () => jevAnswer(LOW);
  assert.deepEqual(await loaded.host.emit("input", { text, source: "interactive" }), [undefined], `${loaded.session.id}: the message is passed on`);
  const signal = loaded.session.startRun();
  await loaded.host.emit("before_agent_start", { messageType: "user", prompt: text });
  const ref = routed(loaded.runtime.route("auto", request("user", { signal })));
  loaded.session.endRun();
  await loaded.host.emit("agent_settled", { aborted: false });
  return ref;
}

describe("the pin of earlier versions", () => {
  test("PI_SMART_ROUTER_LOCAL_ONLY is not read and shows nothing", async (t) => {
    for (const value of ["1", "on", "", "0", "off"]) {
      resetSlot();
      await withEnv(ENV_PIN, value, async () => {
        await watchingEnv(async (names) => {
          const loaded = await hera(t, { id: `env-${value}` });
          assert.ok(loaded.router !== undefined, `${JSON.stringify(value)}: the router was built`);
          assert.ok(!names.includes(ENV_PIN), `${JSON.stringify(value)}: nothing reads ${ENV_PIN}: ${JSON.stringify(names)}`);
          assert.deepEqual(pinNotices(loaded), [], `${JSON.stringify(value)}: nothing is shown for it`);
          assert.equal(processSlot().env.on, false, `${JSON.stringify(value)}: nothing is latched for it`);
          assert.equal(await lowRun(loaded), LUNA, `${JSON.stringify(value)}: smart-router/auto routes a LOW run to the low level's Codex model, not to a local one`);
          assert.equal(loaded.session.statuses.has("smart-router"), false, `${JSON.stringify(value)}: no status item is shown for it`);
          assert.deepEqual(failures(loaded), [], `${JSON.stringify(value)}: no handler failed`);
        });
      });
    }
  });

  test("an old pin entry is not looked for, shows nothing, and does not break the session", async (t) => {
    for (const [name, data] of [
      ["the entry /smart-router local on wrote", OLD_PIN],
      ["a pin entry of another shape", OTHER_PIN],
      ["the entry /smart-router local off wrote", OLD_UNPIN],
      ["a number", 7],
      ["an on that is not a boolean", { on: "yes" }],
      ["null", null],
    ] as const) {
      resetSlot();
      const loaded = await hera(t, { id: name, setup: (session) => session.appendCustom(PIN_ENTRY, data) });
      assert.equal(await lowRun(loaded), LUNA, `${name}: smart-router/auto routes by level, not to the local models`);
      assert.equal(await lowRun(loaded, "and the tests"), LUNA, `${name}: and so does the next run`);
      assert.deepEqual(pinReads(loaded), [], `${name}: the entry is never read`);
      assert.deepEqual(pinNotices(loaded), [], `${name}: nothing is shown for it`);
      assert.equal(pinEntries(loaded), 1, `${name}: nothing is written over the old entry`);
      assert.deepEqual(failures(loaded), [], `${name}: no handler failed`);
    }
  });

  test("an old pin entry on another selection is not looked for when smart-router/auto takes an idle message either", async (t) => {
    const loaded = await hera(t, { select: "local", setup: (session) => session.appendCustom(PIN_ENTRY, OLD_PIN) });
    assert.deepEqual(await loaded.host.emit("input", { text: "go ahead", source: "interactive" }), [undefined]);
    await loaded.host.choose(KIMI);
    await loaded.host.emit("input", { text: "go ahead", source: "interactive" });
    await loaded.host.choose("smart-router/auto");
    assert.equal(await lowRun(loaded), LUNA, "the first idle message on smart-router/auto routes by level");
    await lowRun(loaded, "and the tests");
    assert.deepEqual([pinReads(loaded), pinNotices(loaded)], [[], []], "nothing is read and nothing is shown, at any selection");
  });

  test("a session whose pin entry would throw on reading routes by level: it is never read", async (t) => {
    const loaded = await hera(t, { select: "local", setup: (session) => session.appendCustom(PIN_ENTRY, OLD_PIN) });
    const manager = loaded.session.ctx.sessionManager as unknown as Record<string, unknown>;
    const read = manager.getLatestCustomEntry as (type: string, options?: object) => unknown;
    manager.getLatestCustomEntry = (type: string, options?: object) => {
      if (type === PIN_ENTRY) throw new Error("database is locked");
      return read(type, options);
    };
    await loaded.host.choose("smart-router/auto");
    assert.equal(await lowRun(loaded), LUNA, "a read that would throw is never made");
    assert.deepEqual([pinNotices(loaded), failures(loaded)], [[], []]);
  });

  test("a session without an entry makes no read of it across three prompts on smart-router/auto", async (t) => {
    const loaded = await hera(t);
    for (const text of ["rename foo to bar", "and the tests", "and the docs"]) assert.equal(await lowRun(loaded, text), LUNA, text);
    assert.deepEqual(pinReads(loaded), [], "no read at session start, and none at the prompts");
  });
});

describe("/smart-router local", () => {
  test("is an unknown subcommand, whatever follows: the usage, and nothing of a pin (John, 2026-11-18: no trace of the pin)", async (t) => {
    for (const select of ["auto", "local", KIMI]) {
      resetSlot();
      const loaded = await hera(t, { id: select, select, setup: (session) => session.appendCustom(PIN_ENTRY, OLD_PIN) });
      const entries = loaded.session.entries.length;
      await loaded.host.command("smart-router", "nonsense");
      const usage = loaded.session.notices.at(-1);
      assert.match(usage?.message ?? "", /^Usage: \/smart-router /, `${select}: an unknown subcommand's answer is the usage`);
      for (const args of ["local", "local on", "local off", "local status", "local on now", " local   off "]) {
        loaded.session.dialogKeys = ["down", "enter"];
        const before = loaded.session.notices.length;
        await loaded.host.command("smart-router", args);
        assert.equal(loaded.session.notices.length, before + 1, `${select}, ${args}: the command shows exactly one notice`);
        assert.deepEqual(loaded.session.notices.at(-1), usage, `${select}, ${args}: no trace of the pin: the answer is the usage, as for any unknown subcommand`);
      }
      assert.deepEqual(pinNotices(loaded), [], `${select}: no notice speaks of a pin`);
      assert.equal(loaded.session.entries.length, entries, `${select}: no entry is appended`);
      assert.deepEqual([selection(loaded), loaded.host.selections.length], [select.includes("/") ? select : `smart-router/${select}`, 0], `${select}: the selection is unchanged`);
      assert.deepEqual(loaded.session.dialogs, [], `${select}: nothing is asked`);
    }
  });

  test("is no longer in the usage or the description", async (t) => {
    const loaded = await hera(t);
    await loaded.host.command("smart-router", "nonsense");
    const usage = loaded.session.notices.at(-1)?.message ?? "";
    assert.match(usage, /^Usage: \/smart-router /, "the usage");
    // local is a scope now, of /smart-router scope and of /smart-router prefer, and no subcommand of its own.
    assert.doesNotMatch(usage, /(?:^|\| )local\b/, "the usage names no local subcommand");
    assert.doesNotMatch(loaded.host.commands.get("smart-router")?.description ?? "", /(?:^|, |: )local\b/, "neither does the description");
  });
});

describe("smart-router/local", () => {
  /** A model of the local role's provider whose server is not on a local host. */
  const FAR = "omlx-hera/far-away";
  const far = model(FAR, { baseUrl: OPENROUTER, contextWindow: 131_072, maxTokens: 16_384 });

  test("still routes only to the local role, inside the roster's local policy", async (t) => {
    const loaded = await hera(t, { select: "local" });
    loaded.runtime.answer = async () => jevAnswer(LOW);
    assert.deepEqual(await loaded.host.emit("input", { text: "go ahead", source: "interactive" }), [undefined]);
    assert.equal(loaded.runtime.classifyCalls.length, 0, "Jev is not asked on smart-router/local");
    const signal = loaded.session.startRun();
    await loaded.host.emit("before_agent_start", { messageType: "user", prompt: "go ahead" });
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM, "the local role's model");
    assert.equal(loaded.router?.record(loaded.session.id)?.history.at(-1)?.code, "local", "planned on the local role");
    loaded.session.endRun();
    // A local-role model whose server is not local is passed over, and with nothing else the request is refused.
    const roster = JSON.parse(HERA_V2);
    const role = roster.roles.find((entry: { name: string }) => entry.name === roster.local.role);
    role.models = [FAR, GLM];
    const mixed = await hera(t, { id: "mixed", select: "local", roster: JSON.stringify(roster), runtime: heraRuntime([far]) });
    assert.equal(routed(mixed.runtime.route("local", request("direct"))), GLM, "the model outside the policy is passed over");
    role.models = [FAR];
    const farOnly = await hera(t, { id: "far", select: "local", roster: JSON.stringify(roster), runtime: heraRuntime([far]) });
    assert.throws(
      () => farOnly.runtime.route("local", request("direct")),
      (error: unknown) => error instanceof Error && /^smart-router\/local: no local model can take this request \(.*host openrouter\.ai is not a local host.*\)\. Nothing was sent\./.test(error.message),
      "a local-role model outside the local policy is refused",
    );
    // smart-router/auto never takes the local-only path: a LOW run goes to the low level.
    const auto = await hera(t, { id: "auto" });
    assert.equal(await lowRun(auto), LUNA);
  });
});
