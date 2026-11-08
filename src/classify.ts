// The prompt classifier. It sees only the text John typed, as the `input` event delivers it, so a
// prompt template or a /skill: call is classified by its invocation, not by its expansion.
//
// Planning comes first: upstream's planning patterns (turn-envelope.ts:22-30, MIT), with the
// repo-hygiene and destructive-intent triggers John kept. They run on the text with every file
// name and path blanked out, so PLAN.org, plan.md or src/plan/ cannot make a run a planning run.
// Then upstream's triage() decides complex and trivial, unchanged.
//
// Both see a capped copy of the text: the first 16 KiB and the last 4 KiB. Three of triage()'s
// patterns rescan to the end of the text for each unterminated opener, so an uncapped multi-
// megabyte paste could stall Pi's main thread.
import { triage } from "./triage/triage-engine.ts";
import type { TriageResult } from "./triage/triage-engine.ts";

export type Signal = "planning" | "complex" | "trivial" | "default";

export interface Classification {
  readonly signal: Signal;
  /** The planning pattern that matched, or triage()'s reason code; never prompt text. */
  readonly reason: string;
}

/** The two ends of the text that are classified, in UTF-16 code units. */
export const HEAD_CHARS = 16 * 1024;
export const TAIL_CHARS = 4 * 1024;

const PLANNING: ReadonlyArray<readonly [string, RegExp]> = [
  ["plan-words", /\b(?:plan|planning|architect(?:ure)?|design|refactor|migration)\b/i],
  ["structure-words", /\b(?:step\s*\d|phase\s*\d|breakdown|strategy|trade-?off)\b/i],
  ["plan-heading", /^#+\s*(?:plan|design|architecture)/im],
  ["repo-cleanup", /\b(?:clean\s*up(?:\s+the)?\s+repo|repo\s+cleanup|cleanup\s+the\s+repo)\b/i],
  ["cleanup-words", /\b(?:clean\s*up|cleanup|mistakenly\s+added|accidentally\s+added|accidental\s+add)\b/i],
  ["destructive-git", /\b(?:unstage|git\s+rm|rm\s+-rf|force\s+push|git\s+reset\s+--hard|destructive)\b/i],
];

// A token names a path when it holds a slash or a backslash, and a file when it ends in an
// extension that starts with a letter (PLAN.org, plan.md, .plan), so "v1.2" and "step 1.2" stay.
const EDGES = /^[`'"([{<]+|[`'")\]}>,;:!?.]+$/g;
const PATH = /[\\/]/;
const FILE = /^(?:[\w.-]*\w)?\.[A-Za-z][\w-]{0,15}$/;

/** The text with every file name and path blanked out. */
export function withoutFileNames(text: string): string {
  return text.replace(/\S+/g, (token) => {
    const bare = token.replace(EDGES, "");
    return PATH.test(bare) || FILE.test(bare) ? " " : token;
  });
}

/** The first 16 KiB and the last 4 KiB of the text, at most 20 KiB in all. */
export function capText(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n${text.slice(text.length - TAIL_CHARS + 1)}`;
}

export type Judge = (text: string) => Pick<TriageResult, "verdict" | "reason_code">;

/** Planning, then complex, then trivial, else default. `judge` is triage() except in tests. */
export function classify(text: string, judge: Judge = triage): Classification {
  const capped = capText(text);
  const words = withoutFileNames(capped);
  for (const [name, pattern] of PLANNING) {
    if (pattern.test(words)) return { signal: "planning", reason: `planning:${name}` };
  }
  const result = judge(capped);
  const reason = `triage:${result.reason_code}`;
  if (result.verdict === "complex") return { signal: "complex", reason };
  if (result.verdict === "trivial") return { signal: "trivial", reason };
  return { signal: "default", reason };
}
