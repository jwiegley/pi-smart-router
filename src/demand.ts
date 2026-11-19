// A prompt's demand: a number from 0 (LOW) to 3 (SUPER) that blends Jev's answer with upstream's
// heuristics, the guards that keep a sure answer from under-serving a risky or very deep run, and
// the level the number names. It is pure: the caller reads the prompt, the session and Jev, and
// passes what it found.
import { capText } from "./classify.ts";
import type { JevOutcome } from "./jev.ts";
import { DEEP_SESSION_ENTRIES, DEEP_SESSION_TOKENS } from "./settings.ts";
import type { DemandSettings } from "./settings.ts";
import { higherTier, TIERS, tierRank } from "./tiers.ts";
import type { Tier } from "./tiers.ts";
import { triage } from "./triage/triage-engine.ts";
import { buildTierFeatures, scoreLowIntensity } from "./triage/tier-features.ts";
import type { LowIntensityWeights } from "./triage/tier-features.ts";
import type { RoutingRequest } from "./triage/types.ts";

/** How many recent messages feed the heuristics: upstream's MESSAGE_COUNT_NORM. */
export const HEURISTIC_MESSAGES = 20;

export interface PromptFacts {
  /** The conversation's size in tokens before this prompt, from the latest usage. */
  readonly contextTokens: number | undefined;
  /** The roles of the latest messages, oldest first, at most HEURISTIC_MESSAGES; "tool" for a tool result. */
  readonly roles: readonly string[];
  /** The branch's entry count, where Pi's history metrics give one. */
  readonly entries: number | undefined;
}

/**
 * The roles the heuristics read of the conversation's latest messages, oldest first, at most
 * HEURISTIC_MESSAGES. The heuristics score the model's context, so a message counts as the message
 * Pi would send the model (its convertToLlm): a tool result as "tool", an assistant message as
 * "assistant", and any other role as "user", as Pi sends a ! shell run (bashExecution) or a custom
 * message. A message Pi keeps out of the context (`excludeFromContext`, a !! shell run) is not
 * counted, nor is anything without a string role. The live router and the review script both use
 * this, so that a replay sees the roles the router saw.
 */
export function rolesOf(messages: readonly unknown[]): string[] {
  const roles: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { role, excludeFromContext } = message as { readonly role?: unknown; readonly excludeFromContext?: unknown };
    if (typeof role !== "string" || excludeFromContext === true) continue;
    roles.push(role === "toolResult" ? "tool" : role === "assistant" ? "assistant" : "user");
  }
  return roles.slice(-HEURISTIC_MESSAGES);
}

export type DemandGuard = "low-confidence" | "close-call" | "risky" | "deep-session";

/** What says how deep a session is: the conversation's size and the branch's entry count, each undefined when unknown. */
export type SessionDepth = Pick<PromptFacts, "contextTokens" | "entries">;

/**
 * Whether a session is deep enough for the deep-session floor: more than DEEP_SESSION_TOKENS tokens
 * in the conversation or more than DEEP_SESSION_ENTRIES entries on the branch. An unknown figure,
 * such as the size right after a compaction, is not over. The demand's guard and a run without a
 * prompt (src/route.ts) both use it.
 */
export function isDeepSession(depth: SessionDepth): boolean {
  return (
    (depth.contextTokens !== undefined && depth.contextTokens > DEEP_SESSION_TOKENS) ||
    (depth.entries !== undefined && depth.entries > DEEP_SESSION_ENTRIES)
  );
}

export interface Demand {
  /** 0 (LOW) to 3 (SUPER), before the floors. */
  readonly value: number;
  readonly tier: Tier;
  readonly jev?: { readonly value: number; readonly confidence: number };
  /** The heuristics' value, upstream's score, and the three signals that raise it most, each with its share of 1 - score. */
  readonly heuristics: {
    readonly value: number;
    readonly score: number;
    readonly top: ReadonlyArray<readonly [signal: string, share: number]>;
  };
  /** The guards that changed the result, in the order applied. */
  readonly guards: readonly DemandGuard[];
}

export interface DemandInput {
  readonly text: string;
  readonly planning: boolean;
  readonly risky: boolean;
  readonly jev: JevOutcome | undefined;
  readonly facts: PromptFacts;
}

// A gap that equals closeCall in decimal can differ from it by one rounding step in binary.
const EPSILON = 1e-9;

/** The level a demand names: the first whose cut is above it, or the next one up within `closeCall` of that cut. */
export function tierOfDemand(
  value: number,
  settings: Pick<DemandSettings, "cuts" | "closeCall">,
): { readonly tier: Tier; readonly closeCall: boolean } {
  for (const [index, cut] of settings.cuts.entries()) {
    if (cut > value) {
      const near = cut - value <= settings.closeCall + EPSILON;
      return { tier: TIERS[near ? index + 1 : index] ?? "super", closeCall: near };
    }
  }
  return { tier: "super", closeCall: false };
}

function jevTerm(jev: JevOutcome | undefined): { readonly value: number; readonly confidence: number } | undefined {
  if (jev?.kind !== "answer") return undefined;
  const sum = TIERS.reduce((total, tier) => total + jev.probabilities[tier], 0);
  if (!(sum > 0)) return undefined;
  return {
    value: TIERS.reduce((total, tier) => total + (tierRank(tier) * jev.probabilities[tier]) / sum, 0),
    confidence: Math.max(...TIERS.map((tier) => jev.probabilities[tier])) / sum,
  };
}

export function demandOf(input: DemandInput, settings: DemandSettings): Demand {
  const { facts } = input;
  // 1. The heuristics.
  const capped = capText(input.text);
  const request: RoutingRequest = {
    prompt_text: capped,
    turn_type: input.planning ? "planning" : "main_loop",
    messages: facts.roles.map((role) => ({ role })),
    ...(facts.contextTokens === undefined ? {} : { estimated_input_tokens: facts.contextTokens + Math.ceil(capped.length / 4) }),
  };
  const features = buildTierFeatures(request, triage(capped));
  const score = scoreLowIntensity(features, settings.weights);
  const heuristicsValue = 3 * (1 - score);

  // 2. Jev's term, and 3. the blend.
  const term = jevTerm(input.jev);
  const jevMass = term === undefined ? 0 : settings.jevWeight * term.confidence;
  const denominator = jevMass + settings.heuristicsWeight;
  let value =
    term === undefined || !(denominator > 0)
      ? heuristicsValue
      : (jevMass * term.value + settings.heuristicsWeight * heuristicsValue) / denominator;

  // 4. Low confidence raises only.
  const guards: DemandGuard[] = [];
  if (term !== undefined && term.confidence < settings.minConfidence && heuristicsValue > value) {
    value = heuristicsValue;
    guards.push("low-confidence");
  }

  // 5. The level, and 6. the floors.
  const named = tierOfDemand(value, settings);
  if (named.closeCall) guards.push("close-call");
  let tier = named.tier;
  if (input.risky && higherTier(tier, "high") !== tier) {
    tier = "high";
    guards.push("risky");
  }
  if (isDeepSession(facts) && higherTier(tier, settings.deepSessionFloor) !== tier) {
    tier = settings.deepSessionFloor;
    guards.push("deep-session");
  }

  // 7. The signals that raise the demand most.
  const weights = settings.weights;
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const shares = (Object.keys(weights) as Array<keyof LowIntensityWeights>)
    .filter((name) => weights[name] > 0)
    .map((name) => {
      const alone = Object.fromEntries(Object.keys(weights).map((other) => [other, other === name ? 1 : 0])) as unknown as LowIntensityWeights;
      return [name, (weights[name] * (1 - scoreLowIntensity(features, alone))) / total] as const;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return {
    value,
    tier,
    ...(term === undefined ? {} : { jev: term }),
    heuristics: { value: heuristicsValue, score, top: shares },
    guards,
  };
}
