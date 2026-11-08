// A pi-cache-optimizer-shaped consumer of pi.routing.registry.v1, following what pi-cache-optimizer
// 2.8.7 does (index.ts:1163-1300, 2182-2185): the session hash it sends as the hint, the checks it
// applies before it trusts a registry or an adapter, the registry it creates when it finds none it
// accepts, the snapshot fields it requires, and the APIs whose system prompt it never rewrites.
// Test-only; never shipped.
import { createHash } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const KEY = Symbol.for("pi.routing.registry.v1");
type Store = Record<symbol, unknown>;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export interface Registry {
  registerRouter(adapter: unknown): () => void;
  getRouter(virtualProvider: string): unknown;
}

export interface Snapshot {
  readonly virtualProvider: string;
  readonly virtualModelId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly api: string | undefined;
  readonly status: string | undefined;
  readonly sessionIdHash: string | undefined;
  readonly timestamp: number;
}

/** The optimizer's session key: the first 16 hex characters of sha256(session id). */
export const hashSessionId = (sessionId: string): string => createHash("sha256").update(sessionId).digest("hex").slice(0, 16);

export function isRoutingRegistryV1(value: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && record.version === 1 && typeof record.registerRouter === "function" && typeof record.getRouter === "function";
}

export function isRouterAdapterV1(value: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && nonEmpty(record.virtualProvider) && typeof record.resolveActiveRoute === "function";
}

export const registryValue = (): unknown => (globalThis as unknown as Store)[KEY];

/** The registry the optimizer reuses, or creates in place of anything it does not accept. */
export function ensureRoutingRegistry(): Registry {
  const store = globalThis as unknown as Store;
  if (isRoutingRegistryV1(store[KEY])) return store[KEY] as Registry;
  const routers = new Map<string, unknown>();
  const created = {
    version: 1,
    registerRouter(adapter: unknown) {
      if (!isRouterAdapterV1(adapter)) return () => undefined;
      const key = (adapter as { virtualProvider: string }).virtualProvider.trim();
      routers.set(key, adapter);
      return () => {
        if (routers.get(key) === adapter) routers.delete(key);
      };
    },
    getRouter: (virtualProvider: string) => routers.get(virtualProvider),
  };
  store[KEY] = created;
  return created;
}

/** What the optimizer resolves for the selection at one of its hooks: the adapter's answer for the session, parsed. */
export function resolveActiveRoute(ctx: Pick<ExtensionContext, "model" | "sessionManager">): Snapshot | undefined {
  const { model } = ctx;
  if (model === undefined) return undefined;
  const sessionId = ctx.sessionManager.getSessionId();
  const hint = { sessionIdHash: sessionId ? hashSessionId(sessionId) : undefined };
  const registry = registryValue();
  if (!isRoutingRegistryV1(registry)) return undefined;
  const adapter = (registry as Registry).getRouter(model.provider) as { resolveActiveRoute(id: string, hint: unknown): unknown } | undefined;
  if (adapter === undefined) return undefined;
  const raw = asRecord(adapter.resolveActiveRoute(model.id, hint));
  if (raw === undefined) return undefined;
  const virtualProvider = nonEmpty(raw.virtualProvider) ? raw.virtualProvider : model.provider;
  const virtualModelId = nonEmpty(raw.virtualModelId) ? raw.virtualModelId : model.id;
  if (!nonEmpty(raw.provider) || !nonEmpty(raw.modelId)) return undefined;
  return {
    virtualProvider,
    virtualModelId,
    provider: raw.provider,
    modelId: raw.modelId,
    api: nonEmpty(raw.api) ? raw.api : undefined,
    status: nonEmpty(raw.status) ? raw.status : undefined,
    sessionIdHash: nonEmpty(raw.sessionIdHash) ? raw.sessionIdHash : undefined,
    timestamp: typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now(),
  };
}

/** Whether the optimizer leaves the system prompt alone for a model of this API. */
export const keepsSystemPrompt = (api: unknown): boolean =>
  ["openai-codex-responses", "openai-responses", "azure-openai-responses"].includes(typeof api === "string" ? api.toLowerCase() : "");
