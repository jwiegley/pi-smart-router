/**
 * Tests for the vendored low-intensity scoring (src/triage/tier-features.ts).
 *
 * The first group pins four scores computed with upstream's own function on these exact inputs.
 * The second group ports the four inequality tests of upstream's tests/unit/tier-features.test.ts
 * (vitest) to node:test, as test/triage.test.ts ported the triage tests.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  buildTierFeatures,
  DEFAULT_LOW_INTENSITY_WEIGHTS,
  scoreLowIntensity,
} from "../src/triage/tier-features.ts";
import type { LowIntensityWeights } from "../src/triage/tier-features.ts";
import { triage } from "../src/triage/triage-engine.ts";
import type {
  ClusterMatchResult,
  RequirementVector,
  TurnType,
} from "../src/triage/types.ts";

const PLANNING = "Plan the architecture for a distributed payment service with migration strategy";

/** The design's weights: upstream's defaults, with the two signals the router has no source for off. */
const DESIGN: LowIntensityWeights = { ...DEFAULT_LOW_INTENSITY_WEIGHTS, requirement_low: 0, cluster_signal: 0 };

const ZERO: LowIntensityWeights = {
  prompt_shortness: 0,
  token_shortness: 0,
  cyclomatic_low: 0,
  trivial_signal: 0,
  complex_inverse: 0,
  triage_verdict: 0,
  turn_type: 0,
  no_tool_context: 0,
  message_shallow: 0,
  prose_ratio: 0,
  requirement_low: 0,
  cluster_signal: 0,
};

/** Twenty messages whose roles alternate user, tool. */
const deepRoles = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? "user" : "tool"));

const close = (actual: number, expected: number, what: string): void =>
  assert.ok(Math.abs(actual - expected) < 5e-5, `${what}: ${actual} is not ${expected}`);

/** A request built as the router builds it, scored with the given weights. */
function score(
  promptText: string,
  turnType: TurnType,
  roles: readonly string[],
  tokens: number | undefined,
  weights: LowIntensityWeights,
  requirements?: RequirementVector,
  cluster?: ClusterMatchResult,
): number {
  return scoreLowIntensity(
    buildTierFeatures(
      {
        prompt_text: promptText,
        turn_type: turnType,
        messages: roles.map((role) => ({ role })),
        ...(tokens === undefined ? {} : { estimated_input_tokens: tokens }),
      },
      triage(promptText),
      requirements,
      cluster,
    ),
    weights,
  );
}

function cluster(overrides: Partial<ClusterMatchResult> = {}): ClusterMatchResult {
  return {
    clusterId: "low_stakes_general",
    tierBias: "zero-tier",
    similarity: 0.92,
    margin: 0.12,
    confidence: "high",
    elapsedMs: 3,
    ...overrides,
  };
}

describe("scoreLowIntensity", () => {
  test("scores upstream's own examples as upstream does", () => {
    close(score("what is 2+2 ?", "main_loop", [], undefined, DEFAULT_LOW_INTENSITY_WEIGHTS), 0.72043, "a trivial question, upstream's weights");
    close(score("what is 2+2 ?", "main_loop", [], undefined, DESIGN), 0.70274, "a trivial question, the design's weights");
    close(score(PLANNING, "planning", [], undefined, DESIGN), 0.32619, "a planning prompt");
    close(score("continue", "main_loop", deepRoles, 150_002, DESIGN), 0.55845, "a terse prompt in a deep session");
  });

  test("leaves a zero-weight signal out of the mean, and gives 0.5 when every weight is zero", () => {
    assert.equal(score("what is 2+2 ?", "main_loop", [], undefined, ZERO), 0.5, "every weight zero");
    close(score("what is 2+2 ?", "main_loop", [], undefined, { ...ZERO, turn_type: 1 }), 0.55, "turn_type alone, main_loop");
    close(score(PLANNING, "planning", [], undefined, { ...ZERO, turn_type: 1 }), 0, "turn_type alone, planning");
  });

  test("counts a missing requirement vector as easy, which is why the design zeroes that weight", () => {
    const onlyRequirement = { ...ZERO, requirement_low: 1 };
    assert.equal(score("what is 2+2 ?", "main_loop", [], undefined, onlyRequirement), 1, "a trivial question");
    assert.equal(score(PLANNING, "planning", [], undefined, onlyRequirement), 1, "a planning prompt");
  });
});

describe("upstream's inequality tests", () => {
  test("a simple question scores highly", () => {
    const score_ = score("what is 2+2 ?", "main_loop", [], 8, DEFAULT_LOW_INTENSITY_WEIGHTS);
    assert.ok(score_ > 0.7, `a simple question: ${score_} should be > 0.7`);
  });

  test("a planning architecture turn scores low", () => {
    const score_ = score(
      PLANNING,
      "planning",
      ["user"],
      40,
      DEFAULT_LOW_INTENSITY_WEIGHTS,
      { reasoning: 0.85, code_gen: 0.55, tool_use: 0.2 },
    );
    assert.ok(score_ < 0.35, `a planning turn: ${score_} should be < 0.35`);
  });

  test("a high-confidence low-stakes cluster match raises the score", () => {
    const without = score("what is 2+2 ?", "main_loop", [], 8, DEFAULT_LOW_INTENSITY_WEIGHTS);
    const with_ = score("what is 2+2 ?", "main_loop", [], 8, DEFAULT_LOW_INTENSITY_WEIGHTS, undefined, cluster());
    assert.ok(with_ > without, `with the cluster ${with_} should exceed ${without} without it`);
  });

  test("a high-confidence frontier-biased cluster match lowers the score", () => {
    const score_ = score(
      "architect a distributed cache layer",
      "planning",
      [],
      8,
      DEFAULT_LOW_INTENSITY_WEIGHTS,
      { reasoning: 0.9, code_gen: 0.7, tool_use: 0.2 },
      cluster({ clusterId: "architecture", tierBias: "frontier-cloud", similarity: 0.9, confidence: "high" }),
    );
    assert.ok(score_ < 0.4, `a frontier-biased cluster: ${score_} should be < 0.4`);
  });
});
