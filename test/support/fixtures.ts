// Shared helpers for the unit suites. Test-only; never shipped. Scratch files live under the
// isolated TMPDIR that test/run.mjs provides.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { FileSystem } from "../../src/files.ts";

/** A fresh directory, removed when the test ends. */
export function scratch(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "psr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a file with an exact mode, whatever the umask. */
export function write(dir: string, name: string, content: string | Uint8Array, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

/** The text of a file under test/fixtures. */
export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

/** Assert a result's kind and narrow to it. */
export function expectKind<R extends { readonly kind: string }, K extends R["kind"]>(result: R, kind: K): R & { readonly kind: K } {
  assert.equal(result.kind, kind, JSON.stringify(result));
  return result as R & { readonly kind: K };
}

/** One file of a fakeFileSystem: its text, and the owner, mode and identity fstat gives for it. */
export interface FakeFile {
  text: string;
  uid: number;
  /** The permission bits alone; the file is always a regular one. */
  mode: number;
  ino?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

/**
 * The descriptor calls src/files.ts makes, over the given files by absolute path: how a test shows
 * a file root owns, as one in the Nix store is, without making one. A file's fields may be changed
 * between reads; an open takes its text as it is then.
 */
export function fakeFileSystem(files: ReadonlyMap<string, FakeFile>): FileSystem {
  const open = new Map<number, { readonly file: FakeFile; readonly bytes: Uint8Array; offset: number }>();
  let next = 100;
  const opened = (fd: number): { readonly file: FakeFile; readonly bytes: Uint8Array; offset: number } => {
    const found = open.get(fd);
    if (found === undefined) throw Object.assign(new Error(`EBADF: ${fd}`), { code: "EBADF" });
    return found;
  };
  return {
    openSync(path) {
      const file = files.get(path);
      if (file === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      next += 1;
      open.set(next, { file, bytes: new TextEncoder().encode(file.text), offset: 0 });
      return next;
    },
    fstatSync(fd) {
      const { file, bytes } = opened(fd);
      return {
        isFile: () => true,
        dev: 1,
        ino: file.ino ?? 1,
        mode: 0o100000 | file.mode,
        uid: file.uid,
        size: bytes.length,
        mtimeMs: file.mtimeMs ?? 1_000,
        ctimeMs: file.ctimeMs ?? 1_000,
      };
    },
    readSync(fd, buffer, offset, length) {
      const state = opened(fd);
      const count = Math.min(length, state.bytes.length - state.offset);
      buffer.set(state.bytes.subarray(state.offset, state.offset + count), offset);
      state.offset += count;
      return count;
    },
    closeSync(fd) {
      open.delete(fd);
    },
  };
}
