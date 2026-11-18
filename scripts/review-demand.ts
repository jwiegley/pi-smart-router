// The demand review: `node --experimental-strip-types scripts/review-demand.ts <session.jsonl>...`.
//
// A development tool for the tuning review, not part of the extension: index.ts never imports it,
// Pi never loads it and the package does not ship it. It replays the runs a session file recorded
// and says, for the runs John judged (he typed a tag, or corrected the level afterwards), how often
// the heuristics alone, Jev's top choice alone and the blend named the level he meant. It reads the
// files named on its command line and nothing else: there is no default directory. It contacts
// nothing, and what it prints is counts, levels, rates and file names, never a prompt's text.
//
// A run's record sits on the session's entry tree after the run's own messages, because the router
// writes it when the agent settles. The prompt is the first user message on the record's chain of
// parents dated at or after the record's `at` less two seconds (`at` is when the run was planned,
// just before Pi appends the prompt), so a steer or follow-up in mid-run is not mistaken for it;
// with no user message dated that late, it is the latest user message before the record. The facts
// the heuristics read, taken before that prompt, are the latest assistant usage before that prompt, the roles of up to HEURISTIC_MESSAGES
// messages before it and the number of entries before it on the chain. The record's own `tier` is
// the level the run took. The truth is the record's `tag`, or the level of a correction that
// refers to the run's `at`, and a correction made after the tag wins. The script reads the record
// forms of both the earlier and the later version of the router: it needs only `tag`, `tier`,
// `refers` and `jev.probabilities`, which both write.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { classify, riskyTrigger } from "../src/classify.ts";
import { LEVEL_ENTRY } from "../src/constants.ts";
import { demandOf, HEURISTIC_MESSAGES } from "../src/demand.ts";
import type { DemandInput, PromptFacts } from "../src/demand.ts";
import { isRecord, own } from "../src/files.ts";
import type { JevOutcome } from "../src/jev.ts";
import { DEFAULT_DEMAND } from "../src/settings.ts";
import type { DemandSettings } from "../src/settings.ts";
import { isTier, TIERS } from "../src/tiers.ts";
import type { Tier } from "../src/tiers.ts";

export interface ReviewRow {
  /** When the run was planned: its record's `at`. */
  readonly at: number;
  readonly truth: Tier;
  readonly truthFrom: "tag" | "correction";
  readonly heuristics: Tier;
  /** The level with the largest probability Jev gave, or undefined when the record holds none. */
  readonly jev: Tier | undefined;
  readonly blend: Tier;
  readonly took: Tier;
}

export interface Review {
  readonly rows: readonly ReviewRow[];
  /** Runs that have a truth and a prompt to replay: `rows.length`. */
  readonly judged: number;
  /** Of the judged runs, how many each way named the truth. */
  readonly agree: { readonly heuristics: number; readonly jev: number; readonly blend: number };
  /** Runs with no truth, or with no prompt to replay. */
  readonly unjudged: number;
}

interface Entry {
  readonly id: string;
  readonly parentId: string | undefined;
  readonly fields: Record<string, unknown>;
}

interface Run {
  readonly entry: Entry;
  readonly at: number;
  readonly tier: Tier;
  readonly tag: Tier | undefined;
  readonly probabilities: Readonly<Record<Tier, number>> | undefined;
  readonly model: string;
  readonly ms: number;
}

interface Correction {
  readonly at: number;
  readonly refers: number;
  readonly scope: unknown;
  readonly tier: Tier;
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseEntry(line: string): Entry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const id = own(value, "id");
  if (typeof id !== "string") return undefined;
  const parentId = own(value, "parentId");
  return { id, parentId: typeof parentId === "string" ? parentId : undefined, fields: value };
}

function probabilitiesOf(jev: unknown): Readonly<Record<Tier, number>> | undefined {
  if (!isRecord(jev)) return undefined;
  const raw = own(jev, "probabilities");
  if (!isRecord(raw)) return undefined;
  const values = TIERS.map((tier) => own(raw, tier));
  if (!values.every((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)) return undefined;
  const [low = 0, medium = 0, high = 0, superValue = 0] = values;
  return { low, medium, high, super: superValue };
}

function messageOf(entry: Entry): Record<string, unknown> | undefined {
  if (own(entry.fields, "type") !== "message") return undefined;
  const message = own(entry.fields, "message");
  return isRecord(message) ? message : undefined;
}

function textOf(message: Record<string, unknown>): string {
  const content = own(message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: unknown) => (isRecord(part) && own(part, "type") === "text" && typeof own(part, "text") === "string" ? [own(part, "text") as string] : []))
    .join("\n");
}

function tokensOf(message: Record<string, unknown>): number | undefined {
  const usage = own(message, "usage");
  if (!isRecord(usage)) return undefined;
  const total = own(usage, "totalTokens");
  if (isTime(total) && total > 0) return total;
  const parts = ["input", "output", "cacheRead", "cacheWrite"].map((key) => own(usage, key));
  const sum = parts.reduce<number>((all, part) => all + (isTime(part) ? part : 0), 0);
  return sum > 0 ? sum : undefined;
}

/** The entries from the root to `entry`, oldest first; a cycle or a missing parent ends the chain there. */
function chainOf(entry: Entry, byId: ReadonlyMap<string, Entry>): Entry[] {
  const chain: Entry[] = [];
  const seen = new Set<string>();
  for (let at: Entry | undefined = entry; at !== undefined && !seen.has(at.id); at = at.parentId === undefined ? undefined : byId.get(at.parentId)) {
    seen.add(at.id);
    chain.push(at);
  }
  return chain.reverse();
}

/** An entry's time in milliseconds, from its ISO `timestamp`; undefined when it has none or none that parses. */
function timeOf(entry: Entry): number | undefined {
  const stamp = own(entry.fields, "timestamp");
  const time = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
}

/**
 * How long before a record's `at` its prompt's entry may be dated. The router stamps `at` when it
 * plans the run, a moment before Pi appends the prompt's entry, so the entry is at or after it;
 * the margin absorbs clock granularity.
 */
const PROMPT_MARGIN_MS = 2000;

/**
 * Where the rated prompt sits on `chain`, whose last entry is the run's record: the first user
 * message dated at or after the run's `at` less the margin, because the router writes the record when
 * the agent settles, after any steer or follow-up of the run. When no user message has a usable time
 * that late, the latest user message before the record.
 */
function promptIndex(chain: readonly Entry[], at: number): number {
  let latest = -1;
  for (let index = 0; index < chain.length - 1; index += 1) {
    const entry = chain[index] as Entry;
    if (messageOf(entry)?.["role"] !== "user") continue;
    latest = index;
    const time = timeOf(entry);
    if (time !== undefined && time >= at - PROMPT_MARGIN_MS) return index;
  }
  return latest;
}

/** The rated prompt of the run whose record ends `chain`, with the facts the heuristics read before it. */
function replayInput(chain: readonly Entry[], at: number): Omit<DemandInput, "jev"> | undefined {
  const index = promptIndex(chain, at);
  if (index < 0) return undefined;
  const prompt = messageOf(chain[index] as Entry);
  if (prompt === undefined) return undefined;
  const text = textOf(prompt);
  const before = chain.slice(0, index);
  let contextTokens: number | undefined;
  for (let back = before.length - 1; back >= 0 && contextTokens === undefined; back -= 1) {
    const message = messageOf(before[back] as Entry);
    if (message !== undefined && own(message, "role") === "assistant") contextTokens = tokensOf(message);
  }
  const roles = before
    .flatMap((entry) => {
      const role = messageOf(entry)?.["role"];
      return role === "user" || role === "assistant" ? [role] : role === "toolResult" ? ["tool"] : [];
    })
    .slice(-HEURISTIC_MESSAGES);
  const facts: PromptFacts = { contextTokens, roles, entries: before.length };
  return { text, planning: classify(text).signal === "planning", risky: riskyTrigger(text) !== undefined, facts };
}

function runOf(entry: Entry): Run | undefined {
  if (own(entry.fields, "type") !== "custom" || own(entry.fields, "customType") !== LEVEL_ENTRY) return undefined;
  const data = own(entry.fields, "data");
  if (!isRecord(data) || own(data, "v") !== 1 || own(data, "source") === "correction") return undefined;
  const at = own(data, "at");
  const tier = own(data, "tier");
  if (!isTime(at) || !isTier(tier)) return undefined;
  const tag = own(data, "tag");
  const jev = own(data, "jev");
  const model = isRecord(jev) && typeof own(jev, "model") === "string" ? (own(jev, "model") as string) : "recorded";
  const ms = isRecord(jev) && isTime(own(jev, "ms")) ? (own(jev, "ms") as number) : 0;
  return { entry, at, tier, tag: isTier(tag) ? tag : undefined, probabilities: probabilitiesOf(jev), model, ms };
}

function correctionOf(entry: Entry): Correction | undefined {
  if (own(entry.fields, "type") !== "custom" || own(entry.fields, "customType") !== LEVEL_ENTRY) return undefined;
  const data = own(entry.fields, "data");
  if (!isRecord(data) || own(data, "v") !== 1 || own(data, "source") !== "correction") return undefined;
  const at = own(data, "at");
  const refers = own(data, "refers");
  const tier = own(data, "tier");
  if (!isTime(at) || !isTime(refers) || !isTier(tier)) return undefined;
  return { at, refers, scope: own(data, "scope"), tier };
}

/** The level with the largest probability; the lowest of a tie. */
function topOf(probabilities: Readonly<Record<Tier, number>>): Tier {
  return TIERS.reduce((best, tier) => (probabilities[tier] > probabilities[best] ? tier : best), "low" as Tier);
}

function outcomeOf(run: Run, probabilities: Readonly<Record<Tier, number>>): JevOutcome {
  const choice = topOf(probabilities);
  return { kind: "answer", model: run.model, choice, tier: choice, probabilities, confidence: probabilities[choice], ms: run.ms };
}

/** Replays one session file's recorded runs. Reads the file's lines; contacts nothing. */
export function reviewSession(lines: Iterable<string>, settings: DemandSettings): Review {
  const entries: Entry[] = [];
  for (const line of lines) {
    const entry = parseEntry(line);
    if (entry !== undefined) entries.push(entry);
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  const runs = entries.flatMap((entry) => runOf(entry) ?? []);
  const corrections = entries.flatMap((entry) => correctionOf(entry) ?? []);

  const rows: ReviewRow[] = [];
  let unjudged = 0;
  for (const run of runs) {
    const scope = own(own(run.entry.fields, "data") as Record<string, unknown>, "scope");
    const later = corrections.filter((c) => c.refers === run.at && c.scope === scope).sort((a, b) => a.at - b.at).at(-1);
    const truth = later?.tier ?? run.tag;
    const input = truth === undefined ? undefined : replayInput(chainOf(run.entry, byId), run.at);
    if (truth === undefined || input === undefined) {
      unjudged += 1;
      continue;
    }
    const jev = run.probabilities === undefined ? undefined : outcomeOf(run, run.probabilities);
    rows.push({
      at: run.at,
      truth,
      truthFrom: later === undefined ? "tag" : "correction",
      heuristics: demandOf({ ...input, jev: undefined }, settings).tier,
      jev: run.probabilities === undefined ? undefined : topOf(run.probabilities),
      blend: demandOf({ ...input, jev }, settings).tier,
      took: run.tier,
    });
  }
  const count = (pick: (row: ReviewRow) => Tier | undefined) => rows.filter((row) => pick(row) === row.truth).length;
  return {
    rows,
    judged: rows.length,
    agree: { heuristics: count((row) => row.heuristics), jev: count((row) => row.jev), blend: count((row) => row.blend) },
    unjudged,
  };
}

/** Several files' reviews as one. */
export function totalOf(reviews: readonly Review[]): Review {
  const rows = reviews.flatMap((review) => review.rows);
  const sum = (pick: (review: Review) => number) => reviews.reduce((all, review) => all + pick(review), 0);
  return {
    rows,
    judged: sum((review) => review.judged),
    agree: {
      heuristics: sum((review) => review.agree.heuristics),
      jev: sum((review) => review.agree.jev),
      blend: sum((review) => review.agree.blend),
    },
    unjudged: sum((review) => review.unjudged),
  };
}

const rate = (agree: number, of: number) => (of === 0 ? "n/a" : `${Math.round((agree / of) * 100)}%`);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** One group's lines. Jev's rate is over the runs it answered; the blend's and the heuristics' are over all the group's runs. */
function group(title: string, rows: readonly ReviewRow[]): string[] {
  const answered = rows.filter((row) => row.jev !== undefined);
  const line = (label: string, matched: number, of: number, note = "") =>
    `    ${label.padEnd(11)} ${`${matched}/${of}`.padEnd(7)} ${rate(matched, of).padEnd(5)}${note === "" ? "" : ` ${note}`}`.trimEnd();
  const unanswered = rows.length - answered.length;
  return [
    `  ${title}: ${plural(rows.length, "run")}`,
    line("heuristics", rows.filter((row) => row.heuristics === row.truth).length, rows.length),
    line("jev", answered.filter((row) => row.jev === row.truth).length, answered.length, `(answered ${answered.length} of ${plural(rows.length, "run")})`),
    line("blend", rows.filter((row) => row.blend === row.truth).length, rows.length, `(${plural(unanswered, "run")} without a Jev answer ${unanswered === 1 ? "equals" : "equal"} the heuristics)`),
  ];
}

function section(name: string, review: Review): string[] {
  const { rows } = review;
  return [
    `${name}: judged ${review.judged}, unjudged ${review.unjudged}`,
    ...group("all judged", rows),
    ...group("tagged", rows.filter((row) => row.truthFrom === "tag")),
    ...group("corrected", rows.filter((row) => row.truthFrom === "correction")),
  ];
}

/** The printed report: per file, and in total when there are several. Counts and rates only. */
export function formatReport(files: ReadonlyArray<{ readonly name: string; readonly review: Review }>): string[] {
  const lines = files.flatMap((file) => section(file.name, file.review));
  if (files.length > 1) lines.push("", ...section("total", totalOf(files.map((file) => file.review))));
  return lines;
}

// Run only when named on the command line, never when a test imports the module.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0 || paths.some((path) => path.startsWith("-"))) {
    process.stderr.write("usage: node --experimental-strip-types scripts/review-demand.ts <session.jsonl>...\n");
    process.exitCode = 2;
  } else {
    const files = paths.map((path) => ({
      name: basename(path),
      review: reviewSession(readFileSync(path, "utf8").split("\n"), DEFAULT_DEMAND),
    }));
    for (const line of formatReport(files)) process.stdout.write(`${line}\n`);
  }
}
