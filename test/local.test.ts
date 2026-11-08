import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { baseUrlHost, canonicalHost, checkLocal, EMPTY_POLICY, isLocalHost, parsePolicy, policyFromRoster } from "../src/local.ts";
import type { LocalCheck, LocalPolicy } from "../src/local.ts";
import { parseRoster } from "../src/roster.ts";
import type { Roster } from "../src/roster.ts";
import { fixture } from "./support/fixtures.ts";

function hera(): Roster {
  const parsed = parseRoster(fixture("roster-hera.json"));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.value;
}

const GLM = { provider: "omlx-hera", id: "GLM-5.3-Flash-oQ4e-mtp", baseUrl: "https://hera.lan:443/v1" };
const QWEN = { provider: "omlx-hera", id: "Qwen3.8-27B-oQ4e-fp16-mtp", baseUrl: "https://hera.lan:443/v1" };
const KIMI = { provider: "openrouter", id: "moonshotai/kimi-k3.1-pro", baseUrl: "https://openrouter.ai/api/v1" };

function refused(check: LocalCheck, reason: RegExp): void {
  assert.equal(check.ok, false, JSON.stringify(check));
  if (!check.ok) assert.match(check.reason, reason);
}

describe("the built-in local-host rule", () => {
  test("accepts localhost, loopback, private, link-local and unique-local addresses, and .lan, .local and .home.arpa names", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.255.255.254",
      "::1",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
      "169.254.1.1",
      "fe80::1",
      "febf::1",
      "fc00::1",
      "fd12:3456::1",
      "hera.lan",
      "a.b.lan",
      "nas.local",
      "printer.home.arpa",
    ]) {
      assert.equal(isLocalHost(host), true, host);
    }
  });

  test("refuses cloud hosts, tailnet names and addresses, and near misses", () => {
    for (const host of [
      "openrouter.ai",
      "api.openai.com",
      "chatgpt.com",
      "100.64.0.1",
      "100.127.255.254",
      "hera.tail1234.ts.net",
      "172.15.0.1",
      "172.32.0.1",
      "11.0.0.1",
      "8.8.8.8",
      "192.169.0.1",
      "169.253.0.1",
      "0.0.0.0",
      "256.1.1.1",
      "fec0::1",
      "2001:db8::1",
      "::",
      "::ffff:7f00:1",
      "lan",
      "local",
      "home.arpa",
      "hera.lan.example.com",
      "-x.lan",
      "x-.lan",
      "hera.lan.",
      "Hera.lan",
      "localhost.localdomain",
      "fd00:zz::1",
      "fd00:0:0::1",
      "[::1]",
      "",
    ]) {
      assert.equal(isLocalHost(host), false, host);
    }
  });
});

test("canonicalHost writes a host name as the URL parser does, and refuses anything else", () => {
  const cases: Array<[string, string | undefined]> = [
    ["hera.lan", "hera.lan"],
    ["Hera.LAN", "hera.lan"],
    ["127.1", "127.0.0.1"],
    ["0x7f.0.0.1", "127.0.0.1"],
    ["FD00:0:0::1", "fd00::1"],
    ["::1", "::1"],
    ["hera.lan:443", undefined],
    ["https://hera.lan", undefined],
    ["user@hera.lan", undefined],
    ["hera lan", undefined],
    ["", undefined],
  ];
  for (const [text, expected] of cases) assert.equal(canonicalHost(text), expected, text);
});

test("baseUrlHost reads the canonical host of a catalog base URL", () => {
  const cases: Array<[unknown, string | undefined]> = [
    ["https://hera.lan:443/v1", "hera.lan"],
    ["http://localhost:0", "localhost"],
    ["http://[::1]:8080/v1", "::1"],
    ["https://OpenRouter.ai/api/v1", "openrouter.ai"],
    ["not a url", undefined],
    ["file:///etc/hosts", undefined],
    [undefined, undefined],
    [42, undefined],
  ];
  for (const [baseUrl, expected] of cases) assert.equal(baseUrlHost(baseUrl), expected, String(baseUrl));
});

describe("the local policy", () => {
  test("is the roster's local role, providers and hosts, as a frozen snapshot", () => {
    const policy = policyFromRoster(hera());
    assert.deepEqual(policy, { refs: ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], providers: ["omlx-hera"], hosts: ["hera.lan"] });
    assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.refs) && Object.isFrozen(policy.hosts));
  });

  test("is empty without a local section", () => {
    const parsed = parseRoster(fixture("roster-hera.json").replace(/,\s*"local": \{[^}]*\}/, ""));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    assert.equal(policyFromRoster(parsed.value), EMPTY_POLICY);
    assert.deepEqual(EMPTY_POLICY, { refs: [], providers: [], hosts: [] });
  });
});

describe("the local check", () => {
  const policy = policyFromRoster(hera());

  test("passes the local role's model for routing and for a direct selection", () => {
    assert.deepEqual(checkLocal(GLM, policy, true), { ok: true });
    assert.deepEqual(checkLocal(GLM, policy, false), { ok: true });
  });

  test("refuses a provider outside the policy", () => {
    refused(checkLocal(KIMI, policy, false), /provider openrouter is not a local provider/);
  });

  test("refuses a base URL host outside the policy, or none", () => {
    refused(checkLocal({ ...GLM, baseUrl: "https://openrouter.ai/api/v1" }, policy, true), /host openrouter\.ai is not a local host/);
    refused(checkLocal({ ...GLM, baseUrl: "https://hera.tail1234.ts.net/v1" }, policy, true), /is not a local host/);
    refused(checkLocal({ provider: GLM.provider, id: GLM.id }, policy, true), /has no base URL host/);
  });

  test("routes only to the local role's refs, while a selected local model needs only provider and host", () => {
    refused(checkLocal(QWEN, policy, true), /omlx-hera\/Qwen3\.8-27B-oQ4e-fp16-mtp is not in the local role/);
    assert.deepEqual(checkLocal(QWEN, policy, false), { ok: true });
  });

  test("refuses a host the built-in rule refuses, even when a policy lists it", () => {
    const crafted: LocalPolicy = { refs: ["evil/model"], providers: ["evil"], hosts: ["api.openai.com"] };
    refused(checkLocal({ provider: "evil", id: "model", baseUrl: "https://api.openai.com/v1" }, crafted, true), /fails the built-in local-host rule/);
  });

  test("lets nothing through an empty policy", () => {
    for (const routing of [true, false]) refused(checkLocal(GLM, EMPTY_POLICY, routing), /is not a local provider/);
  });
});

describe("a recorded policy", () => {
  const recorded = { refs: ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], providers: ["omlx-hera"], hosts: ["hera.lan"] };

  test("reads back exactly", () => {
    assert.deepEqual(parsePolicy(recorded), recorded);
    assert.deepEqual(parsePolicy(JSON.parse(JSON.stringify(recorded))), recorded);
    assert.deepEqual(parsePolicy({ refs: [], providers: [], hosts: [] }), EMPTY_POLICY);
  });

  test("is refused when it is anything but a policy within the built-in rule", () => {
    const bad: unknown[] = [
      null,
      [],
      "policy",
      { refs: recorded.refs, providers: recorded.providers },
      { ...recorded, extra: true },
      JSON.parse('{"refs": [], "providers": [], "hosts": [], "__proto__": {}}'),
      { ...recorded, refs: "omlx-hera/GLM" },
      { ...recorded, hosts: [1] },
      { ...recorded, refs: ["openrouter/z-ai/glm-5.3"] },
      { ...recorded, refs: ["omlx-hera"] },
      { ...recorded, refs: ["omlx-hera/"] },
      { ...recorded, refs: ["omlx-hera/GLM*"] },
      { ...recorded, providers: ["omlx hera"] },
      { ...recorded, hosts: ["api.openai.com"] },
      { ...recorded, hosts: ["Hera.lan"] },
      { ...recorded, hosts: ["100.64.0.1"] },
    ];
    for (const value of bad) assert.equal(parsePolicy(value), undefined, JSON.stringify(value));
  });
});
