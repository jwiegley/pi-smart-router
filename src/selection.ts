// The selection: how the router reads it, the one switch it makes, and the pin's status item.
//
// A model picked by hand always stays selected and is sent as it is, in every scope and under the
// pin (John's decision of 2026-11-16, "Manual choice always wins"). The router routes only while
// the selection is one of its own two models, smart-router/auto or smart-router/local, and its
// policies live in those two models' routes (src/router.ts, src/route.ts):
//
//   the pin     both models route only inside the pin's policy. smart-router/auto's roles seldom
//               reach it, so on John's rosters its requests are refused while the session is pinned
//   work scope  smart-router/auto routes only to the work account, and smart-router/local refuses
//               outside the pin
//
// At no event does the router change or revert a selection, lock a session, refuse a prompt, cancel
// a compaction or a tree summary, empty a provider request, stop cache warming or abort a run
// because of what is selected: its handlers for those events answer nothing, and it registers none
// for provider requests or cache warming. A request the router's policy does not allow is refused
// by the route of the model that was asked, with "Nothing was sent" and the way out, and the
// selection stays where John put it.
//
// The router selects a model in one place: /smart-router local on, which asks for local routing,
// selects smart-router/local unless the selection is already that model or a physical model inside
// the pin's policy (switchToLocal). No other command and no event moves the selection.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { PROVIDER, STATUS_KEY, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { checkLocal } from "./local.ts";
import type { Pin } from "./route.ts";

/** The status item while the pin covers the selection. */
export const STATUS_PINNED = "local models";

type Selection = Pick<Model<Api>, "provider" | "id" | "api" | "baseUrl">;

export const describeModel = (model: { readonly provider: string; readonly id: string } | undefined): string =>
  model === undefined ? "no model" : `${model.provider}/${model.id}`;

/** Which of the router's own two models a selection is, if either: any other model is one picked by hand. */
export function ownModel(model: Pick<Selection, "provider" | "id" | "api"> | undefined): VirtualId | undefined {
  if (model === undefined || model.provider !== PROVIDER || model.api !== VIRTUAL_API) return undefined;
  return model.id === "auto" || model.id === "local" ? model.id : undefined;
}

/** Whether a selection is a physical model inside the pin's policy, such as GLM selected directly. */
const insidePolicy = (model: Selection, pin: Pin): boolean => model.api !== VIRTUAL_API && checkLocal(model, pin.policy, false).ok;

/**
 * Whether /smart-router local on leaves a selection as it is: smart-router/local, or a physical
 * model inside the pin's policy. It switches any other selection to smart-router/local.
 */
export function localSelection(model: Selection | undefined, pin: Pin): boolean {
  if (model === undefined) return false;
  return ownModel(model) === "local" || insidePolicy(model, pin);
}

/**
 * Whether the pin's status item fits a selection: the session is pinned, and what is selected is
 * one of the router's own models, whose routes obey the pin, a physical model inside the pin's
 * policy, or nothing. A model picked by hand outside the policy is sent as it is, so the item is
 * not shown over it.
 */
export function coveredByPin(model: Selection | undefined, pin: Pin): boolean {
  if (!pin.on) return false;
  return model === undefined || ownModel(model) !== undefined || insidePolicy(model, pin);
}

/**
 * For /smart-router local on: select smart-router/local, unless the selection is already one the
 * command leaves as it is (localSelection). True when such a selection holds afterwards.
 */
export async function switchToLocal(pi: Pick<ExtensionAPI, "setModel">, ctx: ExtensionContext, pin: Pin): Promise<boolean> {
  if (localSelection(ctx.model, pin)) return true;
  const target = ctx.modelRegistry.find(PROVIDER, "local");
  if (target?.api !== VIRTUAL_API) return false;
  try {
    if (!(await pi.setModel(target))) return false;
  } catch {
    return false;
  }
  return localSelection(ctx.model, pin);
}

/** Show the pin's status item, or clear it, for `model`, the session's selection unless a model_select names a newer one. Never throws. */
export function showPinStatus(ctx: ExtensionContext, pin: Pin, model?: Selection): void {
  try {
    ctx.ui.setStatus(STATUS_KEY, coveredByPin(model ?? ctx.model, pin) ? STATUS_PINNED : undefined);
  } catch {
    // The status item is a courtesy.
  }
}
