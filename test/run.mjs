// Runs the test suites in an isolated environment. Test-only; never shipped.
//
// Each run gets a fresh temporary root. HOME, the XDG directories, TMPDIR and Pi's agent
// directory live under it, the working directory is an empty root/cwd, and the environment is
// built from an allow-list (PATH, LANG, TZ), so no API key or token reaches a test. Every test
// process loads test/setup.mjs, which refuses network and child-process use. The run fails when a
// test fails, when the tripwire recorded anything, or when root/cwd or root/home gained a file.
//
// The behaviour suite (test/behaviour.test.ts) runs Pi's own runtime and its npm dependency
// closure, and scrubbing the environment is not a sandbox, so it runs only sandboxed: in the
// offline Nix build, where NIX_BUILD_TOP is set, or under sandbox-exec through test/sandbox.mjs,
// which passes --sandboxed. A run believes --sandboxed only when a write outside its root is
// refused. Anywhere else the run leaves the behaviour suite out and says so.
//
// Usage: node test/run.mjs [--root DIR] [--sandboxed] [test file ...]
//   --root DIR   use DIR, made by the caller, as the temporary root, and leave its removal to
//                the caller (test/sandbox.mjs makes it before entering the sandbox)
//   --sandboxed  run under test/sandbox.sb; checked
//   (default files: every test/*.test.ts, the behaviour suite only when sandboxed)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const BEHAVIOUR = join(testDir, "behaviour.test.ts");

/** The root this run made, removed again when the run refuses to start. */
let made;

const fail = (message) => {
  if (made !== undefined) rmSync(made, { recursive: true, force: true });
  console.error(`test/run.mjs: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
let rootArg;
let sandboxed = false;
const requested = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--root") {
    rootArg = args[index + 1];
    index += 1;
    if (rootArg === undefined || !isAbsolute(rootArg)) fail("--root needs an absolute directory");
  } else if (arg === "--sandboxed") {
    sandboxed = true;
  } else {
    requested.push(resolve(arg));
  }
}

if (rootArg === undefined) made = realpathSync(mkdtempSync(join(tmpdir(), "pi-smart-router-test-")));
const root = made ?? realpathSync(rootArg);

/** Whether the sandbox refuses a write outside the root, as test/sandbox.sb does. */
function writesConfined() {
  const probe = join(dirname(root), `${basename(root)}-sandbox-probe`);
  try {
    mkdirSync(probe);
  } catch (error) {
    return error?.code === "EPERM" || error?.code === "EACCES";
  }
  rmdirSync(probe);
  return false;
}

const nix = (process.env.NIX_BUILD_TOP ?? "") !== "";
if (sandboxed && !nix && !writesConfined()) {
  fail("--sandboxed was given, but a write outside the temporary root succeeded, so this is not test/sandbox.sb. Run `npm run check:sandbox`.");
}
const behaviour = nix || sandboxed;

const files =
  requested.length > 0
    ? requested
    : readdirSync(testDir)
        .filter((name) => name.endsWith(".test.ts"))
        .sort()
        .map((name) => join(testDir, name))
        .filter((file) => behaviour || file !== BEHAVIOUR);
if (files.length === 0) fail("no test files");
if (!behaviour && files.includes(BEHAVIOUR)) {
  fail("the behaviour suite runs Pi's own runtime, so it runs only sandboxed: run `npm run check:sandbox`; the Nix build runs it in its own sandbox.");
}

const dir = (name) => {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const home = dir("home");
const cwd = dir("cwd");
const netlog = join(root, "net.log");

const env = {};
for (const name of ["PATH", "LANG", "TZ"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
Object.assign(env, {
  HOME: home,
  XDG_CONFIG_HOME: dir("xdg/config"),
  XDG_STATE_HOME: dir("xdg/state"),
  XDG_CACHE_HOME: dir("xdg/cache"),
  TMPDIR: dir("tmp"),
  PI_CODING_AGENT_DIR: dir("agent"),
  PI_OFFLINE: "1",
  npm_config_userconfig: "/dev/null",
  PI_SMART_ROUTER_NETLOG: netlog,
});
if (files.includes(BEHAVIOUR)) env.PI_SMART_ROUTER_BEHAVIOUR = "1";

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "--import",
    pathToFileURL(join(testDir, "setup.mjs")).href,
    "--test",
    "--test-reporter=spec",
    ...files,
  ],
  { cwd, env, stdio: "inherit" },
);

const problems = [];
if (result.error) problems.push(`node did not start: ${result.error.message}`);
else if (result.status !== 0) problems.push(`node --test exited with ${result.status ?? result.signal}`);
if (existsSync(netlog)) {
  const log = readFileSync(netlog, "utf8").trim();
  if (log !== "") problems.push(`the tripwire refused:\n${log}`);
}
for (const [name, path] of [
  ["root/cwd", cwd],
  ["root/home", home],
]) {
  const left = readdirSync(path, { recursive: true });
  if (left.length > 0) problems.push(`${name} gained files: ${left.join(", ")}`);
}
if (problems.length > 0) {
  console.error(`test/run.mjs: FAILED; the temporary root is kept at ${root}\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
if (rootArg === undefined) rmSync(root, { recursive: true, force: true });
const where = nix ? "in the Nix build" : sandboxed ? "under sandbox-exec" : "in an isolated root";
console.log(`test/run.mjs: ${files.length} suite files passed ${where}; the tripwire recorded nothing`);
if (!files.includes(BEHAVIOUR)) {
  console.log("test/run.mjs: the behaviour suite was not run: it runs Pi's own runtime, so it runs only in the Nix build or under `npm run check:sandbox`");
}
