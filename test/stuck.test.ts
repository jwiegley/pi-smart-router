// A stuck run (src/stuck.ts): the run's last three tool results all failed, from the same call
// (one tool, one set of arguments) with one text. Messages are in Pi's shape: a request's
// `messages`, oldest first; each result names its call by `toolCallId`, the `id` of a `toolCall`
// block in an assistant message before it.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { STUCK_CHARS, STUCK_FAILURES, stuck } from "../src/stuck.ts";

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
  test("three failed results in a row from one call with one text are a stuck run", () => {
    assert.equal(STUCK_FAILURES, 3, "three failures, as the design says");
    assert.equal(STUCK_CHARS, 256, "compared on their first 256 characters, as upstream does");
    const messages = run(fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file"));
    assert.equal(stuck(messages), true, "the same call failed three times with the same text");
    const longer = run(pass("read", "ok"), fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file"));
    assert.equal(stuck(longer), true, "only the last three results count: an earlier success does not matter");
  });

  test("three failures that differ are ordinary work", () => {
    const cases: ReadonlyArray<readonly [string, unknown[]]> = [
      ["different texts", run(fail("bash", "No such file"), fail("bash", "Permission denied"), fail("bash", "No such file"))],
      ["different tools", run(fail("bash", "No such file"), fail("read", "No such file"), fail("bash", "No such file"))],
      ["one success among them", run(fail("bash", "No such file"), pass("bash", "No such file"), fail("bash", "No such file"))],
      ["the latest a success", run(fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file"), pass("bash", "built"))],
      ["only two", run(fail("bash", "No such file"), fail("bash", "No such file"))],
      ["none", run()],
      ["no messages", []],
    ];
    for (const [name, messages] of cases) assert.equal(stuck(messages), false, name);
  });

  test("three different shell commands that each fail without output are ordinary work, though Pi gives them one text", () => {
    const messages = run(fail("bash", SILENT, rg("parseRoster")), fail("bash", SILENT, rg("readRoster")), fail("bash", SILENT, rg("loadRoster")));
    assert.equal(stuck(messages), false, "three searches that find nothing are three different calls: the calls must be the same, not only their results");
  });

  test("the same shell command three times with Pi's silent-failure text is a stuck run", () => {
    const messages = run(fail("bash", SILENT, rg("parseRoster")), fail("bash", SILENT, rg("parseRoster")), fail("bash", SILENT, rg("parseRoster")));
    assert.equal(stuck(messages), true, "one call, failed three times the same way");
  });

  test("arguments are compared whatever the order of their keys, at every depth", () => {
    const one = { command: "make test", env: { CI: "1", LANG: "C" }, timeout: 60 };
    const two = { timeout: 60, env: { LANG: "C", CI: "1" }, command: "make test" };
    const three = { env: { CI: "1", LANG: "C" }, timeout: 60, command: "make test" };
    assert.equal(stuck(run(fail("bash", SILENT, one), fail("bash", SILENT, two), fail("bash", SILENT, three))), true, "the same arguments with their keys in another order are the same call");
    const nested = (order: boolean): unknown => ({ edits: [order ? { old: "a", new: "b" } : { new: "b", old: "a" }], path: "x.ts" });
    assert.equal(stuck(run(fail("edit", "No match", nested(true)), fail("edit", "No match", nested(false)), fail("edit", "No match", nested(true)))), true, "keys inside an array's objects are sorted too");
    const listed = (items: string[]): unknown => ({ paths: items });
    assert.equal(stuck(run(fail("read", "No such file", listed(["a", "b"])), fail("read", "No such file", listed(["b", "a"])), fail("read", "No such file", listed(["a", "b"])))), false, "an array's order is part of the arguments");
    assert.equal(stuck(run(fail("bash", SILENT, { command: "make", timeout: 1 }), fail("bash", SILENT, { command: "make", timeout: "1" }), fail("bash", SILENT, { command: "make", timeout: 1 }))), false, "1 and \"1\" are different arguments");
  });

  test("arguments that cannot be put in a canonical form make no stuck run", () => {
    const cyclic: Record<string, unknown> = { command: "make" };
    cyclic.self = cyclic;
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["a cycle", cyclic],
      ["a function", { command: "make", run: () => undefined }],
      ["an undefined value", { command: "make", timeout: undefined }],
      ["a big integer", { command: "make", timeout: 10n }],
      ["a number that is not finite", { command: "make", timeout: Number.POSITIVE_INFINITY }],
      ["no arguments", undefined],
    ];
    for (const [name, args] of cases) {
      const outcome: Outcome = { ...fail("bash", SILENT), args };
      const messages = run(outcome, outcome, outcome);
      assert.doesNotThrow(() => stuck(messages), name);
      assert.equal(stuck(messages), false, `${name}: arguments that cannot be put in a canonical form make no stuck run`);
    }
  });

  test("one assistant message's parallel batch: different commands are ordinary work, the same command three times is stuck", () => {
    const different = [user(), ...batch(fail("bash", SILENT, rg("parseRoster")), fail("bash", SILENT, rg("readRoster")), fail("bash", SILENT, rg("loadRoster")))];
    assert.equal(stuck(different), false, "three different parallel calls that failed without output");
    const same = [user(), ...batch(fail("bash", SILENT, rg("parseRoster")), fail("bash", SILENT, rg("parseRoster")), fail("bash", SILENT, rg("parseRoster")))];
    assert.equal(stuck(same), true, "three parallel calls of one command that failed the same way");
  });

  test("a failed result whose call cannot be found makes no stuck run", () => {
    const outcome = fail("bash", "No such file");
    const orphan = resultOf({ id: "call-nowhere" }, outcome);
    const unmatched = [user(), ...batch(outcome), ...batch(outcome), assistant([call(outcome)]), orphan];
    assert.equal(stuck(unmatched), false, "a toolCallId that matches no call: a failed result whose call cannot be found counts for nothing");
    const noId = { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "No such file" }], isError: true, timestamp: NOW };
    assert.equal(stuck([user(), ...batch(outcome), ...batch(outcome), assistant([call(outcome)]), noId]), false, "a failed result with no toolCallId counts for nothing");
    const earlier = call(outcome);
    const beforeUser = [assistant([earlier]), user(), ...batch(outcome), ...batch(outcome), resultOf(earlier, outcome)];
    assert.equal(stuck(beforeUser), false, "a call before the latest user message is not the run's: its result counts for nothing");
    const after = (() => {
      const later = call(outcome);
      return [user(), ...batch(outcome), ...batch(outcome), resultOf(later, outcome), assistant([later])];
    })();
    assert.equal(stuck(after), false, "a call is found only in an assistant message before its result");
  });

  test("a call that cannot be told apart by its id is a call that cannot be found", () => {
    const commands = [rg("parseRoster"), rg("readRoster"), rg("loadRoster")];
    /** One assistant message calling the three commands with these ids, then a failed result for each. */
    const batchWithIds = (ids: readonly string[]): unknown[] => [
      user(),
      assistant(commands.map((args, index) => ({ type: "toolCall", id: ids[index], name: "bash", arguments: args }))),
      ...ids.map((id) => resultOf({ id }, fail("bash", SILENT))),
    ];
    assert.equal(stuck(batchWithIds(["", "", ""])), false, "ids that are all empty, as Pi's openai-completions gives when the server sends none: the calls cannot be told apart, so they cannot be found and the run is not stuck");
    assert.equal(stuck(batchWithIds(["call_0", "call_0", "call_0"])), false, "one id shared by the calls of a batch: the calls cannot be told apart, so they cannot be found and the run is not stuck");
    const repeated = [
      user(),
      ...[1, 2, 3].flatMap(() => [assistant([{ type: "toolCall", id: "call_0", name: "bash", arguments: rg("parseRoster") }]), resultOf({ id: "call_0" }, fail("bash", SILENT))]),
    ];
    assert.equal(stuck(repeated), true, "an id repeated across messages is found in the nearest message, which holds the right call: the same command failed three times");
  });

  test("results with no text block compare as the empty text, so the calls decide", () => {
    const same = run(fail("bash", undefined, rg("x")), fail("bash", undefined, rg("x")), fail("bash", undefined, rg("x")));
    assert.equal(stuck(same), true, "three identical calls whose results have no text block failed identically");
    const different = run(fail("bash", undefined, rg("x")), fail("bash", undefined, rg("y")), fail("bash", undefined, rg("z")));
    assert.equal(stuck(different), false, "three different calls whose results have no text block are ordinary work");
  });

  test("only the first 256 characters of the text are compared", () => {
    const head = "x".repeat(STUCK_CHARS);
    const same = run(fail("bash", `${head}a`), fail("bash", `${head}b`), fail("bash", `${head}c`));
    assert.equal(stuck(same), true, "texts equal up to 256 characters and different after are one text");
    const at200 = (letter: string): string => `${"x".repeat(200)}${letter}${"x".repeat(100)}`;
    const differ = run(fail("bash", at200("a")), fail("bash", at200("b")), fail("bash", at200("a")));
    assert.equal(stuck(differ), false, "texts that differ at character 200 are two texts");
    // Each result here gets its call; before the calls were compared these results had none, and a
    // failed result whose call cannot be found now counts for nothing.
    const outcome = fail("bash", undefined);
    const blocks = (...texts: string[]): unknown[] => {
      const called = call(outcome);
      return [assistant([called]), resultOf(called, outcome, texts.map((text) => ({ type: "text", text })))];
    };
    const joined = [user(), ...blocks("No such", "file"), ...blocks("No such\nfile"), ...blocks("No such", "file")];
    assert.equal(stuck(joined), true, "a result's text blocks are joined with a newline before they are compared (each result with its call: one whose call cannot be found counts for nothing)");
    const image = (): unknown[] => {
      const called = call(outcome);
      return [assistant([called]), resultOf(called, outcome, [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "No such file" }])];
    };
    assert.equal(stuck([user(), ...image(), ...batch(fail("bash", "No such file")), ...image()]), true, "a block that is not text is passed over (each result with its call: one whose call cannot be found counts for nothing)");
  });

  test("a user message ends the run under way, an extension's custom message included, which Pi sends as one", () => {
    // What a route request carries: Pi converts a custom message to a user message for the model.
    const custom = { role: "user", content: [{ type: "text", text: "continue toward the goal" }], timestamp: NOW };
    const failure = fail("bash", "No such file");
    const messages = [user(), ...batch(failure), ...batch(failure), ...batch(failure), custom, ...batch(failure)];
    assert.equal(stuck(messages), false, "the previous run's three failures do not count toward the next run's");
  });

  test("only the run under way counts: results before the latest user message do not", () => {
    const failure = fail("bash", "No such file");
    const messages = [user(), ...batch(failure), ...batch(failure), user("go on"), ...batch(failure)];
    assert.equal(stuck(messages), false, "two failures, a user message, one failure");
    const after = [...messages, ...batch(failure), ...batch(failure)];
    assert.equal(stuck(after), true, "three failures after the latest user message");
  });

  test("anything that is not a message is passed over, and nothing malformed throws", () => {
    const failure = fail("bash", "No such file");
    const odd = [user(), ...batch(failure), undefined, 7, {}, null, "text", [], ...batch(failure), { role: "toolResult" }, ...batch(failure)];
    assert.doesNotThrow(() => stuck(odd), "undefined, 7, {} and the like do not throw");
    const between = [user(), ...batch(failure), undefined, ...batch(failure), 7, {}, ...batch(failure), null, "text", []];
    assert.equal(stuck(between), true, "undefined, 7, {} and the like between three identical failures are passed over");
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
    assert.equal(stuck(thrice(malformed[3]![1], malformed[3]![2])), false, "isError must be true itself");
    assert.equal(stuck(thrice(malformed[2]![1], malformed[2]![2])), false, "a result without a tool name is no failure of a tool");
    const hostileResult = (called: Call): unknown =>
      Object.defineProperty({ role: "toolResult", toolCallId: called.id, toolName: "bash", isError: true }, "content", {
        get() {
          throw new Error("boom");
        },
      });
    const hostile = [user(), ...[1, 2, 3].flatMap(() => {
      const called = call(failure);
      return [assistant([called]), hostileResult(called)];
    })];
    assert.equal(stuck(hostile), false, "a result whose fields throw is no stuck run, and does not throw");
    const hostileCall = (): unknown[] => {
      const id = `call-${++calls}`;
      const block = Object.defineProperty({ type: "toolCall", id, name: "bash" }, "arguments", {
        get() {
          throw new Error("boom");
        },
      });
      return [assistant([block]), resultOf({ id }, failure)];
    };
    assert.equal(stuck([user(), ...hostileCall(), ...hostileCall(), ...hostileCall()]), false, "a call whose fields throw is no stuck run, and does not throw");
  });
});
