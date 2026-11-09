import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { parseTag } from "../src/tags.ts";

describe("parseTag", () => {
  test("reads a trailing tier tag and strips it", () => {
    assert.deepEqual(parseTag("refactor the loader #medium"), { tier: "medium", text: "refactor the loader" });
    assert.deepEqual(parseTag("review this #H"), { tier: "high", text: "review this" });
    assert.deepEqual(parseTag("go ahead #s\n"), { tier: "super", text: "go ahead" });
    assert.deepEqual(parseTag("line one\nline two #m"), { tier: "medium", text: "line one\nline two" });
    assert.deepEqual(parseTag("#low"), { tier: "low", text: "" });
    assert.deepEqual(parseTag("fix it #HIGH"), { tier: "high", text: "fix it" });
  });

  test("leaves other last tokens alone", () => {
    for (const text of ["fix issue #12", "#hashtag", "#high.", "use #high here please", ""]) {
      assert.equal(parseTag(text), undefined, text);
    }
  });
});
