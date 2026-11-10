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
//                       fallback; any other failure, content-filter refusals and overflows
//                       included, retries the same model; no failure routes as a continuation
//   direct              previous, else the session's last responder, else the default role
//   foreign             previous, else the default role
//
// Every route ends with the same assertions, never returns router state, and keeps a short history
// of model ids and codes, never prompt text.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute, ModelRouteReason, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import { isCodexProvider, subscriptionKind } from "./accounts.ts";
import type { Classification } from "./classify.ts";
import { VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { eligibleRole, NO_LOCAL_SECTION, noScopeSection, pickInRole } from "./decide.ts";
import type { Choice, Decision, LastResponder, LevelInput, Plan, PlanLevel } from "./decide.ts";
import { invariant, noBoundedHistory, unroutable } from "./errors.ts";
import type { JevOutcome } from "./jev.ts";
import { checkLocal } from "./local.ts";
import type { LocalPolicy } from "./local.ts";
import { coolFrom, failureKind, refOf, resolveCandidate } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { autoRoles, excludedBy, excludesFor, isWorkBound, roleOf, scopeSection } from "./roster.ts";

/** A session's pin as routing sees it. */
export interface Pin {
  readonly on: boolean;
  /** The policy local-only routing obeys while pinned. */
  readonly policy: LocalPolicy;
}

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

/**
 * A version 2 run's level, kept from the input that planned it until the run's record is written.
 * Never prompt text.
 */
export interface PendingLevel {
  /** The input's token: a tagged run's opinion lands here only while the token is unchanged. */
  readonly token: number;
  readonly level: PlanLevel;
  /** The keyword classifier's signal and reason for the text. */
  readonly keyword: Classification;
  /** When the run was planned. */
  readonly at: number;
  /**
   * Jev's outcome: the one an untagged run waited for, or a tagged run's opinion, "pending" until it
   * arrives; undefined when Jev was not asked.
   */
  jev: JevOutcome | "pending" | undefined;
}

/** The latest planned input: its text without the tag, and the level input it planned with. */
export interface LastInput {
  readonly text: string;
  readonly level: LevelInput;
}

/** What a router instance keeps per session. */
export interface SessionRecord {
  plan: Plan | undefined;
  runPick: RunPick | undefined;
  last: LastResponder | undefined;
  readonly history: HistoryEntry[];
  /** The planned version 2 run's level, until its record is written. */
  pendingLevel: PendingLevel | undefined;
  /** What an extension's resend of the same text (pi-idle-check) plans with again. */
  lastInput: LastInput | undefined;
}

export function newRecord(): SessionRecord {
  return { plan: undefined, runPick: undefined, last: undefined, history: [], pendingLevel: undefined, lastInput: undefined };
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
  readonly pin: Pin;
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
  if (kind === "limit" && role !== undefined) return pickInRole(rc, role, { skip: ref, fallback: !rc.localOnly, code: "retry:next" });
  if (role !== undefined) {
    const same = resolveCandidate(ref, rc);
    if (same.ok) return { ok: true, choice: { role, ref, model: same.model, code: "retry:same" } };
  }
  // Content a model refused is never sent to another model.
  if (kind === "content-filter") {
    return { ok: false, attempts: [], problem: `${ref} refused this content and can no longer take the retry, and refused content is never sent to another model` };
  }
  return stick(rc, previousRef(request), record);
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

/** The run's plan, consumed: it is never used twice, and never where it does not apply. */
function takePlan(record: SessionRecord, id: VirtualId, rc: ResolveContext): Plan | undefined {
  const { plan } = record;
  record.plan = undefined;
  return plan !== undefined && planApplies(plan, id, rc) ? plan : undefined;
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
 * In both, a local-only request keeps the pin's rules, checked after this one: a local model, which
 * has no account. prepare() already refuses smart-router/auto for a scope the roster does not
 * serve; this check holds even if that refusal is bypassed.
 */
function outsideScope(rc: ResolveContext, provider: string): string | undefined {
  const { roster } = rc;
  const local = rc.localOnly && subscriptionKind(provider) === undefined;
  if (roster.version === 1) return rc.scope === "work" && !local ? "is outside this session's work scope, which a version 1 roster does not serve" : undefined;
  const workBound = isWorkBound(roster, provider);
  if (rc.scope === "personal") return workBound ? "is on a work-bound account, and this session is in personal scope" : undefined;
  if ((workBound && isCodexProvider(provider)) || local) return undefined;
  return "is not on a work-bound Codex account, and this session is in work scope";
}

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
  if (problem !== undefined) throw invariant(id, choice.ref, problem);
}

/** The level a role sends: the selected one, or the role's fixed level. Pi clamps it to the model. */
export function levelFor(rc: ResolveContext, roleName: string, selected: ModelThinkingLevel): ModelThinkingLevel {
  const role = rc.roster.roles.find((entry) => entry.name === roleName);
  return role === undefined || role.thinking === "selected" ? selected : role.thinking;
}

function settle(input: RouteInput, decision: Decision): Choice {
  // A version 2 decision tries more than one role only when its run steps up a tier.
  if (!decision.ok) throw unroutable(input.id, decision, { localOnly: input.rc.localOnly, pinned: input.pin.on, stepUps: input.rc.roster.version === 2 });
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
  if (request.reason === "user") {
    plan = takePlan(record, id, rc);
    decision = plan === undefined ? stick(rc, previousRef(request), record) : fromPlan(rc, plan);
  } else if (request.reason === "retry") {
    decision = retry(rc, request, record);
  } else {
    decision = stick(rc, previousRef(request), record);
  }
  const choice = settle(input, decision);
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
