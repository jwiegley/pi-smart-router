// Shared helpers for the unit suites. Test-only; never shipped. Scratch files live under the
// isolated TMPDIR that test/run.mjs provides.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

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
