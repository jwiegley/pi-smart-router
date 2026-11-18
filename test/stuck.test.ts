// A stuck run (src/stuck.ts): the run's last three tool results all failed, with one tool and one
// text. Messages are in Pi's shape: a request's `messages`, oldest first.
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { STUCK_CHARS, STUCK_FAILURES, stuck } from "../src/stuck.ts";

const NOW = 1_800_000_000_000;
let calls = 0;

const user = (text = "fix the build"): unknown => ({ role: "user", content: [{ type: "text", text }], timestamp: NOW });

/** An assistant message that calls `count` tools. */
const calling = (count = 1): unknown => ({
  role: "assistant",
  content: Array.from({ length: count }, () => ({ type: "toolCall", id: `call-${++calls}`, name: "bash", arguments: {} })),
  api: "openai-codex-responses",
  provider: "openai-codex-2",
  model: "gpt-6.1-terra",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse",
  timestamp: NOW,
});

const result = (toolName: string, text: string, isError: boolean): unknown => ({
  role: "toolResult",
  toolCallId: `call-${calls}`,
  toolName,
  content: [{ type: "text", text }],
  isError,
  timestamp: NOW,
});
const fail = (toolName: string, text: string): unknown => result(toolName, text, true);
const pass = (toolName: string, text: string): unknown => result(toolName, text, false);

/** A user message, then each result after an assistant message that called it. */
const run = (...results: unknown[]): unknown[] => [user(), ...results.flatMap((entry) => [calling(), entry])];

describe("stuck", () => {
  test("three failed results in a row with one tool and one text are a stuck run", () => {
    assert.equal(STUCK_FAILURES, 3, "three failures, as the design says");
    assert.equal(STUCK_CHARS, 256, "compared on their first 256 characters, as upstream does");
    const messages = run(fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file"));
    assert.equal(stuck(messages), true, "the same tool failed three times with the same text");
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

  test("only the first 256 characters of the text are compared", () => {
    const head = "x".repeat(STUCK_CHARS);
    const same = run(fail("bash", `${head}a`), fail("bash", `${head}b`), fail("bash", `${head}c`));
    assert.equal(stuck(same), true, "texts equal up to 256 characters and different after are one text");
    const at200 = (letter: string): string => `${"x".repeat(200)}${letter}${"x".repeat(100)}`;
    const differ = run(fail("bash", at200("a")), fail("bash", at200("b")), fail("bash", at200("a")));
    assert.equal(stuck(differ), false, "texts that differ at character 200 are two texts");
    const blocks = (...texts: string[]): unknown => ({ role: "toolResult", toolCallId: "c", toolName: "bash", content: texts.map((text) => ({ type: "text", text })), isError: true, timestamp: NOW });
    const joined = [user(), calling(), blocks("No such", "file"), calling(), blocks("No such\nfile"), calling(), blocks("No such", "file")];
    assert.equal(stuck(joined), true, "a result's text blocks are joined with a newline before they are compared");
    const image = { role: "toolResult", toolCallId: "c", toolName: "bash", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "No such file" }], isError: true, timestamp: NOW };
    assert.equal(stuck([user(), calling(), image, calling(), fail("bash", "No such file"), calling(), image]), true, "a block that is not text is passed over");
  });

  test("a user message ends the run under way, an extension's custom message included, which Pi sends as one", () => {
    // What a route request carries: Pi converts a custom message to a user message for the model.
    const custom = { role: "user", content: [{ type: "text", text: "continue toward the goal" }], timestamp: NOW };
    const messages = [user(), calling(), fail("bash", "No such file"), calling(), fail("bash", "No such file"), calling(), fail("bash", "No such file"), custom, calling(), fail("bash", "No such file")];
    assert.equal(stuck(messages), false, "the previous run's three failures do not count toward the next run's");
  });

  test("only the run under way counts: results before the latest user message do not", () => {
    const messages = [user(), calling(), fail("bash", "No such file"), calling(), fail("bash", "No such file"), user("go on"), calling(), fail("bash", "No such file")];
    assert.equal(stuck(messages), false, "two failures, a user message, one failure");
    const after = [...messages, calling(), fail("bash", "No such file"), calling(), fail("bash", "No such file")];
    assert.equal(stuck(after), true, "three failures after the latest user message");
  });

  test("results of one assistant message count one by one, and anything that is not a message is passed over", () => {
    const parallel = [user(), calling(3), fail("bash", "No such file"), fail("bash", "No such file"), fail("bash", "No such file")];
    assert.equal(stuck(parallel), true, "three parallel calls that failed the same way");
    const odd = [user(), calling(), fail("bash", "No such file"), undefined, 7, {}, null, "text", [], calling(), fail("bash", "No such file"), { role: "toolResult" }, calling(), fail("bash", "No such file")];
    assert.doesNotThrow(() => stuck(odd), "undefined, 7, {} and the like do not throw");
    const between = [user(), calling(), fail("bash", "No such file"), undefined, calling(), fail("bash", "No such file"), 7, {}, calling(), fail("bash", "No such file"), null, "text", []];
    assert.equal(stuck(between), true, "undefined, 7, {} and the like between three identical failures are passed over");
    const malformed: unknown[] = [
      { role: "toolResult", toolName: "bash", content: "No such file", isError: true },
      { role: "toolResult", toolName: "bash", content: [null, 7, { type: "text" }, { type: "text", text: 7 }], isError: true },
      { role: "toolResult", toolName: 7, content: [{ type: "text", text: "No such file" }], isError: true },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "No such file" }], isError: "yes" },
    ];
    for (const entry of malformed) {
      const messages = [user(), calling(), entry, calling(), entry, calling(), entry];
      assert.doesNotThrow(() => stuck(messages), JSON.stringify(entry));
    }
    assert.equal(stuck([user(), calling(), malformed[3], calling(), malformed[3], calling(), malformed[3]]), false, "isError must be true itself");
    assert.equal(stuck([user(), calling(), malformed[2], calling(), malformed[2], calling(), malformed[2]]), false, "a result without a tool name is no failure of a tool");
    const hostile = Object.defineProperty({ role: "toolResult", toolName: "bash", isError: true }, "content", {
      get() {
        throw new Error("boom");
      },
    });
    assert.equal(stuck([hostile, hostile, hostile]), false, "a message whose fields throw is no stuck run, and does not throw");
  });
});
