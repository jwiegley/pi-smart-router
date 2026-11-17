// A usage-limit, quota, billing or authentication error cools the account: every model of a
// subscription provider, for cooldownMinutes, so that the next run of any level goes straight to
// the scope's fallback chain. A model that is not found, and a provider that is no subscription,
// still cool one model. The
// roster is John's of 2026-11-17 (test/fixtures/roster-hera-v2-fallback.json). Unit tests on the
// fake host of test/support/pi.ts; no Pi runtime is started.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import { checkRoster } from "../src/check.ts";
import { SCOPE_ENTRY } from "../src/constants.ts";
import { policyFromRoster } from "../src/local.ts";
import { accountScoped, coolFrom, Cooldowns } from "../src/resolve.ts";
import { parseRoster } from "../src/roster.ts";
import { scopeEntry } from "../src/scope.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, FakeCatalog, GLM, HERA_LAN, model, NOW, rosterFixtureV2, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, failure, FakeRuntime, previous, request, resetSlot, routed, start } from "./support/pi.ts";
import type { FakeSession, Loaded } from "./support/pi.ts";

const TEXT = fixture("roster-hera-v2-fallback.json");
const ROSTER = rosterFixtureV2("roster-hera-v2-fallback.json");
const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const OR_GLM = "openrouter/z-ai/glm-5.3-flash";
const OR_QWEN = "openrouter/qwen/qwen3.8-27b";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";
const WORK_LUNA = "openai-codex-3/gpt-6-luna";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const WORK_ASTRA = "openai-codex-3/gpt-6-astra";
const OWN: Readonly<Record<Tier, string>> = { low: LUNA, medium: TERRA, high: SOL, super: ASTRA };
const WORK_OWN: Readonly<Record<Tier, string>> = { low: WORK_LUNA, medium: WORK_TERRA, high: WORK_SOL, super: WORK_ASTRA };
const MINUTE = 60_000;
const REFUSED = "connect ECONNREFUSED 192.168.1.9:443";
const LIMIT = "You've hit your usage limit.";
const SID = "session-1";

const codex = (ref: string): Model<Api> => model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 });
const NYX = model(NYX_QWEN, { baseUrl: "https://nyx.lan/v1" });

const catalog = (): FakeCatalog =>
  new FakeCatalog([
    ...TIERS.map((tier) => codex(OWN[tier])),
    ...TIERS.map((tier) => codex(WORK_OWN[tier])),
    model(OR_GLM),
    model(OR_QWEN),
    model(GLM, { baseUrl: HERA_LAN }),
    NYX,
    model(HERA_QWEN, { baseUrl: HERA_LAN }),
  ]);

beforeEach(resetSlot);
afterEach(resetSlot);

interface Session {
  readonly loaded: Loaded;
  readonly cat: FakeCatalog;
  clock: number;
}

async function session(t: TestContext, options: { readonly setup?: (session: FakeSession) => void; readonly select?: string; readonly roster?: string } = {}): Promise<Session> {
  const cat = catalog();
  const state = { clock: NOW };
  const { roster = TEXT, ...rest } = options;
  const loaded = await start({ dir: agentDir(t, { roster }), runtime: new FakeRuntime(cat), now: () => state.clock, ...rest });
  return {
    loaded,
    cat,
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
  };
}

async function prompt(loaded: Loaded, text: string): Promise<AbortSignal> {
  await loaded.host.emit("input", { text, source: "interactive" });
  return loaded.session.startRun();
}

async function finish(loaded: Loaded, ref: string): Promise<void> {
  await loaded.host.emit("message_end", { message: assistant(ref) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
}

const lastCode = (loaded: Loaded) => loaded.router?.record(SID)?.history.at(-1)?.code;

/** A request that failed before any output: an error response with no content. */
const dead = (loaded: Loaded, ref: string, text: string = REFUSED, stamp = NOW) => {
  const failed = failure(loaded.runtime, ref, text, stamp);
  return { ...failed, message: { ...failed.message, content: [] } };
};

function refusal(run: () => unknown): string {
  let message = "";
  assert.throws(run, (error: unknown) => {
    message = error instanceof Error ? error.message : String(error);
    return true;
  });
  assert.match(message, /Nothing was sent\./);
  assert.equal(isRetryableAssistantError(assistant("smart-router/auto", { stopReason: "error", errorMessage: message })), false, message);
  return message;
}

const status = async (loaded: Loaded): Promise<string[]> => {
  await loaded.host.command("smart-router", "status");
  return (loaded.session.notices.at(-1)?.message ?? "").split("\n");
};

describe("a usage limit cools the account", () => {
  const failed = (ref: string, errorMessage: string, stamp = 1) => {
    const slash = ref.indexOf("/");
    return { provider: ref.slice(0, slash), model: ref.slice(slash + 1), api: "openai-completions", stopReason: "error", errorMessage, timestamp: stamp };
  };

  test("which errors are the account's: limits, quota, billing and authentication, not a model that is not found", () => {
    for (const text of [LIMIT, "Monthly usage_limit reached", "quota exceeded for this key", "insufficient_quota", "billing details required", "subscription_sharing_usage_limit_exceeded", "RESOURCE_EXHAUSTED", "401 Unauthorized", "HTTP 403", "Forbidden"]) {
      assert.equal(accountScoped(text), true, text);
    }
    for (const text of ["The model gpt-6.1-sol was not found", "model_not_found", "403: model gpt-6-nova not found for this plan", "429 Too Many Requests", "content_filter", "Request timed out", "", undefined]) {
      assert.equal(accountScoped(text), false, String(text));
    }
  });

  test("a subscription provider's limit or authentication error cools every model of that provider, and no other provider's", () => {
    for (const text of [LIMIT, "401 Unauthorized"]) {
      const cooldowns = new Cooldowns();
      assert.equal(coolFrom(failed(LUNA, text), ROSTER, cooldowns, NOW), LUNA);
      for (const tier of TIERS) assert.equal(cooldowns.until(OWN[tier], NOW), NOW + 30 * MINUTE, `${text}: ${tier}`);
      for (const ref of [...TIERS.map((tier) => WORK_OWN[tier]), OR_GLM, OR_QWEN, GLM]) assert.equal(cooldowns.until(ref, NOW), undefined, `${text}: ${ref}`);
      assert.deepEqual(cooldowns.accounts(NOW), [{ provider: "openai-codex-2", until: NOW + 30 * MINUTE }]);
      assert.equal(cooldowns.until(ASTRA, NOW + 30 * MINUTE), undefined);
    }
    // The work account's cooldown is its own.
    const work = new Cooldowns();
    coolFrom(failed(WORK_LUNA, LIMIT), ROSTER, work, NOW);
    assert.equal(work.until(WORK_ASTRA, NOW), NOW + 30 * MINUTE);
    for (const tier of TIERS) assert.equal(work.until(OWN[tier], NOW), undefined);
  });

  test("a model that is not found cools that model alone, and a provider that is no subscription cools per model", () => {
    const cooldowns = new Cooldowns();
    coolFrom(failed(LUNA, "model_not_found"), ROSTER, cooldowns, NOW);
    assert.deepEqual([cooldowns.until(LUNA, NOW), cooldowns.until(ASTRA, NOW), cooldowns.accounts(NOW)], [NOW + 30 * MINUTE, undefined, []]);
    coolFrom(failed(OR_GLM, "insufficient_quota"), ROSTER, cooldowns, NOW);
    assert.deepEqual([cooldowns.until(OR_GLM, NOW), cooldowns.until(OR_QWEN, NOW), cooldowns.accounts(NOW)], [NOW + 30 * MINUTE, undefined, []]);
  });

  test("luna hits the limit, and a SUPER run goes straight to the chain without trying astra; when the cooldown ends, astra is first again", async (t) => {
    const state = await session(t);
    const { loaded } = state;
    const { runtime } = loaded;
    let signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), LUNA);
    // Pi does not retry a usage limit: the run ends on the error.
    await loaded.host.emit("message_end", { message: assistant(LUNA, { stopReason: "error", errorMessage: LIMIT, content: [] }) });
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();

    state.clock = NOW + MINUTE;
    const before = loaded.router?.record(SID)?.history.length ?? 0;
    signal = await prompt(loaded, "plan the migration #super");
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastCode(loaded)], [OR_GLM, "fallback:super→openrouter"]);
    assert.deepEqual(loaded.router?.record(SID)?.history.slice(before).map((entry) => entry.ref), [OR_GLM]);
    await finish(loaded, OR_GLM);

    const lines = await status(loaded);
    assert.deepEqual(lines.filter((line) => line.startsWith("Cooling:")).map((line) => line.replace(/\d\d:\d\d/, "HH:MM")), [
      "Cooling: the account openai-codex-2, every model of it, until HH:MM after a usage-limit or authentication error",
    ]);
    assert.ok(lines.some((line) => /^Levels \(personal\): LOW → \S+ cooling-until-\d\d:\d\d; MEDIUM → \S+ cooling-until-\d\d:\d\d; HIGH → \S+ cooling-until-\d\d:\d\d; SUPER → \S+ cooling-until-\d\d:\d\d$/.test(line)), lines.join("\n"));

    state.clock = NOW + 31 * MINUTE;
    signal = await prompt(loaded, "plan the next migration #super");
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastCode(loaded)], [ASTRA, "tag"]);
    assert.equal((await status(loaded)).some((line) => line.startsWith("Cooling:")), false);
  });

  test("a retried limit moves the run to the chain, and the work account's limit refuses its other levels rather than reach another account", async (t) => {
    const personal = await session(t);
    let signal = await prompt(personal.loaded, "rename foo to bar #low");
    personal.loaded.runtime.route("auto", request("user", { signal }));
    assert.equal(routed(personal.loaded.runtime.route("auto", request("retry", { signal, failed: failure(personal.loaded.runtime, LUNA, LIMIT) }))), OR_GLM);

    resetSlot();
    const work = await session(t, { setup: (s) => s.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - MINUTE)) });
    signal = await prompt(work.loaded, "rename foo to bar #low");
    work.loaded.runtime.route("auto", request("user", { signal }));
    await work.loaded.host.emit("message_end", { message: assistant(WORK_LUNA, { stopReason: "error", errorMessage: LIMIT, content: [] }) });
    await work.loaded.host.emit("agent_settled", { aborted: false });
    work.loaded.session.endRun();
    signal = await prompt(work.loaded, "plan the migration #super");
    const message = refusal(() => work.loaded.runtime.route("auto", request("user", { signal })));
    assert.match(message, /^smart-router\/auto: no model can take this request \(work-super: openai-codex-3\/gpt-6-astra: cooling down until \d\d:\d\d after a usage-limit or authentication error on its account openai-codex-3\)/);
    assert.doesNotMatch(message, /openrouter|omlx-hera|nyx|openai-codex-2/);
  });
});
