# Four intelligence levels, classified by Jev

Design for John Wiegley's fork of pi-smart-router (jwiegley/pi-smart-router, base v1.3.0-jw.1).
Written 2026-11-09 from a design conversation with John, then revised after an independent builder
check. Choices John made are stated as his. Choices the designer made are marked
**(designer's call)**; John can override them. What remains open is listed at the end.

**Note of 2026-11-16.** John decided that a model picked by hand always stays selected and is sent
as it is, in work scope and under the local-only pin ("Manual choice always wins"). That decision
supersedes three things below: the paragraph "Selection guard in work scope"; the anti-goals where
they speak of a model John selected by hand, or of any text leaving the LAN under the pin; and the
designer's call "In work scope, the router guards the selection the way the pin does". The router's
own two models keep the policies this design gives them. The rest of this document stands as
written on 2026-11-09; the README and the CHANGELOG entry for 1.3.0-jw.3 describe the router as
built.

## Intent

John wants each message he sends through `smart-router/auto` to go to a model whose intelligence
matches the work it asks for, on four levels. He wants to teach the router his judgment as he works,
by tagging the occasional message with the level he wants. He works on personal and work projects in
the same Pi on his Macs, and on separate work machines. Work must stay on the work Codex account.

Today's classifier is deterministic: planning patterns plus upstream's keyword triage
(`src/classify.ts`, `src/triage/`). It cannot tell what a short follow-up such as "go ahead" needs,
and it cannot learn. Jev can do better at the first and gives the second a footing. Jev is
TypeSafe AI's non-generative decision model, reached through OpenRouter. It takes a caller-defined
set of labelled choices and returns a choice, with a probability for each. It costs about $0.042
per million input tokens (output is free), and its published typical latency is 0.13-0.28 s.

## The four levels

| Level | Meaning |
|-------|---------|
| SUPER | Deep thought, research, design and planning |
| HIGH | Deep thought, review, and the design of verification |
| MEDIUM | Engineering, implementation and validation |
| LOW | Mechanical or trivial work that follows a clear specification |

These meanings are the starting descriptions Jev reads. They live in the roster, so John can revise
them; see Training.

## Goals

1. Every run on `smart-router/auto` is routed to one of four levels.
2. John can force a level for one message with a trailing hashtag.
3. Jev classifies untagged messages from the message and the recent conversation.
4. Each routed run records John's tag (if any) next to Jev's pick, so that an agent can propose
   better level descriptions for John's approval.
5. Every session has a scope, personal or work. A personal session uses Codex first, then
   OpenRouter. A work session uses only the work Codex account, with Jev allowed for
   classification. This holds on his Macs (one Pi for both scopes) and on his work machines.

## Non-goals

- No fine-tuning and no self-modification: level descriptions and thresholds change only when John
  approves an edit to the roster.
- No learning store written by the router, no embeddings and no vector store.
- No change to `smart-router/local` or to the local-only pin, which still routes only to the local
  role (GLM on Hera). The pin also blocks the new classifier request.
- No rerouting of a turn that has already been answered. A correction is a label only.
- No switching of models in the middle of a run. A tag acts on a new message only.
- No key bindings for now. Hashtags are the only way to tag.

## Anti-goals: failure even if the feature works

- Any message text leaving the LAN under the local-only pin (session pin or
  `PI_SMART_ROUTER_LOCAL_ONLY`) or on `smart-router/local`.
- Any OpenRouter model answering a work session, whether the router routed it or John selected it
  by hand. Jev's classification request is the one allowed OpenRouter use in work scope.
- A personal account answering a work session, or a work account answering a personal one.
- Work content moving into a personal session without John confirming it.
- A Jev outage that delays a send by more than the 1 s budget, blocks a send, or silently picks a
  more expensive model than these rules allow.
- The answering model seeing the tag.
- Prompt text stored by the router anywhere new, or sent to Jev with secrets left in it.

## What John decided (2026-11-08 and 2026-11-09)

1. **The four levels and their meanings**, as in the table above.
2. **Personal ladder: Codex first, then OpenRouter, at every level.**
   - SUPER: `gpt-6-astra`, then `openrouter/moonshotai/kimi-k3.1-pro`.
   - HIGH: `gpt-6.1-sol`, then `openrouter/z-ai/glm-5.3`.
   - MEDIUM: `gpt-6.1-terra`, then `openrouter/deepseek/deepseek-v4.1-flash-1017`.
   - LOW: `gpt-6-luna`, then Qwen3.8 on Nyx, then Hera's Qwen3.8
     (`omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp`).
   - The Codex models come from his personal ChatGPT subscription. On Hera that is the Multi-Pass
     alias `openai-codex-2` (label "personal"); on his other personal hosts, the native
     `openai-codex` login. "Codex first" means a level returns to its Codex model as soon as that
     model is available again.
3. **Work ladder: Codex only, never an OpenRouter model.** In his words, "only codex and never
   openrouter (except for the ways in which I use Jev)". SUPER `gpt-6-astra`, HIGH `gpt-6.1-sol`,
   MEDIUM `gpt-6.1-terra`, LOW `gpt-6-luna`, all on the work account. On Hera that account is the
   Multi-Pass alias `openai-codex-3`.
4. **The router runs at work too.** This reverses his 11-08 choice; nix-kici keeps only its builder
   change. He does work on the shared-work machines, and also in the same Pi on Hera and Clio. So
   scope is decided per session.
5. **Jev's account at work** is whatever pi-warden's judge already uses on the work machines. It is
   to be confirmed before rollout. On the Macs, that is Pi's OpenRouter login, for both scopes.
6. **Tagging is a trailing hashtag**: `#super`, `#high`, `#medium` or `#low`, or `#s`, `#h`, `#m`,
   `#l`, as the last word. The tag is removed before the model sees the text.
7. **A tag always wins, at once, up or down**, overriding the five-minute rule. If the conversation
   is too long for the tagged level, the router moves up one level and says so. Untagged messages
   keep the five-minute rule.
8. **Jev reads the message plus recent conversation**, capped. This is the same in both scopes.
9. **The 1 s limit and close calls.** If Jev fails, refuses, or takes longer than 1 s, the keyword
   classifier decides. When Jev's top two levels are within about 15 percentage points, the router
   takes the higher one. The threshold is a starting point that training tunes.
10. **Risky operations get at least HIGH.** A message that trips the keyword classifier's
    destructive-intent or repo-hygiene triggers goes to HIGH or above, whatever Jev says. An
    explicit tag still wins. The triggers are force push, `git reset --hard`, `rm -rf`, `git rm`,
    unstage, "clean up the repo" and "accidentally added".
11. **The local-only pin is unchanged.** Under the pin, the router routes only to the local role's
    GLM, as today.
12. **Training is an agent review when John asks.**
    - The agent reads that host's session records, shows where John and Jev disagreed, and proposes
      new descriptions and a new threshold as a roster edit.
    - Nothing changes until John approves.
    - Records stay on the host where they were made.
13. **Jev is never consulted under the local-only pin or on `smart-router/local`.**

## Constraints

- **The fork's invariants** (`AGENTS.md`, `README.md`, CHANGELOG Security, the source scan):
  - Runtime code opens no network connection, starts no child process, sets no timer and writes no
    file.
  - It reads only the roster and Multi-Pass's labels, through `src/files.ts`.
  - Session reads go only through the bounded readers.
  - The source scan enforces an import allow-list and forbids dynamic code.

  This feature changes exactly one invariant: the router asks Pi's model registry to make one
  classifier request per routed run. The request goes through Pi (`ctx.modelRegistry.classify`, the
  path Pi's `examples/extensions/jev-router.ts` uses), so the router still holds no network code,
  and the scan still holds. The README, CHANGELOG and Security sections restate the invariant in
  those terms.
- **Pi 1.5 (jwiegley/pi 1.5.0)** provides:
  - the classifier API;
  - `input` results with `{action: "transform"}`, which Pi awaits before the run starts;
  - `pi.appendEntry`;
  - `ctx.ui.setStatus`, `ctx.ui.select` and `ctx.cwd`;
  - the bounded session readers.

  Escape cannot cancel anything before a run starts, so the classifier needs its own deadline.
- **Jev:**
  - One `choice` question, whose criteria map each label to a description. It answers
    `{choice, confidence, probabilities}`.
  - It has no few-shot or fine-tuning field. The endpoint is alpha.
  - OpenRouter may answer with `refusal`.
  - `~typesafe/jev-latest` currently points at `jev-1.14`.
  - Text goes to OpenRouter and then to TypeSafe in the US. TypeSafe does not train on inputs, but
    it states no retention period.
- **Today's roster model:**
  - A model ref may sit in only one role.
  - `smart-router/auto` never routes to the local role.
  - Candidates are exact refs.
  - Within a role, today's planner prefers the model that answered last. A model that errors is
    cooled for `cooldownMinutes`.
- **Nyx:**
  - Its Qwen3.8 ref (`nyx/g3mjym7raqj6147biq46zxym32gyda9g-Qwen3.8-27B-exl3-6fe61ad`) is a
    Nix-store basename that changes whenever that model is rebuilt.
  - Pi on Hera does not offer it until `NYX_API_KEY` reaches Pi's environment (nix-ose3,
    unfinished).
  - Its window is about 98k tokens, and thinking is either off or medium.
- **Hera's Pi holds both Codex accounts**, personal `openai-codex-2` and work `openai-codex-3`, and
  sees OpenRouter models. The router reads one roster per agent directory.
- **pi-idle-check** can resend a message's text after the router has removed its tag.

## Design

### Scope: personal or work, per session (designer's call; John decided the policy)

Every session on `smart-router/auto` has a scope. It is decided as follows, first rule that
applies:

1. **The process latch.** `PI_SMART_ROUTER_SCOPE=work` is read once at load, like
   `PI_SMART_ROUTER_LOCAL_ONLY`. Nix's `shared-work-pi` profile sets it, so every session on a work
   machine is a work session and cannot be changed to personal. A latched process whose roster has
   no valid work scope refuses every request on `smart-router/auto`, with a notice.
2. **The session's scope entry.** `/smart-router scope work` or `/smart-router scope personal`
   records a `smart-router.scope` custom entry, the way the pin is recorded. It is carried into
   forks and `/new`, and it is enforced at resume.
   - Personal to work takes effect at once.
   - Work to personal asks for confirmation (as `/smart-router local off` does) and says that the
     earlier turns are work content. Under the latch, it is refused.
3. **The roster's work directories.** A session whose working directory (`ctx.cwd`, compared as a
   string; no file I/O) lies under one of the roster's work directories starts in work scope and
   records that scope.
4. Otherwise the session is **personal**.

**Selection guard in work scope.** In work scope, the router keeps the selection on
`smart-router/auto` or on a model of the work account. It uses the guard that the pin uses for
local models: a selection outside the work policy is switched back, with a notice. This makes "never
an OpenRouter model at work" hold for models picked by hand too. The guard can be released only by
changing the session to personal scope, which needs confirmation.

The **footer** shows the scope next to the level.

### Roster: schema version 2 (designer's call)

Version 1 rosters keep working unchanged, in personal scope only and with the keyword classifier
alone. Version 2 adds the following:

- **One role list** for both scopes, as today. A ref still sits in only one role. The personal and
  work ladders use different refs (different accounts), so they do not collide.
- **`scopes.personal.levels` and `scopes.work.levels`**: each maps `low`, `medium`, `high` and
  `super` to a role and carries the description Jev reads. The two scopes may share descriptions.
- **`scopes.work.directories`**: absolute path prefixes (no `~`) for rule 3 above.
- **Account bindings gain a scope.**
  - A personal binding keeps today's rules, and labels containing the words work or Positron stay
    refused.
  - A work binding must carry a work label and is refused in personal scope.
  - Validation also refuses the following:
    - a personal level whose role holds a work-account model;
    - a work level whose role holds anything but work-account Codex models: no OpenRouter, no local
      models, no personal account.
- **The built-in exclusion of `openai-codex-3/*`** (Hera's work alias) applies in personal scope
  only. In work scope, that alias is allowed when bound as a work account.
- **`classifier`** is optional and shared by both scopes:
  ```json
  "classifier": {
    "model": "openrouter/typesafe/jev-1.14",
    "timeoutMs": 1000,
    "closeCall": 0.15,
    "context": { "messages": 6, "messageChars": 1500, "totalChars": 12000 }
  }
  ```
  The model is pinned to a version so that tuned thresholds keep their meaning. Moving to a newer
  Jev is a deliberate roster edit.
- In v2, `routing` is replaced by the scopes' levels. When Jev is unavailable, the keyword
  classifier's signals map onto levels: planning to SUPER, complex to HIGH, default to MEDIUM,
  trivial to LOW.
- **Role order is the ladder**, cheapest first, and each scope's level roles appear in level order.

An example for Hera (the designer's reading of John's ladders):

| Role | Candidates, in order |
|------|----------------------|
| `local` | `omlx-hera/GLM-5.3-Flash-oQ4e-mtp` (thinking max; `smart-router/local` and the pin) |
| `low` | `openai-codex-2/gpt-6-luna`, `nyx/...-Qwen3.8-27B-exl3-6fe61ad`, `omlx-hera/Qwen3.8-27B-oQ4e-fp16-mtp` |
| `medium` | `openai-codex-2/gpt-6.1-terra`, `openrouter/deepseek/deepseek-v4.1-flash-1017` |
| `high` | `openai-codex-2/gpt-6.1-sol`, `openrouter/z-ai/glm-5.3` |
| `super` | `openai-codex-2/gpt-6-astra`, `openrouter/moonshotai/kimi-k3.1-pro` |
| `work-low` | `openai-codex-3/gpt-6-luna` |
| `work-medium` | `openai-codex-3/gpt-6.1-terra` |
| `work-high` | `openai-codex-3/gpt-6.1-sol` |
| `work-super` | `openai-codex-3/gpt-6-astra` |

Hera's bindings and policy:
- `openai-codex-2` is a personal binding with label "personal".
- `openai-codex-3` is a work binding, with whatever label Multi-Pass gives that account.
- `exclude: ["openai-codex/*"]` stays.
- The `local` section keeps the providers `omlx-hera` and `nyx` and the hosts `hera.lan` and
  `nyx.lan`. Pinned sessions route only to GLM, but can still pick Nyx's Qwen by hand.

A work machine's roster has only the work roles, on its native `openai-codex` login bound as work.

### One routed run (designer's call on the order of the steps)

This applies on `smart-router/auto`, in an unpinned session, at an idle `input`:

1. **Scope** is resolved as above.
2. **Tag.** If the message's last whitespace-separated token is a recognised hashtag
   (case-insensitive), the router removes it with an `input` transform, and the run's level is that
   tag. A message that is only a tag is refused with a notice.
3. **Jev request.** If the roster has a `classifier`, the router asks Jev, both for an untagged
   message and for a tagged one (the tagged case feeds training).
   - The request starts at `input`.
   - For an untagged message, the router waits for the answer until `timeoutMs` has passed since
     the request started.
   - For a tagged message, the answer is only recorded. The run never waits for it.
4. **The level for an untagged run:**
   - Jev answered with a choice: take its top level, or the higher of its top two when they are
     within `closeCall`.
   - Otherwise: the keyword classifier's signal, mapped as above.
5. **The risky-operations floor.** The keyword classifier runs on every untagged run; it is cheap
   and local. If its reason is a destructive-intent or repo-hygiene trigger (`destructive-git`,
   `repo-cleanup`, `cleanup-words`), the level is raised to at least HIGH. A tagged run is not
   raised. The record says which source decided.
6. **The role**, in the session's scope:
   - A tagged level is used at once and skips `hold:sticky`. If the conversation does not fit the
     level's first available model (the existing `fits()` check), the router moves up one level at
     a time until it fits and says so in a notice.
   - An untagged level goes through the existing rules: move up at once, move down only after
     `stickyIdleMinutes` idle, and only when the conversation fits. In v2, these rules compare
     levels.
7. **The candidate.** Within the chosen level's role, a v2 run takes the first available candidate
   in roster order. It does not prefer the model that answered last. This is how a level returns to
   its Codex model as soon as Codex is available again; it costs one prompt-cache miss, which the
   record notes. Cooldowns, fallbacks and refusals otherwise work as today.

**Tags in other states.** These cases are handled as follows (designer's call):
- A tag typed while a run is active (a steer or a queued follow-up) is removed. It has no effect,
  and a notice says so, because the run's model is fixed until the run ends.
- On `smart-router/local`, under the pin, or on a physical model selection, a tag is also removed,
  with a no-effect notice.
- A removed tag stays tied to its text, so that pi-idle-check's resend keeps the level.

### The Jev request (designer's call on its shape)

- It goes through `ctx.modelRegistry.classify` with the roster's model, `maxRetries: 0` and the
  deadline above. The router reads no credential itself.
- It has one `choice` question:
  - Its instructions ask, in substance: how much model intelligence does the latest message need
    for the work it asks for now, given the recent conversation?
  - Its criteria are the four labels, with the session's scope's descriptions.
- `state` holds the following:
  - the message text with any tag removed;
  - the last `context.messages` user and assistant messages before it, as text only. Tool calls,
    tool results, images and thinking are excluded. They are read through `getRecentActiveEntries`.
- **Redaction runs first**, in both scopes, as pi-warden's judge does. Secret-shaped substrings
  are replaced with placeholders before any cap is applied: API keys and tokens, bearer and basic
  credentials, private-key blocks, passwords in URLs, and long high-entropy strings. It is written
  in the fork, because the import allow-list rules out reusing pi-warden's code. Then the caps
  apply: the classifier's existing head and tail cap, `messageChars` per message, and `totalChars`
  in all.
- A `refusal` answer, a malformed answer, or a missing label counts as a failure.
- No request is made in any of these cases:
  - the session is pinned;
  - `PI_SMART_ROUTER_LOCAL_ONLY` is set;
  - the selection is `smart-router/local`;
  - the input is a steer or follow-up;
  - the roster has no `classifier`.

### Records and corrections (designer's call on the entry's shape)

- **One record per planned run.** When the run settles, the router appends a
  `smart-router.level` custom entry through `pi.appendEntry`. It holds:
  - the version, a timestamp, and the scope;
  - the source (`tag`, `jev`, `keyword` or `floor`);
  - the level used and the tag (if any);
  - Jev's model, choice, probabilities, confidence and latency, or a failure code;
  - the keyword signal and reason;
  - whether a step-up for fit or a return to Codex happened;
  - the ref that answered.

  It holds no prompt text: the user message sits right before it in the same session.
- **Corrections.** `/smart-router was <level>` appends a record with source `correction` for the
  last planned run. Nothing is resent.
- **History.** `/smart-router history` lines gain the scope, the level and its source, for example
  `work HIGH (floor)`, `personal SUPER (tag)` or `personal MEDIUM (keywords; jev timed out)`.

### Footer (designer's call)

The router shows each run's scope, level and answering model under its own status key, for
example `personal HIGH → gpt-6.1-sol (jev 82%)`. It does not reuse the key that shows the pin.

### Training review (John decided the process; designer's call on its form)

When John asks, an agent session on the host does the following, read-only:
1. It reads that host's Pi session files for `smart-router.level` records and the user messages
   they follow.
2. It reports, per scope and per level, where John's tags and corrections disagree with Jev.
3. It proposes revised `describe` texts (concrete situations, optionally a few short example
   requests per level) and a revised `closeCall`, as a diff to that host's roster.

John approves before anything changes. Work records are read only on the machine that made them.
The router itself never reads other sessions and never writes the roster.

### Documentation and tests

- **Restate the invariant** in the README, CHANGELOG, AGENTS.md and Security section. The router
  asks Pi for one classifier request per routed run on `smart-router/auto` when the roster enables
  it, and never under the pin, on `smart-router/local`, or with no classifier configured. List the
  request in the status line that names what can still send data off the machine. Describe scope,
  the latch and the work guard.
- **Unit tests:**
  - tag parsing and removal;
  - the close-call rule;
  - mapping keyword signals to levels;
  - the risky-operations floor and the tag's override;
  - redaction, including that it runs before the caps;
  - v2 validation in both scopes: account scopes, label rules, and the refusal of non-Codex
    models in work levels;
  - work directories.
- **Behaviour suite**, with a fake classifier registered through Pi's provider `classifiers` hook:
  - a tagged level bypasses `hold:sticky` and steps up when the conversation doesn't fit;
  - untagged runs follow Jev, the close-call rule, and the keyword classifier on failure, refusal
    and timeout;
  - a level returns to its Codex candidate after a cooldown ends;
  - no classifier call is made when pinned, on `smart-router/local`, with the variable set, for a
    steer, or with no classifier;
  - scope resolution, including the latch, the entry and its carry into forks and `/new`, resume,
    directories, and confirmation for work to personal;
  - the work selection guard;
  - records are appended once per run, and corrections are recorded;
  - a tag survives pi-idle-check's resend.
- The default offline suite keeps an empty network log.

### Rollout (designer's call on the order)

1. Implement in the fork on a branch, then pass its gates (`npm run check`, the sandboxed
   behaviour suite, mutants) and a review. Release it as a signed tag.
2. nix packages it. Then nix:
   - sets `PI_SMART_ROUTER_SCOPE=work` in the `shared-work-pi` profile and loads the router there,
     once John confirms in nix's pane;
   - provides a stable model id for Nyx's Qwen in `config/ai`, so that rosters stop tracking a
     store hash. Until then, the agent updates rosters after each Nyx rebuild, with John's OK.
3. Confirm which OpenRouter account pi-warden's judge uses on the work machines, which is the
   account Jev will use there, and tell John.
4. Write the v2 rosters, each with John's OK:
   - Hera, with both scopes;
   - Clio, with both scopes if it holds a work Codex account (confirm at that point);
   - Vulcan, athena and pallas, personal only;
   - the work machines, work only.
5. Measure Jev's latency and failure rate from Hera, Clio and a work machine before relying on the
   1 s budget. Those are paid calls, at about $0.00003 each, and need John's OK.
6. Nyx's Qwen serves LOW on Hera only after nix-ose3 lands. Until then, LOW falls through to Hera's
   Qwen whenever luna is unavailable.

## Left to the builder

- Exact field names, defaults and messages, within the shapes above.
- Whether the Jev request starts at `input` or at the run's first request, as long as an untagged
  run waits no more than `timeoutMs` in all.
- How a removed tag stays tied to its text across pi-idle-check's resend.
- The wording of the instructions, the starting `describe` texts (written from the table above as
  concrete situations), and the redaction patterns.
- Footer and history formats, the test layout, and the release version.

## Still to be supplied by John (at rollout, not design)

- The work directories on Hera and Clio.
- Whether Clio holds a work Codex account, and under which alias.

## Calls the designer made, for John to check

- Scope is decided per session: by the latch on work machines, then the session's scope entry,
  then work directories, then personal. Work to personal needs confirmation.
- In work scope, the router guards the selection the way the pin does, so a model picked by hand
  can't be OpenRouter or a personal account.
- Roster schema version 2: one role list, per-scope levels, scoped account bindings, and a shared
  `classifier`. Version 1 rosters are unchanged.
- A v2 level takes its first available candidate (Codex) rather than the last responder.
- The keyword signals map planning to SUPER, complex to HIGH, default to MEDIUM and trivial to
  LOW. The risky-operations floor uses only the destructive-intent and repo-hygiene triggers.
- Jev is asked for tagged messages too, as a recorded opinion that never delays the run.
- The Jev model is pinned to `typesafe/jev-1.14` and changed by a deliberate roster edit.
- What Jev reads is redacted in both scopes before the caps (6 messages, 1,500 characters each,
  12,000 in all). It is text only: no tool output and no thinking.
- A tag typed during a run is removed with a no-effect notice; there are no mid-run model switches.
- Records are session custom entries without prompt text, plus a `/smart-router was <level>`
  correction.
- The footer shows scope, level, model and Jev's confidence.
- Hera's local section keeps Nyx, so a pinned session can still pick Nyx's Qwen by hand.
- The rollout order, a stable Nyx model id from nix, and measuring latency before relying on the
  1 s budget.
