// The path a real usage limit takes. Pi retries neither Codex's usage-limit text nor a spent
// credit, so the router never gets a retry to move: the run ends unanswered at message_end, the
// account cools, and the request must be sent again. The router says so at that moment, with what
// a resend will get, and registers no handler that would send it again itself (the manual's "A
// fallback chain" says why). The roster is John's of 2026-11-17. Unit tests on the fake host of
// test/support/pi.ts; no Pi runtime is started.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

import { LEVEL_ENTRY, SCOPE_ENTRY } from "../src/constants.ts";
import { scopeEntry } from "../src/scope.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, FakeCatalog, GLM, HERA_LAN, KIMI, model, NOW, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, FakeRuntime, footerOf, plannedWords, previous, request, resetSlot, routed, start, usage } from "./support/pi.ts";
import type { FakeSession, Loaded } from "./support/pi.ts";

const TEXT = fixture("roster-hera-v2-fallback.json");
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
    assert.equal(footerOf(loaded), "low high → z-ai/glm-5.3-flash", "the footer names the chain's model under the level the prompt needs");
    assert.equal(plannedWords(loaded), "personal LOW → z-ai/glm-5.3-flash (tag; fallback)", "and history says it is a fallback");
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
      "warning: pi-smart-router: gpt-6-luna could not take this run (the account openai-codex-2 is out of use until HH:MM), and nothing was answered. No other model can take it now: send the request again after HH:MM, or choose a model with /model.",
    ]);
    void cat;
  });

  test("a local server that cannot be reached, with an error Pi does not retry: the notice names the next local model", async (t) => {
    const { loaded } = await session(t, { select: "local" });
    const signal = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM);
    assert.equal(isRetryableAssistantError(assistant(GLM, { stopReason: "error", errorMessage: "read ECONNRESET" })), false);
    assert.deepEqual(await fails(loaded, GLM, "read ECONNRESET"), [
      `warning: pi-smart-router: GLM-5.3-Flash-oQ4e-mtp could not take this run (its server could not be reached), and nothing was answered. Send the request again: it goes to ${NYX_QWEN.slice("nyx/".length)}.`,
    ]);
    let again = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal: again }))), NYX_QWEN);
    // The notice names what a fresh run takes, the first model written that is not held, which
    // need not be the one after the failed model: Hera's Qwen fails, and GLM, held, is passed over.
    assert.deepEqual(await fails(loaded, NYX_QWEN, "read ECONNRESET"), [
      `warning: pi-smart-router: ${NYX_QWEN.slice("nyx/".length)} could not take this run (its server could not be reached), and nothing was answered. Send the request again: it goes to Qwen3.8-27B-oQ4e-fp16-mtp.`,
    ]);
    again = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal: again }))), HERA_QWEN);
    await answers(loaded, HERA_QWEN);
  });

  test("a run that had already answered or run tools is told to continue, not to send the request again", async (t) => {
    const { loaded } = await session(t);
    const { runtime } = loaded;
    const signal = await prompt(loaded, "push the branch #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), LUNA);
    // luna calls a tool (git push), and the request after the tool result hits the limit.
    await loaded.host.emit("message_end", { message: assistant(LUNA, { stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git push" } }] }) });
    assert.equal(routed(runtime.route("auto", request("continuation", { signal, previous: { model: runtime.physical(LUNA), thinkingLevel: "high" } }))), LUNA);
    const notices = await fails(loaded, LUNA, CODEX_LIMIT);
    assert.deepEqual(notices, [
      "warning: pi-smart-router: gpt-6-luna could not go on with this run (the account openai-codex-2 is out of use until HH:MM), and it stopped partway. What it did so far stands: do not send the request again. To go on, say: continue. It goes on with the fallback openrouter (z-ai/glm-5.3-flash).",
    ]);
    assert.doesNotMatch(notices.join("\n"), /nothing was answered|Send the request again:/);
    // "continue" is a new prompt, and goes where the notice said.
    const next = await prompt(loaded, "continue");
    assert.equal(routed(runtime.route("auto", request("user", { signal: next }))), OR_GLM);

    // With nothing else to go on with, it says when.
    resetSlot();
    const work = await session(t, { setup: (s) => s.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - MINUTE)) });
    const run = await prompt(work.loaded, "push the branch #low");
    work.loaded.runtime.route("auto", request("user", { signal: run }));
    await work.loaded.host.emit("message_end", { message: assistant(WORK_LUNA, { stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git push" } }] }) });
    assert.deepEqual(await fails(work.loaded, WORK_LUNA, CODEX_LIMIT), [
      "warning: pi-smart-router: gpt-6-luna could not go on with this run (the account openai-codex-3 is out of use until HH:MM), and it stopped partway. What it did so far stands: do not send the request again. No other model can take it now: to go on, say: continue, after HH:MM. Another model picked by hand with /model is sent as it is.",
    ]);
  });

  test("a model picked by hand in mid-run, on the model the router had picked, gets no notice", async (t) => {
    const { loaded } = await session(t);
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), LUNA);
    // The selection is now luna itself, picked by hand: its requests are not the router's.
    loaded.session.force(LUNA);
    assert.deepEqual(await fails(loaded, LUNA, CODEX_LIMIT), []);
    // Nor when the selection moved to the router's other model: the pick was smart-router/auto's, and a resend would not be.
    resetSlot();
    const moved = await session(t);
    const run = await prompt(moved.loaded, "rename foo to bar #low");
    assert.equal(routed(moved.loaded.runtime.route("auto", request("user", { signal: run }))), LUNA);
    moved.loaded.session.select("local");
    assert.deepEqual(await fails(moved.loaded, LUNA, CODEX_LIMIT), []);
  });

  test("no notice when Pi will retry the error, when output had started, for another kind of error, or for a model picked by hand", async (t) => {
    const cases: ReadonlyArray<readonly [string, string, string, Partial<AssistantMessage>]> = [
      ["local", GLM, "fetch failed", {}],
      ["local", GLM, "502 Bad Gateway", {}],
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
      "warning: pi-smart-router: gpt-6-luna could not take this run (the account openai-codex-3 is out of use until HH:MM), and nothing was answered. No other model can take it now: send the request again after HH:MM. Another model picked by hand with /model is sent as it is.",
    ]);
    assert.doesNotMatch(notices.join("\n"), /choose a work Codex model/);
  });

  test("on smart-router/local, an unreachable server with no other local model left: the notice says to send again, and that it is tried again", async (t) => {
    const { loaded, cat } = await session(t, { select: "local" });
    cat.remove(NYX_QWEN);
    cat.remove(HERA_QWEN);
    const signal = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal }))), GLM);
    assert.deepEqual(await fails(loaded, GLM, "read ECONNRESET"), [
      "warning: pi-smart-router: GLM-5.3-Flash-oQ4e-mtp could not take this run (its server could not be reached), and nothing was answered. No other model can take it now: send the request again, and it is tried again, or choose a model with /model.",
    ]);
  });
});

describe("on a Pi with the recovery boundary, a usage limit moves the run on instead of ending it", () => {
  test("luna hits the limit: the run goes on with the chain, says so once, and asks for no resend", async (t) => {
    const { loaded } = await session(t);
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), LUNA);
    const message = assistant(LUNA, { stopReason: "error", errorMessage: CODEX_LIMIT, content: [], timestamp: NOW + ++stamps });
    const before = loaded.session.notices.length;
    await loaded.host.emit("message_end", { message });
    const offer = loaded.router!.dispatchRecovery("auto", { model: runtime.registry.find("smart-router", "auto")!, physical: runtime.physical(LUNA), reason: "user", thinkingLevel: "high", message, attempts: [], signal });
    assert.equal(offer === undefined ? undefined : routed(offer.route), OR_GLM, "every Codex level shares the account, so the chain takes it");
    await answers(loaded, OR_GLM);
    const said = loaded.session.notices.slice(before).map((notice) => notice.message);
    assert.equal(said.length, 1);
    assert.match(said[0] ?? "", /openrouter/);
    assert.doesNotMatch(said.join("\n"), /Send the request again|could not take this run/);
    assert.equal(records(loaded).at(-1)?.ref, OR_GLM);
  });

  test("an alternate that fails too leaves the notice to be said, and asking twice changes nothing", async (t) => {
    const { loaded } = await session(t);
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar #low");
    runtime.route("auto", request("user", { signal }));
    const message = assistant(LUNA, { stopReason: "error", errorMessage: CODEX_LIMIT, content: [], timestamp: NOW + ++stamps });
    await loaded.host.emit("message_end", { message });
    const ask = () => loaded.router!.dispatchRecovery("auto", { model: runtime.registry.find("smart-router", "auto")!, physical: runtime.physical(LUNA), reason: "user", thinkingLevel: "high", message, attempts: [], signal });
    const [offer, confirmation] = [ask(), ask()];
    assert.deepEqual([offer && routed(offer.route), confirmation && routed(confirmation.route)], [OR_GLM, OR_GLM], "Pi asks to offer and to confirm: the same answer");
    assert.equal(loaded.router?.record(SID)?.runPick?.ref, LUNA, "an offer is no pick");
    const before = loaded.session.notices.length;
    await loaded.host.emit("message_end", { message: assistant(OR_GLM, { stopReason: "error", errorMessage: "500 upstream error", content: [], timestamp: NOW + ++stamps }) });
    await loaded.host.emit("agent_settled", { aborted: false });
    assert.match(loaded.session.notices.slice(before).map((notice) => notice.message).join("\n"), /gpt-6-luna could not take this run/);
  });

  test("an offer Pi does not use is dropped at the next routed request", async (t) => {
    const { loaded } = await session(t);
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar #low");
    runtime.route("auto", request("user", { signal }));
    const message = assistant(LUNA, { stopReason: "error", errorMessage: "500 broken", content: [], timestamp: NOW + ++stamps });
    await loaded.host.emit("message_end", { message });
    assert.notEqual(loaded.router!.dispatchRecovery("auto", { model: runtime.registry.find("smart-router", "auto")!, physical: runtime.physical(LUNA), reason: "user", thinkingLevel: "high", message, attempts: [], signal }), undefined);
    runtime.route("auto", request("continuation", { signal, previous: previous(runtime, LUNA) }));
    await loaded.host.emit("message_end", { message: assistant(OR_GLM) });
    assert.notEqual(loaded.router?.record(SID)?.history.at(-1)?.code, "recovery", "a later answer from that model is no recovery");
  });

  test("when no alternate answers, the run still ends with what to do", async (t) => {
    const { loaded } = await session(t, { setup: (s) => s.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - MINUTE)) });
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), WORK_LUNA);
    const message = assistant(WORK_LUNA, { stopReason: "error", errorMessage: CODEX_LIMIT, content: [], timestamp: NOW + ++stamps });
    await loaded.host.emit("message_end", { message });
    assert.equal(loaded.router!.dispatchRecovery("auto", { model: runtime.registry.find("smart-router", "auto")!, physical: runtime.physical(WORK_LUNA), reason: "user", thinkingLevel: "high", message, attempts: [], signal }), undefined);
    const before = loaded.session.notices.length;
    await loaded.host.emit("agent_settled", { aborted: false });
    assert.match(loaded.session.notices.slice(before).map((notice) => notice.message).join("\n"), /could not take this run/);
  });
});

describe("the deep-session floor on each request: the LOW level's models are the small ones", () => {
  const DEEP = usage(150_000);
  const user = (text: string) => ({ role: "user" as const, content: text, timestamp: NOW });
  const toolResult = { role: "toolResult" as const, toolCallId: "c", toolName: "bash", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: NOW };

  async function deepOnLuna(t: TestContext, tagged: boolean): Promise<Session> {
    const state = await session(t);
    const { loaded } = state;
    await loaded.host.emit("message_end", { message: assistant(LUNA, { usage: DEEP }) });
    await loaded.host.emit("agent_settled", { aborted: false });
    return state;
  }

  test("a main-loop continuation that would stay on luna goes to MEDIUM's model; planning and tool-result turns stay", async (t) => {
    const { loaded } = await deepOnLuna(t, false);
    const { runtime } = loaded;
    // An extension's run, which has no prompt and no tag, starts on the model that answered last.
    const signal = loaded.session.startRun();
    const base = { signal, previous: previous(runtime, LUNA) };
    assert.equal(routed(runtime.route("auto", request("continuation", { ...base, messages: [toolResult] }))), LUNA, "a tool result's request stays");
    assert.equal(routed(runtime.route("auto", request("continuation", { ...base, messages: [user("plan the next step")] }))), LUNA, "a planning turn stays");
    assert.equal(routed(runtime.route("auto", request("continuation", { ...base, messages: [user("go on")] }))), TERRA, "a main-loop turn does not");
    assert.equal(lastCode(loaded), "deep-session");
  });

  test("a session that is not deep stays, and so does one where nothing but small models can answer", async (t) => {
    const shallow = await session(t);
    await shallow.loaded.host.emit("message_end", { message: assistant(LUNA, { usage: usage(50_000) }) });
    await shallow.loaded.host.emit("agent_settled", { aborted: false });
    const go = (loaded: Loaded) => routed(loaded.runtime.route("auto", request("continuation", { signal: loaded.session.startRun(), previous: previous(loaded.runtime, LUNA), messages: [user("go on")] })));
    assert.equal(go(shallow.loaded), LUNA);

    const alone = await deepOnLuna(t, false);
    for (const ref of [TERRA, SOL, ASTRA, OR_GLM, OR_QWEN, GLM, NYX_QWEN, HERA_QWEN]) alone.cat.unavailable.add(ref);
    assert.equal(go(alone.loaded), LUNA, "with no other model the request keeps its pick");
  });

  test("a retry keeps its model, a floor of low turns the check off, and smart-router/local is never lifted", async (t) => {
    const { loaded } = await deepOnLuna(t, false);
    const { runtime } = loaded;
    const signal = loaded.session.startRun();
    const failed = { model: runtime.physical(LUNA), message: assistant(LUNA, { stopReason: "error", errorMessage: "overloaded_error", content: [], timestamp: NOW + ++stamps }) };
    assert.equal(routed(runtime.route("auto", request("retry", { signal, failed, messages: [user("go on")] }))), LUNA);

    const off = JSON.parse(TEXT) as Record<string, unknown>;
    off.demand = { deepSessionFloor: "low" };
    const cat = catalog();
    const quiet = await start({ dir: agentDir(t, { roster: JSON.stringify(off) }), runtime: new FakeRuntime(cat), now: () => NOW });
    await quiet.host.emit("message_end", { message: assistant(LUNA, { usage: DEEP }) });
    await quiet.host.emit("agent_settled", { aborted: false });
    assert.equal(routed(quiet.runtime.route("auto", request("continuation", { signal: quiet.session.startRun(), previous: previous(quiet.runtime, LUNA), messages: [user("go on")] }))), LUNA);

    const local = await session(t, { select: "smart-router/local" });
    await local.loaded.host.emit("message_end", { message: assistant(GLM, { usage: DEEP }) });
    await local.loaded.host.emit("agent_settled", { aborted: false });
    assert.equal(routed(local.loaded.runtime.route("local", request("continuation", { signal: local.loaded.session.startRun(), previous: previous(local.loaded.runtime, GLM), messages: [user("go on")] }))), GLM);
  });

  test("smart-router/work lifts to the work account's MEDIUM model, never to a personal one", async (t) => {
    const { loaded } = await session(t, { select: "smart-router/work" });
    await loaded.host.emit("message_end", { message: assistant(WORK_LUNA, { usage: DEEP }) });
    await loaded.host.emit("agent_settled", { aborted: false });
    assert.equal(routed(loaded.runtime.route("work", request("continuation", { signal: loaded.session.startRun(), previous: previous(loaded.runtime, WORK_LUNA), messages: [user("go on")] }))), WORK_TERRA);
  });

  test("a run tagged LOW is left on its model: the tag is the explicit choice", async (t) => {
    const { loaded } = await deepOnLuna(t, true);
    const signal = await prompt(loaded, "tidy the imports #low");
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal, messages: [user("tidy the imports")] }))), LUNA);
    assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, LUNA), messages: [user("go on")] }))), LUNA);
  });
});

describe("after a move to another provider, the first tool result's request chooses the run's model again, once", () => {
  const toolResult = { role: "toolResult" as const, toolCallId: "c", toolName: "bash", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: NOW };
  const next = (loaded: Loaded, signal: AbortSignal, ref: string) => routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, ref), messages: [toolResult] })));

  async function movedToChain(t: TestContext): Promise<Session & { readonly signal: AbortSignal }> {
    const state = await session(t);
    const { loaded } = state;
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), LUNA);
    // Pi retries this failure itself, and the retry moves to the chain: another provider.
    const failed = { model: loaded.runtime.physical(LUNA), message: assistant(LUNA, { stopReason: "error", errorMessage: "403 forbidden", content: [], timestamp: NOW + ++stamps }) };
    assert.equal(routed(loaded.runtime.route("auto", request("retry", { signal, failed }))), OR_GLM);
    await loaded.host.emit("message_end", { message: assistant(OR_GLM, { stopReason: "toolUse" }) });
    return Object.assign(state, { signal });
  }

  test("while what made it move still holds, the run stays where it is", async (t) => {
    const { loaded, signal } = await movedToChain(t);
    assert.equal(next(loaded, signal, OR_GLM), OR_GLM);
    assert.equal(loaded.router?.record(SID)?.handoff, false, "the handoff is consumed");
  });

  test("when the level's own model can take the run again, it goes back, and only that one request asks", async (t) => {
    const state = await movedToChain(t);
    const { loaded, signal } = state;
    state.clock = NOW + 24 * 60 * MINUTE;
    assert.equal(next(loaded, signal, OR_GLM), LUNA);
    assert.equal(lastCode(loaded), "handoff");
    await loaded.host.emit("message_end", { message: assistant(LUNA, { stopReason: "toolUse" }) });
    assert.equal(next(loaded, signal, LUNA), LUNA);
    assert.equal(lastCode(loaded), "stick:previous");
  });

  test("a request that is no tool result's keeps the handoff for the one that is", async (t) => {
    const state = await movedToChain(t);
    const { loaded, signal } = state;
    state.clock = NOW + 24 * 60 * MINUTE;
    const steer = { role: "user" as const, content: "and the tests", timestamp: NOW };
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal, previous: previous(loaded.runtime, OR_GLM), messages: [steer] }))), OR_GLM);
    assert.equal(next(loaded, signal, OR_GLM), LUNA);
  });
});
