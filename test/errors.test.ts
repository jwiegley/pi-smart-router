import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";

import type { VirtualId } from "../src/constants.ts";
import type { Attempt } from "../src/decide.ts";
import {
  firstLine,
  fixedText,
  historyNotice,
  invariant,
  loadFailed,
  loadFailedNotice,
  looksRetryable,
  noBoundedHistory,
  PIN_REMOVED,
  pinEntryNotice,
  pinEnvNotice,
  refusal,
  RouterError,
  rosterNotice,
  rosterRefusal,
  scopeUnreadable,
  scopeUnserved,
  stale,
  unroutable,
} from "../src/errors.ts";
import { assistant } from "./support/pi.ts";

const retryable = (text: string): boolean => isRetryableAssistantError(assistant("smart-router/auto", { stopReason: "error", errorMessage: text }));

/** Phrases Pi's classifier retries, as refs and reasons could carry them. */
const POISON = ["-503", "timeout", "terminated", "service unavailable", "rate limit", "overloaded", "429", "ECONNREFUSED", "fetch failed", "socket hang up"];

function attempts(ref: string, detail: string): Attempt[] {
  return [
    { role: "engineer", exists: true, candidates: [{ ok: false, ref, reason: "not-available", detail }] },
    { role: "coder", exists: true, candidates: [{ ok: false, ref: `${ref}-b`, reason: "cooling-until-14:05", detail: `cooling down until 14:05 (${detail})` }] },
  ];
}

/** Every template, with the identifiers it interpolates. */
function templates(id: VirtualId, ref: string, reason: string): Array<readonly [string, RouterError]> {
  return [
    ["loadFailed", loadFailed(id, reason)],
    ["roster missing", rosterRefusal(id, { kind: "missing", path: `/agent/${ref}/smart-router.json`, error: reason })],
    ["roster unsafe", rosterRefusal(id, { kind: "unsafe", path: `/agent/${ref}/smart-router.json`, error: reason })],
    ["roster invalid", rosterRefusal(id, { kind: "invalid", path: "/agent/smart-router.json", error: `roles[0].models[0]: "${ref}" ${reason}` })],
    ["noBoundedHistory", noBoundedHistory(id)],
    ["unroutable", unroutable(id, { attempts: attempts(ref, reason) }, { localOnly: false })],
    ["unroutable local", unroutable(id, { attempts: attempts(ref, reason) }, { localOnly: true })],
    ["unroutable missing role", unroutable(id, { attempts: [{ role: reason, exists: false, candidates: [] }] }, { localOnly: false })],
    ["unroutable problem", unroutable(id, { attempts: [], problem: `${ref} ${reason}` }, { localOnly: true })],
    ["stale", stale(id)],
    ["invariant", invariant(id, ref, reason)],
    ["scope unreadable", scopeUnreadable(id, reason)],
    ["scope unserved", scopeUnserved(id, "personal", 2)],
    // In work scope, where a way out names only the models of the work account.
    ["roster missing in work scope", rosterRefusal(id, { kind: "missing", path: `/agent/${ref}/smart-router.json`, error: reason }, true)],
    ["roster invalid in work scope", rosterRefusal(id, { kind: "invalid", path: "/agent/smart-router.json", error: `roles[0].models[0]: "${ref}" ${reason}` }, true)],
    ["scope unreadable in work scope", scopeUnreadable(id, reason, true)],
    ["scope unserved in work scope", scopeUnserved(id, "work", 1, true)],
    ["scope unserved in work scope, outside the latch", scopeUnserved(id, "work", 2, true, true)],
    ["unroutable in work scope", unroutable(id, { attempts: attempts(ref, reason) }, { localOnly: false, work: true })],
    ["unroutable local in work scope", unroutable(id, { attempts: attempts(ref, reason) }, { localOnly: true, work: true })],
    ["unroutable problem in work scope", unroutable(id, { attempts: [], problem: `${ref} ${reason}` }, { localOnly: false, work: true })],
    ["invariant in work scope", invariant(id, ref, reason, true)],
  ];
}

describe("every refusal", () => {
  test("names the virtual model, says nothing was sent, and is never retryable", () => {
    for (const id of ["auto", "local"] as const) {
      for (const [name, error] of templates(id, "omlx-hera/GLM-5.3-Flash-oQ4e-mtp", "is not in the catalog")) {
        assert.ok(error instanceof RouterError, name);
        assert.ok(error.message.startsWith(`smart-router/${id}: `), `${name}: ${error.message}`);
        assert.match(error.message, /Nothing was sent\./, name);
        assert.equal(retryable(error.message), false, `${name}: ${error.message}`);
        assert.notEqual(error.message, fixedText(id), `${name} keeps its own words when they are safe`);
      }
    }
  });

  test("stays non-retryable with fuzzed refs and reasons, falling back to the fixed text", () => {
    let fixed = 0;
    for (const id of ["auto", "local"] as const) {
      for (const poison of POISON) {
        for (const [ref, reason] of [
          [`openrouter/model${poison}`, "is not available"],
          ["openrouter/deepseek/deepseek-v4.1-flash-1017", `failed: ${poison}`],
          [`omlx-hera/${poison}`, poison],
        ] as const) {
          for (const [name, error] of templates(id, ref, reason)) {
            assert.equal(retryable(error.message), false, `${name} with ${JSON.stringify([ref, reason])}: ${error.message}`);
            assert.match(error.message, new RegExp(`^smart-router/${id}: .*Nothing was sent\\.`), name);
            if (error.message === fixedText(id)) fixed += 1;
          }
        }
      }
    }
    assert.ok(fixed > 0, "some fuzzed texts were retryable as composed, so the fixed text took over");
  });

  test("the fixed text and the stale-route text are exactly as designed", () => {
    for (const id of ["auto", "local"] as const) {
      assert.equal(fixedText(id), `smart-router/${id}: the request cannot be routed; see /smart-router status. Nothing was sent.`);
      assert.equal(retryable(fixedText(id)), false);
    }
    assert.equal(stale("auto").message, "smart-router/auto: this request came through a route left by a session that has ended. Nothing was sent. Run /reload.");
  });

  test("a composed text that would be retried is replaced, never thrown as composed", () => {
    assert.equal(looksRetryable("smart-router/auto: x-503. Nothing was sent. y"), true);
    assert.equal(refusal("auto", "x-503", "y").message, fixedText("auto"));
    assert.equal(refusal("auto", "x", "y").message, "smart-router/auto: x. Nothing was sent. y");
  });

  test("an unroutable refusal lists each role and candidate in the router's words", () => {
    const error = unroutable("auto", { attempts: attempts("openai-codex-2/gpt-6.1-sol", "not among the available models") }, { localOnly: false });
    assert.equal(
      error.message,
      "smart-router/auto: no model can take this request (engineer: openai-codex-2/gpt-6.1-sol: not among the available models; fallback coder: openai-codex-2/gpt-6.1-sol-b: cooling down until 14:05 (not among the available models)). Nothing was sent. See /smart-router status, or choose a model with /model.",
    );
    const local = unroutable(
      "local",
      { attempts: [{ role: "local", exists: true, candidates: [{ ok: false, ref: "omlx-hera/GLM-5.3-Flash-oQ4e-mtp", reason: "not-in-catalog", detail: "not in the catalog" }] }] },
      { localOnly: true },
    );
    assert.equal(
      local.message,
      "smart-router/local: no local model can take this request (local: omlx-hera/GLM-5.3-Flash-oQ4e-mtp: not in the catalog). Nothing was sent. Start the local model server and send the prompt again, or choose another model with /model.",
    );
  });
});

describe("in work scope", () => {
  const MISSING = { kind: "missing", path: "/agent/smart-router.json", error: "" } as const;
  const INVALID = { kind: "invalid", path: "/agent/smart-router.json", error: "JSON syntax error" } as const;
  const ATTEMPTS: Attempt[] = [{ role: "work-medium", exists: true, candidates: [{ ok: false, ref: "openai-codex-3/gpt-6.1-terra", reason: "not-in-catalog", detail: "not in the catalog" }] }];

  test("a refusal names only the models that keep the conversation on the work account: a work Codex model on smart-router/auto, and smart-router/auto too on smart-router/local", () => {
    assert.deepEqual(
      [
        rosterRefusal("auto", MISSING, true),
        rosterRefusal("local", INVALID, true),
        scopeUnreadable("auto", "the latest smart-router.scope entry is not one the router wrote", true),
        unroutable("auto", { attempts: ATTEMPTS }, { localOnly: false, stepUps: true, work: true }),
        unroutable("auto", { attempts: [], problem: "the roster has no work scope" }, { localOnly: false, work: true }),
        unroutable("local", { attempts: [], problem: "the roster has no local section" }, { localOnly: true, work: true }),
        invariant("auto", "openrouter/z-ai/glm-5.3", "is outside this session's work scope", true),
        invariant("local", "openrouter/z-ai/glm-5.3", "is not local", true),
      ].map((error) => error.message),
      [
        "smart-router/auto: the roster /agent/smart-router.json does not exist. Nothing was sent. Create it as the README describes, or choose a work Codex model with /model.",
        "smart-router/local: the roster /agent/smart-router.json is invalid (JSON syntax error). Nothing was sent. Fix it and send the prompt again, or choose smart-router/auto or a work Codex model with /model.",
        "smart-router/auto: this session's scope cannot be read (the latest smart-router.scope entry is not one the router wrote). Nothing was sent. Record it again with /smart-router scope work or /smart-router scope personal, or choose a work Codex model with /model.",
        "smart-router/auto: no model can take this request (work-medium: openai-codex-3/gpt-6.1-terra: not in the catalog). Nothing was sent. See /smart-router status, or choose a work Codex model with /model.",
        "smart-router/auto: the roster has no work scope. Nothing was sent. Fix the roster and send the prompt again, or choose a work Codex model with /model.",
        "smart-router/local: the roster has no local section. Nothing was sent. Fix the roster and send the prompt again, or choose smart-router/auto or a work Codex model with /model.",
        "smart-router/auto: the router picked openrouter/z-ai/glm-5.3, which is outside this session's work scope; this is a bug in pi-smart-router. Nothing was sent. Choose a work Codex model with /model.",
        "smart-router/local: the router picked openrouter/z-ai/glm-5.3, which is not local; this is a bug in pi-smart-router. Nothing was sent. Choose smart-router/auto or a work Codex model with /model.",
      ],
    );
  });

  test("a scope the roster does not serve: a version 1 roster binds no work account, so the roster is the only way out under the latch; a version 2 roster may bind one", () => {
    assert.equal(
      scopeUnserved("auto", "work", 1, true).message,
      "smart-router/auto: this session is in work scope, which a version 1 roster does not serve. Nothing was sent. Give the roster a work scope (version 2).",
    );
    assert.equal(
      scopeUnserved("auto", "work", 2, true).message,
      "smart-router/auto: this session is in work scope, which the roster does not serve. Nothing was sent. Give the roster a work scope, or choose a work Codex model with /model.",
    );
  });

  test("outside the latch, /smart-router scope personal is a way out of a scope the roster does not serve", () => {
    assert.equal(
      scopeUnserved("auto", "work", 1, true, true).message,
      "smart-router/auto: this session is in work scope, which a version 1 roster does not serve. Nothing was sent. Give the roster a work scope (version 2), or run /smart-router scope personal.",
    );
    assert.equal(
      scopeUnserved("auto", "work", 2, true, true).message,
      "smart-router/auto: this session is in work scope, which the roster does not serve. Nothing was sent. Give the roster a work scope, run /smart-router scope personal, or choose a work Codex model with /model.",
    );
  });

  test("outside work scope, the texts are as they were", () => {
    for (const error of [rosterRefusal("auto", MISSING), scopeUnreadable("auto", "x"), scopeUnserved("auto", "work", 1), unroutable("auto", { attempts: ATTEMPTS }, { localOnly: false }), invariant("auto", "a/b", "c")]) {
      assert.doesNotMatch(error.message, /work Codex/, error.message);
      assert.match(error.message, /[Cc]hoose a model with \/model\.$/, error.message);
    }
    assert.match(unroutable("local", { attempts: [], problem: "x" }, { localOnly: true, work: false }).message, /Fix the roster and send the prompt again, or choose another model with \/model\.$/);
  });
});

describe("notices and helpers", () => {
  test("notices name both models", () => {
    for (const notice of [loadFailedNotice("boom"), rosterNotice({ kind: "missing", path: "/agent/smart-router.json", error: "" }), historyNotice()]) {
      assert.match(notice, /smart-router\/auto and smart-router\/local refuse every request/);
    }
  });

  test("the removed pin's notices and the answer to /smart-router local say that it is gone, and how to route locally", () => {
    assert.equal(
      pinEnvNotice(),
      "pi-smart-router: PI_SMART_ROUTER_LOCAL_ONLY is set, but the local-only pin has been removed and keeps nothing local. Select smart-router/local to route locally.",
      "the environment switch's notice",
    );
    assert.equal(
      pinEntryNotice(),
      "pi-smart-router: an earlier version pinned this session to local models. The pin has been removed and is ignored: smart-router/auto routes by level here. Select smart-router/local to route locally.",
      "an old pin entry's notice",
    );
    assert.equal(PIN_REMOVED, "The local-only pin has been removed. To route locally, select the local model: /model smart-router/local", "the answer to /smart-router local");
    assert.doesNotMatch(historyNotice(), /pin/, "a Pi without bounded history is told nothing of a pin");
  });

  test("firstLine keeps the first line, at most 300 characters", () => {
    assert.equal(firstLine(new Error("boom\nstack")), "boom");
    assert.equal(firstLine("plain"), "plain");
    assert.equal(firstLine(new Error("x".repeat(400))).length, 300);
  });
});
