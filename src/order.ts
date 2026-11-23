// The provider order: which provider's models come first in a tier. A view over a version 2
// roster, never an edit of it: each role keeps exactly the models the roster gives it, and only
// their order changes. Every resolution, retry, cost and safety check reads the view, so they all
// see one order.
//
// An order belongs to one of three scopes: personal and work, which own their level roles and the
// roles of their fallback chains, and local, which owns the local roles wherever they are used,
// as a level's fallback included. The roster may give each scope a default (`providerOrder`), and
// a session may replace it, for every tier of a scope or for one tier, with /smart-router prefer.
// A session's order lives in the router's memory for that session and is written nowhere.
//
// Pure, and free of Pi's packages: the standalone checker reads it too (src/check.ts).
import { localRoles } from "./local.ts";
import { parseRef } from "./roster.ts";
import type { Role, Roster, RosterV2 } from "./roster.ts";
import { TIERS } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

export type OrderScope = "personal" | "work" | "local";
export const ORDER_SCOPES: readonly OrderScope[] = ["personal", "work", "local"];

export function isOrderScope(value: unknown): value is OrderScope {
  return typeof value === "string" && (ORDER_SCOPES as readonly string[]).includes(value);
}

/** A session's order for one scope: for every tier, and for single tiers, which come first. */
export interface ScopeOrder {
  readonly all?: readonly string[];
  readonly tiers?: Readonly<Partial<Record<Tier, readonly string[]>>>;
}

export type SessionOrder = Readonly<Partial<Record<OrderScope, ScopeOrder>>>;

/** Which scope's order governs a role, and the tier it is the role of, when it is one. */
export interface RoleOwner {
  readonly scope: OrderScope;
  readonly tier?: Tier;
}

/**
 * Each role an order governs. A local role is the local scope's wherever it is named; a level's
 * role and a chain's role are their scope's.
 */
export function roleOwners(roster: RosterV2): ReadonlyMap<string, RoleOwner> {
  const owners = new Map<string, RoleOwner>();
  const { local } = roster;
  for (const name of localRoles(local)) {
    const tier = TIERS.find((candidate) => local?.levels?.[candidate] === name);
    owners.set(name, tier === undefined ? { scope: "local" } : { scope: "local", tier });
  }
  for (const scope of ["personal", "work"] as const) {
    const section = roster.scopes[scope];
    if (section === undefined) continue;
    for (const tier of TIERS) {
      const { role } = section.levels[tier];
      if (!owners.has(role)) owners.set(role, { scope, tier });
    }
    for (const role of section.fallback ?? []) {
      if (!owners.has(role)) owners.set(role, { scope });
    }
  }
  return owners;
}

/** Whether the roster has anything for a scope's order to govern. */
export function hasOrderScope(roster: RosterV2, scope: OrderScope): boolean {
  return scope === "local" ? roster.local !== undefined : roster.scopes[scope] !== undefined;
}

/** The providers of the models a scope's order governs, in the order the roster first names them. */
export function providersOf(roster: RosterV2, scope: OrderScope, tier?: Tier): readonly string[] {
  const owners = roleOwners(roster);
  const found: string[] = [];
  for (const role of roster.roles) {
    const owner = owners.get(role.name);
    if (owner?.scope !== scope || (tier !== undefined && owner.tier !== tier)) continue;
    for (const ref of role.models) {
      const provider = parseRef(ref)?.provider;
      if (provider !== undefined && !found.includes(provider)) found.push(provider);
    }
  }
  return found;
}

/** The order in effect for a scope's tier, and whose it is; none when the roster's own order stands. */
export function orderFor(
  roster: RosterV2,
  session: SessionOrder | undefined,
  scope: OrderScope,
  tier?: Tier,
): { readonly providers: readonly string[]; readonly source: "session" | "roster" } | undefined {
  const mine = session?.[scope];
  const chosen = (tier === undefined ? undefined : mine?.tiers?.[tier]) ?? mine?.all;
  if (chosen !== undefined) return { providers: chosen, source: "session" };
  const given = roster.providerOrder?.[scope];
  return given === undefined ? undefined : { providers: given, source: "roster" };
}

/** A role's models with the listed providers' first, in the listed order; the rest keep their places after them. */
export function reorder(models: readonly string[], providers: readonly string[]): readonly string[] {
  const rank = (ref: string): number => {
    const at = providers.indexOf(parseRef(ref)?.provider ?? "");
    return at < 0 ? providers.length : at;
  };
  const sorted = models.map((ref, index) => ({ ref, index, rank: rank(ref) })).sort((a, b) => a.rank - b.rank || a.index - b.index);
  return sorted.every((entry, index) => entry.ref === models[index]) ? models : sorted.map((entry) => entry.ref);
}

const views = new WeakMap<Roster, Map<string, Roster>>();

/**
 * The roster as a session routes by it: every role's models in the order in effect. The roster
 * itself when no order moves anything, and the same view for the same roster and order, so that
 * whatever compares rosters by identity sees one.
 */
export function orderedRoster(roster: Roster, session?: SessionOrder): Roster {
  if (roster.version !== 2 || (session === undefined && roster.providerOrder === undefined)) return roster;
  const key = JSON.stringify(session ?? null);
  const known = views.get(roster)?.get(key);
  if (known !== undefined) return known;
  const owners = roleOwners(roster);
  const roles = roster.roles.map((role): Role => {
    const owner = owners.get(role.name);
    const order = owner === undefined ? undefined : orderFor(roster, session, owner.scope, owner.tier);
    if (order === undefined) return role;
    const models = reorder(role.models, order.providers);
    return models === role.models ? role : { ...role, models };
  });
  const view = roles.every((role, index) => role === roster.roles[index]) ? roster : { ...roster, roles };
  let byOrder = views.get(roster);
  if (byOrder === undefined) {
    byOrder = new Map();
    views.set(roster, byOrder);
  }
  byOrder.set(key, view);
  return view;
}

/** A session's order with one scope's part replaced, or dropped; undefined when nothing is left. */
export function withScopeOrder(session: SessionOrder | undefined, scope: OrderScope, next: ScopeOrder | undefined): SessionOrder | undefined {
  const rest = Object.fromEntries(Object.entries(session ?? {}).filter(([name]) => name !== scope));
  const empty = next === undefined || (next.all === undefined && Object.keys(next.tiers ?? {}).length === 0);
  const result = empty ? rest : { ...rest, [scope]: next };
  return Object.keys(result).length === 0 ? undefined : result;
}
