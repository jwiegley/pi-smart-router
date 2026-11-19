// Thinking effort by turn type (src/effort.ts): upstream's adaptive reasoning, as John ruled on
// 2026-11-18, "Exactly as upstream: effort follows each request's turn type". Each expectation
// names the line of upstream's v1.4.0 source it comes from: AR is
// src/domain/delegation/adaptive-reasoning.ts, RC is .pi/extensions/smart-router/routing-context.ts.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

import { AMBIENT_LEVEL, clampToSupported, effortWords, resolveAdaptiveReasoning, sentEffort, turnTypeOf, turnTypeOfText } from "../src/effort.ts";
import type { EffortSignal, TurnType } from "../src/effort.ts";
import { DEFAULT_EFFORT, REASONING_LEVELS } from "../src/settings.ts";
import type { EffortSettings, ReasoningLevel } from "../src/settings.ts";
import { model } from "./support/catalog.ts";

const NOW = 1_800_000_000_000;
const SOL = model("openai-codex-2/gpt-6.1-sol", { api: "openai-codex-responses" });

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: NOW });
const assistant = (): Message =>
  ({ role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-codex-responses", provider: "openai-codex-2", model: "gpt-6.1-sol", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: NOW }) as Message;
const toolResult = (): Message => ({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false, timestamp: NOW });

const signal = (turnType: TurnType, rest: Partial<Omit<EffortSignal, "turnType">> = {}): EffortSignal => ({ turnType, frontier: false, escalated: false, ...rest });

/** The level sent for a signal at the session's level `selected`, with upstream's defaults. */
function sent(turn: EffortSignal, selected: ModelThinkingLevel = "medium", options: { readonly target?: Model<Api>; readonly settings?: EffortSettings; readonly fixed?: ModelThinkingLevel } = {}): string {
  return sentEffort({ model: options.target ?? SOL, fixed: options.fixed, selected, signal: turn, settings: options.settings ?? DEFAULT_EFFORT }).level;
}

describe("a request's turn type, from its last message (RC:197-223)", () => {
  test("a tool result is a tool_result turn", () => {
    assert.equal(turnTypeOf([user("fix the build"), assistant(), toolResult()]), "tool_result", "RC:207-209: the last message is a tool result");
  });

  test("a user message holding plan, architect or design, in any case and inside a word, is a planning turn", () => {
    for (const text of ["Plan the migration", "who should ARCHITECT this", "a design review", "an explanation, please", "the planner's output"]) {
      assert.equal(turnTypeOf([user(text)]), "planning", `RC:211-219: "${text}" holds one of the words, lower-cased`);
    }
  });

  test("any other user message, and an assistant message last, is a main_loop turn", () => {
    assert.equal(turnTypeOf([user("rename foo to bar")]), "main_loop", "RC:222: a user message without the words");
    assert.equal(turnTypeOf([user("plan it"), assistant()]), "main_loop", "RC:222: an assistant message last, whatever came before");
  });

  test("no messages is an unknown turn", () => {
    assert.equal(turnTypeOf([]), "unknown", "RC:198-200");
  });

  test("only text blocks count, joined by newlines; a string content counts as it is", () => {
    const withImage: Message = { role: "user", content: [{ type: "image", data: "plan", mimeType: "image/png" }, { type: "text", text: "rename it" }], timestamp: NOW };
    assert.equal(turnTypeOf([withImage]), "main_loop", "RC:144-153: an image's data is not text");
    assert.equal(turnTypeOf([{ role: "user", content: "design the cache", timestamp: NOW }]), "planning", "RC:145-147: a string is its own text");
    assert.equal(turnTypeOfText("go ahead"), "main_loop", "a prompt's text alone, for the run it plans");
  });
});

describe("upstream's table at the session's default level, medium (AR:8-12, AR:206-220)", () => {
  test("medium is Pi's default level, the ambient one upstream adjusts", () => {
    assert.equal(AMBIENT_LEVEL, "medium", "AR:56");
  });

  test("row 3: a request after a tool result is sent minimal", () => {
    assert.equal(sent(signal("tool_result")), "minimal", "AR:212");
  });

  test("row 4: an ordinary turn is sent low", () => {
    assert.equal(sent(signal("main_loop")), "low", "AR:212");
  });

  test("row 1: a planning turn is sent medium, also on the strongest level and in a stuck run", () => {
    assert.equal(sent(signal("planning")), "medium", "AR:213-214");
    assert.equal(sent(signal("planning", { frontier: true })), "medium", "AR:185-190: planning is classified before escalation");
    assert.equal(sent(signal("planning", { escalated: true })), "medium", "AR:185-190: planning is classified before escalation");
  });

  test("row 2: a request on the strongest level, or in a run that moved up, is sent high, whatever its turn type", () => {
    for (const turnType of ["tool_result", "main_loop", "unknown"] as const) {
      assert.equal(sent(signal(turnType, { frontier: true })), "high", `AR:192-197, AR:215-216: ${turnType} on the frontier tier`);
      assert.equal(sent(signal(turnType, { escalated: true })), "high", `AR:192-197, AR:215-216: ${turnType} after a loop escalation`);
    }
  });

  test("row 5: an unknown turn type off the strongest level leaves the selected level", () => {
    assert.equal(sent(signal("unknown")), "medium", "AR:203, AR:290-296: no policy level");
    const result = resolveAdaptiveReasoning(SOL, signal("unknown"), "medium", DEFAULT_EFFORT);
    assert.deepEqual(result, { reasoning: "medium", reasonCode: "no_policy_signal" }, "AR:290-296");
  });

  test("each row's reason code is upstream's", () => {
    const codes = (["tool_result", "main_loop", "planning"] as const).map((turnType) => resolveAdaptiveReasoning(SOL, signal(turnType), "medium", DEFAULT_EFFORT).reasonCode);
    assert.deepEqual(codes, ["turn_envelope_tool_result", "turn_envelope_main_loop", "planning_turn"], "AR:222-238");
    assert.equal(resolveAdaptiveReasoning(SOL, signal("main_loop", { frontier: true }), "medium", DEFAULT_EFFORT).reasonCode, "frontier_escalation", "AR:233-234");
  });
});

describe("the session's level (AR:335-362)", () => {
  test("off is no caller level: the policy level is sent alone, as upstream's provider receives no reasoning from Pi at off", () => {
    assert.equal(sent(signal("main_loop"), "off"), "low", "AR:358-362, with pi-agent-core agent.js:310");
    assert.equal(sent(signal("tool_result"), "off"), "minimal", "AR:358-362");
    assert.equal(sent(signal("unknown"), "off"), "off", "AR:290-296: no policy level leaves no level, which Pi sends as off");
    const atOff = sentEffort({ model: SOL, fixed: undefined, selected: "off", signal: signal("main_loop"), settings: DEFAULT_EFFORT });
    assert.equal(atOff.why, "turn_envelope_main_loop", "AR:358-362: at off the policy's own reason, not an operator's upgrade");
  });

  test("high, xhigh and max are never lowered, and the table's highest row reaches no higher: nothing changes", () => {
    for (const level of ["high", "xhigh", "max"] as const) {
      for (const turn of [signal("tool_result"), signal("main_loop"), signal("planning"), signal("main_loop", { frontier: true }), signal("tool_result", { escalated: true })]) {
        assert.equal(sent(turn, level), level, `AR:335-345: ${level} for ${JSON.stringify(turn)}`);
      }
    }
  });

  test("minimal and low are never lowered, and are raised when the turn's class asks for more", () => {
    assert.equal(sent(signal("tool_result"), "low"), "low", "AR:342-344: minimal would lower low");
    assert.equal(sent(signal("main_loop"), "minimal"), "low", "AR:337-341: an ordinary turn raises minimal to low");
    assert.equal(sent(signal("planning"), "low"), "medium", "AR:337-341: planning raises low to medium");
    assert.equal(sent(signal("main_loop", { frontier: true }), "low"), "high", "AR:337-341: the frontier raises low to high");
    const raised = resolveAdaptiveReasoning(SOL, signal("planning"), "low", DEFAULT_EFFORT);
    assert.deepEqual(raised, { reasoning: "medium", reasonCode: "operator_thinking_upgrade" }, "AR:341");
    const kept = resolveAdaptiveReasoning(SOL, signal("tool_result"), "low", DEFAULT_EFFORT);
    assert.deepEqual(kept, { reasoning: "low", reasonCode: "operator_thinking_floor" }, "AR:344");
  });
});

describe("a role that fixes its level (John, 2026-11-18)", () => {
  test("keeps it, whatever the turn and the session's level", () => {
    for (const turn of [signal("tool_result"), signal("planning"), signal("main_loop", { frontier: true })]) {
      assert.equal(sent(turn, "medium", { fixed: "max" }), "max", `a fixed max for ${JSON.stringify(turn)}`);
      assert.equal(sent(turn, "off", { fixed: "low" }), "low", `a fixed low for ${JSON.stringify(turn)}`);
    }
    const effort = sentEffort({ model: SOL, fixed: "high", selected: "medium", signal: signal("tool_result"), settings: DEFAULT_EFFORT });
    assert.equal(effort.why, "role_level", "the reason names the role");
  });
});

describe("the floor, the ceiling and the off switch (AR:271-277, AR:309-330, AR:364-373)", () => {
  test("off: the selected level is sent, whatever the turn", () => {
    const off: EffortSettings = { enabled: false };
    for (const level of ["off", "minimal", "medium", "max"] as const) {
      assert.equal(sent(signal("tool_result"), level, { settings: off }), level, `AR:271-277 at ${level}`);
    }
    assert.equal(resolveAdaptiveReasoning(SOL, signal("planning"), "medium", off).reasonCode, "adaptive_reasoning_disabled", "AR:274");
  });

  test("a floor raises what the policy derives, and says so", () => {
    const floor: EffortSettings = { enabled: true, minLevel: "low" };
    assert.equal(sent(signal("tool_result"), "medium", { settings: floor }), "low", "AR:313-315: minimal raised to the floor");
    assert.equal(sent(signal("planning"), "medium", { settings: floor }), "medium", "AR:313: medium is above the floor");
    assert.equal(resolveAdaptiveReasoning(SOL, signal("tool_result"), "medium", floor).reasonCode, "operator_floor_applied", "AR:368-373");
  });

  test("a ceiling caps what the policy derives, and says so", () => {
    const ceiling: EffortSettings = { enabled: true, maxLevel: "low" };
    assert.equal(sent(signal("planning"), "medium", { settings: ceiling }), "low", "AR:316-321: medium capped at the ceiling");
    assert.equal(sent(signal("main_loop", { frontier: true }), "medium", { settings: ceiling }), "low", "AR:316-321: high capped at the ceiling");
    assert.equal(sent(signal("tool_result"), "medium", { settings: ceiling }), "minimal", "AR:316: minimal is under the ceiling");
    assert.equal(resolveAdaptiveReasoning(SOL, signal("planning"), "medium", ceiling).reasonCode, "operator_ceiling_applied", "AR:368-373");
  });

  test("neither lowers an explicit level, and a floor above it raises it", () => {
    assert.equal(sent(signal("planning"), "max", { settings: { enabled: true, maxLevel: "low" } }), "max", "AR:335-345: a ceiling never lowers the selected max");
    assert.equal(sent(signal("tool_result"), "high", { settings: { enabled: true, minLevel: "xhigh" } }), "xhigh", "AR:313-315 then AR:337-341: a floor above high raises the request");
  });

  test("with the floor above the ceiling, the ceiling wins", () => {
    assert.equal(sent(signal("tool_result"), "medium", { settings: { enabled: true, minLevel: "high", maxLevel: "low" } }), "low", "AR:260-261, AR:313-321");
  });

  test("the defaults are upstream's: on, with neither bound", () => {
    assert.deepEqual(DEFAULT_EFFORT, { enabled: true }, "schemas.ts:845-847");
    assert.deepEqual(REASONING_LEVELS, ["minimal", "low", "medium", "high", "xhigh", "max"], "schemas.ts:789-796: off is not a level the policy derives or bounds");
  });
});

describe("what the model supports (AR:141-167, AR:279-307)", () => {
  test("a model without reasoning keeps the selected level", () => {
    const plain = model("cloud-b/m", { reasoning: false });
    assert.equal(sent(signal("tool_result"), "medium", { target: plain }), "medium", "AR:280-286");
    assert.equal(resolveAdaptiveReasoning(plain, signal("tool_result"), "medium", DEFAULT_EFFORT).reasonCode, "reasoning_unsupported", "AR:283");
  });

  test("the policy level is clamped down past levels the model maps to null", () => {
    const noMinimal = model("cloud-c/m", { thinkingLevelMap: { minimal: null } });
    assert.equal(clampToSupported("minimal", noMinimal), undefined, "AR:156-167: nothing at or below minimal");
    assert.equal(sent(signal("tool_result"), "medium", { target: noMinimal }), "medium", "AR:298-307: nothing to clamp to keeps the selected level");
    const noHigh = model("cloud-c/m", { thinkingLevelMap: { high: null } });
    assert.equal(sent(signal("main_loop", { frontier: true }), "medium", { target: noHigh }), "medium", "AR:298: high clamps down to medium");
    const levels: ReasoningLevel[] = [...REASONING_LEVELS];
    assert.deepEqual(
      levels.map((level) => clampToSupported(level, SOL)),
      levels,
      "AR:148-150: a level is supported unless mapped to null",
    );
  });
});

describe("status's words for the effort", () => {
  test("name the level sent and why, in a few words, never the text", () => {
    const words = (turn: EffortSignal, selected: ModelThinkingLevel = "medium", fixed?: ModelThinkingLevel): string => {
      const effort = sentEffort({ model: SOL, fixed, selected, signal: turn, settings: DEFAULT_EFFORT });
      return `thinking ${effort.level} (${effortWords(effort)})`;
    };
    assert.equal(words(signal("tool_result")), "thinking minimal (after a tool result)");
    assert.equal(words(signal("main_loop")), "thinking low (an ordinary turn)");
    assert.equal(words(signal("planning")), "thinking medium (planning)");
    assert.equal(words(signal("main_loop", { frontier: true })), "thinking high (SUPER)");
    assert.equal(words(signal("main_loop", { escalated: true })), "thinking high (a stuck run)");
    assert.equal(words(signal("main_loop"), "max"), "thinking max (as selected, never lowered)");
    assert.equal(words(signal("planning"), "low"), "thinking medium (raised from the selected level for planning)");
    assert.equal(words(signal("planning"), "medium", "high"), "thinking high (the role's own level)");
  });
});
