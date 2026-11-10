# pi-smart-router (jwiegley fork)

Two Pi virtual models, `smart-router/auto` and `smart-router/local`, that send each request to a
physical model chosen from a roster you keep on each host.

This is John Wiegley's fork of [beettlle/pi-smart-router](https://github.com/beettlle/pi-smart-router),
rewritten for the virtual models of Pi 1.5. It keeps upstream's deterministic prompt classifier and
nothing else; [CHANGELOG.md](CHANGELOG.md) lists what was removed and why. Version `1.3.0-jw.2`
is based on upstream v1.3.0 (`f31b2304`). It is not published to npm.

## What it does

The router registers two virtual models with Pi's `registerVirtualModel`. Pi asks the router before
every request of a session on one of them, the router names a physical catalog model, and Pi
prepares the request for that model's provider: its credentials, base URL, headers, transport budget
and hooks. The selection stays virtual; each assistant message names the physical model that
answered, and Pi's footer shows it.

- **`smart-router/auto`** routes by what you typed. With a version 1 roster, a planning prompt goes
  to the planning role, a complex one to the complex role, a trivial one to the trivial role,
  anything else to the default role. A session stays on its model through a stretch of work, moves
  up at once when a run needs a stronger role, and moves back down only after it has been idle for
  a while. When a model cannot take a request (not in the catalog, no credentials, cooling down
  after a usage limit), the next model of its role takes it, and then the role's declared
  fallback, one hop and no further. Without a declared fallback the request is refused.
- **Levels and scopes.** With a version 2 roster, `smart-router/auto` sends each run to one of four
  levels, LOW, MEDIUM, HIGH or SUPER, in the session's scope, personal or work. A trailing tag such
  as `#high` sets the level; otherwise Jev, TypeSafe AI's decision model, classifies the message
  through Pi; otherwise the keywords do. A work session reaches only the work Codex account, apart
  from Jev and, while pinned, local models. See [Levels](#levels), [Jev](#jev) and
  [Scope](#scope-personal-or-work).
- **`smart-router/local`** routes only to the roster's local role, and never falls back to anything
  else. If no local model can take the request, it is refused.
- **The local-only pin** (`/smart-router local on`) keeps a whole session on local models, whatever
  is selected, until you unpin it. See [The local-only pin](#the-local-only-pin).
- **Every refusal says "Nothing was sent."** A refusal names the virtual model, gives the cause in
  the router's own words and says how to get out. Pi never retries a refusal.

The router opens no network connection of its own and sets no timer. When a version 2 roster
has a classifier, it asks Pi's model registry for one classifier request per routed run on
smart-router/auto, with a per-attempt timeout and no retries. It never does so under the pin, on
smart-router/local, for a steer or follow-up, or without a classifier.

It also starts no process, writes no file of its own and keeps no prompt text; its session entries
(the pin's, the scope's and each run's level record) are written by Pi, into the session. It reads
two files, both under Pi's agent directory: the roster, and Multi-Pass's subscription labels when
the roster binds a Multi-Pass account. It reads no file relative to the working directory or a
project; it only compares the working directory, as text, with the roster's work directories. The
one project-influenced value it uses is the compaction reserve in Pi's settings, which Pi merges
with a project's `.pi/settings.json`; it only affects whether stickiness may move a run down to a
smaller role. It has no runtime dependency and no native code; Pi supplies
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.

It needs jwiegley/pi 1.5.0 or later, whose bounded session reads let it look at a session without
loading its whole history. Upstream Pi 1.5.0 lacks those reads, so there the router fails closed: it
cannot read a session's pin and treats every session as pinned, switching each selection to
`smart-router/local` and refusing prompts for as long as it is loaded. Do not load it on upstream Pi.

## Installing

There is no npm package, and none should be installed:

- The fork is not on npm. It ships source only, and Pi loads it by path; nothing needs installing.
- Never install upstream's npm package `pi-smart-router` beside it. Both register the provider
  `smart-router`, and Pi refuses the second registration at startup.

John's nix-config is to package this repository for his personal Pi profiles and, once John
confirms it, for the shared-work profile with `PI_SMART_ROUTER_SCOPE=work` (see
[Scope](#scope-personal-or-work)); that integration belongs to nix-config, not to this repository.
To load it by hand, point Pi at the checkout:

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
  routing to a model you just removed. Only the scope and the work guard keep something of the last
  valid roster: its work directories and account bindings, so that a broken edit can neither move a
  work session to personal scope nor widen what it may select.
- **It reloads** at session start, at each idle prompt when the file changed, and on
  `/smart-router reload`.
- **Two schema versions.** Version 1, below, routes by a routing table. Version 2 routes by four
  levels in each scope; see [Roster version 2](#roster-version-2-levels-and-scopes).

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
  the `fallback` object to be refused instead. After a fallback, stickiness can keep the session on
  coder or thinker for default and trivial runs until it has been idle for `stickyIdleMinutes`,
  because both rank above worker; the next complex or planning run tries sol or astra again.

The order of `roles` is the ladder stickiness uses, cheapest or weakest first. A session that
reached astra on a planning run stays there for complex follow-ups until it has been idle for 5
minutes, because engineer ranks below architect. `"stickyIdleMinutes": 0` instead plans on astra
and implements on sol whenever a run classifies as complex. coder ranks just below engineer, so a
session that fell back to coder returns to sol at its next complex run once sol is available.

### Fields

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | `1` for this table's fields, or `2` for [version 2](#roster-version-2-levels-and-scopes). |
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
- **A label with the word `work` or `positron`** (a whole word, in any case) is refused wherever it
  appears, in the roster or in Multi-Pass's file, except on a version 2 work binding, which must
  carry one, and which only a work-scope session accepts.

`status` reports each binding, the label Multi-Pass stores and the auth source (configured, stored or
environment), never a credential.

## Roster version 2: levels and scopes

Version 2 replaces the routing table with the four levels of each scope the roster serves,
personal, work or both, binds each account to a scope, and may configure the classifier. Version 1
rosters keep working, in personal scope only, with the keyword classifier alone.

### Hera, version 2

```json
{
  "version": 2,
  "$comment": "Hera, version 2. Personal levels take Codex first, on openai-codex-2 (John's personal ChatGPT account, labelled 'personal' in Multi-Pass), then OpenRouter. Work levels take only openai-codex-3, the work account, which the router excludes everywhere else. Plain openai-codex is excluded here because Hera reserves it for the work account.",
  "exclude": ["openai-codex/*"],
  "roles": [
    { "name": "local", "$comment": "private or extreme economy; free; only smart-router/local and the pin", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "thinking": "max" },
    { "name": "low", "$comment": "Nyx's ref is a Nix-store basename that changes whenever its model is rebuilt", "models": ["openai-codex-2/gpt-6-luna", "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad", "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp"] },
    { "name": "medium", "models": ["openai-codex-2/gpt-6.1-terra", "openrouter/deepseek/deepseek-v4.1-flash-1017"] },
    { "name": "high", "models": ["openai-codex-2/gpt-6.1-sol", "openrouter/z-ai/glm-5.3"] },
    { "name": "super", "models": ["openai-codex-2/gpt-6-astra", "openrouter/moonshotai/kimi-k3.1-pro"] },
    { "name": "work-low", "models": ["openai-codex-3/gpt-6-luna"] },
    { "name": "work-medium", "models": ["openai-codex-3/gpt-6.1-terra"] },
    { "name": "work-high", "models": ["openai-codex-3/gpt-6.1-sol"] },
    { "name": "work-super", "models": ["openai-codex-3/gpt-6-astra"] }
  ],
  "scopes": {
    "personal": {
      "levels": {
        "low": { "role": "low", "describe": "Mechanical or trivial work that follows a clear specification" },
        "medium": { "role": "medium", "describe": "Engineering, implementation and validation" },
        "high": { "role": "high", "describe": "Deep thought, review, and the design of verification" },
        "super": { "role": "super", "describe": "Deep thought, research, design and planning" }
      }
    },
    "work": {
      "$comment": "The directory is an example: list the directories of Hera's work checkouts.",
      "levels": {
        "low": { "role": "work-low", "describe": "Mechanical or trivial work that follows a clear specification" },
        "medium": { "role": "work-medium", "describe": "Engineering, implementation and validation" },
        "high": { "role": "work-high", "describe": "Deep thought, review, and the design of verification" },
        "super": { "role": "work-super", "describe": "Deep thought, research, design and planning" }
      },
      "directories": ["/Users/johnw/src/positron"]
    }
  },
  "accounts": {
    "openai-codex-2": { "multiPassLabel": "personal" },
    "openai-codex-3": { "multiPassLabel": "Positron work", "scope": "work", "$comment": "the label Multi-Pass stores for openai-codex-3, which must name work or Positron" }
  },
  "classifier": { "model": "openrouter/typesafe/jev-1.14", "timeoutMs": 1000, "closeCall": 0.15, "context": { "messages": 6, "messageChars": 1500, "totalChars": 12000 } },
  "local": { "role": "local", "providers": ["omlx-hera", "nyx"], "hosts": ["hera.lan", "nyx.lan"] }
}
```

- **The personal ladder** takes Codex first at every level, then OpenRouter; LOW takes luna, then
  Nyx's Qwen, then Hera's. A run takes the first available candidate of its level's role, so a
  level returns to Codex as soon as Codex is available again.
- **The work ladder** holds only `openai-codex-3`, Hera's work account, bound as work. The built-in
  exclusion of `openai-codex-3/*` still holds in personal scope, so no personal level can name it.
- **Nyx's ref** is a Nix-store basename that changes whenever its model is rebuilt, so the roster
  needs an edit after each rebuild until nix-config gives it a stable id. Pi offers it only once
  `NYX_API_KEY` reaches Pi's environment; until then, LOW falls through to Hera's Qwen whenever luna
  is unavailable.
- **The local section** keeps Nyx, so a pinned session can still pick Nyx's Qwen by hand, although
  the pin routes only to GLM.

A work machine's roster has only the work roles, on its native `openai-codex` login bound as work:

```json
{
  "version": 2,
  "$comment": "A shared-work machine: work scope only. Native openai-codex is the work ChatGPT login there; the binding is John's acknowledgement, which the router cannot verify.",
  "roles": [
    { "name": "work-low", "models": ["openai-codex/gpt-6-luna"] },
    { "name": "work-medium", "models": ["openai-codex/gpt-6.1-terra"] },
    { "name": "work-high", "models": ["openai-codex/gpt-6.1-sol"] },
    { "name": "work-super", "models": ["openai-codex/gpt-6-astra"] }
  ],
  "scopes": {
    "work": {
      "levels": {
        "low": { "role": "work-low", "describe": "Mechanical or trivial work that follows a clear specification" },
        "medium": { "role": "work-medium", "describe": "Engineering, implementation and validation" },
        "high": { "role": "work-high", "describe": "Deep thought, review, and the design of verification" },
        "super": { "role": "work-super", "describe": "Deep thought, research, design and planning" }
      }
    }
  },
  "accounts": { "openai-codex": { "native": "Positron work", "scope": "work" } }
}
```

Without a `classifier` section, the keywords decide every level; with one, Jev's request goes
through whatever OpenRouter account Pi has on that machine.

### Fields in version 2

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Exactly `2`. |
| `$comment`, `exclude`, `roles`, `accounts`, `local`, `stickyIdleMinutes`, `cooldownMinutes` | as in version 1 | As in [version 1](#fields), with the rules below. There is no `routing`: the levels replace it, and version 2 declares no fallbacks. |
| `scopes` | yes | `personal`, `work` or both. `smart-router/auto` refuses a session in a scope the roster does not have. |
| `scopes.<scope>.levels` | yes | `low`, `medium`, `high` and `super`, each `{ "role": "<role>", "describe": "<text>" }`: the role the level's runs go to, and the description Jev reads, a non-empty text of at most 2000 characters. No role serves two levels, in one scope or across both, the local role serves none, and a scope's level roles rank up the ladder from low to super. |
| `scopes.work.directories` | no | Absolute paths whose sessions are in work scope ([Scope](#scope-personal-or-work)), written plainly: no trailing `/`, no empty, `.` or `..` segment, and not `/` itself. |
| `accounts.<provider>.scope` | no | `"personal"`, the default, or `"work"`. |
| `classifier` | no | Jev's settings; without them, Jev is never asked. `model`, an exact ref, default `openrouter/typesafe/jev-1.14`; `timeoutMs`, 100 to 1000, default 1000; `closeCall`, 0 to 0.5, default 0.15; and `context`: `messages`, 0 to 20, default 6; `messageChars`, 200 to 8000, default 1500; `totalChars`, 1000 to 32000, default 12000. The model names a Jev version, so that a tuned `closeCall` keeps its meaning; moving to a newer Jev is a roster edit. |

### Account bindings in version 2

- **A binding without `scope`** is personal, and keeps version 1's rules: its label must not name
  work or Positron.
- **`"scope": "work"`** binds the work account. Its label must name work or Positron, and for a
  Multi-Pass alias it must still match the label Multi-Pass stores. Each binding serves only its
  own scope's sessions: a personal session refuses a work binding, and a work session refuses a
  personal one.
- **Levels and accounts.** Validation refuses a model of a work-bound provider in a personal level,
  and anything but a work-bound Codex model in a work level: no OpenRouter, local or
  personal-account model.
- **The built-in `openai-codex-3/*` exclusion** holds in personal scope only. A work-scope session
  lifts it for a work level's model whose provider is bound as work. The roster's own exclusions
  are never lifted.
- **The classifier's model** must match no exclusion, built-in or the roster's own, and none is
  lifted for it, because Jev reads text from both scopes. So a roster with a classifier must not
  exclude `openrouter/*`. It needs no such exclusion: work levels hold only work-bound Codex models,
  and the work guard switches back an OpenRouter model picked by hand.

## Routing in detail

These are version 1's rules. Version 2 keeps them, comparing levels rather than roles, except where
[Levels](#levels) says otherwise.

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
- **A plan belongs to its message's run.** The router binds the two by a digest of the message's
  text, an HMAC-SHA-256 under a key each router instance draws at random, so it holds no prompt
  text. A run whose prompt is that message's text takes the plan; a run whose prompt is the text of
  another message it saw, whose own run has not started, takes none; and a custom message's run
  takes none. A prompt can match no message's text, because Pi expands a template or `/skill:`
  call after the input handlers, and a later extension can change the text: such a run takes the
  plan of the one idle message since the latest prompt's run started, and none when there were
  two. A run that drops a tagged message's plan says so. The limits:
  - identical texts cannot be told apart, so a run can take the plan of another message with the
    same text;
  - a message that a later extension holds, and whose prompt that extension also rewrites, matches
    no text, so its run can take the plan of the one idle message counted;
  - the router remembers the 64 latest messages whose runs have not started, so a message held while
    64 newer ones pass can do the same;
  - after a counted message that never starts its own run (one a later extension handles, an idle
    RPC steer or follow-up, a `prompt()` that throws), the next expanded or rewritten run goes
    unplanned and stays on the model the session used last.
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
  the transcript does not go to a new vendor; otherwise to the default role (under version 2, the
  session's scope's medium level), or to the local role under `smart-router/local` and the pin.
- **Thinking.** Both models offer every thinking level, so a `max` default is not clamped at
  selection. A role sends the session's level or its fixed `thinking`, and Pi clamps that to what the
  routed model supports.
- **Declared limits.** Pi and other extensions read a virtual model's context window and output
  budget before the first response. At every session start the router registers both models again:
  auto with the smallest window and output budget among the first available model of each role it
  can reach (under version 2, every level's role in both scopes, each resolved in its own scope),
  local with its first available local model's. Before that, both declare 128,000 and 16,384.

The router also tells pi-cache-optimizer, through its `pi.routing.registry.v1` registry, which
physical model each session's next request will use. Without that, the optimizer would rewrite
Codex system prompts, which Codex's content filter rejects, and would drop oMLX session-affinity
headers. Only the session's own agent loop changes what the optimizer reads, never a compaction or
another session.

## Levels

Under a version 2 roster, `smart-router/auto` sends each run that a prompt starts to one of four
levels of the session's scope. The meanings are the descriptions the example rosters give Jev:

| Level | Meaning |
|---|---|
| SUPER | Deep thought, research, design and planning |
| HIGH | Deep thought, review, and the design of verification |
| MEDIUM | Engineering, implementation and validation |
| LOW | Mechanical or trivial work that follows a clear specification |

The level is decided when the prompt arrives, by the first rule that applies:

1. **A tag:** the message's last whitespace-separated word, in any case, when it is `#super`,
   `#high`, `#medium` or `#low`, or `#s`, `#h`, `#m` or `#l`. The router removes it before any model
   sees the text. A tag always wins, at once, up or down: neither a hold nor the floor applies to
   it. `#high.`, `#hashtag` and `fix issue #12` are not tags.
2. **Jev**, when the roster has a classifier: its most probable level, or the higher of its two
   most probable when they are within `closeCall` of each other. See [Jev](#jev).
3. **The keywords**, when there is no classifier or Jev fails: the keyword classifier's planning
   signal goes to SUPER, complex to HIGH, default to MEDIUM and trivial to LOW.

**The floor.** An untagged run that names a risky operation goes to HIGH at least, whatever Jev
says: force push, `git reset --hard`, `rm -rf`, `git rm`, unstage, "clean up the repo" or "repo
cleanup", and "accidentally added", "mistakenly added" or "accidental add", with file names and
paths blanked out first. A tagged run is never raised.

Then the level goes through version 1's rules, comparing levels:

- **Holds.** An untagged run below the level of the model that answered last stays at that level
  until the session has been idle for `stickyIdleMinutes`, and longer while the conversation would
  not fit the lower level's first available model. A hold is a preference, not a floor: when the
  held level and every level above it have no available model, the run climbs from its own level.
- **The first available candidate.** Within the level's role, the run takes the first candidate in
  roster order that can take the request, not the model that answered last, so a level returns to
  its first model (Codex, on John's rosters) as soon as that model is available again. That costs
  one prompt-cache miss, which the run's record notes.
- **Step-ups.** A level whose role has no available model, or whose first available model is too
  small for the conversation, passes the run up to the next level, and a notice names the level the
  pick started at: "no LOW model can take this run, so it goes to MEDIUM (gpt-6.1-terra)". When no
  level's first available model fits, the highest level with one takes the run: as in version 1,
  fit alone never refuses a run, and Pi compacts. A run is refused only when neither its level nor
  any above it has an available model.
- **No fallbacks.** Version 2 declares none. Cooldowns and retries work within a level's role: a
  retry after a usage-limit or authentication error goes to the role's next model, never to another
  level.

**Tags elsewhere.** A message that is only a tag sends nothing, with a notice. A tag is removed
wherever it is typed, and where it cannot set its run's level a notice says it has no effect: in a
steer or follow-up typed while a run streams, whose model is fixed until the run ends; on
`smart-router/local`, under the pin or on a physical model; under a version 1 roster; and in a scope
that `smart-router/auto` refuses. An extension's resend of the latest message's text, as
pi-idle-check makes, keeps that message's level, from its tag or from Jev, and Jev is not asked
again.

**The footer** shows each run's scope, level, model and what decided the level, under a status key
of its own, `smart-router-level`, never the pin's: `personal HIGH → gpt-6.1-sol (jev 82%)`,
`work HIGH → gpt-6.1-sol (floor)`, `personal SUPER → gpt-6-astra (tag)`, or
`personal MEDIUM → gpt-6.1-terra (keywords; jev timeout)`. When a hold or a step-up takes the run to
another level than Jev's, the note names Jev's: `(jev LOW 80%)`. `/smart-router history` shows the
same on the run's first request, as `[work HIGH (floor)]`.

## Jev

Jev is TypeSafe AI's non-generative decision model, reached through OpenRouter. It takes a set of
labelled choices and returns one, with a probability for each. Under a version 2 roster with a
`classifier`, `smart-router/auto` asks it about each message typed while the session is idle:

- **Through Pi.** The router calls only `ctx.modelRegistry.findOfType("classifier", provider, id)`
  and `ctx.modelRegistry.classify(model, context, { timeoutMs, maxRetries: 0 })`. Pi's registry
  holds the credentials and makes the one HTTP attempt; the router reads no credential. A model the
  registry does not list as a classifier is unavailable, and nothing is sent.
- **One request per run.** An untagged run waits for the answer. A tagged run never waits: Jev's
  answer is only recorded, as an opinion for training.
- **The 1 s limit.** `timeoutMs`, 1000 ms by default and at most 1000, is pi-ai's timeout for that
  one attempt. The router sets no timer of its own, so the limit bounds the attempt, not the
  registry's credential lookup before it.
- **What it reads:** the message without its tag; up to `context.messages` (6) of the user and
  assistant messages before it on the branch, as text only, without tool calls, tool results, images
  or thinking, read through the bounded `getRecentActiveEntries`; and the four `describe` texts of
  the session's scope, as the criteria of the choices. Its one question asks how much model
  intelligence the message needs for the work it asks for now.
- **Redaction runs first**, in both scopes. Passwords in URLs become `[redacted]` first, in the text
  as written, where the backslash of a `DOMAIN\user` name (`CORP\tom`) is no escape. Then escaped
  line breaks and tabs (`\n`, `\r` and `\t`, as JSON writes them) become spaces, so that they end a
  value as the whitespace they stand for does. Then the other secret shapes become `[redacted]`:
  `Authorization` headers in any scheme, JWTs, private-key blocks, keys and tokens with a known
  prefix (`sk-`, `sk_live_`, `ghp_`, `github_pat_`, `glpat-`, `hf_`, `npm_`, `xoxb-`, `AIza`, `AKIA`
  and others), the value after a key or a flag whose name says secret, password, credential or
  token, or ends in key (`api_key=…`, `--password …`), and long mixed-case strings of 40 or more
  characters. Every pattern is linear in the text, so a huge paste cannot stall Pi. It is pattern
  matching: it catches the shapes it knows.
- **Then the caps.** The message keeps its first 16 KiB and last 4 KiB, as the keywords see it, then
  its head and tail within `totalChars` (12000); each earlier message keeps its last `messageChars`
  (1500) characters; and earlier messages are kept, newest first, only while the whole stays within
  `totalChars`.
- **Close calls go higher.** When Jev's two most probable levels are within `closeCall` (0.15) of
  each other, the run takes the higher one. The threshold is a starting point that training tunes.
- **Failures fall back to the keywords.** A classifier the registry does not have, an error (an
  OpenRouter refusal arrives as one), a timeout, an aborted request, or a malformed answer (a choice
  that is not one of the four levels, or probabilities that miss one or add another label) counts
  as a failure, and the keywords decide. The run's record names the failure, and so does the
  footer of a run the keywords decided.
- **Never asked** under the pin or `PI_SMART_ROUTER_LOCAL_ONLY`, on `smart-router/local` or a
  physical model, for a steer or follow-up, without a classifier, under a version 1 roster, in a
  session whose scope cannot be read or that the roster does not serve, for a message that is only
  a tag, or for an extension's resend of the latest message's text.
- **Where the text goes:** to OpenRouter, then to TypeSafe in the US. TypeSafe does not train on
  inputs, but it states no retention period. `/smart-router status` lists the classifier among what
  can still send data off the machine.

## Scope: personal or work

Every session has a scope, and version 2 routes it within that scope's levels, exclusions and
account bindings. The first rule that applies decides it:

1. **The latch.** `PI_SMART_ROUTER_SCOPE=work`, exactly, puts every session of the process in work
   scope. It is read each time the router loads; once seen, it holds for the life of the process,
   even if the variable is removed later. nix-config's shared-work profile is to set it.
2. **The session's entry.** `/smart-router scope work` and `/smart-router scope personal` record a
   `smart-router.scope` entry in the session, as the pin is recorded, and resume keeps it.
   - Personal to work takes effect at once, and outside the pin a selection outside work scope is
     switched to `smart-router/auto`.
   - Work to personal asks first and says that the earlier turns are work content; Enter keeps
     work scope. It is refused under the latch, and in modes without dialogs.
3. **The roster's work directories**, on every read. A session without an entry whose working
   directory lies under one is in work scope, whether it is new, resumed or running, so a roster
   edit that lists a running session's directory moves it at the next roster load (the next idle
   prompt, or `/smart-router status`, `scope` or `reload`). The first time this rule decides a
   session's scope, at its start, at its next idle prompt or when its next run starts, the router
   records a work entry, with a notice, so that the session stays in work scope whatever the roster
   says later. The working directory is Pi's `ctx.cwd`, compared as text on whole path segments:
   `/x/work` holds `/x/work` and `/x/work/a`, but not `/x/workshop`. Nothing is resolved, so a
   symlinked spelling of a work directory is not under it.
4. Otherwise **personal**.

A fork or `/new` carries the scope that the latch, an entry or the work directories gave into the
session it creates, which records it as an entry of its own, with a notice. The personal default is
not carried, so the new session decides its own, and neither is a scope that cannot be read.

**It fails closed.** A malformed `smart-router.scope` entry, a custom message of that type, or a
session whose entries cannot be read has an unreadable scope: `smart-router/auto` refuses until
`/smart-router scope work` or `/smart-router scope personal` records a scope again, and the work
guard holds the session.

**Where each scope's requests go.** Outside the pin, `smart-router/auto` never sends a personal
session to a work-bound account, and sends a work session only to a work-bound Codex account. Under
the pin, both scopes route only to the local role's models. A version 1 roster
serves no work scope: `smart-router/auto` refuses a work session, and the check every pick passes
refuses it again. A latched process whose roster has no work scope refuses every request on
`smart-router/auto`, and `/smart-router status` says why. Under the pin, `smart-router/local` serves
both scopes, since it carries no account; outside the pin, the work guard switches it back to
`smart-router/auto` in work scope. In personal scope, outside the pin, a model picked by hand is
sent as it is, a work-account model included: only work scope has a guard.

### The work guard

In work scope, outside the pin, the router keeps the selection on `smart-router/auto` or a model of
the work account, as the pin keeps it on local models. The work account is routing's own verdict: a
work-bound Codex provider whose binding passes the account check in work scope, Multi-Pass's label
included. Any other selection, `smart-router/local` and OpenRouter models among them, is switched
back to `smart-router/auto`, with a notice in work scope's words. The guard runs at every hook the
pin's guard does (a model selection, the prompt, `turn_start`, compaction and tree summaries, the
payload barrier, cache warming and session start), and it locks a session that something keeps
switching away.

- **The pin comes first.** While a session is pinned, only the pin's rules apply. Each lock records
  the policy that set it, and the other policy treats it as absent.
- **A failed reload widens nothing.** While the roster fails to load, the scope and the guard read
  the work directories and account bindings of the last valid roster loaded in the process, which
  the process slot keeps, and Multi-Pass's labels as last read. Before any roster has loaded there
  is no work account, so only `smart-router/auto` is allowed, and it refuses.
- **The way out** is `/smart-router scope personal`, which asks first and which the latch refuses.

### Limits and rollout

- A scope set by an entry is not inherited by subagent children (pi-subagents, goal-x auditors), or
  by forks made from the command line that skip `session_shutdown`. Run work in a work directory or
  in a latched process.
- **Rollout order.** Write the version 2 work roster before setting `PI_SMART_ROUTER_SCOPE=work`: a
  latched process with a version 1 roster, or with no roster loaded, sends nothing unless pinned.

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
in modes without dialogs and while the environment switch is on. In work scope, the question says
that the next requests can go only to the work account, and unpinning switches a selection outside
work scope to `smart-router/auto`, as the work guard would. `/smart-router local status` shows the
pin and what can still leave the machine.

- **Session-wide.** The pin belongs to the session file, every branch included. Resume keeps it.
- **Forks and `/new` carry it** into the session they create. Resuming an unpinned session after a
  pinned one shows a notice.
- **Selecting `smart-router/local` does not pin.** It routes locally; pinning is explicit.
- **`PI_SMART_ROUTER_LOCAL_ONLY`**, set to any non-blank value other than `0`, `false` or `off`,
  pins every session in the process, with the local section of the first valid roster, so no
  session of the process asks the classifier either. It is read each time the router loads; once
  seen, it stays on for the life of the process, even if the variable is removed later. Set it in a
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

While a session is pinned, the router asks no classifier, and a tag is removed with a notice that it
has no effect. Once the session is unpinned, Jev reads the recent conversation as it does for any
message, pinned turns included. In work scope, the pin replaces the work guard while it holds.

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

## Records and training

Each version 2 run on `smart-router/auto` that a prompt planned leaves one `smart-router.level`
entry in its session when it settles, however it ended. Its fields:

- `v`; `at`, when the run was planned; and `scope`;
- `source`, what decided the level: `tag`, `jev`, `keyword` or `floor`;
- `tier`, the level the run went to; `asked`, the level the tag, Jev or the keywords asked for; and
  `tag`, for a tagged run;
- `trigger`, the risky operation that raised the run to the floor;
- `keyword`, the keyword classifier's signal and reason;
- `jev`: Jev's model, choice, probabilities, confidence and latency (`ms`), or its failure. A tagged
  run whose answer had not come when it settled records `{ "late": true }`. It is absent when Jev
  was not asked;
- `ref`, the model of the run's last assistant message that ended without an error, absent when no
  model answered;
- `steppedUp`, `returnedToFirst` and `aborted`, when they apply.

A record holds no prompt text and no digest of it. It pairs with its run's first user message,
earlier in the same session; the run's steers and follow-ups can sit between them. That message
lacks the tag, which the record keeps.

`/smart-router was low|medium|high|super` labels a run with the level it should have had: the run in
flight, from its start until its record is written, and otherwise the latest record on the active
branch, never the level of a message whose run never started. It appends a record with source
`correction`, that level, and `refers`, the `at` of the run it names; a correction of a correction
names the same run. Nothing is sent again.

**Training** is an agent review, when John asks for one. An agent session on the host reads that
host's session files for these records and the user messages they pair with, reports per scope and
per level where John's tags and corrections disagree with Jev, and proposes revised `describe`
texts and a revised `closeCall` as a diff to that host's roster. Nothing changes until John
approves it. Records stay on the host that made them, and work records are read only there. The
router itself never reads other sessions and never writes the roster.

## Commands

| Command | Does |
|---|---|
| `/smart-router` or `/smart-router status` | The roster's path and state; the selection and its thinking level; the pin and any lock; the session's scope and what set it, under a version 2 roster or whenever `smart-router/auto` refuses the scope; every role's models on this host with `ok` or the reason they cannot route, and catalog prices; account bindings, checked in the session's scope, and auth sources; a version 1 roster's routing table and fallbacks, or a version 2 roster's levels in each scope and its classifier; the last decision; what can still leave the machine, the classifier first when `smart-router/auto` may ask it; and a warning for any fallback that would move a run onto Codex's API from another one. |
| `/smart-router history [n]` | The last `n` routing decisions (10 by default, at most 50), with reason codes, and on a version 2 run's first request its scope, level and what decided the level. Model ids and codes only, never prompt text. |
| `/smart-router local on`, `off`, `status` | The pin. |
| `/smart-router scope [work\|personal\|status]` | The session's scope and what set it: `latch`, `entry`, `directory` or `default`. `work` records work scope at once; `personal` asks first in work scope, and is refused under `PI_SMART_ROUTER_SCOPE=work`. |
| `/smart-router was low\|medium\|high\|super` | Record that the run in flight, or else the latest run, should have gone to that level. Nothing is sent again. |
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
  and `projectResources` off: each loads a second router into every audit. An auditor does not
  inherit a scope that an entry set ([Limits and rollout](#limits-and-rollout)).
- **pi-subagents**: foreground children inherit the selection but load the router only when it is
  registered for children, as nix-config's integration is meant to do; otherwise a child on
  `smart-router/*` fails with "model not found". Give children explicit models where that
  registration is absent. Children do not inherit a scope that an entry set either.
- **Multi-Pass**: its subscription-pool failover keys on the selected provider, so routed requests
  lose it; a role's next candidates and version 1's `routing.fallback` replace it. In a project
  whose `.pi/multi-pass.json` sets `allowedSubs`, list `smart-router` there, or Multi-Pass switches
  away from it.
- **pi-flag** reads the declared limits, which are real and recomputed at each session start.
- **pi-idle-check and hashline** key per-model settings on `smart-router/*`; configure them for those
  ids as you would for the models behind them. pi-idle-check's resend of a message keeps the level
  its tag or Jev gave it.
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

- **Per run:** choose another model with `/model`. In work scope, only `smart-router/auto` and the
  work account's models stay selected.
- **Per session:** `/smart-router local off` unpins after confirmation, and
  `/smart-router scope personal` moves a work session to personal scope after confirmation, except
  under the latch.
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
- The behaviour suite runs Pi 1.5's own runtime from npm with faux providers and a fake classifier,
  registered through pi-ai's provider `classifiers` hook, so no test asks Jev or any other real
  model. It runs only sandboxed: under `npm run check:sandbox`, or in the offline Nix build.
  `npm run check` leaves it out and says so.
- A source scan (`test/scan.test.ts`) holds `index.ts` and `src/` to the runtime rules, comments
  included: an import allow-list, no whole-history session reads, no dynamic code, no `fetch(` or
  `WebSocket`, and no timers (`setTimeout`, `setInterval`, `setImmediate`, `AbortSignal.timeout`).
- Never run Pi's own test suites on the host, and never start a real Pi session from a test.
- [AGENTS.md](AGENTS.md) holds the rules for coding agents.

## License

MIT; see [LICENSE](LICENSE). Copyright (c) 2026 beettlle and contributors, and Copyright (c) 2026
John Wiegley for the port. The triage engine and entropy check in `src/triage/` are upstream's,
unchanged but for one import specifier.
