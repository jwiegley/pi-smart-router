// The package contract: what nix-config's mkSourcePiExtension asserts with jq before it installs
// the package, plus the pinned development inputs and the reviewed lock. The tarball surface is
// checked by `npm run pack:check`, because the test tripwire refuses child processes.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${what} is not an object`);
  return value;
}

const manifest = record(JSON.parse(read("package.json")), "package.json");

const devDependencies = {
  "@earendil-works/pi-ai": "1.5.2",
  "@earendil-works/pi-coding-agent": "1.5.2",
  "@types/node": "22.19.19",
  typescript: "5.9.3",
};
const peerDependencies = {
  "@earendil-works/pi-ai": ">=1.5.0",
  "@earendil-works/pi-coding-agent": ">=1.5.0",
};

// Reviewed: neither script ever runs, because every install passes --ignore-scripts and the
// repository .npmrc sets ignore-scripts=true. A new entry, or a new version of one of these,
// needs a fresh review before it is added here.
const reviewedInstallScripts = new Set(["node_modules/@google/genai@2.21.0", "node_modules/protobufjs@7.6.6"]);

test("package.json satisfies mkSourcePiExtension's assertions", () => {
  assert.equal(manifest.name, "pi-smart-router");
  assert.equal(manifest.version, "1.4.0-jw.3");
  assert.equal(manifest.type, "module");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.pi, { extensions: ["./index.ts"] });
  assert.equal(manifest.dependencies, undefined);
  const scripts = record(manifest.scripts, "scripts");
  for (const name of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(scripts[name], undefined, `${name} must be absent`);
  }
  assert.equal(existsSync(new URL("../index.ts", import.meta.url)), true);
});

test("package.json declares no runtime surface beyond the source extension", () => {
  for (const name of ["main", "exports", "bin", "allowScripts", "minPiVersion", "bundleDependencies", "bundledDependencies", "optionalDependencies"]) {
    assert.equal(manifest[name], undefined, `${name} must be absent`);
  }
  assert.equal(record(manifest.pi, "pi").skills, undefined);
  const scripts = record(manifest.scripts, "scripts");
  for (const name of ["prepack", "postpack", "prepublish", "prepublishOnly", "publish", "postpublish", "preversion", "version", "postversion"]) {
    assert.equal(scripts[name], undefined, `${name} must be absent`);
  }
  assert.equal(manifest.private, true, "the fork is never published to npm");
  assert.deepEqual(manifest.files, ["index.ts", "src/**/*.ts", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.engines, { node: ">=22.19.0" });
});

test("the gate stays whole", () => {
  const scripts = record(manifest.scripts, "scripts");
  assert.equal(scripts.check, "tsc --noEmit && node test/run.mjs && npm run pack:check");
  assert.equal(scripts["check:sandbox"], "tsc --noEmit && node test/sandbox.mjs && npm run pack:check");
  assert.equal(scripts.test, "node test/run.mjs");
  assert.equal(scripts.typecheck, "tsc --noEmit");
  assert.equal(scripts["pack:check"], "npm pack --dry-run --json --ignore-scripts | node test/pack-check.mjs");
});

test("development inputs are pinned exactly and Pi is an optional peer", () => {
  assert.deepEqual(manifest.devDependencies, devDependencies);
  assert.deepEqual(manifest.peerDependencies, peerDependencies);
  assert.deepEqual(manifest.peerDependenciesMeta, {
    "@earendil-works/pi-ai": { optional: true },
    "@earendil-works/pi-coding-agent": { optional: true },
  });
});

test(".npmrc disables install scripts and registry chatter", () => {
  const settings = read(".npmrc")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  assert.deepEqual(settings.sort(), ["audit=false", "fund=false", "ignore-scripts=true", "update-notifier=false"]);
});

test("LICENSE is the MIT text with both copyright lines", () => {
  const license = read("LICENSE");
  assert.match(license, /^MIT License\n/);
  assert.match(license, /^Copyright \(c\) 2026 beettlle and contributors$/m);
  assert.match(license, /^Copyright \(c\) 2026 John Wiegley$/m);
  assert.match(license, /Permission is hereby granted, free of charge, to any person obtaining a copy/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
});

test("the lock resolves every package from the registry with sha512 integrity", () => {
  const lock = record(JSON.parse(read("package-lock.json")), "package-lock.json");
  assert.equal(lock.lockfileVersion, 3);
  const packages = record(lock.packages, "packages");
  const rootEntry = record(packages[""], "the root entry");
  assert.equal(rootEntry.name, "pi-smart-router");
  assert.equal(rootEntry.version, "1.4.0-jw.3");
  assert.deepEqual(rootEntry.devDependencies, devDependencies);
  assert.deepEqual(rootEntry.peerDependencies, peerDependencies);
  assert.equal(rootEntry.dependencies, undefined);
  const installScripts: string[] = [];
  for (const [path, value] of Object.entries(packages)) {
    if (path === "") continue;
    const entry = record(value, path);
    assert.notEqual(entry.link, true, `${path} is a link`);
    assert.equal(typeof entry.version, "string", `${path} has no version`);
    assert.match(String(entry.resolved), /^https:\/\/registry\.npmjs\.org\//, `${path} is not resolved from the registry`);
    assert.match(String(entry.integrity), /^sha512-/, `${path} has no sha512 integrity`);
    assert.equal(entry.dev, true, `${path} is not a development dependency`);
    if (entry.hasInstallScript === true) installScripts.push(`${path}@${String(entry.version)}`);
  }
  for (const entry of installScripts) {
    assert.ok(reviewedInstallScripts.has(entry), `${entry} declares an install script that has not been reviewed`);
  }
});
