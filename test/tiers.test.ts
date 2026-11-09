import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Signal } from "../src/classify.ts";
import { closeCallTier, higherTier, isTier, keywordTier, tierAbove, tierLabel, tierRank, TIERS } from "../src/tiers.ts";

describe("tiers", () => {
  test("are ordered low to super", () => {
    assert.deepEqual([...TIERS], ["low", "medium", "high", "super"]);
    assert.equal(tierRank("low"), 0);
    assert.equal(tierRank("super"), 3);
    assert.equal(higherTier("medium", "high"), "high");
    assert.equal(higherTier("super", "low"), "super");
    assert.equal(tierAbove("low"), "medium");
    assert.equal(tierAbove("super"), undefined);
    assert.equal(tierLabel("medium"), "MEDIUM");
    assert.equal(isTier("high"), true);
    assert.equal(isTier("HIGH"), false);
    assert.equal(isTier(undefined), false);
  });

  test("keywordTier maps planning, complex, default and trivial", () => {
    const expected: Record<Signal, string> = { planning: "super", complex: "high", default: "medium", trivial: "low" };
    for (const signal of Object.keys(expected) as Signal[]) {
      assert.equal(keywordTier(signal), expected[signal], signal);
    }
  });
});

describe("closeCallTier", () => {
  test("takes the higher of two close leaders", () => {
    assert.equal(closeCallTier({ low: 0.1, medium: 0.45, high: 0.4, super: 0.05 }, 0.15), "high");
  });

  test("takes a clear leader as it is", () => {
    assert.equal(closeCallTier({ low: 0.05, medium: 0.7, high: 0.2, super: 0.05 }, 0.15), "medium");
  });

  test("counts a gap equal to closeCall as a close call", () => {
    assert.equal(closeCallTier({ low: 0, medium: 0.5, high: 0.35, super: 0.15 }, 0.15), "high");
  });

  test("sends tied probabilities to the higher tier", () => {
    assert.equal(closeCallTier({ low: 0.25, medium: 0.25, high: 0.25, super: 0.25 }, 0), "super");
    assert.equal(closeCallTier({ low: 0.5, medium: 0.5, high: 0, super: 0 }, 0), "medium");
  });
});
