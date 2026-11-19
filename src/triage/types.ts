// The upstream types that src/triage/tier-features.ts reads, reduced to the fields it uses. The
// names are upstream's (beettlle/pi-smart-router, src/domain/types and
// src/domain/matching/cluster-matcher.ts, at commit 54bee53d908a81260a34b94cbe124bfd61f57df7).

export type TurnType = "planning" | "tool_result" | "subagent" | "main_loop" | "unknown";

/** Upstream's three tiers, used only by the cluster fields. Not the fork's levels (src/tiers.ts). */
export type Tier = "zero-tier" | "economical-cloud" | "frontier-cloud";

export interface Message {
  readonly role: string;
}

export interface RoutingRequest {
  readonly prompt_text: string;
  readonly messages?: readonly Message[];
  readonly turn_type?: TurnType;
  readonly estimated_input_tokens?: number;
}

export interface RequirementVector {
  readonly reasoning: number;
  readonly code_gen: number;
  readonly tool_use: number;
}

export type ClusterMatchConfidence = "high" | "low" | "none";

export interface ClusterMatchResult {
  readonly clusterId: string;
  readonly tierBias: Tier;
  readonly similarity: number;
  readonly margin: number;
  readonly confidence: ClusterMatchConfidence;
  readonly elapsedMs: number;
}
