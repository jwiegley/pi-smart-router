// The guards: what keeps a guarded session's conversation on the models its policy allows,
// whatever the selection, in any extension load order. The pin's policy guards a pinned session,
// and work scope's policy every other session in work scope. A personal session that is not pinned
// has no guard, so a model picked by hand is sent as it is.
//
//   the pin     smart-router/local, or a physical model whose provider and catalog host are in the
//               pin's policy. smart-router/auto is not allowed, although its route obeys the pin.
//   work scope  smart-router/auto, or a physical model of a work-bound Codex account (isWorkCodex),
//               by the bindings of the roster as it is now or, while it fails to load, of the last
//               valid roster loaded in the process. A scope that cannot be read is work scope, the
//               narrower one, as routing resolves it.
//
// Each policy has a model of the router's own that it switches to: smart-router/local under the
// pin, smart-router/auto in work scope. While a guarded session's selection is not allowed, or the
// session is locked:
//
//   turn_start              the selection is switched to the policy's own model before the request
//                           is prepared; if it is still not allowed after that, or the session is
//                           locked, the run is aborted, and its request fails in auth resolution
//                           before any provider is called
//   model_select            a set or cycle to a model that is not allowed is reverted, at most once
//                           a second, to the policy's own model (under the pin, to the previous
//                           model when the pin allows it); another one inside that second locks the
//                           session instead
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
// John unpins. A lock acts only while a policy guards the session, so it does nothing in a session
// moved to personal scope. The guards block no tools: they guard the model only (John's decision
// Q7). Each policy's texts are in its own words.
//
// Pi catches handler errors and carries on, so each guard catches its own and denies. A session
// known to be unguarded runs no guard.
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

import { isWorkCodex } from "./accounts.ts";
import type { ScopedAccounts } from "./accounts.ts";
import { PROVIDER, STATUS_KEY, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { firstLine } from "./errors.ts";
import { checkLocal } from "./local.ts";
import type { PinReading } from "./pin.ts";
import type { Pin } from "./route.ts";
import type { ScopeState } from "./scope.ts";

/** Something kept a guarded session's selection away from the models its policy allows. */
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

/** The policy that guards a session: the pin's while pinned, else work scope's with the account bindings it reads. */
type Policy = { readonly kind: "pin"; readonly pin: Pin } | { readonly kind: "work"; readonly accounts: ScopedAccounts };

/** Whether a selection may stay under a policy: the pin's rule, or work scope's: smart-router/auto, or a physical model of a work-bound Codex account. */
function allows(policy: Policy, model: Selection | undefined): boolean {
  if (policy.kind === "pin") return selectionAllowed(model, policy.pin);
  if (model === undefined) return false;
  if (isRouterModel(model)) return model.id === "auto";
  return model.api !== VIRTUAL_API && isWorkCodex(policy.accounts, model.provider);
}

/**
 * Whether a provider request made under this selection may carry the conversation, under a policy.
 * In work scope too, both of the router's own models route only inside the policy (assertSafe in
 * src/route.ts; smart-router/local only to LAN models, which hold no account), so their requests
 * are trusted; another router's model is not.
 */
function trusts(policy: Policy, model: Selection | undefined): boolean {
  if (policy.kind === "pin") return requestAllowed(model, policy.pin);
  if (model === undefined) return false;
  if (isRouterModel(model)) return true;
  return model.api !== VIRTUAL_API && isWorkCodex(policy.accounts, model.provider);
}

export interface GuardOptions {
  readonly pi: Pick<ExtensionAPI, "setModel">;
  readonly now: () => number;
  /** The session's pin, read fail closed. Never throws. */
  readonly pinOf: (ctx: ExtensionContext) => PinReading;
  /** The session's scope, read fail closed. Never throws. */
  readonly scopeOf: (ctx: ExtensionContext) => ScopeState;
  /** The account bindings work scope's policy reads: the roster's as it is now, else the last valid roster's in the process, else none. Never throws. */
  readonly accountsOf: () => ScopedAccounts;
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
  /** At session_start: switch a restored selection that is not allowed to the policy's own model, or lock. */
  enforce(ctx: ExtensionContext): Promise<void>;
  /** For /smart-router local on: switch a selection that is not allowed. True when the selection is allowed afterwards. */
  switchToLocal(ctx: ExtensionContext): Promise<boolean>;
  /**
   * For /smart-router scope work: under work scope's policy, switch a selection outside it to
   * smart-router/auto. True when the selection is allowed afterwards. It switches nothing under the
   * pin, whose rules alone apply, and a personal session's selection is always allowed.
   */
  switchToAuto(ctx: ExtensionContext): Promise<boolean>;
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

/** How each of work scope's texts begins. */
const IN_WORK = "pi-smart-router: this session is in work scope";

const WORK_WAY_OUT =
  "To get out: /new (the work scope carries over), a branch before any native Codex compaction checkpoint, smart-router/auto or a work Codex model chosen with /model, or /smart-router scope personal.";

/** lockNotice in work scope's words. */
function workLockNotice(lock: Lock): string {
  const why =
    lock.cause === "restore"
      ? `its restored selection ${lock.model} is outside work scope, and smart-router/auto could not be selected`
      : `something keeps switching it to ${lock.model}`;
  const causes =
    lock.cause === "conflict"
      ? " The usual causes are Multi-Pass allowedSubs in this project (list smart-router there), or a branch that holds a native Codex compaction checkpoint, which codex-compat keeps on openai-codex."
      : "";
  return `${IN_WORK}, and ${why}, so it is locked: prompts are refused, runs are stopped before anything is sent, compaction is cancelled, and provider requests are emptied.${causes} ${WORK_WAY_OUT}`;
}

export function createGuards(options: GuardOptions): Guards {
  const { pi, now, pinOf, scopeOf, accountsOf, stateOf } = options;

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

  /** The policy that guards a session, the pin's first; undefined for a personal session that is not pinned. Never throws. */
  const policyOf = (ctx: ExtensionContext): Policy | undefined => {
    const pin = pinOf(ctx);
    if (pin.on) return { kind: "pin", pin };
    const scope = scopeOf(ctx);
    return scope.kind === "ok" && scope.scope === "personal" ? undefined : { kind: "work", accounts: accountsOf() };
  };

  /** Run a guard under the session's policy. Unguarded, it allows; on an internal error it denies. */
  function guard<T>(ctx: ExtensionContext, name: string, run: (policy: Policy, state: GuardState) => T, deny: (policy: Policy | undefined) => T): T | undefined {
    let policy: Policy | undefined;
    try {
      policy = policyOf(ctx);
      return policy === undefined ? undefined : run(policy, stateOf(ctx));
    } catch (error) {
      notify(ctx, `pi-smart-router: the ${name} guard failed (${firstLine(error)}), so it denied.`, "error");
      return deny(policy);
    }
  }

  async function guardAsync(ctx: ExtensionContext, name: string, run: (policy: Policy, state: GuardState) => Promise<void>, deny: (policy: Policy | undefined) => void): Promise<void> {
    let policy: Policy | undefined;
    try {
      policy = policyOf(ctx);
      if (policy !== undefined) await run(policy, stateOf(ctx));
    } catch (error) {
      notify(ctx, `pi-smart-router: the ${name} guard failed (${firstLine(error)}), so it denied.`, "error");
      deny(policy);
    }
  }

  /** One of the router's own models, as the catalog holds it now. */
  const routerModel = (ctx: ExtensionContext, id: VirtualId): Model<Api> | undefined => {
    const found = ctx.modelRegistry.find(PROVIDER, id);
    return found?.api === VIRTUAL_API ? found : undefined;
  };

  /** The model a policy switches a selection it does not allow to: smart-router/local under the pin, smart-router/auto in work scope. */
  const ownModel = (ctx: ExtensionContext, policy: Policy): Model<Api> | undefined => routerModel(ctx, policy.kind === "pin" ? "local" : "auto");

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

  /** Lock the session, and say so in the words of the policy that locked it (the pin's when it could not be read). */
  const lock = (ctx: ExtensionContext, state: GuardState, policy: Policy | undefined, model: Selection | undefined, cause: Lock["cause"]): void => {
    const fresh = state.lock === undefined;
    state.lock = { since: state.lock?.since ?? now(), model: describeModel(model), cause: state.lock?.cause ?? cause };
    try {
      if (!ctx.isIdle()) ctx.abort();
    } catch {
      // A stale context has no run to abort.
    }
    if (fresh) {
      showStatus(ctx);
      notify(ctx, policy?.kind === "work" ? workLockNotice(state.lock) : lockNotice(state.lock), "error");
    }
  };

  /** Clear the lock; with the policy that guards the session, say so in its words. */
  const unlockState = (ctx: ExtensionContext, state: GuardState, announce: Policy | undefined): void => {
    if (state.lock === undefined) return;
    state.lock = undefined;
    showStatus(ctx);
    if (announce === undefined) return;
    notify(
      ctx,
      announce.kind === "work"
        ? "pi-smart-router: the selection stayed within work scope, so the session is no longer locked."
        : "pi-smart-router: the selection stayed local, so the session is no longer locked.",
      "info",
    );
  };

  const lockOnError = (ctx: ExtensionContext, policy: Policy | undefined): void => {
    try {
      lock(ctx, stateOf(ctx), policy, ctx.model, "conflict");
    } catch {
      abort(ctx);
    }
  };

  const blocked = (ctx: ExtensionContext, policy: Policy, state: GuardState): boolean => state.lock !== undefined || !allows(policy, ctx.model);

  const because = (ctx: ExtensionContext, policy: Policy, state: GuardState): string =>
    state.lock !== undefined ? "it is locked" : `${describeModel(ctx.model)} ${policy.kind === "work" ? "is outside it" : "is not local"}`;

  return {
    input: (ctx) =>
      guard(
        ctx,
        "input",
        (policy, state) => {
          if (!blocked(ctx, policy, state)) return undefined;
          if (policy.kind === "work") {
            notify(
              ctx,
              state.lock !== undefined
                ? `${IN_WORK} and locked, so the prompt was not sent. ${WORK_WAY_OUT}`
                : `${IN_WORK}, and ${describeModel(ctx.model)} is outside it, so the prompt was not sent. Choose smart-router/auto or a work Codex model with /model, or run /smart-router scope personal.`,
              "warning",
            );
          } else {
            notify(
              ctx,
              state.lock !== undefined
                ? `pi-smart-router: this session is pinned to local models and locked, so the prompt was not sent. ${WAY_OUT}`
                : `pi-smart-router: this session is pinned to local models, and ${describeModel(ctx.model)} is not local, so the prompt was not sent. Choose smart-router/local or a local model with /model, or run /smart-router local off.`,
              "warning",
            );
          }
          return HANDLED;
        },
        () => HANDLED,
      ),

    turnStart: (ctx) =>
      guardAsync(
        ctx,
        "turn_start",
        async (policy, state) => {
          const wasLocked = state.lock !== undefined;
          if (!wasLocked && !allows(policy, ctx.model)) {
            const target = ownModel(ctx, policy);
            if (target !== undefined) await switchTo(state, target);
          }
          if (allows(policy, ctx.model)) {
            // An allowed selection held through turn_start: whatever locked the session has stopped.
            unlockState(ctx, state, policy);
            return;
          }
          ctx.abort();
          if (state.lock === undefined) {
            notify(
              ctx,
              policy.kind === "work"
                ? `${IN_WORK}, and its selection ${describeModel(ctx.model)} could not be switched to smart-router/auto, so the run was stopped before anything was sent.`
                : `pi-smart-router: this session is pinned to local models, and its selection ${describeModel(ctx.model)} could not be switched to smart-router/local, so the run was stopped before anything was sent.`,
              "error",
            );
          } else if (wasLocked) {
            notify(
              ctx,
              policy.kind === "work"
                ? `${IN_WORK} and locked, so the run was stopped before anything was sent. ${WORK_WAY_OUT}`
                : `pi-smart-router: this session is pinned to local models and locked, so the run was stopped before anything was sent. ${WAY_OUT}`,
              "error",
            );
          }
        },
        () => abort(ctx),
      ),

    modelSelect: (event, ctx) =>
      guardAsync(
        ctx,
        "model_select",
        async (policy, state) => {
          if (event.source !== "set" && event.source !== "cycle") return;
          if (allows(policy, event.model)) {
            // Someone else chose an allowed model; the router's own switches prove nothing.
            if (state.reverting === 0) unlockState(ctx, state, policy);
            return;
          }
          const recent = state.revertedAt !== undefined && now() - state.revertedAt < REVERT_WINDOW_MS;
          if (state.lock !== undefined || state.reverting > 0 || recent) {
            lock(ctx, state, policy, event.model, "conflict");
            return;
          }
          // The pin goes back to the previous model when it allows that one; work scope always to smart-router/auto.
          const previous =
            policy.kind === "pin" && event.previousModel !== undefined
              ? (ctx.modelRegistry.find(event.previousModel.provider, event.previousModel.id) ?? event.previousModel)
              : undefined;
          const target = previous !== undefined && allows(policy, previous) ? previous : ownModel(ctx, policy);
          if (target === undefined || !(await switchTo(state, target)) || !allows(policy, ctx.model)) {
            if (state.lock === undefined) lock(ctx, state, policy, ctx.model ?? event.model, "conflict");
            return;
          }
          notify(
            ctx,
            policy.kind === "work"
              ? `${IN_WORK}, so ${describeModel(event.model)} was not kept, and the selection is ${describeModel(target)} again.`
              : `pi-smart-router: this session is pinned to local models, so ${describeModel(event.model)} was not kept, and the selection is ${describeModel(target)} again. Run /smart-router local off to unpin.`,
            "warning",
          );
        },
        (policy) => lockOnError(ctx, policy),
      ),

    beforeCompact: (ctx) =>
      guard(
        ctx,
        "session_before_compact",
        (policy, state) => {
          if (!blocked(ctx, policy, state)) return undefined;
          notify(
            ctx,
            policy.kind === "work"
              ? `${IN_WORK}, and ${because(ctx, policy, state)}, so compaction was cancelled. Choose smart-router/auto with /model, then compact.`
              : `pi-smart-router: this session is pinned to local models, and ${because(ctx, policy, state)}, so compaction was cancelled. Choose smart-router/local with /model, then compact.`,
            "warning",
          );
          return CANCEL;
        },
        () => CANCEL,
      ),

    beforeTree: (event, ctx) =>
      guard(
        ctx,
        "session_before_tree",
        (policy, state) => {
          // Plain navigation sends nothing; only a summary goes to a model.
          if (event.preparation?.userWantsSummary === false || !blocked(ctx, policy, state)) return undefined;
          notify(
            ctx,
            policy.kind === "work"
              ? `${IN_WORK}, and ${because(ctx, policy, state)}, so the navigation with a summary was cancelled. Navigate without a summary, or choose smart-router/auto with /model first.`
              : `pi-smart-router: this session is pinned to local models, and ${because(ctx, policy, state)}, so the navigation with a summary was cancelled. Navigate without a summary, or choose smart-router/local with /model first.`,
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
        (policy, state) => {
          if (state.lock === undefined && trusts(policy, ctx.model)) return undefined;
          ctx.abort();
          notify(
            ctx,
            policy.kind === "work"
              ? `${IN_WORK}, and ${state.lock !== undefined ? "it is locked" : `a request to ${describeModel(ctx.model)} would go outside it`}, so the request was emptied and the run stopped.`
              : `pi-smart-router: this session is pinned to local models, and ${state.lock !== undefined ? "it is locked" : `a request to ${describeModel(ctx.model)} would leave this machine`}, so the request was emptied and the run stopped.`,
            "error",
          );
          return null;
        },
        () => {
          abort(ctx);
          return null;
        },
      ),

    cacheWarming: (ctx) => guard(ctx, "cache_warming_decision", (policy, state) => (state.lock === undefined && trusts(policy, ctx.model) ? undefined : STOP), () => STOP),

    enforce: (ctx) =>
      guardAsync(
        ctx,
        "session_start",
        async (policy, state) => {
          if (allows(policy, ctx.model)) return;
          const restored = ctx.model;
          const target = ownModel(ctx, policy);
          if (target !== undefined) await switchTo(state, target);
          if (allows(policy, ctx.model)) {
            notify(
              ctx,
              policy.kind === "work"
                ? `${IN_WORK}, so its selection ${describeModel(restored)} was switched to smart-router/auto.`
                : `pi-smart-router: this session is pinned to local models, so its selection ${describeModel(restored)} was switched to smart-router/local.`,
              "info",
            );
          } else if (state.lock === undefined) {
            lock(ctx, state, policy, ctx.model, "restore");
          }
        },
        (policy) => lockOnError(ctx, policy),
      ),

    switchToLocal: async (ctx) => {
      const pin = pinOf(ctx);
      const state = stateOf(ctx);
      if (selectionAllowed(ctx.model, pin)) return true;
      const target = routerModel(ctx, "local");
      if (target === undefined || !(await switchTo(state, target))) return false;
      return selectionAllowed(ctx.model, pin);
    },

    switchToAuto: async (ctx) => {
      const policy = policyOf(ctx);
      if (policy === undefined) return true;
      if (policy.kind === "pin" || allows(policy, ctx.model)) return allows(policy, ctx.model);
      const target = routerModel(ctx, "auto");
      if (target === undefined || !(await switchTo(stateOf(ctx), target))) return false;
      return allows(policy, ctx.model);
    },

    unlock: (ctx) => unlockState(ctx, stateOf(ctx), undefined),
    showStatus,
  };
}
