// A model whose server cannot be reached: the retry goes to the next candidate in the written
// order, and the model is held for unreachableMinutes so that the runs that follow skip it. The
// rule covers local models only (the roster's local providers on its local hosts), cooled or not,
// and only a failure before any output. The
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
import { holdFrom, Holds, isUnreachable } from "../src/resolve.ts";
import { parseRoster, unreachableMinutesOf } from "../src/roster.ts";
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

describe("what counts as unreachable", () => {
  test("a refused, reset or unresolved connection, a connect timeout, a TLS failure, and a 502, 503 or 504", () => {
    for (const text of [
      REFUSED,
      "Connection refused",
      "read ECONNRESET",
      "connection reset by peer",
      "upstream connect error or disconnect/reset before headers",
      "getaddrinfo ENOTFOUND nyx.lan",
      "getaddrinfo EAI_AGAIN nyx.lan",
      "connect EHOSTUNREACH 192.168.1.9:443",
      "connect ENETUNREACH 192.168.1.9:443",
      "connect EHOSTDOWN 192.168.1.9:443",
      "connect ETIMEDOUT 192.168.1.9:443",
      "UND_ERR_CONNECT_TIMEOUT",
      "Connect Timeout Error",
      "Connection error.",
      "network error",
      "fetch failed",
      "socket hang up",
      "other side closed",
      "The socket connection was closed unexpectedly",
      "unable to verify the first certificate",
      "self-signed certificate in certificate chain",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "TLS handshake failed",
      "502 Bad Gateway",
      "503 Service Unavailable",
      "HTTP 504",
      "Gateway Timeout",
    ]) {
      assert.equal(isUnreachable(text), true, text);
    }
  });

  test("not a slow or broken answer, a rate limit, a usage limit or a content refusal", () => {
    for (const text of ["Request timed out", "timeout", "terminated", "stream was interrupted", "connection lost", "500 Internal Server Error", "429 Too Many Requests", "overloaded", LIMIT, "401 Unauthorized", "content_filter: 503", "request id 15021 failed", "", undefined]) {
      assert.equal(isUnreachable(text), false, String(text));
    }
  });

  test("only for a local model, and only before any output", () => {
    const holds = new Holds();
    const failed = (ref: string, content: unknown[] = [], stamp = 1) => {
      const slash = ref.indexOf("/");
      return { provider: ref.slice(0, slash), model: ref.slice(slash + 1), api: "openai-completions", stopReason: "error", errorMessage: REFUSED, timestamp: stamp, content };
    };
    // A cloud model's connection failure retries the same model, as before: nothing is held.
    assert.equal(holdFrom(failed(OR_GLM), model(OR_GLM), ROSTER, holds, NOW), undefined);
    assert.equal(holdFrom(failed(LUNA), codex(LUNA), ROSTER, holds, NOW), undefined);
    // A local provider on a host that is not one of the roster's local hosts is not local.
    assert.equal(holdFrom(failed(NYX_QWEN), model(NYX_QWEN, { baseUrl: "https://nyx.example.com/v1" }), ROSTER, holds, NOW), undefined);
    assert.equal(holdFrom(failed(NYX_QWEN), undefined, ROSTER, holds, NOW), undefined);
    // Output had started: the failure is the stream's, and nothing is held.
    assert.equal(holdFrom(failed(NYX_QWEN, [{ type: "text", text: "Half an ans" }]), NYX, ROSTER, holds, NOW), undefined);
    assert.equal(holdFrom(failed(NYX_QWEN, [{ type: "toolCall", id: "1", name: "read", arguments: {} }]), NYX, ROSTER, holds, NOW), undefined);
    assert.equal(holds.until(NYX_QWEN, NOW), undefined);
    // Before any output, with empty blocks or none: held for the default five minutes, once per response.
    assert.equal(holdFrom(failed(NYX_QWEN, [{ type: "text", text: "" }]), NYX, ROSTER, holds, NOW), NYX_QWEN);
    assert.deepEqual(holds.get(NYX_QWEN, NOW), { until: NOW + 5 * MINUTE, kind: "unreachable" });
    holdFrom(failed(NYX_QWEN), NYX, ROSTER, holds, NOW + MINUTE);
    assert.equal(holds.until(NYX_QWEN, NOW), NOW + 5 * MINUTE);
    holdFrom(failed(NYX_QWEN, [], 2), NYX, ROSTER, holds, NOW + MINUTE);
    assert.equal(holds.until(NYX_QWEN, NOW), NOW + 6 * MINUTE);
    // Neither a response that did not fail nor another kind of failure holds.
    assert.equal(holdFrom({ ...failed(GLM), errorMessage: "Request timed out" }, model(GLM, { baseUrl: HERA_LAN }), ROSTER, holds, NOW), undefined);
    assert.equal(holdFrom({ ...failed(GLM), stopReason: "aborted" }, model(GLM, { baseUrl: HERA_LAN }), ROSTER, holds, NOW), undefined);
  });

  test("unreachableMinutes: 5 by default, 1 to 60, beside cooldownMinutes, in either version", () => {
    const edited = (edit: (roster: any) => void, base = TEXT): string => {
      const roster = JSON.parse(base);
      edit(roster);
      return JSON.stringify(roster);
    };
    assert.equal(Object.hasOwn(ROSTER, "unreachableMinutes"), false);
    assert.equal(unreachableMinutesOf(ROSTER), 5);
    for (const base of [TEXT, fixture("roster-hera.json")]) {
      const parsed = parseRoster(edited((r) => (r.unreachableMinutes = 9), base));
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
      assert.equal(unreachableMinutesOf(parsed.value), 9);
      for (const bad of [0, 61, 1.5, "2"]) {
        const refused = parseRoster(edited((r) => (r.unreachableMinutes = bad), base));
        assert.deepEqual(refused, { ok: false, error: "unreachableMinutes: must be a whole number of minutes from 1 to 60" });
      }
    }
    const lines = checkRoster(edited((r) => (r.unreachableMinutes = 9))).lines;
    assert.ok(lines.includes("A local model whose server cannot be reached is skipped for 9 minutes, and the request goes to the next model in the order above."), lines.join("\n"));
  });
});

describe("smart-router/local when a server cannot be reached", () => {
  test("Nyx refuses the connection, so Hera's Qwen answers; the runs that follow skip Nyx until the hold ends", async (t) => {
    const state = await session(t, { select: "local" });
    const { loaded, cat } = state;
    const { runtime } = loaded;
    cat.remove(GLM);
    let signal = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(runtime.route("local", request("user", { signal }))), NYX_QWEN);
    const next = runtime.route("local", request("retry", { signal, failed: dead(loaded, NYX_QWEN) }));
    assert.deepEqual([routed(next), lastCode(loaded), next.thinkingLevel], [HERA_QWEN, "retry:unreachable", "max"]);
    await finish(loaded, HERA_QWEN);

    state.clock = NOW + MINUTE;
    signal = await prompt(loaded, "rename bar to baz");
    assert.deepEqual([routed(runtime.route("local", request("user", { signal }))), lastCode(loaded)], [HERA_QWEN, "local"]);
    await finish(loaded, HERA_QWEN);
    const lines = await status(loaded);
    assert.ok(lines.some((line) => line.startsWith(`  local (the local role; a personal fallback; thinking max): ${GLM} not-in-catalog, ${NYX_QWEN} unreachable-until-`)), lines.join("\n"));
    assert.deepEqual(lines.filter((line) => line.startsWith("Unreachable:")).map((line) => line.replace(/\d\d:\d\d/, "HH:MM")), [
      `Unreachable: ${NYX_QWEN} is skipped until HH:MM, since its server could not be reached`,
    ]);

    // After unreachableMinutes, Nyx is first again.
    state.clock = NOW + 5 * MINUTE;
    signal = await prompt(loaded, "rename baz to qux");
    assert.equal(routed(runtime.route("local", request("user", { signal }))), NYX_QWEN);
    assert.equal((await status(loaded)).some((line) => line.startsWith("Unreachable:")), false);
  });

  test("each failure moves on to the next model in the written order, once round, and then the request is refused: never a cloud model", async (t) => {
    const { loaded } = await session(t, { select: "local" });
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(runtime.route("local", request("user", { signal }))), GLM);
    assert.equal(routed(runtime.route("local", request("retry", { signal, failed: dead(loaded, GLM, "503 Service Unavailable") }))), NYX_QWEN);
    assert.equal(routed(runtime.route("local", request("retry", { signal, failed: dead(loaded, NYX_QWEN, REFUSED, NOW + 1) }))), HERA_QWEN);
    const message = refusal(() => runtime.route("local", request("retry", { signal, failed: dead(loaded, HERA_QWEN, "fetch failed", NOW + 2) })));
    assert.match(message, /^smart-router\/local: no local model can take this request \(local: /);
    for (const ref of [GLM, NYX_QWEN, HERA_QWEN]) assert.ok(message.includes(`${ref}: skipped until `), message);
    assert.match(message, /since its server could not be reached/);
    assert.doesNotMatch(message, /openrouter|openai-codex/);
    // A request that does not name a failure is refused as well: every local model is held.
    refusal(() => runtime.route("local", request("continuation", { signal })));
  });

  test("the next model is the one written after the failed one, not the role's first", async (t) => {
    const { loaded } = await session(t, { select: "local" });
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar");
    runtime.route("local", request("user", { signal }));
    // The run is on Nyx, the second model, though the first is available.
    assert.equal(routed(runtime.route("local", request("continuation", { signal, previous: previous(runtime, NYX_QWEN) }))), NYX_QWEN);
    assert.equal(routed(runtime.route("local", request("retry", { signal, failed: dead(loaded, NYX_QWEN) }))), HERA_QWEN);
    // Hera's Qwen is the last: the pass goes round to the first, once.
    assert.equal(routed(runtime.route("local", request("retry", { signal, failed: dead(loaded, HERA_QWEN, REFUSED, NOW + 1) }))), GLM);
    refusal(() => runtime.route("local", request("retry", { signal, failed: dead(loaded, GLM, REFUSED, NOW + 2) })));
  });

  test("a failure after output had started keeps the model, as every such failure did: nothing is sent to another model, and nothing is held", async (t) => {
    const { loaded } = await session(t, { select: "local" });
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar");
    runtime.route("local", request("user", { signal }));
    const failed = failure(runtime, GLM, "read ECONNRESET");
    const partial = { ...failed, message: { ...failed.message, content: [{ type: "text" as const, text: "Half an ans" }] } };
    assert.deepEqual([routed(runtime.route("local", request("retry", { signal, failed: partial }))), lastCode(loaded)], [GLM, "retry:same"]);
    assert.equal((await status(loaded)).some((line) => line.startsWith("Unreachable:")), false);
    // A failure that is not about reaching the server keeps the model too.
    assert.deepEqual([routed(runtime.route("local", request("retry", { signal, failed: dead(loaded, GLM, "Request timed out") }))), lastCode(loaded)], [GLM, "retry:same"]);
  });

  test("a failed response that Pi does not retry holds the model all the same", async (t) => {
    const { loaded } = await session(t, { select: "local" });
    const signal = await prompt(loaded, "rename foo to bar");
    loaded.runtime.route("local", request("user", { signal }));
    await loaded.host.emit("message_end", { message: assistant(GLM, { stopReason: "error", errorMessage: "read ECONNRESET", content: [] }) });
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    const next = await prompt(loaded, "rename bar to baz");
    assert.equal(routed(loaded.runtime.route("local", request("user", { signal: next }))), NYX_QWEN);
  });
});

describe("the pin and smart-router/auto when a server cannot be reached", () => {
  test("a pinned session stays inside its policy: the local models in order, then a refusal", async (t) => {
    const { loaded } = await session(t, { setup: (s) => s.pin(policyFromRoster(ROSTER)) });
    const { runtime } = loaded;
    const signal = await prompt(loaded, "plan the migration #super");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), GLM);
    assert.equal(routed(runtime.route("auto", request("retry", { signal, failed: dead(loaded, GLM) }))), NYX_QWEN);
    assert.equal(routed(runtime.route("auto", request("retry", { signal, failed: dead(loaded, NYX_QWEN, REFUSED, NOW + 1) }))), HERA_QWEN);
    const message = refusal(() => runtime.route("auto", request("retry", { signal, failed: dead(loaded, HERA_QWEN, REFUSED, NOW + 2) })));
    assert.match(message, /^smart-router\/auto: no local model can take this request while this session is pinned to local models/);
    assert.doesNotMatch(message, /openrouter|openai-codex/);
  });

  test("on smart-router/auto the chain's local models give way to each other, and never lead back up the chain", async (t) => {
    const { loaded, cat } = await session(t);
    const { runtime } = loaded;
    for (const ref of [LUNA, OR_GLM]) cat.unavailable.add(ref);
    cat.unavailable.add(OR_QWEN);
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastCode(loaded)], [GLM, "fallback:low→local"]);
    // OpenRouter is back, but a retry from the local role goes on, not back.
    cat.unavailable.delete(OR_GLM);
    assert.deepEqual([routed(runtime.route("auto", request("retry", { signal, failed: dead(loaded, GLM) }))), lastCode(loaded)], [NYX_QWEN, "retry:unreachable"]);
    assert.equal(routed(runtime.route("auto", request("retry", { signal, failed: dead(loaded, NYX_QWEN, REFUSED, NOW + 1) }))), HERA_QWEN);
    const message = refusal(() => runtime.route("auto", request("retry", { signal, failed: dead(loaded, HERA_QWEN, REFUSED, NOW + 2) })));
    assert.match(message, /^smart-router\/auto: no model can take this request \(local: /);
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    // The next run starts from its level again, and skips the held local models: OpenRouter takes it.
    const next = await prompt(loaded, "rename bar to baz #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal: next }))), OR_GLM);
  });

  test("a cloud model's connection failure retries the same model, as before, in personal and in work scope", async (t) => {
    const personal = await session(t);
    let signal = await prompt(personal.loaded, "rename foo to bar #low");
    personal.loaded.runtime.route("auto", request("user", { signal }));
    for (const text of [REFUSED, "503 Service Unavailable", "fetch failed"]) {
      const route = personal.loaded.runtime.route("auto", request("retry", { signal, failed: dead(personal.loaded, LUNA, text) }));
      assert.deepEqual([routed(route), lastCode(personal.loaded)], [LUNA, "retry:same"], text);
    }
    resetSlot();
    const work = await session(t, { setup: (s) => s.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - MINUTE)) });
    signal = await prompt(work.loaded, "rename foo to bar #low");
    work.loaded.runtime.route("auto", request("user", { signal }));
    const route = work.loaded.runtime.route("auto", request("retry", { signal, failed: dead(work.loaded, WORK_LUNA) }));
    assert.deepEqual([routed(route), lastCode(work.loaded)], [WORK_LUNA, "retry:same"]);
  });
});
