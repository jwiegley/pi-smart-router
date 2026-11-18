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
//   owner continuation  previous, else the run's pick, else the last responder: that model if it
//                       resolves, else its role, else the role's fallback; with no base, the
//                       default role (the local role when local-only) and its fallback
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
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteReason, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import { isWorkCodex, subscriptionKind } from "./accounts.ts";
import type { Classification } from "./classify.ts";
import { VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { eligibleRole, NO_LOCAL_SECTION, noScopeSection, pickInRole } from "./decide.ts";
import type { Choice, Decision, LastResponder, LevelInput, Plan, PlanLevel } from "./decide.ts";
import { invariant, noBoundedHistory, unroutable } from "./errors.ts";
import type { JevOutcome } from "./jev.ts";
import { checkLocal } from "./local.ts";
import { clock, coolFrom, failureKind, holdFrom, refOf, resolveCandidate } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { autoRoles, excludedBy, excludesFor, isWorkBound, levelRoles, roleOf, scopeSection } from "./roster.ts";

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
  /**
   * The level role the session's last planned version 2 run took. While the session is on a model
   * of the scope's fallback chain, that model stands for this level: a run that starts without a
   * prompt picks in it again, and the hold rules compare with it (PlanInput.held).
   */
  levelRole: string | undefined;
  last: LastResponder | undefined;
  readonly history: HistoryEntry[];
  /** The planned version 2 run's level, until its record is written. */
  pendingLevel: PendingLevel | undefined;
  /** What an extension's resend of the same text (pi-idle-check) plans with again. */
  lastInput: LastInput | undefined;
}

export function newRecord(): SessionRecord {
  return { plan: undefined, runPick: undefined, limited: new Set(), levelRole: undefined, last: undefined, history: [], pendingLevel: undefined, lastInput: undefined };
}

/** The fork's bounded session readers. Pi 1.5.0's npm types lack them, so they are detected. */
export interface BoundedHistory {
  getLatestCustomEntry(customType: string, options?: { scope?: "all" | "active" }): unknown;
  getRecentActiveEntries(options?: { type?: string; customType?: string; messageRole?: string; limit?: number }): readonly unknown[];
}

export function boundedHistory(sessionManager: unknown): BoundedHistory | undefined {
  if (typeof sessionManager !== "object" || sessionManager === null) return undefined;
  const view = sessionManager as Partial<BoundedHistory>;
  return typeof view.getLatestCustomEntry === "function" && typeof view.getRecentActiveEntries === "function"
    ? (view as BoundedHistory)
    : undefined;
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
 * What an owner continuation without a previous model would pick now: the run's pick, else the
 * last responder, its role or that role's fallback, else the default role. No side effects; the
 * pi-cache-optimizer adapter reports it.
 */
export function predict(rc: ResolveContext, record: SessionRecord): Decision {
  return stick(rc, undefined, record);
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
 * The level a run that starts without a plan goes back to, if it does: on smart-router/auto under a
 * version 2 roster, when this is the run's first request, the model it would stay
 * on is one of the scope's fallback chain, and the session's last planned run took a level of this
 * scope. Such a run (a goal continuation, a loop's) has no prompt to plan it, and without this it
 * would stay on the chain model for as long as it kept starting runs, however long ago the level's
 * own model came back.
 */
function levelToReturnTo(rc: ResolveContext, request: ModelRouteRequest, record: SessionRecord): string | undefined {
  const { levelRole } = record;
  if (rc.roster.version !== 2 || rc.virtualId !== "auto" || rc.localOnly || record.runPick !== undefined || levelRole === undefined) return undefined;
  const section = scopeSection(rc.roster, rc.scope);
  const base = previousRef(request) ?? record.last?.ref;
  const role = base === undefined ? undefined : roleOf(rc.roster, base)?.name;
  if (section?.fallback === undefined || role === undefined || !section.fallback.includes(role)) return undefined;
  return levelRoles(section).includes(levelRole) ? levelRole : undefined;
}

/** The planned model if it still resolves, else the planned role, then its fallback. */
function fromPlan(rc: ResolveContext, plan: Plan): Decision {
  if (plan.decision.ok) {
    const again = resolveCandidate(plan.decision.choice.ref, rc);
    if (again.ok) return { ok: true, choice: { ...plan.decision.choice, model: again.model } };
  }
  if (plan.role === undefined) return plan.decision.ok ? { ok: false, attempts: [] } : plan.decision;
  return pickInRole(rc, plan.role, { fallback: !rc.localOnly, code: plan.code });
}

/**
 * How a pick's provider breaks the session's scope, if it does. A personal session never sends to a
 * work-bound account. A work session sends only to the work-bound Codex account, which only a
 * version 2 roster binds: under a version 1 roster, which serves no work scope, it sends nothing.
 * In both, a local-only request, smart-router/local's, keeps the local policy, checked after this
 * one: a local model, which has no account. prepare() already refuses smart-router/auto for a scope the roster does not
 * serve; this check holds even if that refusal is bypassed.
 */
function outsideScope(rc: ResolveContext, provider: string): string | undefined {
  const { roster } = rc;
  const local = rc.localOnly && subscriptionKind(provider) === undefined;
  if (roster.version === 1) return rc.scope === "work" && !local ? "is outside this session's work scope, which a version 1 roster does not serve" : undefined;
  if (rc.scope === "personal") return isWorkBound(roster, provider) ? "is on a work-bound account, and this session is in personal scope" : undefined;
  if (isWorkCodex(roster.accounts, provider) || local) return undefined;
  return "is not on a work-bound Codex account, and this session is in work scope";
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
  const outside = outsideScope(rc, choice.model.provider);
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
                : rc.localOnly && choice.role !== roster.local?.role
                  ? "is not in the local role"
                  : rc.localOnly && !checkLocal(choice.model, rc.policy, true).ok
                    ? "is outside the local policy"
                    : undefined;
  if (problem !== undefined) throw invariant(id, choice.ref, problem, workSession(rc));
}

/** The level a role sends: the selected one, or the role's fixed level. Pi clamps it to the model. */
export function levelFor(rc: ResolveContext, roleName: string, selected: ModelThinkingLevel): ModelThinkingLevel {
  const role = rc.roster.roles.find((entry) => entry.name === roleName);
  return role === undefined || role.thinking === "selected" ? selected : role.thinking;
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
  let decision: Decision;
  let plan: Plan | undefined;
  if (request.reason === "user") plan = takePlan(record, id, rc);
  const back = plan === undefined && request.reason !== "retry" ? levelToReturnTo(rc, request, record) : undefined;
  if (plan !== undefined) decision = fromPlan(rc, plan);
  else if (request.reason === "retry") decision = retry(rc, request, record);
  else if (back !== undefined) decision = pickInRole(rc, back, { fallback: true, code: "return:level" });
  else decision = stick(rc, previousRef(request), record);
  const choice = settle(input, decision);
  // The level a planned run took is the session's until the next planned run.
  if (plan?.level !== undefined && plan.role !== undefined) record.levelRole = plan.role;
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
  });
  return { model: choice.model, thinkingLevel: levelFor(rc, choice.role, request.thinkingLevel) };
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
  return { model: choice.model, thinkingLevel: levelFor(rc, choice.role, request.thinkingLevel) };
}
