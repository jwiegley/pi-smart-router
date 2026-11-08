import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { EMPTY_POLICY, policyFromRoster } from "../src/local.ts";
import { clock, coolFrom, Cooldowns, failureKind, resolveCandidate, resolveContext } from "../src/resolve.ts";
import type { FailedResponse, Resolution, ResolveContext } from "../src/resolve.ts";
import type { Roster } from "../src/roster.ts";
import {
  ASTRA,
  DEEPSEEK,
  FakeCatalog,
  GLM,
  GLM_CLOUD,
  HERA_LABELS,
  heraContext,
  heraModels,
  KIMI,
  labelsOf,
  model,
  NATIVE_SOL,
  NOW,
  rosterFixture,
  SOL,
  WORK_SOL,
} from "./support/catalog.ts";

const HERA = rosterFixture("roster-hera.json");

function refused(resolution: Resolution, reason: string | RegExp, detail?: RegExp): void {
  assert.equal(resolution.ok, false, JSON.stringify(resolution));
  if (resolution.ok) return;
  if (typeof reason === "string") assert.equal(resolution.reason, reason);
  else assert.match(resolution.reason, reason);
  if (detail !== undefined) assert.match(resolution.detail, detail);
}

function resolves(resolution: Resolution): void {
  assert.equal(resolution.ok, true, JSON.stringify(resolution));
}

/** Hera's roster with one role's models replaced, as if validation had been bypassed. */
function withRole(name: string, models: string[]): Roster {
  return { ...HERA, roles: HERA.roles.map((role) => (role.name === name ? { ...role, models } : role)) };
}

/** A context over a catalog the test prepares. */
function contextWith(catalog: FakeCatalog, overrides: Partial<Omit<ResolveContext, "available" | "catalog">> = {}): ResolveContext {
  const base = heraContext(overrides);
  return resolveContext({ ...base, catalog });
}

describe("each reason, in order", () => {
  test("every roster model on Hera resolves for the role auto routes to it", () => {
    const rc = heraContext();
    for (const ref of [DEEPSEEK, KIMI, GLM_CLOUD, SOL, ASTRA]) resolves(resolveCandidate(ref, rc));
    resolves(resolveCandidate(GLM, heraContext({ virtualId: "local" })));
  });

  test("excluded: the built-ins and the roster's own, even for a ref that shares an allowed ref's id", () => {
    const rc = heraContext();
    refused(resolveCandidate(WORK_SOL, rc), "excluded", /openai-codex-3\/\*/);
    resolves(resolveCandidate(SOL, rc));
    refused(resolveCandidate(NATIVE_SOL, rc), "excluded", /openai-codex\/\*/);
    refused(resolveCandidate("hermes/agent", rc), "excluded");
    refused(resolveCandidate("openrouter/openrouter/auto", rc), "excluded");
    refused(resolveCandidate("smart-router/auto", rc), "excluded");
  });

  test("excluded: the built-ins hold even when a roster object lacks them", () => {
    const rc = heraContext({ roster: { ...HERA, exclude: [] } });
    refused(resolveCandidate(WORK_SOL, rc), "excluded");
    refused(resolveCandidate("smart-router/auto", rc), "excluded");
  });

  test("excluded is reported before any later check", () => {
    const catalog = new FakeCatalog(heraModels()).remove(WORK_SOL);
    refused(resolveCandidate(WORK_SOL, contextWith(catalog)), "excluded");
  });

  test("not-in-catalog: absent, or a lookup answered with another model", () => {
    refused(resolveCandidate(GLM, contextWith(new FakeCatalog(heraModels()).remove(GLM), { virtualId: "local" })), "not-in-catalog");
    const aliasing = new FakeCatalog(heraModels());
    aliasing.models.set(KIMI, model("openrouter/moonshotai/kimi-k3"));
    refused(resolveCandidate(KIMI, contextWith(aliasing)), "not-in-catalog");
    refused(resolveCandidate("no-slash", heraContext()), "not-in-catalog");
  });

  test("virtual: a virtual catalog entry is never a target", () => {
    const catalog = new FakeCatalog(heraModels()).add(model("router/auto", { api: "pi-virtual" }));
    const roster = withRole("worker", ["router/auto", DEEPSEEK]);
    refused(resolveCandidate("router/auto", contextWith(catalog, { roster })), "virtual");
  });

  test("not-available: getAvailable() membership, collected once per call", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(DEEPSEEK);
    const rc = contextWith(catalog);
    const calls = catalog.availableCalls;
    refused(resolveCandidate(DEEPSEEK, rc), "not-available");
    resolves(resolveCandidate(KIMI, rc));
    assert.equal(catalog.availableCalls, calls, "the set is built when the context is");
    catalog.unavailable.delete(DEEPSEEK);
    refused(resolveCandidate(DEEPSEEK, rc), "not-available", /not among the available models/);
  });

  test("no-credentials: hasConfiguredAuth is the second check", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unauthenticated.add(KIMI);
    refused(resolveCandidate(KIMI, contextWith(catalog)), "no-credentials");
    catalog.unavailable.add(KIMI);
    refused(resolveCandidate(KIMI, contextWith(catalog)), "not-available");
  });

  test("account: a refused, missing or unmatched Multi-Pass label refuses the alias", () => {
    refused(resolveCandidate(SOL, heraContext({ labels: labelsOf([{ provider: "openai-codex", index: 2, label: "work" }]) })), "account", /refused label/);
    refused(resolveCandidate(SOL, heraContext({ labels: labelsOf([{ provider: "openai-codex", index: 2, label: "spare" }]) })), "account", /not "personal"/);
    refused(resolveCandidate(SOL, heraContext({ labels: labelsOf([]) })), "account", /lists no openai-codex-2/);
    refused(resolveCandidate(SOL, heraContext({ labels: undefined })), "account", /were not read/);
    refused(resolveCandidate(SOL, heraContext({ labels: { kind: "unsafe", path: "/agent/multi-pass.json", error: "mode 666", loadedAt: 0 } })), "account");
    resolves(resolveCandidate(SOL, heraContext({ labels: HERA_LABELS })));
  });

  test("account: a native login needs the roster's acknowledgement", () => {
    const others = rosterFixture("roster-other-hosts.json");
    resolves(resolveCandidate(NATIVE_SOL, heraContext({ roster: others, labels: undefined })));
    refused(resolveCandidate(NATIVE_SOL, heraContext({ roster: { ...others, accounts: new Map() }, labels: undefined })), "account", /no account binding/);
  });

  test("cooling: until the cooldown expires, shown as local HH:MM", () => {
    const cooldowns = new Cooldowns();
    const until = NOW + 30 * 60_000;
    cooldowns.cool(SOL, 1, NOW, 30);
    refused(resolveCandidate(SOL, heraContext({ cooldowns })), `cooling-until-${clock(until)}`, /cooling down until \d\d:\d\d/);
    refused(resolveCandidate(SOL, heraContext({ cooldowns, now: until - 1 })), /^cooling-until-/);
    resolves(resolveCandidate(SOL, heraContext({ cooldowns, now: until })));
    resolves(resolveCandidate(ASTRA, heraContext({ cooldowns })));
  });

  test("cooling: a local-role candidate is never cooling", () => {
    const cooldowns = new Cooldowns();
    cooldowns.cool(GLM, 1, NOW, 30);
    resolves(resolveCandidate(GLM, heraContext({ cooldowns, virtualId: "local" })));
  });

  test("not-routable-by-auto: a role neither routing nor any fallback names", () => {
    refused(resolveCandidate(GLM, heraContext()), "not-routable-by-auto", /role local/);
    resolves(resolveCandidate(GLM_CLOUD, heraContext()));
    resolves(resolveCandidate(KIMI, heraContext()));
    resolves(resolveCandidate(GLM, heraContext({ virtualId: "local" })));
    const noFallback: Roster = { ...HERA, routing: { ...HERA.routing, fallback: new Map() } };
    refused(resolveCandidate(GLM_CLOUD, heraContext({ roster: noFallback })), "not-routable-by-auto");
    refused(resolveCandidate("openrouter/other/model", contextWith(new FakeCatalog([...heraModels(), model("openrouter/other/model")]))), "not-routable-by-auto", /in no role/);
  });

  test("not-local: the provider, the parsed catalog host and the policy's refs", () => {
    const local = heraContext({ virtualId: "local" });
    resolves(resolveCandidate(GLM, local));
    const cloudInLocalRole = withRole("local", [KIMI]);
    refused(resolveCandidate(KIMI, heraContext({ roster: cloudInLocalRole, virtualId: "local", policy: policyFromRoster(cloudInLocalRole) })), "not-local", /not a local provider/);
    const moved = new FakeCatalog(heraModels()).add(model(GLM, { baseUrl: "https://hera.lan.example.com/v1" }));
    refused(resolveCandidate(GLM, contextWith(moved, { virtualId: "local" })), "not-local", /host hera\.lan\.example\.com/);
    const upper = new FakeCatalog(heraModels()).add(model(GLM, { baseUrl: "HTTPS://HERA.LAN:8443/v1" }));
    resolves(resolveCandidate(GLM, contextWith(upper, { virtualId: "local" })));
    refused(resolveCandidate(GLM, heraContext({ virtualId: "local", policy: EMPTY_POLICY })), "not-local");
    const recorded = { ...policyFromRoster(HERA), refs: [] };
    refused(resolveCandidate(GLM, heraContext({ virtualId: "local", policy: recorded })), "not-local", /not in the local role/);
  });

  test("not-local applies to every local-only request, whatever the virtual model", () => {
    refused(resolveCandidate(DEEPSEEK, heraContext({ localOnly: true })), "not-local");
    resolves(resolveCandidate(DEEPSEEK, heraContext({ localOnly: false })));
  });

  test("the first failing check is the one reported", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(SOL);
    const cooldowns = new Cooldowns();
    cooldowns.cool(SOL, 1, NOW, 30);
    refused(resolveCandidate(SOL, contextWith(catalog, { cooldowns, localOnly: true, labels: labelsOf([]) })), "not-available");
    catalog.unavailable.delete(SOL);
    refused(resolveCandidate(SOL, contextWith(catalog, { cooldowns, localOnly: true, labels: labelsOf([]) })), "account");
    refused(resolveCandidate(SOL, contextWith(catalog, { cooldowns, localOnly: true })), /^cooling-until-/);
    refused(resolveCandidate(SOL, contextWith(catalog, { localOnly: true })), "not-local");
  });
});

describe("cooldown rules", () => {
  const failure = (ref: string, errorMessage: string, extra: Partial<FailedResponse> = {}): FailedResponse => {
    const slash = ref.indexOf("/");
    return { provider: ref.slice(0, slash), model: ref.slice(slash + 1), api: "openai-completions", stopReason: "error", errorMessage, timestamp: NOW - 1000, ...extra };
  };

  test("usage-limit and authentication errors cool the model for cooldownMinutes", () => {
    for (const text of [
      "You've hit your usage limit. Try again later.",
      "Monthly usage_limit reached",
      "quota exceeded for this key",
      "insufficient_quota",
      "billing details required",
      "subscription_sharing_usage_limit_exceeded",
      "ResourceExhausted: try later",
      "RESOURCE_EXHAUSTED",
      "401 Unauthorized",
      "HTTP 403",
      "unauthorised",
      "Forbidden",
      "The model gpt-6.1-sol was not found",
      "model_not_found",
    ]) {
      assert.equal(failureKind(text), "limit", text);
      const cooldowns = new Cooldowns();
      assert.equal(coolFrom(failure(SOL, text), HERA, cooldowns, NOW), SOL, text);
      assert.equal(cooldowns.until(SOL, NOW), NOW + 30 * 60_000, text);
    }
  });

  test("content-filter refusals never cool, even with an auth-looking status", () => {
    for (const text of ["content_filter", "Your request was flagged", "violates our content policy", "moderation failed", "403 content filter", "blocked for safety"]) {
      assert.equal(failureKind(text), "content-filter", text);
      const cooldowns = new Cooldowns();
      assert.equal(coolFrom(failure(SOL, text), HERA, cooldowns, NOW), undefined, text);
      assert.equal(cooldowns.until(SOL, NOW), undefined, text);
    }
  });

  test("transient errors never cool", () => {
    for (const text of ["429 Too Many Requests", "rate limit reached", "overloaded", "Request timed out", "request id 14012 failed", "503 Service Unavailable", ""]) {
      assert.equal(failureKind(text), "other", text);
      assert.equal(coolFrom(failure(SOL, text), HERA, new Cooldowns(), NOW), undefined, text);
    }
    assert.equal(failureKind(undefined), "other");
  });

  test("router refusals, local-role models and responses that are not errors never cool", () => {
    const cooldowns = new Cooldowns();
    assert.equal(coolFrom(failure("smart-router/auto", "usage limit"), HERA, cooldowns, NOW), undefined);
    assert.equal(coolFrom(failure(SOL, "usage limit", { api: "pi-virtual" }), HERA, cooldowns, NOW), undefined);
    assert.equal(coolFrom(failure(GLM, "401 Unauthorized"), HERA, cooldowns, NOW), undefined);
    assert.equal(coolFrom(failure(SOL, "usage limit", { stopReason: "stop" }), HERA, cooldowns, NOW), undefined);
    assert.equal(coolFrom(failure(SOL, "usage limit", { stopReason: "aborted" }), HERA, cooldowns, NOW), undefined);
    assert.equal(cooldowns.until(GLM, NOW), undefined);
    assert.equal(cooldowns.until(SOL, NOW), undefined);
  });

  test("one failed response cools once; a later one cools again", () => {
    const cooldowns = new Cooldowns();
    const first = failure(SOL, "usage limit", { timestamp: 1 });
    coolFrom(first, HERA, cooldowns, NOW);
    coolFrom(first, HERA, cooldowns, NOW + 10 * 60_000);
    assert.equal(cooldowns.until(SOL, NOW), NOW + 30 * 60_000);
    coolFrom(failure(SOL, "usage limit", { timestamp: 2 }), HERA, cooldowns, NOW + 10 * 60_000);
    assert.equal(cooldowns.until(SOL, NOW), NOW + 40 * 60_000);
    const quick: Roster = { ...HERA, cooldownMinutes: 1 };
    coolFrom(failure(KIMI, "quota", { timestamp: 3 }), quick, cooldowns, NOW);
    assert.equal(cooldowns.until(KIMI, NOW), NOW + 60_000);
    assert.equal(cooldowns.until(KIMI, NOW + 60_000), undefined);
  });

  test("an error text's provider body is judged by its first 8 KiB", () => {
    assert.equal(failureKind(`${"x".repeat(9000)} usage limit`), "other");
    assert.equal(failureKind(`usage limit ${"x".repeat(9000)}`), "limit");
  });
});

describe("the local host check uses the catalog base URL", () => {
  test("GLM on hera.lan is local; the same model id behind another host is not", () => {
    const rc = heraContext({ virtualId: "local" });
    resolves(resolveCandidate(GLM, rc));
    const elsewhere = new FakeCatalog(heraModels()).add(model(GLM, { baseUrl: "https://openrouter.ai/api/v1" }));
    refused(resolveCandidate(GLM, contextWith(elsewhere, { virtualId: "local" })), "not-local", /host openrouter\.ai is not a local host/);
    const missing = new FakeCatalog(heraModels()).add(model(GLM, { baseUrl: "" }));
    refused(resolveCandidate(GLM, contextWith(missing, { virtualId: "local" })), "not-local", /no base URL host/);
  });
});
