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
// hold rules above, comparing tiers; a tagged run does neither. The tier's role takes its first
// available candidate, not the latest response's. A tier with no available candidate, or whose
// first available candidate is too small for the conversation, passes the run up to the next tier.
// When no tier's first available candidate fits, the highest tier with one takes the run, as
// version 1 would send it and Pi compacts: only a run with no available candidate at all is refused.
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";

import { classify, riskyTrigger } from "./classify.ts";
import type { RiskyTrigger, Signal } from "./classify.ts";
import { PROVIDER } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { isRecord, own } from "./files.ts";
import type { JevOutcome } from "./jev.ts";
import { resolveCandidate } from "./resolve.ts";
import type { Resolution, ResolveContext } from "./resolve.ts";
import { autoRoles, rankOf, roleOf, scopeSection } from "./roster.ts";
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
  /** Whether the role's declared fallback may take over. Never while local-only; version 2 declares none. */
  readonly fallback: boolean;
  readonly code: string;
}

/**
 * The first candidate of a role that resolves, else, when allowed, the first of the role's declared
 * fallback role: one hop, never further. Otherwise every candidate's reason. Only version 1's
 * routing table declares fallbacks.
 */
export function pickInRole(rc: ResolveContext, roleName: string, options: PickOptions): Decision {
  const attempts: Attempt[] = [];
  const firstIn = (name: string, prefer: string | undefined): (Resolution & { readonly ok: true }) | undefined => {
    const role = rc.roster.roles.find((entry) => entry.name === name);
    if (role === undefined) {
      attempts.push({ role: name, exists: false, candidates: [] });
      return undefined;
    }
    const order = prefer !== undefined && role.models.includes(prefer) ? [prefer, ...role.models.filter((ref) => ref !== prefer)] : role.models;
    const refused: Array<Resolution & { readonly ok: false }> = [];
    for (const ref of order) {
      const resolution: Resolution =
        ref === options.skip ? { ok: false, ref, reason: "failed", detail: "its request just failed" } : resolveCandidate(ref, rc);
      if (resolution.ok) return resolution;
      refused.push(resolution);
    }
    attempts.push({ role: name, exists: true, candidates: refused });
    return undefined;
  };
  const inRole = firstIn(roleName, options.prefer);
  if (inRole !== undefined) return { ok: true, choice: { role: roleName, ref: inRole.ref, model: inRole.model, code: options.code } };
  const target = options.fallback && !rc.localOnly && rc.roster.version === 1 ? rc.roster.routing.fallback.get(roleName) : undefined;
  if (target !== undefined) {
    const other = firstIn(target, undefined);
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
  /** The tier the upward pick began at: `asked` after the floor and the hold rules. */
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

/** The tier of a scope whose role holds a ref. */
function tierOf(rc: ResolveContext, section: ScopeSection, ref: string): Tier | undefined {
  const role = roleOf(rc.roster, ref)?.name;
  return role === undefined ? undefined : TIERS.find((tier) => section.levels[tier].role === role);
}

/** Whether a pick ranks before `later` among its role's candidates. */
function ranksBefore(rc: ResolveContext, choice: Choice, later: string): boolean {
  const models = rc.roster.roles.find((role) => role.name === choice.role)?.models ?? [];
  const at = models.indexOf(choice.ref);
  return at >= 0 && at < models.indexOf(later);
}

/**
 * From `start` upward, the first tier whose role's first available candidate fits the conversation;
 * when none fits, the highest tier with an available candidate. Fit alone never refuses: version 1
 * sends such a run, and Pi compacts. The start tier's pick carries `code`, a higher tier's
 * `step-up`. When no tier has an available candidate, every tier's reasons, and the start tier.
 */
function climb(p: PlanInput, section: ScopeSection, start: Tier, code: string): { readonly tier: Tier; readonly decision: Decision } {
  const attempts: Attempt[] = [];
  let highest: { readonly tier: Tier; readonly decision: Decision } | undefined;
  for (let tier: Tier | undefined = start; tier !== undefined; tier = tierAbove(tier)) {
    const decision = pickInRole(p.rc, section.levels[tier].role, { fallback: false, code: tier === start ? code : STEP_UP });
    if (!decision.ok) attempts.push(...decision.attempts);
    else if (fits(p, decision.choice.model)) return { tier, decision };
    else highest = { tier, decision };
  }
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
  let start = trigger === undefined ? asked : FLOOR;
  let code: string = source;
  const sticky = tag === undefined && last !== undefined ? tierOf(rc, section, last.ref) : undefined;
  if (last !== undefined && sticky !== undefined && tierRank(start) < tierRank(sticky)) {
    const idle = p.now - last.at >= rc.roster.stickyIdleMinutes * 60_000;
    if (!idle) {
      start = sticky;
      code = "hold:sticky";
    } else {
      const down = pickInRole(rc, section.levels[start].role, { fallback: false, code: "reopen:idle" });
      const held = down.ok && !fits(p, down.choice.model);
      if (held) start = sticky;
      code = held ? "hold:fit" : "reopen:idle";
    }
  }
  const { tier, decision } = climb(p, section, start, code);
  const choice = decision.ok ? decision.choice : undefined;
  const level: PlanLevel = {
    scope: rc.scope,
    tier,
    asked,
    start,
    source,
    ...(trigger === undefined ? {} : { trigger }),
    steppedUp: tierRank(tier) > tierRank(start),
    returnedToFirst: choice !== undefined && last !== undefined && ranksBefore(rc, choice, last.ref),
    ...(tag !== undefined || jev === undefined ? {} : { jev }),
  };
  return { role: choice?.role, code: choice?.code ?? code, decision, level };
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
