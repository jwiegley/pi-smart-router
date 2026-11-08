// What counts as local: the built-in local-host rule, the local policy taken from the roster's
// `local` section, and the check a model must pass while a request is local-only.
//
// The policy is a snapshot. The pin records the policy in force when John pinned, so a later
// roster edit cannot widen it, and a recorded policy is checked against the built-in rule again
// when it is read back.
import { isRecord, own } from "./files.ts";
import type { Roster } from "./roster.ts";

export interface LocalPolicy {
  /** The local role's refs, which are the only refs routing may pick while local-only. */
  readonly refs: readonly string[];
  readonly providers: readonly string[];
  /** Base-URL host names in canonical form (see `canonicalHost`). */
  readonly hosts: readonly string[];
}

/** Nothing qualifies. */
export const EMPTY_POLICY: LocalPolicy = Object.freeze({
  refs: Object.freeze([]),
  providers: Object.freeze([]),
  hosts: Object.freeze([]),
});

export type LocalCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The parts of a catalog model the local check reads. */
export interface LocalCandidate {
  readonly provider: string;
  readonly id: string;
  readonly baseUrl?: string | undefined;
}

const LOCAL_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:lan|local|home\.arpa)$/;

function ipv4(host: string): readonly number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (match === null) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

/**
 * The built-in local-host rule: `localhost`; a loopback, private (RFC 1918), link-local or
 * unique-local address; or a name ending in `.lan`, `.local` or `.home.arpa`. Tailnet names and
 * addresses are not local, and neither is anything not in canonical form.
 */
export function isLocalHost(host: string): boolean {
  if (canonicalHost(host) !== host) return false;
  if (host === "localhost" || host === "::1") return true;
  const v4 = ipv4(host);
  if (v4 !== undefined) {
    const [a = -1, b = -1] = v4;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (host.includes(":")) {
    const first = host.split(":")[0] ?? "";
    if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
    const word = Number.parseInt(first, 16);
    return (word & 0xfe00) === 0xfc00 || (word & 0xffc0) === 0xfe80; // fc00::/7, fe80::/10
  }
  return host.length <= 253 && LOCAL_NAME.test(host);
}

/**
 * A host name as the URL parser writes it: lower-case, IPv4 in dotted decimal, IPv6 compressed
 * and without brackets. Undefined for anything that is not a bare host name.
 */
export function canonicalHost(text: string): string | undefined {
  if (!/^[A-Za-z0-9.:-]+$/.test(text)) return undefined;
  try {
    const { hostname } = new URL(text.includes(":") ? `http://[${text}]/` : `http://${text}/`);
    return hostname.replace(/^\[|\]$/g, "");
  } catch {
    return undefined;
  }
}

/** The canonical host of a catalog base URL, or undefined when it has none. */
export function baseUrlHost(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string") return undefined;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/** The policy the roster's `local` section defines; empty without one. */
export function policyFromRoster(roster: Roster): LocalPolicy {
  const local = roster.local;
  const role = local === undefined ? undefined : roster.roles.find((entry) => entry.name === local.role);
  if (local === undefined || role === undefined) return EMPTY_POLICY;
  return Object.freeze({
    refs: Object.freeze([...role.models]),
    providers: Object.freeze([...local.providers]),
    hosts: Object.freeze([...local.hosts]),
  });
}

function strings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

/**
 * A policy recorded in a pin entry, or undefined when it is not exactly a policy whose refs use
 * its providers and whose hosts pass the built-in rule. The caller fails closed on undefined.
 */
export function parsePolicy(value: unknown): LocalPolicy | undefined {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "hosts,providers,refs") return undefined;
  const refs = strings(own(value, "refs"));
  const providers = strings(own(value, "providers"));
  const hosts = strings(own(value, "hosts"));
  if (refs === undefined || providers === undefined || hosts === undefined) return undefined;
  if (providers.some((provider) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider))) return undefined;
  // A ref splits at its first "/", and provider ids have none, so this is "the ref's provider is
  // one of the policy's providers".
  const usesPolicyProvider = (ref: string): boolean =>
    /^[^\s*\x00-\x1f\x7f]+$/.test(ref) && providers.some((provider) => ref.startsWith(`${provider}/`) && ref.length > provider.length + 1);
  if (!refs.every(usesPolicyProvider)) return undefined;
  if (!hosts.every(isLocalHost)) return undefined;
  return Object.freeze({
    refs: Object.freeze([...refs]),
    providers: Object.freeze([...providers]),
    hosts: Object.freeze([...hosts]),
  });
}

/**
 * Whether a model may take a local-only request under the policy. Routing also requires the ref
 * to be in the policy's refs; a directly selected physical model needs only its provider and
 * host to qualify.
 */
export function checkLocal(model: LocalCandidate, policy: LocalPolicy, routing: boolean): LocalCheck {
  const ref = `${model.provider}/${model.id}`;
  if (!policy.providers.includes(model.provider)) {
    return { ok: false, reason: `provider ${model.provider} is not a local provider` };
  }
  const host = baseUrlHost(model.baseUrl);
  if (host === undefined) return { ok: false, reason: `${ref} has no base URL host` };
  if (!policy.hosts.includes(host)) return { ok: false, reason: `host ${host} is not a local host` };
  if (!isLocalHost(host)) return { ok: false, reason: `host ${host} fails the built-in local-host rule` };
  if (routing && !policy.refs.includes(ref)) return { ok: false, reason: `${ref} is not in the local role` };
  return { ok: true };
}
