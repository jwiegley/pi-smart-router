// A fake Pi host for the unit suites. Test-only; never shipped; no Pi runtime is started.
//
// FakeRuntime follows Pi's ModelRuntime where the router depends on it: virtual models are kept
// by provider and id, a registration replaces the earlier one and produces a new catalog object,
// and the catalog lists virtual models beside the physical ones. Its registry finds the classifier
// models a test adds, and classify logs every call and answers as the test scripts it. FakeSession
// is one session with its context; every getter of the context throws once the session is
// disposed, as a stale Pi context does, and its session manager refuses whole-history reads.
// FakeHost is one session's extension runtime: the API a factory receives, which stages
// registrations until the session binds, as Pi's loader does, and the handlers events are emitted
// to, in registration order, with input chained as Pi chains it. Its setModel follows
// AgentSession.setModel: it assigns the selection, records a model_change and then awaits every
// model_select handler, so a handler can switch again from inside it. The session's dialogs are
// Pi's own selector component, answered with scripted keys.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { Api, AssistantMessage, ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, Model, Usage } from "@earendil-works/pi-ai";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionVirtualModel,
  ModelRoute,
  ModelRouteReason,
  ModelRouteRequest,
  RegisteredCommand,
  SlashCommandInfo,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";

import { install } from "../../index.ts";
import { PROVIDER, ROUTING_REGISTRY_KEY, SLOT_KEY } from "../../src/constants.ts";
import type { VirtualId } from "../../src/constants.ts";
import { isRecord } from "../../src/files.ts";
import type { ClassifierRegistry } from "../../src/jev.ts";
import { refOf } from "../../src/resolve.ts";
import { createRouter } from "../../src/router.ts";
import type { Router, RouterOptions } from "../../src/router.ts";
import { FakeCatalog, heraModels, NOW, OPENROUTER } from "./catalog.ts";
import { fixture, scratch, write } from "./fixtures.ts";

type Route = (request: ModelRouteRequest) => ModelRoute | Promise<ModelRoute>;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

/** Forget the process slot and the routing registry, so each test starts with a fresh process. */
export function resetSlot(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for(SLOT_KEY)];
  delete (globalThis as Record<symbol, unknown>)[Symbol.for(ROUTING_REGISTRY_KEY)];
}

export function usage(totalTokens: number): Usage {
  return { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** An assistant response from a physical model. */
export function assistant(ref: string, init: Partial<AssistantMessage> = {}): AssistantMessage {
  const slash = ref.indexOf("/");
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-completions",
    provider: ref.slice(0, slash),
    model: ref.slice(slash + 1),
    usage: usage(1_000),
    stopReason: "stop",
    timestamp: NOW,
    ...init,
  };
}

/** A key pressed in one of Pi's selector dialogs. */
export type DialogKey = "up" | "down" | "enter" | "escape";

/** What a terminal sends for each key. */
const KEY_CODES: Readonly<Record<DialogKey, string>> = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };

let themed = false;

/**
 * Answer a selector dialog as Pi's interactive mode does: with Pi's own ExtensionSelectorComponent
 * and these keys. It starts on the first option, so Enter alone picks that one. Escape cancels, and
 * keys that run out before an answer leave the dialog unanswered, as a timeout would; both give
 * undefined.
 */
function answerSelector(title: string, options: string[], keys: readonly DialogKey[]): string | undefined {
  if (!themed) {
    // The component draws with Pi's theme. The built-in one reads only Pi's own package files.
    initTheme("dark");
    themed = true;
  }
  let answered = false;
  let answer: string | undefined;
  const selector = new ExtensionSelectorComponent(
    title,
    options,
    (option) => {
      answered = true;
      answer = option;
    },
    () => {
      answered = true;
    },
  );
  try {
    for (const key of keys) {
      if (answered) break;
      selector.handleInput(KEY_CODES[key]);
    }
  } finally {
    selector.dispose();
  }
  return answer;
}

function latest<T>(items: readonly T[], match: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as T;
    if (match(item)) return item;
  }
  return undefined;
}

/** A classifier model, as Pi's catalog lists one: OpenRouter's Jev speaks typesafe-system-one. */
export function classifierModel(ref: string): ClassifierModel<ClassifierApi> {
  const slash = ref.indexOf("/");
  assert.ok(slash > 0, ref);
  return {
    type: "classifier",
    provider: ref.slice(0, slash),
    id: ref.slice(slash + 1),
    name: ref,
    api: "typesafe-system-one",
    baseUrl: OPENROUTER,
    input: ["text"],
    cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
  };
}

/** A failed classification, as pi-ai reports one: classify never rejects. */
export function classifierError(model: ClassifierModel<ClassifierApi>, errorMessage: string): ClassifierResult {
  return { api: model.api, provider: model.provider, model: model.id, answers: {}, stopReason: "error", errorMessage, timestamp: NOW };
}

/** One classify call, as the registry received it. */
export interface ClassifyCall {
  readonly model: ClassifierModel<ClassifierApi>;
  readonly context: ClassifierContext;
  readonly options: { readonly timeoutMs: number; readonly maxRetries: number };
}

export class FakeRuntime {
  readonly catalog: FakeCatalog;
  readonly virtual = new Map<string, { readonly model: Model<Api>; readonly route: Route }>();
  registrations = 0;
  /** The classifier models findOfType finds, by ref: none until a test adds one. */
  readonly classifiers = new Map<string, ClassifierModel<ClassifierApi>>();
  /** Every classify call, in order. */
  readonly classifyCalls: ClassifyCall[] = [];
  /** How classify answers a call. Until a test scripts it, every call fails. */
  answer: (call: ClassifyCall) => Promise<ClassifierResult> = async (call) => classifierError(call.model, "no answer was scripted");
  readonly registry: Pick<ExtensionContext["modelRegistry"], "find" | "getAvailable" | "hasConfiguredAuth" | "getProviderAuthStatus"> & ClassifierRegistry;

  constructor(catalog: FakeCatalog = new FakeCatalog(heraModels())) {
    this.catalog = catalog;
    this.registry = {
      find: (provider, id) => this.find(provider, id),
      getAvailable: () => this.getAvailable(),
      hasConfiguredAuth: (model) => this.hasConfiguredAuth(model),
      getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
      findOfType: (type, provider, id) => (type === "classifier" ? this.classifiers.get(`${provider}/${id}`) : undefined),
      classify: (model, context, options) => {
        const call: ClassifyCall = { model, context, options };
        this.classifyCalls.push(call);
        return this.answer(call);
      },
    };
  }

  /** Add a classifier model that findOfType finds. */
  addClassifier(ref: string): ClassifierModel<ClassifierApi> {
    const added = classifierModel(ref);
    this.classifiers.set(ref, added);
    return added;
  }

  register(definition: Omit<ExtensionVirtualModel, "route"> & { readonly route: Route }): void {
    const model = {
      provider: definition.provider,
      id: definition.id,
      name: definition.name,
      api: "pi-virtual",
      baseUrl: "",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: definition.contextWindow ?? 0,
      maxTokens: definition.maxTokens ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as Model<Api>;
    this.virtual.set(`${definition.provider}/${definition.id}`, { model, route: definition.route });
    this.registrations += 1;
  }

  find(provider: string, id: string): Model<Api> | undefined {
    return this.virtual.get(`${provider}/${id}`)?.model ?? this.catalog.find(provider, id);
  }

  getAvailable(): Model<Api>[] {
    return [...this.catalog.getAvailable(), ...[...this.virtual.values()].map((entry) => entry.model)];
  }

  hasConfiguredAuth(model: Model<Api>): boolean {
    return this.virtual.has(refOf(model)) || this.catalog.hasConfiguredAuth(model);
  }

  /** A physical model of the catalog. */
  physical(ref: string): Model<Api> {
    const found = this.catalog.models.get(ref);
    assert.ok(found !== undefined, ref);
    return found;
  }

  /** Route a request through whatever route is registered now, as Pi's resolveModel does. */
  route(id: VirtualId, request: Omit<ModelRouteRequest, "model">): ModelRoute {
    const entry = this.virtual.get(`${PROVIDER}/${id}`);
    if (entry === undefined) throw new Error(`Virtual model ${PROVIDER}/${id} is not registered.`);
    const result = entry.route({ ...request, model: entry.model });
    assert.ok(!(result instanceof Promise), "the router routes synchronously");
    return result;
  }
}

export interface SessionOptions {
  readonly id?: string;
  readonly file?: string;
  /** Whether the session manager has the fork's bounded readers. */
  readonly bounded?: boolean;
  /** The session's working directory, as ctx.cwd gives it. */
  readonly cwd?: string;
}

export class FakeSession {
  readonly runtime: FakeRuntime;
  readonly id: string;
  readonly cwd: string;
  file: string | undefined;
  model: Model<Api> | undefined;
  controller: AbortController | undefined;
  disposed = false;
  hasUI = true;
  readonly notices: Array<{ readonly type: string; readonly message: string }> = [];
  readonly entries: Array<Record<string, unknown>> = [];
  readonly boundedReads: unknown[] = [];
  /** The ids of entries that are not on the active branch, as after /tree to a branch without them (leaveBranch). */
  readonly offBranch = new Set<string>();
  wholeHistoryReads = 0;
  /** The status items, as setStatus left them. */
  readonly statuses = new Map<string, string | undefined>();
  /** The keys each dialog gets (see answerSelector), and the dialogs shown. */
  dialogKeys: DialogKey[] = ["enter"];
  readonly dialogs: Array<{ readonly title: string; readonly options: readonly string[] }> = [];
  /** How many times an extension aborted, whether or not a run was active. */
  aborts = 0;
  readonly ctx: ExtensionContext;

  constructor(runtime: FakeRuntime, options: SessionOptions = {}) {
    this.runtime = runtime;
    this.id = options.id ?? "session-1";
    this.cwd = options.cwd ?? "/nonexistent";
    this.file = options.file;
    const session = this;
    const live = (): void => {
      if (session.disposed) throw new Error("This extension ctx is stale after session replacement or reload.");
    };
    const whole = (name: string) => () => {
      session.wholeHistoryReads += 1;
      throw new Error(`a whole-history read: ${name}`);
    };
    const manager: Record<string, unknown> = {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
      getEntries: whole("getEntries"),
      getBranch: whole("getBranch"),
    };
    if (options.bounded !== false) {
      manager.getRecentActiveEntries = (filter: { type?: string; messageRole?: string; customType?: string; limit?: number } = {}) => {
        session.boundedReads.push(filter);
        const matching = session.entries.filter((entry) => {
          const message = entry.message as { role?: string } | undefined;
          return (
            !session.offBranch.has(String(entry.id)) &&
            (filter.type === undefined || entry.type === filter.type) &&
            (filter.messageRole === undefined || message?.role === filter.messageRole) &&
            (filter.customType === undefined || entry.customType === filter.customType)
          );
        });
        return matching.slice(-(filter.limit ?? 256));
      };
      manager.getLatestCustomEntry = (customType: string, options?: { scope?: "all" | "active" }) => {
        session.boundedReads.push({ customType, ...options });
        const active = options?.scope === "active";
        return latest(
          session.entries,
          (entry) => (entry.type === "custom" || entry.type === "custom_message") && entry.customType === customType && !(active && session.offBranch.has(String(entry.id))),
        );
      };
      manager.getLatestMessage = (role?: string) =>
        latest(session.entries, (entry) => entry.type === "message" && (role === undefined || (entry.message as { role?: string }).role === role));
    }
    const select = async (title: string, options: string[]): Promise<string | undefined> => {
      session.dialogs.push({ title, options: [...options] });
      return answerSelector(title, options, session.dialogKeys);
    };
    const ui = {
      notify: (message: string, type = "info") => session.notices.push({ type, message }),
      setStatus: (key: string, text: string | undefined) => session.statuses.set(key, text),
      select,
      // Pi's interactive confirm (InteractiveMode.showExtensionConfirm) is this selector over Yes and No.
      confirm: async (title: string, message: string): Promise<boolean> => (await select(`${title}\n${message}`, ["Yes", "No"])) === "Yes",
    };
    this.ctx = {
      get ui() {
        live();
        return ui;
      },
      get mode() {
        live();
        return "tui";
      },
      get hasUI() {
        live();
        return session.hasUI;
      },
      get cwd() {
        live();
        return session.cwd;
      },
      get sessionManager() {
        live();
        return manager;
      },
      get modelRegistry() {
        live();
        return session.runtime.registry;
      },
      get model() {
        live();
        return session.model;
      },
      get scopedModels() {
        live();
        return [];
      },
      get signal() {
        live();
        return session.controller?.signal;
      },
      isIdle: () => {
        live();
        return session.controller === undefined;
      },
      isProjectTrusted: () => {
        live();
        return false;
      },
      abort: () => {
        live();
        session.aborts += 1;
        session.controller?.abort();
      },
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    } as unknown as ExtensionContext;
  }

  select(id: VirtualId | string): void {
    const model = id.includes("/") ? this.runtime.find(id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)) : this.runtime.find(PROVIDER, id);
    assert.ok(model !== undefined, id);
    this.model = model;
  }

  /** Start a run: the agent's abort signal, which every request of the run carries. */
  startRun(): AbortSignal {
    this.controller = new AbortController();
    return this.controller.signal;
  }

  endRun(): void {
    this.controller = undefined;
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Append an assistant message entry to the branch. */
  appendAssistant(message: AssistantMessage, timestamp = new Date(message.timestamp).toISOString()): void {
    this.entries.push({ type: "message", id: `e${this.entries.length}`, parentId: null, timestamp, message });
  }

  /** Append a custom entry, as Pi's appendEntry does. */
  appendCustom(customType: string, data: unknown, type: "custom" | "custom_message" = "custom"): void {
    this.entries.push({ type, customType, data, id: `e${this.entries.length}`, parentId: null, timestamp: new Date(NOW).toISOString() });
  }

  /** Move to a branch that holds none of the entries so far, as /tree to an earlier point does: scope "all" still reads them. */
  leaveBranch(): void {
    for (const entry of this.entries) this.offBranch.add(String(entry.id));
  }

  /** Force the selection without a model_select, as writing session.agent.state.model does. */
  force(ref: string): void {
    this.select(ref);
  }
}

export class FakeHost {
  readonly session: FakeSession;
  readonly handlers = new Map<string, Handler[]>();
  readonly calls: string[] = [];
  readonly definitions: ExtensionVirtualModel[] = [];
  readonly commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  settings: Record<string, unknown> = {};
  /** What pi.getCommands() and pi.getAllTools() list. */
  commandList: SlashCommandInfo[] = [];
  tools: ToolInfo[] = [];
  /** The model_select events emitted, in order. */
  readonly selections: Array<{ readonly model: string; readonly previous: string | undefined; readonly source: string }> = [];
  bound = false;
  readonly staged: Array<() => void> = [];
  readonly api: ExtensionAPI;

  constructor(session: FakeSession) {
    this.session = session;
    const host = this;
    this.api = {
      on(event: string, handler: Handler) {
        host.calls.push(`on:${event}`);
        host.handlers.set(event, [...(host.handlers.get(event) ?? []), handler]);
        return () => {};
      },
      registerVirtualModel(model: ExtensionVirtualModel) {
        host.calls.push(`registerVirtualModel:${model.id}`);
        host.definitions.push(model);
        const apply = () => session.runtime.register({ ...model, route: (request: ModelRouteRequest) => model.route(request, session.ctx) });
        if (host.bound) apply();
        else host.staged.push(apply);
      },
      registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
        host.calls.push(`registerCommand:${name}`);
        host.commands.set(name, options);
      },
      getSettings: () => structuredClone(host.settings),
      appendEntry(customType: string, data?: unknown) {
        session.appendCustom(customType, data);
      },
      getCommands: () => host.commandList,
      getAllTools: () => host.tools,
      getThinkingLevel: () => "high",
      setModel: (model: Model<Api>) => host.setModel(model, "set"),
    } as unknown as ExtensionAPI;
  }

  /** Select a model as AgentSession.setModel (source set) or cycleModel (source cycle) does. */
  async setModel(model: Model<Api>, source: "set" | "cycle" = "set"): Promise<boolean> {
    if (!this.session.runtime.hasConfiguredAuth(model)) return false;
    const previousModel = this.session.model;
    this.session.model = model;
    this.session.entries.push({ type: "model_change", provider: model.provider, modelId: model.id, id: `e${this.session.entries.length}`, parentId: null, timestamp: new Date(NOW).toISOString() });
    if (previousModel !== undefined && refOf(previousModel) === refOf(model)) return true;
    this.selections.push({ model: refOf(model), previous: previousModel === undefined ? undefined : refOf(previousModel), source });
    await this.emit("model_select", { model, previousModel, source });
    return true;
  }

  /** Select a model by ref, as /model or a competing extension does. */
  choose(ref: string, source: "set" | "cycle" = "set"): Promise<boolean> {
    const slash = ref.indexOf("/");
    const model = this.session.runtime.find(ref.slice(0, slash), ref.slice(slash + 1));
    assert.ok(model !== undefined, ref);
    return this.setModel(model, source);
  }

  /** Run a registered command with its arguments; resolves when the handler has finished. */
  async command(name: string, args = ""): Promise<void> {
    const command = this.commands.get(name);
    assert.ok(command !== undefined, `the command ${name} is registered`);
    await command.handler(args, this.session.ctx as ExtensionCommandContext);
  }

  /** Flush the staged registrations into the runtime, as Pi does when the session binds. */
  bind(): void {
    this.bound = true;
    for (const apply of this.staged.splice(0)) apply();
  }

  /**
   * Emit an event to every handler, in registration order, and return their results. Input chains
   * as Pi's emitInput does: each handler sees the text and images the handlers before it left, and
   * `handled` stops the chain. Unlike Pi, which reports a handler that throws and carries on, the
   * throw reaches the test.
   */
  async emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> {
    const results: unknown[] = [];
    let current: Record<string, unknown> = { type: event, ...payload };
    for (const handler of this.handlers.get(event) ?? []) {
      const result = await handler({ ...current }, this.session.ctx);
      results.push(result);
      if (event !== "input" || !isRecord(result)) continue;
      if (result.action === "handled") break;
      if (result.action === "transform") current = { ...current, text: result.text, images: result.images ?? current.images };
    }
    return results;
  }

  count(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }
}

/** An agent directory holding Hera's roster and Multi-Pass labels, or other files. */
export function agentDir(t: TestContext, files: { roster?: string | null; multiPass?: string | null } = {}): string {
  const dir = join(scratch(t), "agent");
  mkdirSync(dir);
  const roster = files.roster === undefined ? fixture("roster-hera.json") : files.roster;
  if (roster !== null) write(dir, "smart-router.json", roster);
  const multiPass =
    files.multiPass === undefined
      ? JSON.stringify({ subscriptions: [{ provider: "openai-codex", index: 2, label: "personal" }, { provider: "openai-codex", index: 3, label: "Positron work" }] })
      : files.multiPass;
  if (multiPass !== null) write(dir, "multi-pass.json", multiPass);
  return dir;
}

export interface Loaded {
  readonly runtime: FakeRuntime;
  readonly session: FakeSession;
  readonly host: FakeHost;
  /** The router the factory built; undefined when it failed. */
  router: Router | undefined;
}

export interface LoadOptions extends SessionOptions {
  readonly dir: string;
  readonly runtime?: FakeRuntime;
  readonly now?: () => number;
  /** Replace the router builder, as the lifecycle tests do. */
  readonly build?: (pi: ExtensionAPI, options: RouterOptions) => Router;
  /** Runs before the router loads: an extension that loads earlier registers its handlers here. */
  readonly before?: (host: FakeHost) => void;
  /** Entries the session holds before it starts, such as a scope or an earlier version's pin entry. */
  readonly setup?: (session: FakeSession) => void;
}

/** Load the extension into a new session on a runtime and bind it, without starting it. */
export function load(options: LoadOptions): Loaded {
  const runtime = options.runtime ?? new FakeRuntime();
  const session = new FakeSession(runtime, options);
  const host = new FakeHost(session);
  const loaded: Loaded = { runtime, session, host, router: undefined };
  options.setup?.(session);
  options.before?.(host);
  install(host.api, (pi, given) => {
    const build = options.build ?? createRouter;
    loaded.router = build(pi, { ...given, agentDir: () => options.dir, ...(options.now === undefined ? {} : { now: options.now }) });
    return loaded.router;
  });
  host.bind();
  return loaded;
}

/** Load, bind, select a model and start the session. */
export async function start(options: LoadOptions & { readonly select?: VirtualId | string }): Promise<Loaded> {
  const loaded = load(options);
  loaded.session.select(options.select ?? "auto");
  await loaded.host.emit("session_start", { reason: "startup" });
  return loaded;
}

/** A route request, without the virtual model, which the runtime fills in. */
export function request(reason: ModelRouteReason, init: Partial<Omit<ModelRouteRequest, "model" | "reason">> = {}): Omit<ModelRouteRequest, "model"> {
  return { reason, thinkingLevel: "high", messages: [], ...init };
}

export function previous(runtime: FakeRuntime, ref: string): NonNullable<ModelRouteRequest["previous"]> {
  return { model: runtime.physical(ref), thinkingLevel: "high" };
}

export function failure(runtime: FakeRuntime, ref: string, errorMessage: string, timestamp = NOW): NonNullable<ModelRouteRequest["failed"]> {
  return { model: runtime.physical(ref), thinkingLevel: "high", message: assistant(ref, { stopReason: "error", errorMessage, timestamp }) };
}

export const routed = (route: ModelRoute): string => refOf(route.model);
