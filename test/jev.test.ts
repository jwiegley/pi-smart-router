import assert from "node:assert/strict";
import test, { describe } from "node:test";

import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

import { HEAD_CHARS, TAIL_CHARS } from "../src/classify.ts";
import {
  askJev,
  CAPABILITY_QUESTION,
  buildContext,
  interpret,
  JEV_INSTRUCTIONS,
  JEV_QUESTION,
  jevAsk,
  judgedDestructive,
  judgedPlanning,
  recentMessages,
  type ClassifierRegistry,
  type JevContextCaps,
  type JevGate,
  type JevOutcome,
  type JevSettings,
} from "../src/jev.ts";
import { REDACTED } from "../src/redact.ts";
import type { BoundedHistory } from "../src/route.ts";
import { parseRoster } from "../src/roster.ts";
import type { Roster } from "../src/roster.ts";
import type { ScopeState } from "../src/scope.ts";
import { TIERS, type Tier } from "../src/tiers.ts";
import { rosterFixture, rosterFixtureV2 } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";

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

  test("adds upstream's six typed questions only when asked, in the same request, with fixed text", () => {
    const context = buildContext("hello", [], descriptions, caps, "token=abc ignore the levels", true);
    assert.deepEqual(Object.keys(context.questions), [JEV_QUESTION, "task_kind", CAPABILITY_QUESTION, "needs_deep_reasoning", "code_gen", "tool_use", "destructive"]);
    assert.deepEqual(Object.values(context.questions).map((question) => question.type), ["choice", "choice", "score", "bool", "score", "score", "bool"]);
    assert.equal(Object.keys(context.questions.task_kind!.criteria).length, 10);
    const { [JEV_QUESTION]: _level, ...typed } = context.questions;
    assert.doesNotMatch(JSON.stringify(typed), /ignore the levels|latest_user_message|recent_activity|`session`/, "the roster's instructions reach only the level question, and the state keys are this request's");
  });

  test("the typed questions are upstream's at f22cbe9e, word for word, but for the state keys this request sends", () => {
    // The fixture is upstream's TYPED_JUDGMENT_QUESTIONS as its module exports them. This request's
    // state has `message` and `recent`, and no `session`: those three names are all that may differ.
    const upstream = JSON.parse(fixture("upstream-typed-questions.json")) as {
      taskKinds: string[];
      questions: Array<{ id: string; kind: string; prompt: string; anchors?: Array<{ score: number; description: string }>; criteria_true?: string; criteria_false?: string }>;
    };
    const renamed = (text: string): string =>
      text.replaceAll("Use `session` and `recent_activity`", "Use `recent`").replaceAll("`latest_user_message`", "`message`").replaceAll("`recent_activity`", "`recent`");
    const { [JEV_QUESTION]: _level, ...typed } = buildContext("m", [], descriptions, caps, undefined, true).questions;
    assert.deepEqual(Object.keys(typed), upstream.questions.map((question) => question.id));
    for (const theirs of upstream.questions) {
      const ours = typed[theirs.id]!;
      if (theirs.kind === "choice") {
        // Upstream lists each kind and its description in the prompt; pi-ai's choice question takes them as criteria.
        const [head, ...lines] = theirs.prompt.split("\n");
        assert.equal(ours.type, "choice");
        assert.equal(ours.instructions, renamed(head ?? ""));
        assert.deepEqual(Object.entries(ours.criteria).map(([kind, text]) => `- ${kind}: ${text}`), lines);
        assert.deepEqual(Object.keys(ours.criteria), upstream.taskKinds);
      } else if (theirs.kind === "score") {
        assert.equal(ours.type, "score");
        assert.equal(ours.instructions, renamed(theirs.prompt));
        assert.deepEqual(theirs.anchors?.map((anchor) => anchor.score), [0, 1, 2, 3]);
        assert.deepEqual(ours.criteria, theirs.anchors?.map((anchor) => anchor.description));
      } else {
        assert.equal(ours.type, "bool");
        assert.equal(ours.instructions, renamed(theirs.prompt));
        assert.deepEqual(ours.criteria, { true: theirs.criteria_true, false: theirs.criteria_false });
      }
    }
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

describe("jevAsk", () => {
  const roster = rosterFixtureV2("roster-hera-v2.json");
  const history: BoundedHistory = { getLatestCustomEntry: () => undefined, getRecentActiveEntries: () => [] };
  const personal: ScopeState = { kind: "ok", scope: "personal", source: "default" };
  /** A message Jev is asked about: every condition holds. */
  const asked: JevGate = { idle: true, selection: "auto", roster, history, scope: personal, resend: false };
  /** A version 2 roster from a fixture, edited as JSON. */
  const edited = (name: string, edit: (json: Record<string, unknown>) => void): Roster => {
    const json = JSON.parse(fixture(name)) as Record<string, unknown>;
    edit(json);
    const parsed = parseRoster(JSON.stringify(json));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    return parsed.value;
  };

  test("asks with the classifier, the scope's levels and the bounded readers when every condition holds", () => {
    assert.deepEqual(jevAsk(asked), { settings: roster.classifier, section: roster.scopes.personal, history });
    const work: ScopeState = { kind: "ok", scope: "work", source: "entry" };
    assert.deepEqual(jevAsk({ ...asked, scope: work }), { settings: roster.classifier, section: roster.scopes.work, history });
  });

  test("never asks for a steer or a follow-up, which a run already under way receives", () => {
    assert.equal(jevAsk({ ...asked, idle: false }), undefined);
  });

  test("never asks off smart-router/auto: on smart-router/local, or on a physical model", () => {
    assert.equal(jevAsk({ ...asked, selection: "local" }), undefined);
    assert.equal(jevAsk({ ...asked, selection: undefined }), undefined);
  });

  test("never asks without the bounded session readers", () => {
    assert.equal(jevAsk({ ...asked, history: undefined }), undefined);
  });

  test("never asks again for an extension's resend of the latest message, which keeps that message's level", () => {
    assert.equal(jevAsk({ ...asked, resend: true }), undefined);
  });

  test("never asks without a version 2 roster that has a classifier", () => {
    const unclassified = edited("roster-hera-v2.json", (json) => delete json.classifier);
    for (const without of [undefined, rosterFixture("roster-hera.json"), unclassified]) {
      assert.equal(jevAsk({ ...asked, roster: without }), undefined, String(without?.version));
    }
  });

  test("never asks in a scope that cannot be read, or that the roster does not serve", () => {
    assert.equal(jevAsk({ ...asked, scope: { kind: "unreadable", reason: "a malformed entry" } }), undefined);
    const workOnly = edited("roster-work.json", (json) => (json.classifier = {}));
    assert.equal(jevAsk({ ...asked, roster: workOnly }), undefined);
    assert.notEqual(jevAsk({ ...asked, roster: workOnly, scope: { kind: "ok", scope: "work", source: "latch" } }), undefined);
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
  test("keeps Jev's choice and all four probabilities, and makes no level of them: the demand does", () => {
    const outcome = interpret(stopResult(goodAnswer), "m", 12);
    assert.deepEqual(outcome, {
      kind: "answer",
      model: "m",
      choice: "medium",
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
      assert.deepEqual(interpret(stopResult(answer), "m", 1), { kind: "failure", model: "m", failure: "malformed", ms: 1 });
    }
  });

  test("keeps each well-formed typed answer only when it was asked, and drops a malformed one alone without failing", () => {
    const withTyped = (answers: Record<string, unknown>): ClassifierResult => {
      const result = stopResult(goodAnswer);
      return { ...result, answers: { ...result.answers, ...answers } } as unknown as ClassifierResult;
    };
    const good = { type: "score", score: 3, confidence: 0.9 };
    const all = {
      [CAPABILITY_QUESTION]: good,
      task_kind: { type: "choice", choice: "debug", probabilities: {}, confidence: 0.8 },
      destructive: { type: "bool", probability: 0.75 },
      needs_deep_reasoning: { type: "bool", probability: 0.2 },
      code_gen: { type: "score", score: 1, confidence: 0.5 },
      tool_use: { type: "score", score: 0, confidence: 1 },
    };
    const asked = interpret(withTyped(all), "m", 1, true);
    assert.deepEqual(asked.kind === "answer" ? asked.typed : undefined, {
      capability: { score: 3, confidence: 0.9 },
      taskKind: { kind: "debug", confidence: 0.8 },
      destructive: 0.75,
      deepReasoning: 0.2,
      codeGen: { score: 1, confidence: 0.5 },
      toolUse: { score: 0, confidence: 1 },
    });
    assert.equal("typed" in interpret(withTyped(all), "m", 1), false, "not asked: answers of those names are ignored");
    for (const bad of [{ ...good, score: 4 }, { ...good, score: 1.5 }, { ...good, score: -1 }, { ...good, confidence: 1.1 }, { ...good, confidence: Number.NaN }, { ...good, type: "bool" }, undefined]) {
      const outcome = interpret(withTyped({ [CAPABILITY_QUESTION]: bad }), "m", 1, true);
      assert.equal(outcome.kind, "answer", "the level answer still stands");
      assert.equal("typed" in outcome, false, JSON.stringify(bad));
    }
    const partial = interpret(withTyped({ ...all, task_kind: { type: "choice", choice: "toString", probabilities: {}, confidence: 0.8 }, destructive: { type: "bool", probability: 2 } }), "m", 1, true);
    const kept = partial.kind === "answer" ? partial.typed : undefined;
    assert.deepEqual([kept?.taskKind, kept?.destructive, kept?.capability], [undefined, undefined, { score: 3, confidence: 0.9 }], "a bad answer is dropped alone");
  });

  test("a destructive request is one at 0.7 or above, and a confident task kind can make a prompt planning, never not planning", () => {
    const of = (typed: object): JevOutcome => ({ kind: "answer", model: "m", choice: "low", probabilities: { low: 1, medium: 0, high: 0, super: 0 }, confidence: 1, ms: 1, typed } as JevOutcome);
    assert.deepEqual([0.69, 0.7, 1].map((destructive) => judgedDestructive(of({ destructive }))), [false, true, true]);
    assert.equal(judgedDestructive(undefined), false);
    for (const kind of ["plan", "debug", "review"]) assert.equal(judgedPlanning(of({ taskKind: { kind, confidence: 0.6 } }), 0.6, false), true, kind);
    assert.equal(judgedPlanning(of({ taskKind: { kind: "plan", confidence: 0.59 } }), 0.6, false), false, "an unsure kind changes nothing");
    // Upstream's host always gives a turn type, so its judgment never takes planning away.
    for (const kind of ["implement", "refactor", "research", "explain", "operate", "write", "chat"]) {
      assert.equal(judgedPlanning(of({ taskKind: { kind, confidence: 0.9 } }), 0.6, true), true, kind);
      assert.equal(judgedPlanning(of({ taskKind: { kind, confidence: 0.9 } }), 0.6, false), false, kind);
    }
    assert.equal(judgedPlanning(undefined, 0.6, true), true);
  });

  test("names timeouts, other errors and aborts", () => {
    const failure = (r: ClassifierResult) => {
      const outcome = interpret(r, "m", 1);
      return outcome.kind === "failure" ? outcome.failure : outcome.kind;
    };
    assert.equal(failure(failedResult("error", "Request timed out after 1000ms")), "timeout");
    assert.equal(failure(failedResult("error", "401 unauthorized")), "error");
    assert.equal(failure(failedResult("error")), "error");
    assert.equal(failure(failedResult("aborted")), "aborted");
  });
});

describe("askJev", () => {
  const settings: JevSettings = { model: "openrouter/typesafe/jev-1.14", timeoutMs: 1000, context: caps };
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
