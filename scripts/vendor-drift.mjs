// Compares the files vendored from beettlle/pi-smart-router with an upstream clone. A development
// script: never shipped, not type-checked, not part of the runtime.
//
// Usage: node scripts/vendor-drift.mjs <upstream clone> [revision]
//
// For each vendored file it prints whether upstream changed it between the vendored commit and the
// revision (default HEAD), and a unified diff of the local file against upstream at the vendored
// commit, after import specifiers are normalised and the fork's own header is dropped. A clean
// run prints "unchanged upstream" for every file and no diff.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VENDORED_COMMIT = "54bee53d908a81260a34b94cbe124bfd61f57df7";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  { local: "src/triage/triage-engine.ts", upstream: "src/domain/triage/triage-engine.ts" },
  { local: "src/triage/entropy-check.ts", upstream: "src/domain/triage/entropy-check.ts" },
  { local: "src/triage/tier-features.ts", upstream: "src/domain/routing/tier-features.ts" },
];

const [clone, revision = "HEAD"] = process.argv.slice(2);
if (clone === undefined) {
  console.error("usage: node scripts/vendor-drift.mjs <upstream clone> [revision]");
  process.exit(2);
}

function git(...args) {
  const run = spawnSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    console.error(`git ${args.join(" ")}: ${run.stderr.trim()}`);
    process.exit(2);
  }
  return run.stdout;
}

/** Every import and export specifier replaced by a fixed one: only the specifiers may differ. */
function normaliseSpecifiers(text) {
  return text.replace(/(\bfrom\s*)(["'])([^"'\n]+)\2/g, '$1"<module>"');
}

/** The text without the fork's leading `//` header block and the blank line after it. */
function dropHeader(text) {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].startsWith("//")) index += 1;
  if (index > 0 && lines[index] === "") index += 1;
  return lines.slice(index).join("\n");
}

const scratch = mkdtempSync(join(tmpdir(), "vendor-drift-"));
let drifted = false;
try {
  for (const { local, upstream } of FILES) {
    const changed = git("log", "--format=%h %s", `${VENDORED_COMMIT}..${revision}`, "--", upstream).trim();
    console.log(`${local}: ${changed === "" ? `unchanged upstream between ${VENDORED_COMMIT.slice(0, 7)} and ${revision}` : `CHANGED upstream since ${VENDORED_COMMIT.slice(0, 7)}:\n${changed}`}`);
    if (changed !== "") drifted = true;

    const expected = normaliseSpecifiers(git("show", `${VENDORED_COMMIT}:${upstream}`));
    const actual = normaliseSpecifiers(dropHeader(readFileSync(join(root, local), "utf8")));
    const expectedPath = join(scratch, "upstream");
    const actualPath = join(scratch, "local");
    writeFileSync(expectedPath, expected);
    writeFileSync(actualPath, actual);
    const diff = spawnSync("diff", ["-u", "--label", `upstream/${upstream}`, "--label", `local/${local}`, expectedPath, actualPath], { encoding: "utf8" });
    if (diff.status === 1) {
      drifted = true;
      console.log(diff.stdout);
    } else if (diff.status !== 0) {
      console.error(diff.stderr);
      process.exit(2);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(drifted ? 1 : 0);
