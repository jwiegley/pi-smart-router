// The request to Jev and its answer. The router never reaches the network itself: it hands a
// ClassifierContext to Pi's model registry, which makes the one HTTP attempt.
import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";

import { capText } from "./classify.ts";
import { routesLevels } from "./constants.ts";
import type { VirtualId } from "./constants.ts";
import { isRecord } from "./files.ts";
import { DEFAULT_INSTRUCTIONS } from "./prompts.ts";
import { redact } from "./redact.ts";
import type { BoundedHistory } from "./route.ts";
import { parseRef, scopeSection } from "./roster.ts";
import type { Roster, Scope, ScopeSection } from "./roster.ts";
import type { ScopeState } from "./scope.ts";
import { isTier, TIERS, type Tier } from "./tiers.ts";

export const JEV_QUESTION = "level";
/** The built-in question, asked unless the roster gives its own instructions (src/prompts.ts). */
export const JEV_INSTRUCTIONS = DEFAULT_INSTRUCTIONS;

export interface JevContextCaps {
  readonly messages: number;
  readonly messageChars: number;
  readonly totalChars: number;
}
export interface JevSettings {
  /** The model asked in a scope that `models` does not name. */
  readonly model: string;
  /**
   * The model asked in each scope the roster names one for: the same judge on that scope's own
   * account (`openrouter-p/…` for work), so a session's text reaches only its scope's account.
   */
  readonly models?: Readonly<Partial<Record<Scope, string>>>;
  /** Ask Jev on smart-router/local too, where the roster's local section has tiers. Off unless the roster says `true`. */
  readonly local?: boolean;
  readonly timeoutMs: number;
  readonly context: JevContextCaps;
  /** The roster's own question for Jev, inline. Without it and without a file, the built-in one is asked. */
  readonly instructions?: string;
  /** The name of the prompt file that holds the roster's own question. */
  readonly instructionsFile?: string;
  /** Ask upstream v1.5.0's six fixed typed questions in the same request. Off unless the roster says `true`. */
  readonly typedJudgment?: boolean;
}
export interface RecentMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
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

export const CAPABILITY_QUESTION = "capability_deserved";
export const TASK_KIND_QUESTION = "task_kind";
export const DEEP_REASONING_QUESTION = "needs_deep_reasoning";
export const CODE_GEN_QUESTION = "code_gen";
export const TOOL_USE_QUESTION = "tool_use";
export const DESTRUCTIVE_QUESTION = "destructive";

/** Upstream's ten task kinds, in its order, each with its description. */
const TASK_KINDS = {
  plan: "Deciding what to build, sequencing work, or designing an approach before editing",
  implement: "Writing or changing code, scripts, or configuration to produce a concrete result",
  debug: "Diagnosing a failure, error, or unexpected behavior and finding its root cause",
  refactor: "Restructuring existing code without changing intended behavior",
  review: "Auditing code, a diff, a document, or a plan for problems and risks",
  research: "Searching, reading, and synthesizing external information or unfamiliar APIs",
  explain: "Answering a question or explaining how something works",
  operate: "Running commands, tooling, git, deploys, or environment setup",
  write: "Producing prose, documentation, comments, or other non-code content from scratch",
  chat: "Small talk, acknowledgements, or a request with no real work attached",
} as const;
export type TaskKind = keyof typeof TASK_KINDS;
const isTaskKind = (value: unknown): value is TaskKind => typeof value === "string" && Object.hasOwn(TASK_KINDS, value);

/**
 * Upstream v1.5.0's six typed questions (src/domain/judgment/questions.ts at f22cbe9e), asked in
 * the same request as the level question when the roster says so. Their wording is upstream's,
 * with its state keys `latest_user_message` and `recent_activity` renamed to this request's
 * `message` and `recent`, and its `session` key, which this request does not send, left out.
 * Fixed in code: no roster text or prompt file reaches them. The router acts on three,
 * `capability_deserved`, `destructive` and `task_kind` (John, 2026-11-23); the other three are
 * recorded and decide nothing, since Pi's catalog has none of the capability scores upstream
 * compares them with.
 */
const TYPED_QUESTIONS: ClassifierContext["questions"] = {
  [TASK_KIND_QUESTION]: {
    type: "choice",
    instructions:
      "Which single kind of work does `message` ask for? Judge the work the user wants done, not the topic they mention. Read `recent` when the request is a short follow-up that only makes sense in context. Pick the closest kind even when the request is ambiguous.",
    criteria: { ...TASK_KINDS },
  },
  [CAPABILITY_QUESTION]: {
    type: "score",
    instructions:
      "Setting price aside entirely, how much model capability does this request deserve to get a good outcome? Judge by stakes, difficulty, and how much a stronger model would measurably improve the result.",
    criteria: [
      "Minimal: any fast small model answers this just as well",
      "Standard: a competent mid-tier model is enough",
      "High: a strong frontier model materially improves the outcome",
      "Maximum: correctness matters more than cost; use the best available",
    ],
  },
  [DEEP_REASONING_QUESTION]: {
    type: "bool",
    instructions:
      "Does answering `message` well require extended multi-step reasoning (algorithm design, subtle debugging, proof, careful long-horizon planning) rather than recall, lookup, or a short direct edit?",
    criteria: { true: "The work hinges on reasoning through non-obvious steps or edge cases", false: "The work is recall, lookup, formatting, or a short direct change" },
  },
  [CODE_GEN_QUESTION]: {
    type: "score",
    instructions: "How much code or configuration must be written or modified to satisfy `message` well?",
    criteria: [
      "None: no code or configuration is written or modified",
      "Small: a short snippet, single-line change, or simple config value",
      "Moderate: a function, test, or file-scale change using familiar patterns",
      "Substantial: multi-file or architecturally significant code generation",
    ],
  },
  [TOOL_USE_QUESTION]: {
    type: "score",
    instructions: "How much tool execution (shell, file, search, or agentic tool calls) does satisfying `message` require? Use `recent` to judge whether a tool loop is already underway.",
    criteria: [
      "None: the answer needs no tool execution",
      "Light: at most a couple of simple read-only tool calls",
      "Moderate: several tool calls or state-changing commands in a known sequence",
      "Heavy: long agentic tool loops, orchestration across many calls, or recovery from tool failures",
    ],
  },
  [DESTRUCTIVE_QUESTION]: {
    type: "bool",
    instructions: "Could satisfying `message` destroy, overwrite, or irreversibly modify data, state, or history?",
    criteria: {
      true: "The request could delete, overwrite, or irreversibly modify data, state, or history (e.g. recursive deletes, force pushes, dropped tables, branch resets, mass edits without a checkpoint)",
      false: "The request is read-only, additive, or easily reversible",
    },
  },
};

export type TypedScore = 0 | 1 | 2 | 3;
/** A scored answer: 0 to 3, and the judge's confidence in it. */
export interface Scored {
  readonly score: TypedScore;
  readonly confidence: number;
}

/** The typed answers that were well formed, each on its own: a missing or malformed one is absent, and changes nothing. */
export interface TypedJudgment {
  /** `capability_deserved`: 0 to 3 are LOW to SUPER. */
  readonly capability?: Scored;
  readonly taskKind?: { readonly kind: TaskKind; readonly confidence: number };
  /** The probability that the request is destructive. */
  readonly destructive?: number;
  /** Recorded only. */
  readonly deepReasoning?: number;
  readonly codeGen?: Scored;
  readonly toolUse?: Scored;
}

/** Upstream's TYPED_JUDGMENT_DESTRUCTIVE_THRESHOLD: at or above it a request counts as destructive. */
export const DESTRUCTIVE_THRESHOLD = 0.7;
/** Upstream's PLANNING_TASK_KINDS: the kinds a confident judgment makes a planning turn of. */
const PLANNING_KINDS: ReadonlySet<TaskKind> = new Set(["plan", "debug", "review"]);

const unit = (value: unknown): value is number => typeof value === "number" && value >= 0 && value <= 1;

function scored(answer: ClassifierResult["answers"][string] | undefined): Scored | undefined {
  if (answer?.type !== "score") return undefined;
  const { score, confidence } = answer;
  return (score === 0 || score === 1 || score === 2 || score === 3) && unit(confidence) ? { score, confidence } : undefined;
}

function probability(answer: ClassifierResult["answers"][string] | undefined): number | undefined {
  return answer?.type === "bool" && unit(answer.probability) ? answer.probability : undefined;
}

function typedOf(answers: ClassifierResult["answers"]): TypedJudgment | undefined {
  const kind = answers[TASK_KIND_QUESTION];
  const judged = {
    capability: scored(answers[CAPABILITY_QUESTION]),
    taskKind: kind?.type === "choice" && isTaskKind(kind.choice) && unit(kind.confidence) ? { kind: kind.choice, confidence: kind.confidence } : undefined,
    destructive: probability(answers[DESTRUCTIVE_QUESTION]),
    deepReasoning: probability(answers[DEEP_REASONING_QUESTION]),
    codeGen: scored(answers[CODE_GEN_QUESTION]),
    toolUse: scored(answers[TOOL_USE_QUESTION]),
  };
  const kept = Object.fromEntries(Object.entries(judged).filter(([, value]) => value !== undefined)) as TypedJudgment;
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** The typed answers of an outcome, when it has any. */
export const typedJudgment = (jev: JevOutcome | undefined): TypedJudgment | undefined => (jev?.kind === "answer" ? jev.typed : undefined);

/** Whether the typed judgment calls the request destructive (upstream's local-zero gate; here it applies the risky floor). */
export function judgedDestructive(jev: JevOutcome | undefined): boolean {
  const p = typedJudgment(jev)?.destructive;
  return p !== undefined && p >= DESTRUCTIVE_THRESHOLD;
}

/**
 * Whether a prompt counts as planning for its demand, upstream's resolveTurnType
 * (turn-envelope-stage.ts at f22cbe9e): a task kind of plan, debug or review at `minConfidence` or
 * above makes it planning. The judgment never makes a planning prompt not one: upstream allows
 * that only when its host gave no turn type, and its host always gives one. The thinking effort
 * does not read this: upstream's adaptive reasoning takes the host's turn type, not the judged one.
 */
export function judgedPlanning(jev: JevOutcome | undefined, minConfidence: number, words: boolean): boolean {
  const task = typedJudgment(jev)?.taskKind;
  return words || (task !== undefined && task.confidence >= minConfidence && PLANNING_KINDS.has(task.kind));
}

/**
 * The classifier request: the redacted message and recent turns, and the one level question.
 * `instructions` and `descriptions` are the only parts John's prompts supply. The request's shape
 * is fixed here whatever they say: one question, named `level`, a choice whose labels are exactly
 * the four tiers.
 */
export function buildContext(
  message: string,
  recent: readonly RecentMessage[],
  descriptions: Readonly<Record<Tier, string>>,
  caps: JevContextCaps,
  instructions: string = JEV_INSTRUCTIONS,
  typed = false,
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
  // John's prompts are redacted like the message: a prompt file can be a link to any file he owns,
  // and whatever it holds, no secret shape in it reaches Jev. The built-in text has none.
  const criteria: Record<string, string> = {};
  for (const tier of TIERS) criteria[tier] = redact(descriptions[tier]);
  return {
    state: { message: capped, recent: kept.map(({ role, text }) => ({ role, text })) },
    questions: { [JEV_QUESTION]: { type: "choice", instructions: redact(instructions), criteria }, ...(typed ? TYPED_QUESTIONS : {}) },
  };
}

/** Why Jev gave no answer. `prompt`: one of the roster's prompt files cannot be used, so Jev was not asked. */
export type JevFailure = "unavailable" | "error" | "timeout" | "aborted" | "malformed" | "prompt";
export type JevOutcome =
  | {
      readonly kind: "answer";
      readonly model: string;
      /** Jev's top choice. The level comes from the demand, which reads all four probabilities. */
      readonly choice: Tier;
      readonly probabilities: Readonly<Record<Tier, number>>;
      readonly confidence: number;
      readonly ms: number;
      /** The typed answers, when the roster asked for them and any was well formed. */
      readonly typed?: TypedJudgment;
    }
  | { readonly kind: "failure"; readonly model: string; readonly failure: JevFailure; readonly ms: number };

function failure(model: string, kind: JevFailure, ms: number): JevOutcome {
  return { kind: "failure", model, failure: kind, ms };
}

/** pi-ai checks the answer's types only; the labels must be exactly the four tiers here. */
export function interpret(result: ClassifierResult, model: string, ms: number, typed = false): JevOutcome {
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
  const judged = typed ? typedOf(result.answers) : undefined;
  return { kind: "answer", model, choice: answer.choice, probabilities, confidence: answer.confidence, ms, ...(judged === undefined ? {} : { typed: judged }) };
}

/** What the router reads at a message's input to decide whether Jev is asked about it. */
export interface JevGate {
  /** Whether the session is idle: a message that arrives while a run is under way is a steer or a follow-up. */
  readonly idle: boolean;
  /** The router model selected, if one is: only smart-router/auto asks Jev. */
  readonly selection: VirtualId | undefined;
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

/** The model Jev is asked through in a scope: that scope's own, else the shared one. */
export function jevModel(settings: JevSettings, scope: Scope): string {
  return settings.models?.[scope] ?? settings.model;
}

/**
 * Whether Jev is asked about a message, and with what. Never for a steer or a follow-up, off the
 * router's models, without the bounded readers, for an extension's resend of the latest message,
 * without a version 2 roster's classifier, or in a scope that cannot be read or that the roster
 * does not serve. On smart-router/local only when the roster's classifier says `local` and its
 * local section has tiers. The settings it gives name the session's scope's model. Pure: the
 * router reads every condition first.
 */
export function jevAsk(gate: JevGate): JevAsk | undefined {
  const { roster, scope, history } = gate;
  if (!gate.idle || gate.selection === undefined || history === undefined || gate.resend) return undefined;
  if (roster?.version !== 2 || roster.classifier === undefined || scope.kind !== "ok") return undefined;
  if (!routesLevels(gate.selection) && !(roster.classifier.local === true && roster.local?.levels !== undefined)) return undefined;
  const section = scopeSection(roster, scope.scope);
  if (section === undefined) return undefined;
  return { settings: { ...roster.classifier, model: jevModel(roster.classifier, scope.scope) }, section, history };
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
    return interpret(result, settings.model, elapsed(), settings.typedJudgment === true);
  } catch {
    return failure(settings.model, "error", elapsed());
  }
}
