// The sandbox profile `npm run check:sandbox` runs the behaviour suite under (test/sandbox.sb)
// keeps its rules: no network but loopback, no writes outside the run's root, no file contents
// read under the home directory but the checkout's and the root's, and the credential stores
// denied last, so no earlier allow can reopen them. test/run.mjs checks at run time that writes
// are confined; the read and network rules cannot be checked there without touching what they
// protect, so they are checked here, in the profile's own text.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Form = string | Form[];

/** The profile's top-level forms, comments dropped, strings kept with their quotes. */
function parse(text: string): Form[] {
  const tokens = text.replace(/;[^\n]*/g, "").match(/"[^"]*"|[()]|[^\s()"]+/g) ?? [];
  const stack: Form[][] = [[]];
  for (const token of tokens) {
    if (token === "(") {
      stack.push([]);
    } else if (token === ")") {
      const done = stack.pop();
      const parent = stack.at(-1);
      assert.ok(done !== undefined && parent !== undefined, "balanced parentheses");
      parent.push(done);
    } else {
      stack.at(-1)?.push(token);
    }
  }
  assert.equal(stack.length, 1, "balanced parentheses");
  return stack[0] ?? [];
}

const forms = parse(readFileSync(new URL("./sandbox.sb", import.meta.url), "utf8")).filter((form): form is Form[] => Array.isArray(form));
const show = (form: Form): string => (Array.isArray(form) ? `(${form.map(show).join(" ")})` : form);
const rules = forms.filter((form) => form[0] === "allow" || form[0] === "deny");
const rule = (action: string, operation: string): Form[][] => rules.filter((form) => form[0] === action && form[1] === operation);
const filters = (form: Form[]): string[] => form.slice(2).map(show);
const at = (action: string, operation: string): number => rules.findIndex((form) => form[0] === action && form[1] === operation);

test("the profile starts from allow-default and denies the network but loopback", () => {
  assert.equal(show(forms[0] ?? []), "(version 1)");
  assert.equal(show(rules[0] ?? []), "(allow default)");
  assert.deepEqual(rule("deny", "network*").map(filters), [[]]);
  const allowed = rules.filter((form) => form[0] === "allow" && String(form[1]).startsWith("network"));
  assert.ok(allowed.length > 0);
  for (const form of allowed) {
    assert.ok(at("deny", "network*") < rules.indexOf(form));
    for (const filter of filters(form)) assert.match(filter, /^\((remote|local) ip "localhost:\*"\)$/, show(form));
  }
});

test("the profile writes only under the run's root and to the null and terminal devices", () => {
  assert.deepEqual(rule("deny", "file-write*").map(filters), [[]]);
  const allowed = rules.filter((form) => form[0] === "allow" && String(form[1]).startsWith("file-write"));
  for (const form of allowed) {
    assert.ok(at("deny", "file-write*") < rules.indexOf(form));
    for (const filter of filters(form)) assert.match(filter, /^\(subpath \(param "ROOT"\)\)$|^\(literal "\/dev\/(null|zero|tty|dtracehelper)"\)$/, show(form));
  }
});

test("the profile reads no file contents under the home directory but the checkout's and the root's", () => {
  assert.deepEqual(rule("deny", "file-read-data").map(filters), [['(subpath (param "HOME"))']]);
  assert.deepEqual(rule("allow", "file-read-data").map(filters), [['(subpath (param "REPO"))', '(subpath (param "ROOT"))']]);
  assert.ok(at("deny", "file-read-data") < at("allow", "file-read-data"));
  assert.equal(rule("allow", "file-read*").length, 0);
});

test("the profile denies the credential stores last", () => {
  const denied = rule("deny", "file-read*");
  assert.equal(denied.length, 1);
  const last = denied[0] ?? [];
  assert.equal(rules.indexOf(last), rules.length - 1, "no later rule can reopen them");
  assert.deepEqual(filters(last), [
    '(subpath (string-append (param "HOME") "/.config/pi"))',
    '(subpath (string-append (param "HOME") "/.pi"))',
    '(subpath (string-append (param "HOME") "/.ssh"))',
    '(subpath (string-append (param "HOME") "/.gnupg"))',
    '(subpath (string-append (param "HOME") "/.password-store"))',
    '(literal (string-append (param "HOME") "/.npmrc"))',
  ]);
});
