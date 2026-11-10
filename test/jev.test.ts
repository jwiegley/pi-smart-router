import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

import { HEAD_CHARS, TAIL_CHARS } from "../src/classify.ts";
import {
  askJev,
  buildContext,
  interpret,
  JEV_INSTRUCTIONS,
  JEV_QUESTION,
  recentMessages,
  type ClassifierRegistry,
  type JevContextCaps,
  type JevSettings,
} from "../src/jev.ts";
import { REDACTED } from "../src/redact.ts";
import { TIERS, type Tier } from "../src/tiers.ts";

const descriptions: Record<Tier, string> = { low: "L", medium: "M", high: "H", super: "S" };
const caps: JevContextCaps = { messages: 6, messageChars: 1500, totalChars: 12000 };

function stateOf(context: ClassifierContext): { message: string; recent: Array<{ role: string; text: string }> } {
  return context.state as unknown as { message: string; recent: Array<{ role: string; text: string }> };
}

describe("recentMessages", () => {
  const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

  test("keeps user and assistant text, in order", () => {
    const entries = [
      { type: "custom", data: 1 },
      message("user", "first"),
      message("assistant", [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "second" },
        { type: "toolCall", id: "1", name: "x", arguments: {} },
      ]),
      message("toolResult", [{ type: "text", text: "tool output" }]),
      message("user", [{ type: "text", text: "third" }]),
    ];
    assert.deepEqual(recentMessages(entries, 10), [
      { role: "user", text: "first" },
      { role: "assistant", text: "second" },
      { role: "user", text: "third" },
    ]);
  });

  test("drops an assistant message with no text, without counting it", () => {
    const entries = [
      message("user", "one"),
      message("assistant", "two"),
      message("assistant", [{ type: "toolCall", id: "1", name: "x", arguments: {} }]),
      message("user", "three"),
    ];
    assert.deepEqual(recentMessages(entries, 2), [
      { role: "assistant", text: "two" },
      { role: "user", text: "three" },
    ]);
  });

  test("keeps the last limit messages", () => {
    const entries = [message("user", "a"), message("user", "b"), message("user", "c")];
    assert.deepEqual(recentMessages(entries, 2).map((m) => m.text), ["b", "c"]);
    assert.deepEqual(recentMessages(entries, 0), []);
  });
});

describe("buildContext", () => {
  test("asks one choice question over the tiers", () => {
    const context = buildContext("hello", [{ role: "user", text: "hi" }], descriptions, caps);
    assert.deepEqual(Object.keys(context.questions), [JEV_QUESTION]);
    const question = context.questions[JEV_QUESTION]!;
    assert.equal(question.type, "choice");
    assert.equal(question.instructions, JEV_INSTRUCTIONS);
    assert.deepEqual(Object.keys(question.criteria), [...TIERS]);
    assert.deepEqual(question.criteria, descriptions);
    assert.deepEqual(stateOf(context), { message: "hello", recent: [{ role: "user", text: "hi" }] });
  });

  test("redacts before capping, so a secret across the head boundary leaves no fragment", () => {
    const secret = `sk-proj-${"aB3dE5gH7j".repeat(4)}`;
    const text = `${"x ".repeat(HEAD_CHARS)}`.slice(0, HEAD_CHARS - 20) + secret + " tail ".repeat(5000);
    const out = stateOf(buildContext(text, [], descriptions, { ...caps, totalChars: 32000 })).message;
    assert.ok(out.includes(REDACTED));
    for (let i = 0; i + 8 <= secret.length; i++) {
      assert.ok(!out.includes(secret.slice(i, i + 8)), secret.slice(i, i + 8));
    }
  });

  test("redacts the message before each of its cuts, so no part of a secret survives wherever a cut falls", () => {
    // Every split, the short ones included: a head fragment such as "sk-proj-Q9Z" is no key shape of
    // its own, so a cut made first would leave it. Only the spaces, the line break a cut inserts and
    // the marker, or a piece of it, may remain: not even an "s" or an "8" of the secret.
    const secret = `sk-proj-${"Q9Z8".repeat(10)}`;
    const cuts: ReadonlyArray<readonly [string, (split: number) => string, JevContextCaps]> = [
      // capText keeps the first HEAD_CHARS and the last TAIL_CHARS - 1 characters.
      ["the head cut", (split) => `${" ".repeat(HEAD_CHARS - split)}${secret}${" ".repeat(8000)}`, { ...caps, totalChars: 32000 }],
      ["the tail cut", (split) => `${" ".repeat(30000)}${secret}${" ".repeat(TAIL_CHARS - 1 - split)}`, { ...caps, totalChars: 32000 }],
      // Then totalChars, here 1000: the first 800 and the last 199 characters.
      ["totalChars's head cut", (split) => `${" ".repeat(800 - split)}${secret}${" ".repeat(4000)}`, { ...caps, totalChars: 1000 }],
      ["totalChars's tail cut", (split) => `${" ".repeat(4000)}${secret}${" ".repeat(199 - split)}`, { ...caps, totalChars: 1000 }],
    ];
    for (const [cut, text, limits] of cuts) {
      for (let split = 1; split < secret.length; split++) {
        const out = stateOf(buildContext(text(split), [], descriptions, limits)).message;
        assert.match(out, /^[ \n[\]redact]*$/, `${cut}, ${split} characters of the secret inside it: ${JSON.stringify(out.trim())}`);
      }
    }
  });

  test("redacts recent messages", () => {
    const context = buildContext("m", [{ role: "user", text: "password=hunter2" }], descriptions, caps);
    assert.ok(!JSON.stringify(context.state).includes("hunter2"));
  });

  test("redacts a recent text before the messageChars cut, so a secret across the cut leaves no fragment", () => {
    const secret = `sk-proj-${"aB3dE5gH7j".repeat(4)}`;
    const text = "q ".repeat(150) + secret + "q ".repeat(86);
    const recent = stateOf(buildContext("m", [{ role: "user", text }], descriptions, { ...caps, messageChars: 200 })).recent;
    const out = recent[0]!.text;
    assert.ok(out.includes(REDACTED), out);
    for (let i = 0; i + 8 <= secret.length; i++) {
      assert.ok(!out.includes(secret.slice(i, i + 8)), secret.slice(i, i + 8));
    }
  });

  test("cuts each recent text to its last messageChars characters", () => {
    const text = `${"a".repeat(300)}${"b".repeat(200)}`;
    const recent = stateOf(buildContext("m", [{ role: "assistant", text }], descriptions, { ...caps, messageChars: 200 })).recent;
    assert.equal(recent[0]!.text, "b".repeat(200));
  });

  test("drops the oldest recent messages first to stay within totalChars", () => {
    const recent = [
      { role: "user" as const, text: "1".repeat(300) },
      { role: "assistant" as const, text: "2".repeat(300) },
      { role: "user" as const, text: "3".repeat(300) },
    ];
    const state = stateOf(buildContext("m".repeat(100), recent, descriptions, { messages: 6, messageChars: 300, totalChars: 950 }));
    assert.deepEqual(state.recent.map((m) => m.text[0]), ["2", "3"]);
    const total = state.message.length + state.recent.reduce((sum, m) => sum + m.text.length, 0);
    assert.ok(total <= 950, String(total));
  });

  test("cuts a long message to exactly totalChars, keeping its head and tail, and leaves recent nothing", () => {
    const message = `${"h".repeat(5000)}${"t".repeat(5000)}`;
    const state = stateOf(
      buildContext(message, [{ role: "user", text: "older" }], descriptions, { messages: 6, messageChars: 300, totalChars: 1000 }),
    );
    assert.equal(state.message.length, 1000);
    assert.equal(state.message, `${"h".repeat(800)}\n${"t".repeat(199)}`);
    assert.deepEqual(state.recent, []);
  });

  test("keeps at most caps.messages recent messages", () => {
    const recent = Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, text: `m${i}` }));
    assert.deepEqual(
      stateOf(buildContext("x", recent, descriptions, { ...caps, messages: 2 })).recent.map((m) => m.text),
      ["m3", "m4"],
    );
    assert.deepEqual(stateOf(buildContext("x", recent, descriptions, { ...caps, messages: 0 })).recent, []);
  });
});

function stopResult(answer: unknown): ClassifierResult {
  return {
    api: "openrouter-chat-classifier",
    provider: "openrouter",
    model: "typesafe/jev-1.14",
    answers: answer === undefined ? {} : { [JEV_QUESTION]: answer },
    stopReason: "stop",
    timestamp: 0,
  } as unknown as ClassifierResult;
}

function failedResult(stopReason: "error" | "aborted", errorMessage?: string): ClassifierResult {
  return { ...stopResult(undefined), stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) };
}

const goodAnswer = {
  type: "choice",
  choice: "medium",
  probabilities: { low: 0.05, medium: 0.45, high: 0.4, super: 0.1 },
  confidence: 0.8,
};

describe("interpret", () => {
  test("takes the higher tier of a close call", () => {
    const outcome = interpret(stopResult(goodAnswer), 0.15, "m", 12);
    assert.deepEqual(outcome, {
      kind: "answer",
      model: "m",
      choice: "medium",
      tier: "high",
      probabilities: goodAnswer.probabilities,
      confidence: 0.8,
      ms: 12,
    });
  });

  test("treats malformed answers as failures", () => {
    const { super: _dropped, ...missing } = goodAnswer.probabilities;
    const cases: unknown[] = [
      { ...goodAnswer, choice: "other" },
      { ...goodAnswer, probabilities: missing },
      { ...goodAnswer, probabilities: { ...goodAnswer.probabilities, other: 0.1 } },
      { ...goodAnswer, probabilities: { ...goodAnswer.probabilities, high: Number.NaN } },
      { ...goodAnswer, confidence: "high" },
      { ...goodAnswer, type: "score" },
      undefined,
    ];
    for (const answer of cases) {
      assert.deepEqual(interpret(stopResult(answer), 0.15, "m", 1), { kind: "failure", model: "m", failure: "malformed", ms: 1 });
    }
  });

  test("names timeouts, other errors and aborts", () => {
    const failure = (r: ClassifierResult) => {
      const outcome = interpret(r, 0.15, "m", 1);
      return outcome.kind === "failure" ? outcome.failure : outcome.kind;
    };
    assert.equal(failure(failedResult("error", "Request timed out after 1000ms")), "timeout");
    assert.equal(failure(failedResult("error", "401 unauthorized")), "error");
    assert.equal(failure(failedResult("error")), "error");
    assert.equal(failure(failedResult("aborted")), "aborted");
  });
});

describe("askJev", () => {
  const settings: JevSettings = { model: "openrouter/typesafe/jev-1.14", timeoutMs: 1000, closeCall: 0.15, context: caps };
  const model = { id: "typesafe/jev-1.14" } as unknown as ClassifierModel<ClassifierApi>;
  const context = buildContext("hi", [], descriptions, caps);

  function fake(found: boolean, classify: ClassifierRegistry["classify"]) {
    const lookups: unknown[][] = [];
    const registry: ClassifierRegistry = {
      findOfType(...args) {
        lookups.push(args);
        return found ? model : undefined;
      },
      classify,
    };
    return { registry, lookups };
  }

  test("looks the model up, passes the options and measures the time", async () => {
    const seen: unknown[] = [];
    const { registry, lookups } = fake(true, async (_model, _context, options) => {
      seen.push(options);
      return stopResult(goodAnswer);
    });
    const times = [100, 142];
    const outcome = await askJev(registry, settings, context, () => times.shift() ?? 0);
    assert.deepEqual(lookups, [["classifier", "openrouter", "typesafe/jev-1.14"]]);
    assert.deepEqual(seen, [{ timeoutMs: 1000, maxRetries: 0 }]);
    assert.equal(outcome.kind, "answer");
    assert.equal(outcome.ms, 42);
  });

  test("reports an unknown model as unavailable without classifying", async () => {
    let calls = 0;
    const { registry } = fake(false, async () => {
      calls++;
      return stopResult(goodAnswer);
    });
    const outcome = await askJev(registry, settings, context, () => 0);
    assert.deepEqual(outcome, { kind: "failure", model: settings.model, failure: "unavailable", ms: 0 });
    assert.equal(calls, 0);
  });

  test("reports an unparsable model ref as unavailable", async () => {
    const { registry, lookups } = fake(true, async () => stopResult(goodAnswer));
    const outcome = await askJev(registry, { ...settings, model: "nonsense" }, context, () => 0);
    assert.equal(outcome.kind === "failure" && outcome.failure, "unavailable");
    assert.equal(lookups.length, 0);
  });

  test("resolves with an error when classify throws", async () => {
    const { registry } = fake(true, async () => {
      throw new Error("boom");
    });
    const outcome = await askJev(registry, settings, context, () => 0);
    assert.equal(outcome.kind === "failure" && outcome.failure, "error");
  });

  test("resolves with an error when the lookup throws", async () => {
    const registry: ClassifierRegistry = {
      findOfType() {
        throw new Error("boom");
      },
      classify: async () => stopResult(goodAnswer),
    };
    const outcome = await askJev(registry, settings, context, () => 0);
    assert.equal(outcome.kind === "failure" && outcome.failure, "error");
  });
});
