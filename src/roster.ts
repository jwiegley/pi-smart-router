// The roster, schema version 1: one user-owned JSON file per host, <agentDir>/smart-router.json,
// holding ordered roles of exact provider/id refs, the routing table, the account bindings and
// the local section. Validation is strict and fails closed: the first error, with its location,
// makes the whole file invalid, and there is no last-known-good copy. Unknown keys are refused at
// every level, so the file has nowhere to hold a key, token, header, base URL or environment.
import { subscriptionKind } from "./accounts.ts";
import {
  ALL_LEVELS,
  BUILTIN_EXCLUDES,
  COOLDOWN_MINUTES,
  REFUSED_LABEL,
  ROSTER_FILE,
  ROSTER_MAX_BYTES,
  STICKY_IDLE_MINUTES,
} from "./constants.ts";
import type { Level } from "./constants.ts";
import { agentFile, isRecord, message, own } from "./files.ts";
import type { AgentFile, FileSystem, Parsed } from "./files.ts";
import { canonicalHost, isLocalHost } from "./local.ts";

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

export interface LocalSection {
  readonly role: string;
  readonly providers: readonly string[];
  /** Base-URL host names, canonical, each passing the built-in local-host rule. */
  readonly hosts: readonly string[];
  readonly blockTools: readonly string[];
}

export interface Roster {
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
}

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
export function roleOf(roster: Roster, ref: string): Role | undefined {
  return roster.roles.find((role) => role.models.includes(ref));
}

/** A role's position on the ladder, or -1. */
export function rankOf(roster: Roster, name: string): number {
  return roster.roles.findIndex((role) => role.name === name);
}

/**
 * The roles `smart-router/auto` may route to: routing targets and fallback targets. A role that
 * neither names, such as a local role kept for smart-router/local, is never routed by auto.
 */
export function autoRoles(roster: Roster): ReadonlySet<string> {
  const { routing } = roster;
  return new Set([routing.default, routing.trivial, routing.complex, routing.planning, ...routing.fallback.values()]);
}

// ─── Validation ──────────────────────────────────────────────────────────────

const TOP_KEYS = ["version", "exclude", "roles", "routing", "accounts", "local", "stickyIdleMinutes", "cooldownMinutes"];
const ROLE_KEYS = ["name", "models", "thinking"];
const ROUTING_KEYS = ["default", "trivial", "complex", "planning", "fallback"];
const BINDING_KEYS = ["multiPassLabel", "native"];
const LOCAL_KEYS = ["role", "providers", "hosts", "blockTools"];
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

function minutes(value: unknown, path: string, range: { readonly default: number; readonly min: number; readonly max: number }): number {
  if (value === undefined) return range.default;
  if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
    fail(path, `must be a whole number of minutes from ${range.min} to ${range.max}`);
  }
  return value;
}

function validate(value: unknown): Roster {
  if (!isRecord(value)) fail("roster", "must be a JSON object");
  const version = own(value, "version");
  if (version === undefined) fail("version", "is required");
  if (version !== 1) fail("version", `must be 1, not ${JSON.stringify(version)}`);
  const root = object(value, "", TOP_KEYS);

  const rosterExcludes =
    own(root, "exclude") === undefined
      ? []
      : array(own(root, "exclude"), "exclude", false).map((item, index) => {
          const where = `exclude[${index}]`;
          const pattern = text(item, where);
          const ref = parseRef(pattern);
          if (ref === undefined || !PROVIDER_ID.test(ref.provider) || (ref.id !== "*" && !MODEL_ID.test(ref.id))) {
            fail(where, `"${pattern}" is neither a provider/id ref nor a provider/* pattern`);
          }
          return pattern;
        });
  const exclude = [...new Set([...BUILTIN_EXCLUDES, ...rosterExcludes])];

  const names = new Set<string>();
  const holders = new Map<string, string>();
  const refs: Array<{ readonly where: string; readonly ref: string; readonly provider: string }> = [];
  const roles = array(own(root, "roles"), "roles", true).map((item, index): Role => {
    const path = `roles[${index}]`;
    const entry = object(item, path, ROLE_KEYS);
    const name = text(own(entry, "name"), `${path}.name`);
    if (!ROLE_NAME.test(name)) fail(`${path}.name`, `"${name}" must match ${ROLE_NAME.source}`);
    if (names.has(name)) fail(`${path}.name`, `role "${name}" is defined twice`);
    names.add(name);
    const models = array(own(entry, "models"), `${path}.models`, true).map((model, position) => {
      const where = `${path}.models[${position}]`;
      const ref = text(model, where);
      const parsed = parseRef(ref);
      if (parsed === undefined || !PROVIDER_ID.test(parsed.provider) || !MODEL_ID.test(parsed.id)) {
        fail(where, `"${ref}" is not an exact provider/id ref`);
      }
      const holder = holders.get(ref);
      if (holder !== undefined) fail(where, holder === name ? `"${ref}" is listed twice` : `"${ref}" is already in role "${holder}"`);
      const pattern = excludedBy(exclude, ref);
      if (pattern !== undefined) fail(where, `"${ref}" is excluded by ${pattern}`);
      holders.set(ref, name);
      refs.push({ where, ref, provider: parsed.provider });
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
      const path = `accounts.${provider}`;
      const kind = subscriptionKind(provider);
      if (kind === undefined) {
        fail(path, `${provider} is not a subscription provider: openai-codex, anthropic, github-copilot, or a Multi-Pass alias of one`);
      }
      const binding = object(item, path, BINDING_KEYS);
      if (kind === "alias" && own(binding, "native") !== undefined) fail(path, 'a Multi-Pass alias is bound with "multiPassLabel", not "native"');
      if (kind === "native" && own(binding, "multiPassLabel") !== undefined) fail(path, 'a native login is bound with "native", not "multiPassLabel"');
      const field = kind === "alias" ? "multiPassLabel" : "native";
      const label = text(own(binding, field), `${path}.${field}`).trim();
      if (REFUSED_LABEL.test(label)) fail(`${path}.${field}`, `the label "${label}" is refused`);
      accounts.set(provider, { kind: kind === "alias" ? "multi-pass" : "native", label });
    }
  }
  for (const { where, ref, provider } of refs) {
    if (subscriptionKind(provider) !== undefined && !accounts.has(provider)) {
      fail(where, `"${ref}" uses the subscription provider ${provider}, which needs a binding in accounts`);
    }
  }

  let local: LocalSection | undefined;
  if (own(root, "local") !== undefined) {
    const section = object(own(root, "local"), "local", LOCAL_KEYS);
    const role = roleName(own(section, "role"), "local.role");
    const providers = uniqueTexts(own(section, "providers"), "local.providers", true, (provider, where) => {
      if (!PROVIDER_ID.test(provider)) fail(where, `"${provider}" is not a provider id`);
    });
    for (const { ref, provider } of refs) {
      if (holders.get(ref) === role && !providers.includes(provider)) {
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
    const blockTools = own(section, "blockTools") === undefined ? [] : uniqueTexts(own(section, "blockTools"), "local.blockTools", false);
    local = { role, providers, hosts, blockTools };
  }

  return {
    version: 1,
    exclude,
    roles,
    routing,
    accounts,
    ...(local === undefined ? {} : { local }),
    stickyIdleMinutes: minutes(own(root, "stickyIdleMinutes"), "stickyIdleMinutes", STICKY_IDLE_MINUTES),
    cooldownMinutes: minutes(own(root, "cooldownMinutes"), "cooldownMinutes", COOLDOWN_MINUTES),
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
