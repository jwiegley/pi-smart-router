// The behaviour harness: Pi 1.5's own runtime from npm, with faux providers, and the router loaded
// from index.ts the way Pi loads any extension (DefaultResourceLoader, through jiti). Test-only;
// never shipped. It runs only sandboxed: test/behaviour.test.ts imports ./sandboxed.ts first.
//
// Each test builds a World: a fresh directory under the run's isolated TMPDIR with its own agent
// directory (PI_CODING_AGENT_DIR, absolute, holding the roster and Multi-Pass's labels), an empty
// working directory, a session directory, a fleet of faux providers and a trace. Every Pi it starts
// is an AgentSessionRuntime whose factory calls createAgentSessionServices and then
// createAgentSessionFromServices, so virtual registrations are flushed before a session is
// restored, and each session replacement (/new, a fork, a resume) gets fresh services, a fresh
// ModelRuntime and a fresh load of the router, as Pi's own lifecycle does. Isolation follows the
// design (§8.1): the ModelRuntime reads auth only from <world>/agent/auth.json, has no models.json
// and never refreshes over the network; settings live in memory; the resource loader discovers no
// extensions, skills, prompt templates, themes or context files.
//
// Pi from npm, 1.5.2 like 1.5.0, lacks jwiegley/pi's bounded session reads, which the router
// requires. They are installed on SessionManager.prototype as the fork's own fallbacks behave
// (packages/coding-agent/src/core/session-manager.ts), as pi-flag's harness does.
//
// The faux providers answer in memory. Unlike Pi's stock faux provider, each one calls `onPayload`
// with the payload it would send, as Pi's real chat APIs do, and records what it would have sent,
// so the payload barrier can be observed; a provider marked `ignoresAbort` also streams on after
// an abort, as Codex's reused WebSocket does. A provider serves one model, or several, as a Codex
// account does. Every call is appended to the world's trace, next to what a
// pi-cache-optimizer-shaped probe resolved through the routing registry at the same hooks.
//
// Jev is faked too: a classifier provider, jev-fake, registered with every ModelRuntime after the
// faux providers through pi-ai's provider `classifiers` hook, so the router reaches it as it reaches
// OpenRouter's Jev, through Pi's model registry. It answers from memory, logs every call, and keeps
// a call's deadline and abort signal as pi-ai does.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { createFauxCore, createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierResult,
  FauxResponseFactory,
  Model,
  Provider,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionUIContext,
  InlineExtension,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { ENV_PIN, ENV_SCOPE, ROUTING_REGISTRY_KEY, SLOT_KEY } from "../../src/constants.ts";
import { ensureRoutingRegistry, resolveActiveRoute } from "./co.ts";
import type { Snapshot } from "./co.ts";

export type Settings = NonNullable<Parameters<typeof SettingsManager.inMemory>[0]>;

/** The router's entry, which Pi loads as an extension file. */
export const ROUTER_ENTRY = fileURLToPath(new URL("../../index.ts", import.meta.url));
/** An extension that keeps switching the selection to codex-like/m. */
export const COMPETITOR_ENTRY = fileURLToPath(new URL("./competitor.ts", import.meta.url));

// ─── The fork's bounded session reads ────────────────────────────────────────

const BOUNDED_READERS = ["getLatestCustomEntry", "getLatestMessage", "getRecentActiveEntries"] as const;

interface RecentFilter {
  readonly type?: string;
  readonly customType?: string;
  readonly messageRole?: string;
  readonly limit?: number;
  readonly stopBeforeId?: string;
}

const customTypeOf = (entry: SessionEntry): string | undefined =>
  entry.type === "custom" || entry.type === "custom_message" ? entry.customType : undefined;

const boundedReaders: Record<(typeof BOUNDED_READERS)[number], unknown> = {
  getLatestCustomEntry(this: SessionManager, customType: string, options?: { scope?: "all" | "active" }): SessionEntry | undefined {
    const entries = options?.scope === "active" ? this.getBranch() : this.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry !== undefined && customTypeOf(entry) === customType) return entry;
    }
    return undefined;
  },
  getLatestMessage(this: SessionManager, role?: string, options?: { scope?: "all" | "active" }): SessionEntry | undefined {
    const entries = options?.scope === "active" ? this.getBranch() : this.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type === "message" && (role === undefined || entry.message.role === role)) return entry;
    }
    return undefined;
  },
  getRecentActiveEntries(this: SessionManager, options: RecentFilter = {}): SessionEntry[] {
    const branch = this.getBranch();
    const stop = options.stopBeforeId === undefined ? -1 : branch.findIndex((entry) => entry.id === options.stopBeforeId);
    return branch
      .slice(stop >= 0 ? stop + 1 : 0)
      .filter((entry) => {
        if (options.type !== undefined && entry.type !== options.type) return false;
        if (options.customType !== undefined && customTypeOf(entry) !== options.customType) return false;
        if (options.messageRole !== undefined && (entry.type !== "message" || entry.message.role !== options.messageRole)) return false;
        return true;
      })
      .slice(-Math.max(1, Math.min(options.limit ?? 256, 4096)));
  },
};

const prototype = SessionManager.prototype as unknown as Record<string, unknown>;

/** Give npm's SessionManager the fork's bounded reads. */
function installBoundedReaders(): void {
  for (const name of BOUNDED_READERS) prototype[name] = boundedReaders[name];
}

/** Take them away again, as upstream Pi 1.5.0 is; returns a function that puts them back. */
export function withoutBoundedReaders(): () => void {
  for (const name of BOUNDED_READERS) delete prototype[name];
  return installBoundedReaders;
}

installBoundedReaders();

// ─── Faux providers ──────────────────────────────────────────────────────────

/** A model of a faux provider that serves several: its id, and limits of its own. */
export interface FauxModel {
  readonly id: string;
  /** The spec's limits unless given. */
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface FauxSpec {
  readonly provider: string;
  /** The model id; "m" by default. */
  readonly id?: string;
  /** The models it serves instead of the one `id` names, the first standing for the provider; each takes the spec's settings. */
  readonly models?: ReadonlyArray<string | FauxModel>;
  readonly api?: string;
  /** Never contacted. Cloud providers default to https://<provider>.invalid/v1. */
  readonly baseUrl?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  readonly promptCache?: Model<Api>["promptCache"];
  readonly cost?: Model<Api>["cost"];
  /** Stream to the end after an abort, as Codex's reused WebSocket sends without looking at the signal. */
  readonly ignoresAbort?: boolean;
}

/** One request a faux provider received. */
export interface FauxCall {
  readonly provider: string;
  /** The model it asked for, as provider/id. */
  readonly ref: string;
  readonly sessionId: string | undefined;
  readonly maxTokens: number | undefined;
  readonly reasoning: string | undefined;
  /** The text of the request's system messages and of its last user message. */
  readonly system: string;
  readonly lastUser: string;
  /** Whether it asks for one of Pi's summaries (compaction, branch summary) rather than a turn. */
  readonly summary: boolean;
  /** What the provider would have sent once `onPayload` ran: null when a handler emptied it. */
  payload: unknown;
}

/** A scripted reply: a message, or a function of the call that returns one. */
export type FauxStep = AssistantMessage | ((call: FauxCall) => AssistantMessage | Promise<AssistantMessage>);

const NOT_SENT = Symbol("not sent yet");

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: unknown) => (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

export class Faux {
  readonly spec: FauxSpec;
  /** The provider's first model, which stands for it, and its ref. */
  readonly ref: string;
  readonly model: Model<Api>;
  /** Every model it serves, by id. */
  readonly models: ReadonlyMap<string, Model<Api>>;
  readonly provider: Provider;
  readonly calls: FauxCall[] = [];
  readonly #core: ReturnType<typeof createFauxCore>;
  readonly #callOf = new WeakMap<object, FauxCall>();

  constructor(spec: FauxSpec, trace: TraceEntry[]) {
    this.spec = spec;
    const served = (spec.models ?? [spec.id ?? "m"]).map((entry): FauxModel => (typeof entry === "string" ? { id: entry } : entry));
    if (served.length === 0) throw new Error(`faux provider ${spec.provider} serves no model`);
    this.#core = createFauxCore({
      provider: spec.provider,
      api: spec.api ?? `faux-${spec.provider}`,
      models: served.map((entry) => ({
        id: entry.id,
        reasoning: spec.reasoning ?? false,
        contextWindow: entry.contextWindow ?? spec.contextWindow ?? 128_000,
        maxTokens: entry.maxTokens ?? spec.maxTokens ?? 16_384,
        ...(spec.cost === undefined ? {} : { cost: spec.cost }),
      })),
    });
    const models = this.#core.models as Array<Model<Api>>;
    for (const model of models) {
      model.baseUrl = spec.baseUrl ?? `https://${spec.provider}.invalid/v1`;
      if (spec.thinkingLevelMap !== undefined) model.thinkingLevelMap = spec.thinkingLevelMap;
      if (spec.promptCache !== undefined) model.promptCache = spec.promptCache;
    }
    this.model = models[0] as Model<Api>;
    this.ref = `${spec.provider}/${this.model.id}`;
    this.models = new Map(models.map((model) => [model.id, model]));
    const stream = (requestModel: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream => {
      const messages = context.messages;
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => textOf(message.content))
        .join("\n");
      const call: FauxCall = {
        provider: spec.provider,
        ref: `${spec.provider}/${requestModel.id}`,
        sessionId: options?.sessionId,
        maxTokens: options?.maxTokens,
        reasoning: options?.reasoning,
        system,
        lastUser: textOf(lastUser?.content),
        summary: /context summarization assistant/.test(system),
        payload: NOT_SENT,
      };
      this.calls.push(call);
      trace.push({ kind: "call", call });
      const { signal, ...rest } = options ?? {};
      const forwarded: SimpleStreamOptions = spec.ignoresAbort === true || signal === undefined ? rest : { ...rest, signal };
      this.#callOf.set(forwarded, call);
      if (this.#core.getPendingResponseCount() === 0) this.respond(fauxAssistantMessage(`ok from ${call.ref}`));
      return this.#core.stream(requestModel, context, forwarded);
    };
    this.provider = createProvider({
      id: spec.provider,
      auth: { apiKey: { name: spec.provider, resolve: async () => ({ auth: {} }) } },
      models: this.#core.models,
      api: { stream, streamSimple: stream },
    });
  }

  get callCount(): number {
    return this.#core.state.callCount;
  }

  /** Queue scripted replies, which any of its models' requests take in turn. Each sends its payload first; once they run out, the provider says "ok from <ref>". */
  respond(...steps: FauxStep[]): void {
    this.#core.appendResponses(
      steps.map((step): FauxResponseFactory => async (context, options, _state, model) => {
        const call = options === undefined ? undefined : this.#callOf.get(options);
        const payload = { model: model.id, messages: context.messages.length, max_output_tokens: options?.maxTokens, input: call?.lastUser };
        const replaced = options?.onPayload === undefined ? undefined : await options.onPayload(payload, model);
        if (call !== undefined) call.payload = replaced === undefined ? payload : replaced;
        if (typeof step !== "function") return step;
        if (call === undefined) throw new Error(`${this.ref}: a reply without its call`);
        return step(call);
      }),
    );
  }

  /** The calls of session requests (not summaries) of a session. */
  sessionCalls(sessionId: string): FauxCall[] {
    return this.calls.filter((call) => call.sessionId === sessionId);
  }
}

/** An error reply, as a provider sends one. */
export function failure(errorMessage: string): AssistantMessage {
  return fauxAssistantMessage([], { stopReason: "error", errorMessage });
}

/** A reply that waits for `release()`; `started` resolves when the request arrives. */
export function gate(): { readonly started: Promise<void>; readonly step: FauxStep; release(): void } {
  let markStarted = (): void => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let release = (): void => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    step: async (call) => {
      markStarted();
      await released;
      return fauxAssistantMessage(`ok from ${call.ref}, late`);
    },
    release: () => release(),
  };
}

// ─── The fake classifier ─────────────────────────────────────────────────────

/** One classification the fake classifier received. */
export interface JevCall {
  readonly context: ClassifierContext;
  /** One attempt's deadline and the retries, as the request's options carried them to the provider. */
  readonly timeoutMs: number | undefined;
  readonly maxRetries: number | undefined;
  /** What it answered; undefined while it waits. */
  result: ClassifierResult | undefined;
}

/** A scripted classification: a result for the call's questions, or none at all. */
type JevStep = ((context: ClassifierContext, model: ClassifierModel<ClassifierApi>) => ClassifierResult) | "hang";

/**
 * A fake Jev: the provider jev-fake, whose one classifier model, jev, answers from memory. Each call
 * takes the next scripted step, and fails once they run out. Like pi-ai's own classifiers, a call
 * gives up at its `timeoutMs`, one attempt's deadline, with pi-ai's "Request timed out after <ms>ms"
 * error, and when its `signal` aborts, with an aborted result. Every call is logged in `calls`.
 */
export class FakeJev {
  readonly model: ClassifierModel<ClassifierApi>;
  readonly provider: Provider;
  readonly calls: JevCall[] = [];
  readonly #steps: JevStep[] = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    this.model = {
      type: "classifier",
      id: "jev",
      name: "Jev (fake)",
      api: "jev-fake-api",
      provider: "jev-fake",
      baseUrl: "https://jev-fake.invalid/v1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262_144,
    };
    this.provider = createProvider({
      id: "jev-fake",
      auth: { apiKey: { name: "jev-fake", resolve: async () => ({ auth: {} }) } },
      models: [this.model],
      classifiers: { "jev-fake-api": { classify: (model, context, options) => this.#classify(model, context, options) } },
    });
  }

  /** Answer the next call's every question with these probabilities, and the most probable label unless `choice` names another. */
  answer(probabilities: Readonly<Record<string, number>>, choice?: string): void {
    const chosen = choice ?? Object.keys(probabilities).sort((a, b) => (probabilities[b] ?? 0) - (probabilities[a] ?? 0))[0] ?? "";
    this.#steps.push((context, model) => {
      const answer: ClassifierAnswer = { type: "choice", choice: chosen, probabilities: { ...probabilities }, confidence: probabilities[chosen] ?? 0 };
      return { ...classifierResult(model, "stop"), answers: Object.fromEntries(Object.keys(context.questions).map((id) => [id, answer])) };
    });
  }

  /** Fail the next call, as pi-ai reports a service's error, OpenRouter's refusal included. */
  fail(errorMessage: string): void {
    this.#steps.push((_context, model) => classifierResult(model, "error", errorMessage));
  }

  /** Leave the next call unanswered: only its deadline or its signal ends it. */
  hang(): void {
    this.#steps.push("hang");
  }

  /** Clear the deadlines still running, when the world closes. */
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  async #classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult> {
    const call: JevCall = { context, timeoutMs: options?.timeoutMs, maxRetries: options?.maxRetries, result: undefined };
    this.calls.push(call);
    const step = this.#steps.shift() ?? ((_context, unscripted) => classifierResult(unscripted, "error", "jev-fake: no answer was scripted for this call"));
    const ends: Array<Promise<ClassifierResult>> = [];
    const signal = options?.signal;
    let onAbort: (() => void) | undefined;
    if (signal !== undefined) {
      ends.push(
        new Promise((resolve) => {
          onAbort = () => resolve(classifierResult(model, "aborted", "Request aborted"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    const timeoutMs = options?.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      ends.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(classifierResult(model, "error", `Request timed out after ${timeoutMs}ms`)), timeoutMs);
          this.#timers.add(timer);
        }),
      );
    }
    if (step !== "hang") ends.push(Promise.resolve(step(context, model)));
    const ended = await Promise.race(ends);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(timer);
    }
    if (signal !== undefined && onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    call.result = ended;
    return ended;
  }
}

/** A classifier result without answers, as pi-ai builds one. */
function classifierResult(model: ClassifierModel<ClassifierApi>, stopReason: ClassifierResult["stopReason"], errorMessage?: string): ClassifierResult {
  return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: Date.now() };
}

// ─── The trace ───────────────────────────────────────────────────────────────

/** Faux calls, and what the pi-cache-optimizer-shaped probe resolved, in the order they happened. */
export type TraceEntry =
  | { readonly kind: "before_agent_start"; readonly messageType: string; readonly route: Snapshot | undefined }
  | { readonly kind: "headers"; readonly route: Snapshot | undefined }
  | { readonly kind: "payload"; readonly payload: unknown; readonly route: Snapshot | undefined }
  | { readonly kind: "call"; readonly call: FauxCall };

/**
 * A pi-cache-optimizer-shaped consumer: like pi-cache-optimizer 2.8.7 it creates the routing
 * registry at load when there is none, and resolves the active route with its session hint at
 * before_agent_start, before_provider_headers and before_provider_request.
 */
function coProbe(trace: TraceEntry[]): InlineExtension {
  return {
    name: "co-probe",
    factory: (pi) => {
      ensureRoutingRegistry();
      pi.on("before_agent_start", (event, ctx) => {
        trace.push({ kind: "before_agent_start", messageType: event.messageType, route: resolveActiveRoute(ctx) });
      });
      pi.on("before_provider_headers", (_event, ctx) => {
        trace.push({ kind: "headers", route: resolveActiveRoute(ctx) });
      });
      pi.on("before_provider_request", (event, ctx) => {
        trace.push({ kind: "payload", payload: event.payload, route: resolveActiveRoute(ctx) });
      });
    },
  };
}

// ─── The UI ──────────────────────────────────────────────────────────────────

/**
 * A UI context that records notices, status items and select dialogs. A select dialog takes the
 * next scripted answer, and with none left is cancelled, as Escape does; every other dialog is
 * cancelled.
 */
export class FakeUI {
  readonly notices: Array<{ readonly message: string; readonly type: string }> = [];
  readonly statuses = new Map<string, string | undefined>();
  /** Every status item set, oldest first. */
  readonly statusLog: Array<{ readonly key: string; readonly text: string | undefined }> = [];
  /** The answers the next select dialogs give, in order: one of the dialog's options, or undefined for Escape. */
  readonly answers: Array<string | undefined> = [];
  /** Every select dialog shown, oldest first. */
  readonly dialogs: Array<{ readonly title: string; readonly options: readonly string[] }> = [];
  readonly context: ExtensionUIContext;

  constructor() {
    const ui = this;
    const none = (): void => undefined;
    this.context = {
      select: async (title: string, options: string[]) => {
        ui.dialogs.push({ title, options: [...options] });
        const answer = ui.answers.shift();
        if (answer !== undefined && !options.includes(answer)) throw new Error(`FakeUI: the scripted answer "${answer}" is not an option of "${title}"`);
        return answer;
      },
      confirm: async () => false,
      input: async () => undefined,
      notify: (message: string, type?: string) => {
        ui.notices.push({ message, type: type ?? "info" });
      },
      onTerminalInput: () => none,
      setStatus: (key: string, text: string | undefined) => {
        ui.statuses.set(key, text);
        ui.statusLog.push({ key, text });
      },
      setWorkingMessage: none,
      setWorkingVisible: none,
      setWorkingIndicator: none,
      setHiddenThinkingLabel: none,
      setWidget: none,
      setFooter: none,
      setHeader: none,
      setTitle: none,
      custom: async () => undefined,
      pasteToEditor: none,
      setEditorText: none,
      getEditorText: () => "",
      editor: async () => undefined,
      addAutocompleteProvider: none,
      setEditorComponent: none,
      getEditorComponent: () => undefined,
      theme: undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "UI not available" }),
      getToolsExpanded: () => false,
      setToolsExpanded: none,
    } as unknown as ExtensionUIContext;
  }

  /** The status item under `key`. */
  status(key: string): string | undefined {
    return this.statuses.get(key);
  }

  /** The notices whose text matches. */
  saw(pattern: RegExp): string[] {
    return this.notices.map((notice) => notice.message).filter((message) => pattern.test(message));
  }
}

// ─── Worlds ──────────────────────────────────────────────────────────────────

/** Settings every behaviour test starts from: fast retries, compaction with a small reserve, no warming. */
export const BASE_SETTINGS: Settings = {
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
  compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
  cacheWarming: "off",
};

/** The fleet of the design's scenarios (§8.2). */
const FLEET: readonly FauxSpec[] = [
  { provider: "local-a", baseUrl: "http://localhost:0" },
  { provider: "cloud-a" },
  { provider: "cloud-b" },
  { provider: "cloud-c" },
  { provider: "codex-like", api: "openai-codex-responses", ignoresAbort: true },
  { provider: "openai-codex-3", id: "gpt-6.1-sol", api: "openai-codex-responses" },
  { provider: "openai-codex-2", id: "gpt-6.1-sol", api: "openai-codex-responses" },
];

/** What both roster versions share, as JSON, loose enough for a scenario to vary any field; the router validates it. */
interface RosterJsonBase {
  exclude?: string[];
  roles: Array<{ name: string; models: string[]; thinking?: string }>;
  /** A version 2 binding also names its scope, personal by default. */
  accounts?: Record<string, { multiPassLabel?: string; native?: string; scope?: string }>;
  local?: { role: string; providers: string[]; hosts: string[] };
  stickyIdleMinutes?: number;
  cooldownMinutes?: number;
}

/** A version 1 roster: a routing table. */
export interface RosterJsonV1 extends RosterJsonBase {
  version: 1;
  routing: { default: string; trivial?: string; complex?: string; planning?: string; fallback?: Record<string, string> };
}

/** A scope of a version 2 roster: a role and a description for each level. */
export interface ScopeJson {
  levels: Record<"low" | "medium" | "high" | "super", { role: string; describe: string }>;
}

/** A version 2 roster: the levels of each scope it serves, and the classifier. */
export interface RosterJsonV2 extends RosterJsonBase {
  version: 2;
  scopes: { personal?: ScopeJson; work?: ScopeJson & { directories?: string[] } };
  classifier?: { model?: string; timeoutMs?: number; closeCall?: number; context?: { messages?: number; messageChars?: number; totalChars?: number } };
  demand?: { jevWeight?: number; heuristicsWeight?: number; minConfidence?: number; closeCall?: number; cuts?: number[]; deepSessionFloor?: string; weights?: Record<string, number> };
  switching?: { margin?: number; horizonCap?: number; cacheSurvival?: Array<[number, number]> };
}

export type RosterJson = RosterJsonV1 | RosterJsonV2;

/** The roster of the behaviour tests, shaped like John's: the local role is reached only by smart-router/local, coder only as engineer's fallback. */
export const ROSTER: RosterJsonV1 = {
  version: 1,
  roles: [
    { name: "local", models: ["local-a/m"] },
    { name: "worker", models: ["cloud-b/m"] },
    { name: "coder", models: ["cloud-c/m"] },
    { name: "engineer", models: ["cloud-a/m"] },
    { name: "architect", models: ["codex-like/m"] },
  ],
  routing: { default: "worker", trivial: "worker", complex: "engineer", planning: "architect", fallback: { engineer: "coder" } },
  local: { role: "local", providers: ["local-a"], hosts: ["localhost"] },
};

export const PROMPTS = {
  planning: "Plan the migration of the session store",
  complex: "Debug the deadlock in concurrent writes",
  trivial: "Format this JSON file",
  plain: "Hello, how are you today?",
} as const;

export interface WorldOptions {
  /** An object is written as JSON, a string as is; null writes no roster. */
  readonly roster?: unknown;
  /** Multi-Pass's global file, written the same way; none by default. */
  readonly multiPass?: unknown;
  readonly settings?: Settings;
  readonly fleet?: readonly FauxSpec[];
}

export interface PiOptions {
  /** The session: a fresh in-memory one by default. */
  readonly sessionManager?: SessionManager;
  /** A file-backed session in the world's session directory, for resume, /new and forks. */
  readonly persisted?: boolean;
  /** The model the first session starts on, as provider/id; otherwise Pi restores or picks one. */
  readonly select?: string;
  /** Whether Pi loads the router; true by default. */
  readonly router?: boolean;
  /** Extension files loaded before and after the router. */
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  /** Inline extensions, which Pi loads after every extension file; the probe is one by default. */
  readonly extensions?: readonly InlineExtension[];
  readonly probe?: boolean;
  /** The providers registered with each ModelRuntime: the whole fleet by default. */
  readonly providers?: readonly string[];
  readonly tools?: readonly string[];
}

/** Forget the process slot, the routing registry and both environment switches: a fresh process. */
function resetProcess(): void {
  const store = globalThis as Record<symbol, unknown>;
  delete store[Symbol.for(SLOT_KEY)];
  delete store[Symbol.for(ROUTING_REGISTRY_KEY)];
  delete process.env[ENV_PIN];
  delete process.env[ENV_SCOPE];
}

function writeOwned(dir: string, name: string, value: unknown): void {
  const path = join(dir, name);
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(path, 0o600);
}

export class World {
  readonly root: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly fleet = new Map<string, Faux>();
  /** The classifier every Pi of the world registers after the fleet. */
  readonly jev = new FakeJev();
  readonly trace: TraceEntry[] = [];
  settings: Settings;
  readonly #pis: Pi[] = [];

  constructor(t: TestContext, options: WorldOptions = {}) {
    resetProcess();
    this.root = realpathSync(mkdtempSync(join(tmpdir(), "psr-world-")));
    this.agentDir = join(this.root, "agent");
    this.cwd = join(this.root, "cwd");
    this.sessionDir = join(this.root, "sessions");
    for (const dir of [this.agentDir, this.cwd, this.sessionDir]) mkdirSync(dir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
    if (options.roster !== null) this.writeRoster(options.roster ?? ROSTER);
    if (options.multiPass !== undefined) this.writeMultiPass(options.multiPass);
    this.settings = structuredClone(options.settings ?? BASE_SETTINGS);
    for (const spec of options.fleet ?? FLEET) this.fleet.set(spec.provider, new Faux(spec, this.trace));
    t.after(async () => {
      for (const pi of this.#pis.splice(0)) await pi.close();
      this.jev.dispose();
      resetProcess();
      rmSync(this.root, { recursive: true, force: true });
    });
  }

  faux(provider: string): Faux {
    const found = this.fleet.get(provider);
    if (found === undefined) throw new Error(`no faux provider ${provider}`);
    return found;
  }

  /** How many requests each provider received, for messages and for "no other provider" checks. */
  counts(): Record<string, number> {
    return Object.fromEntries([...this.fleet].map(([provider, faux]) => [provider, faux.callCount]));
  }

  /** How many requests each model received, by provider/id; models that received none are left out. */
  refCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const faux of this.fleet.values()) {
      for (const call of faux.calls) counts[call.ref] = (counts[call.ref] ?? 0) + 1;
    }
    return counts;
  }

  writeRoster(value: unknown): void {
    writeOwned(this.agentDir, "smart-router.json", value);
  }

  writeMultiPass(value: unknown): void {
    writeOwned(this.agentDir, "multi-pass.json", value);
  }

  /** A file-backed session in this world. */
  persistedSession(): SessionManager {
    return SessionManager.create(this.cwd, this.sessionDir);
  }

  /** Reopen a session file, as a resume does. */
  open(file: string): SessionManager {
    return SessionManager.open(file, this.sessionDir, this.cwd);
  }

  async start(options: PiOptions = {}): Promise<Pi> {
    const pi = await Pi.start(this, options);
    this.#pis.push(pi);
    return pi;
  }
}

/** One Pi process's session runtime, with its UI and the events of every session it held. */
export class Pi {
  readonly world: World;
  readonly runtime: AgentSessionRuntime;
  readonly ui: FakeUI;
  readonly events: AgentSessionEvent[];
  #closed = false;

  private constructor(world: World, runtime: AgentSessionRuntime, ui: FakeUI, events: AgentSessionEvent[]) {
    this.world = world;
    this.runtime = runtime;
    this.ui = ui;
    this.events = events;
  }

  static async start(world: World, options: PiOptions): Promise<Pi> {
    const ui = new FakeUI();
    const events: AgentSessionEvent[] = [];
    const providers = (options.providers ?? [...world.fleet.keys()]).map((provider) => world.faux(provider));
    const paths = [...(options.before ?? []), ...(options.router === false ? [] : [ROUTER_ENTRY]), ...(options.after ?? [])];
    const extensions = [...(options.probe === false ? [] : [coProbe(world.trace)]), ...(options.extensions ?? [])];
    let select = options.select;
    const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      for (const faux of providers) modelRuntime.registerNativeProvider(faux.provider);
      modelRuntime.registerNativeProvider(world.jev.provider);
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager: SettingsManager.inMemory(world.settings),
        modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: paths,
          extensionFactories: extensions,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const errors = [
        ...services.diagnostics.filter((diagnostic) => diagnostic.type === "error").map((diagnostic) => diagnostic.message),
        ...services.resourceLoader.getExtensions().errors.map((error) => `${error.path}: ${error.error}`),
      ];
      if (errors.length > 0) throw new Error(`Pi could not load the test's extensions: ${errors.join("; ")}`);
      const ref = select;
      select = undefined;
      const model = ref === undefined ? undefined : findModel(services.modelRuntime, ref);
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(model === undefined ? {} : { model }),
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        tools: [...(options.tools ?? [])],
      });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const sessionManager = options.sessionManager ?? (options.persisted === true ? world.persistedSession() : SessionManager.inMemory(world.cwd));
    const runtime = await createAgentSessionRuntime(factory, { cwd: world.cwd, agentDir: world.agentDir, sessionManager });
    const bind = async (session: AgentSession): Promise<void> => {
      session.subscribe((event) => events.push(event));
      await session.bindExtensions({ uiContext: ui.context, mode: "tui" });
    };
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    return new Pi(world, runtime, ui, events);
  }

  get session(): AgentSession {
    return this.runtime.session;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  /** A model of the current session's catalog, by provider/id. */
  model(ref: string): Model<Api> {
    return findModel(this.session.modelRuntime, ref);
  }

  /** Type a prompt and wait until the session is idle again. */
  async prompt(text: string): Promise<void> {
    await this.session.prompt(text);
    await this.session.waitForIdle();
  }

  /** Send a message as an extension does, such as pi-idle-check's resend (source "extension"), and wait until the session is idle again. */
  async resend(text: string): Promise<void> {
    await this.session.sendUserMessage(text);
    await this.session.waitForIdle();
  }

  /** Start a run without a prompt, as goal-x's continuations do, and wait for it to settle. */
  async custom(text = "continue"): Promise<void> {
    await this.session.sendCustomMessage({ customType: "test/continue", content: text, display: false }, { triggerTurn: true });
    await this.session.waitForIdle();
  }

  /** Run /smart-router with these arguments. */
  async command(args: string): Promise<void> {
    await this.prompt(`/smart-router ${args}`);
  }

  /** Force the selection without a model_select event, as writing session.agent.state.model does. */
  force(ref: string): void {
    this.session.agent.state.model = this.model(ref);
  }

  /** The selection, as provider/id. */
  selection(): string | undefined {
    const model = this.session.model;
    return model === undefined ? undefined : `${model.provider}/${model.id}`;
  }

  /** Every assistant message of the session, oldest first. */
  assistants(): AssistantMessage[] {
    return this.session.messages.filter((message): message is AssistantMessage => message.role === "assistant");
  }

  lastAssistant(): AssistantMessage | undefined {
    return this.assistants().at(-1);
  }

  /** The session events of one type, in order. */
  eventsOf<T extends AgentSessionEvent["type"]>(type: T): Array<Extract<AgentSessionEvent, { type: T }>> {
    return this.events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.runtime.dispose();
  }
}

/**
 * A session nested in a parent's process on the parent's ModelRuntime, loading the router, as
 * goal-x's auditor and oracle with project resources and pi-subagents' detached children do.
 * Creating it flushes its router's registrations into the shared runtime, replacing the parent's
 * routes. With `bind`, it also binds its extensions and so starts its own router instance.
 */
export async function nestedSession(world: World, parent: Pi, options: { readonly bind: boolean }): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory(world.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: world.cwd,
    agentDir: world.agentDir,
    settingsManager,
    additionalExtensionPaths: [ROUTER_ENTRY],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const model = parent.session.model;
  const { session } = await createAgentSession({
    cwd: world.cwd,
    agentDir: world.agentDir,
    modelRuntime: parent.session.modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(world.cwd),
    settingsManager,
    ...(model === undefined ? {} : { model }),
    tools: [],
  });
  if (options.bind) await session.bindExtensions({ uiContext: new FakeUI().context, mode: "tui" });
  return session;
}

/**
 * A session on a parent's ModelRuntime that loads no extensions, as goal-x's default auditor is:
 * its requests go through the parent's route, with the parent's context.
 */
export async function auditorSession(world: World, parent: Pi, ref: string): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory(world.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: world.cwd,
    agentDir: world.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: world.cwd,
    agentDir: world.agentDir,
    modelRuntime: parent.session.modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(world.cwd),
    settingsManager,
    model: findModel(parent.session.modelRuntime, ref),
    tools: [],
  });
  return session;
}

function findModel(runtime: Pick<ModelRuntime, "getModel">, ref: string): Model<Api> {
  const slash = ref.indexOf("/");
  const model = slash <= 0 ? undefined : runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1));
  if (model === undefined) throw new Error(`model not found: ${ref}`);
  return model;
}

// ─── Session history ─────────────────────────────────────────────────────────

/** A user message, as Pi records one. */
function userMessage(text: string, timestamp = Date.now()): { role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number } {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

/** An assistant response from a faux provider's first model, or its model `id`, with a context of `tokens` input tokens. */
export function response(
  faux: Faux,
  init: { readonly id?: string; readonly tokens?: number; readonly stopReason?: AssistantMessage["stopReason"]; readonly text?: string; readonly timestamp?: number } = {},
): AssistantMessage {
  const tokens = init.tokens ?? 100;
  const model = init.id === undefined ? faux.model : faux.models.get(init.id);
  if (model === undefined) throw new Error(`faux provider ${faux.spec.provider} serves no model ${init.id ?? ""}`);
  return {
    role: "assistant",
    content: [{ type: "text", text: init.text ?? `earlier answer from ${model.provider}/${model.id}` }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: init.stopReason ?? "stop",
    timestamp: init.timestamp ?? Date.now(),
  };
}

/** An in-memory session that already holds a conversation: a selection, then user and assistant turns. */
export function history(world: World, selection: string, turns: ReadonlyArray<readonly [string, AssistantMessage]>): SessionManager {
  const manager = SessionManager.inMemory(world.cwd);
  const slash = selection.indexOf("/");
  manager.appendModelChange(selection.slice(0, slash), selection.slice(slash + 1));
  manager.appendThinkingLevelChange("medium");
  for (const [text, answer] of turns) {
    manager.appendMessage(userMessage(text, answer.timestamp - 1));
    manager.appendMessage(answer);
  }
  return manager;
}

/** Wait until `done()` holds, or fail after `ms`. For timers Pi runs on its own, such as cache warming. */
export async function until(done: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** The providers that received any request. */
export function called(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0));
}
