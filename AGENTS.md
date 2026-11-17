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
  `ctx.modelRegistry.classify` with `{ timeoutMs, maxRetries: 0 }`, once per routed run on
  `smart-router/auto` when a version 2 roster has a classifier, and never under the pin, on
  `smart-router/local`, for a steer or follow-up, or without a classifier. The message and the
  earlier messages it sends go through redaction first (`src/redact.ts`).
- Runtime code keeps no prompt text: a plan is bound to its message by a keyed digest, and no entry
  the router writes holds text or a digest.
- Runtime code never reads a session's whole history: no `getEntries()` or `getBranch()`. It uses
  the bounded readers `getLatestCustomEntry` and `getRecentActiveEntries`.
- Runtime code does no I/O relative to the working directory or HOME, and it writes no files: its
  session entries (the pin's, the scope's and the level records) go through `pi.appendEntry`. It
  reads only the roster, Multi-Pass's subscription labels and the prompt files the roster names in
  `smart-router/`, all under Pi's agent directory and all through `src/files.ts`, and compares
  `ctx.cwd` with the roster's work directories as text.
- A prompt file is guidance for Jev and nothing else reads it. The request's shape, the four level
  names, what counts as an answer, the scope and the pin are fixed in code: no roster text or
  prompt file may reach them (`test/prompts.test.ts`, "a hostile prompt").
- `src/check-cli.ts` is the standalone roster checker, not runtime code: `index.ts` never imports
  it. It may take a path relative to the working directory and write to standard output. It and
  everything it imports stay free of Pi's packages (`test/check.test.ts` walks its imports), so
  that it runs without Pi and without credentials.
- Signed commits only (`git commit -S`), one logical change each, with explicit paths staged.
  Never bypass hooks, and never stash, reset or rewrite published history.
- Pushing, tagging and creating remotes need John's explicit authorization.
