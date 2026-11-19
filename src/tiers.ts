// The four intelligence tiers, low < medium < high < super, shown as LOW, MEDIUM, HIGH and SUPER.
// They are called tiers because Level and ALL_LEVELS already mean thinking levels (constants.ts).

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
