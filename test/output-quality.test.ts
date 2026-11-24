import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { isDegenerateOutput } from "../src/output-quality.ts";
import { ASTRA, KIMI, NOW } from "./support/catalog.ts";
import { agentDir, assistant, load, request, resetSlot, routed, start } from "./support/pi.ts";

const repeated = Array.from({ length: 160 }, (_, index) => `sleep ${300 + index}; echo "${index}-END";`).join("\n");
const unique = Array.from({ length: 800 }, (_, index) => `analysis-${index.toString(36)}-continuation`).join(" ");
const response = (text: string, stopReason = "length") => ({ stopReason, content: [{ type: "text", text }] });

beforeEach(resetSlot);
afterEach(resetSlot);

describe("upstream v1.5.0 degenerate output", () => {
  test("requires a length stop, repetition and no tool call", () => {
    assert.equal(isDegenerateOutput(response(repeated)), true);
    assert.equal(isDegenerateOutput(response(repeated, "stop")), false);
    assert.equal(isDegenerateOutput(response(repeated, "error")), false);
    assert.equal(isDegenerateOutput(response(unique)), false);
    assert.equal(isDegenerateOutput({ stopReason: "length", content: [{ type: "text", text: repeated }, { type: "toolCall" }] }), false);
    assert.equal(isDegenerateOutput(response("same ".repeat(27))), false);
    assert.equal(isDegenerateOutput(response("same ".repeat(28))), true);
  });

  test("uses only the trailing 8192 characters and joins text blocks as upstream does", () => {
    assert.equal(isDegenerateOutput(response(`${unique.repeat(4)}\n${repeated}`)), true);
    assert.equal(isDegenerateOutput(response(`${repeated}\n${unique.repeat(4)}`)), false);
    const split = Math.floor(repeated.length / 2);
    assert.equal(isDegenerateOutput({ stopReason: "length", content: [{ type: "text", text: repeated.slice(0, split) }, { type: "thinking", thinking: "ignored" }, { type: "text", text: repeated.slice(split) }] }), true);
    for (const value of [undefined, null, {}, { stopReason: "length", content: null }, { stopReason: "length", content: [null, { type: "text", text: 12 }] }]) {
      assert.equal(isDegenerateOutput(value), false);
    }
  });

  test("matches upstream's window calculation across text-block boundaries", () => {
    const upstream = (blocks: string[]): boolean => {
      const tokens = (blocks.join("\n").slice(-8192).match(/\S+/gu) ?? []).map((token) => token.replace(/\d+(?:\.\d+)?/g, "#"));
      const windows = Math.max(0, tokens.length - 4);
      const grams = new Set(Array.from({ length: windows }, (_, i) => tokens.slice(i, i + 5).join("\u0000")));
      return windows >= 24 && 1 - grams.size / windows >= 0.65;
    };
    for (const text of [repeated, unique, repeated + unique, unique + repeated, "same ".repeat(28), "same ".repeat(27), ""]) {
      for (const split of [0, 1, 10, Math.floor(text.length / 2), text.length]) {
        const blocks = [text.slice(0, split), text.slice(split)];
        assert.equal(isDegenerateOutput({ stopReason: "length", content: blocks.map((part) => ({ type: "text", text: part })) }), upstream(blocks));
      }
    }
  });
});

describe("degenerate responses in the router", () => {
  test("are not recorded as an answer or cached usage, and a routed run is warned", async (t) => {
    const loaded = await start({ dir: agentDir(t), now: () => NOW });
    await loaded.host.emit("message_end", { message: assistant(KIMI) });
    const record = loaded.router!.record(loaded.session.id)!;
    const before = { last: record.last, seen: [...record.ledger.seen], run: record.ledger.run };
    await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
    const signal = loaded.session.startRun();
    assert.equal(routed(loaded.runtime.route("auto", request("user", { signal }))), ASTRA);
    const message = assistant(ASTRA, { stopReason: "length", content: [{ type: "text", text: repeated }] });
    await loaded.host.emit("message_end", { message });
    assert.deepEqual(record.last, before.last);
    assert.deepEqual([...record.ledger.seen], before.seen);
    assert.equal(record.ledger.run, before.run);
    assert.equal(record.answered, KIMI, "the earlier answer is not overwritten");
    assert.match(loaded.session.notices.at(-1)?.message ?? "", /truncated repetitive output detected/);
    assert.equal(message.stopReason, "length", "the router does not rewrite Pi's response");
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("a resumed session does not seed its last answer or cache from a degenerate response", async (t) => {
    const loaded = load({ dir: agentDir(t), now: () => NOW });
    loaded.session.appendAssistant(assistant(KIMI, { timestamp: NOW - 1000 }));
    loaded.session.appendAssistant(assistant(ASTRA, { stopReason: "length", content: [{ type: "text", text: repeated }], timestamp: NOW }));
    loaded.session.select("auto");
    await loaded.host.emit("session_start", { reason: "resume" });
    const record = loaded.router!.record(loaded.session.id)!;
    assert.equal(record.last?.ref, KIMI);
    assert.equal(record.ledger.seen.has(ASTRA), false);
    assert.equal(loaded.session.wholeHistoryReads, 0);
  });

  test("a non-repetitive length stop remains an answer", async (t) => {
    const loaded = await start({ dir: agentDir(t), now: () => NOW });
    await loaded.host.emit("message_end", { message: assistant(KIMI, { stopReason: "length", content: [{ type: "text", text: unique }] }) });
    const record = loaded.router!.record(loaded.session.id)!;
    assert.equal(record.last?.ref, KIMI);
    assert.equal(record.ledger.seen.has(KIMI), true);
    assert.equal(loaded.session.notices.some((notice) => notice.message.includes("repetitive")), false);
  });
});
