import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Usage } from "@earendil-works/pi-ai";

import { checkAccount } from "../src/accounts.ts";
import type { Labels } from "../src/accounts.ts";
import { BUILTIN_EXCLUDES } from "../src/constants.ts";
import type { VirtualId } from "../src/constants.ts";
import { eligibleRole, fits, NO_LOCAL_SECTION, pickInRole, planUserTurn, reserveFor } from "../src/decide.ts";
import type { Choice, Decision, LastResponder, Plan } from "../src/decide.ts";
import type { Loaded } from "../src/files.ts";
import { baseUrlHost, checkLocal, isLocalHost, policyFromRoster } from "../src/local.ts";
import type { LocalPolicy } from "../src/local.ts";
import { Cooldowns, refOf, resolveCandidate, resolveContext } from "../src/resolve.ts";
import type { ResolveContext } from "../src/resolve.ts";
import { autoRoles, excludedBy, roleOf } from "../src/roster.ts";
import type { AccountBinding, Role, Roster } from "../src/roster.ts";
import {
  ASTRA,
  CHATGPT,
  DEEPSEEK,
  FakeCatalog,
  GLM,
  GLM_CLOUD,
  HERA_LAN,
  heraContext,
  heraModels,
  KIMI,
  labelsOf,
  model,
  NATIVE_SOL,
  NOW,
  OPENROUTER,
  rosterFixture,
  SOL,
  WORK_SOL,
} from "./support/catalog.ts";

const HERA = rosterFixture("roster-hera.json");
const MINUTE = 60_000;

function usage(totalTokens: number): Usage {
  return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function last(ref: string, ago: number, tokens?: number): LastResponder {
  return { ref, at: NOW - ago, ...(tokens === undefined ? {} : { usage: usage(tokens) }) };
}

function plan(text: string, options: { last?: LastResponder; rc?: ResolveContext; reserve?: number } = {}): Plan {
  return planUserTurn({ rc: options.rc ?? heraContext(), text, last: options.last, now: NOW, reserve: options.reserve ?? 16_384 });
}

function chosen(decision: Decision): Choice {
  assert.ok(decision.ok, JSON.stringify(decision));
  return decision.choice;
}

function expectPlan(result: Plan, ref: string, code: string): void {
  const choice = chosen(result.decision);
  assert.deepEqual([choice.ref, choice.code], [ref, code], JSON.stringify(result));
}

function contextWith(catalog: FakeCatalog, overrides: Partial<Omit<ResolveContext, "available" | "catalog">> = {}): ResolveContext {
  return resolveContext({ ...heraContext(overrides), catalog });
}

const PLANNING = "plan the migration to the new store";
const COMPLEX = "Debug the deadlock in concurrent writes";
const TRIVIAL = "Format this file";
const PLAIN = "Hello, how are you today?";

describe("the routing table", () => {
  test("a first run follows the classification", () => {
    expectPlan(plan(PLANNING), ASTRA, "signal:planning");
    expectPlan(plan(COMPLEX), SOL, "signal:complex");
    expectPlan(plan(TRIVIAL), DEEPSEEK, "signal:trivial");
    expectPlan(plan(PLAIN), DEEPSEEK, "signal:default");
    const result = plan(PLANNING);
    assert.deepEqual([result.signal, result.reason, result.role, result.code], ["planning", "planning:plan-words", "architect", "signal:planning"]);
  });

  test("escalation is immediate", () => {
    expectPlan(plan(COMPLEX, { last: last(DEEPSEEK, 10_000) }), SOL, "signal:complex");
    expectPlan(plan(PLANNING, { last: last(SOL, 10_000) }), ASTRA, "signal:planning");
  });

  test("the same role holds its model", () => {
    expectPlan(plan(COMPLEX, { last: last(SOL, 10_000) }), SOL, "signal:complex");
  });

  test("a lower role holds the latest response's role inside the idle window", () => {
    expectPlan(plan(COMPLEX, { last: last(ASTRA, MINUTE) }), ASTRA, "hold:sticky");
    expectPlan(plan(TRIVIAL, { last: last(ASTRA, 5 * MINUTE - 1) }), ASTRA, "hold:sticky");
    expectPlan(plan(TRIVIAL, { last: last(SOL, MINUTE) }), SOL, "hold:sticky");
  });

  test("a lower role reopens once the session has been idle for stickyIdleMinutes", () => {
    expectPlan(plan(TRIVIAL, { last: last(ASTRA, 5 * MINUTE) }), DEEPSEEK, "reopen:idle");
    expectPlan(plan(COMPLEX, { last: last(ASTRA, 6 * MINUTE) }), SOL, "reopen:idle");
  });

  test("stickyIdleMinutes 0 re-routes every run by its classification", () => {
    const rc = heraContext({ roster: { ...HERA, stickyIdleMinutes: 0 } });
    expectPlan(plan(COMPLEX, { rc, last: last(ASTRA, 0) }), SOL, "reopen:idle");
  });

  test("the fit guard holds a downgrade the conversation would not fit", () => {
    // DeepSeek's window is 128,000; 16,384 are reserved.
    expectPlan(plan(TRIVIAL, { last: last(ASTRA, 6 * MINUTE, 120_000) }), ASTRA, "hold:fit");
    expectPlan(plan(TRIVIAL, { last: last(ASTRA, 6 * MINUTE, 100_000) }), DEEPSEEK, "reopen:idle");
    expectPlan(plan(TRIVIAL, { last: last(ASTRA, 6 * MINUTE, 120_000), reserve: 4_096 }), DEEPSEEK, "reopen:idle");
    const huge = `${TRIVIAL} ${"word ".repeat(60_000)}`;
    expectPlan(plan(huge, { last: last(ASTRA, 6 * MINUTE, 50_000) }), ASTRA, "hold:fit");
  });

  test("a downgrade to a role that cannot take the run reports why instead of holding", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(DEEPSEEK);
    const result = plan(TRIVIAL, { rc: contextWith(catalog), last: last(ASTRA, 6 * MINUTE) });
    assert.equal(result.decision.ok, false);
    assert.deepEqual([result.role, result.code], ["worker", "reopen:idle"]);
  });

  test("the sticky role prefers the model that answered last", () => {
    const roster: Roster = { ...HERA, roles: HERA.roles.map((role) => (role.name === "architect" ? { ...role, models: [ASTRA, "openrouter/other/architect"] } : role)) };
    const catalog = new FakeCatalog([...heraModels(), model("openrouter/other/architect")]);
    expectPlan(plan(COMPLEX, { rc: contextWith(catalog, { roster }), last: last("openrouter/other/architect", MINUTE) }), "openrouter/other/architect", "hold:sticky");
    catalog.unavailable.add("openrouter/other/architect");
    expectPlan(plan(COMPLEX, { rc: contextWith(catalog, { roster }), last: last("openrouter/other/architect", MINUTE) }), ASTRA, "hold:sticky");
  });

  test("auto never sticks to the local role", () => {
    expectPlan(plan(TRIVIAL, { last: last(GLM, 10_000) }), DEEPSEEK, "signal:trivial");
    assert.equal(eligibleRole(heraContext(), GLM), undefined);
    assert.equal(eligibleRole(heraContext({ virtualId: "local" }), GLM), "local");
  });

  test("a last responder outside the roster does not hold", () => {
    expectPlan(plan(TRIVIAL, { last: last("openrouter/someone/else", 10_000) }), DEEPSEEK, "signal:trivial");
  });
});

describe("fallback", () => {
  test("is one hop to the declared role", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(SOL);
    expectPlan(plan(COMPLEX, { rc: contextWith(catalog) }), GLM_CLOUD, "fallback:engineer→coder");
    catalog.unavailable.add(ASTRA);
    expectPlan(plan(PLANNING, { rc: contextWith(catalog) }), KIMI, "fallback:architect→thinker");
  });

  test("never takes a second hop", () => {
    const chained: Roster = { ...HERA, routing: { ...HERA.routing, fallback: new Map([...HERA.routing.fallback, ["coder", "thinker"]]) } };
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(SOL);
    catalog.unavailable.add(GLM_CLOUD);
    const result = plan(COMPLEX, { rc: contextWith(catalog, { roster: chained }) });
    assert.equal(result.decision.ok, false, "thinker is two hops from engineer");
  });

  test("without one, the refusal lists every candidate's reason", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(DEEPSEEK);
    const result = plan(TRIVIAL, { rc: contextWith(catalog) });
    assert.deepEqual(result.decision, {
      ok: false,
      attempts: [{ role: "worker", exists: true, candidates: [{ ok: false, ref: DEEPSEEK, reason: "not-available", detail: "not among the available models" }] }],
    });
    const cooldowns = new Cooldowns();
    catalog.unavailable.delete(DEEPSEEK);
    catalog.unavailable.add(SOL);
    cooldowns.cool(GLM_CLOUD, 1, NOW, 30);
    const both = plan(COMPLEX, { rc: contextWith(catalog, { cooldowns }) });
    assert.equal(both.decision.ok, false);
    if (!both.decision.ok) {
      const [engineer, coder] = both.decision.attempts;
      assert.equal(both.decision.attempts.length, 2);
      assert.deepEqual([engineer?.role, engineer?.candidates.map((candidate) => [candidate.ref, candidate.reason])], ["engineer", [[SOL, "not-available"]]]);
      assert.deepEqual([coder?.role, coder?.candidates.map((candidate) => candidate.ref)], ["coder", [GLM_CLOUD]]);
      assert.match(coder?.candidates[0]?.reason ?? "", /^cooling-until-\d\d:\d\d$/);
    }
  });

  test("skip passes over the model that just failed, then falls back", () => {
    const next = chosen(pickInRole(heraContext(), "engineer", { skip: SOL, fallback: true, code: "retry:next" }));
    assert.deepEqual([next.ref, next.role, next.code], [GLM_CLOUD, "coder", "fallback:engineer→coder"]);
    const decision = pickInRole(heraContext(), "engineer", { skip: SOL, fallback: false, code: "retry:next" });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.deepEqual(decision.attempts[0]?.candidates.map((candidate) => candidate.reason), ["failed"]);
  });

  test("a role the roster lacks is reported as missing", () => {
    const decision = pickInRole(heraContext(), "nope", { fallback: true, code: "stick:default" });
    assert.deepEqual(decision, { ok: false, attempts: [{ role: "nope", exists: false, candidates: [] }] });
  });
});

describe("local-only plans", () => {
  test("use the local role and never its fallback", () => {
    expectPlan(plan(PLANNING, { rc: heraContext({ virtualId: "local" }) }), GLM, "local");
    const withFallback: Roster = { ...HERA, routing: { ...HERA.routing, fallback: new Map([["local", "worker"]]) } };
    const catalog = new FakeCatalog(heraModels()).remove(GLM);
    const result = plan(PLANNING, { rc: contextWith(catalog, { roster: withFallback, virtualId: "local" }) });
    assert.equal(result.decision.ok, false);
    assert.deepEqual([result.signal, result.role, result.localOnly], ["local", "local", true]);
  });

  test("a local-only pick never falls back, even when the caller allows it and the fallback is local", () => {
    const QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";
    const roster: Roster = {
      ...HERA,
      roles: HERA.roles.map((role) => (role.name === "worker" ? { ...role, models: [QWEN] } : role)),
      routing: { ...HERA.routing, fallback: new Map([["local", "worker"]]) },
    };
    const policy = { refs: [GLM, QWEN], providers: ["omlx-hera"], hosts: ["hera.lan"] };
    const catalog = new FakeCatalog([...heraModels(), model(QWEN, { baseUrl: HERA_LAN })]);
    catalog.unavailable.add(GLM);
    const decision = pickInRole(contextWith(catalog, { roster, virtualId: "local", policy }), "local", { fallback: true, code: "local" });
    assert.equal(decision.ok, false, JSON.stringify(decision));
    // The control: without local-only, the same call takes the declared fallback.
    const open = chosen(pickInRole(contextWith(catalog, { roster, virtualId: "auto", localOnly: false, policy }), "local", { fallback: true, code: "x" }));
    assert.deepEqual([open.ref, open.code], [QWEN, "fallback:local→worker"]);
  });

  test("a pinned auto selection is local-only too", () => {
    const result = plan(PLANNING, { rc: heraContext({ localOnly: true }) });
    assert.equal(result.decision.ok, false, "Hera's local role is not one auto may reach");
    const reachable: Roster = { ...HERA, routing: { ...HERA.routing, trivial: "local" } };
    expectPlan(plan(PLANNING, { rc: heraContext({ roster: reachable, localOnly: true, policy: policyFromRoster(reachable) }) }), GLM, "local");
  });

  test("refuse without a local section", () => {
    const { local: _local, ...rest } = HERA;
    const result = plan(PLANNING, { rc: heraContext({ roster: rest, virtualId: "local" }) });
    assert.deepEqual(result.decision, { ok: false, attempts: [], problem: NO_LOCAL_SECTION });
    assert.equal(result.role, undefined);
  });
});

describe("fits and the reserve", () => {
  test("fits measures the latest usage plus the new prompt against the window less the reserve", () => {
    const window = model("x/y", { contextWindow: 100_000 });
    // "hi" estimates as one token.
    assert.equal(fits({ last: last(ASTRA, 0, 90_000), text: "hi", now: NOW, reserve: 9_999 }, window), true);
    assert.equal(fits({ last: last(ASTRA, 0, 90_000), text: "hi", now: NOW, reserve: 10_000 }, window), false);
    assert.equal(fits({ last: undefined, text: "a".repeat(400_000), now: NOW, reserve: 0 }, window), true);
    assert.equal(fits({ last: undefined, text: "a".repeat(400_004), now: NOW, reserve: 0 }, window), false);
    assert.equal(fits({ last: last(ASTRA, 0, 10_000_000), text: "hi", now: NOW, reserve: 0 }, model("x/z", { contextWindow: 0 })), true);
  });

  test("the reserve comes from the selection's override, then the setting, then Pi's default", () => {
    assert.equal(reserveFor({}, "auto"), 16_384);
    assert.equal(reserveFor(undefined, "auto"), 16_384);
    assert.equal(reserveFor({ compaction: { reserveTokens: 4_096 } }, "auto"), 4_096);
    const settings = { compaction: { reserveTokens: 4_096, modelOverrides: { "smart-router/auto": { reserveTokens: 32_000 }, "smart-router/local": { keepRecentTokens: 1 } } } };
    assert.equal(reserveFor(settings, "auto"), 32_000);
    assert.equal(reserveFor(settings, "local"), 4_096);
    assert.equal(reserveFor({ compaction: { reserveTokens: -1, modelOverrides: { "smart-router/auto": { reserveTokens: 1.5 } } } }, "auto"), 16_384);
    assert.equal(reserveFor({ compaction: { modelOverrides: { "smart-router/auto": { reserveTokens: 0 } } } }, "auto"), 0);
  });
});

// ─── Property-style checks ──────────────────────────────────────────────────

/** mulberry32: a small seeded PRNG, so a failure names a reproducible case. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PoolEntry {
  readonly ref: string;
  readonly baseUrl?: string;
  readonly virtual?: boolean;
  readonly absent?: boolean;
}

const POOL: readonly PoolEntry[] = [
  { ref: GLM, baseUrl: HERA_LAN },
  { ref: "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp", baseUrl: HERA_LAN },
  { ref: "lan-box/tiny", baseUrl: "http://localhost:8080/v1" },
  { ref: "lan-box/cloudy", baseUrl: "https://api.openai.com/v1" },
  { ref: "lan-box/tailnet", baseUrl: "https://hera.tail1234.ts.net/v1" },
  { ref: DEEPSEEK, baseUrl: OPENROUTER },
  { ref: KIMI, baseUrl: OPENROUTER },
  { ref: GLM_CLOUD, baseUrl: OPENROUTER },
  { ref: SOL, baseUrl: CHATGPT },
  { ref: ASTRA, baseUrl: CHATGPT },
  { ref: WORK_SOL, baseUrl: CHATGPT },
  { ref: "openai-codex-3/gpt-6-astra", baseUrl: CHATGPT },
  { ref: NATIVE_SOL, baseUrl: CHATGPT },
  { ref: "hermes/agent", baseUrl: "http://127.0.0.1:9000/v1" },
  { ref: "openrouter/openrouter/auto", baseUrl: OPENROUTER },
  { ref: "smart-router/auto", virtual: true },
  { ref: "router/virtual", baseUrl: HERA_LAN, virtual: true },
  { ref: "ghost/missing", absent: true },
];
const NAMES = ["local", "worker", "thinker", "coder", "engineer", "architect"];
const TEXTS = [PLANNING, COMPLEX, TRIVIAL, PLAIN, "see PLAN.org", "", "clean up the repo", `${TRIVIAL} ${"x".repeat(30_000)}`];

interface Case {
  readonly rc: ResolveContext;
  readonly text: string;
  readonly last: LastResponder | undefined;
  readonly reserve: number;
}

function randomCase(seed: number): Case {
  const rand = prng(seed);
  const chance = (p: number): boolean => rand() < p;
  const one = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const some = <T>(items: readonly T[], p: number): T[] => items.filter(() => chance(p));
  const shuffled = <T>(items: readonly T[]): T[] =>
    items
      .map((item) => [rand(), item] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);

  const names = shuffled(NAMES).slice(0, 1 + Math.floor(rand() * NAMES.length));
  const refs = shuffled(POOL.map((entry) => entry.ref));
  let spare = 0;
  const roles: Role[] = names.map((name) => {
    const models = refs.splice(0, 1 + Math.floor(rand() * 3));
    if (models.length === 0) models.push(`spare/model-${spare++}`);
    return { name, models, thinking: one(["selected", "max", "low"] as const) };
  });
  const fallback = new Map<string, string>();
  for (const from of names) {
    const to = one(names);
    if (to !== from && chance(0.4)) fallback.set(from, to);
  }
  const accounts = new Map<string, AccountBinding>();
  if (chance(0.9)) accounts.set("openai-codex-2", { kind: "multi-pass", label: chance(0.8) ? one(["personal", "Personal "]) : one(["work", "spare"]) });
  if (chance(0.5)) accounts.set("openai-codex-3", { kind: "multi-pass", label: "personal" });
  if (chance(0.5)) accounts.set("openai-codex", { kind: "native", label: one(["personal", "Positron"]) });
  const local = chance(0.85)
    ? {
        role: one(names),
        providers: some(["omlx-hera", "lan-box", "openrouter", "hermes", "router"], 0.6),
        hosts: some(["hera.lan", "localhost", "127.0.0.1", "openrouter.ai", "api.openai.com", "hera.tail1234.ts.net"], 0.6),
      }
    : undefined;
  const roster: Roster = {
    version: 1,
    exclude: [...BUILTIN_EXCLUDES, ...some(["openai-codex/*", GLM_CLOUD, "lan-box/*"], 0.3)],
    roles,
    routing: { default: one(names), trivial: one(names), complex: one(names), planning: one(names), fallback },
    accounts,
    ...(local === undefined ? {} : { local }),
    stickyIdleMinutes: Math.floor(rand() * 10),
    cooldownMinutes: 30,
  };

  const catalog = new FakeCatalog();
  for (const entry of POOL) {
    if (entry.absent === true) continue;
    catalog.add(
      model(entry.ref, {
        baseUrl: entry.baseUrl ?? "",
        api: entry.virtual === true ? "pi-virtual" : "openai-completions",
        contextWindow: one([0, 32_000, 128_000, 262_144]),
      }),
    );
  }
  for (let index = 0; index < spare; index += 1) catalog.add(model(`spare/model-${index}`));
  if (chance(0.1)) catalog.models.set(DEEPSEEK, model("openrouter/deepseek/other"));
  for (const ref of catalog.models.keys()) {
    if (chance(0.2)) catalog.unavailable.add(ref);
    if (chance(0.1)) catalog.unauthenticated.add(ref);
  }

  const now = NOW + Math.floor(rand() * 60 * MINUTE);
  const cooldowns = new Cooldowns();
  for (const entry of POOL) if (chance(0.15)) cooldowns.cool(entry.ref, Math.floor(rand() * 1e6), now - Math.floor(rand() * 40 * MINUTE), 30);

  const roll = rand();
  const labels: Loaded<Labels> | undefined =
    roll < 0.6
      ? labelsOf([
          { provider: "openai-codex", index: 2, label: "personal" },
          { provider: "openai-codex", index: 3, label: "personal" },
        ])
      : roll < 0.75
        ? labelsOf([{ provider: "openai-codex", index: 2, label: one(["work", "Positron", "spare"]) }])
        : roll < 0.85
          ? labelsOf([{ provider: "openai-codex", index: 2 }])
          : roll < 0.95
            ? { kind: "unsafe", path: "/agent/multi-pass.json", error: "mode 666", loadedAt: 0 }
            : undefined;

  const virtualId: VirtualId = one(["auto", "local"] as const);
  const localOnly = virtualId === "local" || chance(0.3);
  const policy: LocalPolicy = chance(0.5)
    ? policyFromRoster(roster)
    : {
        refs: some(POOL.map((entry) => entry.ref), 0.5),
        providers: some(["omlx-hera", "lan-box", "openrouter", "hermes", "openai-codex-3", "router"], 0.5),
        hosts: some(["hera.lan", "localhost", "127.0.0.1", "openrouter.ai", "chatgpt.com", "hera.tail1234.ts.net"], 0.5),
      };
  const rc = resolveContext({ roster, catalog, labels, cooldowns, now, virtualId, localOnly, policy });
  const lastResponder = chance(0.7)
    ? {
        ref: one([...POOL.map((entry) => entry.ref), "spare/model-0"]),
        at: now - Math.floor(rand() * 20 * MINUTE),
        ...(chance(0.7) ? { usage: usage(Math.floor(rand() * 300_000)) } : {}),
      }
    : undefined;
  return { rc, text: one(TEXTS), last: lastResponder, reserve: Math.floor(rand() * 50_000) };
}

/**
 * Everything a picked model must be, whatever the roster, catalog and inputs. A plan must also be
 * in the local role while local-only; a bare pick in a role the caller names need only be local.
 */
function assertSafeChoice(rc: ResolveContext, choice: Choice, where: string, plan: boolean): void {
  const { roster } = rc;
  assert.equal(excludedBy([...BUILTIN_EXCLUDES, ...roster.exclude], choice.ref), undefined, `${where}: excluded`);
  assert.ok(!choice.ref.startsWith("openai-codex-3/"), `${where}: the work alias`);
  assert.notEqual(choice.model.api, "pi-virtual", `${where}: virtual`);
  assert.equal(refOf(choice.model), choice.ref, `${where}: catalog entry`);
  assert.equal(rc.catalog.find(choice.model.provider, choice.model.id), choice.model, `${where}: not the catalog's object`);
  const role = roleOf(roster, choice.ref);
  assert.ok(role !== undefined, `${where}: outside the roster`);
  assert.equal(role.name, choice.role, `${where}: role`);
  assert.ok(rc.available.has(choice.ref) && rc.catalog.hasConfiguredAuth(choice.model), `${where}: unavailable`);
  assert.ok(checkAccount(choice.model.provider, roster, rc.labels).ok, `${where}: account`);
  if (role.name !== roster.local?.role) assert.equal(rc.cooldowns.until(choice.ref, rc.now), undefined, `${where}: cooling`);
  if (rc.virtualId === "auto") assert.ok(autoRoles(roster).has(choice.role), `${where}: not routable by auto`);
  if (rc.localOnly) {
    if (plan) assert.equal(choice.role, roster.local?.role, `${where}: not the local role`);
    assert.ok(checkLocal(choice.model, rc.policy, true).ok, `${where}: outside the policy`);
    assert.ok(rc.policy.refs.includes(choice.ref), `${where}: not a policy ref`);
    assert.ok(isLocalHost(baseUrlHost(choice.model.baseUrl) ?? ""), `${where}: a non-local host`);
  }
}

/** A refusal is never spurious: no candidate it lists could have taken the request. */
function assertHonestRefusal(rc: ResolveContext, decision: Decision, skip: string | undefined, where: string): void {
  if (decision.ok) return;
  for (const attempt of decision.attempts) {
    for (const candidate of attempt.candidates) {
      assert.ok(candidate.reason !== "" && candidate.detail !== "", `${where}: an empty reason`);
      if (candidate.ref !== skip) assert.equal(resolveCandidate(candidate.ref, rc).ok, false, `${where}: ${candidate.ref} could have taken it`);
    }
  }
}

describe("property-style invariants", () => {
  test("1,000 random rosters, catalogs and inputs never yield an unsafe pick", (t) => {
    const seen = { plans: 0, picks: 0, refused: 0, local: 0, fallback: 0, workAliasBeside: 0, pinnedAuto: 0 };
    for (let seed = 1; seed <= 1000; seed += 1) {
      const { rc, text, last: lastResponder, reserve } = randomCase(seed);
      const where = `seed ${seed}`;
      const result = planUserTurn({ rc, text, last: lastResponder, now: rc.now, reserve });
      assert.equal(result.localOnly, rc.localOnly, where);
      if (result.decision.ok) {
        assertSafeChoice(rc, result.decision.choice, `${where} plan`, true);
        seen.plans += 1;
        if (rc.localOnly) seen.local += 1;
        if (rc.localOnly && rc.virtualId === "auto") seen.pinnedAuto += 1;
        if (result.decision.choice.code.startsWith("fallback:")) seen.fallback += 1;
      } else {
        seen.refused += 1;
        assertHonestRefusal(rc, result.decision, undefined, `${where} plan`);
      }
      const holdsWorkAlias = rc.roster.roles.some((role) => role.models.includes(WORK_SOL));
      if (holdsWorkAlias && resolveCandidate(SOL, rc).ok) seen.workAliasBeside += 1;
      for (const role of rc.roster.roles) {
        const skip = role.models[0];
        for (const options of [
          { fallback: true, code: "t" },
          { fallback: false, code: "t" },
          { fallback: true, code: "t", skip },
          { fallback: true, code: "t", prefer: role.models.at(-1) },
        ]) {
          const decision = pickInRole(rc, role.name, options);
          if (decision.ok) {
            assertSafeChoice(rc, decision.choice, `${where} pick ${role.name}`, false);
            assert.notEqual(decision.choice.ref, options.skip, `${where}: took the failed model`);
            if (rc.localOnly) assert.ok(!decision.choice.code.startsWith("fallback:"), `${where}: fell back while local-only`);
            seen.picks += 1;
            // Complete: a role with a candidate that resolves is never passed over.
            const own = role.models.find((ref) => ref !== options.skip && resolveCandidate(ref, rc).ok);
            if (own !== undefined) assert.equal(decision.choice.role, role.name, `${where}: passed over ${own}`);
            if (options.prefer !== undefined && resolveCandidate(options.prefer, rc).ok && options.prefer !== options.skip) {
              assert.equal(decision.choice.ref, options.prefer, `${where}: ignored the preferred model`);
            }
          } else {
            assertHonestRefusal(rc, decision, options.skip, `${where} pick ${role.name}`);
          }
        }
      }
    }
    // The run is not vacuous: every kind of outcome happened.
    t.diagnostic(JSON.stringify(seen));
    for (const [name, count] of Object.entries(seen)) assert.ok(count > 0, `no ${name} in 1,000 cases: ${JSON.stringify(seen)}`);
  });

  test("Hera's work alias is never picked, though it shares sol's id and carries a matching label", () => {
    const roster: Roster = { ...HERA, exclude: [], roles: HERA.roles.map((role) => (role.name === "engineer" ? { ...role, models: [WORK_SOL, SOL] } : role)), accounts: new Map([...HERA.accounts, ["openai-codex-3", { kind: "multi-pass", label: "personal" }]]) };
    const labels = labelsOf([
      { provider: "openai-codex", index: 2, label: "personal" },
      { provider: "openai-codex", index: 3, label: "personal" },
    ]);
    const rc = heraContext({ roster, labels });
    expectPlan(plan(COMPLEX, { rc }), SOL, "signal:complex");
    expectPlan(plan(COMPLEX, { rc, last: last(WORK_SOL, 1000) }), SOL, "signal:complex");
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(SOL);
    expectPlan(plan(COMPLEX, { rc: contextWith(catalog, { roster, labels }) }), GLM_CLOUD, "fallback:engineer→coder");
  });

  test("the generator is deterministic", () => {
    const a = randomCase(42);
    const b = randomCase(42);
    assert.deepEqual(JSON.stringify([a.text, a.reserve, a.rc.virtualId, a.rc.roster.roles]), JSON.stringify([b.text, b.reserve, b.rc.virtualId, b.rc.roster.roles]));
    assert.notDeepEqual(JSON.stringify(randomCase(43).rc.roster.roles), JSON.stringify(a.rc.roster.roles));
  });
});
