// The router leaves provider translation to Pi and recognizes only its Google preflight error.
import assert from "node:assert/strict";
import test from "node:test";

import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { resolveGoogleThinkingLevel } from "@earendil-works/pi-ai/api/google-shared";
import type { Model } from "@earendil-works/pi-ai";

import { sentEffort } from "../src/effort.ts";
import { effortOf } from "../src/ledger.ts";
import { providerThinkingFailure } from "../src/provider-thinking.ts";
import { DEFAULT_EFFORT } from "../src/settings.ts";
import { model } from "./support/catalog.ts";
import { assistant } from "./support/pi.ts";

const ref = "google/gemini-4-hydrogen";
const hydrogen = model(ref, {
  api: "google-generative-ai",
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
});
const signal = { turnType: "main_loop", frontier: false, escalated: false } as const;

test("the reported error is a Pi 1.5.2 preflight failure, not a standard transient retry", () => {
  const text = `Unsupported Google thinking level mapping for ${ref}: xhigh -> xhigh`;
  assert.throws(() => resolveGoogleThinkingLevel(hydrogen as Model<"google-generative-ai">, "xhigh"), { message: text });
  assert.equal(isRetryableAssistantError(assistant(ref, { stopReason: "error", content: [], errorMessage: text })), false);
});

test("fixed, adaptive and disabled policy preserve native Google levels", () => {
  const fixed = sentEffort({ model: hydrogen, fixed: "max", selected: "medium", signal, settings: DEFAULT_EFFORT });
  assert.equal(fixed.level, "max");
  assert.equal(fixed.why, "role_level");
  const adaptive = sentEffort({ model: hydrogen, fixed: undefined, selected: "xhigh", signal, settings: DEFAULT_EFFORT });
  assert.equal(adaptive.level, "xhigh");
  const disabled = sentEffort({ model: hydrogen, fixed: undefined, selected: "xhigh", signal, settings: { enabled: false } });
  assert.equal(disabled.level, "xhigh");
  assert.equal(effortOf(hydrogen, "xhigh"), "xhigh");
  assert.equal(effortOf(hydrogen, "max"), "xhigh", "Pi clamps max to the model's native xhigh");
});

test("only the selected Google adapter's exact preflight error is recognized", () => {
  const message = { stopReason: "error", errorMessage: `Unsupported Google thinking level mapping for ${ref}: xhigh -> invalid` };
  assert.equal(providerThinkingFailure(hydrogen, message), true);
  assert.equal(providerThinkingFailure({ ...hydrogen, api: "google-vertex" }, message), true);
  assert.equal(providerThinkingFailure({ ...hydrogen, api: "openai-completions" }, message), false);
  assert.equal(providerThinkingFailure(hydrogen, { ...message, stopReason: "stop" }), false);
  assert.equal(providerThinkingFailure(hydrogen, { ...message, errorMessage: message.errorMessage.replace(ref, "google/other") }), false);
  assert.equal(providerThinkingFailure(hydrogen, { ...message, errorMessage: `${message.errorMessage}; content filter` }), false);
});
