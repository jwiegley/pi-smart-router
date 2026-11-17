// Candidate availability: whether one roster ref can take a request on this host now, and if not,
// why. The checks run in a fixed order and the first failure is the reason reported:
//
//   excluded, not-in-catalog, virtual, not-available, no-credentials, account,
//   cooling-until-HH:MM, unreachable-until-HH:MM, not-routable-by-auto (smart-router/auto only),
//   not-local (local-only requests only).
//
// A version 2 roster resolves within the session's scope: the exclusions, the account bindings and
// the roles auto reaches, its levels' and its fallback chain's, are that scope's. Version 1 ignores
// the scope.
//
// Also the cooldowns: in memory, per router instance, and fed only by the owner session's own
// error responses. A usage-limit or authentication error cools its model; a content-filter
// refusal never does, and neither does any error from a local-role model. On a subscription
// provider such an error is the account's, so it cools every model of that provider at once
// (accountScoped): the four personal Codex levels share one ChatGPT account.
//
// And the holds, kept the same way but apart from the cooldowns: a local model whose server could
// not be reached, before any output, is skipped for the roster's unreachableMinutes. A hold applies
// to local-role models too, which are never cooled: a server that is down is skipped, whatever its
// role, and comes back after minutes, not after a cooldown.
import type { Api, Model } from "@earendil-works/pi-ai";

import { checkAccount, subscriptionKind } from "./accounts.ts";
import type { Labels } from "./accounts.ts";
import { PROVIDER, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { PIN_POLICY_CHANGED } from "./errors.ts";
import type { Loaded } from "./files.ts";
import { checkLocal, policyFromRoster } from "./local.ts";
import type { LocalCandidate, LocalPolicy } from "./local.ts";
import { autoRoles, excludedBy, excludesFor, parseRef, roleOf, scopeSection, unreachableMinutesOf } from "./roster.ts";
import type { Roster, Scope } from "./roster.ts";

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
  /** The models held because their servers could not be reached; without it, none is. */
  readonly holds?: Cooldowns | undefined;
  readonly now: number;
  readonly virtualId: VirtualId;
  /** smart-router/local, or a pinned session: only the local role, inside `policy`. */
  readonly localOnly: boolean;
  /** The local policy local-only requests obey: the pin's recorded one, or the roster's. */
  readonly policy: LocalPolicy;
  /** Whether `policy` is a pin's, recorded when John pinned, rather than the roster's own. */
  readonly pinned?: boolean | undefined;
  /** The session's scope, which a version 2 roster resolves within. */
  readonly scope: Scope;
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
  const pattern = excludedBy(excludesFor(rc.roster, rc.scope, ref), ref);
  if (pattern !== undefined) return refuse("excluded", `excluded by ${pattern}`);
  const parsed = parseRef(ref);
  const model = parsed === undefined ? undefined : rc.catalog.find(parsed.provider, parsed.id);
  // A catalog entry under another name would make every later check judge the wrong model.
  if (parsed === undefined || model === undefined || refOf(model) !== ref) return refuse("not-in-catalog", "not in the catalog");
  if (model.api === VIRTUAL_API) return refuse("virtual", "a virtual model");
  if (!rc.available.has(ref)) return refuse("not-available", "not among the available models");
  if (!rc.catalog.hasConfiguredAuth(model)) return refuse("no-credentials", "its provider has no credentials");
  const account = checkAccount(parsed.provider, rc.roster, rc.labels, rc.scope);
  if (!account.ok) return refuse("account", account.reason);
  if (!inLocalRole(rc.roster, ref)) {
    const until = rc.cooldowns.until(ref, rc.now);
    if (until !== undefined) {
      // A model that did not fail itself waits for its account: another model of its provider did.
      const account = rc.cooldowns.ownUntil(ref, rc.now) === undefined ? ` on its account ${parsed.provider}` : "";
      return refuse(`cooling-until-${clock(until)}`, `cooling down until ${clock(until)} after a usage-limit or authentication error${account}`);
    }
  }
  // A hold is no cooldown: it applies to local-role models too.
  const held = rc.holds?.until(ref, rc.now);
  if (held !== undefined) return refuse(`unreachable-until-${clock(held)}`, `skipped until ${clock(held)}, since its server could not be reached`);
  if (rc.virtualId === "auto") {
    const role = roleOf(rc.roster, ref);
    if (role === undefined || !autoRoles(rc.roster, rc.scope).has(role.name)) {
      const why =
        role === undefined
          ? "it is in no role"
          : rc.roster.version === 1
            ? `its role ${role.name} is neither a routing target nor a fallback`
            : `its role ${role.name} is not one of the ${rc.scope} scope's level roles${scopeSection(rc.roster, rc.scope)?.fallback === undefined ? "" : " or fallback roles"}`;
      return refuse("not-routable-by-auto", `${why}, so smart-router/auto never routes to it`);
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

/** Cooling refs, or held ones, each with the failed response that cooled or held it, so one response does so once. */
export class Cooldowns {
  readonly #entries = new Map<string, { readonly until: number; readonly stamp: number }>();
  /** Cooling accounts, by provider id: every model of the provider waits. */
  readonly #accounts = new Map<string, { readonly until: number; readonly stamp: number }>();

  /** Cool `ref` for `minutes` because of the failed response stamped `stamp`. */
  cool(ref: string, stamp: number, now: number, minutes: number): void {
    if (this.#entries.get(ref)?.stamp === stamp) return;
    this.#entries.set(ref, { until: now + minutes * 60_000, stamp });
  }

  /** Cool every model of `provider`, its account, for `minutes` because of the failed response stamped `stamp`. */
  coolAccount(provider: string, stamp: number, now: number, minutes: number): void {
    if (this.#accounts.get(provider)?.stamp === stamp) return;
    this.#accounts.set(provider, { until: now + minutes * 60_000, stamp });
  }

  /** When `ref` stops cooling for a failure of its own, whatever its account does. */
  ownUntil(ref: string, now: number): number | undefined {
    const entry = this.#entries.get(ref);
    return entry !== undefined && entry.until > now ? entry.until : undefined;
  }

  /** When `ref` stops cooling, for its own failure or its account's, whichever lasts longer; undefined when it is not cooling at `now`. */
  until(ref: string, now: number): number | undefined {
    const own = this.ownUntil(ref, now);
    const provider = parseRef(ref)?.provider;
    const account = provider === undefined ? undefined : this.#accounts.get(provider);
    const shared = account !== undefined && account.until > now ? account.until : undefined;
    return own === undefined ? shared : shared === undefined ? own : Math.max(own, shared);
  }

  /** The accounts cooling at `now`, with when each stops. */
  accounts(now: number): Array<{ readonly provider: string; readonly until: number }> {
    return [...this.#accounts].filter(([, entry]) => entry.until > now).map(([provider, entry]) => ({ provider, until: entry.until }));
  }

  /** Every ref cooling or held at `now`, in the order they were first cooled or held, with when each stops. */
  active(now: number): Array<{ readonly ref: string; readonly until: number }> {
    return [...this.#entries].filter(([, entry]) => entry.until > now).map(([ref, entry]) => ({ ref, until: entry.until }));
  }
}

export type FailureKind = "content-filter" | "limit" | "other";

// Checked first: a refusal of the content must never send the same content to another vendor.
const CONTENT_FILTER = /content[ _-]?filter|content[ _-]?policy|moderation|\bflagged\b|\bsafety\b/i;
const LIMIT_OR_AUTH =
  /usage[ _-]?limit|\bquota\b|insufficient_quota|\bbilling\b|subscription_sharing|resource[ _]?exhausted|(?<![a-z0-9])(?:401|403)(?![a-z0-9])|unauthori[sz]ed|\bforbidden\b|model_not_found|\bmodel\b[^\n]{0,200}?\bnot[ _-]?found\b/i;
/** The one limit-kind failure that is about a model, not about the account that asked for it. */
const MODEL_NOT_FOUND = /model_not_found|\bmodel\b[^\n]{0,200}?\bnot[ _-]?found\b/i;
// Error texts can carry a provider's whole response body; the kind is decided by its start.
const FAILURE_TEXT_LIMIT = 8 * 1024;

/** What a provider's error text says, in the router's terms. */
export function failureKind(text: string | undefined): FailureKind {
  const head = (text ?? "").slice(0, FAILURE_TEXT_LIMIT);
  if (CONTENT_FILTER.test(head)) return "content-filter";
  if (LIMIT_OR_AUTH.test(head)) return "limit";
  return "other";
}

/**
 * What an error text says when the model's server could not be reached at all: the connection was
 * refused or reset, the name did not resolve, the host or network was unreachable, the connection
 * or its TLS handshake did not complete, or a gateway in front of the model answered 502, 503 or
 * 504. Deliberately not here: a request that timed out or was cut off without saying how (the
 * server may be slow, or half way through an answer), 500, a rate limit, and "overloaded".
 */
const UNREACHABLE =
  /ECONNREFUSED|connection[ _-]?refused|ECONNRESET|connection[ _-]?reset|reset before headers|ENOTFOUND|EAI_AGAIN|getaddrinfo|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connect(?:ion)?[ _-]?timeout|connection[ _-]?error|network[ _-]?error|fetch failed|socket hang up|other side closed|socket connection was closed|certificate|\bCERT_|SELF_SIGNED|self[ -]signed|ERR_TLS|\b(?:TLS|SSL)\b[^\n]{0,80}?\b(?:handshake|alert|error|failed)\b|(?<![a-z0-9])(?:502|503|504)(?![a-z0-9])|bad gateway|service unavailable|gateway time-?out/i;

/** Whether an error text says that the model's server could not be reached. A content-filter refusal or a usage limit never does. */
export function isUnreachable(text: string | undefined): boolean {
  return failureKind(text) === "other" && UNREACHABLE.test((text ?? "").slice(0, FAILURE_TEXT_LIMIT));
}

/** Whether a failed response carries any output: text, thinking or a tool call that had begun to stream. */
function hasOutput(content: readonly unknown[] | undefined): boolean {
  return (content ?? []).some((block) => {
    if (typeof block !== "object" || block === null) return false;
    const { type, text, thinking } = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (type === "text") return typeof text === "string" && text !== "";
    if (type === "thinking") return typeof thinking === "string" && thinking !== "";
    return true;
  });
}

/**
 * Apply the hold rule to one failed response, and return the held ref. A model is held for the
 * roster's unreachableMinutes when all of these are so:
 *
 * - the response is a physical model's error whose text says the server could not be reached
 *   (isUnreachable);
 * - it carries no output. A failure after output has started is the stream's: it is retried on the
 *   same model, as every such failure was before holds existed, and is never sent on to another;
 * - `model`, the catalog's entry for it, is local by the roster's own local section: one of its
 *   local providers, on one of its local hosts. A cloud model's connection failure is left to Pi's
 *   backoff on the same model: a network blip should not send a conversation to another vendor.
 *
 * A local-role model is held like any other local model, though it is never cooled.
 */
export function holdFrom(
  message: FailedResponse & { readonly content?: readonly unknown[] | undefined },
  model: LocalCandidate | undefined,
  roster: Roster,
  holds: Cooldowns,
  now: number,
): string | undefined {
  if (message.stopReason !== "error" || message.provider === PROVIDER || message.api === VIRTUAL_API) return undefined;
  const ref = `${message.provider}/${message.model}`;
  if (model === undefined || `${model.provider}/${model.id}` !== ref) return undefined;
  if (!isUnreachable(message.errorMessage) || hasOutput(message.content)) return undefined;
  if (!checkLocal(model, policyFromRoster(roster), false).ok) return undefined;
  holds.cool(ref, message.timestamp, now, unreachableMinutesOf(roster));
  return ref;
}

/**
 * Whether an error text is about the account rather than the one model: a usage limit, a quota,
 * billing, or an authentication failure (the credential is the provider's). A model that is not
 * found is the model's own. The router applies this to subscription providers only (coolFrom).
 */
export function accountScoped(text: string | undefined): boolean {
  return failureKind(text) === "limit" && !MODEL_NOT_FOUND.test((text ?? "").slice(0, FAILURE_TEXT_LIMIT));
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
 *
 * When the error is the account's (accountScoped) and the provider is a subscription provider
 * (openai-codex, anthropic, github-copilot or a Multi-Pass alias of one, each of which is one
 * account behind one credential), every model of that provider is cooled with it. Other providers
 * cool the one model, as before: an error text cannot tell an account-wide limit from a limit on
 * one model, and OpenRouter has both. A provider id is one account, so the work account's cooldown
 * never touches the personal account's models, nor the other way round.
 */
export function coolFrom(message: FailedResponse, roster: Roster, cooldowns: Cooldowns, now: number): string | undefined {
  if (message.stopReason !== "error" || message.provider === PROVIDER || message.api === VIRTUAL_API) return undefined;
  const ref = `${message.provider}/${message.model}`;
  if (failureKind(message.errorMessage) !== "limit" || inLocalRole(roster, ref)) return undefined;
  cooldowns.cool(ref, message.timestamp, now, roster.cooldownMinutes);
  if (accountScoped(message.errorMessage) && subscriptionKind(message.provider) !== undefined) {
    cooldowns.coolAccount(message.provider, message.timestamp, now, roster.cooldownMinutes);
  }
  return ref;
}
