// The first import of test/behaviour.test.ts, so that it runs before anything evaluates Pi's own
// runtime. The behaviour suite runs Pi 1.5 and its npm dependency closure, so it runs only where
// test/run.mjs has established a sandbox and says so in PI_SMART_ROUTER_BEHAVIOUR: in the offline
// Nix build, or under sandbox-exec through `npm run check:sandbox`. Run in any other way, the suite
// fails here instead of running unsandboxed. Test-only; never shipped.
if (process.env.PI_SMART_ROUTER_BEHAVIOUR !== "1") {
  throw new Error(
    "test/behaviour.test.ts runs Pi's own runtime, so it runs only sandboxed: run `npm run check:sandbox` on a Mac; the Nix build runs it in its own sandbox.",
  );
}

export {};
