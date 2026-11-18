// The role decision for one run, and the in-role pick every route makes. Pure: every input is
// passed in, and nothing is read, written or remembered here.
//
// A run's role comes from the text John typed: its classification picks a role from the routing
// table, whichever model answered last and however long ago. Nothing holds a session on a model by
// time: a run that classifies lower moves down at once, as one that classifies higher moves up.
//
// Version 2 plans a tier in the session's scope instead: the level the prompt needs, a trailing
// tag's, else its demand's (demand.ts), which blends Jev's answer with the heuristics, or takes the
// heuristics alone when Jev gave none. The demand's guards raise an untagged run to at least high
// when it names a risky operation, and a very deep session to the roster's floor; a tagged run is
// raised by neither. The tier's role takes its first available candidate, not the latest
// response's. A tier with no available candidate passes the run up to the next tier: a run is
// refused only when neither its own tier nor any above it has an available one.
//
// A conversation larger than a candidate's window neither removes the candidate nor holds the
// session while Pi's compaction is enabled: the run goes to its tier, and Pi compacts before it
// sends. With compaction disabled Pi would send the request as it is, so there a tier whose first
// available candidate is too small for the conversation passes the run up too, and when no tier's
// first available candidate fits, the highest tier with one takes the run.
//
// Among the levels at or above the needed one, the run goes to the model the expected run costs
// least on (chooseModel, priced by src/cost.ts), counting what each model has in its prompt cache and how
// likely that cache still exists: each level's first available model of its own is a candidate,
// and the model that answered last keeps the run unless another is cheaper by the roster's margin.
// The figures come from the session's ledger (src/ledger.ts). Without them, for a tagged run, when
// the needed level's own models cannot take the run, or when a figure is missing, the run goes to
// the needed level as described here, and a missing figure is recorded as an unknown cost.
//
// A scope that declares a fallback chain (roster.ts) gives every tier more candidates: after the
// tier's own models, the chain's roles in the order written. A tier takes the chain before it
// passes the run up, so a run keeps its tier while any chain model can take it. A chain model holds
// no tier: the next run starts from its own tier's first candidate, and so returns to the tier's
// own model as soon as that is available again.
import type { Api, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";

import { classify, riskyTrigger } from "./classify.ts";
import type { RiskyTrigger, Signal } from "./classify.ts";
import { PROVIDER } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { chooseByCost, positive, ratesOf } from "./cost.ts";
import type { Candidate, Priced, Rates, Workload } from "./cost.ts";
import { demandOf } from "./demand.ts";
import type { Demand, PromptFacts } from "./demand.ts";
import { isRecord, own } from "./files.ts";
import type { JevOutcome } from "./jev.ts";
import { againChance, effortOf, horizonFor, runShape } from "./ledger.ts";
import type { Ledger } from "./ledger.ts";
import { HELD_REASON, resolveCandidate } from "./resolve.ts";
import type { Resolution, ResolveContext } from "./resolve.ts";
import { autoRoles, candidatesOf, fallbackAfter, roleLevel, roleOf, scopeSection } from "./roster.ts";
import type { RosterV2, Scope, ScopeSection } from "./roster.ts";
import { AGAIN_DEFAULT, DEFAULT_SWITCHING, SUMMARY_TOKENS } from "./settings.ts";
import { tierAbove, tierRank } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** The latest successful physical response of a session. */
export interface LastResponder {
  readonly ref: string;
  readonly at: number;
  readonly usage?: Usage | undefined;
}

/** A model picked for a request, with the role it was picked in and the history code. */
export interface Choice {
  readonly role: string;
  readonly ref: string;
  readonly model: Model<Api>;
  readonly code: string;
}

/** A role a decision tried, with the reason each candidate could not take the request. */
export interface Attempt {
  readonly role: string;
  /** False when the roster has no role of that name. */
  readonly exists: boolean;
  /** Whether the role was tried as a fallback of the role the pick started in. */
  readonly fallback?: true;
  readonly candidates: ReadonlyArray<Resolution & { readonly ok: false }>;
}

export type Decision =
  | { readonly ok: true; readonly choice: Choice }
  | {
      readonly ok: false;
      readonly attempts: readonly Attempt[];
      /** A problem that is not about any candidate, such as a missing local section. */
      readonly problem?: string | undefined;
    };

export interface PickOptions {
  /** Never taken: the model whose request just failed. */
  readonly skip?: string | undefined;
  /** Never taken either: the models whose requests failed with a limit earlier in this run, so that a run tries each candidate once. */
  readonly skipped?: ReadonlySet<string> | undefined;
  /**
   * The model whose server could not be reached: the role's candidates are tried in the written
   * order starting after it and going round once, so that the next one written takes the request.
   * It comes last itself, where its hold passes it over.
   */
  readonly after?: string | undefined;
  /**
   * Leave held candidates out for good: the pick fails when only held ones are left. A retry asks
   * this way, because it has something better than a held candidate: the model it is on, under Pi's
   * backoff.
   */
  readonly strictHolds?: boolean | undefined;
  /** Whether the role's declared fallback may take over: version 1's one hop, or a version 2 scope's chain on smart-router/auto. Never while local-only. */
  readonly fallback: boolean;
  readonly code: string;
}

/**
 * The roles a pick may go on to after `roleName`, when the caller allows a fallback: version 1's
 * declared fallback role, one hop and never further; under version 2, on smart-router/auto, what is
 * left of the session's scope's chain (fallbackAfter). Never while local-only: smart-router/local
 * keeps to the local role.
 */
function fallbackRoles(rc: ResolveContext, roleName: string): readonly string[] {
  if (rc.localOnly) return [];
  if (rc.roster.version === 1) {
    const target = rc.roster.routing.fallback.get(roleName);
    return target === undefined ? [] : [target];
  }
  return rc.virtualId === "auto" ? fallbackAfter(rc.roster, rc.scope, roleName) : [];
}

/**
 * The first candidate of a role that resolves, else, when allowed, the first that resolves of the
 * roles its fallback goes on to, in order (fallbackRoles). Otherwise every candidate's reason.
 *
 * A hold is a preference, never a refusal. When nothing resolves and a hold is among the reasons,
 * the pick is made again without the holds, in the written order: every cooldown and every check
 * of the selection and the scope stays, so the request goes to the first candidate that
 * only its hold kept out. A server that had a blip is tried again rather than the request refused.
 */
export function pickInRole(rc: ResolveContext, roleName: string, options: PickOptions): Decision {
  const first = pickWithHolds(rc, roleName, options);
  if (first.ok || options.strictHolds === true || rc.holds === undefined) return first;
  const heldBack = first.attempts.some((attempt) => attempt.candidates.some((candidate) => candidate.reason.startsWith(HELD_REASON)));
  return heldBack ? pickWithHolds({ ...rc, holds: undefined }, roleName, { ...options, after: undefined }) : first;
}

function pickWithHolds(rc: ResolveContext, roleName: string, options: PickOptions): Decision {
  const attempts: Attempt[] = [];
  const firstIn = (name: string, fallback: boolean): (Resolution & { readonly ok: true }) | undefined => {
    const role = rc.roster.roles.find((entry) => entry.name === name);
    if (role === undefined) {
      attempts.push({ role: name, exists: false, candidates: [], ...(fallback ? { fallback: true as const } : {}) });
      return undefined;
    }
    const at = options.after === undefined ? -1 : role.models.indexOf(options.after);
    const order = at >= 0 ? [...role.models.slice(at + 1), ...role.models.slice(0, at + 1)] : role.models;
    const refused: Array<Resolution & { readonly ok: false }> = [];
    for (const ref of order) {
      const resolution: Resolution =
        ref === options.skip
          ? { ok: false, ref, reason: "failed", detail: "its request just failed" }
          : options.skipped?.has(ref) === true
            ? { ok: false, ref, reason: "failed", detail: "its request failed earlier in this run" }
            : resolveCandidate(ref, rc);
      if (resolution.ok) return resolution;
      refused.push(resolution);
    }
    attempts.push({ role: name, exists: true, candidates: refused, ...(fallback ? { fallback: true as const } : {}) });
    return undefined;
  };
  const inRole = firstIn(roleName, false);
  if (inRole !== undefined) return { ok: true, choice: { role: roleName, ref: inRole.ref, model: inRole.model, code: options.code } };
  for (const target of options.fallback ? fallbackRoles(rc, roleName) : []) {
    const other = firstIn(target, true);
    if (other !== undefined) {
      return { ok: true, choice: { role: target, ref: other.ref, model: other.model, code: `fallback:${roleName}→${target}` } };
    }
  }
  return { ok: false, attempts };
}

/** What a version 2 run's input says about its tier: a trailing tag's, and Jev's outcome. */
export interface LevelInput {
  readonly tag?: Tier;
  readonly jev?: JevOutcome;
}

/** What decided a version 2 run's level: a tag, the blend with Jev's answer, the heuristics alone, or a floor that raised it. */
export type LevelSource = "tag" | "jev" | "heuristics" | "floor";

/** Why a version 2 run on auto went to its tier. Never prompt text. */
export interface PlanLevel {
  readonly scope: Scope;
  /** The level the prompt needs: its tag's, else its demand's after the guards. */
  readonly need: Tier;
  /** The level whose model takes the run: `need`, or a higher one. When the plan picked none, `need`. */
  readonly tier: Tier;
  readonly source: LevelSource;
  /** The risky operation that raised the run to HIGH. */
  readonly trigger?: RiskyTrigger;
  /** An untagged run's demand. */
  readonly demand?: Demand;
  /**
   * Whether `tier` is above `need` because each level between had no available model, or none that
   * fits with compaction disabled. A stronger model chosen by cost is no step-up.
   */
  readonly steppedUp: boolean;
  /**
   * Whether the pick ranks before the model that answered last, in that model's role: the role is
   * back on an earlier candidate. A move off the latest responder to a later candidate is no return.
   */
  readonly returnedToFirst: boolean;
  /** The outcome an untagged run waited for. */
  readonly jev?: JevOutcome;
  /** The pick is a model of the scope's fallback chain, not one of the tier's own: the run keeps its tier. */
  readonly fallback?: true;
  /** What the cost rule decided, when it was asked: an untagged run with the session's figures. */
  readonly cost?: CostTerms;
}

/** A run's decision, made when its prompt arrives and consumed by its first request. */
export interface Plan {
  readonly virtualId: VirtualId;
  readonly localOnly: boolean;
  readonly signal: Signal | "local";
  /** Why the text classified as it did; never prompt text. */
  readonly reason: string;
  /** The role decided, before any fallback; undefined when there is none to decide. */
  readonly role: string | undefined;
  /**
   * The history code of the decision: `signal:*` or `local`. A version 2 run on auto has its level's
   * source (`tag`, `jev`, `heuristics` or `floor`), `step-up` when its pick moved up a tier, or
   * `no-scope` when the roster does not serve the session's scope.
   */
  readonly code: string;
  /** The model the decision picked when it was made, or why there was none. */
  readonly decision: Decision;
  /** A version 2 run's level on auto, in a scope the roster serves. */
  readonly level?: PlanLevel;
}

export interface PlanInput {
  readonly rc: ResolveContext;
  /** The text John typed. */
  readonly text: string;
  readonly last: LastResponder | undefined;
  readonly now: number;
  /** Pi's compaction settings under the selection (see `compactionFor`). */
  readonly compaction: CompactionFigures;
  /** A version 2 run's tag and Jev outcome; version 1 and local-only runs ignore it. */
  readonly level?: LevelInput;
  /** What the heuristics read of the session before the prompt; only an untagged version 2 run on auto uses them. */
  readonly facts: PromptFacts;
  /** What the cost rule reads of the session; without them a version 2 run on auto goes to the level it needs. */
  readonly figures?: CostFigures;
}

/** The role of a ref that may take this request: the local role when local-only, else for auto a role auto can reach. */
export function eligibleRole(rc: ResolveContext, ref: string): string | undefined {
  const role = roleOf(rc.roster, ref)?.name;
  if (role === undefined) return undefined;
  if (rc.localOnly) return role === rc.roster.local?.role ? role : undefined;
  if (rc.virtualId === "auto" && !autoRoles(rc.roster, rc.scope).has(role)) return undefined;
  return role;
}

export const NO_LOCAL_SECTION = "the roster has no local section";

/** A version 2 roster that serves no such scope. */
export function noScopeSection(scope: Scope): string {
  return `the roster has no ${scope} scope`;
}

const STEP_UP = "step-up";
const NO_SCOPE = "no-scope";

/** Whether a pick ranks before `later` among a tier's candidates: its role's own models, then the scope's chain. */
function ranksBefore(rc: ResolveContext, section: ScopeSection, tier: Tier, choice: Choice, later: string): boolean {
  const refs = candidatesOf(rc.roster, rc.scope, section.levels[tier].role).map((candidate) => candidate.ref);
  const at = refs.indexOf(choice.ref);
  return at >= 0 && at < refs.indexOf(later);
}

/**
 * From `start` upward, the first tier with an available candidate. With `checkFit`, compaction being
 * disabled, the first tier whose first available candidate fits the conversation, and when none
 * fits, the highest tier with an available candidate: fit alone never refuses. A tier's candidates
 * are its role's own models and then the scope's fallback chain, so a tier takes the chain before
 * it passes the run up. The start tier's pick carries `code`, a higher tier's `step-up`, and a chain
 * model's names the roles. When no tier has an available candidate, every role's reasons, each role
 * once, and the start tier.
 */
function climb(p: Sizing, section: ScopeSection, start: Tier, code: string, checkFit: boolean): { readonly tier: Tier; readonly decision: Decision } {
  const attempts: Attempt[] = [];
  let first: { readonly tier: Tier; readonly decision: Decision & { readonly ok: true } } | undefined;
  let highest: { readonly tier: Tier; readonly decision: Decision & { readonly ok: true } } | undefined;
  for (let tier: Tier | undefined = start; tier !== undefined; tier = tierAbove(tier)) {
    const decision = pickInRole(p.rc, section.levels[tier].role, { fallback: true, code: tier === start ? code : STEP_UP });
    // Every tier shares the scope's chain, so its roles' reasons are listed with the first tier's only.
    if (!decision.ok) attempts.push(...decision.attempts.filter((attempt) => !attempts.some((seen) => seen.role === attempt.role)));
    else if (!checkFit || fitsSize(p.conversation, p.reserve, decision.choice.model)) return { tier, decision };
    else {
      highest = { tier, decision };
      first ??= highest;
    }
  }
  // When the highest tier would take the very model the first one would, a chain model that every
  // tier shares, moving up gains nothing: the run keeps the tier it started at.
  if (first !== undefined && highest !== undefined && first.decision.choice.ref === highest.decision.choice.ref) return first;
  return highest ?? { tier: start, decision: { ok: false, attempts } };
}

/** What a climb measures a candidate against: the conversation with the new prompt, and Pi's compaction reserve. */
interface Sizing {
  readonly rc: ResolveContext;
  readonly conversation: number;
  readonly reserve: number;
}

/** What the cost rule reads of the session. */
export interface CostFigures {
  readonly ledger: Ledger;
  /** The thinking level selected for the session; a role may fix another (roleLevel). */
  readonly thinking: ModelThinkingLevel;
}

/** What the cost rule decided, for the run's record: model refs, numbers, level names and outcome names, never prompt text. */
export type CostTerms =
  | { readonly outcome: "unknown"; readonly why: "no usage yet" | "no price" | "the clock went backwards" }
  | {
      readonly outcome: "stayed" | "moved" | "only";
      readonly chosen: string;
      readonly priced: readonly Priced[];
      readonly workload: Workload;
      readonly again: number;
    };

/** The level whose model takes a run, its pick, whether it stepped up past the needed level, and what the cost rule decided. */
export interface Chosen {
  readonly tier: Tier;
  readonly decision: Decision;
  readonly steppedUp: boolean;
  readonly cost?: CostTerms;
}

/** A cache lifetime the catalog entry states: its short retention's, else its long one's, when positive. */
function lifetimeOf(model: Model<Api>): number | undefined {
  const short = model.promptCache?.short;
  const long = model.promptCache?.long;
  return short !== undefined && positive(short) ? short : long !== undefined && positive(long) ? long : undefined;
}

/**
 * The model a run takes, from the level it needs up. Without figures, for a run that is not priced
 * (a tagged one), or when the needed level's own models cannot take it, the climb as it always was
 * (its chain, then a step up). Otherwise each level's first available model of its own is a
 * candidate, once (a model a lower level took is not a candidate again), and, with compaction
 * disabled, only when the conversation fits it. With no usage yet (no history measured, whatever
 * the prompt's size), a candidate without a price or one seen after now (checked in that order),
 * the needed level's own model takes the run and the cost is unknown. A candidate is priced at the
 * size it is sent: the conversation, or, when Pi compacts first, what the compaction leaves. Else
 * chooseByCost picks, counting a model's cache only at the effort of its last answer: a known
 * effort that differs from the one it would be sent now leaves it nothing cached.
 */
export function chooseModel(input: {
  readonly rc: ResolveContext;
  readonly section: ScopeSection;
  readonly need: Tier;
  readonly code: string;
  readonly last: LastResponder | undefined;
  readonly promptTokens: number;
  readonly compaction: CompactionFigures;
  readonly figures: CostFigures | undefined;
  readonly priced: boolean;
}): Chosen {
  const { rc, section, need, code, last, compaction, figures } = input;
  const conversation = historyOf(last) + input.promptTokens;
  const climbed = (): Chosen => {
    const { tier, decision } = climb({ rc, conversation, reserve: compaction.reserve }, section, need, code, !compaction.enabled);
    return { tier, decision, steppedUp: tierRank(tier) > tierRank(need) };
  };
  if (figures === undefined || !input.priced) return climbed();

  const levels: Array<{ readonly tier: Tier; readonly decision: Decision & { readonly ok: true } }> = [];
  for (let tier: Tier | undefined = need; tier !== undefined; tier = tierAbove(tier)) {
    const decision = pickInRole(rc, section.levels[tier].role, { fallback: false, code });
    if (!decision.ok) continue;
    if (!compaction.enabled && !fitsSize(conversation, compaction.reserve, decision.choice.model)) continue;
    if (levels.some((level) => level.decision.choice.ref === decision.choice.ref)) continue;
    levels.push({ tier, decision });
  }
  const needed = levels[0];
  if (needed === undefined || needed.tier !== need) return climbed();

  const unknown = (why: "no usage yet" | "no price" | "the clock went backwards"): Chosen => ({
    tier: need,
    decision: needed.decision,
    steppedUp: false,
    cost: { outcome: "unknown", why },
  });
  // The history alone: a prompt is no usage.
  if (last?.usage === undefined || historyOf(last) === 0) return unknown("no usage yet");
  const { ledger, thinking } = figures;
  // A candidate that compacts first is sent the conversation Pi leaves, so it is priced at that size.
  const after = compaction.keepRecent + SUMMARY_TOKENS;
  const rated: Array<{ readonly tier: Tier; readonly choice: Choice; readonly rates: Rates; readonly compacts: boolean }> = [];
  for (const { tier, decision } of levels) {
    const { model } = decision.choice;
    const compacts = compaction.enabled && !fitsSize(conversation, compaction.reserve, model);
    const rates = ratesOf(model.cost, compacts ? after : conversation, ledger.writes.has(model.provider));
    if (rates === undefined) return unknown("no price");
    rated.push({ tier, choice: decision.choice, rates, compacts });
  }
  if (rated.some(({ choice }) => (ledger.seen.get(choice.ref)?.at ?? rc.now) > rc.now)) return unknown("the clock went backwards");

  const candidates = rated.map(({ tier, choice, rates, compacts }): Candidate => {
    const seen = ledger.seen.get(choice.ref);
    const effort = effortOf(choice.model, roleLevel(rc.roster, choice.role, thinking));
    const sameEffort = seen?.effort === undefined || seen.effort === effort;
    return {
      ref: choice.ref,
      tier,
      rates,
      cached: seen !== undefined && sameEffort ? Math.min(seen.tokens, conversation) : 0,
      idle: seen === undefined ? undefined : (rc.now - seen.at) / 1_000,
      lifetime: lifetimeOf(choice.model),
      compacts,
    };
  });
  const switching = rc.roster.version === 2 ? rc.roster.switching : DEFAULT_SWITCHING;
  const workload: Workload = { tokens: conversation, ...runShape(ledger), horizon: horizonFor(ledger, need, switching.horizonCap) };
  const current = candidates.find((candidate) => candidate.ref === last.ref);
  const again = current === undefined ? AGAIN_DEFAULT : againChance(ledger, current.tier);
  const choice = chooseByCost({
    candidates,
    current: current?.ref,
    workload,
    again,
    settings: switching,
    compaction: { summary: SUMMARY_TOKENS, after },
  });
  const taken = rated.find((entry) => entry.choice.ref === choice.chosen.ref)!;
  return {
    tier: taken.tier,
    decision: { ok: true, choice: taken.choice },
    steppedUp: false,
    cost: { outcome: choice.outcome, chosen: choice.chosen.ref, priced: choice.priced, workload, again },
  };
}

/**
 * The level a version 2 run on auto needs, and what decided it: a tag's, which no floor raises;
 * else the demand's, after its guards. A guard that raised the level, the risky one or the deep
 * session's, makes the source `floor`; else the blend with Jev's answer is `jev`, and the heuristics
 * alone are `heuristics`.
 */
function needOf(p: PlanInput, roster: RosterV2, signal: Signal): Pick<PlanLevel, "need" | "source" | "trigger" | "demand"> {
  const tag = p.level?.tag;
  if (tag !== undefined) return { need: tag, source: "tag" };
  const risky = riskyTrigger(p.text);
  const demand = demandOf({ text: p.text, planning: signal === "planning", risky: risky !== undefined, jev: p.level?.jev, facts: p.facts }, roster.demand);
  const raised = demand.guards.includes("risky") || demand.guards.includes("deep-session");
  const source: LevelSource = raised ? "floor" : demand.jev !== undefined ? "jev" : "heuristics";
  return { need: demand.tier, source, ...(risky !== undefined && demand.guards.includes("risky") ? { trigger: risky } : {}), demand };
}

/** A version 2 run on auto, in a scope the roster serves. A refusal keeps no role, so the run's request does not pick in one again. */
function planLevel(p: PlanInput, roster: RosterV2, section: ScopeSection, signal: Signal): Pick<Plan, "role" | "code" | "decision"> & { readonly level: PlanLevel } {
  const { rc, last } = p;
  const tag = p.level?.tag;
  const jev = p.level?.jev;
  const { need, source, trigger, demand } = needOf(p, roster, signal);
  // Whichever tier answered last, the pick starts at the level the prompt needs. A tagged run is never priced.
  const { tier, decision, steppedUp, cost } = chooseModel({
    rc,
    section,
    need,
    code: source,
    last,
    promptTokens: promptTokensOf(p.text, p.now),
    compaction: p.compaction,
    figures: p.figures,
    priced: tag === undefined,
  });
  const choice = decision.ok ? decision.choice : undefined;
  // The tier's own role, whichever role the pick is in: a chain model's role is not the run's.
  const levelRole = section.levels[tier].role;
  const viaChain = choice !== undefined && choice.role !== levelRole;
  const level: PlanLevel = {
    scope: rc.scope,
    need,
    tier,
    source,
    ...(trigger === undefined ? {} : { trigger }),
    ...(demand === undefined ? {} : { demand }),
    steppedUp,
    returnedToFirst: choice !== undefined && last !== undefined && ranksBefore(rc, section, tier, choice, last.ref),
    ...(tag !== undefined || jev === undefined ? {} : { jev }),
    ...(viaChain ? { fallback: true as const } : {}),
    ...(cost === undefined ? {} : { cost }),
  };
  // The plan keeps the tier's role, so the run's first request picks among the tier's candidates again.
  return { role: choice === undefined ? undefined : levelRole, code: choice?.code ?? source, decision, level };
}

export function planUserTurn(p: PlanInput): Plan {
  const { rc } = p;
  const plan = (signal: Plan["signal"], reason: string, role: string | undefined, code: string, decision: Decision, level?: PlanLevel): Plan => ({
    virtualId: rc.virtualId,
    localOnly: rc.localOnly,
    signal,
    reason,
    role,
    code,
    decision,
    ...(level === undefined ? {} : { level }),
  });
  if (rc.localOnly) {
    const role = rc.roster.local?.role;
    if (role === undefined) return plan("local", "local-only", undefined, "local", { ok: false, attempts: [], problem: NO_LOCAL_SECTION });
    return plan("local", "local-only", role, "local", pickInRole(rc, role, { fallback: false, code: "local" }));
  }
  const { signal, reason } = classify(p.text);
  if (rc.roster.version === 2) {
    const section = scopeSection(rc.roster, rc.scope);
    if (section === undefined) return plan(signal, reason, undefined, NO_SCOPE, { ok: false, attempts: [], problem: noScopeSection(rc.scope) });
    const { role, code, decision, level } = planLevel(p, rc.roster, section, signal);
    return plan(signal, reason, role, code, decision, level);
  }
  const role = rc.roster.routing[signal];
  const code = `signal:${signal}`;
  return plan(signal, reason, role, code, pickInRole(rc, role, { fallback: true, code }));
}

/**
 * Whether the conversation, as the latest response measured it, plus the new prompt fits a model's
 * window less the compaction reserve. A model whose window is unknown fits.
 */
export function fits(p: Pick<PlanInput, "last" | "text" | "now"> & { readonly reserve: number }, model: Model<Api>): boolean {
  return fitsSize(historyOf(p.last) + promptTokensOf(p.text, p.now), p.reserve, model);
}

/** The conversation's size as the latest response measured it; 0 without one. */
function historyOf(last: LastResponder | undefined): number {
  return last?.usage === undefined ? 0 : calculateContextTokens(last.usage);
}

/** The new prompt's size, by Pi's estimate of a user message holding its text. */
function promptTokensOf(text: string, now: number): number {
  return estimateTokens({ role: "user", content: [{ type: "text", text }], timestamp: now });
}

/** Whether a conversation of `conversation` tokens fits a model's window less the reserve; a model whose window is unknown fits. */
function fitsSize(conversation: number, reserve: number, model: Model<Api>): boolean {
  if (!(model.contextWindow > 0)) return true;
  return conversation <= model.contextWindow - reserve;
}

const tokens = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Pi's compaction settings as they apply under one selection. */
export interface CompactionFigures {
  readonly enabled: boolean;
  readonly reserve: number;
  readonly keepRecent: number;
}

/**
 * Pi's compaction settings under smart-router/<id>: `compaction.enabled`, the reserve and
 * keepRecentTokens, each of the two from its `compaction.modelOverrides` entry first, as Pi reads
 * them, then the setting; each Pi's default when unset or not a whole number of tokens. Read from
 * `pi.getSettings()`.
 */
export function compactionFor(settings: unknown, id: VirtualId): CompactionFigures {
  const compaction = isRecord(settings) ? own(settings, "compaction") : undefined;
  const overrides = isRecord(compaction) ? own(compaction, "modelOverrides") : undefined;
  const override = isRecord(overrides) ? own(overrides, `${PROVIDER}/${id}`) : undefined;
  const figure = (field: "reserveTokens" | "keepRecentTokens", fallback: number): number =>
    tokens(isRecord(override) ? own(override, field) : undefined) ?? tokens(isRecord(compaction) ? own(compaction, field) : undefined) ?? fallback;
  const enabled = isRecord(compaction) ? own(compaction, "enabled") : undefined;
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_COMPACTION_SETTINGS.enabled,
    reserve: figure("reserveTokens", DEFAULT_COMPACTION_SETTINGS.reserveTokens),
    keepRecent: figure("keepRecentTokens", DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
  };
}
