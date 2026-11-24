// The repeated-failure hold, upstream v1.5.0's breaker for failures that are a model's own
// (DEFAULT_MODEL_FAILURE_CONFIG: three in a row, thirty seconds), kept as a hold: a preference that
// never refuses a request. Test-only; never shipped.
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, describe } from "node:test";

import { pickInRole } from "../src/decide.ts";
import { describeHold, FAILURE_HOLD_MS, FAILURE_THRESHOLD, Holds } from "../src/resolve.ts";
import { ASTRA, heraContext, KIMI, NOW } from "./support/catalog.ts";
import { agentDir, assistant, request, resetSlot, routed, start } from "./support/pi.ts";

beforeEach(resetSlot);
afterEach(resetSlot);

describe("the count", () => {
  test("is upstream's: the third failure in a row holds the model for thirty seconds, and each response counts once", () => {
    assert.deepEqual([FAILURE_THRESHOLD, FAILURE_HOLD_MS], [3, 30_000]);
    const holds = new Holds();
    assert.equal(holds.fail(ASTRA, 1, NOW), false);
    assert.equal(holds.fail(ASTRA, 1, NOW), false, "the same response again is not a second failure");
    assert.equal(holds.fail(ASTRA, 2, NOW), false);
    assert.equal(holds.until(ASTRA, NOW), undefined);
    assert.equal(holds.fail(ASTRA, 3, NOW), true);
    assert.deepEqual(holds.get(ASTRA, NOW), { until: NOW + FAILURE_HOLD_MS, failing: true });
    assert.equal(holds.until(ASTRA, NOW + FAILURE_HOLD_MS), undefined, "it ends by itself");
    assert.match(describeHold(holds.get(ASTRA, NOW)!).reason, /^failing-until-\d\d:\d\d$/);
  });

  test("a longer hold for an unreachable server is not shortened", () => {
    const holds = new Holds();
    holds.hold(ASTRA, 1, NOW, 5);
    for (const stamp of [2, 3]) holds.fail(ASTRA, stamp, NOW);
    assert.equal(holds.fail(ASTRA, 4, NOW), false);
    assert.deepEqual(holds.get(ASTRA, NOW), { until: NOW + 5 * 60_000 });
  });

  test("an answer starts it again, and a failure the request caused is taken back, with the hold it made", () => {
    const holds = new Holds();
    holds.fail(ASTRA, 1, NOW);
    holds.fail(ASTRA, 2, NOW);
    holds.release(ASTRA);
    assert.equal(holds.fail(ASTRA, 3, NOW), false, "an answer in between: not three in a row");
    holds.fail(ASTRA, 4, NOW);
    holds.forgive(ASTRA);
    assert.equal(holds.fail(ASTRA, 5, NOW), false, "one was taken back");
    assert.equal(holds.fail(ASTRA, 6, NOW), true);
    holds.forgive(ASTRA);
    assert.equal(holds.until(ASTRA, NOW), undefined, "a hold the request caused is lifted");
  });
});

test("a failing model is passed over for the role's fallback, and tried after all when nothing else can take the request", () => {
  const holds = new Holds();
  for (const stamp of [1, 2, 3]) holds.fail(ASTRA, stamp, NOW);
  const rc = heraContext({ holds });
  const moved = pickInRole(rc, "architect", { fallback: true, code: "t" });
  assert.equal(moved.ok && moved.choice.ref, KIMI);
  const alone = pickInRole(rc, "architect", { fallback: false, code: "t" });
  assert.equal(alone.ok && alone.choice.ref, ASTRA, "never a refusal");
});

describe("in a session", () => {
  const fail = (errorMessage: string, stamp: number) => assistant(ASTRA, { stopReason: "error", errorMessage, content: [], timestamp: NOW + stamp });
  const next = async (loaded: Awaited<ReturnType<typeof start>>): Promise<string> => {
    await loaded.host.emit("agent_settled", { aborted: false });
    loaded.session.endRun();
    await loaded.host.emit("input", { text: "plan the migration", source: "interactive" });
    return routed(loaded.runtime.route("auto", request("user", { signal: loaded.session.startRun() })));
  };

  test("three failed requests in a row move the next run off the model; limits, refusals, overflows and statusless errors do not count", async (t) => {
    const loaded = await start({ dir: agentDir(t), now: () => NOW });
    assert.equal(await next(loaded), ASTRA);
    for (const [index, text] of ["400 content filter", "400 maximum context length exceeded", "something broke", "500 internal error", "400 invalid request"].entries()) {
      await loaded.host.emit("message_end", { message: fail(text, index + 1) });
    }
    assert.equal(await next(loaded), ASTRA, "two that count: not yet");
    await loaded.host.emit("message_end", { message: fail("422 unprocessable", 9) });
    assert.equal(await next(loaded), KIMI, "the third holds it");
    assert.match(loaded.session.notices.map((notice) => notice.message).join("\n"), /^(?![\s\S]*could not take this run)/, "a hold for failing asks for no resend");
  });

  test("an answer in between starts the count again", async (t) => {
    const loaded = await start({ dir: agentDir(t), now: () => NOW });
    assert.equal(await next(loaded), ASTRA);
    await loaded.host.emit("message_end", { message: fail("500 a", 1) });
    await loaded.host.emit("message_end", { message: fail("500 b", 2) });
    await loaded.host.emit("message_end", { message: assistant(ASTRA) });
    await loaded.host.emit("message_end", { message: fail("500 c", 3) });
    assert.equal(await next(loaded), ASTRA);
  });
});
