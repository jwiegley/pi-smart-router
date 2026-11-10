// Source scan of the shipped files (index.ts and src/**, comments included): no whole-history
// session reads, an import allow-list, and no dynamic code, process, network or timer tokens.
// Every pattern is word-bounded, so a triage keyword such as 'rename' cannot trip it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const shipped = [
  "index.ts",
  ...readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => `src/${path.split("\\").join("/")}`)
    .sort(),
];
const source = new Map(shipped.map((path) => [path, readFileSync(join(root, path), "utf8")]));

// nix-config's gallery check (test/ai/pi-gallery.nix): `\.get(Entries|Branch)([^[:alnum:]_$]|$)`.
const WHOLE_HISTORY = /\.get(?:Entries|Branch)(?:[^A-Za-z0-9_$]|$)/m;

const ALLOWED_SPECIFIERS = new Set(["node:path", "node:crypto", "@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]);
const FS_MODULE = "src/files.ts";
// `constants` supplies O_RDONLY | O_NONBLOCK, so that a FIFO at the roster's path cannot block Pi
// at open(); fstat then refuses it as not a regular file.
const FS_NAMES = new Set(["openSync", "fstatSync", "readSync", "closeSync", "constants"]);

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["require(", /\brequire\s*\(/],
  ["createRequire", /\bcreateRequire\b/],
  ["import(", /\bimport\s*\(/],
  ["eval(", /\beval\s*\(/],
  ["new Function(", /\bnew\s+Function\s*\(/],
  ["process.cwd(", /\bprocess\s*\.\s*cwd\s*\(/],
  ["process.binding", /\bprocess\s*\.\s*binding\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["fetch(", /\bfetch\s*\(/],
  ["setInterval/setTimeout", /\bset(?:Interval|Timeout)\b/],
  ["setImmediate", /\bsetImmediate\b/],
  ["AbortSignal.timeout", /\bAbortSignal\.timeout\b/],
  ["ModelRuntime.create", /\bModelRuntime\s*\.\s*create\b/],
  ["SettingsManager.create", /\bSettingsManager\s*\.\s*create\b/],
];

/** Every module specifier a file names: `… from "x"` (imports and re-exports) and `import "x"`. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/\bfrom\s*(["'])([^"'\n]+)\1|\bimport\s*(["'])([^"'\n]+)\3/g)].map(
    (match) => match[2] ?? match[4] ?? "",
  );
}

test("the shipped files are index.ts and the TypeScript under src/", () => {
  assert.ok(shipped.length > 1);
  assert.ok(shipped.includes("src/triage/triage-engine.ts"));
});

test("no shipped file reads a session's whole history", () => {
  for (const [path, text] of source) {
    assert.doesNotMatch(text, WHOLE_HISTORY, `${path} names a whole-history session read`);
  }
});

test("every import is on the allow-list", () => {
  for (const [path, text] of source) {
    for (const specifier of specifiers(text)) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) continue;
      if (specifier === "node:fs" && path === FS_MODULE) continue;
      assert.ok(ALLOWED_SPECIFIERS.has(specifier), `${path} imports ${JSON.stringify(specifier)}`);
    }
  }
});

test("node:fs is imported only by src/files.ts, only for opening, stat and reading", () => {
  const text = source.get(FS_MODULE);
  if (text === undefined) return; // src/files.ts does not exist yet
  const all = specifiers(text).filter((specifier) => specifier === "node:fs").length;
  const named = [...text.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*(["'])node:fs\2/g)];
  assert.equal(named.length, all, "node:fs must be imported by name only");
  for (const match of named) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0] ?? "";
      if (name === "") continue;
      assert.ok(FS_NAMES.has(name), `src/files.ts imports ${name} from node:fs`);
    }
  }
});

test("no shipped file names dynamic code, process, network or timer APIs", () => {
  for (const [path, text] of source) {
    for (const [label, pattern] of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${path} contains ${label}`);
    }
  }
});

test("the scanners catch what they are meant to catch", () => {
  assert.match("ctx.sessionManager.getEntries()", WHOLE_HISTORY);
  assert.match("const b = sm.getBranch", WHOLE_HISTORY);
  assert.doesNotMatch("sm.getBranchSummary()", WHOLE_HISTORY);
  assert.deepEqual(specifiers(`import { a } from "node:os";\nexport * from './x.ts';\nimport "side";`), ["node:os", "./x.ts", "side"]);
  assert.deepEqual(specifiers(`import type {\n  T,\n} from "@earendil-works/pi-ai";`), ["@earendil-works/pi-ai"]);
  const hits = (text: string) => FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  assert.deepEqual(hits("const m = await import ('x'); setTimeout(f); globalThis.fetch (u)"), ["import(", "fetch(", "setInterval/setTimeout"]);
  assert.deepEqual(hits("setImmediate(f); const signal = AbortSignal.timeout(1000);"), ["setImmediate", "AbortSignal.timeout"]);
  assert.deepEqual(hits("'rename', 'retrieval (x)', 'prefetch(x)', 'requirements (y)'"), []);
  // The router's own signal matching names the type, never the timer.
  assert.deepEqual(hits("signal: AbortSignal | undefined; AbortSignal.any([a]); 'immediately', 'setImmediately'"), []);
});
