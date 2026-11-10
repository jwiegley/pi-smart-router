// A session's scope, personal or work: a property of the session, kept in `smart-router.scope`
// custom entries. Like the pin (src/pin.ts), it is read on every route with the fork's bounded
// getLatestCustomEntry over the whole session (scope "all"), so nothing mirrors it in memory. The
// first rule that applies decides:
//
//   1. PI_SMART_ROUTER_SCOPE=work, latched in the process slot by the factory: work, whatever the
//      session's entries say;
//   2. the session's latest scope entry, exactly as the router writes it;
//   3. the work directories of the roster as it is now: work for a session whose working directory
//      lies under one of them, so a roster load that lists a running session's directory moves
//      that session at once;
//   4. otherwise personal, the default.
//
// The first time rule 3 decides a session's scope, at session start or at its next idle input, the
// router records it as a work entry, so that rule 2 keeps it whatever the roster says later
// (src/router.ts).
//
// The read fails closed. A malformed entry, a custom_message of the type, or a session whose
// entries cannot be read has an unreadable scope: routing resolves in work scope, the narrower one,
// and smart-router/auto refuses until a scope is recorded again.
//
// A fork or /new carries a scope that an entry or the latch set: at session_shutdown the old
// session leaves it in the slot under the new session's file (src/owners.ts), and the new session's
// session_start records it as a carried entry.
import { SCOPE_ENTRY } from "./constants.ts";
import { firstLine } from "./errors.ts";
import { isRecord, own } from "./files.ts";
import { boundedHistory } from "./route.ts";
import type { Scope } from "./roster.ts";

export interface ScopeEntryData {
  readonly v: 1;
  readonly scope: Scope;
  /** What recorded it: /smart-router scope, the roster's work directories, or a fork or /new. */
  readonly by: "command" | "directory" | "carried";
  /** When, in milliseconds since the epoch. */
  readonly at: number;
}

export type ScopeState =
  | { readonly kind: "ok"; readonly scope: Scope; readonly source: "latch" | "entry" | "directory" | "default" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** Where a session works: its working directory, and the work directories of the roster as it is now. */
export interface WorkDirectories {
  readonly cwd: string;
  readonly directories: readonly string[];
}

const KEYS: ReadonlySet<string> = new Set(["v", "scope", "by", "at"]);
const LATCHED: ScopeState = Object.freeze({ kind: "ok", scope: "work", source: "latch" });
const BY_DIRECTORY: ScopeState = Object.freeze({ kind: "ok", scope: "work", source: "directory" });
const DEFAULT: ScopeState = Object.freeze({ kind: "ok", scope: "personal", source: "default" });

const isScope = (value: unknown): value is Scope => value === "personal" || value === "work";
const isRecorder = (value: unknown): value is ScopeEntryData["by"] => value === "command" || value === "directory" || value === "carried";

/** One entry, exactly as the router writes it; undefined for anything else. */
export function parseScopeEntry(entry: unknown): ScopeEntryData | undefined {
  if (!isRecord(entry) || own(entry, "type") !== "custom" || own(entry, "customType") !== SCOPE_ENTRY) return undefined;
  const data = own(entry, "data");
  if (!isRecord(data) || Object.keys(data).some((key) => !KEYS.has(key))) return undefined;
  const scope = own(data, "scope");
  const by = own(data, "by");
  const at = own(data, "at");
  if (own(data, "v") !== 1 || !isScope(scope) || !isRecorder(by) || typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { v: 1, scope, by, at };
}

/**
 * A session's scope, by the four rules above. `work` is undefined when the roster lists no work
 * directories. Never throws: a session whose scope entries cannot be read has an unreadable scope,
 * which the work directories do not override.
 */
export function readScope(sessionManager: unknown, latched: boolean, work: WorkDirectories | undefined): ScopeState {
  if (latched) return LATCHED;
  const view = boundedHistory(sessionManager);
  if (view === undefined) return { kind: "unreadable", reason: "this Pi has no bounded session history" };
  let entry: unknown;
  try {
    entry = view.getLatestCustomEntry(SCOPE_ENTRY, { scope: "all" });
  } catch (error) {
    return { kind: "unreadable", reason: `reading its ${SCOPE_ENTRY} entries failed: ${firstLine(error)}` };
  }
  if (entry === undefined || entry === null) return work !== undefined && underDirectory(work.cwd, work.directories) ? BY_DIRECTORY : DEFAULT;
  const data = parseScopeEntry(entry);
  if (data === undefined) return { kind: "unreadable", reason: `the latest ${SCOPE_ENTRY} entry is not one the router wrote` };
  return { kind: "ok", scope: data.scope, source: "entry" };
}

/** The data of an entry that records a scope. */
export function scopeEntry(scope: Scope, by: ScopeEntryData["by"], at: number): ScopeEntryData {
  return { v: 1, scope, by, at };
}

function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end -= 1;
  return path.slice(0, end);
}

/**
 * The first of these directories that a working directory lies under: compared as text on whole
 * path segments, so /x/work holds /x/work, /x/work/ and /x/work/a but not /x/workshop. Nothing is
 * resolved: a symlinked spelling of a directory is not under it. A path that is not absolute is
 * under nothing and holds nothing.
 */
export function workDirectoryOf(cwd: string, directories: readonly string[]): string | undefined {
  if (!cwd.startsWith("/")) return undefined;
  return directories.find((directory) => {
    if (!directory.startsWith("/")) return false;
    const base = withoutTrailingSlashes(directory);
    return cwd === base || cwd.startsWith(`${base}/`);
  });
}

/** Whether a working directory lies under one of these directories (see workDirectoryOf). */
export function underDirectory(cwd: string, directories: readonly string[]): boolean {
  return workDirectoryOf(cwd, directories) !== undefined;
}
