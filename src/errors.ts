// The texts the router throws and shows. Every refusal names the virtual model, says that nothing
// was sent, gives the cause in the router's own words (never a provider's error text) and the way
// out. A model picked by hand always stays selected, so "choose a model with /model" is a way out
// of every refusal. In work scope, outside the pin, a refusal names only the models that keep the
// conversation on the work account, smart-router/auto and the work Codex models (chooseModel): it
// does not suggest sending work content anywhere else, though any model John picks is kept.
//
// Pi decides whether to retry a failed request from its error text alone, and a router refusal is
// deterministic: retrying it with backoff only delays the error. An interpolated ref or reason can
// make a text look retryable (a model id ending in -503, a reason that says "timeout"), so every
// composed text is checked with pi-ai's own classifier first, and a text it would retry is
// replaced by a fixed one without identifiers.
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { PROVIDER, VIRTUAL_API } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import type { Attempt } from "./decide.ts";
import type { Scope } from "./roster.ts";
import { tierLabel } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** An error route() throws. Pi turns it into an error response attributed to the virtual model. */
export class RouterError extends Error {}

const probe = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: VIRTUAL_API,
  provider: PROVIDER,
  model: "auto",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "error",
  errorMessage,
  timestamp: 0,
});

/** Whether Pi would retry a failed response with this error text. */
export function looksRetryable(text: string): boolean {
  return isRetryableAssistantError(probe(text));
}

/** The text thrown when a refusal's own wording would look retryable. */
export function fixedText(id: VirtualId): string {
  return `${PROVIDER}/${id}: the request cannot be routed; see /smart-router status. Nothing was sent.`;
}

/** A refusal: the virtual model and the cause, "Nothing was sent.", and the way out. */
export function refusal(id: VirtualId, cause: string, way: string): RouterError {
  const text = `${PROVIDER}/${id}: ${cause}. Nothing was sent. ${way}`;
  return new RouterError(looksRetryable(text) ? fixedText(id) : text);
}

/** The first line of an error's message, at most 300 characters. */
export function firstLine(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  return (text.split("\n", 1)[0] ?? "").slice(0, 300);
}

/**
 * How a refusal offers a model to choose by hand: any model, or, for a work session that is not
 * pinned (`work`: work scope, or a scope that cannot be read, outside the pin), only the models
 * that keep the conversation on the work account: a work Codex model when smart-router/auto
 * refused, and smart-router/auto too when smart-router/local did.
 */
function chooseModel(id: VirtualId, work: boolean): string {
  if (!work) return "choose a model with /model";
  return id === "auto" ? "choose a work Codex model with /model" : "choose smart-router/auto or a work Codex model with /model";
}

/** The way out as a sentence of its own. */
const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

// No router runs while it failed to load, so the session has no scope to name.
export function loadFailed(id: VirtualId, reason: string): RouterError {
  return refusal(id, `pi-smart-router failed to load (${reason})`, "Choose a model with /model, or fix the cause and run /reload.");
}

export function loadFailedNotice(reason: string): string {
  return `pi-smart-router failed to load: ${reason}. smart-router/auto and smart-router/local refuse every request until it loads.`;
}

/** A roster that did not load, as the file module reports it. */
export interface RosterProblem {
  readonly kind: "missing" | "unsafe" | "invalid";
  readonly path: string;
  readonly error: string;
}

function rosterCause(problem: RosterProblem): string {
  switch (problem.kind) {
    case "missing":
      return `the roster ${problem.path} does not exist`;
    case "unsafe":
      return `the roster ${problem.path} is unsafe (${problem.error})`;
    case "invalid":
      return `the roster ${problem.path} is invalid (${problem.error})`;
  }
}

/** `work`: whether the session is a work session that is not pinned (chooseModel). */
export function rosterRefusal(id: VirtualId, problem: RosterProblem, work = false): RouterError {
  const fix = problem.kind === "missing" ? "Create it as the README describes" : "Fix it and send the prompt again";
  return refusal(id, rosterCause(problem), `${fix}, or ${chooseModel(id, work)}.`);
}

export function rosterNotice(problem: RosterProblem): string {
  return `pi-smart-router: ${rosterCause(problem)}. smart-router/auto and smart-router/local refuse every request until it is fixed.`;
}

const NO_HISTORY = "this Pi has no bounded session history (getLatestCustomEntry and getRecentActiveEntries)";

export function noBoundedHistory(id: VirtualId): RouterError {
  return refusal(id, NO_HISTORY, "Run a Pi with bounded history (jwiegley/pi 1.5.0 or later), or choose a model with /model.");
}

export function historyNotice(): string {
  return `pi-smart-router: ${NO_HISTORY}, so smart-router/auto and smart-router/local refuse every request, and every session counts as pinned to local models because its pin cannot be read. Run jwiegley/pi 1.5.0 or later.`;
}

/** Why a local candidate the roster allows is refused while pinned: the recorded policy does not hold it. */
export const PIN_POLICY_CHANGED = "the roster's local role changed after this session was pinned; run /smart-router local on to accept it";

/** Shown when a resumed session is not pinned, but the session it replaced was. */
export function resumeNotice(): string {
  return "pi-smart-router: the session you left was pinned to local models, and this one is not. Run /smart-router local on to pin it.";
}

/** Shown when a fork or /new carried the pin over. */
export function carriedNotice(): string {
  return "pi-smart-router: this session is pinned to local models, as the session it came from was.";
}

/** Shown when the pin of the session a fork or /new came from could not be recorded in the new one. */
export function carryFailedNotice(reason: string): string {
  return `pi-smart-router: the session this one came from was pinned to local models, but its pin could not be recorded here (${reason}). Run /smart-router local on before you send anything.`;
}

/**
 * Both models refuse a session whose scope cannot be read: smart-router/auto always, and
 * smart-router/local outside the pin, where such a scope counts as work scope. Neither answers
 * until the scope is recorded again, so the model offered is the one smart-router/auto's refusals
 * offer, never smart-router/auto itself. `work`: whether the session is a work session that is
 * not pinned (chooseModel).
 */
export function scopeUnreadable(id: VirtualId, reason: string, work = false): RouterError {
  return refusal(
    id,
    `this session's scope cannot be read (${reason})`,
    `Record it again with /smart-router scope work or /smart-router scope personal, or ${chooseModel("auto", work)}.`,
  );
}

/**
 * smart-router/local refuses a session in work scope that is not pinned. It answers only from LAN
 * models, which are not the work account, and work scope sends them a conversation only under the
 * pin. `movable`: whether /smart-router scope personal can move the session, which the latch
 * refuses.
 */
export function localInWorkScope(movable: boolean): RouterError {
  const ways = ["Run /smart-router local on to pin the session to local models", chooseModel("local", true), ...(movable ? ["run /smart-router scope personal"] : [])];
  return refusal("local", "this session is in work scope, where smart-router/local answers only while the session is pinned to local models", `${either(ways)}.`);
}

/** A roster that does not serve a scope, as the texts name it: by its version, when that is 1. */
export function rosterNamed(version: 1 | 2): string {
  return version === 1 ? "a version 1 roster" : "the roster";
}

/** Ways out, as a refusal lists them: "a", "a, or b", "a, b, or c". */
function either(ways: readonly string[]): string {
  return ways.length < 2 ? (ways[0] ?? "") : `${ways.slice(0, -1).join(", ")}, or ${ways.at(-1) ?? ""}`;
}

/**
 * smart-router/auto refuses a session whose scope the roster does not serve: work under a version 1
 * roster, or a scope a version 2 roster has no section for. `work`: whether the session is a work
 * session that is not pinned (chooseModel); a version 1 roster binds no work account, so then no
 * model is offered. `movable`: whether /smart-router scope personal can move the session, which the
 * latch refuses; it is offered only then, and only to a work session that is not pinned.
 */
export function scopeUnserved(id: VirtualId, scope: Scope, version: 1 | 2, work = false, movable = false): RouterError {
  const ways = [
    `Give the roster a ${scope} scope${version === 1 ? " (version 2)" : ""}`,
    ...(work && movable ? ["run /smart-router scope personal"] : []),
    ...(work && version === 1 ? [] : [chooseModel(id, work)]),
  ];
  return refusal(id, `this session is in ${scope} scope, which ${rosterNamed(version)} does not serve`, `${either(ways)}.`);
}

/** Shown when the roster's work directories put a session in work scope. */
export function directoryNotice(cwd: string, directory: string): string {
  return `pi-smart-router: this session is in work scope because ${cwd} is under ${directory}.`;
}

/** Shown when the work scope the work directories give a session could not be recorded in it. */
export function directoryFailedNotice(cwd: string, directory: string, reason: string): string {
  return `pi-smart-router: this session is in work scope because ${cwd} is under ${directory}, but its scope could not be recorded (${reason}), so it stays in work scope only while the roster lists that directory.`;
}

/** Shown when a fork or /new carried the scope over. */
export function scopeCarriedNotice(scope: Scope): string {
  return `pi-smart-router: this session is in ${scope} scope, as the session it came from was.`;
}

/** Shown when the scope of the session a fork or /new came from could not be recorded in the new one. */
export function scopeCarryFailedNotice(scope: Scope, reason: string): string {
  return `pi-smart-router: the session this one came from was in ${scope} scope, but its scope could not be recorded here (${reason}). Run /smart-router scope ${scope} before you send anything.`;
}

/** Shown when a message was only a level tag: nothing is sent. */
export function tagOnlyNotice(tier: Tier): string {
  return `pi-smart-router: the message was only a ${tierLabel(tier)} tag, so nothing was sent. Put the tag at the end of a message.`;
}

const TAG_IGNORED = {
  busy: "a run is under way, and it keeps its model until it ends",
  pinned: "this session is pinned to local models",
  version: "levels need a version 2 roster",
  scope: "smart-router/auto refuses this session's scope",
} as const;

/** Why a tag cannot set its run's level: a fixed cause, or the selection when it is not smart-router/auto. */
export type TagIgnored = keyof typeof TAG_IGNORED | { readonly selection: string };

/** Shown when a tag was removed from a message but cannot set its run's level. */
export function tagIgnoredNotice(tier: Tier, why: TagIgnored): string {
  const cause = typeof why === "string" ? TAG_IGNORED[why] : `only smart-router/auto routes by level, and the selection is ${why.selection}`;
  return `pi-smart-router: the ${tierLabel(tier)} tag was removed and has no effect, because ${cause}.`;
}

/** Shown when a prompt's or a custom message's run starts and drops a tagged message's plan: the run is not that message's. */
export function unmatchedTagNotice(): string {
  return "pi-smart-router: a tagged message's level could not be matched to the run that started, so it was dropped.";
}

/** Shown when a version 2 run went to a higher tier than the one its pick started at. */
export function stepUpNotice(start: Tier, tier: Tier, modelId: string): string {
  return `pi-smart-router: no ${tierLabel(start)} model can take this run, so it goes to ${tierLabel(tier)} (${modelId}).`;
}

/** What one role's candidates said, as a refusal lists it: the first role, then each `later` one. */
function describeAttempt(attempt: Attempt, index: number, later: string): string {
  const label = index === 0 ? attempt.role : `${later} ${attempt.role}`;
  if (!attempt.exists) return `${label}: no such role in the roster`;
  if (attempt.candidates.length === 0) return `${label}: no candidates`;
  return `${label}: ${attempt.candidates.map((candidate) => `${candidate.ref}: ${candidate.detail}`).join("; ")}`;
}

export interface UnroutableContext {
  readonly localOnly: boolean;
  readonly pinned: boolean;
  /** Whether the roles after the first are a version 2 run's step-ups to higher tiers, not version 1's declared fallback. */
  readonly stepUps?: boolean;
  /** Whether the session is a work session that is not pinned (chooseModel). */
  readonly work?: boolean;
}

/** No candidate could take the request: every role tried and why, or the problem found first. */
export function unroutable(
  id: VirtualId,
  failure: { readonly attempts: readonly Attempt[]; readonly problem?: string | undefined },
  context: UnroutableContext,
): RouterError {
  const work = context.work === true;
  const unpin = context.pinned ? "run /smart-router local off" : work ? chooseModel(id, true) : "choose another model with /model";
  if (failure.problem !== undefined) {
    return refusal(id, failure.problem, `Fix the roster and send the prompt again, or ${unpin}.`);
  }
  const subject = context.localOnly ? "no local model" : "no model";
  const pinned = context.pinned ? " while this session is pinned to local models" : "";
  const later = context.stepUps === true ? "step-up" : "fallback";
  const detail = failure.attempts.map((attempt, index) => describeAttempt(attempt, index, later)).join("; ");
  const cause = `${subject} can take this request${pinned}${detail === "" ? "" : ` (${detail})`}`;
  const changed = context.pinned && failure.attempts.some((attempt) => attempt.candidates.some((candidate) => candidate.detail === PIN_POLICY_CHANGED));
  // Under the pin smart-router/auto routes only within the pin's policy, which its roles seldom
  // reach, so its way out is the model that does route there.
  const way = changed
    ? "Run /smart-router local on to accept the roster's local role, or run /smart-router local off."
    : context.pinned && id === "auto"
      ? "Choose smart-router/local with /model, or run /smart-router local off."
      : context.localOnly
        ? `Start the local model server and send the prompt again, or ${unpin}.`
        : `See /smart-router status, or ${chooseModel(id, work)}.`;
  return refusal(id, cause, way);
}

export function stale(id: VirtualId): RouterError {
  return refusal(id, "this request came through a route left by a session that has ended", "Run /reload.");
}

/** A pick that broke one of the router's own invariants: a bug, refused rather than sent. `work`: whether the session is a work session that is not pinned (chooseModel). */
export function invariant(id: VirtualId, ref: string, problem: string, work = false): RouterError {
  return refusal(id, `the router picked ${ref}, which ${problem}; this is a bug in pi-smart-router`, sentence(chooseModel(id, work)));
}
