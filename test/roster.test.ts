import assert from "node:assert/strict";
import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";

import { BUILTIN_EXCLUDES, ROSTER_MAX_BYTES } from "../src/constants.ts";
import { autoRoles, excludedBy, parseRef, parseRoster, rankOf, roleOf, rosterFile } from "../src/roster.ts";
import type { Roster } from "../src/roster.ts";
import { expectKind, fixture, scratch, write } from "./support/fixtures.ts";

const HERA = fixture("roster-hera.json");
const OTHERS = fixture("roster-other-hosts.json");

// Rosters are edited here as plain JSON values.
type Json = any;

function hera(): Json {
  return JSON.parse(HERA);
}

/** A copy of Hera's roster with one edit applied. */
function edited(edit: (roster: Json) => void, base: string = HERA): Json {
  const roster = JSON.parse(base);
  edit(roster);
  return roster;
}

function valid(value: unknown): Roster {
  const parsed = parseRoster(typeof value === "string" ? value : JSON.stringify(value));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.value;
}

function invalid(value: unknown, expected: RegExp | string): void {
  const parsed = parseRoster(typeof value === "string" ? value : JSON.stringify(value));
  assert.equal(parsed.ok, false, `expected ${String(expected)}`);
  if (parsed.ok) return;
  if (typeof expected === "string") assert.equal(parsed.error, expected);
  else assert.match(parsed.error, expected);
}

/** Add an own key, even `__proto__`, so that JSON.stringify writes it. */
function withKey(target: Json, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

describe("John's rosters", () => {
  test("Hera's roster validates as written", () => {
    const roster = valid(HERA);
    assert.deepEqual(
      roster.roles.map((role) => [role.name, role.models, role.thinking]),
      [
        ["local", ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "max"],
        ["worker", ["openrouter/deepseek/deepseek-v4.1-flash-1017"], "selected"],
        ["thinker", ["openrouter/moonshotai/kimi-k3.1-pro"], "selected"],
        ["coder", ["openrouter/z-ai/glm-5.3"], "selected"],
        ["engineer", ["openai-codex-2/gpt-6.1-sol"], "selected"],
        ["architect", ["openai-codex-2/gpt-6-astra"], "selected"],
      ],
    );
    assert.deepEqual(
      { ...roster.routing, fallback: [...roster.routing.fallback] },
      {
        default: "worker",
        trivial: "worker",
        complex: "engineer",
        planning: "architect",
        fallback: [
          ["engineer", "coder"],
          ["architect", "thinker"],
        ],
      },
    );
    assert.deepEqual([...roster.accounts], [["openai-codex-2", { kind: "multi-pass", label: "personal" }]]);
    assert.deepEqual(roster.local, { role: "local", providers: ["omlx-hera"], hosts: ["hera.lan"] });
    assert.deepEqual(roster.exclude, [...BUILTIN_EXCLUDES, "openai-codex/*"]);
    assert.deepEqual([roster.stickyIdleMinutes, roster.cooldownMinutes], [5, 30]);
  });

  test("the other hosts' roster validates, with native openai-codex acknowledged", () => {
    const roster = valid(OTHERS);
    assert.deepEqual(roleOf(roster, "openai-codex/gpt-6.1-sol")?.name, "engineer");
    assert.deepEqual(roleOf(roster, "openai-codex/gpt-6-astra")?.name, "architect");
    assert.deepEqual([...roster.accounts], [["openai-codex", { kind: "native", label: "personal" }]]);
    assert.deepEqual(roster.exclude, BUILTIN_EXCLUDES);
  });

  test("the coder role is reached only as the engineer's fallback, and auto never reaches the local role", () => {
    const roster = valid(HERA);
    assert.equal(roster.routing.fallback.get("engineer"), "coder");
    assert.ok(![roster.routing.default, roster.routing.trivial, roster.routing.complex, roster.routing.planning].includes("coder"));
    assert.deepEqual([...autoRoles(roster)].sort(), ["architect", "coder", "engineer", "thinker", "worker"]);
    assert.ok(rankOf(roster, "coder") < rankOf(roster, "engineer"), "a session on the fallback climbs back to sol at once");
    assert.equal(rankOf(roster, "nope"), -1);
  });

  test("a role that neither routing nor any fallback names is not routable by auto", () => {
    const roster = valid(edited((r) => delete r.routing.fallback));
    assert.deepEqual([...autoRoles(roster)].sort(), ["architect", "engineer", "worker"]);
  });

  test("trivial, complex and planning default to routing.default", () => {
    const roster = valid(
      edited((r) => {
        r.routing = { default: "thinker" };
      }),
    );
    assert.deepEqual([roster.routing.trivial, roster.routing.complex, roster.routing.planning], ["thinker", "thinker", "thinker"]);
    assert.equal(roster.routing.fallback.size, 0);
  });
});

describe("refs", () => {
  test("a ref splits at its first slash", () => {
    assert.deepEqual(parseRef("openrouter/deepseek/deepseek-v4.1-flash-1017"), {
      provider: "openrouter",
      id: "deepseek/deepseek-v4.1-flash-1017",
    });
    for (const bad of ["openrouter", "/model", "provider/", ""]) assert.equal(parseRef(bad), undefined, bad);
    assert.equal(roleOf(valid(HERA), "openrouter/deepseek/deepseek-v4.1-flash-1017")?.name, "worker");
  });

  test("exclusions match an exact ref or every ref of a provider/*", () => {
    assert.equal(excludedBy(BUILTIN_EXCLUDES, "openai-codex-3/gpt-6.1-sol"), "openai-codex-3/*");
    assert.equal(excludedBy(BUILTIN_EXCLUDES, "openrouter/openrouter/auto"), "openrouter/openrouter/auto");
    assert.equal(excludedBy(BUILTIN_EXCLUDES, "openai-codex-2/gpt-6.1-sol"), undefined, "openai-codex-3/* does not reach openai-codex-2");
    assert.equal(excludedBy(BUILTIN_EXCLUDES, "openrouter/openrouter/auto-x"), undefined);
    assert.equal(excludedBy(["openai-codex/*"], "openai-codex-2/gpt-6.1-sol"), undefined);
  });

  test("a model ref must be exact", () => {
    for (const ref of ["no-slash", "openrouter/*", "openrouter/z-ai/glm*", "open router/x", "openrouter/a b", "-x/y"]) {
      invalid(
        edited((r) => {
          r.roles[1].models = [ref];
        }),
        `roles[1].models[0]: "${ref}" is not an exact provider/id ref`,
      );
    }
  });

  test("a ref may be listed once, in one role", () => {
    invalid(
      edited((r) => r.roles[1].models.push("openrouter/deepseek/deepseek-v4.1-flash-1017")),
      'roles[1].models[1]: "openrouter/deepseek/deepseek-v4.1-flash-1017" is listed twice',
    );
    invalid(
      edited((r) => r.roles[2].models.push("openrouter/deepseek/deepseek-v4.1-flash-1017")),
      'roles[2].models[1]: "openrouter/deepseek/deepseek-v4.1-flash-1017" is already in role "worker"',
    );
  });

  test("an excluded ref is an error, for every built-in exclusion and the roster's own", () => {
    const cases: Array<[string, string]> = [
      ["openai-codex-3/gpt-6.1-sol", "openai-codex-3/*"],
      ["hermes/hermes-4", "hermes/*"],
      ["openrouter/openrouter/auto", "openrouter/openrouter/auto"],
      ["smart-router/auto", "smart-router/*"],
      ["openai-codex/gpt-6.1-sol", "openai-codex/*"],
    ];
    for (const [ref, pattern] of cases) {
      invalid(
        edited((r) => {
          r.roles[4].models = [ref];
        }),
        `roles[4].models[0]: "${ref}" is excluded by ${pattern}`,
      );
    }
  });

  test("no roster can remove a built-in exclusion", () => {
    const roster = valid(edited((r) => (r.exclude = [])));
    assert.deepEqual(roster.exclude, BUILTIN_EXCLUDES);
    invalid(
      edited((r) => {
        r.exclude = [];
        r.roles[4].models = ["openai-codex-3/gpt-6.1-sol"];
      }),
      /is excluded by openai-codex-3\/\*/,
    );
  });

  test("an exclusion is a ref or a provider/* pattern", () => {
    for (const pattern of ["openai-codex", "*/x", "openai-codex/gpt*", "/x", 7]) {
      invalid(
        edited((r) => {
          r.exclude = [pattern];
        }),
        /^exclude\[0\]: /,
      );
    }
  });
});

describe("keys", () => {
  const levels: Array<[string, (r: Json) => Json, string]> = [
    ["", (r) => r, ""],
    ["roles[1]", (r) => r.roles[1], "roles[1]."],
    ["routing", (r) => r.routing, "routing."],
    ["accounts.openai-codex-2", (r) => r.accounts["openai-codex-2"], "accounts.openai-codex-2."],
    ["local", (r) => r.local, "local."],
  ];

  test("unknown keys are refused at every level", () => {
    for (const [, target, prefix] of levels) {
      invalid(
        edited((r) => {
          target(r).unexpected = true;
        }),
        `${prefix}unexpected: unknown key`,
      );
    }
    invalid(
      edited((r) => {
        r.routing.fallback.nobody = "worker";
      }),
      'routing.fallback.nobody: "nobody" is not a role',
    );
    invalid(
      edited((r) => {
        r.accounts.openrouter = { native: "personal" };
      }),
      /^accounts\.openrouter: openrouter is not a subscription provider/,
    );
  });

  test("__proto__, constructor and prototype are refused at every level", () => {
    const maps: Array<[(r: Json) => Json, string]> = [
      [(r) => r.routing.fallback, "routing.fallback."],
      [(r) => r.accounts, "accounts."],
    ];
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const [, target, prefix] of levels) {
        invalid(
          edited((r) => withKey(target(r), key, {})),
          `${prefix}${key}: forbidden key`,
        );
      }
      for (const [target, prefix] of maps) {
        invalid(
          edited((r) => withKey(target(r), key, "worker")),
          `${prefix}${key}: forbidden key`,
        );
      }
    }
  });

  test("$comment is allowed at every object level, and must be a string", () => {
    const roster = edited((r) => {
      r.routing.$comment = "routing";
      r.routing.fallback.$comment = "fallbacks";
      r.accounts.$comment = "accounts";
      r.accounts["openai-codex-2"].$comment = "binding";
      r.local.$comment = "local";
    });
    assert.deepEqual([...valid(roster).routing.fallback.keys()], ["engineer", "architect"]);
    assert.deepEqual([...valid(roster).accounts.keys()], ["openai-codex-2"]);
    invalid(
      edited((r) => {
        r.roles[0].$comment = 3;
      }),
      "roles[0].$comment: must be a string",
    );
    invalid(
      edited((r) => {
        r.$comment = null;
      }),
      "$comment: must be a string",
    );
  });
});

describe("structure", () => {
  test("the version must be exactly 1", () => {
    invalid(
      edited((r) => delete r.version),
      "version: is required",
    );
    for (const version of [0, 2, "1", null]) {
      invalid(
        edited((r) => {
          r.version = version;
        }),
        `version: must be 1, not ${JSON.stringify(version)}`,
      );
    }
  });

  test("the roster is a JSON object, and its syntax errors are reported", () => {
    for (const text of ["[]", "null", "3", '"roster"']) invalid(text, "roster: must be a JSON object");
    invalid('{"version": 1,', /^JSON syntax error: /);
  });

  test("roles are required, non-empty, and well formed", () => {
    invalid(
      edited((r) => delete r.roles),
      "roles: is required",
    );
    invalid(
      edited((r) => {
        r.roles = [];
      }),
      "roles: must not be empty",
    );
    invalid(
      edited((r) => {
        r.roles[1].models = [];
      }),
      "roles[1].models: must not be empty",
    );
    for (const name of ["Worker", "1worker", "a".repeat(33), "work er", ""]) {
      invalid(
        edited((r) => {
          r.roles[1].name = name;
        }),
        /^roles\[1\]\.name: /,
      );
    }
    invalid(
      edited((r) => {
        r.roles[2].name = "worker";
      }),
      'roles[2].name: role "worker" is defined twice',
    );
  });

  test("thinking is selected or a Pi level", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "selected"]) {
      const roster = valid(
        edited((r) => {
          r.roles[1].thinking = level;
        }),
      );
      assert.equal(roster.roles[1]?.thinking, level);
    }
    for (const level of ["turbo", "MAX", null, 3]) {
      invalid(
        edited((r) => {
          r.roles[1].thinking = level;
        }),
        /^roles\[1\]\.thinking: must be "selected" or one of off, minimal, low, medium, high, xhigh, max$/,
      );
    }
  });

  test("routing must name existing roles, and no role falls back to itself", () => {
    invalid(
      edited((r) => delete r.routing),
      "routing: is required",
    );
    invalid(
      edited((r) => delete r.routing.default),
      "routing.default: is required",
    );
    for (const key of ["default", "trivial", "complex", "planning"]) {
      invalid(
        edited((r) => {
          r.routing[key] = "nobody";
        }),
        `routing.${key}: "nobody" is not a role`,
      );
    }
    invalid(
      edited((r) => {
        r.routing.fallback.engineer = "nobody";
      }),
      'routing.fallback.engineer: "nobody" is not a role',
    );
    invalid(
      edited((r) => {
        r.routing.fallback.engineer = "engineer";
      }),
      "routing.fallback.engineer: a role cannot fall back to itself",
    );
  });

  test("minutes are whole numbers within their ranges", () => {
    const at = (key: string, value: unknown): Json =>
      edited((r) => {
        r[key] = value;
      });
    assert.equal(valid(at("stickyIdleMinutes", 0)).stickyIdleMinutes, 0);
    assert.equal(valid(at("stickyIdleMinutes", 1440)).stickyIdleMinutes, 1440);
    assert.equal(valid(at("cooldownMinutes", 1)).cooldownMinutes, 1);
    assert.equal(valid(at("cooldownMinutes", 1440)).cooldownMinutes, 1440);
    for (const value of [-1, 1441, 2.5, "5", null]) {
      invalid(at("stickyIdleMinutes", value), "stickyIdleMinutes: must be a whole number of minutes from 0 to 1440");
    }
    for (const value of [0, 1441, 1.5, true]) {
      invalid(at("cooldownMinutes", value), "cooldownMinutes: must be a whole number of minutes from 1 to 1440");
    }
  });
});

describe("accounts", () => {
  test("every subscription ref needs a binding", () => {
    invalid(
      edited((r) => delete r.accounts),
      'roles[4].models[0]: "openai-codex-2/gpt-6.1-sol" uses the subscription provider openai-codex-2, which needs a binding in accounts',
    );
    invalid(
      edited((r) => delete r.accounts, OTHERS),
      'roles[4].models[0]: "openai-codex/gpt-6.1-sol" uses the subscription provider openai-codex, which needs a binding in accounts',
    );
    for (const ref of ["anthropic/claude-x", "github-copilot/gpt-x", "anthropic-2/claude-x"]) {
      invalid(
        edited((r) => {
          r.roles[1].models = [ref];
        }),
        new RegExp(`^roles\\[1\\]\\.models\\[0\\]: "${ref}" uses the subscription provider`),
      );
    }
  });

  test("an alias binds a Multi-Pass label and a native login an acknowledgement", () => {
    invalid(
      edited((r) => {
        r.accounts["openai-codex-2"] = { native: "personal" };
      }),
      'accounts.openai-codex-2: a Multi-Pass alias is bound with "multiPassLabel", not "native"',
    );
    invalid(
      edited((r) => {
        r.accounts["openai-codex"] = { multiPassLabel: "personal" };
      }, OTHERS),
      'accounts.openai-codex: a native login is bound with "native", not "multiPassLabel"',
    );
    invalid(
      edited((r) => {
        r.accounts["openai-codex-2"] = {};
      }),
      "accounts.openai-codex-2.multiPassLabel: is required",
    );
    invalid(
      edited((r) => {
        r.accounts["openai-codex-2"].multiPassLabel = "  ";
      }),
      "accounts.openai-codex-2.multiPassLabel: must be a non-empty string",
    );
    assert.equal(
      valid(
        edited((r) => {
          r.accounts["openai-codex-2"].multiPassLabel = "  Personal ";
        }),
      ).accounts.get("openai-codex-2")?.label,
      "Personal",
    );
  });

  test("a work or Positron label is refused in the roster", () => {
    for (const label of ["work", "Positron", "WORK laptop", "my-work", "positron (team)"]) {
      invalid(
        edited((r) => {
          r.accounts["openai-codex-2"].multiPassLabel = label;
        }),
        `accounts.openai-codex-2.multiPassLabel: the label "${label}" is refused`,
      );
      invalid(
        edited((r) => {
          r.accounts["openai-codex"].native = label;
        }, OTHERS),
        `accounts.openai-codex.native: the label "${label}" is refused`,
      );
    }
    for (const label of ["personal", "workbench", "homework", "positronic"]) {
      valid(
        edited((r) => {
          r.accounts["openai-codex-2"].multiPassLabel = label;
        }),
      );
    }
  });
});

describe("the local section", () => {
  test("local.role must exist and its providers must cover the role's models", () => {
    invalid(
      edited((r) => {
        r.local.role = "nobody";
      }),
      'local.role: "nobody" is not a role',
    );
    invalid(
      edited((r) => {
        r.local.providers = ["omlx-vulcan"];
      }),
      'local.providers: must include omlx-hera, the provider of "omlx-hera/GLM-5.3-Flash-oQ4e-mtp" in the local role "local"',
    );
    invalid(
      edited((r) => {
        r.local.providers = [];
      }),
      "local.providers: must not be empty",
    );
    invalid(
      edited((r) => {
        r.local.providers = ["omlx-hera", "omlx-hera"];
      }),
      'local.providers[1]: "omlx-hera" is listed twice',
    );
  });

  test("local.hosts is required", () => {
    invalid(
      edited((r) => delete r.local.hosts),
      "local.hosts: is required",
    );
    invalid(
      edited((r) => {
        r.local.hosts = [];
      }),
      "local.hosts: must not be empty",
    );
  });

  test("local.hosts entries pass the built-in local-host rule", () => {
    const accepted = [
      "localhost",
      "127.0.0.1",
      "127.10.20.30",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.10",
      "169.254.1.1",
      "fe80::1",
      "fd00::1",
      "fc00::5",
      "hera.lan",
      "nas.local",
      "box.home.arpa",
    ];
    for (const host of accepted) {
      const roster = valid(
        edited((r) => {
          r.local.hosts = [host];
        }),
      );
      assert.deepEqual(roster.local?.hosts, [host]);
    }
    const refused = ["openrouter.ai", "api.openai.com", "chatgpt.com", "100.64.0.1", "hera.tail1234.ts.net", "172.32.0.1", "8.8.8.8", "lan", "2001:db8::1"];
    for (const host of refused) {
      invalid(
        edited((r) => {
          r.local.hosts = [host];
        }),
        new RegExp(`^local\\.hosts\\[0\\]: "${host.replace(/\./g, "\\.")}" is not a local host`),
      );
    }
  });

  test("local.hosts entries are bare host names in canonical form", () => {
    invalid(
      edited((r) => {
        r.local.hosts = ["Hera.LAN"];
      }),
      'local.hosts[0]: write "hera.lan", not "Hera.LAN"',
    );
    invalid(
      edited((r) => {
        r.local.hosts = ["127.1"];
      }),
      'local.hosts[0]: write "127.0.0.1", not "127.1"',
    );
    for (const host of ["hera.lan:443", "https://hera.lan", "user@hera.lan", "hera lan"]) {
      invalid(
        edited((r) => {
          r.local.hosts = [host];
        }),
        `local.hosts[0]: "${host}" is not a host name`,
      );
    }
  });

  test("blockTools is not a field: the pin pins the model only (Q7), so a roster cannot ask for a tool block", () => {
    for (const value of [[], ["web_fetch", "subagent"]]) {
      invalid(
        edited((r) => {
          r.local.blockTools = value;
        }),
        "local.blockTools: unknown key",
      );
    }
  });

  test("without a local section the roster has no local role", () => {
    const roster = valid(edited((r) => delete r.local));
    assert.equal(roster.local, undefined);
    assert.equal("local" in roster, false);
  });
});

describe("the roster file", () => {
  test("John's roster loads from <agentDir>/smart-router.json", (t) => {
    const dir = scratch(t);
    write(dir, "smart-router.json", HERA);
    const state = expectKind(rosterFile({ agentDir: () => dir }).current(), "ok");
    assert.equal(state.path, join(dir, "smart-router.json"));
    assert.equal(state.value.routing.complex, "engineer");
  });

  test("a missing, unparsable, oversized or unsafe file fails closed with its reason", (t) => {
    const dir = scratch(t);
    const file = rosterFile({ agentDir: () => dir });
    assert.match(expectKind(file.refresh(), "missing").error, /smart-router\.json does not exist/);
    write(dir, "smart-router.json", "{ not json");
    assert.match(expectKind(file.refresh(), "invalid").error, /^JSON syntax error: /);
    write(dir, "smart-router.json", HERA.replace(/\s*$/, " ".repeat(ROSTER_MAX_BYTES + 1 - HERA.trimEnd().length)));
    assert.match(expectKind(file.refresh(), "invalid").error, /is larger than 65536 bytes/);
    write(dir, "smart-router.json", HERA, 0o666);
    assert.match(expectKind(file.refresh(), "unsafe").error, /writable by its group or by others/);
  });

  test("a relative PI_CODING_AGENT_DIR is refused", () => {
    const state = expectKind(rosterFile({ agentDir: () => "pi/agent" }).current(), "invalid");
    assert.match(state.error, /PI_CODING_AGENT_DIR is relative/);
  });

  test("the roster reloads when (dev, ino, mtime, size) changes, and an invalid reload refuses", (t) => {
    const dir = scratch(t);
    const path = write(dir, "smart-router.json", HERA);
    const file = rosterFile({ agentDir: () => dir });
    const first = expectKind(file.refresh(), "ok");
    assert.equal(file.refresh(), first, "unchanged: the parsed roster is reused");

    write(dir, "smart-router.json", OTHERS);
    const second = expectKind(file.refresh(), "ok");
    assert.equal(roleOf(second.value, "openai-codex/gpt-6.1-sol")?.name, "engineer");

    const touched = OTHERS.replaceAll('"worker"', '"helper"');
    assert.equal(touched.length, OTHERS.length);
    write(dir, "smart-router.json", touched);
    utimesSync(path, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
    assert.equal(expectKind(file.refresh(), "ok").value.routing.default, "helper", "a same-size edit is seen through its mtime");

    write(dir, "smart-router.json", OTHERS.replace('"version": 1', '"version": 2'));
    assert.equal(expectKind(file.refresh(), "invalid").error, "version: must be 1, not 2");
    assert.equal(file.current().kind, "invalid", "no last-known-good copy");

    rmSync(path);
    expectKind(file.refresh(), "missing");
  });
});

test("Hera's fixture follows John's decisions: plain openai-codex excluded, no blocked tools (Q7)", () => {
  const roster = hera();
  assert.deepEqual(roster.exclude, ["openai-codex/*"]);
  assert.equal(roster.local.blockTools, undefined, "Q7: the pin blocks no tools");
});
