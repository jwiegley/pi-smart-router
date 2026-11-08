// The pi.routing.registry.v1 adapter for pi-cache-optimizer.
//
// pi-cache-optimizer decides once per run, at before_agent_start, whether to rewrite the system
// prompt, and judges each request's headers and payload by the model it reaches. Without an
// adapter it sees the virtual model (api pi-virtual): it rewrites Codex system prompts, which
// Codex's content filter rejects, drops oMLX session-affinity headers and strips
// prompt_cache_retention. The adapter tells it, per session, what route() will do next there:
//
//   1. the run's pending plan, as "planned";
//   2. else the model the run's owner-loop route picked, as "selected";
//   3. else what an owner continuation would pick now, computed without side effects, as
//      "selected";
//   4. else nothing.
//
// Only the owner session's own agent loop and its message_end change these answers, so a
// compaction summary, a nested session or a goal-x auditor routing in between cannot change what
// the optimizer reads. Without a session hint the adapter answers nothing, and it never throws.
//
// One adapter serves the whole process. It is registered when the first owner arrives and
// unregistered after the last one leaves, and it asks the owner whose session hash the hint
// names. Concurrent in-process sessions would otherwise replace each other's adapter, and the
// first to unregister would remove the others'. The registry has the shape pi-cache-optimizer
// validates and reuses (pi-cache-optimizer 2.8.7, index.ts:1183-1223), so either side may create
// it first.
import { PROVIDER, ROUTING_REGISTRY_KEY } from "./constants.ts";
import { isRecord } from "./files.ts";
import { isLiveOwner } from "./owners.ts";
import type { Owner, Slot } from "./owners.ts";

/** What an owner answers for its session: the model route() will pick next. */
export interface ActiveRoute {
  readonly provider: string;
  readonly modelId: string;
  readonly api: string | undefined;
  readonly status: "planned" | "selected";
  readonly at: number;
}

export interface RouteSnapshot {
  readonly virtualProvider: string;
  readonly virtualModelId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly api?: string;
  readonly status: "planned" | "selected";
  readonly sessionIdHash: string;
  readonly timestamp: number;
}

export interface RouteHint {
  readonly sessionIdHash?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface RouterAdapter {
  readonly virtualProvider: string;
  resolveActiveRoute(virtualModelId: string, hint?: RouteHint): RouteSnapshot | undefined;
}

export interface RoutingRegistry {
  readonly version: 1;
  registerRouter(adapter: RouterAdapter): () => void;
  getRouter(virtualProvider: string): RouterAdapter | undefined;
}

const KEY = Symbol.for(ROUTING_REGISTRY_KEY);

const isAdapter = (value: unknown): value is RouterAdapter =>
  isRecord(value) && typeof value.virtualProvider === "string" && value.virtualProvider.trim() !== "" && typeof value.resolveActiveRoute === "function";

/** The test pi-cache-optimizer applies before it reuses a registry it finds. */
export const isRoutingRegistry = (value: unknown): value is RoutingRegistry =>
  isRecord(value) && value.version === 1 && typeof value.registerRouter === "function" && typeof value.getRouter === "function";

function createRegistry(): RoutingRegistry {
  const routers = new Map<string, RouterAdapter>();
  return {
    version: 1,
    registerRouter(adapter) {
      if (!isAdapter(adapter)) return () => undefined;
      const key = adapter.virtualProvider.trim();
      routers.set(key, adapter);
      return () => {
        if (routers.get(key) === adapter) routers.delete(key);
      };
    },
    getRouter: (virtualProvider) => routers.get(virtualProvider),
  };
}

/** The process's registry: one pi-cache-optimizer would accept, created in its place, as the optimizer does, when there is none. */
export function routingRegistry(host: object = globalThis): RoutingRegistry {
  const store = host as Record<symbol, unknown>;
  const existing = store[KEY];
  if (isRoutingRegistry(existing)) return existing;
  const created = createRegistry();
  store[KEY] = created;
  return created;
}

/** The adapter: it asks the live owner whose session hash the hint names. */
export function createAdapter(slot: Slot): RouterAdapter {
  return {
    virtualProvider: PROVIDER,
    resolveActiveRoute(virtualModelId, hint) {
      try {
        const hash = hint?.sessionIdHash;
        if (typeof hash !== "string" || hash === "" || (virtualModelId !== "auto" && virtualModelId !== "local")) return undefined;
        let owner: Owner | undefined;
        for (const candidate of [...slot.owners]) {
          if (candidate.hash === hash && isLiveOwner(slot, candidate)) owner = candidate;
        }
        if (owner === undefined || typeof owner.router.activeRoute !== "function") return undefined;
        const route = owner.router.activeRoute(virtualModelId);
        if (route === undefined) return undefined;
        return {
          virtualProvider: PROVIDER,
          virtualModelId,
          provider: route.provider,
          modelId: route.modelId,
          ...(route.api === undefined ? {} : { api: route.api }),
          status: route.status,
          sessionIdHash: owner.hash,
          timestamp: route.at,
        };
      } catch {
        return undefined;
      }
    },
  };
}

/** At session_start: register the process's one adapter, unless it is registered already. */
export function registerAdapter(slot: Slot, host: object = globalThis): void {
  const registry = routingRegistry(host);
  const current = slot.adapter;
  if (current !== undefined && registry.getRouter(PROVIDER) === current.adapter) return;
  current?.unregister();
  const adapter = createAdapter(slot);
  slot.adapter = { adapter, unregister: registry.registerRouter(adapter) };
}

/** After the last owner leaves. */
export function unregisterAdapter(slot: Slot): void {
  const current = slot.adapter;
  slot.adapter = undefined;
  current?.unregister();
}
