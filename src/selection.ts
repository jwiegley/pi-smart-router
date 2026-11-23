// The selection: how the router reads it.
//
// A model picked by hand always stays selected and is sent as it is, in every scope (John's
// decision of 2026-11-16, "Manual choice always wins"). The router routes only while the selection
// is one of its own models, smart-router/auto, smart-router/personal, smart-router/work or
// smart-router/local, and its policies live in those models' routes (src/router.ts, src/route.ts):
//
//   work scope  smart-router/auto and smart-router/work route to work-bound Codex or Claude Code,
//               or an explicitly configured local fallback. smart-router/personal refuses: the
//               session's scope decides, never the selection. smart-router/local routes only to
//               local roles.
//   personal scope
//               smart-router/auto and smart-router/personal route to the personal levels, and
//               smart-router/work refuses until the session is in work scope.
//   a scope that cannot be read
//               smart-router/auto, smart-router/personal and smart-router/work refuse, since
//               they cannot tell which account to use, and smart-router/local routes only to local
//               roles, as in either scope.
//
// At no event does the router change or revert a selection, lock a session, refuse a prompt, cancel
// a compaction or a tree summary, empty a provider request, stop cache warming or abort a run
// because of what is selected: its handlers for those events answer nothing, and it registers none
// for provider requests or cache warming. A request the router's policy does not allow is refused
// by the route of the model that was asked, with "Nothing was sent" and the way out, and the
// selection stays where John put it.
//
// The router selects a model in one place only: /smart-router scope work, personal or local, given
// while one of the router's own models is selected, selects that scope's model, so that the command
// and the model name the same scope (src/commands.ts). No event moves the selection, and a model
// picked by hand is never replaced. The local-only pin of earlier versions has been removed;
// selecting smart-router/local, by /model or by /smart-router scope local, is how a session routes
// locally.
import type { Api, Model } from "@earendil-works/pi-ai";

import { isVirtualId, PROVIDER, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";

type Selection = Pick<Model<Api>, "provider" | "id" | "api">;

export const describeModel = (model: { readonly provider: string; readonly id: string } | undefined): string =>
  model === undefined ? "no model" : `${model.provider}/${model.id}`;

/** Which of the router's own models a selection is, if any: any other model is one picked by hand. */
export function ownModel(model: Selection | undefined): VirtualId | undefined {
  if (model === undefined || model.provider !== PROVIDER || model.api !== VIRTUAL_API) return undefined;
  return isVirtualId(model.id) ? model.id : undefined;
}
