# Weighted demand and cost-aware switching

Design for John Wiegley's fork of pi-smart-router (jwiegley/pi-smart-router, base v1.4.0-jw.4,
`8cec10ed`). Written 2026-11-18 from a design conversation with John on 11-17 and 11-18, and from
six pieces of research on upstream beettlle/pi-smart-router v1.4.0 (`54bee53d`) done the same
night. Choices John made are stated as his, in his words. Choices the designer made are marked
**(designer's call)**; John can override them. Decisions that are still his to make come first.

## Decisions still open

Each has a default, which is what the rest of this document describes.

1. **Requests that follow a tool call.** Default: they stay on the model the run started on.
   Upstream's code sends each of them to the cheapest model of its economical tier, whatever the
   task was rated. See "Requests inside a run".
2. **How Jev joins "the 13-stage process".** Default: Jev is one weighted term beside upstream's
   own heuristics, in upstream's own weighting function, and the roster then maps the result to a
   model. Upstream's deciding cascade is not run. See "Why not run upstream's pipeline as it is".
3. **The local-only pin stays removed.** John asked for that on 11-17, before he was reminded that
   the pin was his own choice of 11-08. Default: removed.
4. **Escalation after repeated tool failures.** Default: adopted from upstream, as one level up.
5. **Thinking effort by turn type** (upstream's "adaptive reasoning"). Default: left out of this
   release, so that one thing changes at a time.

## Intent

John wants `smart-router/auto` to choose a model the way the original pi-smart-router set out to:
several signals weighed together, and no switch of model unless the work needs it or the cache
economics favour it. He also wants to keep what the fork exists for: his roster, which names the
model for each of four levels on each account, and the safety rules that keep the router from
writing, downloading or connecting on its own.

Two things are wrong today. The level comes from Jev alone, or from keywords when Jev fails. And
a session that has moved up stays up for five idle-free minutes, whatever the work that follows
costs there; John removed that rule on 11-17 and nothing has replaced it.

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
- **Catalog prices**, dollars per million tokens (input, cached input, output): astra 6.2
  8 / 0.4 / 40; sol 6.2 2 / 0.1 / 10; terra 6.1 1 / 0.05 / 5; luna 6 0.1 / 0.01 / 0.5. Cache
  writes are listed at 1.25 times input, and prices double above 272K input tokens.

## Constraints

- **The fork's invariants hold.** Runtime code opens no connection, starts no process, sets no
  timer and writes no file; it has no runtime dependency; session reads go through the bounded
  readers; the source scan's import allow-list stands. Jev is asked only through
  `ctx.modelRegistry.classify`.
- **Pi 1.5.2 as John runs it** (jwiegley/pi `092190aa5`):
  - asks the router before every request, with a reason: `user`, `continuation`, `retry`, `direct`;
  - compacts by itself when the routed model's window is exceeded, before sending;
  - asks the router which model writes a summary (reason `direct`);
  - carries `usage` (input, cached read, cache write, output) and a timestamp on every assistant
    message, and each catalog model's `cost`;
  - offers `classify` with several questions of type choice, score or bool in one request.
- **Hosted Jev** has a 1 s limit here. Whether `jev-1.14` on OpenRouter answers score and bool
  questions, and several questions inside that limit, is not known. The plan's first task finds out.
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

**The heuristics' term.** Upstream's `buildTierFeatures` and `scoreLowIntensity` are vendored
unchanged with their default weights. They take:

- the turn type from upstream's turn envelope (a planning prompt or an ordinary one);
- the triage engine's verdict, its trivial and complex keyword hits and its complexity score (the
  engine is already in the fork);
- the prompt's length, the conversation's size and depth, whether tools are in play, and how much
  of the prompt is code;
- the requirement vector, taken from Jev's answers when the extra questions below were answered.

The score is 1 for the lightest work, so `dH = 3 × (1 − score)`. The weights of a signal that has
no input (the requirement vector without Jev, clusters always) are set to zero for that prompt, so
that a missing input does not read as "easy" **(designer's call)**.

**The blend.** `demand = (wJ·c·dJ + wH·dH) / (wJ·c + wH)`, with `wJ = 3` and `wH = 1` by default
**(designer's call)**. A confident Jev carries three quarters of the result; an unsure one carries
less; without Jev the heuristics decide alone, which replaces today's keyword mapping.

**Guards**, from upstream's plan and John's earlier decisions:

- **Low confidence raises only.** Below `minConfidence` (0.5), the result is the higher of `dH` and
  the blend.
- **Risky operations get at least HIGH**, by today's keyword triggers, and by Jev's `destructive`
  answer when it is asked.
- **A very deep session gets at least MEDIUM**: more than 100,000 tokens or 1,000 messages. This
  is upstream's planned floor for the terse "continue" in a long session, which no classifier
  rates well **(designer's call to include it)**.
- **Close calls go higher**, as today: within `closeCall` (0.15) of a cut point.

**Level.** Cut points 0.75, 1.5 and 2.25 divide the scale into the four levels. Before release
the weights and cut points are calibrated on John's own sessions; see "Calibration".

### The Jev request

One request per prompt, as today. If the first task of the plan shows that hosted Jev answers
several typed questions inside the limit, the request also asks upstream's `task_kind`,
`needs_deep_reasoning`, `code_gen`, `tool_use` and `destructive`. They feed the requirement
vector and the risky floor, and a `task_kind` of plan, review or debug at 0.8 or more sets a floor
of HIGH, as upstream's T5 proposes. If it does not, the request stays as it is today and those
inputs are absent **(designer's call)**. The protocol stays fixed in code; the texts stay John's
to edit.

### Choosing the model: need sets the floor, cost picks above it

**Candidates** are the first available model of each level at or above the needed one, in the
session's scope. A level whose own models cannot take a request is not a candidate; if the needed
level is such a level, today's resolution applies (its chain, then a step up).

**The current model** is the model of the latest assistant message on the branch that ended
without an error, if it is one of the candidates.

**Expected cost of the coming work on a model X** uses, per token, X's catalog prices: input
`in`, cached input `cr`, output `out`; uncached input counts at the cache-write price when this
session's usage shows that provider reporting cache writes.

- `T` is the conversation's size in tokens, from the latest usage figures.
- `W` is how much of it X has cached: the size X last saw on this branch since the last
  compaction or context edit, or zero.
- `p` is the chance that cache still exists, from the survival table and the time since X's last
  answer.
- `n`, `o`, `g` and `d` are the expected requests in a run, output tokens per request, tokens
  added per request and seconds per run, each the median of the last ten runs on the branch.
  With fewer than three runs: 5 requests, 800 tokens, 1,500 tokens, 120 seconds.

```
first request   p·(W·cr + (T − W)·in) + (1 − p)·T·in
later requests  for i = 2..N:  (T + (i − 2)·g)·cr + g·in
output          N·o·out
```

`N` is `n` times the horizon: 1, plus the number of consecutive earlier prompts on this branch
that needed this level or less and stayed on a higher model, capped at 5 **(designer's call)**.
Without it, a session that keeps asking for lighter work would be kept on the stronger model one
cheap-looking prompt at a time.

**Leaving the current model costs something more.** Any candidate other than the current model
carries `q · (1 − s) · Wc · (in_c − cr_c)`: the current model's cached size at its uncached
premium, times the chance `1 − s` that its cache is gone when this work ends (the survival table
at its idle time plus `d`), times the chance `q` that its level is needed again (the share of the
last ten prompts that needed it or more; 0.5 with fewer than three; never under 0.2).

**The choice.** The cheapest candidate takes the run. The current model keeps it unless another
is cheaper by `margin` (15%). When the current model is below the needed level it is not a
candidate, so the run moves up at once, to the cheapest adequate model. That is usually the needed
level's own model, but a stronger model whose cache is warm can cost less than a cold one.

**Worked examples**, with a 150K-token conversation warm on astra, 1,000 output tokens per request,
no growth, and astra taken as certain to be needed again (`q = 1`). The second figure under
"Move" is the cost of leaving astra:

| Prompt | Stay on astra | Move | Result |
|---|---|---|---|
| MEDIUM, one request, about a minute | $0.10 | terra, cold: $0.16, plus $0.03 | stays |
| MEDIUM, 20 requests over 20 minutes | $2.00 | terra: $0.39, plus $0.24 | moves |
| LOW, one request, about a minute | $0.10 | luna, cold: $0.02, plus $0.03 | moves |
| MEDIUM, one request, the third such prompt in a row | $0.30 over a horizon of 3 | terra: $0.18, plus $0.03 | moves |

These are test cases. The plan restates each with its exact inputs.

**When figures are missing** (no usage yet, no price for a model, a clock that went backwards),
the run takes the needed level's own model, and the record says the cost was unknown.

### Cache survival

The table is a setting, `switching.cacheSurvival`: pairs of idle seconds and the chance the cache
is still there, defaulting to the measured Codex figures. A model whose catalog entry states a
cache lifetime uses a step at that lifetime instead. After a compaction or a context edit, every
model's cached size is zero.

### A conversation larger than the candidate's window

Size removes no candidate and holds no session. When `T` exceeds 90% of a candidate's window, its
cost adds one summary request on the current model and uses the size Pi's settings will leave
after compaction. If that candidate wins, the router returns it; Pi compacts first, and the router
names the current model to write the summary, as it does today for every summary. The fit hold
and the step-up for fit are removed.

### Requests inside a run

Tool continuations, steers and follow-ups stay on the run's model. A run that starts without a
prompt takes the level its session last needed and goes through the same choice.

**Escalation**, from upstream: when three consecutive tool calls of a run fail, its next request
moves to the first available model one level up, once per run, with a notice. The detection is
upstream's `loop-escalation.ts`, vendored; the consequence is the fork's **(designer's call:
one level, per run, where upstream goes to its top tier once per session)**.

Upstream also sends tool-result requests to a cheap model. Its author's reasoning is that a tool
result is a "small structured payload" and so light work, and he limits it in words to small
results on the same provider. His code applies no size or provider limit. In agentic coding the
request after a tool result is where the model decides what to do next, and Jev never rates those
requests, so this design leaves them where the task put them. This is open decision 1.

### What is removed

- **The pin:** `/smart-router local on|off|status`, `PI_SMART_ROUTER_LOCAL_ONLY`, the
  `smart-router.pin` entry and every "under the pin" branch. An old pin entry is ignored, with one
  notice in a session on `smart-router/auto`. The environment switch is ignored, with one notice
  at session start so that nobody believes it still keeps traffic local. `/smart-router local …`
  answers that the pin is gone and that `/model smart-router/local` routes locally.
- **The five-minute rule.** `stickyIdleMinutes` is still accepted in a roster, since all six of
  John's rosters now carry it, and is ignored; the checker says so.
- **The fit hold** and the step-up for fit.

### Roster additions

Version 2 gains two optional sections. A roster without them gets the defaults, so every roster
John has stays valid.

```json
"demand": {
  "jevWeight": 3, "heuristicsWeight": 1, "minConfidence": 0.5,
  "cuts": [0.75, 1.5, 2.25], "deepSessionFloor": "medium",
  "weights": { "triage_verdict": 0.18, "turn_type": 0.18, "…": "upstream's twelve, each optional" }
},
"switching": {
  "margin": 0.15, "horizonCap": 5,
  "cacheSurvival": [[60, 0.97], [300, 0.92], [1200, 0.87], [1800, 0.79], [3600, 0.66], [7200, 0.5], [21600, 0.38], [86400, 0.11]]
}
```

`classifier.closeCall` keeps its meaning. `pi-smart-router-check` and `/smart-router check` read
both sections back in plain words, and refuse weights that are negative or all zero, cut points
that do not ascend, and a survival table that does not fall.

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

`tier-features.ts`, `turn-envelope.ts` and `loop-escalation.ts` join the triage engine under
`src/upstream/`, byte for byte apart from import paths, each with upstream's MIT notice and the
commit it came from. A development script compares them with upstream at that commit and at a
newer one, so that taking upstream's later changes to these heuristics is a diff to review, not a
rewrite. They are pure functions; the source scan covers them.

### Why not run upstream's pipeline as it is

- **Its deciding stages pick "the cheapest model of a tier"**, which is the decision the roster
  exists to make. In the live run that meant the local GLM for every prompt.
- **Three tiers are fixed in it**: 78 literal tier names in 28 files. Four levels would be a second
  axis laid over it either way.
- **Its lock and timer** are what John has just removed.
- **Its provider and store** break the safety rules and the other extensions.

What it does offer, this design takes: its heuristics and their weights, its judge questions and
guards, and its failure-streak detection. Of the thirteen stages on its project page, turn
envelope, typed judgment, the low-intensity gate, triage and loop escalation contribute directly;
the context-fit gate and the session pin are replaced by the compaction rule and the cost rule;
the matcher's requirement vector is fed by Jev while its model choice is the roster's; the
hardware probe, the local zero tier, the two cloud defaults and the overflow fallback serve fleets
the roster does not have.

### Calibration

Before release, a script replays the user prompts of John's recent sessions on Hera, locally and
without printing them. For each it computes the heuristics' value and reads the level Jev gave and
any tag or correction from the session's records. It reports how often heuristics alone, Jev
alone and the blend match John's own labels, and proposes weights and cut points. John approves
the defaults from that report. The same script is the tool for later training reviews.

### Documentation and tests

- README: "Levels" and "Routing in detail" rewritten for demand and cost; "The local-only pin"
  replaced by a short note; "Changing the routing" gains the two sections. CHANGELOG entry.
- Unit tests, table-driven: the blend and every guard; the cost formula with the worked examples;
  survival lookup; run-shape medians; the horizon; missing figures.
- Sequence tests on the modelled cost: for alternating, long-low and one-off-low sequences, the
  rule's total is never above always staying on the higher model, and never above always following
  the level by more than the margin.
- Behaviour tests in Pi's runtime, in the existing harness: up at once; a move down only when
  cheaper; a tag; compaction before a move to a smaller window; an old roster; an old pin entry;
  the environment switch's notice; a work session never leaving the work account.
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

## Still to be supplied by John

- Answers to the five open decisions.
- Approval of the calibrated weights and cut points.
- The word for each push and activation.

## Calls the designer made, for John to check

- Jev's weight is three times the heuristics' at full confidence.
- Signals without an input count for nothing, instead of counting as "easy".
- A very deep session is never LOW.
- The horizon grows with consecutive lighter prompts, capped at five runs.
- A move must win by 15%.
- Escalation is one level, once per run.
- The extra Jev questions are asked only if hosted Jev answers them inside the limit.
- Thinking effort is left alone in this release.
- The roster keeps version 2; the new sections are optional.
