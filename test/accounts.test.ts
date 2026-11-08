import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { checkAccount, labelsFile, needsLabels, parseMultiPass, subscriptionKind } from "../src/accounts.ts";
import type { AccountCheck, Labels } from "../src/accounts.ts";
import { MULTI_PASS_MAX_BYTES } from "../src/constants.ts";
import type { Loaded } from "../src/files.ts";
import { parseRoster } from "../src/roster.ts";
import type { AccountBinding, Roster } from "../src/roster.ts";
import { expectKind, fixture, scratch, write } from "./support/fixtures.ts";

function roster(name: string): Roster {
  const parsed = parseRoster(fixture(name));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.value;
}

const HERA = roster("roster-hera.json");
const OTHERS = roster("roster-other-hosts.json");

/** A roster whose bindings are set directly, as if validation had been bypassed. */
function bound(bindings: Array<[string, AccountBinding]>): Roster {
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

test("subscription providers are the native logins Multi-Pass clones and their aliases", () => {
  for (const provider of ["openai-codex", "anthropic", "github-copilot"]) assert.equal(subscriptionKind(provider), "native");
  for (const provider of ["openai-codex-2", "anthropic-3", "github-copilot-12"]) assert.equal(subscriptionKind(provider), "alias");
  for (const provider of ["openai", "openrouter", "omlx-hera", "openai-codex-x", "codex-2", "anthropic-", "xanthropic-2"]) {
    assert.equal(subscriptionKind(provider), undefined, provider);
  }
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
