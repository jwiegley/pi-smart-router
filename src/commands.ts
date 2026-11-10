// /smart-router: status (the default), history [n], local on|off|status, and reload. It reports
// through notices, and the only thing it writes is the pin's own session entries.
//
// status shows the roster's state, the selection, the pin and the lock, each role's candidates on
// this host with the resolver's verdict and the catalog price, the account bindings with each
// provider's auth source (never a credential), a version 1 roster's routing table, the last
// decision, what can still send data off the machine, and a warning for any version 1 fallback
// that moves a run onto Codex's API from another one. It replaces upstream's doctor, plan, stats,
// pricing and mode commands.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import { checkAccount, subscriptionKind } from "./accounts.ts";
import type { Labels } from "./accounts.ts";
import { PIN_ENTRY, PROVIDER, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { firstLine } from "./errors.ts";
import { isRecord } from "./files.ts";
import type { Loaded } from "./files.ts";
import { describeModel } from "./guards.ts";
import type { GuardState, Guards } from "./guards.ts";
import { checkLocal, EMPTY_POLICY, policyFromRoster } from "./local.ts";
import type { LocalPolicy } from "./local.ts";
import { describePin, describePolicy, pinOff, pinOn } from "./pin.ts";
import type { PinReading } from "./pin.ts";
import { clock, resolveCandidate } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { boundedHistory, HISTORY_LIMIT } from "./route.ts";
import type { HistoryEntry, Pin } from "./route.ts";
import { autoRoles, parseRef } from "./roster.ts";
import type { Roster, RosterV1 } from "./roster.ts";

export interface Files {
  readonly roster: Loaded<Roster>;
  /** Multi-Pass's labels, read only when the roster binds an alias. */
  readonly labels: Loaded<Labels> | undefined;
}

/** What the command needs of its router instance. */
export interface CommandHost {
  readonly pi: Pick<ExtensionAPI, "appendEntry" | "getAllTools" | "getCommands" | "getThinkingLevel">;
  readonly guards: Pick<Guards, "showStatus" | "switchToLocal" | "unlock">;
  readonly now: () => number;
  /** Re-stat both files, and read them again when they changed. */
  refresh(): Files;
  /** Read both files again now, and register both models again when their declared limits changed. */
  reload(ctx: ExtensionContext): Files & { readonly limitsChanged: boolean };
  pinOf(ctx: ExtensionContext): PinReading;
  session(ctx: ExtensionContext): { readonly history: readonly HistoryEntry[]; readonly guard: GuardState } | undefined;
  /** A resolver context for one of the two models, built as routing builds it. */
  resolver(ctx: ExtensionContext, roster: Roster, id: VirtualId, pin: Pin): ResolveContext;
}

/** A notice the command shows. */
export interface Answer {
  readonly text: string;
  readonly type: "info" | "warning" | "error";
}

const USAGE = "Usage: /smart-router [status] | history [n] | local on|off|status | reload";
const UNPINNED: Pin = Object.freeze({ on: false, policy: EMPTY_POLICY });
const HISTORY_DEFAULT = 10;
const CODEX_API = "openai-codex-responses";

/**
 * What /smart-router local off asks, and its two answers. Pi's selector starts on the first answer,
 * so Enter keeps the pin. Pi's own confirm dialog is a selector over Yes and No that starts on Yes,
 * so it is not used here.
 */
const UNPIN_QUESTION = "Unpin this session from local models?\nThe next requests may go to cloud models. Earlier turns stay where they are.";
const KEEP_PIN = "No, keep the pin";
const UNPIN = "Yes, unpin";

/** Extension commands that can send data off the machine, found by name. */
const EGRESS_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["warden", "pi-warden's judge sends redacted context to its backend while it is enabled"],
  ["subs", "Multi-Pass can move the session to another subscription"],
  ["btw", "pi-btw asks a model of its own"],
];
/** Tools that can send data off the machine: subagents, workflows, web fetch and search, and browsers. */
const EGRESS_TOOL = /subagent|workflow|web[_-]?(?:fetch|search)|browser/i;

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** What can still send data off this machine while the session is pinned (design §5.2, §5.3). */
export function egress(pi: Pick<ExtensionAPI, "getAllTools" | "getCommands">): string {
  const commands = new Set(attempt(() => pi.getCommands(), []).filter((command) => command.source === "extension").map((command) => command.name));
  const parts = EGRESS_COMMANDS.filter(([name]) => commands.has(name)).map(([name, what]) => `/${name} (${what})`);
  const tools = [...new Set(attempt(() => pi.getAllTools(), []).map((tool) => tool.name).filter((name) => EGRESS_TOOL.test(name)))].sort();
  if (tools.length > 0) parts.push(`the tools ${tools.join(", ")}`);
  parts.push("Pi's own /share, /export and /bug");
  return `The pin covers the model only. Still able to send data off this machine: ${parts.join("; ")}.`;
}

const stamp = (ms: number): string => {
  const time = new Date(ms);
  return `${clock(ms)}:${String(time.getSeconds()).padStart(2, "0")}`;
};

function rosterLine(roster: Loaded<Roster>): string {
  const at = clock(roster.loadedAt);
  switch (roster.kind) {
    case "ok":
      return `${roster.path}: valid, loaded at ${at}`;
    case "missing":
      return `${roster.path}: missing, checked at ${at}`;
    case "unsafe":
    case "invalid":
      return `${roster.path}: ${roster.kind} (${roster.error}), checked at ${at}`;
  }
}

function describeEntry(entry: HistoryEntry): string {
  const trigger = entry.trigger === undefined ? "" : `, ${entry.trigger}`;
  return `${stamp(entry.at)} ${PROVIDER}/${entry.virtual} ${entry.reason}: ${entry.role} → ${entry.ref} (${entry.code}${trigger})${entry.foreign ? ", foreign" : ""}`;
}

function lockLine(lock: GuardState["lock"]): string | undefined {
  if (lock === undefined) return undefined;
  const why = lock.cause === "conflict" ? `something keeps switching the selection to ${lock.model}` : `the restored selection ${lock.model} could not be switched to smart-router/local`;
  return `Lock: since ${clock(lock.since)}: ${why}. Prompts are refused and runs stopped until the selection stays local.`;
}

const catalogModel = (rc: ResolveContext, ref: string): Model<Api> | undefined => {
  const parsed = parseRef(ref);
  return parsed === undefined ? undefined : rc.catalog.find(parsed.provider, parsed.id);
};

function price(model: Model<Api> | undefined): string {
  const cost = model?.cost;
  if (cost === undefined || (!(cost.input > 0) && !(cost.output > 0))) return "";
  return ` ($${cost.input}/$${cost.output} per 1M)`;
}

function roleLines(host: CommandHost, ctx: ExtensionContext, roster: Roster, pin: PinReading): string[] {
  const localRole = roster.local?.role;
  const auto = host.resolver(ctx, roster, "auto", UNPINNED);
  const local = host.resolver(ctx, roster, "local", pin);
  const reached = autoRoles(roster, auto.scope);
  return roster.roles.map((role) => {
    const rc = role.name === localRole ? local : auto;
    const tags = [
      role.name === localRole ? "the local role" : undefined,
      role.name !== localRole && !reached.has(role.name) ? "smart-router/auto never routes here" : undefined,
      role.thinking === "selected" ? undefined : `thinking ${role.thinking}`,
    ].filter((tag) => tag !== undefined);
    const candidates = role.models.map((ref) => {
      const verdict = resolveCandidate(ref, rc);
      return `${ref} ${verdict.ok ? "ok" : verdict.reason}${price(catalogModel(rc, ref))}`;
    });
    return `  ${role.name}${tags.length > 0 ? ` (${tags.join("; ")})` : ""}: ${candidates.join(", ")}`;
  });
}

function authSource(ctx: ExtensionContext, provider: string): string {
  return attempt(() => {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    return status.configured ? `configured${status.source === undefined ? "" : ` (${status.source})`}` : "not configured";
  }, "unknown");
}

function accountLines(ctx: ExtensionContext, roster: Roster, labels: Loaded<Labels> | undefined): string[] {
  const providers = new Set(roster.accounts.keys());
  for (const role of roster.roles) {
    for (const ref of role.models) {
      const provider = parseRef(ref)?.provider;
      if (provider !== undefined && subscriptionKind(provider) !== undefined) providers.add(provider);
    }
  }
  if (providers.size === 0) return [];
  return [
    "Accounts:",
    ...[...providers].sort().map((provider) => {
      const binding = roster.accounts.get(provider);
      const bound =
        binding === undefined ? "no binding" : binding.kind === "multi-pass" ? `bound to the Multi-Pass label "${binding.label}"` : `a native login acknowledged as "${binding.label}"`;
      const check = checkAccount(provider, roster, labels);
      const verdict = !check.ok
        ? `refused: ${check.reason}`
        : check.kind === "multi-pass"
          ? `Multi-Pass labels it "${check.label}"`
          : check.kind === "native"
            ? "the router cannot verify a native login; run /smart-router status after every /login, /logout or /subs change"
            : "no binding needed";
      return `  ${provider}: ${bound}; ${verdict}; auth ${authSource(ctx, provider)}`;
    }),
  ];
}

function routingLine(roster: RosterV1): string {
  const { routing } = roster;
  const fallbacks = [...routing.fallback].map(([from, to]) => `${from} → ${to}`);
  return `Routing: default ${routing.default}, trivial ${routing.trivial}, complex ${routing.complex}, planning ${routing.planning}; ${
    fallbacks.length === 0 ? "no fallback" : `fallback ${fallbacks.join(", ")}`
  }`;
}

/** Fallbacks that move a run onto Codex's API from another: the system prompt may have been rewritten for the source model. */
function codexWarnings(host: CommandHost, ctx: ExtensionContext, roster: RosterV1): string[] {
  const rc = host.resolver(ctx, roster, "auto", UNPINNED);
  const usesCodex = (name: string): boolean => roster.roles.find((role) => role.name === name)?.models.some((ref) => catalogModel(rc, ref)?.api === CODEX_API) ?? false;
  return [...roster.routing.fallback]
    .filter(([from, to]) => usesCodex(to) && !usesCodex(from))
    .map(
      ([from, to]) =>
        `Warning: the fallback ${from} → ${to} moves a run onto the ${CODEX_API} API mid-run, with a system prompt pi-cache-optimizer may have rewritten for ${from}, which Codex can refuse.`,
    );
}

export function statusText(host: CommandHost, ctx: ExtensionContext): string {
  const { roster, labels } = host.refresh();
  const pin = host.pinOf(ctx);
  const session = host.session(ctx);
  const lines = [
    "pi-smart-router status",
    `Roster: ${rosterLine(roster)}`,
    `Selection: ${describeModel(ctx.model)}, thinking ${attempt(() => host.pi.getThinkingLevel(), "unknown")}`,
    `Pin: ${describePin(pin)}`,
  ];
  const lock = lockLine(session?.guard.lock);
  if (lock !== undefined) lines.push(lock);
  if (roster.kind === "ok") {
    lines.push("Roles on this host, cheapest first:", ...roleLines(host, ctx, roster.value, pin), ...accountLines(ctx, roster.value, labels));
    if (roster.value.version === 1) lines.push(routingLine(roster.value), ...codexWarnings(host, ctx, roster.value));
  }
  const last = session?.history.at(-1);
  lines.push(`Last decision: ${last === undefined ? "none yet" : describeEntry(last)}`);
  lines.push(egress(host.pi));
  return lines.join("\n");
}

export function historyText(host: CommandHost, ctx: ExtensionContext, count: number): string {
  const entries = host.session(ctx)?.history.slice(-count) ?? [];
  if (entries.length === 0) return "pi-smart-router: no routing decisions in this session yet.";
  return [`pi-smart-router: the last ${entries.length} routing decisions, oldest first:`, ...entries.map((entry) => `  ${describeEntry(entry)}`)].join("\n");
}

/** The latest physical response on the branch, when it came from a model outside the policy. */
function earlierRemote(ctx: ExtensionContext, policy: LocalPolicy): string | undefined {
  const entries = boundedHistory(ctx.sessionManager)?.getRecentActiveEntries({ type: "message", messageRole: "assistant", limit: 16 }) ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const message = isRecord(entry) ? entry.message : undefined;
    if (!isRecord(message)) continue;
    const { provider, model } = message;
    if (typeof provider !== "string" || typeof model !== "string" || provider === PROVIDER || message.api === VIRTUAL_API) continue;
    const found = ctx.modelRegistry.find(provider, model);
    return found !== undefined && checkLocal(found, policy, false).ok ? undefined : `${provider}/${model}`;
  }
  return undefined;
}

const info = (text: string): Answer => ({ text, type: "info" });
const warning = (text: string): Answer => ({ text, type: "warning" });

async function localOn(host: CommandHost, ctx: ExtensionContext): Promise<Answer> {
  if (boundedHistory(ctx.sessionManager) === undefined) {
    return warning("pi-smart-router: this Pi cannot read pin entries (it has no bounded session history), so every session already counts as pinned.");
  }
  const { roster } = host.refresh();
  const policy = roster.kind === "ok" ? policyFromRoster(roster.value) : EMPTY_POLICY;
  const empty = policy.refs.length === 0;
  host.pi.appendEntry(PIN_ENTRY, pinOn(policy, host.now()));
  const lines = [
    empty
      ? `pi-smart-router: this session is pinned to local models, but ${roster.kind === "ok" ? "the roster has no local section" : `the roster is ${roster.kind}`}, so the pin has an empty policy and no model qualifies. Fix the roster, then run /smart-router local on again.`
      : `pi-smart-router: this session is pinned to local models, with ${describePolicy(policy)}.`,
  ];
  const before = describeModel(ctx.model);
  const allowed = await host.guards.switchToLocal(ctx);
  if (!allowed) {
    lines.push(`The selection ${describeModel(ctx.model)} is not local and could not be switched to smart-router/local, so prompts are refused until you choose a local model.`);
  } else if (describeModel(ctx.model) !== before) {
    lines.push(`The selection is ${describeModel(ctx.model)} now.`);
  }
  const earlier = earlierRemote(ctx, policy);
  if (earlier !== undefined) {
    lines.push(`Earlier turns of this branch went to ${earlier}, which is not local: they have already left this machine, and the pin protects only what follows.`);
  }
  lines.push(egress(host.pi));
  host.guards.showStatus(ctx);
  const text = lines.join("\n");
  return empty || !allowed ? warning(text) : info(text);
}

async function localOff(host: CommandHost, ctx: ExtensionContext): Promise<Answer> {
  const pin = host.pinOf(ctx);
  if (pin.env) {
    return warning("pi-smart-router: PI_SMART_ROUTER_LOCAL_ONLY pins every session in this process, so this one cannot be unpinned. Start Pi without it to unpin.");
  }
  if (pin.entry === "unreadable") {
    return warning("pi-smart-router: this Pi cannot read pin entries (it has no bounded session history), so an unpinning entry would not be seen; the session stays pinned.");
  }
  if (!pin.on) {
    host.guards.unlock(ctx);
    host.guards.showStatus(ctx);
    return info("pi-smart-router: this session is not pinned.");
  }
  if (!ctx.hasUI) return warning("pi-smart-router: /smart-router local off asks for confirmation, and this mode has no dialogs, so the session stays pinned.");
  // Only the one answer unpins: Escape, a timeout, a cancelled dialog and anything else keep the pin.
  const answer = await ctx.ui.select(UNPIN_QUESTION, [KEEP_PIN, UNPIN]);
  if (answer !== UNPIN) return info("pi-smart-router: the session stays pinned to local models.");
  host.pi.appendEntry(PIN_ENTRY, pinOff(host.now()));
  host.guards.unlock(ctx);
  host.guards.showStatus(ctx);
  return warning(`pi-smart-router: this session is no longer pinned, and the selection stays ${describeModel(ctx.model)}. The next requests may go to cloud models.`);
}

function localStatus(host: CommandHost, ctx: ExtensionContext): Answer {
  const lines = [`pi-smart-router: pin ${describePin(host.pinOf(ctx))}.`];
  const lock = lockLine(host.session(ctx)?.guard.lock);
  if (lock !== undefined) lines.push(lock);
  lines.push(egress(host.pi));
  return info(lines.join("\n"));
}

function reload(host: CommandHost, ctx: ExtensionContext): Answer {
  const { roster, labels, limitsChanged } = host.reload(ctx);
  const parts = [`pi-smart-router: reloaded the roster, ${rosterLine(roster)}`];
  if (labels !== undefined) parts.push(`Multi-Pass's labels ${labels.kind === "ok" ? "read" : `${labels.kind} (${labels.error})`}`);
  if (limitsChanged) parts.push("and registered both models again with their new limits");
  const text = `${parts.join("; ")}.`;
  return roster.kind === "ok" ? info(text) : warning(text);
}

/** What the command answers, for the arguments after /smart-router. */
export async function run(host: CommandHost, ctx: ExtensionContext, args: string): Promise<Answer> {
  const [sub = "status", option, extra] = args.trim().split(/\s+/).filter((word) => word !== "");
  if (sub === "status" && option === undefined) return info(statusText(host, ctx));
  if (sub === "history" && extra === undefined) {
    const count = option === undefined ? HISTORY_DEFAULT : Number(option);
    if (Number.isSafeInteger(count) && count >= 1) return info(historyText(host, ctx, Math.min(count, HISTORY_LIMIT)));
  }
  if (sub === "local" && extra === undefined) {
    if (option === "on") return localOn(host, ctx);
    if (option === "off") return localOff(host, ctx);
    if (option === "status" || option === undefined) return localStatus(host, ctx);
  }
  if (sub === "reload" && option === undefined) return reload(host, ctx);
  return warning(USAGE);
}

export function smartRouterCommand(host: CommandHost): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "Smart Router: status, history [n], local on|off|status, reload",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      let answer: Answer;
      try {
        answer = await run(host, ctx, args);
      } catch (error) {
        answer = { text: `pi-smart-router: /smart-router failed: ${firstLine(error)}`, type: "error" };
      }
      ctx.ui.notify(answer.text, answer.type);
    },
  };
}
