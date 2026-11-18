import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { formatReport, reviewSession, totalOf } from "../scripts/review-demand.ts";
import { DEFAULT_DEMAND } from "../src/settings.ts";

const PATH = new URL("./fixtures/session-review.jsonl", import.meta.url);
const TEXT = readFileSync(PATH, "utf8");
const LINES = TEXT.split("\n").filter((line) => line !== "");
// The fixture's runs are planned 100 ms before Pi appends their prompts, as the router's `at` is.
const BASE = 1_793_523_599_900;

// Every text the fixture holds, read from the fixture so that a new one is covered too.
const fixtureTexts = LINES.flatMap((line) => {
  const entry = JSON.parse(line) as { message?: { content?: Array<{ text?: string }> } };
  return (entry.message?.content ?? []).flatMap((part) => (part.text === undefined ? [] : [part.text]));
});

describe("reviewSession", () => {
  const review = reviewSession(LINES, DEFAULT_DEMAND);

  test("counts the runs that have a truth and the one that has none", () => {
    assert.equal(review.judged, 2, "a tagged run and a corrected run are judged");
    assert.equal(review.unjudged, 1, "the untagged, uncorrected run has no truth");
    assert.equal(review.rows.length, 2, "one row per judged run");
  });

  test("replays a tagged run whose Jev opinion had not come", () => {
    assert.deepEqual(
      review.rows[0],
      { at: BASE, truth: "high", truthFrom: "tag", heuristics: "low", jev: undefined, blend: "low", took: "high" },
      "first prompt of an empty history; no probabilities: the blend is the heuristics alone and Jev alone has no level",
    );
  });

  test("replays a corrected run from the later record form", () => {
    assert.deepEqual(
      review.rows[1],
      { at: BASE + 300_000, truth: "low", truthFrom: "correction", heuristics: "medium", jev: "low", blend: "low", took: "medium" },
      "truth from the correction; Jev's term from its probabilities; the level taken from tier",
    );
  });

  test("counts how often each way gave the truth", () => {
    assert.deepEqual(review.agree, { heuristics: 0, jev: 1, blend: 1 }, "Jev and the blend gave the corrected level; the heuristics gave neither");
  });

  test("lets a later correction win over a tag", () => {
    const lines = [
      ...LINES,
      JSON.stringify({ id: "e11", parentId: "e10", type: "custom", customType: "smart-router.level", data: { v: 1, at: BASE + 700_000, scope: "main", source: "correction", tier: "low", refers: BASE } }),
    ];
    const row = reviewSession(lines, DEFAULT_DEMAND).rows.find((r) => r.at === BASE);
    assert.equal(row?.truth, "low", "a correction made after the tag is what John said last");
    assert.equal(row?.truthFrom, "correction", "and it is named as the correction");
  });

  test("skips lines it cannot use without failing", () => {
    const noise = ["", "not json", "[1,2]", "null", '{"type":"message"}', '{"id":"x","parentId":"nowhere","type":"custom","customType":"smart-router.level","data":{"v":1}}'];
    const noisy = reviewSession([...noise, ...LINES, ...noise], DEFAULT_DEMAND);
    assert.deepEqual(noisy, review, "malformed lines change nothing");
  });

  test("leaves a run with no prompt on its chain unjudged", () => {
    const lines = [
      JSON.stringify({ id: "r1", parentId: null, type: "custom", customType: "smart-router.level", data: { v: 1, at: 5, scope: "main", source: "tag", tier: "high", tag: "high" } }),
    ];
    const orphan = reviewSession(lines, DEFAULT_DEMAND);
    assert.equal(orphan.judged, 0, "nothing to replay");
    assert.equal(orphan.unjudged, 1, "so it is not judged");
  });

  test("does not read an inherited field as a record's", () => {
    const lines = LINES.map((line) => line.replace('"tag":"high"', '"__proto__":{"tag":"high"}'));
    const polluted = reviewSession(lines, DEFAULT_DEMAND);
    assert.equal(polluted.judged, 1, "a tag that is not an own field is no tag");
  });
});

// A run that John steered in mid-run: the opening prompt, a reply, a steer, a reply, then the record,
// which the router writes when the agent settles. Appended to the fixture's chain.
const OPENING = "Design the architecture for the lantern scheduling service and plan its migration across three teams";
const STEER = "Yes, go ahead";
const message = (id: string, parentId: string, timestamp: string, role: string, text: string) =>
  JSON.stringify({ id, parentId, timestamp, type: "message", message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { usage: { totalTokens: 4000 } } : {}) } });
const steered = (at: number) => [
  message("s01", "e10", "2026-11-01T09:20:00.000Z", "user", OPENING),
  message("s02", "s01", "2026-11-01T09:20:30.000Z", "assistant", "Drafting the plan."),
  message("s03", "s02", "2026-11-01T09:21:00.000Z", "user", STEER),
  message("s04", "s03", "2026-11-01T09:21:40.000Z", "assistant", "Done."),
  JSON.stringify({
    id: "s05",
    parentId: "s04",
    type: "custom",
    customType: "smart-router.level",
    data: { v: 1, at, scope: "main", source: "tag", tier: "super", tag: "super" },
  }),
];
const OPENING_AT = Date.parse("2026-11-01T09:20:00.000Z") - 100;

describe("reviewSession, the rated prompt", () => {
  test("replays the opening prompt of a run that was steered in mid-run, not the steer", () => {
    const row = reviewSession([...LINES, ...steered(OPENING_AT)], DEFAULT_DEMAND).rows.find((r) => r.at === OPENING_AT);
    assert.equal(row?.heuristics, "high", "the planning prompt the router rated, not the steer, which names no work and rates lower");
    assert.equal(row?.truth, "super", "the tag is the run's truth");
  });

  test("takes the first user message planned at or after the run's time, within two seconds", () => {
    const early = reviewSession([...LINES, ...steered(OPENING_AT + 1_900)], DEFAULT_DEMAND).rows.find((r) => r.at === OPENING_AT + 1_900);
    assert.equal(early?.heuristics, "high", "a prompt 1.9 s before `at` is still within the two seconds");
  });

  test("falls back to the latest user message when none has a time at or after the run's", () => {
    const late = reviewSession([...LINES, ...steered(OPENING_AT + 3_600_000)], DEFAULT_DEMAND).rows.find((r) => r.at === OPENING_AT + 3_600_000);
    assert.notEqual(late?.heuristics, "high", "every message is before the record's time, so the latest user message, the steer, stands in");
  });

  test("falls back to the latest user message when the entries carry no usable time", () => {
    const untimed = LINES.map((line) => line.replace(/"timestamp":"[^"]*",/, '"timestamp":"not a time",'));
    assert.deepEqual(reviewSession(untimed, DEFAULT_DEMAND), reviewSession(LINES, DEFAULT_DEMAND), "the fixture's prompts are the latest user messages, so the fallback agrees with the time rule");
  });
});

describe("formatReport", () => {
  const review = reviewSession(LINES, DEFAULT_DEMAND);
  const report = formatReport([{ name: "session-review.jsonl", review }]).join("\n");

  test("names the file, the counts and the rates, and none of the prompt text", () => {
    assert.match(report, /session-review\.jsonl/, "the file's name");
    assert.match(report, /judged 2/, "the judged count");
    assert.match(report, /unjudged 1/, "the unjudged count");
    assert.match(report, /blend\s+1\/2\s+50%/, "the blend's rate");
    assert.ok(fixtureTexts.length >= 6, "the fixture holds prompt and reply texts to look for");
    for (const text of fixtureTexts) assert.ok(!report.includes(text), `the report holds the fixture text ${JSON.stringify(text.slice(0, 20))}`);
  });

  test("counts the runs Jev answered, apart from the runs it did not, for all, tagged and corrected runs", () => {
    const lines = report.split("\n");
    const group = (title: RegExp) => lines.slice(lines.findIndex((line) => title.test(line)) + 1, lines.findIndex((line) => title.test(line)) + 4).join("\n");
    const all = group(/^ {2}all judged: 2 runs/);
    assert.match(all, /heuristics\s+0\/2\s+0%/, "all: the heuristics matched none of two");
    assert.match(all, /jev\s+1\/1\s+100%\s+\(answered 1 of 2 runs\)/, "all: Jev's rate is over the one run it answered, not over both");
    assert.match(all, /blend\s+1\/2\s+50%\s+\(1 run without a Jev answer equals the heuristics\)/, "all: the blend's runs include one that had no Jev answer");
    const tagged = group(/^ {2}tagged: 1 run/);
    assert.match(tagged, /heuristics\s+0\/1\s+0%/, "tagged: the heuristics' count");
    assert.match(tagged, /jev\s+0\/0\s+n\/a\s+\(answered 0 of 1 run\)/, "tagged: a rate over no run is n/a, not 0% or NaN");
    assert.match(tagged, /blend\s+0\/1\s+0%\s+\(1 run without a Jev answer equals the heuristics\)/, "tagged: the blend equals the heuristics here");
    const corrected = group(/^ {2}corrected: 1 run/);
    assert.match(corrected, /jev\s+1\/1\s+100%\s+\(answered 1 of 1 run\)/, "corrected: Jev answered and matched");
    assert.match(corrected, /blend\s+1\/1\s+100%\s+\(0 runs without a Jev answer equal the heuristics\)/, "corrected: every blend run had a Jev answer");
  });

  test("adds a total over several files", () => {
    const two = formatReport([
      { name: "a.jsonl", review },
      { name: "b.jsonl", review },
    ]).join("\n");
    assert.match(two, /total[\s\S]*judged 4/, "the total sums the files");
    assert.equal(totalOf([review, review]).agree.blend, 2, "and so does the agreement");
  });

  test("says so when nothing was judged", () => {
    const empty = formatReport([{ name: "none.jsonl", review: reviewSession([], DEFAULT_DEMAND) }]).join("\n");
    assert.match(empty, /judged 0/, "a count of none");
    assert.doesNotMatch(empty, /NaN|0%/, "and no rate of nothing");
    assert.match(empty, /jev\s+0\/0\s+n\/a/, "which reads n/a");
  });
});
