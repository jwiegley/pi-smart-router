// A stuck run: its last three tool calls in a row failed, whatever the tool and whatever the text.
// Pure: it reads a request's messages and nothing else, and keeps nothing of them.
//
// This is upstream's test below its top tier (`src/domain/pinning/loop-escalation.ts`, v1.4.0),
// where consecutive tool failures of any signature count toward its threshold (John, 2026-11-18).
// Upstream's test of identical failure text applies only on its top tier, where it moves to another
// top-tier model; here a run on SUPER has no level above and never moves, so that test has no
// place. A failed result is a tool result whose `isError` is `true` itself (Pi's
// `ToolResultMessage`, `@earendil-works/pi-ai`'s `types.d.ts`); its text is not read.
//
// The run under way is what follows the latest user message. A route request's messages are Pi's
// model-facing messages, in which an extension's custom message (a goal continuation's, a loop's)
// is already a user message, so a run without a prompt is bounded the same way.

/** How many failed tool results in a row make a run stuck. */
export const STUCK_FAILURES = 3;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Whether the run's last three tool results all failed. The run is what follows the latest user
 * message; the results of one assistant message count one by one, and anything that is not a
 * message is passed over. Never throws: a message that cannot be read makes no stuck run, and so
 * does any result among the last three that is not a failed tool result.
 */
export function stuck(messages: readonly unknown[]): boolean {
  try {
    let failed = 0;
    for (let index = messages.length - 1; index >= 0 && failed < STUCK_FAILURES; index -= 1) {
      const message = messages[index];
      if (!isRecord(message)) continue;
      if (message.role === "user") return false;
      if (message.role !== "toolResult") continue;
      if (message.isError !== true || typeof message.toolName !== "string") return false;
      failed += 1;
    }
    return failed === STUCK_FAILURES;
  } catch {
    return false;
  }
}
