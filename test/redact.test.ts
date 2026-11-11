import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { redact, REDACTED } from "../src/redact.ts";

const pgpBody = "lQOYBF1bU2kBCAC7nV3rXQ9p+Kq/2mZtYw8sH4dLcE6aR0uJfGiT5vNoBxWy1zA3";
const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const mixed40 = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k";
// A 32-character lowercase hex key: no backstop matches it, so only its name can hide it.
const hexKey = "4f1c9e2ab7d35e8c0a6b2d9f17e3c5a8";

describe("redact", () => {
  const secrets: ReadonlyArray<readonly [string, string, string]> = [
    ["a bearer token", "Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
    ["a basic credential", "Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ["an OpenAI key", `key sk-proj-${"a1B2c3D4e5".repeat(4)} end`, "a1B2c3D4e5"],
    ["a GitHub token", `token ghp_${"x9Y8z7W6v5".repeat(3)}abcdef`, "x9Y8z7W6v5"],
    ["a Slack token", "slack xoxb-1-2-3 end", "xoxb-1-2-3"],
    ["an AWS key id", "id AKIA0ABCDEFGHIJKLMNO end", "AKIA0ABCDEFGHIJKLMNO"],
    [
      "a private key block",
      "before\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\nafter",
      "MIIEvQIBADANBgkq",
    ],
    ["an unterminated private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADANBgkq", "MIIEvQIBADANBgkq"],
    ["a URL password", "see https://user:hunter2@example.com/x now", "hunter2"],
    ["a password assignment", "password=hunter2", "hunter2"],
    ["an API key assignment", "API_KEY: abc123", "abc123"],
    ["a JSON api_key", '{"api_key": "q8Zt1rLm9Xa"}', "q8Zt1rLm9Xa"],
    ["a JSON password", '{"password": "hunter2"}', "hunter2"],
    ["a JSON Authorization header", 'headers = {"Authorization": "Bearer q8Zt1rLm9Xa.bb.cc"}', "q8Zt1rLm9Xa"],
    ["an Authorization header with another scheme", "Authorization: Token q8Zt1rLm9Xa", "q8Zt1rLm9Xa"],
    ["a quoted SECRET_KEY", "SECRET_KEY = 'django-insecure-k3j4h5g6f7d8s9a0'", "k3j4h5g6f7d8s9a0"],
    ["an AWS secret in a credentials file", `aws_secret_access_key = ${awsSecret}`, "bPxRfiCYEXAMPLEKEY"],
    ["an AWS secret in the environment", `AWS_SECRET_ACCESS_KEY=${awsSecret}`, "bPxRfiCYEXAMPLEKEY"],
    ["a bare AWS secret", `the value ${awsSecret} here`, "bPxRfiCYEXAMPLEKEY"],
    ["a passphrase with spaces", 'password="correct horse battery staple"', "battery staple"],
    ["a URL with an empty user", "redis://:s3cretpass@localhost:6379/0", "s3cretpass"],
    ["a PGP private key block", `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${pgpBody}\n-----END PGP PRIVATE KEY BLOCK-----`, "lQOYBF1bU2kBCAC7nV3rXQ9p"],
    ["a fine-grained GitHub token", `github_pat_11ABCDEFG0aBcDeFgHiJkLmN_${"aB3dE5gH7j".repeat(6)}`, "aB3dE5gH7j"],
    ["a Stripe live key", `sk_live_${"aB3dE5gH7j".repeat(5)}`, "aB3dE5gH7j"],
    ["a Stripe test key", `rk_test_${"aB3dE5gH7j".repeat(3)}`, "aB3dE5gH7j"],
    ["a GitLab token", `glpat-${"aB3dE5gH7j".repeat(2)}`, "aB3dE5gH7j"],
    ["a Hugging Face token", `hf_${"aB3dE5gH7j".repeat(3)}`, "aB3dE5gH7j"],
    ["an npm token", `npm_${"aB3dE5gH7j".repeat(3)}`, "aB3dE5gH7j"],
    ["a Slack app token", "xapp-1-A0123-4567-aB3dE5gH7jK9", "aB3dE5gH7jK9"],
    ["a Google API key", `AIza${"aB3dE5gH7j".repeat(3)}aB3dE`, "aB3dE5gH7j"],
    ["an AWS session key id", "id ASIAABCDEFGHIJKLMNOP end", "ASIAABCDEFGHIJKLMNOP"],
    ["a long mixed-case string", `value ${mixed40} end`, mixed40],
  ];

  for (const [name, input, secret] of secrets) {
    test(`hides ${name}`, () => {
      const out = redact(input);
      assert.ok(out.includes(REDACTED), out);
      assert.ok(!out.includes(secret), out);
    });
  }

  test("keeps the user of a URL credential", () => {
    assert.equal(redact("https://user:hunter2@example.com/x"), `https://user:${REDACTED}@example.com/x`);
  });

  test("keeps the key name and spares ordinary settings", () => {
    assert.equal(redact('{"password": "hunter2"}'), `{"password": ${REDACTED}}`);
    assert.equal(redact("max_tokens: 4096"), "max_tokens: 4096");
    assert.equal(redact("timeout = 30"), "timeout = 30");
    assert.equal(redact("commit 3f786850e387550fdab836ed7e6dc881de23001b"), "commit 3f786850e387550fdab836ed7e6dc881de23001b");
    const digest = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    assert.equal(redact(digest), digest);
  });

  test("leaves ordinary text alone", () => {
    assert.equal(redact("rename foo to bar in src/a.ts"), "rename foo to bar in src/a.ts");
    const lower = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";
    assert.equal(lower.length, 40);
    assert.equal(redact(lower), lower);
  });

  test("hides a secret inside a non-secret key's value", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["curl https://api.example.com/v1/items?api_key=q8Zt1rLm9XaQ", "q8Zt1rLm9XaQ"],
      ["http://localhost:8888/lab?token=4f1c9e2ab7d3", "4f1c9e2ab7d3"],
      ["body: user=bob&password=hunter2", "hunter2"],
      ["jdbc:postgresql://db:5432/app?user=fred&password=s3cretpw", "s3cretpw"],
      ['{"command": "mysql --password=hunter2 -u root app"}', "hunter2"],
      ['level=error msg="login failed: password=hunter2 rejected"', "hunter2"],
    ];
    for (const [input, secret] of cases) {
      const out = redact(input);
      assert.ok(out.includes(REDACTED) && !out.includes(secret), out);
    }
    assert.equal(redact("body: user=bob&password=hunter2"), `body: user=bob&password=${REDACTED}`);
  });

  test("hides quoted and comma-joined bearer credentials", () => {
    for (const input of ['Authorization: Bearer "q8Zt1rLm9XaQ"', "Authorization: Bearer q8Zt1rLm9XaQ,zz9Yy8Xx7"]) {
      const out = redact(input);
      assert.ok(!/q8Zt|zz9Yy/.test(out), out);
    }
  });

  test("hides a whole JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    assert.equal(redact(`token was ${jwt} ok`), `token was ${REDACTED} ok`);
    assert.equal(redact(`see ${jwt}`), `see ${REDACTED}`);
  });

  test("hides other assignment shapes and key-like names", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['os.environ["DB_PASSWORD"] = "hunter2"', "hunter2"],
      ["'password' => 'hunter2'", "hunter2"],
      ['password := "hunter2"', "hunter2"],
      ["mysql --password hunter2 -u root", "hunter2"],
      ['mysql --password "hunter 2" -u root', "hunter 2"],
      ["credentials: q8Zt1rLm9XaQ", "q8Zt1rLm9XaQ"],
      ["ENCRYPTION_KEY=q8Zt1rLm9XaQ", "q8Zt1rLm9XaQ"],
      ["encryptionKey: q8Zt1rLm9XaQ", "q8Zt1rLm9XaQ"],
      ['password="unterminated secret', "unterminated secret"],
    ];
    for (const [input, secret] of cases) {
      const out = redact(input);
      assert.ok(out.includes(REDACTED) && !out.includes(secret), out);
    }
    for (const spared of ["--verbose true", "--timeout 30", "keyboard = us"]) {
      assert.equal(redact(spared), spared);
    }
  });

  test("hides names ending in key, whatever their case", () => {
    for (const input of ["masterkey: q8Zt1rLm9XaQ", "passkey=q8Zt1rLm9XaQ", "encryptionkey=q8Zt1rLm9XaQ", "Encryption_Key=q8Zt1rLm9XaQ", "Key=q8Zt1rLm9XaQ", "MONKEY: q8Zt1rLm9XaQ"]) {
      const out = redact(input);
      assert.ok(out.includes(REDACTED) && !out.includes("q8Zt1rLm9XaQ"), out);
    }
    assert.equal(redact("keyboard = us"), "keyboard = us");
  });

  test("scans a flag's quoted value for secret flags", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['ssh host --command "mysql --password hunter2"', "hunter2"],
      ["run --args '--token t0k3n'", "t0k3n"],
      ['docker run --entrypoint "app --api-key q8Zt1rLm9XaQ"', "q8Zt1rLm9XaQ"],
    ];
    for (const [input, secret] of cases) {
      const out = redact(input);
      assert.ok(out.includes(REDACTED) && !out.includes(secret), out);
    }
  });

  test("ends an unclosed quote at the next whitespace", () => {
    const text = "Fix the bug: the token: 'it never refreshes and I want to investigate the retry loop";
    assert.equal(redact(text), `Fix the bug: the token: ${REDACTED} never refreshes and I want to investigate the retry loop`);
    assert.equal(redact("--token 'abc def"), `--token ${REDACTED} def`);
  });

  test("ends a quoted value only at a quote that no word follows", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["masterkey: 'it is in the vault and the user's copy is stale", `masterkey: ${REDACTED} is in the vault and the user's copy is stale`],
      ["authorization = 'it never works when the user's token expires, why", `authorization = ${REDACTED} never works when the user's token expires, why`],
      ['the password: "it fails when I click "save" in the dialog', `the password: ${REDACTED} fails when I click "save" in the dialog`],
      ["the --token 'refresh logic breaks when the user's session ends", `the --token ${REDACTED} logic breaks when the user's session ends`],
      ['the --token "it fails when I click "save" in the dialog', `the --token ${REDACTED} fails when I click "save" in the dialog`],
      ["masterkey: 'it is in the user's vault, see 'docs' now", `masterkey: ${REDACTED} is in the user's vault, see 'docs' now`],
      ["the --token 'it breaks when the user's 'save' runs", `the --token ${REDACTED} breaks when the user's 'save' runs`],
    ];
    for (const [input, want] of cases) assert.equal(redact(input), want);
  });

  test("hides escaped quotes and an Authorization name", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['{\\"password\\": \\"hunter2\\"}', "hunter2"],
      ['{"Authorization": "Bearer \\"q8Zt1rLm9XaQ\\""}', "q8Zt1rLm9XaQ"],
      ['headers=dict(Authorization="Bearer q8Zt1rLm9XaQ")', "q8Zt1rLm9XaQ"],
      ['Authorization\\": Bearer q8Zt1rLm9XaQ', "q8Zt1rLm9XaQ"],
    ];
    for (const [input, secret] of cases) {
      const out = redact(input);
      assert.ok(out.includes(REDACTED) && !out.includes(secret), out);
    }
    assert.equal(redact('{\\"password\\": \\"hunter 2\\"}'), `{\\"password\\": ${REDACTED}}`);
    assert.equal(redact('{"command": "mysql --password \\"hunter 2\\" -u root"}'), `{"command": "mysql --password ${REDACTED} -u root"}`);
  });

  test("hides the whole Authorization credential when it holds a JSON escape", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['{"Authorization":"Basic dXNlcjpw\\/YXNzd29yZA=="}', "YXNzd29yZA"],
      ['{"headers":{"Authorization":"Bearer q8Zt1rLm\\/9XaQwE3rT"}}', "9XaQwE3rT"],
      ['{"Authorization":"Basic dXNlcjpwYXNz\\u002Bd29yZA=="}', "d29yZA"],
      ["Authorization: Basic dXNlcjpw\\/YXNzd29yZA==", "YXNzd29yZA"],
      ['curl -H "Authorization: Bearer abc\\/def123XYZ"', "def123XYZ"],
      ['{\\"Authorization\\": \\"Bearer q8Zt\\/1rLm9XaQ\\"}', "1rLm9XaQ"],
    ];
    for (const [input, tail] of cases) {
      const out = redact(input);
      assert.ok(out.includes(REDACTED) && !out.includes(tail), out);
    }
  });

  // JSON and a repr write a line break or a tab as a backslash and a letter. Each reads as one
  // space, so it ends the value before it and the name after it stays, with its value hidden.
  const escapedBreaks: ReadonlyArray<readonly [string, string, string]> = [
    [
      "the API key after an escaped line break in a JSON log line",
      `{"msg": "request headers", "raw": "Authorization: Bearer q8Zt1rLm\\nX-Api-Key: ${hexKey}\\n"}`,
      `{"msg": "request headers", "raw": "${REDACTED} X-Api-Key: ${REDACTED} "}`,
    ],
    [
      "the proxy credential after an escaped CRLF",
      `"Authorization: Basic dXNlcjpw\\r\\nProxy-Authorization: Basic ${hexKey}\\r\\n"`,
      `"${REDACTED}  Proxy-${REDACTED}  "`,
    ],
    ["the token header after an escaped CRLF", `"Authorization: Bearer abc\\r\\nX-Auth-Token: ${hexKey}"`, `"${REDACTED}  X-Auth-Token: ${REDACTED}"`],
    ["the vault token after an escaped line break", `"Authorization: Bearer abc\\nX-Vault-Token: ${hexKey}"`, `"${REDACTED} X-Vault-Token: ${REDACTED}"`],
    ["the password after an escaped line break", '"Authorization: Bearer abc\\npassword: hunter2"', `"${REDACTED} password: ${REDACTED}"`],
    ["the password after an escaped tab", '"Authorization: Bearer abc\\tpassword: hunter2"', `"${REDACTED} password: ${REDACTED}"`],
    ["a credential after an escaped CRLF", "\\r\\nAuthorization: Bearer q8Zt1rLm9XaQ", `  ${REDACTED}`],
    ["the API key after a password and an escaped line break", `"password: hunter2\\napi_key: ${hexKey}"`, `"password: ${REDACTED} api_key: ${REDACTED}"`],
    ["the API key flag after a password flag and an escaped line break", `"--password hunter2\\n--api-key ${hexKey}"`, `"--password ${REDACTED} --api-key ${REDACTED}"`],
  ];

  for (const [name, input, want] of escapedBreaks) {
    test(`hides ${name}`, () => {
      assert.equal(redact(input), want);
    });
  }

  // A Windows DOMAIN\user name is no escape: the backslash before t, r or n in CORP\tom is the
  // user's. The URL password must be found before \t, \r and \n read as spaces and split the URL.
  const domainUsers: ReadonlyArray<readonly [string, string]> = [
    ["a proxy URL, CORP\\tom", "http://CORP\\tom:hunter2X9@proxy.corp:8080"],
    ["a proxy URL, CORP\\rsmith", "http://CORP\\rsmith:hunter2X9@proxy.corp:8080"],
    ["a proxy URL, AD\\nancy", "https://AD\\nancy:hunter2X9@proxy.corp:3128"],
    ["a shell export with the backslash escaped", 'export HTTPS_PROXY="http://CORP\\\\tom:hunter2X9@proxy.corp:8080"'],
    ["VS Code's settings.json", '{"http.proxy": "http://CORP\\\\tom:hunter2X9@proxy.corp:8080", "http.proxyStrictSSL": false}'],
    ["an npm config line", "npm config set proxy http://CORP\\tom:hunter2X9@proxy.corp:8080"],
    ["pip's --proxy", "pip install --proxy http://CORP\\tom:hunter2X9@proxy.corp:8080 requests"],
    ["git's http.proxy", "git config --global http.proxy http://CORP\\tom:hunter2X9@proxy.corp:8080"],
    ["a git-credentials line", "https://CORP\\tom:hunter2X9@git.corp.example"],
    ["an smb URL", "smb://CORP\\tom:hunter2X9@fileserver/share"],
  ];

  for (const [name, input] of domainUsers) {
    test(`hides the password of a DOMAIN\\user URL: ${name}`, () => {
      const out = redact(input);
      assert.ok(out.includes(REDACTED), out);
      assert.ok(!out.includes("hunter2X9"), out);
    });
  }

  test("leaves a backslash before any other letter as it is, uppercase T included", () => {
    for (const text of ["CORP\\Tom", "C:\\Temp", "logged in as CORP\\Tom from C:\\Temp\\New"]) {
      assert.equal(redact(text), text);
    }
  });

  // Basic credentials in command-line and config forms. Each secret goes, and what tells the
  // classifier what the text is about (the command, the user, the names) stays.
  const basicCredentials: ReadonlyArray<readonly [string, string, string]> = [
    ["curl's -u", "curl -u admin:Hunter2pw https://api.example.com", `curl -u admin:${REDACTED} https://api.example.com`],
    ["curl's --user", "curl --user admin:Hunter2pw https://api.example.com", `curl --user admin:${REDACTED} https://api.example.com`],
    ["curl's --user=", "curl --user=admin:Hunter2pw https://api.example.com", `curl --user=admin:${REDACTED} https://api.example.com`],
    ["curl's --proxy-user", "curl -x proxy:3128 --proxy-user bob:Hunter2pw https://x", `curl -x proxy:3128 --proxy-user bob:${REDACTED} https://x`],
    ["curl's -U", "curl -U bob:Hunter2pw https://x", `curl -U bob:${REDACTED} https://x`],
    ["a quoted -u value with a space in the password", "curl -u 'admin:Hunter 2pw' https://x", `curl -u 'admin:${REDACTED}' https://x`],
    ["a password with a colon in it", "curl -u admin:Hunter2:pw https://x", `curl -u admin:${REDACTED} https://x`],
    ["a -u glued to its value", "curl -uadmin:Hunter2pw https://x", `curl -uadmin:${REDACTED} https://x`],
    ["curl's -u after other flags", "curl -s -X POST -u admin:Hunter2pw https://h", `curl -s -X POST -u admin:${REDACTED} https://h`],
    ["curl's -u when curl is named by its path", "/usr/bin/curl -u a:Hunter2pw https://h", `/usr/bin/curl -u a:${REDACTED} https://h`],
    ["curl's -u after a tab", "curl\t-u admin:Hunter2pw https://h", `curl\t-u admin:${REDACTED} https://h`],
    ["curl's -u inside a command substitution", "body=$(curl -u admin:Hunter2pw https://h)", `body=$(curl -u admin:${REDACTED} https://h)`],
    ["curl's -u after a URL with an ampersand, which ends no command", "curl https://h/x?a=1&b=2 -u admin:Hunter2pw", `curl https://h/x?a=1&b=2 -u admin:${REDACTED}`],
    ["curl's -u in the command after a semicolon", "cd /tmp; curl -u admin:Hunter2pw https://h", `cd /tmp; curl -u admin:${REDACTED} https://h`],
    ["curl's -u with an LDAP name, which holds equals signs", 'curl -u "uid=bob,ou=people,dc=example,dc=com:Hunter2pw" ldap://h/', `curl -u "uid=bob,ou=people,dc=example,dc=com:${REDACTED}" ldap://h/`],
    ["curl's -u with an unquoted name that holds an equals sign", "curl -u team=ops:Hunter2pw https://h", `curl -u team=ops:${REDACTED} https://h`],
    ["a quoted -u value whose password holds a colon", "curl -u 'admin:Hunter2:pw' https://h", `curl -u 'admin:${REDACTED}' https://h`],
    ["a quoted -u value that holds a flag", "curl -u 'admin:Hunter 2pw -U x:y' https://h", `curl -u 'admin:${REDACTED}' https://h`],
    ["a quoted -u value that holds a semicolon, and the -U after it", "curl -u 'admin:Hunter;2pw' -U b:Hunter3pw https://h", `curl -u 'admin:${REDACTED}' -U b:${REDACTED} https://h`],
    ["a quoted -u value that its line ends", "curl -u 'admin:Hunter2pw\nsecond line 'quoted'", `curl -u 'admin:${REDACTED}\nsecond line 'quoted'`],
    ["curl's -u on a line that a backslash continues", "curl -X POST https://h \\\n  -u admin:Hunter2pw", `curl -X POST https://h \\\n  -u admin:${REDACTED}`],
    ["curl's -U after a -u line that a backslash continues", "curl -u admin:Hunter2pw \\\n  -U proxy:Hunter3pw \\\n  https://h", `curl -u admin:${REDACTED} \\\n  -U proxy:${REDACTED} \\\n  https://h`],
    ["curl's -u after a backslash and a CRLF", "curl https://h \\\r\n  -u admin:Hunter2pw", `curl https://h \\\r\n  -u admin:${REDACTED}`],
    ["curl's -u after a semicolon in a quoted header", "curl -H 'Content-Type: application/json; charset=utf-8' -u admin:Hunter2pw https://h", `curl -H 'Content-Type: application/json; charset=utf-8' -u admin:${REDACTED} https://h`],
    ["curl's -u after a semicolon in a double-quoted header", 'curl -H "Accept: text/html; q=0.9" -u admin:Hunter2pw https://h', `curl -H "Accept: text/html; q=0.9" -u admin:${REDACTED} https://h`],
    ["curl's -u after a pipe in a quoted URL", "curl 'https://h/x?q=a|b' -u admin:Hunter2pw", `curl 'https://h/x?q=a|b' -u admin:${REDACTED}`],
    ["curl's -u after && in a double-quoted body", 'curl -d "a && b" -u admin:Hunter2pw https://h', `curl -d "a && b" -u admin:${REDACTED} https://h`],
    ["curl's --user after || in a quoted body", "curl -d 'a || b' --user admin:Hunter2pw https://h", `curl -d 'a || b' --user admin:${REDACTED} https://h`],
    ["curl's -u after a semicolon behind a quote that never closes", "curl -H 'Accept: a; b -u admin:Hunter2pw https://h", `curl -H 'Accept: a; b -u admin:${REDACTED} https://h`],
    ["curl's -u after a quoted argument that holds the other quote", 'curl -H "it\'s; here" -u admin:Hunter2pw https://h', `curl -H "it's; here" -u admin:${REDACTED} https://h`],
    ["curl's -u after a quoted argument that a backslash continues", "curl -d 'a \\\n b; c' -u admin:Hunter2pw https://h", `curl -d 'a \\\n b; c' -u admin:${REDACTED} https://h`],
    ["curl's -u inside a quoted argument, behind a semicolon", "curl -K 'x; -u admin:Hunter2pw' https://h", `curl -K 'x; -u admin:${REDACTED}' https://h`],
    ["a quoted -u value that its line ends, before another command", "curl -u 'admin:Hunter2pw\ndate -u +%H:%M:%S", `curl -u 'admin:${REDACTED}\ndate -u +%H:%M:%S`],
    ["a quoted -u value, whose closing quote opens nothing", "curl -u 'admin:Hunter2pw' https://h; date -u +%H:%M:%S", `curl -u 'admin:${REDACTED}' https://h; date -u +%H:%M:%S`],
    ["curl's -u after a semicolon in a double-quoted body with escaped quotes", "curl -X POST -d \"{\\\"query\\\": \\\"SELECT 1; SELECT 2\\\"}\" -u admin:Hunter2pw https://h", `curl -X POST -d "{\\"query\\": \\"SELECT 1; SELECT 2\\"}" -u admin:${REDACTED} https://h`],
    ["curl's --user after a pipe in a double-quoted body with escaped quotes", "curl -d \"{\\\"filter\\\": \\\"a | b\\\"}\" --user admin:Hunter2pw https://h", `curl -d "{\\"filter\\": \\"a | b\\"}" --user admin:${REDACTED} https://h`],
    ["curl's -U after && in a double-quoted body with escaped quotes", "curl -d \"{\\\"cmd\\\": \\\"a && b\\\"}\" -U proxy:Hunter2pw https://h", `curl -d "{\\"cmd\\": \\"a && b\\"}" -U proxy:${REDACTED} https://h`],
    ["curl's -u after a semicolon in a double-quoted header with escaped quotes", "curl -H \"X-Note: say \\\"hi; there\\\"\" -u admin:Hunter2pw https://h", `curl -H "X-Note: say \\"hi; there\\"" -u admin:${REDACTED} https://h`],
    ["curl's -u after a single-quoted body with an escaped quote between its pieces", "curl -d 'it'\\''s; here' -u admin:Hunter2pw https://h", `curl -d 'it'\\''s; here' -u admin:${REDACTED} https://h`],
    ["curl's -u in a command that a JSON string holds, with escaped quotes around a semicolon", "{\"command\": \"curl -H \\\"x; y\\\" -u admin:Hunter2pw https://h\"}", `{"command": "curl -H \\"x; y\\" -u admin:${REDACTED} https://h"}`],
    ["a mysql password glued behind a curl password that only the shell's reading finds", "curl -d \"{\\\"a\\\": \\\"b; c\\\"}\" -u admin:Hunter2pw|mysql -uroot -pHunter3pw", `curl -d "{\\"a\\": \\"b; c\\"}" -u admin:${REDACTED} -uroot -p${REDACTED}`],
    ["curl's -u after a quote behind three backslashes in a double-quoted body", 'curl -d "a\\\\\\"b; c" -u admin:Hunter2pw https://h', `curl -d "a\\\\\\"b; c" -u admin:${REDACTED} https://h`],
    ["curl's -u after a quote behind five backslashes in a double-quoted body", 'curl -d "a\\\\\\\\\\"b; c" -u admin:Hunter2pw https://h', `curl -d "a\\\\\\\\\\"b; c" -u admin:${REDACTED} https://h`],
    ["a netrc password that ends a curl command with no escaped quote, which is read once", "curl -s https://h login bob password a;b; date -u +%H:%M:%S", `curl -s https://h login bob password ${REDACTED} date -u +%H:%M:%S`],
    ["curl's -u and -U in one command", "curl -u a:Hunter2pw -U b:Hunter3pw https://h", `curl -u a:${REDACTED} -U b:${REDACTED} https://h`],
    ["wget's --proxy-user, which no curl word precedes", "wget --proxy-user bob:Hunter2pw https://h", `wget --proxy-user bob:${REDACTED} https://h`],
    ["a --proxy-user= outside curl", "wget --proxy-user=bob:Hunter2pw https://h", `wget --proxy-user=bob:${REDACTED} https://h`],
    ["a quoted --proxy-user value outside curl", "wget --proxy-user 'bob:Hunter 2pw' https://h", `wget --proxy-user 'bob:${REDACTED}' https://h`],
    ["a --proxy-user that opens a quoted string", 'WGET_OPTS="--proxy-user bob:Hunter2pw"', `WGET_OPTS="--proxy-user bob:${REDACTED}"`],
    ["curl's -u that opens a quoted string", "curl '-uadmin:Hunter2pw' https://h", `curl '-uadmin:${REDACTED}' https://h`],
    ["curl's -u that opens a double-quoted string", 'curl "-uadmin:Hunter2pw" https://h', `curl "-uadmin:${REDACTED}" https://h`],
    ["curl's -u that opens inline code", "Run curl with `-u admin:Hunter2pw` first", `Run curl with \`-u admin:${REDACTED} first`],
    ["a --proxy-user that opens inline code", "pass `--proxy-user bob:Hunter2pw` to wget", `pass \`--proxy-user bob:${REDACTED} to wget`],
    ["mysql's -p", "mysql -pHunter2pw", `mysql -p${REDACTED}`],
    ["mysqldump's -p after -u root", "mysqldump -u root -pHunter2pw db", `mysqldump -u root -p${REDACTED} db`],
    ["mysql's -p after a glued -u", "mysql -uroot -pHunter2pw", `mysql -uroot -p${REDACTED}`],
    ["mariadb-dump's -p", "mariadb-dump -pHunter2pw db", `mariadb-dump -p${REDACTED} db`],
    ["mysql's -p by its path", "/usr/local/bin/mysql -h db -pHunter2pw", `/usr/local/bin/mysql -h db -p${REDACTED}`],
    ["mysql's -p inside docker exec", "docker exec -it db mysql -uroot -pHunter2pw", `docker exec -it db mysql -uroot -p${REDACTED}`],
    ["mysql's quoted -p", "mysql -p'Hunter 2pw' db", `mysql -p${REDACTED} db`],
    ["mysql's double-quoted -p", 'mysql -p"Hunter 2pw" db', `mysql -p${REDACTED} db`],
    ["mysql's -p before a semicolon, which ends the command", "mysql -pHunter2pw;cp -pr src dst", `mysql -p${REDACTED};cp -pr src dst`],
    ["a netrc line", "machine example.com login bob password Hunter2pw", `machine example.com login bob password ${REDACTED}`],
    ["a netrc line with login only", "login bob password Hunter2pw", `login bob password ${REDACTED}`],
    ["a netrc line with machine only", "machine example.com password Hunter2pw", `machine example.com password ${REDACTED}`],
    ["a netrc password before its machine", "password Hunter2pw machine example.com", `password ${REDACTED} machine example.com`],
    ["a quoted netrc password", 'machine x login bob password "Hunter 2pw"', `machine x login bob password ${REDACTED}`],
    ["a netrc password with an unclosed quote", 'machine x login bob password "Hunter2pw', `machine x login bob password ${REDACTED}`],
    ["a netrc line among other lines", "first line\nmachine x login bob password Hunter2pw\nlast line", `first line\nmachine x login bob password ${REDACTED}\nlast line`],
    ["a netrc line among lines that end in CRLF", "first line\r\nmachine x login bob password Hunter2pw\r\nlast line", `first line\r\nmachine x login bob password ${REDACTED}\r\nlast line`],
    ["a password = value on a netrc line, which the name pass takes", "machine x login bob password = Hunter2pw", `machine x login bob password = ${REDACTED}`],
    ["a password : value on a netrc line, which the name pass takes", "machine x login bob password : Hunter2pw", `machine x login bob password : ${REDACTED}`],
    ["an XML password element", "<password>Hunter2pw</password>", `<password>${REDACTED}</password>`],
    [
      "Maven's settings.xml",
      "<server><id>x</id><username>bob</username><password>Hunter2pw</password></server>",
      `<server><id>x</id><username>bob</username><password>${REDACTED}</password></server>`,
    ],
    ["an XML private key", "<privateKey>Hunter2pw</privateKey>", `<privateKey>${REDACTED}</privateKey>`],
    ["an XML element with attributes", '<password type="plain">Hunter2pw</password>', `<password type="plain">${REDACTED}</password>`],
    ["a namespaced XML element", "<ns:secret>Hunter2pw</ns:secret>", `<ns:secret>${REDACTED}</ns:secret>`],
    ["an XML element over several lines", "<passphrase>\n  Hunter2pw\n</passphrase>", `<passphrase>${REDACTED}</passphrase>`],
    ["an XML element whose closing tag has a space", "<password>Hunter2pw</password >", `<password>${REDACTED}</password >`],
    ["requests' auth tuple", "requests.get(url, auth=('bob', 'Hunter2pw'))", `requests.get(url, auth=('bob', ${REDACTED}))`],
    ["an auth tuple without spaces", "auth=('bob','Hunter2pw')", `auth=('bob',${REDACTED})`],
    ["a double-quoted auth tuple", 'auth = ("bob", "Hunter2pw")', `auth = ("bob", ${REDACTED})`],
    ["an auth tuple whose user is a name", "session.auth = (user, 'Hunter2pw')", `session.auth = (user, ${REDACTED})`],
    ["an auth tuple in a dict", "{'auth': ('bob', 'Hunter2pw')}", `{'auth': ('bob', ${REDACTED})}`],
    ["requests' HTTPBasicAuth", "auth=HTTPBasicAuth('bob', 'Hunter2pw')", `auth=HTTPBasicAuth('bob', ${REDACTED})`],
    ["requests' HTTPDigestAuth", "HTTPDigestAuth('bob', 'Hunter2pw')", `HTTPDigestAuth('bob', ${REDACTED})`],
    ["aiohttp's BasicAuth", "aiohttp.BasicAuth('bob', 'Hunter2pw')", `aiohttp.BasicAuth('bob', ${REDACTED})`],
    ["a Cookie header", "Cookie: session=Hunter2pwSessionTok", `Cookie: session=${REDACTED}`],
    ["a Cookie header with two cookies", "Cookie: a=Hunter2pw; b=Hunter3pw", `Cookie: a=${REDACTED}; b=${REDACTED}`],
    ["a lowercase cookie header", "cookie: session=Hunter2pw", `cookie: session=${REDACTED}`],
    ["a JSON Cookie header", '{"Cookie": "session=Hunter2pw"}', `{"Cookie": "session=${REDACTED}"}`],
    ["an escaped JSON Cookie header", '{\\"Cookie\\": \\"session=Hunter2pw\\"}', `{\\"Cookie\\": \\"session=${REDACTED}\\"}`],
    ["a Cookie header among other headers", "Cookie: session=Hunter2pw\nX-Mode: debug=on", `Cookie: session=${REDACTED}\nX-Mode: debug=on`],
    ["a Cookie header after an escaped CRLF", "Host: x\\r\\nCookie: session=Hunter2pw", `Host: x  Cookie: session=${REDACTED}`],
    ["a Set-Cookie header, whose attributes stay", "Set-Cookie: sid=Hunter2pw; Path=/; HttpOnly", `Set-Cookie: sid=${REDACTED}; Path=/; HttpOnly`],
    ["a lowercase set-cookie header", "set-cookie: sid=Hunter2pw", `set-cookie: sid=${REDACTED}`],
    ["a JSON Set-Cookie header", '{"Set-Cookie": "sid=Hunter2pw"}', `{"Set-Cookie": "sid=${REDACTED}"}`],
    ["a single-quoted Set-Cookie header", "{'Set-Cookie': 'sid=Hunter2pw'}", `{'Set-Cookie': 'sid=${REDACTED}'}`],
    ["an escaped JSON Set-Cookie header", '{\\"Set-Cookie\\": \\"sid=Hunter2pw\\"}', `{\\"Set-Cookie\\": \\"sid=${REDACTED}\\"}`],
    ["a Set-Cookie header behind a prefix and a hyphen", "X-Set-Cookie: sid=Hunter2pw; Path=/", `X-Set-Cookie: sid=${REDACTED}; Path=/`],
  ];

  for (const [name, input, want] of basicCredentials) {
    test(`hides the basic credential in ${name}`, () => {
      assert.equal(redact(input), want);
    });
  }

  // Flags, ports and prose that only look like credentials.
  const notCredentials: readonly string[] = [
    "curl -u",
    "curl -u\nhttps://api.example.com",
    "curl -u admin: https://api.example.com",
    "curl -u 'admin:' https://h",
    "git push -u origin main",
    "menu-u a:b",
    "pip install -U git+https://github.com/org/repo.git",
    "date -u +%H:%M:%S",
    "rsync -u host:/src/ dst/",
    "docker run -u 1000:1000 img",
    "docker run --user 1000:1000 img",
    "docker run --user=1000:1000 img",
    "id -u",
    "ps -u root",
    "echo curl; date -u +%H:%M:%S",
    "curl https://h | sort -u -t: -k1",
    "curl https://h | docker run -i -u 1000:1000 img",
    "curl -s https://h && date -u +%H:%M:%S",
    "curl -s https://h || date -u +%H:%M:%S",
    "curl -s https://h\ndate -u +%H:%M:%S",
    "curl -s https://h\r\ndate -u +%H:%M:%S",
    "echo 'a;b'; date -u +%H:%M:%S",
    "curl -H 'x; y' https://h | sort -u -t: -k1",
    "curl -H 'x; y' https://h | docker run -i -u 1000:1000 img",
    "curl -H 'x; y' https://h; date -u +%H:%M:%S",
    'curl -H "x; y" https://h && date -u +%H:%M:%S',
    "curl -H 'x; y https://h\ndate -u +%H:%M:%S",
    "curl -H 'x https://h\ncurl https://h; date -u +%H:%M:%S",
    'curl -H "it\'s" https://h; date -u +%H:%M:%S',
    "Run `curl -s https://h`; date -u +%H:%M:%S",
    "echo \"a \\\"b; c\\\" d\"; date -u +%H:%M:%S",
    "curl -d \"{\\\"a\\\": 1}\" https://h; date -u +%H:%M:%S",
    "curl -d \"C:\\\\dir\\\\\" https://h; date -u +%H:%M:%S",
    'curl -d "a\\\\\\\\" https://h; date -u +%H:%M:%S',
    "curl -d 'C:\\dir\\' https://h; date -u +%H:%M:%S",
    "curl -s https://h \\ \ndate -u +%H:%M:%S",
    "curl -s https://h; date -u +%H:%M:%S",
    "see libcurl and date -u +%H:%M:%S",
    "see php-curl and date -u +%H:%M:%S",
    "edit curl.cfg, then date -u +%H:%M:%S",
    "curl https://api.example.com/items?sort=-updated:desc",
    "curl https://h/a,-U:b",
    "curl --username:bob https://h",
    "see wget.html#--proxy-user user:password",
    "mkdir -p build",
    "cp -pr src dst",
    "ssh -p 2222 host",
    "git log -p",
    "docker run -p 8080:80 img",
    "docker run -p8080:80 img",
    "mysql -p",
    "mysql -p mydb",
    "mysql --skip-pager db",
    "mysql db | cp -pr src dst",
    "mysql db; cp -pr src dst",
    "mysql db && cp -pr src dst",
    "mysql db\ncp -pr src dst",
    "edit mysql.cnf, then cp -pr src dst",
    "see pymysql and cp -pr src dst",
    "Click password reset to continue.",
    "the password field is empty",
    "the password field is empty\nlogin bob",
    "the password field is empty\r\nlogin bob",
    "the password field is empty\rlogin bob",
    "loginForm has a password field",
    "relogin with a password reset",
    "login bob with nopassword set",
    "<username>bob</username>",
    "<password></password>",
    "Press <Key>Enter</kbd> to continue",
    "auth=(user, password)",
    "auth=('bob', '')",
    "oauth=('client', 'scope')",
    "reset-cookie: when=logout",
  ];

  for (const text of notCredentials) {
    test(`leaves ${JSON.stringify(text)} as it is`, () => {
      assert.equal(redact(text), text);
    });
  }

  // A basic credential beside a secret that its name gives away. The names are read first, so a
  // basic value that runs on (through an unclosed quote, or glued to the next name) cannot take the
  // name of the next secret with it. The quote that mysql's -p leaves open ends its value at the
  // next whitespace, as one after a name does, so the words behind that value stay.
  const besideNames: ReadonlyArray<readonly [string, string, string]> = [
    ["mysql's -p with an unclosed quote, before a quoted token", "mysql -p'Hunter 3pw fails, so I set token='Hunter 2pw'", `mysql -p${REDACTED} 3pw fails, so I set token=${REDACTED}`],
    ["curl's -u with an unclosed quote, before a quoted secret", "I typed curl -u 'admin:Hunter 3pw then secret=\"Hunter2pw\" by mistake", `I typed curl -u 'admin:${REDACTED}`],
    ["a netrc password glued to the name of an API key", "login bob password Hunter3pw,api_key: abcdef12345", `login bob password ${REDACTED} ${REDACTED}`],
    ["curl's -u with an unclosed quote, before a quoted --token flag", "curl -u 'admin:Hunter 3pw and --token 'Hunter 2pw'", `curl -u 'admin:${REDACTED}`],
  ];

  for (const [name, input, want] of besideNames) {
    test(`hides the secret a name gives away after ${name}`, () => {
      assert.equal(redact(input), want);
    });
  }

  test("redacts every part of a private key block and a vendor token that the backstops would miss", () => {
    const block = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${pgpBody}\nshort/Tail+9\n-----END PGP PRIVATE KEY BLOCK-----`;
    assert.equal(redact(`${block}`), REDACTED);
    const pat = "github_pat_11ABCDEFG0aBcDeFgHiJkLmN_aB3dE5gH7jK9mN1pQ3sT5vW7y";
    assert.equal(redact(pat), REDACTED);
  });

  test("the long-run backstop holds across an underscore", () => {
    assert.equal(redact(`pad_${mixed40}`), `pad_${REDACTED}`);
    assert.equal(redact(`${mixed40}_pad`), `${REDACTED}_pad`);
  });

  test("runs in linear time on long hostile input", () => {
    const inputs = [
      "-----BEGIN PRIVATE KEY-----".repeat(5000),
      "password ".repeat(20000),
      `${"a".repeat(100000)}_`,
      "https://".repeat(20000),
      `${"aB".repeat(50000)}!`,
      " ".repeat(100000) + "token",
      "Authorization: ".repeat(10000),
      "a.".repeat(50000),
      "a-".repeat(50000),
      "a_".repeat(50000),
      "a/".repeat(50000),
      "password=".repeat(20000),
      "http://:".repeat(20000),
      `a://:${"b".repeat(100000)}`,
      `-----BEGIN ${"A".repeat(100000)}`,
      `"${"a".repeat(100000)}`,
      'password="'.repeat(20000),
      "x=".repeat(50000),
      "a=b&".repeat(30000),
      'a["'.repeat(30000),
      "--a ".repeat(30000),
      "--password ".repeat(20000),
      `--${"a".repeat(100000)} `,
      "eyJ".repeat(30000),
      "eyJa.".repeat(20000),
      `eyJ${"a".repeat(100000)}.${"b".repeat(100000)}`,
      `Authorization: Bearer "${"a".repeat(100000)}`,
      `key${" ".repeat(100000)}=`,
      "Authorization: Bearer ,".repeat(10000),
      "-eyJ".repeat(50000),
      "eyJ-".repeat(50000),
      "-eyJa".repeat(40000),
      `eyJa.${"-eyJ".repeat(50000)}`,
      '--a "'.repeat(30000),
      "--password '".repeat(20000),
      '\\"password\\": \\"'.repeat(10000),
      "token: '".repeat(30000),
      `token: '${"a".repeat(100000)}`,
      "key=".repeat(50000),
      "a\\".repeat(50000),
      `Authorization: \\"${"a".repeat(100000)}`,
      "Authorization: \\".repeat(13000),
      `Authorization: Basic ${"a\\/".repeat(66000)}`,
      "key:'a'b ".repeat(22300),
      'key:"a"b '.repeat(22300),
      `token: '${"a ".repeat(100000)}'b`,
      "--key 'a'b ".repeat(18200),
      '--key "a"b '.repeat(18200),
      `--token "${"a ".repeat(100000)}"b`,
      "\\n".repeat(100000),
      "\\\\t".repeat(66700),
      "\\r\\nAuthorization: Bearer q8Zt".repeat(6700),
      "Authorization: Bearer abc\\npassword: x".repeat(5300),
      "password: a\\napi_key: b\\n".repeat(8400),
      "--password a\\t--api-key b\\t".repeat(7500),
      "-u ".repeat(50000),
      "--user=".repeat(30000),
      "-u a:b ".repeat(30000),
      "-u 'a".repeat(40000),
      `-u ${"x_".repeat(100000)}`,
      // A -u or -U after a mark that is no word character, whose user ran on through the marks
      // and the flags behind it, made every flag rescan the rest of its token; in a curl command
      // and out of one.
      "(-u".repeat(30000),
      `curl ${"(-u".repeat(30000)}`,
      ...[..."!#$%&()*+,./;<>?@[\\]^`{|}~"].flatMap((mark) => [`${mark}-u`.repeat(30000), `curl ${`${mark}-U`.repeat(30000)}`, `${mark}-U`.repeat(30000), `curl ${`${mark}-u`.repeat(30000)}`]),
      "(-u(".repeat(25000),
      "-ua(".repeat(25000),
      `curl ${"(-uaa".repeat(28000)}`,
      "curl ".repeat(40000),
      "curl -u ".repeat(25000),
      "curl -u a:b ".repeat(16000),
      "curl -u a:b; ".repeat(15000),
      `curl${" -u".repeat(60000)}`,
      `curl${" -ua".repeat(50000)}`,
      `curl -u${" ".repeat(100000)}a`,
      `curl -u ${"x_".repeat(100000)}`,
      `curl -u '${"a ".repeat(100000)}`,
      "curl -u 'a".repeat(20000),
      `curl ${"--user=".repeat(28000)}`,
      "--proxy-user ".repeat(15000),
      "--proxy-user 'a".repeat(13000),
      `--proxy-user ${"x_".repeat(100000)}`,
      `curl ${"'-u".repeat(60000)}`,
      `curl ${'-u"'.repeat(60000)}`,
      `curl ${"-u'a".repeat(45000)}`,
      '"--proxy-user '.repeat(14000),
      "--proxy-user=".repeat(30000),
      `curl ${"--proxy-user=".repeat(30000)}`,
      `curl ${"\`-u".repeat(60000)}`,
      "`--proxy-user ".repeat(14000),
      `\`--proxy-user ${"x\`".repeat(100000)}`,
      "curl|".repeat(40000),
      `curl ${"\\\n".repeat(90000)}`,
      `curl ${"-u \\\n".repeat(40000)}`,
      `curl ${"\\\r\n-u a".repeat(30000)}`,
      `curl ${"\\\r".repeat(90000)}`,
      `curl ${"'".repeat(100000)}`,
      `curl ${'"'.repeat(100000)}`,
      `curl '${";".repeat(100000)}`,
      `curl "${" && ".repeat(40000)}`,
      `curl ${"'a; ".repeat(40000)}`,
      `curl ${"'\"".repeat(60000)}`,
      "curl 'a;' ".repeat(18000),
      `curl '${" -u".repeat(60000)}`,
      `curl "${"-u 'a:b' ".repeat(18000)}`,
      `curl '${"\n".repeat(100000)}`,
      // Escaped quotes and runs of backslashes in a curl command: the backslashes before a quote
      // are counted back from it, so a run must be read once and not once for each quote.
      `curl ${'\\"'.repeat(60000)}`,
      `curl "${'\\"'.repeat(60000)}`,
      `curl ${"\\'".repeat(60000)}`,
      `curl ${"\\\\".repeat(60000)}`,
      `curl ${'"\\'.repeat(60000)}`,
      `curl ${"\\".repeat(150000)}"`,
      `curl "${"\\".repeat(150000)}`,
      `curl ${`${"\\".repeat(300)}"`.repeat(500)}`,
      `curl ${'\\\\"'.repeat(50000)}`,
      `curl "${"\\;".repeat(60000)}`,
      `curl ${"\\|".repeat(60000)}`,
      `curl "${"\\&&".repeat(45000)}`,
      `curl ${'-u "a:b\\" '.repeat(15000)}`,
      "/curl ".repeat(30000),
      "mysql ".repeat(40000),
      "mysql -pX ".repeat(25000),
      ' -p"'.repeat(60000),
      `mysql -p'${"a b ".repeat(60000)}`,
      "mysql_".repeat(40000),
      `${"password x ".repeat(18000)}login`,
      "password x\n".repeat(18000),
      "login password ".repeat(13000),
      "\n".repeat(200000),
      // In multiline mode a line also starts behind a carriage return and behind U+2028 and
      // U+2029, which the netrc candidate's class crossed, so every such line reread the text.
      "\r".repeat(100000),
      "\u2028".repeat(100000),
      "\u2029".repeat(100000),
      "a\r".repeat(60000),
      "password x\r".repeat(18000),
      `login ${"password \r".repeat(20000)}`,
      "<password>".repeat(30000),
      "<a ".repeat(60000),
      "<password>x</passwor".repeat(10000),
      "<password>x</password>".repeat(8000),
      `<password>${"a ".repeat(100000)}`,
      "auth=('".repeat(30000),
      "auth=('a',".repeat(20000),
      "BasicAuth(".repeat(20000),
      `${"x_".repeat(100000)}BasicAuth(`,
      "auth=(a, 'x".repeat(20000),
      "Cookie: ".repeat(25000),
      "Cookie: a=b; ".repeat(15000),
      "Set-Cookie: ".repeat(16000),
      "Set-Cookie: a;".repeat(14000),
      "cookie:a=".repeat(22000),
      // A Set-Cookie name that ran on through the next header's name, and through each character
      // a name could hold, made every header rescan the rest of the text.
      "Set-Cookie:".repeat(16000),
      ...[..."!#$%&()*+,-./:<>?@[]^_`{|}~a0"].map((mark) => `Set-Cookie:${mark}`.repeat(16000)),
      "xSet-Cookie:".repeat(16000),
      "set-cookie:a,".repeat(15000),
      ",set-cookie:aa".repeat(14000),
    ];
    for (const input of inputs) {
      const start = performance.now();
      redact(input);
      const took = performance.now() - start;
      assert.ok(took < 1000, `${input.slice(0, 24)}... took ${took} ms`);
    }
  });
});
