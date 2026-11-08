// Candidate availability: whether one roster ref can take a request on this host now, and if not,
// why. The checks run in a fixed order and the first failure is the reason reported:
//
//   excluded, not-in-catalog, virtual, not-available, no-credentials, account,
//   cooling-until-HH:MM, not-routable-by-auto (smart-router/auto only),
//   not-local (local-only requests only).
//
// Also the cooldowns: in memory, per router instance, and fed only by the owner session's own
// error responses. A usage-limit or authentication error cools its model; a content-filter
// refusal never does, and neither does any error from a local-role model.
import type { Api, Model } from "@earendil-works/pi-ai";

import { checkAccount } from "./accounts.ts";
import type { Labels } from "./accounts.ts";
import { BUILTIN_EXCLUDES, PROVIDER, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { PIN_POLICY_CHANGED } from "./errors.ts";
import type { Loaded } from "./files.ts";
import { checkLocal, policyFromRoster } from "./local.ts";
import type { LocalPolicy } from "./local.ts";
import { autoRoles, excludedBy, parseRef, roleOf } from "./roster.ts";
import type { Roster } from "./roster.ts";

/** The catalog reads the resolver makes. Pi's ModelRegistry (`ctx.modelRegistry`) has them. */
export interface Catalog {
  find(provider: string, id: string): Model<Api> | undefined;
  getAvailable(): readonly Model<Api>[];
  hasConfiguredAuth(model: Model<Api>): boolean;
}

export type Resolution =
  | { readonly ok: true; readonly ref: string; readonly model: Model<Api> }
  | {
      readonly ok: false;
      readonly ref: string;
      /** The reason code, as status and the history show it: `not-local`, `cooling-until-14:05`. */
      readonly reason: string;
      /** The same in words, for refusals. */
      readonly detail: string;
    };

/** Everything one route call resolves against. Build it with `resolveContext`, once per call. */
export interface ResolveContext {
  readonly roster: Roster;
  readonly catalog: Catalog;
  /** The refs `getAvailable()` lists, collected once per call. */
  readonly available: ReadonlySet<string>;
  /** Multi-Pass's labels; undefined when the roster binds no alias. */
  readonly labels: Loaded<Labels> | undefined;
  readonly cooldowns: Cooldowns;
  readonly now: number;
  readonly virtualId: VirtualId;
  /** smart-router/local, or a pinned session: only the local role, inside `policy`. */
  readonly localOnly: boolean;
  /** The local policy local-only requests obey: the pin's recorded one, or the roster's. */
  readonly policy: LocalPolicy;
  /** Whether `policy` is a pin's, recorded when John pinned, rather than the roster's own. */
  readonly pinned?: boolean | undefined;
}

export const refOf = (model: { readonly provider: string; readonly id: string }): string => `${model.provider}/${model.id}`;

export function resolveContext(input: Omit<ResolveContext, "available">): ResolveContext {
  return { ...input, available: new Set(input.catalog.getAvailable().map(refOf)) };
}

/** Local time as HH:MM. */
export function clock(ms: number): string {
  const time = new Date(ms);
  return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
}

/** Whether a ref belongs to the roster's local role, whose models are never cooled. */
export function inLocalRole(roster: Roster, ref: string): boolean {
  return roster.local !== undefined && roleOf(roster, ref)?.name === roster.local.role;
}

export function resolveCandidate(ref: string, rc: ResolveContext): Resolution {
  const refuse = (reason: string, detail: string): Resolution => ({ ok: false, ref, reason, detail });
  const pattern = excludedBy([...BUILTIN_EXCLUDES, ...rc.roster.exclude], ref);
  if (pattern !== undefined) return refuse("excluded", `excluded by ${pattern}`);
  const parsed = parseRef(ref);
  const model = parsed === undefined ? undefined : rc.catalog.find(parsed.provider, parsed.id);
  // A catalog entry under another name would make every later check judge the wrong model.
  if (parsed === undefined || model === undefined || refOf(model) !== ref) return refuse("not-in-catalog", "not in the catalog");
  if (model.api === VIRTUAL_API) return refuse("virtual", "a virtual model");
  if (!rc.available.has(ref)) return refuse("not-available", "not among the available models");
  if (!rc.catalog.hasConfiguredAuth(model)) return refuse("no-credentials", "its provider has no credentials");
  const account = checkAccount(parsed.provider, rc.roster, rc.labels);
  if (!account.ok) return refuse("account", account.reason);
  if (!inLocalRole(rc.roster, ref)) {
    const until = rc.cooldowns.until(ref, rc.now);
    if (until !== undefined) {
      return refuse(`cooling-until-${clock(until)}`, `cooling down until ${clock(until)} after a usage-limit or authentication error`);
    }
  }
  if (rc.virtualId === "auto") {
    const role = roleOf(rc.roster, ref);
    if (role === undefined || !autoRoles(rc.roster).has(role.name)) {
      return refuse("not-routable-by-auto", `${role === undefined ? "it is in no role" : `its role ${role.name} is neither a routing target nor a fallback`}, so smart-router/auto never routes to it`);
    }
  }
  if (rc.localOnly) {
    const local = checkLocal(model, rc.policy, true);
    if (!local.ok) {
      // A pinned session keeps the policy it was pinned under: a roster edit cannot widen it.
      const widened = rc.pinned === true && checkLocal(model, policyFromRoster(rc.roster), true).ok;
      return refuse("not-local", widened ? PIN_POLICY_CHANGED : local.reason);
    }
  }
  return { ok: true, ref, model };
}

// ─── Cooldowns ───────────────────────────────────────────────────────────────

/** Cooling refs, each with the failed response that cooled it, so one response cools once. */
export class Cooldowns {
  readonly #entries = new Map<string, { readonly until: number; readonly stamp: number }>();

  /** Cool `ref` for `minutes` because of the failed response stamped `stamp`. */
  cool(ref: string, stamp: number, now: number, minutes: number): void {
    if (this.#entries.get(ref)?.stamp === stamp) return;
    this.#entries.set(ref, { until: now + minutes * 60_000, stamp });
  }

  /** When `ref` stops cooling, or undefined when it is not cooling at `now`. */
  until(ref: string, now: number): number | undefined {
    const entry = this.#entries.get(ref);
    return entry !== undefined && entry.until > now ? entry.until : undefined;
  }
}

export type FailureKind = "content-filter" | "limit" | "other";

// Checked first: a refusal of the content must never send the same content to another vendor.
const CONTENT_FILTER = /content[ _-]?filter|content[ _-]?policy|moderation|\bflagged\b|\bsafety\b/i;
const LIMIT_OR_AUTH =
  /usage[ _-]?limit|\bquota\b|insufficient_quota|\bbilling\b|subscription_sharing|resource[ _]?exhausted|(?<![a-z0-9])(?:401|403)(?![a-z0-9])|unauthori[sz]ed|\bforbidden\b|model_not_found|\bmodel\b[^\n]{0,200}?\bnot[ _-]?found\b/i;
// Error texts can carry a provider's whole response body; the kind is decided by its start.
const FAILURE_TEXT_LIMIT = 8 * 1024;

/** What a provider's error text says, in the router's terms. */
export function failureKind(text: string | undefined): FailureKind {
  const head = (text ?? "").slice(0, FAILURE_TEXT_LIMIT);
  if (CONTENT_FILTER.test(head)) return "content-filter";
  if (LIMIT_OR_AUTH.test(head)) return "limit";
  return "other";
}

/** The parts of a failed assistant response the cooldown rules read. */
export interface FailedResponse {
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly stopReason: string;
  readonly errorMessage?: string | undefined;
  readonly timestamp: number;
}

/**
 * Apply the cooldown rules to one failed response: a physical model's usage-limit or
 * authentication error cools it for the roster's cooldownMinutes. A router refusal (it names the
 * virtual model), a content-filter refusal and any local-role model are never cooled. Returns the
 * cooled ref.
 */
export function coolFrom(message: FailedResponse, roster: Roster, cooldowns: Cooldowns, now: number): string | undefined {
  if (message.stopReason !== "error" || message.provider === PROVIDER || message.api === VIRTUAL_API) return undefined;
  const ref = `${message.provider}/${message.model}`;
  if (failureKind(message.errorMessage) !== "limit" || inLocalRole(roster, ref)) return undefined;
  cooldowns.cool(ref, message.timestamp, now, roster.cooldownMinutes);
  return ref;
}
