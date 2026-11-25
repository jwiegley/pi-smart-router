import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { SCOPE_ENTRY } from "../src/constants.ts";
import { isThrottle, recoveryChoice, recoveryStatus } from "../src/recovery.ts";
import type { RecoveryRequest } from "../src/recovery.ts";
import { scopeEntry } from "../src/scope.ts";
import { ASTRA, GLM, heraContext, KIMI, NOW, rosterFixtureV2, WORK_SOL } from "./support/catalog.ts";
import { agentDir, assistant, previous, request, resetSlot, routed, start } from "./support/pi.ts";

beforeEach(resetSlot);
afterEach(resetSlot);

function outcome(ref = ASTRA, errorMessage = "400: invalid request"): RecoveryRequest {
  const rc = heraContext();
  const slash = ref.indexOf("/");
  return {
    model: rc.catalog.find("smart-router", "auto")!,
    physical: rc.catalog.find(ref.slice(0, slash), ref.slice(slash + 1))!,
    reason: "user",
    thinkingLevel: "high",
    message: assistant(ref, { stopReason: "error", errorMessage }),
    attempts: [],
  };
}

function choose(request: RecoveryRequest, rc = heraContext()) {
  return recoveryChoice({ id: rc.virtualId, rc, request, skipped: new Set(), turn: "planning", escalated: false });
}

test("HTTP status is read from an explicit prefix or structured error only", () => {
  assert.equal(recoveryStatus("HTTP 400: invalid"), 400);
  assert.equal(recoveryStatus('{"error":{"status":"422","message":"invalid"}}'), 422);
  assert.equal(recoveryStatus("invalid 502 tokens"), undefined);
  assert.equal(recoveryStatus('{"message":"quoted 400"}'), undefined);
});

test("a recovery follows the failed role's fallback and skips attempted models", () => {
  const first = outcome();
  assert.equal(routed(choose(first)!.route), KIMI);
  assert.equal(choose({ ...first, attempts: [{ model: { provider: "openrouter", id: "moonshotai/kimi-k3.1-pro" }, kind: "error", status: 400 }] }), undefined);
});

test("content filters, context overflow, signature errors and errors without a status do not fail over", () => {
  for (const error of ["400 content filter", "usage limit reached: flagged by moderation", "400 maximum context length", "400 thought_signature", "invalid 500 tokens"]) {
    assert.equal(choose(outcome(ASTRA, error)), undefined, error);
  }
});

test("only a Google adapter's own preflight mapping error can fail over without a status", () => {
  const first = outcome();
  const physical = { ...first.physical, api: "google-generative-ai" as const };
  const errorMessage = `Unsupported Google thinking level mapping for ${ASTRA}: xhigh -> invalid`;
  const message = { ...first.message, api: physical.api, content: [], errorMessage };
  const rc = heraContext();
  const request = { ...first, physical, message };
  assert.equal(routed(choose(request, rc)!.route), KIMI);
  assert.equal(rc.cooldowns.until(ASTRA, NOW), undefined);
  assert.equal(routed(choose(request, rc)!.route), KIMI, "Pi's second identical offer agrees");
  assert.equal(choose({ ...request, attempts: [{ model: { provider: "openrouter", id: "moonshotai/kimi-k3.1-pro" }, kind: "error" }] }, rc), undefined, "an exhausted fallback is not tried again");
  assert.equal(choose({ ...request, physical: first.physical }, rc), undefined, "not a Google adapter");
  assert.equal(choose({ ...request, message: { ...message, errorMessage: errorMessage.replace(ASTRA, KIMI) } }, rc), undefined, "not this physical model");
  assert.equal(choose({ ...request, message: { ...message, content: [{ type: "text", text: "partial" }] } }, rc), undefined, "output already began");
  assert.equal(choose({ ...request, message: { ...message, errorMessage: `${errorMessage}; content filter` } }, rc), undefined, "refused content stays put");
  assert.equal(choose({ ...request, message: { ...message, errorMessage: `${errorMessage}; maximum context length` } }, rc), undefined, "conversation-size errors stay put");
  const work = heraContext({ roster: rosterFixtureV2("roster-hera-v2-fallback.json"), scope: "work" });
  const failedWork = outcome(WORK_SOL);
  assert.equal(choose({ ...failedWork, physical: { ...failedWork.physical, api: "google-vertex" }, message: { ...failedWork.message, content: [], errorMessage: `Unsupported Google thinking level mapping for ${WORK_SOL}: max -> invalid` } }, work), undefined, "work cannot use a personal alternate");
});

test("a throttle that outlasted Pi's retries fails over with nothing cooled, with or without a status in its text", () => {
  const wrapped = "Incomplete Claude Code upstream response (status 429, capture incomplete, upstream said: Too many requests. Please try again later.)";
  for (const error of ["429 Too Many Requests", "rate limit exceeded", "rate_limit_exceeded", "overloaded_error", wrapped]) {
    const rc = heraContext();
    const request = outcome(ASTRA, error);
    assert.equal(isThrottle(request.message), true, error);
    assert.equal(routed(choose(request, rc)!.route), KIMI, error);
    assert.equal(rc.cooldowns.until(ASTRA, NOW), undefined, `${error}: the throttled model is not cooled`);
  }
  // Not throttles, and no status to go by: Pi's retries are all they get.
  for (const error of ["terminated", "Request timed out", "fetch failed"]) {
    assert.equal(isThrottle(outcome(ASTRA, error).message), false, error);
    assert.equal(choose(outcome(ASTRA, error)), undefined, error);
  }
  // A refusal of the content and an account's own limit are never throttles.
  for (const error of ["429 rate limit: flagged by moderation", "This request would exceed your account's rate limit."]) {
    assert.equal(isThrottle(outcome(ASTRA, error).message), false, error);
  }
  assert.equal(choose(outcome(ASTRA, "429 rate limit: flagged by moderation")), undefined);
});

test("a usage limit or a refused credential cools its model and fails over, as Pi's own retry of one does", () => {
  for (const error of ["403 forbidden", "401 unauthorized", "429 quota exceeded", "You have hit your usage limit. Try again in ~42 min."]) {
    const rc = heraContext();
    assert.equal(routed(choose(outcome(ASTRA, error), rc)!.route), KIMI, error);
    assert.notEqual(rc.cooldowns.until(ASTRA, NOW), undefined, `${error}: the failed model is cooling`);
  }
  const work = heraContext({ roster: rosterFixtureV2("roster-hera-v2-fallback.json"), scope: "work" });
  assert.equal(choose(outcome(WORK_SOL, "usage limit reached"), work), undefined, "the work scope has no chain: the run stops");
});

test("local recovery never uses a cloud fallback", () => {
  const rc = heraContext({ virtualId: "local", localOnly: true });
  assert.equal(choose(outcome(GLM), rc), undefined);
});

test("work recovery cannot take the personal fallback chain", () => {
  const rc = heraContext({ roster: rosterFixtureV2("roster-hera-v2-fallback.json"), scope: "work" });
  assert.equal(choose(outcome(WORK_SOL), rc), undefined);
});

test("recovery is bound to the owner and the scope of the original request", async (t) => {
  const loaded = await start({ dir: agentDir(t), now: () => NOW });
  await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
  const signal = loaded.session.startRun();
  const picked = loaded.runtime.route("auto", request("user", { signal }));
  assert.equal(routed(picked), ASTRA);
  const value: RecoveryRequest = { ...outcome(), signal };
  loaded.session.endRun();
  assert.equal(routed(loaded.router!.dispatchRecovery("auto", value)!.route), KIMI);
  assert.equal(loaded.router!.record("session-1")?.runPick?.ref, ASTRA, "an offer alone is not a routed response");
  await loaded.host.emit("message_end", { message: assistant(KIMI) });
  assert.equal(loaded.router!.record("session-1")?.runPick?.ref, KIMI);
  assert.equal(loaded.router!.record("session-1")?.history.at(-1)?.code, "recovery");
  assert.equal(loaded.router!.dispatchRecovery("auto", { ...value, signal: new AbortController().signal }), undefined);
  loaded.session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW));
  assert.equal(loaded.router!.dispatchRecovery("auto", value), undefined);
  assert.equal(loaded.session.wholeHistoryReads, 0);
});

test("matching request-caused 4xx does not cool the alternate", async (t) => {
  const loaded = await start({ dir: agentDir(t), now: () => NOW });
  await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
  const signal = loaded.session.startRun();
  loaded.runtime.route("auto", request("user", { signal }));
  const value: RecoveryRequest = { ...outcome(), signal };
  assert.equal(routed(loaded.router!.dispatchRecovery("auto", value)!.route), KIMI);
  await loaded.host.emit("message_end", { message: assistant(KIMI, { stopReason: "error", errorMessage: "400 forbidden" }) });
  assert.equal(routed(loaded.runtime.route("auto", request("direct", { previous: previous(loaded.runtime, KIMI) }))), KIMI);
});

test("a run that left a throttled model asks for no re-check, and the next run starts on its own model again", async (t) => {
  const loaded = await start({ dir: agentDir(t), now: () => NOW });
  await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
  const signal = loaded.session.startRun();
  assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), ASTRA);
  // Pi retried the throttle on the same model, as the router lets it, until its retries ran out.
  const message = assistant(ASTRA, { stopReason: "error", errorMessage: "429 Too Many Requests", content: [] });
  assert.equal(routed(loaded.runtime.route("auto", request("retry", { signal, failed: { model: loaded.runtime.physical(ASTRA), message } }))), ASTRA);
  await loaded.host.emit("message_end", { message });
  const value: RecoveryRequest = { ...outcome(ASTRA, "429 Too Many Requests"), message, signal };
  assert.equal(routed(loaded.router!.dispatchRecovery("auto", value)!.route), KIMI);
  await loaded.host.emit("message_end", { message: assistant(KIMI, { stopReason: "toolUse" }) });
  const record = loaded.router!.record("session-1");
  assert.deepEqual([record?.runPick?.ref, record?.handoff], [KIMI, false]);
  const toolResult = { role: "toolResult" as const, toolCallId: "c", toolName: "bash", content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: NOW };
  assert.equal(routed(loaded.runtime.route("auto", request("continuation", { signal, previous: previous(loaded.runtime, KIMI), messages: [toolResult] }))), KIMI, "the run stays where it went");
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
  await loaded.host.emit("input", { text: "plan the next migration", source: "interactive" });
  assert.equal(routed(loaded.runtime.route("auto", request("user", { signal: loaded.session.startRun() }))), ASTRA, "nothing was cooled or held");
});
