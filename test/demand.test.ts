import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { capText, classify } from "../src/classify.ts";
import { demandOf, HEURISTIC_MESSAGES, isDeepSession, rolesOf, tierOfDemand } from "../src/demand.ts";
import type { Demand, DemandInput, PromptFacts } from "../src/demand.ts";
import type { JevOutcome } from "../src/jev.ts";
import { DEFAULT_DEMAND, SIGNALS } from "../src/settings.ts";
import type { DemandSettings } from "../src/settings.ts";
import { TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";
import { triage } from "../src/triage/triage-engine.ts";
import { buildTierFeatures, scoreLowIntensity } from "../src/triage/tier-features.ts";
import type { LowIntensityWeights } from "../src/triage/tier-features.ts";

const PLANNING = "Plan the architecture for a distributed payment service with migration strategy";
const alternating = Array.from({ length: HEURISTIC_MESSAGES }, (_, i) => (i % 2 === 0 ? "user" : "tool"));
const FRESH: PromptFacts = { contextTokens: undefined, roles: [], entries: undefined };
const DEEP: PromptFacts = { contextTokens: 150_000, roles: alternating, entries: 400 };
const SHALLOW: PromptFacts = { ...DEEP, contextTokens: 50_000 };

type Table = Readonly<Record<Tier, number>>;
const LOW: Table = { low: 0.8, medium: 0.1, high: 0.05, super: 0.05 };
const MEDIUM: Table = { low: 0.1, medium: 0.8, high: 0.05, super: 0.05 };
const HIGH: Table = { low: 0.05, medium: 0.1, high: 0.8, super: 0.05 };
const SUPER: Table = { low: 0.05, medium: 0.05, high: 0.1, super: 0.8 };

function answer(p: Table): JevOutcome {
  const [choice] = [...TIERS].sort((a, b) => p[b] - p[a]) as [Tier];
  return { kind: "answer", model: "jev", choice, probabilities: p, confidence: p[choice], ms: 10 };
}

function run(
  text: string,
  facts: PromptFacts,
  options: { planning?: boolean; risky?: boolean; jev?: JevOutcome | undefined; settings?: Partial<DemandSettings> } = {},
): Demand {
  const input: DemandInput = { text, planning: options.planning ?? false, risky: options.risky ?? false, jev: options.jev, facts };
  return demandOf(input, { ...DEFAULT_DEMAND, ...options.settings });
}

function close(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-3, `${message}: ${actual} is not within 1e-3 of ${expected}`);
}

describe("the heuristics alone", () => {
  test("give each kind of prompt the level the design's weights imply", () => {
    for (const [text, planning, facts, value, tier] of [
      ["what is 2+2 ?", false, FRESH, 0.8918, "medium"],
      ["fix the typo in the README", false, FRESH, 0.5112, "low"],
      [PLANNING, true, FRESH, 2.0214, "high"],
      ["Implement a concurrent rate limiter with a token bucket and add tests for it", false, FRESH, 1.3802, "medium"],
      ["continue", false, DEEP, 1.3246, "medium"],
    ] as const) {
      const demand = run(text, facts, { planning });
      close(demand.value, value, `${text}: the value`);
      assert.equal(demand.tier, tier, `${text}: the tier`);
      assert.deepEqual(demand.guards, [], `${text}: no guard`);
      assert.equal("jev" in demand, false, `${text}: no Jev term`);
      close(demand.heuristics.value, value, `${text}: the heuristics' value`);
      close(demand.heuristics.value, 3 * (1 - demand.heuristics.score), `${text}: 3 * (1 - score)`);
    }
  });

  test("name the three signals that raise the demand most, and their shares add up to 1 - score", () => {
    const demand = run("continue", DEEP);
    const { top, score } = demand.heuristics;
    assert.equal(top.length, 3, "three signals");
    for (let i = 1; i < top.length; i += 1) {
      assert.ok((top[i - 1]?.[1] ?? 0) >= (top[i]?.[1] ?? 0), "descending by share");
    }
    const capped = capText("continue");
    const features = buildTierFeatures(
      { prompt_text: capped, turn_type: "main_loop", messages: DEEP.roles.map((role) => ({ role })), estimated_input_tokens: 150_000 + Math.ceil(capped.length / 4) },
      triage(capped),
    );
    const total = SIGNALS.reduce((sum, name) => sum + DEFAULT_DEMAND.weights[name], 0);
    const shares = SIGNALS.map((name) => {
      const oneHot = Object.fromEntries(SIGNALS.map((other) => [other, other === name ? 1 : 0])) as unknown as LowIntensityWeights;
      return [name, (DEFAULT_DEMAND.weights[name] * (1 - scoreLowIntensity(features, oneHot))) / total] as const;
    });
    close(
      shares.reduce((sum, [, share]) => sum + share, 0),
      1 - score,
      "all shares add up to 1 - score",
    );
    const expected = shares
      .filter(([name]) => DEFAULT_DEMAND.weights[name] > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    assert.deepEqual(
      top.map(([name]) => name),
      expected.map(([name]) => name),
      "the three largest shares",
    );
    top.forEach(([name, share], i) => close(share, expected[i]?.[1] ?? NaN, `the share of ${name}`));
    for (const [name] of top) assert.ok(DEFAULT_DEMAND.weights[name as keyof LowIntensityWeights] > 0, `${name} has a weight`);
  });

  test("agree in direction with the keyword classifier's own examples", () => {
    const groups: Record<string, string[]> = {
      planning: ["plan the migration", "Can you design a cache for this?", "Refactor the authentication module"],
      complex: [
        "Debug the memory leak in the WebSocket handler",
        `What does this do?\n${["```js", ...Array.from({ length: 16 }, (_, i) => `if (a${i} && b) { x(); }`), "```"].join("\n")}`,
        "debug my-secret-service",
      ],
      trivial: ["Format this file", "format secret.txt", "Format the README"],
      default: ["Hello, how are you today?", "debug the typo", ""],
    };
    const values: Record<string, number[]> = {};
    for (const [signal, texts] of Object.entries(groups)) {
      values[signal] = texts.map((text) => {
        const classified = classify(text).signal;
        assert.equal(classified, signal, `the keyword classifier calls ${JSON.stringify(text.slice(0, 40))} ${signal}`);
        return run(text, FRESH, { planning: classified === "planning" }).value;
      });
    }
    const planning = values.planning ?? [];
    const trivial = values.trivial ?? [];
    assert.ok(Math.min(...planning) > Math.max(...trivial), "every planning prompt is above every trivial one");
    for (const v of planning) assert.ok(v >= 0.75, `a planning prompt is not LOW (${v})`);
    for (const v of trivial) assert.ok(v < 1.5, `a trivial prompt is not above MEDIUM (${v})`);
    assert.equal(values.complex?.length, 3, "three complex prompts ran");
    assert.equal(values.default?.length, 3, "three default prompts ran");
  });
});

describe("a confident Jev", () => {
  test("keeps the level it gives on a neutral prompt, at both ends of the scale", () => {
    for (const [table, text, facts, value, tier, guards] of [
      [LOW, "what is 2+2 ?", FRESH, 0.479, "low", []],
      [LOW, "continue", SHALLOW, 0.5821, "low", []],
      [MEDIUM, "what is 2+2 ?", FRESH, 1.0123, "medium", []],
      [HIGH, "fix the typo in the README", FRESH, 1.5312, "high", []],
      [SUPER, "what is 2+2 ?", FRESH, 2.2314, "super", ["close-call"]],
      [SUPER, "continue", DEEP, 2.3344, "super", []],
    ] as const) {
      const demand = run(text, facts, { jev: answer(table) });
      close(demand.value, value, `${tier} on ${text}: the value`);
      assert.equal(demand.tier, tier, `${tier} on ${text}: the tier`);
      assert.deepEqual(demand.guards, guards, `${tier} on ${text}: the guards`);
      close(demand.jev?.confidence ?? NaN, 0.8, `${tier} on ${text}: the confidence`);
    }
  });

  test("is moved one level by heuristics that disagree strongly", () => {
    const up = run(PLANNING, FRESH, { planning: true, jev: answer(LOW) });
    close(up.value, 0.748, "LOW against a planning prompt: the value");
    assert.equal(up.tier, "medium", "LOW against a planning prompt: the tier");
    assert.deepEqual(up.guards, ["close-call"], "LOW against a planning prompt: the guards");

    const down = run("fix the typo in the README", FRESH, { jev: answer(SUPER) });
    close(down.value, 2.1408, "SUPER against a typo fix: the value");
    assert.equal(down.tier, "high", "SUPER against a typo fix: the tier");
    assert.deepEqual(down.guards, [], "SUPER against a typo fix: the guards");
  });
});

describe("the guards", () => {
  test("an unsure Jev can only raise the heuristics' level", () => {
    const lower = run(PLANNING, FRESH, { planning: true, jev: answer({ low: 0.4, medium: 0.3, high: 0.2, super: 0.1 }) });
    close(lower.value, 2.0214, "an unsure Jev below the heuristics: the heuristics' value");
    assert.equal(lower.tier, "high", "an unsure Jev below the heuristics: the tier");
    assert.deepEqual(lower.guards, ["low-confidence"], "an unsure Jev below the heuristics: the guards");

    const higher = run("what is 2+2 ?", FRESH, { jev: answer({ low: 0.1, medium: 0.2, high: 0.3, super: 0.4 }) });
    close(higher.value, 1.5738, "an unsure Jev above the heuristics: the blend");
    assert.equal(higher.tier, "high", "an unsure Jev above the heuristics: the tier");
    assert.deepEqual(higher.guards, [], "an unsure Jev above the heuristics: the guards");
  });

  test("a risky operation is never under HIGH, and a very deep session never under the floor", () => {
    const risky = run("what is 2+2 ?", FRESH, { risky: true, jev: answer(LOW) });
    close(risky.value, 0.479, "risky: the value is not raised");
    assert.equal(risky.tier, "high", "risky: the tier");
    assert.deepEqual(risky.guards, ["risky"], "risky: the guards");

    const sure = { low: 0.9, medium: 0.1, high: 0, super: 0 };
    const deep = run("continue", DEEP, { jev: answer(sure) });
    close(deep.value, 0.3662, "deep tokens: the value");
    assert.equal(deep.tier, "medium", "deep tokens: the tier");
    assert.deepEqual(deep.guards, ["deep-session"], "deep tokens: the guards");

    const longBranch = run("continue", { ...SHALLOW, entries: 1_001 }, { jev: answer(sure) });
    assert.equal(longBranch.tier, "medium", "1,001 entries: the tier");
    assert.deepEqual(longBranch.guards, ["deep-session"], "1,001 entries: the guards");

    const off = run("continue", { ...SHALLOW, entries: 1_001 }, { jev: answer(sure), settings: { deepSessionFloor: "low" } });
    assert.equal(off.tier, "low", "a floor of low: the tier");
    assert.deepEqual(off.guards, [], "a floor of low: the guards");

    const edge = run("continue", { ...SHALLOW, entries: 1_000, contextTokens: 100_000 }, { jev: answer(sure) });
    assert.equal(edge.tier, "low", "exactly 100,000 tokens and 1,000 entries is not deep");
  });

  test("a Jev that failed, or weights that silence one side, leave the other to decide", () => {
    const failed: JevOutcome = { kind: "failure", model: "jev", failure: "timeout", ms: 1_000 };
    const without = run("what is 2+2 ?", FRESH);
    const withFailure = run("what is 2+2 ?", FRESH, { jev: failed });
    assert.deepEqual(withFailure, without, "a failure equals no Jev");
    assert.equal("jev" in withFailure, false, "a failure leaves no Jev term");

    const noHeuristics = run("what is 2+2 ?", FRESH, { jev: answer(HIGH), settings: { heuristicsWeight: 0 } });
    close(noHeuristics.value, 1.85, "heuristicsWeight 0: Jev's expected level");

    const noJev = run("what is 2+2 ?", FRESH, { jev: answer(HIGH), settings: { jevWeight: 0 } });
    close(noJev.value, without.heuristics.value, "jevWeight 0: the heuristics' value");
  });
});

describe("isDeepSession", () => {
  test("is over 100,000 tokens or over 1,000 entries, and an unknown figure is not over", () => {
    for (const [contextTokens, entries, deep] of [
      [100_000, undefined, false],
      [100_001, undefined, true],
      [undefined, 1_000, false],
      [undefined, 1_001, true],
      [100_000, 1_000, false],
      [100_001, 1_000, true],
      [100_000, 1_001, true],
      [undefined, undefined, false],
    ] as const) {
      assert.equal(
        isDeepSession({ contextTokens, entries }),
        deep,
        `${String(contextTokens)} tokens and ${String(entries)} entries: deep only over DEEP_SESSION_TOKENS tokens or DEEP_SESSION_ENTRIES entries, and an unknown size (right after a compaction) is not over`,
      );
    }
  });

  test("is the test demandOf's deep-session guard applies", () => {
    const sure = { low: 0.9, medium: 0.1, high: 0, super: 0 };
    for (const facts of [DEEP, SHALLOW, { ...SHALLOW, entries: 1_001 }, { ...SHALLOW, entries: 1_000, contextTokens: 100_000 }, FRESH]) {
      const demand = run("continue", facts, { jev: answer(sure) });
      assert.equal(demand.guards.includes("deep-session"), isDeepSession(facts), `${JSON.stringify(facts)}: the guard applies exactly when the session is deep`);
    }
  });
});

describe("tierOfDemand", () => {
  test("cuts the scale at 0.75, 1.5 and 2.25, and sends a close call up", () => {
    for (const [value, tier, closeCall] of [
      [0, "low", false],
      [0.64, "low", false],
      [0.65, "medium", true],
      [0.75, "medium", false],
      [1.39, "medium", false],
      [1.41, "high", true],
      [1.5, "high", false],
      [2.15, "super", true],
      [2.25, "super", false],
      [3, "super", false],
    ] as const) {
      assert.deepEqual(tierOfDemand(value, DEFAULT_DEMAND), { tier, closeCall }, `a demand of ${value}`);
    }
  });
});

describe("the roles the heuristics see", () => {
  test("are the roles of the messages Pi would send the model: a tool result is tool, and any other non-assistant role is the user's", () => {
    assert.deepEqual(rolesOf([{ role: "toolResult" }]), ["tool"], "a tool result is a tool message");
    assert.deepEqual(rolesOf([{ role: "assistant" }]), ["assistant"], "an assistant message is the assistant's");
    assert.deepEqual(rolesOf([{ role: "user" }]), ["user"], "a user message is the user's");
    assert.deepEqual(rolesOf([{ role: "bashExecution", command: "ls" }]), ["user"], "Pi sends a ! shell run as a user message");
    assert.deepEqual(rolesOf([{ role: "custom" }]), ["user"], "any other role Pi sends goes as the user's");
  });

  test("leave out what Pi keeps out of the model's context, and what is no message", () => {
    assert.deepEqual(rolesOf([{ role: "bashExecution", excludeFromContext: true }]), [], "Pi keeps a !! shell run out of the model's context");
    assert.deepEqual(rolesOf([{ content: "no role" }, { role: 7 }, "user", 42, null, undefined]), [], "a message without a string role, a non-object and undefined are not counted");
    assert.deepEqual(rolesOf([{ role: "user" }, undefined, { role: "toolResult" }]), ["user", "tool"], "the rest still count");
  });

  test("are the latest twenty, oldest first", () => {
    const messages = Array.from({ length: 25 }, (_, i) => ({ role: i % 5 === 4 ? "toolResult" : i % 2 === 0 ? "user" : "assistant" }));
    const roles = rolesOf(messages);
    assert.equal(roles.length, HEURISTIC_MESSAGES, "at most HEURISTIC_MESSAGES");
    assert.deepEqual(roles, rolesOf(messages.slice(5)), "the last twenty of twenty-five");
    assert.deepEqual(roles.slice(0, 3), ["assistant", "user", "assistant"], "oldest first: messages 5, 6 and 7");
    assert.equal(roles.at(-1), "tool", "message 24, a tool result, is last");
  });
});
