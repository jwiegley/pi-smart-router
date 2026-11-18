// The local-only pin of earlier versions is gone: smart-router/local is how a session routes
// locally. PI_SMART_ROUTER_LOCAL_ONLY and an earlier version's pin entry are ignored, each with one
// notice, so that nobody believes an old pin still keeps a session local, and /smart-router local
// answers that the pin is gone. Unit tests on the fake host of test/support/pi.ts; no Pi runtime is
// started.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import type { Api, ClassifierResult, Model } from "@earendil-works/pi-ai";

import { ENV_PIN, PIN_ENTRY } from "../src/constants.ts";
import { PIN_REMOVED, pinEntryNotice, pinEnvNotice } from "../src/errors.ts";
import { processSlot } from "../src/owners.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { CHATGPT, FakeCatalog, GLM, heraModels, KIMI, model, NOW, OPENROUTER } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
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

/** How many times the session was told `text`. */
const told = (loaded: Loaded, text: string): number => loaded.session.notices.filter((notice) => notice.message === text).length;
const failures = (loaded: Loaded): string[] => loaded.session.notices.map((notice) => notice.message).filter((message) => / handler failed: /.test(message));
const pinEntries = (loaded: Loaded): number => loaded.session.entries.filter((entry) => entry.customType === PIN_ENTRY).length;
const selection = (loaded: Loaded): string => `${loaded.session.model?.provider}/${loaded.session.model?.id}`;

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
  test("the environment switch is ignored, with one notice at session start", async (t) => {
    let first: Loaded | undefined;
    await withEnv(ENV_PIN, "1", async () => {
      first = await hera(t, { id: "first" });
    });
    assert.ok(first !== undefined);
    assert.equal(processSlot().env.on, true, "the switch is latched for the life of the process, as before");
    assert.equal(told(first, pinEnvNotice()), 1, "the session is told once, at its start, that the switch keeps nothing local");
    assert.equal(await lowRun(first), LUNA, "smart-router/auto routes a LOW run to the low level's Codex model, not to a local one");
    assert.equal(await lowRun(first, "and the tests"), LUNA, "and so does the next run");
    assert.equal(told(first, pinEnvNotice()), 1, "the prompts say nothing more");
    assert.equal(first.session.statuses.has("smart-router"), false, "no status item is shown for the switch");
    // The variable is gone from the environment, but the latch holds for a second session of the process.
    const second = await hera(t, { id: "second", runtime: heraRuntime() });
    assert.equal(told(second, pinEnvNotice()), 1, "a second session_start in the process says it again, for that session");
    assert.equal(told(first, pinEnvNotice()), 1, "and only for that session");
    assert.equal(await lowRun(second), LUNA, "the second session routes by level too");
    assert.deepEqual([failures(first), failures(second)], [[], []], "no handler failed");
  });

  test("an environment switch that is off says nothing", async (t) => {
    for (const value of ["", "0", "off", "false"]) {
      resetSlot();
      await withEnv(ENV_PIN, value, async () => {
        const loaded = await hera(t, { id: `env-${value}` });
        assert.equal(told(loaded, pinEnvNotice()), 0, JSON.stringify(value));
      });
    }
  });

  test("an old pin entry is ignored, with one notice", async (t) => {
    for (const [name, data] of [
      ["the entry /smart-router local on wrote", OLD_PIN],
      ["a pin entry of another shape", OTHER_PIN],
    ] as const) {
      resetSlot();
      const loaded = await hera(t, { id: name, setup: (session) => session.appendCustom(PIN_ENTRY, data) });
      assert.equal(told(loaded, pinEntryNotice()), 1, `${name}: one notice at session start`);
      assert.equal(await lowRun(loaded), LUNA, `${name}: smart-router/auto routes by level, not to the local models`);
      assert.equal(await lowRun(loaded, "and the tests"), LUNA, `${name}: and so does the next run`);
      assert.equal(told(loaded, pinEntryNotice()), 1, `${name}: a second prompt says nothing more`);
      assert.equal(pinEntries(loaded), 1, `${name}: nothing is written over the old entry`);
      assert.deepEqual(failures(loaded), [], `${name}: no handler failed`);
    }
  });

  test("an old pin entry on another selection says nothing until smart-router/auto takes an idle message", async (t) => {
    const loaded = await hera(t, { select: "local", setup: (session) => session.appendCustom(PIN_ENTRY, OLD_PIN) });
    assert.equal(told(loaded, pinEntryNotice()), 0, "smart-router/local routes locally, so the old pin misleads nobody there");
    assert.deepEqual(await loaded.host.emit("input", { text: "go ahead", source: "interactive" }), [undefined]);
    assert.equal(told(loaded, pinEntryNotice()), 0, "not at an input on smart-router/local either");
    await loaded.host.choose(KIMI);
    await loaded.host.emit("input", { text: "go ahead", source: "interactive" });
    assert.equal(told(loaded, pinEntryNotice()), 0, "nor on a model picked by hand");
    await loaded.host.choose("smart-router/auto");
    assert.equal(told(loaded, pinEntryNotice()), 0, "a selection alone says nothing");
    assert.equal(await lowRun(loaded), LUNA, "the first idle message on smart-router/auto routes by level");
    assert.equal(told(loaded, pinEntryNotice()), 1, "and is told once");
    await lowRun(loaded, "and the tests");
    assert.equal(told(loaded, pinEntryNotice()), 1, "and only once");
  });

  test("an entry that says the session was unpinned says nothing", async (t) => {
    const loaded = await hera(t, { setup: (session) => session.appendCustom(PIN_ENTRY, OLD_UNPIN) });
    assert.equal(await lowRun(loaded), LUNA);
    assert.deepEqual([told(loaded, pinEntryNotice()), told(loaded, pinEnvNotice())], [0, 0]);
    // The latest entry is the one read: an unpin after a pin says nothing either.
    const unpinned = await hera(t, {
      id: "pin-then-unpin",
      setup: (session) => {
        session.appendCustom(PIN_ENTRY, OLD_PIN);
        session.appendCustom(PIN_ENTRY, OLD_UNPIN);
      },
    });
    assert.equal(await lowRun(unpinned), LUNA);
    assert.equal(told(unpinned, pinEntryNotice()), 0);
  });

  test("a malformed pin entry is ignored without a notice and without failing", async (t) => {
    for (const [name, data] of [
      ["a number", 7],
      ["an on that is not a boolean", { on: "yes" }],
      ["null", null],
    ] as const) {
      resetSlot();
      const loaded = await hera(t, { id: name, setup: (session) => session.appendCustom(PIN_ENTRY, data) });
      assert.equal(await lowRun(loaded), LUNA, `${name}: smart-router/auto routes by level`);
      assert.deepEqual([told(loaded, pinEntryNotice()), failures(loaded)], [0, []], `${name}: no notice, and no handler failed`);
    }
  });

  test("a session whose pin entry cannot be read routes by level without a notice", async (t) => {
    const loaded = await hera(t, { select: "local", setup: (session) => session.appendCustom(PIN_ENTRY, OLD_PIN) });
    const manager = loaded.session.ctx.sessionManager as unknown as Record<string, unknown>;
    const read = manager.getLatestCustomEntry as (type: string, options?: object) => unknown;
    manager.getLatestCustomEntry = (type: string, options?: object) => {
      if (type === PIN_ENTRY) throw new Error("database is locked");
      return read(type, options);
    };
    await loaded.host.choose("smart-router/auto");
    assert.equal(await lowRun(loaded), LUNA, "a read that throws stops nothing");
    assert.deepEqual([told(loaded, pinEntryNotice()), failures(loaded)], [0, []]);
  });
});

describe("/smart-router local", () => {
  test("answers that the pin is gone, whatever follows", async (t) => {
    for (const select of ["auto", "local", KIMI]) {
      resetSlot();
      const loaded = await hera(t, { id: select, select, setup: (session) => session.appendCustom(PIN_ENTRY, OLD_PIN) });
      const entries = loaded.session.entries.length;
      for (const args of ["local", "local on", "local off", "local status", "local on now", " local   off "]) {
        loaded.session.dialogKeys = ["down", "enter"];
        await loaded.host.command("smart-router", args);
        assert.deepEqual(loaded.session.notices.at(-1), { type: "warning", message: PIN_REMOVED }, `${select}, ${args}: the answer`);
      }
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
    assert.doesNotMatch(usage, /local/, "the usage names no local subcommand");
    assert.doesNotMatch(loaded.host.commands.get("smart-router")?.description ?? "", /local/, "neither does the description");
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
