// A stuck run (src/stuck.ts): the run's last three tool results all failed, whatever the tool and
// whatever the text, as upstream counts failures below its top tier (John, 2026-11-18). Messages
// are in Pi's shape: a request's `messages`, oldest first; each result names its call by
// `toolCallId`, the `id` of a `toolCall` block in an assistant message before it.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { STUCK_FAILURES, stuck } from "../src/stuck.ts";

const NOW = 1_800_000_000_000;
let calls = 0;

/** Pi's text for a shell command that exits 1 without output (its bash tool's `formatOutput`). */
const SILENT = "(no output)\n\nCommand exited with code 1";

const user = (text = "fix the build"): unknown => ({ role: "user", content: [{ type: "text", text }], timestamp: NOW });

/** What a tool call did: the tool, its arguments, and the result's text (none: no text block). */
interface Outcome {
  readonly tool: string;
  readonly args: unknown;
  readonly text: string | undefined;
  readonly isError: unknown;
}

const MAKE = { command: "make" };
const fail = (tool: string, text: string | undefined, args: unknown = MAKE): Outcome => ({ tool, args, text, isError: true });
const pass = (tool: string, text: string, args: unknown = MAKE): Outcome => ({ tool, args, text, isError: false });

interface Call {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

const call = (outcome: Outcome): Call => ({ type: "toolCall", id: `call-${++calls}`, name: outcome.tool, arguments: outcome.args });

const assistant = (blocks: readonly unknown[]): unknown => ({
  role: "assistant",
  content: blocks,
  api: "openai-codex-responses",
  provider: "openai-codex-2",
  model: "gpt-6.1-terra",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse",
  timestamp: NOW,
});

/** The result of `called`, with the outcome's text as one text block (none when it has no text). */
const resultOf = (called: { readonly id: string }, outcome: Outcome, content: unknown = outcome.text === undefined ? [] : [{ type: "text", text: outcome.text }]): unknown => ({
  role: "toolResult",
  toolCallId: called.id,
  toolName: outcome.tool,
  content,
  isError: outcome.isError,
  timestamp: NOW,
});

/** One assistant message that calls every outcome's tool at once, then their results in order. */
const batch = (...outcomes: Outcome[]): unknown[] => {
  const blocks = outcomes.map(call);
  return [assistant(blocks), ...outcomes.map((outcome, index) => resultOf(blocks[index] as Call, outcome))];
};

/** A user message, then each outcome as an assistant message that calls it and its result. */
const run = (...outcomes: Outcome[]): unknown[] => [user(), ...outcomes.flatMap((outcome) => batch(outcome))];

const rg = (pattern: string): { command: string } => ({ command: `rg -n ${pattern} src` });

describe("stuck", () => {
  test("three failed results in a row are a stuck run", () => {
    assert.equal(STUCK_FAILURES, 3, "three failures, as the design says");
    const messages = run(fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file"));
    assert.equal(stuck(messages), true, "the same call failed three times with the same text");
    const longer = run(pass("read", "ok"), fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file"));
    assert.equal(stuck(longer), true, "only the last three results count: an earlier success does not matter");
  });

  test("three failed results in a row from three different tools with three different texts are a stuck run", () => {
    const messages = run(fail("bash", "No such file", rg("parseRoster")), fail("read", "EACCES: permission denied", { path: "a.ts" }), fail("edit", "No match for the old text", { path: "b.ts" }));
    assert.equal(stuck(messages), true, "John's ruling of 2026-11-18, exactly upstream below its top tier: three failures in a row are stuck whatever the tool and whatever the text");
  });

  test("three different shell commands that each fail without output are a stuck run", () => {
    const messages = run(fail("bash", SILENT, rg("parseRoster")), fail("bash", SILENT, rg("readRoster")), fail("bash", SILENT, rg("loadRoster")));
    assert.equal(stuck(messages), true, "John's ruling of 2026-11-18: three failed results in a row are stuck whatever the calls were");
  });

  test("a successful result among the last three makes no stuck run", () => {
    const cases: ReadonlyArray<readonly [string, unknown[]]> = [
      ["two failures, then a success", run(fail("bash", "No such file"), fail("read", "Permission denied"), pass("bash", "built"))],
      ["a success between two failures", run(fail("bash", "No such file"), pass("bash", "ok"), fail("read", "No such file"))],
      ["a success, then two failures", run(fail("bash", "x"), pass("edit", "ok"), fail("bash", "y"), fail("read", "z"))],
      ["three failures, then a success", run(fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file"), pass("bash", "built"))],
      ["only two", run(fail("bash", "No such file"), fail("read", "Permission denied"))],
      ["none", run()],
      ["no messages", []],
    ];
    for (const [name, messages] of cases) assert.equal(stuck(messages), false, name);
  });

  test("one assistant message's parallel batch of three failed results is a stuck run", () => {
    const different = [user(), ...batch(fail("bash", SILENT, rg("parseRoster")), fail("read", "No such file", { path: "a.ts" }), fail("bash", "Permission denied", rg("loadRoster")))];
    assert.equal(stuck(different), true, "the results of one batch count one by one: three failed results in a row");
    const mixed = [user(), ...batch(fail("bash", SILENT), pass("read", "ok"), fail("bash", SILENT))];
    assert.equal(stuck(mixed), false, "a batch with a success among its three results is not stuck");
  });

  test("results with no text block count as any other failure", () => {
    const messages = run(fail("bash", undefined, rg("x")), fail("bash", undefined, rg("y")), fail("bash", undefined, rg("z")));
    assert.equal(stuck(messages), true, "a failed result is Pi's isError === true, whatever its text");
  });

  test("a user message ends the run under way, an extension's custom message included, which Pi sends as one", () => {
    // What a route request carries: Pi converts a custom message to a user message for the model.
    const custom = { role: "user", content: [{ type: "text", text: "continue toward the goal" }], timestamp: NOW };
    const failure = fail("bash", "No such file");
    const messages = [user(), ...batch(failure), ...batch(failure), ...batch(failure), custom, ...batch(failure)];
    assert.equal(stuck(messages), false, "the previous run's three failures do not count toward the next run's");
  });

  test("only the run under way counts: failures before the latest user message do not", () => {
    const failure = fail("bash", "No such file");
    const messages = [user(), ...batch(failure), ...batch(failure), user("go on"), ...batch(fail("read", "Permission denied"))];
    assert.equal(stuck(messages), false, "two failures, a user message, one failure");
    const after = [...messages, ...batch(fail("edit", "No match")), ...batch(failure)];
    assert.equal(stuck(after), true, "three failures after the latest user message");
  });

  test("anything that is not a message is passed over, and nothing malformed throws or makes a stuck run", () => {
    const failure = fail("bash", "No such file");
    const odd = [user(), ...batch(failure), undefined, 7, {}, null, "text", [], ...batch(failure), { role: "toolResult" }, ...batch(failure)];
    assert.doesNotThrow(() => stuck(odd), "undefined, 7, {} and the like do not throw");
    assert.equal(stuck(odd), false, "a tool result without isError among the last three is not a failed result");
    const between = [user(), ...batch(failure), undefined, ...batch(failure), 7, {}, ...batch(failure), null, "text", []];
    assert.equal(stuck(between), true, "undefined, 7, {} and the like between three failures are passed over");
    const malformed: ReadonlyArray<readonly [string, Outcome, unknown]> = [
      ["content not an array", failure, "No such file"],
      ["blocks that are not text", failure, [null, 7, { type: "text" }, { type: "text", text: 7 }]],
      ["a tool name that is not a string", { ...failure, tool: 7 as unknown as string }, [{ type: "text", text: "No such file" }]],
      ["isError not true itself", { ...failure, isError: "yes" }, [{ type: "text", text: "No such file" }]],
    ];
    const thrice = (outcome: Outcome, content: unknown): unknown[] => [
      user(),
      ...[1, 2, 3].flatMap(() => {
        const called = call(outcome);
        return [assistant([called]), resultOf(called, outcome, content)];
      }),
    ];
    for (const [name, outcome, content] of malformed) assert.doesNotThrow(() => stuck(thrice(outcome, content)), name);
    assert.equal(stuck(thrice(malformed[0]![1], malformed[0]![2])), true, "a failed result's content is not read: isError alone decides");
    assert.equal(stuck(thrice(malformed[3]![1], malformed[3]![2])), false, "isError must be true itself");
    assert.equal(stuck(thrice(malformed[2]![1], malformed[2]![2])), false, "a result without a tool name is no failure of a tool");
    const hostile = (field: string): unknown[] => [
      user(),
      ...[1, 2, 3].flatMap(() => {
        const called = call(failure);
        const result = { ...(resultOf(called, failure) as Record<string, unknown>) };
        delete result[field];
        return [
          assistant([called]),
          Object.defineProperty(result, field, {
            get() {
              throw new Error("boom");
            },
          }),
        ];
      }),
    ];
    for (const field of ["role", "isError", "toolName"]) assert.equal(stuck(hostile(field)), false, `a result whose ${field} throws is no stuck run, and does not throw`);
    const hostileMessages = new Proxy([user(), ...batch(failure), ...batch(failure), ...batch(failure)], {
      get(target, key, receiver) {
        if (key === "length") throw new Error("boom");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    assert.equal(stuck(hostileMessages), false, "messages whose length throws are no stuck run, and do not throw");
  });
});
