// The roster checker (src/check.ts): a roster's routing read back in plain language, or its first
// error with its place; the standalone entry point's run (src/check-cli.ts) and /smart-router
// check. The standalone entry point itself is not started here, because the tripwire refuses child
// processes: its whole run is runCheck, which these tests call.
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { afterEach, beforeEach, describe } from "node:test";
import { fileURLToPath } from "node:url";

import { CHECK_USAGE, checkFile, checkRoster, runCheck } from "../src/check.ts";
import { FakeCatalog, model, NOW } from "./support/catalog.ts";
import { fixture, scratch, write } from "./support/fixtures.ts";
import { agentDir, FakeRuntime, resetSlot, start } from "./support/pi.ts";

const JOHN = fixture("roster-hera-v2-fallback.json");
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";

const TAIL = [
  "A usage-limit or authentication error takes a cloud model out of routing for 30 minutes, and with it every model of the same subscription account; a local-role model is never taken out.",
  "A local model whose server cannot be reached is skipped for 2 minutes, and the request goes to the next model in the order above.",
  "This reads the roster alone. Whether each model is in Pi's catalog on this host, available and has credentials is /smart-router status's to say.",
];

/** What the checker says of John's roster of 2026-11-17, after its first line. */
const JOHN_ROUTING = [
  "smart-router/auto in personal scope: a tag, else Jev (openrouter/typesafe/jev-1.14), else the keywords, pick the level; each level tries its own models in order:",
  "  LOW    openai-codex-2/gpt-6-luna  (role low)",
  "  MEDIUM openai-codex-2/gpt-6.1-terra  (role medium)",
  "  HIGH   openai-codex-2/gpt-6.1-sol  (role high)",
  "  SUPER  openai-codex-2/gpt-6-astra  (role super)",
  "  then, for every level, when its own models cannot take a request, the fallback chain in this order:",
  "    1. openrouter/z-ai/glm-5.3-flash  (role openrouter)",
  "    2. openrouter/qwen/qwen3.8-27b  (role openrouter)",
  "    3. omlx-hera/GLM-5.3-Flash-oQ4e-mtp  (role local, thinking max)",
  `    4. ${NYX_QWEN}  (role local, thinking max)`,
  "    5. omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp  (role local, thinking max)",
  "  under the pin: only the local role local, in its own order (below)",
  "",
  "smart-router/auto in work scope: a tag, else Jev (openrouter/typesafe/jev-1.14), else the keywords, pick the level; each level tries its own models in order:",
  "  LOW    openai-codex-3/gpt-6-luna  (role work-low)",
  "  MEDIUM openai-codex-3/gpt-6.1-terra  (role work-medium)",
  "  HIGH   openai-codex-3/gpt-6.1-sol  (role work-high)",
  "  SUPER  openai-codex-3/gpt-6-astra  (role work-super)",
  "  no fallback: a level with no available model passes its run up to the next level; with none above, the run is refused",
  "  sessions under these directories are in work scope: /Users/johnw/src/positron",
  "  under the pin: refused, since smart-router/auto does not reach the local role in this scope; choose smart-router/local",
  "",
  "smart-router/local, in any scope, pinned or not: only these, in this order, never a cloud model:",
  "  1. omlx-hera/GLM-5.3-Flash-oQ4e-mtp  (role local, thinking max)",
  `  2. ${NYX_QWEN}  (role local, thinking max)`,
  "  3. omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp  (role local, thinking max)",
  "  local means: a provider of omlx-hera, nyx whose base URL is on hera.lan, nyx.lan",
  "",
  "Jev's prompts: the question it is asked, and what each level means:",
  "  instructions: built-in, 139 characters",
  "  personal LOW: inline in the roster, 61 characters",
  "  personal MEDIUM: inline in the roster, 42 characters",
  "  personal HIGH: inline in the roster, 52 characters",
  "  personal SUPER: inline in the roster, 43 characters",
  "  work LOW: inline in the roster, 61 characters",
  "  work MEDIUM: inline in the roster, 42 characters",
  "  work HIGH: inline in the roster, 52 characters",
  "  work SUPER: inline in the roster, 43 characters",
  "",
  "Accounts:",
  '  openai-codex-2: the Multi-Pass label "personal", personal scope',
  '  openai-codex-3: the Multi-Pass label "Positron work", work scope',
  ...TAIL,
];

describe("checking a roster's text", () => {
  test("John's roster reads back as his routing: each level's model, the one chain in order, and the local three", () => {
    assert.deepEqual(checkRoster(JOHN), { ok: true, lines: ["OK: a valid version 2 roster.", "", ...JOHN_ROUTING] });
  });

  test("a version 2 roster without a chain or a classifier, for one scope, says what the other scope and the pin do", () => {
    const report = checkRoster(fixture("roster-work.json"));
    assert.equal(report.ok, true);
    assert.deepEqual(report.lines.slice(0, 13), [
      "OK: a valid version 2 roster.",
      "",
      "smart-router/auto in personal scope: refused, since the roster has no personal scope",
      "",
      "smart-router/auto in work scope: a tag, else the keywords, pick the level; each level tries its own models in order:",
      "  LOW    openai-codex/gpt-6-luna  (role work-low)",
      "  MEDIUM openai-codex/gpt-6.1-terra  (role work-medium)",
      "  HIGH   openai-codex/gpt-6.1-sol  (role work-high)",
      "  SUPER  openai-codex/gpt-6-astra  (role work-super)",
      "  no fallback: a level with no available model passes its run up to the next level; with none above, the run is refused",
      "  under the pin: refused, since smart-router/auto does not reach the local role in this scope; choose smart-router/local",
      "",
      "smart-router/local, in any scope, pinned or not:",
    ]);
    assert.equal(report.lines[13], "  refused: the roster has no local section");
  });

  test("a level with several models of its own lists them in order", () => {
    const report = checkRoster(fixture("roster-hera-v2.json"));
    assert.ok(report.lines.includes(`  LOW    openai-codex-2/gpt-6-luna, then ${NYX_QWEN}, then omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp  (role low)`), report.lines.join("\n"));
    assert.ok(report.lines.includes("  under the pin: refused, since smart-router/auto does not reach the local role in this scope; choose smart-router/local"));
  });

  test("a version 1 roster reads back as its routing table and one-hop fallbacks", () => {
    const report = checkRoster(fixture("roster-hera.json"));
    assert.deepEqual(report.lines.slice(0, 9), [
      "OK: a valid version 1 roster.",
      "",
      "smart-router/auto in personal scope (version 1: the keywords pick the kind of run):",
      "  planning openai-codex-2/gpt-6-astra  (role architect); then the fallback openrouter/moonshotai/kimi-k3.1-pro  (role thinker)",
      "  complex  openai-codex-2/gpt-6.1-sol  (role engineer); then the fallback openrouter/z-ai/glm-5.3  (role coder)",
      "  default  openrouter/deepseek/deepseek-v4.1-flash-1017  (role worker); no fallback",
      "  trivial  openrouter/deepseek/deepseek-v4.1-flash-1017  (role worker); no fallback",
      "  under the pin: refused, since smart-router/auto does not reach the local role in this scope; choose smart-router/local",
      "smart-router/auto in work scope: refused, since a version 1 roster serves no work scope",
    ]);
  });

  test("an invalid roster gives the parser's first error, with its place, and says what it costs", () => {
    const twice = JSON.parse(JOHN);
    twice.roles[3].models.push("omlx-hera/GLM-5.3-Flash-oQ4e-mtp");
    assert.deepEqual(checkRoster(JSON.stringify(twice)), {
      ok: false,
      lines: [
        'INVALID: roles[3].models[1]: "omlx-hera/GLM-5.3-Flash-oQ4e-mtp" is already in role "local"',
        "Both smart-router/auto and smart-router/local refuse every request while the roster is invalid.",
      ],
    });
    assert.match(checkRoster("{ nope").lines[0] ?? "", /^INVALID: JSON syntax error: /);
    assert.deepEqual(checkRoster("[]").lines[0], "INVALID: roster: must be a JSON object");
  });

  test("the README's fallback example is John's roster, and its read-back is what the checker prints", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const section = readme.slice(readme.indexOf("### A fallback chain"), readme.indexOf("### Fields in version 2"));
    const [, example] = /```json\n([\s\S]*?)\n```/.exec(section) ?? [];
    assert.equal(`${example}\n`, JOHN);
    const [, shown] = /```text\n([\s\S]*?)\n```/.exec(section) ?? [];
    assert.deepEqual((shown ?? "").split("\n"), JOHN_ROUTING.slice(0, 12));
  });

  test("every roster the README shows is valid", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const rosters = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "").filter((text) => /"version"\s*:/.test(text));
    assert.ok(rosters.length >= 5, `the README shows ${rosters.length} rosters`);
    for (const text of rosters) {
      const report = checkRoster(text);
      assert.equal(report.ok, true, `${report.lines[0]}\n${text.slice(0, 200)}`);
    }
  });
});

describe("checking a roster file", () => {
  test("a file is read as the router reads its own: missing, unsafe and oversized files are reported so", (t) => {
    const dir = scratch(t);
    assert.deepEqual(checkFile(join(dir, "none.json")), { ok: false, lines: [`MISSING: ${join(dir, "none.json")} does not exist`] });
    const loose = write(dir, "loose.json", JOHN, 0o666);
    assert.deepEqual(checkFile(loose), { ok: false, lines: [`UNSAFE: ${loose} is writable by its group or by others (mode 666)`] });
    const big = write(dir, "big.json", " ".repeat(64 * 1024 + 1));
    assert.deepEqual(checkFile(big), { ok: false, lines: [`INVALID: ${big} is larger than 65536 bytes`] });
    assert.deepEqual(checkFile("relative.json"), { ok: false, lines: ["INVALID: relative.json is not an absolute path"] });
    const good = write(dir, "smart-router.json", JOHN, 0o644);
    assert.deepEqual(checkFile(good), checkRoster(JOHN));
  });

  test("the standalone run prints the path and the report, and exits 0, 1 or 2", (t) => {
    const dir = scratch(t);
    const good = write(dir, "good.json", JOHN);
    const bad = write(dir, "bad.json", JOHN.replace('"fallback": ["openrouter", "local"]', '"fallback": ["openrouter", "cloud"]'));
    const run = (...paths: string[]): readonly [number, string[]] => {
      const out: string[] = [];
      return [runCheck(paths, (line) => out.push(line)), out];
    };
    assert.deepEqual(run(good), [0, [good, "OK: a valid version 2 roster.", "", ...JOHN_ROUTING]]);
    assert.deepEqual(run(bad), [
      1,
      [bad, 'INVALID: scopes.personal.fallback[1]: "cloud" is not a role', "Both smart-router/auto and smart-router/local refuse every request while the roster is invalid."],
    ]);
    assert.deepEqual(run(), [2, [CHECK_USAGE]]);
    assert.deepEqual(run(good, bad), [2, [CHECK_USAGE]]);
    assert.deepEqual(run("--help"), [2, [CHECK_USAGE]]);
  });

  test("the standalone checker imports nothing of Pi's, so it runs without Pi and without credentials", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const seen = new Set<string>();
    const outside = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, "utf8");
      // Imports that survive type stripping: every import and re-export but `import type` and `export type`.
      for (const match of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^"';]*?from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)) {
        const specifier = match[1] ?? match[2] ?? "";
        if (specifier.startsWith(".")) visit(resolve(dirname(file), specifier));
        else outside.add(specifier);
      }
    };
    visit(join(src, "check-cli.ts"));
    assert.deepEqual([...outside].sort(), ["node:fs", "node:path"]);
    assert.ok(seen.has(join(src, "roster.ts")) && seen.has(join(src, "files.ts")), "it uses the router's own parser and file reader");
    assert.equal(seen.has(join(src, "decide.ts")) || seen.has(join(src, "router.ts")) || seen.has(join(src, "jev.ts")), false);
    // The entry point's whole body is that run: nothing else to test in a child process.
    const cli = readFileSync(join(src, "check-cli.ts"), "utf8");
    assert.match(cli, /process\.exitCode = runCheck\(/);
  });
});

describe("/smart-router check", () => {
  beforeEach(resetSlot);
  afterEach(resetSlot);

  test("reads the roster back, and for a broken one gives the error and its place, changing and sending nothing", async (t) => {
    const dir = agentDir(t, { roster: JOHN });
    const runtime = new FakeRuntime(new FakeCatalog([model("openai-codex-2/gpt-6-luna")]));
    runtime.addClassifier("openrouter/typesafe/jev-1.14");
    const loaded = await start({ dir, runtime, now: () => NOW });
    const entries = loaded.session.entries.length;
    const check = async (): Promise<{ readonly message: string; readonly type: string }> => {
      await loaded.host.command("smart-router", "check");
      const notice = loaded.session.notices.at(-1);
      assert.ok(notice !== undefined);
      return notice;
    };
    const good = await check();
    assert.equal(good.type, "info");
    const [head, blank, ...rest] = good.message.split("\n");
    assert.match(head ?? "", new RegExp(`^pi-smart-router check: ${join(dir, "smart-router.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: valid, loaded at \\d\\d:\\d\\d$`));
    assert.equal(blank, "");
    assert.deepEqual(rest, JOHN_ROUTING);

    // A typo, saved: the same model in two roles, as on 2026-11-16.
    const path = join(dir, "smart-router.json");
    writeFileSync(path, JOHN.replace('"models": ["openai-codex-2/gpt-6.1-terra"]', '"models": ["openai-codex-2/gpt-6.1-terra", "omlx-hera/GLM-5.3-Flash-oQ4e-mtp"]'));
    utimesSync(path, new Date(NOW + 5_000), new Date(NOW + 5_000));
    const bad = await check();
    assert.equal(bad.type, "warning");
    assert.match(
      bad.message,
      /: invalid \(roles\[3\]\.models\[1\]: "omlx-hera\/GLM-5\.3-Flash-oQ4e-mtp" is already in role "local"\), checked at \d\d:\d\d\nBoth smart-router\/auto and smart-router\/local refuse every request until it is fixed\. Nothing was changed\.$/,
    );
    assert.equal(loaded.session.entries.length, entries, "check records nothing");
    assert.equal(runtime.classifyCalls.length, 0, "check asks no classifier");
    assert.equal(`${loaded.session.model?.provider}/${loaded.session.model?.id}`, "smart-router/auto");
    // Arguments are refused, as for every subcommand.
    await loaded.host.command("smart-router", "check now");
    assert.match(loaded.session.notices.at(-1)?.message ?? "", /^Usage: \/smart-router /);
  });
});
