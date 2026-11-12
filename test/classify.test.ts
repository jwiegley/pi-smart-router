import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { capText, classify, HEAD_CHARS, riskyTrigger, TAIL_CHARS, withoutFileNames } from "../src/classify.ts";
import type { Judge } from "../src/classify.ts";

describe("planning", () => {
  test("comes from planning words in the typed text", () => {
    for (const text of [
      "plan the migration",
      "Plan: rewrite the parser",
      "Can you design a cache for this?",
      "# Design\nA new cache layer",
      "## architecture notes",
      "what's the trade-off here?",
      "step 1: read the code",
      "phase 2 of the rollout",
      "give me a breakdown and a strategy",
      "let's refactor this",
      "write up the plan's open questions",
      "make a plan.",
      "(plan) first, then code",
    ]) {
      assert.equal(classify(text).signal, "planning", text);
    }
  });

  test("keeps upstream's repo-hygiene and destructive-intent triggers", () => {
    for (const text of [
      "clean up the repo",
      "repo cleanup please",
      "cleanup",
      "I mistakenly added a binary",
      "unstage that file",
      "git rm the stray files",
      "rm -rf node_modules/ and reinstall",
      "force push the branch",
      "git reset --hard to main",
      "is this destructive?",
    ]) {
      assert.equal(classify(text).signal, "planning", text);
    }
  });

  test("never comes from a file name or a path", () => {
    for (const text of [
      "Update PLAN.org with today's notes",
      "see plan.md",
      "look in src/plan/",
      "open `PLAN.org`, please",
      "read (plan.md).",
      "cat ~/.plan",
      "the file my-planning-notes.txt",
      "edit docs/design.md",
      "C:\\work\\plan\\notes.txt has it",
      "https://example.com/plan",
    ]) {
      assert.notEqual(classify(text).signal, "planning", text);
    }
  });

  test("file names and paths are blanked, other tokens kept", () => {
    assert.equal(withoutFileNames("see PLAN.org and src/plan/ now"), "see   and   now");
    assert.equal(withoutFileNames("step 1.2 of v1.2: plan."), "step 1.2 of v1.2: plan.");
    assert.equal(withoutFileNames("(PLAN.org), `plan.md`; .plan"), " ".repeat(5));
  });
});

describe("precedence", () => {
  test("planning beats complex, which beats trivial, else default", () => {
    assert.deepEqual(classify("Refactor the authentication module"), { signal: "planning", reason: "planning:plan-words" });
    assert.deepEqual(classify("plan how to rename the variable"), { signal: "planning", reason: "planning:plan-words" });
    assert.deepEqual(classify("Debug the memory leak in the WebSocket handler"), { signal: "complex", reason: "triage:keyword_frontier" });
    assert.deepEqual(classify("Format this file"), { signal: "trivial", reason: "triage:keyword_economical" });
    assert.deepEqual(classify("Hello, how are you today?"), { signal: "default", reason: "triage:no_fast_path" });
    assert.deepEqual(classify(""), { signal: "default", reason: "triage:empty_prompt" });
  });

  test("a mixed verdict from triage falls to default", () => {
    assert.equal(classify("debug the typo").signal, "default");
  });

  test("triage decides complex from code without keywords", () => {
    const code = ["```js", ...Array.from({ length: 16 }, (_, i) => `if (a${i} && b) { x(); }`), "```"].join("\n");
    assert.deepEqual(classify(`What does this do?\n${code}`), { signal: "complex", reason: "triage:cyclomatic_high" });
  });

  test("the reason names a pattern or a triage code, never prompt text", () => {
    for (const text of ["plan the secret project", "debug my-secret-service", "format secret.txt", "secret"]) {
      assert.doesNotMatch(classify(text).reason, /secret/);
    }
  });
});

describe("the text cap", () => {
  test("a 5 MB paste of unterminated openers reaches triage as at most 20 KiB", () => {
    const paste = ["<a ", "<!-- ", "```\n"].map((opener) => opener.repeat(Math.ceil((5 * 1024 * 1024) / 3 / opener.length))).join("");
    assert.ok(paste.length >= 5 * 1024 * 1024);
    const seen: number[] = [];
    const judge: Judge = (text) => {
      seen.push(text.length);
      return { verdict: "ambiguous", reason_code: "no_fast_path" };
    };
    assert.equal(classify(paste, judge).signal, "default");
    assert.equal(seen.length, 1);
    assert.ok((seen[0] ?? Infinity) <= 20 * 1024, `triage saw ${seen[0]} characters`);
  });

  test("keeps the first 16 KiB and the last 4 KiB", () => {
    const text = Array.from({ length: 60_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const capped = capText(text);
    assert.equal(capped.length, HEAD_CHARS + TAIL_CHARS);
    assert.ok(capped.startsWith(text.slice(0, HEAD_CHARS)));
    assert.ok(capped.endsWith(text.slice(text.length - TAIL_CHARS + 1)));
    assert.equal(capped[HEAD_CHARS], "\n", "the ends are joined by a line break, so no word spans the cut");
    assert.equal(capText("short text"), "short text");
    const exact = "x".repeat(HEAD_CHARS + TAIL_CHARS);
    assert.equal(capText(exact), exact);
  });

  test("the real triage runs on the capped paste", () => {
    const paste = "<!-- ".repeat(1_100_000);
    assert.equal(classify(paste).signal, "default");
  });

  test("planning words count only inside the capped ends", () => {
    const filler = "lorem ipsum ".repeat(100_000);
    assert.equal(classify(`${filler}now plan the migration`).signal, "planning");
    assert.equal(classify(`plan the migration ${filler}`).signal, "planning");
    assert.equal(classify(`${filler} plan the migration ${filler}`).signal, "default");
  });
});

describe("risky floor triggers", () => {
  test("name the operation a run must not under-serve", () => {
    for (const text of ["force push it", "git reset --hard HEAD~1", "rm -rf node_modules/", "please plan the force push"]) {
      assert.equal(riskyTrigger(text), "destructive-git", text);
    }
    assert.equal(riskyTrigger("clean up the repo"), "repo-cleanup");
    assert.equal(riskyTrigger("I accidentally added secrets.env"), "added-by-mistake");
  });

  test("ignore near misses", () => {
    for (const text of ["clean up this function", "this is a destructive change", "rename foo"]) {
      assert.equal(riskyTrigger(text), undefined, text);
    }
  });

  test("scan on their own, because classify reports only its first reason", () => {
    assert.equal(classify("please plan the force push").reason, "planning:plan-words");
  });
});
