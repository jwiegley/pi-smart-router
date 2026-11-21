// The personal-only process boundary. No live Pi or network is used.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { ENV_PERSONAL_ONLY, ENV_SCOPE, SCOPE_ENTRY } from "../src/constants.ts";
import { scopeEntry } from "../src/scope.ts";
import { fixture } from "./support/fixtures.ts";
import { agentDir, classifierModel, FakeRuntime, request, resetSlot, start } from "./support/pi.ts";

beforeEach(resetSlot);
afterEach(resetSlot);

async function personalOnly(run: () => Promise<void>): Promise<void> {
  const before = process.env[ENV_SCOPE];
  process.env[ENV_SCOPE] = "personal-only";
  try { await run(); } finally {
    if (before === undefined) delete process.env[ENV_SCOPE];
    else process.env[ENV_SCOPE] = before;
  }
}

test("personal-only rejects selecting work scope without recording an entry", async (t) => personalOnly(async () => {
  const loaded = await start({ dir: agentDir(t, { roster: fixture("roster-hera-v2.json") }) });
  await loaded.host.command("smart-router", "scope work");
  assert.match(loaded.session.notices.at(-1)?.message ?? "", /work scope.*disabled/i);
  assert.equal(loaded.session.entries.filter((entry) => entry.customType === SCOPE_ENTRY).length, 0);
  delete process.env[ENV_SCOPE];
  await loaded.host.command("smart-router", "scope work");
  assert.match(loaded.session.notices.at(-1)?.message ?? "", /work scope.*disabled/i, "the restriction remains latched");
  await loaded.host.command("smart-router", "status");
  assert.match(loaded.session.notices.at(-1)?.message ?? "", /personal-only.*work scope is disabled/i);
}));

test("personal-only refuses restored work sessions on both router models and never asks Jev", async (t) => personalOnly(async () => {
  const runtime = new FakeRuntime();
  runtime.classifiers.set("openrouter/typesafe/jev-1.14", classifierModel("openrouter/typesafe/jev-1.14"));
  const loaded = await start({ dir: agentDir(t, { roster: fixture("roster-hera-v2.json") }), runtime,
    setup: (session) => session.appendCustom(SCOPE_ENTRY, scopeEntry("work", "command", 0)) });
  await loaded.host.emit("input", { text: "review this work", source: "interactive" });
  assert.deepEqual(runtime.classifyCalls, []);
  assert.throws(() => runtime.route("auto", request("direct")), /work scope.*disabled.*Nothing was sent/i);
  loaded.session.select("local");
  assert.throws(() => runtime.route("local", request("direct")), /work scope.*disabled.*Nothing was sent/i);
}));

test("personal-only refuses unreadable scope rather than treating it as personal", async (t) => personalOnly(async () => {
  const loaded = await start({ dir: agentDir(t, { roster: fixture("roster-hera-v2.json") }),
    setup: (session) => session.appendCustom(SCOPE_ENTRY, { malformed: true }) });
  assert.throws(() => loaded.runtime.route("auto", request("direct")), /Nothing was sent/);
  loaded.session.select("local");
  assert.throws(() => loaded.runtime.route("local", request("direct")), /Nothing was sent/);
}));

test("an independent personal-only switch preserves and refuses an inherited work latch", async (t) => {
  const scope = process.env[ENV_SCOPE];
  const personal = process.env[ENV_PERSONAL_ONLY];
  process.env[ENV_SCOPE] = "work";
  process.env[ENV_PERSONAL_ONLY] = "1";
  try {
    const runtime = new FakeRuntime();
    runtime.classifiers.set("openrouter/typesafe/jev-1.14", classifierModel("openrouter/typesafe/jev-1.14"));
    const loaded = await start({ dir: agentDir(t, { roster: fixture("roster-hera-v2.json") }), runtime });
    delete process.env[ENV_SCOPE];
    delete process.env[ENV_PERSONAL_ONLY];
    await loaded.host.emit("input", { text: "work request", source: "interactive" });
    assert.deepEqual(runtime.classifyCalls, []);
    assert.throws(() => runtime.route("auto", request("direct")), /work scope.*disabled.*Nothing was sent/i);
    loaded.session.select("local");
    assert.throws(() => runtime.route("local", request("direct")), /work scope.*disabled.*Nothing was sent/i);
  } finally {
    if (scope === undefined) delete process.env[ENV_SCOPE]; else process.env[ENV_SCOPE] = scope;
    if (personal === undefined) delete process.env[ENV_PERSONAL_ONLY]; else process.env[ENV_PERSONAL_ONLY] = personal;
  }
});
