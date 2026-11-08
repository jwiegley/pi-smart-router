// Names, limits and fixed policy shared by the router's modules.

/** The router's provider id and its two virtual models. */
export const PROVIDER = "smart-router";
export const VIRTUAL_IDS = ["auto", "local"] as const;
export type VirtualId = (typeof VIRTUAL_IDS)[number];
export const NAMES: Readonly<Record<VirtualId, string>> = {
  auto: "Smart Router (auto)",
  local: "Smart Router (local models)",
};

/** Pi's thinking levels, lowest first. Both virtual models offer every one of them. */
export const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof ALL_LEVELS)[number];

/** The limits both models declare until session_start recomputes them from the roster. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Exclusions no roster can remove: exact `provider/id` refs and `provider/*` globs. They guard
 * names; the account bindings guard accounts.
 */
export const BUILTIN_EXCLUDES: readonly string[] = [
  "openai-codex-3/*",
  "hermes/*",
  "openrouter/openrouter/auto",
  "smart-router/*",
];

/**
 * Subscription providers: the account types Multi-Pass clones, and the aliases it names
 * `<provider>-<index>`. A roster ref to any of them needs an account binding.
 */
export const SUBSCRIPTION_PROVIDERS: readonly string[] = ["openai-codex", "anthropic", "github-copilot"];
export const SUBSCRIPTION_ALIAS = /^(openai-codex|anthropic|github-copilot)-[0-9]+$/;

/** Account labels the router refuses wherever they appear, in the roster or in Multi-Pass's file. */
export const REFUSED_LABEL = /\b(positron|work)\b/i;

/** The files the router reads, all under Pi's agent directory, and their size caps. */
export const ROSTER_FILE = "smart-router.json";
export const ROSTER_MAX_BYTES = 64 * 1024;
export const MULTI_PASS_FILE = "multi-pass.json";
export const MULTI_PASS_MAX_BYTES = 256 * 1024;

/** Roster defaults and their allowed ranges, in whole minutes. */
export const STICKY_IDLE_MINUTES = { default: 5, min: 0, max: 1440 } as const;
export const COOLDOWN_MINUTES = { default: 30, min: 1, max: 1440 } as const;

/** The pin's session entry, the environment switch, the status item and the process slots. */
export const PIN_ENTRY = "smart-router.pin";
export const ENV_PIN = "PI_SMART_ROUTER_LOCAL_ONLY";
export const STATUS_KEY = "smart-router";
export const SLOT_KEY = "jwiegley.pi-smart-router.v1";
export const ROUTING_REGISTRY_KEY = "pi.routing.registry.v1";
