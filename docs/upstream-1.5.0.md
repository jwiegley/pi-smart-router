# Upstream v1.5.0 in this fork

This note records how [upstream v1.5.0](https://github.com/beettlle/pi-smart-router/releases/tag/v1.5.0) (`f22cbe9e`) was carried onto this fork's virtual models, as of `1.5.0-jw.1`. Upstream delegates each provider stream itself and chooses among three tiers with a session pin. This fork names a physical model and lets Pi send the request, and chooses among four levels with no pin. Each v1.5.0 behaviour is therefore fitted to that design rather than copied. The files the fork vendors from upstream (`src/triage/`) and the policies it ports rule for rule (adaptive reasoning, the stuck-run test) did not change between v1.4.0 and v1.5.0.

John Wiegley decided each fitting on 2026-11-23, with the instruction to keep no difference from upstream that does not earn its place. The differences that remain are listed at the end.

## Failover within a run (SP-322, SP-325)

Upstream can try another model inside one delegation. A router that only picks a model before each request cannot, so the fork's Pi gained a boundary for it: a virtual model may define `recover(request, ctx)`, described in Pi's `docs/virtual-models.md`. Pi owns the lifecycle; the router only offers an alternate.

Pi calls `recover` for an agent-loop error once its own retry and compaction have declined it, and for a length stop before it tries compaction. It allows at most three distinct alternates in a run, and one after a repetitive length stop. It checks the offer again before dispatch. A failed response that carried a tool call, a context overflow, an abort, queued messages, a changed selection or a changed branch all prevent an alternate. The failed response stays in the session's history and in what listeners saw; it is left out of the next request's context only. Text already streamed cannot be taken back.

The router offers an alternate for:

- a repetitive length stop, by upstream's test (`src/output-quality.ts`, from `degenerate-output.ts`);
- an error with an explicit 4xx or 5xx status that is the model's own;
- a usage limit or a credential that was not accepted, whose model or account is cooled first.

It never offers one for a content-filter refusal, for an error about the conversation's size or a thinking signature, or for an error with no status it can read. The alternate is the failed role's next model, then the scope's fallback chain, skipping every model that already failed in the run. Scope, account bindings, the local policy and credentials are checked on every pick, so `smart-router/local` never reaches a cloud model and a work session never reaches the personal chain. A run that moves onto the chain says so once. When no alternate answers, the run ends with the notice that says what to do, as before; the notice is now said when the run settles, since only then is it known that none did.

The same 4xx status, other than 429, from two distinct models points to the request rather than to either model. Pi stops recovery there, and the router neither cools nor counts the second model and takes back what it counted against the first.

On a Pi without the boundary none of this runs: the router's `recover` is never called, and a failed request is handled as it was in `1.4.0-jw.6`.

## A model whose requests keep failing (SP-322)

Upstream's breaker for failures that are a model's own is kept with its numbers: three in a row pass the model over for thirty seconds (`FAILURE_THRESHOLD`, `FAILURE_HOLD_MS` in `src/resolve.ts`). A failure counts when it has an explicit 4xx or 5xx status other than 429 and is neither a limit, a content-filter refusal nor about the conversation's size. An answer from the model starts the count again.

A server that could not be reached is not counted: it has its own, longer hold. It is a hold, like that one: a preference, never a refusal. When nothing else can take a request, the held model is tried anyway. `/smart-router status` lists it as `Failing`. Like cooldowns and other holds it is kept in memory, per session.

## The deep-session floor (SP-323)

Upstream keeps flash-class models out of main-loop turns in a deep session, over 100,000 tokens or 1,000 messages, unless no other model is available. It finds those models by capability scores and by name. Pi's catalog has no such scores, and here the roster says what each model is for, so the small models are the models of the scope's LOW level.

In a deep session, a main-loop request that would go to a LOW model goes to MEDIUM's choice instead, when that finds a model that is not a LOW one; with none, the request keeps its pick. Planning and tool-result turns are left alone, as upstream leaves them. A run whose level came from a tag is left alone too: the tag is the explicit choice that upstream's forced model is. So is a retry, which keeps the model Pi backed off for. A roster whose `demand.deepSessionFloor` is `low` has turned the floor off, and this check with it. The roster's `demand.deepSessionFloor` still raises a deep session's level when a run is planned; this rule adds the check on each request. The session's depth is read as before, from the last response's usage and Pi's entry count, never from the history.

## The re-check after a move to another provider (SP-324)

Upstream routes the first tool result afresh after its pinned model's provider changed, once, because the new provider has none of the conversation cached. The fork has no pin; a run changes provider only when a retry or a recovery moves it.

After such a move, the first tool result's request chooses the run's model again, once: the run's level, picked as a prompt for it would be, with the cost rule for an untagged run. While what made the run move still holds, that choice is the model it is on, and nothing changes. A move up for being stuck is no handoff, as upstream's loop escalation is none. A model picked by hand never reaches the router and is not touched.

## Typed judgment (SP-326, SP-327)

With `classifier.typedJudgment: true`, off by default, the one request to Jev also carries upstream's six typed questions, their text fixed in code. There is no second request, and `smart-router/local`, steers and follow-ups still ask nothing. Each answer is checked on its own; a missing or malformed one is dropped and changes nothing, and the level answer stands. The answers are kept in the run's record as names, scores and probabilities.

The router acts on three:

- `capability_deserved`: scores 0 to 3 are LOW, MEDIUM, HIGH and SUPER. At `demand.minConfidence` or above the score replaces the demand's level, up or down; under it, it can only raise it, as in upstream's `computeAdjustedHint`.
- `destructive`: at 0.7 or above, upstream's threshold, the request takes the risky floor, at least HIGH.
- `task_kind`: at `demand.minConfidence` or above, `plan`, `debug` and `review` make the prompt a planning one for its demand, as in upstream's `resolveTurnType`. It never makes a planning prompt not one: upstream allows that only when its host gave no turn type, and its host always gives one. The thinking effort does not read the judgment: upstream's adaptive reasoning takes the host's turn type, and so does `src/effort.ts`.

`needs_deep_reasoning`, `code_gen` and `tool_use` are recorded and decide nothing: upstream compares them with model capability scores that Pi's catalog does not have.

The risky and deep-session floors apply after the capability score, so a judgment never lowers a run below them. A tagged run is not planned by any of this; Jev's answer for it is an opinion, recorded only.

## Differences that remain

- **Four scores to four levels.** Upstream maps capability 0 to its local tier, 1 to economical and 2 and 3 both to frontier. Here 0 is LOW and never sends a run to a local model: which models are local, and when they are reached, stays the roster's decision.
- **Small models are the LOW level's**, not models found by name or by capability score.
- **Upstream's capability filter for a judgment above 0** needs nothing here: such a judgment already puts the run at MEDIUM or above.
- **No local-zero gate.** Upstream's `destructive` and `tool_use` answers keep work off its local model. The fork sends nothing to a local model by judgment, so `destructive` raises the level instead.
- **Failover needs Pi's `recover` boundary**, which jwiegley/pi has from the commit that adds it and npm's Pi 1.5.2 does not. The fork's sandboxed behaviour suite runs npm's Pi, so the boundary's lifecycle is tested in Pi's own suite, and the router's part in unit tests with a fake.
- **A request-caused 4xx** is recognised only across the attempts of one run, since Pi reports them there.
- **Holds and counts are per session**, as every cooldown is; upstream's breaker is per process.
