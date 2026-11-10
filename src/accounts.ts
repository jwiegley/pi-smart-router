// Account bindings. Provider ids do not identify accounts, so every subscription provider in the
// roster carries a binding. A Multi-Pass alias must carry the label Multi-Pass stores for it; a
// native login carries John's acknowledgement, which the router cannot verify. A work or Positron
// label is refused wherever it appears.
//
// Multi-Pass's labels come from its own global file, <agentDir>/multi-pass.json, read with the
// same safe reader. Only subscriptions[].{provider, index, label} is used, and the file holds no
// credentials. An unreadable, unsafe or malformed file refuses every alias binding.
import { MULTI_PASS_FILE, MULTI_PASS_MAX_BYTES, REFUSED_LABEL, SUBSCRIPTION_ALIAS, SUBSCRIPTION_PROVIDERS } from "./constants.ts";
import { agentFile, isRecord, message, own } from "./files.ts";
import type { AgentFile, FileSystem, Loaded, Parsed } from "./files.ts";
import type { Roster } from "./roster.ts";

export type SubscriptionKind = "native" | "alias";

/** Whether a provider is a subscription login (native) or a Multi-Pass alias of one. */
export function subscriptionKind(provider: string): SubscriptionKind | undefined {
  if (SUBSCRIPTION_PROVIDERS.includes(provider)) return "native";
  if (SUBSCRIPTION_ALIAS.test(provider)) return "alias";
  return undefined;
}

const CODEX_PROVIDER = /^openai-codex(?:-[0-9]+)?$/;

/** Whether a provider is Codex: the native openai-codex login or a Multi-Pass alias of it. */
export function isCodexProvider(provider: string): boolean {
  return CODEX_PROVIDER.test(provider);
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

/** Whether the roster binds any Multi-Pass alias, which is the only reason to read the labels. */
export function needsLabels(roster: Roster): boolean {
  return [...roster.accounts.values()].some((binding) => binding.kind === "multi-pass");
}

export type AccountCheck =
  | { readonly ok: true; readonly kind: "none" }
  | { readonly ok: true; readonly kind: "native" | "multi-pass"; readonly label: string; readonly verified: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether the roster's binding lets the router use a provider. Not a subscription provider:
 * nothing to check. A native login: John's acknowledgement, reported as unverified. A Multi-Pass
 * alias: the label Multi-Pass stores must match the roster's, trimmed and case-insensitive.
 */
export function checkAccount(provider: string, roster: Roster, labels: Loaded<Labels> | undefined): AccountCheck {
  const kind = subscriptionKind(provider);
  if (kind === undefined) return { ok: true, kind: "none" };
  const binding = roster.accounts.get(provider);
  if (binding === undefined) return { ok: false, reason: `${provider} has no account binding in the roster` };
  const wanted = binding.label.trim();
  if (REFUSED_LABEL.test(wanted)) return { ok: false, reason: `the roster binds ${provider} to "${wanted}", a refused label` };
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
  if (REFUSED_LABEL.test(found)) return { ok: false, reason: `Multi-Pass labels ${provider} "${found}", a refused label` };
  if (found.toLowerCase() !== wanted.toLowerCase()) {
    return { ok: false, reason: `Multi-Pass labels ${provider} "${found}", not "${wanted}"` };
  }
  return { ok: true, kind: "multi-pass", label: found, verified: true };
}
