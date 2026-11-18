import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { higherTier, isTier, tierAbove, tierLabel, tierRank, TIERS } from "../src/tiers.ts";

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
});
