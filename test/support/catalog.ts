// Catalog fakes for the unit suites: physical models, a catalog with switchable availability and
// credentials, John's Hera fleet, Multi-Pass labels and resolver contexts. Test-only; never shipped.
import assert from "node:assert/strict";

import type { Api, Model } from "@earendil-works/pi-ai";

import { parseMultiPass } from "../../src/accounts.ts";
import type { Labels } from "../../src/accounts.ts";
import type { VirtualId } from "../../src/constants.ts";
import type { Loaded } from "../../src/files.ts";
import { policyFromRoster } from "../../src/local.ts";
import { Cooldowns, refOf, resolveContext } from "../../src/resolve.ts";
import type { Catalog, ResolveContext } from "../../src/resolve.ts";
import { parseRoster } from "../../src/roster.ts";
import type { Roster } from "../../src/roster.ts";
import { fixture } from "./fixtures.ts";

export const HERA_LAN = "https://hera.lan:443/v1";
export const OPENROUTER = "https://openrouter.ai/api/v1";
export const CHATGPT = "https://chatgpt.com/backend-api";

export const GLM = "omlx-hera/GLM-5.3-Flash-oQ4e-mtp";
export const DEEPSEEK = "openrouter/deepseek/deepseek-v4.1-flash-1017";
export const KIMI = "openrouter/moonshotai/kimi-k3.1-pro";
export const GLM_CLOUD = "openrouter/z-ai/glm-5.3";
export const SOL = "openai-codex-2/gpt-6.1-sol";
export const ASTRA = "openai-codex-2/gpt-6-astra";
/** The work account's alias on Hera: it shares sol's model id and is excluded by the router itself. */
export const WORK_SOL = "openai-codex-3/gpt-6.1-sol";
/** Plain openai-codex, which Hera's roster excludes. */
export const NATIVE_SOL = "openai-codex/gpt-6.1-sol";

/** A physical chat model. */
export function model(ref: string, init: Partial<Model<Api>> = {}): Model<Api> {
  const slash = ref.indexOf("/");
  assert.ok(slash > 0, ref);
  return {
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    name: ref,
    api: "openai-completions",
    baseUrl: OPENROUTER,
    input: ["text"],
    reasoning: true,
    contextWindow: 200_000,
    maxTokens: 32_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...init,
  } as Model<Api>;
}

/** A catalog whose models can be made unavailable or left without credentials. */
export class FakeCatalog implements Catalog {
  readonly models = new Map<string, Model<Api>>();
  readonly unavailable = new Set<string>();
  readonly unauthenticated = new Set<string>();
  availableCalls = 0;

  constructor(models: readonly Model<Api>[] = []) {
    for (const entry of models) this.add(entry);
  }

  add(entry: Model<Api>): this {
    this.models.set(refOf(entry), entry);
    return this;
  }

  remove(ref: string): this {
    this.models.delete(ref);
    return this;
  }

  find(provider: string, id: string): Model<Api> | undefined {
    return this.models.get(`${provider}/${id}`);
  }

  getAvailable(): Model<Api>[] {
    this.availableCalls += 1;
    return [...this.models.values()].filter((entry) => !this.unavailable.has(refOf(entry)));
  }

  hasConfiguredAuth(entry: Model<Api>): boolean {
    return !this.unauthenticated.has(refOf(entry));
  }
}

/** Hera's catalog: every roster model, the excluded work alias, plain openai-codex and a virtual model. */
export function heraModels(): Model<Api>[] {
  return [
    model(GLM, { baseUrl: HERA_LAN, contextWindow: 262_144, maxTokens: 81_920 }),
    model(DEEPSEEK, { contextWindow: 128_000, maxTokens: 32_000 }),
    model(KIMI, { contextWindow: 256_000, maxTokens: 32_000 }),
    model(GLM_CLOUD, { contextWindow: 200_000, maxTokens: 32_000 }),
    model(SOL, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 }),
    model(ASTRA, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 }),
    model(WORK_SOL, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 }),
    model(NATIVE_SOL, { api: "openai-codex-responses", baseUrl: CHATGPT, contextWindow: 272_000, maxTokens: 128_000 }),
    model("smart-router/auto", { api: "pi-virtual", baseUrl: "" }),
  ];
}

export function heraCatalog(): FakeCatalog {
  return new FakeCatalog(heraModels());
}

/** A roster from a fixture, validated. */
export function rosterFixture(name: string): Roster {
  const parsed = parseRoster(fixture(name));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.value;
}

/** Labels as loaded from a Multi-Pass file with these subscriptions. */
export function labelsOf(subscriptions: ReadonlyArray<{ provider: string; index: number; label?: string }>): Loaded<Labels> {
  const parsed = parseMultiPass(JSON.stringify({ subscriptions }));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return { kind: "ok", path: "/agent/multi-pass.json", value: parsed.value, loadedAt: 0 };
}

/** Hera's Multi-Pass labels: #2 is John's personal account, #3 the work account. */
export const HERA_LABELS = labelsOf([
  { provider: "openai-codex", index: 2, label: "personal" },
  { provider: "openai-codex", index: 3, label: "Positron work" },
]);

export const NOW = Date.UTC(2026, 10, 8, 14, 0, 0);

/** A resolver context over Hera's roster and catalog, with any part replaced. */
export function heraContext(overrides: Partial<Omit<ResolveContext, "available">> = {}): ResolveContext {
  const roster = overrides.roster ?? rosterFixture("roster-hera.json");
  const virtualId: VirtualId = overrides.virtualId ?? "auto";
  return resolveContext({
    roster,
    catalog: heraCatalog(),
    labels: HERA_LABELS,
    cooldowns: new Cooldowns(),
    now: NOW,
    virtualId,
    localOnly: virtualId === "local",
    policy: policyFromRoster(roster),
    ...overrides,
  });
}
