// One instance of the router: the session whose extension runtime loaded it, the files it reads
// (the roster, Multi-Pass's labels and the prompt files the roster names), its per-session records
// (each with the ledger its session's answers feed, which prices a planned run) and cooldowns, the
// limits both models declare, the session's scope with its handoffs and work directories, the
// refusals of its own two models for a scope their policy does not serve, a message's tag and Jev's
// request, each planned run's level record and the footer item that shows its level, the notices
// that the removed local-only pin's switch and entries are ignored, the /smart-router command, what
// it tells pi-cache-optimizer, and the handlers wire() registers. No handler changes or blocks what
// is selected (src/selection.ts).
//
// createRouter only builds closures. It makes no pi.on, registration or command call, so a throw
// while it is built leaves only the two refusing models index.ts registered, and wire() makes
// every pi.on and registerCommand call in one place, after the router exists. No timer, watcher,
// socket or other handle is ever opened; the files are read at session_start, at idle prompts when
// they changed, and on demand. Jev is asked through Pi's model registry, which makes the request.
// No message text is kept: a keyed digest of it binds a plan to its message's run.
import { createHmac, randomBytes } from "node:crypto";

import type { Api, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  MessageEndEvent,
  ModelRoute,
  ModelRouteRequest,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import { labelsFile, needsLabels } from "./accounts.ts";
import { registerAdapter, unregisterAdapter } from "./cache-optimizer.ts";
import type { ActiveRoute } from "./cache-optimizer.ts";
import { smartRouterCommand } from "./commands.ts";
import type { CommandHost, Files } from "./commands.ts";
import { ALL_LEVELS, COMMAND, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, LEVEL_ENTRY, LEVEL_KEY, PIN_ENTRY, PROVIDER, SCOPE_ENTRY, VIRTUAL_API, VIRTUAL_IDS } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { compactionFor, pickInRole, planUserTurn } from "./decide.ts";
import type { CostFigures, Decision, LastResponder, LevelInput, Plan } from "./decide.ts";
import { HEURISTIC_MESSAGES, rolesOf } from "./demand.ts";
import type { PromptFacts } from "./demand.ts";
import {
  directoryFailedNotice,
  directoryNotice,
  escalationNotice,
  fallbackMoveNotice,
  fallbackNotice,
  firstLine,
  historyNotice,
  looksRetryable,
  pinEntryNotice,
  pinEnvNotice,
  promptNotice,
  resendNotice,
  rosterNotice,
  rosterRefusal,
  scopeCarriedNotice,
  scopeCarryFailedNotice,
  scopeUnreadable,
  scopeUnserved,
  stale,
  stepUpNotice,
  tagIgnoredNotice,
  tagOnlyNotice,
  unmatchedTagNotice,
} from "./errors.ts";
import type { RouterError, TagIgnored } from "./errors.ts";
import { isRecord, own } from "./files.ts";
import type { FileSystem, Loaded } from "./files.ts";
import { askJev, buildContext, jevAsk, recentMessages } from "./jev.ts";
import type { JevAsk, JevOutcome } from "./jev.ts";
import { answerOf, forgetBranch, forgetCaches, noteAnswer, noteRunEnd, seedAnswer } from "./ledger.ts";
import type { Ledger } from "./ledger.ts";
import { policyFromRoster } from "./local.ts";
import { healDisplaced, isLive, isLiveOwner, join, leave, leaveScopeHandoff, ownerBySignal, rememberedRoster, rememberRoster, scopeLatched, sessionHash, takeScopeHandoff } from "./owners.ts";
import type { Owner, OwnerRouter, RosterMemory, Slot } from "./owners.ts";
import { promptProblem, promptStore, promptUses, scopePrompts } from "./prompts.ts";
import { footerText, levelRecord, readLevelRecord } from "./records.ts";
import { clock, coolFrom, Cooldowns, coolsAccount, hasOutput, holdFrom, Holds, resolveContext } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { activeEntries, afterFailure, boundedHistory, newRecord, planApplies, predict, requireBoundedHistory, routeOther, routeOwned } from "./route.ts";
import type { BoundedHistory, Failover, LastInput, RouteInput, SessionRecord } from "./route.ts";
import { autoRoles, parseRef, roleOf, rosterFile, SCOPES, scopeSection, servesScope } from "./roster.ts";
import type { Roster, RosterV2, Scope } from "./roster.ts";
import { readScope, scopeEntry, workDirectoryOf } from "./scope.ts";
import type { ScopeEntryData, ScopeState, WorkDirectories } from "./scope.ts";
import { describeModel } from "./selection.ts";
import { parseTag } from "./tags.ts";
import type { Tagged } from "./tags.ts";
import type { Tier } from "./tiers.ts";

export interface Limits {
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({ contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS });

export interface RouterOptions {
  readonly slot: Slot;
  /** Register one virtual model, with the factory's route and these limits. */
  readonly register: (id: VirtualId, limits: Limits) => void;
  /** Pi's agent directory, asked afresh on every load. */
  readonly agentDir: () => string;
  readonly now: () => number;
  /** Test seams for the file reader. */
  readonly uid?: number | undefined;
  readonly fs?: FileSystem | undefined;
}

/**
 * What a router instance keeps per session: the route records, whether it tried to record the work
 * directories' scope, and what binds a plan to the run that uses it.
 */
export interface Session extends SessionRecord {
  /** Whether this instance has tried to record the scope the work directories gave the session. It tries once. */
  directoryTried: boolean;
  /** The token of the latest input that planned: an input that waited for Jev plans only if no newer input has planned since. */
  plannedToken: number;
  /** Whether this instance has looked for the session's old pin entry (pinEntryNotice). It looks once, on smart-router/auto. */
  pinEntryChecked: boolean;
  /** Whether the footer shows a level item this instance set: only then does a run without a level clear it. */
  levelShown: boolean;
  /** The model of the current run's last assistant message that ended without an error: the one its record names. */
  answered: string | undefined;
  /** The digest of the text, without its tag, of the message whose plan `plan` holds; meaningful only while `plan` is set. */
  planDigest: string | undefined;
  /** How many idle messages the router passed since the latest prompt's run started. */
  inputsSinceRun: number;
  /**
   * The digests of the texts, without tags, of the messages the router passed, busy or idle, whose
   * own runs have not started, each with how many such messages carry that text: the REMEMBERED most
   * recent texts, oldest first. A prompt's run forgets one message of its own text, so a held message
   * typed again is still remembered after the retyped one's run.
   */
  readonly remembered: Map<string, number>;
}

export interface Router extends OwnerRouter {
  /** Every route call of both models lands here, whichever instance registered the route. */
  dispatch(id: VirtualId, request: ModelRouteRequest, ctx: ExtensionContext): ModelRoute;
  /** Register every handler and the command, once. */
  wire(pi: ExtensionAPI): void;
  /** A session's records, for status and history. */
  record(sessionId: string): Readonly<Session> | undefined;
  /** The limits both models were last registered with. */
  limits(): Readonly<Record<VirtualId, Limits>>;
}

const BOTH_DEFAULT: Readonly<Record<VirtualId, Limits>> = Object.freeze({ auto: DEFAULT_LIMITS, local: DEFAULT_LIMITS });
const HANDLED: InputEventResult = Object.freeze({ action: "handled" });
/** How many messages whose runs have not started a session remembers (Session.remembered). */
const REMEMBERED = 64;
/** How far back session_start looks for the latest successful response. */
const SEED_ENTRIES = 16;

const virtualIdOf = (model: Model<Api> | undefined): VirtualId | undefined =>
  model?.provider === PROVIDER && (model.id === "auto" || model.id === "local") ? model.id : undefined;

function isUsage(value: unknown): value is Usage {
  return isRecord(value) && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => typeof value[key] === "number");
}

const THINKING_LEVELS: ReadonlySet<string> = new Set(ALL_LEVELS);
const isThinkingLevel = (value: unknown): value is ModelThinkingLevel => typeof value === "string" && THINKING_LEVELS.has(value);

/** What the ledger reads of a response entry responder() took: its model, usage, start and thinking level, each only when well formed. */
function seededAnswer(entry: unknown, usage: Usage): Parameters<typeof answerOf>[0] | undefined {
  const message = isRecord(entry) ? own(entry, "message") : undefined;
  if (!isRecord(message)) return undefined;
  const provider = own(message, "provider");
  const model = own(message, "model");
  if (typeof provider !== "string" || typeof model !== "string") return undefined;
  const timestamp = own(message, "timestamp");
  const thinkingLevel = own(message, "thinkingLevel");
  const providerThinkingLevel = own(message, "providerThinkingLevel");
  return {
    provider,
    model,
    usage,
    ...(typeof timestamp === "number" && Number.isFinite(timestamp) ? { timestamp } : {}),
    ...(isThinkingLevel(thinkingLevel) ? { thinkingLevel } : {}),
    ...(typeof providerThinkingLevel === "string" ? { providerThinkingLevel } : {}),
  };
}

/**
 * Whether Pi says the conversation's size is unknown: `ctx.getContextUsage()` gives `tokens: null`
 * right after a compaction, before the next response. A context without the call, one whose call
 * throws, and one that gives anything else say nothing.
 */
function sizeUnknown(ctx: ExtensionContext): boolean {
  try {
    const { getContextUsage } = ctx as { readonly getContextUsage?: unknown };
    if (typeof getContextUsage !== "function") return false;
    const usage: unknown = getContextUsage.call(ctx);
    return isRecord(usage) && own(usage, "tokens") === null;
  } catch {
    return false;
  }
}

/** The last responder without its usage: the conversation it measured is no longer the one sent. */
const withoutSize = (last: LastResponder | undefined): LastResponder | undefined => (last === undefined ? undefined : { ref: last.ref, at: last.at });

/** The smallest known window and output budget among the picks, else the defaults. */
function smallest(decisions: readonly Decision[]): Limits {
  let contextWindow = Infinity;
  let maxTokens = Infinity;
  for (const decision of decisions) {
    if (!decision.ok) continue;
    const { model } = decision.choice;
    if (model.contextWindow > 0) contextWindow = Math.min(contextWindow, model.contextWindow);
    if (model.maxTokens > 0) maxTokens = Math.min(maxTokens, model.maxTokens);
  }
  return {
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : DEFAULT_MAX_TOKENS,
  };
}

/** A shared window read that threw (demandWindow). */
const UNREAD = Symbol("unread");
/** The conversation an untagged input read for its demand and Jev, or UNREAD. */
type Window = readonly unknown[] | typeof UNREAD;

const sameLimits = (a: Readonly<Record<VirtualId, Limits>>, b: Readonly<Record<VirtualId, Limits>>): boolean =>
  VIRTUAL_IDS.every((id) => a[id].contextWindow === b[id].contextWindow && a[id].maxTokens === b[id].maxTokens);

/** What the scope reads of a valid roster: its work directories. */
const memoryOf = (value: Roster): RosterMemory => ({ directories: scopeSection(value, "work")?.directories ?? [] });

export function createRouter(pi: ExtensionAPI, options: RouterOptions): Router {
  const { slot, now } = options;
  const files = { agentDir: options.agentDir, uid: options.uid, fs: options.fs, now };
  const roster = rosterFile(files);
  const labels = labelsFile(files);
  const prompts = promptStore(files);
  const cooldowns = new Cooldowns();
  /** The local models passed over for a few minutes because their servers could not be reached (holdFrom in src/resolve.ts). */
  const holds = new Holds();
  const records = new Map<string, Session>();
  const reported = new Set<string>();
  let limits = BOTH_DEFAULT;
  let self: Owner | undefined;
  /** The latest valid roster this instance loaded, whose work directories and bindings the slot keeps. */
  let lastLoaded: Roster | undefined;
  /** How many idle inputs this instance has seen: each one's token. */
  let inputs = 0;
  /**
   * A message's text as the records hold it: its HMAC-SHA-256 under a key each instance draws at
   * random. Equal texts give equal digests, and the text is taken as its UTF-16 code units, so the
   * digests tell apart exactly the texts === does. Unlike a bare hash, a digest is no help in
   * guessing a short text without the key.
   */
  const key = randomBytes(32);
  const digestOf = (text: string): string => createHmac("sha256", key).update(text, "utf16le").digest("base64");

  const recordOf = (sessionId: string): Session => {
    let record = records.get(sessionId);
    if (record === undefined) {
      record = {
        ...newRecord(),
        directoryTried: false,
        plannedToken: 0,
        pinEntryChecked: false,
        levelShown: false,
        answered: undefined,
        planDigest: undefined,
        inputsSinceRun: 0,
        remembered: new Map(),
      };
      records.set(sessionId, record);
    }
    return record;
  };

  /** A context's session manager, or undefined when the context is stale. */
  const managerOf = (ctx: ExtensionContext): unknown => {
    try {
      return ctx.sessionManager;
    } catch {
      return undefined;
    }
  };

  /**
   * What the scope reads of the roster: its work directories as it is now, else, while it fails to
   * load, those of the last valid roster loaded in the process (the slot keeps them), else none.
   * Never throws: an agent directory that cannot be found counts as a roster that fails to load.
   */
  const rosterFacts = (): RosterMemory | undefined => {
    try {
      const state = loaded(roster.current());
      if (state.kind === "ok") return memoryOf(state.value);
    } catch {
      // As for a roster that fails to load.
    }
    return rememberedRoster(slot);
  };

  /**
   * The session's working directory and the work directories that rosterFacts gives; undefined
   * without any. Never throws: a stale context has none.
   */
  const workOf = (ctx: ExtensionContext): WorkDirectories | undefined => {
    try {
      const directories = rosterFacts()?.directories ?? [];
      if (directories.length === 0) return undefined;
      const { cwd } = ctx;
      return typeof cwd === "string" ? { cwd, directories } : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * A session's scope, read fail closed: the latch, the session's entry, then the work directories
   * that rosterFacts gives. A context whose session cannot be read has an unreadable scope.
   */
  const scopeOf = (ctx: ExtensionContext): ScopeState => readScope(managerOf(ctx), scopeLatched(slot), workOf(ctx));

  /**
   * The scope a session resolves in. A scope that cannot be read resolves in work scope, the
   * narrower one: prepare() refuses smart-router/auto for it, and smart-router/local's requests,
   * which carry no account, go to the local role there as in any scope.
   */
  const resolvedScope = (ctx: ExtensionContext): Scope => {
    const scope = scopeOf(ctx);
    return scope.kind === "ok" ? scope.scope : "work";
  };

  /** A resolver context in the session's scope, or in `scope`, which only /smart-router status names. */
  const contextFor = (ctx: ExtensionContext, value: Roster, id: VirtualId, scope: Scope = resolvedScope(ctx)): ResolveContext =>
    resolveContext({
      roster: value,
      catalog: ctx.modelRegistry,
      labels: needsLabels(value) ? labels.current() : undefined,
      cooldowns,
      holds,
      now: now(),
      virtualId: id,
      localOnly: id === "local",
      policy: policyFromRoster(value),
      scope,
    });

  /**
   * Every roster load passes here, so the slot keeps what the latest valid one says of work scope
   * (rosterFacts). Reading again a roster this instance already holds is no new load, so it leaves
   * in the slot a roster another instance loaded since.
   */
  const loaded = (state: Loaded<Roster>): Loaded<Roster> => {
    if (state.kind === "ok" && state.value !== lastLoaded) {
      lastLoaded = state.value;
      rememberRoster(slot, memoryOf(state.value));
    }
    return state;
  };

  /**
   * Whether Multi-Pass's labels matter with the roster as it loaded: it binds a Multi-Pass alias.
   * A roster that fails to load routes nothing, so no account is checked against them.
   */
  const labelsNeeded = (state: Loaded<Roster>): boolean => state.kind === "ok" && needsLabels(state.value);

  /** Re-read both files when they changed. Only here and on /smart-router reload, never in a route. */
  const refreshFiles = (): Loaded<Roster> => {
    const state = loaded(roster.refresh());
    if (labelsNeeded(state)) labels.refresh();
    // Jev's prompt files are John's to edit while a session runs: an edit is read where the roster's is.
    if (state.kind === "ok" && state.value.version === 2) prompts.refresh(state.value);
    return state;
  };

  /**
   * Why smart-router/auto refuses this session's scope, if it does: a scope that cannot be read, a
   * work-scope session under a version 1 roster, and a scope a version 2 roster has no section for.
   * Its way out is worded for a work session (chooseModel in src/errors.ts): a work or unreadable
   * scope.
   */
  const scopeRefusal = (value: Roster, ctx: ExtensionContext): RouterError | undefined => {
    const scope = scopeOf(ctx);
    if (scope.kind === "unreadable") return scopeUnreadable("auto", scope.reason, true);
    if (servesScope(value, scope.scope)) return undefined;
    // Outside the latch, /smart-router scope personal can move the session.
    return scopeUnserved("auto", scope.scope, value.version, scope.scope === "work", scope.source !== "latch");
  };

  /**
   * Why one of the router's models refuses this session for its scope, if it does. prepare() throws
   * the refusal; what pi-cache-optimizer is told and an input's plan follow it.
   *
   * Only smart-router/auto has one. Local-only requests carry no account, and selecting
   * smart-router/local is itself the request for local routing, so it refuses no scope, whatever
   * scopes the roster serves: neither scope (John's decision of 2026-11-16, "Let
   * smart-router/local route in work scope"), nor one that cannot be read (his decision of
   * 2026-11-17, "Let local route there too"). Such a request resolves in work scope
   * (resolvedScope), where a local model passes every check as it does in work scope itself.
   */
  const refusalFor = (id: VirtualId, value: Roster, ctx: ExtensionContext): RouterError | undefined => (id === "auto" ? scopeRefusal(value, ctx) : undefined);

  /** Pi's settings, for the compaction figures a route prices with; Pi's defaults (compactionFor) when they cannot be read. */
  const settingsNow = (): unknown => {
    try {
      return pi.getSettings();
    } catch {
      return undefined;
    }
  };

  const prepare = (id: VirtualId, request: ModelRouteRequest, ctx: ExtensionContext): RouteInput => {
    const { sessionManager } = ctx;
    requireBoundedHistory(id, sessionManager);
    const state = loaded(roster.current());
    // A work session: work scope, or a scope that cannot be read.
    if (state.kind !== "ok") throw rosterRefusal(id, state, resolvedScope(ctx) === "work");
    const refused = refusalFor(id, state.value, ctx);
    if (refused !== undefined) throw refused;
    const record = recordOf(sessionManager.getSessionId());
    // The thinking level this request carries: the price assumes the effort the request is sent at.
    const figures: CostFigures = { ledger: record.ledger, thinking: request.thinkingLevel };
    return { id, request, rc: contextFor(ctx, state.value, id), record, figures, compaction: compactionFor(settingsNow(), id) };
  };

  // auto declares the smallest window and output budget among the first available candidate of
  // every role it can reach; local declares its first available candidate's. The limits are the
  // process's, not the registering session's: under a version 2 roster, auto reaches every level
  // role of both scopes, each resolved in its own scope, and the local role is resolved in each. A
  // version 1 roster serves only personal scope, and resolves the same in either.
  const computeLimits = (ctx: ExtensionContext, value: Roster): Record<VirtualId, Limits> => {
    const scopes: readonly Scope[] = value.version === 2 ? SCOPES : ["personal"];
    const picks = (id: VirtualId, roles: (scope: Scope) => Iterable<string>): Decision[] =>
      scopes.flatMap((scope) => {
        const rc = contextFor(ctx, value, id, scope);
        return [...roles(scope)].map((role) => pickInRole(rc, role, { fallback: false, code: "limits" }));
      });
    const auto = smallest(picks("auto", (scope) => autoRoles(value, scope)));
    const role = value.local?.role;
    const local = role === undefined ? DEFAULT_LIMITS : smallest(picks("local", () => [role]));
    return { auto, local };
  };

  // Pi's catalog keeps the object a registration produced until the next registration, so the
  // slot maps each object to the owner whose registration produced it.
  const registerModels = (ctx: ExtensionContext): void => {
    for (const id of VIRTUAL_IDS) {
      options.register(id, limits[id]);
      const model = ctx.modelRegistry.find(PROVIDER, id);
      if (model !== undefined && self !== undefined) slot.registered.set(model, self);
    }
  };

  /** Whether a registration that neither this owner nor a live sibling made holds either model. */
  const displaced = (ctx: ExtensionContext): boolean =>
    VIRTUAL_IDS.some((id) => {
      const current = ctx.modelRegistry.find(PROVIDER, id);
      const holder = current === undefined ? undefined : slot.registered.get(current);
      return holder === undefined || (holder !== self && !isLiveOwner(slot, holder));
    });

  const heal = (ctx: ExtensionContext): boolean => {
    if (self === undefined || !displaced(ctx)) return false;
    registerModels(ctx);
    return true;
  };

  const responder = (entry: unknown): LastResponder | undefined => {
    const message = isRecord(entry) ? entry.message : undefined;
    if (!isRecord(entry) || !isRecord(message) || message.role !== "assistant") return undefined;
    const { provider, model, stopReason } = message;
    if (typeof provider !== "string" || typeof model !== "string" || provider === PROVIDER || message.api === VIRTUAL_API) return undefined;
    if (stopReason === "error" || stopReason === "aborted") return undefined;
    const stamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    const at = Number.isFinite(stamp) ? stamp : typeof message.timestamp === "number" ? message.timestamp : now();
    return { ref: `${provider}/${model}`, at, usage: isUsage(message.usage) ? message.usage : undefined };
  };

  /**
   * The latest successful physical response on the branch, from a bounded read. The same entries,
   * oldest first, seed the ledger: each one's cache, at its entry's time, so that a resumed
   * session's warm model is priced warm. A response before a smaller prompt of the same model is
   * forgotten there, as the ledger forgets any rewritten conversation (seedAnswer). Without a
   * ledger, nothing is seeded into one.
   */
  const seed = (view: BoundedHistory, ledger: Ledger | undefined, ctx: ExtensionContext): LastResponder | undefined => {
    const entries = view.getRecentActiveEntries({ type: "message", messageRole: "assistant", limit: SEED_ENTRIES });
    let last: LastResponder | undefined;
    for (const entry of entries) {
      const found = responder(entry);
      if (found === undefined) continue;
      last = found;
      const answered = found.usage === undefined ? undefined : seededAnswer(entry, found.usage);
      if (answered !== undefined && ledger !== undefined) seedAnswer(ledger, answerOf(answered, ctx.modelRegistry.find(answered.provider, answered.model), found.at));
    }
    return last;
  };

  /**
   * The level a resumed session's latest run needed: its latest level record's, or an earlier
   * version's record's tier, when that record is of the session's scope and the roster still serves
   * it. A correction is a label for a run, not a run's level, and seeds nothing; neither does an
   * entry the router did not write, nor a record of the other scope.
   */
  const seedLevel = (view: BoundedHistory, value: Roster, scope: Scope): Tier | undefined => {
    const record = readLevelRecord(view.getLatestCustomEntry(LEVEL_ENTRY, { scope: "active" }));
    if (record === undefined || record.source === "correction" || record.scope !== scope || scopeSection(value, scope) === undefined) return undefined;
    return record.need ?? record.tier;
  };

  // What pi-cache-optimizer reads through the adapter, for the owner's session: the run's plan,
  // else the run's pick, else what a continuation would pick now; nothing when the request would be
  // refused. Only the owner's own loop and its message_end change it.
  const activeRoute = (id: VirtualId): ActiveRoute | undefined => {
    try {
      const owner = self;
      if (owner === undefined) return undefined;
      const { ctx } = owner;
      const state = loaded(roster.current());
      if (state.kind !== "ok" || boundedHistory(ctx.sessionManager) === undefined) return undefined;
      // smart-router/auto has no pick in a scope that prepare() refuses it for.
      if (refusalFor(id, state.value, ctx) !== undefined) return undefined;
      const rc = contextFor(ctx, state.value, id);
      const record = records.get(owner.sessionId) ?? newRecord();
      const at = now();
      const answer = (model: Model<Api>, status: ActiveRoute["status"]): ActiveRoute => ({ provider: model.provider, modelId: model.id, api: model.api, status, at });
      const { plan, runPick } = record;
      if (plan !== undefined && planApplies(plan, id, rc)) {
        // The run's first request takes the planned model, or refuses when the plan found none.
        return plan.decision.ok ? answer(plan.decision.choice.model, "planned") : undefined;
      }
      if (runPick?.id === id) {
        const ref = parseRef(runPick.ref);
        return ref === undefined ? undefined : { provider: ref.provider, modelId: ref.id, api: rc.catalog.find(ref.provider, ref.id)?.api, status: "selected", at };
      }
      const predicted = predict(rc, record);
      return predicted.ok ? answer(predicted.choice.model, "selected") : undefined;
    } catch {
      return undefined;
    }
  };

  const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning" | "error"): void => {
    if (ctx.hasUI) ctx.ui.notify(text, type);
  };

  /**
   * The footer's level item, under its own key: a version 2 run's level and model, or none. A
   * session that shows none is not told so again, so a version 1 roster never sets it.
   */
  const showLevel = (ctx: ExtensionContext, record: Session, text: string | undefined): void => {
    if (text === undefined && !record.levelShown) return;
    record.levelShown = text !== undefined;
    try {
      ctx.ui.setStatus(LEVEL_KEY, text);
    } catch {
      // The footer is a courtesy.
    }
  };

  /**
   * Whether the session's latest pin entry, which an earlier version wrote, says it was pinned. The
   * pin was session-wide, so the entry is read over the whole session (scope "all"), as the scope's
   * is: a /tree move to a branch without it left the session pinned. The pin has been removed and
   * the entry is ignored; it is read only to say so. Never throws: an entry that cannot be read, or
   * that says anything else, says nothing.
   */
  const pinnedBefore = (ctx: ExtensionContext): boolean => {
    try {
      const entry = boundedHistory(managerOf(ctx))?.getLatestCustomEntry(PIN_ENTRY, { scope: "all" });
      const data = isRecord(entry) ? own(entry, "data") : undefined;
      return isRecord(data) && own(data, "on") === true;
    } catch {
      return false;
    }
  };

  /**
   * Look once in a session for an old pin entry, and say that it is ignored when it says the session
   * was pinned: at session start when smart-router/auto is selected, else at the first idle input on
   * it. After that one look the entry is never read again, whatever it said. Only smart-router/auto
   * now routes where the pin would not have: smart-router/local still routes locally, and a model
   * picked by hand was always sent as it is.
   */
  const tellPinEntry = (ctx: ExtensionContext): void => {
    const record = recordOf(ctx.sessionManager.getSessionId());
    if (record.pinEntryChecked || virtualIdOf(ctx.model) !== "auto") return;
    record.pinEntryChecked = true;
    if (pinnedBefore(ctx)) notify(ctx, pinEntryNotice(), "warning");
  };

  /** Append a scope entry, and say whether it was recorded. */
  const recordScope = (ctx: ExtensionContext, data: ScopeEntryData, recorded: string, failed: (reason: string) => string): void => {
    let failure: string | undefined;
    try {
      pi.appendEntry(SCOPE_ENTRY, data);
    } catch (error) {
      failure = firstLine(error);
    }
    if (failure === undefined) notify(ctx, recorded, "info");
    else notify(ctx, failed(failure), "error");
  };

  /** A fork or /new records the scope it carries. */
  const carryScope = (ctx: ExtensionContext): void => {
    const file = ctx.sessionManager.getSessionFile();
    const scope = typeof file === "string" ? takeScopeHandoff(slot, file) : undefined;
    if (scope !== undefined) recordScope(ctx, scopeEntry(scope, "carried", now()), scopeCarriedNotice(scope), (reason) => scopeCarryFailedNotice(scope, reason));
  };

  /**
   * The work directories decide a session's scope on every read (scopeOf), so a roster load that
   * lists a running session's directory moves it at once. The first time they do, at session start,
   * at the next idle input or at the start of the next run, the router records the scope as a work
   * entry, so that it no longer depends on the roster, and says so. Never from prepare(), which can
   * run for another session's request. It tries once per session: a session whose entry cannot be
   * written is told once, and stays in work scope while the roster lists its directory.
   */
  const recordDirectory = (ctx: ExtensionContext): void => {
    const scope = scopeOf(ctx);
    const work = workOf(ctx);
    const directory = work === undefined ? undefined : workDirectoryOf(work.cwd, work.directories);
    if (scope.kind !== "ok" || scope.source !== "directory" || work === undefined || directory === undefined) return;
    const record = recordOf(ctx.sessionManager.getSessionId());
    if (record.directoryTried) return;
    record.directoryTried = true;
    recordScope(ctx, scopeEntry("work", "directory", now()), directoryNotice(work.cwd, directory), (reason) => directoryFailedNotice(work.cwd, directory, reason));
  };

  // The restored selection is left as it is. The scope a fork or /new carries is recorded first,
  // and the scope the work directories give is recorded as soon as the roster is read. Each step
  // reports its own failure and lets the rest run.
  const start = (ctx: ExtensionContext): void => {
    const { sessionManager } = ctx;
    const sessionId = sessionManager.getSessionId();
    if (self !== undefined) leave(slot, self);
    self = { router: api, ctx, sessionId, hash: sessionHash(sessionId) };
    join(slot, self);
    const step = <T>(run: () => T): T | undefined => guarded("session_start", ctx, run);
    // The removed pin's switch and entries keep nothing local: a session that relied on them is told so.
    step(() => {
      if (slot.env.on) notify(ctx, pinEnvNotice(), "warning");
    });
    step(() => tellPinEntry(ctx));
    step(() => carryScope(ctx));
    step(() => registerAdapter(slot));
    const state = step(refreshFiles);
    step(() => recordDirectory(ctx));
    if (state !== undefined) {
      step(() => {
        limits = state.kind === "ok" ? computeLimits(ctx, state.value) : BOTH_DEFAULT;
      });
    }
    step(() => registerModels(ctx));
    const view = boundedHistory(sessionManager);
    // Right after a compaction Pi knows no size yet: no answer on the branch measured the conversation
    // as it is now, so none seeds a cache, and the last responder has no usage until the next answer.
    const compacted = sizeUnknown(ctx);
    const last = view === undefined ? undefined : step(() => seed(view, compacted ? undefined : recordOf(sessionId).ledger, ctx));
    if (last !== undefined) recordOf(sessionId).last = compacted ? withoutSize(last) : last;
    // A resumed session's level is its latest run's, so that it returns from the chain as a running one does.
    const need = view === undefined || state?.kind !== "ok" ? undefined : step(() => seedLevel(view, state.value, resolvedScope(ctx)));
    if (need !== undefined) recordOf(sessionId).need = need;
    const notice = state !== undefined && state.kind !== "ok" ? rosterNotice(state) : view === undefined ? historyNotice() : undefined;
    if (notice !== undefined) notify(ctx, notice, "warning");
    // A prompt file that cannot be used stops no route, so it is said once here; status says it too.
    const unusable = state?.kind === "ok" && state.value.version === 2 && state.value.classifier !== undefined ? promptProblem(promptUses(state.value, prompts.read)) : undefined;
    if (unusable !== undefined) notify(ctx, promptNotice(unusable), "warning");
  };

  /**
   * An idle input heals a displaced registration and drops the plan, the pending level and the last
   * input, which it returns: an extension's resend of the same text plans with its level again.
   */
  const resetInput = (ctx: ExtensionContext): LastInput | undefined => {
    if (!ctx.isIdle()) return undefined;
    heal(ctx);
    const record = recordOf(ctx.sessionManager.getSessionId());
    const previous = record.lastInput;
    record.plan = undefined;
    record.planDigest = undefined;
    record.pendingLevel = undefined;
    record.lastInput = undefined;
    return previous;
  };

  /**
   * Jev's answer about a message, asked with what jevAsk gave. Jev reads the text without its tag
   * and the conversation before it (the message is not in the session yet), both redacted and then
   * cut to the classifier's caps, with the instructions and the scope's descriptions as the roster
   * gives them, inline or from its prompt files (src/prompts.ts). An untagged message's conversation
   * is `window`, the one read its demand's heuristics share (planInput), and when that read threw,
   * Jev fails as an error without a request; a tagged message's opinion reads its own. Never rejects: a prompt file that cannot be used fails as `prompt`, and a request
   * that cannot be built, such as for text too long to redact, as an error, both before anything is
   * sent.
   */
  const askFor = (ctx: ExtensionContext, ask: JevAsk, text: string, value: RosterV2, scope: Scope, window?: Window): Promise<JevOutcome> => {
    const { settings, history } = ask;
    try {
      const given = scopePrompts(value, scope, prompts.read);
      if (!given.ok) return Promise.resolve<JevOutcome>({ kind: "failure", model: settings.model, failure: "prompt", ms: 0 });
      // The conversation could not be read: nothing is sent, as when Jev's own read threw.
      if (window === UNREAD) return Promise.resolve<JevOutcome>({ kind: "failure", model: settings.model, failure: "error", ms: 0 });
      const descriptions: Record<Tier, string> = given.descriptions;
      const { messages } = settings.context;
      const entries = messages === 0 ? [] : (window ?? history.getRecentActiveEntries({ type: "message", limit: messages * 4 }));
      const recent = recentMessages(entries, messages);
      return askJev(ctx.modelRegistry, settings, buildContext(text, recent, descriptions, settings.context, given.instructions), now);
    } catch {
      return Promise.resolve<JevOutcome>({ kind: "failure", model: settings.model, failure: "error", ms: 0 });
    }
  };

  /** A tagged run's opinion lands in its pending level while that is still the session's and this input's. */
  const landOpinion =
    (sessionId: string, record: Session, token: number) =>
    (jev: JevOutcome): void => {
      const pending = records.get(sessionId) === record ? record.pendingLevel : undefined;
      if (pending?.token === token) pending.jev = jev;
    };

  /**
   * Plan an idle input's run with the session as it is now: after a wait, its selection, scope and
   * roster may have moved. `roles`: what the heuristics read of the input's window (rolesOf), none
   * for a run that read none; the conversation's size and the branch's entry count are read here,
   * without a read of the history.
   */
  const plan = (ctx: ExtensionContext, record: Session, text: string, digest: string, level: LevelInput, token: number, roles: readonly string[]): Plan | undefined => {
    if (!ctx.isIdle()) return undefined;
    const { sessionManager } = ctx;
    const state = loaded(roster.current());
    const id = virtualIdOf(ctx.model);
    if (id === undefined || state.kind !== "ok" || boundedHistory(sessionManager) === undefined) return undefined;
    // The selected model refuses this scope at the run's first request, so there is no run to plan.
    if (refusalFor(id, state.value, ctx) !== undefined) return undefined;
    const rc = contextFor(ctx, state.value, id);
    const usage = record.last?.usage;
    const facts: PromptFacts = { contextTokens: usage === undefined ? undefined : calculateContextTokens(usage), roles, entries: activeEntries(sessionManager) };
    // The thinking level the run's requests carry: Pi sends the selected one, and the price assumes it too.
    const figures: CostFigures = { ledger: record.ledger, thinking: pi.getThinkingLevel() };
    const planned = planUserTurn({ rc, text, last: record.last, now: now(), compaction: compactionFor(pi.getSettings(), id), level, facts, figures });
    record.plan = planned;
    record.planDigest = digest;
    record.plannedToken = token;
    return planned;
  };

  /**
   * Whether a plan or a pending level made for a message belongs to the run a prompt starts. The
   * message's text and the prompt are compared by their digests (digestOf).
   * Pi starts a message's run once the message's input handlers return, whenever that is: two
   * messages that overlap a Jev wait start their runs in either order, and a message a later
   * extension's async input handler holds, even one typed while a run streamed, can start its run
   * after other messages have planned and run. So a prompt that is the plan's message's text is that
   * message's run, and a prompt that is the text of another message the router remembers (passed,
   * busy or idle, and not yet started) is that other message's run and takes no plan.
   *
   * Pi expands a template or skill after the input handlers, and a later extension can change the
   * text, so a prompt can match no message's text. Such a run is the plan's message's only when that
   * is the one idle message since the latest prompt's run started; with two, it cannot be told whose
   * and is neither's. A custom message's run is no message's run, so it restarts neither the count
   * nor what is remembered. What remains:
   * - identical texts cannot be told apart, so a message's run can take the plan of another message
   *   with the same text;
   * - a stray message whose own prompt a later handler also expands or changes matches no text, so it
   *   can still take the plan of the one idle message counted;
   * - a message held while REMEMBERED newer messages pass is forgotten, so its run, too, can take
   *   the plan of the one idle message counted;
   * - a counted message that never starts its own run (one a later extension handles, an idle RPC
   *   steer or follow_up, a prompt() that throws) leaves the next expanded or changed run unplanned.
   *   A run that drops a tagged plan, a prompt's or a custom message's, says so (unmatchedTagNotice);
   *   under version 1, which has no tags, it goes unplanned without a notice;
   * - a message a later extension rewrites into the text of a steer the router still remembers goes
   *   unplanned, which is the safe direction, but its run forgets one message of that text, the
   *   steer's: the steer's own run, when it starts, can then take the plan of the one idle message
   *   counted.
   */
  const ownsRun = (record: Session, digest: string | undefined, prompt: string): boolean =>
    digest !== undefined && (digest === prompt || (!record.remembered.has(prompt) && record.inputsSinceRun === 1));

  /** Remember a message until its own run starts: the REMEMBERED most recent texts, each counted, the oldest forgotten first. */
  const remember = (record: Session, digest: string): void => {
    const { remembered } = record;
    const count = remembered.get(digest) ?? 0;
    remembered.delete(digest);
    remembered.set(digest, count + 1);
    for (const oldest of remembered.keys()) {
      if (remembered.size <= REMEMBERED) break;
      remembered.delete(oldest);
    }
  };

  /** A prompt's run started: forget one message of its text. */
  const forgetOne = (record: Session, digest: string): void => {
    const count = record.remembered.get(digest) ?? 0;
    if (count > 1) record.remembered.set(digest, count - 1);
    else record.remembered.delete(digest);
  };

  /**
   * The one bounded window of the conversation an untagged idle input on smart-router/auto reads,
   * under a version 2 roster, in a scope that reads and that the roster serves: the latest
   * HEURISTIC_MESSAGES messages, or four for each message Jev reads when that is more. Undefined
   * where nothing is planned by level; UNREAD when the read throws, so that Jev fails as an error
   * without a request, as it did when its own read threw, and the heuristics see no conversation.
   */
  const demandWindow = (ctx: ExtensionContext, id: VirtualId | undefined, value: Roster | undefined, scope: ScopeState): Window | undefined => {
    const history = boundedHistory(ctx.sessionManager);
    if (!ctx.isIdle() || id !== "auto" || value?.version !== 2 || scope.kind !== "ok" || history === undefined) return undefined;
    if (scopeSection(value, scope.scope) === undefined) return undefined;
    const limit = Math.max(4 * (value.classifier?.context.messages ?? 0), HEURISTIC_MESSAGES);
    try {
      return history.getRecentActiveEntries({ type: "message", limit });
    } catch {
      return UNREAD;
    }
  };

  // The decision point: a prompt typed while the session is idle plans its run. Input that
  // arrives while a run starts or streams (steering, follow-ups) neither plans nor drops; its tag
  // is removed with a notice. A roster edit read here that lists the session's directory is
  // recorded before the run is planned, and nothing is planned for a scope smart-router/auto
  // refuses (plan()), where Jev is not asked either (jevAsk). A version 2 run on auto takes the
  // level its last input planned with when an extension resends that text (pi-idle-check), else
  // its tag's, with Jev's opinion asked and recorded without waiting, else its demand's, from Jev's
  // answer, waited for, and the heuristics (demandWindow). The plan and its pending level carry the
  // digest of the message's text, which binds them to the run the message's prompt starts.
  const planInput = async (event: InputEvent, ctx: ExtensionContext, tagged: Tagged | undefined, previous: LastInput | undefined): Promise<void> => {
    const tier = tagged?.tier;
    const text = tagged === undefined ? event.text : tagged.text;
    const digest = digestOf(text);
    const { sessionManager } = ctx;
    const sessionId = sessionManager.getSessionId();
    const record = recordOf(sessionId);
    // A message typed while a run streams can still start a run of its own, when a later handler
    // holds it until that run ends: its text tells its run from the messages that plan meanwhile.
    remember(record, digest);
    if (!ctx.isIdle()) {
      if (tier !== undefined) notify(ctx, tagIgnoredNotice(tier, "busy"), "warning");
      return;
    }
    const token = ++inputs;
    record.inputsSinceRun += 1;
    const state = refreshFiles();
    guarded("input", ctx, () => recordDirectory(ctx));
    const id = virtualIdOf(ctx.model);
    const value = state.kind === "ok" ? state.value : undefined;
    if (tier !== undefined) {
      const why: TagIgnored | undefined =
        id !== "auto"
          ? { selection: describeModel(ctx.model) }
          : value?.version === 1
            ? "version"
            : value !== undefined && scopeRefusal(value, ctx) !== undefined
              ? "scope"
              : undefined;
      if (why !== undefined) notify(ctx, tagIgnoredNotice(tier, why), "warning");
    }
    // An extension's resend of the latest message's text (pi-idle-check) keeps that message's level.
    const reused = tagged === undefined && event.source === "extension" && previous?.digest === digest ? previous.level : undefined;
    const scope = scopeOf(ctx);
    const ask = jevAsk({
      idle: ctx.isIdle(),
      selection: id,
      roster: value,
      history: boundedHistory(sessionManager),
      scope,
      resend: reused !== undefined,
    });
    // jevAsk gives an ask only under a version 2 roster, in a scope that reads: its request is built for both.
    const asked = ask !== undefined && value?.version === 2 && scope.kind === "ok" ? { ask, value, scope: scope.scope } : undefined;
    // An untagged run's level is its demand's: one bounded read of the conversation serves both the
    // heuristics and Jev's context. A tagged run, or one that reuses a tagged message's level, reads
    // none for it; an extension's resend of an untagged message reads it again for its own facts.
    const window = tier === undefined && reused?.tag === undefined ? demandWindow(ctx, id, value, scope) : undefined;
    // A level input counts only where levels route: planUserTurn ignores it under version 1 and on
    // smart-router/local, and plan() plans nothing off the router's models.
    let level: LevelInput = reused ?? (tier === undefined ? {} : { tag: tier });
    let opinion = false;
    if (asked !== undefined && tier !== undefined) {
      opinion = true;
      void askFor(ctx, asked.ask, text, asked.value, asked.scope)
        .then(landOpinion(sessionId, record, token))
        .catch(() => {
          // An opinion only feeds the record, so there is nothing to do when landing it fails.
        });
    } else if (asked !== undefined) {
      const jev = await askFor(ctx, asked.ask, text, asked.value, asked.scope, window);
      // The session ended during the wait, or a newer message has planned since. A stale token
      // alone does not stop it: an earlier message whose answer comes first plans its own run.
      if (records.get(sessionId) !== record || record.plannedToken > token) return;
      level = { jev };
    }
    const planned = plan(ctx, record, text, digest, level, token, window === undefined || window === UNREAD ? [] : rolesOf(window.map((entry) => (isRecord(entry) ? own(entry, "message") : undefined))));
    const planLevel = planned?.level;
    if (planned === undefined || planLevel === undefined || planned.signal === "local") return;
    record.pendingLevel = { token, digest, level: planLevel, keyword: { signal: planned.signal, reason: planned.reason }, at: now(), jev: opinion ? "pending" : level.jev, started: false };
    record.lastInput = { digest, level };
    // A plan that found no model shows none: its run is refused at its first request.
    showLevel(ctx, record, planned.decision.ok ? footerText(planLevel, planned.decision.choice.model.id) : undefined);
    if (planLevel.steppedUp && planned.decision.ok) notify(ctx, stepUpNotice(planLevel.need, planLevel.tier, planned.decision.choice.model.id), "info");
    // A chain model is another vendor's or a LAN host's, so the run says where it goes.
    if (planLevel.fallback === true && planned.decision.ok) notify(ctx, fallbackNotice(planLevel.tier, planned.decision.choice.role, planned.decision.choice.model.id), "info");
  };

  /** Whether a model is one of a scope's fallback chain under the roster as it is now; false when the roster does not load. */
  const inChain = (scope: Scope, ref: string): boolean => {
    const state = roster.current();
    if (state.kind !== "ok") return false;
    const role = roleOf(state.value, ref)?.name;
    return role !== undefined && (scopeSection(state.value, scope)?.fallback?.includes(role) ?? false);
  };

  /**
   * A run's own pick failed, before any output of that request, on its account's limit or because
   * its server could not be reached, with an error Pi does not retry: the run ends there. The
   * router cannot go on by itself, so it says what happened and what to do (resendNotice): send the
   * request again when nothing was done, ask to continue when the run had already answered or run
   * tools, and where that goes, which is what a new run's plan would pick now. A model picked by
   * hand is no pick of the router's, and gets no notice.
   */
  const sayResend = (ctx: ExtensionContext, record: Session, value: Roster, failover: Failover): void => {
    const id = virtualIdOf(ctx.model);
    if (id === undefined || record.runPick?.id !== id || refusalFor(id, value, ctx) !== undefined) return;
    const rc = contextFor(ctx, value, id);
    const parsed = parseRef(failover.ref);
    const cause = failover.kind === "unreachable" ? { unreachable: true as const } : { account: parsed?.provider ?? "", until: clock(cooldowns.until(failover.ref, rc.now) ?? rc.now) };
    // A new run starts in its level's role, the one this run's level had; on smart-router/local, in the local role.
    const section = rc.localOnly ? undefined : scopeSection(value, rc.scope);
    const tier = record.pendingLevel?.level.tier;
    const start = section !== undefined && tier !== undefined ? section.levels[tier].role : rc.localOnly ? value.local?.role : undefined;
    const next = afterFailure(rc, failover, start);
    const chain = next !== undefined && !rc.localOnly && inChain(rc.scope, next.ref) ? next.role : undefined;
    notify(
      ctx,
      resendNotice(id, {
        modelId: parsed?.id ?? failover.ref,
        cause,
        partway: record.answered !== undefined,
        next: next === undefined ? undefined : { role: chain, modelId: next.model.id },
        work: rc.scope === "work",
      }),
      "warning",
    );
  };

  const messageEnd = (event: MessageEndEvent, ctx: ExtensionContext): void => {
    const { message } = event;
    if (message.role !== "assistant" || message.provider === PROVIDER || message.api === VIRTUAL_API) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const ref = `${message.provider}/${message.model}`;
    if (message.stopReason === "error") {
      const state = roster.current();
      if (state.kind === "ok") {
        const cooled = coolFrom(message, state.value, cooldowns, now());
        // A failure Pi does not retry holds its model too, so that the next run skips it.
        const held = holdFrom(message, ctx.modelRegistry.find(message.provider, message.model), state.value, holds, now());
        const session = records.get(sessionId);
        const kind = held !== undefined ? "unreachable" : cooled !== undefined && coolsAccount(message.provider, message.errorMessage) ? "limit" : undefined;
        // Pi retries some of these errors, and its retry is routed to the next candidate; the rest end the run.
        if (session !== undefined && kind !== undefined && session.runPick?.ref === ref && !hasOutput(message.content) && !looksRetryable(message.errorMessage ?? "")) {
          sayResend(ctx, session, state.value, { ref, kind });
        }
      }
      return;
    }
    // A held model that answers is no longer held: its server is back.
    holds.release(ref);
    // The footer names the model that answered a run's level, when the run's own route picked it.
    const record = records.get(sessionId);
    const pick = record?.runPick;
    if (record?.pendingLevel !== undefined && pick?.id === "auto" && pick.ref === ref) {
      const { level } = record.pendingLevel;
      showLevel(ctx, record, footerText(level, message.model, inChain(level.scope, ref)));
    }
    if (record !== undefined) record.answered = ref;
    if (message.stopReason === "aborted") return;
    const at = now();
    const session = recordOf(sessionId);
    session.last = { ref, at, usage: message.usage };
    // Whichever selection sent it, a model picked by hand's included: its cache and the run's shape.
    noteAnswer(session.ledger, answerOf(message, ctx.modelRegistry.find(message.provider, message.model), at));
  };

  /**
   * At agent_settled, the run is over: its level, if it had one, is recorded with the model of its
   * last assistant message that ended without an error, whichever route or selection sent it, and
   * with none when no model answered. The run's plan, pick, level, answer, tag and escalation are
   * dropped, whether or not the record could be appended. A run without a level of its own records
   * nothing.
   */
  const settle = (record: Session, aborted: boolean): void => {
    const { pendingLevel: pending, answered } = record;
    record.plan = undefined;
    record.planDigest = undefined;
    record.runPick = undefined;
    record.limited.clear();
    record.pendingLevel = undefined;
    record.answered = undefined;
    record.runTier = undefined;
    record.runTagged = false;
    record.escalated = false;
    noteRunEnd(record.ledger);
    if (pending !== undefined) pi.appendEntry(LEVEL_ENTRY, levelRecord(pending, answered, aborted, answered !== undefined && inChain(pending.level.scope, answered)));
  };

  /**
   * A fork or /new carries the scope the latch, an entry or the work directories set. A default
   * scope is not carried, so the new session decides its own. An unreadable one is carried as work,
   * the scope routing holds that session in.
   */
  const leaveScope = (event: SessionShutdownEvent, ctx: ExtensionContext): void => {
    const { reason, targetSessionFile: target } = event;
    if ((reason !== "new" && reason !== "fork") || typeof target !== "string" || target === "") return;
    const scope = scopeOf(ctx);
    if (scope.kind !== "ok") leaveScopeHandoff(slot, target, "work");
    else if (scope.source !== "default") leaveScopeHandoff(slot, target, scope.scope);
  };

  const shutdown = (event: SessionShutdownEvent, ctx: ExtensionContext): void => {
    try {
      // The scope goes with a fork or /new into the session it creates, keyed by that session's file.
      leaveScope(event, ctx);
    } finally {
      records.clear();
      // pi-cache-optimizer's adapter serves every owner in the process; the last one to leave removes it.
      if (self !== undefined && leave(slot, self)) unregisterAdapter(slot);
      self = undefined;
    }
  };

  /** Report a handler's failure once; never let it reach Pi. */
  const report = (name: string, ctx: ExtensionContext, error: unknown): void => {
    const text = `pi-smart-router: the ${name} handler failed: ${firstLine(error)}`;
    if (reported.has(text)) return;
    reported.add(text);
    try {
      if (ctx.hasUI) ctx.ui.notify(text, "warning");
    } catch {
      // A stale context has nowhere to report to.
    }
  };

  const guarded = <T>(name: string, ctx: ExtensionContext, run: () => T): T | undefined => {
    try {
      return run();
    } catch (error) {
      report(name, ctx, error);
      return undefined;
    }
  };

  const filesNow = (state: Loaded<Roster>): Files => ({ roster: state, labels: labelsNeeded(state) ? labels.current() : undefined });

  const commandHost: CommandHost = {
    pi,
    now,
    refresh: () => filesNow(refreshFiles()),
    reload: (ctx) => {
      const state = loaded(roster.reload());
      if (labelsNeeded(state)) labels.reload();
      if (state.kind === "ok" && state.value.version === 2) prompts.reload(state.value);
      let limitsChanged = false;
      if (state.kind === "ok") {
        const next = computeLimits(ctx, state.value);
        limitsChanged = !sameLimits(next, limits);
        if (limitsChanged) {
          limits = next;
          registerModels(ctx);
        }
      }
      return { ...filesNow(state), limitsChanged };
    },
    scopeOf,
    session: (ctx) => records.get(ctx.sessionManager.getSessionId()),
    resolver: contextFor,
    readPrompt: prompts.read,
  };

  const api: Router = {
    routeOwned: (id, request, ctx) => {
      const input = prepare(id, request, ctx);
      const before = input.record.runPick;
      const { runTier: from, escalated } = input.record;
      const route = routeOwned(input);
      // A stuck run that moves up says so, where it happens: the levels and the model, nothing of its tools' output.
      const to = input.record.runTier;
      if (!escalated && input.record.escalated && from !== undefined && to !== undefined) notify(ctx, escalationNotice(from, to, route.model.id), "info");
      // A run under way that moves from its model onto the scope's chain says so, where it happens.
      const after = input.record.runPick;
      if (id === "auto" && !input.rc.localOnly && before !== undefined && after !== undefined && before.ref !== after.ref) {
        const { scope } = input.rc;
        if (!inChain(scope, before.ref) && inChain(scope, after.ref)) {
          notify(ctx, fallbackMoveNotice(parseRef(before.ref)?.id ?? before.ref, after.role, route.model.id), "info");
        }
      }
      return route;
    },
    routeOther: (id, request, ctx) => routeOther(prepare(id, request, ctx)),
    heal,
    activeRoute,

    dispatch(id, request, passed) {
      const owner = request.reason !== "direct" && request.signal !== undefined ? ownerBySignal(slot, request.signal) : undefined;
      if (owner !== undefined) return owner.router.routeOwned(id, request, owner.ctx);
      if (isLive(passed)) return api.routeOther(id, request, passed);
      const healed = healDisplaced(slot);
      if (healed !== undefined) return healed.router.routeOther(id, request, healed.ctx);
      throw stale(id);
    },

    wire(target) {
      target.on("session_start", (_event, ctx) => guarded("session_start", ctx, () => start(ctx)));
      target.on("input", async (event, ctx) => {
        // The tag first: whatever fails after this, the model never sees it, and a message that is
        // only a tag is never sent.
        const tagged = parseTag(event.text);
        const result: InputEventResult | undefined = tagged === undefined ? undefined : tagged.text === "" ? HANDLED : { action: "transform", text: tagged.text };
        try {
          const previous = guarded("input", ctx, () => resetInput(ctx));
          // An old pin entry is looked for at the first idle input on smart-router/auto, unless session_start looked.
          guarded("input", ctx, () => {
            if (ctx.isIdle()) tellPinEntry(ctx);
          });
          if (tagged !== undefined && tagged.text === "") {
            notify(ctx, tagOnlyNotice(tagged.tier), "warning");
          } else {
            await planInput(event, ctx, tagged, previous);
          }
        } catch (error) {
          report("input", ctx, error);
        }
        return result;
      });
      target.on("before_agent_start", (event, ctx) => {
        guarded("before_agent_start", ctx, () => {
          const record = recordOf(ctx.sessionManager.getSessionId());
          // A run starts with no answer of its own.
          record.answered = undefined;
          if (event.messageType === "custom" || typeof event.prompt !== "string") {
            // A custom message's run has no input, and a prompt that is not text matches none: what
            // an earlier input planned or kept is not its, and neither the count nor what is
            // remembered starts again. Each run's end drops the plan, so one still set is a level no
            // run took, or whose run failed to start; a tagged one is lost, and this run says so as a
            // prompt's run does.
            const tagged = record.plan?.level?.source === "tag";
            record.plan = undefined;
            record.planDigest = undefined;
            record.pendingLevel = undefined;
            record.lastInput = undefined;
            if (tagged) notify(ctx, unmatchedTagNotice(), "warning");
          } else {
            // A prompt's run takes only its own message's plan and pending level, never another's.
            const prompt = digestOf(event.prompt);
            if (record.plan !== undefined && !ownsRun(record, record.planDigest, prompt)) {
              const tagged = record.plan.level?.source === "tag";
              record.plan = undefined;
              record.planDigest = undefined;
              if (tagged) notify(ctx, unmatchedTagNotice(), "warning");
            }
            if (record.pendingLevel !== undefined && !ownsRun(record, record.pendingLevel.digest, prompt)) record.pendingLevel = undefined;
            // The level this run kept is now a started run's, until its record is written.
            if (record.pendingLevel !== undefined) record.pendingLevel.started = true;
            // This prompt's message has started its run; the others it remembers have not.
            record.inputsSinceRun = 0;
            forgetOne(record, prompt);
          }
          // A run without a level of its own shows none, rather than an earlier run's.
          if (record.pendingLevel === undefined) showLevel(ctx, record, undefined);
        });
        // Every run starts here, so a run without an input (a custom message's, a goal-x
        // continuation's) records the work directories' scope too.
        guarded("before_agent_start", ctx, () => recordDirectory(ctx));
      });
      // Whatever is selected, a run's turn starts as it is: the router only heals its registration.
      target.on("turn_start", (_event, ctx) => guarded("turn_start", ctx, () => void heal(ctx)));
      target.on("message_end", (event, ctx) => guarded("message_end", ctx, () => messageEnd(event, ctx)));
      target.on("agent_settled", (event, ctx) => guarded("agent_settled", ctx, () => settle(recordOf(ctx.sessionManager.getSessionId()), event.aborted === true)));
      // Compaction and tree navigation go on under any selection: these only heal the registration
      // their summary may route through, and return nothing.
      target.on("session_before_compact", (_event, ctx) => guarded("session_before_compact", ctx, () => void heal(ctx)));
      target.on("session_before_tree", (_event, ctx) => guarded("session_before_tree", ctx, () => void heal(ctx)));
      // After a compaction, or a move to another leaf of the tree, no model has the conversation
      // cached as it is now, and its size is unknown until the next answer measures it.
      target.on("session_compact", (_event, ctx) =>
        guarded("session_compact", ctx, () => {
          const record = recordOf(ctx.sessionManager.getSessionId());
          forgetCaches(record.ledger);
          record.last = withoutSize(record.last);
        }),
      );
      target.on("session_tree", (event, ctx) =>
        guarded("session_tree", ctx, () => {
          if (event.newLeafId === event.oldLeafId) return;
          const record = recordOf(ctx.sessionManager.getSessionId());
          // The branch's runs and prompts are another branch's now: they start afresh.
          forgetBranch(record.ledger);
          record.last = withoutSize(record.last);
        }),
      );
      target.on("session_shutdown", (event, ctx) => guarded("session_shutdown", ctx, () => shutdown(event, ctx)));
      target.registerCommand(COMMAND, smartRouterCommand(commandHost));
    },

    record: (sessionId) => records.get(sessionId),
    limits: () => limits,
  };
  return api;
}
