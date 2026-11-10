// The role decision for one run, and the in-role pick every route makes. Pure: every input is
// passed in, and nothing is read, written or remembered here.
//
// A run's role comes from the text John typed: its classification picks a role from the routing
// table. The latest response holds its role while the session is busy, so a session stays on a
// model through a stretch of work: a run that classifies lower keeps the latest response's role
// until the session has been idle for stickyIdleMinutes, and longer still when the conversation
// would not fit the lower role's window. A run that classifies higher moves up at once.
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, DEFAULT_COMPACTION_SETTINGS, estimateTokens } from "@earendil-works/pi-coding-agent";

import { classify } from "./classify.ts";
import type { Signal } from "./classify.ts";
import { PROVIDER } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { isRecord, own } from "./files.ts";
import { resolveCandidate } from "./resolve.ts";
import type { Resolution, ResolveContext } from "./resolve.ts";
import { autoRoles, rankOf, roleOf } from "./roster.ts";
import type { Scope } from "./roster.ts";

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
   * The history code of the decision: `signal:*`, `hold:sticky`, `hold:fit`, `reopen:idle`, `local`,
   * or `v2-unplanned` for a version 2 roster's run on auto, which this planner refuses.
   */
  readonly code: string;
  /** The model the decision picked when it was made, or why there was none. */
  readonly decision: Decision;
}

export interface PlanInput {
  readonly rc: ResolveContext;
  /** The text John typed. */
  readonly text: string;
  readonly last: LastResponder | undefined;
  readonly now: number;
  /** The compaction reserve Pi applies under the selection (see `reserveFor`). */
  readonly reserve: number;
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

const V2_UNPLANNED = "version 2 planning is not built yet";

export function planUserTurn(p: PlanInput): Plan {
  const { rc } = p;
  const plan = (signal: Plan["signal"], reason: string, role: string | undefined, code: string, decision: Decision): Plan => ({
    virtualId: rc.virtualId,
    localOnly: rc.localOnly,
    signal,
    reason,
    role,
    code,
    decision,
  });
  if (rc.localOnly) {
    const role = rc.roster.local?.role;
    if (role === undefined) return plan("local", "local-only", undefined, "local", { ok: false, attempts: [], problem: NO_LOCAL_SECTION });
    return plan("local", "local-only", role, "local", pickInRole(rc, role, { fallback: false, code: "local" }));
  }
  const { signal, reason } = classify(p.text);
  if (rc.roster.version === 2) return plan(signal, reason, undefined, "v2-unplanned", { ok: false, attempts: [], problem: V2_UNPLANNED });
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
