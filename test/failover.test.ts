// The path a real usage limit takes. Pi retries neither Codex's usage-limit text nor a spent
// credit, so the router never gets a retry to move: the run ends unanswered at message_end, the
// account cools, and the request must be sent again. The router says so at that moment, with what
// a resend will get, and registers no handler that would send it again itself (the README's "A
// fallback chain" says why). The roster is John's of 2026-11-17. Unit tests on the fake host of
// test/support/pi.ts; no Pi runtime is started.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

import { LEVEL_ENTRY, LEVEL_KEY, SCOPE_ENTRY } from "../src/constants.ts";
import { policyFromRoster } from "../src/local.ts";
import { scopeEntry } from "../src/scope.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, FakeCatalog, GLM, HERA_LAN, KIMI, model, NOW, rosterFixtureV2, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, request, resetSlot, routed, start } from "./support/pi.ts";
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
/** The text Codex gives when the ChatGPT account has no tokens left. Pi 1.5.2 does not retry it. */
const CODEX_LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
const MINUTE = 60_000;
const SID = "session-1";

const codex = (ref: string): Model<Api> => model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 });

const catalog = (): FakeCatalog =>
  new FakeCatalog([
    ...TIERS.map((tier) => codex(OWN[tier])),
    ...TIERS.map((tier) => codex(WORK_OWN[tier])),
    model(OR_GLM),
    model(OR_QWEN),
    model(KIMI),
    model(GLM, { baseUrl: HERA_LAN }),
    model(NYX_QWEN, { baseUrl: "https://nyx.lan/v1" }),
    model(HERA_QWEN, { baseUrl: HERA_LAN }),
  ]);

beforeEach(resetSlot);
afterEach(resetSlot);

interface Session {
  readonly loaded: Loaded;
  readonly cat: FakeCatalog;
  clock: number;
}

async function session(t: TestContext, options: { readonly setup?: (session: FakeSession) => void; readonly select?: string } = {}): Promise<Session> {
  const cat = catalog();
  const state = { clock: NOW };
  const loaded = await start({ dir: agentDir(t, { roster: TEXT }), runtime: new FakeRuntime(cat), now: () => state.clock, ...options });
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

const lastCode = (loaded: Loaded) => loaded.router?.record(SID)?.history.at(-1)?.code;
const records = (loaded: Loaded): Array<Record<string, unknown>> =>
  loaded.session.entries.filter((entry) => entry.customType === LEVEL_ENTRY).map((entry) => entry.data as Record<string, unknown>);

let stamps = 0;

/** The run's response fails as Pi reports it, with no retry: message_end with an error and no content, then the run settles. */
async function fails(loaded: Loaded, ref: string, errorMessage: string, init: Partial<AssistantMessage> = {}): Promise<string[]> {
  const before = loaded.session.notices.length;
  await loaded.host.emit("message_end", { message: assistant(ref, { stopReason: "error", errorMessage, content: [], timestamp: NOW + ++stamps, ...init }) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
  return loaded.session.notices.slice(before).map((notice) => `${notice.type}: ${notice.message.replace(/\d\d:\d\d/g, "HH:MM")}`);
}

async function answers(loaded: Loaded, ref: string): Promise<void> {
  await loaded.host.emit("message_end", { message: assistant(ref) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
}

describe("a real usage limit: the run ends, the notice says what to do, and the resend goes to the chain", () => {
  test("Pi retries neither Codex's usage-limit text nor a spent credit, and the router adds no handler that would", async (t) => {
    assert.equal(isRetryableAssistantError(assistant(LUNA, { stopReason: "error", errorMessage: CODEX_LIMIT })), false);
    assert.equal(isRetryableAssistantError(assistant(OR_GLM, { stopReason: "error", errorMessage: "402 Insufficient credits" })), false);
    const { loaded } = await session(t);
    // A handler for either boundary changes what Pi does when a run settles, for every session.
    assert.deepEqual([loaded.host.count("agent_before_settle"), loaded.host.count("turn_end")], [0, 0]);
  });

  test("luna answers with the usage limit: one run fails, with a notice; sent again, it goes to OpenRouter, as every level does until the account is back", async (t) => {
    const state = await session(t);
    const { loaded } = state;
    const { runtime } = loaded;
    let signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), LUNA);
    assert.deepEqual(await fails(loaded, LUNA, CODEX_LIMIT), [
      "warning: pi-smart-router: gpt-6-luna could not take this run (the account openai-codex-2 is out of use until HH:MM), and nothing was answered. Send the request again: it goes to the fallback openrouter (z-ai/glm-5.3-flash).",
    ]);
    const [failed] = records(loaded);
    assert.deepEqual([failed?.tier, failed?.ref, failed?.fallback], ["low", undefined, undefined]);

    // The same request, sent again.
    signal = await prompt(loaded, "rename foo to bar #low");
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastCode(loaded)], [OR_GLM, "fallback:low→openrouter"]);
    await loaded.host.emit("message_end", { message: assistant(OR_GLM) });
    assert.equal(loaded.session.statuses.get(LEVEL_KEY), "personal LOW → z-ai/glm-5.3-flash (tag; fallback)");
    await answers(loaded, OR_GLM);

    // The account cools for the 42 minutes its error named, so that one failed run is the whole
    // cost: a SUPER run goes straight to the chain, and astra is not tried.
    state.clock = NOW + 41 * MINUTE;
    const before = loaded.router?.record(SID)?.history.length ?? 0;
    signal = await prompt(loaded, "plan the migration #super");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), OR_GLM);
    assert.deepEqual(loaded.router?.record(SID)?.history.slice(before).map((entry) => entry.ref), [OR_GLM]);
    await answers(loaded, OR_GLM);
    state.clock = NOW + 43 * MINUTE;
    signal = await prompt(loaded, "plan the migration #super");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), ASTRA);
  });

  test("OpenRouter out of credit after Codex: the notice names the local model a resend reaches, or when to resend when nothing is left", async (t) => {
    const { loaded, cat } = await session(t);
    const { runtime } = loaded;
    let signal = await prompt(loaded, "rename foo to bar #low");
    runtime.route("auto", request("user", { signal }));
    await fails(loaded, LUNA, CODEX_LIMIT);
    signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), OR_GLM);
    assert.deepEqual(await fails(loaded, OR_GLM, "402 Insufficient credits"), [
      "warning: pi-smart-router: z-ai/glm-5.3-flash could not take this run (the account openrouter is out of use until HH:MM), and nothing was answered. Send the request again: it goes to the fallback local (GLM-5.3-Flash-oQ4e-mtp).",
    ]);
    signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), GLM);
    await answers(loaded, GLM);

    resetSlot();
    const bare = await session(t);
    for (const ref of [OR_GLM, OR_QWEN, GLM, NYX_QWEN, HERA_QWEN]) bare.cat.unavailable.add(ref);
    signal = await prompt(bare.loaded, "rename foo to bar #low");
    bare.loaded.runtime.route("auto", request("user", { signal }));
    assert.deepEqual(await fails(bare.loaded, LUNA, CODEX_LIMIT), [
      "warning: pi-smart-router: gpt-6-luna could not take this run (the account openai-codex-2 is out of use until HH:MM), and no other model can take it now. Send the request again after HH:MM, or choose a model with /model.",
    ]);
    void cat;
  });

  test("a local server that cannot be reached, with an error Pi does not retry: the notice names the next local model", async (t) => {
    const { loaded } = await session(t, { select: "local" });
    const signal = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM);
    assert.equal(isRetryableAssistantError(assistant(GLM, { stopReason: "error", errorMessage: "read ECONNRESET" })), false);
    assert.deepEqual(await fails(loaded, GLM, "read ECONNRESET"), [
      `warning: pi-smart-router: GLM-5.3-Flash-oQ4e-mtp could not take this run (its server could not be reached, and it is skipped until HH:MM), and nothing was answered. Send the request again: it goes to ${NYX_QWEN.slice("nyx/".length)}.`,
    ]);
    const again = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal: again }))), NYX_QWEN);
  });

  test("no notice when Pi will retry the error, when output had started, for another kind of error, or for a model picked by hand", async (t) => {
    const cases: ReadonlyArray<readonly [string, string, string, Partial<AssistantMessage>]> = [
      ["local", GLM, "fetch failed", {}],
      ["local", GLM, "503 Service Unavailable", {}],
      ["auto", LUNA, CODEX_LIMIT, { content: [{ type: "text", text: "Half an ans" }] }],
      ["auto", LUNA, "content_filter", {}],
      ["auto", LUNA, "429 Too Many Requests", {}],
      ["auto", LUNA, "Request timed out", {}],
      ["auto", LUNA, "model_not_found", {}],
      ["auto", LUNA, "HTTP 403", {}],
    ];
    for (const [select, ref, text, init] of cases) {
      resetSlot();
      const { loaded } = await session(t, { select });
      const signal = await prompt(loaded, "rename foo to bar #low");
      assert.equal(routed(loaded.runtime.route(select as "auto" | "local", request("user", { signal }))), ref, text);
      assert.deepEqual(await fails(loaded, ref, text, init), [], text);
    }
    resetSlot();
    const hand = await session(t, { select: KIMI });
    await hand.loaded.host.emit("input", { text: "rename foo to bar", source: "interactive" });
    hand.loaded.session.startRun();
    assert.deepEqual(await fails(hand.loaded, KIMI, "402 Insufficient credits"), []);
    // The cooldown is kept all the same: the router's own next pick will not be that account's.
  });

  test("a work session: the notice says when the work account is back, and offers only the work account's models", async (t) => {
    const { loaded } = await session(t, { setup: (s) => s.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - MINUTE)) });
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), WORK_LUNA);
    const notices = await fails(loaded, WORK_LUNA, CODEX_LIMIT);
    assert.deepEqual(notices, [
      "warning: pi-smart-router: gpt-6-luna could not take this run (the account openai-codex-3 is out of use until HH:MM), and no other model can take it now. Send the request again after HH:MM, or choose a work Codex model with /model.",
    ]);
  });

  test("a pinned session: a resend stays inside the pin's policy, or waits", async (t) => {
    const { loaded, cat } = await session(t, { setup: (s) => s.pin(policyFromRoster(ROSTER)) });
    cat.remove(NYX_QWEN);
    cat.remove(HERA_QWEN);
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), GLM);
    assert.deepEqual(await fails(loaded, GLM, "read ECONNRESET"), [
      "warning: pi-smart-router: GLM-5.3-Flash-oQ4e-mtp could not take this run (its server could not be reached, and it is skipped until HH:MM), and no other model can take it now. Send the request again after HH:MM, or choose a model with /model.",
    ]);
  });
});
