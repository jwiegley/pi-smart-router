// A stuck run: its last three tool calls failed the same way. Pure: it reads a request's messages
// and nothing else, and keeps nothing of them.
//
// Any failure does not count: in Pi every shell command that exits non-zero is a failed call, and
// three of those in a row is ordinary work. Nor does one text: Pi's shell tool gives every command
// that fails without output the same text, "(no output)" and its exit code, so three different
// searches that find nothing would look alike. Three failed results in a row are a run going round
// in circles when their calls are the same, the same tool with the same arguments, and their texts
// are the same first 256 characters. A result's call is the `toolCall` block whose `id` is the
// result's `toolCallId`, in an assistant message before it (Pi's `ToolCall` and
// `ToolResultMessage`, `@earendil-works/pi-ai`'s `types.d.ts`). A failed result whose call cannot
// be found means the run is not stuck, and so does one whose call id is empty, or shared by two
// calls of one batch, since the call cannot then be told apart. Arguments are compared in a canonical form, the keys of every object
// sorted at every depth. Upstream compares a hash of each text's first 256 characters; comparing
// the characters themselves is the same test without the hash. The texts and arguments are held
// only while they are compared.
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
 * A value's canonical JSON: the keys of every object sorted at every depth, so key order never
 * matters. Undefined when it has none: a cycle, or a value JSON does not hold (undefined, a
 * function, a symbol, a big integer, a number that is not finite).
 */
function canonical(value: unknown, seen: Set<object> = new Set()): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value !== "object" || seen.has(value)) return undefined;
  seen.add(value);
  const parts: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const own = canonical(item, seen);
      if (own === undefined) return undefined;
      parts.push(own);
    }
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  for (const key of Object.keys(value).sort()) {
    const own = canonical((value as Record<string, unknown>)[key], seen);
    if (own === undefined) return undefined;
    parts.push(`${JSON.stringify(key)}:${own}`);
  }
  seen.delete(value);
  return `{${parts.join(",")}}`;
}

/**
 * The call a tool result answers, as the tool's name and its arguments' canonical form: the
 * `toolCall` block whose id is `id`, in the nearest assistant message from `from` back to `after`
 * (exclusive) that holds one. Undefined when none is found, when its arguments have no canonical
 * form, or when the call cannot be told apart: an empty id (Pi's openai-completions gives `""` when
 * a server sends none) or one that two blocks of that message share (some servers repeat an id
 * within a batch).
 */
function callOf(messages: readonly unknown[], id: string, from: number, after: number): string | undefined {
  if (id === "") return undefined;
  for (let index = from; index > after; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter((block) => isRecord(block) && block.type === "toolCall" && block.id === id);
    if (calls.length === 0) continue;
    const [block] = calls;
    if (calls.length > 1 || !isRecord(block)) return undefined;
    const args = canonical(block.arguments);
    return typeof block.name === "string" && args !== undefined ? `${JSON.stringify(block.name)}(${args})` : undefined;
  }
  return undefined;
}

/**
 * Whether the run's last three tool results all failed, from one call with one text: the same tool,
 * the same arguments and the same first STUCK_CHARS characters. The run is what follows the latest
 * user message; the results of one assistant message count one by one, and anything that is not a
 * message is passed over. Never throws: a message that cannot be read, or a failed result whose
 * call cannot be found, makes no stuck run.
 */
export function stuck(messages: readonly unknown[]): boolean {
  try {
    let start = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isRecord(message) && message.role === "user") {
        start = index;
        break;
      }
    }
    let same: string | undefined;
    let failed = 0;
    for (let index = messages.length - 1; index > start && failed < STUCK_FAILURES; index -= 1) {
      const message = messages[index];
      if (!isRecord(message) || message.role !== "toolResult") continue;
      const { toolName, toolCallId } = message;
      if (message.isError !== true || typeof toolName !== "string" || typeof toolCallId !== "string") return false;
      const called = callOf(messages, toolCallId, index - 1, start);
      if (called === undefined) return false;
      const own = `${JSON.stringify(toolName)} ${called} ${JSON.stringify(textOf(message.content))}`;
      if (same === undefined) same = own;
      else if (own !== same) return false;
      failed += 1;
    }
    return failed === STUCK_FAILURES;
  } catch {
    return false;
  }
}
