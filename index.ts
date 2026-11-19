// pi-smart-router: the Pi virtual models smart-router/auto and smart-router/local, routed by a
// per-host roster.
//
// The factory registers both models first, synchronously, and never throws: Pi discards whatever
// a throwing factory registered, and a session restored onto a model that is not registered falls
// back to a physical one. Until the router is built, and for good if building it fails, both
// models refuse every request. The router's handlers are wired only after it is built, so a
// failure leaves the two refusing models and no handler bound to a half-built router. The factory
// does no I/O; it reads one environment variable, the scope's switch. It never uses the value an
// API call returns, so it also works through nix-config's managed entry, which stages on() and
// register*() calls.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionVirtualModel } from "@earendil-works/pi-coding-agent";

import { ALL_LEVELS, ENV_SCOPE, NAMES, PROVIDER, VIRTUAL_IDS } from "./src/constants.ts";
import type { VirtualId } from "./src/constants.ts";
import { firstLine, loadFailed, loadFailedNotice } from "./src/errors.ts";
import { latchEnvScope, processSlot } from "./src/owners.ts";
import { createRouter, DEFAULT_LIMITS } from "./src/router.ts";
import type { Limits, Router, RouterOptions } from "./src/router.ts";

export type BuildRouter = (pi: ExtensionAPI, options: RouterOptions) => Router;

/** The factory's body, with the router builder replaceable for the lifecycle tests. */
export function install(pi: ExtensionAPI, build: BuildRouter = createRouter): void {
  let router: Router | undefined;
  let failure = "it did not finish loading";
  const define = (id: VirtualId, limits: Limits): ExtensionVirtualModel => ({
    provider: PROVIDER,
    id,
    name: NAMES[id],
    thinkingLevels: ALL_LEVELS,
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
    route: (request, ctx) => {
      if (router === undefined) throw loadFailed(id, failure);
      return router.dispatch(id, request, ctx);
    },
  });
  const register = (id: VirtualId, limits: Limits): void => {
    pi.registerVirtualModel(define(id, limits));
  };
  try {
    for (const id of VIRTUAL_IDS) register(id, DEFAULT_LIMITS);
    const slot = processSlot();
    latchEnvScope(slot, process.env[ENV_SCOPE]);
    router = build(pi, { slot, register, agentDir: getAgentDir, now: Date.now });
    router.wire(pi);
  } catch (error) {
    router = undefined;
    failure = firstLine(error) || "unknown error";
    try {
      pi.on("session_start", (_event, ctx) => {
        if (ctx.hasUI) ctx.ui.notify(loadFailedNotice(failure), "error");
      });
    } catch {
      // The refusing models still say why; a factory that throws would lose them.
    }
  }
}

export default function smartRouter(pi: ExtensionAPI): void {
  install(pi);
}
