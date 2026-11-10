// The request to Jev and its answer. The router never reaches the network itself: it hands a
// ClassifierContext to Pi's model registry, which makes the one HTTP attempt.
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

import { capText } from "./classify.ts";
import type { VirtualId } from "./constants.ts";
import { redact } from "./redact.ts";
import type { BoundedHistory } from "./route.ts";
import { parseRef, scopeSection } from "./roster.ts";
import type { Roster, ScopeSection } from "./roster.ts";
import type { ScopeState } from "./scope.ts";
import { closeCallTier, isTier, TIERS, type Tier } from "./tiers.ts";

export const JEV_QUESTION = "level";
export const JEV_INSTRUCTIONS =
  "How much model intelligence does `message` need for the work it asks for now? `recent` holds the conversation just before it, oldest first.";

export interface JevContextCaps {
  readonly messages: number;
  readonly messageChars: number;
  readonly totalChars: number;
}
export interface JevSettings {
  readonly model: string;
  readonly timeoutMs: number;
  readonly closeCall: number;
  readonly context: JevContextCaps;
}
export interface RecentMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** The last `limit` user and assistant messages that carry text, oldest first. */
export function recentMessages(entries: readonly unknown[], limit: number): RecentMessage[] {
  const found: RecentMessage[] = [];
  for (let i = entries.length - 1; i >= 0 && found.length < limit; i--) {
    const entry = entries[i];
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const { role, content } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(content);
    if (text.trim() === "") continue;
    found.push({ role, text });
  }
  return found.reverse();
}

function capMessage(message: string, totalChars: number): string {
  const capped = capText(message);
  if (capped.length <= totalChars) return capped;
  const tail = Math.floor(totalChars / 5) - 1;
  return `${capped.slice(0, totalChars - Math.floor(totalChars / 5))}\n${capped.slice(capped.length - tail)}`;
}

/** The classifier request: the redacted message and recent turns, and the one level question. */
export function buildContext(
  message: string,
  recent: readonly RecentMessage[],
  descriptions: Readonly<Record<Tier, string>>,
  caps: JevContextCaps,
): ClassifierContext {
  const capped = capMessage(redact(message), caps.totalChars);
  const candidates = caps.messages > 0 ? recent.slice(-caps.messages) : [];
  const kept: RecentMessage[] = [];
  let used = capped.length;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    const text = redact(candidate.text).slice(-caps.messageChars);
    if (used + text.length > caps.totalChars) break;
    used += text.length;
    kept.unshift({ role: candidate.role, text });
  }
  const criteria: Record<string, string> = {};
  for (const tier of TIERS) criteria[tier] = descriptions[tier];
  return {
    state: { message: capped, recent: kept.map(({ role, text }) => ({ role, text })) },
    questions: { [JEV_QUESTION]: { type: "choice", instructions: JEV_INSTRUCTIONS, criteria } },
  };
}

export type JevFailure = "unavailable" | "error" | "timeout" | "aborted" | "malformed";
export type JevOutcome =
  | {
      readonly kind: "answer";
      readonly model: string;
      readonly choice: Tier;
      readonly tier: Tier;
      readonly probabilities: Readonly<Record<Tier, number>>;
      readonly confidence: number;
      readonly ms: number;
    }
  | { readonly kind: "failure"; readonly model: string; readonly failure: JevFailure; readonly ms: number };

function failure(model: string, kind: JevFailure, ms: number): JevOutcome {
  return { kind: "failure", model, failure: kind, ms };
}

/** pi-ai checks the answer's types only; the labels must be exactly the four tiers here. */
export function interpret(result: ClassifierResult, closeCall: number, model: string, ms: number): JevOutcome {
  if (result.stopReason === "aborted") return failure(model, "aborted", ms);
  if (result.stopReason === "error") {
    return failure(model, /^Request timed out after \d+ms$/.test(result.errorMessage ?? "") ? "timeout" : "error", ms);
  }
  const answer = result.answers[JEV_QUESTION];
  if (answer === undefined || answer.type !== "choice" || !isTier(answer.choice) || !Number.isFinite(answer.confidence)) {
    return failure(model, "malformed", ms);
  }
  const raw = answer.probabilities;
  const keys = Object.keys(raw);
  if (keys.length !== TIERS.length || !TIERS.every((tier) => keys.includes(tier) && Number.isFinite(raw[tier]))) {
    return failure(model, "malformed", ms);
  }
  const probabilities: Record<Tier, number> = { low: raw.low!, medium: raw.medium!, high: raw.high!, super: raw.super! };
  return {
    kind: "answer",
    model,
    choice: answer.choice,
    tier: closeCallTier(probabilities, closeCall),
    probabilities,
    confidence: answer.confidence,
    ms,
  };
}

/** What the router reads at a message's input to decide whether Jev is asked about it. */
export interface JevGate {
  /** Whether the session is idle: a message that arrives while a run is under way is a steer or a follow-up. */
  readonly idle: boolean;
  /** The router model selected, if one is: only smart-router/auto routes by level. */
  readonly selection: VirtualId | undefined;
  /** Whether the session is pinned, by its entry or by PI_SMART_ROUTER_LOCAL_ONLY. */
  readonly pinned: boolean;
  /** The roster, when it loaded. */
  readonly roster: Roster | undefined;
  /** The fork's bounded session readers, through which Jev's context is read; undefined on a Pi without them. */
  readonly history: BoundedHistory | undefined;
  /** The session's scope, read fail closed. */
  readonly scope: ScopeState;
  /** Whether the message is an extension's resend of the latest message's text, which keeps that message's level. */
  readonly resend: boolean;
}

/** What Jev is asked with: the classifier's settings, the session's scope's levels, and the readers of its conversation. */
export interface JevAsk {
  readonly settings: JevSettings;
  readonly section: ScopeSection;
  readonly history: BoundedHistory;
}

/**
 * Whether Jev is asked about a message, and with what. Never for a steer or a follow-up, off
 * smart-router/auto, under the pin, without the bounded readers, for an extension's resend of the
 * latest message, without a version 2 roster's classifier, or in a scope that cannot be read or
 * that the roster does not serve. Pure: the router reads every condition first. The pin's guard
 * already refuses a pinned session's prompt on smart-router/auto; this checks the pin as well.
 */
export function jevAsk(gate: JevGate): JevAsk | undefined {
  const { roster, scope, history } = gate;
  if (!gate.idle || gate.selection !== "auto" || gate.pinned || history === undefined || gate.resend) return undefined;
  if (roster?.version !== 2 || roster.classifier === undefined || scope.kind !== "ok") return undefined;
  const section = scopeSection(roster, scope.scope);
  return section === undefined ? undefined : { settings: roster.classifier, section, history };
}

/** The part of Pi's ModelRegistry that askJev uses; tests pass a fake. */
export interface ClassifierRegistry {
  findOfType(type: "classifier", provider: string, id: string): ClassifierModel<ClassifierApi> | undefined;
  classify(
    model: ClassifierModel<ClassifierApi>,
    context: ClassifierContext,
    options: { timeoutMs: number; maxRetries: number },
  ): Promise<ClassifierResult>;
}

/** One classification attempt. Never rejects. */
export async function askJev(
  registry: ClassifierRegistry,
  settings: JevSettings,
  context: ClassifierContext,
  now: () => number,
): Promise<JevOutcome> {
  const started = now();
  const elapsed = () => now() - started;
  try {
    const ref = parseRef(settings.model);
    const model = ref === undefined ? undefined : registry.findOfType("classifier", ref.provider, ref.id);
    if (model === undefined) return failure(settings.model, "unavailable", elapsed());
    const result = await registry.classify(model, context, { timeoutMs: settings.timeoutMs, maxRetries: 0 });
    return interpret(result, settings.closeCall, settings.model, elapsed());
  } catch {
    return failure(settings.model, "error", elapsed());
  }
}
