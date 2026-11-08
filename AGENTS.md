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
  ones use the login. Never start a real Pi session from a test, and never contact a model.
- Never read or write `~/.pi`, `~/.config/pi`, any `auth.json`, `~/.ssh`, `~/.gnupg` or
  `~/.password-store`.
- Runtime code never reads a session's whole history: no `getEntries()` or `getBranch()`. It uses
  the bounded readers `getLatestCustomEntry`, `getLatestMessage` and `getRecentActiveEntries`.
- Runtime code does no I/O relative to the working directory or HOME, and it writes no files. It
  reads only the roster and Multi-Pass's subscription labels under Pi's agent directory, through
  `src/files.ts`.
- Signed commits only (`git commit -S`), one logical change each, with explicit paths staged.
  Never bypass hooks, and never stash, reset or rewrite published history.
- Pushing, tagging and creating remotes need John's explicit authorization.
