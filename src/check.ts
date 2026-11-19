// The roster checker: what a roster will route to, read back in plain language, or its first error
// with the place it is at. /smart-router check prints it for the roster a session has loaded, and
// src/check-cli.ts prints it for any file, without Pi, a session or a credential.
//
// It judges the roster's text, with the parser the router routes by (parseRoster), and the prompt
// files the roster names, with the checks the router makes of them (src/prompts.ts); the orders it
// prints are the ones routing uses (candidatesOf). It knows no catalog, so it cannot say
// whether a model exists, is reachable or has credentials on a host: /smart-router status does.
// Nothing here sends anything, and nothing here imports Pi.
import { dirname } from "node:path";

import { ROSTER_MAX_BYTES } from "./constants.ts";
import { readUserFile } from "./files.ts";
import type { ReadOptions } from "./files.ts";
import { promptLines, promptProblem, promptReader, promptUses } from "./prompts.ts";
import type { PromptReader, PromptUse } from "./prompts.ts";
import { candidatesOf, parseRoster, SCOPES, unreachableMinutesOf } from "./roster.ts";
import type { Roster, RosterV1, RosterV2 } from "./roster.ts";
import { DEEP_SESSION_ENTRIES, DEEP_SESSION_TOKENS, DEFAULT_EFFORT, SIGNALS } from "./settings.ts";
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

/** What smart-router/local routes to. */
function localLines(roster: Roster): string[] {
  const role = roster.local?.role;
  if (role === undefined) return ["smart-router/local, in any scope:", "  refused: the roster has no local section"];
  return [
    "smart-router/local, in any scope: only these, in this order, never a cloud model:",
    ...numbered(roster, modelsOf(roster, role).map((ref) => ({ role, ref })), "  "),
    `  local means: a provider of ${roster.local?.providers.join(", ")} whose base URL is on ${roster.local?.hosts.join(", ")}`,
  ];
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
    const decides = roster.classifier === undefined ? "the demand the heuristics give" : `the demand from Jev (${roster.classifier.model}) and the heuristics`;
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
    lines.push("");
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
  lines.push("smart-router/auto in work scope: refused, since a version 1 roster serves no work scope", "");
  return lines;
}

/** Where Jev's instructions and each level's description come from; nothing for a roster that never asks Jev. */
function promptSection(roster: Roster, uses: readonly PromptUse[]): string[] {
  if (roster.version !== 2) return [];
  if (roster.classifier === undefined && uses.every((use) => use.source !== "file")) return [];
  const asked = roster.classifier === undefined ? " (no classifier section, so Jev is never asked and these are not used)" : "";
  return [`Jev's prompts${asked}: the question it is asked, and what each level means:`, ...promptLines(uses), ""];
}

/** A share as a percentage, without the noise of floating point. */
const percent = (share: number): string => `${Math.round(share * 10_000) / 100}%`;

/** A time as whole hours, else whole minutes, else seconds. */
function duration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** How a prompt's demand is weighed, in words. */
function demandLines(roster: RosterV2): string[] {
  const { jevWeight, heuristicsWeight, minConfidence, closeCall, cuts, deepSessionFloor, weights } = roster.demand;
  const [low, medium, high] = cuts;
  const listed = SIGNALS.map((signal) => [signal, weights[signal]] as const).sort((a, b) => b[1] - a[1]);
  return [
    `Demand: Jev's answer counts ${jevWeight} and the heuristics ${heuristicsWeight} at full confidence; under ${percent(minConfidence)} confidence the heuristics can only raise the level.`,
    `  LOW under ${low}, MEDIUM under ${medium}, HIGH under ${high}, SUPER from there; within ${closeCall} under a cut takes the level above.`,
    `  A conversation over ${DEEP_SESSION_TOKENS.toLocaleString("en-US")} tokens or ${DEEP_SESSION_ENTRIES.toLocaleString("en-US")} entries is never under ${tierLabel(deepSessionFloor)}.`,
    `  Heuristic weights: ${listed.map(([signal, weight]) => `${signal} ${weight}`).join(", ")}.`,
  ];
}

/** When a session moves to another model, in words. */
function switchingLines(roster: RosterV2): string[] {
  const { margin, horizonCap, cacheSurvival } = roster.switching;
  const table = cacheSurvival.map(([seconds, chance]) => `${percent(chance)} up to ${duration(seconds)}`);
  return [
    `Switching: a move must cost more than ${percent(margin)} less than staying; lighter prompts in a row are priced up to ${horizonCap} runs ahead.`,
    `  A model's cache is taken to survive ${table.join(", ")}, and not after.`,
  ];
}

/**
 * What thinking effort each request carries, in words: upstream's adaptive reasoning (src/effort.ts),
 * with the roster's floor, ceiling and off switch; a version 1 roster has upstream's defaults, and
 * neither SUPER nor a run that moves up.
 */
function effortLines(roster: Roster): string[] {
  const settings = roster.version === 2 ? roster.adaptiveReasoning : DEFAULT_EFFORT;
  if (!settings.enabled) return ["Thinking effort: adaptiveReasoning is off, so every request carries the selected /thinking level, or its role's fixed one."];
  const table =
    roster.version === 2
      ? "minimal after a tool result, low for an ordinary turn, medium for planning, and high on SUPER or in a run that moved up"
      : "minimal after a tool result, low for an ordinary turn and medium for planning";
  const { minLevel, maxLevel } = settings;
  const bounds =
    minLevel === undefined && maxLevel === undefined
      ? "No floor and no ceiling."
      : minLevel !== undefined && maxLevel !== undefined
        ? `Floor ${minLevel}, ceiling ${maxLevel}: the levels the turn gives are raised to the floor and capped at the ceiling.`
        : minLevel !== undefined
          ? `Floor ${minLevel}; no ceiling: the levels the turn gives are raised to the floor.`
          : `No floor; ceiling ${maxLevel}: the levels the turn gives are capped at the ceiling.`;
  return [
    `Thinking effort, as upstream's adaptive reasoning: while /thinking is medium (Pi's default) or off, ${table}; any other /thinking level is never lowered, and is raised when the turn asks for more.`,
    `  ${bounds} A role that fixes its thinking keeps it. A change of effort costs that model's cache.`,
  ];
}

/** Why the settings a roster may give and this version ignores are ignored, by path. */
const IGNORED_BECAUSE: Readonly<Record<string, string>> = {
  stickyIdleMinutes: "nothing holds a session on a model by time.",
  "classifier.closeCall": "demand.closeCall decides a close call.",
};

/** One line for each setting the roster gives that is accepted and ignored. */
const ignoredLines = (roster: Roster): string[] =>
  roster.ignored.map((path) => {
    const because = IGNORED_BECAUSE[path];
    return because === undefined ? `${path} is accepted and ignored.` : `${path} is accepted and ignored: ${because}`;
  });

/**
 * What a valid roster routes to, for each selection and scope, in the order it tries, and where
 * Jev's prompts come from. `uses`: a version 2 roster's prompts as they are in effect.
 */
export function describeRouting(roster: Roster, uses: readonly PromptUse[] = []): string[] {
  return [
    ...(roster.version === 2 ? describeV2(roster) : describeV1(roster)),
    ...(roster.version === 2 ? [...demandLines(roster), ...switchingLines(roster)] : []),
    ...effortLines(roster),
    "",
    ...localLines(roster),
    "",
    ...promptSection(roster, uses),
    ...accountLines(roster),
    `A usage-limit or authentication error takes a cloud model out of routing for ${roster.cooldownMinutes} minutes, and with it every model of the same subscription account; a local-role model is never taken out.`,
    `A local model whose server cannot be reached is passed over for ${unreachableMinutesOf(roster)} minutes while another model in the order above can take the request.`,
    ...ignoredLines(roster),
    "This reads the roster alone. Whether each model is in Pi's catalog on this host, available and has credentials is /smart-router status's to say.",
  ];
}

/**
 * Check a roster's text: its routing read back, or its first error with its place. With `read`,
 * the prompt files it names are checked too; a prompt that cannot be used leaves the roster valid
 * and its routes in force, but fails the check, since Jev is then not asked.
 */
export function checkRoster(text: string, read?: PromptReader): CheckReport {
  const parsed = parseRoster(text);
  if (!parsed.ok) return { ok: false, lines: [`INVALID: ${parsed.error}`, "Both smart-router/auto and smart-router/local refuse every request while the roster is invalid."] };
  const uses = parsed.value.version === 2 ? promptUses(parsed.value, read) : [];
  const problem = promptProblem(uses);
  const routing = describeRouting(parsed.value, uses);
  if (problem !== undefined) return { ok: false, lines: [`PROMPT NOT USABLE: ${problem}`, `The roster itself is a valid version ${parsed.value.version} roster, and it routes:`, "", ...routing] };
  return { ok: true, lines: [`OK: a valid version ${parsed.value.version} roster.`, "", ...routing] };
}

/**
 * Check a roster file at an absolute path, read as the router reads its own: a regular file owned
 * by this user, writable by no one else, at most 64 KiB of UTF-8. A file the router would refuse
 * as missing or unsafe is reported so. The prompt files it names are looked for where the router
 * would find them were this the roster in use: in the directory smart-router/ beside it.
 */
export function checkFile(path: string, options: Pick<ReadOptions, "uid" | "fs" | "anyOwner"> = {}): CheckReport {
  const read = readUserFile(path, { maxBytes: ROSTER_MAX_BYTES, ...options });
  if (read.kind === "read") return checkRoster(read.text, promptReader(dirname(path), options));
  // No previous identity is offered, so the file is never reported unchanged.
  const error = read.kind === "unchanged" ? `${path} was not read` : read.error;
  return { ok: false, lines: [`${read.kind === "missing" ? "MISSING" : read.kind === "unsafe" ? "UNSAFE" : "INVALID"}: ${error}`] };
}

export const CHECK_USAGE =
  "Usage: node src/check-cli.ts [--no-owner-check] <roster.json>\n" +
  "Checks a pi-smart-router roster without Pi, a session or credentials, and prints what it routes to.\n" +
  "--no-owner-check accepts a roster and prompt files that another user owns, as in the Nix store; the router itself never does.";
const NO_OWNER_CHECK = "--no-owner-check";

/**
 * The standalone checker's whole run: one roster path, already absolute, and before it, if at all,
 * --no-owner-check. Returns the exit status: 0 for a valid roster, 1 for one the router would
 * refuse, 2 for a wrong invocation.
 */
export function runCheck(args: readonly string[], print: (line: string) => void, options: Pick<ReadOptions, "uid" | "fs"> = {}): number {
  const anyOwner = args[0] === NO_OWNER_CHECK;
  const [path, ...rest] = anyOwner ? args.slice(1) : args;
  if (path === undefined || rest.length > 0 || path.startsWith("-")) {
    print(CHECK_USAGE);
    return 2;
  }
  const report = checkFile(path, { ...options, anyOwner });
  print(`${path}`);
  if (anyOwner) print("Checked without the owner check: the router itself reads only files you own.");
  for (const line of report.lines) print(line);
  return report.ok ? 0 : 1;
}
