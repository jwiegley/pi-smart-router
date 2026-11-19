// Thinking effort by turn type: upstream's "adaptive reasoning", as John ruled on 2026-11-18,
// "Exactly as upstream: effort follows each request's turn type."
//
// The policy is upstream's src/domain/delegation/adaptive-reasoning.ts at v1.4.0 (54bee53d), and
// the turn type is its .pi/extensions/smart-router/routing-context.ts deriveTurnType, both ported
// rule for rule. What upstream reads from its pipeline's decision is given here as two facts the
// route knows: whether the request goes to the strongest level (upstream's frontier tier) and
// whether it belongs to a run that moved up for being stuck (upstream's loop escalation). Upstream's
// pin continuation has no counterpart, since the fork has no session pin, and neither has its
// planning delegate. Its conciseness hint rewrites the system prompt, which a route cannot do.
//
// Pure: no clock, no I/O. The messages' text is read to find a planning turn and is kept nowhere.
import type { Api, Message, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

import { REASONING_LEVELS } from "./settings.ts";
import type { EffortSettings, ReasoningLevel } from "./settings.ts";

/** Upstream's turn types, as deriveTurnType finds them. Upstream's `subagent` is never derived. */
export type TurnType = "planning" | "tool_result" | "main_loop" | "unknown";

/** Pi's default thinking level, which upstream treats as the session's ambient level (SESSION_AMBIENT_THINKING_LEVEL). */
export const AMBIENT_LEVEL: ReasoningLevel = "medium";

/** The words upstream looks for, lower-cased, in a user message's text to call its turn planning. */
const PLANNING_WORDS = ["plan", "architect", "design"] as const;

/** A message's text, as upstream joins it: a string as it is, else its text blocks joined by newlines. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: unknown): block is { readonly type: "text"; readonly text: string } => {
      if (typeof block !== "object" || block === null) return false;
      const { type, text } = block as { readonly type?: unknown; readonly text?: unknown };
      return type === "text" && typeof text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

/** A user message's turn type, from its text: planning when it holds one of upstream's words, else main_loop. */
export function turnTypeOfText(text: string): "planning" | "main_loop" {
  const lower = text.toLowerCase();
  return PLANNING_WORDS.some((word) => lower.includes(word)) ? "planning" : "main_loop";
}

/**
 * The request's turn type, from its last message, as upstream derives it: a tool result is
 * `tool_result`; a user message is `planning` when its text holds "plan", "architect" or
 * "design", in any case; any other last message is `main_loop`; no messages is `unknown`.
 */
export function turnTypeOf(messages: readonly Message[]): TurnType {
  const last = messages.at(-1) as { readonly role?: unknown; readonly content?: unknown } | undefined;
  if (last === undefined || last === null) return "unknown";
  if (last.role === "toolResult") return "tool_result";
  if (last.role === "user" && turnTypeOfText(textOf(last.content)) === "planning") return "planning";
  return "main_loop";
}

/** What the route knows of a request, in place of upstream's turn envelope and routing decision. */
export interface EffortSignal {
  readonly turnType: TurnType;
  /** The request goes to the strongest level's model: upstream's `decision.tier === 'frontier-cloud'`. */
  readonly frontier: boolean;
  /** The request belongs to a run that moved up for being stuck: upstream's loop escalation. */
  readonly escalated: boolean;
}

/** Upstream's reason codes (AdaptiveReasoningReasonCode), without the pin's two. */
export type AdaptiveReason =
  | "adaptive_reasoning_disabled"
  | "reasoning_unsupported"
  | "no_policy_signal"
  | "turn_envelope_tool_result"
  | "turn_envelope_main_loop"
  | "planning_turn"
  | "frontier_escalation"
  | "operator_thinking_floor"
  | "operator_thinking_upgrade"
  | "operator_floor_applied"
  | "operator_ceiling_applied";

export interface Adaptive {
  /** The level to send; undefined leaves the caller's level, which was none, as it is. */
  readonly reasoning: ReasoningLevel | undefined;
  readonly reasonCode: AdaptiveReason;
}

type TurnClass = "routine" | "planning" | "escalation" | "unknown";

const rank = (level: ReasoningLevel): number => REASONING_LEVELS.indexOf(level);

/** A level is supported unless the model's thinkingLevelMap maps it to null. */
const supported = (model: Model<Api>, level: ReasoningLevel): boolean => model.thinkingLevelMap?.[level] !== null;

/** The policy level clamped down to the nearest level the model supports at or below it, if any. */
export function clampToSupported(level: ReasoningLevel, model: Model<Api>): ReasoningLevel | undefined {
  for (let index = rank(level); index >= 0; index--) {
    const candidate = REASONING_LEVELS[index];
    if (candidate !== undefined && supported(model, candidate)) return candidate;
  }
  return undefined;
}

/** Upstream's classifyReasoningTurn: planning first, then escalation, then a routine turn. */
function classify(signal: EffortSignal): TurnClass {
  if (signal.turnType === "planning") return "planning";
  if (signal.frontier || signal.escalated) return "escalation";
  if (signal.turnType === "tool_result" || signal.turnType === "main_loop") return "routine";
  return "unknown";
}

/** Upstream's table: minimal after a tool result, low for an ordinary turn, medium for planning, high on the strongest level or after an escalation. */
function policyLevel(turnClass: TurnClass, turnType: TurnType): ReasoningLevel | undefined {
  switch (turnClass) {
    case "routine":
      return turnType === "tool_result" ? "minimal" : "low";
    case "planning":
      return "medium";
    case "escalation":
      return "high";
    case "unknown":
      return undefined;
  }
}

function policyReason(turnClass: TurnClass, turnType: TurnType): AdaptiveReason {
  switch (turnClass) {
    case "routine":
      return turnType === "tool_result" ? "turn_envelope_tool_result" : "turn_envelope_main_loop";
    case "planning":
      return "planning_turn";
    case "escalation":
      return "frontier_escalation";
    case "unknown":
      return "no_policy_signal";
  }
}

/**
 * Upstream's resolveAdaptiveReasoning, without its pin continuation and its conciseness hint.
 * `caller` is the session's level as upstream's provider received it: none for Pi's `off`.
 * In order: the off switch, a model without reasoning and a turn without a policy level leave the
 * caller's level; the policy level is clamped down to what the model supports, bounded by the floor
 * and then the ceiling (so the ceiling wins), and clamped again; a caller level other than `medium`
 * is never lowered and is raised when the policy level is higher; at `medium`, or with no caller
 * level, the policy level is sent.
 */
export function resolveAdaptiveReasoning(model: Model<Api>, signal: EffortSignal, caller: ReasoningLevel | undefined, settings: EffortSettings): Adaptive {
  if (!settings.enabled) return { reasoning: caller, reasonCode: "adaptive_reasoning_disabled" };
  if (!model.reasoning) return { reasoning: caller, reasonCode: "reasoning_unsupported" };
  const turnClass = classify(signal);
  const derived = policyLevel(turnClass, signal.turnType);
  if (derived === undefined) return { reasoning: caller, reasonCode: "no_policy_signal" };
  const clamped = clampToSupported(derived, model);
  if (clamped === undefined) return { reasoning: caller, reasonCode: "reasoning_unsupported" };

  let bounded = clamped;
  if (settings.minLevel !== undefined && rank(bounded) < rank(settings.minLevel)) bounded = settings.minLevel;
  if (settings.maxLevel !== undefined && rank(bounded) > rank(settings.maxLevel)) bounded = settings.maxLevel;
  const effective = bounded === clamped ? clamped : clampToSupported(bounded, model);
  if (effective === undefined) return { reasoning: caller, reasonCode: "reasoning_unsupported" };

  let reasoning: ReasoningLevel;
  let reasonCode: AdaptiveReason;
  if (caller !== undefined && caller !== AMBIENT_LEVEL) {
    // The operator's own level: never lowered, raised when the turn's class asks for more.
    if (rank(effective) > rank(caller)) {
      reasoning = effective;
      reasonCode = "operator_thinking_upgrade";
    } else {
      reasoning = caller;
      reasonCode = "operator_thinking_floor";
    }
  } else {
    reasoning = effective;
    reasonCode = policyReason(turnClass, signal.turnType);
  }
  if (effective !== clamped && reasoning === effective) reasonCode = rank(effective) > rank(clamped) ? "operator_floor_applied" : "operator_ceiling_applied";
  return { reasoning, reasonCode };
}

/** Why a request carries its level: one of upstream's reasons, or its role's fixed level. */
export type EffortWhy = AdaptiveReason | "role_level";

/** The level a request is sent at, why, and what it was derived from: levels and names, never text. */
export interface SentEffort {
  readonly level: ModelThinkingLevel;
  readonly why: EffortWhy;
  readonly signal: EffortSignal;
}

/**
 * The level a request is sent at. A role that fixes its level keeps it (John, 2026-11-18); otherwise
 * upstream's policy decides from the selected level, `off` counting as none, as Pi passes it to a
 * provider. Pi clamps the result to the model, as it clamps any route's level.
 */
export function sentEffort(input: {
  readonly model: Model<Api>;
  readonly fixed: ModelThinkingLevel | undefined;
  readonly selected: ModelThinkingLevel;
  readonly signal: EffortSignal;
  readonly settings: EffortSettings;
}): SentEffort {
  const { model, fixed, selected, signal, settings } = input;
  if (fixed !== undefined) return { level: fixed, why: "role_level", signal };
  const caller = selected === "off" ? undefined : selected;
  const { reasoning, reasonCode } = resolveAdaptiveReasoning(model, signal, caller, settings);
  return { level: reasoning ?? "off", why: reasonCode, signal };
}

/** What the turn's class asked for, in a few words. */
function classWords(signal: EffortSignal): string {
  if (signal.turnType === "planning") return "planning";
  if (signal.escalated) return "a stuck run";
  if (signal.frontier) return "SUPER";
  return signal.turnType === "tool_result" ? "a tool result" : "a turn";
}

/** Why the level was sent, in a few words, for /smart-router status; the footer shows the level alone. */
export function effortWords(effort: SentEffort): string {
  switch (effort.why) {
    case "role_level":
      return "the role's own level";
    case "adaptive_reasoning_disabled":
      return "as selected; adaptive effort is off";
    case "reasoning_unsupported":
    case "no_policy_signal":
      return "as selected";
    case "turn_envelope_tool_result":
      return "after a tool result";
    case "turn_envelope_main_loop":
      return "an ordinary turn";
    case "planning_turn":
      return "planning";
    case "frontier_escalation":
      return effort.signal.escalated ? "a stuck run" : "SUPER";
    case "operator_thinking_floor":
      return "as selected, never lowered";
    case "operator_thinking_upgrade":
      return `raised from the selected level for ${classWords(effort.signal)}`;
    case "operator_floor_applied":
      return "the roster's floor";
    case "operator_ceiling_applied":
      return "the roster's ceiling";
  }
}
