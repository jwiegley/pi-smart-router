// One instance of the router: the session whose extension runtime loaded it, the two files it
// reads, its per-session records and cooldowns, the limits both models declare, the pin's guards
// and handoffs, the session's scope with its handoffs and work directories, a message's tag and
// Jev's request, the /smart-router command, what it tells pi-cache-optimizer, and the handlers
// wire() registers.
//
// createRouter only builds closures. It makes no pi.on, registration or command call, so a throw
// while it is built leaves only the two refusing models index.ts registered, and wire() makes
// every pi.on and registerCommand call in one place, after the router exists. No timer, watcher,
// socket or other handle is ever opened; the files are read at session_start, at idle prompts when
// they changed, and on demand. Jev is asked through Pi's model registry, which makes the request.
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
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
import { COMMAND, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, PIN_ENTRY, PROVIDER, SCOPE_ENTRY, VIRTUAL_API, VIRTUAL_IDS } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { pickInRole, planUserTurn, reserveFor } from "./decide.ts";
import type { Decision, LastResponder, LevelInput, Plan } from "./decide.ts";
import {
  carriedNotice,
  carryFailedNotice,
  directoryFailedNotice,
  directoryNotice,
  firstLine,
  historyNotice,
  resumeNotice,
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
} from "./errors.ts";
import type { RouterError, TagIgnored } from "./errors.ts";
import { isRecord } from "./files.ts";
import type { FileSystem, Loaded } from "./files.ts";
import { createGuards, describeModel, newGuardState } from "./guards.ts";
import type { GuardState } from "./guards.ts";
import { askJev, buildContext, recentMessages } from "./jev.ts";
import type { JevOutcome } from "./jev.ts";
import { EMPTY_POLICY, policyFromRoster } from "./local.ts";
import { healDisplaced, isLive, isLiveOwner, join, leave, leaveScopeHandoff, ownerBySignal, scopeLatched, sessionHash, takeScopeHandoff } from "./owners.ts";
import type { Owner, OwnerRouter, Slot } from "./owners.ts";
import { latchEnvPolicy, leaveHandoff, pinOn, readPin, takeHandoff } from "./pin.ts";
import type { PinReading } from "./pin.ts";
import { coolFrom, Cooldowns, resolveContext } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { boundedHistory, newRecord, planApplies, predict, requireBoundedHistory, routeOther, routeOwned } from "./route.ts";
import type { BoundedHistory, LastInput, Pin, RouteInput, SessionRecord } from "./route.ts";
import { autoRoles, parseRef, rosterFile, scopeSection } from "./roster.ts";
import type { Roster, RosterV2 } from "./roster.ts";
import { readScope, scopeEntry, workDirectoryOf } from "./scope.ts";
import type { ScopeEntryData, ScopeState, WorkDirectories } from "./scope.ts";
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
 * What a router instance keeps per session: the route records, the pin's guard state, whether it
 * tried to record the work directories' scope, and what binds a plan to the run that uses it.
 */
export interface Session extends SessionRecord {
  readonly guard: GuardState;
  /** Whether this instance has tried to record the scope the work directories gave the session. It tries once. */
  directoryTried: boolean;
  /** The token of the latest input that planned: an input that waited for Jev plans only if no newer input has planned since. */
  plannedToken: number;
  /** The text, without its tag, of the message whose plan `plan` holds; meaningful only while `plan` is set. */
  planText: string | undefined;
  /** How many idle messages the router passed since the latest run started. */
  inputsSinceRun: number;
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
const UNPINNED: Pin = Object.freeze({ on: false, policy: EMPTY_POLICY });
const HANDLED: InputEventResult = Object.freeze({ action: "handled" });
/** How far back session_start looks for the latest successful response. */
const SEED_ENTRIES = 16;

const virtualIdOf = (model: Model<Api> | undefined): VirtualId | undefined =>
  model?.provider === PROVIDER && (model.id === "auto" || model.id === "local") ? model.id : undefined;

function isUsage(value: unknown): value is Usage {
  return isRecord(value) && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => typeof value[key] === "number");
}

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

const sameLimits = (a: Readonly<Record<VirtualId, Limits>>, b: Readonly<Record<VirtualId, Limits>>): boolean =>
  VIRTUAL_IDS.every((id) => a[id].contextWindow === b[id].contextWindow && a[id].maxTokens === b[id].maxTokens);

export function createRouter(pi: ExtensionAPI, options: RouterOptions): Router {
  const { slot, now } = options;
  const files = { agentDir: options.agentDir, uid: options.uid, fs: options.fs, now };
  const roster = rosterFile(files);
  const labels = labelsFile(files);
  const cooldowns = new Cooldowns();
  const records = new Map<string, Session>();
  const reported = new Set<string>();
  let limits = BOTH_DEFAULT;
  let self: Owner | undefined;
  /** How many idle inputs this instance has seen: each one's token. */
  let inputs = 0;

  const recordOf = (sessionId: string): Session => {
    let record = records.get(sessionId);
    if (record === undefined) {
      record = { ...newRecord(), guard: newGuardState(), directoryTried: false, plannedToken: 0, planText: undefined, inputsSinceRun: 0 };
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

  /** A session's pin, read fail closed. A context whose session cannot be read counts as pinned. */
  const pinOf = (ctx: ExtensionContext): PinReading => readPin(managerOf(ctx), slot.env);

  /**
   * The session's working directory and the work directories of the roster as it is now; undefined
   * without any. Never throws: a roster that cannot be read, or a stale context, has none.
   */
  const workOf = (ctx: ExtensionContext): WorkDirectories | undefined => {
    try {
      const state = loaded(roster.current());
      const directories = state.kind === "ok" ? (scopeSection(state.value, "work")?.directories ?? []) : [];
      if (directories.length === 0) return undefined;
      const { cwd } = ctx;
      return typeof cwd === "string" ? { cwd, directories } : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * A session's scope, read fail closed: the latch, the session's entry, then the roster's work
   * directories as they are now. A context whose session cannot be read has an unreadable scope.
   */
  const scopeOf = (ctx: ExtensionContext): ScopeState => readScope(managerOf(ctx), scopeLatched(slot), workOf(ctx));

  const guards = createGuards({ pi, now, pinOf, stateOf: (ctx) => recordOf(ctx.sessionManager.getSessionId()).guard });

  const contextFor = (ctx: ExtensionContext, value: Roster, id: VirtualId, pin: Pin): ResolveContext => {
    const scope = scopeOf(ctx);
    return resolveContext({
      roster: value,
      catalog: ctx.modelRegistry,
      labels: needsLabels(value) ? labels.current() : undefined,
      cooldowns,
      now: now(),
      virtualId: id,
      localOnly: id === "local" || pin.on,
      policy: pin.on ? pin.policy : policyFromRoster(value),
      pinned: pin.on,
      // A scope that cannot be read resolves in work scope, the narrower one, and prepare() refuses
      // smart-router/auto for it.
      scope: scope.kind === "ok" ? scope.scope : "work",
    });
  };

  /** Every roster load passes here, so the environment switch latches the first valid one's local policy. */
  const loaded = (state: Loaded<Roster>): Loaded<Roster> => {
    if (state.kind === "ok") latchEnvPolicy(slot.env, state.value);
    return state;
  };

  /** Re-read both files when they changed. */
  const refreshFiles = (): Loaded<Roster> => {
    const state = loaded(roster.refresh());
    if (state.kind === "ok" && needsLabels(state.value)) labels.refresh();
    return state;
  };

  /**
   * Why smart-router/auto refuses this session's scope, if it does: a scope that cannot be read, a
   * work-scope session under a version 1 roster, and a scope a version 2 roster has no section for.
   * Local-only requests carry no account, so smart-router/local is never refused for its scope.
   * prepare() throws the refusal; what pi-cache-optimizer is told and an input's plan follow it.
   */
  const scopeRefusal = (value: Roster, ctx: ExtensionContext): RouterError | undefined => {
    const scope = scopeOf(ctx);
    if (scope.kind === "unreadable") return scopeUnreadable("auto", scope.reason);
    const served = value.version === 1 ? scope.scope === "personal" : scopeSection(value, scope.scope) !== undefined;
    return served ? undefined : scopeUnserved("auto", scope.scope, value.version);
  };

  const prepare = (id: VirtualId, request: ModelRouteRequest, ctx: ExtensionContext): RouteInput => {
    const { sessionManager } = ctx;
    requireBoundedHistory(id, sessionManager);
    const state = loaded(roster.current());
    if (state.kind !== "ok") throw rosterRefusal(id, state);
    const refused = id === "auto" ? scopeRefusal(state.value, ctx) : undefined;
    if (refused !== undefined) throw refused;
    const pin = pinOf(ctx);
    return { id, request, rc: contextFor(ctx, state.value, id, pin), pin, record: recordOf(sessionManager.getSessionId()) };
  };

  // auto declares the smallest window and output budget among the first available candidate of
  // every role it can reach; local declares its first available candidate's.
  const computeLimits = (ctx: ExtensionContext, value: Roster): Record<VirtualId, Limits> => {
    const reach = contextFor(ctx, value, "auto", UNPINNED);
    const auto = smallest([...autoRoles(value, reach.scope)].map((role) => pickInRole(reach, role, { fallback: false, code: "limits" })));
    const role = value.local?.role;
    const local =
      role === undefined ? DEFAULT_LIMITS : smallest([pickInRole(contextFor(ctx, value, "local", UNPINNED), role, { fallback: false, code: "limits" })]);
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

  /** The latest successful physical response on the branch, from a bounded read. */
  const seed = (view: BoundedHistory): LastResponder | undefined => {
    const entries = view.getRecentActiveEntries({ type: "message", messageRole: "assistant", limit: SEED_ENTRIES });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const found = responder(entries[index]);
      if (found !== undefined) return found;
    }
    return undefined;
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
      // smart-router/auto has no pick in a scope that prepare() refuses.
      if (id === "auto" && scopeRefusal(state.value, ctx) !== undefined) return undefined;
      const rc = contextFor(ctx, state.value, id, pinOf(ctx));
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

  /** A fork or /new records the pin it carries; a resume only says that the session it left was pinned. */
  const carry = (ctx: ExtensionContext): void => {
    const handoff = takeHandoff(slot, ctx.sessionManager.getSessionFile());
    if (handoff?.kind === "pin") {
      let failure: string | undefined;
      try {
        pi.appendEntry(PIN_ENTRY, pinOn(handoff.policy, now()));
      } catch (error) {
        failure = firstLine(error);
      }
      if (failure === undefined) notify(ctx, carriedNotice(), "info");
      else notify(ctx, carryFailedNotice(failure), "error");
    } else if (handoff?.kind === "notice" && !pinOf(ctx).on) {
      notify(ctx, resumeNotice(), "warning");
    }
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

  // The pin's steps come first and last, and nothing between them can skip them: a fork or /new
  // records the pin it carries before any other step runs, and the pin is enforced on the restored
  // selection, with its status item, whatever failed in between. The scope a fork or /new carries
  // is recorded next, and the scope the work directories give is recorded as soon as the roster is
  // read. Each of the other steps reports its own failure and lets the rest run.
  const start = async (ctx: ExtensionContext): Promise<void> => {
    try {
      const { sessionManager } = ctx;
      const sessionId = sessionManager.getSessionId();
      if (self !== undefined) leave(slot, self);
      self = { router: api, ctx, sessionId, hash: sessionHash(sessionId) };
      join(slot, self);
      carry(ctx);
      const step = <T>(run: () => T): T | undefined => guarded("session_start", ctx, run);
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
      const last = view === undefined ? undefined : step(() => seed(view));
      if (last !== undefined) recordOf(sessionId).last = last;
      const notice = state !== undefined && state.kind !== "ok" ? rosterNotice(state) : view === undefined ? historyNotice() : undefined;
      if (notice !== undefined) notify(ctx, notice, "warning");
    } finally {
      await guards.enforce(ctx);
      guards.showStatus(ctx);
    }
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
    record.planText = undefined;
    record.pendingLevel = undefined;
    record.lastInput = undefined;
    return previous;
  };

  /**
   * Jev's answer for a version 2 run on auto, or undefined when Jev is not asked: the roster has no
   * classifier, or the session's scope cannot be read or has no levels. Jev reads the text without
   * its tag, the conversation before it (the message is not in the session yet) and the scope's
   * descriptions, redacted, then cut to the classifier's caps. Never rejects: a request that cannot
   * be built, such as for text too long to redact, fails as an error before anything is sent.
   */
  const askFor = (ctx: ExtensionContext, value: RosterV2, view: BoundedHistory, text: string): Promise<JevOutcome> | undefined => {
    const settings = value.classifier;
    const scope = scopeOf(ctx);
    const section = scope.kind === "ok" ? scopeSection(value, scope.scope) : undefined;
    if (settings === undefined || section === undefined) return undefined;
    try {
      const { levels } = section;
      const descriptions: Record<Tier, string> = { low: levels.low.describe, medium: levels.medium.describe, high: levels.high.describe, super: levels.super.describe };
      const { messages } = settings.context;
      const recent = messages === 0 ? [] : recentMessages(view.getRecentActiveEntries({ type: "message", limit: messages * 4 }), messages);
      return askJev(ctx.modelRegistry, settings, buildContext(text, recent, descriptions, settings.context), now);
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

  /** Plan an idle input's run with the session as it is now: after a wait, its selection, pin, scope and roster may have moved. */
  const plan = (ctx: ExtensionContext, record: Session, text: string, level: LevelInput, token: number): Plan | undefined => {
    if (!ctx.isIdle()) return undefined;
    const { sessionManager } = ctx;
    const state = loaded(roster.current());
    const id = virtualIdOf(ctx.model);
    if (id === undefined || state.kind !== "ok" || boundedHistory(sessionManager) === undefined) return undefined;
    // smart-router/auto refuses this scope at the run's first request, so there is no run to plan.
    if (id === "auto" && scopeRefusal(state.value, ctx) !== undefined) return undefined;
    const rc = contextFor(ctx, state.value, id, pinOf(ctx));
    const planned = planUserTurn({ rc, text, last: record.last, now: now(), reserve: reserveFor(pi.getSettings(), id), level });
    record.plan = planned;
    record.planText = text;
    record.plannedToken = token;
    return planned;
  };

  /**
   * Whether a plan or a pending level made for a message's text belongs to the run a prompt starts.
   * Pi starts a prompt's run once that prompt's input handlers return, so two messages that overlap
   * a Jev wait can start their runs in either order, and a run belongs to the message whose text is
   * its prompt. Pi expands a template or skill after the input handlers, and a later extension can
   * change the text, so a prompt can match no message's text: it is still the plan's message's when
   * that is the only idle message since the latest run started. With two, it cannot be told whose,
   * and it is neither's.
   */
  const ownsRun = (record: Session, text: string | undefined, prompt: string): boolean =>
    text !== undefined && (text === prompt || record.inputsSinceRun === 1);

  // The decision point: a prompt typed while the session is idle plans its run. Input that
  // arrives while a run starts or streams (steering, follow-ups) neither plans nor drops; its tag
  // is removed with a notice. A roster edit read here that lists the session's directory is
  // recorded before the run is planned, and nothing is planned for a scope smart-router/auto
  // refuses (plan()), where Jev is not asked either (askFor). A version 2 run on auto, unpinned,
  // takes the level its last input planned with when an extension resends that text
  // (pi-idle-check), else its tag's, with Jev's opinion asked and recorded without waiting, else
  // Jev's answer, waited for. The plan and its pending level carry the message's text, which binds
  // them to the run the message's prompt starts.
  const planInput = async (event: InputEvent, ctx: ExtensionContext, tagged: Tagged | undefined, previous: LastInput | undefined): Promise<void> => {
    const tier = tagged?.tier;
    if (!ctx.isIdle()) {
      if (tier !== undefined) notify(ctx, tagIgnoredNotice(tier, "busy"), "warning");
      return;
    }
    const text = tagged === undefined ? event.text : tagged.text;
    const { sessionManager } = ctx;
    const sessionId = sessionManager.getSessionId();
    const record = recordOf(sessionId);
    const token = ++inputs;
    record.inputsSinceRun += 1;
    const state = refreshFiles();
    guarded("input", ctx, () => recordDirectory(ctx));
    const id = virtualIdOf(ctx.model);
    const pinned = pinOf(ctx).on;
    const value = state.kind === "ok" ? state.value : undefined;
    if (tier !== undefined) {
      const why: TagIgnored | undefined = pinned
        ? "pinned"
        : id !== "auto"
          ? { selection: describeModel(ctx.model) }
          : value?.version === 1
            ? "version"
            : value !== undefined && scopeRefusal(value, ctx) !== undefined
              ? "scope"
              : undefined;
      if (why !== undefined) notify(ctx, tagIgnoredNotice(tier, why), "warning");
    }
    let level: LevelInput = {};
    let opinion = false;
    const view = boundedHistory(sessionManager);
    if (id === "auto" && !pinned && value?.version === 2 && view !== undefined) {
      if (tagged === undefined && event.source === "extension" && previous?.text === text) {
        level = previous.level;
      } else if (tier !== undefined) {
        level = { tag: tier };
        const asked = askFor(ctx, value, view, text);
        if (asked !== undefined) {
          opinion = true;
          void asked.then(landOpinion(sessionId, record, token)).catch(() => {
            // An opinion only feeds the record, so there is nothing to do when landing it fails.
          });
        }
      } else {
        const asked = askFor(ctx, value, view, text);
        if (asked !== undefined) {
          const jev = await asked;
          // The session ended during the wait, or a newer message has planned since. A stale token
          // alone does not stop it: an earlier message whose answer comes first plans its own run.
          if (records.get(sessionId) !== record || record.plannedToken > token) return;
          level = { jev };
        }
      }
    }
    const planned = plan(ctx, record, text, level, token);
    const planLevel = planned?.level;
    if (planned === undefined || planLevel === undefined || planned.signal === "local") return;
    record.pendingLevel = { token, text, level: planLevel, keyword: { signal: planned.signal, reason: planned.reason }, at: now(), jev: opinion ? "pending" : level.jev };
    record.lastInput = { text, level };
    if (planLevel.steppedUp && planned.decision.ok) notify(ctx, stepUpNotice(planLevel.start, planLevel.tier, planned.decision.choice.model.id), "info");
  };

  const messageEnd = (event: MessageEndEvent, ctx: ExtensionContext): void => {
    const { message } = event;
    if (message.role !== "assistant" || message.provider === PROVIDER || message.api === VIRTUAL_API) return;
    if (message.stopReason === "error") {
      const state = roster.current();
      if (state.kind === "ok") coolFrom(message, state.value, cooldowns, now());
      return;
    }
    if (message.stopReason === "aborted") return;
    recordOf(ctx.sessionManager.getSessionId()).last = { ref: `${message.provider}/${message.model}`, at: now(), usage: message.usage };
  };

  /**
   * A fork or /new carries the scope the latch, an entry or the work directories set. A default
   * scope is not carried, so the new session decides its own, and neither is an unreadable one,
   * whose value is unknown.
   */
  const leaveScope = (event: SessionShutdownEvent, ctx: ExtensionContext): void => {
    const { reason, targetSessionFile: target } = event;
    if ((reason !== "new" && reason !== "fork") || typeof target !== "string" || target === "") return;
    const scope = scopeOf(ctx);
    if (scope.kind === "ok" && scope.source !== "default") leaveScopeHandoff(slot, target, scope.scope);
  };

  const shutdown = (event: SessionShutdownEvent, ctx: ExtensionContext): void => {
    try {
      // The pin and the scope go with a fork or /new into the session it creates, keyed by that
      // session's file, each in its own map.
      leaveHandoff(slot, event.reason, event.targetSessionFile, pinOf(ctx));
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

  const guardedAsync = async (name: string, ctx: ExtensionContext, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      report(name, ctx, error);
    }
  };

  const filesNow = (state: Loaded<Roster>): Files => ({
    roster: state,
    labels: state.kind === "ok" && needsLabels(state.value) ? labels.current() : undefined,
  });

  const commandHost: CommandHost = {
    pi,
    guards,
    now,
    refresh: () => filesNow(refreshFiles()),
    reload: (ctx) => {
      const state = loaded(roster.reload());
      if (state.kind === "ok" && needsLabels(state.value)) labels.reload();
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
    pinOf,
    session: (ctx) => records.get(ctx.sessionManager.getSessionId()),
    resolver: contextFor,
  };

  const api: Router = {
    routeOwned: (id, request, ctx) => routeOwned(prepare(id, request, ctx)),
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
      target.on("session_start", (_event, ctx) => guardedAsync("session_start", ctx, () => start(ctx)));
      target.on("input", async (event, ctx) => {
        // The tag first: whatever fails after this, the model never sees it, and a message that is
        // only a tag is never sent.
        const tagged = parseTag(event.text);
        const result: InputEventResult | undefined = tagged === undefined ? undefined : tagged.text === "" ? HANDLED : { action: "transform", text: tagged.text };
        try {
          const previous = guarded("input", ctx, () => resetInput(ctx));
          const veto = guards.input(ctx);
          if (veto !== undefined) return veto;
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
          if (event.messageType === "custom") {
            // A custom message's run has no input: what an earlier input planned or kept is not its.
            record.plan = undefined;
            record.planText = undefined;
            record.pendingLevel = undefined;
            record.lastInput = undefined;
          } else {
            // A prompt's run takes only its own message's plan and pending level, never another's.
            if (record.plan !== undefined && !ownsRun(record, record.planText, event.prompt)) {
              record.plan = undefined;
              record.planText = undefined;
            }
            if (record.pendingLevel !== undefined && !ownsRun(record, record.pendingLevel.text, event.prompt)) record.pendingLevel = undefined;
          }
          record.inputsSinceRun = 0;
        });
        // Every run starts here, so a run without an input (a custom message's, a goal-x
        // continuation's) records the work directories' scope too.
        guarded("before_agent_start", ctx, () => recordDirectory(ctx));
      });
      target.on("turn_start", async (_event, ctx) => {
        guarded("turn_start", ctx, () => void heal(ctx));
        await guards.turnStart(ctx);
      });
      target.on("message_end", (event, ctx) => guarded("message_end", ctx, () => messageEnd(event, ctx)));
      target.on("agent_settled", (_event, ctx) =>
        guarded("agent_settled", ctx, () => {
          const record = recordOf(ctx.sessionManager.getSessionId());
          record.plan = undefined;
          record.planText = undefined;
          record.runPick = undefined;
        }),
      );
      target.on("model_select", (event, ctx) => guards.modelSelect(event, ctx));
      target.on("session_before_compact", (_event, ctx) => {
        guarded("session_before_compact", ctx, () => void heal(ctx));
        return guards.beforeCompact(ctx);
      });
      target.on("session_before_tree", (event, ctx) => {
        guarded("session_before_tree", ctx, () => void heal(ctx));
        return guards.beforeTree(event, ctx);
      });
      target.on("before_provider_request", (_event, ctx) => guards.beforeProviderRequest(ctx));
      target.on("cache_warming_decision", (_event, ctx) => guards.cacheWarming(ctx));
      target.on("session_shutdown", (event, ctx) => guarded("session_shutdown", ctx, () => shutdown(event, ctx)));
      target.registerCommand(COMMAND, smartRouterCommand(commandHost));
    },

    record: (sessionId) => records.get(sessionId),
    limits: () => limits,
  };
  return api;
}
