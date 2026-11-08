// The pin's guards: what keeps a pinned session's conversation on local models whatever the
// selection, in any extension load order.
//
// A selection is allowed under the pin when it is smart-router/local, or a physical model whose
// provider and catalog host are in the pin's policy. smart-router/auto is not allowed, although its
// route obeys the pin. While a pinned session's selection is not allowed, or the session is locked:
//
//   turn_start              the selection is switched to smart-router/local before the request is
//                           prepared; if it is still not allowed after that, or the session is
//                           locked, the run is aborted, and its request fails in auth resolution
//                           before any provider is called
//   model_select            a set or cycle to a model that is not allowed is reverted, at most once
//                           a second; another one inside that second locks the session instead
//   input                   the prompt is refused (a courtesy: a later input handler can still
//                           switch the model, which model_select and turn_start then meet)
//   session_before_compact  compaction is cancelled; summaries pass no payload hook, so this is
//   session_before_tree     their only barrier (tree navigation only when it summarizes)
//   before_provider_request the payload becomes null and the run is aborted, for a physical model
//                           outside the policy or another router's model, or while locked; later
//                           handlers see only the null
//   cache_warming_decision  warming stops, under the same condition
//
// The lock holds until an allowed selection holds through a model_select or a turn_start, or until
// John unpins. The pin blocks no tools: it pins the model only (John's decision Q7).
//
// Pi catches handler errors and carries on, so each guard catches its own and, unless the session
// is known to be unpinned, denies.
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  CacheWarmingDecisionEventResult,
  ExtensionAPI,
  ExtensionContext,
  InputEventResult,
  ModelSelectEvent,
  SessionBeforeCompactResult,
  SessionBeforeTreeEvent,
  SessionBeforeTreeResult,
} from "@earendil-works/pi-coding-agent";

import { PROVIDER, STATUS_KEY, VIRTUAL_API } from "./constants.ts";
import { firstLine } from "./errors.ts";
import { checkLocal } from "./local.ts";
import type { PinReading } from "./pin.ts";
import type { Pin } from "./route.ts";

/** Something kept the pinned session's selection away from local models. */
export interface Lock {
  readonly since: number;
  /** The model the selection was switched to. */
  readonly model: string;
  /** `conflict`: something keeps switching away; `restore`: a restored selection could not be switched. */
  readonly cause: "conflict" | "restore";
}

/** A session's guard state, kept with its other records in the owning router instance. */
export interface GuardState {
  lock: Lock | undefined;
  /** When the router last switched the selection itself. */
  revertedAt: number | undefined;
  /** How many of the router's own switches are in progress. */
  reverting: number;
}

export function newGuardState(): GuardState {
  return { lock: undefined, revertedAt: undefined, reverting: 0 };
}

/** At most one revert per session in this window; another disallowed selection inside it locks. */
export const REVERT_WINDOW_MS = 1_000;

/** The status item while pinned, and while locked. */
export const STATUS_PINNED = "local models";
export const STATUS_LOCKED = "local models: locked";

type Selection = Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">;

export const describeModel = (model: { readonly provider: string; readonly id: string } | undefined): string =>
  model === undefined ? "no model" : `${model.provider}/${model.id}`;

const isRouterModel = (model: Selection): boolean => model.provider === PROVIDER && model.api === VIRTUAL_API;

/** Whether a selection may stay while pinned: smart-router/local, or a physical model inside the policy. */
export function selectionAllowed(model: Selection | undefined, pin: Pin): boolean {
  if (!pin.on) return true;
  if (model === undefined) return false;
  if (isRouterModel(model)) return model.id === "local";
  return model.api !== VIRTUAL_API && checkLocal(model, pin.policy, false).ok;
}

/**
 * Whether a provider request made under this selection may carry the conversation while pinned.
 * Both of the router's own models route only inside the pin's policy, so their requests are
 * trusted; another router's model is not.
 */
export function requestAllowed(model: Selection | undefined, pin: Pin): boolean {
  if (!pin.on) return true;
  if (model === undefined) return false;
  if (isRouterModel(model)) return true;
  return model.api !== VIRTUAL_API && checkLocal(model, pin.policy, false).ok;
}

export interface GuardOptions {
  readonly pi: Pick<ExtensionAPI, "setModel">;
  readonly now: () => number;
  /** The session's pin, read fail closed. Never throws. */
  readonly pinOf: (ctx: ExtensionContext) => PinReading;
  readonly stateOf: (ctx: ExtensionContext) => GuardState;
}

export interface Guards {
  input(ctx: ExtensionContext): InputEventResult | undefined;
  turnStart(ctx: ExtensionContext): Promise<void>;
  modelSelect(event: Pick<ModelSelectEvent, "model" | "previousModel" | "source">, ctx: ExtensionContext): Promise<void>;
  beforeCompact(ctx: ExtensionContext): SessionBeforeCompactResult | undefined;
  beforeTree(event: Pick<SessionBeforeTreeEvent, "preparation">, ctx: ExtensionContext): SessionBeforeTreeResult | undefined;
  beforeProviderRequest(ctx: ExtensionContext): null | undefined;
  cacheWarming(ctx: ExtensionContext): CacheWarmingDecisionEventResult | undefined;
  /** At session_start: switch a restored selection that is not allowed to smart-router/local, or lock. */
  enforce(ctx: ExtensionContext): Promise<void>;
  /** For /smart-router local on: switch a selection that is not allowed. True when the selection is allowed afterwards. */
  switchToLocal(ctx: ExtensionContext): Promise<boolean>;
  /** Clear the lock, as unpinning does. */
  unlock(ctx: ExtensionContext): void;
  showStatus(ctx: ExtensionContext): void;
}

const HANDLED: InputEventResult = Object.freeze({ action: "handled" });
const CANCEL = Object.freeze({ cancel: true });
const STOP: CacheWarmingDecisionEventResult = Object.freeze({ action: "stop" });

const WAY_OUT =
  "To get out: /new (the pin carries over), a branch before any native Codex compaction checkpoint, smart-router/local chosen with /model, or /smart-router local off.";

function lockNotice(lock: Lock): string {
  const why =
    lock.cause === "restore"
      ? `its restored selection ${lock.model} is not local, and smart-router/local could not be selected`
      : `something keeps switching it to ${lock.model}`;
  const causes =
    lock.cause === "conflict"
      ? " The usual causes are Multi-Pass allowedSubs in this project (list smart-router there), or a branch that holds a native Codex compaction checkpoint, which codex-compat keeps on openai-codex."
      : "";
  return `pi-smart-router: this session is pinned to local models, and ${why}, so it is locked: prompts are refused, runs are stopped before anything is sent, compaction is cancelled, and provider requests are emptied.${causes} ${WAY_OUT}`;
}

export function createGuards(options: GuardOptions): Guards {
  const { pi, now, pinOf, stateOf } = options;

  const notify = (ctx: ExtensionContext, text: string, type: "info" | "warning" | "error"): void => {
    try {
      if (ctx.hasUI) ctx.ui.notify(text, type);
    } catch {
      // Nowhere to report to.
    }
  };

  const abort = (ctx: ExtensionContext): void => {
    try {
      ctx.abort();
    } catch {
      // A stale context has no run to abort.
    }
  };

  const showStatus = (ctx: ExtensionContext): void => {
    try {
      const text = !pinOf(ctx).on ? undefined : stateOf(ctx).lock !== undefined ? STATUS_LOCKED : STATUS_PINNED;
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      // The status item is a courtesy.
    }
  };

  /** Run a guard. Unpinned, it allows; on an internal error it denies, unless the session is known to be unpinned. */
  function guard<T>(ctx: ExtensionContext, name: string, run: (pin: PinReading, state: GuardState) => T, deny: () => T): T | undefined {
    let pin: PinReading | undefined;
    try {
      pin = pinOf(ctx);
      return pin.on ? run(pin, stateOf(ctx)) : undefined;
    } catch (error) {
      if (pin?.on === false) return undefined;
      notify(ctx, `pi-smart-router: the ${name} guard failed (${firstLine(error)}), so it denied.`, "error");
      return deny();
    }
  }

  async function guardAsync(ctx: ExtensionContext, name: string, run: (pin: PinReading, state: GuardState) => Promise<void>, deny: () => void): Promise<void> {
    let pin: PinReading | undefined;
    try {
      pin = pinOf(ctx);
      if (pin.on) await run(pin, stateOf(ctx));
    } catch (error) {
      if (pin?.on === false) return;
      notify(ctx, `pi-smart-router: the ${name} guard failed (${firstLine(error)}), so it denied.`, "error");
      deny();
    }
  }

  const localModel = (ctx: ExtensionContext): Model<Api> | undefined => {
    const found = ctx.modelRegistry.find(PROVIDER, "local");
    return found?.api === VIRTUAL_API ? found : undefined;
  };

  /** One of the router's own switches. It counts as a revert for the loop breaker. */
  const switchTo = async (state: GuardState, target: Model<Api>): Promise<boolean> => {
    state.revertedAt = now();
    state.reverting += 1;
    try {
      return await pi.setModel(target);
    } catch {
      return false;
    } finally {
      state.reverting -= 1;
    }
  };

  const lock = (ctx: ExtensionContext, state: GuardState, model: Selection | undefined, cause: Lock["cause"]): void => {
    const fresh = state.lock === undefined;
    state.lock = { since: state.lock?.since ?? now(), model: describeModel(model), cause: state.lock?.cause ?? cause };
    try {
      if (!ctx.isIdle()) ctx.abort();
    } catch {
      // A stale context has no run to abort.
    }
    if (fresh) {
      showStatus(ctx);
      notify(ctx, lockNotice(state.lock), "error");
    }
  };

  const unlockState = (ctx: ExtensionContext, state: GuardState, announce: boolean): void => {
    if (state.lock === undefined) return;
    state.lock = undefined;
    showStatus(ctx);
    if (announce) notify(ctx, "pi-smart-router: the selection stayed local, so the session is no longer locked.", "info");
  };

  const lockOnError = (ctx: ExtensionContext): void => {
    try {
      lock(ctx, stateOf(ctx), ctx.model, "conflict");
    } catch {
      abort(ctx);
    }
  };

  const blocked = (ctx: ExtensionContext, pin: Pin, state: GuardState): boolean => state.lock !== undefined || !selectionAllowed(ctx.model, pin);

  const because = (ctx: ExtensionContext, state: GuardState): string =>
    state.lock !== undefined ? "it is locked" : `${describeModel(ctx.model)} is not local`;

  return {
    input: (ctx) =>
      guard(
        ctx,
        "input",
        (pin, state) => {
          if (!blocked(ctx, pin, state)) return undefined;
          notify(
            ctx,
            state.lock !== undefined
              ? `pi-smart-router: this session is pinned to local models and locked, so the prompt was not sent. ${WAY_OUT}`
              : `pi-smart-router: this session is pinned to local models, and ${describeModel(ctx.model)} is not local, so the prompt was not sent. Choose smart-router/local or a local model with /model, or run /smart-router local off.`,
            "warning",
          );
          return HANDLED;
        },
        () => HANDLED,
      ),

    turnStart: (ctx) =>
      guardAsync(
        ctx,
        "turn_start",
        async (pin, state) => {
          const wasLocked = state.lock !== undefined;
          if (!wasLocked && !selectionAllowed(ctx.model, pin)) {
            const target = localModel(ctx);
            if (target !== undefined) await switchTo(state, target);
          }
          if (selectionAllowed(ctx.model, pin)) {
            // An allowed selection held through turn_start: whatever locked the session has stopped.
            unlockState(ctx, state, true);
            return;
          }
          ctx.abort();
          if (state.lock === undefined) {
            notify(
              ctx,
              `pi-smart-router: this session is pinned to local models, and its selection ${describeModel(ctx.model)} could not be switched to smart-router/local, so the run was stopped before anything was sent.`,
              "error",
            );
          } else if (wasLocked) {
            notify(ctx, `pi-smart-router: this session is pinned to local models and locked, so the run was stopped before anything was sent. ${WAY_OUT}`, "error");
          }
        },
        () => abort(ctx),
      ),

    modelSelect: (event, ctx) =>
      guardAsync(
        ctx,
        "model_select",
        async (pin, state) => {
          if (event.source !== "set" && event.source !== "cycle") return;
          if (selectionAllowed(event.model, pin)) {
            // Someone else chose an allowed model; the router's own switches prove nothing.
            if (state.reverting === 0) unlockState(ctx, state, true);
            return;
          }
          const recent = state.revertedAt !== undefined && now() - state.revertedAt < REVERT_WINDOW_MS;
          if (state.lock !== undefined || state.reverting > 0 || recent) {
            lock(ctx, state, event.model, "conflict");
            return;
          }
          const previous = event.previousModel === undefined ? undefined : (ctx.modelRegistry.find(event.previousModel.provider, event.previousModel.id) ?? event.previousModel);
          const target = previous !== undefined && selectionAllowed(previous, pin) ? previous : localModel(ctx);
          if (target === undefined || !(await switchTo(state, target)) || !selectionAllowed(ctx.model, pin)) {
            if (state.lock === undefined) lock(ctx, state, ctx.model ?? event.model, "conflict");
            return;
          }
          notify(
            ctx,
            `pi-smart-router: this session is pinned to local models, so ${describeModel(event.model)} was not kept, and the selection is ${describeModel(target)} again. Run /smart-router local off to unpin.`,
            "warning",
          );
        },
        () => lockOnError(ctx),
      ),

    beforeCompact: (ctx) =>
      guard(
        ctx,
        "session_before_compact",
        (pin, state) => {
          if (!blocked(ctx, pin, state)) return undefined;
          notify(ctx, `pi-smart-router: this session is pinned to local models, and ${because(ctx, state)}, so compaction was cancelled. Choose smart-router/local with /model, then compact.`, "warning");
          return CANCEL;
        },
        () => CANCEL,
      ),

    beforeTree: (event, ctx) =>
      guard(
        ctx,
        "session_before_tree",
        (pin, state) => {
          // Plain navigation sends nothing; only a summary goes to a model.
          if (event.preparation?.userWantsSummary === false || !blocked(ctx, pin, state)) return undefined;
          notify(
            ctx,
            `pi-smart-router: this session is pinned to local models, and ${because(ctx, state)}, so the navigation with a summary was cancelled. Navigate without a summary, or choose smart-router/local with /model first.`,
            "warning",
          );
          return CANCEL;
        },
        () => CANCEL,
      ),

    beforeProviderRequest: (ctx) =>
      guard<null | undefined>(
        ctx,
        "before_provider_request",
        (pin, state) => {
          if (state.lock === undefined && requestAllowed(ctx.model, pin)) return undefined;
          ctx.abort();
          notify(
            ctx,
            `pi-smart-router: this session is pinned to local models, and ${state.lock !== undefined ? "it is locked" : `a request to ${describeModel(ctx.model)} would leave this machine`}, so the request was emptied and the run stopped.`,
            "error",
          );
          return null;
        },
        () => {
          abort(ctx);
          return null;
        },
      ),

    cacheWarming: (ctx) => guard(ctx, "cache_warming_decision", (pin, state) => (state.lock === undefined && requestAllowed(ctx.model, pin) ? undefined : STOP), () => STOP),

    enforce: (ctx) =>
      guardAsync(
        ctx,
        "session_start",
        async (pin, state) => {
          if (selectionAllowed(ctx.model, pin)) return;
          const restored = ctx.model;
          const target = localModel(ctx);
          if (target !== undefined) await switchTo(state, target);
          if (selectionAllowed(ctx.model, pin)) {
            notify(ctx, `pi-smart-router: this session is pinned to local models, so its selection ${describeModel(restored)} was switched to smart-router/local.`, "info");
          } else if (state.lock === undefined) {
            lock(ctx, state, ctx.model, "restore");
          }
        },
        () => lockOnError(ctx),
      ),

    switchToLocal: async (ctx) => {
      const pin = pinOf(ctx);
      const state = stateOf(ctx);
      if (selectionAllowed(ctx.model, pin)) return true;
      const target = localModel(ctx);
      if (target === undefined || !(await switchTo(state, target))) return false;
      return selectionAllowed(ctx.model, pin);
    },

    unlock: (ctx) => unlockState(ctx, stateOf(ctx), false),
    showStatus,
  };
}
