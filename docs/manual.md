# pi-smart-router (jwiegley fork): the manual

Four Pi virtual models, `smart-router/auto`, `smart-router/personal`, `smart-router/work` and
`smart-router/local`, that send each request to a physical model chosen from a roster you keep on
each host.

This is the manual of the fork. The repository's [README](../README.md) is upstream's, with one
section on how the fork differs.

This is John Wiegley's fork of [beettlle/pi-smart-router](https://github.com/beettlle/pi-smart-router),
rewritten for the virtual models of Pi 1.5. It retains upstream's deterministic prompt classifier,
low-intensity scoring and adaptive-reasoning policy, and carries what upstream v1.5.0 added, each
part fitted to the four levels: [docs/upstream-1.5.0.md](upstream-1.5.0.md) says how.
[CHANGELOG.md](../CHANGELOG.md) lists what was removed and why. The port started from upstream
v1.3.0 (`f31b2304`). Version `1.5.0-jw.1` has upstream v1.5.0 (`f22cbe9e`) in its history through
a merge that keeps the port's tree, as earlier ones recorded v1.4.0 (`54bee53d`): the files the
port vendors or ports rule for rule did not change between the two releases, so the merge brought
nothing into this code, and what v1.5.0 added is written here anew. It is not published to npm.

## What it does

The router registers two virtual models with Pi's `registerVirtualModel`. Pi asks the router before
every request of a session on one of them, the router names a physical catalog model, and Pi
prepares the request for that model's provider: its credentials, base URL, headers, transport budget
and hooks. The selection stays virtual; each assistant message names the physical model that
answered, and Pi's footer shows it.

- **`smart-router/auto`** routes by what you typed. With a version 1 roster, a planning prompt goes
  to the planning role, a complex one to the complex role, a trivial one to the trivial role,
  anything else to the default role, up or down, whichever model answered last: nothing holds a
  session on a model by time. When a model cannot take a request (not in the catalog, no
  credentials, cooling down after a usage limit), the next model of its role takes it, and then
  the role's declared fallback, one hop and no further. Without a declared fallback the request is
  refused.
- **Levels and scopes.** With a version 2 roster, `smart-router/auto` sends each run to one of four
  levels, LOW, MEDIUM, HIGH or SUPER, in the session's scope, personal or work. A trailing tag such
  as `#high` sets the level; otherwise the prompt's demand does: the judgment of Jev, TypeSafe AI's
  decision model, which the router asks through Pi, weighed together with upstream's heuristics.
  Among the models good enough for that level, the run goes to the one the coming work costs least
  on, counting what each has in its prompt cache, and a session leaves its model only when that
  saves more than a margin. In a work session `smart-router/auto` may use work-bound Codex or
  Claude Code, or a local model explicitly named as a level's fallback, apart from Jev's request;
  a model picked by hand and extensions with models of their own are outside it
  ([What work scope does not cover](#what-work-scope-does-not-cover)). A level may declare local
  fallback roles, and a scope may declare a fallback chain. See [Levels](#levels),
  [A fallback chain](#a-fallback-chain), [Jev](#jev) and [Scope](#scope-personal-or-work).
- **`smart-router/personal` and `smart-router/work`** route by level as `smart-router/auto` does,
  each in its one scope. `smart-router/auto` takes the scope from the session; these two name it.
  Selecting `smart-router/work` makes the session a work session. Selecting `smart-router/personal`
  in a work session asks before it moves the session, and refuses its requests if you decline. See
  [The scope's own models](#the-scopes-own-models).
- **A provider order.** `/smart-router prefer claude` puts Claude's models first in every tier of
  the session's scope, and `/smart-router prefer codex` puts Codex's back. A tier keeps exactly the
  models the roster gives it; only their order changes, for that session alone. The roster can
  give a default order in `providerOrder`. See [The provider order](#the-provider-order).
- **Easy to change, cheap to get wrong.** Which model serves which level, the fallback chain, the
  local set and the texts Jev reads are each one edit in one place, a running session picks the
  edit up at its next prompt, and `/smart-router check` or `node src/check-cli.ts` reads the result
  back before anything is sent. See [Changing the routing](#changing-the-routing).
- **`smart-router/local`** routes only to the roster's local roles and never to cloud. With local
  tiers it uses offline heuristics or a tag to select a tier, and a prompt whose tier is empty is
  refused. A run that starts without a plan takes the session's level
  ([Runs without a prompt](#runs-without-a-prompt)). Without local tiers it uses the one local role in order. Normally it
  works in either scope or an unreadable scope; a personal-only restriction refuses work and
  unreadable scope. The local-only pin of earlier versions is gone;
  see [Routing locally](#routing-locally).
- **A model picked by hand always stays selected.** The router routes only while the selection is
  one of its own four models. A model you choose with `/model` or by cycling is
  sent as it is, in work scope too: the router does not switch it back, refuse
  its prompts, cancel its compactions or touch its requests. See
  [A model picked by hand](#a-model-picked-by-hand).
- **Every refusal says "Nothing was sent."** A refusal names the virtual model, gives the cause in
  the router's own words and says how to get out. Pi never retries a refusal.

The router opens no network connection of its own and sets no timer. When a version 2 roster
has a classifier, it asks Pi's model registry for one classifier request per prompt on
smart-router/auto, smart-router/personal or smart-router/work, with a per-attempt timeout and no
retries. It never does so on smart-router/local, for a steer or follow-up, or without a classifier.

It also starts no process, writes no file of its own and keeps no prompt text; its session entries
(the scope's and the level records) are written by Pi, into the session. It reads
only files under Pi's agent directory: the roster, Multi-Pass's subscription labels when the
roster binds a Multi-Pass account, and the prompt files the roster names in `smart-router/`
([Jev's prompts](#jevs-prompts)). It reads no file relative to the working directory or a
project; it only compares the working directory, as text, with the roster's work directories. The
one project-influenced value it uses is the compaction settings in Pi's settings, which Pi merges
with a project's `.pi/settings.json`; they only affect how a version 2 run treats a model too
small for the conversation: priced with the compaction Pi will make first, or, with compaction
disabled, passed over. It has no runtime dependency and no native code; Pi supplies
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`.

It needs jwiegley/pi 1.5.0 or later, whose bounded session reads let it look at a session without
loading its whole history. Upstream Pi 1.5.0 lacks those reads, so there the router fails closed:
every one of its models refuses every request for as long as it is loaded. Do not load it on upstream Pi.

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
- **Failure is closed.** A missing, invalid or unsafe roster makes every model refuse until it is
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
    { "name": "local", "$comment": "private or extreme economy; free; only smart-router/local", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "thinking": "max" },
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
    { "name": "local", "$comment": "private or extreme economy; free; only smart-router/local", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "thinking": "max" },
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

- **local (GLM on Hera's oMLX)** takes requests only through `smart-router/local`.
  `smart-router/auto` never routes to it, because no routing target or fallback names it; that
  keeps auto from causing cold oMLX prefills.
- **worker (DeepSeek)** takes default and trivial runs.
- **engineer (sol)** takes complex runs: code, debugging, a high cyclomatic score and similar.
- **architect (astra)** takes planning runs, on the prepaid Codex subscription.
- **coder (GLM 5.3 on OpenRouter)** and **thinker (Kimi)** are reached only as fallbacks: coder when
  sol cannot take a request, thinker when astra cannot, as when the ChatGPT subscription is
  unavailable or cooling down after a usage limit. sol and astra share one ChatGPT account, so the
  fallbacks move to a different quota. A fallback sends the conversation to another vendor; delete
  the `fallback` object to be refused instead. After a fallback, the next run goes to the role its
  prompt classifies as: a default or trivial run to worker, and a complex or planning run tries sol
  or astra again.

The order of `roles` is the ladder, cheapest or weakest first. Every run plans on the role its
prompt classifies as, whichever role answered last: a session plans on astra and implements on sol
whenever a run classifies as complex, and a trivial follow-up goes to worker at once.

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
| `local` | no | `role` (the local role), `providers` (every provider of the local role, and nothing qualifies as local unless it is listed) and `hosts` (base-URL host names). Without it, `smart-router/local` always refuses. |
| `stickyIdleMinutes` | no | Accepted and ignored: nothing holds a session on a model by time. When given it must still be 0 to 1440, and `/smart-router check` says it is ignored. |
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

A provider id does not identify an account: Multi-Pass aliases are positional, a native login is
whichever account was signed in, and Claude Code manages its login outside Pi. Every subscription
provider in the roster needs a binding. Native providers are `openai-codex`, `anthropic`,
`github-copilot`, `claude-code`, and independently configured numbered Claude Code providers such as
`claude-code-2`; each needs its own native binding. Multi-Pass aliases such as `openai-codex-2`
also need bindings; numbered Claude Code providers are not Multi-Pass aliases.

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
personal, work or both, binds each account to a scope, and may configure the classifier, the
demand and the switching. Version 1 rosters keep working, in personal scope only: the keyword
classifier picks the role, with no demand and no cost rule.

### Hera, version 2

```json
{
  "version": 2,
  "$comment": "Hera, version 2. Personal levels take Codex first, on openai-codex-2 (John's personal ChatGPT account, labelled 'personal' in Multi-Pass), then OpenRouter. Work levels take only openai-codex-3, the work account, which the router excludes everywhere else. Plain openai-codex is excluded here because Hera reserves it for the work account.",
  "exclude": ["openai-codex/*"],
  "roles": [
    { "name": "local", "$comment": "private or extreme economy; free; only smart-router/local", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp"], "thinking": "max" },
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
  "classifier": { "model": "openrouter/typesafe/jev-1.14", "timeoutMs": 1000, "context": { "messages": 6, "messageChars": 1500, "totalChars": 12000 } },
  "local": { "role": "local", "providers": ["omlx-hera", "nyx"], "hosts": ["hera.lan", "nyx.lan"] }
}
```

- **The personal ladder** takes Codex first at every level, then OpenRouter; LOW takes luna, then
  Nyx's Qwen, then Hera's. A level is represented by the first available candidate of its role, so
  a level returns to Codex as soon as Codex is available again.
- **The work ladder** holds only `openai-codex-3`, Hera's work account, bound as work. The built-in
  exclusion of `openai-codex-3/*` still holds in personal scope, so no personal level can name it.
- **Nyx's ref** is a Nix-store basename that changes whenever its model is rebuilt, so the roster
  needs an edit after each rebuild until nix-config gives it a stable id. Pi offers it only once
  `NYX_API_KEY` reaches Pi's environment; until then, LOW falls through to Hera's Qwen whenever luna
  is unavailable.
- **The local section** keeps Nyx, so Nyx's Qwen counts as local although `smart-router/local`
  routes only to GLM: when its server cannot be reached, LOW passes it over for a few minutes, as
  it does any local model ([Routing in detail](#routing-in-detail)).

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

Without a `classifier` section, the heuristics alone give every untagged prompt its demand; with
one, Jev's request goes through whatever OpenRouter account Pi has on that machine.

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
    { "name": "local", "$comment": "smart-router/local, in this order; also the end of the personal fallback chain. Nyx's ref is a Nix-store basename that changes whenever its model is rebuilt", "models": ["omlx-hera/GLM-5.3-Flash-oQ4e-mtp", "nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad", "omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp"], "thinking": "max" },
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
smart-router/auto in personal scope: a tag, else the demand from Jev (openrouter/typesafe/jev-1.14) and the heuristics, pick the level; each level tries its own models in order:
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
```

The read-back goes on with the demand and switching settings, the local set and the rest.

How the chain works:

- **A level's own models come first, always.** The chain is tried only when none of them can take
  the request: not in the catalog, not available, no credentials, a refused account binding, or
  cooling down after a usage-limit or authentication error.
- **The order is the order written:** each role of the list in turn, and within a role its models
  in turn. A model that cannot take the request is passed over by the same checks as any other.
- **One chain serves every level of its scope.** A run keeps its level while any chain model can
  take it: the level takes the chain before it passes the run up, so a LOW run that falls back is
  still recorded as LOW, with `fallback` in its record. Only when none of the chain's models can
  take the request, or, with Pi's compaction disabled, they are too small for the conversation,
  does the run step up ([Levels](#levels)).
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
  run starts again from the level it needs, and goes to the chain only while none of that level's
  own models can take it. So does a run that starts without a prompt
  ([Runs without a prompt](#runs-without-a-prompt)). A chain model is never a candidate of the cost
  rule. A run under way stays on the model it has. A cooled account is tried again when its time is
  up; if it is still out of tokens, that one request fails and the account cools again.
- **A retry never goes back.** When a chain model itself fails with a limit, or a local one cannot
  be reached, the retry takes another model of the same role, then the roles after it in the chain,
  never an earlier role and never the level's own, and no model twice in one run.
- **A chain belongs to the scope that declares it.** Here the work scope declares none, so a work
  session behaves exactly as before: its levels' own work-account models, a step up, or a refusal.
- **Validation keeps each scope's account rules.** No role of a chain is a level's role, in either
  scope, and no role is in two chains. A personal chain takes no model of a work-bound provider. A
  work chain takes only work-bound Codex or Claude Code models, not OpenRouter, local or a personal
  account. A model still sits in exactly one role, so a chain cannot repeat a level's model.
- **A level may also name one local fallback role.** Its models come after the level's own models
  and before the scope's chain. The same local role may serve levels of both scopes. Each model must pass
  the configured provider and LAN-host checks even when `smart-router/auto` reaches it.
- **It says so.** A run planned onto a chain model shows a notice, "no LOW model can take this
  run, so it goes to the fallback openrouter (z-ai/glm-5.3-flash)"; a run under way that moves
  onto one says "gpt-6-astra can no longer take this run, so it goes on with the fallback
  openrouter (z-ai/glm-5.3-flash)"; the footer names the chain's model, as in
  `low high → z-ai/glm-5.3-flash`; and `/smart-router history` marks a run planned onto one:
  `[personal LOW → z-ai/glm-5.3-flash (demand 0.6, jev unavailable; fallback)]`.
  `/smart-router status` lists each scope's chain with every model's verdict, and says when the
  last request went to one.

> **A fallback sends the conversation somewhere else.** When the chain takes a run, the whole
> conversation so far, not only the new message, goes to that role's vendor: here to OpenRouter and
> the provider behind the model, under their retention terms, and then to the LAN models on Hera
> and Nyx. Delete the `fallback` line, or the roles you do not want, to be refused or stepped up
> instead. A work scope's shared chain names only work-bound Codex or Claude Code, but an explicit
> per-level local fallback can send the whole work conversation to that LAN endpoint.

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
| `scopes.<scope>.levels` | yes | `low`, `medium`, `high` and `super`, each with `role` and either `describe` or `describeFile`. No role serves two scope levels; the levels rank up the ladder. An optional `fallback` is a one-element array naming a local role, whose models follow the level's own and precede the scope-wide chain. The same local role may serve both scopes. |
| `scopes.<scope>.fallback` | no | Role names to try after every level's own models and its local fallbacks. A scope-wide chain is nonempty, has no duplicate or level role and belongs to only one scope. Personal chains take no work-bound model; work chains take only work-bound Codex or Claude Code models. |
| `local.levels` | no | All four tiers, each a local role name or `null` to refuse that tier. `local.role` must be one of the enabled tier roles and remains the default for operations that do not use a planned prompt. Local routing uses offline heuristics or a tag and never asks Jev. |
| `providerOrder` | no | `personal`, `work` and `local`, each optional and each a nonempty list of provider ids without duplicates. In every role of that scope, the listed providers' models come first, in the listed order ([The provider order](#the-provider-order)). A list may name only providers of the models it governs. Without the field, every role is tried in the order its `models` are written. |
| `roles[].disabled` | no | Set to `true` with an empty `models` array to leave a role explicitly disabled, for example while no work account is verified. An empty role without this flag remains invalid. |
| `scopes.work.directories` | no | Absolute paths whose sessions are in work scope ([Scope](#scope-personal-or-work)), written plainly: no trailing `/`, no empty, `.` or `..` segment, and not `/` itself. |
| `accounts.<provider>.scope` | no | `"personal"`, the default, or `"work"`. |
| `classifier` | no | Jev's settings; without them, Jev is never asked. `model`, an exact ref, default `openrouter/typesafe/jev-1.14`; `timeoutMs`, 100 to 1000, default 1000; and `context`: `messages`, 0 to 20, default 6; `messageChars`, 200 to 8000, default 1500; `totalChars`, 1000 to 32000, default 12000. `closeCall`, which earlier versions used, is still accepted from 0 to 0.5 and ignored, and the checker says so: `demand.closeCall` decides a close call. The model names a Jev version, so that tuned demand settings keep their meaning; moving to a newer Jev is a roster edit. `instructions`, the question Jev is asked, as a text of at most 4000 characters, or `instructionsFile`, the name of a prompt file that holds it; not both, and with neither the built-in question is asked ([Jev's prompts](#jevs-prompts)). `typedJudgment`, `true` or `false`, default `false`: also ask upstream's six typed questions ([The level a prompt needs](#the-level-a-prompt-needs)). |
| `demand` | no | How a prompt's demand is weighed ([The level a prompt needs](#the-level-a-prompt-needs)). `jevWeight` and `heuristicsWeight`, each 0 to 100, defaults 4 and 1, not both 0; `minConfidence`, 0 to 1, default 0.6; `closeCall`, 0 to 0.5, default 0.1; `cuts`, three numbers that ascend, each above 0 and below 3, default `[0.75, 1.5, 2.25]`; `deepSessionFloor`, `low`, `medium`, `high` or `super`, default `medium`; and `weights`, any of the twelve heuristic signals, each 0 to 100 and not all 0, by default upstream's weights with `requirement_low` and `cluster_signal` at 0. Every field is optional, and a field left out keeps its default. |
| `adaptiveReasoning` | no | The thinking effort each request is sent ([Thinking effort](#thinking-effort)), upstream's `adaptive_reasoning`: `enabled`, `true` or `false`, default `true`; `minLevel`, the floor, and `maxLevel`, the ceiling, each one of `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, with no default, the floor never above the ceiling. A floor above the selected `/thinking` level raises it; a ceiling never lowers it. A version 1 roster has none, and the defaults. |
| `switching` | no | When a session moves to another model ([Choosing the model](#choosing-the-model)). `margin`, 0 to 0.9, default 0.15; `horizonCap`, a whole number of runs from 1 to 20, default 5; and `cacheSurvival`, 1 to 32 pairs of `[seconds, chance]`, the seconds rising and the chances from 1 to 0 never rising, by default the table in [Choosing the model](#choosing-the-model). Every field is optional. |

### Account bindings in version 2

- **A binding without `scope`** is personal, and keeps version 1's rules: its label must not name
  work or Positron.
- **`"scope": "work"`** binds the work account. Its label must name work or Positron, and for a
  Multi-Pass alias it must still match the label Multi-Pass stores. Each binding serves only its
  own scope's sessions: a personal session refuses a work binding, and a work session refuses a
  personal one.
- **Levels, chains and accounts.** Validation refuses a work-bound provider in a personal level or
  chain. Work levels and scope-wide chains take only work-bound Codex or Claude Code. A level's
  separate local fallback can serve either scope, but each candidate must pass the LAN policy.
- **The built-in `openai-codex-3/*` exclusion** holds in personal scope only. A work-scope session
  lifts it for a model of a work level or a work chain whose provider is bound as work. The roster's own exclusions
  are never lifted.
- **The classifier's model** must match no exclusion, built-in or the roster's own, and none is
  lifted for it, because Jev reads text from both scopes. So a roster with a classifier must not
  exclude `openrouter/*`. A work level itself takes only work-bound Codex or Claude Code, although
  a per-level local fallback may also be named. An exclusion binds the router's routes only: a model
  picked by hand is sent as it is.

## Changing the routing

Every decision has one place in the roster, `~/.config/pi/agent/smart-router.json`. Edit it, run
the check, and the next prompt of every running session uses it: no restart, no rebuild.

| To change | Edit |
|---|---|
| The model a level uses | The `models` of that level's role in `roles`. `scopes.<scope>.levels.<level>.role` names the role; the first model listed is the one used, the rest are tried after it. |
| Which provider every level tries first | `providerOrder.<scope>`, for every session; or `/smart-router prefer`, for the session you are in ([The provider order](#the-provider-order)). |
| What takes over when a level's model cannot | A level's `fallback` for local roles, then `scopes.<scope>.fallback` for a scope-wide chain. Each role's own `models` order is the order inside it. |
| The local set, for `smart-router/local` | The local role's `models`, or the roles named by `local.levels`. A new server also needs its provider in `local.providers` and host in `local.hosts`. |
| A work session's models | The `work-*` roles, which take work-bound Codex or Claude Code; a level may also name a local fallback. |
| What a level means to Jev | That level's `describe`, or the file its `describeFile` names. |
| How Jev judges a message | `classifier.instructions`, or the file `classifier.instructionsFile` names. |
| How much Jev counts against the heuristics | `demand.jevWeight` (4) and `demand.heuristicsWeight` (1). |
| Where one level ends and the next begins | `demand.cuts` (0.75, 1.5, 2.25). |
| How readily a close call goes to the higher level | `demand.closeCall` (0.1). |
| The lowest level of a very deep session | `demand.deepSessionFloor` (`medium`; `low` turns the floor off). |
| How much cheaper a move must be | `switching.margin` (0.15). |
| How long a model's prompt cache is taken to last | `switching.cacheSurvival`. |
| How long an exhausted account is left alone | `cooldownMinutes` (30). |
| How long a local server that could not be reached is passed over | `unreachableMinutes` (5). |

Roles are named, rather than a level listing its models inline, because the role is what a model
has exactly one of: it gives the model its `thinking`, its place on the ladder, its line in
`status`, and, for the local role, its membership of the local policy. A level and
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

The same edit changes the end of any chain that names `local`.

**Sharpen a level's description.** In the roster:

```diff
-        "high": { "role": "high", "describe": "Deep thought, review, and the design of verification" },
+        "high": { "role": "high", "describe": "Code review, debugging that crosses modules, concurrency, and designing tests or proofs" },
```

or, once the level names a file (`"describeFile": "personal-high.md"`), by editing
`~/.config/pi/agent/smart-router/personal-high.md` alone ([Jev's prompts](#jevs-prompts)).

**Weigh the demand, or the cost of a move, differently.** A version 2 roster may carry two more
sections at its top level, `demand` and `switching`. Without them, or without any of their fields,
the defaults apply, so no roster needs them. Here they are with every field at its default; added to
a roster as they are, they change nothing:

```json
{
  "demand": {
    "jevWeight": 4, "heuristicsWeight": 1, "minConfidence": 0.6, "closeCall": 0.1,
    "cuts": [0.75, 1.5, 2.25], "deepSessionFloor": "medium",
    "weights": {
      "prompt_shortness": 0.06, "token_shortness": 0.05, "cyclomatic_low": 0.08, "trivial_signal": 0.1,
      "complex_inverse": 0.14, "triage_verdict": 0.18, "turn_type": 0.18, "no_tool_context": 0.05,
      "message_shallow": 0.03, "prose_ratio": 0.03, "requirement_low": 0, "cluster_signal": 0
    }
  },
  "switching": {
    "margin": 0.15, "horizonCap": 5,
    "cacheSurvival": [[60, 0.97], [300, 0.92], [1200, 0.87], [1800, 0.79], [3600, 0.66], [7200, 0.5], [21600, 0.38], [86400, 0.11]]
  }
}
```

To make Jev count for more, raise `jevWeight`; to keep a session on a warm model longer, raise
`margin`. [Levels](#levels) says what each figure does. The checker reads both sections back in
plain words, and refuses weights that are negative or all zero, cuts that do not ascend, and a
survival table whose seconds do not rise or whose chances rise. `requirement_low` and
`cluster_signal` are upstream's signals for its embedding model and its cluster match, which have
no input here; they weigh 0 so that a missing input does not read as easy work.

**Bound or turn off the thinking effort.** A version 2 roster may also carry `adaptiveReasoning`
([Thinking effort](#thinking-effort)). Without it the rule is on with no bounds. To keep every
request at the selected level, as before this rule:

```json
{ "adaptiveReasoning": { "enabled": false } }
```

or to keep the turn's level between `low` and `high`:
`{ "adaptiveReasoning": { "minLevel": "low", "maxLevel": "high" } }`. The checker reads the rule
back in words and refuses a level it does not know and a floor above the ceiling.

A model belongs to one role. To use a model in two places, that is what a fallback chain is for;
listing it in two roles is the error `"<model>" is already in role "<role>"`.

### Checking a roster

```sh
node /path/to/pi-smart-router/src/check-cli.ts ~/.config/pi/agent/smart-router.json
```

or `/smart-router check` in a session. Both use the router's own parser. A valid roster is read
back in plain language: for `smart-router/auto` in each scope, each level's models, the fallback
chain in order; under version 2, how the demand is weighed and when a session moves; for
`smart-router/local`, the local models in order; where each of Jev's prompts comes from; the
account bindings; and each setting it accepts and ignores, with the reason. An invalid one gives
the first error with its place, such as
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
- **An invalid roster still makes every model refuse everything.** That is deliberate: a last
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
  upstream's triage engine decides complex and trivial. Anything else is default. Under version 2
  the same text, capped the same way, feeds the demand's heuristics, and the planning signal is
  their turn type ([The level a prompt needs](#the-level-a-prompt-needs)).
- **One decision per run.** The run is planned when the prompt arrives, and its first request takes
  the plan. Steering, follow-ups and tool continuations stay on the run's model, except that a
  stuck run moves up once ([A stuck run](#a-stuck-run)). A run that starts without a prompt is
  routed as [Runs without a prompt](#runs-without-a-prompt) says.
- **A plan belongs to its message's run.** The router binds the two by a digest of the message's
  text, an HMAC-SHA-256 under a key each router instance draws at random, so it holds no prompt
  text. A run whose prompt is that message's text takes the plan; a run whose prompt is the text of
  another message it saw, whose own run has not started, takes none; and a custom message's run
  takes none. A run that takes no plan is routed as a
  [run without a prompt](#runs-without-a-prompt). A prompt can match no message's text, because Pi
  expands a template or `/skill:` call after the input handlers, and a later extension can change
  the text: such a run takes the plan of the one idle message since the latest prompt's run started,
  and none when there were two. A run that drops a tagged message's plan says so. The limits:
  - identical texts cannot be told apart, so a run can take the plan of another message with the
    same text;
  - a message that a later extension holds, and whose prompt that extension also rewrites, matches
    no text, so its run can take the plan of the one idle message counted;
  - the router remembers the 64 latest messages whose runs have not started, so a message held while
    64 newer ones pass can do the same;
  - after a counted message that never starts its own run (one a later extension handles, an idle
    RPC steer or follow-up, a `prompt()` that throws), the next expanded or rewritten run goes
    unplanned, and is routed as a run without a prompt;
  - a message that a later extension rewrites into the text of a message still held goes unplanned,
    but its run makes the router forget the held one, whose own run can then take the plan of the
    one idle message counted.
- **No hold.** Nothing holds a session on a model by time. Under version 1 a run goes to the role
  its prompt classifies as at once, higher or lower than the latest response's; under version 2
  the level its prompt needs and the cost of the coming work decide ([Levels](#levels)). A
  conversation too large for the model is Pi's to compact, when its compaction is enabled. With
  compaction disabled, version 1 sends a request too large for its model as it is: it has no fit
  rule.
- **Cooldowns.** A physical model's usage-limit, quota, billing or authentication error (401, 403,
  `insufficient_quota`, `ResourceExhausted` and the like) takes it out of routing for
  `cooldownMinutes`, so the next run of any kind moves to the role's next model or its fallback. A
  content-filter or moderation refusal never cools a model and never triggers a fallback, so refused
  content is not sent to another vendor. Local-role models are never cooled, so an oMLX restart does
  not cost 30 minutes of refusals.
- **Whose limit it is.** A limit-kind error is one of three things, and cools accordingly:
  - *The account's:* a usage limit, a quota, billing, or a credential that was not accepted (401).
    On a subscription provider (`openai-codex`, `anthropic`, `github-copilot`, `claude-code`, or a
    Multi-Pass alias such as `openai-codex-2`) it cools every model of that provider id at once, since they
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
  `smart-router/local` stays in the local role and its policy. `status` shows a held
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
    expired, name mismatch); or 502 at the start of the error, or "bad gateway".
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
- **Repetitive output.** Upstream v1.5.0's detector treats a length stop with no tool call as
  degenerate when at least 24 five-grams in its last 8,192 characters are at least 65% repeated,
  after normalizing numbers. The router excludes such a response from its last-answer and cost
  records, including on resume, and warns when it was the routed run's own response. Pi keeps and
  shows the response.
- **Failover within a run.** On a Pi with the `recover` boundary (jwiegley/pi; npm's Pi 1.5.2 has
  none, and there this does nothing), a request that failed can go on with another model in the
  same run: after a repetitive length stop, after an error with an explicit 4xx or 5xx status that
  is the model's own, and after a usage limit or a refused credential, whose model or account is
  cooled first. The alternate is the role's next model, then the scope's chain, and a run that
  moves onto the chain says so. A content-filter refusal never moves, nor does an error about the
  conversation's size, and `smart-router/local` stays local. Pi allows three alternates in a run,
  one after a repetitive stop, and stops when two models give the same 4xx: that is the request's
  fault, and the router cools neither for it. Both responses stay in the session and on screen;
  only the next request's context leaves the failed one out.
- **A model whose requests keep failing** with errors of its own (an explicit 4xx or 5xx, not a
  limit, not 429) is passed over for 30 seconds after the third in a row, upstream's numbers. Like
  the hold for an unreachable server it is a preference: with nothing else to take a request the
  model is tried anyway, an answer from it starts the count again, and `/smart-router status` lists
  it as `Failing`.
- **After a move to another provider** on a retry or a failover, the first tool result's request
  chooses the run's model again, once, as a prompt for the run's level would. While the cause of
  the move holds, that is the model the run is on.
- **Retries.** When Pi retries a failed request, a limit-kind failure moves to the role's next model
  and then its fallback, skipping every model that failed with a limit earlier in the same run, so
  a run tries each candidate once; a local server that could not be reached gives way as above; any
  other failure, rate limits and context overflows included, retries the same model, because Pi has
  already backed off or compacted. Pi does not retry every error: see
  [A fallback chain](#a-fallback-chain) for what a usage limit costs.
- **Compaction and other summaries** go to the model that answered last when it may take them, so
  the transcript does not go to a new vendor; otherwise to the default role (under version 2, the
  session's scope's medium level), or to the local role under `smart-router/local`.
- **Thinking.** Both models offer every thinking level, so a `max` default is not clamped at
  selection. A role with a fixed `thinking` sends it; any other request is sent the effort its turn
  type gives ([Thinking effort](#thinking-effort)), and Pi clamps that to what the routed model
  supports.
- **Declared limits.** Pi and other extensions read a virtual model's context window and output
  budget before the first response. At every session start the router registers its models again:
  auto with the smallest window and output budget among the first available model of each role it
  can reach (under version 2, every level's role and every fallback chain's role in both scopes,
  each resolved in its own scope),
  local with its first available local model's. Before that, both declare 128,000 and 16,384.

The router also tells pi-cache-optimizer, through its `pi.routing.registry.v1` registry, which
physical model each session's next request will use. Without that, the optimizer would rewrite
Codex system prompts, which Codex's content filter rejects, and would drop oMLX session-affinity
headers. Only the session's own agent loop changes what the optimizer reads, never a compaction or
another session. Before a run without a prompt starts, the optimizer is told the model its first
request will take ([Runs without a prompt](#runs-without-a-prompt)), worked out without changing
anything, and not merely the model used last.

## Levels

Under a version 2 roster, `smart-router/auto` sends each run that a prompt starts to one of four
levels of the session's scope. The meanings are the descriptions the example rosters give Jev:

| Level | Meaning |
|---|---|
| SUPER | Deep thought, research, design and planning |
| HIGH | Deep thought, review, and the design of verification |
| MEDIUM | Engineering, implementation and validation |
| LOW | Mechanical or trivial work that follows a clear specification |

A run's model is chosen in two steps, when its prompt arrives: the level the prompt needs, and then,
among the models good enough for that level, the one the coming work costs least on. Need sets the
floor and cost picks above it: cost never takes a run below the level it needs.

### The level a prompt needs

The first rule that applies decides it:

1. **A tag:** the message's last whitespace-separated word, in any case, when it is `#super`,
   `#high`, `#medium` or `#low`, or `#s`, `#h`, `#m` or `#l`. The router removes it before any
   model sees the text. A tag always wins, at once, up or down: no guard raises it, and the cost
   rule does not price it, so the run takes the tagged level's first available model. `#high.`,
   `#hashtag` and `fix issue #12` are not tags.
2. **The demand**, a number from 0 (LOW) to 3 (SUPER) that weighs Jev's judgment together with
   upstream's heuristics, after the guards below.

**Jev's term.** When the roster has a classifier and Jev answers, its four probabilities give an
expected level on the same scale, LOW 0, MEDIUM 1, HIGH 2 and SUPER 3, and its top probability is
its confidence ([Jev](#jev)).

**The heuristics' term.** Upstream's low-intensity scoring, vendored in
`src/triage/tier-features.ts`, is a weighted mean of signals that a prompt is light work; the term
is 3 × (1 − that score). Its signals: the prompt's length in characters and in tokens (the
conversation's size by the latest usage, plus the prompt's), its cyclomatic score, its trivial and
complex keyword hits and the triage engine's verdict on it, its turn type (planning, by the fork's
planning detection in `src/classify.ts`, or ordinary), whether tool results are in the
conversation, how many messages the conversation has, and how much of the prompt is code. The
prompt is capped as the keyword classifier caps it: its first 16 KiB and last 4 KiB. Two of
upstream's twelve signals, its requirement vector and its cluster match, have no input here and
weigh 0, so that a missing input does not read as easy work.

**Which messages the heuristics count.** The latest 20 messages of the conversation, as Pi would
send them to the model: a tool result as a tool message, an assistant message as itself, and
anything else as a user message, which is how Pi sends a `!` shell run. A `!!` shell run, which Pi
keeps out of the model's context, is not counted. An extension's own entry in the session is not a
message entry, so it is not read and not counted. The review script counts them by the same
function, so that a replay sees what the router saw.

**The blend.** With Jev's confidence `c`:

```text
demand = (4 · c · Jev's term + 1 · the heuristics' term) / (4 · c + 1)
```

4 and 1 are `demand.jevWeight` and `demand.heuristicsWeight`. A fully confident Jev carries four
fifths of the result, an unsure one less, and without an answer from Jev the heuristics decide
alone: when the roster has no classifier, when Jev fails (its failure then shows in
`/smart-router history`, as `jev timeout`, for example), and when the router cannot read the conversation, in which case Jev
is not asked at all and its outcome is the failure `error`.

**The guards**, in the order they apply:

- **Low confidence raises only.** When Jev's confidence is under `demand.minConfidence` (0.6), the
  demand is the higher of the blend and the heuristics' term.
- **The cuts, and close calls.** `demand.cuts`, 0.75, 1.5 and 2.25, divide the scale: LOW under
  0.75, MEDIUM under 1.5, HIGH under 2.25 and SUPER from there. A demand within `demand.closeCall`
  (0.1) under a cut takes the level above it, so 0.66 is MEDIUM. (The old `classifier.closeCall`,
  which compared Jev's two likeliest levels, is accepted and ignored: the expected value already
  carries that.)
- **Typed judgment, when asked for.** With `classifier.typedJudgment: true`, the same request also
  asks upstream v1.5.0's six typed questions. `capability_deserved`, whose scores 0 to 3 are LOW to
  SUPER, replaces the level, up or down, at `demand.minConfidence` or above, and can only raise it
  under that. `destructive` at 0.7 or above takes the risky floor below. `task_kind` at
  `demand.minConfidence` or above makes a `plan`, `debug` or `review` prompt a planning one for
  its demand; it never makes a planning prompt not one, and the thinking effort does not read it.
  The other three are recorded only. A missing or
  malformed answer changes nothing.
- **Risky operations get at least HIGH**, whatever Jev says: force push, `git reset --hard`,
  `rm -rf`, `git rm`, unstage, "clean up the repo" or "repo cleanup", and "accidentally added",
  "mistakenly added" or "accidental add", with file names and paths blanked out first.
- **A very deep session gets at least MEDIUM**, `demand.deepSessionFloor`: a conversation over
  100,000 tokens by the latest usage, or an active context of over 1,000 entries where Pi counts
  them. Pi counts the entries of the active context from the last compaction, an extension's own
  entries included. This is upstream's planned floor for the terse "continue" in a long session,
  which no classifier rates well. The floor holds for a run without a prompt too
  ([Runs without a prompt](#runs-without-a-prompt)), so with this default, once the session has
  planned a run, no run in a conversation known to be over 100,000 tokens routes to LOW unless its
  tag says so. That section says when the size is not known. Before a session has planned a run, a
  run without a prompt stays on the model the session used last.
  `"deepSessionFloor": "low"` turns the floor off.
  In such a session each request is checked too: a main-loop request that would go to a model of
  the LOW level goes to MEDIUM's choice instead, when a model that is not a LOW one can take it.
  Planning and tool-result turns, a retry, and a run whose level a tag set are left as they are.

The record of a run says what decided its level: `tag`, `jev` (the blend with Jev's answer),
`heuristics` (the heuristics alone) or `floor` (a risky operation or a deep session raised it).

### Choosing the model

**The candidates** are the first available model of the needed level's own role and of each level
above it, in the session's scope; a model that two levels would take counts once. A model of the
scope's fallback chain is never a candidate. When none of the needed level's own models can take
the run, the cost rule is not asked: the level takes its chain, then a step up, as below.

**The current model** is the model of the latest assistant message on the branch that ended
without an error, when it is one of the candidates.

**The expected cost** of the coming work on a candidate uses the prices Pi's catalog gives for it,
per token, at the price tier the conversation's size falls in: input, cached input and output.
Uncached input counts at the input price, or at the cache-write price once this session's usage
shows the model's provider reporting cache writes.

- **The first request** reads the whole conversation. If the model's cache survives, what it has
  cached costs the cached-input price and the rest the input price; if not, all of it costs the
  input price. The chance it survives is the survival table's at the time since the model's last
  answer (Cache survival, below).
- **Each later request** reads the conversation so far at the cached-input price, and what the run
  added since the request before at the input price.
- **Every request's output** costs the output price.
- **The run's shape** is the median of the branch's last 10 runs: its requests, output tokens per
  request, tokens added per request, and seconds. With fewer than 3 runs it is 5 requests, 800
  tokens, 1,500 tokens and 120 seconds.
- **The horizon.** The requests priced are the run's requests times the horizon: 1, plus the
  earlier prompts in a row on this branch that needed this level or less and stayed on a stronger
  model, at most `switching.horizonCap` (5). Without it, a session that keeps asking for lighter
  work would be kept on the stronger model one cheap-looking prompt at a time.
- **Leaving the current model costs something more.** Every other candidate carries the current
  model's cached size at its uncached premium (its input price less its cached-input price), times
  the chance its cache is gone when this work ends (the survival table at its idle time plus the
  run's seconds times the horizon), times the chance its level is needed again: the share of the
  last 10 prompts that needed its level or more, 0.5 with fewer than 3, and never under 0.2.

**The choice.** The cheapest candidate takes the run, the lower level on a tie. The current model
keeps it unless another is cheaper by more than `switching.margin`, 15% of the current model's
cost, so two costs that look equal in `/smart-router history` are a stay inside the margin. When the model
that answered last is no candidate (it is below the needed level, or is not a level's first
available model, as a chain model is not), the run moves at once to the cheapest adequate model.
That is usually the needed level's own, but a stronger model whose cache is warm can cost less than
a cold one, and history then says `chose`.

**Worked examples.** A 150,000-token conversation, all of it cached on astra, whose last answer was
30 seconds ago; 1,000 output tokens per request; no growth; 60 seconds per run; a 0.5 chance that
astra's level is needed again; uncached input at the input price; the default survival table; and
the catalog prices Pi reports on Hera, in dollars per million tokens of input, cached input and
output: astra (6.2) 8, 0.4 and 40; terra 1, 0.05 and 5; luna 0.1, 0.01 and 0.5. "Move" includes
the cost of leaving astra. The tests pin these figures, rounded here to cents.

| Prompt | Stay on astra | Move | Result |
|---|---|---|---|
| MEDIUM, a run of one request | $0.13 | terra: $0.16 + $0.05 = $0.20 | stays |
| MEDIUM, a run of 20 requests over 20 minutes | $2.03 | terra: $0.39 + $0.12 = $0.51 | moves |
| LOW, a run of one request | $0.13 | luna: $0.02 + $0.05 = $0.06 | moves |
| MEDIUM, one request, the third such prompt in a row (horizon 3) | $0.33 | terra: $0.18 + $0.05 = $0.23 | moves |

The LOW row tests the arithmetic: with the default deep-session floor, a 150,000-token conversation
is never rated LOW.

**Cache survival.** The chance that a model's cache still exists after an idle time is that of the
first pair of `switching.cacheSurvival` whose seconds are not less than the idle time, and zero
past the last pair. The default table is what was measured on Hera from two weeks of Pi session
logs, 17,610 pairs of consecutive requests to one Codex model: still cached after under a minute
97%, up to 5 minutes 92%, up to 20 minutes 87%, up to 30 minutes 79%, up to an hour 66%, up to two
hours 50%, up to six hours 38% and up to a day 11%; the samples beyond 30 minutes are few. The Codex
cache does not expire at five minutes. A model whose catalog entry states a cache lifetime counts
as cached up to that lifetime and not after it.

**Thinking effort.** A model's cached size counts only when the thinking effort it would be sent
now is the effort of its last answer, compared after the model's own mapping of levels. On John's
ChatGPT-account models a change of effort between two requests discards the model's whole prompt
cache, so a change of effort leaves that model nothing cached in the figures: after a `/thinking`
change in a session, the next choice prices the current model as cold, which it is. Each
candidate is priced at the effort the request would be sent on it ([Thinking
effort](#thinking-effort)): on SUPER an ordinary turn is sent `high`, and a planning turn `medium`,
so whether astra's cache counts depends on the turn as well as on `/thinking`.

**A conversation too large for a candidate.** With Pi's compaction enabled, as it is by default,
size removes no candidate and holds no session. A candidate whose window, less Pi's reserve, the
conversation does not fit is priced with the compaction Pi will make before sending to it: one
summary request on the current model (on the candidate itself when there is no current model),
then the run on what the compaction leaves, `keepRecentTokens` plus the summary, with nothing
cached, at the price tier of that size. Pi writes the summary with a request of its own, its own
system prompt and the serialized conversation, which no cache serves. So the summary's input is
priced at the writing model's price for uncached input, on the conversation's size less what the
compaction keeps (`keepRecentTokens`), and its output at 4,000 tokens. When Pi's cut falls inside
a turn it writes two summaries; the second one's output is not priced. The summary's input is an
upper bound, because Pi shortens long tool results before it sends them, and it errs toward
staying. The reasoning a summary may add, the wait before the answer and the detail a summary
loses are not priced. A candidate that compacts shows nothing cached in status, since its cost uses
no cache. Leaving the current model then costs its uncached premium on that smaller conversation,
times the chance its level is needed again. If the candidate wins, Pi compacts
first, the summary written by the model that answered last. With compaction disabled Pi would send
the request as it is, so there a candidate too small for the conversation is passed over, and a
needed level whose first available model is too small passes the run up.

**When the cost is unknown,** the run takes the needed level's own model, `/smart-router history`
says `cost unknown`, and `/smart-router status` says why: `no usage yet`, `no price` or
`the clock went backwards`. It is unknown when:

- the session has no usage yet: no answer on the branch, or an answer without usage or of 0 tokens,
  whatever the size of the new prompt, as for a session's first prompt. A usage with a figure that
  is not a finite number of zero or more is no usage either, and the session's figures record
  nothing from it;
- right after a compaction, after a move to another leaf of the session tree, and in a session that
  starts right after a compaction: no answer has measured the conversation as it now is, until the
  next answer does, and every model's cache is forgotten at the same moment. A move to another leaf
  also starts the branch's run shapes, its count of lighter prompts and its last prompts afresh,
  and the chance a level is needed again is 0.5 until three prompts are counted on the new branch;
  the level the session last needed stays;
- a level's model has no price: a catalog entry whose input or output price is missing or 0 is no
  price at all, never free;
- a candidate's last answer is dated after now: the clock went backwards.

**Step-ups.** A level with no available model, among its own and then its scope's fallback chain,
or, with compaction disabled, whose first available model is too small for the conversation,
passes the run up to the next level, and a notice names the level the pick started at: "no LOW
model can take this run, so it goes to MEDIUM (gpt-6.1-terra)". With compaction disabled, when no
level's first available model fits, the highest level with one takes the run: fit alone never
refuses a run. A run is refused only when neither its level nor any above it has an available
model. A stronger model chosen by cost is no step-up. When a run's pick is an earlier model of its
role than the one that answered last, which costs a prompt-cache miss, its record notes
`returnedToFirst`.

**Fallbacks are the scope's chain, if it declares one** ([A fallback chain](#a-fallback-chain)).
Without one, cooldowns and retries work within a level's role: a retry after a usage-limit or
authentication error goes to the role's next model, and is refused when there is none. With one,
it goes on down the chain. A retry never goes to another level.

### Runs without a prompt

A run that starts without a prompt (a goal continuation, a loop's, any extension's message), and a
prompt's run whose plan cannot be matched to it (another extension changed its text, or Pi expanded
it while two messages were pending), take the highest level among the last three prompts planned
on the branch (John, 2026-11-18). One short question in a goal session therefore does not drop the
continuations that follow to LOW; three light prompts in a row do. With fewer than three prompts
known, it is the highest of those known. With none known on the branch, as after a move to another
leaf of the session tree or in a resumed session, it is the level the session last needed: that of
its latest planned run, or, in a resumed session, of its latest level record. A run without a
prompt is not one of the prompts. In a very deep session that level is raised to the deep-session
floor, as a prompt's demand is: over 100,000 tokens by the latest usage, or over 1,000 entries in
the active context, which Pi counts from the last compaction, an extension's own entries included.
The size is unknown right after a compaction, after a move to another leaf of the session tree,
and after an answer whose usage could not be read, and an unknown size counts as not over. Until
the next answer only the count of entries can raise the level, and after a compaction that count
has started again. A move to another leaf forgets every model's cache even when the new leaf is an
ancestor of the old one, whose conversation the caches still hold. The risky floor needs a
prompt's text and does not apply. Neither the prompts' needs nor the session's own need is raised:
the next run without a prompt starts from them again.

The run goes through the same choice a prompt's run makes, priced with nothing added for a prompt,
and counts, for the horizon and for the chance a level is needed again, as a prompt that needed
its level. Jev is not asked, and the run writes no level record. Its footer names that level, raised
to the floor where the floor raised it, as a prompt's run does: `medium low → gpt-6.1-terra`.
`/smart-router status` says where the level came from
([The footer and status](#the-footer-and-status)).

On `smart-router/local` with per-tier local roles the same runs take the same level, from the last
three planned prompts or else the session's last need, whichever of the two in that order has local
models, and go to that tier's local role. Where neither has, or the session has planned nothing
yet, the run takes the tier of the roster's `local.role`, and `/smart-router status` says so. Nothing is priced and the deep-session floor does not apply. Such a run is
never refused for having no plan: an extension's message, such as a mail notice or a goal
continuation, starts one whenever it arrives.

Apart from that paragraph, all of this is `smart-router/auto` under a version 2 roster. Under
version 1, on `smart-router/local` without per-tier roles, and on `smart-router/auto` in a session
that has planned no run yet, a run without a prompt stays on the model the session used last, as it
always did.

### A stuck run

When a run's last three tool calls in a row failed, whatever the tool and whatever the text, its
next request moves up (John, 2026-11-18: exactly upstream's test below its top tier). A failed call
is a tool result that Pi marks as an error; a successful result among the last three means the run
is not stuck. Upstream's test of identical failure text applies only on its top tier, where it
moves to another top model; here a run on SUPER has no level above and never moves, so that test
is not built. The three are looked for after the latest user message of the request; Pi sends an
extension's own message as a user message, so a run an extension starts is bounded the same way.

- **Where it goes:** one level up, to that level's own model, unpriced. It never goes to a fallback
  chain, whose models may be weaker than the one the run is on, and never looks further up. When
  that model is not available, or with compaction disabled the conversation does not fit it, the
  run stays where it is and nothing is shown, and a later request of the same run can still move.
- **Once per run.** Never from SUPER, never for a tagged run, and only on
  `smart-router/auto` under a version 2 roster: not on `smart-router/local`, under a version 1
  roster or on a model picked by hand. A run without a prompt can move up too. The next run starts
  again from the level it needs.
- **It says so,** once, where it happens: "pi-smart-router: this run's last three tool calls
  failed, so it moves up from MEDIUM to HIGH (gpt-6.1-sol)." The notice names levels and a model,
  never a tool's output. The footer follows the run to the model it moved to, still under the
  level its prompt needs, as in `medium high → gpt-6.1-sol`, and the run's record carries
  `escalated: true`.

### Thinking effort

John's ruling of 2026-11-18: "Exactly as upstream: effort follows each request's turn type." Every
request the router routes is sent the thinking effort upstream's adaptive reasoning gives it
(`src/effort.ts`, from upstream v1.4.0's `adaptive-reasoning.ts`), on both router models and under
either roster version. The turn type comes from the request's last message, as upstream reads it:
a tool result is a *tool result*; a user message whose text holds "plan", "architect" or "design",
in any case and inside a longer word, is a *planning* turn; anything else is an *ordinary* turn.

| The request | Sent at `/thinking medium` (Pi's default) or `off` |
|---|---|
| after a tool result | `minimal` |
| an ordinary turn | `low` |
| a planning turn, on any level | `medium` |
| any other turn on SUPER's model, or in a run that moved up for being stuck | `high` |

- **Any other `/thinking` level** is your own choice and is never lowered: at `high`, `xhigh` and
  `max` nothing changes. At `minimal` or `low` a turn that asks for more is raised to it, as
  upstream raises it: at `low`, a planning turn goes out at `medium`.
- **A role with a fixed `thinking`** keeps it, whatever the turn: the local role's `max` stays.
- **The roster's `adaptiveReasoning`** section turns the rule off (`"enabled": false`: every request
  is sent the selected level, as before), or sets a floor (`minLevel`) and a ceiling (`maxLevel`)
  on the level the turn gives. The ceiling wins over the floor.
- **A model that does not reason**, or one whose catalog maps every level up to the turn's to
  `null`, is sent the selected level. A model whose catalog has no `minimal` and no level below it
  therefore gets its requests after a tool result at the selected level, which Pi clamps to what
  the model supports, while its ordinary prompts go at `low`: at `/thinking medium` such a run
  alternates between the two. This is upstream's rule as written, and a roster floor does not
  change it.
- **A change of effort costs that model's cache.** On John's ChatGPT-account models the prompt cache
  holds only between two requests at one effort, and `minimal` is sent as `low` there, so those
  two are one effort. An ordinary turn after a planning one on the same model, or a tool result's
  request after a planning one, reads the conversation again at the full input price. The cost
  choice prices each candidate at the effort its run's first request would be sent, so that
  request carries the effort its price assumed; a later change of effort within the run is not
  priced.
- **The footer** shows the effort the latest request carried, between the run's level and its
  model: `medium minimal → gpt-6.1-terra` ([The footer and status](#the-footer-and-status)).
  `/smart-router status` says why, on its line `Thinking sent on the latest request`:
  `minimal (after a tool result)`, `low (an ordinary turn)`, `medium (planning)`, `high (SUPER)`,
  `high (a stuck run)`, `max (as selected, never lowered)`, `medium (raised from the selected level
  for planning)`, `max (the role's own level)`, or `(the roster's floor)` and `(the roster's
  ceiling)`, `(as selected)` where the rule leaves the level, as for a model that does not
  reason, and `(as selected; adaptive effort is off)`. Both name the level the router returned;
  Pi then clamps it to what the model supports, so a model that does not reason is sent none and
  a ChatGPT-account model shown `minimal` is sent `low`. A model picked by hand is never routed:
  status shows nothing for it at once, and the footer from the next run's start.

What upstream does that the router does not: it adds a line asking for brevity to the system
prompt of a verbose model at `minimal` or `low`, which a route cannot do; it keeps the session's
level on a request its session pin holds, and the router has no session pin; and it reads three
environment variables for the switches, where the router reads the roster.

### Tags elsewhere

A message that is only a tag sends nothing, with a notice. A tag is removed wherever it is typed,
and where it cannot set its run's level a notice says it has no effect: in a steer or follow-up
typed while a run streams, whose model is fixed until the run ends; on `smart-router/local` or on a
physical model; under a version 1 roster; and in a scope that `smart-router/auto` refuses. An
extension's resend of the latest message's text, as pi-idle-check makes, keeps that message's
level, from its tag or its demand, and Jev is not asked again.

### The footer and status

**The footer** has one item, under the status key `smart-router-level`: the level the run needs,
the thinking effort its latest request carried, and the model that request went to (John,
2026-11-19: "Just the model tier, the thinking level, and which model it's actually using").

| Footer | Meaning |
|---|---|
| `super high → gpt-6.2-astra` | A SUPER run, whose latest request was sent at `high`, on astra. |
| `medium high → gpt-6.2-astra` | The level is the one the prompt needs, so this is a MEDIUM prompt that stayed on astra; at `/thinking medium` a turn on SUPER's model is sent `high`. |
| `medium minimal → gpt-6.1-terra` | The effort follows each request: here the request after a tool result ([Thinking effort](#thinking-effort)). |
| `medium high → gpt-6.1-sol` | The model follows each request too: a stuck MEDIUM run that moved up to sol, or a retry that went to another model. |
| `low → gpt-6-luna` | A prompt that has been planned and whose first request has not been sent: its level and the model picked. |
| `max → GLM-5.3-Flash-oQ4e-mtp` | A run without a level, as on `smart-router/local`, under a version 1 roster, and before a session has planned a run: the effort and the model. |

It shows nothing for a model picked by hand, which is never routed, and it does not say which scope
the session is in, what decided the level, what the cost rule compared, why the effort was sent, or
whether the model is one of a fallback chain. `/smart-router history` and `/smart-router status`
say those.

**`/smart-router history`** shows each planned run in brackets, on the run's first request: its
scope, the level the run needs, the model that took it after the arrow, and what decided.

| History | Meaning |
|---|---|
| `[personal SUPER → gpt-6-astra (tag)]` | A tag set the level; nothing was priced. |
| `[personal MEDIUM → gpt-6.1-terra (demand 1.3; moved, $0.63 vs $2.00)]` | The demand, to one decimal; the run moved, and the cost on the model it moved to is compared with the cost of staying. |
| `[personal MEDIUM → gpt-6-astra (demand 1.2; stayed, $0.10 vs $0.16)]` | The run stayed: the cost of staying against the cheapest other candidate. |
| `[personal HIGH → gpt-6-astra (demand 1.8; chose, $0.14 vs $0.31)]` | No current model was a candidate, and a stronger, warm model cost less than the needed level's own: the chosen model's cost against that one's. |
| `[personal MEDIUM → gpt-6.1-terra (demand 1.0; cost unknown)]` | A figure was missing, so the needed level's own model took the run. |
| `[personal LOW → gpt-6.1-terra (demand 0.4)]` | Nothing to compare: the run stepped up or went to the chain, or took the needed level's own model with no current model among the candidates, or stayed with no other candidate. |

Two marks can follow the demand, and one closes the brackets:

- **`, jev <failure>`** when Jev was asked and gave no answer, so the heuristics decided:
  `[personal MEDIUM → gpt-6.1-terra (demand 0.9, jev timeout; cost unknown)]`. The failures are
  `unavailable`, `error`, `timeout`, `aborted`, `malformed` and `prompt` ([Jev](#jev)).
- **`, floor`** when a risky operation or a deep session raised the level: the demand shown is the
  one before the floor, as in `[personal HIGH → gpt-6.1-sol (demand 0.7, floor; cost unknown)]`.
- **`; fallback`**, last, when the model the plan picked is one of the scope's fallback chain:
  `[personal LOW → z-ai/glm-5.3-flash (tag; fallback)]`.

A run without a prompt plans nothing, so history shows no brackets for it: its request has the
code `run:need`. A stuck run's move is an entry of its own, with the code `escalate`.

**`/smart-router status`** shows the terms of the run the last decision belongs to, a run without a
prompt included, however many requests the run has made: the demand,
with Jev's term and confidence, the heuristics' term with the three signals that raise it most, and
every guard that applied, in the order applied; then the run priced, and each candidate, the
strongest first, with its expected cost, what it has cached and the chance that survives, and what
leaving the current model adds. For a MEDIUM prompt in the first worked example's session, on the
6.2 models whose prices the example uses (the prompt, "Add a test for the parser's error path",
is made up, as is Jev's answer, 80% MEDIUM and 10% each for LOW and HIGH; the conversation's
latest 20 messages include a tool result; the figures are the router's):

```text
  Demand 1.08 → MEDIUM: Jev 1.00 at 80%, heuristics 1.33 (trivial_signal 0.11, triage_verdict 0.09, turn_type 0.09).
  Cost of 1 request, horizon 1: gpt-6.2-astra $0.13 (150,000 cached, 97%); gpt-6.2-sol $0.36 (nothing cached; leaving gpt-6.2-astra $0.05); gpt-6.1-terra $0.20 (nothing cached; leaving gpt-6.2-astra $0.05).
```

History's words for that run are
`[personal MEDIUM → gpt-6.2-astra (demand 1.1; stayed, $0.13 vs $0.20)]`, and its footer, at
`/thinking medium`, is `medium high → gpt-6.2-astra`.
A guard that applied ends the demand line, as in `; guards: close-call, risky.`; a cost that was
unknown gives `  Cost unknown: no usage yet.` in place of the second line. A run without a prompt
shows the level it needed, where that level came from and the level that took it in place of the
demand line, as in `  Need HIGH → HIGH: a run without a prompt, at the highest of the last 3
prompts.`, then its cost line. With fewer prompts known it says `the highest of the last 2 prompts`
or `the level of the last prompt`; with none known, `the level the session last needed`; and
`, raised to the deep-session floor` when the floor raised it. A tagged run shows no terms, since
nothing was weighed, and a model picked by hand shows none.

Two moves the footer shows that are not faults:

- **After a restart, a `/reload` or a move in the session tree**, the session's run shapes start
  again from the defaults. The first lighter prompt is then priced as a run of five requests and
  may move down where a run of one request would have stayed.
- **Unattended runs take the highest of the last three prompts.** A run without a prompt takes the
  highest level among the last three planned prompts on the branch, raised to the deep-session
  floor as before. A prompt another extension sends and the router plans, such as pi-idle-check's
  resend of the latest message, counts too. One short question in a goal session no longer drops
  the continuations to LOW; three light prompts in a row do.

## Jev

Jev is TypeSafe AI's non-generative decision model, reached through OpenRouter. It takes a set of
labelled choices and returns one, with a probability for each. Under a version 2 roster with a
`classifier`, `smart-router/auto` asks it about each message typed while the session is idle:

- **Through Pi.** The router calls only `ctx.modelRegistry.findOfType("classifier", provider, id)`
  and `ctx.modelRegistry.classify(model, context, { timeoutMs, maxRetries: 0 })`. Pi's registry
  holds the credentials and makes the one HTTP attempt; the router reads no credential. A model the
  registry does not list as a classifier is unavailable, and nothing is sent.
- **One request per prompt.** An untagged run waits for the answer. A tagged run never waits:
  Jev's answer is only recorded, as an opinion for training.
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
- **Then the caps.** The message keeps its first 16 KiB and last 4 KiB, as the heuristics see it,
  then its head and tail within `totalChars` (12000); each earlier message keeps its last
  `messageChars` (1500) characters; and earlier messages are kept, newest first, only while the
  whole stays within `totalChars`.
- **Its answer is one term of the demand.** All four probabilities are kept: their expected level
  and Jev's confidence, its top probability, go into the blend with the heuristics
  ([The level a prompt needs](#the-level-a-prompt-needs)).
- **Failures leave the heuristics to decide.** A classifier the registry does not have
  (`unavailable`), an error (an OpenRouter refusal arrives as one), a timeout, an aborted request,
  a malformed answer (a choice that is not one of the four levels, or probabilities that miss one
  or add another label), or a prompt file that cannot be used (`prompt`; then nothing is sent to
  Jev) counts as a failure, and the heuristics decide alone. So does a conversation the router
  cannot read: Jev is then not asked, and its outcome is the failure `error`. The run's record
  names the failure, and so do status and history: `(demand 0.9, jev timeout; cost unknown)`.
- **Never asked** on `smart-router/local` or a physical model, for a steer or follow-up, for a run
  without a prompt, without a classifier, under a version 1 roster, in a session whose scope
  cannot be read or that the roster does not serve, for a message that is only a tag, or for an
  extension's resend of the latest message's text.
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
  or one that still holds a `{{placeholder}}` or a line starting with `TODO`) stops no route. Jev
  is not asked in the scopes that need that file, the heuristics alone give their demand, the
  history marks it, as in `(demand 0.5, jev prompt; cost unknown)`, the session says so once when it
  starts, and `/smart-router status` and the checker name the file and the cause. The router never
  falls back to an older text.
- **`/smart-router status`** shows the source of every prompt in force: `built-in`,
  `inline in the roster`, or `file <path>`, with its length.

**You edit guidance, not the protocol.** These stay fixed in code, whatever a prompt says:

- the request has one question, a choice among exactly `low`, `medium`, `high` and `super`;
- an answer counts only when it names one of those four and gives a probability for each;
  anything else is discarded as malformed and the heuristics decide alone;
- the level is routed within the session's scope, by that scope's levels, account bindings and
  exclusions; a prompt cannot name a model or change the scope;
- redaction, the size caps, the tag syntax (`#low` … `#super`) and the guards, the floor for risky
  operations among them.

`test/prompts.test.ts` gives the router a prompt that asks for another label, a work-account
model, work scope and the lifting of the local-only pin of earlier versions, with a classifier that
does as it says, and shows that none of it happens.

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
cycling, or restored with a session, stays selected and is sent as it is, in personal scope and in
work scope. The router routes only while the selection is one of its own models:
`smart-router/auto`, `smart-router/personal`, `smart-router/work` or `smart-router/local`.

Each row below is asserted by the tests under "the router's handlers", "a model picked by hand in
work scope" and "a restored selection" in `test/selection.test.ts`, on Hera's rosters. Scenarios 6
to 9, 11 and 26, and L5, L6 and L10, of `test/behaviour.test.ts` show the same in Pi's own runtime.

| In a work session | What happens |
|---|---|
| `/model openrouter/moonshotai/kimi-k3.1-pro`, or cycling to `openai-codex-2/gpt-6.1-sol` | That model is the selection. The router shows no notice and selects nothing. |
| `xai/grok-4.7` picked in a work session, the case John reported | It stays. The notice "so xai/grok-4.7 was not kept, and the selection is smart-router/auto again" no longer exists. |
| Four picks in the same instant | Each is kept. Nothing counts picks, and no session is locked. |
| The prompt "fix the build", and a steer typed while it runs | Both are sent. |
| The run's `turn_start` | Nothing is switched, and the run is not aborted. |
| The provider request | The router registers no handler for it, so the payload arrives whole. |
| Cache warming | The router registers no handler for it, so Pi's own decision stands. |
| A compaction, and `/tree` with a summary | Each proceeds, on the model picked by hand. |
| A work session resumed on such a model, by its entry or its work directory; a session of a latched process at startup, resume, reload, `/new` or a fork | It starts on that model, and nothing is selected in its place. |
| Another extension selects a model, as Multi-Pass `allowedSubs` does | Its selection stands as a hand's does. The router cannot tell the two apart, and answers neither. |

The consequence, which John accepted: in a work session, a personal-account or OpenRouter model
picked by hand receives that conversation under that account.

**The router's own models keep their policies, in their routes.** A request their policy does not
allow is refused by the model that was asked, and the selection stays where it was:

| Selection | Session | Its requests |
|---|---|---|
| `smart-router/auto` | work scope | Use a work-bound Codex or Claude Code model, or an explicitly configured per-level local fallback. Refuse when the roster serves no work scope, or the scope cannot be read. |
| `smart-router/local` | either scope, or a scope that cannot be read | Use only local roles, never a cloud model. With local tiers, a disabled or unplanned tier refuses. A personal-only restriction refuses work and unreadable scope. |

John's decision of 2026-11-16, "Let smart-router/local route in work scope": selecting
`smart-router/local` is itself the request for local routing, so it normally routes in a work session.
The consequence: in a work session, on the shared work machines too, selecting
`smart-router/local` sends the conversation to the roster's local models, not to the work account.
A personal-only restriction refuses that work session instead.
Until 1.4.0-jw.1 that request was refused unless the session was pinned, with the local-only pin
that has since been removed.

John's decision of 2026-11-17, "Let local route there too": normally `smart-router/local` routes in
an unreadable scope too; the personal-only restriction refuses it. Until 1.4.0-jw.2 an unreadable
scope was refused unless pinned. `smart-router/auto` still refuses one, since it cannot tell which
account the session's requests may use.

In work scope a refusal names only `smart-router/auto` and work Codex models as
models to choose, since those keep the conversation on the work account. Any other model you pick
is kept all the same.

**No switch.** No command and no event selects a model. The local-only pin's
`/smart-router local on`, which selected `smart-router/local`, was the one place that did, and it
has been removed. Each of these is a test in `test/commands.test.ts`:

- `/smart-router scope work` with Kimi selected answers "pi-smart-router: scope work (entry)." and
  "The selection stays openrouter/moonshotai/kimi-k3.1-pro. A model picked by hand is sent as it is,
  in work scope too."
- `/smart-router scope work` with one of the router's own models selected selects
  `smart-router/work`, and answers "The selection is now smart-router/work."
- `/smart-router scope personal` leaves a model picked by hand selected too.

## Scope: personal or work

Every session has a scope, and version 2 routes it within that scope's levels, exclusions and
account bindings. The first rule that applies decides it:

1. **The latch.** `PI_SMART_ROUTER_SCOPE=work`, exactly, puts every session of the process in work
   scope. It is read each time the router loads; once seen, it holds for the life of the process,
   even if the variable is removed later. nix-config's shared-work profile is to set it.
2. **The session's entry.** `/smart-router scope work` and `/smart-router scope personal` record a
   `smart-router.scope` entry in the session, and resume keeps it. Selecting `smart-router/work`
   records the same work entry.
   - Personal to work takes effect at once, for the routes of the router's own models. A model
     picked by hand stays selected and is sent as it is, and the answer says so. One of the
     router's own models gives way to `smart-router/work`.
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

`PI_SMART_ROUTER_PERSONAL_ONLY=1` is a separate process-lifetime restriction; the alternative
`PI_SMART_ROUTER_SCOPE=personal-only` has the same effect. It does not rewrite a session's scope:
the router refuses both virtual models when the scope is work or cannot be read, asks no Jev, and
refuses `/smart-router scope work` without recording an entry. If both restrictions are present,
the work latch makes the session work and the
personal-only restriction refuses it. **A model picked by hand and other extensions are not blocked:**
this is a boundary on the router, not a guarantee that Pi itself cannot send work content.

A fork or `/new` carries the scope that the latch, an entry or the work directories gave into the
session it creates, which records it as an entry of its own, with a notice. The personal default is
not carried, so the new session decides its own. A scope that cannot be read is carried as work
scope, the scope the router routes that session in.

**It fails closed.** A malformed `smart-router.scope` entry, a custom message of that type, or a
session whose entries cannot be read has an unreadable scope: `smart-router/auto` refuses until
`/smart-router scope work` or `/smart-router scope personal` records a scope again.
Normally `smart-router/local` can still route to its local roles, resolving in work scope. Under a
personal-only restriction it refuses an unreadable scope too.

**Where each scope's requests go.** Scope governs the router's own models, and nothing else.
`smart-router/auto` and `smart-router/personal` never send a personal session to a work-bound
account. `smart-router/auto` and `smart-router/work` send a work session only to work-bound Codex
or Claude Code, or to explicitly configured per-level local fallbacks. No provider order changes
either rule.
A version 1 roster serves no work scope: `smart-router/auto` refuses a work session, and the check
on every pick refuses it again. A latched process whose roster has no work scope refuses every request
on `smart-router/auto`, and `/smart-router status` says why. Normally `smart-router/local` serves both
scopes and an unreadable scope, using only local roles. A personal-only restriction refuses work or
unreadable scope on every model. In either scope a model picked by hand
is sent as it is, a work-account model in a personal session included
([A model picked by hand](#a-model-picked-by-hand)).

### The scope's own models

`smart-router/personal` and `smart-router/work` route by level exactly as `smart-router/auto` does,
with Jev, tags, the cost rule and the fallback chain, each in its one scope. The session's scope
decides which accounts its content may reach. The selection never does.

| You select | In a personal session | In a work session |
|---|---|---|
| `smart-router/auto` | Routes the personal levels. | Routes the work levels. |
| `smart-router/personal` | Routes the personal levels. | Asks "Move this session to personal scope?", the question `/smart-router scope personal` asks. Declined, the session stays a work session and the model refuses every request with "Nothing was sent". |
| `smart-router/work` | Records work scope, with a notice, and routes the work levels. The session stays a work session whatever you select later. | Routes the work levels. |
| `smart-router/local` | Routes the local roles. | Routes the local roles. |

- **The question is asked only when you select the model by hand**, with `/model`. A selection Pi
  restores with a session, or reaches by cycling, asks nothing: `smart-router/personal` refuses the
  work session until you run `/smart-router scope personal` or select another model.
- **Under `PI_SMART_ROUTER_SCOPE=work`** no session can leave work scope, so
  `smart-router/personal` refuses and asks nothing.
- **On a personal-only host** `smart-router/work` refuses and records nothing, as
  `/smart-router scope work` does there.
- **A scope the roster does not serve** is refused as on `smart-router/auto`: a version 1 roster
  serves only personal scope, so `smart-router/work` refuses under it.

`/smart-router scope work`, `personal` and `local` select that scope's model whenever one of the
router's own models is selected, so the command and the model always name the same scope. A model
picked by hand is never replaced. `/smart-router scope local` selects `smart-router/local` and
records no scope: the session's own scope, personal or work, stays as it is.

A run that is under way when the scope changes keeps its level. After `/smart-router scope work`
in a personal run, none of the run's models may be used any more, so its next request takes the
level the run had, in work scope: that level's own models, its fallback chain, then a level above,
never one below, and never a personal model. When nothing at that level can take it the request is
refused with "Nothing was sent" instead of going on at a lower level. The footer then names the
work model beside the run's level, the status and the run's level record name work scope and that
model, without the cost figures of the scope it left, and `/smart-router history` marks the request
`run:level`. A retry keeps its own rule: content the personal model refused is not sent to a work
model either. A run without a level (a session that has planned nothing) goes to the scope's
default role, as before.

### Work scope and the selection

Work scope has no hold on the selection. Until 1.3.0-jw.2 a work guard switched any selection but
`smart-router/auto` and the work account's models back to `smart-router/auto`, and locked a session
that something kept switching away. John's decision of 2026-11-16 removed it: a model picked by
hand stays selected in a work session and is sent as it is.

- **A failed reload moves no session.** While the roster fails to load, the scope reads the work
  directories of the last valid roster loaded in the process, which the process slot keeps. Every
  one of the router's models refuses until the roster loads; a model picked by hand is sent as it is.
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
  in it, and a fork made from the command line (`pi --fork`) copies
  the entry with the rest of the session. pi-subagents children start with no entries, so it does
  not reach them. Run work in a work directory or in a latched process, which reach a child that
  loads the router as they reach any session.
- **Rollout order.** Write the version 2 work roster before setting `PI_SMART_ROUTER_SCOPE=work`: in
  a latched process with a version 1 roster, `smart-router/auto` sends nothing, and
  `smart-router/local` sends only to the local models; with no roster loaded, both refuse every
  request.

## The provider order

A tier's role lists its models in the order they are tried: on John's hosts a Codex model, then a
Claude model, then an OpenRouter model. The provider order changes which provider comes first
without changing the models.

```text
/smart-router prefer claude
```

In every tier of the session's scope, Claude's model is now tried first, and the others follow in
the order the roster gives them. `/smart-router prefer codex` puts Codex first again.

| Command | Does |
|---|---|
| `/smart-router prefer PROVIDER...` | Puts those providers first, in that order, in every tier of the scope. |
| `/smart-router prefer TIER PROVIDER...` | The same for one tier: `low`, `medium`, `high` or `super`. |
| `/smart-router prefer SCOPE ...` | Names the scope: `personal`, `work` or `local`. Without it, the scope is the session's, or `local` while `smart-router/local` is selected. |
| `/smart-router prefer reset` | Returns every scope to the roster's order. `prefer SCOPE reset` and `prefer TIER reset` return one scope or one tier. |
| `/smart-router prefer SCOPE` | Shows that scope's tiers. |
| `/smart-router tiers` | Shows every scope the roster has, its tiers, and each tier's models in the order this session tries them. |

- **A provider is named by its id or by any part of it** that fits one provider only: `claude`
  names `claude-code`, and `codex` names `openai-codex`. A word that fits two is refused.
- **An order names only providers the scope's tiers already hold.** `prefer` cannot bring a
  provider into a scope: a personal session cannot name a work-bound account, and a work session
  cannot name a personal one. Every pick still passes the account, scope and local-host checks.
- **The order is the session's alone.** The router keeps it in memory. It writes no file and no
  session entry, so a new, resumed or forked session starts from the roster as written.
- **An order for every tier replaces the single tiers' orders** of that scope.
- **The local roles have an order of their own**, wherever they are used: on `smart-router/local`
  and as a level's local fallback. The personal and work orders never reorder them.
- **A provider with no model in a tier** leaves that tier as it is.

To make an order the default on a host, write it in the roster:

```json
"providerOrder": {
  "personal": ["claude-code", "openai-codex"],
  "local": ["omlx-hera"]
}
```

`/smart-router check` reads the roster back in that order, and `/smart-router status` says whose
order is in effect: the roster's, or the session's.

## Routing locally

To route a session locally, select `/model smart-router/local`, or run `/smart-router scope local`,
which selects it. It uses only the roster's local
roles, inside the configured providers and LAN hosts. Normally it works in either scope or an
unreadable scope; a personal-only restriction refuses work and unreadable scope. With `local.levels`,
offline demand or a tag selects a tier. A prompt whose tier is null is refused with "Nothing was
sent"; it does not step down or ask Jev. A run without a plan takes the session's level
([Runs without a prompt](#runs-without-a-prompt)). Without `local.levels`,
the legacy local role is tried in order. A model picked by hand afterwards is sent as it is, and
`/smart-router status` lists what else can send data off the machine. For strictly private work,
keep using a dedicated session on a local model with pi-warden off (`NIX_MANAGED_PI_WARDEN=off`).

Earlier versions also had a local-only pin: `/smart-router local on|off|status`, a
`smart-router.pin` session entry and the `PI_SMART_ROUTER_LOCAL_ONLY` environment variable, which
kept both of the router's models on local models. John's decision of 2026-11-18 removed it:
`smart-router/local` already routes locally. A second decision of the same day left no trace of it:

- **`/smart-router local`** is an unknown subcommand: whatever follows, it answers with the usage,
  as any unknown subcommand does, and records and selects nothing. `/smart-router scope local` is
  the command that selects `smart-router/local`.
- **`PI_SMART_ROUTER_LOCAL_ONLY` is ignored.** Nothing reads it and nothing is shown for it. It
  selects and routes nothing.
- **An old pin entry is ignored.** The router does not look for one, and nothing is shown for it.
  A session file that holds one, and level records of earlier versions, still load without an
  error, and `smart-router/auto` routes the session by level.

## Records and training

A run that still holds a level when it settles leaves one `smart-router.level` entry in its session,
however it ended. A message on a physical model, under a version 1 roster, or on legacy
`smart-router/local` without local tiers gets no level; a run without a level leaves no entry. A run
without a prompt plans none of its own.

The router can drop a level before its run settles, and a run can record a level that another
message planned. These can happen when messages overlap, as when several wait for Jev together or a
steer arrives while a run settles, and when the selection, the scope or the roster changes
after a message was planned. A run that stays on a model picked by hand after its message was
planned is different: its requests do not go through the router, so the plan is not compared, and
the entry keeps the planned level, with the hand-picked model as its `ref` when that model answered.
The tests under "a run's record" in `test/router-levels.test.ts` pin some of these cases, and the
rest can vary. A record is a label, so check it against its session before training on it.

The entry's fields:

- `v`; `at`, when the run was planned; and `scope`;
- `source`, what decided the level: `tag`, `jev` (the blend with Jev's answer), `heuristics` (the
  heuristics alone) or `floor` (a risky operation or a deep session raised it);
- `need`, the level the run needed, its tag's or its demand's after the guards; `tier`, the level
  whose model took it, `need` or a level above it; and `tag`, for a tagged run;
- `trigger`, the risky operation that raised the run to HIGH;
- `demand`, for an untagged run: its `value` before the floors; `tier`, the level after every guard,
  floors included; Jev's term (`value` and `confidence`) when Jev answered, the heuristics' term
  (`value`, upstream's `score`, and the three signals that raise it most, each with its share), and
  the `guards` that applied, in the order applied (`low-confidence`, `close-call`, `typed-judgment`,
  `risky` or `destructive`, `deep-session`);
- `keyword`, the keyword classifier's signal and reason; its planning signal gives the heuristics
  their turn type;
- `jev`: Jev's model, choice, probabilities, confidence and latency (`ms`), or its failure
  (`unavailable`, `error`, `timeout`, `aborted`, `malformed` or `prompt`). A tagged
  run whose answer had not come when it settled records `{ "late": true }`. The field can be absent,
  as it is without a classifier, and an extension's resend can repeat the answer its message got
  before;
- `ref`, the model of the run's last assistant message that ended without an error or degenerate
  output, absent when no model answered;
- `cost`, when the cost rule was asked: its `outcome`, `unknown` with the reason `why`, or
  `stayed`, `moved` or `only` (no current model among the candidates); the model `chosen` and the
  `current` one; the run's expected `requests`, the `horizon` and the chance `again` that the
  current model's level is needed again; and for each candidate its `ref`, `tier`, expected `cost`
  (leaving included), the `leaving` part, the tokens `cached`, the chance `survival` and whether it
  `compacts` first. A tagged run, and one that stepped up or went to the chain, has none;
- `steppedUp`, `returnedToFirst`, `escalated` (a stuck run moved up a level) and `aborted`, when
  they apply; and `fallback`, when the model that answered is one of the scope's fallback chain.
  `tier` is the level whose model the plan picked all the same: a fallback or an escalation never
  changes it.

Records of earlier versions still read: one with `source: "keyword"` and `asked` in place of
`need`, as 1.4.0-jw.4 and before wrote them, is read with its `tier` as the run's need, by a
resumed session and by `/smart-router was`.

A record holds no prompt text and no digest of it: model refs, numbers, level names, signal and
guard names, outcome names. It normally follows its run's first user message,
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
per level where John's tags and corrections disagree with Jev, the heuristics and the blend, and
proposes revised descriptions and instructions, and revised `demand` weights and cuts or a revised
`switching.margin`, as a diff to that host's roster and prompt files. Nothing changes until John
approves it. Records stay on the host that made them, and work records are read only there. The
router itself reads no other session and does not write the roster.

**The review script**, `scripts/review-demand.ts`, is the review's tool:

```sh
node --experimental-strip-types scripts/review-demand.ts <session.jsonl>...
```

It replays the runs the named session files recorded and reports, for the runs John judged (he typed
a tag, or corrected the level afterwards), how often the heuristics alone, Jev's top choice alone
and the blend named the level he meant. For each such run it replays the first user message at or
after the record's time, less two seconds, else the latest one before it, through the router's own
demand code at the default settings. It is a development script, not part of the extension: Pi never
loads it and the package does not ship it. It reads only the files named on its command line,
contacts nothing, and prints counts, levels, rates and file names, never a prompt's text. Since
John's session files are under Pi's agent directory, it runs on them only at his word.

Its facts differ from the router's in two ways. It counts every entry on the chain, where Pi counts
the active context's entries from the last compaction, and it takes the conversation's size from
the latest usage even after a compaction, where the router counts the size as unknown until the
next answer. A replay can therefore raise the deep-session floor where the router did not.

## Commands

| Command | Does |
|---|---|
| `/smart-router` or `/smart-router status` | The roster's path and state; the selection and its thinking level; the session's scope and what set it, under a version 2 roster or whenever `smart-router/auto` refuses the scope; every role's models on this host with `ok` or the reason they cannot route, and catalog prices; the accounts cooling and the local models held as unreachable; account bindings, checked in the session's scope, and auth sources; a version 1 roster's routing table and fallbacks, or a version 2 roster's levels and fallback chain in each scope, its classifier and the source of each of Jev's prompts; the last decision, and whether it went to a fallback chain's model; the terms of the run that decision belongs to, kept from that run's choice however many requests it has made: a planned run's demand with every guard that applied, or a run without a prompt's need and level, and each candidate's expected cost, or why the cost was unknown; none for a tagged run or while a model picked by hand is selected ([The footer and status](#the-footer-and-status)); the thinking effort the latest request carried and why ([Thinking effort](#thinking-effort)); what can still leave the machine, a model picked by hand first and then the classifier when `smart-router/auto` may ask it; and a warning for any fallback that would move a run onto Codex's API from another one. |
| `/smart-router history [n]` | The last `n` routing decisions (10 by default, at most 50), with reason codes, and on a version 2 run's first request its level's words: its scope, the level it needs, the model that took it, what decided the level and what the cost rule compared. Model ids and codes only, never prompt text. |
| `/smart-router scope [work\|personal\|local\|status]` | The session's scope and what set it: `latch`, `entry`, `directory` or `default`. `work` records work scope at once; `personal` asks first in work scope, and is refused under `PI_SMART_ROUTER_SCOPE=work`; `local` selects `smart-router/local` and records no scope. Each selects its scope's model when one of the router's own models is selected, and leaves a model picked by hand selected ([The scope's own models](#the-scopes-own-models)). |
| `/smart-router prefer [personal\|work\|local] [low\|medium\|high\|super] PROVIDER...` | Put those providers' models first in every tier of a scope, or in one tier, for this session; `reset` in place of the providers returns to the roster's order ([The provider order](#the-provider-order)). It writes no file and no entry. |
| `/smart-router tiers` | Each scope the roster has, its tiers, and each tier's own models, local fallback and fallback chain, in the order this session tries them. It reads the roster alone; `status` adds what each model can do on this host. |
| `/smart-router was low\|medium\|high\|super` | Record that the run in flight, when it holds a level, or else the run of the latest record, should have gone to that level. Nothing is sent again. |
| `/smart-router check` | Read the roster and its prompt files again and read them back: what each selection and scope routes to, in order, the demand and switching settings, where each of Jev's prompts comes from, and the settings accepted and ignored; or the first error, with its place. It selects, records and sends nothing. [Checking a roster](#checking-a-roster). |
| `/smart-router reload` | Read the roster, its prompt files and Multi-Pass's labels again now, and register the models again if their limits changed. |

## Interactions with other extensions

- **pi-cache-optimizer** works through the routing registry, as described above.
- **pi-openai-codex-compat** still wraps routed `openai-codex` requests, but whatever it keys on the
  *selected* model does not apply to them: its request options, its Codex tool surface and its remote
  compaction. On a branch with a native Codex compaction checkpoint it switches the selection back
  to Codex, and the router leaves it there: the session is then on Codex. Start local work outside
  such a branch. Hera's `openai-codex-2` never uses codex-compat.
- **goal-x**: continuations route like any
  [run that starts without a prompt](#runs-without-a-prompt), and they get cooldowns and fallbacks.
  The default auditor routes through the session, on the selection it inherits; a configured auditor
  bypasses the router, so leave it unset in private work. Leave `auditorProjectResources` and
  `projectResources` off: each loads a second router into every audit. The default auditor routes in
  the session's scope too, one an entry set included; a configured auditor bypasses work scope as it
  bypasses the router ([What work scope does not cover](#what-work-scope-does-not-cover)).
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
  its tag or its demand gave it.
- **pi-warden** aggregates statistics under the virtual id. Its judge is independent of the router.
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

- **Per run:** choose another model with `/model`. It stays selected, in work scope too.
- **Per session:** `/smart-router scope personal` moves a work session to personal scope after
  confirmation, except under the latch.
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
- `scripts/` holds development scripts, which never run in a session and are not shipped:
  `vendor-drift.mjs` compares the vendored upstream files with an upstream clone, and
  `review-demand.ts` is the review script ([Records and training](#records-and-training)), which
  reads only the session files it is given.
- Never run Pi's own test suites on the host, and never start a real Pi session from a test.
- [AGENTS.md](../AGENTS.md) holds the rules for coding agents.

## License

MIT; see [LICENSE](../LICENSE). Copyright (c) 2026 beettlle and contributors, and Copyright (c) 2026
John Wiegley for the port. The triage engine, the entropy check and the low-intensity scoring
(`tier-features.ts`) in `src/triage/` are upstream's, taken at commit
`54bee53d908a81260a34b94cbe124bfd61f57df7` (v1.4.0) and changed only in their import specifiers
(`tier-features.ts` also carries a header and reads its types from `types.ts`).
`scripts/vendor-drift.mjs` compares them with an upstream clone; upstream v1.5.0 (`f22cbe9e`) left
all three as they were. The repetitive-output test in `src/output-quality.ts` and the typed
questions in `src/jev.ts` follow upstream's `src/domain/delegation/degenerate-output.ts` and
`src/domain/judgment/questions.ts` at `f22cbe9e`.
