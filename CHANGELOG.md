# Changelog

All notable changes to this fork are recorded here, in the form of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A version is `<upstream base>-jw.<n>`:
the base is the latest upstream release merged into the fork's history, and `jw.<n>` counts the
fork's releases on that base. Releases are signed tags; nothing is published to npm.

## [1.4.0-jw.4] - 2026-11-17

A scope's fallback chain, a roster checker, and Jev's prompts as files John edits. On 2026-11-17
John specified the routing he wants ("smart-router/auto on personal should also use: astra, sol,
terra, luna -- based on difficulty of the task -- and then when tokens run out there it should use
OpenRouter GLM-5.3-Flash and Qwen3.8, with a final fallback to GLM-5.3-Flash on Hera, Qwen3.8 on
Nyx with a fallback to Qwen3.8 on Hera. smart-router/local only uses those last three."), and asked
that "these decisions about which models to use ... should be very easy to change and reconfigure",
with Jev's instructions as "a set of prompts ... that is also very easy to modify".

Upgrading from 1.4.0-jw.3: no roster change is needed, and a roster that uses none of the new
fields parses to the same value, routes the same and sends Jev the same request, byte for byte.
Three things are visible without a roster change: `/smart-router status` has one more line, for
the prompt sources; the usage text names `check`; and a run's record may carry `fallback` or the
Jev failure `prompt`, both only under the new fields.

### Added

- **`scopes.<scope>.fallback`**, a list of roles: the scope's fallback chain. On
  `smart-router/auto`, outside the pin, a level tries its own models and then each chain role's
  models, in the order written. One chain serves every level of its scope, and its roles are no
  level's, so a model still sits in exactly one role.
  - A level takes the chain before it passes its run up, so the run keeps its level: its record's
    `tier` does not change, and the record carries `fallback` when a chain model answered.
  - A chain model holds no level, and each new run starts from its level's first model, so a
    session returns to the level's own model as soon as that can take requests again, as version
    1's fallback role returned to its primary. A retry after a usage-limit or authentication error
    goes on through the chain and never back to an earlier role or to the level.
  - The chain is the declaring scope's alone. A personal chain takes no work-bound model, and a
    work chain takes only work-bound Codex models, for which the built-in `openai-codex-3/*`
    exclusion is lifted as for a work level. A work scope without the field behaves as before.
  - A chain may name the local role, which is how `smart-router/auto` reaches the local models.
    `smart-router/local` never uses a chain.
  - A run planned onto a chain model shows a notice and `; fallback` in the footer; status lists
    each scope's chain with its models' verdicts and says when the last request went to one; a
    refusal names the chain's roles as fallbacks.
- **`/smart-router check`** and the standalone **`node src/check-cli.ts <roster.json>`**: the
  roster read back with the router's own parser. For each selection and scope, the models in the
  order tried, the fallback chain, what the pin leaves, the local set, the source of each of Jev's
  prompts and the account bindings; or the first error with its place. The standalone checker
  imports nothing of Pi's and needs no session and no credentials; it exits 0, 1 or 2.
- **Jev's prompts are editable.** `classifier.instructions` (inline) or
  `classifier.instructionsFile` (a file's name) replaces the built-in question, and a level takes
  `describeFile` in place of `describe`. Prompt files are plain text or Markdown in
  `<agentDir>/smart-router/`, read with the roster's safe reader, refreshed with the roster, with
  HTML comments left out of what is sent. Status shows each prompt's source.
- README: "A fallback chain", with John's routing as the worked example and the note that a
  fallback sends the conversation to another vendor and to LAN models; "Jev's prompts"; and
  "Changing the routing", with the commonest edits as before and after, and "Checking a roster".

### Changed

- **A pinned session on `smart-router/auto`**, in a scope whose fallback chain names the local
  role, now routes to the local role's models, in the role's order and inside the pin's policy. It
  was refused, and still is in every other scope, with the text that names `smart-router/local`.
  The chain's cloud roles are never used under the pin.
- `smart-router/auto` declares the smallest context window and output budget among the first
  available model of every role it reaches, which now includes each fallback chain's roles.
- A prompt file that cannot be used (missing, unsafe, empty, too long, an unclosed comment, a
  `{{placeholder}}` or a `TODO` line) stops no route: Jev is not asked in the scopes that need it,
  the keywords decide, and the record and footer say `jev prompt`.
- AGENTS.md: the runtime reads the prompt files too, a prompt reaches nothing but Jev, and
  `src/check-cli.ts` is not runtime code.
- The package version is `1.4.0-jw.4`.

### Unchanged

- An invalid, missing or unsafe roster still makes both models refuse every request, with no last
  valid copy kept in use: such a copy would keep sending to a model or account an edit had just
  removed. The checker is the remedy.
- `smart-router/local` routes only to the local role, in the role's order, never to a cloud model,
  in every scope, pinned or not.
- A work session on `smart-router/auto` reaches only the work-bound Codex account. No chain can
  name a personal-account, OpenRouter or local model for it.
- Jev is asked once per routed run, never under the pin, on `smart-router/local`, for a steer or a
  follow-up. Its request has one question whose choices are exactly the four levels; no prompt can
  add a label, name a model, change the scope or lift the pin.
- A model picked by hand is never changed, reverted, refused or locked.
- A local server that is down is not passed over: only a model Pi's catalog cannot offer, or one
  cooling after a usage-limit or authentication error, is. Local-role models are never cooled.

## [1.4.0-jw.3] - 2026-11-17

`smart-router/local` routes in a session whose scope cannot be read, without the pin. On 2026-11-17
John decided "Let local route there too": selecting `smart-router/local` means local routing in
every scope state, personal, work or unreadable, pinned or not, so it has no scope refusal left.

Upgrading from 1.4.0-jw.2: no roster change is needed. One thing behaves differently: in a session
that is not pinned and whose scope cannot be read (a malformed `smart-router.scope` entry, a custom
message of that type, or scope entries whose read fails), `smart-router/local` now sends the
conversation to the roster's local models, where it sent nothing before.

### Changed

- In a session whose scope cannot be read, outside the pin, `smart-router/local` routes to the
  roster's local role: the run's first request, continuations, retries, compactions and summaries,
  and requests of sessions that share the route. It plans the run and tells pi-cache-optimizer of
  its pick as it does in either scope. It did refuse: "smart-router/local: this session's scope
  cannot be read (...). Nothing was sent. Record it again with /smart-router scope work or
  /smart-router scope personal, or choose a work Codex model with /model." That refusal is removed;
  the text remains `smart-router/auto`'s.
- Such a run resolves in work scope, the narrower one, as a pinned session's already did. Its
  requests are local-only and carry no account, and every pick still passes the check that it is
  in the local role and inside the roster's local policy. Routing it records neither a scope nor a
  pin, so the scope stays unreadable until a `/smart-router scope` command records one.
- This holds whatever scopes the roster serves, under a version 1 roster too.
- `/smart-router local off` on `smart-router/local` in a session whose scope cannot be read now
  says "smart-router/local routes to the local models without the pin in every scope, so its next
  requests go to them. Its scope cannot be read (...), so smart-router/auto refuses its requests
  until /smart-router scope work or /smart-router scope personal records it again." It did say that
  `smart-router/local` refuses its requests, as `smart-router/auto` does.
- The package version is `1.4.0-jw.3`.

### Unchanged

- `smart-router/auto` still refuses a session whose scope cannot be read, pinned or not, until a
  scope is recorded again: it cannot tell which account to use. Jev is not asked there, and a tag
  has no effect.
- `smart-router/local` never routes to a model outside the local role and the roster's local
  policy, in any scope state: with no local model it refuses rather than fall back.
- Both models still refuse while the roster does not load, and on a Pi without bounded session
  history, where the pin cannot be read either.
- A model picked by hand is never changed, reverted, refused or locked, and the router selects a
  model only at `/smart-router local on`. Selecting `smart-router/local` does not pin.

## [1.4.0-jw.2] - 2026-11-16

`smart-router/local` routes in work scope without the pin. On 2026-11-16 John decided "Let
smart-router/local route in work scope": selecting `smart-router/local` is itself the request for
local routing, so a work session on it routes to the local role's models exactly as a pinned one
does.

Upgrading from 1.4.0-jw.1: no roster change is needed. One thing behaves differently, and John
accepted it with the decision: in a work session that is not pinned, on the shared work machines
too, `smart-router/local` now sends the conversation to the roster's local models, which are not
the work account, where it sent nothing before.

### Changed

- In work scope, outside the pin, `smart-router/local` routes to the roster's local role: the run's
  first request, continuations, retries, compactions and summaries, and requests of sessions that
  share the route. It plans the run and tells pi-cache-optimizer of its pick as it does in personal
  scope. It did refuse: "smart-router/local: this session is in work scope, where
  smart-router/local answers only while the session is pinned to local models. Nothing was sent.
  ...". That refusal and its text are removed.
- This holds whatever scopes the roster serves. Under a version 1 roster, or a version 2 roster
  without a work scope, a work session's `smart-router/local` routes to the local role too, while
  `smart-router/auto` still refuses that session.
- `/smart-router scope work` with `smart-router/local` selected, and `/smart-router local off` in a
  work session on it, now say "In work scope smart-router/local routes to the local models without
  the pin, so its next requests go to them, not to the work account." The first is an information
  notice now, unless `smart-router/auto` refuses the scope; it was a warning.
- The package version is `1.4.0-jw.2`.

### Unchanged

- `smart-router/local` never routes to a model outside the local role and the roster's local
  policy, in any scope: with no local model it refuses, "smart-router/local: no local model can
  take this request (...). Nothing was sent. Start the local model server and send the prompt
  again, or choose smart-router/auto or a work Codex model with /model."
- Outside the pin, `smart-router/local` still refuses a session whose scope cannot be read, as
  `smart-router/auto` does, until a scope is recorded again.
- `smart-router/auto` in work scope still goes only to the work-bound Codex account.
- A model picked by hand is never changed, reverted, refused or locked, and the router selects a
  model only at `/smart-router local on`. Selecting `smart-router/local` does not pin.

## [1.4.0-jw.1] - 2026-11-16

The fork's 1.3.0-jw.3 carried onto upstream v1.4.0. Upstream's v1.4.0 tag (`54bee53d`) is merged
into the fork's history by a merge that keeps the fork's tree, as upstream main (`58e87b59`) was
for 1.3.0-jw.1. No commit is rewritten, and `main` fast-forwards. The router behaves as it did in
1.3.0-jw.3.

Upgrading from 1.3.0-jw.3: nothing is required. No roster, command, notice, refusal or handler
changes. Of the shipped files, only `package.json` and `README.md` differ, in the version and in
the statement of the upstream base.

### Changed

- The upstream base is v1.4.0. The 35 upstream commits from `58e87b59` to v1.4.0 bump upstream's Pi
  development dependencies from `^1.3.0` to `^1.5.2`, add a model-mapper rule and benchmark aliases
  for Kimi K3 and K3.1 Pro, list Gemini 4 `carbon` and `hydrogen` as ungrounded, add a SWE-Marathon
  benchmark source, keep curated benchmark rows through a live ingest, and keep release records
  under `spine-tasks/`. Of the 47 files they change, 44 belong to what this port removed: the model
  mapper, the benchmark profiles with their ingest scripts, fixtures and tests, two documents and
  `spine-tasks/`. The other three, `README.md`, `package.json` and `package-lock.json`, the port
  had replaced with its own. So none of upstream's changes is in this fork, and nothing among them
  selects, reverts or blocks a model or adds an event handler.
- Development and the tests use Pi 1.5.2: `@earendil-works/pi-ai` and
  `@earendil-works/pi-coding-agent` are pinned at exactly 1.5.2, from 1.5.0. That is the version
  upstream's lock resolves, and the version of jwiegley/pi that John's nix-config builds. In the
  lock, the eight `@earendil-works` packages move to 1.5.2, and `lovely-mermaid` 0.3.3 takes the
  place of `grok-mermaid` 0.2.3 as a dependency of pi-coding-agent; the lock still holds 124
  packages, and the two that declare an install script are unchanged.
- The peer ranges stay `>=1.5.0`, and the router still needs jwiegley/pi 1.5.0 or later. Pi 1.5.2
  from npm lacks the bounded session reads, as 1.5.0 does, so the router still refuses every request
  on upstream Pi.
- A version's base, in this file's first paragraph, is the latest upstream release merged into the
  fork's history. It read "the upstream release the fork started from".
- The package version is `1.4.0-jw.1`.

## [1.3.0-jw.3] - 2026-11-16

A model picked by hand always stays selected. On 2026-11-16 John decided that in every context,
work scope and the local-only pin included, a model he selects with `/model` or by cycling stays
selected and is sent as it is, and that the router routes only while the selection is
`smart-router/auto` or `smart-router/local`.

Upgrading from 1.3.0-jw.2: no roster change is needed. Three things behave differently:

- In a work session, a personal-account or OpenRouter model picked by hand now receives the
  conversation under that account, and under the pin a cloud model picked by hand receives it too.
  John accepted this with the decision.
- A session that starts pinned, by a pin carried into a fork or `/new`, at resume, or under
  `PI_SMART_ROUTER_LOCAL_ONLY`, is no longer switched to `smart-router/local`. On
  `smart-router/auto` its requests are refused until you choose `smart-router/local`; on a cloud
  model, that model is sent as it is.
- The router no longer registers `before_provider_request` and `cache_warming_decision` handlers.

### Changed

- The selection is never changed, reverted, blocked or locked by an event. `model_select` only
  shows or clears the pin's status item; `turn_start`, `session_before_compact` and
  `session_before_tree` only heal the registration and answer nothing; `input` refuses no prompt;
  `session_start` switches no restored selection.
- The router's policies are in the routes of its own two models. In work scope, outside the pin,
  `smart-router/local` refuses: "smart-router/local: this session is in work scope, where
  smart-router/local answers only while the session is pinned to local models. Nothing was sent.
  Run /smart-router local on to pin the session to local models, choose smart-router/auto or a work
  Codex model with /model, or run /smart-router scope personal." Under the latch the last way out
  is left off, and a scope that cannot be read is refused with the scope's own text. Until now
  that request was routed to a LAN model, and the work guard emptied it.
- Under the pin, `smart-router/auto`'s refusal ends "Choose smart-router/local with /model, or run
  /smart-router local off." It ended "Start the local model server and send the prompt again, or
  run /smart-router local off."
- `/smart-router local on` is the only place where the router selects a model. When
  `smart-router/local` cannot be selected, it says "The selection … could not be switched to
  smart-router/local and stays as it is. Choose smart-router/local with /model: the pin routes only
  the router's own two models, and a model picked by hand is sent as it is."
- `/smart-router scope work` no longer selects `smart-router/auto`. With a model picked by hand
  selected it adds "The selection stays …. A model picked by hand is sent as it is, in work scope
  too."; with `smart-router/local` selected it warns that its next requests are refused.
- `/smart-router local off` no longer selects `smart-router/auto` in work scope, and says the same
  of the selection it leaves. Its question there reads "It is in work scope, so smart-router/auto's
  next requests go to the work account."
- The pin's status item, `local models`, shows only while the pin covers the selection: either of
  the router's models, or a physical model inside the pin's policy.
- Status and local status begin their last line "The pin covers smart-router/auto and
  smart-router/local only", and list "a model picked by hand with /model, which is sent as it is"
  first among what can still send data off the machine.
- On a Pi without bounded session reads, both models refuse every request, and no selection is
  switched.
- The package version is `1.3.0-jw.3`.

### Removed

- The pin's guard and the work guard: the revert of a selection outside the policy, the switch and
  the abort at `turn_start`, the refused prompt, the cancelled compaction and tree summary, the
  emptied provider payload, the stopped cache warming, and the switch of a restored selection at
  session start.
- The lock: its state in each session's record, the one-second revert window, the status text
  `local models: locked`, the `Lock:` line of status and local status, and the notices "so … was
  not kept", "so it is locked", "so the session is no longer locked", "so the prompt was not sent",
  "so compaction was cancelled", "so the navigation with a summary was cancelled", "so the request
  was emptied and the run stopped", "so the run was stopped before anything was sent", "was
  switched to smart-router/local", "was switched to smart-router/auto", "the … guard failed (…), so
  it denied", and the commands' "could not be switched to smart-router/auto, so prompts are refused
  until you choose smart-router/auto or a work Codex model".
- The process slot's memory of the last valid roster's account bindings, which only the work guard
  read. It keeps the work directories.
- `src/guards.ts`; `src/selection.ts` holds what is left.

### Security

- The pin and work scope no longer hold the selection. They hold the requests routed through
  `smart-router/auto` and `smart-router/local`, and those still go only where each policy allows,
  or are refused with "Nothing was sent". A model picked by hand, and a model another extension
  selects, is outside both: its turns, compactions, summaries and warm requests go to it whole.
- No OpenRouter model answers a request routed through a work session's `smart-router/auto`. The
  sentence of 1.3.0-jw.2 that none answers a request "picked by hand" no longer holds.
- The README's "A model picked by hand" gives the behaviour by tested example.

## [1.3.0-jw.2] - 2026-11-12

Four intelligence levels on `smart-router/auto`, classified by Jev through Pi's model registry, and
a personal or work scope for every session. Version 1 rosters route personal sessions as before,
with the keyword classifier alone, apart from the removal of tags and the binding of a plan to its
message; they serve no work scope.

Upgrading from 1.3.0-jw.1: nothing is required. To route by level, write a version 2 roster (see the
README). On a work machine, write its version 2 work roster before setting
`PI_SMART_ROUTER_SCOPE=work`: a latched process with a version 1 roster, or with no roster loaded,
sends nothing unless pinned.

### Added

- Roster schema version 2: the four levels `low`, `medium`, `high` and `super` of each scope it
  serves, personal, work or both, each with a role and the description Jev reads; account bindings
  with a `scope`; the work scope's `directories`; and an optional `classifier` (model
  `openrouter/typesafe/jev-1.14`, `timeoutMs` 1000, `closeCall` 0.15, and caps on what Jev reads).
  Validation keeps work levels to work-bound Codex models and personal levels off work-bound
  accounts, requires a work or Positron label on a work binding and refuses one on a personal
  binding, and refuses a classifier model that an exclusion matches. The built-in `openai-codex-3/*`
  exclusion is lifted only in work scope, for a work level's work-bound model.
- Levels: a version 2 run on `smart-router/auto` goes to LOW, MEDIUM, HIGH or SUPER in the
  session's scope. A trailing tag (`#super`, `#high`, `#medium`, `#low`, or `#s`, `#h`, `#m`, `#l`)
  sets the level and always wins; otherwise Jev's answer, with a close call going to the higher
  level; otherwise the keyword classifier's signal (planning SUPER, complex HIGH, default MEDIUM,
  trivial LOW). An untagged run that names a risky operation goes to HIGH at least. Holds compare
  levels and are a preference. A run takes its level's first available candidate, so that a level
  returns to its first model, Codex on John's rosters, as soon as that model is available; a level
  that cannot take the run, or is too small for it, passes it to the next one up, with a notice.
- Jev: one classifier request per routed run, through `ctx.modelRegistry.findOfType` and
  `ctx.modelRegistry.classify` with `{ timeoutMs, maxRetries: 0 }`. An untagged run waits for the
  answer; a tagged run records it as an opinion and never waits. Jev reads the message and up to
  `context.messages` earlier messages (six by default), text only, redacted and then capped. A
  failure, timeout or malformed answer falls back to the keywords.
- Scope: personal or work per session, from the latch `PI_SMART_ROUTER_SCOPE=work`, then the
  session's `smart-router.scope` entry, then the roster's work directories, read on every read and
  recorded once as an entry, then personal. A fork or `/new` carries it; work to personal asks for
  confirmation, and the latch refuses it.
- The work guard: in work scope, outside the pin, the selection stays on `smart-router/auto` or a
  model of the work account, by routing's own account check, Multi-Pass's label included. It runs
  at every hook the pin's guard uses, switches back to `smart-router/auto` with notices in work
  scope's words, and locks a session that something keeps switching away.
- Records: a run that still holds a level when it settles leaves one `smart-router.level` session
  entry, with no prompt text and no digest, and `/smart-router was low|medium|high|super` appends a
  correction; nothing is sent again. The router can drop a level before its run settles, and a run
  can record a level that another message planned, so a record is a label to check against its
  session: see the README's "Records and training".
- `/smart-router scope [work|personal|status]` and `/smart-router was`.
- The footer's level item, under its own status key `smart-router-level`. History lines of a
  version 2 run gain its scope and level, and status shows the scope, each scope's levels and the
  classifier.
- Tests: units for tags, tiers, redaction, Jev's request and answer, version 2 validation, scope,
  the work guard, plan binding and records, and behaviour scenarios that run them in Pi 1.5's own
  runtime with a fake classifier registered through pi-ai's provider `classifiers` hook.

### Changed

- A trailing level tag is removed from every message before any model sees it, whatever the roster
  or the selection; where it cannot set its run's level, as under a version 1 roster, a notice says
  it has no effect. A message that is only a tag is not sent.
- A run's plan is bound to the message that made it, under version 1 too: a run takes only its own
  message's plan. The router matches a keyed digest of the message's text with the prompt the run
  starts with, or, for a prompt that Pi expanded or an extension rewrote, gives the run the plan of
  the one idle message since the latest prompt's run started; with two such messages, the run goes
  unplanned. The README lists where a plan can still bind wrongly.
- The guards serve two policies: the pin's first, then work scope's. Each lock records the policy
  that set it.
- `smart-router/auto` refuses a session in a scope the roster does not serve, as a work session is
  under a version 1 roster, and a session whose scope cannot be read.
- Under version 2, continuations and summaries with no model to stay on go to the scope's medium
  level, no fallback is declared, and the declared limits come from every level of both scopes.
- The process slot keeps the last valid roster's work directories and account bindings, for the
  scope and the work guard while a reload fails.
- The source scan also forbids `setImmediate` and `AbortSignal.timeout`.
- The package version is `1.3.0-jw.2`.

### Security

- The router opens no network connection of its own and sets no timer. When a version 2 roster has
  a classifier, it asks Pi's model registry for one classifier request per routed run on
  smart-router/auto, with a per-attempt timeout and no retries. It never does so under the pin, on
  smart-router/local, for a steer or follow-up, or without a classifier.
- The message and the earlier messages go through redaction before any cap, in both scopes.
  Redaction is pattern matching: it hides the shapes its tests pin, and other spellings of the same
  secret can stay. It looks for passwords in URLs, `Authorization` headers, JWTs, private-key
  blocks, keys with a vendor's prefix, values after secret names and flags, long mixed-case runs,
  and basic credentials in command lines and config files: curl's `-u`, `--user` and `-U` and
  `--proxy-user`, mysql's `-p`, netrc passwords, XML elements with a secret name, Python auth pairs
  and cookie values. Its time grows in proportion to the text. The README's "What redaction hides"
  gives a tested example of each kind, and lists known gaps and text that is hidden though it is no
  secret. Status lists the classifier among what can still send data off the machine.
- The router keeps no prompt text: it binds plans by HMAC-SHA-256 digests under a key each instance
  draws at random, and records hold neither text nor digest.
- No OpenRouter model answers the requests that go through a work session's route, routed or picked
  by hand, the default goal-x auditor's included; Jev's request is the one OpenRouter use in work
  scope. A `pi --fork` copies a scope that an entry set; pi-subagents children start without it,
  and extensions with models of their own are outside work scope (see "What work scope does not
  cover" in the README). `smart-router/auto` never routes a personal session to a work-bound
  account. In personal scope, outside the pin, a model picked by hand is sent as it is.
- Scope reads fail closed: an unreadable or malformed scope entry makes `smart-router/auto` refuse,
  the work guard holds the session as work scope, and a fork or `/new` from it starts in work scope.
  A work session under a version 1 roster is refused twice, when its request is prepared and by
  the check every pick passes.
- Work directories are compared as text on whole path segments; nothing is resolved or opened.

## [1.3.0-jw.1] - 2026-11-08

The first release of the fork: beettlle/pi-smart-router v1.3.0 (`f31b2304`), rewritten for the
virtual models of Pi 1.5 (jwiegley/pi 1.5.0). It keeps upstream's deterministic prompt classifier
and replaces everything else.

Upgrading from upstream: uninstall upstream's npm package first, since both register the provider
`smart-router`. Then write a roster, `<agentDir>/smart-router.json` (schema version 1, new in this
release; see the README). Upstream's configuration files, its `.pi-smart-router/` state
directories, its ONNX models and its SQLite database are not read, and can be deleted.

### Added

- `smart-router/auto` and `smart-router/local`, registered as Pi virtual models. The factory
  registers both first, synchronously, and never throws; until the router is built, and for good if
  building it fails, both refuse every request, and no handler is wired to a half-built router.
- The roster: one user-owned JSON file per host under Pi's agent directory, with ordered roles of
  exact `provider/id` refs, a routing table for default, trivial, complex and planning runs,
  one-hop fallbacks, account bindings and a local section. Validation is strict and fails closed.
- Account bindings for subscription providers: a Multi-Pass alias must carry the label Multi-Pass
  stores for it, read from Multi-Pass's own file; a native login carries an acknowledgement, shown
  as unverified. Labels with the word `work` or `positron` (a whole word, in any case) are refused
  everywhere.
- The local policy: the local role, its providers and its hosts, which must pass a built-in
  local-host rule (loopback, private, link-local and unique-local addresses, `.lan`, `.local` and
  `.home.arpa` names).
- The local-only pin: `/smart-router local on|off|status`, recorded as a session entry with the
  local policy in force, carried into forks and `/new`, enforced at resume, and pinning every
  session of a process when `PI_SMART_ROUTER_LOCAL_ONLY` is set at load. Its guards switch a
  disallowed selection back, stop runs before their requests are prepared, cancel compaction and
  summaries, empty provider payloads and stop cache warming, and lock the session against an
  extension that keeps switching away. The pin blocks no tools.
- `/smart-router [status]`, `history [n]` and `reload`.
- A `pi.routing.registry.v1` adapter, so that pi-cache-optimizer judges each session's requests by
  the physical model they reach.
- A process-wide owner registry, so that a nested session sharing the model runtime cannot take over
  its parent's routes, and a route left by an ended session heals itself or refuses.
- Declared limits recomputed from the roster at every session start.
- A `LICENSE` file with the MIT text; upstream declared MIT but shipped no license file.
- Tests: unit suites, a source scan, package checks, and a behaviour suite that runs the router in
  Pi 1.5's own runtime with faux providers, sandboxed (`npm run check:sandbox`, or the Nix build).

### Changed

- Routing classifies the text you typed: upstream's planning patterns, including its repo-hygiene
  and destructive-intent triggers, run on the text with file names and paths blanked out, and
  upstream's triage engine, kept verbatim, decides complex and trivial. The text is capped at its
  first 16 KiB and last 4 KiB.
- One decision per run, made when the prompt arrives and taken by the run's first request.
  Stickiness comes from the session's latest physical response: a run moves up the ladder at once
  and down only after `stickyIdleMinutes` (default 5) of idleness, and only when the conversation
  fits the lower role.
- Cooldowns (default 30 minutes) come from the session's own error responses, so autonomous runs
  fall back too. Content-filter refusals never cool a model or trigger a fallback, and local-role
  models are never cooled.
- Both models offer every thinking level; a role sends the session's level or a fixed one, and Pi
  clamps it to the routed model.
- Every failure refuses with a text that names the virtual model, says "Nothing was sent", gives the
  way out, and that Pi does not retry. Nothing falls back silently to a cloud model.
- The package: version `1.3.0-jw.1`, private, an ES module with `pi.extensions: ["./index.ts"]`, no
  runtime dependencies, optional peers `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
  `>=1.5.0`, shipping `index.ts`, `src/**/*.ts`, `README.md` and `LICENSE` only. It requires
  jwiegley/pi 1.5.0 or later, for bounded session reads.

### Removed

- The fake `smart-router/auto` provider with its own `streamSimple`, the delegation and failover
  state machine, and limit sync by re-registration. Pi's own agent loop, retries and compaction take
  their place.
- The model-scope shim, which ran `which pi`, searched the working directory's ancestors,
  `~/.pi/agent/npm` and `$HOMEBREW_PREFIX`, and imported a resolver it found there.
- The fleet built from `enabledModels` or every model with regex tiers, a second `ModelRuntime` and
  `ModelRegistry`, and `SettingsManager.create(cwd)`, which read the project's settings.
- All state and configuration under the working directory (`.pi-smart-router/` and two dozen files).
- Hugging Face, ONNX and HyDRA matching, with its unpinned download of about 90 MB into the working
  directory at extension load, and its native `onnxruntime` and `sharp`.
- SQLite (`better-sqlite3` and its write queue).
- Telemetry, dataset export, contributions, feedback and the `pi-smart-router` CLI.
- The LiteLLM price fetch, the price broker and its cache, staleness notices, peak-pricing clocks, the
  quota feed and virtual cost; `status` shows catalog prices instead.
- The hardware probe (`pmset`, PowerShell, `/sys`) and the LM Studio and Ollama probes; the roster's
  local section replaces them.
- The planning delegate, on by default, which made hidden frontier calls and injected a synthetic
  user message, and typed judgment, which made hidden calls to a local endpoint.
- The adaptive reasoning override and the conciseness hint; per-role `thinking` replaces them.
- Learned tiers: low intensity, P(success), isotonic calibration, expected cost, tier features,
  prewarming and workload heat.
- The session pinner with SAAR, sub-routing, `force_model_id` and cache break-even economics; derived
  stickiness replaces them.
- Loop escalation, deferred: a mid-run switch loses prompt caches and thinking signatures.
- Safe cloud defaults and every catch that routed to the cloud, headroom and zero-output escalation,
  Gemini replay, and the failover notice injected into assistant text.
- The Gemini tool-history guard, the Cursor quota logic and the unevicted cache markers.
- The commands `mode`, `pricing`, `export`, `feedback`, `plan`, `doctor`, `stats` and `unpin`, the
  fleet-mode entry, the status line and the pricing notice.
- Maintainer skills, the release and npm-deprecate workflows, the spine, review, stet and gitnexus
  agent tooling, the `spine-tasks/` directory, and the agent instructions that ran `npx` and `bunx`.
- The `dist` build, `bin`, `exports`, `main`, `allowScripts`, `minPiVersion`, and the dependencies
  `@huggingface/transformers`, `better-sqlite3`, `yaml` and `zod`.

### Security

- No network connection, child process, timer or file write; the source scan enforces an import
  allow-list and forbids dynamic code.
- Only two files are read, both under Pi's agent directory, which must be absolute: the roster and
  Multi-Pass's labels. Each is opened once and checked on that descriptor: a regular file, owned by
  the user, not group- or world-writable, read up to a size cap.
- The roster has no field for secrets; unknown and prototype keys are rejected.
- Built-in exclusions (`openai-codex-3/*`, `hermes/*`, `openrouter/openrouter/auto`,
  `smart-router/*`) no roster can remove, account bindings, refused labels and the local-host rule.
- The pin records its policy and its reads fail closed. Its guards on the agent loop (the switch
  before a request is prepared, the selection guard and the payload barrier) hold in any extension
  load order; cancelling compaction needs the router to load before an extension that compacts
  remotely, such as pi-openai-codex-compat.
- No whole-history session reads: only the fork's bounded readers.
- No install script runs: the repository's `.npmrc` sets `ignore-scripts`. The reviewed dev lock has
  two packages that declare one (`@google/genai` and `protobufjs`), and a package test pins that
  list.
- Tests run offline in an isolated root with a network and process tripwire, and the behaviour
  suite runs only in a sandbox.

[1.4.0-jw.3]: https://github.com/jwiegley/pi-smart-router/compare/v1.4.0-jw.2...v1.4.0-jw.3
[1.4.0-jw.2]: https://github.com/jwiegley/pi-smart-router/compare/v1.4.0-jw.1...v1.4.0-jw.2
[1.4.0-jw.1]: https://github.com/jwiegley/pi-smart-router/compare/v1.3.0-jw.3...v1.4.0-jw.1
[1.3.0-jw.3]: https://github.com/jwiegley/pi-smart-router/compare/v1.3.0-jw.2...v1.3.0-jw.3
[1.3.0-jw.2]: https://github.com/jwiegley/pi-smart-router/compare/v1.3.0-jw.1...v1.3.0-jw.2
[1.3.0-jw.1]: https://github.com/jwiegley/pi-smart-router/compare/f31b2304...v1.3.0-jw.1
