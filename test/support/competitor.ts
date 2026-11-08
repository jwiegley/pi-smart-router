// A competing extension for the behaviour suite: it switches the selection back to codex-like/m in
// `input`, in `model_select` and in `turn_start`, as Multi-Pass's allowedSubs or codex-compat's
// checkpoint policy can. It is a file rather than an inline extension so that Pi can load it before
// the router: Pi loads extension paths in their order, and inline extensions after every path.
// Test-only; never shipped.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "codex-like";
const ID = "m";

export default function competitor(pi: ExtensionAPI): void {
  const switchBack = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.model?.provider === PROVIDER && ctx.model.id === ID) return;
    const model = ctx.modelRegistry.find(PROVIDER, ID);
    if (model !== undefined) await pi.setModel(model);
  };
  pi.on("input", async (_event, ctx) => {
    await switchBack(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    await switchBack(ctx);
  });
  pi.on("turn_start", async (_event, ctx) => {
    await switchBack(ctx);
  });
}
