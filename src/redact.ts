// Secret redaction for text sent to the classifier. It first hides URL passwords in the raw text,
// where a backslash before t, r or n can be a Windows DOMAIN\user name's (CORP\tom), not an escape.
// Then it turns each escaped line break or tab (\n, \r or \t, as JSON and a repr write them) into
// a space, so that it ends a value and starts a name as the whitespace it stands for does; the
// classifier needs only the words, so the space costs it nothing. Then come the fixed shapes
// (headers, JWTs, private keys, keys with a known prefix), the values after secret names and flags,
// the basic credentials of command lines and config files, and the long-run backstops. The names
// are read before the basic credentials: a basic value can run on, through an unclosed quote or a
// word glued to the next name, and would take that name away from the secret after it. The input
// is untrusted and unbounded, so every pattern is linear: a start anchored by a lookbehind or a fixed
// literal, character classes with no overlapping adjacent quantifiers, and lazy scans that consume
// to their end; where a quantifier overlaps what follows it, an anchor (a line's or a word's start)
// or a delimiter it cannot cross bounds what each attempt reads.
export const REDACTED = "[redacted]";

// The user stays, the password goes; the user may be empty (redis://:pass@host).
const URL_PASSWORD = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+(?=@)/gi;

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

// ─── Basic credentials in command-line and config forms ───

// curl's -u, --user and -U take user:password, quoted or not: the text after the first colon goes
// and the user stays. Other programs give those flags other meanings (date -u +%H:%M:%S, docker
// run -u 1000:1000, pip install -U git+https://…), so they are read only in a curl command: after
// a curl word (curl, or a path that ends in /curl) and before the next |, ;, && or line break. A
// line break right behind a backslash continues the command, as the shell reads it. So does a |,
// ; or && inside a quoted argument: it is the argument's own
// (-H 'Content-Type: application/json; charset=utf-8').
//
// The quotes of a curl command are read in two ways, each by a pass of its own, and each pass
// hides the passwords it finds:
// - counting every quote, escaped or not: a quote opens an argument and the same quote closes it.
//   That is also how the quotes pair when the command sits in a JSON string and all of them are
//   escaped (-H \"x; y\"). This pass is the first of the basic stage.
// - as the shell reads them: a backslash escapes a quote behind it outside a quoted argument and
//   inside a double-quoted one, so the quotes of -d "{\"a\": \"b; c\"}" and the middle one of
//   'it'\''s; here' are text. Inside single quotes a backslash is text, and the next single quote
//   closes. Only an odd run of backslashes escapes a quote: a pair is an escaped backslash, and the
//   quote behind it is a real one. A backslash before a |, ; or && does not keep the command open;
//   one right before a line break does, in both readings, as said above. This pass is the last of
//   the basic stage, on what the other passes left, so what it hides takes no command word or name
//   from them. The two readings differ only where a backslash stands before a quote, so it runs
//   only on text that holds one; other text is read once.
// Inside a flag's own value neither pass takes an escaped quote for text. The value ends at any
// quote (USER_VALUE): a user name that holds one is no value, and the rest of a password behind
// one stays. What becomes of the quote that ended the password depends on the value:
// - a quoted value takes it for its closing quote, so the quotes behind it pair one off, which can
//   end the command before a later flag;
// - behind an unquoted value, the first pass has replaced the backslash with the password, and
//   the quote opens a quoted argument in both readings. Where only the last pass reads the flag,
//   the backslash is still in the text it scans, and the quote is text.
// The first pass replaces a password up to that quote, the backslash before it included, so the
// last pass finds no escaped quote there.
// Neither reading follows a quoted argument past its line: a quote that never closes ends at the
// line's end, with the command, unless a backslash continues the line. Flags are read inside a
// quoted argument as outside one. A reading can still end a command too early, where the text's
// quotes pair in neither way.
//
// --proxy-user means the same everywhere, and is read in any command. A pass steps from one thing
// that counts to the next: outside a curl command, a curl word or a --proxy-user; inside one, a
// break, a quote or a flag. A flag starts only after whitespace, a quote or a backtick (inline
// code). A quoted user stops at whitespace, a quote or a colon, and an unquoted one at a backtick
// too, so a value is read once, within the token it starts. The backslashes before a quote are
// counted back from it, once for each quote.
const OUTSIDE_CURL = /(?<![\w-])(curl)(?=[ \t])|(?<![^\s"'`])--proxy-user(?:[ \t]+|=)/g;
const INSIDE_CURL = /(\||;|&&)|((?<!\\\r?)\n)|(["'])|(?<![^\s"'`])(?:-[uU][ \t]*|--(?:proxy-)?user(?:[ \t]+|=))/g;
const USER_VALUE = /(["'])([^\s"':]*:)[^"'\n]+|([^\s"'`:]*:)[^\s"']+/y;
const ESCAPED_QUOTE = /\\["']/;

/** The passwords of the user flags, replaced: with every quote counted, or with quotes read as the shell reads them. */
function redactUserPasswords(text: string, shell: boolean): string {
  let out = "";
  let last = 0;
  let at = 0;
  let curl = false;
  // In a curl command, the quote that opened the quoted argument the scan is in.
  let quote = "";
  for (;;) {
    const scan = curl ? INSIDE_CURL : OUTSIDE_CURL;
    scan.lastIndex = at;
    const match = scan.exec(text);
    if (match === null) break;
    at = scan.lastIndex;
    if (!curl) {
      if (match[1] !== undefined) {
        curl = true;
        continue;
      }
    } else if (match[1] !== undefined) {
      // |, ; or && ends the command, unless a quoted argument holds it.
      if (quote === "") curl = false;
      continue;
    } else if (match[2] !== undefined) {
      // A line break ends the command, and with it a quote that never closed.
      curl = false;
      quote = "";
      continue;
    } else if (match[3] !== undefined) {
      // To the shell, an odd run of backslashes before a quote escapes it, except inside single
      // quotes, and an escaped quote is text.
      let backslashes = 0;
      if (shell && quote !== "'") while (text[match.index - 1 - backslashes] === "\\") backslashes += 1;
      if (backslashes % 2 === 1) continue;
      // A quote opens a quoted argument, and the same quote closes it; the other quote is its text.
      if (quote === "") quote = match[3];
      else if (quote === match[3]) quote = "";
      continue;
    }
    USER_VALUE.lastIndex = at;
    const value = USER_VALUE.exec(text);
    if (value === null) continue;
    out += text.slice(last, at) + (value[1] === undefined ? value[3] : value[1] + value[2]) + REDACTED;
    last = USER_VALUE.lastIndex;
    // The closing quote of a quoted value is the value's own, and opens no quoted argument.
    at = value[1] !== undefined && text[last] === value[1] ? last + 1 : last;
  }
  return out + text.slice(last);
}

// MySQL's clients take the password glued to -p (-pHunter2), and a lone -p before a space prompts
// for it. Elsewhere, text glued to -p is a flag cluster (cp -pr) or a port (docker run -p8080:80),
// so the text glued to a lone -p is hidden only in a command that a mysql-family word starts
// (mysql, mysqldump, mysqladmin, mariadb, mariadb-dump and the like, with a path or not), up to the
// next |, ;, & or line break. One scan finds the words, the breaks and the flags in order.
const MYSQL_SCAN = /(?<![^\s/("'`|;&])(mysql\w*|mariadb[\w-]*)(?=[ \t])|([|;&\n])|(?<!\S)-p("[^"\n]*"|'[^'\n]*'|[^\s|;&]+)/g;

function redactMysqlPasswords(text: string): string {
  let out = "";
  let last = 0;
  let command = false;
  for (const match of text.matchAll(MYSQL_SCAN)) {
    if (match[1] !== undefined) command = true;
    else if (match[2] !== undefined) command = false;
    else if (command) {
      out += text.slice(last, match.index + 2) + REDACTED;
      last = match.index + match[0].length;
    }
  }
  return out + text.slice(last);
}

// A netrc line, machine example.com login bob password hunter2: the word after password goes, but
// only on a line that also says machine or login, so that prose such as "the password field is
// empty" stays. Only lines that hold password are read, each once: the candidate is anchored at a
// line's start and ends where a line does. A line starts behind a line feed, a carriage return,
// U+2028 or U+2029, and the dot stops at each of them, so no line reads into the next. A value that
// starts with = or : belongs to the name pass (password = hunter2).
const NETRC_CANDIDATE = /^.*password.*$/gm;
const NETRC_LINE = /(?<![\w-])(?:machine|login)(?![\w-])/;
const NETRC_PASSWORD = /(?<![\w-])(password[ \t]+)(?:"[^"\n]*"|"?[^\s"=:]\S*)/g;

// The text of an XML element whose name SECRET_NAME matches, as in Maven's settings.xml:
// <password>hunter2</password>. The tags stay. The text runs to the next <, and only the element's
// own closing tag ends it, so an attempt scans no further than the next tag.
const XML_ELEMENT = /(<([A-Za-z_][\w.:-]*)(?:\s[^<>]*)?>)[^<]+(?=<\/\2\s*>)/g;

// A user and password pair in Python: the requests auth=('bob', 'hunter2') tuple, plain or in a
// dict, and the BasicAuth and DigestAuth classes (HTTPBasicAuth('bob', 'hunter2')). The second
// element goes when it is a string that is not empty; a name (password) is no secret of its own.
const AUTH_PAIR = /((?:(?<![\w-])auth["']?[ \t]*[=:][ \t]*\(|(?<!\w)\w*(?:Basic|Digest)Auth\()[ \t]*(?:(["'])[^"'\n]*\2|[\w.]+)[ \t]*,[ \t]*)(["'])[^"'\n]+\3/g;

// A Set-Cookie header sets one cookie, whose value goes; its name and attributes (Path, Expires)
// stay. The header's name starts where a word starts or after a hyphen (X-Set-Cookie), and the
// cookie's name holds no colon, so an attempt reads no further than the next header's colon. A
// Cookie header, plain or in JSON, sends several: each value goes and each name stays. Its
// lookbehind keeps Set-Cookie's attributes out of the Cookie pass.
const SET_COOKIE = /(?<!\w)(set-cookie\\?["']?[ \t]*:[ \t]*\\?["']?[^=;:\s"'\\]*=)[^;\s"'\\]+/gi;
const COOKIE_HEADER = /(?<![\w-])(cookie\\?["']?[ \t]*:[ \t]*\\?["']?)([^\n"']*)/gi;
const COOKIE_VALUE = /=[^;\s\\]+/g;

/** Basic credentials in command-line and config forms, each password replaced with REDACTED. */
function redactBasic(text: string): string {
  let out = redactUserPasswords(text, false);
  out = redactMysqlPasswords(out);
  out = out.replace(NETRC_CANDIDATE, (line) => (NETRC_LINE.test(line) ? line.replace(NETRC_PASSWORD, `$1${REDACTED}`) : line));
  out = out.replace(XML_ELEMENT, (element, open: string, name: string) => (isSecretName(name) ? open + REDACTED : element));
  out = out.replace(AUTH_PAIR, `$1${REDACTED}`);
  out = out.replace(SET_COOKIE, `$1${REDACTED}`);
  out = out.replace(COOKIE_HEADER, (_header, head: string, value: string) => head + value.replace(COOKIE_VALUE, `=${REDACTED}`));
  return ESCAPED_QUOTE.test(out) ? redactUserPasswords(out, true) : out;
}

function mixedCase(run: string): boolean {
  return /[a-z]/.test(run) && /[A-Z]/.test(run);
}

/** The text with credentials replaced by REDACTED. */
export function redact(text: string): string {
  let out = text.replace(URL_PASSWORD, `$1${REDACTED}`).replace(ESCAPED_BREAK, " ");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  out = redactValues(out, NAME_SEPARATOR, VALUE, (m) => m[1]!);
  out = redactValues(out, FLAG_SPACE, FLAG_VALUE, (m) => m[1]!.slice(2));
  out = redactBasic(out);
  out = out.replace(LONG_BASE64, (run) => (mixedCase(run) && /\d/.test(run) && /[+/]/.test(run) ? REDACTED : run));
  return out.replace(LONG_ALNUM, (run) => (mixedCase(run) ? REDACTED : run));
}
