// Runs every test suite, the behaviour suite included, under the sandbox-exec profile
// test/sandbox.sb: no network but loopback, no writes outside a fresh temporary root, and no file
// contents read under the home directory but the checkout's and the root's. Test-only; never
// shipped. macOS only: elsewhere the behaviour suite runs in the offline Nix build.
//
// It makes the root before entering the sandbox, because inside it nothing outside the root is
// writable, then runs test/run.mjs inside with --root and --sandboxed, and removes the root when
// the run passed. The home directory comes from the user database, not from HOME, so a changed
// environment cannot point the profile's credential rules elsewhere.
//
// Usage: node test/sandbox.mjs [test file ...]   (default: every suite, as test/run.mjs runs them)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const testDir = dirname(fileURLToPath(import.meta.url));

if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
  console.error("test/sandbox.mjs: check:sandbox needs macOS sandbox-exec; elsewhere the behaviour suite runs in the Nix build.");
  process.exit(1);
}

const repo = realpathSync(join(testDir, ".."));
const home = realpathSync(userInfo().homedir);
const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-smart-router-sandbox-")));
const result = spawnSync(
  SANDBOX_EXEC,
  [
    "-f",
    join(testDir, "sandbox.sb"),
    "-D",
    `ROOT=${root}`,
    "-D",
    `HOME=${home}`,
    "-D",
    `REPO=${repo}`,
    process.execPath,
    join(testDir, "run.mjs"),
    "--root",
    root,
    "--sandboxed",
    ...process.argv.slice(2).map((file) => resolve(file)),
  ],
  { cwd: repo, stdio: "inherit" },
);
if (result.error !== undefined || result.status !== 0) {
  const why = result.error?.message ?? `exit ${result.status ?? result.signal}`;
  console.error(`test/sandbox.mjs: FAILED (${why}); the temporary root is kept at ${root}`);
  process.exit(1);
}
rmSync(root, { recursive: true, force: true });
