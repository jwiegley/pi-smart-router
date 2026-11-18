// A stuck run: its last three tool calls failed the same way. Pure: it reads a request's messages
// and nothing else, and keeps nothing of them.
//
// Any failure does not count: in Pi every shell command that exits non-zero is a failed call, and
// three of those in a row is ordinary work. Three failed results in a row with one tool and one
// text are a run going round in circles. Upstream compares a hash of each text's first 256
// characters; comparing the characters themselves is the same test without the hash. The texts are
// held only while they are compared.
//
// The run under way is what follows the latest user message. A route request's messages are Pi's
// model-facing messages, in which an extension's custom message (a goal continuation's, a loop's)
// is already a user message, so a run without a prompt is bounded the same way.

/** How many failed tool results in a row make a run stuck. */
export const STUCK_FAILURES = 3;

/** How many characters of a tool result's text are compared. */
export const STUCK_CHARS = 256;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A tool result's text: its text blocks joined with a newline, cut to STUCK_CHARS. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);
  }
  return texts.join("\n").slice(0, STUCK_CHARS);
}

/**
 * Whether the run's last three tool results all failed, with one tool and one text: the same first
 * STUCK_CHARS characters. The run is what follows the latest user message; the results of one
 * assistant message count one by one, and anything that is not a message is passed over. Never
 * throws: a message that cannot be read makes no stuck run.
 */
export function stuck(messages: readonly unknown[]): boolean {
  try {
    let tool: string | undefined;
    let text: string | undefined;
    let failed = 0;
    for (let index = messages.length - 1; index >= 0 && failed < STUCK_FAILURES; index -= 1) {
      const message = messages[index];
      if (!isRecord(message)) continue;
      if (message.role === "user") return false;
      if (message.role !== "toolResult") continue;
      const { toolName } = message;
      if (message.isError !== true || typeof toolName !== "string") return false;
      const own = textOf(message.content);
      if (tool === undefined) {
        tool = toolName;
        text = own;
      } else if (toolName !== tool || own !== text) {
        return false;
      }
      failed += 1;
    }
    return failed === STUCK_FAILURES;
  } catch {
    return false;
  }
}
