import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { isCodexProvider, isWorkCodex } from "../src/accounts.ts";
import { BUILTIN_EXCLUDES } from "../src/constants.ts";
import { autoRoles, excludedBy, excludesFor, isWorkBound, liftWorkAlias, parseRoster, SCOPES, scopeSection } from "../src/roster.ts";
import type { Roster, RosterV2, ScopedBinding } from "../src/roster.ts";
import { DEFAULT_DEMAND, DEFAULT_EFFORT, DEFAULT_SWITCHING, DESIGN_WEIGHTS, SIGNALS } from "../src/settings.ts";
import { rosterFixture, rosterFixtureV2 } from "./support/catalog.ts";
import { fixture } from "./support/fixtures.ts";

const HERA = fixture("roster-hera-v2.json");
const WORK = fixture("roster-work.json");

const LOW = "Mechanical or trivial work that follows a clear specification";
const MEDIUM = "Engineering, implementation and validation";
const HIGH = "Deep thought, review, and the design of verification";
const SUPER = "Deep thought, research, design and planning";
const NYX_QWEN = "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad";
const HERA_QWEN = "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp";

// Rosters are edited here as plain JSON values.
type Json = any;

/** A copy of Hera's version 2 roster, or of another, with one edit applied. */
function edited(edit: (roster: Json) => void, base: string = HERA): Json {
  const roster = JSON.parse(base);
  edit(roster);
  return roster;
}

function valid(value: unknown): RosterV2 {
  const parsed = parseRoster(typeof value === "string" ? value : JSON.stringify(value));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.ok(parsed.value.version === 2, "a version 2 roster");
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

const levels = (prefix: string) => ({
  low: { role: `${prefix}low`, describe: LOW },
  medium: { role: `${prefix}medium`, describe: MEDIUM },
  high: { role: `${prefix}high`, describe: HIGH },
  super: { role: `${prefix}super`, describe: SUPER },
});

describe("John's version 2 rosters", () => {
  test("Hera's validates as written, with the classifier's defaults filled in", () => {
    const roster = rosterFixtureV2("roster-hera-v2.json");
    assert.equal(roster.accounts.get("openai-codex-3")?.scope, "work");
    assert.deepEqual(scopeSection(roster, "work")?.directories, ["/Users/johnw/src/positron"]);
    assert.deepEqual(roster.classifier, {
      model: "openrouter/typesafe/jev-1.14",
      timeoutMs: 1000,
      context: { messages: 6, messageChars: 1500, totalChars: 12000 },
    });
    assert.deepEqual(roster, {
      version: 2,
      exclude: [...BUILTIN_EXCLUDES, "openai-codex/*"],
      roles: [
        { name: "local", models: ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], thinking: "max" },
        { name: "low", models: ["openai-codex-2/gpt-6-luna", NYX_QWEN, HERA_QWEN], thinking: "selected" },
        { name: "medium", models: ["openai-codex-2/gpt-6.1-terra", "openrouter/deepseek/deepseek-v4.1-flash-1017"], thinking: "selected" },
        { name: "high", models: ["openai-codex-2/gpt-6.1-sol", "openrouter/z-ai/glm-5.3"], thinking: "selected" },
        { name: "super", models: ["openai-codex-2/gpt-6-astra", "openrouter/moonshotai/kimi-k3.1-pro"], thinking: "selected" },
        { name: "work-low", models: ["openai-codex-3/gpt-6-luna"], thinking: "selected" },
        { name: "work-medium", models: ["openai-codex-3/gpt-6.1-terra"], thinking: "selected" },
        { name: "work-high", models: ["openai-codex-3/gpt-6.1-sol"], thinking: "selected" },
        { name: "work-super", models: ["openai-codex-3/gpt-6-astra"], thinking: "selected" },
      ],
      accounts: new Map([
        ["openai-codex-2", { kind: "multi-pass", label: "personal", scope: "personal" }],
        ["openai-codex-3", { kind: "multi-pass", label: "Positron work", scope: "work" }],
      ]),
      local: { role: "local", providers: ["omlx-hera", "nyx"], hosts: ["hera.lan", "nyx.lan"] },
      ignored: [],
      cooldownMinutes: 30,
      scopes: {
        personal: { levels: levels(""), directories: [] },
        work: { levels: levels("work-"), directories: ["/Users/johnw/src/positron"] },
      },
      classifier: {
        model: "openrouter/typesafe/jev-1.14",
        timeoutMs: 1000,
        context: { messages: 6, messageChars: 1500, totalChars: 12000 },
      },
      demand: DEFAULT_DEMAND,
      switching: DEFAULT_SWITCHING,
      adaptiveReasoning: DEFAULT_EFFORT,
    });
  });

  test("the work machines' validates: the work scope only, on the native login bound as work", () => {
    const roster = rosterFixtureV2("roster-work.json");
    assert.deepEqual(Object.keys(roster.scopes), ["work"]);
    assert.equal(scopeSection(roster, "personal"), undefined);
    assert.deepEqual(scopeSection(roster, "work"), { levels: levels("work-"), directories: [] });
    assert.deepEqual([...roster.accounts], [["openai-codex", { kind: "native", label: "Positron work", scope: "work" }]]);
    assert.deepEqual(roster.exclude, BUILTIN_EXCLUDES);
    assert.equal("classifier" in roster, false, "no classifier, so Jev is never asked");
    assert.equal("local" in roster, false);
  });

  test("the version decides the schema: version 1 knows no scopes, and version 2 no routing", () => {
    invalid(
      edited((r) => {
        r.scopes = JSON.parse(HERA).scopes;
      }, fixture("roster-hera.json")),
      "scopes: unknown key",
    );
    invalid(
      edited((r) => {
        r.routing = { default: "medium" };
      }),
      "routing: unknown key",
    );
  });
});

describe("reading a roster's scopes and bindings", () => {
  // The parser gives a version 1 roster no scopes and no scoped binding, so only an object built
  // by hand can show that the two readers go by the version and not by what the object carries.
  test("scopeSection and isWorkBound go by the version: a version 1 roster that carries scopes and a work binding has neither", () => {
    const hera = rosterFixtureV2("roster-hera-v2.json");
    assert.notEqual(scopeSection(hera, "work"), undefined, "the control: version 2 has the section");
    assert.equal(isWorkBound(hera, "openai-codex-3"), true, "the control: version 2 has the work binding");
    const labelled1 = { ...hera, version: 1 } as unknown as Roster;
    for (const scope of SCOPES) assert.equal(scopeSection(labelled1, scope), undefined, scope);
    assert.equal(isWorkBound(labelled1, "openai-codex-3"), false);
  });

  test("scopeSection and isWorkBound read version 2 only", () => {
    assert.deepEqual(SCOPES, ["personal", "work"]);
    const v1 = rosterFixture("roster-hera.json");
    for (const scope of SCOPES) assert.equal(scopeSection(v1, scope), undefined, scope);
    assert.equal(isWorkBound(v1, "openai-codex-2"), false);
    const hera = rosterFixtureV2("roster-hera-v2.json");
    assert.equal(isWorkBound(hera, "openai-codex-3"), true);
    assert.equal(isWorkBound(hera, "openai-codex-2"), false, "a personal binding");
    assert.equal(isWorkBound(hera, "openrouter"), false, "no binding");
    assert.equal(isWorkBound(rosterFixtureV2("roster-work.json"), "openai-codex"), true);
  });

  test("isCodexProvider is the native openai-codex login or a Multi-Pass alias of it", () => {
    for (const provider of ["openai-codex", "openai-codex-2", "openai-codex-3", "openai-codex-10"]) {
      assert.equal(isCodexProvider(provider), true, provider);
    }
    const others = ["openai-codex-", "openai-codex-x", "openai-codexx", "openai-codex-2x", "openai-codex-2-3", "xopenai-codex-2", "OpenAI-Codex", "openai", "openrouter", "anthropic", "anthropic-2", "github-copilot-2", ""];
    for (const provider of others) assert.equal(isCodexProvider(provider), false, provider);
  });

  test("isWorkCodex is a Codex provider that the bindings tie to the work scope", () => {
    const hera = rosterFixtureV2("roster-hera-v2.json").accounts;
    assert.equal(isWorkCodex(hera, "openai-codex-3"), true);
    assert.equal(isWorkCodex(hera, "openai-codex-2"), false, "a personal binding");
    assert.equal(isWorkCodex(hera, "openai-codex"), false, "no binding");
    assert.equal(isWorkCodex(hera, "openrouter"), false);
    assert.equal(isWorkCodex(rosterFixtureV2("roster-work.json").accounts, "openai-codex"), true, "a native login bound to work");
    assert.equal(isWorkCodex(new Map([["anthropic-2", { scope: "work" as const }]]), "anthropic-2"), false, "work-bound, but not Codex");
    assert.equal(isWorkCodex(new Map(), "openai-codex-3"), false, "no bindings, as before any roster has loaded");
  });

  test("auto reaches the session scope's level roles, none without that scope, and never the local role", () => {
    const hera = rosterFixtureV2("roster-hera-v2.json");
    assert.deepEqual([...autoRoles(hera, "personal")], ["low", "medium", "high", "super"]);
    assert.deepEqual([...autoRoles(hera, "work")], ["work-low", "work-medium", "work-high", "work-super"]);
    const work = rosterFixtureV2("roster-work.json");
    assert.deepEqual([...autoRoles(work, "work")], ["work-low", "work-medium", "work-high", "work-super"]);
    assert.deepEqual([...autoRoles(work, "personal")], [], "the work roster has no personal scope");
    const v1 = rosterFixture("roster-hera.json");
    assert.deepEqual([...autoRoles(v1, "work")], [...autoRoles(v1, "personal")], "version 1 ignores the scope");
  });

  test("excludesFor lifts the work alias from the merged exclusions only in a version 2 work-scope session", () => {
    const hera = rosterFixtureV2("roster-hera-v2.json");
    const merged = [...BUILTIN_EXCLUDES, ...hera.exclude];
    assert.deepEqual(excludesFor(hera, "personal", "openai-codex-3/gpt-6.1-sol"), merged);
    assert.deepEqual(excludesFor(hera, "work", "openai-codex-3/gpt-6.1-sol"), merged.filter((pattern) => pattern !== "openai-codex-3/*"));
    assert.deepEqual(excludesFor(hera, "work", "openai-codex-2/gpt-6.1-sol"), merged, "a personal level's ref");
    const own = { ...hera, exclude: [...hera.exclude, "openai-codex-3/gpt-6.1-sol"] };
    assert.equal(excludedBy(excludesFor(own, "work", "openai-codex-3/gpt-6.1-sol"), "openai-codex-3/gpt-6.1-sol"), "openai-codex-3/gpt-6.1-sol", "the roster's own exclusions stay in force");
    const v1 = rosterFixture("roster-hera.json");
    for (const scope of SCOPES) assert.deepEqual(excludesFor(v1, scope, "openai-codex-3/gpt-6.1-sol"), [...BUILTIN_EXCLUDES, ...v1.exclude], scope);
  });

  test("liftWorkAlias lifts openai-codex-3/* only for a work-bound provider's ref in a work level's role", () => {
    const hera = rosterFixtureV2("roster-hera-v2.json");
    const all = [...BUILTIN_EXCLUDES, ...hera.exclude];
    const lifted = liftWorkAlias(hera, "openai-codex-3/gpt-6.1-sol", all);
    assert.deepEqual(lifted, all.filter((pattern) => pattern !== "openai-codex-3/*"));
    assert.equal(excludedBy(lifted, "openai-codex-3/gpt-6.1-sol"), undefined);
    assert.deepEqual(liftWorkAlias(hera, "openai-codex-3/gpt-6-nova", all), all, "a ref in no role");
    const inPersonal = { ...hera, roles: hera.roles.map((role) => (role.name === "low" ? { ...role, models: [...role.models, "openai-codex-3/gpt-6-nova"] } : role)) };
    assert.deepEqual(liftWorkAlias(inPersonal, "openai-codex-3/gpt-6-nova", all), all, "a ref in a personal level");
    const spare: ScopedBinding = { kind: "multi-pass", label: "spare", scope: "personal" };
    const personal = { ...hera, accounts: new Map<string, ScopedBinding>([...hera.accounts, ["openai-codex-3", spare]]) };
    assert.deepEqual(liftWorkAlias(personal, "openai-codex-3/gpt-6.1-sol", all), all, "a work level's ref on a personal binding");
    assert.deepEqual(
      liftWorkAlias(hera, "openai-codex-3/gpt-6.1-sol", ["hermes/*", "openai-codex-3/*", "openai-codex-3/gpt-6.1-sol"]),
      ["hermes/*", "openai-codex-3/gpt-6.1-sol"],
      "only the provider pattern is lifted, never an exact ref",
    );
  });
});

describe("version 2 account bindings", () => {
  test("a binding's scope is personal by default, or work", () => {
    assert.deepEqual(valid(HERA).accounts.get("openai-codex-2"), { kind: "multi-pass", label: "personal", scope: "personal" });
    const explicit = valid(
      edited((r) => {
        r.accounts["openai-codex-2"].scope = "personal";
      }),
    );
    assert.deepEqual(explicit.accounts.get("openai-codex-2"), { kind: "multi-pass", label: "personal", scope: "personal" });
    invalid(
      edited((r) => delete r.accounts["openai-codex-3"].scope),
      'accounts.openai-codex-3.multiPassLabel: the label "Positron work" is refused for a personal binding',
    );
    for (const scope of ["team", "Work", "", null, 1]) {
      invalid(
        edited((r) => {
          r.accounts["openai-codex-3"].scope = scope;
        }),
        'accounts.openai-codex-3.scope: must be "personal" or "work"',
      );
    }
  });

  test("a personal binding's label names neither work nor Positron", () => {
    for (const label of ["Positron work", "work", "Positron", "WORK laptop", "my-work", "positron (team)"]) {
      invalid(
        edited((r) => {
          r.accounts["openai-codex-2"].multiPassLabel = label;
        }),
        `accounts.openai-codex-2.multiPassLabel: the label "${label}" is refused for a personal binding`,
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

  test("a work binding's label names work or Positron", () => {
    for (const label of ["personal", "workbench", "homework", "positronic"]) {
      invalid(
        edited((r) => {
          r.accounts["openai-codex-3"].multiPassLabel = label;
        }),
        `accounts.openai-codex-3.multiPassLabel: the label "${label}" is refused for a work binding, whose label must contain work or Positron`,
      );
    }
    invalid(
      edited((r) => {
        r.accounts["openai-codex"].native = "personal";
      }, WORK),
      'accounts.openai-codex.native: the label "personal" is refused for a work binding, whose label must contain work or Positron',
    );
    for (const label of ["work", "Positron", "WORK laptop", "my-work"]) {
      const roster = valid(
        edited((r) => {
          r.accounts["openai-codex-3"].multiPassLabel = `  ${label} `;
        }),
      );
      assert.equal(roster.accounts.get("openai-codex-3")?.label, label);
    }
  });

  test("version 1's binding rules still hold", () => {
    invalid(
      edited((r) => {
        r.accounts.openrouter = { native: "personal" };
      }),
      /^accounts\.openrouter: openrouter is not a subscription provider/,
    );
    invalid(
      edited((r) => {
        r.accounts["openai-codex-3"] = { native: "Positron work", scope: "work" };
      }),
      'accounts.openai-codex-3: a Multi-Pass alias is bound with "multiPassLabel", not "native"',
    );
    invalid(
      edited((r) => {
        r.accounts["openai-codex"] = { multiPassLabel: "Positron work", scope: "work" };
      }, WORK),
      'accounts.openai-codex: a native login is bound with "native", not "multiPassLabel"',
    );
    invalid(
      edited((r) => delete r.accounts["openai-codex-3"]),
      'roles[5].models[0]: "openai-codex-3/gpt-6-luna" uses the subscription provider openai-codex-3, which needs a binding in accounts',
    );
  });
});

describe("scopes and their levels", () => {
  test("scopes is required and holds personal, work or both", () => {
    invalid(
      edited((r) => delete r.scopes),
      "scopes: is required",
    );
    invalid(
      edited((r) => {
        r.scopes = [];
      }),
      "scopes: must be an object",
    );
    for (const scopes of [{}, { $comment: "none yet" }]) {
      invalid(
        edited((r) => {
          r.scopes = scopes;
        }),
        "scopes: must not be empty",
      );
    }
    invalid(
      edited((r) => {
        r.scopes.team = r.scopes.work;
      }),
      "scopes.team: unknown key",
    );
    invalid(
      edited((r) => {
        r.scopes.personal = [];
      }),
      "scopes.personal: must be an object",
    );
    const personal = valid(
      edited((r) => {
        delete r.scopes.work;
        r.roles.splice(5);
      }),
    );
    assert.deepEqual(Object.keys(personal.scopes), ["personal"]);
  });

  test("every scope has all four levels, each naming a role", () => {
    invalid(
      edited((r) => delete r.scopes.personal.levels.super),
      "scopes.personal.levels.super: is required",
    );
    invalid(
      edited((r) => delete r.scopes.work.levels.low),
      "scopes.work.levels.low: is required",
    );
    invalid(
      edited((r) => delete r.scopes.personal.levels),
      "scopes.personal.levels: is required",
    );
    invalid(
      edited((r) => {
        r.scopes.personal.levels.extreme = r.scopes.personal.levels.super;
      }),
      "scopes.personal.levels.extreme: unknown key",
    );
    invalid(
      edited((r) => {
        r.scopes.personal.levels.low = "low";
      }),
      "scopes.personal.levels.low: must be an object",
    );
    invalid(
      edited((r) => delete r.scopes.personal.levels.low.role),
      "scopes.personal.levels.low.role: is required",
    );
    invalid(
      edited((r) => {
        r.scopes.personal.levels.low.role = "nobody";
      }),
      'scopes.personal.levels.low.role: "nobody" is not a role',
    );
  });

  test("a level's description is 1 to 2000 characters", () => {
    invalid(
      edited((r) => delete r.scopes.personal.levels.high.describe),
      "scopes.personal.levels.high.describe: is required",
    );
    for (const describe of ["", "   ", 7]) {
      invalid(
        edited((r) => {
          r.scopes.personal.levels.high.describe = describe;
        }),
        "scopes.personal.levels.high.describe: must be a non-empty string",
      );
    }
    invalid(
      edited((r) => {
        r.scopes.work.levels.high.describe = "x".repeat(2001);
      }),
      "scopes.work.levels.high.describe: must be at most 2000 characters",
    );
    const longest = valid(
      edited((r) => {
        r.scopes.work.levels.high.describe = "x".repeat(2000);
      }),
    );
    assert.equal(scopeSection(longest, "work")?.levels.high.describe.length, 2000);
  });

  test("a description's length counts code points, not UTF-16 units", () => {
    const emoji = "😀";
    assert.equal(emoji.length, 2);
    for (const count of [1001, 2000]) {
      const roster = valid(
        edited((r) => {
          r.scopes.work.levels.high.describe = emoji.repeat(count);
        }),
      );
      assert.equal(scopeSection(roster, "work")?.levels.high.describe, emoji.repeat(count), `${count} code points, ${2 * count} units`);
    }
    invalid(
      edited((r) => {
        r.scopes.work.levels.high.describe = emoji.repeat(2001);
      }),
      "scopes.work.levels.high.describe: must be at most 2000 characters",
    );
  });

  test("each scope's level roles rank in level order", () => {
    invalid(
      edited((r) => {
        r.scopes.personal.levels.low.role = "high";
        r.scopes.personal.levels.high.role = "low";
      }),
      'scopes.personal.levels.medium.role: "medium" must rank above "high", the role of the low level',
    );
    invalid(
      edited((r) => {
        r.scopes.personal.levels.high.role = "super";
        r.scopes.personal.levels.super.role = "high";
      }),
      'scopes.personal.levels.super.role: "high" must rank above "super", the role of the high level',
    );
    invalid(
      edited((r) => {
        r.scopes.work.levels.low.role = "work-high";
        r.scopes.work.levels.high.role = "work-low";
      }),
      'scopes.work.levels.medium.role: "work-medium" must rank above "work-high", the role of the low level',
    );
  });

  test("a role serves one level of one scope, and is never the local role", () => {
    invalid(
      edited((r) => {
        r.scopes.personal.levels.medium.role = "low";
      }),
      "scopes.personal.levels.medium.role: \"low\" is already the role of the personal scope's low level",
    );
    invalid(
      edited((r) => {
        r.scopes.work.levels.low.role = "low";
      }),
      "scopes.work.levels.low.role: \"low\" is already the role of the personal scope's low level",
    );
    invalid(
      edited((r) => {
        r.scopes.personal.levels.low.role = "local";
      }),
      "local.role: \"local\" is already the role of the personal scope's low level",
    );
    invalid(
      edited((r) => {
        r.local.role = "work-super";
      }),
      "local.role: \"work-super\" is already the role of the work scope's super level",
    );
  });

  test("work directories are absolute paths in canonical form, and only the work scope has them", () => {
    const refused: Array<[unknown, string]> = [
      ["src/positron", '"src/positron" is not an absolute path'],
      ["~/x", '"~/x" is not an absolute path'],
      ["/", '"/" would put every session in work scope'],
      ["//", '"//" would put every session in work scope'],
      ["/x/", 'write "/x", not "/x/"'],
      ["/Users/johnw/src/positron//", 'write "/Users/johnw/src/positron", not "/Users/johnw/src/positron//"'],
      ["/Users/johnw/../johnw/src/positron", '"/Users/johnw/../johnw/src/positron" must not contain empty, . or .. segments'],
      ["/..", '"/.." must not contain empty, . or .. segments'],
      ["/Users/./johnw", '"/Users/./johnw" must not contain empty, . or .. segments'],
      ["/Users//johnw", '"/Users//johnw" must not contain empty, . or .. segments'],
      ["", "must be a non-empty string"],
      [3, "must be a non-empty string"],
    ];
    for (const [directory, problem] of refused) {
      invalid(
        edited((r) => {
          r.scopes.work.directories = [directory];
        }),
        `scopes.work.directories[0]: ${problem}`,
      );
    }
    invalid(
      edited((r) => {
        r.scopes.work.directories = ["/x", "/x"];
      }),
      'scopes.work.directories[1]: "/x" is listed twice',
    );
    invalid(
      edited((r) => {
        r.scopes.work.directories = "/x";
      }),
      "scopes.work.directories: must be an array",
    );
    invalid(
      edited((r) => {
        r.scopes.personal.directories = ["/Users/johnw/src"];
      }),
      "scopes.personal.directories: unknown key",
    );
    const kept = ["/a", "/Users/johnw/src/positron-docs", "/x y/a..b/.z"];
    const roster = valid(
      edited((r) => {
        r.scopes.work.directories = kept;
      }),
    );
    assert.deepEqual(scopeSection(roster, "work")?.directories, kept);
    for (const edit of [(r: Json) => delete r.scopes.work.directories, (r: Json) => (r.scopes.work.directories = [])]) {
      assert.deepEqual(scopeSection(valid(edited(edit)), "work")?.directories, []);
    }
  });
});

describe("each level's accounts", () => {
  test("a personal level holds no work-bound provider", () => {
    invalid(
      edited((r) => r.roles[1].models.push("openai-codex-3/gpt-6-nova")),
      "roles[1].models[3]: \"openai-codex-3/gpt-6-nova\" is in the personal scope's low level, but openai-codex-3 is work-bound",
    );
    invalid(
      edited((r) => {
        r.exclude = [];
        r.accounts["openai-codex"] = { native: "Positron work", scope: "work" };
        r.roles[4].models.push("openai-codex/gpt-6-nova");
      }),
      "roles[4].models[2]: \"openai-codex/gpt-6-nova\" is in the personal scope's super level, but openai-codex is work-bound",
    );
  });

  test("a work level holds only work-bound Codex or Claude Code models, not arbitrary cloud or personal accounts", () => {
    for (const ref of ["openrouter/qwen/qwen-9-max", "nyx/qwen-local", "omlx-hera/GLM-9", "openai-codex-2/gpt-6-nova"]) {
      invalid(
        edited((r) => r.roles[5].models.push(ref)),
        `roles[5].models[1]: "${ref}" is in the work scope's low level, which takes only work-bound Codex or Claude Code models`,
      );
    }
    invalid(
      edited((r) => {
        r.accounts.anthropic = { native: "Positron work", scope: "work" };
        r.roles[8].models.push("anthropic/claude-x");
      }),
      "roles[8].models[1]: \"anthropic/claude-x\" is in the work scope's super level, which takes only work-bound Codex or Claude Code models",
    );
  });
});

describe("exclusions in version 2", () => {
  test("openai-codex-3/* still excludes a model in a personal level, even bound as a personal account", () => {
    invalid(
      edited((r) => {
        delete r.scopes.work;
        r.roles.splice(5);
        r.accounts["openai-codex-3"] = { multiPassLabel: "spare" };
        r.roles[1].models.push("openai-codex-3/gpt-6-luna");
      }),
      'roles[1].models[3]: "openai-codex-3/gpt-6-luna" is excluded by openai-codex-3/*',
    );
  });

  test("only the built-in openai-codex-3/* is lifted: the roster's own stays in force", () => {
    invalid(
      edited((r) => {
        r.exclude = ["openai-codex/*", "openai-codex-3/*"];
      }),
      'roles[5].models[0]: "openai-codex-3/gpt-6-luna" is excluded by openai-codex-3/*',
    );
    const workOnAlias = (exclude?: readonly string[]): Json =>
      edited((r) => {
        for (const role of r.roles) role.models = role.models.map((ref: string) => ref.replace(/^openai-codex\//, "openai-codex-3/"));
        r.accounts = { "openai-codex-3": { multiPassLabel: "Positron work", scope: "work" } };
        if (exclude !== undefined) r.exclude = exclude;
      }, WORK);
    assert.deepEqual(valid(workOnAlias()).roles[0]?.models, ["openai-codex-3/gpt-6-luna"], "the control: lifted for the work levels");
    invalid(workOnAlias(["openai-codex-3/*"]), 'roles[0].models[0]: "openai-codex-3/gpt-6-luna" is excluded by openai-codex-3/*');
  });

  test("the roster's own openai-codex-3/* applies with the roles, before the accounts, the scopes and the levels are read", () => {
    const own = 'roles[5].models[0]: "openai-codex-3/gpt-6-luna" is excluded by openai-codex-3/*';
    // Each of these defects is the first one reported once the roster's own exclusion is left out.
    const later: ReadonlyArray<readonly [string, (r: Json) => void]> = [
      ['accounts.openai-codex-3.scope: must be "personal" or "work"', (r) => (r.accounts["openai-codex-3"].scope = "team")],
      ['roles[5].models[0]: "openai-codex-3/gpt-6-luna" uses the subscription provider openai-codex-3, which needs a binding in accounts', (r) => delete r.accounts["openai-codex-3"]],
      ['scopes.personal.levels.low.role: "nobody" is not a role', (r) => (r.scopes.personal.levels.low.role = "nobody")],
      ["roles[5].models[1]: \"openrouter/qwen/qwen-9-max\" is in the work scope's low level, which takes only work-bound Codex or Claude Code models", (r) => r.roles[5].models.push("openrouter/qwen/qwen-9-max")],
    ];
    for (const [defect, edit] of later) {
      invalid(edited(edit), defect);
      invalid(
        edited((r) => {
          r.exclude = ["openai-codex/*", "openai-codex-3/*"];
          edit(r);
        }),
        own,
      );
    }
  });

  test("openai-codex-3/* is lifted only in a work level's role", () => {
    invalid(
      edited((r) => r.roles.push({ name: "spare", models: ["openai-codex-3/gpt-6-nova"] })),
      'roles[9].models[0]: "openai-codex-3/gpt-6-nova" is excluded by openai-codex-3/*',
    );
    invalid(
      edited((r) => delete r.scopes.work),
      'roles[5].models[0]: "openai-codex-3/gpt-6-luna" is excluded by openai-codex-3/*',
    );
  });

  test("every other exclusion applies as in version 1, before the scopes are read", () => {
    const cases: Array<[string, string]> = [
      ["hermes/hermes-4", "hermes/*"],
      ["openrouter/openrouter/auto", "openrouter/openrouter/auto"],
      ["smart-router/auto", "smart-router/*"],
      ["openai-codex/gpt-6.1-sol", "openai-codex/*"],
    ];
    for (const [ref, pattern] of cases) {
      invalid(
        edited((r) => {
          r.roles[5].models = [ref];
          delete r.scopes;
        }),
        `roles[5].models[0]: "${ref}" is excluded by ${pattern}`,
      );
    }
    invalid(
      edited((r) => {
        r.exclude = ["openai-codex-3/gpt-6.1-sol"];
        delete r.scopes;
      }),
      'roles[7].models[0]: "openai-codex-3/gpt-6.1-sol" is excluded by openai-codex-3/gpt-6.1-sol',
    );
  });
});

describe("the classifier", () => {
  const DEFAULTS = { model: "openrouter/typesafe/jev-1.14", timeoutMs: 1000, context: { messages: 6, messageChars: 1500, totalChars: 12000 } };

  test("is optional, and every field it leaves out takes its default", () => {
    const none = valid(edited((r) => delete r.classifier));
    assert.equal("classifier" in none, false);
    assert.deepEqual(
      valid(
        edited((r) => {
          r.classifier = {};
        }),
      ).classifier,
      DEFAULTS,
    );
    const some = valid(
      edited((r) => {
        r.classifier = { model: "openrouter/typesafe/jev-1.15", closeCall: 0, context: { messages: 0 } };
      }),
    );
    assert.deepEqual(some.classifier, { ...DEFAULTS, model: "openrouter/typesafe/jev-1.15", context: { ...DEFAULTS.context, messages: 0 } }, "closeCall is accepted and ignored: demand.closeCall decides a close call");
    assert.deepEqual(some.ignored, ["classifier.closeCall"], "and the roster says it was given");
    for (const bounds of [
      { model: "openrouter/typesafe/jev-1.14", timeoutMs: 100, closeCall: 0.5, context: { messages: 20, messageChars: 8000, totalChars: 32000 } },
      { model: "openrouter/typesafe/jev-1.14", timeoutMs: 1000, closeCall: 0, context: { messages: 0, messageChars: 200, totalChars: 1000 } },
    ]) {
      const { closeCall: _ignored, ...kept } = bounds;
      assert.deepEqual(
        valid(
          edited((r) => {
            r.classifier = bounds;
          }),
        ).classifier,
        kept,
        "closeCall is accepted and ignored: demand.closeCall decides a close call",
      );
    }
  });

  test("its model is an exact provider/id ref", () => {
    for (const model of ["jev", "openrouter/", "openrouter/*", "open router/jev", "/jev"]) {
      invalid(
        edited((r) => {
          r.classifier.model = model;
        }),
        `classifier.model: "${model}" is not an exact provider/id ref`,
      );
    }
    for (const model of ["", 7]) {
      invalid(
        edited((r) => {
          r.classifier.model = model;
        }),
        "classifier.model: must be a non-empty string",
      );
    }
  });

  test("its model, written or the default, is refused when an exclusion matches it, with nothing lifted", () => {
    const cases: Array<[string, string]> = [
      ["openai-codex-3/gpt-6-luna", "openai-codex-3/*"],
      ["openai-codex/gpt-6-luna", "openai-codex/*"],
      ["hermes/hermes-4", "hermes/*"],
      ["openrouter/openrouter/auto", "openrouter/openrouter/auto"],
      ["smart-router/auto", "smart-router/*"],
    ];
    for (const [model, pattern] of cases) {
      invalid(
        edited((r) => {
          r.classifier.model = model;
        }),
        `classifier.model: "${model}" is excluded by ${pattern}`,
      );
    }
    const workWithout = (classifier: object): Json =>
      edited((r) => {
        r.exclude = ["openrouter/*"];
        r.classifier = classifier;
      }, WORK);
    for (const classifier of [{}, { model: "openrouter/typesafe/jev-1.14" }]) {
      invalid(workWithout(classifier), 'classifier.model: "openrouter/typesafe/jev-1.14" is excluded by openrouter/*');
    }
    assert.equal(valid(workWithout({ model: "typesafe/jev-1.14" })).classifier?.model, "typesafe/jev-1.14");
  });

  test("timeoutMs is a whole number of milliseconds from 100 to 1000", () => {
    for (const timeoutMs of [1001, 99, 0, 500.5, "1000", null]) {
      invalid(
        edited((r) => {
          r.classifier.timeoutMs = timeoutMs;
        }),
        "classifier.timeoutMs: must be a whole number of milliseconds from 100 to 1000",
      );
    }
  });

  test("closeCall is still checked as a number from 0 to 0.5, and a valid one is ignored", () => {
    for (const closeCall of [0.6, 0.5000001, -0.01, "0.15", null, true]) {
      invalid(
        edited((r) => {
          r.classifier.closeCall = closeCall;
        }),
        "classifier.closeCall: must be a number from 0 to 0.5",
      );
    }
    invalid(HERA.replace('"classifier": {', '"classifier": { "closeCall": 1e999,'), "classifier.closeCall: must be a number from 0 to 0.5");
    const given = valid(
      edited((r) => {
        r.classifier.closeCall = 0.2;
      }),
    );
    assert.deepEqual([given.ignored, given.classifier !== undefined && "closeCall" in given.classifier], [["classifier.closeCall"], false], "demand.closeCall decides a close call");
  });

  test("the context caps are whole numbers within their ranges", () => {
    const cases: Array<[string, unknown, string]> = [
      ["messages", 21, "must be a whole number of messages from 0 to 20"],
      ["messages", -1, "must be a whole number of messages from 0 to 20"],
      ["messages", 2.5, "must be a whole number of messages from 0 to 20"],
      ["messageChars", 199, "must be a whole number of characters from 200 to 8000"],
      ["messageChars", 8001, "must be a whole number of characters from 200 to 8000"],
      ["totalChars", 999, "must be a whole number of characters from 1000 to 32000"],
      ["totalChars", 32001, "must be a whole number of characters from 1000 to 32000"],
      ["totalChars", "12000", "must be a whole number of characters from 1000 to 32000"],
    ];
    for (const [key, value, problem] of cases) {
      invalid(
        edited((r) => {
          r.classifier.context = { [key]: value };
        }),
        `classifier.context.${key}: ${problem}`,
      );
    }
    invalid(
      edited((r) => {
        r.classifier.context = [];
      }),
      "classifier.context: must be an object",
    );
    invalid(
      edited((r) => {
        r.classifier = "openrouter/typesafe/jev-1.14";
      }),
      "classifier: must be an object",
    );
  });
});

describe("stickyIdleMinutes in version 2", () => {
  test("is accepted, is not on the roster, and is recorded as ignored", () => {
    const roster = valid(edited((r) => {
      r.stickyIdleMinutes = 5;
    }));
    assert.equal("stickyIdleMinutes" in roster, false, "nothing holds a session by time");
    assert.deepEqual(roster.ignored, ["stickyIdleMinutes"]);
  });

  test("a roster without it ignores nothing", () => {
    assert.deepEqual(valid(HERA).ignored, []);
  });

  test("is still refused out of its range, with the same text", () => {
    invalid(
      edited((r) => {
        r.stickyIdleMinutes = -1;
      }),
      "stickyIdleMinutes: must be a whole number of minutes from 0 to 1440",
    );
  });
});

describe("version 2 keys", () => {
  const objects: Array<[(r: Json) => Json, string]> = [
    [(r) => r, ""],
    [(r) => r.roles[1], "roles[1]."],
    [(r) => r.scopes, "scopes."],
    [(r) => r.scopes.personal, "scopes.personal."],
    [(r) => r.scopes.personal.levels, "scopes.personal.levels."],
    [(r) => r.scopes.personal.levels.low, "scopes.personal.levels.low."],
    [(r) => r.scopes.work, "scopes.work."],
    [(r) => r.scopes.work.levels.super, "scopes.work.levels.super."],
    [(r) => r.accounts["openai-codex-3"], "accounts.openai-codex-3."],
    [(r) => r.classifier, "classifier."],
    [(r) => (r.classifier.context = {}), "classifier.context."],
    [(r) => r.local, "local."],
  ];

  test("unknown keys are refused at every level", () => {
    for (const [target, prefix] of objects) {
      invalid(
        edited((r) => {
          target(r).unexpected = true;
        }),
        `${prefix}unexpected: unknown key`,
      );
    }
  });

  test("__proto__, constructor and prototype are refused at every level", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const [target, prefix] of [...objects, [(r: Json) => r.accounts, "accounts."] as const]) {
        invalid(
          edited((r) => withKey(target(r), key, {})),
          `${prefix}${key}: forbidden key`,
        );
      }
    }
  });

  test("$comment is allowed at every level, and must be a string", () => {
    valid(
      edited((r) => {
        for (const [target] of objects) target(r).$comment = "note";
      }),
    );
    for (const [target, prefix] of objects) {
      invalid(
        edited((r) => {
          target(r).$comment = 3;
        }),
        `${prefix}$comment: must be a string`,
      );
    }
  });
});

test("version 2 reports its first defect in order: keys, exclude, roles, accounts, scopes, level accounts, the work alias, local, classifier, demand, switching, adaptiveReasoning, minutes", () => {
  const defects: Array<readonly [string, (r: Json) => void]> = [
    ["unexpected: unknown key", (r) => (r.unexpected = 1)],
    ['exclude[0]: "x" is neither a provider/id ref nor a provider/* pattern', (r) => (r.exclude = ["x"])],
    ['roles[1].models[0]: "hermes/x" is excluded by hermes/*', (r) => (r.roles[1].models[0] = "hermes/x")],
    ['accounts.openai-codex-3.scope: must be "personal" or "work"', (r) => (r.accounts["openai-codex-3"].scope = "team")],
    ['scopes.personal.levels.low.role: "nobody" is not a role', (r) => (r.scopes.personal.levels.low.role = "nobody")],
    ["roles[5].models[1]: \"openrouter/qwen/qwen-9-max\" is in the work scope's low level, which takes only work-bound Codex or Claude Code models", (r) => r.roles[5].models.push("openrouter/qwen/qwen-9-max")],
    ['roles[9].models[0]: "openai-codex-3/gpt-6-nova" is excluded by openai-codex-3/*', (r) => r.roles.push({ name: "spare", models: ["openai-codex-3/gpt-6-nova"] })],
    ['local.role: "nobody" is not a role', (r) => (r.local.role = "nobody")],
    ["classifier.timeoutMs: must be a whole number of milliseconds from 100 to 1000", (r) => (r.classifier.timeoutMs = 1001)],
    ["demand.jevWeight: must be a number from 0 to 100", (r) => (r.demand = { jevWeight: -1 })],
    ["switching.margin: must be a number from 0 to 0.9", (r) => (r.switching = { margin: 1 })],
    ["adaptiveReasoning.enabled: must be true or false", (r) => (r.adaptiveReasoning = { enabled: "no" })],
    ["cooldownMinutes: must be a whole number of minutes from 1 to 1440", (r) => (r.cooldownMinutes = 0)],
  ];
  // Each defect is the one reported while every later defect is present too.
  for (const [index, [expected]] of defects.entries()) {
    invalid(
      edited((r) => {
        for (const [, edit] of defects.slice(index)) edit(r);
      }),
      expected,
    );
  }
  valid(HERA);
});

describe("the demand and switching sections", () => {
  const FALLBACK = fixture("roster-hera-v2-fallback.json");
  const SURVIVAL_PROBLEM = "switching.cacheSurvival: must be 1 to 32 pairs of [seconds, chance], the seconds rising and the chances from 1 to 0 never rising";
  const CUTS_PROBLEM = "demand.cuts: must be three numbers that ascend, each above 0 and below 3";
  const ALL_ZERO = Object.fromEntries(SIGNALS.map((signal) => [signal, 0]));

  test("a roster without them gets the defaults", () => {
    const roster = rosterFixtureV2("roster-hera-v2-fallback.json");
    assert.deepEqual(roster.demand, DEFAULT_DEMAND, "demand defaults");
    assert.deepEqual(roster.switching, DEFAULT_SWITCHING, "switching defaults");
    assert.deepEqual(DEFAULT_DEMAND.weights, DESIGN_WEIGHTS, "the default weights are the design's");
    assert.equal(DESIGN_WEIGHTS.requirement_low + DESIGN_WEIGHTS.cluster_signal, 0, "the two signals nothing computes carry no weight");
  });

  test("a section that gives one setting keeps the defaults for the rest", () => {
    const switching = valid(edited((r) => (r.switching = { margin: 0.3 }), FALLBACK)).switching;
    assert.equal(switching.margin, 0.3, "the margin given");
    assert.equal(switching.horizonCap, 5, "the default horizon cap");
    assert.deepEqual(switching.cacheSurvival, DEFAULT_SWITCHING.cacheSurvival, "the default table");
    const demand = valid(edited((r) => (r.demand = { weights: { turn_type: 0.3 } }), FALLBACK)).demand;
    assert.equal(demand.weights.turn_type, 0.3, "the weight given");
    assert.equal(demand.weights.triage_verdict, 0.18, "another weight keeps its default");
    assert.equal(demand.weights.requirement_low, 0, "a signal nothing computes keeps weight 0");
    assert.equal(demand.jevWeight, 4, "the default Jev weight");
    assert.deepEqual(demand.cuts, [0.75, 1.5, 2.25], "the default cuts");
  });

  test("refuses what the checker promises to refuse", () => {
    for (const [section, expected] of [
      [{ demand: { jevWeight: -1 } }, "demand.jevWeight: must be a number from 0 to 100"],
      [{ demand: { jevWeight: 0, heuristicsWeight: 0 } }, "demand: jevWeight and heuristicsWeight cannot both be 0"],
      [{ demand: { cuts: [0.75, 1.5, 2.25 + 0.75] } }, CUTS_PROBLEM],
      [{ demand: { cuts: [0.75, 0.5, 2.25] } }, CUTS_PROBLEM],
      [{ demand: { cuts: [0.75, 1.5] } }, CUTS_PROBLEM],
      [{ demand: { deepSessionFloor: "top" } }, "demand.deepSessionFloor: must be one of low, medium, high, super"],
      [{ demand: { weights: { turn_type: -0.1 } } }, "demand.weights.turn_type: must be a number from 0 to 100"],
      [{ demand: { weights: { speed: 1 } } }, "demand.weights.speed: unknown key"],
      [{ demand: { weights: ALL_ZERO } }, "demand.weights: cannot all be 0"],
      [{ switching: { margin: 1 } }, "switching.margin: must be a number from 0 to 0.9"],
      [{ switching: { horizonCap: 0 } }, "switching.horizonCap: must be a whole number of runs from 1 to 20"],
      [{ switching: { cacheSurvival: [[300, 0.9], [60, 0.8]] } }, SURVIVAL_PROBLEM],
      [{ switching: { cacheSurvival: [[60, 0.8], [300, 0.9]] } }, SURVIVAL_PROBLEM],
      [{ switching: { cacheSurvival: [] } }, SURVIVAL_PROBLEM],
    ] as const) {
      const parsed = parseRoster(JSON.stringify({ ...JSON.parse(FALLBACK), ...section }));
      assert.equal(parsed.ok, false, `${expected} is refused`);
      assert.ok(!parsed.ok && parsed.error.startsWith(expected), `${expected}, got ${parsed.ok ? "ok" : parsed.error}`);
    }
  });

  test("version 1 refuses both sections as unknown keys", () => {
    for (const key of ["demand", "switching"]) {
      const parsed = parseRoster(JSON.stringify({ ...JSON.parse(fixture("roster-hera.json")), [key]: {} }));
      assert.ok(!parsed.ok && parsed.error.startsWith(`${key}: unknown key`), `${key} in version 1`);
    }
  });
});

describe("the adaptiveReasoning section: upstream's adaptive_reasoning (src/domain/types/schemas.ts:818-847)", () => {
  const FALLBACK = fixture("roster-hera-v2-fallback.json");
  const LEVELS = "must be one of minimal, low, medium, high, xhigh, max";

  test("a roster without it gets upstream's defaults: on, with no floor and no ceiling", () => {
    assert.deepEqual(rosterFixtureV2("roster-hera-v2-fallback.json").adaptiveReasoning, { enabled: true }, "schemas.ts:845-847");
    assert.deepEqual(DEFAULT_EFFORT, { enabled: true });
  });

  test("gives the off switch, the floor and the ceiling as written, the rest as upstream's defaults", () => {
    assert.deepEqual(valid(edited((r) => (r.adaptiveReasoning = { enabled: false }), FALLBACK)).adaptiveReasoning, { enabled: false }, "off");
    assert.deepEqual(valid(edited((r) => (r.adaptiveReasoning = { minLevel: "low" }), FALLBACK)).adaptiveReasoning, { enabled: true, minLevel: "low" }, "a floor alone");
    assert.deepEqual(valid(edited((r) => (r.adaptiveReasoning = { maxLevel: "high" }), FALLBACK)).adaptiveReasoning, { enabled: true, maxLevel: "high" }, "a ceiling alone");
    assert.deepEqual(valid(edited((r) => (r.adaptiveReasoning = { minLevel: "medium", maxLevel: "medium" }), FALLBACK)).adaptiveReasoning, { enabled: true, minLevel: "medium", maxLevel: "medium" }, "a floor equal to the ceiling");
    assert.deepEqual(valid(edited((r) => (r.adaptiveReasoning = {}), FALLBACK)).adaptiveReasoning, { enabled: true }, "an empty section");
  });

  test("refuses what upstream's schema refuses", () => {
    for (const [section, expected] of [
      [{ enabled: "no" }, "adaptiveReasoning.enabled: must be true or false"],
      [{ minLevel: "off" }, `adaptiveReasoning.minLevel: ${LEVELS}`],
      [{ maxLevel: "huge" }, `adaptiveReasoning.maxLevel: ${LEVELS}`],
      [{ minLevel: "high", maxLevel: "low" }, "adaptiveReasoning.minLevel: must not exceed maxLevel"],
      [{ floor: "low" }, "adaptiveReasoning.floor: unknown key"],
    ] as const) {
      const parsed = parseRoster(JSON.stringify({ ...JSON.parse(FALLBACK), adaptiveReasoning: section }));
      assert.equal(parsed.ok, false, `${expected} is refused`);
      assert.ok(!parsed.ok && parsed.error.startsWith(expected), `${expected}, got ${parsed.ok ? "ok" : parsed.error}`);
    }
  });

  test("version 1 refuses it as an unknown key, and has upstream's defaults", () => {
    const parsed = parseRoster(JSON.stringify({ ...JSON.parse(fixture("roster-hera.json")), adaptiveReasoning: {} }));
    assert.ok(!parsed.ok && parsed.error.startsWith("adaptiveReasoning: unknown key"), "adaptiveReasoning in version 1");
  });
});
