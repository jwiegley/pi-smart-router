// A session's scope, personal or work: a property of the session, kept in `smart-router.scope`
// custom entries. It is read on every route with the fork's bounded
// getLatestCustomEntry over the whole session (scope "all"), so nothing mirrors it in memory. The
// first rule that applies decides:
//
//   1. PI_SMART_ROUTER_SCOPE=work, latched in the process slot by the factory: work, whatever the
//      session's entries say;
//   2. the session's latest scope entry, exactly as the router writes it;
//   3. the work directories of the roster as it is now: work for a session whose working directory
//      lies under one of them, so a roster load that lists a running session's directory moves
//      that session at once. While the roster fails to load, the router passes the directories of
//      the last valid roster loaded in the process (src/router.ts);
//   4. otherwise the host's default: the roster's defaultScope as it is now, source
//      "roster-default", or personal, source "default", for a roster that sets none. While the
//      roster fails to load, the router passes the last valid roster's default; when no roster the
//      process loaded says which default this host has, the scope is unreadable (below).
//
// The first time rule 3 decides a session's scope, at session start or at its next idle input, the
// router records it as a work entry, so that rule 2 keeps it whatever the roster says later
// (src/router.ts). Rule 4 records nothing, so a roster whose default changes moves every session
// it decides at the next roster load. Selecting smart-router/work records a work entry in a session
// that rule 4 puts in work scope, as in a personal one, so that session then stays where it is.
//
// The read fails closed. A malformed entry, a custom_message of the type, or a session whose
// entries cannot be read has an unreadable scope: routing resolves in work scope, the narrower one,
// and smart-router/auto refuses until a scope is recorded again. smart-router/local, whose requests
// carry no account, routes to the local role all the same. A session that rule 4 would decide while
// the host's default is unknown is unreadable too, until the roster loads or a scope is recorded.
//
// A fork or /new carries a scope that an entry, the latch or the work directories set, and an
// unreadable one as work: at session_shutdown the old session leaves it in the slot under the new
// session's file (src/owners.ts), and the new session's session_start records it as a carried entry.
// What rule 4 gives is not carried, an unknown default included: the new session reads the same
// host's default for itself.
import { SCOPE_ENTRY } from "./constants.ts";
import { firstLine } from "./errors.ts";
import { isRecord, own } from "./files.ts";
import { boundedHistory } from "./route.ts";
import { isScope } from "./roster.ts";
import type { Scope } from "./roster.ts";

export interface ScopeEntryData {
  readonly v: 1;
  readonly scope: Scope;
  /** What recorded it: /smart-router scope, the roster's work directories, or a fork or /new. */
  readonly by: "command" | "directory" | "carried";
  /** When, in milliseconds since the epoch. */
  readonly at: number;
}

/** Which rule gave a readable scope: "default" is the built-in personal, "roster-default" the roster's defaultScope. */
export type ScopeSource = "latch" | "entry" | "directory" | "default" | "roster-default";

export type ScopeState =
  | { readonly kind: "ok"; readonly scope: Scope; readonly source: ScopeSource }
  /** `fromDefault`: rule 4 decided the session while the host's default is unknown. */
  | { readonly kind: "unreadable"; readonly reason: string; readonly fromDefault?: true };

/**
 * What rule 4 reads of the roster: the built-in personal default of a roster that sets no
 * defaultScope, the scope a roster sets, or, when no roster loaded in the process says which,
 * an unknown default and why.
 */
export type HostDefault =
  | { readonly kind: "built-in" }
  | { readonly kind: "roster"; readonly scope: Scope }
  | { readonly kind: "unknown"; readonly reason: string };

/** Where a session works: its working directory, and the work directories of the roster as it is now. */
export interface WorkDirectories {
  readonly cwd: string;
  readonly directories: readonly string[];
}

const KEYS: ReadonlySet<string> = new Set(["v", "scope", "by", "at"]);
const LATCHED: ScopeState = Object.freeze({ kind: "ok", scope: "work", source: "latch" });
const BY_DIRECTORY: ScopeState = Object.freeze({ kind: "ok", scope: "work", source: "directory" });
const DEFAULT: ScopeState = Object.freeze({ kind: "ok", scope: "personal", source: "default" });
/** A roster that sets no defaultScope: rule 4 gives personal, as before the key existed. */
export const BUILT_IN_DEFAULT: HostDefault = Object.freeze({ kind: "built-in" });

/** What rule 4 gives a session with no entry outside the work directories. */
function byDefault(host: HostDefault): ScopeState {
  switch (host.kind) {
    case "built-in":
      return DEFAULT;
    case "roster":
      return { kind: "ok", scope: host.scope, source: "roster-default" };
    case "unknown":
      return { kind: "unreadable", reason: host.reason, fromDefault: true };
  }
}

/**
 * Whether rule 4 gave this scope, readable or not: such a scope is the host's, not the session's,
 * so nothing carries it into a fork or /new and nothing records it.
 */
export function fromHostDefault(state: ScopeState): boolean {
  return state.kind === "ok" ? state.source === "default" || state.source === "roster-default" : state.fromDefault === true;
}

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
 * directories; `host` is rule 4's default, the built-in personal one unless the caller passes the
 * roster's. Never throws: a session whose scope entries cannot be read has an unreadable scope,
 * which neither the work directories nor the default override.
 */
export function readScope(sessionManager: unknown, latched: boolean, work: WorkDirectories | undefined, host: HostDefault = BUILT_IN_DEFAULT): ScopeState {
  if (latched) return LATCHED;
  const view = boundedHistory(sessionManager);
  if (view === undefined) return { kind: "unreadable", reason: "this Pi has no bounded session history" };
  let entry: unknown;
  try {
    entry = view.getLatestCustomEntry(SCOPE_ENTRY, { scope: "all" });
  } catch (error) {
    return { kind: "unreadable", reason: `reading its ${SCOPE_ENTRY} entries failed: ${firstLine(error)}` };
  }
  if (entry === undefined || entry === null) return work !== undefined && underDirectory(work.cwd, work.directories) ? BY_DIRECTORY : byDefault(host);
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
