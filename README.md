# pi-smart-router (jwiegley fork)

Two Pi virtual models, `smart-router/auto` and `smart-router/local`, that send each request to a
physical model chosen from a roster you keep on each host.

This is John Wiegley's fork of [beettlle/pi-smart-router](https://github.com/beettlle/pi-smart-router),
rewritten for the virtual models of Pi 1.5. It keeps upstream's deterministic prompt classifier and
nothing else; [CHANGELOG.md](CHANGELOG.md) lists what was removed and why. The port started from
upstream v1.3.0 (`f31b2304`). Version `1.4.0-jw.4` has upstream v1.4.0 (`54bee53d`) in its history
through a merge that keeps the port's tree, as an earlier one recorded upstream main at `58e87b59`:
everything upstream changed between v1.3.0 and v1.4.0 is in files the port had removed or
replaced, so none of it is in this code. It is not published to npm.

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
  through Pi; otherwise the keywords do. In a work session `smart-router/auto` routes only to the
  work Codex account, apart from Jev's request; a model picked by hand and extensions with models
  of their own are outside it ([What work scope does not cover](#what-work-scope-does-not-cover)).
  A scope may declare a fallback chain: models that take a run, in a fixed order, when its level's
  own models cannot. See [Levels](#levels), [A fallback chain](#a-fallback-chain), [Jev](#jev) and
  [Scope](#scope-personal-or-work).
- **Easy to change, cheap to get wrong.** Which model serves which level, the fallback chain, the
  local set and the texts Jev reads are each one edit in one place, a running session picks the
  edit up at its next prompt, and `/smart-router check` or `node src/check-cli.ts` reads the result
  back before anything is sent. See [Changing the routing](#changing-the-routing).
- **`smart-router/local`** routes only to the roster's local role, and never falls back to anything
  else. If no local model can take the request, it is refused. It does so in personal scope, in
  work scope and in a session whose scope cannot be read alike, pinned or not: selecting it is the
  request for local routing.
- **The local-only pin** (`/smart-router local on`) keeps the router's two models on local models
  until you unpin it: `smart-router/local` routes to the local role, and `smart-router/auto` routes
  only inside the pin's policy. See [The local-only pin](#the-local-only-pin).
- **A model picked by hand always stays selected.** The router routes only while the selection is
  `smart-router/auto` or `smart-router/local`. A model you choose with `/model` or by cycling is
  sent as it is, in work scope and under the pin too: the router does not switch it back, refuse
  its prompts, cancel its compactions or touch its requests. See
  [A model picked by hand](#a-model-picked-by-hand).
- **Every refusal says "Nothing was sent."** A refusal names the virtual model, gives the cause in
  the router's own words and says how to get out. Pi never retries a refusal.

The router opens no network connection of its own and sets no timer. When a version 2 roster
has a classifier, it asks Pi's model registry for one classifier request per routed run on
smart-router/auto, with a per-attempt timeout and no retries. It never does so under the pin, on
smart-router/local, for a steer or follow-up, or without a classifier.

It also starts no process, writes no file of its own and keeps no prompt text; its session entries
(the pin's, the scope's and the level records) are written by Pi, into the session. It reads
only files under Pi's agent directory: the roster, Multi-Pass's subscription labels when the
roster binds a Multi-Pass account, and the prompt files the roster names in `smart-router/`
([Jev's prompts](#jevs-prompts)). It reads no file relative to the working directory or a
project; it only compares the working directory, as text, with the roster's work directories. The
one project-influenced value it uses is the compaction reserve in Pi's settings, which Pi merges
with a project's `.pi/settings.json`; it only affects whether stickiness may move a run down to a
smaller role. It has no runtime dependency and no native code; Pi supplies
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.

It needs jwiegley/pi 1.5.0 or later, whose bounded session reads let it look at a session without
loading its whole history. Upstream Pi 1.5.0 lacks those reads, so there the router fails closed: it
cannot read a session's pin, counts every session as pinned, and both of its models refuse every
request for as long as it is loaded. Do not load it on upstream Pi.

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
  routing to a model you just removed. Only the scope keeps something of the last valid roster: its
  work directories, so that a broken edit cannot move a work session to personal scope.
- **Check before you rely on it.** `/smart-router check` in a session, or
  `node src/check-cli.ts <roster.json>` anywhere, reads the roster back: what each selection and
  scope routes to, in order, or the first error and its place. See
  [Checking a roster](#checking-a-roster).
- **It reloads without a restart:** at session start, at each idle prompt when the file changed,
  and on `/smart-router status`, `check`, `scope` and `reload`. A running session routes its next
  prompt by the roster as it is then; the run under way keeps the model it has.
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
| `cooldownMinutes` | no | 1 to 1440, default 30. How long a usage-limit or authentication error takes a model out of routing, and with it every model of the same subscription account. |
| `unreachableMinutes` | no | 1 to 60, default 5. How long a local model whose server could not be reached is passed over while another model can take the request. |

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
- **The local section** keeps Nyx, so Nyx's Qwen counts as local although the pin routes only to
  GLM: `/smart-router local on` leaves it selected when it was picked by hand, and the pin's status
  item shows over it.

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

### A fallback chain

A scope may say what takes a run when its level's own models cannot: `"fallback"`, a list of roles
in the order to try them. This roster is John's routing of 2026-11-17 for Hera: on a personal
session `smart-router/auto` uses astra, sol, terra or luna by difficulty; when the Codex account
has no tokens left, OpenRouter's GLM-5.3-Flash and then its Qwen3.8; then GLM-5.3-Flash on Hera,
Qwen3.8 on Nyx and Qwen3.8 on Hera. `smart-router/local` uses only those last three. A work
session uses only the work account.

```json
{
  "version": 2,
  "$comment": "Hera, version 2, with John's routing of 2026-11-17. Personal levels take one Codex model each, on openai-codex-2 (John's personal ChatGPT account, labelled 'personal' in Multi-Pass). When a level's model cannot take a request, every level falls back along one chain: OpenRouter's GLM and Qwen, then the local models. Work levels take only openai-codex-3, the work account, and declare no fallback. Plain openai-codex is excluded here because Hera reserves it for the work account.",
  "exclude": ["openai-codex/*"],
  "roles": [
    { "name": "local", "$comment": "smart-router/local and the pin, in this order; also the end of the personal fallback chain. Nyx's ref is a Nix-store basename that changes whenever its model is rebuilt", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp", "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad", "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp"], "thinking": "max" },
    { "name": "openrouter", "$comment": "the start of the personal fallback chain: another vendor, on another quota", "models": ["openrouter/z-ai/glm-5.3-flash", "openrouter/qwen/qwen3.8-27b"] },
    { "name": "low", "models": ["openai-codex-2/gpt-6-luna"] },
    { "name": "medium", "models": ["openai-codex-2/gpt-6.1-terra"] },
    { "name": "high", "models": ["openai-codex-2/gpt-6.1-sol"] },
    { "name": "super", "models": ["openai-codex-2/gpt-6-astra"] },
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
      },
      "fallback": ["openrouter", "local"]
    },
    "work": {
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

`node src/check-cli.ts` reads it back as:

```text
smart-router/auto in personal scope: a tag, else Jev (openrouter/typesafe/jev-1.14), else the keywords, pick the level; each level tries its own models in order:
  LOW    openai-codex-2/gpt-6-luna  (role low)
  MEDIUM openai-codex-2/gpt-6.1-terra  (role medium)
  HIGH   openai-codex-2/gpt-6.1-sol  (role high)
  SUPER  openai-codex-2/gpt-6-astra  (role super)
  then, for every level, when its own models cannot take a request, the fallback chain in this order:
    1. openrouter/z-ai/glm-5.3-flash  (role openrouter)
    2. openrouter/qwen/qwen3.8-27b  (role openrouter)
    3. omlx-hera/GLM-5.3-Flash-oQ4e-mtp  (role local, thinking max)
    4. nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad  (role local, thinking max)
    5. omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp  (role local, thinking max)
  under the pin: only the local role local, in its own order (below)
```

How the chain works:

- **A level's own models come first, always.** The chain is tried only when none of them can take
  the request: not in the catalog, not available, no credentials, a refused account binding, or
  cooling down after a usage-limit or authentication error.
- **The order is the order written:** each role of the list in turn, and within a role its models
  in turn. A model that cannot take the request is passed over by the same checks as any other.
- **One chain serves every level of its scope.** A run keeps its level while any chain model can
  take it: the level takes the chain before it passes the run up, so a LOW run that falls back is
  still recorded as LOW, with `fallback` in its record. Only when the chain's models are too small
  for the conversation, or none can take the request, does the run step up
  ([Levels](#levels)).
- **The first request that hits a usage limit fails.** Pi retries some errors and asks the router
  where the retry goes; it does not retry Codex's "You have hit your ChatGPT usage limit (plus
  plan). Try again in ~N min.", nor a spent credit. So that one run ends unanswered. The router
  says so at that moment and tells you what to do: "gpt-6-luna could not take this run (the
  account openai-codex-2 is out of use until 14:42), and nothing was answered. Send the request
  again: it goes to the fallback openrouter (z-ai/glm-5.3-flash)." Send it again, and it does.
  A run that had already answered or run tools before the limit is told otherwise: "it stopped
  partway. What it did so far stands: do not send the request again. To go on, say: continue. It
  goes on with the fallback openrouter (…)." When nothing else can take the request, the notice
  says when the account is back; in a work session it does not offer another work Codex model,
  which is on the same account, and says that another model picked by hand is sent as it is.
  That failed run is the whole cost of a cooldown window: the account cools as one, for the time
  the error names, so every level's next run goes straight to the chain.
  The router does not send the request again itself. Pi 1.5.2 has a hook that could
  (`agent_before_settle`), and it was built and removed: in Pi's own runtime, merely registering
  it stopped the cache warming Pi wanted, and it makes Pi rebuild a session's context at the end
  of every run.
- **The session returns to the level's own model** as soon as it can take requests again: each new
  run starts from its level's first model, and so does the first request of a run that starts
  without a prompt, such as a goal continuation or a loop's, in a resumed session too, which
  takes its level from its latest level record. A run under way stays on the model it has. A cooled account is tried again when its time is up; if it is still out of tokens, that one
  request fails and the account cools again.
- **The session keeps its level meanwhile.** A chain model stands for the level the session held:
  a session at SUPER whose account ran out stays at SUPER for a trivial follow-up inside the
  sticky window, as it would on astra, and is at SUPER when astra returns.
- **A retry never goes back.** When a chain model itself fails with a limit, or a local one cannot
  be reached, the retry takes another model of the same role, then the roles after it in the chain,
  never an earlier role and never the level's own, and no model twice in one run.
- **A chain belongs to the scope that declares it.** Here the work scope declares none, so a work
  session behaves exactly as before: its levels' own work-account models, a step up, or a refusal.
- **Validation keeps each scope's account rules.** No role of a chain is a level's role, in either
  scope, and no role is in two chains. A personal chain takes no model of a work-bound provider. A
  work chain takes only work-bound Codex models: no OpenRouter, local or personal-account model can
  be named there. A model still sits in exactly one role, so a chain cannot repeat a level's model.
- **The local role may end a chain.** That is the one way `smart-router/auto` reaches the local
  models. Under the pin, `smart-router/auto` in that scope then routes to the local role, in the
  role's own order and inside the pin's policy, and the chain's cloud roles are not used.
  `smart-router/local` never uses a chain: it routes to the local role alone, as before.
- **It says so.** A run planned onto a chain model shows a notice, "no LOW model can take this
  run, so it goes to the fallback openrouter (z-ai/glm-5.3-flash)"; a run under way that moves
  onto one says "gpt-6-astra can no longer take this run, so it goes on with the fallback
  openrouter (z-ai/glm-5.3-flash)"; and the footer marks it:
  `personal LOW → z-ai/glm-5.3-flash (jev 80%; fallback)`. `/smart-router status` lists each
  scope's chain with every model's verdict, and says when the last request went to one.

> **A fallback sends the conversation somewhere else.** When the chain takes a run, the whole
> conversation so far, not only the new message, goes to that role's vendor: here to OpenRouter and
> the provider behind the model, under their retention terms, and then to the LAN models on Hera
> and Nyx. Delete the `fallback` line, or the roles you do not want, to be refused or stepped up
> instead. A work scope's chain can only name the work account, so work conversations cannot reach
> a personal account, OpenRouter or a LAN model through one.

Three things to know:

- **A local server that is down gives way.** When Nyx cannot be reached, the request goes to
  Hera's Qwen, and Nyx is passed over for `unreachableMinutes`, 5 by default
  ([Routing in detail](#routing-in-detail)). A hold is a preference: when Hera's Qwen cannot take
  the request either, Nyx is tried again rather than the request refused. A server that accepts
  the connection and then answers slowly or not at all is not passed over: a timeout, a 503 while
  a model loads and a 504 retry the same model.
- **The whole Codex account cools together.** The four personal levels share one ChatGPT account,
  so a usage limit on any of them sends every level to the chain until the account's time is up.
  In work scope, which has no chain, a limit on one work model refuses the other work levels for
  that time; the refusal says when the account is tried again, and that another model picked by
  hand is sent as it is.
- **The local role has one `thinking` setting**, so the three local models share it.

### Fields in version 2

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Exactly `2`. |
| `$comment`, `exclude`, `roles`, `accounts`, `local`, `stickyIdleMinutes`, `cooldownMinutes`, `unreachableMinutes` | as in version 1 | As in [version 1](#fields), with the rules below. There is no `routing`: the levels replace it, and a scope's `fallback` replaces `routing.fallback`. |
| `scopes` | yes | `personal`, `work` or both. `smart-router/auto` refuses a session in a scope the roster does not have. |
| `scopes.<scope>.levels` | yes | `low`, `medium`, `high` and `super`, each `{ "role": "<role>", "describe": "<text>" }`: the role the level's runs go to, and the description Jev reads, a non-empty text of at most 2000 characters. `"describeFile": "<name>"` in place of `describe` takes the text from a prompt file ([Jev's prompts](#jevs-prompts)); a level gives exactly one of the two. No role serves two levels, in one scope or across both, the local role serves none, and a scope's level roles rank up the ladder from low to super. |
| `scopes.<scope>.fallback` | no | Role names, in the order to try them after any level's own models ([A fallback chain](#a-fallback-chain)): not empty, none twice, none a level's role in either scope, none in both scopes' chains. The local role may be one. A personal chain takes no work-bound model; a work chain takes only work-bound Codex models. Without the field, the scope has no fallback. |
| `scopes.work.directories` | no | Absolute paths whose sessions are in work scope ([Scope](#scope-personal-or-work)), written plainly: no trailing `/`, no empty, `.` or `..` segment, and not `/` itself. |
| `accounts.<provider>.scope` | no | `"personal"`, the default, or `"work"`. |
| `classifier` | no | Jev's settings; without them, Jev is never asked. `model`, an exact ref, default `openrouter/typesafe/jev-1.14`; `timeoutMs`, 100 to 1000, default 1000; `closeCall`, 0 to 0.5, default 0.15; and `context`: `messages`, 0 to 20, default 6; `messageChars`, 200 to 8000, default 1500; `totalChars`, 1000 to 32000, default 12000. The model names a Jev version, so that a tuned `closeCall` keeps its meaning; moving to a newer Jev is a roster edit. `instructions`, the question Jev is asked, as a text of at most 4000 characters, or `instructionsFile`, the name of a prompt file that holds it; not both, and with neither the built-in question is asked ([Jev's prompts](#jevs-prompts)). |

### Account bindings in version 2

- **A binding without `scope`** is personal, and keeps version 1's rules: its label must not name
  work or Positron.
- **`"scope": "work"`** binds the work account. Its label must name work or Positron, and for a
  Multi-Pass alias it must still match the label Multi-Pass stores. Each binding serves only its
  own scope's sessions: a personal session refuses a work binding, and a work session refuses a
  personal one.
- **Levels, chains and accounts.** Validation refuses a model of a work-bound provider in a personal
  level or a personal fallback chain, and anything but a work-bound Codex model in a work level or a
  work chain: no OpenRouter, local or personal-account model.
- **The built-in `openai-codex-3/*` exclusion** holds in personal scope only. A work-scope session
  lifts it for a model of a work level or a work chain whose provider is bound as work. The roster's own exclusions
  are never lifted.
- **The classifier's model** must match no exclusion, built-in or the roster's own, and none is
  lifted for it, because Jev reads text from both scopes. So a roster with a classifier must not
  exclude `openrouter/*`. It needs no such exclusion: work levels hold only work-bound Codex models.
  An exclusion binds the router's routes only: a model picked by hand is sent as it is.

## Changing the routing

Every decision has one place in the roster, `~/.config/pi/agent/smart-router.json`. Edit it, run
the check, and the next prompt of every running session uses it: no restart, no rebuild.

| To change | Edit |
|---|---|
| The model a level uses | The `models` of that level's role in `roles`. `scopes.<scope>.levels.<level>.role` names the role; the first model listed is the one used, the rest are tried after it. |
| What takes over when a level's model cannot | `scopes.<scope>.fallback`: the roles, in order. Each role's own `models` order is the order inside it. |
| The local set, for `smart-router/local` and the pin | The `models` of the local role, in order. A new server also needs its provider in `local.providers` and its host in `local.hosts`. |
| A work session's models | The `work-*` roles, which take only the work Codex account. |
| What a level means to Jev | That level's `describe`, or the file its `describeFile` names. |
| How Jev judges a message | `classifier.instructions`, or the file `classifier.instructionsFile` names. |
| How readily a close call goes to the higher level | `classifier.closeCall`. |
| How long an exhausted account is left alone | `cooldownMinutes` (30). |
| How long a local server that could not be reached is passed over | `unreachableMinutes` (5). |

Roles are named, rather than a level listing its models inline, because the role is what a model
has exactly one of: it gives the model its `thinking`, its place on the ladder, its line in
`status`, and, for the local role, its membership of the pin's policy. A level and
a fallback chain only point at roles, so swapping a model is still one edit, in `roles`.

**Swap a level's model.** Move HIGH to a newer sol:

```diff
-    { "name": "high", "models": ["openai-codex-2/gpt-6.1-sol"] },
+    { "name": "high", "models": ["openai-codex-2/gpt-6.2-sol"] },
```

**Add a fallback, or reorder the chain.** Put Kimi ahead of the others, and try the local models
before OpenRouter:

```diff
-    { "name": "openrouter", "models": ["openrouter/z-ai/glm-5.3-flash", "openrouter/qwen/qwen3.8-27b"] },
+    { "name": "openrouter", "models": ["openrouter/moonshotai/kimi-k3.1-pro", "openrouter/z-ai/glm-5.3-flash", "openrouter/qwen/qwen3.8-27b"] },
```

```diff
-      "fallback": ["openrouter", "local"]
+      "fallback": ["local", "openrouter"]
```

With `local` first, OpenRouter is reached only when no local model can take the request: a
local-role model is never cooled, so it is passed over only while Pi does not offer it, and a
held one is tried again when nothing else is left. Deleting the `fallback` line removes the
chain; deleting `"local"` from it keeps `smart-router/auto` off the LAN models.

**Change the local set.** Drop Nyx, and prefer Hera's Qwen to its GLM:

```diff
-    { "name": "local", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp", "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad", "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp"], "thinking": "max" },
+    { "name": "local", "models": ["omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp", "omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "thinking": "max" },
```

The same edit changes the end of any chain that names `local`. A session pinned earlier keeps the
local set it was pinned with until `/smart-router local on` is run again.

**Sharpen a level's description.** In the roster:

```diff
-        "high": { "role": "high", "describe": "Deep thought, review, and the design of verification" },
+        "high": { "role": "high", "describe": "Code review, debugging that crosses modules, concurrency, and designing tests or proofs" },
```

or, once the level names a file (`"describeFile": "personal-high.md"`), by editing
`~/.config/pi/agent/smart-router/personal-high.md` alone ([Jev's prompts](#jevs-prompts)).

A model belongs to one role. To use a model in two places, that is what a fallback chain is for;
listing it in two roles is the error `"<model>" is already in role "<role>"`.

### Checking a roster

```sh
node /path/to/pi-smart-router/src/check-cli.ts ~/.config/pi/agent/smart-router.json
```

or `/smart-router check` in a session. Both use the router's own parser. A valid roster is read
back in plain language: for `smart-router/auto` in each scope, each level's models, the fallback
chain in order and what the pin leaves; for `smart-router/local`, the local models in order; where
each of Jev's prompts comes from; and the account bindings. An invalid one gives the first error
with its place, such as
`INVALID: roles[3].models[1]: "omlx-hera/GLM-5.3-Flash-oQ4e-mtp" is already in role "local"`.

- **The standalone checker needs no Pi, no session and no credentials,** and sends nothing. It
  reads the file it is given, with the owner and mode checks the router applies, and that roster's
  prompt files from the `smart-router/` directory beside it, so check a candidate roster where its
  prompt files are. Exit status: 0 valid, 1 a roster the router would refuse or a prompt it could
  not use, 2 a wrong invocation.
- **It runs from the installed package.** It needs Node 22.19 or later, the package's own floor,
  and a path that is not under a `node_modules` directory, where Node does not run TypeScript.
  nix-config installs the package under `share/pi-packages/pi-smart-router/`, which is not, so
  `node <that>/src/check-cli.ts` checks with the installed version's own parser. No built
  JavaScript copy is shipped: it would be a second parser to keep equal to the first.
- **A roster in the Nix store** is root's, and the checker reports it as the router would:
  `UNSAFE: … is owned by uid 0`. For a build-time check, pass `--no-owner-check` before the path.
  The flag is the checker's alone, the report says the owner was not checked, and a file others
  can write is still unsafe. The router itself always requires a file you own.
- **It reads the roster, not the host.** Whether Pi's catalog on a host lists a model, and whether
  it has credentials, is for `/smart-router status` there: a model Pi does not list is passed over
  at run time as `not-in-catalog`.
- **An invalid roster still makes both models refuse everything.** That is deliberate: a last
  valid copy kept in use would keep sending to a model or an account the edit had just removed.
  The check is the remedy: run it before relying on an edit.

**One roster per host.** The hosts differ in more than names: on Hera, `openai-codex-2` is the
personal account and plain `openai-codex` is the work one, while on the others plain `openai-codex`
is the personal one, so one text for all would bind the wrong account somewhere; and the Nyx ref
changes per rebuild. Keep the per-host files, and keep their `scopes`, `fallback` and prompt files
alike.

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
    unplanned and stays on the model the session used last;
  - a message that a later extension rewrites into the text of a message still held goes unplanned,
    but its run makes the router forget the held one, whose own run can then take the plan of the
    one idle message counted.
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
- **Whose limit it is.** A limit-kind error is one of three things, and cools accordingly:
  - *The account's:* a usage limit, a quota, billing, or a credential that was not accepted (401).
    On a subscription provider (`openai-codex`, `anthropic`, `github-copilot`, or a Multi-Pass
    alias such as `openai-codex-2`) it cools every model of that provider id at once, since they
    share one account and one credential. So when luna runs out of tokens, the next run of any
    level goes straight to the fallback chain without first failing on terra, sol or astra. On any
    other provider it cools the one model: the text cannot tell an account-wide limit from a limit
    on one model, and OpenRouter has both.
  - *The account's money:* spent credit (402, "payment required", "insufficient credits",
    "requires more credits"). It cools every model of the provider id, whatever the provider:
    credit is the account's by its nature. With Codex cooled and OpenRouter out of credit, the
    chain goes on to the local models.
  - *The model's own:* a model that is not found, and a 403, which providers also give for one
    model an account may not use. It cools that model alone.

  A provider id is one account: the work account's cooldown never touches the personal account's
  models, nor the other way round. `/smart-router status` shows one `Cooling:` line for an
  account, however many of its models wait. Whether an error is the account's is decided by an
  account error's own words ("usage limit", "insufficient_quota", "quota exceeded", "billing
  details", "unauthorized", "authentication_error") or by 401 or 402 where the error text
  begins, so a number or a word inside an unrelated error, such as a tool result quoted back,
  cools no account. A model picked by hand that fails with such an error cools its account for
  the router's own picks too: the account is out of use whoever asked.
- **How long.** A limit that names its wait ("Try again in ~42 min", "2 hours 30 min") cools for
  that long, at least a minute and at most a day; any other cools for `cooldownMinutes`. When the
  time is up, the first run tries its level's own model again.
- **A rate limit moves nothing.** A 429, "rate limit" or "too many requests" is a throttle, not
  an account out of tokens: Pi backs off and retries the same model, and the router lets it. It
  cools nothing, holds nothing and triggers no fallback, so a run that ends on one leaves the next
  run on the same model. (A 429 whose text is a usage limit or a quota is the account's, above.)
- **A local server that cannot be reached is passed over.** When a request to a local model (one
  of `local.providers` on one of `local.hosts`) fails before any output because a connection to
  its server could not be made, the model is held for `unreachableMinutes`, and the retry goes to
  the model written after it that is not held, round its role once, and then on along the
  fallback chain. The runs that follow pass a held model over in the same way. This applies to
  local-role models too, which are never cooled. It never leaves what the selection may use:
  `smart-router/local` and the pin stay in the local role and its policy. `status` shows a held
  model as `unreachable-until-HH:MM`, with an `Unreachable:` line.
  - *A hold is a preference, never a refusal.* When every candidate that could take the request
    is held, the hold gives way: a retry stays on the model it has, under Pi's backoff, as it
    always did, so a server that is restarting is ridden out; a new run takes the first held
    model in the written order. With one local model, a blip changes nothing. An answer from a
    held model lifts its hold at once.
  - *Unreachable* means the connection could not be made: refused or reset (`ECONNREFUSED`,
    `ECONNRESET`, "reset before headers"); the name did not resolve (`ENOTFOUND`, `EAI_AGAIN`,
    `getaddrinfo`); no route (`EHOSTUNREACH`, `ENETUNREACH`, `EHOSTDOWN`); the connect timed out
    (`connect ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, "connect timeout"); the SDK's "connection
    error", "network error" or "fetch failed", "socket hang up", "other side closed", a closed
    socket; a TLS handshake or certificate verification that failed (unable to verify, self-signed,
    expired, name mismatch); or 502, "bad gateway".
  - *Not unreachable,* because the server may be there and slow, loading or busy: a request or a
    read that timed out (a bare `ETIMEDOUT`, "timed out", 504, "gateway time-out"), 503 and
    "service unavailable", 500, a stream cut off, a rate limit, "overloaded", and a text that
    merely mentions a certificate. Those retry the same model. Hera's models answer behind HTTPS,
    where a long cold prefill can trip the proxy's timeout; that must not move a session to Nyx
    and back.
  - *Not after output has started.* A failure of a response that already carries text, thinking or
    a tool call retries the same model, as every such failure always has; a half-answered request
    is never sent on to another model.
  - *Not for cloud models.* A cloud model's connection failure, the SDK's generic "Connection
    error." included, retries the same model under Pi's backoff, so a network blip does not send
    the conversation to another vendor.
  - *Five minutes by default.* A server that is restarting or loading a model takes minutes, and
    a session that moved to the other host has paid a cold prefill there, so moving back at once,
    and again at the next hiccup, would pay it twice more. Five minutes bounds that to one move
    each way per outage, and puts the preferred server back in use soon after it returns.
- **Cooldowns and holds are per session.** Each router instance keeps its own, in memory: another
  session finds an exhausted account or a dead server out for itself, with one failed request,
  and a restarted session starts with none.
- **Retries.** When Pi retries a failed request, a limit-kind failure moves to the role's next model
  and then its fallback, skipping every model that failed with a limit earlier in the same run, so
  a run tries each candidate once; a local server that could not be reached gives way as above; any
  other failure, rate limits and context overflows included, retries the same model, because Pi has
  already backed off or compacted. Pi does not retry every error: see
  [A fallback chain](#a-fallback-chain) for what a usage limit costs.
- **Compaction and other summaries** go to the model that answered last when it may take them, so
  the transcript does not go to a new vendor; otherwise to the default role (under version 2, the
  session's scope's medium level), or to the local role under `smart-router/local` and the pin.
- **Thinking.** Both models offer every thinking level, so a `max` default is not clamped at
  selection. A role sends the session's level or its fixed `thinking`, and Pi clamps that to what the
  routed model supports.
- **Declared limits.** Pi and other extensions read a virtual model's context window and output
  budget before the first response. At every session start the router registers both models again:
  auto with the smallest window and output budget among the first available model of each role it
  can reach (under version 2, every level's role and every fallback chain's role in both scopes,
  each resolved in its own scope),
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
  While a fallback chain's model is answering, it stands for the level the session's last planned
  run took.
- **The first available candidate.** Within the level's role, the run takes the first candidate in
  roster order that can take the request, not the model that answered last, so a level returns to
  its first model (Codex, on John's rosters) as soon as that model is available again. That costs
  one prompt-cache miss, which the run's record notes.
- **Step-ups.** A level with no available model, among its own and then its scope's fallback
  chain, or whose first available model is too small for the conversation, passes the run up to
  the next level, and a notice names the level the
  pick started at: "no LOW model can take this run, so it goes to MEDIUM (gpt-6.1-terra)". When no
  level's first available model fits, the highest level with one takes the run: as in version 1,
  fit alone never refuses a run, and Pi compacts. A run is refused only when neither its level nor
  any above it has an available model.
- **Fallbacks are the scope's chain, if it declares one**
  ([A fallback chain](#a-fallback-chain)). Without one, cooldowns and retries work within a level's
  role: a retry after a usage-limit or authentication error goes to the role's next model, and is
  refused when there is none. With one, it goes on down the chain. A retry never goes to another
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
  or thinking, read through the bounded `getRecentActiveEntries`; the four descriptions of the
  session's scope, as the criteria of the choices; and its one question, the instructions, which by
  default asks how much model intelligence the message needs for the work it asks for now. The
  instructions and the descriptions are yours to edit: see [Jev's prompts](#jevs-prompts).
- **Redaction runs first**, in both scopes: the message and the earlier messages go through
  `src/redact.ts` before any cap. [What redaction hides](#what-redaction-hides) names the kinds of
  secret it looks for, with tested examples and its known gaps.
- **Then the caps.** The message keeps its first 16 KiB and last 4 KiB, as the keywords see it, then
  its head and tail within `totalChars` (12000); each earlier message keeps its last `messageChars`
  (1500) characters; and earlier messages are kept, newest first, only while the whole stays within
  `totalChars`.
- **Close calls go higher.** When Jev's two most probable levels are within `closeCall` (0.15) of
  each other, the run takes the higher one. The threshold is a starting point that training tunes.
- **Failures fall back to the keywords.** A classifier the registry does not have, an error (an
  OpenRouter refusal arrives as one), a timeout, an aborted request, a malformed answer (a choice
  that is not one of the four levels, or probabilities that miss one or add another label), or a
  prompt file that cannot be used (`prompt`; then nothing is sent to Jev) counts as a failure, and
  the keywords decide. The run's record names the failure, and so does the
  footer of a run the keywords decided.
- **Never asked** under the pin or `PI_SMART_ROUTER_LOCAL_ONLY`, on `smart-router/local` or a
  physical model, for a steer or follow-up, without a classifier, under a version 1 roster, in a
  session whose scope cannot be read or that the roster does not serve, for a message that is only
  a tag, or for an extension's resend of the latest message's text.
- **Where the text goes:** to OpenRouter, then to TypeSafe in the US. TypeSafe does not train on
  inputs, but it states no retention period. `/smart-router status` lists the classifier among what
  can still send data off the machine.

### Jev's prompts

What Jev is told is two kinds of text, and both are yours to change without touching code:

- **The instructions:** the one question asked about every message, in every scope. Built in:
  "How much model intelligence does `message` need for the work it asks for now? `recent` holds the
  conversation just before it, oldest first." Replace it with `classifier.instructions` (a string
  in the roster) or `classifier.instructionsFile` (a file's name). With neither, the built-in
  question is asked and the request is exactly what it was before 1.4.0-jw.4.
- **The level descriptions:** per scope, what kind of work belongs at each level, and so which
  model gets it. Each level gives `describe` (a string in the roster, as before) or `describeFile`
  (a file's name).

**Prompt files** are plain text or Markdown in `<agentDir>/smart-router/`, which is
`~/.config/pi/agent/smart-router/` on John's hosts. The roster names each by a plain lower-case
name ending in `.md` or `.txt`, with no directory part:

```json
"classifier": { "model": "openrouter/typesafe/jev-1.14", "instructionsFile": "classifier.md" },
"scopes": { "personal": { "levels": {
  "low":    { "role": "low",    "describeFile": "personal-low.md" },
  "medium": { "role": "medium", "describe": "Engineering, implementation and validation" }
} } }
```

- **Files rather than long JSON strings,** because prose is iterated on: a file has line breaks,
  needs no escaping and diffs cleanly. The roster points at each file, rather than a fixed file
  name being picked up when present, so that the roster and the checker always say which text is
  in force, and a stray or forgotten file changes nothing.
- **What is sent** is the file's text without HTML comments (`<!-- … -->`, your notes) and without
  surrounding blank space. Jev reads the rest as it is written.
- **Limits:** the instructions at most 4000 characters, a level description at most 2000, a file
  at most 16 KiB of plain UTF-8 text, with no control characters.
- **A prompt file must be yours:** a regular file you own, writable by no one else, in
  `<agentDir>/smart-router/`, by the roster's own rules. A link is followed to its target, which
  must pass the same checks, so a link into `/nix/store`, whose files are root's, is refused as
  unsafe: keep prompt files as real files you edit.
- **Prompts are redacted like messages.** The instructions and the descriptions go through the
  same redaction as the message before Jev reads them
  ([What redaction hides](#what-redaction-hides)), so a prompt file that is, or links to, something
  else of yours does not send its secrets. Write prompts in prose: a `key: value` line whose key
  marks a secret loses its value.
- **Edits take effect** at the next idle prompt of a running session, as roster edits do.
- **A file that cannot be used** (missing, unsafe, empty, too long, not text, an unclosed comment,
  or one that still holds a `{{placeholder}}` or a line starting with `TODO`) stops no route. Jev is not
  asked in the scopes that need that file, the keywords decide their levels, the footer shows
  `(keywords; jev prompt)`, the session says so once when it starts, and `/smart-router status`
  and the checker name the file and the cause. The router never falls back to an older text.
- **`/smart-router status`** shows the source of every prompt in force: `built-in`,
  `inline in the roster`, or `file <path>`, with its length.

**You edit guidance, not the protocol.** These stay fixed in code, whatever a prompt says:

- the request has one question, a choice among exactly `low`, `medium`, `high` and `super`;
- an answer counts only when it names one of those four and gives a probability for each;
  anything else is discarded as malformed and the keywords decide;
- the level is routed within the session's scope, by that scope's levels, account bindings and
  exclusions; a prompt cannot name a model, change the scope or lift the pin, and under the pin Jev
  is not asked at all;
- redaction, the size caps, the tag syntax (`#low` … `#super`) and the floor for risky operations.

`test/prompts.test.ts` gives the router a prompt that asks for another label, a work-account
model, work scope and an unpinning, with a classifier that does as it says, and shows that none of
it happens.

### What redaction hides

Redaction looks for these kinds of secret, and writes `[redacted]` where it finds one:

- passwords in URLs;
- `Authorization` headers;
- JWTs;
- private-key blocks;
- keys and tokens with a vendor's prefix (`sk-`, `sk_live_`, `ghp_`, `github_pat_`, `glpat-`,
  `hf_`, `npm_`, `xoxb-`, `AIza`, `AKIA` and others);
- values after a key or a flag whose name marks a secret (`password`, `token`, `api_key` and the
  like);
- passwords behind curl's `-u`, `--user` and `-U`, and behind `--proxy-user`;
- passwords glued to `-p` in mysql and mariadb commands;
- netrc passwords;
- the text of XML elements whose name marks a secret;
- passwords in Python auth pairs;
- cookie values in `Cookie` and `Set-Cookie` headers;
- long mixed-case runs of letters and digits, or of base64 characters.

Redaction is pattern matching. It hides the shapes its tests pin, and other spellings of the same
secret can stay: the list names what it looks for, not what it finds. Other programs give `-u`,
`--user` and `-U` other meanings (`date -u`, `docker run -u`), so the examples show them behind
`curl`, and show `--proxy-user` behind `wget`. Redaction's time grows in proportion to the text:
a test holds it to under a second on each of its hostile inputs, of 90,000 characters and more.

For example, with each row a test of the suite, which reads these tables and checks them against
the code. In a cell `⏎` stands for a line break and `⇥` for a tab:

| Example | Input | What Jev reads |
|---|---|---|
| a URL's password | `git clone https://bob:Hunter2pw@example.com/a/b` | `git clone https://bob:[redacted]@example.com/a/b` |
| a URL's password behind a DOMAIN\user name, whose \t then reads as a space | `http://CORP\tom:Hunter2pw@proxy.corp:8080` | `http://CORP om:[redacted]@proxy.corp:8080` |
| escaped line breaks and an escaped tab, which read as spaces and end a value | `{"log": "password: hunter2\napi_key: Zz9y8x7w\r\ntoken: Aa1b2c3d\tdone"}` | `{"log": "password: [redacted] api_key: [redacted]  token: [redacted] done"}` |
| an Authorization header with a scheme | `Authorization: Bearer q8Zt1rLm9XaQ` | `[redacted]` |
| an Authorization header with no scheme | `Authorization: q8Zt1rLm9XaQ and more` | `[redacted] and more` |
| a JWT | `jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ok` | `jwt [redacted] ok` |
| a private-key block | `-----BEGIN OPENSSH PRIVATE KEY-----⏎b3BlbnNzaC1rZXktdjEA⏎-----END OPENSSH PRIVATE KEY-----⏎after` | `[redacted]⏎after` |
| keys and tokens with a vendor's prefix | `sk-abcdefghij0123456789 sk_live_aB3dE5gH ghp_abcdefghijklmnopqrstuvwxyz0123456789 github_pat_x glpat-abcdefghij0123456789 hf_abcdefghij0123456789 npm_abcdefghij0123456789 xoxb-1 AIzaabcde_ghij-123456789abcdefghij01234 AKIA0ABCDEFGHIJKLMNO` | `[redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted]` |
| values after keys whose names mark a secret | `client_secret=a1 password=a2 passwd=a3 passphrase=a4 credential=a5 authorization=a6 token=a7 api_key_id=a8 access_key_id=a9 private_key_id=b1 monkey=b2 db_pass=b3 pwd=b4` | `client_secret=[redacted] password=[redacted] passwd=[redacted] passphrase=[redacted] credential=[redacted] authorization=[redacted] token=[redacted] api_key_id=[redacted] access_key_id=[redacted] private_key_id=[redacted] monkey=[redacted] db_pass=[redacted] pwd=[redacted]` |
| values after flags whose names mark a secret | `run --password a1 --api-key a2 --token a3 --db-pass a4` | `run --password [redacted] --api-key [redacted] --token [redacted] --db-pass [redacted]` |
| a long mixed-case run of letters and digits | `aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k` | `[redacted]` |
| a long base64 run | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | `[redacted]` |
| curl's -u, --user and -U | `curl -u admin:Hunter2pw --user bob:Hunter3pw -U proxy:Hunter4pw https://h` | `curl -u admin:[redacted] --user bob:[redacted] -U proxy:[redacted] https://h` |
| curl named by its path | `/usr/bin/curl -u admin:Hunter2pw https://h` | `/usr/bin/curl -u admin:[redacted] https://h` |
| a curl word behind a dot | `my.curl -u admin:Hunter2pw https://h` | `my.curl -u admin:[redacted] https://h` |
| curl before a tab | `curl⇥-u admin:Hunter2pw https://h` | `curl⇥-u admin:[redacted] https://h` |
| sort -u behind the pipe that ends a curl command | `curl -s https://h \| sort -u -t: -k1` | unchanged |
| date -u behind the semicolon that ends a curl command | `curl -s https://h; date -u +%H:%M:%S` | unchanged |
| date -u behind the && that ends a curl command | `curl -s https://h && date -u +%H:%M:%S` | unchanged |
| date -u on the line after a curl command | `curl -s https://h⏎date -u +%H:%M:%S` | unchanged |
| curl's -u on a line that a backslash continues | `curl -s https://h \⏎  -u admin:Hunter2pw` | `curl -s https://h \⏎  -u admin:[redacted]` |
| curl's -u behind a semicolon inside a quoted argument | `curl -H 'Accept: a; b' -u admin:Hunter2pw https://h` | `curl -H 'Accept: a; b' -u admin:[redacted] https://h` |
| date -u on the line after a curl argument whose quote never closes | `curl -H 'Accept: a; b⏎date -u +%H:%M:%S` | unchanged |
| curl's -u in a command inside a JSON string, behind escaped quotes | `{"command": "curl -H \"x; y\" -u admin:Hunter2pw https://h"}` | `{"command": "curl -H \"x; y\" -u admin:[redacted] https://h"}` |
| curl's -u behind a double-quoted argument that holds escaped quotes | `curl -d "{\"a\": \"b; c\"}" -u admin:Hunter2pw https://h` | `curl -d "{\"a\": \"b; c\"}" -u admin:[redacted] https://h` |
| date -u and docker run -u, with no curl command | `date -u +%H:%M:%S; docker run -u 1000:1000 img` | unchanged |
| --proxy-user behind wget, behind curl and behind no command | `wget --proxy-user bob:Hunter2pw https://h; curl --proxy-user amy:Hunter3pw https://h⏎pass --proxy-user=cat:Hunter4pw to it` | `wget --proxy-user bob:[redacted] https://h; curl --proxy-user amy:[redacted] https://h⏎pass --proxy-user=cat:[redacted] to it` |
| -p glued to its password behind mysql, mysqldump and mariadb | `mysql -uroot -pHunter2pw db; mysqldump -pHunter3pw db; mariadb -pHunter4pw db` | `mysql -uroot -p[redacted] db; mysqldump -p[redacted] db; mariadb -p[redacted] db` |
| cp -pr and docker run -p8080:80 | `cp -pr src dst; docker run -p8080:80 img` | unchanged |
| a netrc password on a line that says machine | `machine example.com password Hunter2pw` | `machine example.com password [redacted]` |
| a netrc password on a line that says login | `login bob password Hunter2pw` | `login bob password [redacted]` |
| the word after password on a line that says neither | `the password Hunter2pw was typed twice` | unchanged |
| an XML element whose name marks a secret | `<server><username>bob</username><password>Hunter2pw</password></server>` | `<server><username>bob</username><password>[redacted]</password></server>` |
| a Python auth pair | `requests.get(url, auth=('bob', 'Hunter2pw'))` | `requests.get(url, auth=('bob', [redacted]))` |
| HTTPBasicAuth | `HTTPBasicAuth('bob', 'Hunter2pw')` | `HTTPBasicAuth('bob', [redacted])` |
| the cookies of a Cookie header | `Cookie: a=Hunter2pw; b=Hunter3pw` | `Cookie: a=[redacted]; b=[redacted]` |
| the cookie of a Set-Cookie header | `Set-Cookie: sid=Hunter2pw; Path=/; HttpOnly` | `Set-Cookie: sid=[redacted]; Path=/; HttpOnly` |

It also hides some text that is no secret. For example:

| Text | Input | What Jev reads |
|---|---|---|
| the text of a plist's key element | `<key>CFBundleName</key>` | `<key>[redacted]</key>` |
| the port of docker run on a line that names mysql | `docker run --name mysql -p8080:80 img` | `docker run --name mysql -p[redacted] img` |
| the word after password on a line that also says login | `enter your login and password carefully` | `enter your login and password [redacted]` |
| the end of a time format behind a curl word and a single & | `curl -s https://h & date -u +%H:%M:%S` | `curl -s https://h & date -u +%H:[redacted]` |

Its known gaps include the shapes below; each entry gives an input whose secret, or the part of
it the entry names, stays in the text that Jev reads, and the list is not complete. In the inputs
`pw` stands for a password:

| Shape | Input | What Jev reads |
|---|---|---|
| a quoted argument that runs over several lines, before the flag | `curl -d '{⏎"a": 1⏎}' -u admin:pw https://h` | unchanged |
| a -u value in JSON-escaped quotes | `curl -u \"admin:pw\" https://h` | unchanged |
| a command in a JSON string whose argument holds quotes escaped twice around a separator | `{"command": "curl -d \"{\\\"a\\\": \\\"b; c\\\"}\" -u admin:pw"}` | unchanged |
| such a command with one quote escaped twice and the separator in a later quoted argument | `{"command": "curl -d \"5\\\" wide\" -H \"Accept: text/html; q=0.9\" -u admin:pw https://h"}` | unchanged |
| a password that holds an escaped quote, whose part behind that quote stays | `curl -u "admin:pw\"Xyz9" https://h` | `curl -u "admin:[redacted]"Xyz9" https://h` |
| a user name that holds an escaped quote | `curl -u "ad\"min:pw" https://h` | unchanged |
| a quoted -u value whose user holds a space | `curl -u "John Smith:Hunter2pw" https://h` | unchanged |
| a flag behind a value that holds an escaped quote and a quoted separator | `curl -u "admin:x\"y" -H "Accept: a; b" -U proxy:pw https://h` | `curl -u "admin:[redacted]"y" -H "Accept: a; b" -U proxy:pw https://h` |
| a quoted password that holds the other kind of quote, whose part from that quote on stays | `curl -u "admin:O'Brien1x" https://h` | `curl -u "admin:[redacted]'Brien1x" https://h` |
| a $'…' string that holds a separator, before the flag | `curl -d $'it\'s; here' -u admin:pw` | unchanged |
| a command substitution with quotes of its own, before the flag | `curl -d "$(jq -c ".a; .b" f)" -u admin:pw` | unchanged |
| a backslash before a separator outside quotes, before the flag | `curl https://h/a\;b -u admin:pw` | unchanged |
| a line continuation between the flag and its value | `curl -u \⏎admin:pw https://h` | unchanged |
| combined short flags | `curl -sSu admin:pw https://h` | unchanged |
| a quoted password after the colon | `curl -u admin:"pw with space" https://h` | unchanged |
| an argument array | `["curl", "-u", "admin:pw"]` | unchanged |
| curl.exe | `curl.exe -u admin:pw https://h` | unchanged |
| wget's --user | `wget --user admin:pw https://h` | unchanged |
| http's -u | `http -u admin:pw https://h` | unchanged |
| a .netrc file written over several lines | `machine example.com⏎login bob⏎password pw` | unchanged |
| an Authorization name with an equals sign and no quotes, whose token stays | `Authorization=Bearer q8Zt1rLm9XaQ` | `Authorization=[redacted] q8Zt1rLm9XaQ` |
| a header name glued behind an underscore, whose token stays | `HTTP_AUTHORIZATION: Bearer q8Zt1rLm9XaQ` | `HTTP_AUTHORIZATION: [redacted] q8Zt1rLm9XaQ` |
| an Authorization scheme that holds a hyphen, whose credential stays | `Authorization: Api-Key q8Zt1rLm9XaQ` | `[redacted] q8Zt1rLm9XaQ` |
| an Authorization scheme that holds a digit, whose credential stays | `{"Authorization": "OAuth2 q8Zt1rLm9XaQ"}` | `{"[redacted] q8Zt1rLm9XaQ"}` |
| an Authorization credential of several words, whose words behind the first stay | `Authorization: Digest username="bob", response="6629fae49393a05397450978507c4ef1"` | `[redacted]"bob", response="6629fae49393a05397450978507c4ef1"` |
| a credential of letters only before an escaped line break and another header, whose key stays | `Authorization: abcdef\r\nX-Api-Key: Zz9y8x7w6v` | `[redacted] Zz9y8x7w6v` |
| a name that ends in tokens | `refresh_tokens: q8Zt1rLm9XaQ` | unchanged |
| a name in which String stands behind token | `tokenString = q8Zt1rLm9XaQ` | unchanged |
| PowerShell's -Password | `New-LocalUser -Name bob -Password hunter2` | unchanged |
| a quoted cookie value | `Set-Cookie: sid="Hunter2pw"` | unchanged |
| mysql.exe | `mysql.exe -pHunter2pw db` | unchanged |
| mysql's -p on a line that a backslash continues | `mysql -h db.example.com -u root \⏎  -pHunter2pw mydb` | unchanged |
| an unquoted cookie value behind a quoted one | `Cookie: a="x"; session=Hunter2pw` | unchanged |
| a value that holds an apostrophe, whose part from the apostrophe on stays | `password: O'Brien1x` | `password: [redacted]'Brien1x` |
| a value that holds a comma, whose part from the comma on stays | `DB_PASSWORD=Hunter2,pw9` | `DB_PASSWORD=[redacted],pw9` |
| an XML element whose text is a CDATA section | `<password><![CDATA[Hunter2&pw]]></password>` | unchanged |
| a Python auth pair written over several lines | `requests.get(url, auth=(⏎    'bob',⏎    'Hunter2pw',⏎))` | unchanged |
| a comparison | `if (password === "pw") ok()` | `if (password =[redacted] "pw") ok()` |
| a bytes string | `password=b"pw"` | `password=[redacted]"pw"` |
| a raw string | `token = r'pw'` | `token = [redacted]'pw'` |
| a value on the line after its name | `password:⏎pw` | unchanged |
| JSON escaped twice | `{\\"password\\": \\"pw\\"}` | unchanged |
| a JWT glued behind an underscore | `x_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl` | unchanged |
| a URL password that holds a slash | `https://bob:p/w@host` | unchanged |
| a URL password that holds an at sign, whose part from the at sign on stays | `postgres://bob:Hunt@er2pw@db.example.com/app` | `postgres://bob:[redacted]@er2pw@db.example.com/app` |
| a Python auth pair whose password holds the other kind of quote | `auth=("bob", "O'Brien1x")` | unchanged |
| a Python auth pair behind a name that only ends in _auth | `http_auth=('bob', 'Hunter2pw')` | unchanged |

## A model picked by hand

John's decision of 2026-11-16: a manual choice always wins. A model selected with `/model` or by
cycling, or restored with a session, stays selected and is sent as it is, in personal scope, in work
scope and under the pin. The router routes only while the selection is `smart-router/auto` or
`smart-router/local`.

Each row below is asserted by the tests under "the router's handlers", "a model picked by hand in
work scope", "a model picked by hand under the pin" and "a restored selection" in
`test/selection.test.ts`, on Hera's rosters. Scenarios 6 to 9, 11, 20 and 26, and L5, L6 and L10,
of `test/behaviour.test.ts` show the same in Pi's own runtime.

| In a work session, or in a pinned one | What happens |
|---|---|
| `/model openrouter/moonshotai/kimi-k3.1-pro`, or cycling to `openai-codex-2/gpt-6.1-sol` | That model is the selection. The router shows no notice and selects nothing. |
| `xai/grok-4.7` picked in a work session, the case John reported | It stays. The notice "so xai/grok-4.7 was not kept, and the selection is smart-router/auto again" no longer exists. |
| Four picks in the same instant | Each is kept. Nothing counts picks, and no session is locked. |
| The prompt "fix the build", and a steer typed while it runs | Both are sent. |
| The run's `turn_start` | Nothing is switched, and the run is not aborted. |
| The provider request | The router registers no handler for it, so the payload arrives whole. |
| Cache warming | The router registers no handler for it, so Pi's own decision stands. |
| A compaction, and `/tree` with a summary | Each proceeds, on the model picked by hand. |
| A work session resumed on such a model, by its entry or its work directory; a session of a latched process at startup, resume, reload, `/new` or a fork; a pinned session at resume, or under `PI_SMART_ROUTER_LOCAL_ONLY` | It starts on that model, and nothing is selected in its place. |
| Another extension selects a model, as Multi-Pass `allowedSubs` does | Its selection stands as a hand's does. The router cannot tell the two apart, and answers neither. |

The consequence, which John accepted: in a work session, a personal-account or OpenRouter model
picked by hand receives that conversation under that account, and under the pin a cloud model
picked by hand receives it too.

**The router's own models keep their policies, in their routes.** A request their policy does not
allow is refused by the model that was asked, and the selection stays where it was:

| Selection | Session | Its requests |
|---|---|---|
| `smart-router/auto` | work scope, not pinned | Go only to the work-bound Codex account. Refused when the roster serves no work scope, or the scope cannot be read. |
| `smart-router/auto` | pinned | Go only inside the pin's policy. In a scope whose fallback chain names the local role, to that role's models, in its order. In any other scope, where auto does not reach the local role, refused: "smart-router/auto: no local model can take this request while this session is pinned to local models (…). Nothing was sent. Choose smart-router/local with /model, or run /smart-router local off." |
| `smart-router/local` | either scope, or a scope that cannot be read, pinned or not | Go only to the local role, and never to a cloud model. Refused only when no local model can take the request. |

John's decision of 2026-11-16, "Let smart-router/local route in work scope": selecting
`smart-router/local` is itself the request for local routing, so a work session needs no pin for
it. The consequence: in a work session, on the shared work machines too, selecting
`smart-router/local` sends the conversation to the roster's local models, not to the work account,
without the pin step. Until 1.4.0-jw.1 that request was refused unless the session was pinned.

John's decision of 2026-11-17, "Let local route there too": `smart-router/local` routes in a
session whose scope cannot be read as well, pinned or not, so it refuses no scope at all. Until
1.4.0-jw.2 it refused such a session outside the pin. `smart-router/auto` still refuses one, since
it cannot tell which account the session's requests may use.

In work scope, outside the pin, a refusal names only `smart-router/auto` and work Codex models as
models to choose, since those keep the conversation on the work account. Any other model you pick
is kept all the same.

**The one switch.** The router selects a model in one place: `/smart-router local on`, which asks
for local routing, selects `smart-router/local`, unless the selection is already that model or a
physical model inside the pin's policy, such as GLM selected directly. No other command and no
event selects a model. Each of these is a test in `test/commands.test.ts`:

- `/smart-router scope work` with Kimi selected answers "pi-smart-router: scope work (entry)." and
  "The selection stays openrouter/moonshotai/kimi-k3.1-pro. A model picked by hand is sent as it is,
  in work scope too."
- `/smart-router scope work` with `smart-router/local` selected answers "The selection stays
  smart-router/local. In work scope smart-router/local routes to the local models without the pin,
  so its next requests go to them, not to the work account."
- `/smart-router local off` in a work session leaves the selection too: on `smart-router/local` it
  ends with the same sentence, and on Kimi with "A model picked by hand is sent as it is, in work
  scope too."
- `/smart-router scope personal` changes no selection.

**A session that starts pinned starts on whatever Pi selected.** A pin carried into a fork or
`/new`, a resumed pin and `PI_SMART_ROUTER_LOCAL_ONLY` select nothing. Pi starts a new session on
the settings default: when that is `smart-router/auto`, its requests go to the local role where
its scope's fallback chain names that role, and are otherwise refused, with the text above, until
you choose `smart-router/local`; when it is a cloud model, that model is sent as it
is. The pin's status item, `local models`, shows only while the pin covers the selection: either of
the router's models, or a physical model inside the pin's policy.

## Scope: personal or work

Every session has a scope, and version 2 routes it within that scope's levels, exclusions and
account bindings. The first rule that applies decides it:

1. **The latch.** `PI_SMART_ROUTER_SCOPE=work`, exactly, puts every session of the process in work
   scope. It is read each time the router loads; once seen, it holds for the life of the process,
   even if the variable is removed later. nix-config's shared-work profile is to set it.
2. **The session's entry.** `/smart-router scope work` and `/smart-router scope personal` record a
   `smart-router.scope` entry in the session, as the pin is recorded, and resume keeps it.
   - Personal to work takes effect at once, for the routes of the router's own models. The selection
     stays as it is, and the answer says what it will do: a model picked by hand is sent as it is,
     and `smart-router/local` routes to the local models, without the pin too.
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
not carried, so the new session decides its own. A scope that cannot be read is carried as work
scope, the scope the router routes that session in.

**It fails closed.** A malformed `smart-router.scope` entry, a custom message of that type, or a
session whose entries cannot be read has an unreadable scope: `smart-router/auto` refuses until
`/smart-router scope work` or `/smart-router scope personal` records a scope again.
`smart-router/local` routes to the local role's models all the same, pinned or not: its requests
carry no account, so there is nothing for the scope to decide. Such a request resolves in work
scope, the narrower one, and records neither a scope nor a pin.

**Where each scope's requests go.** Scope governs the router's own two models, and nothing else.
Outside the pin, `smart-router/auto` never sends a personal session to a work-bound account, and
sends a work session only to a work-bound Codex account. Under the pin, both scopes route only to
the local role's models. A version 1 roster serves no work scope: `smart-router/auto` refuses a
work session, and the check every pick passes refuses it again. A latched process whose roster has
no work scope refuses every request on `smart-router/auto`, and `/smart-router status` says why.
`smart-router/local` serves both scopes, and a scope that cannot be read, pinned or not, since it
carries no account: a work session on it goes to the local role's models, under a roster that
serves no work scope too, and never to a cloud model. In either scope, pinned or not, a model picked by hand
is sent as it is, a work-account model in a personal session included
([A model picked by hand](#a-model-picked-by-hand)).

### Work scope and the selection

Work scope has no hold on the selection. Until 1.3.0-jw.2 a work guard switched any selection but
`smart-router/auto` and the work account's models back to `smart-router/auto`, and locked a session
that something kept switching away. John's decision of 2026-11-16 removed it: a model picked by
hand stays selected in a work session and is sent as it is.

- **The pin comes first.** While a session is pinned, the router's models route only inside the
  pin's policy, in either scope.
- **A failed reload moves no session.** While the roster fails to load, the scope reads the work
  directories of the last valid roster loaded in the process, which the process slot keeps. Both
  of the router's models refuse until the roster loads; a model picked by hand is sent as it is.
- **Leaving work scope** is `/smart-router scope personal`, which asks first and which the latch
  refuses.

### What work scope does not cover

Work scope governs the requests the router routes: those a session sends through
`smart-router/auto` or `smart-router/local`, and those that go through such a session's route, as
the default goal-x auditor's do. It blocks no tools. Still able to send a work session's content
elsewhere, the latch included:

- **A model picked by hand.** It stays selected and is sent as it is, a personal-account or
  OpenRouter model included ([A model picked by hand](#a-model-picked-by-hand)).
- **Extensions with their own models:** pi-warden's judge (it sends redacted context to its backend
  while enabled), a goal-x auditor configured with its own model, and pi-btw.
- **Workflow tiers and subagent agents with explicit models**, whether or not the child loads the
  router: an explicit model is sent as it is. A child that loads the router is in work scope by
  the latch and the work directories as any session is, so its `smart-router/auto` goes to the
  work account, but it starts in personal scope when only its parent's entry set work scope.
- **Tools** that send data themselves: web fetch and web search tools, which send URLs and queries;
  browser tools; and whatever the bash tool can read and send.
- **Pi's own `/share`, `/export` and `/bug`**, which run before any extension hook, and extension
  commands, which run before the router sees the input.
- **Turns sent before the session was in work scope**, and processes outside Pi.

### Limits and rollout

- A scope set by an entry reaches what goes through its session: the default goal-x auditor routes
  in it, as it obeys the session's pin, and a fork made from the command line (`pi --fork`) copies
  the entry with the rest of the session. pi-subagents children start with no entries, so it does
  not reach them. Run work in a work directory or in a latched process, which reach a child that
  loads the router as they reach any session.
- **Rollout order.** Write the version 2 work roster before setting `PI_SMART_ROUTER_SCOPE=work`: in
  a latched process with a version 1 roster, or with no roster loaded, the router's own models send
  nothing unless pinned.

## The local-only pin

`/smart-router local on` pins the session to local models: from then on both of the router's
models route only inside the local policy. It holds the router's routes, not the selection: a model
picked by hand afterwards stays selected and is sent as it is
([A model picked by hand](#a-model-picked-by-hand)).

- It records the local policy in force (the local role's models, providers and hosts) in a
  `smart-router.pin` session entry, so a later roster edit cannot widen what counts as local. If
  the roster is invalid or has no local section, the pin records an empty policy, under which
  nothing qualifies, and says so.
- It selects `smart-router/local`, since the command asks for local routing, unless the selection
  is already that model or a physical model inside the policy, such as GLM selected directly. This
  is the only place where the router selects a model. When the switch fails, it says that the
  selection stays as it is.
- It warns when earlier turns of the branch went to a cloud model. Those have already left the
  machine; the pin protects only what follows.
- It lists what can still send data off the machine (below).

The status item reads `local models` while the session is pinned and the pin covers the selection:
either of the router's models, or a physical model inside the policy. Over a model picked by hand
outside the policy it is cleared, because that model is sent as it is. It does not say "private".

`/smart-router local off` asks first, and Enter keeps the pin; only "Yes, unpin" unpins. It refuses
in modes without dialogs and while the environment switch is on. It leaves the selection as it is.
In work scope, the question says that `smart-router/auto`'s next requests go to the work account,
and the answer says what the selection will do: `smart-router/local` still routes to the local
models once unpinned, in a session whose scope cannot be read too, and a model picked by hand is
sent as it is. `/smart-router local status` shows the pin and what
can still leave the machine.

- **Session-wide.** The pin belongs to the session file, every branch included. Resume keeps it.
- **Forks and `/new` carry it** into the session they create. Resuming an unpinned session after a
  pinned one shows a notice.
- **Selecting `smart-router/local` does not pin.** It routes locally; pinning is explicit.
- **`PI_SMART_ROUTER_LOCAL_ONLY`**, set to any non-blank value other than `0`, `false` or `off`,
  pins every session in the process, with the local section of the first valid roster, so no
  session of the process asks the classifier either. It is read each time the router loads; once
  seen, it stays on for the life of the process, even if the variable is removed later. It selects
  nothing: a session that starts on `smart-router/auto` stays there, and its requests go to the
  local role where its scope's fallback chain names that role, and are otherwise refused until you
  choose `smart-router/local`. Set it in a launcher or an alias; Nix never sets it.
- **It fails closed.** Only a well-formed unpinning entry unpins. A `smart-router.pin` entry of any
  other shape, a custom message of that type or another version pins with an empty policy, under
  which nothing qualifies, until you pin again. On a Pi without the fork's bounded session reads,
  every session counts as pinned, and both models refuse every request.

### What the pin guarantees

While a session is pinned, every request routed through either virtual model goes to a model inside
the pinned policy, or fails with "Nothing was sent". That covers user runs, continuations, retries,
Pi's compaction and branch summaries, a goal-x auditor that inherits the session's selection, and
pi-subagents children that inherit `smart-router/local` and load the router. `smart-router/auto`
obeys the pin too. In a scope whose fallback chain names the local role, a pinned request on
`smart-router/auto` goes to that role's models; the chain's cloud roles are never used under the
pin. In any other scope, where auto does not reach the local role, it is refused, with a text that
names `smart-router/local`.

The guarantee is about the router's two models, and it ends at the selection. Until 1.3.0-jw.2
the pin also guarded the selection: it undid a model selected outside the policy, refused prompts,
switched or stopped runs at `turn_start`, cancelled compaction and summaries, emptied provider
payloads, stopped cache warming, and locked a session that something kept switching away. John's
decision of 2026-11-16 removed all of that. With a model picked by hand selected, a pinned session
sends everything to that model: the prompt, the run, compactions, summaries and warm requests.

While a session is pinned, the router asks no classifier, and a tag is removed with a notice that it
has no effect. Once the session is unpinned, Jev reads the recent conversation as it does for any
message, pinned turns included.

Another extension that selects a model, as Multi-Pass `allowedSubs` in the project does, or
pi-openai-codex-compat on a branch holding a native Codex compaction checkpoint, moves a pinned
session off the router's models, and the router does not move it back: the pin's status item is
cleared, and the session sends to the model that extension selected. `/new` carries the pin into a
clean session.

### What the pin does not cover

The pin pins the router's two models. It does not hold the selection, blocks no tools, and cannot
see requests that do not go through its own routes. Still able to send data off the machine:

- **A model picked by hand.** It stays selected and is sent as it is: its turns, and the
  compactions and summaries made while it is selected. `/smart-router status` lists it first.
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
(`NIX_MANAGED_PI_WARDEN=off`). The pin is the router's safeguard for its own routes, not a sandbox.

## Records and training

A run that still holds a level when it settles leaves one `smart-router.level` entry in its session,
however it ended. A message that arrives on `smart-router/local`, under the pin, on a physical model
or under a version 1 roster gets no level, and a run without a level leaves no entry.

The router can drop a level before its run settles, and a run can record a level that another
message planned. These can happen when messages overlap, as when several wait for Jev together or a
steer arrives while a run settles, and when the selection, the pin, the scope or the roster changes
after a message was planned. A run that stays on a model picked by hand after its message was
planned is different: its requests do not go through the router, so the plan is not compared, and
the entry keeps the planned level, with the hand-picked model as its `ref` when that model answered.
The tests under "a run's record" in `test/router-levels.test.ts` pin some of these cases, and the
rest can vary. A record is a label, so check it against its session before training on it.

The entry's fields:

- `v`; `at`, when the run was planned; and `scope`;
- `source`, what decided the level: `tag`, `jev`, `keyword` or `floor`;
- `tier`, the level planned for the run; `asked`, the level the tag, Jev or the keywords asked for;
  and `tag`, for a tagged run;
- `trigger`, the risky operation that raised the run to the floor;
- `keyword`, the keyword classifier's signal and reason;
- `jev`: Jev's model, choice, probabilities, confidence and latency (`ms`), or its failure
  (`unavailable`, `error`, `timeout`, `aborted`, `malformed` or `prompt`). A tagged
  run whose answer had not come when it settled records `{ "late": true }`. The field can be absent,
  as it is without a classifier, and an extension's resend can repeat the answer its message got
  before;
- `ref`, the model of the run's last assistant message that ended without an error, absent when no
  model answered;
- `steppedUp`, `returnedToFirst` and `aborted`, when they apply; and `fallback`, when the model
  that answered is one of the scope's fallback chain. `tier` is the run's level all the same: a
  fallback never changes it.

A record holds no prompt text and no digest of it. It normally follows its run's first user message,
earlier in the same session, and the run's steers and follow-ups can sit between them; that message
lacks the tag, which the record keeps.

`/smart-router was low|medium|high|super` labels a run with the level it should have had: the run in
flight, when it holds a level, from its start until its record is written, and otherwise the run of
the latest record on the active branch, not the level of a message whose run has not started. It
appends a record with source `correction`, that level, and `refers`, the `at` of the run it names; a
correction of a correction names the same run. With no run to name, it says so and appends nothing.
Nothing is sent again.

**Training** is an agent review, when John asks for one. An agent session on the host reads that
host's session files for these records and the user messages they pair with, reports per scope and
per level where John's tags and corrections disagree with Jev, and proposes revised descriptions
and instructions and a revised `closeCall` as a diff to that host's roster and prompt files. Nothing changes until John approves it.
Records stay on the host that made them, and work records are read only there. The router itself
reads no other session and does not write the roster.

## Commands

| Command | Does |
|---|---|
| `/smart-router` or `/smart-router status` | The roster's path and state; the selection and its thinking level; the pin; the session's scope and what set it, under a version 2 roster or whenever `smart-router/auto` refuses the scope; every role's models on this host with `ok` or the reason they cannot route, and catalog prices; the accounts cooling and the local models held as unreachable; account bindings, checked in the session's scope, and auth sources; a version 1 roster's routing table and fallbacks, or a version 2 roster's levels and fallback chain in each scope, its classifier and the source of each of Jev's prompts; the last decision, and whether it went to a fallback chain's model; what can still leave the machine, a model picked by hand first and then the classifier when `smart-router/auto` may ask it; and a warning for any fallback that would move a run onto Codex's API from another one. |
| `/smart-router history [n]` | The last `n` routing decisions (10 by default, at most 50), with reason codes, and on a version 2 run's first request its scope, level and what decided the level. Model ids and codes only, never prompt text. |
| `/smart-router local on`, `off`, `status` | The pin. `on` selects `smart-router/local`, the only selection any command makes; `off` leaves the selection as it is. |
| `/smart-router scope [work\|personal\|status]` | The session's scope and what set it: `latch`, `entry`, `directory` or `default`. `work` records work scope at once; `personal` asks first in work scope, and is refused under `PI_SMART_ROUTER_SCOPE=work`. Neither changes the selection. |
| `/smart-router was low\|medium\|high\|super` | Record that the run in flight, when it holds a level, or else the run of the latest record, should have gone to that level. Nothing is sent again. |
| `/smart-router check` | Read the roster and its prompt files again and read them back: what each selection and scope routes to, in order, and where each of Jev's prompts comes from; or the first error, with its place. It selects, records and sends nothing. [Checking a roster](#checking-a-roster). |
| `/smart-router reload` | Read the roster, its prompt files and Multi-Pass's labels again now, and register both models again if their limits changed. |

## Interactions with other extensions

- **pi-cache-optimizer** works through the routing registry, as described above.
- **pi-openai-codex-compat** still wraps routed `openai-codex` requests, but whatever it keys on the
  *selected* model does not apply to them: its request options, its Codex tool surface and its remote
  compaction. On a branch with a native Codex compaction checkpoint it switches the selection back
  to Codex, and the router leaves it there, pinned or not: the session is then on Codex. Start
  pinned work outside such a branch (`/new` carries the pin). Hera's `openai-codex-2` never uses
  codex-compat.
- **goal-x**: continuations route like any run that starts without a prompt, and get cooldowns and
  fallbacks. The default auditor routes through the session and obeys its pin; a configured auditor
  bypasses the router and the pin, so leave it unset in private work. Leave `auditorProjectResources`
  and `projectResources` off: each loads a second router into every audit. The default auditor
  routes in the session's scope too, one an entry set included; a configured auditor bypasses work
  scope as it bypasses the pin
  ([What work scope does not cover](#what-work-scope-does-not-cover)).
- **pi-subagents**: foreground children inherit the selection but load the router only when it is
  registered for children, as nix-config's integration is meant to do; otherwise a child on
  `smart-router/*` fails with "model not found". Give children explicit models where that
  registration is absent. Children start with no entries, so a scope that only an entry set does not
  reach them; the latch and the work directories do, in a child that loads the router.
- **Multi-Pass**: its subscription-pool failover keys on the selected provider, so routed requests
  lose it; a role's next candidates and version 1's `routing.fallback` replace it. In a project
  whose `.pi/multi-pass.json` sets `allowedSubs`, list `smart-router` there, or Multi-Pass switches
  away from it, and the router does not switch back.
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

- **Per run:** choose another model with `/model`. It stays selected, in work scope and under the
  pin too.
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
- `src/check-cli.ts` is the standalone roster checker. It is not part of the extension, and it and
  what it imports stay free of Pi's packages; `test/check.test.ts` walks its imports.
- A source scan (`test/scan.test.ts`) holds `index.ts` and `src/` to the runtime rules, comments
  included: an import allow-list, no whole-history session reads, no dynamic code, no `fetch(` or
  `WebSocket`, and no timers (`setTimeout`, `setInterval`, `setImmediate`, `AbortSignal.timeout`).
- Never run Pi's own test suites on the host, and never start a real Pi session from a test.
- [AGENTS.md](AGENTS.md) holds the rules for coding agents.

## License

MIT; see [LICENSE](LICENSE). Copyright (c) 2026 beettlle and contributors, and Copyright (c) 2026
John Wiegley for the port. The triage engine and entropy check in `src/triage/` are upstream's,
unchanged but for one import specifier.
