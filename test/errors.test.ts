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
  refusal,
  RouterError,
  rosterNotice,
  rosterRefusal,
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
    ["unroutable", unroutable(id, { attempts: attempts(ref, reason) }, { localOnly: false, pinned: false })],
    ["unroutable local", unroutable(id, { attempts: attempts(ref, reason) }, { localOnly: true, pinned: false })],
    ["unroutable pinned", unroutable(id, { attempts: attempts(ref, reason) }, { localOnly: true, pinned: true })],
    ["unroutable missing role", unroutable(id, { attempts: [{ role: reason, exists: false, candidates: [] }] }, { localOnly: false, pinned: false })],
    ["unroutable problem", unroutable(id, { attempts: [], problem: `${ref} ${reason}` }, { localOnly: true, pinned: true })],
    ["stale", stale(id)],
    ["invariant", invariant(id, ref, reason)],
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
    const error = unroutable("auto", { attempts: attempts("openai-codex-2/gpt-6.1-sol", "not among the available models") }, { localOnly: false, pinned: false });
    assert.equal(
      error.message,
      "smart-router/auto: no model can take this request (engineer: openai-codex-2/gpt-6.1-sol: not among the available models; fallback coder: openai-codex-2/gpt-6.1-sol-b: cooling down until 14:05 (not among the available models)). Nothing was sent. See /smart-router status, or choose a model with /model.",
    );
    const local = unroutable(
      "local",
      { attempts: [{ role: "local", exists: true, candidates: [{ ok: false, ref: "omlx-hera/GLM-5.3-Flash-oQ4e-mtp", reason: "not-in-catalog", detail: "not in the catalog" }] }] },
      { localOnly: true, pinned: true },
    );
    assert.equal(
      local.message,
      "smart-router/local: no local model can take this request while this session is pinned to local models (local: omlx-hera/GLM-5.3-Flash-oQ4e-mtp: not in the catalog). Nothing was sent. Start the local model server and send the prompt again, or run /smart-router local off.",
    );
  });
});

describe("notices and helpers", () => {
  test("notices name both models", () => {
    for (const notice of [loadFailedNotice("boom"), rosterNotice({ kind: "missing", path: "/agent/smart-router.json", error: "" }), historyNotice()]) {
      assert.match(notice, /smart-router\/auto and smart-router\/local refuse every request/);
    }
  });

  test("firstLine keeps the first line, at most 300 characters", () => {
    assert.equal(firstLine(new Error("boom\nstack")), "boom");
    assert.equal(firstLine("plain"), "plain");
    assert.equal(firstLine(new Error("x".repeat(400))).length, 300);
  });
});
