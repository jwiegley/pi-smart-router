// Route policy: the physical model one request goes to, chosen by the request's reason and by
// whose request it is.
//
// Only the owner session's own agent loop consumes a run's plan, sets the run's pick or changes
// what the latest response says: those are what pi-cache-optimizer reads through the adapter. A
// `direct` request (a compaction or branch summary, an extension's call) and a foreign loop
// request (a session that shares the runtime but has no instance of its own, such as goal-x's
// default auditor) route without changing any of them.
//
//   owner user          the run's plan (on auto, only under the roster version it was made for,
//                       and under version 2 in its scope), else as a continuation (steering,
//                       follow-ups)
//   owner run start     on smart-router/auto under a version 2 roster, a run's first request
//                       without a plan (an extension's run, which has no prompt) takes the
//                       highest level of the branch's last three prompts, else the level its
//                       session last needed, raised to the deep-session floor in a deep session,
//                       through the choice a prompt's run makes (run:need); a session that never
//                       planned a run continues as below
//   owner continuation  a stuck run (src/stuck.ts) on smart-router/auto under a version 2 roster
//                       moves up, once per run, to the level directly above's own model when it
//                       is available, never a chain's, unless its level is SUPER or its tag's
//                       (escalate); else previous, else the run's pick, else the last responder:
//                       that model if it resolves, else its role, else the role's fallback; with
//                       no base, the default role (the local role when local-only) and its fallback
//   owner retry         a usage-limit or auth failure moves to the role's next candidate, then its
//                       fallback; a local model whose server could not be reached, before any
//                       output, gives way to the candidate written after it that is not held,
//                       round its role once, then to the fallback, and keeps its model when
//                       every other is held; any other failure, content-filter refusals, rate
//                       limits and overflows included, retries the same model; no failure
//                       routes as a continuation
//   direct              previous, else the session's last responder, else the default role
//   foreign             previous, else the default role
//
// Every route ends with the same assertions, never returns router state, and keeps a short history
// of model ids and codes, never prompt text.
//
// Every route sends the thinking effort upstream's adaptive reasoning gives the request's turn type
// (src/effort.ts; John, 2026-11-18: "Exactly as upstream"), or its role's fixed level: the same
// effort the cost choice priced (effortFor).
import type { ModelRoute, ModelRouteReason, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import { isClaudeCodeProvider, isWorkCodex, subscriptionKind } from "./accounts.ts";
import type { Classification } from "./classify.ts";
import { isDeepSession } from "./demand.ts";
import type { SessionDepth } from "./demand.ts";
import { VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { chooseModel, effortFor, eligibleRole, escalationTarget, NO_LOCAL_SECTION, noScopeSection, pickInRole } from "./decide.ts";
import type { Choice, CompactionFigures, CostFigures, CostTerms, Decision, LastResponder, LevelInput, Plan, PlanLevel } from "./decide.ts";
import { turnTypeOf } from "./effort.ts";
import type { SentEffort } from "./effort.ts";
import { invariant, noBoundedHistory, unroutable } from "./errors.ts";
import type { JevOutcome } from "./jev.ts";
import { newLedger, notePlanned, notePrompt, recentNeed } from "./ledger.ts";
import type { Ledger } from "./ledger.ts";
import { checkLocal, localRoles } from "./local.ts";
import type { NeedRun } from "./records.ts";
import { clock, coolFrom, failureKind, holdFrom, inLocalRole, refOf, resolveCandidate } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { autoRoles, excludedBy, excludesFor, isWorkBound, roleOf, scopeSection } from "./roster.ts";
import type { ScopeSection } from "./roster.ts";
import { stuck } from "./stuck.ts";
import { higherTier, tierAbove, TIERS } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** The model the owner loop's last route picked in the current run. */
export interface RunPick {
  readonly id: VirtualId;
  readonly ref: string;
  readonly role: string;
}

export interface HistoryEntry {
  readonly at: number;
  readonly virtual: VirtualId;
  readonly reason: ModelRouteReason;
  readonly signal: string | undefined;
  /** What made the run's classification: a planning pattern or triage()'s reason code. */
  readonly trigger: string | undefined;
  readonly role: string;
  readonly ref: string;
  readonly code: string;
  /** A foreign request's decision: kept for /smart-router history, never published. */
  readonly foreign: boolean;
  /** A version 2 run's level, on the request that consumed its plan. Version 1 entries have none. */
  readonly level?: PlanLevel;
  /**
   * The owner loop's request continued a run under way: the run's first request is an earlier
   * entry. /smart-router status walks back over such entries to the run's first request.
   */
  readonly continuesRun?: true;
}

export const HISTORY_LIMIT = 50;

/** A version 2 run's level, kept from the input that planned it until the run's record is written. */
export interface PendingLevel {
  /** The input's token: a tagged run's opinion lands here only while the token is unchanged. */
  readonly token: number;
  /**
   * The router's keyed digest of the text, without its tag, of the message that planned the level:
   * the level belongs only to the run that message's prompt starts (src/router.ts). The router keeps
   * no prompt text, and the digest is never recorded either.
   */
  readonly digest: string;
  readonly level: PlanLevel;
  /** The keyword classifier's signal and reason for the text. */
  readonly keyword: Classification;
  /** When the run was planned. */
  readonly at: number;
  /**
   * Jev's outcome for the level: the one an untagged run waited for, or the original message's when
   * an extension's resend reused that message's level and Jev was not asked again; for a tagged run,
   * Jev's opinion, "pending" until it arrives. A resend of a tagged original carries undefined, not
   * the original's opinion. Undefined when Jev was not asked for the level.
   */
  jev: JevOutcome | "pending" | undefined;
  /**
   * Whether the level's run has started: set when a prompt's run takes its own message's level. The
   * mark goes with the level, when that run's record is written at agent_settled or the level is
   * dropped. /smart-router was corrects that run until then, whatever Pi says of the session's
   * idleness meanwhile, and never a level that no run took.
   */
  started: boolean;
}

/** The latest planned input: the router's keyed digest of its text without the tag, and the level input it planned with. */
export interface LastInput {
  readonly digest: string;
  readonly level: LevelInput;
}

/**
 * What decided a run, as status shows it: a planned run's level, or a run without a prompt's choice
 * and the level whose model took it.
 */
export type RunTerms = { readonly kind: "plan"; readonly level: PlanLevel } | { readonly kind: "need"; readonly run: NeedRun; readonly tier: Tier };

/** What a router instance keeps per session. */
export interface SessionRecord {
  plan: Plan | undefined;
  runPick: RunPick | undefined;
  /**
   * The models whose requests failed with a limit-kind error in the current run. A retry skips
   * them all, so a run tries each candidate once: local-role models are never cooled, and without
   * this a retry went back and forth between two of them.
   */
  readonly limited: Set<string>;
  /** What the session has measured: each model's cache, its runs' shape and its prompts' levels (src/ledger.ts). */
  readonly ledger: Ledger;
  /**
   * The level the session's last planned version 2 run needed: a run that starts without a prompt
   * takes it, through the same choice (run:need).
   */
  need: Tier | undefined;
  /**
   * The level whose model the run under way took, from its plan, its run:need choice or its
   * escalation; cleared when the agent settles.
   */
  runTier: Tier | undefined;
  /** Whether the run under way's level came from its message's tag: such a run is never escalated. Cleared when the agent settles. */
  runTagged: boolean;
  /** Whether the run under way has moved up once for being stuck; cleared when the agent settles. */
  escalated: boolean;
  /** The run under way's run:need choice, for its footer, when its first request had no plan; cleared when the agent settles. */
  needRun: NeedRun | undefined;
  /**
   * The terms of the latest run's choice, for /smart-router status: a planned run's level, or a run
   * without a prompt's run:need choice and the level that took it; none for a run whose first
   * request made neither. Kept when the agent settles, until the next run's first request.
   */
  runTerms: RunTerms | undefined;
  last: LastResponder | undefined;
  readonly history: HistoryEntry[];
  /** The planned version 2 run's level, until its record is written. */
  pendingLevel: PendingLevel | undefined;
  /** What an extension's resend of the same text (pi-idle-check) plans with again. */
  lastInput: LastInput | undefined;
  /** The thinking effort the owner loop's latest request carried, and why: levels and names, never text. */
  effort: SentEffort | undefined;
}

export function newRecord(): SessionRecord {
  return {
    plan: undefined,
    runPick: undefined,
    limited: new Set(),
    ledger: newLedger(),
    need: undefined,
    runTier: undefined,
    runTagged: false,
    escalated: false,
    needRun: undefined,
    runTerms: undefined,
    last: undefined,
    history: [],
    pendingLevel: undefined,
    lastInput: undefined,
    effort: undefined,
  };
}

/** The fork's bounded session readers. Pi 1.5.0's npm types lack them, so they are detected. */
export interface BoundedHistory {
  getLatestCustomEntry(customType: string, options?: { scope?: "all" | "active" }): unknown;
  getRecentActiveEntries(options?: { type?: string; customType?: string; messageRole?: string; limit?: number; stopBeforeId?: string }): readonly unknown[];
}

export function boundedHistory(sessionManager: unknown): BoundedHistory | undefined {
  if (typeof sessionManager !== "object" || sessionManager === null) return undefined;
  const view = sessionManager as Partial<BoundedHistory>;
  return typeof view.getLatestCustomEntry === "function" && typeof view.getRecentActiveEntries === "function"
    ? (view as BoundedHistory)
    : undefined;
}

/**
 * The active context's entry count from Pi's history metrics, where this Pi has them: John's Pi
 * gives `getHistoryMetrics().session_active_entries` without reading the history, counted from the
 * last compaction, an extension's own entries included. Pi 1.5.0's npm types
 * lack it, so it is detected; undefined when it is absent, throws, or gives anything but a finite
 * count of zero or more.
 */
export function activeEntries(sessionManager: unknown): number | undefined {
  if (typeof sessionManager !== "object" || sessionManager === null) return undefined;
  try {
    const { getHistoryMetrics } = sessionManager as { readonly getHistoryMetrics?: unknown };
    if (typeof getHistoryMetrics !== "function") return undefined;
    const metrics: unknown = getHistoryMetrics.call(sessionManager);
    const count = typeof metrics === "object" && metrics !== null ? (metrics as { readonly session_active_entries?: unknown }).session_active_entries : undefined;
    return typeof count === "number" && Number.isFinite(count) && count >= 0 ? count : undefined;
  } catch {
    return undefined;
  }
}

export function requireBoundedHistory(id: VirtualId, sessionManager: unknown): BoundedHistory {
  const view = boundedHistory(sessionManager);
  if (view === undefined) throw noBoundedHistory(id);
  return view;
}

/** One route call, as the router prepares it. */
export interface RouteInput {
  readonly id: VirtualId;
  readonly request: ModelRouteRequest;
  readonly rc: ResolveContext;
  readonly record: SessionRecord;
  /** What the cost rule reads of the session: its ledger and the request's own thinking level. */
  readonly figures: CostFigures | undefined;
  /** Pi's compaction settings under the selection. */
  readonly compaction: CompactionFigures;
  /** How deep the session is: a run without a prompt takes at least the deep-session floor in a deep one. */
  readonly depth: SessionDepth;
}

const previousRef = (request: ModelRouteRequest): string | undefined =>
  request.previous === undefined ? undefined : refOf(request.previous.model);

/**
 * The default role, or the local role while local-only, and its fallback when not local-only.
 * Version 2's default is the medium level of the session's scope.
 */
function byDefault(rc: ResolveContext, code: string): Decision {
  const { roster } = rc;
  const role = rc.localOnly ? roster.local?.role : roster.version === 1 ? roster.routing.default : scopeSection(roster, rc.scope)?.levels.medium.role;
  if (role === undefined) return { ok: false, attempts: [], problem: rc.localOnly ? NO_LOCAL_SECTION : noScopeSection(rc.scope) };
  return pickInRole(rc, role, { fallback: !rc.localOnly, code });
}

/** A base model that holds the conversation: itself, else its role, else that role's fallback. Pure. */
function stick(rc: ResolveContext, previous: string | undefined, record: SessionRecord): Decision {
  const run = record.runPick?.id === rc.virtualId ? record.runPick.ref : undefined;
  const bases: ReadonlyArray<readonly [string, string | undefined]> = [
    ["previous", previous],
    ["run", run],
    ["last", record.last?.ref],
  ];
  for (const [source, ref] of bases) {
    if (ref === undefined) continue;
    const role = eligibleRole(rc, ref);
    if (role === undefined) continue;
    const base = resolveCandidate(ref, rc);
    if (base.ok) return { ok: true, choice: { role, ref, model: base.model, code: `stick:${source}` } };
    // Another candidate that is not held is better than this one; failing that, this one, though
    // held, is better than any other held one: the conversation is on it.
    const other = pickInRole(rc, role, { fallback: !rc.localOnly, code: "stick:role", strictHolds: true });
    if (other.ok) return other;
    const anyway = resolveCandidate(ref, { ...rc, holds: undefined });
    if (anyway.ok) return { ok: true, choice: { role, ref, model: anyway.model, code: `stick:${source}` } };
    // The base is out for another reason, and only held candidates are left: they are tried, in the written order.
    return pickInRole(rc, role, { fallback: !rc.localOnly, code: "stick:role" });
  }
  return byDefault(rc, "stick:default");
}

/**
 * What the owner loop's next request without a previous model would pick now, as routeOwned would
 * pick it: with no run pick, on smart-router/auto under a version 2 roster, a session that has a
 * need takes the run:need choice (chooseForNeed), priced with `figures` and `compaction` and floored
 * by `depth`, and on smart-router/local with per-tier roles the tier chooseLocalForNeed gives; else the run's pick, else the last responder, its role or that role's fallback, else
 * the default role. No side effects: nothing of the record or its ledger changes. The
 * pi-cache-optimizer adapter reports it.
 */
export function predict(rc: ResolveContext, record: SessionRecord, figures: CostFigures | undefined, compaction: CompactionFigures, depth: SessionDepth): Decision {
  const section = levelSection(rc);
  const chosen = record.runPick !== undefined
    ? undefined
    : section !== undefined
      ? chooseForNeed(rc, record, section, figures, compaction, depth)
      : rc.localOnly
        ? chooseLocalForNeed(rc, record)
        : undefined;
  return chosen?.decision ?? stick(rc, undefined, record);
}

function retry(rc: ResolveContext, request: ModelRouteRequest, record: SessionRecord): Decision {
  const { failed } = request;
  if (failed === undefined) return stick(rc, previousRef(request), record);
  coolFrom(failed.message, rc.roster, rc.cooldowns, rc.now);
  const ref = refOf(failed.model);
  const role = eligibleRole(rc, ref);
  const kind = failureKind(failed.message.errorMessage);
  if (kind === "limit" && role !== undefined) {
    record.limited.add(ref);
    return pickInRole(rc, role, { skip: ref, skipped: record.limited, fallback: !rc.localOnly, code: "retry:next" });
  }
  // A local model whose server could not be reached is held, and gives way to the candidate written
  // after it that is not held. Each such retry holds one more model, so it takes a candidate not
  // yet tried: one pass over the order. When every other candidate is held too, the retry stays on
  // the model it has, below, as it always did: Pi has backed off, and a server that is restarting
  // is ridden out rather than the request refused. The pick stays where every pick of this request
  // may go: the role, then what is left of the scope's chain.
  const held = rc.holds === undefined ? undefined : holdFrom(failed.message, failed.model, rc.roster, rc.holds, rc.now);
  if (held !== undefined && role !== undefined) {
    const next = pickInRole(rc, role, { after: ref, fallback: !rc.localOnly, code: "retry:unreachable", strictHolds: true });
    if (next.ok) return next;
  }
  if (role !== undefined) {
    // Its own hold does not keep a model from its own retry.
    const same = resolveCandidate(ref, { ...rc, holds: undefined });
    if (same.ok) return { ok: true, choice: { role, ref, model: same.model, code: "retry:same" } };
  }
  // Content a model refused is never sent to another model.
  if (kind === "content-filter") {
    return { ok: false, attempts: [], problem: `${ref} refused this content and can no longer take the retry, and refused content is never sent to another model` };
  }
  return stick(rc, previousRef(request), record);
}

/** A failed response of a run's own pick, before any output: its model, and whether the account ran out or the server could not be reached. */
export interface Failover {
  readonly ref: string;
  readonly kind: "limit" | "unreachable";
}

/**
 * What would take the request if it were sent again after such a failure, as a new run's plan
 * would pick it: from `start`, the role the new run starts in (its level's, or the local role),
 * the first candidate in the written order that is neither cooling nor held, then the scope's
 * chain; held to the selection and the scope as any pick is. The failed model is cooling
 * or held by now. Nothing when only the failed model itself, or nothing, is left. Pure.
 */
export function afterFailure(rc: ResolveContext, failover: Failover, start: string | undefined): Choice | undefined {
  const role = start ?? eligibleRole(rc, failover.ref);
  if (role === undefined) return undefined;
  const decision = pickInRole(rc, role, { fallback: !rc.localOnly, code: "resend" });
  return decision.ok && decision.choice.ref !== failover.ref ? decision.choice : undefined;
}

/**
 * Whether a run's plan applies to a request as the session is now: the same model, local-only or
 * not, and on auto, the roster version it was made for: a version 1 plan has no level, and a
 * version 2 plan applies only in the scope it was made in. A local-only plan carries no account.
 * The run's first request (takePlan) and what pi-cache-optimizer is told (activeRoute) both ask.
 */
export function planApplies(plan: Plan, id: VirtualId, rc: ResolveContext): boolean {
  if (plan.virtualId !== id || plan.localOnly !== rc.localOnly) return false;
  return rc.localOnly || (rc.roster.version === 1 ? plan.level === undefined : plan.level?.scope === rc.scope);
}

/**
 * The run's plan, consumed: it is never used twice, and never where it does not apply. A plan that
 * no longer applies, because the selection, the scope or the roster's version changed after
 * its message planned, takes its level with it: the run did not go to that level, so it records none.
 */
function takePlan(record: SessionRecord, id: VirtualId, rc: ResolveContext): Plan | undefined {
  const { plan } = record;
  record.plan = undefined;
  if (plan === undefined || planApplies(plan, id, rc)) return plan;
  record.pendingLevel = undefined;
  return undefined;
}

/**
 * The scope's section where levels route: smart-router/auto under a version 2 roster, in a scope it
 * serves. Undefined on smart-router/local, under a version 1 roster, and in a scope without one.
 */
function levelSection(rc: ResolveContext): ScopeSection | undefined {
  if (rc.virtualId !== "auto" || rc.localOnly || rc.roster.version !== 2) return undefined;
  return scopeSection(rc.roster, rc.scope);
}

/** A decision that puts the run at a level: the level whose model takes it, and what the cost rule decided. */
interface Leveled {
  readonly decision: Decision;
  readonly tier: Tier;
  readonly cost?: CostTerms;
}

/**
 * A run:need choice: its level, the need it was chosen for, how many of the branch's last prompts
 * that need came from (none: the session's last need), and whether the deep-session floor raised it.
 */
interface NeedChoice extends Leveled {
  readonly need: Tier;
  readonly prompts: number | undefined;
  readonly floor: boolean;
}

/**
 * A run that starts without a prompt (an extension's own, such as a goal continuation or a loop's)
 * has no plan: it takes the highest level among the branch's last three planned prompts
 * (recentNeed; John, 2026-11-18), or with none known on the branch the level its session last
 * needed, raised to the roster's deep-session floor when the session is deep (isDeepSession: the
 * risky floor needs prompt text, so it does not apply), and goes through the choice a prompt's run
 * makes, priced with the session's figures and nothing for a prompt. The session's need itself is
 * not changed. Undefined when the session never planned a run: it continues as before.
 */
function chooseForNeed(rc: ResolveContext, record: SessionRecord, section: ScopeSection, figures: CostFigures | undefined, compaction: CompactionFigures, depth: SessionDepth): NeedChoice | undefined {
  if (record.need === undefined) return undefined;
  const recent = recentNeed(record.ledger);
  const base = recent?.need ?? record.need;
  const lowest = rc.roster.version === 2 && isDeepSession(depth) ? rc.roster.demand.deepSessionFloor : base;
  const need = higherTier(base, lowest);
  const { tier, decision, cost } = chooseModel({ rc, section, need, code: "run:need", last: record.last, promptTokens: 0, compaction, figures, priced: true });
  return { tier, decision, need, prompts: recent?.prompts, floor: need !== base, ...(cost === undefined ? {} : { cost }) };
}

/**
 * The same run on smart-router/local with per-tier local roles: it takes the tier of the branch's
 * last three planned prompts, or the one its session last needed, as chooseForNeed does, whichever
 * of the two in that order has local models; where neither has, or the session never planned a
 * run, the tier of the roster's local role, which the roster requires to be an enabled tier's. Nothing is priced, and the
 * deep-session floor is not applied: a local run costs nothing, and the floor's tier may be one the
 * roster leaves without local models. Refusing instead (as 1.4.0-jw.5 first did) stopped every run
 * an extension starts, such as a mail doorbell's or a goal continuation's.
 */
function chooseLocalForNeed(rc: ResolveContext, record: SessionRecord): (NeedChoice & { readonly localRole: boolean }) | undefined {
  const local = rc.roster.local;
  const tiers = local?.levels;
  if (local === undefined || tiers === undefined) return undefined;
  const enabled = (tier: Tier | undefined): tier is Tier => tier !== undefined && typeof tiers[tier] === "string";
  const recent = recentNeed(record.ledger);
  const known = enabled(recent?.need) ? recent?.need : enabled(record.need) ? record.need : undefined;
  const need = known ?? TIERS.find((tier) => tiers[tier] === local.role);
  const role = need === undefined ? undefined : tiers[need];
  if (need === undefined || typeof role !== "string") return undefined;
  const prompts = recent !== undefined && known === recent.need ? recent.prompts : undefined;
  return { tier: need, decision: pickInRole(rc, role, { fallback: false, code: "run:need" }), need, prompts, floor: false, localRole: known === undefined };
}

/**
 * A stuck run's move up: on a continuation of a run whose level is below SUPER and not its tag's,
 * that has not moved up yet, when its last three tool calls failed (src/stuck.ts), the level
 * directly above the run's, to that level's own model, unpriced (escalationTarget). Never a
 * fallback chain, and never a level further up. When that model is not available the run stays,
 * and a later request of the run can still move. Only a model other than the run's is a move; it
 * carries the code `escalate`.
 */
function escalation(input: RouteInput, section: ScopeSection): Leveled | undefined {
  const { request, rc, record } = input;
  const { runPick, runTier } = record;
  if (request.reason !== "continuation" || runPick?.id !== rc.virtualId || runTier === undefined || record.escalated || record.runTagged) return undefined;
  if (tierAbove(runTier) === undefined || !stuck(request.messages)) return undefined;
  const target = escalationTarget({ rc, section, from: runTier, code: "escalate", last: record.last, compaction: input.compaction });
  if (target === undefined || target.decision.choice.ref === runPick.ref) return undefined;
  return { tier: target.tier, decision: { ok: true, choice: { ...target.decision.choice, code: "escalate" } } };
}

/** The planned model if it still resolves, else the planned role, then its fallback. */
function fromPlan(rc: ResolveContext, plan: Plan): Decision {
  const tiers = rc.localOnly ? rc.roster.local?.levels : undefined;
  if (tiers !== undefined) {
    if (plan.level === undefined) return { ok: false, attempts: [], problem: "the local tier configuration changed after planning; send the prompt again" };
    const role = tiers[plan.level.need];
    if (role === null) return { ok: false, attempts: [], problem: `the local ${plan.level.need.toUpperCase()} tier has no models` };
    if (role !== plan.role || (plan.decision.ok && plan.decision.choice.role !== role)) {
      return pickInRole(rc, role, { fallback: false, code: plan.code });
    }
  }
  if (plan.decision.ok) {
    const again = resolveCandidate(plan.decision.choice.ref, rc);
    if (again.ok) return { ok: true, choice: { ...plan.decision.choice, model: again.model } };
  }
  if (plan.role === undefined) return plan.decision.ok ? { ok: false, attempts: [] } : plan.decision;
  return pickInRole(rc, plan.role, { fallback: !rc.localOnly, code: plan.code });
}

/**
 * A personal pick never uses a work-bound account. A work pick uses a work-bound Codex or Claude
 * Code account, or a model in a local role that passes the local policy. Version 1 serves no work
 * scope. Local-only picks also pass the local policy in assertSafe; prepare refuses auto for an
 * unserved scope before this independent check.
 */
function outsideScope(rc: ResolveContext, choice: Choice): string | undefined {
  const { roster } = rc;
  const provider = choice.model.provider;
  const local = subscriptionKind(provider) === undefined &&
    (rc.localOnly || (inLocalRole(roster, choice.ref) && checkLocal(choice.model, rc.policy, true).ok));
  if (roster.version === 1) return rc.scope === "work" && !local ? "is outside this session's work scope, which a version 1 roster does not serve" : undefined;
  if (rc.scope === "personal") return isWorkBound(roster, provider) ? "is on a work-bound account, and this session is in personal scope" : undefined;
  if (isWorkCodex(roster.accounts, provider) || (isClaudeCodeProvider(provider) && isWorkBound(roster, provider)) || local) return undefined;
  return "is not on a work-bound Codex or Claude Code account or an allowed local endpoint, and this session is in work scope";
}

/**
 * Whether the request's session is a work session: work scope, or a scope that cannot be read,
 * which resolves in work scope. A refusal then names only the models that keep the conversation on
 * the work account (src/errors.ts).
 */
const workSession = (rc: ResolveContext): boolean => rc.scope === "work";

/** The router's own invariants, checked on every pick before it is returned. */
export function assertSafe(id: VirtualId, rc: ResolveContext, choice: Choice): void {
  const { roster } = rc;
  const outside = outsideScope(rc, choice);
  const problem =
    excludedBy(excludesFor(roster, rc.scope, choice.ref), choice.ref) !== undefined
      ? "is excluded"
      : choice.model.api === VIRTUAL_API
        ? "is a virtual model"
        : refOf(choice.model) !== choice.ref
          ? "is not the catalog entry of that name"
          : outside !== undefined
            ? outside
            : roleOf(roster, choice.ref)?.name !== choice.role
              ? `is not in the role ${choice.role}`
              : rc.virtualId === "auto" && !autoRoles(roster, rc.scope).has(choice.role)
                ? "is in a role smart-router/auto never routes to"
                : rc.localOnly && !localRoles(roster.local).includes(choice.role)
                  ? "is not in a local role"
                  : (rc.localOnly || inLocalRole(roster, choice.ref)) && !checkLocal(choice.model, rc.policy, true).ok
                    ? "is outside the local policy"
                    : undefined;
  if (problem !== undefined) throw invariant(id, choice.ref, problem, workSession(rc));
}

/** The first cooling account that a refusal's candidates wait for, and the time it stops, as HH:MM. */
function coolingAccount(rc: ResolveContext, decision: Decision & { readonly ok: false }): { readonly provider: string; readonly until: string } | undefined {
  const refs = decision.attempts.flatMap((attempt) => attempt.candidates.map((candidate) => candidate.ref));
  const found = rc.cooldowns.accounts(rc.now).find(({ provider }) => refs.some((ref) => ref.startsWith(`${provider}/`)));
  return found === undefined ? undefined : { provider: found.provider, until: clock(found.until) };
}

function settle(input: RouteInput, decision: Decision): Choice {
  // A version 2 decision tries more than one role when its run steps up a tier, or when its scope
  // declares a fallback chain, whose roles each attempt marks as a fallback.
  if (!decision.ok) {
    throw unroutable(input.id, decision, {
      localOnly: input.rc.localOnly,
      stepUps: input.rc.roster.version === 2,
      work: workSession(input.rc),
      cooling: coolingAccount(input.rc, decision),
    });
  }
  assertSafe(input.id, input.rc, decision.choice);
  return decision.choice;
}

function remember(record: SessionRecord, entry: HistoryEntry): void {
  record.history.push(entry);
  if (record.history.length > HISTORY_LIMIT) record.history.splice(0, record.history.length - HISTORY_LIMIT);
}

/** A request of the owner session's own agent loop. */
export function routeOwned(input: RouteInput): ModelRoute {
  const { id, request, rc, record } = input;
  const starts = record.runPick === undefined;
  let decision: Decision;
  let plan: Plan | undefined;
  if (request.reason === "user") plan = takePlan(record, id, rc);
  const section = levelSection(rc);
  const unplanned = plan !== undefined || request.reason === "retry" || !starts
    ? undefined
    : section !== undefined
      ? chooseForNeed(rc, record, section, input.figures, input.compaction, input.depth)
      : rc.localOnly
        ? chooseLocalForNeed(rc, record)
        : undefined;
  const escalated = section === undefined || plan !== undefined || unplanned !== undefined ? undefined : escalation(input, section);
  if (plan !== undefined) decision = fromPlan(rc, plan);
  else if (request.reason === "retry") decision = retry(rc, request, record);
  else if (unplanned !== undefined) decision = unplanned.decision;
  else if (escalated !== undefined) decision = escalated.decision;
  else decision = stick(rc, previousRef(request), record);
  const choice = settle(input, decision);
  // A planned run's prompt: its need and the level whose model took it go in the ledger, and the
  // need is the session's until the next planned run. A run without a prompt counts as a prompt
  // that needed its run:need level (the highest of the last prompts, else the session's), raised
  // to the deep-session floor where it was, adds nothing to the last prompts, and leaves the
  // session's need as it was.
  if (plan?.level !== undefined) {
    const { need, tier, source } = plan.level;
    notePrompt(record.ledger, need, tier);
    notePlanned(record.ledger, need);
    record.need = need;
    record.runTier = tier;
    record.runTagged = source === "tag";
    record.needRun = undefined;
    record.runTerms = { kind: "plan", level: plan.level };
  } else if (unplanned !== undefined) {
    notePrompt(record.ledger, unplanned.need, unplanned.tier);
    record.runTier = unplanned.tier;
    record.runTagged = false;
    record.needRun = {
      scope: rc.scope,
      need: unplanned.need,
      ...(unplanned.prompts === undefined ? {} : { prompts: unplanned.prompts }),
      ...(unplanned.floor ? { floor: true as const } : {}),
      ...("localRole" in unplanned && unplanned.localRole ? { localRole: true as const } : {}),
      ...(unplanned.cost === undefined ? {} : { cost: unplanned.cost }),
    };
    record.runTerms = { kind: "need", run: record.needRun, tier: unplanned.tier };
  } else if (starts) {
    // A run whose first request made no choice of level shows no older run's terms.
    record.runTerms = undefined;
  }
  if (escalated !== undefined) {
    record.runTier = escalated.tier;
    record.escalated = true;
  }
  record.runPick = { id, ref: choice.ref, role: choice.role };
  remember(record, {
    at: rc.now,
    virtual: id,
    reason: request.reason,
    signal: plan?.signal,
    trigger: plan?.reason,
    role: choice.role,
    ref: choice.ref,
    code: choice.code,
    foreign: false,
    ...(plan?.level === undefined ? {} : { level: plan.level }),
    ...(starts ? {} : { continuesRun: true as const }),
  });
  // A run that moved up for being stuck is upstream's loop escalation from that request on.
  const effort = effortFor(rc, choice.role, choice.model, request.thinkingLevel, turnTypeOf(request.messages), record.escalated);
  record.effort = effort;
  return { model: choice.model, thinkingLevel: effort.level };
}

/** A `direct` request, or a loop request of a session without its own router instance. */
export function routeOther(input: RouteInput): ModelRoute {
  const { id, request, rc, record } = input;
  const direct = request.reason === "direct";
  const prefix = direct ? "direct" : "foreign";
  const bases: ReadonlyArray<readonly [string, string | undefined]> = direct
    ? [
        ["previous", previousRef(request)],
        ["last", record.last?.ref],
      ]
    : [["previous", previousRef(request)]];
  let decision: Decision | undefined;
  for (const [source, ref] of bases) {
    const role = ref === undefined ? undefined : eligibleRole(rc, ref);
    if (ref === undefined || role === undefined) continue;
    const base = resolveCandidate(ref, rc);
    if (base.ok) {
      decision = { ok: true, choice: { role, ref, model: base.model, code: `${prefix}:${source}` } };
      break;
    }
  }
  const choice = settle(input, decision ?? byDefault(rc, `${prefix}:default`));
  remember(record, {
    at: rc.now,
    virtual: id,
    reason: request.reason,
    signal: undefined,
    trigger: undefined,
    role: choice.role,
    ref: choice.ref,
    code: choice.code,
    foreign: !direct,
  });
  // Such a request belongs to no run of the owner's loop, so it is never an escalated run's.
  return { model: choice.model, thinkingLevel: effortFor(rc, choice.role, choice.model, request.thinkingLevel, turnTypeOf(request.messages), false).level };
}
