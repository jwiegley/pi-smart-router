// Secret redaction for text sent to the classifier. The input is untrusted and unbounded, so
// every pattern is linear: a start anchored by a lookbehind or a fixed literal, character classes
// with no overlapping adjacent quantifiers, and lazy scans that consume to their end.
export const REDACTED = "[redacted]";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Header, in plain or JSON form: the whole value, whatever its scheme.
  [/\bAuthorization["']?[ \t]*:[ \t]*["']?(?:[A-Za-z]+[ \t]+)?["']?[^\s"';]+/gi, REDACTED],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
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

// A name and its separator, never the value, so the value of a harmless key is scanned for more
// names like any other text. Only a secret name takes the value after it (VALUE, sticky), and the
// scan resumes behind it. The lookbehind starts one attempt per run of name characters, so the
// scan stays linear.
const NAME_SEPARATOR = /(?<![\w-])([\w-]+)["'\]]*[ \t]*(?::=|=>|=|:)[ \t]*/g;
const VALUE = /"[^"\n]*"?|'[^'\n]*'?|[^\s"',;]+/y;
// A flag that names a secret and takes its value after a space: --password hunter2.
const FLAG = /(?<![\w-])(--[\w-]+[ \t]+)("[^"\n]*"?|'[^'\n]*'?|[^\s"'-][^\s"',;]*)/g;
const SECRET_NAME =
  /secret|password|passwd|passphrase|credential|token(?!s)|api[_-]?key|access[_-]?key|private[_-]?key|(?:^|[_-])(?:pass|pwd)(?:$|[_-])/i;
// Names ending in key, by case: ENCRYPTION_KEY, encryptionKey, key; never monkey or hotkey.
const KEY_NAME = /(?:^|[_-])(?:key|KEY)$|[a-z]Key$|[A-Z]KEY$/;

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) || KEY_NAME.test(name);
}

function redactAssignments(text: string): string {
  let out = "";
  let last = 0;
  NAME_SEPARATOR.lastIndex = 0;
  for (let m = NAME_SEPARATOR.exec(text); m !== null; m = NAME_SEPARATOR.exec(text)) {
    if (!isSecretName(m[1]!)) continue;
    VALUE.lastIndex = NAME_SEPARATOR.lastIndex;
    if (VALUE.exec(text) === null) continue;
    out += text.slice(last, NAME_SEPARATOR.lastIndex) + REDACTED;
    last = VALUE.lastIndex;
    NAME_SEPARATOR.lastIndex = last;
  }
  return out + text.slice(last);
}

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
  out = redactAssignments(out);
  out = out.replace(FLAG, (match, flag: string) => (isSecretName(flag.trim().slice(2)) ? `${flag}${REDACTED}` : match));
  out = out.replace(LONG_BASE64, (run) => (mixedCase(run) && /\d/.test(run) && /[+/]/.test(run) ? REDACTED : run));
  return out.replace(LONG_ALNUM, (run) => (mixedCase(run) ? REDACTED : run));
}
