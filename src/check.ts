// The roster checker: what a roster will route to, read back in plain language, or its first error
// with the place it is at. /smart-router check prints it for the roster a session has loaded, and
// src/check-cli.ts prints it for any file, without Pi, a session or a credential.
//
// It judges the roster's text alone, with the parser the router routes by (parseRoster), and the
// orders it prints are the ones routing uses (candidatesOf). It knows no catalog, so it cannot say
// whether a model exists, is reachable or has credentials on a host: /smart-router status does.
// Nothing here sends anything, and nothing here imports Pi.
import { ROSTER_MAX_BYTES } from "./constants.ts";
import { readUserFile } from "./files.ts";
import type { ReadOptions } from "./files.ts";
import { autoRoles, candidatesOf, parseRoster, SCOPES } from "./roster.ts";
import type { Roster, RosterV1, RosterV2, Scope } from "./roster.ts";
import { tierLabel, TIERS } from "./tiers.ts";

export interface CheckReport {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

const modelsOf = (roster: Roster, name: string): readonly string[] => roster.roles.find((role) => role.name === name)?.models ?? [];

const thinkingOf = (roster: Roster, name: string): string => {
  const thinking = roster.roles.find((role) => role.name === name)?.thinking ?? "selected";
  return thinking === "selected" ? "" : `, thinking ${thinking}`;
};

/** A numbered list of models, each with the role that holds it. */
function numbered(roster: Roster, candidates: ReadonlyArray<{ readonly role: string; readonly ref: string }>, indent: string): string[] {
  return candidates.map(({ role, ref }, index) => `${indent}${index + 1}. ${ref}  (role ${role}${thinkingOf(roster, role)})`);
}

/** What smart-router/local, and smart-router/auto under the pin, route to. */
function localLines(roster: Roster): string[] {
  const role = roster.local?.role;
  if (role === undefined) return ["smart-router/local, in any scope, pinned or not:", "  refused: the roster has no local section"];
  return [
    "smart-router/local, in any scope, pinned or not: only these, in this order, never a cloud model:",
    ...numbered(roster, modelsOf(roster, role).map((ref) => ({ role, ref })), "  "),
    `  local means: a provider of ${roster.local?.providers.join(", ")} whose base URL is on ${roster.local?.hosts.join(", ")}`,
  ];
}

/** What a pinned session on smart-router/auto does in a scope: the local role when auto reaches it there, else a refusal. */
function pinnedLine(roster: Roster, scope: Scope): string {
  const role = roster.local?.role;
  return role !== undefined && autoRoles(roster, scope).has(role)
    ? `  under the pin: only the local role ${role}, in its own order (below)`
    : "  under the pin: refused, since smart-router/auto does not reach the local role in this scope; choose smart-router/local";
}

function accountLines(roster: Roster): string[] {
  if (roster.accounts.size === 0) return [];
  return [
    "Accounts:",
    ...[...roster.accounts].map(([provider, binding]) => {
      const scope = "scope" in binding ? `, ${binding.scope} scope` : "";
      return `  ${provider}: ${binding.kind === "multi-pass" ? `the Multi-Pass label "${binding.label}"` : `a native login acknowledged as "${binding.label}"`}${scope}`;
    }),
  ];
}

function describeV2(roster: RosterV2): string[] {
  const lines: string[] = [];
  for (const scope of SCOPES) {
    const section = roster.scopes[scope];
    if (section === undefined) {
      lines.push(`smart-router/auto in ${scope} scope: refused, since the roster has no ${scope} scope`, "");
      continue;
    }
    const decides = roster.classifier === undefined ? "the keywords" : `Jev (${roster.classifier.model}), else the keywords`;
    lines.push(`smart-router/auto in ${scope} scope: a tag, else ${decides}, pick the level; each level tries its own models in order:`);
    for (const tier of TIERS) {
      const role = section.levels[tier].role;
      lines.push(`  ${tierLabel(tier).padEnd(6)} ${modelsOf(roster, role).join(", then ")}  (role ${role}${thinkingOf(roster, role)})`);
    }
    if (section.fallback === undefined) {
      lines.push("  no fallback: a level with no available model passes its run up to the next level; with none above, the run is refused");
    } else {
      const chain = candidatesOf(roster, scope, section.levels.low.role).filter((candidate) => candidate.role !== section.levels.low.role);
      lines.push("  then, for every level, when its own models cannot take a request, the fallback chain in this order:", ...numbered(roster, chain, "    "));
    }
    if (scope === "work" && section.directories.length > 0) lines.push(`  sessions under these directories are in work scope: ${section.directories.join(", ")}`);
    lines.push(pinnedLine(roster, scope), "");
  }
  return lines;
}

function describeV1(roster: RosterV1): string[] {
  const { routing } = roster;
  const lines = ["smart-router/auto in personal scope (version 1: the keywords pick the kind of run):"];
  for (const [kind, role] of [["planning", routing.planning], ["complex", routing.complex], ["default", routing.default], ["trivial", routing.trivial]] as const) {
    const target = routing.fallback.get(role);
    const after = target === undefined ? "no fallback" : `then the fallback ${modelsOf(roster, target).join(", then ")}  (role ${target})`;
    lines.push(`  ${kind.padEnd(8)} ${modelsOf(roster, role).join(", then ")}  (role ${role}${thinkingOf(roster, role)}); ${after}`);
  }
  lines.push(pinnedLine(roster, "personal"), "smart-router/auto in work scope: refused, since a version 1 roster serves no work scope", "");
  return lines;
}

/** What a valid roster routes to, for each selection and scope, in the order it tries. */
export function describeRouting(roster: Roster): string[] {
  return [
    ...(roster.version === 2 ? describeV2(roster) : describeV1(roster)),
    ...localLines(roster),
    "",
    ...accountLines(roster),
    `A usage-limit or authentication error takes a cloud model out of routing for ${roster.cooldownMinutes} minutes; a local-role model is never taken out.`,
    "This reads the roster alone. Whether each model is in Pi's catalog on this host, available and has credentials is /smart-router status's to say.",
  ];
}

/** Check a roster's text: its routing read back, or its first error with its place. */
export function checkRoster(text: string): CheckReport {
  const parsed = parseRoster(text);
  if (!parsed.ok) return { ok: false, lines: [`INVALID: ${parsed.error}`, "Both smart-router/auto and smart-router/local refuse every request while the roster is invalid."] };
  return { ok: true, lines: [`OK: a valid version ${parsed.value.version} roster.`, "", ...describeRouting(parsed.value)] };
}

/**
 * Check a roster file at an absolute path, read as the router reads its own: a regular file owned
 * by this user, writable by no one else, at most 64 KiB of UTF-8. A file the router would refuse
 * as missing or unsafe is reported so.
 */
export function checkFile(path: string, options: Pick<ReadOptions, "uid" | "fs"> = {}): CheckReport {
  const read = readUserFile(path, { maxBytes: ROSTER_MAX_BYTES, ...options });
  if (read.kind === "read") return checkRoster(read.text);
  // No previous identity is offered, so the file is never reported unchanged.
  const error = read.kind === "unchanged" ? `${path} was not read` : read.error;
  return { ok: false, lines: [`${read.kind === "missing" ? "MISSING" : read.kind === "unsafe" ? "UNSAFE" : "INVALID"}: ${error}`] };
}

export const CHECK_USAGE = "Usage: node src/check-cli.ts <roster.json>\nChecks a pi-smart-router roster without Pi, a session or credentials, and prints what it routes to.";

/**
 * The standalone checker's whole run: one roster path, already absolute. Returns the exit status:
 * 0 for a valid roster, 1 for one the router would refuse, 2 for a wrong invocation.
 */
export function runCheck(paths: readonly string[], print: (line: string) => void): number {
  const [path, ...rest] = paths;
  if (path === undefined || rest.length > 0 || path.startsWith("-")) {
    print(CHECK_USAGE);
    return 2;
  }
  const report = checkFile(path);
  print(`${path}`);
  for (const line of report.lines) print(line);
  return report.ok ? 0 : 1;
}
