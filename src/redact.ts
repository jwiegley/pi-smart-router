// Secret redaction for text sent to the classifier. The input is untrusted and unbounded, so
// every pattern is linear: a start anchored by a lookbehind or a fixed literal, character classes
// with no overlapping adjacent quantifiers, and lazy scans that consume to their end.
export const REDACTED = "[redacted]";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Header, in plain or JSON form: the whole value, whatever its scheme.
  [/\bAuthorization["']?[ \t]*:[ \t]*["']?(?:[A-Za-z]+[ \t]+)?[^\s"',;]+/gi, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, REDACTED],
  [/\b[rs]k[_-](?:live|test|proj)[_-][A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]+/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:hf|npm)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]+/g, REDACTED],
  [/\bxapp-[A-Za-z0-9-]+/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // The user stays, the password goes; the user may be empty (redis://:pass@host).
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+(?=@)/gi, `$1${REDACTED}`],
];

// name, separator, value: one run per name, so the scan stays linear. The value of a secret-named
// key goes, quoted or not; other keys stay as they were.
const ASSIGNMENT = /(?<![\w-])([\w-]+)(["']?[ \t]*[=:][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"',;]+)/g;
const SECRET_NAME =
  /secret|password|passwd|passphrase|token(?!s)|api[_-]?key|access[_-]?key|private[_-]?key|(?:^|[_-])(?:pass|pwd)(?:$|[_-])/i;

// Backstops for keys that carry no prefix: 40 or more characters, mixed case. The base64 form
// must also hold a digit and a `+` or `/`, which a lowercase path or a digest never does.
const LONG_ALNUM = /(?<![A-Za-z0-9])[A-Za-z0-9]{40,}(?![A-Za-z0-9])/g;
const LONG_BASE64 = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}(?![A-Za-z0-9+/])/g;

function mixedCase(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run);
}

/** The text with credentials replaced by REDACTED. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(ASSIGNMENT, (match, name: string, separator: string) =>
    SECRET_NAME.test(name) ? `${name}${separator}${REDACTED}` : match,
  );
  out = out.replace(LONG_BASE64, (run) => (mixedCase(run) && /\d/.test(run) && /[+/]/.test(run) ? REDACTED : run));
  return out.replace(LONG_ALNUM, (run) => (mixedCase(run) ? REDACTED : run));
}
