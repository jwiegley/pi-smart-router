// The four intelligence tiers, low < medium < high < super, shown as LOW, MEDIUM, HIGH and SUPER.
// They are called tiers because Level and ALL_LEVELS already mean thinking levels (constants.ts).
import type { Signal } from "./classify.ts";

export type Tier = "low" | "medium" | "high" | "super";

export const TIERS: readonly Tier[] = ["low", "medium", "high", "super"];

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function higherTier(a: Tier, b: Tier): Tier {
  return tierRank(b) > tierRank(a) ? b : a;
}

export function tierAbove(tier: Tier): Tier | undefined {
  return TIERS[tierRank(tier) + 1];
}

export function tierLabel(tier: Tier): "LOW" | "MEDIUM" | "HIGH" | "SUPER" {
  return tier.toUpperCase() as "LOW" | "MEDIUM" | "HIGH" | "SUPER";
}

const KEYWORD_TIERS: Readonly<Record<Signal, Tier>> = {
  planning: "super",
  complex: "high",
  default: "medium",
  trivial: "low",
};

/** The tier the keyword classifier implies: planning, complex, default and trivial. */
export function keywordTier(signal: Signal): Tier {
  return KEYWORD_TIERS[signal];
}

// A gap that equals closeCall in decimal can differ from it by one rounding step in binary.
const EPSILON = 1e-9;

/** The most probable tier; when it leads the runner-up by at most `closeCall`, the higher of the two. */
export function closeCallTier(probabilities: Readonly<Record<Tier, number>>, closeCall: number): Tier {
  const ranked = [...TIERS].sort((a, b) => probabilities[b] - probabilities[a] || tierRank(b) - tierRank(a));
  const [first, second] = ranked as [Tier, Tier];
  return probabilities[first] - probabilities[second] <= closeCall + EPSILON ? higherTier(first, second) : first;
}
