import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { formatReport, reviewSession, totalOf } from "../scripts/review-demand.ts";
import { DEFAULT_DEMAND } from "../src/settings.ts";

const PATH = new URL("./fixtures/session-review.jsonl", import.meta.url);
const TEXT = readFileSync(PATH, "utf8");
const LINES = TEXT.split("\n").filter((line) => line !== "");
const BASE = 1_700_000_000_000;

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
    assert.doesNotMatch(empty, /NaN/, "and no rate of nothing");
  });
});
