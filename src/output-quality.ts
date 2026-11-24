// Upstream v1.5.0's degenerate-output test (SP-325, f22cbe9e): a length stop without a
// tool call is suspect only when its trailing text has enough highly repetitive five-grams.
// This test keeps no text. Pi still owns the response and any recovery from it.
const TAIL_CHARS = 8_192;
const NGRAM_SIZE = 5;
const MIN_WINDOWS = 24;
const MIN_REPEATED_RATIO = 0.65;

/** Whether a response is the repetitive, truncated output upstream treats as a failed attempt. */
export function isDegenerateOutput(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const { stopReason, content } = value as { readonly stopReason?: unknown; readonly content?: unknown };
  if (stopReason !== "length" || !Array.isArray(content)) return false;

  let tail = "";
  let hasText = false;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { type, text } = block as { readonly type?: unknown; readonly text?: unknown };
    if (type === "toolCall") return false;
    if (type !== "text" || typeof text !== "string") continue;
    tail = text.length >= TAIL_CHARS ? text.slice(-TAIL_CHARS) : (tail + (hasText ? "\n" : "") + text).slice(-TAIL_CHARS);
    hasText = true;
  }
  const tokens = (tail.match(/\S+/gu) ?? []).map((token) => token.replace(/\d+(?:\.\d+)?/g, "#"));
  const windows = tokens.length - NGRAM_SIZE + 1;
  if (windows < MIN_WINDOWS) return false;
  const unique = new Set<string>();
  for (let index = 0; index < windows; index += 1) unique.add(tokens.slice(index, index + NGRAM_SIZE).join("\u0000"));
  return 1 - unique.size / windows >= MIN_REPEATED_RATIO;
}
