// The role decision for one run, and the in-role pick every route makes. Pure: every input is
// passed in, and nothing is read, written or remembered here.
//
// A run's role comes from the text John typed: its classification picks a role from the routing
// table. The latest response holds its role while the session is busy, so a session stays on a
// model through a stretch of work: a run that classifies lower keeps the latest response's role
// until the session has been idle for stickyIdleMinutes, and longer still when the conversation
// would not fit the lower role's window. A run that classifies higher moves up at once.
//
// Version 2 plans a tier in the session's scope instead: a trailing tag's, else Jev's, else the
// keywords'. An untagged run rises to at least high when it names a risky operation, and keeps the
// hold rules above, comparing tiers; a tagged run does neither. A hold is a preference, not a
// floor: when the held tier and every tier above it have no available candidate, the run climbs
// from its own tier instead. The tier's role takes its first available candidate, not the latest
// response's. A tier with no available candidate, or whose first available candidate is too small
// for the conversation, passes the run up to the next tier. When no tier's first available
// candidate fits, the highest tier with one takes the run, as version 1 would send it and Pi
// compacts: a run is refused only when neither its own tier nor any above it has an available one.
//
// A scope that declares a fallback chain (roster.ts) gives every tier more candidates: after the
// tier's own models, the chain's roles in the order written. A tier takes the chain before it
// passes the run up, so a run keeps its tier while any chain model can take it. A chain model holds
// no tier: the next run starts from its own tier's first candidate, and so returns to the tier's
// own model as soon as that is available again.
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";

import { classify, riskyTrigger } from "./classify.ts";
import type { RiskyTrigger, Signal } from "./classify.ts";
import { PROVIDER } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { isRecord, own } from "./files.ts";
import type { JevOutcome } from "./jev.ts";
import { HELD_REASON, resolveCandidate } from "./resolve.ts";
import type { Resolution, ResolveContext } from "./resolve.ts";
import { autoRoles, candidatesOf, fallbackAfter, rankOf, roleOf, scopeSection } from "./roster.ts";
import type { Scope, ScopeSection } from "./roster.ts";
import { keywordTier, tierAbove, tierRank, TIERS } from "./tiers.ts";
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
  /** Taken first when it is in the role and resolves: the model that holds the conversation. */
  readonly prefer?: string | undefined;
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
  const firstIn = (name: string, prefer: string | undefined, fallback: boolean): (Resolution & { readonly ok: true }) | undefined => {
    const role = rc.roster.roles.find((entry) => entry.name === name);
    if (role === undefined) {
      attempts.push({ role: name, exists: false, candidates: [], ...(fallback ? { fallback: true as const } : {}) });
      return undefined;
    }
    const at = options.after === undefined ? -1 : role.models.indexOf(options.after);
    const order =
      at >= 0
        ? [...role.models.slice(at + 1), ...role.models.slice(0, at + 1)]
        : prefer !== undefined && role.models.includes(prefer)
          ? [prefer, ...role.models.filter((ref) => ref !== prefer)]
          : role.models;
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
  const inRole = firstIn(roleName, options.prefer, false);
  if (inRole !== undefined) return { ok: true, choice: { role: roleName, ref: inRole.ref, model: inRole.model, code: options.code } };
  for (const target of options.fallback ? fallbackRoles(rc, roleName) : []) {
    const other = firstIn(target, undefined, true);
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

/** What decided a version 2 run's tier: a tag, Jev, the keywords, or the risky-operations floor. */
export type LevelSource = "tag" | "jev" | "keyword" | "floor";

/** Why a version 2 run on auto went to its tier. Never prompt text. */
export interface PlanLevel {
  readonly scope: Scope;
  /** The tier whose role the plan picked in; when it picked none, `start`. */
  readonly tier: Tier;
  /** The tier the tag, Jev or the keywords asked for, before the floor, the hold rules and any step-up. */
  readonly asked: Tier;
  /**
   * The tier the upward pick began at: `asked` after the floor and the hold rules. A hold whose tier
   * and every tier above it had no available candidate gives way, and the pick began at `asked` after
   * the floor alone.
   */
  readonly start: Tier;
  readonly source: LevelSource;
  /** The risky operation that raised the run to the floor. */
  readonly trigger?: RiskyTrigger;
  /**
   * Whether `tier` ranks above `start`: each tier from `start` below it had no available candidate,
   * or its first available candidate was too small for the conversation.
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
   * The history code of the decision: `signal:*`, `hold:sticky`, `hold:fit`, `reopen:idle` or
   * `local`. A version 2 run on auto has its level's source (`tag`, `jev`, `keyword` or `floor`) or
   * a hold code, `step-up` when its pick moved up a tier, or `no-scope` when the roster does not
   * serve the session's scope.
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
  /** The compaction reserve Pi applies under the selection (see `reserveFor`). */
  readonly reserve: number;
  /** A version 2 run's tag and Jev outcome; version 1 and local-only runs ignore it. */
  readonly level?: LevelInput;
  /**
   * The level role the session's last planned run took. A chain model stands for that level: while
   * the latest response is a chain model's, the hold rules compare with it, so that a session at
   * SUPER whose account ran out is still at SUPER when the account is back.
   */
  readonly held?: string | undefined;
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

/** The tier an untagged run that names a risky operation rises to, at least. */
const FLOOR: Tier = "high";
const STEP_UP = "step-up";
const NO_SCOPE = "no-scope";

/**
 * The tier of a scope whose role holds a ref; for a model of the scope's fallback chain, the tier of
 * `held`, the level role the session's last planned run took, when that is a level of the scope.
 */
function tierOf(rc: ResolveContext, section: ScopeSection, ref: string, held?: string): Tier | undefined {
  const role = roleOf(rc.roster, ref)?.name;
  if (role === undefined) return undefined;
  const standsFor = section.fallback?.includes(role) === true ? held : role;
  return TIERS.find((tier) => section.levels[tier].role === standsFor);
}

/** Whether a pick ranks before `later` among a tier's candidates: its role's own models, then the scope's chain. */
function ranksBefore(rc: ResolveContext, section: ScopeSection, tier: Tier, choice: Choice, later: string): boolean {
  const refs = candidatesOf(rc.roster, rc.scope, section.levels[tier].role).map((candidate) => candidate.ref);
  const at = refs.indexOf(choice.ref);
  return at >= 0 && at < refs.indexOf(later);
}

/**
 * From `start` upward, the first tier whose first available candidate fits the conversation; when
 * none fits, the highest tier with an available candidate. A tier's candidates are its role's own
 * models and then the scope's fallback chain, so a tier takes the chain before it passes the run up.
 * Fit alone never refuses: version 1 sends such a run, and Pi compacts. The start tier's pick
 * carries `code`, a higher tier's `step-up`, and a chain model's names the roles. When no tier has
 * an available candidate, every role's reasons, each role once, and the start tier.
 */
function climb(p: PlanInput, section: ScopeSection, start: Tier, code: string): { readonly tier: Tier; readonly decision: Decision } {
  const attempts: Attempt[] = [];
  let first: { readonly tier: Tier; readonly decision: Decision & { readonly ok: true } } | undefined;
  let highest: { readonly tier: Tier; readonly decision: Decision & { readonly ok: true } } | undefined;
  for (let tier: Tier | undefined = start; tier !== undefined; tier = tierAbove(tier)) {
    const decision = pickInRole(p.rc, section.levels[tier].role, { fallback: true, code: tier === start ? code : STEP_UP });
    // Every tier shares the scope's chain, so its roles' reasons are listed with the first tier's only.
    if (!decision.ok) attempts.push(...decision.attempts.filter((attempt) => !attempts.some((seen) => seen.role === attempt.role)));
    else if (fits(p, decision.choice.model)) return { tier, decision };
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

/** A version 2 run on auto, in a scope the roster serves. A refusal keeps no role, so the run's request does not pick in one again. */
function planLevel(p: PlanInput, section: ScopeSection, signal: Signal): Pick<Plan, "role" | "code" | "decision"> & { readonly level: PlanLevel } {
  const { rc, last } = p;
  const tag = p.level?.tag;
  const jev = p.level?.jev;
  const [asked, given]: readonly [Tier, LevelSource] =
    tag !== undefined ? [tag, "tag"] : jev?.kind === "answer" ? [jev.tier, "jev"] : [keywordTier(signal), "keyword"];
  const risky = tag === undefined ? riskyTrigger(p.text) : undefined;
  const trigger = risky !== undefined && tierRank(asked) < tierRank(FLOOR) ? risky : undefined;
  const source: LevelSource = trigger === undefined ? given : "floor";
  // The run's own tier: the one it asked for, or the floor.
  const own = trigger === undefined ? asked : FLOOR;
  let start = own;
  let code: string = source;
  const sticky = tag === undefined && last !== undefined ? tierOf(rc, section, last.ref, p.held) : undefined;
  if (last !== undefined && sticky !== undefined && tierRank(start) < tierRank(sticky)) {
    const idle = p.now - last.at >= rc.roster.stickyIdleMinutes * 60_000;
    if (!idle) {
      start = sticky;
      code = "hold:sticky";
    } else {
      const down = pickInRole(rc, section.levels[start].role, { fallback: true, code: "reopen:idle" });
      const held = down.ok && !fits(p, down.choice.model);
      if (held) start = sticky;
      code = held ? "hold:fit" : "reopen:idle";
    }
  }
  let planned = climb(p, section, start, code);
  // A hold is a preference, not a floor: when the held tier and every tier above it have no
  // available candidate, the run climbs again from its own tier.
  if (!planned.decision.ok && start !== own) {
    start = own;
    code = source;
    planned = climb(p, section, start, code);
  }
  const { tier, decision } = planned;
  const choice = decision.ok ? decision.choice : undefined;
  // The tier's own role, whichever role the pick is in: a chain model's role is not the run's.
  const levelRole = section.levels[tier].role;
  const viaChain = choice !== undefined && choice.role !== levelRole;
  const level: PlanLevel = {
    scope: rc.scope,
    tier,
    asked,
    start,
    source,
    ...(trigger === undefined ? {} : { trigger }),
    steppedUp: tierRank(tier) > tierRank(start),
    returnedToFirst: choice !== undefined && last !== undefined && ranksBefore(rc, section, tier, choice, last.ref),
    ...(tag !== undefined || jev === undefined ? {} : { jev }),
    ...(viaChain ? { fallback: true as const } : {}),
  };
  // The plan keeps the tier's role, so the run's first request picks among the tier's candidates again.
  return { role: choice === undefined ? undefined : levelRole, code: choice?.code ?? code, decision, level };
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
    const { role, code, decision, level } = planLevel(p, section, signal);
    return plan(signal, reason, role, code, decision, level);
  }
  const target = rc.roster.routing[signal];
  const sticky = p.last === undefined ? undefined : eligibleRole(rc, p.last.ref);
  let role = target;
  let code = `signal:${signal}`;
  if (p.last !== undefined && sticky !== undefined && sticky !== target && rankOf(rc.roster, target) < rankOf(rc.roster, sticky)) {
    const idle = p.now - p.last.at >= rc.roster.stickyIdleMinutes * 60_000;
    if (!idle) {
      role = sticky;
      code = "hold:sticky";
    } else {
      const down = pickInRole(rc, target, { fallback: true, code: "reopen:idle" });
      if (!down.ok || fits(p, down.choice.model)) return plan(signal, reason, target, "reopen:idle", down);
      role = sticky;
      code = "hold:fit";
    }
  }
  const prefer = role === sticky ? p.last?.ref : undefined;
  return plan(signal, reason, role, code, pickInRole(rc, role, { prefer, fallback: true, code }));
}

/**
 * Whether the conversation, as the latest response measured it, plus the new prompt fits a model's
 * window less the compaction reserve. A model whose window is unknown fits.
 */
export function fits(p: Pick<PlanInput, "last" | "text" | "now" | "reserve">, model: Model<Api>): boolean {
  if (!(model.contextWindow > 0)) return true;
  const history = p.last?.usage === undefined ? 0 : calculateContextTokens(p.last.usage);
  const prompt = estimateTokens({ role: "user", content: [{ type: "text", text: p.text }], timestamp: p.now });
  return history + prompt <= model.contextWindow - p.reserve;
}

const tokens = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * The compaction reserve Pi applies under `smart-router/<id>`: its `compaction.modelOverrides`
 * entry, else `compaction.reserveTokens`, else Pi's default. Read from `pi.getSettings()`.
 */
export function reserveFor(settings: unknown, id: VirtualId): number {
  const compaction = isRecord(settings) ? own(settings, "compaction") : undefined;
  const overrides = isRecord(compaction) ? own(compaction, "modelOverrides") : undefined;
  const override = isRecord(overrides) ? own(overrides, `${PROVIDER}/${id}`) : undefined;
  return (
    tokens(isRecord(override) ? own(override, "reserveTokens") : undefined) ??
    tokens(isRecord(compaction) ? own(compaction, "reserveTokens") : undefined) ??
    DEFAULT_COMPACTION_SETTINGS.reserveTokens
  );
}
