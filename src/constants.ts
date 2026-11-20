// Names, limits and fixed policy shared by the router's modules.

/** The router's provider id and its two virtual models. */
export const PROVIDER = "smart-router";
export const VIRTUAL_IDS = ["auto", "local"] as const;
export type VirtualId = (typeof VIRTUAL_IDS)[number];
export const NAMES: Readonly<Record<VirtualId, string>> = {
  auto: "Smart Router (auto)",
  local: "Smart Router (local models)",
};

/**
 * The API id Pi gives virtual catalog entries (VIRTUAL_MODEL_API, which the package index does not
 * export). A model with it never reaches a provider, and the router never routes to one.
 */
export const VIRTUAL_API = "pi-virtual";

/** Pi's thinking levels, lowest first. Both virtual models offer every one of them. */
export const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof ALL_LEVELS)[number];

/** The limits both models declare until session_start recomputes them from the roster. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;

/** Hera's work account alias. A version 2 work level lifts its exclusion for a work-bound account. */
export const WORK_ALIAS_EXCLUDE = "openai-codex-3/*";

/**
 * Exclusions no roster can remove: exact `provider/id` refs and `provider/*` globs. They guard
 * names; the account bindings guard accounts.
 */
export const BUILTIN_EXCLUDES: readonly string[] = [
  WORK_ALIAS_EXCLUDE,
  "hermes/*",
  "openrouter/openrouter/auto",
  "smart-router/*",
];

/**
 * Subscription providers: native accounts and the aliases Multi-Pass names
 * `<provider>-<index>`. Claude Code owns its native login outside Pi and is
 * not a Multi-Pass provider.
 */
export const SUBSCRIPTION_PROVIDERS: readonly string[] = ["openai-codex", "anthropic", "github-copilot", "claude-code"];
export const SUBSCRIPTION_ALIAS = /^(openai-codex|anthropic|github-copilot)-[0-9]+$/;

/**
 * Account labels that name work. The router refuses them wherever they appear, in the roster or in
 * Multi-Pass's file, except on a version 2 work binding, which must carry one, and which only a
 * work-scope session's check accepts (checkAccount).
 */
export const REFUSED_LABEL = /\b(positron|work)\b/i;

/** The files the router reads, all under Pi's agent directory, and their size caps. */
export const ROSTER_FILE = "smart-router.json";
export const ROSTER_MAX_BYTES = 64 * 1024;
export const MULTI_PASS_FILE = "multi-pass.json";
export const MULTI_PASS_MAX_BYTES = 256 * 1024;

// Roster defaults and their allowed ranges, in whole minutes.
/** stickyIdleMinutes is accepted and ignored, and still refused outside this range; its default is never used. */
export const STICKY_IDLE_MINUTES = { default: 5, min: 0, max: 1440 } as const;
export const COOLDOWN_MINUTES = { default: 30, min: 1, max: 1440 } as const;
/**
 * How long a local model whose server could not be reached is held, that is passed over while
 * another candidate can take the request. Five minutes by default: long enough
 * that a server restarting or loading a model is not tried, and timed out on, by every run
 * meanwhile, and that a session does not flap between two hosts, each move costing a cold prefill
 * on the other; short enough that the preferred server is back in use soon after it returns.
 */
export const UNREACHABLE_MINUTES = { default: 5, min: 1, max: 60 } as const;

/**
 * The version 2 classifier's defaults and allowed ranges. The model names a Jev version. closeCall
 * is accepted within its old range and ignored: demand.closeCall decides a close call.
 */
export const CLASSIFIER_MODEL = "openrouter/typesafe/jev-1.14";
export const CLASSIFIER_TIMEOUT_MS = { default: 1000, min: 100, max: 1000 } as const;
export const CLASSIFIER_CLOSE_CALL = { default: 0.15, min: 0, max: 0.5 } as const;
export const CLASSIFIER_MESSAGES = { default: 6, min: 0, max: 20 } as const;
export const CLASSIFIER_MESSAGE_CHARS = { default: 1500, min: 200, max: 8000 } as const;
export const CLASSIFIER_TOTAL_CHARS = { default: 12_000, min: 1000, max: 32_000 } as const;
/** The longest level description Jev reads, in characters, counted as Unicode code points. */
export const DESCRIBE_MAX_CHARS = 2000;

/**
 * Jev's prompt files: plain text or Markdown under <agentDir>/smart-router/, named by the roster
 * (src/prompts.ts). A name has no directory part, so a roster cannot point outside that directory.
 * The instructions' cap is in characters, counted as a level description's is.
 */
export const PROMPT_DIR = "smart-router";
export const PROMPT_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}\.(?:md|txt)$/;
export const PROMPT_FILE_MAX_BYTES = 16 * 1024;
export const INSTRUCTIONS_MAX_CHARS = 4000;

/** The command and the process slots. */
export const COMMAND = "smart-router";
export const SLOT_KEY = "jwiegley.pi-smart-router.v1";
export const ROUTING_REGISTRY_KEY = "pi.routing.registry.v1";

/**
 * The scope's session entry and its environment switch, whose one value `work` puts every session
 * of the process in work scope; the session entry that records each routed run's level; and the
 * footer's one status item, which shows the run's level, the thinking effort the owner loop's
 * latest request carried (src/effort.ts) and the model (records.ts, footerText).
 */
export const SCOPE_ENTRY = "smart-router.scope";
export const ENV_SCOPE = "PI_SMART_ROUTER_SCOPE";
export const LEVEL_ENTRY = "smart-router.level";
export const LEVEL_KEY = "smart-router-level";
