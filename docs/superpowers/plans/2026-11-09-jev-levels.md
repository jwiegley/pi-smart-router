# Four Jev-Classified Levels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every `smart-router/auto` run to one of four tiers (LOW, MEDIUM, HIGH, SUPER), chosen
by a trailing tag, by Jev, or by the keyword classifier, inside a per-session personal or work
scope, and record each run for training.

**Architecture:**
- Pure modules hold the new logic: tiers, tags, redaction, and the Jev request and its answer
  (`src/tiers.ts`, `src/tags.ts`, `src/redact.ts`, `src/jev.ts`).
- Roster schema version 2 lives in `src/roster.ts` beside the version 1 path, which is left
  untouched.
- Scope is session state, kept the way the pin is kept (`src/scope.ts`, an `src/owners.ts` latch,
  carried through handoffs in `src/router.ts`).
- The planner gains a version 2 path in `src/decide.ts`.
- The router's input handler becomes async. It removes tags and asks Jev through
  `ctx.modelRegistry.classify`. Jev is never asked from `route()`, which stays synchronous.
- Records go into the session through `pi.appendEntry` at `agent_settled`.

**Tech Stack:**
- TypeScript under the repository's tsconfig: `erasableSyntaxOnly`, `verbatimModuleSyntax`,
  `.ts` specifiers, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`.
- Node's test runner through `test/run.mjs`.
- Pi 1.5 (jwiegley/pi 1.5.0) extension API, and pi-ai's classifier types (`ClassifierContext`,
  `ClassifierResult`, `ClassifierModel`).

**Spec:** `docs/superpowers/specs/2026-11-09-jev-levels-design.md`. Read it with this plan; it
carries the reasons.

## Global Constraints

- **Tiers:** `low`, `medium`, `high`, `super`, ordered low < medium < high < super. They are
  displayed as LOW, MEDIUM, HIGH and SUPER. The code calls them *tiers*, because `Level` and
  `ALL_LEVELS` already mean thinking levels (`src/constants.ts:19-20`).
- **Tags:** the last whitespace-separated token of the message, case-insensitive, one of `#super`,
  `#high`, `#medium`, `#low`, `#s`, `#h`, `#m`, `#l`.
- **Keyword fallback:** planning → super, complex → high, default → medium, trivial → low.
- **Risky floor:** an untagged run whose text matches a risky trigger rises to at least `high`. A
  tagged run never rises. The triggers are applied to `withoutFileNames(capText(text))`:
  - `destructive-git`: `/\b(?:unstage|git\s+rm|rm\s+-rf|force\s+push|git\s+reset\s+--hard)\b/i`
  - `repo-cleanup`: `/\b(?:clean\s*up(?:\s+the)?\s+repo|repo\s+cleanup|cleanup\s+the\s+repo)\b/i`
  - `added-by-mistake`: `/\b(?:mistakenly\s+added|accidentally\s+added|accidental\s+add)\b/i`

  The spec names upstream's `destructive-git` and `cleanup-words` reasons, but those patterns
  (`src/classify.ts:32-33`) also match bare "destructive", "clean up" and "cleanup", which John's
  list leaves out, and `classify()` reports only its first reason. So the floor keeps its own
  patterns, taken from John's list.
- **Classifier defaults and ranges:**
  - `model`: `openrouter/typesafe/jev-1.14`;
  - `timeoutMs`: 1000, an integer from 100 to 1000;
  - `closeCall`: 0.15, a number from 0 to 0.5;
  - `context.messages`: 6, from 0 to 20;
  - `context.messageChars`: 1500, from 200 to 8000;
  - `context.totalChars`: 12000, from 1000 to 32000;
  - `describe`: from 1 to 2000 characters.
- **Close call:** when the top two probabilities differ by at most `closeCall`, take the higher
  tier of the two.
- **The Jev call** uses only `ctx.modelRegistry.findOfType("classifier", provider, id)` and
  `ctx.modelRegistry.classify(model, context, { timeoutMs, maxRetries: 0 })`. It is never made:
  - from `route()`;
  - while `pinOf(ctx).on`, which includes `PI_SMART_ROUTER_LOCAL_ONLY`;
  - on `smart-router/local`;
  - for a non-idle input;
  - without a version 2 `classifier` section.

  `timeoutMs` bounds the single HTTP attempt, not Pi's key lookup. pi-ai has no refusal branch, so
  an OpenRouter refusal arrives as `stopReason: "error"`. pi-ai does not check that the choice and
  the probabilities use the four labels; `interpret` does.
- **No timers, no network APIs, no child processes, no file writes, and no new import specifiers**
  in `src/**` or `index.ts`, not even in comments (`test/scan.test.ts`). The only timer on this
  path is pi-ai's per-attempt `timeoutMs`.
- **Names:**
  - entries: `smart-router.scope`, `smart-router.level`;
  - environment variable: `PI_SMART_ROUTER_SCOPE`, where the value `work` latches;
  - footer status key: `smart-router-level`. Never `smart-router`, which belongs to the pin.
- **Scope precedence:**
  1. the latch;
  2. the session's scope entry;
  3. the work directories, only for a session with no assistant message yet;
  4. personal.

  An unreadable or malformed scope entry makes `auto` refuse.
- **The pin outranks the work guard.** While pinned, only the pin's rules apply.
- **Version 1 rosters behave byte-identically:**
  - the parsed shape (`test/roster.test.ts:74,84,590`);
  - validation messages and their order;
  - status text (`test/commands.test.ts:58-86`);
  - history lines;
  - routing, including the last-responder preference (`test/decide.test.ts:126-132`).
- **TypeScript:** no `enum`, `namespace` or parameter properties; `import type` for types. Tests
  type-check too, because `tsconfig` includes `test/**`.
- **Running tests:**
  - Never run Pi's own test suites, and no `npx`.
  - The behaviour suite runs only sandboxed: `node test/sandbox.mjs test/behaviour.test.ts` or
    `npm run check:sandbox`.
  - Unit tests run with `node test/run.mjs test/<file>.test.ts`.
  - No test file other than `test/behaviour.test.ts` may import `test/support/host.ts`.
- **Commits:** signed (`git commit -S`), with explicit paths and one logical change each.
- **Release version:** `1.3.0-jw.2`.
- **John's rulings on this plan (2026-11-09):**
  - The selection guard applies in work scope only. In personal scope, a model picked by hand is
    sent as today, even a work-account model. Do not add a personal-scope guard.
  - The directory rule moves resumed sessions too (Task 5).
  - Execution is subagent-driven.
  - The push and the tag are authorized only under the conditions in Task 11, Step 7.

## Review Focus

1. **Hashtag-like last tokens that are not tags** must be left alone: `fix issue #12`, `#hashtag`,
   and `#high.` (punctuation attached). `#HIGH` and `go ahead #h` followed by a newline are tags.
   Task 1 tests these.
2. **Malformed Jev answers** must count as failures, with no tier taken from them:
   - a `stop` result whose choice is not a tier;
   - probabilities that miss a tier or add an `other` label;
   - empty answers.

   Task 2 tests these.
3. **Work directories match on segment boundaries:** `/x/work` matches `/x/work` and `/x/work/a`
   but not `/x/workshop`, and a `cwd` with a trailing slash still matches. Symlinked spellings are
   compared literally, which the README documents. Task 5 tests these.
4. **A session replaced during the Jev wait** (`/new` mid-wait): the handler still returns the tag
   transform, never throws, and the late answer never lands in another run's record. Task 7 tests
   this.
5. **Latch, entry and directory conflicts:**
   - a personal entry in a latched process resolves to work;
   - `/smart-router scope personal` under the latch is refused;
   - a resumed session that has turns but no scope entry, under a work directory, moves to work
     scope with a notice, while one with a personal entry stays personal.

   Tasks 5 and 9 test these.

---

**Before Task 1:** create a worktree on branch `feat/jev-levels` (superpowers:using-git-worktrees).
Install devDependencies with `npm install --ignore-scripts`, physically, without symlinking
`node_modules`, because `test/sandbox.sb` refuses reads outside the checkout. Confirm that
`npm run check` passes at the base. Then commit the spec and this plan:

```bash
git add docs/superpowers/specs/2026-11-09-jev-levels-design.md docs/superpowers/plans/2026-11-09-jev-levels.md
git commit -S -m "Add the four-level Jev design and its implementation plan"
```

### Task 1: Tiers, tags and the risky floor

**Files:**
- Create: `src/tiers.ts`, `src/tags.ts`
- Modify: `src/classify.ts`. Add `riskyTrigger` beside the PLANNING table at :27-34.
- Test: `test/tiers.test.ts`, `test/tags.test.ts`, `test/classify.test.ts`

**Interfaces:**
- Consumes: `Signal`, `capText` and `withoutFileNames` from `src/classify.ts`.
- Produces:
  ```ts
  // src/tiers.ts
  export type Tier = "low" | "medium" | "high" | "super";
  export const TIERS: readonly Tier[];                 // ["low", "medium", "high", "super"]
  export function isTier(value: unknown): value is Tier;
  export function tierRank(tier: Tier): number;        // index in TIERS
  export function higherTier(a: Tier, b: Tier): Tier;
  export function tierAbove(tier: Tier): Tier | undefined;
  export function tierLabel(tier: Tier): "LOW" | "MEDIUM" | "HIGH" | "SUPER";
  export function keywordTier(signal: Signal): Tier;
  export function closeCallTier(probabilities: Readonly<Record<Tier, number>>, closeCall: number): Tier;
  // src/tags.ts
  export interface Tagged { readonly tier: Tier; readonly text: string } // text: tag removed, trailing whitespace trimmed; "" when tag-only
  export function parseTag(text: string): Tagged | undefined;
  // src/classify.ts
  export type RiskyTrigger = "destructive-git" | "repo-cleanup" | "added-by-mistake";
  export function riskyTrigger(text: string): RiskyTrigger | undefined;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `test/tiers.test.ts`:
    - `keywordTier` maps planning, complex, default and trivial to super, high, medium and low.
    - `closeCallTier({low:.1, medium:.45, high:.4, super:.05}, .15) === "high"`.
    - `closeCallTier({low:.05, medium:.7, high:.2, super:.05}, .15) === "medium"`.
    - At the boundary, `{low:0, medium:.5, high:.35, super:.15}` with `.15` gives `"high"` (a
      difference of 0.15 counts as a close call).
    - Tied probabilities go to the higher tier.
    - `tierAbove("super") === undefined`.
  - `test/tags.test.ts`:

    | Input | `parseTag` result |
    |-------|-------------------|
    | `"refactor the loader #medium"` | `{tier:"medium", text:"refactor the loader"}` |
    | `"review this #H"` | `{tier:"high", text:"review this"}` |
    | `"go ahead #s\n"` | `{tier:"super", text:"go ahead"}` |
    | `"line one\nline two #m"` | `{tier:"medium", text:"line one\nline two"}` |
    | `"#low"` | `{tier:"low", text:""}` |
    | `"fix issue #12"`, `"#hashtag"`, `"#high."`, `"use #high here please"`, `""` | `undefined` |
  - `test/classify.test.ts`, new group `risky floor triggers`:

    | Input | `riskyTrigger` result |
    |-------|-----------------------|
    | `"force push it"`, `"git reset --hard HEAD~1"`, `"rm -rf node_modules/"`, `"please plan the force push"` | `"destructive-git"` |
    | `"clean up the repo"` | `"repo-cleanup"` |
    | `"I accidentally added secrets.env"` | `"added-by-mistake"` |
    | `"clean up this function"`, `"this is a destructive change"`, `"rename foo"` | `undefined` |

    Also assert that `classify("please plan the force push").reason === "planning:plan-words"`, to
    show why the floor scans on its own.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/tiers.test.ts test/tags.test.ts test/classify.test.ts`. They fail
  because the modules and exports do not exist yet.
- [ ] **Step 3: Implement the signatures above.**
  - `closeCallTier`: order the tiers by probability, highest first, with ties going to the higher
    rank. Take the first; if it leads the second by at most `closeCall`, return `higherTier` of
    the two.
  - `parseTag`: split off the last whitespace-separated token of `text.trimEnd()`.
  - `riskyTrigger`: test the three Global Constraints patterns in order, against
    `withoutFileNames(capText(text))`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run typecheck`.
- [ ] **Step 5: Commit.**
  `git add src/tiers.ts src/tags.ts src/classify.ts test/tiers.test.ts test/tags.test.ts test/classify.test.ts && git commit -S -m "Add tiers, trailing tags and the risky-operations floor triggers"`

**Controller rulings (pre-flight, binding; they amend this task):**
- `closeCallTier` counts a gap within `1e-9` of `closeCall` as a close call. In floating point,
  `0.5 - 0.35` is `0.15000000000000002`, so the boundary test fails with a bare `<=`.

### Task 2: Redaction and the Jev request

**Files:**
- Create: `src/redact.ts`, `src/jev.ts`
- Test: `test/redact.test.ts`, `test/jev.test.ts`

**Interfaces:**
- Consumes: Task 1's `Tier`, `TIERS`, `isTier` and `closeCallTier`; `capText` from `src/classify.ts`;
  `parseRef` from `src/roster.ts`.
- Produces:
  ```ts
  // src/redact.ts
  export const REDACTED = "[redacted]";
  export function redact(text: string): string;
  // src/jev.ts
  import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
  export const JEV_QUESTION = "level";
  export const JEV_INSTRUCTIONS =
    "How much model intelligence does `message` need for the work it asks for now? `recent` holds the conversation just before it, oldest first.";
  export interface JevContextCaps { readonly messages: number; readonly messageChars: number; readonly totalChars: number }
  export interface JevSettings { readonly model: string; readonly timeoutMs: number; readonly closeCall: number; readonly context: JevContextCaps }
  export interface RecentMessage { readonly role: "user" | "assistant"; readonly text: string }
  export function recentMessages(entries: readonly unknown[], limit: number): RecentMessage[];
  export function buildContext(message: string, recent: readonly RecentMessage[], descriptions: Readonly<Record<Tier, string>>, caps: JevContextCaps): ClassifierContext;
  export type JevFailure = "unavailable" | "error" | "timeout" | "aborted" | "malformed";
  export type JevOutcome =
    | { readonly kind: "answer"; readonly model: string; readonly choice: Tier; readonly tier: Tier; readonly probabilities: Readonly<Record<Tier, number>>; readonly confidence: number; readonly ms: number }
    | { readonly kind: "failure"; readonly model: string; readonly failure: JevFailure; readonly ms: number };
  export function interpret(result: ClassifierResult, closeCall: number, model: string, ms: number): JevOutcome;
  export interface ClassifierRegistry {
    findOfType(type: "classifier", provider: string, id: string): ClassifierModel<ClassifierApi> | undefined;
    classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext, options: { timeoutMs: number; maxRetries: number }): Promise<ClassifierResult>;
  }
  export function askJev(registry: ClassifierRegistry, settings: JevSettings, context: ClassifierContext, now: () => number): Promise<JevOutcome>; // never rejects
  ```

- [ ] **Step 1: Write the failing tests.**
  - `test/redact.test.ts`: one case per category. Each output contains `REDACTED` and not the
    secret:
    - `Authorization: Bearer abc.def.ghi` and `Basic dXNlcjpwYXNz`;
    - `sk-proj-` followed by 40 characters, `ghp_` followed by 36, `xoxb-1-2-3`, and `AKIA`
      followed by 16;
    - a `-----BEGIN PRIVATE KEY-----` block;
    - `https://user:hunter2@example.com/x` (keep the user, drop the password);
    - `password=hunter2` and `API_KEY: abc123`;
    - a 40-character mixed-case alphanumeric string.

    Two cases stay unchanged: `"rename foo to bar in src/a.ts"` and a 40-character lowercase
    English word run.
  - `test/jev.test.ts`:
    - `recentMessages` keeps only user and assistant text blocks, in order. It drops `toolResult`
      entries, thinking blocks and toolCall blocks. An assistant message with no text block is
      dropped and does not count toward `limit`. With `limit` 2 it keeps the last two.
    - `buildContext`:
      - `criteria` keys deepEqual `TIERS`, and `type === "choice"`;
      - `instructions === JEV_INSTRUCTIONS`;
      - the message and the recent texts are redacted before capping. A secret placed across the
        `HEAD_CHARS` boundary leaves no fragment of 8 or more of its characters in `state`;
      - each recent text is cut to its last `messageChars` characters;
      - the oldest recent messages are dropped first, so that the total text stays within
        `totalChars`.
    - `interpret`:
      - a `stop` result `{choice:"medium", probabilities:{low:.05, medium:.45, high:.4, super:.1}, confidence:.8}`
        with closeCall `.15` gives `{kind:"answer", choice:"medium", tier:"high"}`;
      - choice `"other"`, missing `super`, an extra key `other`, or empty answers give
        `{kind:"failure", failure:"malformed"}`;
      - `stopReason:"error"` with `errorMessage:"Request timed out after 1000ms"` gives `timeout`;
      - another error message gives `error`;
      - `aborted` gives `aborted`.
    - `askJev`:
      - the fake registry records the options, which deepEqual `{timeoutMs: 1000, maxRetries: 0}`;
      - `findOfType` is called with `("classifier", "openrouter", "typesafe/jev-1.14")`;
      - an undefined model gives `unavailable` with zero `classify` calls;
      - a throwing `classify` gives `error` and the promise resolves.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/redact.test.ts test/jev.test.ts`
- [ ] **Step 3: Implement the signatures.**
  - `redact` replaces each match with `REDACTED`. The builder writes the patterns, one per tested
    category.
  - `buildContext` redacts first and caps afterwards. The message goes through `capText` and then
    `totalChars`. `state` is `{ message, recent: [{ role, text }] }`, and the question is
    `{ [JEV_QUESTION]: { type: "choice", instructions: JEV_INSTRUCTIONS, criteria } }`, with
    `criteria` built from `descriptions` in `TIERS` order.
  - `askJev` wraps everything in `try`/`catch` and measures `ms` with `now()`.
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then
  `npm run typecheck`.
- [ ] **Step 5: Commit.**
  `git add src/redact.ts src/jev.ts test/redact.test.ts test/jev.test.ts && git commit -S -m "Add redaction and the Jev request and answer"`

**Controller rulings (pre-flight, binding; they amend this task):**
- When the capped message is still longer than `totalChars`, keep its first
  `totalChars - Math.floor(totalChars / 5)` characters and its last `Math.floor(totalChars / 5) - 1`,
  joined by `"\n"` as `capText` does, so that it is exactly `totalChars` long. Recent messages
  then get only the budget that is left. Test it.

### Task 3: Roster schema version 2

**Files:**
- Modify:
  - `src/roster.ts`: types at :21-65, allow-lists at :106-115, the version check at :182-184, and
    the validation body from :185.
  - `src/accounts.ts`: add `isCodexProvider`.
  - `test/support/catalog.ts`: `rosterFixture` returns `RosterV1`; add `rosterFixtureV2`.
- Create:
  - `test/roster-v2.test.ts`;
  - `test/fixtures/roster-hera-v2.json`;
  - `test/fixtures/roster-work.json`.
- Update the version 2 refusals: `test/roster.test.ts:279-286, 637-638` and
  `test/route.test.ts:304-307` now use `version: 3` as the invalid example.

**Interfaces:**
- Consumes: Task 1's `Tier` and `TIERS`; Task 2's `JevSettings` (as a type import).
- Produces:
  ```ts
  // src/roster.ts
  export type Scope = "personal" | "work";
  export const SCOPES: readonly Scope[];               // ["personal", "work"]
  export interface TierEntry { readonly role: string; readonly describe: string }
  export interface ScopeSection { readonly levels: Readonly<Record<Tier, TierEntry>>; readonly directories: readonly string[] } // [] for personal
  export type ScopedBinding = AccountBinding & { readonly scope: Scope };
  export interface RosterV1 { readonly version: 1; /* exactly today's Roster fields */ }
  export interface RosterV2 {
    readonly version: 2;
    readonly exclude: readonly string[];
    readonly roles: readonly Role[];
    readonly accounts: ReadonlyMap<string, ScopedBinding>;
    readonly local?: LocalSection;
    readonly stickyIdleMinutes: number;
    readonly cooldownMinutes: number;
    readonly scopes: Readonly<Partial<Record<Scope, ScopeSection>>>;
    readonly classifier?: JevSettings;                 // defaults filled in
  }
  export type Roster = RosterV1 | RosterV2;
  export function scopeSection(roster: Roster, scope: Scope): ScopeSection | undefined; // version 1 → undefined
  export function isWorkBound(roster: Roster, provider: string): boolean;               // version 2 binding with scope "work"
  // src/accounts.ts
  export function isCodexProvider(provider: string): boolean; // "openai-codex" or "openai-codex-<n>"
  ```
- **JSON shape** (field spellings are fixed here):
  ```json
  {
    "version": 2,
    "exclude": [],
    "roles": [],
    "scopes": {
      "personal": { "levels": { "low": { "role": "low", "describe": "..." } } },
      "work": { "levels": {}, "directories": ["/abs/path"] }
    },
    "accounts": { "openai-codex-3": { "multiPassLabel": "Positron work", "scope": "work" } },
    "classifier": {
      "model": "...",
      "timeoutMs": 1000,
      "closeCall": 0.15,
      "context": { "messages": 6, "messageChars": 1500, "totalChars": 12000 }
    },
    "local": {},
    "stickyIdleMinutes": 5,
    "cooldownMinutes": 30
  }
  ```
  Each `levels` object has all four tiers; the snippet shows one. A binding's `scope` defaults to
  `personal`. `directories` is allowed only under `work`, and may be omitted.

- [ ] **Step 1: Write the fixtures and the failing tests.**
  - `test/fixtures/roster-hera-v2.json`:
    - **Roles, in this order:**
      - `local`: `omlx-hera/GLM-5.3-Flash-oQ4e-mtp`, thinking max.
      - `low`: `openai-codex-2/gpt-6-luna`, `nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad`, `omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp`.
      - `medium`: `openai-codex-2/gpt-6.1-terra`, `openrouter/deepseek/deepseek-v4.1-flash-1017`.
      - `high`: `openai-codex-2/gpt-6.1-sol`, `openrouter/z-ai/glm-5.3`.
      - `super`: `openai-codex-2/gpt-6-astra`, `openrouter/moonshotai/kimi-k3.1-pro`.
      - `work-low`, `work-medium`, `work-high`, `work-super`: `openai-codex-3/` with `gpt-6-luna`,
        `gpt-6.1-terra`, `gpt-6.1-sol` and `gpt-6-astra` respectively.
    - **Scopes:** `personal` maps each tier to the role of the same name. `work` maps them to the
      `work-*` roles, with directories `["/Users/johnw/src/positron"]`.
    - **Accounts:** `openai-codex-2` with `multiPassLabel` "personal"; `openai-codex-3` with
      "Positron work" and scope work.
    - **Exclude:** `["openai-codex/*"]`.
    - **Local:** role `local`, providers `["omlx-hera", "nyx"]`, hosts `["hera.lan", "nyx.lan"]`.
    - **Classifier:** `{"model": "openrouter/typesafe/jev-1.14"}`.
    - **Descriptions:** the four meanings from the spec table.
  - `test/fixtures/roster-work.json`: the four `work-*` roles on native `openai-codex`, a work
    scope only, and the account `{"openai-codex": {"native": "Positron work", "scope": "work"}}`.
  - `test/roster-v2.test.ts`:
    - The Hera version 2 fixture parses. Classifier defaults are filled in
      (`{timeoutMs: 1000, closeCall: 0.15, context: {messages: 6, messageChars: 1500, totalChars: 12000}}`),
      `openai-codex-3` has scope work, and `scopeSection(r, "work")?.directories` deepEquals
      `["/Users/johnw/src/positron"]`.
    - The work fixture parses.
    - Each of the following fails, with a message naming its path:

      | Defect | Path named in the message |
      |--------|---------------------------|
      | a tier is missing | `scopes.personal.levels.super` |
      | an unknown role | `scopes.personal.levels.low.role` |
      | a level role equal to `local.role` | |
      | level ranks out of order (low on `high`, high on `low`) | |
      | one role used in both scopes | |
      | an `openai-codex-3` model in a personal level role | `excluded by openai-codex-3/*` |
      | an `openrouter/...` model in a work level role | |
      | a personal binding labelled "Positron work" | |
      | a work binding labelled "personal" | |
      | a directory that is relative, `~/x`, `/`, `/x/`, or contains `..` | |
      | `timeoutMs` 1001 or 99 | |
      | `closeCall` 0.6 | |
      | an unknown key at each level of the object | |
      | an empty `scopes` | |

    - Every existing test in `test/roster.test.ts` passes unchanged, except the three version 2
      refusals, which now use version 3.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/roster-v2.test.ts test/roster.test.ts test/route.test.ts`
- [ ] **Step 3: Implement version 2.** Dispatch at :184, so that version 1 runs today's body from
  :185 unchanged and version 2 runs a new `validateV2`. Keep `parseRoster`'s signature.

  `validateV2` uses the existing helpers and checks, in this order:
  1. the version 2 top keys;
  2. `exclude`;
  3. roles, using version 1's per-ref checks but deferring the built-in `openai-codex-3/*` check;
  4. accounts, with scope;
  5. scopes and levels;
  6. per-level account rules: a personal level role holds no work-bound provider, and a work level
     role holds only models whose provider passes `isCodexProvider` and is work-bound;
  7. the deferred exclusions, where `openai-codex-3/*` is lifted only for a work-bound provider in
     a work level role;
  8. `local`;
  9. `classifier`;
  10. the minutes.
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run typecheck`.
  Fix test spreads of `HERA.routing` by typing them as `RosterV1`.
- [ ] **Step 5: Commit.**
  `git add src/roster.ts src/accounts.ts test/roster-v2.test.ts test/roster.test.ts test/route.test.ts test/support/catalog.ts test/fixtures/roster-hera-v2.json test/fixtures/roster-work.json && git commit -S -m "Accept roster version 2: scoped levels, scoped bindings and a classifier"`

**Controller rulings (pre-flight, binding; they amend this task):**
- `Roster` becomes a union in this task, so Step 4's typecheck passes only if this task also
  narrows every consumer of the version 1 `routing` field on `version === 1`. Until later tasks
  replace them, the version 2 branches do this:
  - `autoRoles` (`src/roster.ts:99`): every level role of every scope present. Task 4 adds the
    scope.
  - The fallback at `src/decide.ts:88`: none. This is final, because version 2 has no
    cross-level fallback.
  - `planUserTurn` at `src/decide.ts:151`: refuses with code `v2-unplanned` and the decision
    `{ ok: false, attempts: [], problem: "version 2 planning is not built yet" }`. Task 6 replaces it.
  - `byDefault` at `src/route.ts:112`: the personal scope's `medium` role. Task 4 makes it the
    session scope's.
  - Status (`src/commands.ts:195-213`): no routing line and no fallback warnings. Task 9 adds the
    version 2 lines.

  Version 1 behaviour and text stay byte-identical. Add `src/decide.ts`, `src/route.ts` and
  `src/commands.ts` to the commit.
- Write the lifting of `openai-codex-3/*` as one exported helper in `src/roster.ts`. The pattern
  is lifted only for a work-bound provider in a work level role. Validation uses the helper here,
  and Task 4's `excludesFor` calls it.

### Task 4: Scope-aware resolution

**Files:**
- Modify:
  - `src/resolve.ts`: `ResolveContext` at :42-59, and the exclusion at :80.
  - `src/accounts.ts`: `checkAccount`, :84-107.
  - `src/roster.ts`: `autoRoles`, :95-102.
  - `src/route.ts`: `byDefault`, :111-115, and `assertSafe`, :182-201.
  - Every caller of `autoRoles` (`decide.ts:128`, `resolve.ts:99`, `route.ts:193`,
    `router.ts:186`, `commands.ts:141`) and of `routing` (`decide.ts:88,151`,
    `commands.ts:195-213`): narrow on the version.
  - `src/router.ts`: `contextFor` passes `scope: "personal"` until Task 5.
- Test: `test/resolve.test.ts`, `test/accounts.test.ts`, `test/route.test.ts`

**Interfaces:**
- Consumes: Task 3's `Scope`, `RosterV2`, `scopeSection`, `isWorkBound` and `isCodexProvider`.
- Produces:
  ```ts
  // src/resolve.ts
  export interface ResolveContext { /* existing fields */ readonly scope: Scope }
  // src/roster.ts
  export function autoRoles(roster: Roster, scope: Scope): ReadonlySet<string>; // version 1: unchanged set; version 2: the scope's four level roles (empty without that section)
  export function excludesFor(roster: Roster, scope: Scope, ref: string): readonly string[]; // version 2 work scope with a work-bound provider: BUILTIN_EXCLUDES minus "openai-codex-3/*", plus roster.exclude
  // src/accounts.ts
  export function checkAccount(provider: string, roster: Roster, labels: Loaded<Labels> | undefined, scope?: Scope): AccountCheck;
  ```
  - `checkAccount` takes today's path for version 1, or when `scope` is omitted. For version 2:
    - in personal scope, a work-bound provider is refused;
    - in work scope, the binding must be work-bound and its label must match `REFUSED_LABEL`, and
      Multi-Pass's label is still compared case-insensitively.
  - `byDefault` for version 2 uses the scope's `medium` role.
  - `assertSafe` for version 2 throws its invariant error in two cases:
    - a work-scope choice whose provider is not a work-bound Codex provider;
    - a personal-scope choice on a work-bound provider.

- [ ] **Step 1: Write the failing tests.**
  - `test/resolve.test.ts`, using `heraContext({ roster: rosterFixtureV2("roster-hera-v2.json"), scope })`:
    - in work scope, `resolveCandidate("openai-codex-3/gpt-6.1-sol")` gives `ok`;
    - in personal scope, the same ref gives a reason starting `excluded`;
    - in personal scope, `openrouter/z-ai/glm-5.3` gives `ok`.
  - `test/accounts.test.ts`:
    - a work binding with Multi-Pass label "Positron work" passes in work scope and is refused in
      personal scope;
    - a personal binding is refused in work scope;
    - the version 1 verdicts at `accounts.test.ts:151-164` are unchanged.
  - `test/route.test.ts`:
    - `assertSafe` throws for a work-scope choice of `openrouter/z-ai/glm-5.3`;
    - a direct request without a plan in version 2 personal scope routes to `openai-codex-2/gpt-6.1-terra`.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/resolve.test.ts test/accounts.test.ts test/route.test.ts`
- [ ] **Step 3: Implement.** Thread `rc.scope` through the files above. Version 1 code paths take
  `scope` and ignore it.
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run check`.
  All existing suites must pass.
- [ ] **Step 5: Commit.**
  `git add src/resolve.ts src/accounts.ts src/roster.ts src/route.ts src/decide.ts src/commands.ts src/router.ts test/resolve.test.ts test/accounts.test.ts test/route.test.ts && git commit -S -m "Resolve candidates, accounts and exclusions within a scope"`

**Controller rulings (pre-flight, binding; they amend this task):**
- `excludesFor` calls Task 3's helper for lifting `openai-codex-3/*`. Do not write the rule twice.
- `autoRoles(roster, scope)` replaces Task 3's interim all-scopes set. `byDefault` uses the
  `medium` role of `rc.scope`.
- `heraContext()` in `test/support/catalog.ts` defaults `scope` to `personal`. Add that file to
  the commit.

### Task 5: Scope state: latch, entry, directories and carry

**Files:**
- Create: `src/scope.ts`
- Modify:
  - `src/constants.ts`, :57-63: add the new names.
  - `src/owners.ts`: `EnvLatch` :52-57, the slot :59-69 and `isSlot` :73-84. New fields are
    optional and created lazily, and the slot version is not bumped.
  - `index.ts`, :44-46: latch the scope beside `latchEnvPin`.
  - `src/router.ts`:
    - `scopeOf(ctx)` beside `pinOf` at :134-143;
    - `contextFor` at :147-158 uses `scopeOf`;
    - `prepare` at :173-180 refuses;
    - at `start`, after `carry` at :300, take the scope handoff and apply the directory rule
      before `guards.enforce` at :316;
    - at `shutdown` (:346-356), leave the scope handoff.
  - `src/errors.ts`: the scope refusals and notices.
  - `test/support/pi.ts`: add `SessionOptions.cwd`, replacing the fixed `/nonexistent` at :277-280.
- Test: `test/scope.test.ts`, `test/owners.test.ts`

**Interfaces:**
- Consumes: Task 3's `Scope`, `RosterV2` and `scopeSection`.
- Produces:
  ```ts
  // src/constants.ts
  export const SCOPE_ENTRY = "smart-router.scope";
  export const LEVEL_ENTRY = "smart-router.level";
  export const ENV_SCOPE = "PI_SMART_ROUTER_SCOPE";
  export const LEVEL_KEY = "smart-router-level";
  // src/scope.ts
  export interface ScopeEntryData { readonly v: 1; readonly scope: Scope; readonly by: "command" | "directory" | "carried"; readonly at: number }
  export type ScopeState =
    | { readonly kind: "ok"; readonly scope: Scope; readonly source: "latch" | "entry" | "default" }
    | { readonly kind: "unreadable"; readonly reason: string };
  export function parseScopeEntry(entry: unknown): ScopeEntryData | undefined;      // strict keys; undefined = malformed
  export function readScope(sessionManager: unknown, latched: boolean): ScopeState;  // mirrors readPin (src/pin.ts:70)
  export function scopeEntry(scope: Scope, by: ScopeEntryData["by"], at: number): ScopeEntryData;
  export function underDirectory(cwd: string, directories: readonly string[]): boolean;
  // src/owners.ts
  export function latchEnvScope(slot: Slot, value: string | undefined): void;        // "work" latches for the life of the process
  export function scopeLatched(slot: Slot): boolean;
  export function leaveScopeHandoff(slot: Slot, file: string, scope: Scope): void;  // its own map, never slot.handoffs
  export function takeScopeHandoff(slot: Slot, file: string): Scope | undefined;
  // src/router.ts, inside build() beside pinOf
  const scopeOf: (ctx: ExtensionContext) => ScopeState;
  ```
  - **Refusal.** `prepare()` makes `smart-router/auto` refuse, with "Nothing was sent", in these
    cases:
    - the scope is unreadable;
    - a version 1 roster with work scope;
    - a version 2 roster without the session's scope section.
  - **Directory rule.** At every session start (new, resumed, forked or reloaded) whose scope
    source is `default`, with a version 2 roster whose work directories contain `ctx.cwd`
    (`underDirectory`), append `scopeEntry("work", "directory", now)` and notify
    `pi-smart-router: this session is in work scope because ${cwd} is under ${dir}.` Resumed
    sessions move too. Otherwise a session begun before its directory was listed would keep sending
    work to personal accounts.
  - **Carry.** At `session_shutdown` with reason `new` or `fork` and a `targetSessionFile`, leave
    a handoff when the scope came from an entry or the latch. At the next `session_start`, append
    `scopeEntry(scope, "carried", now)` and notify.

- [ ] **Step 1: Write the failing tests.**
  - **`test/scope.test.ts`:**
    - `parseScopeEntry` refuses unknown keys, a wrong `v`, and a scope that is neither personal
      nor work.
    - `readScope` precedence:
      - when latched, a personal entry gives `{scope:"work", source:"latch"}`;
      - with no entry, it gives `{scope:"personal", source:"default"}`;
      - a malformed entry gives `unreadable`;
      - a session manager without the bounded readers gives `unreadable`.
    - `underDirectory`:
      - `("/x/work", ["/x/work"])` and `("/x/work/a", ["/x/work"])` are true;
      - `("/x/workshop", ["/x/work"])` is false;
      - `("/x/work/", ["/x/work"])` is true.
    - Handoffs, modelled on `pin.test.ts:167-276`:
      - after `scope work`, `/new` and a fork each record a carried work entry;
      - a personal default leaves no handoff;
      - `processSlot().handoffs.size` is unchanged by scope handoffs.
    - Directory rule (cwd from `SessionOptions.cwd`):
      - a new session under `/Users/johnw/src/positron/app` with the Hera version 2 roster starts
        in work scope, with the notice;
      - a resumed session there that has turns but no scope entry moves to work scope;
      - one there with a personal entry stays personal.
    - A version 1 roster with `PI_SMART_ROUTER_SCOPE=work` makes `auto` refuse, and the message
      includes "Nothing was sent".
  - **`test/owners.test.ts`**, modelled on the `latchEnvPin` tests at :70-117:
    - `latchEnvScope(slot, "work")` latches, while `"1"` and `"Work"` do not;
    - the latch survives a second `latchEnvScope(slot, undefined)`;
    - a slot without the new fields still passes `isSlot`.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/scope.test.ts test/owners.test.ts`
- [ ] **Step 3: Implement the interfaces and the router wiring.** Copy `pin.ts`'s fail-closed
  reading, through `getLatestCustomEntry(SCOPE_ENTRY, { scope: "all" })` with try/catch, as
  `pinOf` does.
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run check`.
- [ ] **Step 5: Commit.**
  `git add src/scope.ts src/constants.ts src/owners.ts index.ts src/router.ts src/errors.ts test/support/pi.ts test/scope.test.ts test/owners.test.ts && git commit -S -m "Give each session a scope: latch, entry, work directories, carried into forks and /new"`

**Controller rulings (pre-flight, binding; they amend this task):**
- When the scope is unreadable, `contextFor` resolves in `work` scope, the narrower one, while
  `prepare()` refuses `smart-router/auto` as above.

### Task 6: The version 2 planner

**Files:**
- Modify:
  - `src/decide.ts`: `PlanInput` and `Plan` at :98-121, and the body after the local-only branch
    at :145-149, which stays first.
  - `src/route.ts`: `takePlan` at :164-169 also requires `plan.level?.scope === rc.scope` for
    version 2. Add an optional `level: PlanLevel` to `HistoryEntry` (:50-62), set by conditional
    spread in `routeOwned` (:235-245) so that version 1 entries keep their exact shape.
- Test: `test/decide.test.ts`, `test/route.test.ts`

**Interfaces:**
- Consumes:
  - Task 1's `Tier`, `tierRank`, `tierAbove`, `higherTier`, `keywordTier` and `riskyTrigger`;
  - Task 2's `JevOutcome`;
  - Tasks 3 and 4's `scopeSection` and `rc.scope`.
- Produces:
  ```ts
  // src/decide.ts
  export interface LevelInput { readonly tag?: Tier; readonly jev?: JevOutcome }
  export interface PlanInput { /* existing fields */ readonly level?: LevelInput }
  export type LevelSource = "tag" | "jev" | "keyword" | "floor";
  export interface PlanLevel {
    readonly scope: Scope; readonly tier: Tier; readonly asked: Tier; readonly source: LevelSource;
    readonly trigger?: RiskyTrigger; readonly steppedUp: boolean; readonly returnedToFirst: boolean;
    readonly jev?: JevOutcome;   // the outcome an untagged run waited for
  }
  export interface Plan { /* existing fields */ readonly level?: PlanLevel }
  ```
- **The version 2 algorithm.** Only this sequence is fixed; the builder writes the code.
  1. Take `section = scopeSection(roster, rc.scope)`. Without one, refuse.
  2. Set `asked` to the first of these that applies: the tag; Jev's `tier` when
     `jev.kind === "answer"`; otherwise `keywordTier(classify(text).signal)`. Record the matching
     source.
  3. If the run is untagged, `riskyTrigger(text)` matches, and `asked` ranks below high, set the
     tier to `high`, the source to `floor`, and record the trigger.
  4. **A tagged run** skips the hold rules. From the tier upward, use the tier's level role and
     `pickInRole` with no `prefer`. Stop at the first tier whose pick is ok and whose model `fits`.
     Set `steppedUp` if that tier is above the tagged one. If no tier works, refuse.
  5. **An untagged run:**
     - its sticky tier is the tier whose level role holds `last.ref` in this scope;
     - it holds `hold:sticky` when its tier ranks below the sticky tier and `stickyIdleMinutes`
       have not passed;
     - the existing `hold:fit` and `reopen:idle` rules apply, but compared by tier rank;
     - then the same upward pick as step 4, which also steps up for unavailability.
  6. Set `returnedToFirst` when `last.ref` is in the chosen role but differs from `choice.ref`.
     Version 1 keeps `prefer = last.ref`; version 2 passes `prefer = undefined`.
  7. **Codes:**
     - the source (`tag`, `jev`, `keyword` or `floor`) for a direct pick;
     - `hold:sticky`, `hold:fit` or `reopen:idle` when a hold rule applied;
     - `step-up` when the pick moved up a tier.

- [ ] **Step 1: Write the failing tests** in `test/decide.test.ts`, in a new group `v2 levels`,
  using a context built from the Hera version 2 fixture:

  | Case | Expected |
  |------|----------|
  | `"What is the capital of France?"`, untagged, no Jev | `openai-codex-2/gpt-6.1-terra`; level `{tier:"medium", source:"keyword"}` |
  | Jev answer with `tier:"high"` and `choice:"medium"` | `openai-codex-2/gpt-6.1-sol` (the tier is used, not the choice) |
  | `"force push the branch"` with a Jev answer of low | tier `high`, source `floor`, trigger `destructive-git` |
  | the same text, tagged low | `openai-codex-2/gpt-6-luna`, source `tag` |
  | last response from `openai-codex-2/gpt-6-astra` one minute ago, tagged low | luna, code `tag` (no hold) |
  | the same, untagged, with a Jev answer of low | astra, code `hold:sticky` |
  | a catalog where low's only available candidate has a 32k window, last usage 100k tokens, tagged low | medium's first candidate, `steppedUp: true`, code `step-up` |
  | `last.ref = openrouter/z-ai/glm-5.3`, sol available, untagged high | sol, `returnedToFirst: true` |
  | sol cooled | glm-5.3 |
  | work scope, keyword default | `openai-codex-3/gpt-6.1-terra` |

  Add a property loop: 200 random texts and tiers in work scope never choose a provider other than
  `openai-codex-3`.

  In `test/route.test.ts`, a version 2 history entry carries `level`, while the version 1 entry
  still deepEquals the shape at :70-80.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/decide.test.ts test/route.test.ts`
- [ ] **Step 3: Implement the algorithm above.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run check`.
  The version 1 prefer test at `decide.test.ts:126-132` and the work-alias test at :507-519 must
  still pass unchanged.
- [ ] **Step 5: Commit.**
  `git add src/decide.ts src/route.ts test/decide.test.ts test/route.test.ts && git commit -S -m "Plan version 2 runs by tier: tags, Jev, keywords, the floor and first-available candidates"`

**Controller rulings (pre-flight, binding; they amend this task):**
- The version 2 branch replaces Task 3's interim `v2-unplanned` refusal.
- The 200-case property loop uses a fixed-seed generator, and its failure message names the seed
  and the case.

### Task 7: The router input: tags, Jev and the pending record

**Files:**
- Modify:
  - `src/router.ts`: the input handler at :433-442 becomes async; `plan` at :323-332 takes the
    stripped text and a `LevelInput`.
  - `src/route.ts`: add `SessionRecord.pendingLevel` and `lastInput` (:66-76), cleared at the idle
    input reset (router.ts:437) and the custom-run reset (:445).
  - `src/errors.ts`: the tag notices.
  - `test/support/pi.ts`:
    - give `FakeRuntime.registry` (:125-139) a `findOfType` and a scriptable `classify` with a
      call log;
    - make `FakeHost.emit` (:453-457) chain `transform` results and stop at `handled`, as Pi's
      `runner.js:1208-1243` does.
- Test: `test/router-levels.test.ts`, a new unit suite that must not import `test/support/host.ts`.

**Interfaces:**
- Consumes:
  - Task 1's `parseTag` and `tierLabel`;
  - Task 2's `askJev`, `buildContext`, `recentMessages`, `JevOutcome` and `ClassifierRegistry`;
  - Task 5's `scopeOf`;
  - Task 6's `LevelInput` and `PlanLevel`.
- Produces:
  ```ts
  // src/route.ts
  export interface PendingLevel {
    readonly token: number; readonly level: PlanLevel; readonly keyword: Classification;
    readonly at: number; jev: JevOutcome | "pending" | undefined;  // a tagged run's opinion arrives later
  }
  export interface SessionRecord { /* existing fields */ pendingLevel: PendingLevel | undefined; lastInput: { readonly text: string; readonly level: LevelInput } | undefined }
  ```
- **The handler, in order:**
  1. Compute `tagged = parseTag(event.text)` first.
  2. If `guards.input(ctx)` vetoes, return the veto.
  3. A tag-only message notifies and returns `{ action: "handled" }`.
  4. A tagged message that is not an idle `smart-router/auto` input in an unpinned session, or
     whose roster is version 1, notifies "no effect" and returns the transform.
  5. **Jev.** Ask Jev for an eligible input: idle, `auto`, unpinned, a readable scope, and a
     version 2 roster with a classifier. Context comes from
     `boundedHistory(sm).getRecentActiveEntries({ type: "message", limit: caps.messages * 4 })`
     through `recentMessages`. The criteria are the session scope's `levels[tier].describe`.
     - An untagged input waits for the answer.
     - A tagged input does not wait. Its promise has a terminal `.catch`, and it writes
       `pendingLevel.jev` only while `pendingLevel.token` is unchanged.
  6. **Reuse.** An input with `event.source === "extension"` whose text equals `lastInput.text`
     reuses `lastInput.level` and makes no Jev call.
  7. **Plan.** After any wait, rebuild `rc`. Plan only if this input's token is still the latest.
     Set `pendingLevel` and `lastInput`. When `plan.level.steppedUp`, notify
     `pi-smart-router: no ${ASKED} model can take this run, so it goes to ${TIER} (${modelId}).`
  8. **Return** the transform for a tagged input, otherwise `undefined`. Everything after step 1
     sits in `try`/`catch`, so the transform is always returned.

- [ ] **Step 1: Write the failing tests** in `test/router-levels.test.ts`. Each one starts the
  router with the Hera version 2 roster and `auto` selected, unless stated otherwise:

  | Case | Expected |
  |------|----------|
  | `"go ahead #high"` | emit result deepEquals `[{action:"transform", text:"go ahead"}]`; the next `route("auto", user)` picks `openai-codex-2/gpt-6.1-sol`; `classify` called once and not awaited (a never-resolving fake still lets `emit` return) |
  | untagged `"rename foo to bar"`, fake answer `{choice:"low", probabilities:{low:.8, medium:.1, high:.05, super:.05}}` | route picks `openai-codex-2/gpt-6-luna`; options deepEqual `{timeoutMs:1000, maxRetries:0}` |
  | fake returns `stopReason:"error"` | route picks `openai-codex-2/gpt-6.1-terra` (keyword default) |
  | pinned session, `"x #low"` | zero `classify` calls; a transform; a notice matching `/no effect/` |
  | `"x #low"` with `streamingBehavior:"steer"` during a run | zero calls; a transform; a notice; the run's plan unchanged |
  | `"#low"` | `[{action:"handled"}]`; a notice; no run planned |
  | a tagged input, then an `extension` input with the stripped text | plan tier `high`; no second `classify` call |
  | a slow `classify` while the session is replaced by `/new` | `emit` resolves to the transform without throwing; the new session's `pendingLevel` is undefined |
  | a version 1 roster, `"x #high"` | a transform; a `/version 2 roster/` notice; zero calls |
  | every LOW candidate unavailable, `"x #low"` | medium's first candidate; the step-up notice, exactly |
  | glm-5.3 answered a HIGH run while sol was cooled (cool it as the existing cooldown tests do); `now` then moves past `cooldownMinutes` | the next HIGH run picks sol, with `returnedToFirst: true` |
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/router-levels.test.ts`
- [ ] **Step 3: Implement the handler and the harness changes.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run check`.
  `route.test.ts`, `guards.test.ts` and `lifecycle.test.ts` must still pass. The handler set is
  unchanged.
- [ ] **Step 5: Commit.**
  `git add src/router.ts src/route.ts src/errors.ts test/support/pi.ts test/router-levels.test.ts && git commit -S -m "Strip tags and ask Jev at input; plan with the chosen tier"`

**Controller rulings (pre-flight, binding; they amend this task):**
- The `/new` row becomes two tests:
  - (a) A tagged input whose `classify` never settles returns its transform at once. When that
    `classify` settles after `/new`, the new session's `pendingLevel` is untouched.
  - (b) An untagged input whose `classify` is still pending when `/new` arrives resolves without
    throwing and plans nothing, and the new session's `pendingLevel` stays undefined.

### Task 8: The work selection guard

**Files:**
- Modify:
  - `src/guards.ts`:
    - `GuardOptions` (:102-108) gains `scopeOf`;
    - the policy selection: pin first, then work scope;
    - a work predicate beside `localModel` (:199-202);
    - add `switchToAuto`;
    - `modelSelect` (:299-328) and `enforce` (:381-397) use the active policy;
    - work-worded notices that leave the pin-worded texts at :131-144 unchanged.
  - `src/router.ts`, :145: pass `scopeOf`.
  - `src/errors.ts`.
- Test: `test/guards.test.ts`

**Interfaces:**
- Consumes: Task 5's `ScopeState` and `scopeOf`; Task 3's `isWorkBound`; Task 4's
  `isCodexProvider`.
- Produces:
  ```ts
  export interface GuardOptions { /* existing fields */ readonly scopeOf: (ctx: ExtensionContext) => ScopeState }
  export interface Guards { /* existing members */ switchToAuto(ctx: ExtensionContext): Promise<boolean> }
  ```
  In an unpinned work-scope session, an allowed selection is either `smart-router/auto` or a model
  whose provider passes `isCodexProvider` and is work-bound. A disallowed selection is reverted to
  `smart-router/auto` with the notice
  `pi-smart-router: this session is in work scope, so <model> was not kept, and the selection is smart-router/auto again.`
  A second disallowed choice within `REVERT_WINDOW_MS` locks, as the pin does. While pinned, only
  the pin's policy applies.

- [ ] **Step 1: Write the failing tests** in `test/guards.test.ts`, in a group `work guard`
  (Hera version 2, work scope):
  - choosing `KIMI` returns the selection to `smart-router/auto` with the notice above;
  - `WORK_SOL` is kept;
  - `SOL` (`openai-codex-2`) is reverted;
  - a pinned work session follows the pin's rules (smart-router/local is allowed and `auto` is
    refused);
  - two disallowed choices within the window lock;
  - resuming a work session whose selection is `KIMI` switches it to `auto` at start.
- [ ] **Step 2: Run the tests and confirm they fail.** `node test/run.mjs test/guards.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run check`.
- [ ] **Step 5: Commit.**
  `git add src/guards.ts src/router.ts src/errors.ts test/guards.test.ts && git commit -S -m "Guard the selection in work scope, below the pin"`

**Controller rulings (pre-flight, binding; they amend this task):**
- `isCodexProvider` comes from Task 3 (`src/accounts.ts`), not Task 4.
- John ruled that the guard applies in work scope only. There is no personal-scope guard.

### Task 9: Records, corrections, history, the footer and commands

**Files:**
- Create: `src/records.ts`
- Modify:
  - `src/router.ts`: in `agent_settled` (:453-459), append the record before `runPick` is
    cleared, then clear `pendingLevel`. Set the footer under `LEVEL_KEY` when a run is planned,
    and again at the assistant `message_end` (:338-344) with the model that answered.
  - `src/commands.ts`:
    - `run` at :332-346 gains the `scope` and `was` branches;
    - `USAGE` at :59 and the description at :350;
    - the status lines in `statusText` (:215-235);
    - the Jev item in `egress` (:91-98), for version 2 rosters with a classifier, unpinned;
    - `describeEntry` (:118-121) for version 2 entries.
  - `src/errors.ts`.
- Test: `test/commands.test.ts`, `test/router-levels.test.ts`, `test/scope.test.ts`

**Interfaces:**
- Consumes: Task 7's `PendingLevel`; Task 8's `switchToAuto`; Task 5's `readScope`,
  `scopeEntry` and `scopeLatched`.
- Produces:
  ```ts
  // src/records.ts
  export type JevRecord =
    | { readonly model: string; readonly choice: Tier; readonly probabilities: Readonly<Record<Tier, number>>; readonly confidence: number; readonly ms: number }
    | { readonly model: string; readonly failure: JevFailure; readonly ms: number }
    | { readonly late: true };
  export interface LevelRecord {
    readonly v: 1; readonly at: number; readonly scope: Scope; readonly source: LevelSource | "correction"; readonly tier: Tier;
    readonly asked?: Tier; readonly tag?: Tier; readonly trigger?: RiskyTrigger; readonly keyword?: { readonly signal: Signal; readonly reason: string };
    readonly jev?: JevRecord; readonly ref?: string; readonly steppedUp?: true; readonly returnedToFirst?: true; readonly aborted?: true; readonly refers?: number;
  }
  export function levelRecord(pending: PendingLevel, answeringRef: string | undefined, aborted: boolean): LevelRecord;
  export function correctionRecord(previous: LevelRecord, tier: Tier, at: number): LevelRecord;
  export function levelNote(level: PlanLevel): string;               // "jev 82%", "tag", "floor", "keywords; jev timeout", "keywords"
  export function footerText(level: PlanLevel, modelId: string): string;
  ```
- **Exact copy:**
  - `USAGE`:
    `Usage: /smart-router [status] | history [n] | local on|off|status | scope [work|personal|status] | was low|medium|high|super | reload`
  - Footer: `${scope} ${TIER} → ${modelId} (${levelNote(level)})`. `levelNote` gives one of:
    - `jev NN%`, where NN is the chosen tier's probability, rounded;
    - `tag`;
    - `floor`;
    - `keywords; jev ${failure}`;
    - `keywords` when there is no classifier.
  - Version 2 history lines append ` [${scope} ${TIER} (${levelNote(level)})]` to today's line.
  - `scope work` appends the entry. If the selection is then outside the work policy, it calls
    `guards.switchToAuto(ctx)`.
  - Scope answer: `pi-smart-router: scope ${scope} (${source}).`
  - Work → personal is asked through `ctx.ui.select` with the options
    `["Keep this session in work scope", "Move it to personal scope (earlier turns are work content)"]`;
    only the second option changes the scope.
  - Under the latch, `scope personal` answers
    `pi-smart-router: PI_SMART_ROUTER_SCOPE pins every session of this process to work scope, so this one cannot be moved to personal.`
  - `was <tier>` answers `pi-smart-router: recorded that the last run should have been ${TIER}.`
    With no prior record it answers `pi-smart-router: no routed run to correct in this session yet.`
  - Status, for version 2 only:
    - a `Scope:` line;
    - one `Levels (${scope}):` line per scope present, listing `TIER → candidates with verdicts`;
    - `Classifier: ${model}, ${timeoutMs} ms, close call ${closeCall}`.

    Version 1 status text is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `test/commands.test.ts`:
    - `USAGE` is exact;
    - `scope work` then `scope status` answers `pi-smart-router: scope work (entry).`;
    - `scope personal` with scripted `dialogKeys` (Enter) keeps work scope, and selecting the
      second option moves the session to personal;
    - `scope personal` under the latch answers the latch text exactly;
    - `was high` after a routed run appends a record with `{source:"correction", tier:"high", refers: previous.at}`;
    - `was high` with no record answers the exact text;
    - the version 2 status text for the Hera fixture in personal scope is exact;
    - the version 1 status test (:58-86) and the `EGRESS` line (:39) are unchanged.
  - `test/router-levels.test.ts`:
    - after a routed run and `agent_settled({aborted:false})`, exactly one `smart-router.level`
      entry exists, with `ref` equal to the answering model;
    - an aborted run's record has `aborted: true`;
    - a tagged run whose Jev opinion is still pending at settle records `jev: { late: true }`;
    - a physical selection records nothing;
    - the footer reads `personal HIGH → gpt-6.1-sol (tag)` after `"x #high"`, and
      `personal MEDIUM → gpt-6.1-terra (keywords; jev timeout)` after a Jev timeout;
    - `scope work` while `KIMI` is selected switches the selection to `smart-router/auto`.
- [ ] **Step 2: Run the tests and confirm they fail.**
  `node test/run.mjs test/commands.test.ts test/router-levels.test.ts test/scope.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests and confirm they pass.** Run the same command, then `npm run check`.
  The lifecycle test still sees one `registerCommand` and the same handlers.
- [ ] **Step 5: Commit.**
  `git add src/records.ts src/router.ts src/commands.ts src/errors.ts test/commands.test.ts test/router-levels.test.ts test/scope.test.ts && git commit -S -m "Record each routed run, add scope and was commands, show the tier in the footer"`

**Controller rulings (pre-flight, binding; they amend this task):**
- When the latest level record is itself a correction, `/smart-router was` refers to the run that
  correction named (its `refers`), not to the correction.

### Task 10: Declared limits and the behaviour suite

**Files:**
- Modify:
  - `src/router.ts`: `computeLimits` (:184-201) for version 2 takes the smallest context window
    among the available candidates of every level role in both scopes, plus the local role. The
    limits stay per process.
  - `test/support/host.ts`:
    - register a fake classifier provider `jev-fake` with one `type: "classifier"` model `jev`
      through `createProvider({…, classifiers: {"jev-fake-api": {classify}}})`, after the faux
      providers (:563-566). Its `classify` honours `options.timeoutMs` and `options.signal` and
      logs every call;
    - let `Faux` serve several model ids;
    - give the select dialog a scripted answer queue (:325-378);
    - add `status(key)`;
    - make `resetProcess` (:463-468) delete `ENV_SCOPE`;
    - extend `RosterJson` (:401-411) for version 2.
  - `test/behaviour.test.ts`: the new scenarios.
- Test: sandboxed only.

**Interfaces:**
- Consumes: everything above.
- Produces: the behaviour scenarios. Their rosters point the classifier at `jev-fake/jev`, never
  at `openrouter`.

- [ ] **Step 1: Write the failing scenarios**, using `World` as the existing scenarios do. Each
  covers one item of the spec's behaviour-suite list:
  - **`L1 a tag routes at once past hold:sticky, never reaches the payload, and survives a resend`**:
    the payload's last user text has no `#high`. An `extension` resend of the stripped text routes
    to the same tier, with no second classifier call.
  - **`L2 a tagged level steps up, with a notice, when the conversation does not fit`**: LOW's fake
    model declares a 32k window.
  - **`L3 untagged runs follow Jev; a close call goes higher; failure, refusal and timeout fall back to keywords`**:
    medium .45 and high .40 routes to high. An error result and a wait past `timeoutMs` both route
    to the keyword tier, the timeout within about 1.5 s.
  - **`L4 no classifier call when pinned, on local, with PI_SMART_ROUTER_LOCAL_ONLY, for a steer, or without a classifier`**:
    the call log stays empty in every case.
  - **`L5 scope: the latch, the entry carried into /new and a fork, resume, directories, and confirmation for work to personal`**.
  - **`L6 the work guard switches a hand-picked OpenRouter model back, and work runs reach only the work account`**.
  - **`L7 one smart-router.level record per run; /smart-router was appends a correction`**.
  - **`L8 the risky floor raises a Jev LOW to HIGH, and a tag overrides it`**.
  - **`L9 a version 1 roster keeps its history and status text byte-identical`**: reuse the
    existing scenarios' history and status expectations.

  The return to a Codex candidate after a cooldown is tested in Task 7's unit suite instead,
  because the behaviour suite runs on the real clock and `cooldownMinutes` is at least 1.
- [ ] **Step 2: Run the scenarios and confirm they fail.**
  `node test/sandbox.mjs test/behaviour.test.ts`
- [ ] **Step 3: Implement the harness changes and `computeLimits`.**
- [ ] **Step 4: Run and confirm everything passes.** Run `npm run check:sandbox`, which runs every
  suite, sandboxed, plus `pack:check`.
- [ ] **Step 5: Commit.**
  `git add src/router.ts test/support/host.ts test/behaviour.test.ts && git commit -S -m "Declare limits across scopes; add behaviour scenarios for tiers, scope and records"`

### Task 11: Docs, scan hardening and release

**Files:**
- Modify:
  - `README.md`:
    - :8, the version;
    - :33-40, restate the invariant;
    - :174 and :213-214, version 2 and the work labels;
    - :287-290, privacy;
    - the commands table at :351-358;
    - :407-421;
    - a new roster version 2 section with the Hera example;
    - a scope section covering the latch, entries, directories and the work guard;
    - a Jev section covering what it reads, redaction, the 1 s limit and close calls;
    - a training section covering records, `was`, and agent review on request.
  - `CHANGELOG.md`: a `[1.3.0-jw.2]` entry with Added, Changed and Security sections.
  - `AGENTS.md`, :10-22: the runtime rules, restated.
  - `test/scan.test.ts`, :30-43: add `/\bAbortSignal\.timeout\b/` and `/\bsetImmediate\b/` to
    `FORBIDDEN`, with self-test lines.
  - The version: `package.json:3`, `package-lock.json:3,9`, `test/package.test.ts:39,106`.
- Test: `npm run check`, `npm run check:sandbox`, and the mutant check.

- [ ] **Step 1: Restate the invariant and write the docs.** The exact invariant sentence for the
  README and the CHANGELOG Security section:
  "The router opens no network connection of its own and sets no timer. When a version 2 roster
  has a classifier, it asks Pi's model registry for one classifier request per routed run on
  smart-router/auto, with a per-attempt timeout and no retries. It never does so under the pin, on
  smart-router/local, for a steer or follow-up, or without a classifier."
- [ ] **Step 2: Harden the scan.** Add the two patterns and their self-tests, then run
  `node test/run.mjs test/scan.test.ts` and expect PASS.
- [ ] **Step 3: Bump the version** to `1.3.0-jw.2` in every place listed above. Run
  `node test/run.mjs test/package.test.ts` and expect PASS.
- [ ] **Step 4: Run the full gates.** Run `npm run check` and `npm run check:sandbox`, and expect
  both to exit 0 with an empty network log.
- [ ] **Step 5: Run the mutant check.**
  1. In a copy of the worktree, not the shared checkout, first run a passing control.
  2. Apply 20 or more single mutations across `src/tiers.ts`, `src/tags.ts`, `src/jev.ts`,
     `src/scope.ts`, `src/records.ts` and the version 2 branch of `src/decide.ts`. For example:
     flip the close-call comparison, drop the floor, accept `#high.` as a tag, skip the pin check
     before Jev, prefer the last responder in version 2, or carry the scope under the pin's key.
  3. Run `npm run check` for each, compiling with `node_modules/.bin/tsc`.
  4. Report each mutant as caught, missed, skipped or broken. Any missed mutant needs a test before
     release.
- [ ] **Step 6: Commit.**
  `git add README.md CHANGELOG.md AGENTS.md test/scan.test.ts package.json package-lock.json test/package.test.ts && git commit -S -m "Document four Jev-classified levels and scope; release 1.3.0-jw.2"`
- [ ] **Step 7: Publish or stop.** John authorized the push and the tag on 2026-11-09, but only if
  all of these hold:
  - `npm run check` passes;
  - `npm run check:sandbox` passes;
  - the mutant check misses no mutant;
  - the final whole-branch review leaves no open finding;
  - a fess audit of the branch and its claims is clean.

  If they all hold:
  1. Push `feat/jev-levels` to `main` on GitHub, fast-forward only.
  2. Push the signed tag `v1.3.0-jw.2`.
  3. In `~/src/fork/pi-smart-router`, remove the untracked copies of the spec and this plan. Remove
     each one only if its `git hash-object` blob appears in that path's history on the branch;
     otherwise stop and report.
  4. Then run `git fetch` and `git merge --ff-only origin/main` there.

  If any check fails, stop and report it with its evidence. Either way, report every check's
  result. Rollout is separate units, each with John's OK, per the spec's Rollout section:
  - nix packaging and the `shared-work-pi` latch;
  - a stable model id for Nyx's Qwen;
  - confirming the account pi-warden uses at work;
  - the version 2 rosters;
  - measuring Jev's latency.
