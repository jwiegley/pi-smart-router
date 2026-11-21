// What counts as local: the built-in local-host rule and the policy from the roster's `local`
// section. Local-only routing and local fallback candidates both pass this check.
import type { LocalSection, Roster } from "./roster.ts";
import { TIERS } from "./tiers.ts";

/** The local role and all roles assigned to a local tier. */
export function localRoles(local: LocalSection | undefined): readonly string[] {
  if (local === undefined) return [];
  return [...new Set([local.role, ...TIERS.map((tier) => local.levels?.[tier]).filter((role): role is string => typeof role === "string")])];
}

export interface LocalPolicy {
  /** The refs in local roles, the only refs local-only routing may pick. */
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
  if (local === undefined) return EMPTY_POLICY;
  const roles = localRoles(local);
  const refs = roles.flatMap((name) => roster.roles.find((role) => role.name === name)?.models ?? []);
  return Object.freeze({
    refs: Object.freeze(refs),
    providers: Object.freeze([...local.providers]),
    hosts: Object.freeze([...local.hosts]),
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
