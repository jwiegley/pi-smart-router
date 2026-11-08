// One instance of the router: the session whose extension runtime loaded it, the two files it
// reads, its per-session records and cooldowns, the limits both models declare, the pin's guards
// and handoffs, the /smart-router command, what it tells pi-cache-optimizer, and the handlers
// wire() registers.
//
// createRouter only builds closures. It makes no pi.on, registration or command call, so a throw
// while it is built leaves only the two refusing models index.ts registered, and wire() makes
// every pi.on and registerCommand call in one place, after the router exists. No timer, watcher,
// socket or other handle is ever opened; the files are read at session_start, at idle prompts when
// they changed, and on demand.
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
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
import { COMMAND, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, PIN_ENTRY, PROVIDER, VIRTUAL_API, VIRTUAL_IDS } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { pickInRole, planUserTurn, reserveFor } from "./decide.ts";
import type { Decision, LastResponder } from "./decide.ts";
import { carriedNotice, carryFailedNotice, firstLine, historyNotice, resumeNotice, rosterNotice, rosterRefusal, stale } from "./errors.ts";
import { isRecord } from "./files.ts";
import type { FileSystem, Loaded } from "./files.ts";
import { createGuards, newGuardState } from "./guards.ts";
import type { GuardState } from "./guards.ts";
import { EMPTY_POLICY, policyFromRoster } from "./local.ts";
import { healDisplaced, isLive, isLiveOwner, join, leave, ownerBySignal, sessionHash } from "./owners.ts";
import type { Owner, OwnerRouter, Slot } from "./owners.ts";
import { latchEnvPolicy, leaveHandoff, pinOn, readPin, takeHandoff } from "./pin.ts";
import type { PinReading } from "./pin.ts";
import { coolFrom, Cooldowns, resolveContext } from "./resolve.ts";
import type { ResolveContext } from "./resolve.ts";
import { boundedHistory, newRecord, predict, requireBoundedHistory, routeOther, routeOwned } from "./route.ts";
import type { BoundedHistory, Pin, RouteInput, SessionRecord } from "./route.ts";
import { autoRoles, parseRef, rosterFile } from "./roster.ts";
import type { Roster } from "./roster.ts";

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

/** What a router instance keeps per session: the route records and the pin's guard state. */
export interface Session extends SessionRecord {
  readonly guard: GuardState;
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

  const recordOf = (sessionId: string): Session => {
    let record = records.get(sessionId);
    if (record === undefined) {
      record = { ...newRecord(), guard: newGuardState() };
      records.set(sessionId, record);
    }
    return record;
  };

  /** A session's pin, read fail closed. A context whose session cannot be read counts as pinned. */
  const pinOf = (ctx: ExtensionContext): PinReading => {
    let manager: unknown;
    try {
      manager = ctx.sessionManager;
    } catch {
      manager = undefined;
    }
    return readPin(manager, slot.env);
  };

  const guards = createGuards({ pi, now, pinOf, stateOf: (ctx) => recordOf(ctx.sessionManager.getSessionId()).guard });

  const contextFor = (ctx: ExtensionContext, value: Roster, id: VirtualId, pin: Pin): ResolveContext =>
    resolveContext({
      roster: value,
      catalog: ctx.modelRegistry,
      labels: needsLabels(value) ? labels.current() : undefined,
      cooldowns,
      now: now(),
      virtualId: id,
      localOnly: id === "local" || pin.on,
      policy: pin.on ? pin.policy : policyFromRoster(value),
      pinned: pin.on,
    });

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

  const prepare = (id: VirtualId, request: ModelRouteRequest, ctx: ExtensionContext): RouteInput => {
    const { sessionManager } = ctx;
    requireBoundedHistory(id, sessionManager);
    const state = loaded(roster.current());
    if (state.kind !== "ok") throw rosterRefusal(id, state);
    const pin = pinOf(ctx);
    return { id, request, rc: contextFor(ctx, state.value, id, pin), pin, record: recordOf(sessionManager.getSessionId()) };
  };

  // auto declares the smallest window and output budget among the first available candidate of
  // every role it can reach; local declares its first available candidate's.
  const computeLimits = (ctx: ExtensionContext, value: Roster): Record<VirtualId, Limits> => {
    const reach = contextFor(ctx, value, "auto", UNPINNED);
    const auto = smallest([...autoRoles(value)].map((role) => pickInRole(reach, role, { fallback: false, code: "limits" })));
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
  // else the run's pick, else what a continuation would pick now. Only the owner's own loop and
  // its message_end change it.
  const activeRoute = (id: VirtualId): ActiveRoute | undefined => {
    try {
      const owner = self;
      if (owner === undefined) return undefined;
      const { ctx } = owner;
      const state = loaded(roster.current());
      if (state.kind !== "ok" || boundedHistory(ctx.sessionManager) === undefined) return undefined;
      const rc = contextFor(ctx, state.value, id, pinOf(ctx));
      const record = records.get(owner.sessionId) ?? newRecord();
      const at = now();
      const answer = (model: Model<Api>, status: ActiveRoute["status"]): ActiveRoute => ({ provider: model.provider, modelId: model.id, api: model.api, status, at });
      const { plan, runPick } = record;
      if (plan !== undefined && plan.virtualId === id && plan.localOnly === rc.localOnly) {
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

  const start = async (ctx: ExtensionContext): Promise<void> => {
    const { sessionManager } = ctx;
    const sessionId = sessionManager.getSessionId();
    if (self !== undefined) leave(slot, self);
    self = { router: api, ctx, sessionId, hash: sessionHash(sessionId) };
    join(slot, self);
    registerAdapter(slot);
    const state = refreshFiles();
    limits = state.kind === "ok" ? computeLimits(ctx, state.value) : BOTH_DEFAULT;
    registerModels(ctx);
    const view = boundedHistory(sessionManager);
    const last = view === undefined ? undefined : seed(view);
    if (last !== undefined) recordOf(sessionId).last = last;
    const notice = state.kind !== "ok" ? rosterNotice(state) : view === undefined ? historyNotice() : undefined;
    if (notice !== undefined) notify(ctx, notice, "warning");
    // A fork or /new carries the pin; a resume only says that the session it left was pinned.
    const handoff = takeHandoff(slot, sessionManager.getSessionFile());
    if (handoff?.kind === "pin") {
      try {
        pi.appendEntry(PIN_ENTRY, pinOn(handoff.policy, now()));
        notify(ctx, carriedNotice(), "info");
      } catch (error) {
        notify(ctx, carryFailedNotice(firstLine(error)), "error");
      }
    } else if (handoff?.kind === "notice" && !pinOf(ctx).on) {
      notify(ctx, resumeNotice(), "warning");
    }
    await guards.enforce(ctx);
    guards.showStatus(ctx);
  };

  // The decision point: a prompt typed while the session is idle plans its run. Input that
  // arrives while a run starts or streams (steering, follow-ups) neither plans nor drops.
  const plan = (event: InputEvent, ctx: ExtensionContext): void => {
    if (!ctx.isIdle()) return;
    const { sessionManager } = ctx;
    const record = recordOf(sessionManager.getSessionId());
    const state = refreshFiles();
    const id = virtualIdOf(ctx.model);
    if (id === undefined || state.kind !== "ok" || boundedHistory(sessionManager) === undefined) return;
    const rc = contextFor(ctx, state.value, id, pinOf(ctx));
    record.plan = planUserTurn({ rc, text: event.text, last: record.last, now: now(), reserve: reserveFor(pi.getSettings(), id) });
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

  const shutdown = (event: SessionShutdownEvent, ctx: ExtensionContext): void => {
    try {
      // The pin goes with a fork or /new into the session it creates, keyed by that session's file.
      leaveHandoff(slot, event.reason, event.targetSessionFile, pinOf(ctx));
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

  const guarded = (name: string, ctx: ExtensionContext, run: () => void): void => {
    try {
      run();
    } catch (error) {
      report(name, ctx, error);
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
      target.on("input", (event, ctx) => {
        guarded("input", ctx, () => {
          if (!ctx.isIdle()) return;
          heal(ctx);
          recordOf(ctx.sessionManager.getSessionId()).plan = undefined;
        });
        const veto = guards.input(ctx);
        if (veto === undefined) guarded("input", ctx, () => plan(event, ctx));
        return veto;
      });
      target.on("before_agent_start", (event, ctx) =>
        guarded("before_agent_start", ctx, () => {
          if (event.messageType === "custom") recordOf(ctx.sessionManager.getSessionId()).plan = undefined;
        }),
      );
      target.on("turn_start", async (_event, ctx) => {
        guarded("turn_start", ctx, () => void heal(ctx));
        await guards.turnStart(ctx);
      });
      target.on("message_end", (event, ctx) => guarded("message_end", ctx, () => messageEnd(event, ctx)));
      target.on("agent_settled", (_event, ctx) =>
        guarded("agent_settled", ctx, () => {
          const record = recordOf(ctx.sessionManager.getSessionId());
          record.plan = undefined;
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
