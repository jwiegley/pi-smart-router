import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Api, Model, Usage } from "@earendil-works/pi-ai";

import { checkAccount } from "../src/accounts.ts";
import type { Labels } from "../src/accounts.ts";
import { BUILTIN_EXCLUDES } from "../src/constants.ts";
import type { VirtualId } from "../src/constants.ts";
import { compactionFor, eligibleRole, fits, NO_LOCAL_SECTION, pickInRole, planUserTurn } from "../src/decide.ts";
import type { Choice, CompactionFigures, Decision, LastResponder, LevelInput, Plan } from "../src/decide.ts";
import type { Loaded } from "../src/files.ts";
import type { JevOutcome } from "../src/jev.ts";
import { baseUrlHost, checkLocal, isLocalHost, policyFromRoster } from "../src/local.ts";
import type { LocalPolicy } from "../src/local.ts";
import { Cooldowns, refOf, resolveCandidate, resolveContext } from "../src/resolve.ts";
import type { ResolveContext } from "../src/resolve.ts";
import { autoRoles, excludedBy, roleOf, SCOPES } from "../src/roster.ts";
import type { AccountBinding, Role, Roster } from "../src/roster.ts";
import { tierRank, TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
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
  rosterFixtureV2,
  SOL,
  WORK_SOL,
} from "./support/catalog.ts";

const HERA = rosterFixture("roster-hera.json");
const MINUTE = 60_000;
/** Pi's compaction settings when none are given: enabled, with its default reserve and recent tail. */
const ENABLED: CompactionFigures = { enabled: true, reserve: 16_384, keepRecent: 20_000 };
const DISABLED: CompactionFigures = { ...ENABLED, enabled: false };

function usage(totalTokens: number): Usage {
  return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function last(ref: string, ago: number, tokens?: number): LastResponder {
  return { ref, at: NOW - ago, ...(tokens === undefined ? {} : { usage: usage(tokens) }) };
}

function plan(text: string, options: { last?: LastResponder; rc?: ResolveContext } = {}): Plan {
  return planUserTurn({ rc: options.rc ?? heraContext(), text, last: options.last, now: NOW, compaction: ENABLED });
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

  test("a run whose role cannot take it reports why, whichever role answered last", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(DEEPSEEK);
    const result = plan(TRIVIAL, { rc: contextWith(catalog), last: last(ASTRA, 6 * MINUTE) });
    assert.equal(result.decision.ok, false);
    assert.deepEqual([result.role, result.code], ["worker", "signal:trivial"], "nothing holds a session by time");
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

  test("refuse without a local section", () => {
    const { local: _local, ...rest } = HERA;
    const result = plan(PLANNING, { rc: heraContext({ roster: rest, virtualId: "local" }) });
    assert.deepEqual(result.decision, { ok: false, attempts: [], problem: NO_LOCAL_SECTION });
    assert.equal(result.role, undefined);
  });
});

describe("fits and the compaction settings", () => {
  test("fits measures the latest usage plus the new prompt against the window less the reserve", () => {
    const window = model("x/y", { contextWindow: 100_000 });
    // "hi" estimates as one token.
    assert.equal(fits({ last: last(ASTRA, 0, 90_000), text: "hi", now: NOW, reserve: 9_999 }, window), true);
    assert.equal(fits({ last: last(ASTRA, 0, 90_000), text: "hi", now: NOW, reserve: 10_000 }, window), false);
    assert.equal(fits({ last: undefined, text: "a".repeat(400_000), now: NOW, reserve: 0 }, window), true);
    assert.equal(fits({ last: undefined, text: "a".repeat(400_004), now: NOW, reserve: 0 }, window), false);
    assert.equal(fits({ last: last(ASTRA, 0, 10_000_000), text: "hi", now: NOW, reserve: 0 }, model("x/z", { contextWindow: 0 })), true);
  });

  test("compactionFor: the reserve and the recent tail come from the selection's override, then the setting, then Pi's default", () => {
    const reserve = (settings: unknown, id: VirtualId): number => compactionFor(settings, id).reserve;
    assert.equal(reserve({}, "auto"), 16_384);
    assert.equal(reserve(undefined, "auto"), 16_384);
    assert.equal(reserve({ compaction: { reserveTokens: 4_096 } }, "auto"), 4_096);
    const settings = { compaction: { reserveTokens: 4_096, modelOverrides: { "smart-router/auto": { reserveTokens: 32_000 }, "smart-router/local": { keepRecentTokens: 1 } } } };
    assert.equal(reserve(settings, "auto"), 32_000);
    assert.equal(reserve(settings, "local"), 4_096);
    assert.equal(reserve({ compaction: { reserveTokens: -1, modelOverrides: { "smart-router/auto": { reserveTokens: 1.5 } } } }, "auto"), 16_384);
    assert.equal(reserve({ compaction: { modelOverrides: { "smart-router/auto": { reserveTokens: 0 } } } }, "auto"), 0);
    // Pi reads keepRecentTokens through the same override as the reserve.
    assert.deepEqual([compactionFor(settings, "local").keepRecent, compactionFor(settings, "auto").keepRecent], [1, 20_000]);
    // enabled is Pi's boolean, true unless it is false.
    assert.equal(compactionFor({ compaction: { enabled: "no" } }, "auto").enabled, true);
    assert.equal(compactionFor({ compaction: { enabled: false } }, "auto").enabled, false);
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
  readonly compaction: CompactionFigures;
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
    cooldownMinutes: 30,
    ignored: [],
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
  const localOnly = virtualId === "local";
  const policy: LocalPolicy = chance(0.5)
    ? policyFromRoster(roster)
    : {
        refs: some(POOL.map((entry) => entry.ref), 0.5),
        providers: some(["omlx-hera", "lan-box", "openrouter", "hermes", "openai-codex-3", "router"], 0.5),
        hosts: some(["hera.lan", "localhost", "127.0.0.1", "openrouter.ai", "chatgpt.com", "hera.tail1234.ts.net"], 0.5),
      };
  const rc = resolveContext({ roster, catalog, labels, cooldowns, now, virtualId, localOnly, policy, scope: "personal" });
  const lastResponder = chance(0.7)
    ? {
        ref: one([...POOL.map((entry) => entry.ref), "spare/model-0"]),
        at: now - Math.floor(rand() * 20 * MINUTE),
        ...(chance(0.7) ? { usage: usage(Math.floor(rand() * 300_000)) } : {}),
      }
    : undefined;
  return { rc, text: one(TEXTS), last: lastResponder, compaction: { enabled: chance(0.5), reserve: Math.floor(rand() * 50_000), keepRecent: 20_000 } };
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
  if (rc.virtualId === "auto") assert.ok(autoRoles(roster, rc.scope).has(choice.role), `${where}: not routable by auto`);
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
    const seen = { plans: 0, picks: 0, refused: 0, local: 0, fallback: 0, workAliasBeside: 0 };
    for (let seed = 1; seed <= 1000; seed += 1) {
      const { rc, text, last: lastResponder, compaction } = randomCase(seed);
      const where = `seed ${seed}`;
      const result = planUserTurn({ rc, text, last: lastResponder, now: rc.now, compaction });
      assert.equal(result.localOnly, rc.localOnly, where);
      if (result.decision.ok) {
        assertSafeChoice(rc, result.decision.choice, `${where} plan`, true);
        seen.plans += 1;
        if (rc.localOnly) seen.local += 1;
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
    assert.deepEqual(JSON.stringify([a.text, a.compaction, a.rc.virtualId, a.rc.roster.roles]), JSON.stringify([b.text, b.compaction, b.rc.virtualId, b.rc.roster.roles]));
    assert.notDeepEqual(JSON.stringify(randomCase(43).rc.roster.roles), JSON.stringify(a.rc.roster.roles));
  });
});

// ─── Version 2: levels ──────────────────────────────────────────────────────

const V2 = rosterFixtureV2("roster-hera-v2.json");
const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";
const WORK_LUNA = "openai-codex-3/gpt-6-luna";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const WORK_ASTRA = "openai-codex-3/gpt-6-astra";
const JEV = "openrouter/typesafe/jev-1.14";
const FRANCE = "What is the capital of France?";
const FORCE_PUSH = "force push the branch";

/** A Codex model, as Hera's catalog lists them. */
const codex = (ref: string, init: Partial<Model<Api>> = {}): Model<Api> =>
  model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000, ...init });

/** Hera's catalog with every model of its version 2 roster: both Codex accounts, OpenRouter, Nyx and Hera's Qwen. */
const v2Catalog = (): FakeCatalog =>
  new FakeCatalog([
    ...heraModels(),
    codex(LUNA),
    codex(TERRA),
    model(NYX_QWEN, { baseUrl: "https://nyx.lan/v1", contextWindow: 98_304 }),
    model(HERA_QWEN, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
    codex(WORK_LUNA),
    codex(WORK_TERRA),
    codex(WORK_ASTRA),
  ]);

const v2 = (catalog: FakeCatalog = v2Catalog(), overrides: Partial<Omit<ResolveContext, "available" | "catalog">> = {}): ResolveContext =>
  contextWith(catalog, { roster: V2, ...overrides });

function planV2(text: string, options: { level?: LevelInput; last?: LastResponder; rc?: ResolveContext; compaction?: CompactionFigures } = {}): Plan {
  const { level } = options;
  return planUserTurn({ rc: options.rc ?? v2(), text, last: options.last, now: NOW, compaction: options.compaction ?? ENABLED, ...(level === undefined ? {} : { level }) });
}

/** Jev's answer: its top choice, and the tier the close-call rule made of it. */
function answer(choice: Tier, tier: Tier = choice): JevOutcome {
  const probabilities: Record<Tier, number> = { low: 0.05, medium: 0.05, high: 0.05, super: 0.05 };
  probabilities[choice] = tier === choice ? 0.85 : 0.5;
  if (tier !== choice) probabilities[tier] = 0.4;
  return { kind: "answer", model: JEV, choice, tier, probabilities, confidence: probabilities[choice], ms: 140 };
}

describe("v2 levels", () => {
  test("an untagged run without Jev takes the first candidate of the keywords' tier", () => {
    const result = planV2(FRANCE);
    expectPlan(result, TERRA, "keyword");
    assert.deepEqual([result.signal, result.role], ["default", "medium"]);
    assert.deepEqual(result.level, { scope: "personal", tier: "medium", asked: "medium", start: "medium", source: "keyword", steppedUp: false, returnedToFirst: false });
  });

  test("Jev's tier decides, not its choice; when Jev fails, the keywords decide and the failure is kept", () => {
    const jev = answer("medium", "high");
    const result = planV2(FRANCE, { level: { jev } });
    expectPlan(result, SOL, "jev");
    assert.deepEqual(result.level, { scope: "personal", tier: "high", asked: "high", start: "high", source: "jev", steppedUp: false, returnedToFirst: false, jev });
    const failed: JevOutcome = { kind: "failure", model: JEV, failure: "timeout", ms: 1000 };
    const keywords = planV2(FRANCE, { level: { jev: failed } });
    expectPlan(keywords, TERRA, "keyword");
    assert.deepEqual(keywords.level, { scope: "personal", tier: "medium", asked: "medium", start: "medium", source: "keyword", steppedUp: false, returnedToFirst: false, jev: failed });
  });

  test("a risky operation raises an untagged run to high, whatever Jev says", () => {
    const jev = answer("low");
    const result = planV2(FORCE_PUSH, { level: { jev } });
    expectPlan(result, SOL, "floor");
    assert.deepEqual(result.level, { scope: "personal", tier: "high", asked: "low", start: "high", source: "floor", trigger: "destructive-git", steppedUp: false, returnedToFirst: false, jev });
  });

  test("the floor never lowers a run, and never raises a tagged one", () => {
    // "force push" is one of the planning patterns too, so the keywords ask for super.
    const keywords = planV2(FORCE_PUSH);
    expectPlan(keywords, ASTRA, "keyword");
    assert.deepEqual(keywords.level, { scope: "personal", tier: "super", asked: "super", start: "super", source: "keyword", steppedUp: false, returnedToFirst: false });
    expectPlan(planV2(FORCE_PUSH, { level: { jev: answer("high") } }), SOL, "jev");
    const tagged = planV2(FORCE_PUSH, { level: { tag: "low" } });
    expectPlan(tagged, LUNA, "tag");
    assert.deepEqual(tagged.level, { scope: "personal", tier: "low", asked: "low", start: "low", source: "tag", steppedUp: false, returnedToFirst: false });
    // A tag outranks Jev, and a tagged run waits for no answer, so its plan keeps none.
    assert.deepEqual(planV2(FORCE_PUSH, { level: { tag: "low", jev: answer("super") } }), tagged);
  });

  test("a tag goes down at once, and so does an untagged run below the latest response's tier", () => {
    const astra = last(ASTRA, MINUTE);
    expectPlan(planV2(PLAIN, { level: { tag: "low" }, last: astra }), LUNA, "tag");
    const jev = answer("low");
    const down = planV2(PLAIN, { level: { jev }, last: astra });
    expectPlan(down, LUNA, "jev");
    assert.deepEqual(down.level, { scope: "personal", tier: "low", asked: "low", start: "low", source: "jev", steppedUp: false, returnedToFirst: false, jev }, "nothing holds a session by time");
  });

  test("a latest response from the other scope's roles changes nothing either", () => {
    const jev = answer("low");
    expectPlan(planV2(PLAIN, { level: { jev }, last: last(WORK_ASTRA, MINUTE) }), LUNA, "jev");
    expectPlan(planV2(PLAIN, { rc: v2(v2Catalog(), { scope: "work" }), level: { jev }, last: last(ASTRA, MINUTE) }), WORK_LUNA, "jev");
  });

  test("a run starts at its own tier whatever tier answered last, and climbs from there", () => {
    // Astra answered a minute ago and is cooling now, and kimi is unavailable, so super can take nothing.
    const cooldowns = new Cooldowns();
    cooldowns.cool(ASTRA, 1, NOW, 30);
    cooldowns.cool(WORK_ASTRA, 2, NOW, 30);
    const catalog = v2Catalog();
    catalog.unavailable.add(KIMI);
    const MEDIUM = { tier: "medium", asked: "medium", start: "medium", source: "keyword", steppedUp: false, returnedToFirst: false } as const;
    const work = planV2(FRANCE, { rc: v2(catalog, { cooldowns, scope: "work" }), last: last(WORK_ASTRA, MINUTE) });
    expectPlan(work, WORK_TERRA, "keyword");
    assert.deepEqual(work.level, { scope: "work", ...MEDIUM });
    const personal = planV2(FRANCE, { rc: v2(catalog, { cooldowns }), last: last(ASTRA, MINUTE) });
    expectPlan(personal, TERRA, "keyword");
    assert.deepEqual(personal.level, { scope: "personal", ...MEDIUM });
    // Luna is too small for the conversation. With compaction enabled the run takes it, and Pi compacts.
    const small = v2Catalog().add(codex(LUNA, { contextWindow: 128_000 }));
    small.unavailable.add(KIMI);
    const jev = answer("low");
    const compacted = planV2(PLAIN, { rc: v2(small, { cooldowns }), level: { jev }, last: last(ASTRA, 6 * MINUTE, 120_000) });
    expectPlan(compacted, LUNA, "jev");
    assert.deepEqual(compacted.level, { scope: "personal", tier: "low", asked: "low", start: "low", source: "jev", steppedUp: false, returnedToFirst: false, jev }, "with compaction enabled a too-small model is compacted for");
    // With compaction disabled, the run climbs from low to the first tier that fits.
    const fit = planV2(PLAIN, { rc: v2(small, { cooldowns }), level: { jev }, last: last(ASTRA, 6 * MINUTE, 120_000), compaction: DISABLED });
    expectPlan(fit, TERRA, "step-up");
    assert.deepEqual(fit.level, { scope: "personal", tier: "medium", asked: "low", start: "low", source: "jev", steppedUp: true, returnedToFirst: false, jev });
    // The floor stays a minimum: a risky run climbs again from high, not from the tier it asked for.
    const floored = planV2(FORCE_PUSH, { rc: v2(catalog, { cooldowns }), level: { jev }, last: last(ASTRA, MINUTE) });
    expectPlan(floored, SOL, "floor");
    assert.deepEqual(floored.level, { scope: "personal", tier: "high", asked: "low", start: "high", source: "floor", trigger: "destructive-git", steppedUp: false, returnedToFirst: false, jev });
  });

  test("a run whose own tier and every tier above it have no available candidate is refused, whatever tier answered last", () => {
    const catalog = v2Catalog();
    for (const ref of [TERRA, DEEPSEEK, SOL, GLM_CLOUD, ASTRA, KIMI]) catalog.unavailable.add(ref);
    const result = planV2(FRANCE, { rc: v2(catalog), last: last(ASTRA, MINUTE) });
    assert.deepEqual([result.role, result.code], [undefined, "keyword"]);
    assert.deepEqual(result.level, { scope: "personal", tier: "medium", asked: "medium", start: "medium", source: "keyword", steppedUp: false, returnedToFirst: false });
    assert.ok(!result.decision.ok, JSON.stringify(result.decision));
    // Low's candidates are available, but a run never goes below its own tier.
    assert.deepEqual(result.decision.attempts.map((attempt) => attempt.role), ["medium", "high", "super"]);
  });

  test("with compaction disabled, a tagged run moves up a tier when the conversation would not fit its tier's first available model", () => {
    // Low's only available candidate has a 32,000-token window, and the conversation holds 100,000.
    const catalog = v2Catalog().add(codex(LUNA, { contextWindow: 32_000 }));
    catalog.unavailable.add(NYX_QWEN).add(HERA_QWEN);
    const compacted = planV2(PLAIN, { rc: v2(catalog), level: { tag: "low" }, last: last(SOL, MINUTE, 100_000) });
    expectPlan(compacted, LUNA, "tag");
    assert.equal(compacted.level?.steppedUp, false, "with compaction enabled a too-small model is compacted for");
    const result = planV2(PLAIN, { rc: v2(catalog), level: { tag: "low" }, last: last(SOL, MINUTE, 100_000), compaction: DISABLED });
    expectPlan(result, TERRA, "step-up");
    assert.equal(result.role, "medium");
    assert.deepEqual(result.level, { scope: "personal", tier: "medium", asked: "low", start: "low", source: "tag", steppedUp: true, returnedToFirst: false });
  });

  test("a run moves up past a tier with no available candidate, whatever tier answered last", () => {
    const catalog = v2Catalog();
    for (const ref of [LUNA, NYX_QWEN, HERA_QWEN]) catalog.unavailable.add(ref);
    const jev = answer("low");
    const result = planV2(PLAIN, { rc: v2(catalog), level: { jev } });
    expectPlan(result, TERRA, "step-up");
    assert.deepEqual(result.level, { scope: "personal", tier: "medium", asked: "low", start: "low", source: "jev", steppedUp: true, returnedToFirst: false, jev });
    // Version 1 refuses a run whose role cannot take it; a tier passes it up instead.
    const after = planV2(PLAIN, { rc: v2(catalog), level: { jev }, last: last(ASTRA, 10_000) });
    expectPlan(after, TERRA, "step-up");
    assert.equal(after.level?.start, "low", "nothing holds a session by time");
  });

  test("a level returns to its first candidate as soon as that is available again", () => {
    const jev = answer("high");
    const back = planV2(PLAIN, { level: { jev }, last: last(GLM_CLOUD, MINUTE) });
    expectPlan(back, SOL, "jev");
    assert.deepEqual(back.level, { scope: "personal", tier: "high", asked: "high", start: "high", source: "jev", steppedUp: false, returnedToFirst: true, jev });
    const cooldowns = new Cooldowns();
    cooldowns.cool(SOL, 1, NOW, 30);
    const cooled = planV2(PLAIN, { rc: v2(v2Catalog(), { cooldowns }), level: { jev }, last: last(GLM_CLOUD, MINUTE) });
    expectPlan(cooled, GLM_CLOUD, "jev");
    assert.equal(cooled.level?.returnedToFirst, false);
  });

  test("a move off a cooled latest responder to a later candidate is no return", () => {
    const jev = answer("high");
    const cooldowns = new Cooldowns();
    cooldowns.cool(SOL, 1, NOW, 30);
    const away = planV2(PLAIN, { rc: v2(v2Catalog(), { cooldowns }), level: { jev }, last: last(SOL, MINUTE) });
    expectPlan(away, GLM_CLOUD, "jev");
    assert.equal(away.level?.returnedToFirst, false);
  });

  test("a work-scope run takes its tier's work-account model", () => {
    const result = planV2(FRANCE, { rc: v2(v2Catalog(), { scope: "work" }) });
    expectPlan(result, WORK_TERRA, "keyword");
    assert.deepEqual([result.role, result.level], ["work-medium", { scope: "work", tier: "medium", asked: "medium", start: "medium", source: "keyword", steppedUp: false, returnedToFirst: false }]);
  });

  test("the start tier is where the upward pick began, after the floor", () => {
    // High has no available candidate, so a run that starts there goes on to super.
    const catalog = v2Catalog();
    catalog.unavailable.add(SOL).add(GLM_CLOUD);
    const jev = answer("low");
    const floored = planV2(FORCE_PUSH, { rc: v2(catalog), level: { jev } });
    expectPlan(floored, ASTRA, "step-up");
    assert.deepEqual(floored.level, { scope: "personal", tier: "super", asked: "low", start: "high", source: "floor", trigger: "destructive-git", steppedUp: true, returnedToFirst: false, jev });
    // Sol answered a minute ago: the run still starts at its own tier, low, which can take it.
    const after = planV2(PLAIN, { rc: v2(catalog), level: { jev }, last: last(SOL, MINUTE) });
    expectPlan(after, LUNA, "jev");
    assert.deepEqual(after.level, { scope: "personal", tier: "low", asked: "low", start: "low", source: "jev", steppedUp: false, returnedToFirst: false, jev }, "nothing holds a session by time");
  });

  test("with compaction disabled, when no tier's first available candidate fits, the highest tier with an available candidate takes the run", () => {
    // The conversation holds 300,000 tokens, more than any window.
    const huge = last(SOL, MINUTE, 300_000);
    const compacted = planV2(PLAIN, { level: { tag: "low" }, last: huge });
    expectPlan(compacted, LUNA, "tag");
    assert.equal(compacted.level?.tier, "low", "with compaction enabled a too-small model is compacted for");
    const result = planV2(PLAIN, { level: { tag: "low" }, last: huge, compaction: DISABLED });
    expectPlan(result, ASTRA, "step-up");
    assert.equal(result.role, "super");
    assert.deepEqual(result.level, { scope: "personal", tier: "super", asked: "low", start: "low", source: "tag", steppedUp: true, returnedToFirst: false });
    // With no super candidate available, high is the highest tier that has one.
    const catalog = v2Catalog();
    catalog.unavailable.add(ASTRA).add(KIMI);
    expectPlan(planV2(PLAIN, { rc: v2(catalog), level: { tag: "low" }, last: huge, compaction: DISABLED }), SOL, "step-up");
    // A run that starts at the highest such tier keeps its own code, and has not stepped up.
    const top = planV2(PLAIN, { level: { tag: "super" }, last: huge, compaction: DISABLED });
    expectPlan(top, ASTRA, "tag");
    assert.equal(top.level?.steppedUp, false);
  });

  test("a run is refused only when no tier from its start has an available candidate, with every tier's reasons and no role", () => {
    const catalog = v2Catalog();
    for (const ref of [LUNA, NYX_QWEN, HERA_QWEN, TERRA, DEEPSEEK, SOL, GLM_CLOUD, ASTRA, KIMI]) catalog.unavailable.add(ref);
    const result = planV2(PLAIN, { rc: v2(catalog), level: { tag: "low" }, last: last(SOL, MINUTE, 100_000) });
    assert.deepEqual([result.role, result.code], [undefined, "tag"]);
    assert.deepEqual(result.level, { scope: "personal", tier: "low", asked: "low", start: "low", source: "tag", steppedUp: false, returnedToFirst: false });
    assert.ok(!result.decision.ok, JSON.stringify(result.decision));
    assert.equal(result.decision.problem, undefined);
    assert.deepEqual(
      result.decision.attempts.map((attempt) => [attempt.role, attempt.exists, attempt.candidates.map((candidate) => [candidate.ref, candidate.reason])]),
      [
        ["low", true, [[LUNA, "not-available"], [NYX_QWEN, "not-available"], [HERA_QWEN, "not-available"]]],
        ["medium", true, [[TERRA, "not-available"], [DEEPSEEK, "not-available"]]],
        ["high", true, [[SOL, "not-available"], [GLM_CLOUD, "not-available"]]],
        ["super", true, [[ASTRA, "not-available"], [KIMI, "not-available"]]],
      ],
    );
    // A run never goes down: low and medium are available, but a run tagged high cannot use them.
    const lower = v2Catalog();
    for (const ref of [SOL, GLM_CLOUD, ASTRA, KIMI]) lower.unavailable.add(ref);
    const high = planV2(PLAIN, { rc: v2(lower), level: { tag: "high" } });
    assert.ok(!high.decision.ok, JSON.stringify(high.decision));
    assert.deepEqual(high.decision.attempts.map((attempt) => attempt.role), ["high", "super"]);
  });

  test("a scope the roster does not serve is refused before any level", () => {
    const { work: _work, ...personal } = V2.scopes;
    const result = planV2(FRANCE, { rc: v2(v2Catalog(), { roster: { ...V2, scopes: personal }, scope: "work" }), level: { tag: "low" } });
    assert.deepEqual([result.role, result.code, result.level], [undefined, "no-scope", undefined]);
    assert.deepEqual(result.decision, { ok: false, attempts: [], problem: "the roster has no work scope" });
  });

  test("smart-router/local plans its local role before any level, as before", () => {
    const local = planV2(FRANCE, { rc: v2(v2Catalog(), { virtualId: "local" }), level: { tag: "super" } });
    expectPlan(local, GLM, "local");
    assert.equal(local.level, undefined);
  });

  test("a role never falls back", () => {
    const catalog = new FakeCatalog(heraModels());
    catalog.unavailable.add(DEEPSEEK);
    const decision = pickInRole(contextWith(catalog, { roster: V2 }), "medium", { fallback: true, code: "t" });
    assert.equal(decision.ok, false, JSON.stringify(decision));
    assert.deepEqual(decision.ok ? [] : decision.attempts.map((attempt) => attempt.role), ["medium"]);
  });

  test("a version 1 plan carries no level, and a level input changes nothing in it", () => {
    const planned = plan(PLANNING);
    assert.deepEqual(Object.keys(planned), ["virtualId", "localOnly", "signal", "reason", "role", "code", "decision"]);
    assert.deepEqual(planUserTurn({ rc: heraContext(), text: PLANNING, last: undefined, now: NOW, compaction: ENABLED, level: { tag: "low", jev: answer("low") } }), planned);
  });

  test("200 random runs in each scope pick only that scope's accounts, each the first candidate of its role that resolves", (t) => {
    // A fixed seed. Each case has its own generator, seeded SEED + case, so a failure names a case
    // that replays alone. Each case is planned in both scopes.
    const SEED = 20_261_109;
    const CASES = 200;
    // Words and whole phrases, so that risky operations, planning and trivial work all come up.
    const WORDS = ["force push", "git reset --hard", "rm -rf node_modules/", "unstage", "clean up the repo", "accidentally added secrets.env", "the", "branch", "plan", "migration", "rename", "foo", "to", "bar", "fix", "build", "debug", "deadlock", "design", "format", "this", "file", "what", "is", "capital", "of", "France?", "PLAN.org", "review", "tests", "go", "ahead"];
    const WORK_REFS = [WORK_LUNA, WORK_TERRA, WORK_SOL, WORK_ASTRA];
    const REFS = [LUNA, NYX_QWEN, HERA_QWEN, TERRA, DEEPSEEK, SOL, GLM_CLOUD, ASTRA, KIMI, ...WORK_REFS, GLM, NATIVE_SOL, "openrouter/someone/else"];
    const seen: Record<string, number> = {};
    const count = (name: string): void => {
      seen[name] = (seen[name] ?? 0) + 1;
    };
    for (let index = 1; index <= CASES; index += 1) {
      const seed = SEED + index;
      const rand = prng(seed);
      const chance = (p: number): boolean => rand() < p;
      const one = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
      const text = Array.from({ length: Math.floor(rand() * 9) }, () => one(WORDS)).join(" ");
      const roll = rand();
      const level: LevelInput =
        roll < 0.3
          ? { tag: one(TIERS) }
          : roll < 0.65
            ? { jev: answer(one(TIERS), one(TIERS)) }
            : roll < 0.8
              ? { jev: { kind: "failure", model: JEV, failure: one(["timeout", "error", "malformed"] as const), ms: 1000 } }
              : {};
      const catalog = v2Catalog();
      for (const ref of [LUNA, TERRA, SOL, ASTRA, ...WORK_REFS]) catalog.add(codex(ref, { contextWindow: one([32_000, 128_000, 272_000]) }));
      for (const ref of REFS) if (chance(0.15)) catalog.unavailable.add(ref);
      const cooldowns = new Cooldowns();
      const cooled: string[] = [];
      const cool = (ref: string): void => {
        cooldowns.cool(ref, cooled.length, NOW, 30);
        cooled.push(ref);
      };
      for (const ref of REFS) if (chance(0.1)) cool(ref);
      // The latest responses come from both accounts, at any age and of any size, and a third of
      // them cool after answering, as a usage limit does.
      const latest = chance(0.85)
        ? { ref: one(chance(0.5) ? WORK_REFS : REFS), at: NOW - Math.floor(rand() * 10 * MINUTE), ...(chance(0.6) ? { usage: usage(Math.floor(rand() * 300_000)) } : {}) }
        : undefined;
      if (latest !== undefined && chance(0.35)) cool(latest.ref);
      const compaction = chance(0.5) ? ENABLED : DISABLED;
      const shown = JSON.stringify({ text, level, last: latest, unavailable: [...catalog.unavailable], cooled, compaction: compaction.enabled });
      for (const scope of SCOPES) {
        const section = V2.scopes[scope];
        assert.ok(section !== undefined);
        const rc = v2(catalog, { scope, cooldowns });
        const result = planUserTurn({ rc, text, last: latest, now: NOW, compaction, level });
        const where = `seed ${seed} (case ${index} of ${CASES}, ${scope} scope): ${shown}`;
        const planned = result.level;
        assert.ok(planned !== undefined && planned.scope === scope, where);
        // The run's own tier, which nothing lowers: the one it asked for, or the floor.
        const own: Tier = planned.source === "floor" ? "high" : planned.asked;
        const available = (tier: Tier): boolean => pickInRole(rc, section.levels[tier].role, { fallback: false, code: "t" }).ok;
        const from = (tier: Tier): readonly Tier[] => TIERS.slice(tierRank(tier));
        if (result.decision.ok) {
          const { choice } = result.decision;
          // Only the scope's own account: the work alias in work scope, and never in personal scope.
          if (scope === "work") assert.equal(choice.model.provider, "openai-codex-3", where);
          else assert.notEqual(choice.model.provider, "openai-codex-3", where);
          // The role of a tier no lower than the run's own, and that role's first candidate that resolves.
          assert.equal(choice.role, section.levels[planned.tier].role, where);
          assert.ok(tierRank(planned.tier) >= tierRank(own), `${where}: picked below its own tier, ${own}`);
          const models = rc.roster.roles.find((role) => role.name === choice.role)?.models ?? [];
          assert.equal(models.find((ref) => resolveCandidate(ref, rc).ok), choice.ref, `${where}: not the first candidate of ${choice.role} that resolves`);
          const oversized = !fits({ last: latest, text, now: NOW, reserve: compaction.reserve }, choice.model);
          if (compaction.enabled) {
            // Nothing holds, and size removes nothing: the first tier from the run's own that has an available candidate.
            assert.equal(planned.tier, from(own).find(available), `${where}: nothing holds a session by time, and with compaction enabled a too-small model is compacted for`);
            if (result.code === "step-up") {
              const below = from(own).filter((tier) => tierRank(tier) < tierRank(planned.tier));
              assert.ok(below.every((tier) => !available(tier)), `${where}: with compaction enabled a step-up passes only levels with no available candidate`);
              count("step-up with compaction");
            }
            if (oversized) count("compacted for");
          } else if (oversized) {
            // A pick too small for the conversation is the highest tier with an available candidate.
            assert.ok(from(planned.tier).slice(1).every((tier) => !available(tier)), `${where}: a tier above the oversized pick has an available candidate`);
            count("oversized");
          }
          count(`${scope} picked`);
        } else {
          // Refused only when neither the run's own tier nor any tier above it has an available candidate.
          assert.ok(from(own).every((tier) => !available(tier)), `${where}: refused, though ${own} or a tier above it has an available candidate`);
          count(`${scope} refused`);
        }
        count(result.code);
      }
    }
    // The run is not vacuous: both scopes picked and refused, and every source, step-up, and
    // oversized pick with compaction disabled and enabled happened.
    t.diagnostic(JSON.stringify(seen));
    for (const name of ["personal picked", "personal refused", "work picked", "work refused", "oversized", "compacted for", "step-up", "step-up with compaction", "tag", "jev", "keyword", "floor"]) {
      assert.ok((seen[name] ?? 0) > 0, `no ${name} in ${CASES} cases from seed ${SEED}: ${JSON.stringify(seen)}`);
    }
  });
});

describe("nothing holds a session by time", () => {
  test("version 1: a run that classifies lower moves down at once, whatever the last response's age", () => {
    for (const ago of [0, 10_000, MINUTE, 5 * MINUTE - 1, 6 * MINUTE]) {
      expectPlan(plan(TRIVIAL, { last: last(KIMI, ago) }), DEEPSEEK, "signal:trivial");
      expectPlan(plan(COMPLEX, { last: last(ASTRA, ago) }), SOL, "signal:complex");
    }
  });

  test("version 2: a tagged LOW after a SUPER response 10 s ago goes to LOW", () => {
    const result = planV2(PLAIN, { level: { tag: "low" }, last: last(ASTRA, 10_000) });
    expectPlan(result, LUNA, "tag");
    assert.equal(result.level?.tier, "low", "nothing holds a session by time");
  });

  test("version 2: an untagged run goes to the level Jev gives, lower or higher than the last response's", () => {
    const low = answer("low");
    const down = planV2(PLAIN, { level: { jev: low }, last: last(ASTRA, 10_000) });
    expectPlan(down, LUNA, "jev");
    assert.deepEqual(down.level, { scope: "personal", tier: "low", asked: "low", start: "low", source: "jev", steppedUp: false, returnedToFirst: false, jev: low }, "nothing holds a session by time");
    const high = answer("super");
    const up = planV2(PLAIN, { level: { jev: high }, last: last(LUNA, 10_000) });
    expectPlan(up, ASTRA, "jev");
    assert.equal(up.level?.tier, "super", "a run that rates higher moves up at once, as before");
    // Without an answer the keywords decide, and they too move the session down at once.
    const keywords = planV2(FRANCE, { last: last(ASTRA, 10_000) });
    expectPlan(keywords, TERRA, "keyword");
    assert.equal(keywords.level?.tier, "medium", "nothing holds a session by time");
  });
});

describe("a conversation too large for a model", () => {
  /** Low's model has a 128,000-token window; the conversation holds 250,000. */
  const smallLow = (): FakeCatalog => v2Catalog().add(codex(LUNA, { contextWindow: 128_000 }));
  const huge = last(SOL, 10_000, 250_000);

  test("with compaction enabled, holds nothing and steps up nothing: the run goes to its level and Pi compacts", () => {
    const result = planV2(PLAIN, { rc: v2(smallLow()), level: { tag: "low" }, last: huge, compaction: ENABLED });
    expectPlan(result, LUNA, "tag");
    assert.equal(result.role, "low");
    assert.deepEqual(result.level, { scope: "personal", tier: "low", asked: "low", start: "low", source: "tag", steppedUp: false, returnedToFirst: false }, "with compaction enabled a too-small model is compacted for");
  });

  test("with compaction disabled, a tagged run steps up to the first level whose model fits", () => {
    const result = planV2(PLAIN, { rc: v2(smallLow()), level: { tag: "low" }, last: huge, compaction: DISABLED });
    expectPlan(result, TERRA, "step-up");
    assert.equal(result.role, "medium");
    assert.deepEqual(result.level, { scope: "personal", tier: "medium", asked: "low", start: "low", source: "tag", steppedUp: true, returnedToFirst: false });
  });

  test("with compaction disabled and no level that fits, the highest available level takes it", () => {
    const catalog = v2Catalog();
    for (const ref of [LUNA, TERRA, SOL, ASTRA]) catalog.add(codex(ref, { contextWindow: 128_000 }));
    const result = planV2(PLAIN, { rc: v2(catalog), level: { tag: "low" }, last: huge, compaction: DISABLED });
    expectPlan(result, ASTRA, "step-up");
    assert.equal(result.level?.tier, "super");
    assert.equal(result.level?.steppedUp, true);
  });
});

describe("compactionFor", () => {
  test("unset settings give Pi's defaults", () => {
    assert.deepEqual(compactionFor(undefined, "auto"), { enabled: true, reserve: 16_384, keepRecent: 20_000 });
    assert.deepEqual(compactionFor({}, "local"), { enabled: true, reserve: 16_384, keepRecent: 20_000 });
  });

  test("the selection's override comes first, then the setting", () => {
    const settings = { compaction: { enabled: false, reserveTokens: 64_000, keepRecentTokens: 5_000, modelOverrides: { "smart-router/auto": { reserveTokens: 8_000 } } } };
    assert.deepEqual(compactionFor(settings, "auto"), { enabled: false, reserve: 8_000, keepRecent: 5_000 });
    assert.deepEqual(compactionFor(settings, "local"), { enabled: false, reserve: 64_000, keepRecent: 5_000 });
  });
});
