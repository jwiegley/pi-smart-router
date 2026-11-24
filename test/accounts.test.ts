import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { checkAccount, labelsFile, needsLabels, parseMultiPass, subscriptionKind } from "../src/accounts.ts";
import type { AccountCheck, Labels } from "../src/accounts.ts";
import { MULTI_PASS_MAX_BYTES } from "../src/constants.ts";
import type { Loaded } from "../src/files.ts";
import { parseRoster, SCOPES } from "../src/roster.ts";
import type { AccountBinding, RosterV1, RosterV2, ScopedBinding } from "../src/roster.ts";
import { rosterFixtureV2 } from "./support/catalog.ts";
import { expectKind, fixture, scratch, write } from "./support/fixtures.ts";

function roster(name: string): RosterV1 {
  const parsed = parseRoster(fixture(name));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.ok(parsed.value.version === 1, `${name} is not a version 1 roster`);
  return parsed.value;
}

const HERA = roster("roster-hera.json");
const OTHERS = roster("roster-other-hosts.json");

/** A roster whose bindings are set directly, as if validation had been bypassed. */
function bound(bindings: Array<[string, AccountBinding]>): RosterV1 {
  return { ...HERA, accounts: new Map(bindings) };
}

/** Labels as loaded from a Multi-Pass file with these subscriptions. */
function labels(subscriptions: unknown[]): Loaded<Labels> {
  const parsed = parseMultiPass(JSON.stringify({ subscriptions, pools: [], chains: [], presets: [] }));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return { kind: "ok", path: "/agent/multi-pass.json", value: parsed.value, loadedAt: 0 };
}

const PERSONAL = labels([{ provider: "openai-codex", index: 2, label: "personal" }]);

function refused(check: AccountCheck, reason: RegExp): void {
  assert.equal(check.ok, false, JSON.stringify(check));
  if (!check.ok) assert.match(check.reason, reason);
}

test("subscription providers include Claude Code, Multi-Pass aliases and named accounts", () => {
  for (const provider of ["openai-codex", "anthropic", "github-copilot", "claude-code", "claude-code-2", "claude-code-12"]) assert.equal(subscriptionKind(provider), "native");
  for (const provider of ["openai-codex-2", "anthropic-3", "github-copilot-12"]) assert.equal(subscriptionKind(provider), "alias");
  for (const provider of ["openai-codex-j", "openai-codex-p", "claude-code-j", "claude-code-p", "anthropic-work", "github-copilot-x2"]) assert.equal(subscriptionKind(provider), "account");
  for (const provider of ["openai", "openrouter", "openrouter-p", "google-j", "omlx-hera", "codex-2", "anthropic-", "xanthropic-2", "openai-codex-", "openai-codex-J"]) {
    assert.equal(subscriptionKind(provider), undefined, provider);
  }
});

test("Claude Code needs a personal account binding and cannot cross scopes", () => {
  const base = rosterFixtureV2("roster-hera-v2.json");
  const noBinding = { ...base, accounts: new Map(base.accounts) };
  refused(checkAccount("claude-code", noBinding, undefined, "personal"), /no account binding/);
  const personal = { ...base, accounts: new Map([...base.accounts, ["claude-code", { kind: "native", label: "personal", scope: "personal" } as const]]) };
  assert.deepEqual(checkAccount("claude-code", personal, undefined, "personal"), { ok: true, kind: "native", label: "personal", verified: false });
  refused(checkAccount("claude-code", personal, undefined, "work"), /binds claude-code to the personal scope/);
  const value = JSON.parse(fixture("roster-hera-v2.json"));
  value.roles.find((role: { name: string }) => role.name === "low").models.push("claude-code/claude-haiku-5-5");
  const missing = parseRoster(JSON.stringify(value));
  assert.ok(!missing.ok);
  assert.match(missing.error, /claude-code.*needs a binding/);
  value.accounts["claude-code"] = { native: "personal" };
  assert.ok(parseRoster(JSON.stringify(value)).ok);
});

test("numbered Claude Code instances are explicitly bound native accounts, not Multi-Pass", () => {
  const value = JSON.parse(fixture("roster-hera-v2.json"));
  value.roles.find((role: { name: string }) => role.name === "work-low").models.push("claude-code-2/claude-haiku-5-5");
  const missing = parseRoster(JSON.stringify(value));
  assert.ok(!missing.ok);
  assert.match(missing.error, /claude-code-2.*needs a binding/);
  value.accounts["claude-code-2"] = { native: "Positron work", scope: "work" };
  const parsed = parseRoster(JSON.stringify(value));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.deepEqual(checkAccount("claude-code-2", parsed.value, undefined, "work"), { ok: true, kind: "native", label: "Positron work", verified: false });
  refused(checkAccount("claude-code-2", parsed.value, undefined, "personal"), /binds claude-code-2 to the work scope/);
  value.roles.find((role: { name: string }) => role.name === "low").models.push("claude-code-2/claude-opus-5-5");
  const crossed = parseRoster(JSON.stringify(value));
  assert.ok(!crossed.ok);
  assert.match(crossed.error, /work-bound/);
});

describe("Multi-Pass labels", () => {
  test("each subscription is keyed by the provider Multi-Pass registers for it", () => {
    const parsed = parseMultiPass(
      JSON.stringify({
        subscriptions: [
          { provider: "openai-codex", index: 2, label: "personal" },
          { provider: "anthropic", index: 2 },
          { provider: "openai-codex", index: 3, label: "Positron" },
        ],
        pools: [{ name: "ignored" }],
      }),
    );
    assert.ok(parsed.ok);
    assert.deepEqual(
      [...parsed.value],
      [
        ["openai-codex-2", "personal"],
        ["anthropic-2", undefined],
        ["openai-codex-3", "Positron"],
      ],
    );
    const empty = parseMultiPass("{}");
    assert.ok(empty.ok);
    assert.equal(empty.value.size, 0);
  });

  test("a malformed file is refused whole", () => {
    const cases: Array<[unknown, RegExp]> = [
      [[], /is not a JSON object/],
      [{ subscriptions: {} }, /subscriptions is not an array/],
      [{ subscriptions: [1] }, /subscriptions\[0\] is not an object/],
      [{ subscriptions: [{ index: 2 }] }, /subscriptions\[0\]\.provider is not a provider id/],
      [{ subscriptions: [{ provider: "openai-codex" }] }, /subscriptions\[0\]\.index is not a positive whole number/],
      [{ subscriptions: [{ provider: "openai-codex", index: 0 }] }, /index is not a positive whole number/],
      [{ subscriptions: [{ provider: "openai-codex", index: -2 }] }, /index is not a positive whole number/],
      [{ subscriptions: [{ provider: "openai-codex", index: 2.5 }] }, /index is not a positive whole number/],
      [{ subscriptions: [{ provider: "openai-codex", index: "2" }] }, /index is not a positive whole number/],
      [{ subscriptions: [{ provider: "openai-codex", index: 2, label: 5 }] }, /label is not a string/],
      [{ subscriptions: [{ provider: "openai-codex", index: 2, label: null }] }, /label is not a string/],
      [
        {
          subscriptions: [
            { provider: "openai-codex", index: 2, label: "personal" },
            { provider: "openai-codex", index: 2, label: "work" },
          ],
        },
        /subscriptions\[1\] lists openai-codex-2 a second time/,
      ],
    ];
    for (const [value, error] of cases) {
      const parsed = parseMultiPass(JSON.stringify(value));
      assert.equal(parsed.ok, false, JSON.stringify(value));
      if (!parsed.ok) assert.match(parsed.error, error);
    }
    const syntax = parseMultiPass("{");
    assert.ok(!syntax.ok);
    assert.match(syntax.error, /^JSON syntax error: /);
  });

  test("only a roster that binds a Multi-Pass alias needs the labels", () => {
    assert.equal(needsLabels(HERA), true);
    assert.equal(needsLabels(OTHERS), false);
  });

  test("the labels load from <agentDir>/multi-pass.json with a 256 KiB cap", (t) => {
    const dir = scratch(t);
    const file = labelsFile({ agentDir: () => dir });
    assert.match(expectKind(file.refresh(), "missing").error, /multi-pass\.json does not exist/);
    write(dir, "multi-pass.json", JSON.stringify({ subscriptions: [{ provider: "openai-codex", index: 2, label: "personal" }] }));
    assert.equal(expectKind(file.refresh(), "ok").value.get("openai-codex-2"), "personal");
    write(dir, "multi-pass.json", `{"subscriptions": []}${" ".repeat(MULTI_PASS_MAX_BYTES)}`);
    assert.match(expectKind(file.refresh(), "invalid").error, /is larger than 262144 bytes/);
  });
});

describe("account checks", () => {
  test("a provider that is not a subscription needs no binding", () => {
    assert.deepEqual(checkAccount("openrouter", HERA, undefined), { ok: true, kind: "none" });
    assert.deepEqual(checkAccount("omlx-hera", HERA, undefined), { ok: true, kind: "none" });
  });

  test("an alias passes when Multi-Pass's label matches, trimmed and case-insensitive", () => {
    assert.deepEqual(checkAccount("openai-codex-2", HERA, PERSONAL), { ok: true, kind: "multi-pass", label: "personal", verified: true });
    const padded = labels([{ provider: "openai-codex", index: 2, label: "  Personal " }]);
    assert.deepEqual(checkAccount("openai-codex-2", HERA, padded), { ok: true, kind: "multi-pass", label: "Personal", verified: true });
  });

  test("a missing file, entry or label refuses", () => {
    const missing: Loaded<Labels> = { kind: "missing", path: "/agent/multi-pass.json", error: "/agent/multi-pass.json does not exist", loadedAt: 0 };
    refused(checkAccount("openai-codex-2", HERA, missing), /Multi-Pass's labels are unavailable: \/agent\/multi-pass\.json does not exist/);
    refused(checkAccount("openai-codex-2", HERA, undefined), /Multi-Pass's labels were not read/);
    refused(checkAccount("openai-codex-2", HERA, labels([{ provider: "openai-codex", index: 3, label: "personal" }])), /Multi-Pass lists no openai-codex-2/);
    refused(checkAccount("openai-codex-2", HERA, labels([{ provider: "openai-codex", index: 2 }])), /Multi-Pass has no label for openai-codex-2/);
    refused(checkAccount("openai-codex-2", HERA, labels([{ provider: "openai-codex", index: 2, label: "   " }])), /no label for openai-codex-2/);
  });

  test("a different label refuses", () => {
    refused(
      checkAccount("openai-codex-2", HERA, labels([{ provider: "openai-codex", index: 2, label: "family" }])),
      /Multi-Pass labels openai-codex-2 "family", not "personal"/,
    );
  });

  test("a positron or work label refuses, in Multi-Pass's file and even when the roster names it", () => {
    for (const label of ["Positron", "work", "Work laptop"]) {
      refused(
        checkAccount("openai-codex-2", HERA, labels([{ provider: "openai-codex", index: 2, label }])),
        new RegExp(`Multi-Pass labels openai-codex-2 "${label}", a refused label`),
      );
      const parsed = parseRoster(fixture("roster-hera.json").replace('"multiPassLabel": "personal"', `"multiPassLabel": "${label}"`));
      assert.ok(!parsed.ok);
      assert.match(parsed.error, /is refused/);
      const named = bound([["openai-codex-2", { kind: "multi-pass", label }]]);
      refused(checkAccount("openai-codex-2", named, labels([{ provider: "openai-codex", index: 2, label }])), /a refused label/);
      refused(checkAccount("openai-codex", bound([["openai-codex", { kind: "native", label }]]), undefined), /a refused label/);
    }
  });

  test("a native acknowledgement passes, reported as unverified, and needs no labels", () => {
    assert.deepEqual(checkAccount("openai-codex", OTHERS, undefined), { ok: true, kind: "native", label: "personal", verified: false });
  });

  test("an unreadable, unsafe or malformed Multi-Pass file refuses every alias, and only aliases", () => {
    const roster = bound([
      ["openai-codex-2", { kind: "multi-pass", label: "personal" }],
      ["anthropic-2", { kind: "multi-pass", label: "personal" }],
      ["openai-codex", { kind: "native", label: "personal" }],
    ]);
    for (const kind of ["invalid", "unsafe"] as const) {
      const broken: Loaded<Labels> = { kind, path: "/agent/multi-pass.json", error: "it is broken", loadedAt: 0 };
      refused(checkAccount("openai-codex-2", roster, broken), /Multi-Pass's labels are unavailable: it is broken/);
      refused(checkAccount("anthropic-2", roster, broken), /Multi-Pass's labels are unavailable: it is broken/);
      assert.equal(checkAccount("openai-codex", roster, broken).ok, true);
    }
  });

  test("an unsafe Multi-Pass file on disk refuses the alias", (t) => {
    const dir = scratch(t);
    write(dir, "multi-pass.json", JSON.stringify({ subscriptions: [{ provider: "openai-codex", index: 2, label: "personal" }] }), 0o646);
    const state = labelsFile({ agentDir: () => dir }).current();
    refused(checkAccount("openai-codex-2", HERA, state), /Multi-Pass's labels are unavailable: .*writable by its group or by others/);
  });

  test("a subscription provider without a binding, or with the wrong kind of binding, refuses", () => {
    refused(checkAccount("anthropic-2", HERA, PERSONAL), /anthropic-2 has no account binding in the roster/);
    refused(checkAccount("openai-codex-2", bound([["openai-codex-2", { kind: "native", label: "personal" }]]), PERSONAL), /is a Multi-Pass alias, but the roster binds it as a native login/);
    refused(checkAccount("openai-codex", bound([["openai-codex", { kind: "multi-pass", label: "personal" }]]), PERSONAL), /is a native login, but the roster binds it to a Multi-Pass label/);
  });
});

describe("account checks in a version 2 session's scope", () => {
  const HERA_V2 = rosterFixtureV2("roster-hera-v2.json");
  const WORK_ONLY = rosterFixtureV2("roster-work.json");
  const BOTH = labels([
    { provider: "openai-codex", index: 2, label: "personal" },
    { provider: "openai-codex", index: 3, label: "Positron work" },
  ]);

  /** Hera's version 2 roster with one binding replaced, as if validation had been bypassed. */
  function rebound(provider: string, binding: ScopedBinding): RosterV2 {
    return { ...HERA_V2, accounts: new Map([...HERA_V2.accounts, [provider, binding]]) };
  }

  test("a work binding passes in work scope and is refused in personal scope", () => {
    assert.deepEqual(checkAccount("openai-codex-3", HERA_V2, BOTH, "work"), { ok: true, kind: "multi-pass", label: "Positron work", verified: true });
    refused(checkAccount("openai-codex-3", HERA_V2, BOTH, "personal"), /^the roster binds openai-codex-3 to the work scope, but this session is in the personal scope$/);
    assert.deepEqual(checkAccount("openai-codex", WORK_ONLY, undefined, "work"), { ok: true, kind: "native", label: "Positron work", verified: false });
    refused(checkAccount("openai-codex", WORK_ONLY, undefined, "personal"), /^the roster binds openai-codex to the work scope, but this session is in the personal scope$/);
  });

  test("a personal binding is refused in work scope", () => {
    refused(checkAccount("openai-codex-2", HERA_V2, BOTH, "work"), /^the roster binds openai-codex-2 to the personal scope, but this session is in the work scope$/);
    assert.deepEqual(checkAccount("openai-codex-2", HERA_V2, BOTH, "personal"), { ok: true, kind: "multi-pass", label: "personal", verified: true });
  });

  test("in work scope, Multi-Pass's label must still match the binding's, trimmed and case-insensitive", () => {
    const padded = labels([{ provider: "openai-codex", index: 3, label: " positron WORK " }]);
    assert.deepEqual(checkAccount("openai-codex-3", HERA_V2, padded, "work"), { ok: true, kind: "multi-pass", label: "positron WORK", verified: true });
    refused(checkAccount("openai-codex-3", HERA_V2, labels([{ provider: "openai-codex", index: 3, label: "personal" }]), "work"), /^Multi-Pass labels openai-codex-3 "personal", not "Positron work"$/);
    refused(checkAccount("openai-codex-3", HERA_V2, labels([{ provider: "openai-codex", index: 3, label: "Work" }]), "work"), /^Multi-Pass labels openai-codex-3 "Work", not "Positron work"$/);
    refused(checkAccount("openai-codex-3", HERA_V2, labels([{ provider: "openai-codex", index: 2, label: "Positron work" }]), "work"), /^Multi-Pass lists no openai-codex-3$/);
    refused(checkAccount("openai-codex-3", HERA_V2, undefined, "work"), /^Multi-Pass's labels were not read/);
  });

  test("in work scope, a work binding whose label names neither work nor Positron is refused", () => {
    const spare = rebound("openai-codex-3", { kind: "multi-pass", label: "spare", scope: "work" });
    refused(checkAccount("openai-codex-3", spare, labels([{ provider: "openai-codex", index: 3, label: "spare" }]), "work"), /^the roster binds openai-codex-3 to "spare", which names neither work nor Positron$/);
  });

  test("a provider that is not a subscription needs no binding in either scope", () => {
    for (const scope of SCOPES) {
      assert.deepEqual(checkAccount("openrouter", HERA_V2, BOTH, scope), { ok: true, kind: "none" }, scope);
      assert.deepEqual(checkAccount("omlx-hera", HERA_V2, BOTH, scope), { ok: true, kind: "none" }, scope);
    }
  });

  test("without a scope a version 2 binding takes today's path, and version 1 ignores the scope", () => {
    refused(checkAccount("openai-codex-3", HERA_V2, BOTH), /^the roster binds openai-codex-3 to "Positron work", a refused label$/);
    assert.deepEqual(checkAccount("openai-codex-2", HERA_V2, BOTH), { ok: true, kind: "multi-pass", label: "personal", verified: true });
    for (const scope of SCOPES) {
      assert.deepEqual(checkAccount("openai-codex-2", HERA, PERSONAL, scope), { ok: true, kind: "multi-pass", label: "personal", verified: true }, scope);
      for (const label of ["Positron", "work", "Work laptop"]) {
        refused(checkAccount("openai-codex-2", HERA, labels([{ provider: "openai-codex", index: 2, label }]), scope), new RegExp(`^Multi-Pass labels openai-codex-2 "${label}", a refused label$`));
        refused(checkAccount("openai-codex-2", bound([["openai-codex-2", { kind: "multi-pass", label }]]), labels([{ provider: "openai-codex", index: 2, label }]), scope), /a refused label$/);
        refused(checkAccount("openai-codex", bound([["openai-codex", { kind: "native", label }]]), undefined, scope), /a refused label$/);
      }
    }
  });
});
