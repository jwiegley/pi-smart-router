import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { Usage } from "@earendil-works/pi-ai";

import {
  againChance,
  answerOf,
  effortOf,
  forgetCaches,
  horizonFor,
  newLedger,
  noteAnswer,
  noteRunEnd,
  notePrompt,
  runShape,
  seedAnswer,
} from "../src/ledger.ts";
import type { Answer, Ledger } from "../src/ledger.ts";
import { RUN_DEFAULTS } from "../src/settings.ts";
import type { Tier } from "../src/tiers.ts";
import { model } from "./support/catalog.ts";

const T = 1_700_000_000_000;

function usageOf(init: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">> = {}): Usage {
  const parts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...init };
  return { ...parts, totalTokens: parts.input + parts.output + parts.cacheRead + parts.cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function answer(ref: string, init: Partial<Answer> & { readonly tokens?: number; readonly output?: number } = {}): Answer {
  const { tokens, output, ...rest } = init;
  const slash = ref.indexOf("/");
  return {
    ref,
    provider: ref.slice(0, slash),
    usage: usageOf({ input: tokens ?? 1_000, output: output ?? 0 }),
    effort: undefined,
    startedAt: T,
    at: T + 1_000,
    ...rest,
  };
}

/** One finished run of `sizes.length` requests, one answer per prompt size, the run lasting `seconds`. */
function runOf(ledger: Ledger, sizes: readonly number[], outputs: readonly number[], seconds: number): void {
  sizes.forEach((tokens, index) => {
    const startedAt = T;
    const at = index === sizes.length - 1 ? T + seconds * 1_000 : T + (index + 1) * 1_000;
    noteAnswer(ledger, answer("p/m", { tokens, output: outputs[index] ?? 0, startedAt, at }));
  });
  noteRunEnd(ledger);
}

describe("a model's cache", () => {
  test("is the prompt size of its last answer: input, cached read and cache write, not output", () => {
    const ledger = newLedger();
    noteAnswer(ledger, { ...answer("p/m"), usage: usageOf({ input: 20_000, cacheRead: 130_000, cacheWrite: 0, output: 1_000 }), effort: "high", at: T + 5 });
    assert.deepEqual(ledger.seen.get("p/m"), { tokens: 150_000, at: T + 5, effort: "high" }, "input plus cache read, no output");
    assert.deepEqual(ledger.latest, { ref: "p/m", tokens: 150_000 }, "the latest answer");
    noteAnswer(ledger, { ...answer("p/m"), usage: usageOf({ input: 1_000, cacheRead: 100, cacheWrite: 900 }) });
    assert.equal(ledger.seen.get("p/m")?.tokens, 2_000, "cache write counts toward the prompt");
  });

  test("two accounts with one model id keep separate figures", () => {
    const ledger = newLedger();
    noteAnswer(ledger, answer("openai-codex-2/gpt-6-astra", { tokens: 100_000, at: T + 1 }));
    noteAnswer(ledger, answer("openai-codex-3/gpt-6-astra", { tokens: 120_000, at: T + 2 }));
    assert.equal(ledger.seen.size, 2, "two entries");
    assert.equal(ledger.seen.get("openai-codex-2/gpt-6-astra")?.tokens, 100_000, "first account");
    assert.equal(ledger.seen.get("openai-codex-3/gpt-6-astra")?.tokens, 120_000, "second account");
  });

  test("is forgotten for every model when the same model's next prompt is smaller: the conversation was rewritten", () => {
    const ledger = newLedger();
    noteAnswer(ledger, answer("p/a", { tokens: 150_000 }));
    noteAnswer(ledger, answer("p/b", { tokens: 151_000 }));
    noteAnswer(ledger, answer("p/b", { tokens: 40_000 }));
    assert.deepEqual([...ledger.seen.keys()], ["p/b"], "only the answering model remains");
    assert.equal(ledger.seen.get("p/b")?.tokens, 40_000, "at its new size");
    assert.deepEqual(ledger.latest, { ref: "p/b", tokens: 40_000 }, "latest follows");
  });

  test("is kept when another model's first prompt counts fewer tokens: tokenizers differ", () => {
    const ledger = newLedger();
    noteAnswer(ledger, answer("p/a", { tokens: 150_000 }));
    noteAnswer(ledger, answer("p/b", { tokens: 120_000 }));
    assert.deepEqual([...ledger.seen.keys()].sort(), ["p/a", "p/b"], "both kept");
    assert.equal(ledger.seen.get("p/a")?.tokens, 150_000, "a untouched");
  });

  test("is forgotten for every model by forgetCaches, which keeps the runs and the prompts", () => {
    const ledger = newLedger();
    noteAnswer(ledger, { ...answer("p/a", { tokens: 150_000 }), usage: usageOf({ input: 150_000, cacheWrite: 5 }) });
    noteRunEnd(ledger);
    notePrompt(ledger, "medium", "super");
    noteAnswer(ledger, answer("q/b", { tokens: 10_000 }));
    const runs = [...ledger.runs];
    const needs = [...ledger.needs];
    const writes = new Set(ledger.writes);
    forgetCaches(ledger);
    assert.equal(ledger.seen.size, 0, "no cache remains");
    assert.equal(ledger.latest, undefined, "no latest answer");
    assert.deepEqual(ledger.runs, runs, "runs unchanged");
    assert.deepEqual(ledger.needs, needs, "prompts unchanged");
    assert.deepEqual(ledger.writes, writes, "writes unchanged");
  });

  test("records a provider's cache writes, and ignores an answer without usage", () => {
    const ledger = newLedger();
    noteAnswer(ledger, { ...answer("p/a"), usage: usageOf({ input: 10, cacheWrite: 5 }) });
    assert.ok(ledger.writes.has("p"), "a cache write marks the provider");
    noteAnswer(ledger, { ...answer("q/b"), usage: usageOf() });
    assert.equal(ledger.writes.has("q"), false, "no write, no mark");
    assert.equal(ledger.seen.has("q/b"), false, "an all-zero usage leaves no Seen");
    assert.equal(ledger.latest?.ref, "p/a", "and does not become the latest answer");
    assert.equal(ledger.run?.requests, 2, "the run still counts the request");
    noteAnswer(ledger, { ...answer("p/a", { startedAt: T + 10 }), usage: usageOf() });
    assert.equal(ledger.seen.get("p/a")?.tokens, 15, "an empty usage leaves the earlier figure");
  });

  test("a run whose first answer reports no usage takes its first prompt size from the first one that does", () => {
    const ledger = newLedger();
    noteAnswer(ledger, { ...answer("p/a"), usage: usageOf() });
    noteAnswer(ledger, answer("p/a", { tokens: 100_000 }));
    noteAnswer(ledger, answer("p/a", { tokens: 102_000 }));
    noteRunEnd(ledger);
    assert.equal(ledger.runs[0]?.growth, 1_000, "growth is 2,000 tokens over two steps, measured from the first prompt size that was reported");
  });
});

describe("effortOf", () => {
  const mapped = model("p/m", { reasoning: true, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high" } });

  test("is the level the model maps it to, after Pi's clamp", () => {
    assert.equal(effortOf(mapped, "minimal"), "low", "minimal maps to low");
    assert.equal(effortOf(mapped, "low"), "low", "low stays low");
    assert.equal(effortOf(mapped, "high"), "high", "high stays high");
    assert.equal(effortOf(mapped, "off"), "low", "off is unsupported: clamped up to minimal, which maps to low");
  });

  test("answerOf prefers the provider's own effort, else maps the recorded level, else knows none", () => {
    const usage = usageOf({ input: 1 });
    const base = { provider: "p", model: "m", usage };
    assert.equal(answerOf({ ...base, providerThinkingLevel: "xhigh", thinkingLevel: "low" }, mapped, T).effort, "xhigh", "the provider's own effort wins");
    assert.equal(answerOf({ ...base, thinkingLevel: "minimal" }, mapped, T).effort, "low", "the recorded level maps through the model");
    assert.equal(answerOf({ ...base }, mapped, T).effort, undefined, "neither: none known");
    assert.equal(answerOf({ ...base, thinkingLevel: "high" }, undefined, T).effort, undefined, "no catalog model: none known");
    assert.equal(answerOf({ ...base, providerThinkingLevel: "xhigh" }, undefined, T).effort, "xhigh", "the provider's effort needs no catalog model");
    assert.equal(answerOf({ ...base, timestamp: T - 500 }, mapped, T).startedAt, T - 500, "startedAt is the message's timestamp");
    assert.equal(answerOf({ ...base }, mapped, T).startedAt, T, "else the time given");
    const made = answerOf({ ...base }, mapped, T + 7);
    assert.equal(made.ref, "p/m", "ref is provider/id");
    assert.equal(made.provider, "p", "provider");
    assert.equal(made.at, T + 7, "at is the time given");
  });
});

describe("the run shape", () => {
  test("is the defaults until three runs have ended", () => {
    const ledger = newLedger();
    assert.deepEqual(runShape(ledger), RUN_DEFAULTS, "after no run");
    runOf(ledger, [100, 200], [10, 10], 10);
    runOf(ledger, [100, 200], [10, 10], 10);
    assert.deepEqual(runShape(ledger), RUN_DEFAULTS, "after two runs");
  });

  test("is the median of each figure over the last ten runs", () => {
    const ledger = newLedger();
    for (const sizes of [2, 4, 9]) runOf(ledger, Array.from({ length: sizes }, () => 1_000), [], 10);
    assert.equal(runShape(ledger).requests, 4, "the median of 2, 4 and 9 requests");

    const shaped = newLedger();
    runOf(shaped, [100_000, 101_500, 104_000], [500, 700, 900], 90);
    runOf(shaped, [100_000, 101_500, 104_000], [500, 700, 900], 90);
    runOf(shaped, [100_000, 101_500, 104_000], [500, 700, 900], 90);
    assert.deepEqual(runShape(shaped), { requests: 3, output: 700, growth: 2_000, seconds: 90 }, "output per request, growth per request, seconds");

    const eleven = newLedger();
    runOf(eleven, Array.from({ length: 100 }, () => 1_000), [], 10);
    for (let i = 0; i < 10; i++) runOf(eleven, [1_000, 1_000], [], 10);
    assert.equal(eleven.runs.length, 10, "only the last ten are kept");
    assert.equal(runShape(eleven).requests, 2, "the eleventh run dropped the first");

    const even = newLedger();
    for (const requests of [2, 4, 6, 8]) runOf(even, Array.from({ length: requests }, () => 1_000), [], 10);
    assert.equal(runShape(even).requests, 5, "an even count takes the mean of the middle two");
  });

  test("a run of one request grows by nothing, and seeding counts no run", () => {
    const ledger = newLedger();
    noteAnswer(ledger, answer("p/m", { tokens: 5_000 }));
    noteRunEnd(ledger);
    assert.equal(ledger.runs[0]?.growth, 0, "one request: no growth");
    assert.equal(ledger.run, undefined, "the run is closed");

    const seeded = newLedger();
    for (let i = 0; i < 3; i++) seedAnswer(seeded, answer("p/m", { tokens: 1_000 + i }));
    noteRunEnd(seeded);
    assert.deepEqual(seeded.runs, [], "seeding counts no run");
    assert.equal(seeded.seen.get("p/m")?.tokens, 1_002, "but the cache is known");
    seedAnswer(seeded, { ...answer("q/m"), usage: usageOf({ input: 10, cacheWrite: 1 }) });
    assert.ok(seeded.writes.has("q"), "and the provider's writes");
  });

  test("a compaction or a move in the tree in mid-run counts the run whole, and measures its growth only after the event", () => {
    const ledger = newLedger();
    noteAnswer(ledger, answer("p/m", { tokens: 100_000, output: 100, startedAt: T, at: T + 1_000 }));
    noteAnswer(ledger, answer("p/m", { tokens: 110_000, output: 200, startedAt: T, at: T + 2_000 }));
    forgetCaches(ledger);
    for (const [index, tokens] of [30_000, 31_000, 32_000].entries()) {
      noteAnswer(ledger, answer("p/m", { tokens, output: 300, startedAt: T, at: T + (3 + index) * 1_000 }));
    }
    noteRunEnd(ledger);
    assert.deepEqual(
      ledger.runs[0],
      { requests: 5, output: 240, growth: 1_000, seconds: 5 },
      "five requests, their output and seconds counted whole; growth 2,000 tokens over the two steps after the event, not across it",
    );

    const few = newLedger();
    noteAnswer(few, answer("p/m", { tokens: 100_000 }));
    noteAnswer(few, answer("p/m", { tokens: 110_000 }));
    forgetCaches(few);
    noteAnswer(few, answer("p/m", { tokens: 30_000 }));
    noteRunEnd(few);
    assert.deepEqual([few.runs[0]?.requests, few.runs[0]?.growth], [3, 0], "one answer after the event: three requests, and no growth measured");

    const none = newLedger();
    noteAnswer(none, answer("p/m", { tokens: 100_000 }));
    noteAnswer(none, answer("p/m", { tokens: 110_000 }));
    forgetCaches(none);
    noteRunEnd(none);
    assert.deepEqual([none.runs[0]?.requests, none.runs[0]?.growth], [2, 0], "no answer after the event: two requests, and no growth measured");
  });

  test("growth is never negative", () => {
    const ledger = newLedger();
    noteAnswer(ledger, answer("p/m", { tokens: 9_000 }));
    noteAnswer(ledger, answer("p/m", { tokens: 3_000 }));
    noteRunEnd(ledger);
    assert.equal(ledger.runs[0]?.growth, 0, "a shrinking prompt is no growth");
  });
});

describe("the horizon and the chance a level is needed again", () => {
  function promptsOf(pairs: readonly (readonly [Tier, Tier])[]): Ledger {
    const ledger = newLedger();
    for (const [need, took] of pairs) notePrompt(ledger, need, took);
    return ledger;
  }

  test("the horizon is 1 plus the lighter prompts in a row that stayed on a stronger model, up to the cap", () => {
    assert.equal(horizonFor(newLedger(), "medium", 5), 1, "no prompts");
    const two = promptsOf([["medium", "super"], ["medium", "super"]]);
    assert.equal(horizonFor(two, "medium", 5), 3, "two such prompts");
    assert.equal(horizonFor(two, "low", 5), 1, "they needed more than low");
    assert.equal(horizonFor(promptsOf([["low", "super"], ["medium", "super"]]), "medium", 5), 3, "a lighter need counts too");
    assert.equal(horizonFor(promptsOf([["medium", "medium"], ["medium", "super"]]), "medium", 5), 2, "a prompt that took only the level it needed ends the run");
    assert.equal(horizonFor(promptsOf(Array.from({ length: 7 }, () => ["medium", "super"] as const)), "medium", 5), 5, "capped");
  });

  test("the chance is the share of the last ten prompts that needed the level or more, 0.5 until three, never under 0.2", () => {
    assert.equal(againChance(newLedger(), "super"), 0.5, "no prompts");
    assert.equal(againChance(promptsOf([["low", "low"], ["low", "low"]]), "super"), 0.5, "two prompts");
    assert.equal(againChance(promptsOf([["super", "super"], ["medium", "medium"], ["medium", "medium"], ["medium", "medium"]]), "super"), 0.25, "one in four");
    const lows = promptsOf(Array.from({ length: 10 }, () => ["low", "low"] as const));
    assert.equal(againChance(lows, "super"), 0.2, "the floor");
    assert.equal(againChance(lows, "low"), 1, "every prompt needed low or more");
  });

  test("notePrompt keeps the last ten", () => {
    const ledger = promptsOf(Array.from({ length: 12 }, (_, i) => [i < 2 ? "super" : "low", "low"] as const));
    assert.equal(ledger.needs.length, 10, "ten kept");
    assert.equal(againChance(ledger, "super"), 0.2, "the two oldest super prompts were dropped");
  });
});
