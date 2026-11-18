// /smart-router: status (the default), history [n], scope [work|personal|status], was
// low|medium|high|super, check, and reload. It reports through notices, and the only things it
// writes are the scope's session entries and a run's correction. `local`, whatever follows, answers
// that the local-only pin of earlier versions has been removed, and writes nothing.
//
// status shows the roster's state, the selection, the session's scope, each role's
// candidates on this host with the resolver's verdict and the catalog price, the account bindings
// checked in the session's scope, with each provider's auth source (never a credential), a version 1
// roster's routing table or a version 2 roster's levels and fallback chain in each scope and its
// classifier, the last decision, whether the last request went to a fallback chain's model, what can still send data off the machine, and a warning for any version 1 fallback that
// moves a run onto Codex's API from another one. It replaces upstream's doctor, plan, stats, pricing
// and mode commands.
//
// check reads the roster again and prints what it routes to, for each selection and scope and in
// the order tried, or its first error with its place (src/check.ts). It changes nothing and sends
// nothing, and the standalone src/check-cli.ts prints the same for any file without a session.
//
// No command moves the selection: scope work changes what the router's own models do, and says what
// the selection John keeps will do next (src/selection.ts).
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";

import { checkAccount, subscriptionKind } from "./accounts.ts";
import { describeRouting } from "./check.ts";
import type { Labels } from "./accounts.ts";
import { LEVEL_ENTRY, PROVIDER, SCOPE_ENTRY } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { firstLine, PIN_REMOVED, rosterNamed } from "./errors.ts";
import type { Loaded } from "./files.ts";
import { promptLines, promptProblem, promptUses } from "./prompts.ts";
import type { PromptReader } from "./prompts.ts";
import { correctionRecord, levelNote, levelRecord, readLevelRecord } from "./records.ts";
import type { LevelRecord } from "./records.ts";
import { clock, describeHold, resolveCandidate } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { boundedHistory, HISTORY_LIMIT } from "./route.ts";
import type { HistoryEntry, PendingLevel } from "./route.ts";
import { autoRoles, parseRef, scopeSection, SCOPES, servesScope } from "./roster.ts";
import type { Roster, RosterV1, RosterV2, Scope } from "./roster.ts";
import { scopeEntry } from "./scope.ts";
import type { ScopeState } from "./scope.ts";
import { describeModel, ownModel } from "./selection.ts";
import { isTier, tierLabel, TIERS } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

export interface Files {
  readonly roster: Loaded<Roster>;
  /** Multi-Pass's labels, read only when the roster binds an alias. */
  readonly labels: Loaded<Labels> | undefined;
}

/** What the command needs of its router instance. */
export interface CommandHost {
  readonly pi: Pick<ExtensionAPI, "appendEntry" | "getAllTools" | "getCommands" | "getThinkingLevel">;
  readonly now: () => number;
  /** Re-stat both files, and read them again when they changed. */
  refresh(): Files;
  /** Read both files again now, and register both models again when their declared limits changed. */
  reload(ctx: ExtensionContext): Files & { readonly limitsChanged: boolean };
  /** The session's scope, as routing reads it: the latch, the session's entry, then the work directories. */
  scopeOf(ctx: ExtensionContext): ScopeState;
  /** The session's records: its decisions, and the level of the run planned or in flight, marked once that run starts. */
  session(ctx: ExtensionContext): { readonly history: readonly HistoryEntry[]; readonly pendingLevel: PendingLevel | undefined } | undefined;
  /** A resolver context for one of the two models, built as routing builds it: in the session's scope, or in `scope`. */
  resolver(ctx: ExtensionContext, roster: Roster, id: VirtualId, scope?: Scope): ResolveContext;
  /** A prompt file the roster names, as the router last loaded it; refresh() and reload() load them with the roster. */
  readonly readPrompt: PromptReader;
}

/** A notice the command shows. */
export interface Answer {
  readonly text: string;
  readonly type: "info" | "warning" | "error";
}

const USAGE = "Usage: /smart-router [status] | history [n] | scope [work|personal|status] | was low|medium|high|super | check | reload";
const HISTORY_DEFAULT = 10;
const CODEX_API = "openai-codex-responses";

/** How a session whose scope cannot be read gets one again. */
const UNTIL_RECORDED = "until /smart-router scope work or /smart-router scope personal records it again";
/** What a model picked by hand does in a work session: the same as anywhere. */
const BY_HAND = "A model picked by hand is sent as it is, in work scope too.";
/** What smart-router/local's route does in a work session: the same as in personal scope. */
const LOCAL_IN_WORK = "In work scope smart-router/local routes to the local models, so its next requests go to them, not to the work account.";

/**
 * What /smart-router scope personal asks a session in work scope, and its two answers. Pi's
 * selector starts on the first answer, so Enter keeps work scope. Pi's own confirm dialog is a
 * selector over Yes and No that starts on Yes, so it is not used here.
 */
const MOVE_QUESTION = "Move this session to personal scope?\nIts earlier turns are work content, and the next requests would send them to personal accounts.";
const KEEP_WORK = "Keep this session in work scope";
const TO_PERSONAL = "Move it to personal scope (earlier turns are work content)";

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

/**
 * What can send data off this machine besides the models the router's own two models route to
 * (design §5.2, §5.3): first a model picked by hand, which the router does not route, then the
 * classifier smart-router/auto asks about each message, then other extensions' commands and tools,
 * and Pi's own commands.
 */
export function egress(pi: Pick<ExtensionAPI, "getAllTools" | "getCommands">, classifier?: string): string {
  const commands = new Set(attempt(() => pi.getCommands(), []).filter((command) => command.source === "extension").map((command) => command.name));
  const parts = ["a model picked by hand with /model, which is sent as it is"];
  if (classifier !== undefined) parts.push(`the classifier ${classifier} (smart-router/auto sends it each message and the recent conversation, redacted)`);
  parts.push(...EGRESS_COMMANDS.filter(([name]) => commands.has(name)).map(([name, what]) => `/${name} (${what})`));
  const tools = [...new Set(attempt(() => pi.getAllTools(), []).map((tool) => tool.name).filter((name) => EGRESS_TOOL.test(name)))].sort();
  if (tools.length > 0) parts.push(`the tools ${tools.join(", ")}`);
  parts.push("Pi's own /share, /export and /bug");
  return `Besides the models smart-router/auto and smart-router/local route to, these can send data off this machine: ${parts.join("; ")}.`;
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

/** A decision, and on a version 2 run's planned request, its scope, tier and what decided the tier. */
function describeEntry(entry: HistoryEntry): string {
  const trigger = entry.trigger === undefined ? "" : `, ${entry.trigger}`;
  const { level } = entry;
  const tier = level === undefined ? "" : ` [${level.scope} ${tierLabel(level.tier)} (${levelNote(level)})]`;
  return `${stamp(entry.at)} ${PROVIDER}/${entry.virtual} ${entry.reason}: ${entry.role} → ${entry.ref} (${entry.code}${trigger})${entry.foreign ? ", foreign" : ""}${tier}`;
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

/** A candidate and the resolver's verdict on it. */
function verdict(ref: string, rc: ResolveContext): string {
  const resolution = resolveCandidate(ref, rc);
  return `${ref} ${resolution.ok ? "ok" : resolution.reason}`;
}

/** Each role's candidates with their verdicts and prices: auto's roles as `auto` resolves them, in the session's scope, and the local role as smart-router/local does. */
function roleLines(host: CommandHost, ctx: ExtensionContext, roster: Roster, auto: ResolveContext): string[] {
  const localRole = roster.local?.role;
  const local = host.resolver(ctx, roster, "local");
  const reached = autoRoles(roster, auto.scope);
  const chains = SCOPES.filter((scope) => scopeSection(roster, scope)?.fallback !== undefined);
  return roster.roles.map((role) => {
    const rc = role.name === localRole ? local : auto;
    const tags = [
      role.name === localRole ? "the local role" : undefined,
      ...chains.filter((scope) => scopeSection(roster, scope)?.fallback?.includes(role.name)).map((scope) => `a ${scope} fallback`),
      role.name !== localRole && !reached.has(role.name) ? "smart-router/auto never routes here" : undefined,
      role.thinking === "selected" ? undefined : `thinking ${role.thinking}`,
    ].filter((tag) => tag !== undefined);
    const candidates = role.models.map((ref) => `${verdict(ref, rc)}${price(catalogModel(rc, ref))}`);
    return `  ${role.name}${tags.length > 0 ? ` (${tags.join("; ")})` : ""}: ${candidates.join(", ")}`;
  });
}

function authSource(ctx: ExtensionContext, provider: string): string {
  return attempt(() => {
    const status = ctx.modelRegistry.getProviderAuthStatus(provider);
    return status.configured ? `configured${status.source === undefined ? "" : ` (${status.source})`}` : "not configured";
  }, "unknown");
}

/** Each subscription provider's binding, checked as routing checks it in the session's scope, which version 1 ignores. */
function accountLines(ctx: ExtensionContext, roster: Roster, labels: Loaded<Labels> | undefined, scope: Scope): string[] {
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
      const check = checkAccount(provider, roster, labels, scope);
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
  const rc = host.resolver(ctx, roster, "auto");
  const usesCodex = (name: string): boolean => roster.roles.find((role) => role.name === name)?.models.some((ref) => catalogModel(rc, ref)?.api === CODEX_API) ?? false;
  return [...roster.routing.fallback]
    .filter(([from, to]) => usesCodex(to) && !usesCodex(from))
    .map(
      ([from, to]) =>
        `Warning: the fallback ${from} → ${to} moves a run onto the ${CODEX_API} API mid-run, with a system prompt pi-cache-optimizer may have rewritten for ${from}, which Codex can refuse.`,
    );
}

/**
 * The session's scope, under a version 2 roster, and whenever smart-router/auto refuses it, such as a
 * latched process's whose roster has no work scope. A version 1 roster in personal scope has none.
 */
function scopeLine(roster: Roster, scope: ScopeState): string | undefined {
  if (scope.kind === "unreadable") return `Scope: unreadable (${scope.reason}), so smart-router/auto refuses every request ${UNTIL_RECORDED}.`;
  const named = `Scope: ${scope.scope} (${scope.source})`;
  if (!servesScope(roster, scope.scope)) return `${named}, which ${rosterNamed(roster.version)} does not serve, so smart-router/auto refuses every request.`;
  return roster.version === 2 ? named : undefined;
}

/**
 * Why smart-router/auto refuses a session in work scope, if it does, and the way out: a roster that
 * did not load, or one that serves no work scope, as status's Scope line reads it (servesScope).
 * Outside the latch, /smart-router scope personal is a way out too.
 */
function workRefusal(roster: Loaded<Roster>, scope: ScopeState & { readonly kind: "ok" }): string | undefined {
  if (roster.kind !== "ok") return "It is in work scope, but the roster did not load, so smart-router/auto refuses its requests until it is fixed; see /smart-router status.";
  if (servesScope(roster.value, "work")) return undefined;
  const give = `give the roster a work scope${roster.value.version === 1 ? " (version 2)" : ""}`;
  return `It is in work scope, which ${rosterNamed(roster.value.version)} does not serve, so smart-router/auto refuses its requests: ${give}${scope.source === "latch" ? "" : ", or run /smart-router scope personal"}.`;
}

/**
 * A selection that is not smart-router/auto: a model picked by hand, or smart-router/local. In a
 * work session, the first is sent as it is and the second routes to the local models, not to the
 * work account. No command changes either: scope work says which it is, and leaves the choice to
 * John.
 */
function otherSelection(ctx: ExtensionContext): "hand" | "local" | undefined {
  if (ctx.model === undefined) return undefined;
  const own = ownModel(ctx.model);
  return own === undefined ? "hand" : own === "local" ? "local" : undefined;
}

/**
 * Each scope's tiers, low to super, with each tier's own candidates and the verdicts they get in
 * that scope, and, when any scope declares a fallback chain, each scope's chain in its order, or
 * that it has none.
 */
function levelLines(host: CommandHost, ctx: ExtensionContext, roster: RosterV2): string[] {
  const anyChain = SCOPES.some((scope) => roster.scopes[scope]?.fallback !== undefined);
  return SCOPES.flatMap((scope) => {
    const section = roster.scopes[scope];
    if (section === undefined) return [];
    const rc = host.resolver(ctx, roster, "auto", scope);
    const modelsOf = (name: string): readonly string[] => roster.roles.find((role) => role.name === name)?.models ?? [];
    const tiers = TIERS.map((tier) => `${tierLabel(tier)} → ${modelsOf(section.levels[tier].role).map((ref) => verdict(ref, rc)).join(", ")}`);
    const lines = [`Levels (${scope}): ${tiers.join("; ")}`];
    if (section.fallback !== undefined) {
      const chain = section.fallback.map((name) => `${name} → ${modelsOf(name).map((ref) => verdict(ref, rc)).join(", ")}`);
      lines.push(`Fallback (${scope}), after any level's own models, in this order: ${chain.join("; ")}`);
    } else if (anyChain) {
      lines.push(`Fallback (${scope}): none, so a level with no available model passes its run up or refuses it`);
    }
    return lines;
  });
}

/** The accounts cooling now, one line each however many models wait for them, then the local models skipped because their servers could not be reached. */
function holdLines(rc: ResolveContext): string[] {
  const accounts = rc.cooldowns
    .accounts(rc.now)
    .map(({ provider, until }) => `Cooling: the account ${provider}, every model of it, until ${clock(until)} after a usage-limit or authentication error`);
  return accounts.concat(
    (rc.holds?.active(rc.now) ?? []).map((hold) => `Unreachable: ${hold.ref} is ${describeHold(hold).detail}; it is tried again sooner if nothing else can take a request`),
  );
}

/** Said when the session's last request on smart-router/auto went to a model of a scope's fallback chain. */
function onFallbackLine(roster: RosterV2, last: HistoryEntry | undefined): string | undefined {
  if (last === undefined || last.virtual !== "auto") return undefined;
  const scope = SCOPES.find((name) => roster.scopes[name]?.fallback?.includes(last.role));
  if (scope === undefined) return undefined;
  return `On a fallback: the last request went to ${last.ref}, in the ${scope} fallback role ${last.role}; each new run tries its level's own models first.`;
}

function classifierLine(roster: RosterV2): string {
  const settings = roster.classifier;
  return settings === undefined
    ? "Classifier: none, so the heuristics alone weigh every prompt's demand"
    : `Classifier: ${settings.model}, ${settings.timeoutMs} ms`;
}

/**
 * The prompt sources in effect, when the roster has a classifier and any of them is John's own: an
 * inline instruction or a file. A roster that only gives its levels' describe texts inline, as
 * every roster before 1.4.0-jw.4 does, shows the one line that says so.
 */
function promptStatus(host: CommandHost, roster: RosterV2): string[] {
  if (roster.classifier === undefined) return [];
  const uses = promptUses(roster, host.readPrompt);
  if (uses.every((use) => use.source === "inline" || use.source === "built-in") && uses[0]?.source === "built-in") {
    return ["Prompts: the built-in instructions, and each level's describe from the roster"];
  }
  const problem = promptProblem(uses);
  return ["Prompts:", ...promptLines(uses), ...(problem === undefined ? [] : [`Prompt problem: ${problem}`])];
}

/** The classifier smart-router/auto can ask about a message: a version 2 roster's. */
function classifierOf(roster: Loaded<Roster>): string | undefined {
  return roster.kind === "ok" && roster.value.version === 2 ? roster.value.classifier?.model : undefined;
}

export function statusText(host: CommandHost, ctx: ExtensionContext): string {
  const { roster, labels } = host.refresh();
  const session = host.session(ctx);
  const lines = [
    "pi-smart-router status",
    `Roster: ${rosterLine(roster)}`,
    `Selection: ${describeModel(ctx.model)}, thinking ${attempt(() => host.pi.getThinkingLevel(), "unknown")}`,
  ];
  const scope = roster.kind === "ok" ? scopeLine(roster.value, host.scopeOf(ctx)) : undefined;
  if (scope !== undefined) lines.push(scope);
  if (roster.kind === "ok") {
    const { value } = roster;
    const auto = host.resolver(ctx, value, "auto");
    lines.push("Roles on this host, cheapest first:", ...roleLines(host, ctx, value, auto), ...accountLines(ctx, value, labels, auto.scope));
    if (value.version === 1) lines.push(routingLine(value), ...codexWarnings(host, ctx, value));
    else lines.push(...levelLines(host, ctx, value), classifierLine(value), ...promptStatus(host, value));
    lines.push(...holdLines(auto));
  }
  const last = session?.history.at(-1);
  lines.push(`Last decision: ${last === undefined ? "none yet" : describeEntry(last)}`);
  const onFallback = roster.kind === "ok" && roster.value.version === 2 ? onFallbackLine(roster.value, last) : undefined;
  if (onFallback !== undefined) lines.push(onFallback);
  lines.push(egress(host.pi, classifierOf(roster)));
  return lines.join("\n");
}

export function historyText(host: CommandHost, ctx: ExtensionContext, count: number): string {
  const entries = host.session(ctx)?.history.slice(-count) ?? [];
  if (entries.length === 0) return "pi-smart-router: no routing decisions in this session yet.";
  return [`pi-smart-router: the last ${entries.length} routing decisions, oldest first:`, ...entries.map((entry) => `  ${describeEntry(entry)}`)].join("\n");
}

const info = (text: string): Answer => ({ text, type: "info" });
const warning = (text: string): Answer => ({ text, type: "warning" });

/** The session's scope, as /smart-router scope answers it. */
function scopeAnswer(scope: ScopeState): Answer {
  return scope.kind === "ok"
    ? info(`pi-smart-router: scope ${scope.scope} (${scope.source}).`)
    : warning(`pi-smart-router: this session's scope cannot be read (${scope.reason}), so smart-router/auto refuses it ${UNTIL_RECORDED}.`);
}

/**
 * Personal to work takes effect at once: the entry is recorded, and the answer says when
 * smart-router/auto refuses the scope. Changing the scope asks for no routing, so the selection
 * stays: the answer says what a model picked by hand, or smart-router/local, does in work scope.
 */
function scopeWork(host: CommandHost, ctx: ExtensionContext, roster: Loaded<Roster>): Answer {
  host.pi.appendEntry(SCOPE_ENTRY, scopeEntry("work", "command", host.now()));
  const scope = host.scopeOf(ctx);
  const answer = scopeAnswer(scope);
  const lines = [answer.text];
  let warned = answer.type !== "info";
  // A scope that cannot be read, which only a Pi without bounded history gives here, is answered above.
  const refused = scope.kind === "ok" ? workRefusal(roster, scope) : undefined;
  const selection = otherSelection(ctx);
  if (selection === "hand") {
    lines.push(`The selection stays ${describeModel(ctx.model)}. ${BY_HAND}`);
  } else if (selection === "local") {
    // smart-router/local routes to the LAN models in either scope.
    lines.push(`The selection stays smart-router/local. ${LOCAL_IN_WORK}`);
  }
  if (refused !== undefined) {
    lines.push(refused);
    warned = true;
  }
  return warned ? warning(lines.join("\n")) : info(lines.join("\n"));
}

/**
 * Work to personal asks first, and says that the earlier turns are work content;
 * a scope that cannot be read counts as work, as routing treats it. Under the latch it is refused.
 * The selection stays as it is.
 */
async function scopePersonal(host: CommandHost, ctx: ExtensionContext): Promise<Answer> {
  const scope = host.scopeOf(ctx);
  if (scope.kind === "ok" && scope.source === "latch") {
    return warning("pi-smart-router: PI_SMART_ROUTER_SCOPE pins every session of this process to work scope, so this one cannot be moved to personal.");
  }
  const fromWork = scope.kind !== "ok" || scope.scope === "work";
  if (fromWork) {
    if (!ctx.hasUI) return warning("pi-smart-router: /smart-router scope personal asks for confirmation, and this mode has no dialogs, so the session stays in work scope.");
    // Only the one answer moves the session: Escape, a timeout, a cancelled dialog and anything else keep work scope.
    const answer = await ctx.ui.select(MOVE_QUESTION, [KEEP_WORK, TO_PERSONAL]);
    if (answer !== TO_PERSONAL) return info("pi-smart-router: the session stays in work scope.");
  }
  host.pi.appendEntry(SCOPE_ENTRY, scopeEntry("personal", "command", host.now()));
  const answer = scopeAnswer(host.scopeOf(ctx));
  return fromWork ? warning(answer.text) : answer;
}

/** The scope subcommands, which read the roster as it is now: its work directories decide a session without an entry. */
async function scopeCommand(host: CommandHost, ctx: ExtensionContext, option: string | undefined): Promise<Answer | undefined> {
  if (option !== undefined && option !== "status" && option !== "work" && option !== "personal") return undefined;
  const { roster } = host.refresh();
  if (option === "work") return scopeWork(host, ctx, roster);
  if (option === "personal") return scopePersonal(host, ctx);
  return scopeAnswer(host.scopeOf(ctx));
}

/**
 * A correction of the last run: a label only, appended as a record of its own, and nothing is sent
 * again. A correction of a correction corrects the same run.
 *
 * Pi runs a command at once while a run streams, and a run has no record until the router's
 * agent_settled handler writes it, though the footer already shows it. So a run whose level the
 * router bound to it when it started is the run corrected until then, by the `at` and scope its
 * record will carry, whatever Pi says of idleness meanwhile: after the run ends, another extension's
 * agent_settled handler can still be running. Otherwise the run is the latest on this branch. A
 * pending level that no run took, such as a message's that a later extension handled, is never the
 * run corrected.
 */
function was(host: CommandHost, ctx: ExtensionContext, tier: Tier): Answer {
  const pending = host.session(ctx)?.pendingLevel;
  const inFlight = pending?.started === true ? pending : undefined;
  let previous: LevelRecord | undefined;
  if (inFlight !== undefined) {
    previous = levelRecord(inFlight, undefined, false);
  } else {
    const latest = boundedHistory(ctx.sessionManager)?.getLatestCustomEntry(LEVEL_ENTRY, { scope: "active" });
    if (latest === undefined || latest === null) return warning("pi-smart-router: no routed run to correct in this session yet.");
    previous = readLevelRecord(latest);
    if (previous === undefined) return warning("pi-smart-router: the latest smart-router.level entry is not one the router wrote, so there is no run to correct.");
  }
  host.pi.appendEntry(LEVEL_ENTRY, correctionRecord(previous, tier, host.now()));
  return info(`pi-smart-router: recorded that the last run should have been ${tierLabel(tier)}.`);
}

/**
 * The roster as it is on disk now, read back: what each selection and scope routes to, or why the
 * router refuses it. A check only: nothing is selected, recorded or sent.
 */
function check(host: CommandHost): Answer {
  const { roster } = host.refresh();
  const head = `pi-smart-router check: ${rosterLine(roster)}`;
  if (roster.kind !== "ok") {
    return warning(`${head}\nBoth smart-router/auto and smart-router/local refuse every request until it is fixed. Nothing was changed.`);
  }
  const uses = roster.value.version === 2 ? promptUses(roster.value, host.readPrompt) : [];
  const problem = promptProblem(uses);
  const lines = [head, ...(problem === undefined ? [] : [`PROMPT NOT USABLE: ${problem}`]), "", ...describeRouting(roster.value, uses)];
  return problem === undefined ? info(lines.join("\n")) : warning(lines.join("\n"));
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
  // The local-only pin has been removed: whatever follows, the answer says so and writes nothing.
  if (sub === "local") return warning(PIN_REMOVED);
  if (sub === "scope" && extra === undefined) {
    const answer = await scopeCommand(host, ctx, option);
    if (answer !== undefined) return answer;
  }
  if (sub === "was" && extra === undefined) {
    // The footer shows tiers in capitals, so a tier is taken in any case.
    const tier = option?.toLowerCase();
    if (isTier(tier)) return was(host, ctx, tier);
  }
  if (sub === "check" && option === undefined) return check(host);
  if (sub === "reload" && option === undefined) return reload(host, ctx);
  return warning(USAGE);
}

export function smartRouterCommand(host: CommandHost): Omit<RegisteredCommand, "name" | "sourceInfo"> {
  return {
    description: "Smart Router: status, history [n], scope [work|personal|status], was low|medium|high|super, check, reload",
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
