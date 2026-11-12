# Changelog

All notable changes to this fork are recorded here, in the form of
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). A version is `<upstream base>-jw.<n>`:
the base is the upstream release the fork started from, and `jw.<n>` counts the fork's releases.
Releases are signed tags; nothing is published to npm.

## [1.3.0-jw.2] - 2026-11-11

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
- Records: one `smart-router.level` session entry per routed version 2 run, appended when the run
  settles, with no prompt text and no digest, and none for a run whose plan no longer applied at its
  first request; `/smart-router was low|medium|high|super` appends a correction, and nothing is sent
  again.
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
- What Jev reads is redacted before any cap, in both scopes: a URL's password is replaced in the
  text as written, so that a `DOMAIN\user` name's backslash is not read as an escape; then escaped
  line breaks and tabs become spaces, and then the other secret shapes are replaced, by patterns
  written to be linear in the text. Among them are basic credentials in command lines and config
  files: the password of `-u`, `--user` and `-U` in a curl command and of `--proxy-user` in any
  command, the password glued to `-p` in a mysql-family command, a netrc line's password, the text
  of an XML element with a secret name, the password of a Python auth pair, and unquoted cookie
  values. It is pattern matching: the README lists shapes it is known to miss, and text it hides
  that is no secret. Status lists the classifier among what can still send data off the machine.
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

[1.3.0-jw.2]: https://github.com/jwiegley/pi-smart-router/compare/v1.3.0-jw.1...v1.3.0-jw.2
[1.3.0-jw.1]: https://github.com/jwiegley/pi-smart-router/compare/f31b2304...v1.3.0-jw.1
