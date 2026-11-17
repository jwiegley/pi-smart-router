// The only module that touches the file system. It reads the router's files under Pi's agent
// directory, the roster, Multi-Pass's labels and the prompt files the roster names in
// smart-router/, and nothing else, and it never writes. The standalone checker reads the one
// roster it is given, and that roster's prompt files, with the same reader.
//
// A read opens the path once, read-only and non-blocking (a symlink resolves to its target; a
// FIFO cannot stall Pi), checks the open descriptor with fstat, and then reads at most the cap
// plus one byte from that same descriptor, so nothing can change between the check and the read.
// The file must be a regular file owned by this user and writable by no one else.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** What decides whether a file changed since it was last read. */
export interface Identity {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
}

export type Failure = "missing" | "unsafe" | "invalid";

export type FileRead =
  | { readonly kind: "read"; readonly identity: Identity; readonly text: string }
  | { readonly kind: "unchanged"; readonly identity: Identity }
  | { readonly kind: Failure; readonly error: string };

/** The descriptor calls a read makes. Tests substitute them to reach the races. */
export interface FileSystem {
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): {
    isFile(): boolean;
    readonly dev: number;
    readonly ino: number;
    readonly mode: number;
    readonly uid: number;
    readonly size: number;
    readonly mtimeMs: number;
  };
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: null): number;
  closeSync(fd: number): void;
}

const NODE_FS: FileSystem = { openSync, fstatSync, readSync, closeSync };

/** O_NONBLOCK is absent on Windows, where it is not needed. */
export const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export interface ReadOptions {
  readonly maxBytes: number;
  /** The required owner; `process.getuid()` by default. */
  readonly uid?: number | undefined;
  /**
   * Accept a file of any owner. For the standalone checker alone (--no-owner-check), which a build
   * runs on a roster in the Nix store, where every file is root's. The router never sets it: no
   * AgentFile takes it. The file must still be writable by its owner only.
   */
  readonly anyOwner?: boolean | undefined;
  /** When the file still has this identity, report it unchanged instead of reading it. */
  readonly previous?: Identity | undefined;
  readonly fs?: FileSystem | undefined;
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "error";
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** Read one of the router's files safely. Never throws. */
export function readUserFile(path: string, options: ReadOptions): FileRead {
  if (!isAbsolute(path)) return { kind: "invalid", error: `${path} is not an absolute path` };
  const fs = options.fs ?? NODE_FS;
  const uid = options.uid ?? process.getuid?.();
  let fd: number;
  try {
    fd = fs.openSync(path, OPEN_FLAGS);
  } catch (error) {
    const code = errorCode(error);
    return code === "ENOENT"
      ? { kind: "missing", error: `${path} does not exist` }
      : { kind: "invalid", error: `${path} cannot be opened (${code})` };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: "unsafe", error: `${path} is not a regular file` };
    if (options.anyOwner !== true) {
      if (uid === undefined) return { kind: "unsafe", error: `${path}: its owner cannot be checked on this platform` };
      if (stat.uid !== uid) return { kind: "unsafe", error: `${path} is owned by uid ${stat.uid}, not ${uid}` };
    }
    if ((stat.mode & 0o022) !== 0) {
      const mode = (stat.mode & 0o777).toString(8).padStart(3, "0");
      return { kind: "unsafe", error: `${path} is writable by its group or by others (mode ${mode})` };
    }
    const tooLarge = { kind: "invalid", error: `${path} is larger than ${options.maxBytes} bytes` } as const;
    if (stat.size > options.maxBytes) return tooLarge;
    const identity: Identity = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
    if (options.previous !== undefined && sameIdentity(options.previous, identity)) return { kind: "unchanged", identity };
    const buffer = new Uint8Array(options.maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > options.maxBytes) return tooLarge;
    try {
      return { kind: "read", identity, text: UTF8.decode(buffer.subarray(0, length)) };
    } catch {
      return { kind: "invalid", error: `${path} is not valid UTF-8` };
    }
  } catch (error) {
    return { kind: "invalid", error: `${path} cannot be read (${errorCode(error)})` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Nothing useful to do: the descriptor is gone either way.
    }
  }
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** A JSON object, as the parsers of the router's files take it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An own property only, so nothing inherited, polluted or not, can stand in for a missing field. */
export function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The state of one file, as last loaded. `loadedAt` is when its content was last read. */
export type Loaded<T> =
  | { readonly kind: "ok"; readonly path: string; readonly value: T; readonly loadedAt: number }
  | { readonly kind: Failure; readonly path: string; readonly error: string; readonly loadedAt: number };

export interface AgentFile<T> {
  /** The last state; loads on first use. */
  current(): Loaded<T>;
  /** Loads again when the path or the file's (dev, ino, mtimeMs, size) changed. */
  refresh(): Loaded<T>;
  /** Reads and parses again, whatever the identity. */
  reload(): Loaded<T>;
}

export interface AgentFileOptions<T> {
  /** Pi's agent directory, asked afresh on every load. It must be absolute. */
  readonly agentDir: () => string;
  readonly name: string;
  readonly maxBytes: number;
  readonly parse: (text: string) => Parsed<T>;
  readonly uid?: number | undefined;
  readonly fs?: FileSystem | undefined;
  readonly now?: (() => number) | undefined;
}

/**
 * One of the router's files under Pi's agent directory, cached by identity. There is no
 * last-known-good copy: a failed load replaces whatever was loaded before.
 */
export function agentFile<T>(options: AgentFileOptions<T>): AgentFile<T> {
  let state: Loaded<T> | undefined;
  let identity: Identity | undefined;
  const now = options.now ?? Date.now;

  const load = (force: boolean): Loaded<T> => {
    const dir = options.agentDir();
    const path = join(dir, options.name);
    const loadedAt = now();
    if (!isAbsolute(dir)) {
      identity = undefined;
      state = { kind: "invalid", path, error: `PI_CODING_AGENT_DIR is relative (${dir})`, loadedAt };
      return state;
    }
    // A previous identity is offered only with a state for the same path, so "unchanged" always
    // has a state to keep.
    const previous = !force && state !== undefined && state.path === path ? identity : undefined;
    const read = readUserFile(path, { maxBytes: options.maxBytes, uid: options.uid, previous, fs: options.fs });
    if (read.kind === "unchanged") return state ?? load(true);
    if (read.kind === "read") {
      identity = read.identity;
      const parsed = options.parse(read.text);
      state = parsed.ok
        ? { kind: "ok", path, value: parsed.value, loadedAt }
        : { kind: "invalid", path, error: parsed.error, loadedAt };
      return state;
    }
    identity = undefined;
    state = { kind: read.kind, path, error: read.error, loadedAt };
    return state;
  };

  return {
    current: () => state ?? load(false),
    refresh: () => load(false),
    reload: () => load(true),
  };
}
