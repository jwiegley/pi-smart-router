// The roster: one user-owned JSON file per host, <agentDir>/smart-router.json, holding ordered
// roles of exact provider/id refs, the account bindings and the local section. Schema version 1
// routes by its routing table. Version 2 replaces the table with the four levels of each scope it
// serves, personal, work or both, binds every account to a scope, and may configure the
// classifier. A scope may also declare a fallback: an ordered chain of other roles that take a run
// when its level's own models cannot. Validation is strict and fails closed: the first error, with its location, makes the
// whole file invalid, and nothing routes by a last-known-good copy (the scope keeps only the last
// valid roster's work directories, src/router.ts). Unknown keys are refused at every level, so the
// file has nowhere to hold a key, token, header, base URL or environment.
import { isWorkCodex, subscriptionKind } from "./accounts.ts";
import {
  ALL_LEVELS,
  BUILTIN_EXCLUDES,
  CLASSIFIER_CLOSE_CALL,
  CLASSIFIER_MESSAGE_CHARS,
  CLASSIFIER_MESSAGES,
  CLASSIFIER_MODEL,
  CLASSIFIER_TIMEOUT_MS,
  CLASSIFIER_TOTAL_CHARS,
  COOLDOWN_MINUTES,
  DESCRIBE_MAX_CHARS,
  INSTRUCTIONS_MAX_CHARS,
  PROMPT_DIR,
  PROMPT_FILE_NAME,
  REFUSED_LABEL,
  ROSTER_FILE,
  ROSTER_MAX_BYTES,
  STICKY_IDLE_MINUTES,
  UNREACHABLE_MINUTES,
  WORK_ALIAS_EXCLUDE,
} from "./constants.ts";
import type { Level } from "./constants.ts";
import { agentFile, isRecord, message, own } from "./files.ts";
import type { AgentFile, FileSystem, Parsed } from "./files.ts";
import type { JevSettings } from "./jev.ts";
import { canonicalHost, isLocalHost } from "./local.ts";
import { DEFAULT_DEMAND, DEFAULT_SWITCHING, SIGNALS } from "./settings.ts";
import type { DemandSettings, SurvivalTable, SwitchingSettings } from "./settings.ts";
import { isTier, TIERS } from "./tiers.ts";
import type { Tier } from "./tiers.ts";

/** The level a role sends: the selected level, or a fixed one. */
export type Thinking = "selected" | Level;

export interface Role {
  readonly name: string;
  readonly models: readonly string[];
  readonly thinking: Thinking;
}

export interface Routing {
  readonly default: string;
  readonly trivial: string;
  readonly complex: string;
  readonly planning: string;
  /** One hop: a role whose candidates are all unavailable may fall back to this role, no further. */
  readonly fallback: ReadonlyMap<string, string>;
}

export type AccountBinding =
  | { readonly kind: "multi-pass"; readonly label: string }
  | { readonly kind: "native"; readonly label: string };

/** A version 2 session's scope. */
export type Scope = "personal" | "work";

export const SCOPES: readonly Scope[] = ["personal", "work"];

/** Whether a value read from a roster, a session entry or a record names a scope. */
export const isScope = (value: unknown): value is Scope => typeof value === "string" && (SCOPES as readonly string[]).includes(value);

/**
 * One level of a scope: the role it routes to, and the description Jev reads, which the roster
 * gives inline (`describe`) or as a prompt file's name (`describeFile`, and then `describe` is
 * empty). src/prompts.ts turns either into the text.
 */
export interface TierEntry {
  readonly role: string;
  readonly describe: string;
  readonly describeFile?: string;
}

export interface ScopeSection {
  readonly levels: Readonly<Record<Tier, TierEntry>>;
  /** Absolute paths whose sessions start in this scope. Only the work scope has any. */
  readonly directories: readonly string[];
  /**
   * The scope's fallback chain, when it declares one: roles, in the order written, that take a run
   * of smart-router/auto after its level's own models. None is a level's role, in either scope.
   */
  readonly fallback?: readonly string[];
}

/** A version 2 account binding: personal, the default, or work. */
export type ScopedBinding = AccountBinding & { readonly scope: Scope };

/**
 * The local role and what counts as local. There is no field for tools: smart-router/local routes
 * the model only (John's decision Q7), so a roster cannot ask for a tool block the router would not
 * apply.
 */
export interface LocalSection {
  readonly role: string;
  readonly providers: readonly string[];
  /** Base-URL host names, canonical, each passing the built-in local-host rule. */
  readonly hosts: readonly string[];
}

export interface RosterV1 {
  readonly version: 1;
  /** The built-in exclusions, then the roster's own. */
  readonly exclude: readonly string[];
  /** The ladder, cheapest or weakest first. Each ref belongs to exactly one role. */
  readonly roles: readonly Role[];
  readonly routing: Routing;
  readonly accounts: ReadonlyMap<string, AccountBinding>;
  readonly local?: LocalSection;
  readonly stickyIdleMinutes: number;
  readonly cooldownMinutes: number;
  /** How long a local model whose server could not be reached is skipped; absent, the default (unreachableMinutesOf). */
  readonly unreachableMinutes?: number;
}

export interface RosterV2 {
  readonly version: 2;
  /** The built-in exclusions, then the roster's own. A work level lifts only the built-in openai-codex-3/* (liftWorkAlias). */
  readonly exclude: readonly string[];
  /** The ladder, cheapest or weakest first. Each ref belongs to exactly one role. */
  readonly roles: readonly Role[];
  readonly accounts: ReadonlyMap<string, ScopedBinding>;
  readonly local?: LocalSection;
  readonly stickyIdleMinutes: number;
  readonly cooldownMinutes: number;
  /** As in version 1. */
  readonly unreachableMinutes?: number;
  /** The scopes the roster serves, at least one. Each level has a role of its own. */
  readonly scopes: Readonly<Partial<Record<Scope, ScopeSection>>>;
  /** Jev's settings, with every default filled in. Without them, Jev is never asked. */
  readonly classifier?: JevSettings;
  /** How a prompt's demand is weighed, with every default filled in. */
  readonly demand: DemandSettings;
  /** When a session moves to another model, with every default filled in. */
  readonly switching: SwitchingSettings;
}

export type Roster = RosterV1 | RosterV2;

export interface Ref {
  readonly provider: string;
  readonly id: string;
}

/** Split a ref at its first "/": `openrouter/deepseek/x` is provider `openrouter`, id `deepseek/x`. */
export function parseRef(ref: string): Ref | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** The first exclusion that matches a ref: the exact ref, or its `provider/*`. */
export function excludedBy(patterns: readonly string[], ref: string): string | undefined {
  const provider = parseRef(ref)?.provider;
  return patterns.find((pattern) => pattern === ref || (provider !== undefined && pattern === `${provider}/*`));
}

/** The role a ref belongs to. */
export function roleOf(roster: Pick<Roster, "roles">, ref: string): Role | undefined {
  return roster.roles.find((role) => role.models.includes(ref));
}

/** A role's position on the ladder, or -1. */
export function rankOf(roster: Pick<Roster, "roles">, name: string): number {
  return roster.roles.findIndex((role) => role.name === name);
}

/** How long a roster holds a local model whose server could not be reached: its unreachableMinutes, or the default. */
export function unreachableMinutesOf(roster: Pick<Roster, "unreachableMinutes">): number {
  return roster.unreachableMinutes ?? UNREACHABLE_MINUTES.default;
}

/** A scope's section of a version 2 roster; version 1 has none. */
export function scopeSection(roster: Roster, scope: Scope): ScopeSection | undefined {
  return roster.version === 2 ? roster.scopes[scope] : undefined;
}

/** Whether smart-router/auto serves a scope under a roster: version 1 serves only personal scope, version 2 each scope it has a section for. */
export function servesScope(roster: Roster, scope: Scope): boolean {
  return roster.version === 1 ? scope === "personal" : scopeSection(roster, scope) !== undefined;
}

function boundToWork(accounts: ReadonlyMap<string, ScopedBinding>, provider: string): boolean {
  return accounts.get(provider)?.scope === "work";
}

/** Whether a version 2 roster binds a provider as a work account. */
export function isWorkBound(roster: Roster, provider: string): boolean {
  return roster.version === 2 && boundToWork(roster.accounts, provider);
}

/** A scope's level roles, low to super; none without the scope. */
export function levelRoles(section: ScopeSection | undefined): string[] {
  return section === undefined ? [] : TIERS.map((tier) => section.levels[tier].role);
}

/** The roles smart-router/auto reaches in a scope: its level roles, low to super, then its fallback chain. */
function scopeRoles(section: ScopeSection | undefined): string[] {
  return [...levelRoles(section), ...(section?.fallback ?? [])];
}

/**
 * The roles a pick goes on to after `roleName`, in a session's scope: the scope's whole fallback
 * chain after one of its level roles, the rest of the chain after one of the chain's roles, and
 * nothing after any other role, in a scope without a chain or under version 1 (whose one-hop
 * routing.fallback is pickInRole's). The chain only ever moves forward: no role leads back to a
 * level. The helper knows no session, so its callers apply it only to smart-router/auto.
 */
export function fallbackAfter(roster: Roster, scope: Scope, roleName: string): readonly string[] {
  const section = scopeSection(roster, scope);
  const chain = section?.fallback;
  if (section === undefined || chain === undefined) return [];
  if (levelRoles(section).includes(roleName)) return chain;
  const at = chain.indexOf(roleName);
  return at < 0 ? [] : chain.slice(at + 1);
}

/** A candidate of a pick: a model, and the role that holds it. */
export interface Candidate {
  readonly role: string;
  readonly ref: string;
}

/**
 * Every model a pick that starts in `roleName` can reach in a session's scope, in the order it
 * tries them: the role's own models, then each role fallbackAfter gives, each in its own order.
 * It is what smart-router/auto tries; status and the checker print it.
 */
export function candidatesOf(roster: Roster, scope: Scope, roleName: string): readonly Candidate[] {
  return [roleName, ...fallbackAfter(roster, scope, roleName)].flatMap((name) =>
    (roster.roles.find((role) => role.name === name)?.models ?? []).map((ref) => ({ role: name, ref })),
  );
}

/**
 * The exclusions that apply to a ref: `patterns`, less openai-codex-3/* when the ref's provider is
 * bound as a work account and its role is one of the work scope's level roles or fallback roles. The helper knows no
 * session, so its callers lift only in a work-scope session. Validation lifts only the built-in
 * pattern, so a valid roster whose own exclude names openai-codex-3/* holds no openai-codex-3 ref,
 * and lifting over its merged exclusions at runtime reaches none.
 */
export function liftWorkAlias(roster: Pick<RosterV2, "accounts" | "roles" | "scopes">, ref: string, patterns: readonly string[]): readonly string[] {
  const provider = parseRef(ref)?.provider;
  const role = roleOf(roster, ref)?.name;
  const lifted = provider !== undefined && role !== undefined && boundToWork(roster.accounts, provider) && scopeRoles(roster.scopes.work).includes(role);
  return lifted ? patterns.filter((pattern) => pattern !== WORK_ALIAS_EXCLUDE) : patterns;
}

/**
 * The exclusions that apply to a ref in a session's scope: the built-ins and the roster's own. A
 * version 2 work-scope session lifts openai-codex-3/* from them for a work level's or work fallback's work-bound ref
 * (liftWorkAlias); every other session, and version 1, keeps them all.
 */
export function excludesFor(roster: Roster, scope: Scope, ref: string): readonly string[] {
  const merged = [...BUILTIN_EXCLUDES, ...roster.exclude];
  return roster.version === 2 && scope === "work" ? liftWorkAlias(roster, ref, merged) : merged;
}

/**
 * The roles `smart-router/auto` may route to in a session's scope. Version 1 ignores the scope:
 * routing targets and fallback targets; a role that neither names, such as a local role kept for
 * smart-router/local, is never routed by auto. Version 2: the scope's four level roles and the
 * roles of its fallback chain, which may name the local role; none when the roster has no section
 * for that scope.
 */
export function autoRoles(roster: Roster, scope: Scope): ReadonlySet<string> {
  if (roster.version === 2) return new Set(scopeRoles(scopeSection(roster, scope)));
  const { routing } = roster;
  return new Set([routing.default, routing.trivial, routing.complex, routing.planning, ...routing.fallback.values()]);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const TOP_KEYS = ["version", "exclude", "roles", "routing", "accounts", "local", "stickyIdleMinutes", "cooldownMinutes", "unreachableMinutes"];
const ROLE_KEYS = ["name", "models", "thinking"];
const ROUTING_KEYS = ["default", "trivial", "complex", "planning", "fallback"];
const BINDING_KEYS = ["multiPassLabel", "native"];
const LOCAL_KEYS = ["role", "providers", "hosts"];
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ROLE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_ID = /^[^\s*\x00-\x1f\x7f]+$/;
const LEVELS: readonly string[] = ALL_LEVELS;

class RosterError extends Error {}

function fail(path: string, problem: string): never {
  throw new RosterError(`${path}: ${problem}`);
}

const at = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

function required(value: unknown, path: string): unknown {
  if (value === undefined) fail(path, "is required");
  return value;
}

/** An object whose keys are all allowed (any key, for a map); `$comment` is a string anywhere. */
function object(value: unknown, path: string, allowed: readonly string[] | "map"): Record<string, unknown> {
  if (!isRecord(value)) fail(path === "" ? "roster" : path, "must be an object");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(at(path, key), "forbidden key");
    if (key === "$comment") {
      if (typeof value[key] !== "string") fail(at(path, key), "must be a string");
    } else if (allowed !== "map" && !allowed.includes(key)) {
      fail(at(path, key), "unknown key");
    }
  }
  return value;
}

function entries(record: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(record).filter(([key]) => key !== "$comment");
}

function array(value: unknown, path: string, nonEmpty: boolean): unknown[] {
  if (!Array.isArray(required(value, path))) fail(path, "must be an array");
  const items = value as unknown[];
  if (nonEmpty && items.length === 0) fail(path, "must not be empty");
  return items;
}

function text(value: unknown, path: string): string {
  if (typeof required(value, path) !== "string" || (value as string).trim() === "") fail(path, "must be a non-empty string");
  return value as string;
}

function uniqueTexts(value: unknown, path: string, nonEmpty: boolean, check?: (item: string, where: string) => void): string[] {
  const seen = new Set<string>();
  return array(value, path, nonEmpty).map((item, index) => {
    const where = `${path}[${index}]`;
    const entry = text(item, where);
    if (seen.has(entry)) fail(where, `"${entry}" is listed twice`);
    seen.add(entry);
    check?.(entry, where);
    return entry;
  });
}

interface Range {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

/** A whole number within its range, counted in `unit`; the default when absent. */
function count(value: unknown, path: string, range: Range, unit: string): number {
  if (value === undefined) return range.default;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    fail(path, `must be a whole number of ${unit} from ${range.min} to ${range.max}`);
  }
  return value;
}

function minutes(value: unknown, path: string, range: Range): number {
  return count(value, path, range, "minutes");
}

/** The roster's unreachableMinutes, when it gives one: the parsed roster holds the field only then. */
function unreachableField(root: Record<string, unknown>): { readonly unreachableMinutes?: number } {
  const given = own(root, "unreachableMinutes");
  return given === undefined ? {} : { unreachableMinutes: minutes(given, "unreachableMinutes", UNREACHABLE_MINUTES) };
}

// The checks both versions make, with version 1's messages.

/** The roster's own exclusions: exact provider/id refs and provider/* patterns. */
function parseExcludes(root: Record<string, unknown>): string[] {
  if (own(root, "exclude") === undefined) return [];
  return array(own(root, "exclude"), "exclude", false).map((item, index) => {
    const where = `exclude[${index}]`;
    const pattern = text(item, where);
    const ref = parseRef(pattern);
    if (ref === undefined || !PROVIDER_ID.test(ref.provider) || (ref.id !== "*" && !MODEL_ID.test(ref.id))) {
      fail(where, `"${pattern}" is neither a provider/id ref nor a provider/* pattern`);
    }
    return pattern;
  });
}

/** An exact provider/id ref, with no glob and no whitespace, and its provider. */
function exactRef(value: unknown, where: string): { readonly ref: string; readonly provider: string } {
  const ref = text(value, where);
  const parsed = parseRef(ref);
  if (parsed === undefined || !PROVIDER_ID.test(parsed.provider) || !MODEL_ID.test(parsed.id)) fail(where, `"${ref}" is not an exact provider/id ref`);
  return { ref, provider: parsed.provider };
}

/** A model ref in a role: where the roster writes it, its provider, and the role's name. */
interface RoleRef {
  readonly where: string;
  readonly ref: string;
  readonly provider: string;
  readonly role: string;
}

interface ParsedRoles {
  readonly roles: readonly Role[];
  readonly names: ReadonlySet<string>;
  /** Every model ref, in the roster's order. */
  readonly refs: readonly RoleRef[];
  /** A role name the roster defines; any other is an error at `where`. */
  readonly roleName: (item: unknown, where: string) => string;
}

/** The roles: unique names, exact refs that each sit in one role and match none of `patterns`, and their thinking. */
function parseRoles(root: Record<string, unknown>, patterns: readonly string[]): ParsedRoles {
  const names = new Set<string>();
  const holders = new Map<string, string>();
  const refs: RoleRef[] = [];
  const roles = array(own(root, "roles"), "roles", true).map((item, index): Role => {
    const path = `roles[${index}]`;
    const entry = object(item, path, ROLE_KEYS);
    const name = text(own(entry, "name"), `${path}.name`);
    if (!ROLE_NAME.test(name)) fail(`${path}.name`, `"${name}" must match ${ROLE_NAME.source}`);
    if (names.has(name)) fail(`${path}.name`, `role "${name}" is defined twice`);
    names.add(name);
    const models = array(own(entry, "models"), `${path}.models`, true).map((model, position) => {
      const where = `${path}.models[${position}]`;
      const { ref, provider } = exactRef(model, where);
      const holder = holders.get(ref);
      if (holder !== undefined) fail(where, holder === name ? `"${ref}" is listed twice` : `"${ref}" is already in role "${holder}"`);
      const pattern = excludedBy(patterns, ref);
      if (pattern !== undefined) fail(where, `"${ref}" is excluded by ${pattern}`);
      holders.set(ref, name);
      refs.push({ where, ref, provider, role: name });
      return ref;
    });
    const given = own(entry, "thinking");
    const thinking = given === undefined ? "selected" : given;
    if (thinking !== "selected" && (typeof thinking !== "string" || !LEVELS.includes(thinking))) {
      fail(`${path}.thinking`, `must be "selected" or one of ${LEVELS.join(", ")}`);
    }
    return { name, models, thinking: thinking as Thinking };
  });
  const roleName = (item: unknown, where: string): string => {
    const name = text(item, where);
    if (!names.has(name)) fail(where, `"${name}" is not a role`);
    return name;
  };
  return { roles, names, refs, roleName };
}

/** A binding of a subscription provider, which may hold only `keys`: its kind, the field holding its label, and that label, trimmed. */
function bindingLabel(
  provider: string,
  item: unknown,
  keys: readonly string[],
): { readonly binding: Record<string, unknown>; readonly kind: AccountBinding["kind"]; readonly field: string; readonly label: string } {
  const path = `accounts.${provider}`;
  const kind = subscriptionKind(provider);
  if (kind === undefined) {
    fail(path, `${provider} is not a subscription provider: openai-codex, anthropic, github-copilot, or a Multi-Pass alias of one`);
  }
  const binding = object(item, path, keys);
  if (kind === "alias" && own(binding, "native") !== undefined) fail(path, 'a Multi-Pass alias is bound with "multiPassLabel", not "native"');
  if (kind === "native" && own(binding, "multiPassLabel") !== undefined) fail(path, 'a native login is bound with "native", not "multiPassLabel"');
  const field = kind === "alias" ? "multiPassLabel" : "native";
  return { binding, kind: kind === "alias" ? "multi-pass" : "native", field, label: text(own(binding, field), `${path}.${field}`).trim() };
}

/** Every ref to a subscription provider needs that provider's binding. */
function requireBindings(refs: readonly RoleRef[], accounts: ReadonlyMap<string, AccountBinding>): void {
  for (const { where, ref, provider } of refs) {
    if (subscriptionKind(provider) !== undefined && !accounts.has(provider)) {
      fail(where, `"${ref}" uses the subscription provider ${provider}, which needs a binding in accounts`);
    }
  }
}

/** The local section: its role, providers that cover that role's models, and local hosts. `checkRole` is a further rule for the role, checked first. */
function parseLocal(root: Record<string, unknown>, parsed: ParsedRoles, checkRole?: (role: string) => void): LocalSection | undefined {
  if (own(root, "local") === undefined) return undefined;
  const section = object(own(root, "local"), "local", LOCAL_KEYS);
  const role = parsed.roleName(own(section, "role"), "local.role");
  checkRole?.(role);
  const providers = uniqueTexts(own(section, "providers"), "local.providers", true, (provider, where) => {
    if (!PROVIDER_ID.test(provider)) fail(where, `"${provider}" is not a provider id`);
  });
  for (const { ref, provider, role: holder } of parsed.refs) {
    if (holder === role && !providers.includes(provider)) {
      fail("local.providers", `must include ${provider}, the provider of "${ref}" in the local role "${role}"`);
    }
  }
  const hosts = uniqueTexts(own(section, "hosts"), "local.hosts", true, (host, where) => {
    const canonical = canonicalHost(host);
    if (canonical === undefined) fail(where, `"${host}" is not a host name`);
    if (canonical !== host) fail(where, `write "${canonical}", not "${host}"`);
    if (!isLocalHost(host)) {
      fail(where, `"${host}" is not a local host: use localhost, a loopback, private, link-local or unique-local address, or a .lan, .local or .home.arpa name`);
    }
  });
  return { role, providers, hosts };
}

function validate(value: unknown): Roster {
  if (!isRecord(value)) fail("roster", "must be a JSON object");
  const version = own(value, "version");
  if (version === undefined) fail("version", "is required");
  if (version === 2) return validateV2(value);
  if (version !== 1) fail("version", `must be 1 or 2, not ${JSON.stringify(version)}`);
  const root = object(value, "", TOP_KEYS);

  const exclude = [...new Set([...BUILTIN_EXCLUDES, ...parseExcludes(root)])];
  const parsed = parseRoles(root, exclude);
  const { roles, names, roleName } = parsed;

  const routingObject = object(required(own(root, "routing"), "routing"), "routing", ROUTING_KEYS);
  const defaultRole = roleName(own(routingObject, "default"), "routing.default");
  const target = (key: "trivial" | "complex" | "planning"): string =>
    own(routingObject, key) === undefined ? defaultRole : roleName(own(routingObject, key), `routing.${key}`);
  const fallback = new Map<string, string>();
  if (own(routingObject, "fallback") !== undefined) {
    for (const [from, to] of entries(object(own(routingObject, "fallback"), "routing.fallback", "map"))) {
      const where = `routing.fallback.${from}`;
      if (!names.has(from)) fail(where, `"${from}" is not a role`);
      if (roleName(to, where) === from) fail(where, "a role cannot fall back to itself");
      fallback.set(from, to as string);
    }
  }
  const routing: Routing = {
    default: defaultRole,
    trivial: target("trivial"),
    complex: target("complex"),
    planning: target("planning"),
    fallback,
  };

  const accounts = new Map<string, AccountBinding>();
  if (own(root, "accounts") !== undefined) {
    for (const [provider, item] of entries(object(own(root, "accounts"), "accounts", "map"))) {
      const { kind, field, label } = bindingLabel(provider, item, BINDING_KEYS);
      if (REFUSED_LABEL.test(label)) fail(`accounts.${provider}.${field}`, `the label "${label}" is refused`);
      accounts.set(provider, { kind, label });
    }
  }
  requireBindings(parsed.refs, accounts);

  const local = parseLocal(root, parsed);

  return {
    version: 1,
    exclude,
    roles,
    routing,
    accounts,
    ...(local === undefined ? {} : { local }),
    stickyIdleMinutes: minutes(own(root, "stickyIdleMinutes"), "stickyIdleMinutes", STICKY_IDLE_MINUTES),
    cooldownMinutes: minutes(own(root, "cooldownMinutes"), "cooldownMinutes", COOLDOWN_MINUTES),
    ...unreachableField(root),
  };
}

// ─── Version 2 ───────────────────────────────────────────────────────────────

const V2_TOP_KEYS = ["version", "exclude", "roles", "scopes", "accounts", "classifier", "demand", "switching", "local", "stickyIdleMinutes", "cooldownMinutes", "unreachableMinutes"];
const SCOPE_KEYS: Readonly<Record<Scope, readonly string[]>> = { personal: ["levels", "fallback"], work: ["levels", "directories", "fallback"] };
const LEVEL_KEYS = ["role", "describe", "describeFile"];
const SCOPED_BINDING_KEYS = ["multiPassLabel", "native", "scope"];
const CLASSIFIER_KEYS = ["model", "timeoutMs", "closeCall", "context", "instructions", "instructionsFile"];
const CONTEXT_KEYS = ["messages", "messageChars", "totalChars"];

interface LevelName {
  readonly scope: Scope;
  readonly tier: Tier;
}

const levelName = (level: LevelName): string => `the ${level.scope} scope's ${level.tier} level`;

/** A work directory: absolute and written plainly, since a session's directory is compared with it as text. */
function workDirectory(directory: string, where: string): void {
  if (!directory.startsWith("/")) fail(where, `"${directory}" is not an absolute path`);
  let end = directory.length;
  while (end > 0 && directory[end - 1] === "/") end -= 1;
  if (end === 0) fail(where, `"${directory}" would put every session in work scope`);
  if (end < directory.length) fail(where, `write "${directory.slice(0, end)}", not "${directory}"`);
  if (directory.slice(1).split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(where, `"${directory}" must not contain empty, . or .. segments`);
  }
}

/** A prompt file's name: plain, ending in .md or .txt, so that it can only be a file of <agentDir>/smart-router/. */
function promptFile(value: unknown, where: string): string {
  const name = text(value, where);
  if (!PROMPT_FILE_NAME.test(name)) {
    fail(where, `"${name}" is not a prompt file name: a plain lower-case name ending in .md or .txt, for a file in <agentDir>/${PROMPT_DIR}/`);
  }
  return name;
}

/** A number within its range; the default when absent. */
function fraction(value: unknown, path: string, range: Range): number {
  if (value === undefined) return range.default;
  if (typeof value !== "number" || !(value >= range.min && value <= range.max)) fail(path, `must be a number from ${range.min} to ${range.max}`);
  return value;
}

/**
 * The classifier section, with every field it leaves out given its default. Jev reads text from
 * both scopes, so its model, written or the default, must match none of the roster's exclusions,
 * and none is lifted for it.
 */
function classifierSettings(value: unknown, exclude: readonly string[]): JevSettings {
  const section = object(value, "classifier", CLASSIFIER_KEYS);
  const model = own(section, "model") === undefined ? CLASSIFIER_MODEL : exactRef(own(section, "model"), "classifier.model").ref;
  const pattern = excludedBy(exclude, model);
  if (pattern !== undefined) fail("classifier.model", `"${model}" is excluded by ${pattern}`);
  const timeoutMs = count(own(section, "timeoutMs"), "classifier.timeoutMs", CLASSIFIER_TIMEOUT_MS, "milliseconds");
  const closeCall = fraction(own(section, "closeCall"), "classifier.closeCall", CLASSIFIER_CLOSE_CALL);
  const caps: Record<string, unknown> = own(section, "context") === undefined ? {} : object(own(section, "context"), "classifier.context", CONTEXT_KEYS);
  // The question Jev is asked: the built-in one unless the roster gives its own, inline or in a file.
  // Each is checked for itself first, so that a null or a number is named, not taken for "both".
  const instructions = own(section, "instructions") === undefined ? undefined : text(own(section, "instructions"), "classifier.instructions");
  if (instructions !== undefined && [...instructions].length > INSTRUCTIONS_MAX_CHARS) fail("classifier.instructions", `must be at most ${INSTRUCTIONS_MAX_CHARS} characters`);
  const instructionsFile = own(section, "instructionsFile") === undefined ? undefined : promptFile(own(section, "instructionsFile"), "classifier.instructionsFile");
  if (instructions !== undefined && instructionsFile !== undefined) fail("classifier", 'give "instructions" or "instructionsFile", not both');
  return {
    model,
    timeoutMs,
    closeCall,
    context: {
      messages: count(own(caps, "messages"), "classifier.context.messages", CLASSIFIER_MESSAGES, "messages"),
      messageChars: count(own(caps, "messageChars"), "classifier.context.messageChars", CLASSIFIER_MESSAGE_CHARS, "characters"),
      totalChars: count(own(caps, "totalChars"), "classifier.context.totalChars", CLASSIFIER_TOTAL_CHARS, "characters"),
    },
    ...(instructions === undefined ? {} : { instructions }),
    ...(instructionsFile === undefined ? {} : { instructionsFile }),
  };
}

const DEMAND_KEYS = ["jevWeight", "heuristicsWeight", "minConfidence", "closeCall", "cuts", "deepSessionFloor", "weights"];
const SWITCHING_KEYS = ["margin", "horizonCap", "cacheSurvival"];
const WEIGHT = { default: 0, min: 0, max: 100 } as const;
const JEV_WEIGHT = { ...WEIGHT, default: DEFAULT_DEMAND.jevWeight } as const;
const HEURISTICS_WEIGHT = { ...WEIGHT, default: DEFAULT_DEMAND.heuristicsWeight } as const;
const MIN_CONFIDENCE = { default: DEFAULT_DEMAND.minConfidence, min: 0, max: 1 } as const;
const DEMAND_CLOSE_CALL = { default: DEFAULT_DEMAND.closeCall, min: 0, max: 0.5 } as const;
const SWITCH_MARGIN = { default: DEFAULT_SWITCHING.margin, min: 0, max: 0.9 } as const;
const HORIZON_CAP = { default: DEFAULT_SWITCHING.horizonCap, min: 1, max: 20 } as const;
const SURVIVAL_PAIRS_MAX = 32;
const CUTS_PROBLEM = "must be three numbers that ascend, each above 0 and below 3";
const SURVIVAL_PROBLEM = `must be 1 to ${SURVIVAL_PAIRS_MAX} pairs of [seconds, chance], the seconds rising and the chances from 1 to 0 never rising`;

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** Three cuts that ascend strictly, each above 0 and below 3; the default when absent. */
function cutsOf(value: unknown): DemandSettings["cuts"] {
  if (value === undefined) return DEFAULT_DEMAND.cuts;
  if (!Array.isArray(value) || value.length !== 3) fail("demand.cuts", CUTS_PROBLEM);
  const [first, second, third] = value as unknown[];
  if (!isNumber(first) || !isNumber(second) || !isNumber(third) || !(first > 0 && first < second && second < third && third < 3)) fail("demand.cuts", CUTS_PROBLEM);
  return [first, second, third];
}

/** The demand section, with every setting it leaves out given its default. */
function demandSettings(value: unknown): DemandSettings {
  if (value === undefined) return DEFAULT_DEMAND;
  const section = object(value, "demand", DEMAND_KEYS);
  const jevWeight = fraction(own(section, "jevWeight"), "demand.jevWeight", JEV_WEIGHT);
  const heuristicsWeight = fraction(own(section, "heuristicsWeight"), "demand.heuristicsWeight", HEURISTICS_WEIGHT);
  if (jevWeight === 0 && heuristicsWeight === 0) fail("demand", "jevWeight and heuristicsWeight cannot both be 0");
  const floor = own(section, "deepSessionFloor");
  if (floor !== undefined && !isTier(floor)) fail("demand.deepSessionFloor", `must be one of ${TIERS.join(", ")}`);
  const given = own(section, "weights") === undefined ? {} : object(own(section, "weights"), "demand.weights", SIGNALS);
  const weights: { -readonly [K in keyof DemandSettings["weights"]]: number } = { ...DEFAULT_DEMAND.weights };
  for (const signal of SIGNALS) weights[signal] = fraction(own(given, signal), `demand.weights.${signal}`, { ...WEIGHT, default: weights[signal] });
  if (SIGNALS.every((signal) => weights[signal] === 0)) fail("demand.weights", "cannot all be 0");
  return {
    jevWeight,
    heuristicsWeight,
    minConfidence: fraction(own(section, "minConfidence"), "demand.minConfidence", MIN_CONFIDENCE),
    closeCall: fraction(own(section, "closeCall"), "demand.closeCall", DEMAND_CLOSE_CALL),
    cuts: cutsOf(own(section, "cuts")),
    deepSessionFloor: floor ?? DEFAULT_DEMAND.deepSessionFloor,
    weights,
  };
}

/** Pairs of [seconds, chance]: the seconds rise from above 0, the chances run from 1 down to 0 and never rise. */
function survivalOf(value: unknown): SurvivalTable {
  if (value === undefined) return DEFAULT_SWITCHING.cacheSurvival;
  if (!Array.isArray(value) || value.length < 1 || value.length > SURVIVAL_PAIRS_MAX) fail("switching.cacheSurvival", SURVIVAL_PROBLEM);
  let seconds = 0;
  let chance = 1;
  return (value as unknown[]).map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) fail("switching.cacheSurvival", SURVIVAL_PROBLEM);
    const [after, odds] = pair as unknown[];
    if (!isNumber(after) || !isNumber(odds) || !(after > seconds) || !(odds >= 0 && odds <= chance)) fail("switching.cacheSurvival", SURVIVAL_PROBLEM);
    seconds = after;
    chance = odds;
    return [after, odds] as const;
  });
}

/** The switching section, with every setting it leaves out given its default. */
function switchingSettings(value: unknown): SwitchingSettings {
  if (value === undefined) return DEFAULT_SWITCHING;
  const section = object(value, "switching", SWITCHING_KEYS);
  return {
    margin: fraction(own(section, "margin"), "switching.margin", SWITCH_MARGIN),
    horizonCap: count(own(section, "horizonCap"), "switching.horizonCap", HORIZON_CAP, "runs"),
    cacheSurvival: survivalOf(own(section, "cacheSurvival")),
  };
}

/**
 * Version 2, checked in this order: the keys, the exclusions, the roles, the accounts and their
 * scopes, the scopes and their levels, each scope's fallback chain, each level's and each chain's
 * accounts, the work alias's exclusion, the local
 * section, the classifier, the demand and switching sections and the minutes. The checks it shares with version 1 are version 1's
 * helpers, so they keep version 1's messages.
 */
function validateV2(value: Record<string, unknown>): RosterV2 {
  const root = object(value, "", V2_TOP_KEYS);

  const rosterExcludes = parseExcludes(root);
  const exclude = [...new Set([...BUILTIN_EXCLUDES, ...rosterExcludes])];
  // Only the built-in work alias waits until the levels show the refs a work level lifts it for.
  // The roster's own exclusions apply in full, so one that names the alias stays in force.
  const parsed = parseRoles(root, [...new Set([...BUILTIN_EXCLUDES.filter((pattern) => pattern !== WORK_ALIAS_EXCLUDE), ...rosterExcludes])]);
  const { roles, refs, roleName } = parsed;

  const accounts = new Map<string, ScopedBinding>();
  if (own(root, "accounts") !== undefined) {
    for (const [provider, item] of entries(object(own(root, "accounts"), "accounts", "map"))) {
      const { binding, kind, field, label } = bindingLabel(provider, item, SCOPED_BINDING_KEYS);
      const path = `accounts.${provider}`;
      const given = own(binding, "scope");
      const scope = given === undefined ? "personal" : given;
      if (!isScope(scope)) fail(`${path}.scope`, 'must be "personal" or "work"');
      if (scope === "personal" && REFUSED_LABEL.test(label)) fail(`${path}.${field}`, `the label "${label}" is refused for a personal binding`);
      if (scope === "work" && !REFUSED_LABEL.test(label)) {
        fail(`${path}.${field}`, `the label "${label}" is refused for a work binding, whose label must contain work or Positron`);
      }
      accounts.set(provider, { kind, label, scope });
    }
  }
  requireBindings(refs, accounts);

  // Each level has a role of its own, and a scope's level roles climb the ladder from low to super.
  const scopesObject = object(required(own(root, "scopes"), "scopes"), "scopes", SCOPES);
  if (entries(scopesObject).length === 0) fail("scopes", "must not be empty");
  const levelOf = new Map<string, LevelName>();
  const scopes: Partial<Record<Scope, ScopeSection>> = {};
  for (const scope of SCOPES) {
    if (own(scopesObject, scope) === undefined) continue;
    const path = `scopes.${scope}`;
    const section = object(own(scopesObject, scope), path, SCOPE_KEYS[scope]);
    const levelsObject = object(required(own(section, "levels"), `${path}.levels`), `${path}.levels`, TIERS);
    let below: { readonly tier: Tier; readonly role: string } | undefined;
    const parseLevel = (tier: Tier): TierEntry => {
      const where = `${path}.levels.${tier}`;
      const entry = object(required(own(levelsObject, tier), where), where, LEVEL_KEYS);
      const role = roleName(own(entry, "role"), `${where}.role`);
      const holder = levelOf.get(role);
      if (holder !== undefined) fail(`${where}.role`, `"${role}" is already the role of ${levelName(holder)}`);
      if (below !== undefined && rankOf(parsed, role) < rankOf(parsed, below.role)) {
        fail(`${where}.role`, `"${role}" must rank above "${below.role}", the role of the ${below.tier} level`);
      }
      // The description Jev reads: inline, or the name of a prompt file, whose text has the same cap.
      // Each is checked for itself first, so that a null or a number is named, not taken for "both".
      const fileGiven = own(entry, "describeFile");
      const describeFile = fileGiven === undefined ? undefined : promptFile(fileGiven, `${where}.describeFile`);
      const describe = describeFile === undefined || own(entry, "describe") !== undefined ? text(own(entry, "describe"), `${where}.describe`) : "";
      if ([...describe].length > DESCRIBE_MAX_CHARS) fail(`${where}.describe`, `must be at most ${DESCRIBE_MAX_CHARS} characters`);
      if (describeFile !== undefined && own(entry, "describe") !== undefined) fail(where, 'give "describe" or "describeFile", not both');
      levelOf.set(role, { scope, tier });
      below = { tier, role };
      return { role, describe, ...(describeFile === undefined ? {} : { describeFile }) };
    };
    const levels = { low: parseLevel("low"), medium: parseLevel("medium"), high: parseLevel("high"), super: parseLevel("super") };
    const given = own(section, "directories");
    const directories = given === undefined ? [] : uniqueTexts(given, `${path}.directories`, false, workDirectory);
    // The chain's role names are checked once every scope's levels are known.
    const chain = own(section, "fallback") === undefined ? undefined : uniqueTexts(own(section, "fallback"), `${path}.fallback`, true);
    scopes[scope] = { levels, directories, ...(chain === undefined ? {} : { fallback: chain }) };
  }

  // A fallback chain names roles that are no level's, in either scope: a level's role in a chain
  // would give its models two places in one order, and a level of its own to hold.
  const chainOf = new Map<string, Scope>();
  for (const scope of SCOPES) {
    for (const [index, name] of (scopes[scope]?.fallback ?? []).entries()) {
      const where = `scopes.${scope}.fallback[${index}]`;
      const role = roleName(name, where);
      const level = levelOf.get(role);
      if (level !== undefined) fail(where, `"${role}" is already the role of ${levelName(level)}`);
      // One chain per role, so that the account rules below judge it for one scope.
      const other = chainOf.get(role);
      if (other !== undefined) fail(where, `"${role}" is already in the ${other} scope's fallback`);
      chainOf.set(role, scope);
    }
  }

  // A pick from a chain passes the same account rules as a pick from a level: a personal session
  // never reaches a work-bound account, and a work session reaches only the work Codex account.
  for (const { where, ref, provider, role } of refs) {
    const level = levelOf.get(role);
    const chain = chainOf.get(role);
    const scope = level?.scope ?? chain;
    if (scope === undefined) continue;
    const place = level !== undefined ? levelName(level) : `the ${scope} scope's fallback`;
    if (scope === "personal" && boundToWork(accounts, provider)) fail(where, `"${ref}" is in ${place}, but ${provider} is work-bound`);
    if (scope === "work" && !isWorkCodex(accounts, provider)) fail(where, `"${ref}" is in ${place}, which takes only work-bound Codex models`);
  }

  for (const { where, ref } of refs) {
    const pattern = excludedBy(liftWorkAlias({ accounts, roles, scopes }, ref, BUILTIN_EXCLUDES), ref);
    if (pattern !== undefined) fail(where, `"${ref}" is excluded by ${pattern}`);
  }

  // The local role is no level's: smart-router/auto reaches it only at the end of a chain that names it.
  const local = parseLocal(root, parsed, (role) => {
    const level = levelOf.get(role);
    if (level !== undefined) fail("local.role", `"${role}" is already the role of ${levelName(level)}`);
  });

  const classifier = own(root, "classifier") === undefined ? undefined : classifierSettings(own(root, "classifier"), exclude);
  const demand = demandSettings(own(root, "demand"));
  const switching = switchingSettings(own(root, "switching"));

  return {
    version: 2,
    exclude,
    roles,
    accounts,
    ...(local === undefined ? {} : { local }),
    stickyIdleMinutes: minutes(own(root, "stickyIdleMinutes"), "stickyIdleMinutes", STICKY_IDLE_MINUTES),
    cooldownMinutes: minutes(own(root, "cooldownMinutes"), "cooldownMinutes", COOLDOWN_MINUTES),
    ...unreachableField(root),
    scopes,
    ...(classifier === undefined ? {} : { classifier }),
    demand,
    switching,
  };
}

/** Parse and validate a roster. Never throws: any problem is the first error, located. */
export function parseRoster(text: string): Parsed<Roster> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `JSON syntax error: ${message(error)}` };
  }
  try {
    return { ok: true, value: validate(value) };
  } catch (error) {
    return { ok: false, error: error instanceof RosterError ? error.message : `validation failed: ${message(error)}` };
  }
}

export interface RosterFileOptions {
  readonly agentDir: () => string;
  readonly uid?: number | undefined;
  readonly fs?: FileSystem | undefined;
  readonly now?: (() => number) | undefined;
}

/** The roster under Pi's agent directory, capped at 64 KiB and cached by file identity. */
export function rosterFile(options: RosterFileOptions): AgentFile<Roster> {
  return agentFile({ ...options, name: ROSTER_FILE, maxBytes: ROSTER_MAX_BYTES, parse: parseRoster });
}
