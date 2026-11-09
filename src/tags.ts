// Trailing tier tags: the last whitespace-separated token of a message, when it is one of
// #super, #high, #medium, #low or their initials, in any case.
import type { Tier } from "./tiers.ts";

export interface Tagged {
  readonly tier: Tier;
  /** The message with the tag removed and trailing whitespace trimmed; "" when only the tag was typed. */
  readonly text: string;
}

const TAGS: Readonly<Record<string, Tier>> = {
  "#super": "super",
  "#s": "super",
  "#high": "high",
  "#h": "high",
  "#medium": "medium",
  "#m": "medium",
  "#low": "low",
  "#l": "low",
};

export function parseTag(text: string): Tagged | undefined {
  const body = text.trimEnd();
  // Scan back from the end: a regex like /\S+$/ is quadratic on a long pasted token.
  let start = body.length;
  while (start > 0 && !/\s/.test(body[start - 1] as string)) start--;
  if (start === body.length) return undefined;
  const tier = TAGS[body.slice(start).toLowerCase()];
  return tier === undefined ? undefined : { tier, text: body.slice(0, start).trimEnd() };
}
