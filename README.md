# pi-smart-router (jwiegley fork)

Two Pi virtual models, `smart-router/auto` and `smart-router/local`, that send each request to a
physical model chosen from a roster you keep on each host.

This is John Wiegley's fork of [beettlle/pi-smart-router](https://github.com/beettlle/pi-smart-router),
rewritten for the virtual models of Pi 1.5. It keeps upstream's deterministic prompt classifier and
nothing else; [CHANGELOG.md](CHANGELOG.md) lists what was removed and why. Version `1.3.0-jw.1`
is based on upstream v1.3.0 (`f31b2304`). It is not published to npm.

## What it does

The router registers two virtual models with Pi's `registerVirtualModel`. Pi asks the router before
every request of a session on one of them, the router names a physical catalog model, and Pi
prepares the request for that model's provider: its credentials, base URL, headers, transport budget
and hooks. The selection stays virtual; each assistant message names the physical model that
answered, and Pi's footer shows it.

- **`smart-router/auto`** routes by what you typed. A planning prompt goes to the planning role, a
  complex one to the complex role, a trivial one to the trivial role, anything else to the default
  role. A session stays on its model through a stretch of work, moves up at once when a run needs a
  stronger role, and moves back down only after it has been idle for a while. When a model cannot
  take a request (not in the catalog, no credentials, cooling down after a usage limit), the next
  model of its role takes it, and then the role's declared fallback, one hop and no further.
  Without a declared fallback the request is refused.
- **`smart-router/local`** routes only to the roster's local role, and never falls back to anything
  else. If no local model can take the request, it is refused.
- **The local-only pin** (`/smart-router local on`) keeps a whole session on local models, whatever
  is selected, until you unpin it. See [The local-only pin](#the-local-only-pin).
- **Every refusal says "Nothing was sent."** A refusal names the virtual model, gives the cause in
  the router's own words and says how to get out. Pi never retries a refusal.

What it does not do: it opens no network connection, starts no process, writes no file of its own
and sets no timer; the pin's session entries are written by Pi, into the session. It reads two
files, both under Pi's agent directory: the roster, and Multi-Pass's subscription labels when the
roster binds a Multi-Pass account. It never reads anything relative to the working
directory or a project. It has no runtime dependency and no native code; Pi supplies
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.

It needs jwiegley/pi 1.5.0 or later, whose bounded session reads let it look at a session without
loading its whole history. On upstream Pi 1.5.0 both models refuse and say so.

## Installing

There is no npm package, and none should be installed:

- The fork is not on npm. It ships source only, and Pi loads it by path; nothing needs installing.
- Never install upstream's npm package `pi-smart-router` beside it. Both register the provider
  `smart-router`, and Pi refuses the second registration at startup.

John's nix-config is to package this repository for his personal Pi profiles, never for the
shared-work profile; that integration belongs to nix-config, not to this repository. To load it by
hand, point Pi at the checkout:

```sh
pi -e /path/to/pi-smart-router/index.ts
```

or add the path to the `extensions` list in Pi's settings. Then:

1. If your settings keep an `enabledModels` list, add `smart-router/auto` and `smart-router/local`:
   Pi selects and cycles models within that list. Whether `defaultProvider` and `defaultModel`
   should name a router model is your choice.
2. Write the roster (next section).
3. Run `/smart-router status` and check every candidate, binding and route.

## The roster

The roster is one JSON file per host, at `<agentDir>/smart-router.json`, which is
`~/.config/pi/agent/smart-router.json` on John's hosts. `<agentDir>` is Pi's agent directory
(`PI_CODING_AGENT_DIR`); a relative one is refused.

- **You own it.** Nix never writes it, and it holds no secrets: the schema has no field for keys,
  tokens, headers, base URLs or environment.
- **It must be safe:** a regular file owned by you, not writable by group or others, at most 64 KiB.
  A symlink is followed to its target, which must pass the same checks.
- **Validation is strict.** Unknown keys are rejected at every level, and errors name their place,
  as in `roles[3].models[0]: "openai-codex-3/gpt-6.1-sol" is excluded by openai-codex-3/*`.
- **Failure is closed.** A missing, invalid or unsafe roster makes both models refuse until it is
  fixed, with one notice per session start. There is no last-known-good copy, so a typo cannot keep
  routing to a model you just removed.
- **It reloads** at session start, at each idle prompt when the file changed, and on
  `/smart-router reload`.

### Hera

```json
{
  "version": 1,
  "$comment": "Hera. openai-codex-2 is John's personal ChatGPT account, labelled 'personal' in Multi-Pass. The router itself excludes openai-codex-3 and refuses work or Positron labels; plain openai-codex is excluded here because Hera reserves it for the work account.",
  "exclude": ["openai-codex/*"],
  "roles": [
    { "name": "local", "$comment": "private or extreme economy; free; only smart-router/local and the pin", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "thinking": "max" },
    { "name": "worker", "$comment": "economical", "models": ["openrouter/deepseek/deepseek-v4.1-flash-1017"] },
    { "name": "thinker", "$comment": "strong; the architect's fallback", "models": ["openrouter/moonshotai/kimi-k3.1-pro"] },
    { "name": "coder", "$comment": "the engineer's fallback, reached only through routing.fallback; ranked just below the engineer so that sessions return to sol as soon as it is available", "models": ["openrouter/z-ai/glm-5.3"] },
    { "name": "engineer", "$comment": "frontier", "models": ["openai-codex-2/gpt-6.1-sol"] },
    { "name": "architect", "$comment": "frontier architect/thinker", "models": ["openai-codex-2/gpt-6-astra"] }
  ],
  "routing": {
    "default": "worker",
    "trivial": "worker",
    "complex": "engineer",
    "planning": "architect",
    "fallback": { "engineer": "coder", "architect": "thinker" }
  },
  "accounts": { "openai-codex-2": { "multiPassLabel": "personal" } },
  "local": { "role": "local", "providers": ["omlx-hera"], "hosts": ["hera.lan"] }
}
```

The `"exclude": ["openai-codex/*"]` line is required on Hera: plain `openai-codex` is the work
account there, and with the line, a role that names it is a validation error.

### Clio, Vulcan, athena and pallas

```json
{
  "version": 1,
  "$comment": "Clio, Vulcan, athena and pallas. Native openai-codex is John's personal ChatGPT login on these hosts; the binding below is his acknowledgement, which the router cannot verify. Run /smart-router status after any /login, /logout, /subs add or /subs remove.",
  "roles": [
    { "name": "local", "$comment": "private or extreme economy; free; only smart-router/local and the pin", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "thinking": "max" },
    { "name": "worker", "$comment": "economical", "models": ["openrouter/deepseek/deepseek-v4.1-flash-1017"] },
    { "name": "thinker", "$comment": "strong; the architect's fallback", "models": ["openrouter/moonshotai/kimi-k3.1-pro"] },
    { "name": "coder", "$comment": "the engineer's fallback, reached only through routing.fallback", "models": ["openrouter/z-ai/glm-5.3"] },
    { "name": "engineer", "$comment": "frontier", "models": ["openai-codex/gpt-6.1-sol"] },
    { "name": "architect", "$comment": "frontier architect/thinker", "models": ["openai-codex/gpt-6-astra"] }
  ],
  "routing": {
    "default": "worker",
    "trivial": "worker",
    "complex": "engineer",
    "planning": "architect",
    "fallback": { "engineer": "coder", "architect": "thinker" }
  },
  "accounts": { "openai-codex": { "native": "personal" } },
  "local": { "role": "local", "providers": ["omlx-hera"], "hosts": ["hera.lan"] }
}
```

It differs from Hera's in three places: the engineer and architect use native `openai-codex`, there
is no `exclude` line, and the native login is bound with `"native": "personal"`.

### How the roles are used

- **local (GLM on Hera's oMLX)** takes requests only through `smart-router/local` and the pin.
  `smart-router/auto` never routes to it, because no routing target or fallback names it; that
  keeps auto from causing cold oMLX prefills.
- **worker (DeepSeek)** takes default and trivial runs.
- **engineer (sol)** takes complex runs: code, debugging, a high cyclomatic score and similar.
- **architect (astra)** takes planning runs, on the prepaid Codex subscription.
- **coder (GLM 5.3 on OpenRouter)** and **thinker (Kimi)** are reached only as fallbacks: coder when
  sol cannot take a request, thinker when astra cannot, as when the ChatGPT subscription is
  unavailable or cooling down after a usage limit. sol and astra share one ChatGPT account, so the
  fallbacks move to a different quota. A fallback sends the conversation to another vendor; delete
  the `fallback` object to be refused instead.

The order of `roles` is the ladder stickiness uses, cheapest or weakest first. A session that
reached astra on a planning run stays there for complex follow-ups until it has been idle for 5
minutes, because engineer ranks below architect. `"stickyIdleMinutes": 0` instead plans on astra
and implements on sol whenever a run classifies as complex. coder ranks just below engineer, so a
session that fell back to coder returns to sol at its next complex run once sol is available.

### Fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Exactly `1`. |
| `$comment` | no | A string, allowed in every object. |
| `exclude` | no | `provider/id` refs or `provider/*` patterns, added to the built-in exclusions `openai-codex-3/*`, `hermes/*`, `openrouter/openrouter/auto` and `smart-router/*`, which no roster can remove. A role ref that matches an exclusion is an error. |
| `roles` | yes | The ladder, cheapest or weakest first. Each role has a `name` (`^[a-z][a-z0-9-]{0,31}$`, unique), `models` (exact `provider/id` refs, no patterns, each in one role only) and an optional `thinking`: `"selected"` (the default, the session's level) or a fixed `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `routing.default` | yes | The role of runs that classify as nothing else. |
| `routing.trivial`, `routing.complex`, `routing.planning` | no | Roles for those classifications; each defaults to `routing.default`. |
| `routing.fallback` | no | `{ "role": "role" }`: one hop, never to itself. Without an entry, a role that cannot take a request refuses it. |
| `accounts` | for subscription providers | A binding for every subscription provider a role uses. See below. |
| `local` | no | `role` (the local role), `providers` (every provider of the local role, and nothing qualifies as local unless it is listed) and `hosts` (base-URL host names). Without it, `smart-router/local` and the pin always refuse. |
| `stickyIdleMinutes` | no | 0 to 1440, default 5. How long a session must be idle before a run may move down the ladder. |
| `cooldownMinutes` | no | 1 to 1440, default 30. How long a usage-limit or authentication error takes a model out of routing. |

A ref splits at its first `/`: `openrouter/deepseek/deepseek-v4.1-flash-1017` is provider `openrouter`,
model `deepseek/deepseek-v4.1-flash-1017`. Every ref is compared whole, so
`openai-codex-2/gpt-6.1-sol` and `openai-codex-3/gpt-6.1-sol` are different models.

Each `local.hosts` entry must be `localhost`, a loopback, private (RFC 1918), link-local or
unique-local address, or a name ending in `.lan`, `.local` or `.home.arpa`; anything else is a
validation error, so a roster edit cannot make a cloud API count as local. Tailnet names and
addresses are not accepted. A model is local when its provider is in `local.providers` and the host
of its catalog base URL is in `local.hosts`. The router sees only the catalog's base URL: a base URL
that a stored credential supplies replaces it at request time, so keep local providers' credentials
free of base URLs.

### Account bindings

A provider id does not identify an account: Multi-Pass aliases are positional, and a native login
is whichever account the browser had signed in at `/login`. So every subscription provider in the
roster needs a binding. Subscription providers are `openai-codex`, `anthropic` and `github-copilot`,
and their Multi-Pass aliases such as `openai-codex-2`.

- **A Multi-Pass alias** is bound with `{ "multiPassLabel": "<label>" }`. The router reads the label
  Multi-Pass stores for that alias in `<agentDir>/multi-pass.json`, which holds no credentials, and
  the labels must match, ignoring case and surrounding spaces. A missing file, entry or label, or a
  file that is unsafe or malformed, refuses the alias.
- **A native login** is bound with `{ "native": "<label>" }`. That is your acknowledgement of which
  account is logged in; the router cannot check it, and `status` shows it as unverified, with the
  provider's auth source. Run `/smart-router status` after any `/login`, `/logout`, `/subs add` or
  `/subs remove` on hosts that route to native `openai-codex`.
- **A label containing `work` or `positron`** is refused wherever it appears, in the roster or in
  Multi-Pass's file.

`status` reports each binding, the label Multi-Pass stores and the auth source (configured, stored or
environment), never a credential.

## Routing in detail

- **Classification uses the text you typed**, as Pi's `input` event delivers it, capped at its first
  16 KiB and last 4 KiB. A prompt template or `/skill:` call is classified by its invocation, not its
  expansion. Planning comes first: words such as plan, design, architecture, refactor, migration,
  step 1, phase 2, breakdown, strategy and trade-off, a plan heading, and repo-hygiene or destructive
  requests such as clean up, unstage, `git rm`, `rm -rf` or force push. File names and paths are
  blanked out first, so `PLAN.org`, `plan.md` or `src/plan/` do not make a run a planning run. Then
  upstream's triage engine decides complex and trivial. Anything else is default.
- **One decision per run.** The run is planned when the prompt arrives, and its first request takes
  the plan. Steering, follow-ups and tool continuations stay on the run's model; runs that start
  without a prompt, such as goal-x continuations, stay on the model the session used last.
- **Stickiness.** A run that classifies higher than the latest response's role moves up at once. One
  that classifies lower stays until the session has been idle for `stickyIdleMinutes`, and longer
  still while the conversation would not fit the lower role's context window less Pi's compaction
  reserve.
- **Cooldowns.** A physical model's usage-limit, quota, billing or authentication error (401, 403,
  `insufficient_quota`, `ResourceExhausted` and the like) takes it out of routing for
  `cooldownMinutes`, so the next run of any kind moves to the role's next model or its fallback. A
  content-filter or moderation refusal never cools a model and never triggers a fallback, so refused
  content is not sent to another vendor. Local-role models are never cooled, so an oMLX restart does
  not cost 30 minutes of refusals.
- **Retries.** When Pi retries a failed request, a usage-limit or authentication failure moves to the
  role's next model and then its fallback; any other failure, rate limits and context overflows
  included, retries the same model, because Pi has already backed off or compacted.
- **Compaction and other summaries** go to the model that answered last when it may take them, so
  the transcript does not go to a new vendor; otherwise to the default role, or to the local role
  under `smart-router/local` and the pin.
- **Thinking.** Both models offer every thinking level, so a `max` default is not clamped at
  selection. A role sends the session's level or its fixed `thinking`, and Pi clamps that to what the
  routed model supports.
- **Declared limits.** Pi and other extensions read a virtual model's context window and output
  budget before the first response. At every session start the router registers both models again:
  auto with the smallest window and output budget among the first available model of each role it
  can reach, local with its first available local model's. Before that, both declare 128,000 and
  16,384.

The router also tells pi-cache-optimizer, through its `pi.routing.registry.v1` registry, which
physical model each session's next request will use. Without that, the optimizer would rewrite
Codex system prompts, which Codex's content filter rejects, and would drop oMLX session-affinity
headers. Only the session's own agent loop changes what the optimizer reads, never a compaction or
another session.

## The local-only pin

`/smart-router local on` pins the session to local models:

- It records the local policy in force (the local role's models, providers and hosts) in a
  `smart-router.pin` session entry, so a later roster edit cannot widen what counts as local. If
  the roster is invalid or has no local section, the pin records an empty policy, under which
  nothing qualifies, and says so.
- It switches the selection to `smart-router/local` unless it is already allowed: that model, or a
  physical model inside the policy, such as GLM selected directly.
- It warns when earlier turns of the branch went to a cloud model. Those have already left the
  machine; the pin protects only what follows.
- It lists what can still send data off the machine (below).

The status item reads `local models` while pinned and `local models: locked` while locked. It does
not say "private".

`/smart-router local off` asks first, and Enter keeps the pin; only "Yes, unpin" unpins. It refuses
in modes without dialogs and while the environment switch is on. `/smart-router local status` shows
the pin and what can still leave the machine.

- **Session-wide.** The pin belongs to the session file, every branch included. Resume keeps it.
- **Forks and `/new` carry it** into the session they create. Resuming an unpinned session after a
  pinned one shows a notice.
- **Selecting `smart-router/local` does not pin.** It routes locally; pinning is explicit.
- **`PI_SMART_ROUTER_LOCAL_ONLY`**, set to any non-blank value other than `0`, `false` or `off`,
  pins every session in the process, with the local section of the first valid roster. It is read
  once when the router loads and stays on even if the variable is removed later. Set it in a
  launcher or an alias; Nix never sets it.
- **It fails closed.** Only a well-formed unpinning entry unpins. A `smart-router.pin` entry of any
  other shape, a custom message of that type or another version pins with an empty policy, under
  which nothing qualifies, until you pin again. On a Pi without the fork's bounded session reads,
  every session counts as pinned.

### What the pin guarantees

While a session is pinned, every request routed through either virtual model goes to a model inside
the pinned policy, or fails with "Nothing was sent". That covers user runs, continuations, retries,
Pi's compaction and branch summaries, a goal-x auditor that inherits the session's selection, and
pi-subagents children that inherit `smart-router/local` and load the router.

If something selects a model outside the policy, the router undoes it at once, back to the
previous model when that one was allowed and to `smart-router/local` otherwise, and it checks again
before each request is prepared. `smart-router/auto` is not an allowed selection under the pin,
although its routes obey it: with John's rosters, where auto never reaches the local role, a request
that still arrives on `smart-router/auto` while the session is pinned, from an auditor that
inherited it before the pin for instance, is refused. While the selection is outside the policy:

- prompts are refused;
- a run that starts anyway is switched to `smart-router/local` before its first request is
  prepared, or stopped if the switch does not hold, so no provider is called;
- compaction and summaries are cancelled;
- the payload of any provider request is emptied, and later extensions cannot restore it;
- cache warming stops.

If another extension keeps switching the selection away, the router locks the session instead of
fighting: prompts are refused, runs stopped, compaction cancelled and payloads emptied until a local
selection holds or you unpin. The notice names the competing model and the usual causes: Multi-Pass
`allowedSubs` in the project, or a branch holding a native Codex compaction checkpoint. `/new`
carries the pin into a clean session.

The switch before each request, the selection guard and the payload barrier hold whatever order
Pi loads extensions in. Compaction does not: the first extension that cancels it wins, and
pi-openai-codex-compat compacts remotely inside its own handler when the selection is a physical
`openai-codex` model. So load the router before the other extensions, as nix-config's integration
is to do; until then, a pinned session that something has forced onto `openai-codex` could have
its transcript compacted by Codex. The prompt refusal is a courtesy for the same reason: a later
extension can switch the model after the router has seen the prompt, and the other guards then
take over.

### What the pin does not cover

The pin pins the model. It blocks no tools and cannot see requests that do not go through the
session's own loop or Pi's summaries. Still able to send data off the machine:

- **Tools.** Subagent and workflow tools, which may run models of their own; web fetch and web search
  tools, which send URLs and queries; browser tools; and whatever the bash tool can read and send.
  `/smart-router local on` lists the ones loaded, by name.
- **Extensions with their own models:** pi-warden's judge (it sends redacted context to its backend
  while enabled), a configured goal-x auditor, workflow tiers, subagent agents with explicit models,
  pi-btw, and Multi-Pass `/subs`, which can move the session to another subscription.
- **Pi's own `/share`, `/export` and `/bug`**, which run before any extension hook. `/bug` uploads to
  Earendil, optionally with the transcript and a summary the current model writes.
- **Extension commands**, which run before the router sees the input.
- **Turns sent before the pin**, and processes outside Pi, such as agent-deck's relay and backups.

For strictly private work, keep using a dedicated session on a local model with pi-warden off
(`NIX_MANAGED_PI_WARDEN=off`). The pin is the router's safeguard, not a sandbox.

## Commands

| Command | Does |
|---|---|
| `/smart-router` or `/smart-router status` | The roster's path and state; the selection and level; the pin and any lock; every role's models on this host with `ok` or the reason they cannot route, and catalog prices; account bindings and auth sources; the routing table and fallbacks; the last decision; what can still leave the machine; and a warning for any fallback that would move a run onto Codex's API from another one. |
| `/smart-router history [n]` | The last `n` routing decisions (10 by default, at most 50), with reason codes. Model ids and codes only, never prompt text. |
| `/smart-router local on`, `off`, `status` | The pin. |
| `/smart-router reload` | Read the roster and Multi-Pass's labels again now, and register both models again if their limits changed. |

## Interactions with other extensions

- **pi-cache-optimizer** works through the routing registry, as described above.
- **pi-openai-codex-compat** still wraps routed `openai-codex` requests, but whatever it keys on the
  *selected* model does not apply to them: its request options, its Codex tool surface and its remote
  compaction. On a branch with a native Codex compaction checkpoint it switches the selection back
  to Codex, which the pin answers with `smart-router/local` or a lock; start pinned work outside such
  a branch (`/new` carries the pin). Hera's `openai-codex-2` never uses codex-compat.
- **goal-x**: continuations route like any run that starts without a prompt, and get cooldowns and
  fallbacks. The default auditor routes through the session and obeys its pin; a configured auditor
  bypasses the router and the pin, so leave it unset in private work. Leave `auditorProjectResources`
  and `projectResources` off: each loads a second router into every audit.
- **pi-subagents**: foreground children inherit the selection but load the router only when it is
  registered for children, as nix-config's integration is meant to do; otherwise a child on
  `smart-router/*` fails with "model not found". Give children explicit models where that
  registration is absent.
- **Multi-Pass**: its subscription-pool failover keys on the selected provider, so routed requests
  lose it; `routing.fallback` replaces it. In a project whose `.pi/multi-pass.json` sets
  `allowedSubs`, list `smart-router` there, or Multi-Pass switches away from it.
- **pi-flag** reads the declared limits, which are real and recomputed at each session start.
- **pi-idle-check and hashline** key per-model settings on `smart-router/*`; configure them for those
  ids as you would for the models behind them.
- **pi-warden** aggregates statistics under the virtual id. Its judge is independent of the pin.
- **pi-btw** starts a runtime of its own without the router and probably refuses under
  `smart-router/*`.

Other things to know:

- Pi does not warm prompt caches for routed requests.
- `compaction.modelOverrides` must name `smart-router/auto` or `smart-router/local` to apply: Pi
  looks token settings up under the selection.
- Cycling through scoped models may show stale limits for the router's models until the next
  session start.
- If Pi starts without this extension, a session resumed on `smart-router/*` falls back to the
  physical model that answered last, or to the settings default, which is a cloud model on every
  host.

## Opting out

- **Per run:** choose another model with `/model`.
- **Per session:** `/smart-router local off` unpins after confirmation.
- **Entirely:** stop loading the extension. Because a resumed session on `smart-router/*` would then
  fall back to a cloud model, a launcher that leaves the router out should register two refusing
  models with the same ids instead. nix-config's integration, which is to be written there and is
  not part of this repository, is meant to do that when `NIX_MANAGED_PI_SMART_ROUTER` is set to
  any non-blank value other than `on`, `1`, `true` or `yes`, and when the router fails to load.

## Development

```sh
npm install --ignore-scripts    # the pinned devDependencies; .npmrc also sets ignore-scripts
npm run check                   # tsc, the unit suites, the package surface
npm run check:sandbox           # the same, with the behaviour suite, under sandbox-exec (macOS)
```

- Never use `npx`, `bunx` or global installs.
- The tests run offline in an isolated root, with an environment built from an allow-list and a
  tripwire that refuses network and child-process use.
- The behaviour suite runs Pi 1.5's own runtime from npm with faux providers, so it runs only
  sandboxed: under `npm run check:sandbox`, or in the offline Nix build. `npm run check` leaves it
  out and says so.
- Never run Pi's own test suites on the host, and never start a real Pi session from a test.
- [AGENTS.md](AGENTS.md) holds the rules for coding agents.

## License

MIT; see [LICENSE](LICENSE). Copyright (c) 2026 beettlle and contributors, and Copyright (c) 2026
John Wiegley for the port. The triage engine and entropy check in `src/triage/` are upstream's,
unchanged but for one import specifier.
