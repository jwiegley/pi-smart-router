// Account bindings. Provider ids do not identify accounts, so every subscription provider in the
// roster carries a binding. A Multi-Pass alias must carry the label Multi-Pass stores for it; a
// native login carries John's acknowledgement, which the router cannot verify. A work or Positron
// label is refused wherever it appears, except on a version 2 work binding, which must carry one.
// Even that binding passes only a check made in work scope: routing and status check each binding
// in the session's scope, so a personal session refuses it for its scope, and a check made without
// a scope refuses its label.
//
// Multi-Pass's labels come from its own global file, <agentDir>/multi-pass.json, read with the
// same safe reader. Only subscriptions[].{provider, index, label} is used, and the file holds no
// credentials. An unreadable, unsafe or malformed file refuses every alias binding.
import { MULTI_PASS_FILE, MULTI_PASS_MAX_BYTES, REFUSED_LABEL, SUBSCRIPTION_ALIAS, SUBSCRIPTION_PROVIDERS } from "./constants.ts";
import { agentFile, isRecord, message, own } from "./files.ts";
import type { AgentFile, FileSystem, Loaded, Parsed } from "./files.ts";
import type { Roster, RosterV1, RosterV2, Scope } from "./roster.ts";

export type SubscriptionKind = "native" | "alias" | "account";

/**
 * A subscription provider under a symbolic account suffix, as Pi's `accountOf` names an account of
 * a provider: `openai-codex-p`, `claude-code-j`. A numbered suffix is a Multi-Pass alias or a
 * numbered Claude Code instance instead.
 */
const SUBSCRIPTION_ACCOUNT = /^(?:openai-codex|anthropic|github-copilot|claude-code)-[a-z][a-z0-9-]*$/;

const CLAUDE_CODE_PROVIDER = /^claude-code(?:-[1-9][0-9]*)?$/;

/** Claude Code's independent native provider instances, not Multi-Pass aliases. */
export function isClaudeCodeProvider(provider: string): boolean {
  return CLAUDE_CODE_PROVIDER.test(provider);
}

/** Whether a provider is a subscription login (native), a Multi-Pass alias of one, or a named account of one. */
export function subscriptionKind(provider: string): SubscriptionKind | undefined {
  if (SUBSCRIPTION_PROVIDERS.includes(provider) || isClaudeCodeProvider(provider)) return "native";
  if (SUBSCRIPTION_ALIAS.test(provider)) return "alias";
  if (SUBSCRIPTION_ACCOUNT.test(provider)) return "account";
  return undefined;
}

const CODEX_PROVIDER = /^openai-codex(?:-[a-z0-9][a-z0-9-]*)?$/;

/** Whether a provider is Codex: the native openai-codex login, a Multi-Pass alias of it, or a named account of it. */
export function isCodexProvider(provider: string): boolean {
  return CODEX_PROVIDER.test(provider);
}

/** Account bindings as the scope rules read them: the scope each provider is bound to. Only a version 2 roster binds any. */
export type ScopedAccounts = ReadonlyMap<string, { readonly scope: Scope }>;

/**
 * Whether a provider is a work-bound Codex provider: Codex, and bound to the work scope. It is the
 * only kind of account a work level holds (roster validation) and a work-scope pick goes to
 * (assertSafe). A model picked by hand is not checked: it is sent as it is.
 */
export function isWorkCodex(accounts: ScopedAccounts, provider: string): boolean {
  return isCodexProvider(provider) && accounts.get(provider)?.scope === "work";
}

/** Whether the roster binds a provider to the work scope: the accounts a work level holds and a work-scope pick goes to. */
export function isWorkAccount(accounts: ScopedAccounts, provider: string): boolean {
  return accounts.get(provider)?.scope === "work";
}

/** Multi-Pass's labels, keyed by the provider each subscription registers (`openai-codex-2`). */
export type Labels = ReadonlyMap<string, string | undefined>;

/** Parse Multi-Pass's global file. Any entry it would have to repair is malformed here. */
export function parseMultiPass(text: string): Parsed<Labels> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON syntax error: ${message(error)}` };
  }
  if (!isRecord(value)) return { ok: false, error: "multi-pass.json is not a JSON object" };
  const subscriptions = own(value, "subscriptions");
  if (subscriptions === undefined) return { ok: true, value: new Map() };
  if (!Array.isArray(subscriptions)) return { ok: false, error: "multi-pass.json: subscriptions is not an array" };
  const labels = new Map<string, string | undefined>();
  for (const [index, entry] of subscriptions.entries()) {
    const where = `multi-pass.json: subscriptions[${index}]`;
    if (!isRecord(entry)) return { ok: false, error: `${where} is not an object` };
    const provider = own(entry, "provider");
    const position = own(entry, "index");
    const label = own(entry, "label");
    if (typeof provider !== "string" || provider === "") return { ok: false, error: `${where}.provider is not a provider id` };
    if (typeof position !== "number" || !Number.isSafeInteger(position) || position < 1) {
      return { ok: false, error: `${where}.index is not a positive whole number` };
    }
    if (label !== undefined && typeof label !== "string") return { ok: false, error: `${where}.label is not a string` };
    const alias = `${provider}-${position}`;
    if (labels.has(alias)) return { ok: false, error: `${where} lists ${alias} a second time` };
    labels.set(alias, label);
  }
  return { ok: true, value: labels };
}

export interface LabelsFileOptions {
  readonly agentDir: () => string;
  readonly uid?: number | undefined;
  readonly fs?: FileSystem | undefined;
  readonly now?: (() => number) | undefined;
}

/** Multi-Pass's global file under Pi's agent directory, capped at 256 KiB. */
export function labelsFile(options: LabelsFileOptions): AgentFile<Labels> {
  return agentFile({ ...options, name: MULTI_PASS_FILE, maxBytes: MULTI_PASS_MAX_BYTES, parse: parseMultiPass });
}

/** Whether a roster's bindings hold any Multi-Pass alias, which is the only reason to read the labels. */
export function needsLabels(roster: Pick<Roster, "accounts">): boolean {
  return [...roster.accounts.values()].some((binding) => binding.kind === "multi-pass");
}

export type AccountCheck =
  | { readonly ok: true; readonly kind: "none" }
  | { readonly ok: true; readonly kind: "native" | "multi-pass"; readonly label: string; readonly verified: boolean }
  /** A provider the roster binds to a scope by its id alone: the id names the account. */
  | { readonly ok: true; readonly kind: "account" }
  | { readonly ok: false; readonly reason: string };

/** What checkAccount reads of a roster: its version and its account bindings. */
export type RosterBindings = Pick<RosterV1, "version" | "accounts"> | Pick<RosterV2, "version" | "accounts">;

/**
 * Whether the roster's binding lets the router use a provider. Not a subscription provider and
 * not bound: nothing to check. A provider bound by its id (an account binding): its scope, and
 * nothing else, since the id names the account. A native login: John's acknowledgement, reported
 * as unverified. A Multi-Pass alias: the label Multi-Pass stores must match the roster's, trimmed
 * and case-insensitive.
 *
 * Checked in a session's scope, a version 2 binding serves only that scope's sessions: a personal
 * session refuses a work binding, and a work session takes only a work binding, whose label must
 * name work or Positron. Without a scope, and for version 1, a work or Positron label is refused.
 */
export function checkAccount(provider: string, roster: RosterBindings, labels: Loaded<Labels> | undefined, scope?: Scope): AccountCheck {
  const kind = subscriptionKind(provider);
  const binding = roster.accounts.get(provider);
  if (binding === undefined) return kind === undefined ? { ok: true, kind: "none" } : { ok: false, reason: `${provider} has no account binding in the roster` };
  // The scope a version 2 binding names, when the check is made in a session's scope.
  const bound = roster.version === 2 && scope !== undefined ? roster.accounts.get(provider)?.scope : undefined;
  if (bound !== undefined && bound !== scope) return { ok: false, reason: `the roster binds ${provider} to the ${bound} scope, but this session is in the ${scope} scope` };
  if (binding.kind === "account") return { ok: true, kind: "account" };
  const wanted = binding.label.trim();
  const work = bound === "work";
  if (work && !REFUSED_LABEL.test(wanted)) return { ok: false, reason: `the roster binds ${provider} to "${wanted}", which names neither work nor Positron` };
  if (!work && REFUSED_LABEL.test(wanted)) return { ok: false, reason: `the roster binds ${provider} to "${wanted}", a refused label` };
  if (binding.kind === "native") {
    return kind === "native"
      ? { ok: true, kind: "native", label: wanted, verified: false }
      : { ok: false, reason: `${provider} is a Multi-Pass alias, but the roster binds it as a native login` };
  }
  if (kind === "native") return { ok: false, reason: `${provider} is a native login, but the roster binds it to a Multi-Pass label` };
  if (labels === undefined) return { ok: false, reason: `Multi-Pass's labels were not read, so ${provider} cannot be checked` };
  if (labels.kind !== "ok") return { ok: false, reason: `Multi-Pass's labels are unavailable: ${labels.error}` };
  if (!labels.value.has(provider)) return { ok: false, reason: `Multi-Pass lists no ${provider}` };
  const found = labels.value.get(provider)?.trim() ?? "";
  if (found === "") return { ok: false, reason: `Multi-Pass has no label for ${provider}` };
  if (!work && REFUSED_LABEL.test(found)) return { ok: false, reason: `Multi-Pass labels ${provider} "${found}", a refused label` };
  if (found.toLowerCase() !== wanted.toLowerCase()) {
    return { ok: false, reason: `Multi-Pass labels ${provider} "${found}", not "${wanted}"` };
  }
  return { ok: true, kind: "multi-pass", label: found, verified: true };
}
