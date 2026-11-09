// Secret redaction for text sent to the classifier. Every pattern is linear: fixed prefixes,
// character classes and lazy scans that consume to their end, with no nested quantifiers.
export const REDACTED = "[redacted]";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAuthorization[ \t]*:[ \t]*(?:Bearer|Basic)[ \t]+[^\s]+/gi, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]+/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, `$1${REDACTED}`],
  [/(?:password|passwd|secret|token|api[_-]?key)[ \t]*[=:][ \t]*["']?[^\s"',;]+/gi, REDACTED],
];

const LONG_ALNUM = /\b[A-Za-z0-9]{40,}\b/g;

/** The text with credentials replaced by REDACTED. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.replace(LONG_ALNUM, (run) => (/[a-z]/.test(run) && /[A-Z]/.test(run) ? REDACTED : run));
}
