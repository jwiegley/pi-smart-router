// A Google adapter's preflight error is distinct from a response from the model.
import type { Api, Model } from "@earendil-works/pi-ai";

const googleApi = (model: Model<Api>): boolean => model.api === "google-generative-ai" || model.api === "google-vertex";

/** The adapter's own preflight error for this physical model, not an arbitrary provider error. */
export function providerThinkingFailure(model: Model<Api>, message: { readonly stopReason?: unknown; readonly errorMessage?: string | undefined }): boolean {
  if (!googleApi(model) || message.stopReason !== "error") return false;
  const error = message.errorMessage?.replace(/^Error: /, "") ?? "";
  const prefix = `Unsupported Google thinking level mapping for ${model.provider}/${model.id}: `;
  return error.startsWith(prefix) && /^(?:minimal|low|medium|high|xhigh|max) -> \S+$/.test(error.slice(prefix.length));
}
