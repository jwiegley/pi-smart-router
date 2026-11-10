// Secret redaction for text sent to the classifier. It first turns each escaped line break or tab
// (\n, \r or \t, as JSON and a repr write them) into a space, so that it ends a value and starts a
// name as the whitespace it stands for does; the classifier needs only the words, so the space
// costs it nothing. The input is untrusted and unbounded, so every pattern is linear: a start
// anchored by a lookbehind or a fixed literal, character classes with no overlapping adjacent
// quantifiers, and lazy scans that consume to their end.
export const REDACTED = "[redacted]";

// An escaped line break or tab: a backslash and n, r or t.
const ESCAPED_BREAK = /\\[nrt]/g;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Header, in plain or JSON form: the whole value, whatever its scheme. The value runs to the next
  // space, quote or semicolon, so a JSON escape inside it (\/, \u002B) never cuts it short; an
  // escaped line break, a space by now, ends it.
  [/\bAuthorization\\?["']?[ \t]*:[ \t]*\\?["']?(?:[A-Za-z]+[ \t]+)?\\?["']?[^\s"';]+/gi, REDACTED],
  [/(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
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
// names like any other text. Only a secret name takes the value after it (a sticky regex), and the
// scan resumes behind it. The lookbehind starts one attempt per run of name characters, so the
// scan stays linear. Quotes may be escaped (\"). A quoted value closes at the next quote on its
// line only when no word character follows that quote, so the apostrophe in "the user's" closes
// nothing; a value that does not close ends at the next whitespace, as an unquoted value does.
const NAME_SEPARATOR = /(?<![\w-])([\w-]+)(?:\\?["'\]])*[ \t]*(?::=|=>|=|:)[ \t]*/g;
const VALUE = /\\?"[^"\n]*"(?!\w)|\\?'[^'\n]*'(?!\w)|\\?["'][^\s]*|[^\s"',;]+/y;
// A flag that names a secret and takes its value after a space: --password hunter2.
const FLAG_SPACE = /(?<![\w-])(--[\w-]+)[ \t]+/g;
const FLAG_VALUE = /\\?"[^"\n]*"(?!\w)|\\?'[^'\n]*'(?!\w)|\\?["'][^\s]*|[^\s"'-][^\s"',;]*/y;
// Any name ending in key is secret, monkey and hotkey included; keyboard is not.
const SECRET_NAME =
  /secret|password|passwd|passphrase|credential|authorization|token(?!s)|api[_-]?key|access[_-]?key|private[_-]?key|key$|(?:^|[_-])(?:pass|pwd)(?:$|[_-])/i;

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Replaces the value after each secret name that `names` finds with REDACTED. */
function redactValues(text: string, names: RegExp, value: RegExp, nameGroup: (match: RegExpExecArray) => string): string {
  let out = "";
  let last = 0;
  names.lastIndex = 0;
  for (let m = names.exec(text); m !== null; m = names.exec(text)) {
    if (!isSecretName(nameGroup(m))) continue;
    value.lastIndex = names.lastIndex;
    if (value.exec(text) === null) continue;
    out += text.slice(last, names.lastIndex) + REDACTED;
    last = value.lastIndex;
    names.lastIndex = last;
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
  let out = text.replace(ESCAPED_BREAK, " ");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = redactValues(out, NAME_SEPARATOR, VALUE, (m) => m[1]!);
  out = redactValues(out, FLAG_SPACE, FLAG_VALUE, (m) => m[1]!.slice(2));
  out = out.replace(LONG_BASE64, (run) => (mixedCase(run) && /\d/.test(run) && /[+/]/.test(run) ? REDACTED : run));
  return out.replace(LONG_ALNUM, (run) => (mixedCase(run) ? REDACTED : run));
}
