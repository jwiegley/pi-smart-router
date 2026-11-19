// A scope's fallback chain (version 2, `scopes.<scope>.fallback`): the roles smart-router/auto
// goes on to, in order, when a level's own models cannot take a request. The roster under test is
// John's routing of 2026-11-17 (test/fixtures/roster-hera-v2-fallback.json): each personal level
// has one Codex model, every level shares the chain OpenRouter GLM, OpenRouter Qwen, Hera's GLM,
// Nyx's Qwen, Hera's Qwen, smart-router/local uses the last three, and the work scope declares no
// fallback. Unit tests on the fake host of test/support/pi.ts; no Pi runtime is started.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";
import type { TestContext } from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";

import { LEVEL_ENTRY, SCOPE_ENTRY } from "../src/constants.ts";
import { eligibleRole, pickInRole, planUserTurn } from "../src/decide.ts";
import type { CompactionFigures, Decision, LastResponder, LevelInput, Plan } from "../src/decide.ts";
import { policyFromRoster } from "../src/local.ts";
import { Cooldowns, resolveCandidate, resolveContext } from "../src/resolve.ts";
import type { ResolveContext } from "../src/resolve.ts";
import { autoRoles, candidatesOf, excludedBy, excludesFor, fallbackAfter, parseRoster, scopeSection } from "../src/roster.ts";
import type { RosterV2, Scope } from "../src/roster.ts";
import { scopeEntry } from "../src/scope.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { ASTRA, CHATGPT, FakeCatalog, GLM, HERA_LABELS, HERA_LAN, model, NOW, rosterFixtureV2, SOL, WORK_SOL } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, assistant, failure, FakeRuntime, footerOf, plannedWords, previous, request, resetSlot, routed, start } from "./support/pi.ts";
import type { FakeSession, Loaded } from "./support/pi.ts";

const TEXT = fixture("roster-hera-v2-fallback.json");
const ROSTER = rosterFixtureV2("roster-hera-v2-fallback.json");
const PLAIN = rosterFixtureV2("roster-hera-v2.json");

const LUNA = "openai-codex-2/gpt-6-luna";
const TERRA = "openai-codex-2/gpt-6.1-terra";
const OR_GLM = "openrouter/z-ai/glm-5.3-flash";
const OR_QWEN = "openrouter/qwen/qwen3.8-27b";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";
const WORK_LUNA = "openai-codex-3/gpt-6-luna";
const WORK_TERRA = "openai-codex-3/gpt-6.1-terra";
const WORK_ASTRA = "openai-codex-3/gpt-6-astra";
/** The level models of the personal scope, low to super. */
const OWN: Readonly<Record<Tier, string>> = { low: LUNA, medium: TERRA, high: SOL, super: ASTRA };
const WORK_OWN: Readonly<Record<Tier, string>> = { low: WORK_LUNA, medium: WORK_TERRA, high: WORK_SOL, super: WORK_ASTRA };
/** The one chain every personal level shares, in John's order. */
const CHAIN = [OR_GLM, OR_QWEN, GLM, NYX_QWEN, HERA_QWEN] as const;
const LOCAL = [GLM, NYX_QWEN, HERA_QWEN] as const;
const MINUTE = 60_000;
const LIMIT = "You've hit your usage limit.";

type Json = any;

const codex = (ref: string): Model<Api> => model(ref, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 });

/** Every model of the roster: both Codex accounts, OpenRouter's two, and the three local ones. */
const catalog = (): FakeCatalog =>
  new FakeCatalog([
    ...TIERS.map((tier) => codex(OWN[tier])),
    ...TIERS.map((tier) => codex(WORK_OWN[tier])),
    model(OR_GLM, { contextWindow: 200_000 }),
    model(OR_QWEN, { contextWindow: 131_072 }),
    model(GLM, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
    model(NYX_QWEN, { baseUrl: "https://nyx.lan/v1", contextWindow: 98_304 }),
    model(HERA_QWEN, { baseUrl: HERA_LAN, contextWindow: 262_144 }),
    model("smart-router/auto", { api: "pi-virtual", baseUrl: "" }),
  ]);

interface ContextOptions {
  readonly roster?: RosterV2;
  readonly catalog?: FakeCatalog;
  readonly cooldowns?: Cooldowns;
  readonly scope?: Scope;
  readonly virtualId?: "auto" | "local";
  readonly now?: number;
}

function context(options: ContextOptions = {}): ResolveContext {
  const roster = options.roster ?? ROSTER;
  const virtualId = options.virtualId ?? "auto";
  return resolveContext({
    roster,
    catalog: options.catalog ?? catalog(),
    labels: HERA_LABELS,
    cooldowns: options.cooldowns ?? new Cooldowns(),
    now: options.now ?? NOW,
    virtualId,
    localOnly: virtualId === "local",
    policy: policyFromRoster(roster),
    scope: options.scope ?? "personal",
  });
}

/** Cooldowns with these refs cooling at NOW. */
function cooled(...refs: string[]): Cooldowns {
  const cooldowns = new Cooldowns();
  refs.forEach((ref, index) => cooldowns.cool(ref, index + 1, NOW, 30));
  return cooldowns;
}

/** Pi's default compaction settings, and the same with compaction disabled. */
const ENABLED: CompactionFigures = { enabled: true, reserve: 16_384, keepRecent: 20_000 };
const DISABLED: CompactionFigures = { ...ENABLED, enabled: false };

function plan(rc: ResolveContext, level: LevelInput, options: { last?: LastResponder; text?: string; compaction?: CompactionFigures } = {}): Plan {
  const facts = { contextTokens: undefined, roles: [], entries: undefined };
  return planUserTurn({ rc, text: options.text ?? "What is the capital of France?", last: options.last, now: rc.now, compaction: options.compaction ?? ENABLED, level, facts });
}

const picked = (decision: Decision): readonly [string, string, string] | string =>
  decision.ok ? [decision.choice.role, decision.choice.ref, decision.choice.code] : `refused: ${decision.attempts.map((attempt) => attempt.role).join(", ")}`;

function edited(edit: (roster: Json) => void, base: string = TEXT): string {
  const roster = JSON.parse(base);
  edit(roster);
  return JSON.stringify(roster);
}

function invalid(text: string, expected: string): void {
  const parsed = parseRoster(text);
  assert.equal(parsed.ok, false, `expected ${expected}`);
  if (!parsed.ok) assert.equal(parsed.error, expected);
}

function valid(text: string): RosterV2 {
  const parsed = parseRoster(text);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.ok(parsed.value.version === 2);
  return parsed.value;
}

describe("the roster's fallback chain: parsing and validation", () => {
  test("John's roster validates: the personal scope has the chain, the work scope has none", () => {
    assert.deepEqual(scopeSection(ROSTER, "personal")?.fallback, ["openrouter", "local"]);
    const work = scopeSection(ROSTER, "work");
    assert.ok(work !== undefined);
    assert.equal(Object.hasOwn(work, "fallback"), false);
    assert.deepEqual([...autoRoles(ROSTER, "personal")], ["low", "medium", "high", "super", "openrouter", "local"]);
    assert.deepEqual([...autoRoles(ROSTER, "work")], ["work-low", "work-medium", "work-high", "work-super"]);
  });

  test("a roster without the field parses as before: no scope gains a fallback key", () => {
    for (const scope of ["personal", "work"] as const) {
      const section = scopeSection(PLAIN, scope);
      assert.ok(section !== undefined);
      assert.deepEqual(Object.keys(section), ["levels", "directories"]);
      assert.deepEqual(fallbackAfter(PLAIN, scope, section.levels.low.role), []);
    }
    assert.deepEqual([...autoRoles(PLAIN, "personal")], ["low", "medium", "high", "super"]);
  });

  test("the chain is an array of role names, not empty, each a role, none twice", () => {
    invalid(edited((r) => (r.scopes.personal.fallback = "openrouter")), "scopes.personal.fallback: must be an array");
    invalid(edited((r) => (r.scopes.personal.fallback = [])), "scopes.personal.fallback: must not be empty");
    invalid(edited((r) => (r.scopes.personal.fallback = ["openrouter", 3])), "scopes.personal.fallback[1]: must be a non-empty string");
    invalid(edited((r) => (r.scopes.personal.fallback = ["openrouter", "cloud"])), 'scopes.personal.fallback[1]: "cloud" is not a role');
    invalid(edited((r) => (r.scopes.personal.fallback = ["openrouter", "local", "openrouter"])), 'scopes.personal.fallback[2]: "openrouter" is listed twice');
    // A ref is not a role name: the chain names roles, and each role lists its models.
    invalid(edited((r) => (r.scopes.personal.fallback = [OR_GLM])), `scopes.personal.fallback[0]: "${OR_GLM}" is not a role`);
  });

  test("a level's role cannot be in a chain, in its own scope or the other", () => {
    invalid(
      edited((r) => (r.scopes.personal.fallback = ["medium", "local"])),
      'scopes.personal.fallback[0]: "medium" is already the role of the personal scope\'s medium level',
    );
    invalid(
      edited((r) => (r.scopes.personal.fallback = ["openrouter", "work-low"])),
      'scopes.personal.fallback[1]: "work-low" is already the role of the work scope\'s low level',
    );
    invalid(
      edited((r) => (r.scopes.work.fallback = ["super"])),
      'scopes.work.fallback[0]: "super" is already the role of the personal scope\'s super level',
    );
  });

  test("a model still sits in one role only, so a chain cannot repeat a level's own model", () => {
    invalid(edited((r) => r.roles[1].models.push(LUNA)), `roles[2].models[0]: "${LUNA}" is already in role "openrouter"`);
    invalid(edited((r) => r.roles[2].models.push(GLM)), `roles[2].models[1]: "${GLM}" is already in role "local"`);
  });

  test("the work scope's chain takes only work-bound Codex models: no OpenRouter, local or personal-account model", () => {
    invalid(edited((r) => (r.scopes.work.fallback = ["openrouter"])), 'scopes.work.fallback[0]: "openrouter" is already in the personal scope\'s fallback');
    invalid(
      edited((r) => {
        delete r.scopes.personal.fallback;
        r.scopes.work.fallback = ["openrouter"];
      }),
      `roles[1].models[0]: "${OR_GLM}" is in the work scope's fallback, which takes only work-bound Codex models`,
    );
    invalid(
      edited((r) => {
        delete r.scopes.personal.fallback;
        r.scopes.work.fallback = ["local"];
      }),
      `roles[0].models[0]: "${GLM}" is in the work scope's fallback, which takes only work-bound Codex models`,
    );
    invalid(
      edited((r) => {
        r.roles.push({ name: "spare", models: ["openai-codex-2/gpt-6-nova"] });
        r.scopes.work.fallback = ["spare"];
      }),
      'roles[10].models[0]: "openai-codex-2/gpt-6-nova" is in the work scope\'s fallback, which takes only work-bound Codex models',
    );
  });

  test("the personal scope's chain takes no work-bound model", () => {
    invalid(
      edited((r) => {
        r.roles.push({ name: "work-spare", models: ["openai-codex-3/gpt-6-nova"] });
        r.scopes.personal.fallback = ["openrouter", "work-spare"];
      }),
      'roles[10].models[0]: "openai-codex-3/gpt-6-nova" is in the personal scope\'s fallback, but openai-codex-3 is work-bound',
    );
  });

  test("a work chain of work-bound Codex models is valid, and the work alias's exclusion is lifted for it in work scope only", () => {
    const spare = "openai-codex-3/gpt-6-nova";
    const withSpare = (r: Json): void => void r.roles.push({ name: "work-spare", models: [spare] });
    // In no level and no chain, the built-in exclusion still refuses the role.
    invalid(edited(withSpare), `roles[10].models[0]: "${spare}" is excluded by openai-codex-3/*`);
    const roster = valid(
      edited((r) => {
        withSpare(r);
        r.scopes.work.fallback = ["work-spare"];
      }),
    );
    assert.deepEqual(scopeSection(roster, "work")?.fallback, ["work-spare"]);
    assert.equal(excludedBy(excludesFor(roster, "work", spare), spare), undefined);
    assert.equal(excludedBy(excludesFor(roster, "personal", spare), spare), "openai-codex-3/*");
    assert.deepEqual([...autoRoles(roster, "work")], ["work-low", "work-medium", "work-high", "work-super", "work-spare"]);
  });

  test("the field belongs to a version 2 scope only", () => {
    invalid(edited((r) => (r.fallback = ["openrouter"])), "fallback: unknown key");
    invalid(edited((r) => (r.scopes.personal.levels.low.fallback = ["openrouter"])), "scopes.personal.levels.low.fallback: unknown key");
    invalid(edited((r) => (r.scopes.personal.fallbacks = ["openrouter"])), "scopes.personal.fallbacks: unknown key");
  });
});

describe("candidate order under John's roster", () => {
  test("each personal level: its own Codex model, then the one shared chain, in the order written", () => {
    for (const tier of TIERS) {
      assert.deepEqual(
        candidatesOf(ROSTER, "personal", tier).map(({ ref }) => ref),
        [OWN[tier], ...CHAIN],
        tier,
      );
    }
    assert.deepEqual(candidatesOf(ROSTER, "personal", "low"), [
      { role: "low", ref: LUNA },
      { role: "openrouter", ref: OR_GLM },
      { role: "openrouter", ref: OR_QWEN },
      { role: "local", ref: GLM },
      { role: "local", ref: NYX_QWEN },
      { role: "local", ref: HERA_QWEN },
    ]);
  });

  test("smart-router/local: exactly the last three, in that order", () => {
    assert.deepEqual(policyFromRoster(ROSTER).refs, LOCAL);
    assert.deepEqual(ROSTER.roles.find((role) => role.name === ROSTER.local?.role)?.models, LOCAL);
  });

  test("each work level: its own work-account model and nothing else", () => {
    for (const tier of TIERS) {
      assert.deepEqual(candidatesOf(ROSTER, "work", `work-${tier}`), [{ role: `work-${tier}`, ref: WORK_OWN[tier] }], tier);
    }
  });

  test("a chain role goes on only to the roles after it, and a role outside the scope goes nowhere", () => {
    assert.deepEqual(fallbackAfter(ROSTER, "personal", "high"), ["openrouter", "local"]);
    assert.deepEqual(fallbackAfter(ROSTER, "personal", "openrouter"), ["local"]);
    assert.deepEqual(fallbackAfter(ROSTER, "personal", "local"), []);
    assert.deepEqual(fallbackAfter(ROSTER, "personal", "work-low"), []);
    assert.deepEqual(fallbackAfter(ROSTER, "work", "low"), []);
    assert.deepEqual(fallbackAfter(ROSTER, "work", "openrouter"), []);
  });
});

describe("planning with a fallback chain", () => {
  test("while a level's own model is available, the run takes it, and nothing marks a fallback", () => {
    for (const tier of TIERS) {
      const planned = plan(context(), { tag: tier });
      assert.deepEqual(picked(planned.decision), [tier, OWN[tier], "tag"], tier);
      assert.equal(planned.level?.fallback, undefined);
    }
  });

  test("a level whose own model is cooling goes to the chain at once, at the same level: no step-up", () => {
    for (const tier of TIERS) {
      const planned = plan(context({ cooldowns: cooled(OWN[tier]) }), { tag: tier });
      assert.deepEqual(picked(planned.decision), ["openrouter", OR_GLM, `fallback:${tier}→openrouter`], tier);
      // The plan keeps the level's role, so the run's first request picks in the level again.
      assert.equal(planned.role, tier);
      assert.deepEqual(planned.level, { scope: "personal", need: tier, tier, source: "tag", steppedUp: false, returnedToFirst: false, fallback: true });
    }
  });

  test("the chain is walked in the order written, skipping what cannot take the request", () => {
    const models = catalog();
    const cooldowns = cooled(LUNA, TERRA, SOL, ASTRA);
    const next = (): unknown => picked(plan(context({ catalog: models, cooldowns }), { tag: "medium" }).decision);
    assert.deepEqual(next(), ["openrouter", OR_GLM, "fallback:medium→openrouter"]);
    cooldowns.cool(OR_GLM, 10, NOW, 30);
    assert.deepEqual(next(), ["openrouter", OR_QWEN, "fallback:medium→openrouter"]);
    cooldowns.cool(OR_QWEN, 11, NOW, 30);
    assert.deepEqual(next(), ["local", GLM, "fallback:medium→local"]);
    models.unavailable.add(GLM);
    assert.deepEqual(next(), ["local", NYX_QWEN, "fallback:medium→local"]);
    models.remove(NYX_QWEN);
    assert.deepEqual(next(), ["local", HERA_QWEN, "fallback:medium→local"]);
    models.unauthenticated.add(HERA_QWEN);
    // Nothing is left at any level, so the run is refused: each role is named once.
    const refused = plan(context({ catalog: models, cooldowns }), { tag: "medium" });
    assert.equal(refused.decision.ok, false);
    assert.deepEqual(
      refused.decision.ok ? [] : refused.decision.attempts.map((attempt) => [attempt.role, attempt.fallback === true]),
      [["medium", false], ["openrouter", true], ["local", true], ["high", false], ["super", false]],
    );
    assert.equal(refused.role, undefined);
  });

  test("a local model in the chain is never cooled, as in the local role's own routes", () => {
    const cooldowns = cooled(LUNA, OR_GLM, OR_QWEN, GLM);
    assert.deepEqual(picked(plan(context({ cooldowns }), { tag: "low" }).decision), ["local", GLM, "fallback:low→local"]);
  });

  test("the session returns to the level's own model as soon as it is available again, and the record notes it", () => {
    // The last response came from a fallback, a moment ago.
    const last: LastResponder = { ref: OR_GLM, at: NOW - MINUTE };
    const back = plan(context(), { tag: "low" }, { last });
    assert.deepEqual(picked(back.decision), ["low", LUNA, "tag"]);
    assert.equal(back.level?.returnedToFirst, true);
    assert.equal(back.level?.fallback, undefined);
    // Once the cooldown has run out, with the same cooldowns object.
    const cooldowns = cooled(LUNA);
    assert.deepEqual(picked(plan(context({ cooldowns }), { tag: "low" }, { last }).decision), ["openrouter", OR_GLM, "fallback:low→openrouter"]);
    assert.deepEqual(picked(plan(context({ cooldowns, now: NOW + 31 * MINUTE }), { tag: "low" }, { last }).decision), ["low", LUNA, "tag"]);
  });

  test("with compaction disabled, when no candidate fits and every level would take the same chain model, the run keeps its own level", () => {
    const usage = { input: 250_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 250_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const planned = plan(context({ cooldowns: cooled(LUNA, TERRA, SOL, ASTRA) }), { tag: "low" }, { last: { ref: LUNA, at: NOW - MINUTE, usage }, compaction: DISABLED });
    assert.deepEqual(picked(planned.decision), ["openrouter", OR_GLM, "fallback:low→openrouter"]);
    assert.deepEqual([planned.level?.tier, planned.level?.steppedUp, planned.level?.fallback, planned.role], ["low", false, true, "low"]);
    // A higher level whose own model is available and too small still takes the run, as before.
    const huge = { last: { ref: LUNA, at: NOW - MINUTE, usage: { ...usage, input: 300_000, totalTokens: 300_000 } } };
    const up = plan(context({ cooldowns: cooled(LUNA, TERRA, SOL) }), { tag: "low" }, { ...huge, compaction: DISABLED });
    assert.deepEqual([picked(up.decision), up.level?.tier, up.level?.steppedUp], [["super", ASTRA, "step-up"], "super", true]);
    // With compaction enabled the run keeps its level and the chain model, and Pi compacts.
    const kept = plan(context({ cooldowns: cooled(LUNA, TERRA, SOL) }), { tag: "low" }, huge);
    assert.deepEqual([picked(kept.decision), kept.level?.tier, kept.level?.steppedUp], [["openrouter", OR_GLM, "fallback:low→openrouter"], "low", false], "with compaction enabled a too-small model is compacted for");
  });

  test("a chain model holds no level: the next untagged run goes to its own level's model, a moment later too", () => {
    for (const ref of CHAIN) {
      const planned = plan(context(), {}, { last: { ref, at: NOW - MINUTE }, text: "Format this file" });
      assert.deepEqual(picked(planned.decision), ["low", LUNA, "heuristics"], `${ref}: without Jev the heuristics decide alone, and rate a trivial prompt LOW`);
    }
    // Nor does a level's own model.
    assert.deepEqual(picked(plan(context(), {}, { last: { ref: ASTRA, at: NOW - MINUTE }, text: "Format this file" }).decision), ["low", LUNA, "heuristics"], "nothing holds a session by time");
  });

  test("a move further down the chain is no return", () => {
    const planned = plan(context({ cooldowns: cooled(LUNA, OR_GLM) }), { tag: "low" }, { last: { ref: OR_GLM, at: NOW - MINUTE } });
    assert.deepEqual(picked(planned.decision), ["openrouter", OR_QWEN, "fallback:low→openrouter"]);
    assert.equal(planned.level?.returnedToFirst, false);
    // Back up the chain, from a local model to OpenRouter, is a return to an earlier candidate.
    const up = plan(context({ cooldowns: cooled(LUNA) }), { tag: "low" }, { last: { ref: GLM, at: NOW - MINUTE } });
    assert.deepEqual(picked(up.decision), ["openrouter", OR_GLM, "fallback:low→openrouter"]);
    assert.equal(up.level?.returnedToFirst, true);
  });

  test("with compaction disabled, a fallback too small for the conversation passes the run up, where the next level's own model takes it", () => {
    const usage = { input: 250_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 250_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const last = { ref: LUNA, at: NOW - MINUTE, usage };
    const planned = plan(context({ cooldowns: cooled(LUNA) }), { tag: "low" }, { last, compaction: DISABLED });
    assert.deepEqual(picked(planned.decision), ["medium", TERRA, "step-up"]);
    assert.deepEqual([planned.level?.tier, planned.level?.steppedUp, planned.level?.fallback], ["medium", true, undefined]);
    // With compaction enabled the fallback takes the run at its level, and Pi compacts.
    const kept = plan(context({ cooldowns: cooled(LUNA) }), { tag: "low" }, { last });
    assert.deepEqual([picked(kept.decision), kept.level?.tier, kept.level?.steppedUp, kept.level?.fallback], [["openrouter", OR_GLM, "fallback:low→openrouter"], "low", false, true], "with compaction enabled a too-small model is compacted for");
  });

  test("a pick that starts in a chain role goes forward only, never back to a level", () => {
    const rc = context({ cooldowns: cooled(OR_QWEN) });
    assert.deepEqual(picked(pickInRole(rc, "openrouter", { skip: OR_GLM, fallback: true, code: "retry:next" })), ["local", GLM, "fallback:openrouter→local"]);
    assert.deepEqual(picked(pickInRole(context(), "openrouter", { skip: OR_GLM, fallback: true, code: "retry:next" })), ["openrouter", OR_QWEN, "retry:next"]);
    assert.deepEqual(picked(pickInRole(context(), "local", { skip: GLM, fallback: true, code: "retry:next" })), ["local", NYX_QWEN, "retry:next"]);
    // A caller that forbids the fallback gets the role alone.
    assert.equal(picked(pickInRole(context({ cooldowns: cooled(LUNA) }), "low", { fallback: false, code: "limits" })), "refused: low");
  });

  test("auto reaches the chain's roles in the scope that declares it, and nowhere else", () => {
    assert.equal(eligibleRole(context(), OR_GLM), "openrouter");
    assert.equal(eligibleRole(context(), GLM), "local");
    assert.equal(resolveCandidate(GLM, context()).ok, true);
    assert.equal(eligibleRole(context({ scope: "work" }), OR_GLM), undefined);
    assert.equal(eligibleRole(context({ scope: "work" }), GLM), undefined);
    const elsewhere = resolveCandidate(OR_GLM, context({ scope: "work" }));
    assert.deepEqual([elsewhere.ok, elsewhere.ok ? "" : elsewhere.reason], [false, "not-routable-by-auto"]);
    // Without a declared chain the local role stays out of auto's reach, as before.
    const before = resolveCandidate(GLM, context({ roster: PLAIN }));
    assert.deepEqual([before.ok, before.ok ? "" : before.reason], [false, "not-routable-by-auto"]);
  });
});

describe("the work scope declares no fallback, so it behaves as before", () => {
  test("a work level whose model is cooling steps up to the next work level, never to the personal chain", () => {
    const planned = plan(context({ scope: "work", cooldowns: cooled(WORK_LUNA) }), { tag: "low" });
    assert.deepEqual(picked(planned.decision), ["work-medium", WORK_TERRA, "step-up"]);
    assert.equal(planned.level?.fallback, undefined);
  });

  test("with every work model cooling, the run is refused: no OpenRouter, local or personal-account model takes it", () => {
    const planned = plan(context({ scope: "work", cooldowns: cooled(WORK_LUNA, WORK_TERRA, WORK_SOL, WORK_ASTRA) }), { tag: "low" });
    assert.equal(picked(planned.decision), "refused: work-low, work-medium, work-high, work-super");
    const retry = pickInRole(context({ scope: "work", cooldowns: cooled(WORK_LUNA) }), "work-low", { skip: WORK_LUNA, fallback: true, code: "retry:next" });
    assert.equal(picked(retry), "refused: work-low");
  });
});

describe("smart-router/local keeps to the local role", () => {
  test("smart-router/local takes the local role in its order, and is refused rather than sent to a cloud model", () => {
    const models = catalog();
    const next = (scope: Scope): unknown => picked(plan(context({ catalog: models, virtualId: "local", scope }), { tag: "super" }).decision);
    for (const scope of ["personal", "work"] as const) assert.deepEqual(next(scope), ["local", GLM, "local"], scope);
    models.unavailable.add(GLM);
    assert.deepEqual(next("personal"), ["local", NYX_QWEN, "local"]);
    models.unavailable.add(NYX_QWEN);
    assert.deepEqual(next("personal"), ["local", HERA_QWEN, "local"]);
    models.unavailable.add(HERA_QWEN);
    assert.equal(next("personal"), "refused: local");
    assert.equal(next("work"), "refused: local");
  });
});

// ─── Through the router ──────────────────────────────────────────────────────

const SID = "session-1";

beforeEach(resetSlot);
afterEach(resetSlot);

interface Session {
  readonly loaded: Loaded;
  readonly cat: FakeCatalog;
  clock: number;
}

async function session(t: TestContext, options: { readonly setup?: (session: FakeSession) => void; readonly select?: string } = {}): Promise<Session> {
  const cat = catalog();
  const state: { clock: number } = { clock: NOW };
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

async function finish(loaded: Loaded, ref: string): Promise<void> {
  await loaded.host.emit("message_end", { message: assistant(ref) });
  await loaded.host.emit("agent_settled", { aborted: false });
  loaded.session.endRun();
}

const lastHistory = (loaded: Loaded) => loaded.router?.record(SID)?.history.at(-1);
const records = (loaded: Loaded): Array<Record<string, unknown>> =>
  loaded.session.entries.filter((entry) => entry.customType === LEVEL_ENTRY).map((entry) => entry.data as Record<string, unknown>);

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

describe("a run through the router with a fallback chain", () => {
  // The rule for a retry that names a limit. Pi does not retry Codex's own usage-limit text, so the
  // path a real limit takes is in test/failover.test.ts; this text is one Pi would hand back.
  test("a usage limit moves the run down the chain, one candidate at a time, and the level it records stays its own", async (t) => {
    const { loaded } = await session(t);
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar #low");
    const first = runtime.route("auto", request("user", { signal }));
    assert.deepEqual([routed(first), lastHistory(loaded)?.code], [LUNA, "tag"]);
    const hops: Array<readonly [string, string, string, string]> = [
      [LUNA, OR_GLM, "fallback:low→openrouter", "high"],
      [OR_GLM, OR_QWEN, "retry:next", "high"],
      [OR_QWEN, GLM, "fallback:openrouter→local", "max"],
      [GLM, NYX_QWEN, "retry:next", "max"],
      [NYX_QWEN, HERA_QWEN, "retry:next", "max"],
    ];
    for (const [failed, next, code, thinking] of hops) {
      const route = runtime.route("auto", request("retry", { signal, failed: failure(runtime, failed, LIMIT) }));
      assert.deepEqual([routed(route), lastHistory(loaded)?.code, route.thinkingLevel], [next, code, thinking], failed);
      // The run's continuations stay on the model it moved to.
      assert.equal(routed(runtime.route("auto", request("continuation", { signal, previous: previous(runtime, next) }))), next);
    }
    // Local-role models are never cooled, but a run tries each candidate once: when the last one
    // fails too, the retry is refused, naming all three, and goes neither round nor back up the chain.
    const message = refusal(() => runtime.route("auto", request("retry", { signal, failed: failure(runtime, HERA_QWEN, LIMIT) })));
    assert.match(message, /^smart-router\/auto: no model can take this request \(local: /);
    for (const ref of [GLM, NYX_QWEN]) assert.ok(message.includes(`${ref}: its request failed earlier in this run`), message);
    assert.ok(message.includes(`${HERA_QWEN}: its request just failed`), message);
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    const [record, ...others] = records(loaded);
    assert.deepEqual(others, []);
    // The keywords' reason and Jev's opinion (unavailable on this fake host) are not this test's.
    const { keyword: _keyword, jev: _jev, ...rest } = record ?? {};
    assert.deepEqual(rest, { v: 1, at: NOW, scope: "personal", source: "tag", tier: "low", need: "low", tag: "low" }, "a record writes need where it wrote asked");
    // The next run starts afresh: the local models are tried again.
    const next = await prompt(loaded, "rename bar to baz #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal: next }))), GLM);
  });

  test("while a level's model cools, each new run takes the chain with a notice, and returns when the cooldown ends", async (t) => {
    const state = await session(t);
    const { loaded } = state;
    const { runtime } = loaded;
    let signal = await prompt(loaded, "rename foo to bar #low");
    runtime.route("auto", request("user", { signal }));
    assert.equal(routed(runtime.route("auto", request("retry", { signal, failed: failure(runtime, LUNA, LIMIT) }))), OR_GLM);
    await loaded.host.emit("message_end", { message: assistant(OR_GLM) });
    // The footer names the model the retry went to, though the plan was luna.
    assert.equal(footerOf(loaded), "low high → z-ai/glm-5.3-flash");
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();

    // The next run, a minute later: luna still cools.
    state.clock = NOW + MINUTE;
    const before = loaded.session.notices.length;
    signal = await prompt(loaded, "rename bar to baz #low");
    assert.deepEqual(loaded.session.notices.slice(before), [
      { type: "info", message: "pi-smart-router: no LOW model can take this run, so it goes to the fallback openrouter (z-ai/glm-5.3-flash)." },
    ]);
    assert.equal(footerOf(loaded), "low → z-ai/glm-5.3-flash", "the plan's footer: the level and the chain model it picked");
    assert.equal(plannedWords(loaded), "personal LOW → z-ai/glm-5.3-flash (tag; fallback)", "history says the pick is a fallback");
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastHistory(loaded)?.code], [OR_GLM, "fallback:low→openrouter"]);
    await finish(loaded, OR_GLM);

    // luna's limit is its account's, so another level goes to the chain as well, without trying sol.
    signal = await prompt(loaded, "review the design #high");
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastHistory(loaded)?.code], [OR_GLM, "fallback:high→openrouter"]);
    await finish(loaded, OR_GLM);

    // After cooldownMinutes, luna takes LOW runs again.
    state.clock = NOW + 31 * MINUTE;
    signal = await prompt(loaded, "rename baz to qux #low");
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastHistory(loaded)?.code], [LUNA, "tag"]);
    assert.equal(footerOf(loaded), "low high → gpt-6-luna");
    assert.equal(plannedWords(loaded), "personal LOW → gpt-6-luna (tag)");
    await finish(loaded, LUNA);
    const [first, second, third, fourth] = records(loaded);
    // The first run moved to the chain on its retry, the second was planned onto it.
    assert.deepEqual([first?.tier, first?.ref, first?.fallback], ["low", OR_GLM, true]);
    assert.deepEqual([second?.tier, second?.ref, second?.fallback], ["low", OR_GLM, true]);
    assert.deepEqual([third?.tier, third?.ref, third?.fallback], ["high", OR_GLM, true]);
    assert.deepEqual([fourth?.tier, fourth?.ref, fourth?.fallback], ["low", LUNA, undefined]);
  });

  test("a run that starts without a prompt returns to the level's own model once it is back, and stays on the chain until then", async (t) => {
    const state = await session(t);
    const { loaded } = state;
    const { runtime } = loaded;
    let signal = await prompt(loaded, "review the design #high");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), SOL);
    await loaded.host.emit("message_end", { message: assistant(SOL, { stopReason: "error", errorMessage: LIMIT, content: [] }) });
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    signal = await prompt(loaded, "review the design #high");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), OR_GLM);
    await finish(loaded, OR_GLM);

    // A goal continuation or a loop's run has no prompt and no plan. While the account cools, it
    // goes on with the chain; its level is the one the session held.
    for (const reason of ["continuation", "user"] as const) {
      state.clock += MINUTE;
      await loaded.host.emit("before_agent_start", { messageType: "custom" });
      signal = loaded.session.startRun();
      const during = runtime.route("auto", request(reason, { signal, previous: previous(runtime, OR_GLM) }));
      assert.deepEqual([routed(during), lastHistory(loaded)?.code], [OR_GLM, "fallback:high→openrouter"], reason);
      await finish(loaded, OR_GLM);
    }
    // 31 minutes after the fallback, the first request of such a run goes back to sol.
    for (const reason of ["continuation", "user"] as const) {
      resetSlot();
      const later = await session(t);
      let run = await prompt(later.loaded, "review the design #high");
      later.loaded.runtime.route("auto", request("user", { signal: run }));
      assert.equal(routed(later.loaded.runtime.route("auto", request("retry", { signal: run, failed: failure(later.loaded.runtime, SOL, LIMIT) }))), OR_GLM);
      await finish(later.loaded, OR_GLM);
      later.clock = NOW + 31 * MINUTE;
      await later.loaded.host.emit("before_agent_start", { messageType: "custom" });
      run = later.loaded.session.startRun();
      const back = later.loaded.runtime.route("auto", request(reason, { signal: run, previous: previous(later.loaded.runtime, OR_GLM) }));
      assert.deepEqual(
        [routed(back), lastHistory(later.loaded)?.code],
        [SOL, "run:need"],
        `${reason}: a run that starts without a prompt takes the level its session last needed and goes through the same choice (run:need)`,
      );
      // The run's own continuations stay on the model it now has.
      assert.equal(routed(later.loaded.runtime.route("auto", request("continuation", { signal: run, previous: previous(later.loaded.runtime, SOL) }))), SOL);
      assert.equal(lastHistory(later.loaded)?.code, "stick:previous");
    }
  });

  test("a restored session returns to its level too: the level comes from its latest record, when its scope still has it", async (t) => {
    /** A session resumed with a HIGH run on record whose last answer came from OpenRouter. */
    const restored = (record: Record<string, unknown>) =>
      session(t, {
        setup: (s) => {
          s.appendCustom(LEVEL_ENTRY, { v: 1, at: NOW - 40 * MINUTE, scope: "personal", source: "tag", tier: "high", asked: "high", tag: "high", ref: OR_GLM, fallback: true, ...record });
          s.appendAssistant(assistant(OR_GLM, { timestamp: NOW - 40 * MINUTE }));
        },
      });
    const unplanned = async (state: Session): Promise<readonly [string, string | undefined]> => {
      await state.loaded.host.emit("before_agent_start", { messageType: "custom" });
      const signal = state.loaded.session.startRun();
      const route = state.loaded.runtime.route("auto", request("continuation", { signal, previous: previous(state.loaded.runtime, OR_GLM) }));
      return [routed(route), lastHistory(state.loaded)?.code];
    };
    assert.deepEqual(
      await unplanned(await restored({})),
      [SOL, "run:need"],
      "a run that starts without a prompt takes the level its session last needed and goes through the same choice (run:need)",
    );
    // A correction is a label, not a run's level; a record of another scope, or of no tier, seeds nothing.
    for (const record of [{ source: "correction", refers: NOW - 50 * MINUTE }, { scope: "work" }, { tier: "ultra" }, { v: 2 }]) {
      resetSlot();
      assert.deepEqual(await unplanned(await restored(record)), [OR_GLM, "stick:previous"], JSON.stringify(record));
    }
  });

  test("a run starts with no memory of the models that failed in the run before", async (t) => {
    const { loaded } = await session(t, { select: "local" });
    const { runtime } = loaded;
    let signal = await prompt(loaded, "rename foo to bar");
    assert.equal(routed(runtime.route("local", request("user", { signal }))), GLM);
    assert.equal(routed(runtime.route("local", request("retry", { signal, failed: failure(runtime, GLM, LIMIT) }))), NYX_QWEN);
    assert.equal(routed(runtime.route("local", request("retry", { signal, failed: failure(runtime, NYX_QWEN, LIMIT) }))), HERA_QWEN);
    refusal(() => runtime.route("local", request("retry", { signal, failed: failure(runtime, HERA_QWEN, LIMIT) })));
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    // The next run's first limit goes on to the second model, as the first run's did.
    signal = await prompt(loaded, "rename bar to baz");
    assert.equal(routed(runtime.route("local", request("user", { signal }))), GLM);
    assert.equal(routed(runtime.route("local", request("retry", { signal, failed: failure(runtime, GLM, LIMIT) }))), NYX_QWEN);
  });

  test("a move onto the chain in mid-run is said once, and a trivial follow-up a minute later goes to LOW, on the chain while the account cools", async (t) => {
    const state = await session(t);
    const { loaded } = state;
    const { runtime } = loaded;
    let signal = await prompt(loaded, "plan the migration #super");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), ASTRA);
    const before = loaded.session.notices.length;
    assert.equal(routed(runtime.route("auto", request("retry", { signal, failed: failure(runtime, ASTRA, LIMIT) }))), OR_GLM);
    runtime.route("auto", request("continuation", { signal, previous: previous(runtime, OR_GLM) }));
    assert.deepEqual(loaded.session.notices.slice(before), [
      { type: "info", message: "pi-smart-router: gpt-6-astra can no longer take this run, so it goes on with the fallback openrouter (z-ai/glm-5.3-flash)." },
    ]);
    await finish(loaded, OR_GLM);
    state.clock = NOW + MINUTE;
    signal = await prompt(loaded, "Format this file");
    // The limit cooled the whole openai-codex-2 account, luna too, so LOW goes to the chain.
    assert.equal(footerOf(loaded), "low → z-ai/glm-5.3-flash");
    assert.equal(
      plannedWords(loaded),
      "personal LOW → z-ai/glm-5.3-flash (demand 0.6, jev unavailable; fallback)",
      "nothing holds a session by time: without Jev the heuristics alone rate a trivial prompt LOW, 0.59 with the last response's 1,000 tokens",
    );
    assert.deepEqual([routed(runtime.route("auto", request("user", { signal }))), lastHistory(loaded)?.code], [OR_GLM, "fallback:low→openrouter"], "nothing holds a session by time");
  });

  test("a refusal names the level's role, then the chain's roles as fallbacks, then the levels above as step-ups", async (t) => {
    const { loaded, cat } = await session(t);
    for (const ref of [...TIERS.map((tier) => OWN[tier]), ...CHAIN]) cat.unavailable.add(ref);
    const signal = await prompt(loaded, "rename foo to bar #high");
    const message = refusal(() => loaded.runtime.route("auto", request("user", { signal })));
    assert.equal(
      message,
      `smart-router/auto: no model can take this request (high: ${SOL}: not among the available models; ` +
        `fallback openrouter: ${OR_GLM}: not among the available models; ${OR_QWEN}: not among the available models; ` +
        `fallback local: ${GLM}: not among the available models; ${NYX_QWEN}: not among the available models; ${HERA_QWEN}: not among the available models; ` +
        `step-up super: ${ASTRA}: not among the available models). Nothing was sent. See /smart-router status, or choose a model with /model.`,
    );
  });

  test("a work session never leaves the work account: a usage limit there is refused, not sent down the personal chain", async (t) => {
    const { loaded } = await session(t, { setup: (s) => s.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", NOW - MINUTE)) });
    const { runtime } = loaded;
    const signal = await prompt(loaded, "rename foo to bar #low");
    assert.equal(routed(runtime.route("auto", request("user", { signal }))), WORK_LUNA);
    const message = refusal(() => runtime.route("auto", request("retry", { signal, failed: failure(runtime, WORK_LUNA, LIMIT) })));
    assert.match(message, /^smart-router\/auto: no model can take this request \(work-low: /);
    assert.doesNotMatch(message, /openrouter|omlx-hera|nyx|openai-codex-2/);
    await finish(loaded, WORK_LUNA);
    // The limit is the work account's, so the next work run finds every work level cooling and is
    // refused too: the work scope has no chain, and no other account takes it.
    const next = await prompt(loaded, "rename bar to baz #low");
    const again = refusal(() => runtime.route("auto", request("user", { signal: next })));
    assert.match(again, /^smart-router\/auto: no model can take this request \(work-low: .*step-up work-medium: .*step-up work-high: .*step-up work-super: /);
    assert.doesNotMatch(again, /openrouter|omlx-hera|nyx|openai-codex-2/);
  });

  test("smart-router/local routes to the local role, and is refused rather than sent to a cloud model", async (t) => {
    const local = await session(t, { select: "local" });
    const run = await prompt(local.loaded, "plan the migration");
    assert.deepEqual([routed(local.loaded.runtime.route("local", request("user", { signal: run }))), lastHistory(local.loaded)?.code], [GLM, "local"]);
    for (const ref of LOCAL) local.cat.unavailable.add(ref);
    const message = refusal(() => local.loaded.runtime.route("local", request("continuation", { signal: run })));
    assert.match(message, /^smart-router\/local: no local model can take this request/);
    assert.doesNotMatch(message, /openrouter|openai-codex/);
  });

  test("smart-router/auto declares the smallest window among every role it reaches, the chain's roles included", async (t) => {
    const cat = catalog();
    cat.add(model(OR_GLM, { contextWindow: 64_000, maxTokens: 8_000 }));
    const loaded = await start({ dir: agentDir(t, { roster: TEXT }), runtime: new FakeRuntime(cat), now: () => NOW });
    assert.deepEqual(loaded.router?.limits().auto, { contextWindow: 64_000, maxTokens: 8_000 });
    // Without the chain's first model, its role's next one counts.
    resetSlot();
    const without = catalog();
    without.remove(OR_GLM);
    const next = await start({ dir: agentDir(t, { roster: TEXT }), runtime: new FakeRuntime(without), now: () => NOW });
    assert.deepEqual(next.router?.limits().auto, { contextWindow: 131_072, maxTokens: 32_000 });
  });

  test("/smart-router status shows the chain, which roles it reaches, and when the last request was on a fallback", async (t) => {
    const { loaded } = await session(t);
    const { runtime } = loaded;
    const status = async (): Promise<string[]> => {
      await loaded.host.command("smart-router", "status");
      return (loaded.session.notices.at(-1)?.message ?? "").split("\n");
    };
    const lines = await status();
    assert.ok(lines.includes(`  local (the local role; a personal fallback; thinking max): ${GLM} ok, ${NYX_QWEN} ok, ${HERA_QWEN} ok`), lines.join("\n"));
    assert.ok(lines.includes(`  openrouter (a personal fallback): ${OR_GLM} ok, ${OR_QWEN} ok`), lines.join("\n"));
    assert.ok(lines.includes(`Levels (personal): LOW → ${LUNA} ok; MEDIUM → ${TERRA} ok; HIGH → ${SOL} ok; SUPER → ${ASTRA} ok`), lines.join("\n"));
    assert.ok(
      lines.includes(`Fallback (personal), after any level's own models, in this order: openrouter → ${OR_GLM} ok, ${OR_QWEN} ok; local → ${GLM} ok, ${NYX_QWEN} ok, ${HERA_QWEN} ok`),
      lines.join("\n"),
    );
    assert.ok(lines.includes("Fallback (work): none, so a level with no available model passes its run up or refuses it"), lines.join("\n"));
    assert.equal(lines.some((line) => line.startsWith("On a fallback")), false);

    const signal = await prompt(loaded, "rename foo to bar #low");
    runtime.route("auto", request("user", { signal }));
    runtime.route("auto", request("retry", { signal, failed: failure(runtime, LUNA, LIMIT) }));
    const after = await status();
    assert.ok(after.some((line) => line.startsWith(`Levels (personal): LOW → ${LUNA} cooling-until-`)), after.join("\n"));
    assert.ok(
      after.includes(`On a fallback: the last request went to ${OR_GLM}, in the personal fallback role openrouter; each new run tries its level's own models first.`),
      after.join("\n"),
    );
  });
});
