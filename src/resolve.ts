// Candidate availability: whether one roster ref can take a request on this host now, and if not,
// why. The checks run in a fixed order and the first failure is the reason reported:
//
//   excluded, not-in-catalog, virtual, not-available, no-credentials, account,
//   cooling-until-HH:MM, a hold (unreachable-until-HH:MM, lifted when nothing else resolves),
//   not-routable-by-auto (smart-router/auto only),
//   not-local (local-only requests and any candidate in a local role).
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
// not be reached, before any output, is passed over for the roster's unreachableMinutes. A hold
// applies to local-role models, which are never cooled. Unlike a cooldown it is a preference: when
// no candidate of a pick can take a request for any other reason, the held ones are tried again in
// the written order, so a hold never refuses a request, and an answer from a held model lifts it.
//
// Cooldowns and holds are per router instance, which is per session: another session finds an
// exhausted account or a dead server out for itself, with one failed request.
import type { Api, Model } from "@earendil-works/pi-ai";

import { checkAccount, subscriptionKind } from "./accounts.ts";
import type { Labels } from "./accounts.ts";
import { PROVIDER, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import type { Loaded } from "./files.ts";
import { checkLocal, localRoles, policyFromRoster } from "./local.ts";
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
  /** The models held for a few minutes (holdFrom); without it, none is, which is how a held model is tried after all. */
  readonly holds?: Holds | undefined;
  readonly now: number;
  readonly virtualId: VirtualId;
  /** smart-router/local: only the local role, inside `policy`. */
  readonly localOnly: boolean;
  /** The local policy local-only requests obey: the roster's (policyFromRoster). */
  readonly policy: LocalPolicy;
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
  const role = roleOf(roster, ref)?.name;
  return role !== undefined && localRoles(roster.local).includes(role);
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
  if (held !== undefined) {
    const { reason, detail } = describeHold({ until: held });
    return refuse(reason, detail);
  }
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
  if (rc.localOnly || inLocalRole(rc.roster, ref)) {
    const local = checkLocal(model, rc.policy, true);
    if (!local.ok) return refuse("not-local", local.reason);
  }
  return { ok: true, ref, model };
}

// ─── Cooldowns ───────────────────────────────────────────────────────────────

/** Cooling refs, each with the failed response that cooled it, so one response cools once. */
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
}

export type FailureKind = "content-filter" | "limit" | "other";

// Checked first: a refusal of the content must never send the same content to another vendor.
const CONTENT_FILTER = /content[ _-]?filter|content[ _-]?policy|moderation|\bflagged\b|\bsafety\b/i;
// The limit kind has three parts, told apart because they are not about the same thing.
/** About the account: a usage limit, a quota, billing, or a credential that was not accepted. */
const ACCOUNT_LIMIT =
  /usage[ _-]?limit|\bquota\b|insufficient_quota|\bbilling\b|subscription_sharing|resource[ _]?exhausted|(?<![a-z0-9])401(?![a-z0-9])|unauthori[sz]ed|authentication[ _]error|invalid[ _]api[ _]key|incorrect api key/i;
/** About the account's money: prepaid credit that has run out, as OpenRouter reports it (402). */
const CREDIT_LIMIT = /(?<![a-z0-9])402(?![a-z0-9])|payment[ _-]?required|insufficient[ _-]?credits?|out of credits?|requires? more credits|credit balance/i;
/** About the one model: it is not there, or this account may not use it (403). */
const MODEL_LIMIT = /(?<![a-z0-9])403(?![a-z0-9])|\bforbidden\b|model_not_found|\bmodel\b[^\n]{0,200}?\bnot[ _-]?found\b/i;
// Whether the account is cooled is decided by narrower forms of the first two: an account error's
// own words, or its status where an error text begins, so that a number or a word inside an
// unrelated error body (a tool result quoted back, a token count) cools no account.
const ACCOUNT_ERROR =
  /usage[ _-]?limit|insufficient_quota|quota exceeded|exceeded (?:your |the )?(?:current )?quota|billing (?:details|hard limit|(?:is )?not active)|subscription_sharing|resource[ _]?exhausted|^\s*(?:HTTP |error:? ?|status(?: code)?:? ?)?401\b|\b401 unauthori[sz]ed|\bstatus(?: code)?:? ?401\b|^\s*unauthori[sz]ed\b|\bunauthori[sz]ed(?: access| request|[:.]|$)|authentication[ _]error|invalid[ _]api[ _]key|incorrect api key/i;
const CREDIT_ERROR = /^\s*(?:HTTP |error:? ?|status(?: code)?:? ?)?402\b|\b402 payment required|payment[ _]required|insufficient[ _-]?credits?|out of credits?|requires? more credits|credit balance/i;
// Error texts can carry a provider's whole response body; the kind is decided by its start.
const FAILURE_TEXT_LIMIT = 8 * 1024;

const headOf = (text: string | undefined): string => (text ?? "").slice(0, FAILURE_TEXT_LIMIT);

/** What a provider's error text says, in the router's terms. */
export function failureKind(text: string | undefined): FailureKind {
  const head = headOf(text);
  if (CONTENT_FILTER.test(head)) return "content-filter";
  if (ACCOUNT_LIMIT.test(head) || CREDIT_LIMIT.test(head) || MODEL_LIMIT.test(head)) return "limit";
  return "other";
}

/** Whether a limit-kind error text is about spent credit, which is an account's whatever the provider. */
export function creditScoped(text: string | undefined): boolean {
  return failureKind(text) === "limit" && CREDIT_ERROR.test(headOf(text));
}

/**
 * Whether a limit-kind error text is about the account rather than the one model: a usage limit, a
 * quota, billing, spent credit, or a credential that was not accepted (401). A model that is not
 * found, and a 403, which providers also give for one model an account may not use, are the
 * model's own. coolFrom says for which providers the account is cooled.
 */
export function accountScoped(text: string | undefined): boolean {
  const head = headOf(text);
  return failureKind(text) === "limit" && (ACCOUNT_ERROR.test(head) || CREDIT_ERROR.test(head));
}

const WAIT_PART = /^\s*(?:,|and)?\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i;
const WAIT_START = /try again in/i;
/** The longest wait an error text is believed about, in minutes: the roster's own longest cooldown. */
const WAIT_MAX_MINUTES = 1440;

/**
 * The wait a limit error names ("Try again in ~42 min"), in whole minutes, at least 1 and at most
 * a day; undefined when it names none. The account is then left alone for that long, not for the
 * roster's cooldownMinutes: asking again sooner only fails again, and waiting longer wastes it.
 * A wait given in several units ("2 hours 30 min") is their sum.
 */
export function waitMinutes(text: string | undefined): number | undefined {
  const head = headOf(text);
  const start = WAIT_START.exec(head);
  if (start === null) return undefined;
  let rest = head.slice(start.index + start[0].length);
  let total: number | undefined;
  for (let part = WAIT_PART.exec(rest); part !== null; part = WAIT_PART.exec(rest)) {
    const unit = (part[2] ?? "").toLowerCase();
    const perUnit = unit.startsWith("s") ? 1 / 60 : unit.startsWith("m") ? 1 : unit.startsWith("h") ? 60 : 1440;
    total = (total ?? 0) + Number(part[1]) * perUnit;
    rest = rest.slice(part[0].length);
  }
  if (total === undefined || !Number.isFinite(total)) return undefined;
  return Math.min(Math.max(Math.ceil(total), 1), WAIT_MAX_MINUTES);
}

/** The parts of a failed assistant response the cooldown rules read. */
export interface FailedResponse {
  readonly provider: string;
  readonly model: string;
  readonly api: string;
  readonly stopReason: string;
  readonly errorMessage?: string | undefined;
  readonly timestamp: number;
  /** What the response carries: a failure before any output has none. */
  readonly content?: readonly unknown[] | undefined;
}

/**
 * Apply the cooldown rules to one failed response: a physical model's limit-kind error cools it for
 * the wait the error names, else the roster's cooldownMinutes. A router refusal (it names the
 * virtual model), a content-filter refusal and any local-role model are never cooled. Returns the
 * cooled ref.
 *
 * The account, every model of the provider id, is cooled with it in two cases, both where the
 * models are known to share what ran out:
 * - spent credit (creditScoped), for any provider: credit is the account's by its nature;
 * - any other account error (accountScoped), for a subscription provider (openai-codex, anthropic,
 *   github-copilot or a Multi-Pass alias of one), which is one account behind one credential.
 * Otherwise the one model is cooled, as before: an error text cannot tell an account-wide limit
 * from a limit on one model, and OpenRouter has both. A provider id is one account, so the work
 * account's cooldown never touches the personal account's models, nor the other way round.
 */
/** Whether a limit-kind error cools its provider's whole account, by the two cases coolFrom gives. */
export function coolsAccount(provider: string, text: string | undefined): boolean {
  return creditScoped(text) || (accountScoped(text) && subscriptionKind(provider) !== undefined);
}

export function coolFrom(message: FailedResponse, roster: Roster, cooldowns: Cooldowns, now: number): string | undefined {
  if (message.stopReason !== "error" || message.provider === PROVIDER || message.api === VIRTUAL_API) return undefined;
  const ref = `${message.provider}/${message.model}`;
  if (failureKind(message.errorMessage) !== "limit" || inLocalRole(roster, ref)) return undefined;
  const minutes = waitMinutes(message.errorMessage) ?? roster.cooldownMinutes;
  cooldowns.cool(ref, message.timestamp, now, minutes);
  if (coolsAccount(message.provider, message.errorMessage)) cooldowns.coolAccount(message.provider, message.timestamp, now, minutes);
  return ref;
}

// ─── Holds ───────────────────────────────────────────────────────────────────

/** A model held because its server could not be reached, until when. */
export interface Hold {
  readonly until: number;
}

/**
 * Held refs, each with the failed response that held it, so one response holds once. A hold is a
 * preference, never a refusal: a held model is passed over while another candidate can take the
 * request, and is tried again when none can (pickInRole). An answer from it lifts its hold.
 */
export class Holds {
  readonly #entries = new Map<string, Hold & { readonly stamp: number }>();

  hold(ref: string, stamp: number, now: number, minutes: number): void {
    if (this.#entries.get(ref)?.stamp === stamp) return;
    this.#entries.set(ref, { until: now + minutes * 60_000, stamp });
  }

  /** When `ref` stops being held, or undefined when it is not held at `now`. */
  until(ref: string, now: number): number | undefined {
    const entry = this.#entries.get(ref);
    return entry !== undefined && entry.until > now ? entry.until : undefined;
  }

  /** Lift the hold on a model: it has answered. */
  release(ref: string): void {
    this.#entries.delete(ref);
  }

  /** Every ref held at `now`, in the order they were first held. */
  active(now: number): Array<Hold & { readonly ref: string }> {
    return [...this.#entries].filter(([, entry]) => entry.until > now).map(([ref, entry]) => ({ ref, until: entry.until }));
  }
}

/** The reason code of a candidate passed over for its hold; pickInRole tells a hold from every other reason by it. */
export const HELD_REASON = "unreachable-until-";

/** A hold as status and refusals word it: the reason code, and the reason in words. */
export function describeHold(hold: Hold): { readonly reason: string; readonly detail: string } {
  const at = clock(hold.until);
  return { reason: `${HELD_REASON}${at}`, detail: `passed over until ${at}, since its server could not be reached` };
}

/**
 * What an error text says when a connection to the model's server could not be made at all: it was
 * refused or reset, the name did not resolve, there was no route to the host or network, the
 * connect timed out, the TLS handshake or the certificate's verification failed, or the gateway in
 * front of the model had nothing behind it (502). The SDK's generic "Connection error." and "fetch
 * failed" are here too, which is safe only because holdFrom applies the rule to local models alone.
 *
 * Deliberately not here, because each can mean a server that is there and slow, loading or busy: a
 * request or a read that timed out (a bare ETIMEDOUT, "timed out", 504, "gateway time-out"), 503
 * and "service unavailable" (a model that is loading), 500, a stream cut off, a rate limit,
 * "overloaded"; and any text that merely mentions a certificate or TLS. Hera's models answer behind
 * HTTPS on hera.lan, where a long cold prefill can trip the proxy's timeout: that must not bounce a
 * session to another host and back.
 */
const UNREACHABLE =
  /ECONNREFUSED|connection[ _-]?refused|ECONNRESET|connection[ _-]?reset|reset before headers|ENOTFOUND|EAI_AGAIN|getaddrinfo|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|connect ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|connect[ _-]?timeout|connection[ _-]?error|network[ _-]?error|fetch failed|socket hang up|other side closed|socket connection was closed|unable to verify the first certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|self[- ]signed certificate|SELF_SIGNED_CERT|certificate has expired|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|does not match certificate|\b(?:TLS|SSL) handshake\b|(?<![a-z0-9])502(?![a-z0-9])|bad gateway/i;

/** Whether an error text says that a connection to the model's server could not be made. A content-filter refusal or a limit never does. */
export function isUnreachable(text: string | undefined): boolean {
  return failureKind(text) === "other" && UNREACHABLE.test(headOf(text));
}

/** Whether a failed response carries any output: text, thinking or a tool call that had begun to stream. */
export function hasOutput(content: readonly unknown[] | undefined): boolean {
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
 * roster's unreachableMinutes when all of these are so. Holds are kept per router instance, as
 * cooldowns are: another session finds a dead server out for itself.
 *
 * - The response is a physical model's error that says a connection to its server could not be
 *   made (isUnreachable).
 * - It carries no output. A failure after output has started is the stream's: it is retried on the
 *   same model, as every such failure was, and is never sent on to another.
 * - `model`, the catalog's entry for it, is local by the roster's own local section: one of its
 *   local providers on one of its local hosts. A cloud model's connection failure is left to Pi's
 *   backoff on the same model: a network blip should not send a conversation to another vendor.
 */
export function holdFrom(message: FailedResponse, model: LocalCandidate | undefined, roster: Roster, holds: Holds, now: number): string | undefined {
  if (message.stopReason !== "error" || message.provider === PROVIDER || message.api === VIRTUAL_API) return undefined;
  const ref = `${message.provider}/${message.model}`;
  if (model === undefined || `${model.provider}/${model.id}` !== ref) return undefined;
  if (!isUnreachable(message.errorMessage) || hasOutput(message.content)) return undefined;
  if (!checkLocal(model, policyFromRoster(roster), false).ok) return undefined;
  holds.hold(ref, message.timestamp, now, unreachableMinutesOf(roster));
  return ref;
}
