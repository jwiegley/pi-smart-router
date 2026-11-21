// The selection: how the router reads it.
//
// A model picked by hand always stays selected and is sent as it is, in every scope (John's
// decision of 2026-11-16, "Manual choice always wins"). The router routes only while the selection
// is one of its own two models, smart-router/auto or smart-router/local, and its policies live in
// those two models' routes (src/router.ts, src/route.ts):
//
//   work scope  smart-router/auto routes to work-bound Codex or Claude Code, or an explicitly
//               configured local fallback. smart-router/local routes only to local roles.
//   a scope that cannot be read
//               smart-router/auto refuses, since it cannot tell which account to use, and
//               smart-router/local routes only to local roles, as in either scope.
//
// At no event does the router change or revert a selection, lock a session, refuse a prompt, cancel
// a compaction or a tree summary, empty a provider request, stop cache warming or abort a run
// because of what is selected: its handlers for those events answer nothing, and it registers none
// for provider requests or cache warming. A request the router's policy does not allow is refused
// by the route of the model that was asked, with "Nothing was sent" and the way out, and the
// selection stays where John put it.
//
// The router never selects a model: no command and no event moves the selection. The local-only
// pin of earlier versions, whose command selected smart-router/local, has been removed; selecting
// smart-router/local is how a session routes locally.
import type { Api, Model } from "@earendil-works/pi-ai";

import { PROVIDER, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";

type Selection = Pick<Model<Api>, "provider" | "id" | "api">;

export const describeModel = (model: { readonly provider: string; readonly id: string } | undefined): string =>
  model === undefined ? "no model" : `${model.provider}/${model.id}`;

/** Which of the router's own two models a selection is, if either: any other model is one picked by hand. */
export function ownModel(model: Selection | undefined): VirtualId | undefined {
  if (model === undefined || model.provider !== PROVIDER || model.api !== VIRTUAL_API) return undefined;
  return model.id === "auto" || model.id === "local" ? model.id : undefined;
}
