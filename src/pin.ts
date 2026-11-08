// The local-only pin: a property of the session, kept in `smart-router.pin` custom entries.
//
// It is read on every route and guard call with the fork's bounded getLatestCustomEntry over the
// whole session (scope "all"), so nothing mirrors it in memory, and a /tree summary of a pinned
// branch into another branch stays pinned. The read fails closed:
//
//   no entry                          unpinned
//   a custom entry {v: 1, on: false}  unpinned
//   a custom entry {v: 1, on: true}   pinned with the local policy recorded in it, so a later
//                                     roster edit cannot widen what counts as local
//   anything else of that type        pinned with an empty policy, under which no model qualifies
//   (a custom_message, a malformed    until John pins again
//   entry, another version), and a
//   session whose entries cannot be
//   read at all
//
// PI_SMART_ROUTER_LOCAL_ONLY, latched in the process slot by the factory, also pins every session
// that no entry pins, with the local section of the first valid roster loaded in the process,
// which is latched too.
//
// A fork or /new carries the pin: at session_shutdown the old session leaves its policy in the
// slot under the new session's file, and the new session's session_start records it. Concurrent
// forks cannot overwrite each other, because each has its own file. Leaving a pinned session for
// another one (resume) leaves only a notice.
import { PIN_ENTRY } from "./constants.ts";
import { isRecord, own } from "./files.ts";
import { EMPTY_POLICY, parsePolicy, policyFromRoster } from "./local.ts";
import type { LocalPolicy } from "./local.ts";
import type { EnvLatch, Slot } from "./owners.ts";
import { boundedHistory } from "./route.ts";
import type { Pin } from "./route.ts";
import type { Roster } from "./roster.ts";

/** What the session's latest pin entry says. */
export type PinEntryState = "none" | "on" | "off" | "malformed" | "unreadable";

export interface PinReading extends Pin {
  readonly entry: PinEntryState;
  /** When the latest well-formed entry says it was written. */
  readonly at: string | undefined;
  /** Whether the latched environment switch is on. It pins every session that no entry pins. */
  readonly env: boolean;
}

type EntryValue =
  | { readonly kind: "on"; readonly policy: LocalPolicy; readonly at: string | undefined }
  | { readonly kind: "off"; readonly at: string | undefined }
  | { readonly kind: "malformed" };

const MALFORMED: EntryValue = Object.freeze({ kind: "malformed" });
const ON_KEYS: ReadonlySet<string> = new Set(["v", "on", "at", "local"]);
const OFF_KEYS: ReadonlySet<string> = new Set(["v", "on", "at"]);

/** One entry, exactly as the router writes it, or malformed. */
function parseEntry(entry: unknown): EntryValue {
  if (!isRecord(entry) || own(entry, "type") !== "custom" || own(entry, "customType") !== PIN_ENTRY) return MALFORMED;
  const data = own(entry, "data");
  if (!isRecord(data) || own(data, "v") !== 1) return MALFORMED;
  const on = own(data, "on");
  const at = own(data, "at");
  if (typeof on !== "boolean" || (at !== undefined && typeof at !== "string")) return MALFORMED;
  if (Object.keys(data).some((key) => !(on ? ON_KEYS : OFF_KEYS).has(key))) return MALFORMED;
  if (!on) return { kind: "off", at };
  const local = own(data, "local");
  const policy = local === undefined ? EMPTY_POLICY : parsePolicy(local);
  return policy === undefined ? MALFORMED : { kind: "on", policy, at };
}

/** A session's pin. Never throws: a session whose pin entries cannot be read counts as pinned. */
export function readPin(sessionManager: unknown, env: EnvLatch): PinReading {
  const pinned = (policy: LocalPolicy, entry: PinEntryState, at?: string): PinReading => ({ on: true, policy, entry, at, env: env.on });
  const view = boundedHistory(sessionManager);
  if (view === undefined) return pinned(EMPTY_POLICY, "unreadable");
  let value: EntryValue | undefined;
  try {
    const entry = view.getLatestCustomEntry(PIN_ENTRY, { scope: "all" });
    value = entry === undefined || entry === null ? undefined : parseEntry(entry);
  } catch {
    return pinned(EMPTY_POLICY, "unreadable");
  }
  if (value?.kind === "on") return pinned(value.policy, "on", value.at);
  if (value?.kind === "malformed") return pinned(EMPTY_POLICY, "malformed");
  const entry = value === undefined ? "none" : "off";
  const at = value?.kind === "off" ? value.at : undefined;
  return env.on ? pinned(env.policy ?? EMPTY_POLICY, entry, at) : { on: false, policy: EMPTY_POLICY, entry, at, env: false };
}

export interface PinOnData {
  readonly v: 1;
  readonly on: true;
  readonly at: string;
  readonly local: { readonly refs: string[]; readonly providers: string[]; readonly hosts: string[] };
}

export interface PinOffData {
  readonly v: 1;
  readonly on: false;
  readonly at: string;
}

/** The data of an entry that pins the session to this policy. */
export function pinOn(policy: LocalPolicy, now: number): PinOnData {
  const { refs, providers, hosts } = policy;
  return { v: 1, on: true, at: new Date(now).toISOString(), local: { refs: [...refs], providers: [...providers], hosts: [...hosts] } };
}

/** The data of the one kind of entry that unpins the session. */
export function pinOff(now: number): PinOffData {
  return { v: 1, on: false, at: new Date(now).toISOString() };
}

/** Latch the policy the environment switch pins with: the first valid roster's local section. */
export function latchEnvPolicy(env: EnvLatch, roster: Roster): void {
  if (env.on && env.policy === undefined) env.policy = policyFromRoster(roster);
}

// ─── Handoffs ────────────────────────────────────────────────────────────────

export type Handoff = { readonly kind: "pin"; readonly policy: LocalPolicy } | { readonly kind: "notice" };

/**
 * At session_shutdown. A pinned session hands its pin to the session a fork or /new creates, under
 * that session's file. A pin that only the environment switch makes needs no handoff, because the
 * latch pins the new session too. Leaving a pinned session for another one (resume) leaves only a
 * notice, and never replaces a pin left for the same file.
 */
export function leaveHandoff(slot: Slot, reason: string, target: unknown, pin: PinReading): void {
  if (!pin.on || typeof target !== "string" || target === "") return;
  if (reason === "new" || reason === "fork") {
    if (pin.entry === "none" || pin.entry === "off") return;
    const { refs, providers, hosts } = pin.policy;
    slot.handoffs.set(target, { v: 1, kind: "pin", policy: { refs: [...refs], providers: [...providers], hosts: [...hosts] } });
  } else if (reason === "resume" && !slot.handoffs.has(target)) {
    slot.handoffs.set(target, { v: 1, kind: "notice" });
  }
}

/** At session_start: the handoff left for this session's file, taken out of the slot. A malformed one pins with an empty policy. */
export function takeHandoff(slot: Slot, file: unknown): Handoff | undefined {
  if (typeof file !== "string" || file === "" || !slot.handoffs.has(file)) return undefined;
  const value = slot.handoffs.get(file);
  slot.handoffs.delete(file);
  if (isRecord(value) && own(value, "kind") === "notice") return { kind: "notice" };
  const policy = isRecord(value) ? parsePolicy(own(value, "policy")) : undefined;
  return { kind: "pin", policy: policy ?? EMPTY_POLICY };
}

// ─── Descriptions ────────────────────────────────────────────────────────────

export function describePolicy(policy: LocalPolicy): string {
  if (policy.refs.length + policy.providers.length + policy.hosts.length === 0) return "an empty policy, under which no model qualifies";
  const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));
  return `models ${list(policy.refs)}; providers ${list(policy.providers)}; hosts ${list(policy.hosts)}`;
}

/** The pin as /smart-router status shows it. */
export function describePin(pin: PinReading): string {
  switch (pin.entry) {
    case "unreadable":
      return "on: this Pi cannot read pin entries (it has no bounded session history), so the session counts as pinned, and no model qualifies";
    case "malformed":
      return "on: the latest smart-router.pin entry is not one the router wrote, so the session counts as pinned, and no model qualifies until you run /smart-router local on";
    case "on":
      return `on since ${pin.at ?? "an unknown time"}, with ${describePolicy(pin.policy)}`;
    case "none":
    case "off":
      if (!pin.env) return "off";
      return `on, by PI_SMART_ROUTER_LOCAL_ONLY, with ${describePolicy(pin.policy)}${
        pin.entry === "off" ? " (the session's own entry unpinned it, but the switch pins every session in this process)" : ""
      }`;
  }
}
