# AGENTS.md

Guidance for coding agents in jwiegley/pi-smart-router, John Wiegley's port of
beettlle/pi-smart-router to the virtual models of Pi 1.5. `CLAUDE.md` is a link to this file.

## Rules

- No `npx`, `bunx`, `pnpm dlx` or global installs. Install the pinned devDependencies with
  `npm install --ignore-scripts`; the repository `.npmrc` also sets `ignore-scripts=true`.
- The gate is `npm run check`: `tsc --noEmit`, the unit suites through `test/run.mjs`, and
  `pack:check`. It runs offline, and no test may reach the network.
- The behaviour suite runs Pi's own runtime, so it runs only sandboxed: inside the offline Nix
  build, or under `npm run check:sandbox` on a Mac. Never run it any other way.
- Never run Pi's own test suites on the host: they rewrite `~/.pi/agent/auth.json`, and the live
  ones use the login. Never start a real Pi session from a test, and never contact a model or the
  classifier: the behaviour suite's classifier is a fake.
- Never read or write `~/.pi`, `~/.config/pi`, any `auth.json`, `~/.ssh`, `~/.gnupg` or
  `~/.password-store`.
- Runtime code opens no network connection of its own, starts no process and sets no timer;
  `test/scan.test.ts` holds `index.ts` and `src/` to that, comments included. Its one request off
  the machine is the classifier's, made by Pi: `ctx.modelRegistry.findOfType` and
  `ctx.modelRegistry.classify` with `{ timeoutMs, maxRetries: 0 }`, once per prompt on
  `smart-router/auto`, `smart-router/personal` or `smart-router/work` when a version 2 roster has a
  classifier; on `smart-router/local` only where the roster's `classifier.local` is `true` (John's
  decision of 2026-11-23); and never for a steer or follow-up, or without a classifier. It is asked
  through the model of the session's scope (`classifier.models`), so a work session's text reaches
  only a work account. The message and the earlier messages it sends go through redaction first
  (`src/redact.ts`).
- Runtime code keeps no prompt text: a plan is bound to its message by a keyed digest, and no entry
  the router writes holds text or a digest.
- Runtime code never reads a session's whole history: no `getEntries()` or `getBranch()`. It uses
  the bounded readers `getLatestCustomEntry` and `getRecentActiveEntries`, and Pi's
  `getHistoryMetrics` where Pi has it. One call the source scan cannot see reads more:
  `ctx.getContextUsage()`, made once at session start to learn whether the session starts right
  after a compaction, builds the session's projection in a compacted session and walks the whole
  branch in npm's Pi 1.5.2. Make no other such call, and none per request.
- Runtime code does no I/O relative to the working directory or HOME, and it writes no files: its
  session entries (the scope's and the level records) go through `pi.appendEntry`. It
  reads only the roster, Multi-Pass's subscription labels and the prompt files the roster names in
  `smart-router/`, all under Pi's agent directory and all through `src/files.ts`, and compares
  `ctx.cwd` with the roster's work directories as text.
- The session's scope decides which accounts a request may reach, never the selection and never a
  provider order. `smart-router/personal` and `smart-router/work` refuse a session of the other
  scope (`refusalFor` in `src/router.ts`), `assertSafe` checks the scope again on every pick, and
  an order is a view that only reorders a role's own models (`src/order.ts`): it is kept in the
  session's record in memory, and is written to no entry and no file.
- A prompt file is guidance for Jev and nothing else reads it. The request's shape, the four level
  names, what counts as an answer and the scope are fixed in code: no roster text or
  prompt file may reach them (`test/prompts.test.ts`, "a hostile prompt").
- The typed questions are upstream's, at the release the fork has merged, and are fixed in code
  too: `src/jev.ts` holds them and `test/jev.test.ts` holds their text to
  `test/fixtures/upstream-typed-questions.json`. They are asked only when the roster's
  `classifier.typedJudgment` is `true`, in the one request to Jev, never in a second. Change their
  text only to follow upstream. A missing or malformed typed answer changes nothing.
- Pi owns recovery. The models' `recover` callback only offers a physical alternate
  (`src/recovery.ts`): Pi decides whether to use it, omits the failed attempt from the next
  request's context and bounds the attempts. The router never rewrites a response to make Pi
  retry it, never moves content a model refused, and checks scope, accounts and the local policy
  on every offer as on every pick. Pi asks twice, to offer and to confirm, so an offer changes no
  state that a second, identical call would not leave the same.
- `src/check-cli.ts` is the standalone roster checker, not runtime code: `index.ts` never imports
  it. It may take a path relative to the working directory and write to standard output. It and
  everything it imports stay free of Pi's packages (`test/check.test.ts` walks its imports), so
  that it runs without Pi and without credentials.
- `scripts/` holds development scripts. None of them runs in a session: `index.ts` and `src/`
  never import them, and the package does not ship them. `scripts/review-demand.ts` reads only the
  session files named on its command line, and sends and prints no prompt text; running it on
  John's sessions, which are under Pi's agent directory, needs his word.
- The thinking effort of every routed request is upstream's adaptive reasoning, as John ruled on
  2026-11-18 ("Exactly as upstream: effort follows each request's turn type"): `src/effort.ts`
  ports upstream's table and merge rule by rule (`adaptive-reasoning.ts`, the same at v1.4.0 and
  v1.5.0), and `test/effort.test.ts` cites the upstream line each expectation comes from. A typed
  judgment never changes it: upstream's effort reads its host's turn type. Change it only to follow upstream, never to invent a rule of
  the fork's own. The route and the cost choice both take the effort from `effortFor`
  (`src/decide.ts`), so the effort a request is sent at is the one its price assumed; a change of
  effort costs that model's whole prompt cache. A role's fixed `thinking` is never changed, and the
  roster's `adaptiveReasoning` section holds upstream's off switch, floor and ceiling.
- `README.md` is upstream's README at the upstream release the fork has merged (v1.5.0,
  `f22cbe9e`, since `1.5.0-jw.1`), byte for byte, plus
  one section, "This fork", that says how the fork differs and ends at the heading "Upstream's
  README", as John asked on 2026-11-19. Keep that section short, and write nothing else into the
  README. The fork's documentation is `docs/manual.md`, whose rosters and redaction tables the
  tests hold to the code (`test/check.test.ts`, `test/redact.test.ts`).
- Signed commits only (`git commit -S`), one logical change each, with explicit paths staged.
  Never bypass hooks, and never stash, reset or rewrite published history.
- Pushing, tagging and creating remotes need John's explicit authorization.
