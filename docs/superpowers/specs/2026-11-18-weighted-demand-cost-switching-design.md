# Weighted demand and cost-aware switching

Design for John Wiegley's fork of pi-smart-router (jwiegley/pi-smart-router, base v1.4.0-jw.4,
`8cec10ed`). Written 2026-11-18 from a design conversation with John on 11-17 and 11-18, and from
six pieces of research on upstream beettlle/pi-smart-router v1.4.0 (`54bee53d`) done the same
night. Choices John made are stated as his, in his words. Choices the designer made are marked
**(designer's call)**; John can override them. What he decided on the design itself comes first.

## Decided on 2026-11-18

John answered the five decisions that the first two revisions left open, and approved the design
for building on a local branch:

1. **Requests that follow a tool call** stay on the model the run started on. Upstream's code
   sends each of them to the cheapest model of its economical tier, whatever the task was rated.
   See "Requests inside a run".
2. **Jev joins "the 13-stage process" as a weight.** Jev is one weighted term beside upstream's
   own heuristics, in upstream's own weighting function, and the roster then maps the result to a
   model. Upstream's deciding cascade is not run. See "Why not run upstream's pipeline as it is".
3. **The local-only pin is removed.** He first asked for that on 11-17, before he was reminded
   that the pin was his own choice of 11-08, and confirmed it on 11-18.
4. **A stuck run moves up:** one level, after three identical failed tool calls in a row.
5. **Thinking effort by turn type** (upstream's "adaptive reasoning"): "Yes, as upstream does",
   where the designer's default was to leave it for a later release.

## One decision is open again

Decision 5 was taken before a fact that designing it turned up: on John's ChatGPT-account models,
a change of thinking effort between two requests discards that model's whole prompt cache, and
upstream's rule changes effort from turn to turn. "Thinking effort" below has the evidence and
his three choices. Nothing else in this document depends on it. That part is built last, on his
word, and until then the release leaves thinking effort as it is today.

## Intent

John wants `smart-router/auto` to choose a model the way the original pi-smart-router set out to:
several signals weighed together, and no switch of model unless the work needs it or the cache
economics favour it. He also wants to keep what the fork exists for: his roster, which names the
model for each of four levels on each account, and the safety rules that keep the router from
writing, downloading or connecting on its own.

Two things are wrong today. The level comes from Jev alone, or from keywords when Jev fails. And
the code holds a session that has moved up there for five idle-free minutes, whatever the work
that follows costs. John asked for that rule to go on 11-17 and his rosters now set it to zero,
so on his hosts nothing weighs the cost of a move at all. The code for the rule, and for the pin,
is still in `8cec10ed`.

## Goals

- The level a prompt needs comes from a weighted combination of Jev's judgment and upstream's
  heuristics. The weights are settings John can change.
- Among the models that meet that level, the session uses the one with the lowest expected cost
  for the coming work, counting what each model already has cached and what it costs to come back.
- Nothing holds a session on a model by time. Need and cost are the only reasons.
- A conversation too large for a model never blocks a move to it: it is compacted first.
- Every decision can be read back: the terms of the score, and the two costs that were compared.

## Non-goals

- Running upstream's deciding stages, its own provider and streaming, its state database, its
  embedding model, its planning delegate or its probes.
- Changing how the roster maps levels to models, the fallback chain, scopes, account bindings,
  `smart-router/local`, tags, redaction, or the rule that a model picked by hand is sent as it is.
- Changing Pi.
- Exact accounting. Catalog prices stand in for subscription quota.

## Anti-goals: failure even if the feature works

- A session that moves between models and pays more than it would have by staying. John:
  "The thing I want to avoid the most is ping-ponging between lower and higher models, and
  repeatedly paying for an expensive cache-miss such that it would have been more economical just
  to stay on the higher model throughout."
- A prompt that needs a strong model answered by a weaker one because it was cheaper. Cost never
  takes a run below the level it needs.
- A work conversation that reaches anything but the work account through `smart-router/auto`.
- A wrong or missing figure steering a session unseen. With inputs missing, the run takes the
  model of the level it needs, and the footer says the cost was unknown.
- A slower prompt. The design adds no request and no file read on the prompt path beyond what the
  router makes today; the rest is arithmetic on figures already in memory.

## What John decided

From 2026-11-08 and 11-09, unchanged (see `2026-11-09-jev-levels-design.md`): the four levels and
their meanings; Codex first on the personal account; work on the work account only; tags as a
trailing hashtag that always wins; Jev reads the message and capped recent conversation, with a
1 s limit; risky operations get at least HIGH; training is an agent review when he asks.

From 2026-11-16 and 11-17: a model picked by hand always stays selected; `smart-router/local`
routes locally in every scope; one fallback chain for the personal scope and none for work; the
routing and Jev's prompts must be easy to change.

From 2026-11-17 and 11-18, which this design implements:

1. **No pin.** "Let's drop this pin feature since we added it but it has no value."
2. **Jev's level is not held back by time.** "If Jev determines that a request should be handled
   by a medium or low model, then it should route to the medium or low model." And on 11-18: "I
   shouldn't need the five-minute rule".
3. **Compact, then step down.** "If we need to go down to a smaller model that could not fit the
   context, then just compact first in the model with larger context, and then go down. You should
   never get 'trapped' due to having a larger context than the model you wish to change to."
4. **Roster and safety stay.** "I want to keep whatever is needed to enable my roster and to
   ensure safety."
5. **Cost decides a move down.** "I don't want the session to stay on the stronger model unless
   the cache economics dictate that it's cheaper to do so." He confirmed the rule in "Choosing the
   model" in its first form: up at once, same level stays, lower level priced both ways, a tag
   skips the pricing.
6. **Jev is one input among upstream's heuristics.** "I want Jev to participate in conjunction
   with the other heuristics that the original Smart Router would have used, rather than going
   solely based on what Jev has to say. Basically, there should be a weighting, and Jev is one
   input into the 13-stage process that was documented on the project page."
7. **Model names.** SUPER `gpt-6.2-astra`, HIGH `gpt-6.2-sol`, MEDIUM `gpt-6.1-terra`, LOW
   `gpt-6-luna`. On 11-18 the work account refused both 6.2 models, so the work levels stay on
   `gpt-6-astra` and `gpt-6.1-sol` until that account serves them. This is roster content, not code.

## What the research found

Reports and evidence are in the session of 2026-11-17/18; the points this design rests on:

- **Upstream cannot run as it is on John's hosts.** A live run of stock v1.4.0 on his Pi wrote a
  state database and a 91 MB model into the working directory, contacted Hugging Face at every
  start, ran `pmset` on every decision, sent no request through the hooks his other extensions
  rely on, and could not tell his two Codex accounts apart. On 11-08 he chose the port for these
  reasons.
- **Upstream's tiers do not know his models.** Its patterns stop at GPT-5; every model of his
  lands in one tier, and in the live run a local model won every decision.
- **Upstream's switching rule is a lock and a timer.** After two requests a session is locked to
  its model until 300 idle seconds pass. Its cache calculation runs only between providers and
  uses fixed assumptions (a 15% warm-up, five more turns). Its other test reduces to "the
  candidate costs under 59% of the current model's price". None of them reads the cache.
- **Upstream does weigh heuristics.** `scoreLowIntensity` in `src/domain/routing/tier-features.ts`
  is a weighted mean of twelve signals with configurable weights. This is the weighting John
  describes.
- **Upstream already asks a Jev-style judge, and plans to use the answers.** Six questions per
  prompt are asked and recorded; nothing reads them yet. Its drafts (T5 to T7 under
  `spine-tasks/_authoring/issues/typed-judgment/`) say how they should feed the stages, under the
  principle "the judge reads the task; code owns budget, cache economics, context fit, and the
  final model choice". The guards below are taken from T5.
- **The Codex cache does not expire at five minutes.** Measured on Hera from two weeks of Pi
  session logs, 17,610 pairs of consecutive requests to one model: still cached after under 1
  minute 97%; 1 to 5 minutes 92%; 5 to 20 minutes 87%; 20 to 30 minutes 79%; 30 to 60 minutes 66%;
  1 to 2 hours 50%; 2 to 6 hours 38%; 6 to 24 hours 11%. Samples beyond 30 minutes are small.
- **A change of thinking effort discards the cache on John's account models.** OpenAI documents
  the miss as `reasoning_effort_changed`; Pi can avoid it only with an API key; and in Hera's logs
  all five such changes found no cache. See "Thinking effort".
- **Catalog prices** as Pi reports them on Hera, dollars per million tokens (input, cached input,
  output): astra 6.2 8 / 0.4 / 40; sol 6.2 2 / 0.1 / 10; terra 6.1 1 / 0.05 / 5; luna 6
  0.1 / 0.01 / 0.5. Cache writes are listed at 1.25 times input. Above 272K input tokens a second
  tier applies: input and cache prices double and output rises by half. The two 6.2 models reach
  Pi through nix-config's catalog additions, not Pi's own data.

## Constraints

- **The fork's invariants hold.** Runtime code opens no connection, starts no process, sets no
  timer and writes no file; it has no runtime dependency; session reads go through the bounded
  readers; the source scan's import allow-list stands. Jev is asked only through
  `ctx.modelRegistry.classify`.
- **Pi 1.5.2 as John runs it** (jwiegley/pi `092190aa5`):
  - asks the router before every request, with a reason: `user`, `continuation`, `retry`, `direct`;
  - compacts by itself before sending, when compaction is enabled and the conversation exceeds
    the routed model's window less the reserve in Pi's settings (`fits` in `src/decide.ts`
    mirrors that rule);
  - asks the router which model writes a summary (reason `direct`);
  - carries `usage` (input, cached read, cache write, output), a timestamp and the thinking level
    on every assistant message, and each catalog model's `cost`, tiers included;
  - offers `classify` with several questions of type choice, score or bool in one request, and
    discards the whole answer when any one of them is missing or of the wrong type.
- **Hosted Jev** has a 1 s limit here, and has answered the fork's one level question in
  production since 11-12. Whether it answers more questions inside that limit is not known.
- **Pi's catalog has no cache lifetime for Codex models**, so the survival table above is the
  router's own setting.

## Design

### One prompt on `smart-router/auto`

1. The input handler takes the tag, if any, and removes it.
2. Jev is asked, as today: once, through Pi, after redaction, within 1 s. Never for a tagged run's
   decision, a steer, a follow-up, `smart-router/local` or a model picked by hand.
3. **Demand** is computed: a number from 0 (LOW) to 3 (SUPER), from Jev's answer and the
   heuristics. Guards and floors apply. The result is the level the prompt needs.
4. **The model is chosen** among the levels at or above that one, by expected cost.
5. The run's requests go to that model. Fallback, cooldowns, the chain, step-ups for a level with
   no available model, refusals and notices work as they do today.

A tag skips steps 3 and 4: the run takes the tagged level's first available model.

### Demand: the weighted score

**Jev's term.** Jev's level question stays a choice among `low`, `medium`, `high` and `super`
with the scope's descriptions. Its probabilities give an expected value on the 0 to 3 scale,
`dJ`, and its top probability is the confidence `c`.

**The heuristics' term.** Upstream's `buildTierFeatures` and `scoreLowIntensity`
(`src/domain/routing/tier-features.ts`) are vendored with their default weights. They take:

- the turn type, `planning` or `main_loop`. Upstream's Pi extension sets it from the words plan,
  architect and design in the user's message; the fork's planning detection in `src/classify.ts`
  is the same idea with file names blanked out and the text capped, and is what feeds the score
  here **(designer's call)**;
- the triage engine's verdict, its trivial and complex keyword hits and its complexity score (the
  engine is already in the fork);
- the prompt's length, the conversation's size and depth, whether tools are in play, and how much
  of the prompt is code.

The score is 1 for the lightest work, so `dH = 3 × (1 − score)`. Two of upstream's twelve signals
have no input here: the requirement vector, which upstream takes from its embedding model, and
the cluster match. Their weights are zero, so that a missing input does not read as "easy"
**(designer's call)**.

**The blend.** `demand = (wJ·c·dJ + wH·dH) / (wJ·c + wH)`, with `wJ = 4` and `wH = 1` by default
**(designer's call)**. A fully confident Jev carries four fifths of the result; an unsure one
carries less; without Jev the heuristics decide alone, which replaces today's keyword mapping.
The first three revisions said `wJ = 3`. Pinning the test values showed that with 3, an answer of
80% SUPER to a short prompt in a new session came out HIGH (2.13, where SUPER starts at 2.15 with
the close-call allowance), against the intent stated under "Defaults and tuning". With 4 it is
2.23, and each of the four levels survives an 80% answer on a neutral prompt.

**Guards**, from upstream's plan and John's earlier decisions:

- **Low confidence raises only.** Below `minConfidence` (0.6, upstream's default), the result is
  the higher of `dH` and the blend.
- **Risky operations get at least HIGH**, by today's keyword triggers, unchanged.
- **A very deep session gets at least MEDIUM**: more than 100,000 tokens, or more than 1,000
  entries on the branch (Pi counts entries without a read; they stand in for upstream's 1,000
  messages). This is upstream's planned floor for the terse "continue" in a long session, which
  no classifier rates well **(designer's call to include it)**. With this default, a conversation
  over 100,000 tokens never routes to LOW; `deepSessionFloor: "low"` turns the floor off.
- **Close calls go higher.** A demand within `demand.closeCall` (0.1) below a cut point takes the
  level above it. Today's `classifier.closeCall` compares the probabilities of Jev's two likeliest
  levels; the expected value already carries that, so the old setting is accepted and ignored.

**Level.** Cut points 0.75, 1.5 and 2.25 divide the scale into the four levels. See "Defaults and
tuning".

### The Jev request

Unchanged in this release: one request per prompt, one question, the four levels with the scope's
descriptions, redaction first, 1 s. The protocol stays fixed in code and the texts stay John's to
edit. What changes is the use of the answer: all four probabilities are kept, not only the top
choice.

Upstream asks its judge five more questions (the kind of task, deep reasoning, code generation,
tool use, destructiveness). They are left for a later release **(designer's call)**. Pi discards a
whole answer when one question in it fails, so each added question puts the level answer at risk
on every prompt; nothing here has measured hosted Jev with six questions inside 1 s; and
upstream's question texts refer to its own request fields and would need rewriting.

### Choosing the model: need sets the floor, cost picks above it

**Candidates** are the first available model of each level at or above the needed one, in the
session's scope. A level whose own models cannot take a request is not a candidate; if the needed
level is such a level, today's resolution applies (its chain, then a step up).

**The current model** is the model of the latest assistant message on the branch that ended
without an error, if it is one of the candidates.

**Expected cost of the coming work on a model X** uses the prices Pi's registry reports for X,
per token: input `in`, cached input `cr`, output `out`, at the tier that `T` falls in. Uncached
input counts at `in`, or at the cache-write price when this session's usage shows X's provider
reporting cache writes.

- `T` is the conversation's size in tokens, from the latest usage figures.
- `W` is how much of it X has cached: the size X last saw on this branch since the last
  compaction or context edit, or zero. It is also zero when the thinking effort X would be sent
  now is not the effort of its last answer (see "Thinking effort").
- `p` is the chance that cache still exists: the survival table at the time since X's last
  answer. It applies to the current model too.
- `n`, `o`, `g` and `d` are the expected requests in a run, output tokens per request, tokens
  added per request and seconds per run, each the median of the last ten runs on the branch.
  With fewer than three runs: 5 requests, 800 tokens, 1,500 tokens, 120 seconds.
- The horizon `h` is 1, plus the number of consecutive earlier prompts on this branch that needed
  this level or less and stayed on a higher model, capped at `horizonCap` (5) **(designer's
  call)**. Without it, a session that keeps asking for lighter work would be kept on the stronger
  model one cheap-looking prompt at a time. `N = n·h` requests are priced.

```
first request   p·(W·cr + (T − W)·in) + (1 − p)·T·in
later requests  for i = 2..N:  (T + (i − 2)·g)·cr + g·in
output          N·o·out
```

**Leaving the current model costs something more.** Any candidate other than the current model
carries `q · (1 − s) · Wc · (in_c − cr_c)`: the current model's cached size at its uncached
premium, times the chance `1 − s` that its cache is gone when this work ends (the survival table
at its idle time plus `d·h`), times the chance `q` that its level is needed again (the share of
the last ten prompts that needed it or more; 0.5 with fewer than three; never under 0.2).

**The choice.** The cheapest candidate takes the run. The current model keeps it unless another
is cheaper by `margin` (15%). When the current model is below the needed level it is not a
candidate, so the run moves up at once, to the cheapest adequate model. That is usually the needed
level's own model, but a stronger model whose cache is warm can cost less than a cold one.

**Worked examples.** A 150,000-token conversation, all of it cached on astra, whose last answer
was 30 seconds ago; 1,000 output tokens per request; no growth; 60 seconds per run; `q = 0.5`;
uncached input at the input price; the default survival table. "Move" includes the cost of
leaving astra.

| Prompt | Stay on astra | Move | Result |
|---|---|---|---|
| MEDIUM, a run of one request | $0.13 | terra: $0.16 + $0.05 = $0.20 | stays |
| MEDIUM, a run of 20 requests over 20 minutes | $2.03 | terra: $0.39 + $0.12 = $0.51 | moves |
| LOW, a run of one request | $0.13 | luna: $0.02 + $0.05 = $0.06 | moves |
| MEDIUM, one request, the third such prompt in a row (horizon 3) | $0.33 | terra: $0.18 + $0.05 = $0.23 | moves |

These are test cases; the figures are rounded to cents from exact ones the plan restates. The
LOW row tests the arithmetic: with the default deep-session floor, a 150,000-token conversation
is never rated LOW.

**When figures are missing** (no usage yet, no price for a model, a clock that went backwards),
the run takes the needed level's own model, and the record says the cost was unknown.

### Cache survival

The table is a setting, `switching.cacheSurvival`: pairs of idle seconds and a chance, defaulting
to the measured Codex figures. The chance for an idle time is that of the first pair whose seconds
are not less than it; past the last pair it is zero. A model whose catalog entry states a cache
lifetime uses 1 up to that lifetime and zero after it. After a compaction or a context edit, every
model's cached size is zero. A change of thinking effort zeroes the cached size of the model it is
sent to.

### A conversation larger than the candidate's window

With compaction enabled in Pi's settings, size removes no candidate and holds no session. When
the conversation does not fit a candidate by Pi's own rule (`fits`), that candidate's cost adds
one summary request on the current model and uses the size Pi's settings will leave after
compaction. If it wins, the router returns it; Pi compacts first, and the router names the current
model to write the summary, as it does today for every summary. The fit hold goes, and so does the
step-up for fit.

With compaction disabled, Pi would send an oversize request as it is. There a model the
conversation does not fit is not a candidate, and today's step-up for fit stays
**(designer's call)**.

### Requests inside a run

Tool continuations, steers and follow-ups stay on the run's model. A run that starts without a
prompt takes the level its session last needed and goes through the same choice.

**Escalation**, from upstream: when a run's last three tool calls in a row failed in the same way
(the same tool and the same error text, compared as upstream does by a hash of its first 256
characters), its next request moves to the first available model one level up, once per run, with
a notice. Any failure does not count: in Pi every shell command that exits non-zero is a failed
call, and three of those in a row is ordinary work. Upstream applies this "identical failures"
rule to its strongest tier and looser ones below; here it is the rule at every level, and the
move is one level per run where upstream goes to its top tier once per session
**(designer's call)**. Upstream's `loop-escalation.ts` is bound to its pin and tiers, so the
counter is the fork's own code, about sixty lines.

Upstream also sends tool-result requests to a cheap model. Its author's reasoning is that a tool
result is a "small structured payload" and so light work, and he limits it in words to small
results on the same provider. His code applies no size or provider limit. In agentic coding the
request after a tool result is where the model decides what to do next, and Jev never rates those
requests, so this design leaves them where the task put them. John chose this on 11-18.

### Thinking effort

**What upstream does.** Its "adaptive reasoning" sets the thinking effort of each request from the
kind of turn: `minimal` for a request that follows a tool result, `low` for an ordinary turn,
`medium` for a planning turn, and `high` for a request on its strongest tier or after a loop
escalation. It does so only while the session's level is Pi's default, `medium`. Any other level
is taken as the operator's own choice and is never lowered. A request on a pinned session keeps
the session's level unless the turn's class is higher. Two settings bound what the policy derives,
a floor and a ceiling, and a third turns it off.

**What John chose.** On 11-18: "Yes, as upstream does."

**What was found afterwards, the same day.** On John's models, a change of thinking effort between
two requests to one model discards that model's prompt cache:

- **OpenAI documents it.** Its cache diagnostics name the miss `reasoning_effort_changed` and
  advise keeping the effort constant across requests that should share a cache. GPT-6 models
  accept a `configuration_update` item that changes effort and keeps the cache.
- **Pi sends that item only with an API key.** Its source says a changing effort "would
  invalidate the prompt cache", and that "Sign in with ChatGPT rejects configuration_update
  items". Every level of John's roster is a ChatGPT sign-in account.
- **Hera's logs agree.** Of 294,779 pairs of consecutive requests to one Codex model at one
  effort, 1.4% found no cache. Effort changed between the two requests in four pairs, and in one
  more on OpenRouter; all five found none.

Upstream's rule changes effort inside a session by design. Here that means a full-price read of
the conversation whenever a planning prompt follows an ordinary one on the same model, or the
reverse: for 150,000 tokens on astra, $1.20 where the cached read costs $0.06. That is the
repeated cache miss John most wants to avoid, and the question put to him did not mention it.

Two more facts bear on the choice. On these models Pi sends `minimal` as `low`, so upstream's
first two rows are one effort. And in the last two weeks 92% of John's Codex requests ran at a
level he or his launcher had set (`max` 65%, `high` 27%), where upstream's rule changes nothing;
8% ran at `medium`.

**So this part is held for John's word**, and is built last. Until he rules, the release sends
the thinking level as today: the selected one, or the level the roster fixes for the role. His
choices:

1. **Leave effort alone in this release** (the designer's recommendation). The roster can already
   fix an effort per level, for example `high` for the SUPER role, and a fixed effort never costs
   a cache.
2. **Upstream's table, applied only where it costs no cache.** While the session is at `medium`
   and the role fixes no level: when a model starts with nothing cached (its first request on the
   branch, or its first after a compaction or a context edit), its effort is `medium` for a
   planning prompt, `high` on a SUPER model or after an escalation, and `low` otherwise. It keeps
   that effort until the next compaction. Upstream's floor, ceiling and off switch come with it.
3. **Exactly as upstream:** effort follows each request's turn type, with the cache losses above.

**What this release does whichever he chooses.** The cost figures treat a change of effort as the
loss it is. A model's cached size counts only when the effort about to be sent is the effort of
its last answer, compared after the model's own mapping of levels. So when John changes
`/thinking` in a session, the next choice prices the current model as cold, which it is.

### What is removed

- **The pin:** `/smart-router local on|off|status`, `PI_SMART_ROUTER_LOCAL_ONLY`, the
  `smart-router.pin` entry and every "under the pin" branch. An old pin entry is ignored, with one
  notice in a session on `smart-router/auto`. The environment switch is ignored, with one notice
  at session start so that nobody believes it still keeps traffic local. `/smart-router local …`
  answers that the pin is gone and that `/model smart-router/local` routes locally.
- **The five-minute rule**, in both roster versions. `stickyIdleMinutes` is still accepted, since
  all six of John's rosters now carry it, and is ignored; the checker says so.
- **The fit hold**, and with compaction enabled the step-up for fit.

**Version 1 rosters** keep working: keywords pick the role, as today. They lose the hold with
the rest and get no cost rule, so a version 1 session moves at every prompt its keywords say to.
All six of John's hosts are on version 2; retiring version 1 is left for later
**(designer's call)**.

### Roster additions

Version 2 gains two optional sections. A roster without them gets the defaults, so every roster
John has stays valid.

```json
"demand": {
  "jevWeight": 4, "heuristicsWeight": 1, "minConfidence": 0.6, "closeCall": 0.1,
  "cuts": [0.75, 1.5, 2.25], "deepSessionFloor": "medium",
  "weights": { "triage_verdict": 0.18, "turn_type": 0.18, "…": "upstream's signals, each optional" }
},
"switching": {
  "margin": 0.15, "horizonCap": 5,
  "cacheSurvival": [[60, 0.97], [300, 0.92], [1200, 0.87], [1800, 0.79], [3600, 0.66], [7200, 0.5], [21600, 0.38], [86400, 0.11]]
}
```

The checker (`src/check-cli.ts`, which nix-config installs as `pi-smart-router-check`) and
`/smart-router check` read both sections back in plain words. They refuse weights that are
negative or all zero, cut points that do not ascend, and a survival table whose seconds do not
rise or whose chances rise. They note `stickyIdleMinutes` and `classifier.closeCall` as ignored.

### What John sees

- **Footer:** `personal MEDIUM → gpt-6.1-terra (demand 1.3; moved, $0.63 vs $2.00)`, or
  `personal MEDIUM → gpt-6.2-astra (demand 1.2; stayed, $0.10 vs $0.16)`. A tag, a floor and a
  fallback are marked as today.
- **`/smart-router history` and `status`:** the terms behind the latest decision: Jev's value and
  confidence, the heuristics' value with its three largest signals, any guard that applied, and
  each candidate's expected cost with its cached size and survival.
- **Records** gain the same figures, so a training review can tune the weights, the cut points and
  the margin from John's tags and corrections. They still hold no prompt text.

### Upstream code that is vendored

`tier-features.ts` joins the triage engine in `src/triage/`, with upstream's MIT notice and the
commit it came from. Its code is upstream's; its imports of upstream's types point at a small
types file written for the fork. It is pure: no I/O and no clock. A development script compares
the vendored files with upstream at that commit and at a newer one, so that taking upstream's
later changes to these heuristics is a diff to review, not a rewrite. The source scan covers them.

Upstream's `turn-envelope.ts` and `loop-escalation.ts` are not vendored. The first is not what
upstream's own extension uses, and it reads more than the user's message; the second is bound to
upstream's pin and tiers. The fork follows their rules in its own code, as described above.

### Why not run upstream's pipeline as it is

- **Its deciding stages pick "the cheapest model of a tier"**, which is the decision the roster
  exists to make. In the live run that meant the local GLM for every prompt.
- **Three tiers are fixed in it**: 78 literal tier names in 28 files. Four levels would be a second
  axis laid over it either way.
- **Its lock and timer** are what John has just removed.
- **Its provider and store** break the safety rules and the other extensions.

What it does offer, this design takes: its heuristics and their weights, the guards it plans for
its judge, and its rule for a stuck run. Of the thirteen stages on its project page:

- **Five contribute:** the turn envelope's planning signal, typed judgment (as the fork's level
  question), the low-intensity gate (its weighting function), triage, and loop escalation.
- **Two are replaced by something stronger:** the context-fit gate by the compaction rule, and
  the session pin by the cost rule.
- **One is the roster's job:** the matcher's choice of model. Its requirement vector has no input
  in this release.
- **Five serve fleets the roster does not have:** the hardware probe, the local zero tier, the
  two cloud defaults and the overflow fallback.

### Defaults and tuning

The release ships the defaults above. They are chosen so that a confident Jev keeps the level it
gives when the heuristics are neutral, and the heuristics can move a borderline case one level.
Unit tests pin that with a fixed set of example prompts, and pin what the heuristics alone give
for the fork's existing classifier examples.

Tuning stays a training review, when John asks for one, as he decided on 11-09. The records gain
the figures a review needs (below). A review script that replays the user prompts of John's
sessions locally, to report how often heuristics alone, Jev alone and the blend match his tags
and corrections, is part of this work; running it on his sessions waits for his word, since
`AGENTS.md` bars agents from Pi's agent directory otherwise.

### Documentation and tests

- README: "Levels" and "Routing in detail" rewritten for demand and cost; "The local-only pin"
  replaced by a short note; "Changing the routing" gains the two sections. CHANGELOG entry.
- Unit tests, table-driven: the blend and every guard; the cost formula with the worked examples;
  survival lookup at, between, before and after its points; run-shape medians; the horizon;
  missing figures; a cached size that a change of thinking effort zeroes, and one that two levels
  with the same effort on that model leave alone.
- Sequence tests on the modelled cost: for alternating, long-low and one-off-low sequences, the
  rule's total is never above always staying on the higher model, and never above always following
  the level by more than the margin.
- Behaviour tests in Pi's runtime, in the existing harness: up at once; a move down only when
  cheaper; a tag; compaction before a move to a smaller window, and no such move with compaction
  disabled; escalation after three identical failures and none after three different ones; a
  version 2 roster without the new sections; a version 1 roster moving without a hold; an old pin
  entry; the environment switch's notice; a work session never leaving the work account.
- No test contacts Jev, as `AGENTS.md` requires.
- The fork's mutation bar applies to the new modules.

### Rollout

**(designer's call on the order.)** Release `1.4.0-jw.5` on the fork once its gates pass and an
independent review finds nothing blocking. Then nix-config: the pin, its lock, the checker test's
fixture, and the SECURITY and ARCHITECTURE text where they describe the pin and the five-minute
rule. Hera first, then Clio and Vulcan; athena, pallas and the shared-work hosts when John says.
Every push and every activation needs John's word at that time.

## Left to the builder

- How the router keeps each model's last-seen size and time: in memory from `message_end`, rebuilt
  by one bounded read on resume, or read each time.
- The exact post-compaction size estimate from Pi's settings.
- The module layout, and how `planLevel` and `climb` in `src/decide.ts` are reshaped.
- The footer's exact wording within the forms above.
- How the effort of a model's last answer is read: from the thinking level Pi records on the
  assistant message, through that model's map of levels.

## Still to be supplied by John

- His ruling on thinking effort, with the cache finding before him.
- His word before a review script reads his sessions.
- The word for each push and activation.

## Calls the designer made, for John to check

- Jev's weight is four times the heuristics' at full confidence (three in the first revisions; see
  "The blend").
- Jev is still asked one question; upstream's five other questions wait for a later release.
- The planning signal comes from the fork's own detection, not upstream's file.
- Signals without an input count for nothing, instead of counting as "easy".
- A very deep session is never LOW.
- A close call is 0.1 below a cut point on the new scale; the old `closeCall` is ignored.
- The horizon grows with consecutive lighter prompts, capped at five runs.
- A move must win by 15%.
- Escalation needs three identical failures, and is one level, once per run.
- With compaction disabled in Pi, a model the conversation does not fit is still passed over.
- Version 1 rosters keep working, without a hold and without the cost rule.
- The defaults ship without a calibration on John's sessions; tuning is a later review.
- Thinking effort stays as it is until John rules on it with the cache finding before him; the
  designer recommends leaving it alone in this release.
- A change of thinking effort counts as a lost cache in the cost figures.
- The roster keeps version 2; the new sections are optional.

## Checked by an independent reader

A builder check of the first draft (2026-11-18) raised five questions and found eleven statements
about the code or upstream that were wrong. This revision answers the questions in the text and
corrects the statements. None of them needed a decision from John beyond the five listed first.

The third revision (2026-11-18) records John's five answers and his approval, and adds the
finding on thinking effort. It was not sent to a second builder check; the plan's review covers
it.

The fourth revision (2026-11-18) comes from writing the plan: Jev's default weight is 4, not 3;
the deep-session floor counts entries; and the LOW worked example is marked as arithmetic.

## Decided during the build

The build met cases this design did not settle, and one of its own sentences that could not hold.
Each line below is the designer's call, made on 2026-11-18 while the plan was executed, and is for
John to confirm or overrule. Where a line differs from the text above, the line is what was built.

### The demand

- **The messages the heuristics count.** They count the conversation as Pi would send it to the
  model: a tool result as a tool message, an assistant message as itself, and anything else as a
  user message, which is how Pi sends a `!` shell run. A `!!` shell run, which Pi keeps out of the
  model's context, is not counted. The live router and the review script share one function for
  this, so a replay sees what the router saw. An extension's own entry in the session is not a
  message entry, so it is not read and not counted.
- **A conversation that cannot be read.** When the one bounded read of the conversation fails, Jev
  is not asked, its outcome is the failure `error` (the footer says `jev error`), and the
  heuristics decide alone. This is what happened before, when Jev's own read failed.

### The cost choice

- **"No usage yet" is about the history alone.** The cost is unknown when the session has no last
  response, no usage on it, or a usage of 0 tokens, whatever the size of the new prompt.
- **A missing figure is always said.** Every untagged run that is priced and lacks a figure says
  `cost unknown` in its footer, a session's first prompt included.
- **After a compaction, the size of the conversation is unknown.** After a compaction, after a
  move to another leaf of the session tree, and in a session that starts right after a compaction,
  no answer has measured the conversation as it now is. Until the next answer, the cost is unknown
  and the run takes the needed level's own model. The caches are forgotten at the same moment.
- **A move to another leaf starts that branch's figures afresh.** The run shapes and the count of
  lighter prompts in a row are counted on the branch, so a move to another leaf clears them.
  Whether a provider reports cache writes is a fact about the provider and stays, and so does the
  level the session last needed.
- **A compaction in the middle of a run.** The run's requests, output and seconds count whole; its
  growth per request is measured only over the answers after the compaction.
- **A candidate is priced at the size it will be sent.** A candidate that fits is priced at the
  conversation's size. A candidate that Pi compacts for first is priced at the size the compaction
  leaves, which matters for a catalog price that steps up with the size of the request.
- **What a compaction's summary costs.** Pi writes the summary with a request of its own, which
  no cache serves. Its input is priced at the writing model's price for uncached input, on the
  conversation's size less what the compaction keeps. That is an upper bound, because Pi shortens
  long tool results before it sends them, and it errs toward staying. Its output is priced at
  4,000 tokens. When Pi's cut falls inside a turn it writes two summaries; the second one's
  output is not priced. The reasoning a summary may add, the wait before the answer and the
  detail a summary loses are not priced. The design's "one summary request on the current
  model", read through that model's cache, priced a compaction several times too low.
- **A choice by cost when the current model cannot take the run.** When the current model is not
  adequate for the needed level, or is not one of the scope's level models, the cheapest adequate
  model takes the run. When that is a warm stronger model and not the needed level's own, the
  footer says `chose, $X vs $Y`: the chosen model against the needed level's own.

### Runs without a prompt, and a stuck run

- **A prompt whose plan cannot be matched to its run** (another extension changed its text, or Pi
  expanded it while two messages were pending) is treated as a run without a prompt: it takes the
  level a run without a prompt takes, through the same choice. Before, such a run stayed on the
  model used last.
- **The deep-session floor holds for a run without a prompt too.** Such a run takes the highest
  level of the last three prompts (see "What John sees"), raised to the deep-session floor when the
  conversation is over 100,000 tokens or its active context holds more than 1,000 entries. Pi
  counts those entries from the last compaction, an extension's own entries included. Once a
  session has planned a run, a conversation known to be that large therefore never routes to LOW
  without a tag, as the guards above promise. Its footer then says `run, floor`. The size is
  unknown right after a compaction, after a move to another leaf, and after an answer whose usage
  could not be read. Until the next answer only the count of entries can raise the level, and
  after a compaction that count has started again.
- **pi-cache-optimizer is told the same choice.** Before a run starts, the router tells
  pi-cache-optimizer which model the run will reach, and that extension decides from the answer
  whether to rewrite the system prompt. For a run without a prompt the answer is now the choice the
  route will make, computed without side effects, and not the model used last.
- **What makes a run stuck (John, 2026-11-18: exactly upstream).** A run below the top level is
  stuck when its last three tool calls in a row failed, whatever the tool and whatever the text,
  as upstream counts them below its top tier. Upstream's test of identical text applies only on
  its top tier, where it moves to another top model; here a run on SUPER has no level above and
  never moves, so that test is not built. The review round's rule of identical calls is
  withdrawn.
- **Where a stuck run goes (John, 2026-11-18).** One level up, to that level's own model, once
  per run. When that model is not available the run stays where it is and nothing is shown; it
  can still move at a later request of the same run. It never moves to a fallback chain and does
  not look further up.
- **What counts as the run under way.** The three failed tool calls are looked for after the
  latest user message of the request. Pi sends an extension's own message to the model as a user
  message, so a run an extension starts is bounded in the same way.

### What John sees

- **Footer forms.** A planned run: `personal MEDIUM → gpt-6.1-terra (demand 1.3; moved, $0.63 vs
  $2.00)`, `(demand 1.2; stayed, $0.10 vs $0.16)`, `(demand 1.8; chose, $0.14 vs $0.31)`,
  `(demand 1.0; cost unknown)`. A run without a prompt has a footer of its own:
  `personal MEDIUM → gpt-6.1-terra (run; moved, $0.23 vs $0.33)`, `(run; cost unknown)`, `(run)`.
  After an escalation the footer says `escalated` in place of the cost phrase. The router moves
  only when the other model is cheaper by more than the margin, so two figures that look equal are
  a stay inside the margin.
- **`/smart-router status`** shows the terms of the run the last decision belongs to, a run
  without a prompt included, however many requests the run has made. A hand-picked model shows
  none. Its demand line names every guard that applied: `guards: close-call, risky`.
- **`/smart-router history`** shows each planned run in the footer's form.
- **Records.** The level record of a planned run that escalated carries `escalated: true`. A run
  without a prompt writes no level record.
- **After a restart, a `/reload` or a move in the session tree**, the session's run shapes start
  again from the defaults. The first lighter prompt is then priced as a run of five requests and
  may move down where a run of one request would have stayed.
- **Unattended runs take the highest of the last three prompts (John, 2026-11-18).** A run
  without a prompt takes the highest level among the last three prompts John typed on the
  branch, raised to the deep-session floor as before. One short question in a goal session no
  longer drops the continuations to LOW; three light prompts in a row do.

### Thinking effort

- **Exactly as upstream (John, 2026-11-18).** John chose the design's third choice, twice, the
  second time with the cache cost stated: the effort follows each request's turn type by
  upstream's table, with upstream's floor, ceiling and off switch, wherever upstream applies it.
  The cost figures treat each change of effort as the lost cache it is.
- **Where the turn type comes from.** From the last message of Pi's route request, by upstream's
  own `deriveTurnType`, word for word: a tool result is a tool-result turn; a user message whose
  text holds "plan", "architect" or "design", in any case and inside a longer word ("explanation"
  holds "plan"), is a planning turn; anything else is an ordinary turn; no messages is no turn
  type. Pi sends an extension's message as a user message, so a run without a prompt is an ordinary
  or a planning turn by its message's text.
- **The levels that take the table.** Upstream's code sends the table's level alone at `medium`,
  and also when its provider receives no level, which is what Pi passes for `/thinking off`; so
  `off` takes the table too. At any other level upstream never lowers the session's level and
  raises it when the table's level is higher: at `low` a planning turn goes out at `medium` and a
  request on SUPER at `high`. The build follows the code. This section's earlier summary, "only
  while the session's level is `medium`", is exact for `high`, `xhigh` and `max`, where nothing
  changes unless the roster sets a floor above them.
- **The strongest tier is SUPER.** Upstream's `frontier-cloud` tier is the SUPER level's role in the
  session's scope, on `smart-router/auto` under a version 2 roster. Version 1 and
  `smart-router/local` have no levels, so none of their requests is on it.
- **The loop escalation is a stuck run, from its move to its end.** Upstream's escalation re-pins
  the session to its frontier tier, so every request after it is `high` until the pin breaks. Here
  a stuck run moves one level up for the rest of the run, so every request of the owner's loop in a
  run that moved up is `high`, a planning turn's excepted, which stays `medium` as upstream
  classifies planning first.
- **No pin continuation.** Upstream keeps the session's `medium` on a request its session pin holds
  unless the turn asks for more. The fork has no session pin (its only pin, the local-only one, is
  removed), and treating its stay on the run's model as one would leave the table to a run's first
  request alone; so no request is a pin continuation.
- **Every routed request, by one rule.** Upstream applies the policy to every request its provider
  routes, so here a compaction's summary, an extension's call and a foreign session's request take
  the table too; none of them belongs to a run of the owner's loop, so none is an escalated run's.
  A role whose roster entry fixes a level keeps it.
- **The settings.** Upstream's `adaptive_reasoning` (`enabled`, `min_level`, `max_level`) is the
  version 2 roster's `adaptiveReasoning` (`enabled`, `minLevel`, `maxLevel`), checked as upstream's
  schema checks it. A version 1 roster refuses the section and has the defaults. Upstream's three
  environment variables for the same switches are not read: the roster is where the router's
  settings live.
- **What is priced is what is sent.** The cost choice prices each candidate at the effort its turn
  would send it there. A prompt's run is priced when it is planned, from the prompt's text, for the
  request that carries that prompt last; a run without a prompt is priced at its first request,
  from that request's messages; what pi-cache-optimizer is told before a run without a prompt
  assumes an ordinary turn. When another extension or a template changes a prompt after the router
  planned it, the turn type of the request sent can differ from the one priced.
- **What John sees.** A footer item of its own, `smart-router-effort`, after each request of the
  owner's loop: `thinking minimal (after a tool result)`, `thinking low (an ordinary turn)`,
  `thinking medium (planning)`, `thinking high (SUPER)`, `thinking high (a stuck run)`,
  `thinking max (as selected, never lowered)`, `thinking medium (raised from the selected level for
  planning)`, `thinking max (the role's own level)`, `(the roster's floor)`, `(the roster's
  ceiling)`, `(as selected)` and `(as selected; adaptive effort is off)`. `/smart-router status`
  says the same on the line `Thinking sent on the latest request`. A run's start clears the item,
  so a model picked by hand, which is never routed, shows none.
- **Not built.** Upstream's conciseness hint appends a line to a verbose model's system prompt at
  `minimal` or `low`; a route returns only a model and a level, and the fork has no verbosity
  profiles. Upstream's planning delegate, whose decision code also counts as a planning turn, has
  no counterpart here.

### Rosters and the review script

- **A version 1 roster with compaction disabled** sends a request that is too large for its model
  as it is: version 1 has no fit logic left. All six of John's rosters are version 2.
- **No trace of the pin (John, 2026-11-18).** `PI_SMART_ROUTER_LOCAL_ONLY` is ignored and an old
  session's pin entry is not looked for. Neither produces a notice.
- **The review script** replays, for each rated run, the first user message at or after the
  record's time, and falls back to the latest one before it.
