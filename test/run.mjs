// Runs the test suites in an isolated environment. Test-only; never shipped.
//
// Each run gets a fresh temporary root. HOME, the XDG directories, TMPDIR and Pi's agent
// directory live under it, the working directory is an empty root/cwd, and the environment is
// built from an allow-list (PATH, LANG, TZ), so no API key or token reaches a test. Every test
// process loads test/setup.mjs, which refuses network and child-process use. The run fails when a
// test fails, when the tripwire recorded anything, or when root/cwd or root/home gained a file.
//
// Usage: node test/run.mjs [test file ...]   (default: every test/*.test.ts)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const requested = process.argv.slice(2);
const files =
  requested.length > 0
    ? requested.map((file) => resolve(file))
    : readdirSync(testDir)
        .filter((name) => name.endsWith(".test.ts"))
        .sort()
        .map((name) => join(testDir, name));
if (files.length === 0) {
  console.error("test/run.mjs: no test files");
  process.exit(1);
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-smart-router-test-")));
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
rmSync(root, { recursive: true, force: true });
console.log(`test/run.mjs: ${files.length} suite files passed in an isolated root; the tripwire recorded nothing`);
