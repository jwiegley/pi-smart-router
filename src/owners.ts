// The process slot: what every instance of the router in this process shares, kept under
// globalThis[Symbol.for("jwiegley.pi-smart-router.v1")], and the dispatch that uses it.
//
// Pi registers a virtual model's route per ModelRuntime, and the last registration wins. A nested
// session that shares its parent's runtime and loads the router (goal-x's auditor or oracle with
// project resources, pi-subagents' detached children) therefore replaces the route for every
// session on that runtime, and once it is disposed, the context Pi passes that route throws on
// every read. So each session that starts the router joins the slot as an owner, with the context
// its session_start handler received, and whichever instance's route Pi calls:
//
//   1. a request of an owner's own agent loop, recognised by its run signal, goes to that owner;
//   2. any other request routes with the context Pi passed, while that context is live;
//   3. with a stale context, every live owner checks whether it was displaced; when exactly one
//      was, and re-registered, the request routes with that owner's context;
//   4. otherwise the router refuses with its own non-retryable error.
//
// The slot holds only process-wide state: the owners, the catalog objects their registrations
// produced, the environment latches, scope handoffs, what the last valid roster said of work scope,
// and the pi-cache-optimizer adapter's registration. Per-session records live in each router
// instance. Every load of this module, /reload included, shares the slot, so it holds plain data
// and is checked by shape, never by class identity. The scope's fields came later: they are
// optional and made on first use, so a slot an earlier load made still has the shape. The removed
// local-only pin's fields stay, unused, for the same reason: a copy of an earlier version loaded
// in the same process checks for them, and fails on a slot without them.
import { createHash } from "node:crypto";

import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";

import type { ActiveRoute } from "./cache-optimizer.ts";
import { SLOT_KEY } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { isRecord } from "./files.ts";
import type { LocalPolicy } from "./local.ts";
import type { Scope } from "./roster.ts";

/** What the slot asks of a router instance. Instances of every load of this module answer it. */
export interface OwnerRouter {
  /** Route a request of this owner's own agent loop. */
  routeOwned(id: VirtualId, request: ModelRouteRequest, ctx: ExtensionContext): ModelRoute;
  /** Route a `direct` request, or a loop request of a session without its own instance. */
  routeOther(id: VirtualId, request: ModelRouteRequest, ctx: ExtensionContext): ModelRoute;
  /** Re-register both models when a registration no live owner made displaced this one's. */
  heal(ctx: ExtensionContext): boolean;
  /** What route() will pick next for this owner's session, for pi-cache-optimizer; never throws. */
  activeRoute(id: VirtualId): ActiveRoute | undefined;
}

export interface Owner {
  readonly router: OwnerRouter;
  /** The context the session's session_start handler received. */
  readonly ctx: ExtensionContext;
  readonly sessionId: string;
  /** The first 16 hex characters of sha256(sessionId): pi-cache-optimizer's session key. */
  readonly hash: string;
}

export interface EnvLatch {
  /**
   * The removed local-only pin's latch. Kept for the slot's shape (isSlot), which another version
   * loaded in the process may check; always false, and no longer written or read.
   */
  on: boolean;
  /** Was the local policy the removed pin's switch pinned to. Kept for the slot's shape; no longer written or read. */
  policy: LocalPolicy | undefined;
  /** True for the life of the process once any instance saw PI_SMART_ROUTER_SCOPE=work; set only then. */
  work?: boolean;
  /** True for the process lifetime after a personal-only restriction is seen. */
  personalOnly?: boolean;
}

export interface Slot {
  readonly version: 1;
  readonly owners: Set<Owner>;
  /** Each catalog object an owner's registration produced, mapped to that owner. */
  readonly registered: WeakMap<object, Owner>;
  readonly env: EnvLatch;
  /** Was the removed pin's handoffs to the session a fork or /new creates. Kept for the slot's shape (isSlot); no longer written or read. */
  readonly handoffs: Map<string, unknown>;
  /** Scopes handed to the session a fork or /new creates, keyed by its session file; made on first use. */
  scopeHandoffs?: Map<string, unknown>;
  /** What the last valid roster loaded in the process said of work scope (RosterMemory); made at the first valid load, and checked by shape when read. */
  lastRoster?: unknown;
  /** The pi-cache-optimizer adapter and its registration, while any owner is live. */
  adapter: { readonly adapter: object; readonly unregister: () => void } | undefined;
}

const KEY = Symbol.for(SLOT_KEY);

function isSlot(value: unknown): value is Slot {
  if (!isRecord(value)) return false;
  const { env } = value;
  return (
    value.version === 1 &&
    value.owners instanceof Set &&
    value.registered instanceof WeakMap &&
    value.handoffs instanceof Map &&
    (value.scopeHandoffs === undefined || value.scopeHandoffs instanceof Map) &&
    isRecord(env) &&
    typeof env.on === "boolean" &&
    (env.work === undefined || typeof env.work === "boolean") &&
    (env.personalOnly === undefined || typeof env.personalOnly === "boolean")
  );
}

/** The process slot, created on first use. Throws when the key holds anything else. */
export function processSlot(host: object = globalThis): Slot {
  const existing = (host as Record<symbol, unknown>)[KEY];
  if (existing === undefined) {
    const slot: Slot = {
      version: 1,
      owners: new Set(),
      registered: new WeakMap(),
      env: { on: false, policy: undefined },
      handoffs: new Map(),
      adapter: undefined,
    };
    Object.defineProperty(host, KEY, { value: slot, configurable: true, enumerable: false, writable: false });
    return slot;
  }
  if (!isSlot(existing)) {
    throw new Error(`globalThis[Symbol.for("${SLOT_KEY}")] holds an unknown shape; another version of pi-smart-router may be loaded`);
  }
  return existing;
}

/** Process-lifetime scope restrictions. Conflicting latches leave work sessions refused, not personal. */
export function latchEnvScope(slot: Slot, value: string | undefined, personalOnly?: string): void {
  if (value === "work") slot.env.work = true;
  if (value === "personal-only" || personalOnly === "1") slot.env.personalOnly = true;
}

export function scopeLatched(slot: Slot): boolean {
  return slot.env.work === true;
}

export function personalOnlyLatched(slot: Slot): boolean {
  return slot.env.personalOnly === true;
}

/** At session_shutdown: the scope handed to the session a fork or /new creates, under its file. Never in slot.handoffs, which the removed pin used. */
export function leaveScopeHandoff(slot: Slot, file: string, scope: Scope): void {
  if (file === "") return;
  slot.scopeHandoffs ??= new Map();
  slot.scopeHandoffs.set(file, scope);
}

/** At session_start: the scope left for this session's file, taken out of the slot. A value of another shape is no scope. */
export function takeScopeHandoff(slot: Slot, file: string): Scope | undefined {
  const handoffs = slot.scopeHandoffs;
  if (handoffs === undefined || !handoffs.has(file)) return undefined;
  const value = handoffs.get(file);
  handoffs.delete(file);
  return value === "personal" || value === "work" ? value : undefined;
}

/**
 * What the slot keeps of the last valid roster loaded in the process: what the scope reads of it
 * while a later load fails, so that a reload that fails, in this instance or in one a /reload
 * builds, never moves a work session to personal scope.
 */
export interface RosterMemory {
  /** The work scope's directories; none for a roster without a work scope. */
  readonly directories: readonly string[];
}

/** Keep what the scope reads of a roster that loaded. */
export function rememberRoster(slot: Slot, memory: RosterMemory): void {
  slot.lastRoster = memory;
}

/**
 * What the slot keeps of the last valid roster loaded in the process; undefined before any, or when
 * another load of this module kept another shape. Whatever else such a load kept beside the
 * directories is not read.
 */
export function rememberedRoster(slot: Slot): RosterMemory | undefined {
  const memory = slot.lastRoster;
  if (!isRecord(memory)) return undefined;
  const { directories } = memory;
  if (!Array.isArray(directories) || !directories.every((directory) => typeof directory === "string")) return undefined;
  return { directories };
}

export function sessionHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

/** Whether a context is still usable: Pi makes every getter of a stale one throw. */
export function isLive(ctx: ExtensionContext): boolean {
  try {
    return ctx.sessionManager !== undefined;
  } catch {
    return false;
  }
}

/** Drop the owners whose context went stale without a session_shutdown. */
function prune(slot: Slot): void {
  for (const owner of [...slot.owners]) if (!isLive(owner.ctx)) slot.owners.delete(owner);
}

/** Add an owner. True when it is the only live one. */
export function join(slot: Slot, owner: Owner): boolean {
  prune(slot);
  slot.owners.add(owner);
  return slot.owners.size === 1;
}

/** Remove an owner. True when it was the last live one. */
export function leave(slot: Slot, owner: Owner): boolean {
  const removed = slot.owners.delete(owner);
  prune(slot);
  return removed && slot.owners.size === 0;
}

/** Whether an owner is still in the slot with a live context; a stale one is dropped. */
export function isLiveOwner(slot: Slot, owner: Owner): boolean {
  if (!slot.owners.has(owner)) return false;
  if (isLive(owner.ctx)) return true;
  slot.owners.delete(owner);
  return false;
}

/** The owner whose agent loop carries this run signal. Owners with a stale context are dropped. */
export function ownerBySignal(slot: Slot, signal: AbortSignal): Owner | undefined {
  for (const owner of [...slot.owners]) {
    let current: AbortSignal | undefined;
    try {
      current = owner.ctx.signal;
    } catch {
      slot.owners.delete(owner);
      continue;
    }
    if (current === signal) return owner;
  }
  return undefined;
}

/** Every live owner checks for displacement; the one owner that re-registered, if exactly one did. */
export function healDisplaced(slot: Slot): Owner | undefined {
  const healed: Owner[] = [];
  for (const owner of [...slot.owners]) {
    if (!isLiveOwner(slot, owner)) continue;
    try {
      if (owner.router.heal(owner.ctx)) healed.push(owner);
    } catch {
      // An owner that cannot check its registration is not counted as displaced.
    }
  }
  return healed.length === 1 ? healed[0] : undefined;
}
