// Jev's prompts: the texts John edits to steer how messages are classified. There are two kinds.
// The instructions are the one question Jev is asked about every message; the descriptions say,
// for each level of a scope, what kind of work belongs there. Each has three sources:
//
//   built-in   the instructions only: DEFAULT_INSTRUCTIONS, used when the roster gives none;
//   inline     a string in the roster: classifier.instructions, or a level's describe;
//   file       a plain text or Markdown file under <agentDir>/smart-router/, named by the roster:
//              classifier.instructionsFile, or a level's describeFile.
//
// A roster that names no file and gives no instructions sends Jev exactly what it always did.
//
// John edits guidance, not the protocol. Whatever these texts say, the request has one question
// with exactly the four levels as its choices (src/jev.ts), an answer is taken only when it names
// one of the four and gives a probability for each, and the level it names is routed inside the
// session's scope, under its account rules and under the pin (src/decide.ts, src/route.ts). No
// text here is read by anything but Jev.
//
// A prompt file is read with the roster's own safe reader and refreshed with the roster. In it,
// HTML comments (<!-- ... -->) are John's notes and are not sent. A file that is missing, unsafe,
// empty, too long, or still holds a placeholder is an error: Jev is then not asked in the scopes
// that need it, the keywords decide their levels, and status and the checker say why. Nothing
// falls back to an older text.
import { DESCRIBE_MAX_CHARS, INSTRUCTIONS_MAX_CHARS, PROMPT_DIR, PROMPT_FILE_MAX_BYTES } from "./constants.ts";
import { agentFile, readUserFile } from "./files.ts";
import type { AgentFile, FileSystem, Parsed } from "./files.ts";
import { SCOPES } from "./roster.ts";
import type { RosterV2, Scope } from "./roster.ts";
import { tierLabel, TIERS } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** The question Jev is asked when the roster gives no instructions of its own. */
export const DEFAULT_INSTRUCTIONS =
  "How much model intelligence does `message` need for the work it asks for now? `recent` holds the conversation just before it, oldest first.";

const COMMENT = /<!--[\s\S]*?-->/g;
/** What a template leaves behind when it was not filled in: {{name}}, or a line that starts with TODO. */
const PLACEHOLDER = /\{\{[^{}\n]*\}\}|^[ \t]*TODO\b/m;

/**
 * A prompt file's text as Jev reads it: without its HTML comments and surrounding space, or why it
 * cannot be used. `maxChars` counts Unicode code points, as a level's inline describe is counted.
 */
export function promptText(raw: string, maxChars: number): Parsed<string> {
  const text = raw.replace(COMMENT, "").trim();
  if (text.includes("<!--")) return { ok: false, error: "a comment (<!--) is never closed" };
  if (text === "") return { ok: false, error: "holds no text outside its comments" };
  const placeholder = PLACEHOLDER.exec(text);
  if (placeholder !== null) return { ok: false, error: `still holds a placeholder (${placeholder[0].trim()})` };
  const length = [...text].length;
  if (length > maxChars) return { ok: false, error: `is ${length} characters, and at most ${maxChars} are allowed` };
  return { ok: true, value: text };
}

/** A prompt file as read: its text, or why not; always with the path that was read. */
export type PromptRead = ({ readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string }) & { readonly path: string };

/** Reads a prompt file by its name, holding its text to `maxChars`. */
export type PromptReader = (name: string, maxChars: number) => PromptRead;

/** An error that names its file once: the reader's errors name the path, the text's do not. */
const located = (path: string, error: string): string => (error.startsWith(path) ? error : `${path}: ${error}`);

/**
 * A reader of the prompt files beside a roster: `<dir>/smart-router/<name>`, read once per call
 * with the safe reader. The checker uses it, with the directory of the roster it was given.
 */
export function promptReader(dir: string, options: { readonly uid?: number | undefined; readonly fs?: FileSystem | undefined } = {}): PromptReader {
  return (name, maxChars) => {
    const path = `${dir}/${PROMPT_DIR}/${name}`;
    const read = readUserFile(path, { maxBytes: PROMPT_FILE_MAX_BYTES, uid: options.uid, fs: options.fs });
    if (read.kind !== "read") return { ok: false, path, error: read.kind === "unchanged" ? `${path} was not read` : read.error };
    const parsed = promptText(read.text, maxChars);
    return parsed.ok ? { ok: true, path, value: parsed.value } : { ok: false, path, error: located(path, parsed.error) };
  };
}

export interface PromptStoreOptions {
  readonly agentDir: () => string;
  readonly uid?: number | undefined;
  readonly fs?: FileSystem | undefined;
  readonly now?: (() => number) | undefined;
}

/** The router's prompt files under Pi's agent directory, each cached by file identity as the roster is. */
export interface PromptStore {
  /** A file as last loaded; loads on first use. */
  readonly read: PromptReader;
  /** Load again every file the roster names whose identity changed. */
  refresh(roster: RosterV2): void;
  /** Read again every file the roster names, whatever its identity. */
  reload(roster: RosterV2): void;
}

export function promptStore(options: PromptStoreOptions): PromptStore {
  const files = new Map<string, AgentFile<string>>();
  const file = (name: string, maxChars: number): AgentFile<string> => {
    const key = `${maxChars}:${name}`;
    let found = files.get(key);
    if (found === undefined) {
      found = agentFile({ ...options, name: `${PROMPT_DIR}/${name}`, maxBytes: PROMPT_FILE_MAX_BYTES, parse: (text) => promptText(text, maxChars) });
      files.set(key, found);
    }
    return found;
  };
  const each = (roster: RosterV2, load: (entry: AgentFile<string>) => void): void => {
    for (const use of promptPlan(roster)) if (use.file !== undefined) load(file(use.file, use.maxChars));
  };
  return {
    read: (name, maxChars) => {
      const state = file(name, maxChars).current();
      return state.kind === "ok" ? { ok: true, path: state.path, value: state.value } : { ok: false, path: state.path, error: located(state.path, state.error) };
    },
    refresh: (roster) => each(roster, (entry) => void entry.refresh()),
    reload: (roster) => each(roster, (entry) => void entry.reload()),
  };
}

/** One prompt a roster uses: which it is, and where the roster says its text comes from. */
interface PromptPlan {
  /** "instructions", or a level as "personal LOW". */
  readonly what: string;
  /** The scope whose requests carry it; the instructions go with every scope's. */
  readonly scope?: Scope;
  readonly tier?: Tier;
  readonly maxChars: number;
  /** The file's name, for a file source. */
  readonly file?: string;
  /** The text, for an inline or built-in source. */
  readonly text?: string;
  readonly source: "built-in" | "inline" | "file";
}

/** Every prompt of a roster, the instructions first, then each scope's levels, low to super. */
function promptPlan(roster: RosterV2): PromptPlan[] {
  const settings = roster.classifier;
  const instructions: PromptPlan =
    settings?.instructionsFile !== undefined
      ? { what: "instructions", maxChars: INSTRUCTIONS_MAX_CHARS, source: "file", file: settings.instructionsFile }
      : settings?.instructions !== undefined
        ? { what: "instructions", maxChars: INSTRUCTIONS_MAX_CHARS, source: "inline", text: settings.instructions }
        : { what: "instructions", maxChars: INSTRUCTIONS_MAX_CHARS, source: "built-in", text: DEFAULT_INSTRUCTIONS };
  const levels = SCOPES.flatMap((scope) => {
    const section = roster.scopes[scope];
    if (section === undefined) return [];
    return TIERS.map((tier): PromptPlan => {
      const entry = section.levels[tier];
      const what = `${scope} ${tierLabel(tier)}`;
      return entry.describeFile !== undefined
        ? { what, scope, tier, maxChars: DESCRIBE_MAX_CHARS, source: "file", file: entry.describeFile }
        : { what, scope, tier, maxChars: DESCRIBE_MAX_CHARS, source: "inline", text: entry.describe };
    });
  });
  return [instructions, ...levels];
}

/** A prompt as it is in effect: its source, its text or the reason it has none, and its file's path. */
export interface PromptUse {
  readonly what: string;
  readonly scope?: Scope;
  readonly tier?: Tier;
  readonly source: "built-in" | "inline" | "file";
  readonly path?: string;
  readonly text?: string;
  readonly error?: string;
}

/** Every prompt of a roster as it is in effect, the instructions first, then each scope's levels. Without a reader, a file is named but not read. */
export function promptUses(roster: RosterV2, read: PromptReader | undefined): PromptUse[] {
  return promptPlan(roster).map((plan): PromptUse => {
    const { what, source } = plan;
    const place = { ...(plan.scope === undefined ? {} : { scope: plan.scope }), ...(plan.tier === undefined ? {} : { tier: plan.tier }) };
    if (plan.file === undefined) return { what, source, ...place, text: plan.text ?? "" };
    // Without a reader only the roster's text is being judged: the file is named, not read.
    if (read === undefined) return { what, source, ...place, path: `${PROMPT_DIR}/${plan.file}` };
    const result = read(plan.file, plan.maxChars);
    return result.ok ? { what, source, ...place, path: result.path, text: result.value } : { what, source, ...place, path: result.path, error: result.error };
  });
}

export type ScopePrompts =
  | { readonly ok: true; readonly instructions: string; readonly descriptions: Readonly<Record<Tier, string>> }
  | { readonly ok: false; readonly error: string };

/**
 * What a request to Jev carries for a session's scope: the instructions and the scope's four
 * descriptions, or the first problem with any of them. With a problem, Jev is not asked.
 */
export function scopePrompts(roster: RosterV2, scope: Scope, read: PromptReader): ScopePrompts {
  const uses = promptUses(roster, read).filter((use) => use.scope === undefined || use.scope === scope);
  const broken = uses.find((use) => use.error !== undefined);
  if (broken !== undefined) return { ok: false, error: broken.error ?? "" };
  const textOf = (tier: Tier): string => uses.find((use) => use.tier === tier)?.text ?? "";
  return {
    ok: true,
    instructions: uses.find((use) => use.scope === undefined)?.text ?? DEFAULT_INSTRUCTIONS,
    descriptions: { low: textOf("low"), medium: textOf("medium"), high: textOf("high"), super: textOf("super") },
  };
}

/** Where each prompt of a roster comes from, one line each, for status and the checker. */
export function promptLines(uses: readonly PromptUse[]): string[] {
  return uses.map((use) => {
    const size = use.text === undefined ? " (not read: only the roster's text was checked)" : `, ${[...use.text].length} characters`;
    const where = use.source === "file" ? `file ${use.path ?? ""}` : use.source === "inline" ? "inline in the roster" : "built-in";
    return `  ${use.what}: ${where}${use.error === undefined ? size : `: NOT USABLE: ${use.error}`}`;
  });
}

/** The first problem among a roster's prompts, and the scopes whose requests it stops. */
export function promptProblem(uses: readonly PromptUse[]): string | undefined {
  const broken = uses.filter((use) => use.error !== undefined);
  const [first] = broken;
  if (first === undefined) return undefined;
  const everywhere = broken.some((use) => use.scope === undefined);
  const scopes = everywhere ? "any scope" : `${[...new Set(broken.map((use) => use.scope))].join(" and ")} scope`;
  return `${first.error ?? ""}. Jev is not asked in ${scopes} until it is fixed, and the keywords decide every level there.`;
}
