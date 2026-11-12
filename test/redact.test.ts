import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { redact, REDACTED, SCANS } from "../src/redact.ts";

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

  test("reads a flag's name with its hyphens on, where pass and pwd count as they do at a name's start", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["mysql --pass hunter2 db", `mysql --pass ${REDACTED} db`],
      ["mysql --pwd hunter2 db", `mysql --pwd ${REDACTED} db`],
      ["mysql --db-pass hunter2 db", `mysql --db-pass ${REDACTED} db`],
      ["mysql --pass-file hunter2 db", `mysql --pass-file ${REDACTED} db`],
    ];
    for (const [input, want] of cases) assert.equal(redact(input), want);
    for (const spared of ["ship --compass north", "run --bypass yes", "run --passes 3"]) assert.equal(redact(spared), spared);
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

  test("a digit or an underscore behind a quote is a word character too, so that quote closes no value", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['the password: "it is 5"9 wide" in the dialog', `the password: ${REDACTED} is 5"9 wide" in the dialog`],
      ['the password: "see row"_2 of the table" now', `the password: ${REDACTED} row"_2 of the table" now`],
      ["masterkey: 'it is 5'9 wide' in the dialog", `masterkey: ${REDACTED} is 5'9 wide' in the dialog`],
      ["masterkey: 'see row'_2 of the table' now", `masterkey: ${REDACTED} row'_2 of the table' now`],
      ['the --token "it is 5"9 wide" in the dialog', `the --token ${REDACTED} is 5"9 wide" in the dialog`],
      ['the --token "see row"_2 of the table" now', `the --token ${REDACTED} row"_2 of the table" now`],
      ["the --token 'it is 5'9 wide' in the dialog", `the --token ${REDACTED} is 5'9 wide' in the dialog`],
      ["the --token 'see row'_2 of the table' now", `the --token ${REDACTED} row'_2 of the table' now`],
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
    // A backslash before the escape does not keep it: the n of \\n still reads as a space, and the
    // first backslash goes with the value before it.
    ["the API key after a password and a line break escaped twice", `"password: hunter2\\\\napi_key: ${hexKey}"`, `"password: ${REDACTED} api_key: ${REDACTED}"`],
    ["the password after a header and a tab escaped twice", '"Authorization: Bearer abc\\\\tpassword: hunter2"', `"${REDACTED} password: ${REDACTED}"`],
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

  test("leaves a backslash before b, f and v as it is: only n, r and t are escaped breaks", () => {
    for (const text of ["C:\\bin\\foo\\var", "a\\bc", "a\\fc", "a\\vc", "see C:\\build\\fonts\\vendor for the files"]) {
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
    ["a netrc password that takes the text's only escaped quotes with it, after which the text is read once", 'curl -s https://h login bob password a\\"\\";b; date -u +%H:%M:%S', `curl -s https://h login bob password ${REDACTED} date -u +%H:%M:%S`],
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

  // A quote behind a run of backslashes in a double-quoted curl argument, for runs of one to eight.
  // Behind an odd run the quote is escaped: the argument goes on over the semicolon, and the -u
  // behind it is read. Behind an even run the quote closes the argument, and the semicolon behind
  // it ends the command, so the next command's -u stays.
  const backslashRuns: ReadonlyArray<readonly [number, "escaped" | "closes"]> = [
    [1, "escaped"],
    [2, "closes"],
    [3, "escaped"],
    [4, "closes"],
    [5, "escaped"],
    [6, "closes"],
    [7, "escaped"],
    [8, "closes"],
  ];

  for (const [run, quote] of backslashRuns) {
    const backslashes = "\\".repeat(run);
    test(`reads a quote behind ${run} backslashes in a double-quoted curl argument: it ${quote === "escaped" ? "is text" : "closes the argument"}`, () => {
      if (quote === "escaped") {
        assert.equal(redact(`curl -d "a${backslashes}"b; c" -u admin:Hunter2pw https://h`), `curl -d "a${backslashes}"b; c" -u admin:${REDACTED} https://h`);
      } else {
        const text = `curl -d "a${backslashes}" https://h; date -u +%H:%M:%S`;
        assert.equal(redact(text), text);
      }
    });
  }

  // The same rule for every run of 1 to 64 backslashes, each expectation computed from the run's
  // parity. A run longer than 64 is not pinned.
  test("reads a quote behind a run of 1 to 64 backslashes in a double-quoted curl argument by the run's parity, 64 being the longest run pinned", () => {
    for (let run = 1; run <= 64; run += 1) {
      const backslashes = "\\".repeat(run);
      if (run % 2 === 1) {
        assert.equal(redact(`curl -d "a${backslashes}"b; c" -u admin:Hunter2pw https://h`), `curl -d "a${backslashes}"b; c" -u admin:${REDACTED} https://h`, `a run of ${run}: the quote is text`);
      } else {
        const text = `curl -d "a${backslashes}" https://h; date -u +%H:%M:%S`;
        assert.equal(redact(text), text, `a run of ${run}: the quote closes the argument`);
      }
    }
  });

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

  // What each pattern reads, a piece at a time: a row for a branch, a flag, a lookaround, an anchor,
  // a bound or a class member that no other test tells from its neighbour. A row with no third text
  // stays as it is. Some rows pin a shape that is not read, and so show what it holds.
  const patternRows: ReadonlyArray<readonly [string, string, string?]> = [
    // URL passwords.
    ["a URL whose scheme is one letter", "x://bob:Hunter2pw@host", `x://bob:${REDACTED}@host`],
    ["URL schemes that hold a digit, a plus, a dot and a hyphen", "h2c://bob:Hunter2pw@a git+ssh://bob:Hunter3pw@b coap.tcp://bob:Hunter4pw@c ms-sql://bob:Hunter5pw@d", `h2c://bob:${REDACTED}@a git+ssh://bob:${REDACTED}@b coap.tcp://bob:${REDACTED}@c ms-sql://bob:${REDACTED}@d`],
    ["a URL whose scheme is in capitals", "HTTPS://bob:Hunter2pw@host", `HTTPS://bob:${REDACTED}@host`],
    ["a name:word pair after a URL and a space", "see https://example.com and the list ops:announce@example.com"],
    ["a URL password that holds a colon: it starts at the first colon", "https://bob:Hunter2:pw@host", `https://bob:${REDACTED}@host`],
    ["a colon and an at sign in a URL's path", "https://example.com/a:b@c"],
    ["a URL with an at sign before its colon", "https://a@b:c@d"],
    ["a URL host before a colon, a space and a mail address", "note https://example.com: ask bob@example.com"],
    ["a URL password before a second at sign: it ends at the first", "https://bob:Hunter2pw@example.com?to=alice@example.com", `https://bob:${REDACTED}@example.com?to=alice@example.com`],
    ["a URL's port", "http://localhost:8888/lab"],
    ["a URL with an empty password", "https://bob:@host"],
    ["a URL password of one character", "https://bob:x@host", `https://bob:${REDACTED}@host`],
    ["a port before a path that holds an at sign", "https://example.com:8443/pkg@1.2.3"],
    ["URLs right behind a digit, a plus, a dot and a hyphen (a known gap)", "7https://bob:Hunter2pw@a +https://bob:Hunter3pw@b .https://bob:Hunter4pw@c -https://bob:Hunter5pw@d"],
    // The Authorization header.
    ["a header name glued behind an underscore, which is read as a name, so only the word after it goes (a known gap)", "HTTP_AUTHORIZATION: Bearer q8Zt1rLm9XaQ", `HTTP_AUTHORIZATION: ${REDACTED} q8Zt1rLm9XaQ`],
    ["an Authorization header in a single-quoted dict, and the entry after it", "{'Authorization': 'Bearer q8Zt1rLm9XaQ', 'Accept': 'text/html'}", `{'${REDACTED}', 'Accept': 'text/html'}`],
    ["an Authorization header with a space before its colon", "Authorization : Bearer q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header with a tab before its colon", "Authorization\t: Bearer q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header with a tab after its colon", "Authorization:\tBearer q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header with no space after its colon", "Authorization:Bearer q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header whose credential is single-quoted", "Authorization: 'Bearer q8Zt1rLm9XaQ'", `${REDACTED}'`],
    ["an Authorization header with a tab after its scheme", "Authorization: Bearer\tq8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header whose token is single-quoted", "Authorization: Bearer 'q8Zt1rLm9XaQ'", `${REDACTED}'`],
    ["an Authorization header in JSON, and the entry after it", '{"Authorization": "Bearer q8Zt1rLm9XaQ", "Accept": "text/html"}', `{"${REDACTED}", "Accept": "text/html"}`],
    ["an Authorization header before a semicolon", "Authorization: Bearer q8Zt1rLm9XaQ; Accept: text/html", `${REDACTED}; Accept: text/html`],
    ["an authorization header in lower case", "authorization: Bearer q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header with a scheme of one letter", "Authorization: B q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header with no scheme", "Authorization: q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header with a credential of one character", "Authorization: x", REDACTED],
    ["an Authorization header with nothing after its colon", "Authorization:\nBearer q8Zt1rLm9XaQ"],
    ["an Authorization header whose credential opens with a quote and a space", 'Authorization: " Bearer q8Zt1rLm9XaQ"', `Authorization: ${REDACTED}`],
    ["an Authorization header whose scheme is glued to a quoted token: only the scheme goes", 'Authorization: Bearer"q8Zt1rLm9XaQ"', `${REDACTED}"q8Zt1rLm9XaQ"`],
    ["an Authorization header with two quotes before its colon", '{"Authorization"": "Bearer q8Zt1rLm9XaQ"}', `{"Authorization"": ${REDACTED}}`],
    ["an Authorization header with two quotes before its scheme", '{"Authorization": ""Bearer q8Zt1rLm9XaQ"}', `{"${REDACTED} q8Zt1rLm9XaQ"}`],
    ["an Authorization header with two quotes before its token", 'Authorization: Bearer ""q8Zt1rLm9XaQ"', `${REDACTED} ""q8Zt1rLm9XaQ"`],
    ["an Authorization header in JSON escaped twice, where two backslashes stand before each quote (a known gap)", '{\\\\"Authorization\\\\": \\\\"Bearer q8Zt1rLm9XaQ\\\\"}'],
    ["an Authorization header whose scheme has two backslashes before its quote", '{\\"Authorization\\": \\\\"Bearer q8Zt1rLm9XaQ\\"}', `{\\"${REDACTED} q8Zt1rLm9XaQ\\"}`],
    ["an Authorization header whose token has two backslashes before its quote", '{"Authorization": "Bearer \\\\"q8Zt1rLm9XaQ\\""}', `{"${REDACTED}"q8Zt1rLm9XaQ\\""}`],
    // JWTs.
    ["a JWT whose first two segments hold hyphens", "eyJhb-GciOi.eyJzd-WIiOi.dBjf-tJeZ4", REDACTED],
    ["two JWTs in one text", "a eyJhbGci.eyJzdWIi.sig1 b eyJhbGci.eyJzdWIi.sig2", `a ${REDACTED} b ${REDACTED}`],
    ["eyJ with nothing before its first dot", "eyJ.abc.def"],
    ["a JWT whose first segment is eyJ and one character", "eyJh.abc.def", REDACTED],
    ["a JWT shape with an empty second segment", "eyJhbGci..sig"],
    ["a JWT whose second segment is one character", "eyJhbGci.e.sig", REDACTED],
    ["an unsigned JWT, whose third segment is empty", "see eyJhbGci.eyJzdWIi. here", `see ${REDACTED} here`],
    ["a JWT glued behind a letter (a known gap)", "keyJhbGci.eyJzdWIi.sig"],
    ["a JWT glued behind an underscore (a known gap)", "x_eyJhbGci.eyJzdWIi.sig"],
    ["a JWT glued behind a hyphen (a known gap)", "x-eyJhbGci.eyJzdWIi.sig"],
    // Private key blocks.
    ["the text after a private key block's END line", "-----BEGIN RSA PRIVATE KEY-----\nMIIEvQ\n-----END RSA PRIVATE KEY-----\nafter", `${REDACTED}\nafter`],
    ["two private key blocks, and the text between them", "-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\nmid\n-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----", `${REDACTED}\nmid\n${REDACTED}`],
    ["the text after a PGP private key block's END line", "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nAAA\n-----END PGP PRIVATE KEY BLOCK-----\nafter", `${REDACTED}\nafter`],
    ["an empty private key block, and the text after it", "-----BEGIN PRIVATE KEY----------END PRIVATE KEY-----after", `${REDACTED}after`],
    ["a private key header that says BLOCK twice", "-----BEGIN PGP PRIVATE KEY BLOCK BLOCK-----\nlQOYBF1b"],
    ["a private key block whose END line says BLOCK twice, which ends no block: all behind the header goes", "-----BEGIN PGP PRIVATE KEY BLOCK-----\nAAA\n-----END PGP PRIVATE KEY BLOCK BLOCK-----\nafter", REDACTED],
    // Keys with a known prefix.
    ["a Stripe key of eight characters", "sk_live_aB3dE5gH", REDACTED],
    ["a Stripe key of seven characters", "sk_live_aB3dE5g"],
    ["a Stripe project key", "sk_proj_aB3dE5gH", REDACTED],
    ["a Stripe restricted key written with hyphens", "rk-live-aB3dE5gH", REDACTED],
    ["a Stripe key with a hyphen, then an underscore", "sk-live_aB3dE5gH", REDACTED],
    ["a Stripe key with an underscore, then a hyphen", "sk_live-aB3dE5gH", REDACTED],
    ["a Stripe key that holds an underscore", "sk_live_aB3d_5gH", REDACTED],
    ["a Stripe key that holds a hyphen", "sk_live_aB3d-5gH", REDACTED],
    ["a name that only holds sk_test_", "mask_test_fixtures"],
    ["two Stripe keys in one text", "sk_live_aB3dE5gH and rk_test_aB3dE5gH", `${REDACTED} and ${REDACTED}`],
    ["an sk- key of twenty characters", "sk-abcdefghij0123456789", REDACTED],
    ["an sk- key of nineteen characters", "sk-bcdefghij0123456789"],
    ["an sk- key in capitals", "sk-ABCDEFGHIJKLMNOPQRST", REDACTED],
    ["an sk- key in small letters", "sk-abcdefghijklmnopqrst", REDACTED],
    ["an sk- key in digits", "sk-01234567890123456789", REDACTED],
    ["an sk- key that holds an underscore", "sk-abcde_ghijklmnopqrst", REDACTED],
    ["an sk- key that holds a hyphen", "sk-abcde-ghijklmnopqrst", REDACTED],
    ["a hyphenated phrase with sk- inside a word", "risk-assessment-report-2026"],
    ["two sk- keys in one text", "sk-abcdefghij0123456789 and sk-abcdefghij0123456789", `${REDACTED} and ${REDACTED}`],
    ["github_pat_ with nothing behind it", "the github_pat_ prefix"],
    ["a fine-grained GitHub token of one character", "github_pat_x", REDACTED],
    ["a name that only ends in github_pat_ and a word", "old_github_pat_1"],
    ["two fine-grained GitHub tokens in one text", "github_pat_a github_pat_b", `${REDACTED} ${REDACTED}`],
    ["a GitHub OAuth token", "gho_abcdefghijklmnopqrstuvwxyz0123456789", REDACTED],
    ["a GitHub user token", "ghu_abcdefghijklmnopqrstuvwxyz0123456789", REDACTED],
    ["a GitHub server token", "ghs_abcdefghijklmnopqrstuvwxyz0123456789", REDACTED],
    ["a GitHub refresh token", "ghr_abcdefghijklmnopqrstuvwxyz0123456789", REDACTED],
    ["a GitHub token of 35 characters", "ghp_bcdefghijklmnopqrstuvwxyz0123456789"],
    ["a word that only ends in ghp_ and 36 characters", "bughp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["two GitHub tokens in one text", "ghp_abcdefghijklmnopqrstuvwxyz0123456789 gho_abcdefghijklmnopqrstuvwxyz0123456789", `${REDACTED} ${REDACTED}`],
    ["a GitLab token of nineteen characters", "glpat-bcdefghij0123456789"],
    ["a GitLab token that holds an underscore", "glpat-abcde_ghij0123456789", REDACTED],
    ["a GitLab token that holds a hyphen", "glpat-abcde-ghij0123456789", REDACTED],
    ["a word that only ends in glpat- and twenty characters", "xglpat-abcdefghij0123456789"],
    ["two GitLab tokens in one text", "glpat-abcdefghij0123456789 glpat-abcdefghij0123456789", `${REDACTED} ${REDACTED}`],
    ["a Hugging Face token of twenty characters", "hf_abcdefghij0123456789", REDACTED],
    ["a Hugging Face token of nineteen characters", "hf_bcdefghij0123456789"],
    ["a word that only ends in hf_ and twenty characters", "chf_abcdefghij0123456789"],
    ["two npm tokens in one text", "npm_abcdefghij0123456789 npm_abcdefghij0123456789", `${REDACTED} ${REDACTED}`],
    ["a Slack token of each kind", "xoxa-2-abc xoxb-2-abc xoxp-2-abc xoxr-2-abc xoxs-2-abc", `${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`],
    ["a Slack token in capitals", "xoxb-ABC", REDACTED],
    ["a Slack token in small letters", "xoxb-abc", REDACTED],
    ["a Slack token that holds hyphens", "xoxb-1-2", REDACTED],
    ["xoxb- with nothing behind it", "the xoxb- prefix"],
    ["a Slack token of one character", "xoxb-1", REDACTED],
    ["a word that only ends in xoxb- and a word", "fooxoxb-1"],
    ["xapp- with nothing behind it", "the xapp- prefix"],
    ["a Slack app token of one character", "xapp-1", REDACTED],
    ["a word that only ends in xapp- and a word", "wxapp-config"],
    ["two Slack app tokens in one text", "xapp-1 xapp-2", `${REDACTED} ${REDACTED}`],
    ["a Google API key that holds an underscore and a hyphen", "AIzaabcde_ghij-123456789abcdefghij01234", REDACTED],
    ["a Google API key shape of 34 characters", "AIzaabcde_ghij-123456789abcdefghij0123"],
    ["a Google API key shape of 36 characters: the 36th stays", "AIzaabcde_ghij-123456789abcdefghij012345", `${REDACTED}5`],
    ["a word that only ends in AIza and 35 characters", "xAIzaabcde_ghij-123456789abcdefghij01234"],
    ["two Google API keys in one text", "AIzaabcde_ghij-123456789abcdefghij01234 AIzaabcde_ghij-123456789abcdefghij01234", `${REDACTED} ${REDACTED}`],
    ["an AWS key id that holds digits", "AKIA0123456789ABCDEF", REDACTED],
    ["an AWS key id shape of 15 characters", "AKIAABCDEFGHIJKLMNO"],
    ["an AWS key id shape of 17 characters", "AKIA0ABCDEFGHIJKLMNOQ"],
    ["a word that only ends in an AWS key id", "XAKIA0ABCDEFGHIJKLMNO"],
    ["two AWS key ids in one text", "AKIA0ABCDEFGHIJKLMNO ASIAABCDEFGHIJKLMNOP", `${REDACTED} ${REDACTED}`],
    // Names and their values.
    ["a name with a tab before its separator", "password\t= hunter2", `password\t= ${REDACTED}`],
    ["a name with a tab after its separator", "password =\thunter2", `password =\t${REDACTED}`],
    ["a name in JSON escaped twice, where two backslashes stand before each quote (a known gap)", '{\\\\"password\\\\": \\\\"hunter2\\\\"}'],
    ["a double-quoted value that its line ends", 'password: "abc\ndef" ghi', `password: ${REDACTED}\ndef" ghi`],
    ["a single-quoted value that its line ends", "password: 'abc\ndef' ghi", `password: ${REDACTED}\ndef' ghi`],
    ["a bare value inside a single-quoted string", "echo 'password=hunter2' | cat", `echo 'password=${REDACTED}' | cat`],
    ["a bare value before a comma", "{user: bob, password: hunter2, port: 22}", `{user: bob, password: ${REDACTED}, port: 22}`],
    ["a bare value before a semicolon", "password=hunter2;host=db", `password=${REDACTED};host=db`],
    ["a value of one character", "password=x", `password=${REDACTED}`],
    ["a name whose value is on the next line (a known gap)", "password:\n  hunter2"],
    ["an empty double-quoted value, and the entry after it", '{"password": "", "user": "bob"}', `{"password": ${REDACTED}, "user": "bob"}`],
    ["an empty single-quoted value, and the entry after it", "{'password': '', 'user': 'bob'}", `{'password': ${REDACTED}, 'user': 'bob'}`],
    ["escaped single quotes around a value with a space", "{\\'password\\': \\'hunter 2\\'}", `{\\'password\\': ${REDACTED}}`],
    ["an escaped quote that never closes", 'password: \\"hunter2', `password: ${REDACTED}`],
    ["a lone quote before a space, which is the whole value", 'password: " and more', `password: ${REDACTED} and more`],
    ["a double-quoted value with two backslashes before its quotes", 'password: \\\\"hunter 2\\\\"', `password: ${REDACTED}"hunter 2\\\\"`],
    ["a single-quoted value with two backslashes before its quotes", "password: \\\\'hunter 2\\\\'", `password: ${REDACTED}'hunter 2\\\\'`],
    ["an unclosed quote with two backslashes before it", 'password: \\\\"hunter2', `password: ${REDACTED}"hunter2`],
    // Flags and their values.
    ["a double hyphen inside a word", "foo--password bar"],
    ["a flag name behind three hyphens inside a word", "foo---password bar"],
    ["a flag with a tab before its value", "--password\thunter2", `--password\t${REDACTED}`],
    ["a flag with an equals sign, which the name pass takes", "mysql --password=hunter2 -u root", `mysql --password=${REDACTED} -u root`],
    ["a flag whose value is on the next line (a known gap)", "--password \nhunter2"],
    ["a flag before another flag", "mysql --password --verbose"],
    ["a double-quoted flag value that its line ends", '--password "abc\ndef" ghi', `--password ${REDACTED}\ndef" ghi`],
    ["a single-quoted flag value that its line ends", "--password 'abc\ndef' ghi", `--password ${REDACTED}\ndef' ghi`],
    ["a flag's bare value inside a single-quoted string", "sh -c 'mysql --password hunter2' && date", `sh -c 'mysql --password ${REDACTED}' && date`],
    ["a flag's bare value before a comma", "args: [--password hunter2, --port 22]", `args: [--password ${REDACTED}, --port 22]`],
    ["a flag's bare value before a semicolon", "mysql --password hunter2; date", `mysql --password ${REDACTED}; date`],
    ["a flag's double-quoted value with a space", 'mysql --password "hunter 2" -u root', `mysql --password ${REDACTED} -u root`],
    ["a flag's empty double-quoted value", '--password ""; date', `--password ${REDACTED}; date`],
    ["a flag's empty single-quoted value", "--password ''; date", `--password ${REDACTED}; date`],
    ["a flag's value in escaped single quotes", "--password \\'hunter 2\\' -u root", `--password ${REDACTED} -u root`],
    ["a flag's escaped quote that never closes", '--password \\"hunter2', `--password ${REDACTED}`],
    ["a flag's lone quote before a space", '--password " and more', `--password ${REDACTED} and more`],
    ["a flag's lone escaped quote before a space", '--password \\" and more', `--password ${REDACTED} and more`],
    ["a flag's unclosed double-quoted value that holds a comma", '--password "hunter,2 and more', `--password ${REDACTED} and more`],
    ["a flag's unclosed single-quoted value that holds a comma", "--password 'hunter,2 and more", `--password ${REDACTED} and more`],
    ["a flag's value of one character", "--password x", `--password ${REDACTED}`],
    ["a flag's double-quoted value with two backslashes before its quotes", '--password \\\\"hunter 2\\\\"', `--password ${REDACTED}"hunter 2\\\\"`],
    ["a flag's single-quoted value with two backslashes before its quotes", "--password \\\\'hunter 2\\\\'", `--password ${REDACTED}'hunter 2\\\\'`],
    ["a flag's unclosed quote with two backslashes before it", '--password \\\\"hunter2', `--password ${REDACTED}"hunter2`],
    // Secret names.
    ["the name pass", "pass=hunter2", `pass=${REDACTED}`],
    ["the name pwd", "pwd=hunter2", `pwd=${REDACTED}`],
    ["the name passwd", "passwd=hunter2", `passwd=${REDACTED}`],
    ["a name that ends in _pass", "db_pass=hunter2", `db_pass=${REDACTED}`],
    ["a name that ends in -pass", "db-pass: hunter2", `db-pass: ${REDACTED}`],
    ["a name that ends in _PWD", "MYSQL_PWD=hunter2", `MYSQL_PWD=${REDACTED}`],
    ["a name that starts with pass_", "pass_file=hunter2", `pass_file=${REDACTED}`],
    ["a name that starts with pass-", "pass-file: hunter2", `pass-file: ${REDACTED}`],
    ["a line of names that only hold pass or pwd inside a word", "compass=north bypass=1 passed=true passenger: 3 pwdump=1 is_passive=true"],
    ["an API key name that ends in another word, with an underscore", "api_key_id=hunter2", `api_key_id=${REDACTED}`],
    ["an API key name that ends in another word, with a hyphen", "api-key-id: hunter2", `api-key-id: ${REDACTED}`],
    ["an API key name that ends in another word, with no separator", "apiKeyId: hunter2", `apiKeyId: ${REDACTED}`],
    ["a name with two underscores between api and key", "api__key_id=hunter2"],
    ["an access key name that ends in another word, with an underscore", "access_key_id=hunter2", `access_key_id=${REDACTED}`],
    ["an access key name that ends in another word, with a hyphen", "access-key-id: hunter2", `access-key-id: ${REDACTED}`],
    ["an access key name that ends in another word, with no separator", "accessKeyId: hunter2", `accessKeyId: ${REDACTED}`],
    ["a name with two underscores between access and key", "access__key_id=hunter2"],
    ["a private key name that ends in another word, with an underscore", "private_key_id=hunter2", `private_key_id=${REDACTED}`],
    ["a private key name that ends in another word, with a hyphen", "private-key-id: hunter2", `private-key-id: ${REDACTED}`],
    ["a private key name that ends in another word, with no separator", "privateKeyId: hunter2", `privateKeyId: ${REDACTED}`],
    ["a name with two underscores between private and key", "private__key_id=hunter2"],
    // Long runs.
    ["two long mixed-case runs in one text", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k and aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k", `${REDACTED} and ${REDACTED}`],
    ["a mixed-case run of 39 characters", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7"],
    ["a long base64 run that holds a plus and no slash", "wJalrXUtnFEMI+K7MDENG+bPxRfiCYEXAMPLEKEY1", REDACTED],
    ["two long base64 runs in one text", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1 and wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1", `${REDACTED} and ${REDACTED}`],
    ["a base64 run of 39 characters", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKE"],
    ["a long mixed-case path with no digit", "src/Components/Header/NavigationBar/DropdownMenuItem/IndexPage"],
    // curl's user flags.
    ["a --proxy-user that opens a single-quoted string", "wget '--proxy-user bob:Hunter2pw' https://h", `wget '--proxy-user bob:${REDACTED}' https://h`],
    ["a --proxy-user with a tab before its value", "wget --proxy-user\tbob:Hunter2pw https://h", `wget --proxy-user\tbob:${REDACTED} https://h`],
    ["text glued behind --proxy-user", "wget --proxy-userbob:Hunter2pw https://h"],
    ["curl's -u with a tab before its value", "curl -u\tadmin:Hunter2pw https://h", `curl -u\tadmin:${REDACTED} https://h`],
    ["curl's --user with a tab before its value", "curl --user\tadmin:Hunter2pw https://h", `curl --user\tadmin:${REDACTED} https://h`],
    ["curl's -u behind a backslash, two carriage returns and a line feed, which end the command (a known gap)", "curl https://h \\\r\r\n-u admin:Hunter2pw"],
    ["a flag that says proxy- twice, inside a curl command", "curl --proxy-proxy-user bob:Hunter2pw https://h"],
    ["a quoted -u value whose user holds a space (a known gap)", "curl -u 'ad min:Hunter2pw' https://h"],
    ["a quoted -u value with an empty user", "curl -u ':Hunter2pw' https://h", `curl -u ':${REDACTED}' https://h`],
    ["a quoted -u value with a password of one character", "curl -u 'admin:x' https://h", `curl -u 'admin:${REDACTED}' https://h`],
    ["curl's -u with an empty user", "curl -u :Hunter2pw https://h", `curl -u :${REDACTED} https://h`],
    ["curl's -u with a password of one character", "curl -u admin:x https://h", `curl -u admin:${REDACTED} https://h`],
    ["a single-quoted -u value whose user holds a double quote (a known gap)", `curl -u 'a"b:Hunter2pw' https://h`],
    ["a double-quoted -u value whose user holds an apostrophe (a known gap)", `curl -u "a'b:Hunter2pw" https://h`],
    ["curl's -u whose user holds a double quote (a known gap)", 'curl -u a"b:Hunter2pw https://h'],
    ["curl's -u whose user holds an apostrophe (a known gap)", "curl -u a'b:Hunter2pw https://h"],
    ["curl's -u whose user holds a backtick (a known gap)", "curl -u a`b:Hunter2pw https://h"],
    // mysql's -p.
    ["mysql's -p inside a command substitution", "out=$(mysql -pHunter2pw db)", `out=$(mysql -p${REDACTED} db)`],
    ["mysql's -p inside a double-quoted string", 'sh -c "mysql -pHunter2pw db"', `sh -c "mysql -p${REDACTED} db"`],
    ["mysql's -p inside a single-quoted string", "sh -c 'mysql -pHunter2pw db'", `sh -c 'mysql -p${REDACTED} db'`],
    ["mysql's -p inside inline code", "run `mysql -pHunter2pw db` now", `run \`mysql -p${REDACTED} db\` now`],
    ["mysql's -p right after a semicolon", "cd /tmp;mysql -pHunter2pw db", `cd /tmp;mysql -p${REDACTED} db`],
    ["mysql's -p right after &&", "cd /tmp&&mysql -pHunter2pw db", `cd /tmp&&mysql -p${REDACTED} db`],
    ["mysql's -p after a tab", "mysql\t-pHunter2pw db", `mysql\t-p${REDACTED} db`],
    ["mysql's double-quoted -p before another double-quoted argument", 'mysql -p"Hunter 2pw" -e "select 1"', `mysql -p${REDACTED} -e "select 1"`],
    ["mysql's single-quoted -p before another single-quoted argument", "mysql -p'Hunter 2pw' -e 'select 1'", `mysql -p${REDACTED} -e 'select 1'`],
    ["mysql's double-quoted -p that its line ends", 'mysql -p"Hunter\n2pw" db', `mysql -p${REDACTED}\n2pw" db`],
    ["mysql's single-quoted -p that its line ends", "mysql -p'Hunter\n2pw' db", `mysql -p${REDACTED}\n2pw' db`],
    ["mysql's -p before a pipe", "mysql -pHunter2pw|gzip", `mysql -p${REDACTED}|gzip`],
    ["mysql's -p before &&", "mysql -pHunter2pw&&date", `mysql -p${REDACTED}&&date`],
    ["mariadb's -p", "mariadb -pHunter2pw db", `mariadb -p${REDACTED} db`],
    ["mysql's empty double-quoted -p, glued to a word", 'mysql -p""root db', `mysql -p${REDACTED}root db`],
    ["mysql's empty single-quoted -p, glued to a word", "mysql -p''root db", `mysql -p${REDACTED}root db`],
    ["mysql's -p with a password of one character", "mysql -px db", `mysql -p${REDACTED} db`],
    // netrc lines.
    ["a line with password and a word that only ends in -login", "auto-login needs the password field"],
    ["a line with password and a word that only starts with machine-", "the machine-id file holds no password hash"],
    ["a word that only ends in -password on a netrc line", "login bob with the no-password option"],
    ["a netrc password after a tab", "login bob password\tHunter2pw", `login bob password\t${REDACTED}`],
    ["a quoted netrc password before another quoted word", 'machine x login bob password "Hunter 2pw" account "main"', `machine x login bob password ${REDACTED} account "main"`],
    ["a netrc line with two spaces before an equals sign, which the name pass takes", "machine x login bob password  = Hunter2pw", `machine x login bob password  = ${REDACTED}`],
    ["a lone quote behind a netrc password word", 'login bob password "'],
    ["two netrc entries on one line", "machine a login bob password Hunter2pw machine b login amy password Hunter3pw", `machine a login bob password ${REDACTED} machine b login amy password ${REDACTED}`],
    ["two netrc lines", "machine a login bob password Hunter2pw\nmachine b login amy password Hunter3pw", `machine a login bob password ${REDACTED}\nmachine b login amy password ${REDACTED}`],
    ["a word that only starts with password on a netrc line", "machine login is passwordless now"],
    ["an empty quoted netrc password", 'login bob password "" x', `login bob password ${REDACTED} x`],
    ["a netrc password of one character", "login bob password x", `login bob password ${REDACTED}`],
    // XML elements.
    ["an XML element whose name starts with a capital", "<Password>Hunter2pw</Password>", `<Password>${REDACTED}</Password>`],
    ["an XML element whose name starts with an underscore", "<_secret>Hunter2pw</_secret>", `<_secret>${REDACTED}</_secret>`],
    ["an XML element whose name holds a dot", "<db.password>Hunter2pw</db.password>", `<db.password>${REDACTED}</db.password>`],
    ["an XML element whose name holds a hyphen", "<api-key>Hunter2pw</api-key>", `<api-key>${REDACTED}</api-key>`],
    ["an XML element whose text holds a >", '<password a="b">Hunter>2pw</password>', `<password a="b">${REDACTED}</password>`],
    ["an XML element with a space before its >", "<password >Hunter2pw</password>", `<password >${REDACTED}</password>`],
    ["an XML element whose opening tag holds a < (a known gap)", "<password a<b>Hunter2pw</password>"],
    ["an XML element whose text is one character", "<password>x</password>", `<password>${REDACTED}</password>`],
    // Python auth pairs.
    ["a pair behind a name that only ends in -auth", "pre-auth=('basic', 'digest')"],
    ["an auth pair in a double-quoted dict", '{"auth": ("bob", "Hunter2pw")}', `{"auth": ("bob", ${REDACTED})}`],
    ["an auth pair with a tab before its equals sign", "auth\t= ('bob', 'Hunter2pw')", `auth\t= ('bob', ${REDACTED})`],
    ["an auth pair with a tab after its equals sign", "auth =\t('bob', 'Hunter2pw')", `auth =\t('bob', ${REDACTED})`],
    ["an auth pair with a space after its parenthesis", "auth=( 'bob', 'Hunter2pw')", `auth=( 'bob', ${REDACTED})`],
    ["an auth pair with a tab after its parenthesis", "auth=(\t'bob', 'Hunter2pw')", `auth=(\t'bob', ${REDACTED})`],
    ["an auth pair whose user holds the other quote (a known gap)", `auth=('bo"b', 'Hunter2pw')`],
    ["an auth pair whose user string its line ends (a known gap)", "auth=('bob\n', 'Hunter2pw')"],
    ["an auth pair whose user is a dotted name", "auth=(cfg.user, 'Hunter2pw')", `auth=(cfg.user, ${REDACTED})`],
    ["an auth pair with a space before its comma", "auth=('bob' , 'Hunter2pw')", `auth=('bob' , ${REDACTED})`],
    ["an auth pair with a tab before its comma", "auth=('bob'\t, 'Hunter2pw')", `auth=('bob'\t, ${REDACTED})`],
    ["an auth pair with a tab after its comma", "auth=('bob',\t'Hunter2pw')", `auth=('bob',\t${REDACTED})`],
    ["an auth pair whose single-quoted password holds a double quote (a known gap)", `auth=('bob', 'Hun"ter2pw')`],
    ["an auth pair whose double-quoted password holds an apostrophe (a known gap)", `auth=("bob", "O'Brien1x")`],
    ["an auth pair whose password string its line ends (a known gap)", "auth=('bob', 'Hunter\n2pw')"],
    ["two auth pairs in one text", "auth=('bob', 'Hunter2pw'); auth=('amy', 'Hunter3pw')", `auth=('bob', ${REDACTED}); auth=('amy', ${REDACTED})`],
    ["an auth key with two quotes behind it", '{"auth"": ("bob", "Hunter2pw")}'],
    ["an auth pair with an empty user", "auth=('', 'Hunter2pw')", `auth=('', ${REDACTED})`],
    ["an auth pair with nothing before its comma", "auth=(, 'Hunter2pw')"],
    ["an auth pair whose user is a name of one letter", "auth=(u, 'Hunter2pw')", `auth=(u, ${REDACTED})`],
    ["an auth pair with a password of one character", "auth=('bob', 'x')", `auth=('bob', ${REDACTED})`],
    // Cookies.
    ["a Set-Cookie header with a space before its colon", "Set-Cookie : sid=Hunter2pw", `Set-Cookie : sid=${REDACTED}`],
    ["a Set-Cookie header with a tab before its colon", "Set-Cookie\t: sid=Hunter2pw", `Set-Cookie\t: sid=${REDACTED}`],
    ["a Set-Cookie header with a tab after its colon", "Set-Cookie:\tsid=Hunter2pw", `Set-Cookie:\tsid=${REDACTED}`],
    ["a Set-Cookie header with no space after its colon", "Set-Cookie:sid=Hunter2pw", `Set-Cookie:sid=${REDACTED}`],
    ["a Set-Cookie value that holds an equals sign: the name ends at the first", "Set-Cookie: a=b=c; Path=/", `Set-Cookie: a=${REDACTED}; Path=/`],
    ["a Set-Cookie header whose cookie stands behind an attribute (a known gap)", "Set-Cookie: Secure;sid=Hunter2pw"],
    ["a Set-Cookie name with a space before its equals sign (a known gap)", "Set-Cookie: sid =Hunter2pw"],
    ["an empty Set-Cookie value in compact JSON, and the key after it", '{"Set-Cookie":"","mode=debug":1}'],
    ["an empty Set-Cookie value in a compact single-quoted dict, and the key after it", "{'Set-Cookie':'','mode=debug':1}"],
    ["a Set-Cookie name that holds a backslash (a known gap)", "Set-Cookie: sid\\x=Hunter2pw"],
    ["a Set-Cookie value before a space", "Set-Cookie: sid=Hunter2pw and more text", `Set-Cookie: sid=${REDACTED} and more text`],
    ["two Set-Cookie headers", "Set-Cookie: a=Hunter2pw\nSet-Cookie: b=Hunter3pw", `Set-Cookie: a=${REDACTED}\nSet-Cookie: b=${REDACTED}`],
    ["a Set-Cookie header with an empty cookie name", "Set-Cookie: =Hunter2pw", `Set-Cookie: =${REDACTED}`],
    ["a Set-Cookie header with an empty value", "Set-Cookie: sid=; Path=/"],
    ["an empty Set-Cookie header glued before the next header", "Set-Cookie:X-Mode:debug=on"],
    ["a Set-Cookie value of one character", "Set-Cookie: sid=x", `Set-Cookie: sid=${REDACTED}`],
    ["a Set-Cookie key with two backslashes before its closing quote (a known gap)", '{\\\\"Set-Cookie\\\\": "sid=Hunter2pw"}'],
    ["a Set-Cookie key with two quotes behind it", '{"Set-Cookie"": "sid=Hunter2pw"}'],
    ["a Set-Cookie value with two backslashes before its quote", '{\\"Set-Cookie\\": \\\\"sid=Hunter2pw\\"}'],
    ["a Set-Cookie value with two quotes before it", '{"Set-Cookie": ""sid=Hunter2pw"}'],
    ["a name that only ends in cookie", "my_cookie: id=7"],
    ["a Cookie header in a single-quoted dict, and the entry after it", "{'Cookie': 'a=Hunter2pw', 'X-Mode': 'debug=on'}", `{'Cookie': 'a=${REDACTED}', 'X-Mode': 'debug=on'}`],
    ["a Cookie header with a space before its colon", "Cookie : a=Hunter2pw", `Cookie : a=${REDACTED}`],
    ["a Cookie header with a tab before its colon", "Cookie\t: a=Hunter2pw", `Cookie\t: a=${REDACTED}`],
    ["a Cookie header with a tab after its colon, before a quoted value", 'Cookie:\t"a=Hunter2pw"', `Cookie:\t"a=${REDACTED}"`],
    ["a Cookie header with no space after its colon", "Cookie:a=Hunter2pw", `Cookie:a=${REDACTED}`],
    ["a Cookie header whose value is single-quoted", "Cookie: 'a=Hunter2pw'", `Cookie: 'a=${REDACTED}'`],
    ["two Cookie headers", "Cookie: a=Hunter2pw\nCookie: b=Hunter3pw", `Cookie: a=${REDACTED}\nCookie: b=${REDACTED}`],
    ["a Cookie value before a space", "Cookie: a=Hunter2pw (sent twice)", `Cookie: a=${REDACTED} (sent twice)`],
    ["a Cookie header with an empty cookie", "Cookie: a=; b=Hunter3pw", `Cookie: a=; b=${REDACTED}`],
    ["a Cookie value of one character", "Cookie: a=x", `Cookie: a=${REDACTED}`],
    ["a Cookie key with two backslashes before its closing quote (a known gap)", '{\\\\"Cookie\\\\": "a=Hunter2pw"}'],
    ["a Cookie key with two quotes behind it", '{"Cookie"": "a=Hunter2pw"}'],
    ["a Cookie value with two backslashes before its quote", '{\\"Cookie\\": \\\\"a=Hunter2pw\\"}'],
    ["a Cookie value with two quotes before it", '{"Cookie": ""a=Hunter2pw"}'],
  ];

  for (const [what, input, want] of patternRows) {
    test(want === undefined ? `leaves ${what} as it is` : `reads ${what}`, () => {
      assert.equal(redact(input), want ?? input);
    });
  }

  // The claims of the README's redaction passage, and of the CHANGELOG's security entry, that name
  // what is hidden or read, each as a probe. A row with no third text stays as it is. When a row
  // fails, the sentence it probes needs the same change.
  const readmeClaims: ReadonlyArray<readonly [string, string, string?]> = [
    // URL passwords and escaped breaks.
    ["the password of a URL written scheme://user:password@", "git clone https://bob:Hunter2pw@example.com/a/b", `git clone https://bob:${REDACTED}@example.com/a/b`],
    ["a URL's password in the text as written, where the backslash of a DOMAIN\\user name is no escape", "http://CORP\\tom:Hunter2pw@proxy.corp:8080", `http://CORP om:${REDACTED}@proxy.corp:8080`],
    ["escaped line breaks and tabs become spaces, and end a value", '{"log": "password: hunter2\\napi_key: Zz9y8x7w\\r\\ntoken: Aa1b2c3d\\tdone"}', `{"log": "password: ${REDACTED} api_key: ${REDACTED}  token: ${REDACTED} done"}`],
    // The other secret shapes.
    ["an Authorization header: a first word of letters only, and the word after it", "Authorization: Bearer q8Zt1rLm9XaQ", REDACTED],
    ["an Authorization header: the first word alone, when no word of letters stands before it", "Authorization: q8Zt1rLm9XaQ and more", `${REDACTED} and more`],
    ["a JWT that starts a word", "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl ok", `jwt ${REDACTED} ok`],
    ["a private-key block", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\n-----END OPENSSH PRIVATE KEY-----\nafter", `${REDACTED}\nafter`],
    ["keys and tokens with each prefix the README names, at the length that goes with it", "sk-abcdefghij0123456789 sk_live_aB3dE5gH ghp_abcdefghijklmnopqrstuvwxyz0123456789 github_pat_x glpat-abcdefghij0123456789 hf_abcdefghij0123456789 npm_abcdefghij0123456789 xoxb-1 AIzaabcde_ghij-123456789abcdefghij01234 AKIA0ABCDEFGHIJKLMNO", `${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`],
    ["the value on the same line after a key of each kind of secret name", "client_secret=a1 password=a2 passwd=a3 passphrase=a4 credential=a5 authorization=a6 token=a7 api_key_id=a8 access_key_id=a9 private_key_id=b1 monkey=b2 db_pass=b3 pwd=b4", `client_secret=${REDACTED} password=${REDACTED} passwd=${REDACTED} passphrase=${REDACTED} credential=${REDACTED} authorization=${REDACTED} token=${REDACTED} api_key_id=${REDACTED} access_key_id=${REDACTED} private_key_id=${REDACTED} monkey=${REDACTED} db_pass=${REDACTED} pwd=${REDACTED}`],
    ["the value after a flag with a secret name", "run --password a1 --api-key a2 --token a3 --db-pass a4", `run --password ${REDACTED} --api-key ${REDACTED} --token ${REDACTED} --db-pass ${REDACTED}`],
    ["a run of 40 letters and digits in mixed case", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k", REDACTED],
    ["a run of 40 base64 characters in mixed case with a digit and a slash", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", REDACTED],
    // Basic credentials.
    ["the password of -u, --user and -U in a curl command", "curl -u admin:Hunter2pw --user bob:Hunter3pw -U proxy:Hunter4pw https://h", `curl -u admin:${REDACTED} --user bob:${REDACTED} -U proxy:${REDACTED} https://h`],
    ["a curl word behind a slash", "/usr/bin/curl -u admin:Hunter2pw https://h", `/usr/bin/curl -u admin:${REDACTED} https://h`],
    ["a curl word behind a dot", "my.curl -u admin:Hunter2pw https://h", `my.curl -u admin:${REDACTED} https://h`],
    ["a curl word before a tab", "curl\t-u admin:Hunter2pw https://h", `curl\t-u admin:${REDACTED} https://h`],
    ["a curl command that a pipe ends", "curl -s https://h | sort -u -t: -k1"],
    ["a curl command that a semicolon ends", "curl -s https://h; date -u +%H:%M:%S"],
    ["a curl command that && ends", "curl -s https://h && date -u +%H:%M:%S"],
    ["a curl command that a line break ends", "curl -s https://h\ndate -u +%H:%M:%S"],
    ["a curl command that a line break behind a backslash continues", "curl -s https://h \\\n  -u admin:Hunter2pw", `curl -s https://h \\\n  -u admin:${REDACTED}`],
    ["a curl command that a semicolon inside a quoted argument does not end", "curl -H 'Accept: a; b' -u admin:Hunter2pw https://h", `curl -H 'Accept: a; b' -u admin:${REDACTED} https://h`],
    ["a quoted argument that ends at its line's end, and the command with it", "curl -H 'Accept: a; b\ndate -u +%H:%M:%S"],
    ["the quotes as they pair in a JSON string", '{"command": "curl -H \\"x; y\\" -u admin:Hunter2pw https://h"}', `{"command": "curl -H \\"x; y\\" -u admin:${REDACTED} https://h"}`],
    ["the quotes as the shell reads them, where a backslash escapes a quote", 'curl -d "{\\"a\\": \\"b; c\\"}" -u admin:Hunter2pw https://h', `curl -d "{\\"a\\": \\"b; c\\"}" -u admin:${REDACTED} https://h`],
    ["date -u and docker run -u, which stay", "date -u +%H:%M:%S; docker run -u 1000:1000 img"],
    ["the password of --proxy-user behind wget, behind curl and behind no command", "wget --proxy-user bob:Hunter2pw https://h; curl --proxy-user amy:Hunter3pw https://h\npass --proxy-user=cat:Hunter4pw to it", `wget --proxy-user bob:${REDACTED} https://h; curl --proxy-user amy:${REDACTED} https://h\npass --proxy-user=cat:${REDACTED} to it`],
    ["the text glued to -p behind mysql, mysqldump and mariadb", "mysql -uroot -pHunter2pw db; mysqldump -pHunter3pw db; mariadb -pHunter4pw db", `mysql -uroot -p${REDACTED} db; mysqldump -p${REDACTED} db; mariadb -p${REDACTED} db`],
    ["cp -pr and docker run -p8080:80, which stay", "cp -pr src dst; docker run -p8080:80 img"],
    ["the word after password on a netrc line that says machine", "machine example.com password Hunter2pw", `machine example.com password ${REDACTED}`],
    ["the word after password on a netrc line that says login", "login bob password Hunter2pw", `login bob password ${REDACTED}`],
    ["the word after password on a line that says neither", "the password Hunter2pw was typed twice"],
    ["the text of an XML element with a secret name", "<server><username>bob</username><password>Hunter2pw</password></server>", `<server><username>bob</username><password>${REDACTED}</password></server>`],
    ["the password of a Python auth pair", "requests.get(url, auth=('bob', 'Hunter2pw'))", `requests.get(url, auth=('bob', ${REDACTED}))`],
    ["the password of HTTPBasicAuth", "HTTPBasicAuth('bob', 'Hunter2pw')", `HTTPBasicAuth('bob', ${REDACTED})`],
    ["the unquoted cookie values of a Cookie header", "Cookie: a=Hunter2pw; b=Hunter3pw", `Cookie: a=${REDACTED}; b=${REDACTED}`],
    ["the unquoted cookie value of a Set-Cookie header", "Set-Cookie: sid=Hunter2pw; Path=/; HttpOnly", `Set-Cookie: sid=${REDACTED}; Path=/; HttpOnly`],
  ];

  for (const [claim, input, want] of readmeClaims) {
    test(`holds the README to its claim: ${claim}`, () => {
      assert.equal(redact(input), want ?? input);
    });
  }

  // The README's known gaps, input for input: what redact returns for each example the list gives.
  // A row with no third text reaches Jev as it is. When a row fails, the README's list needs the
  // same change.
  const readmeGaps: ReadonlyArray<readonly [string, string, string?]> = [
    // In a curl command.
    ["a quoted argument that runs over several lines, before the flag", `curl -d '{\n"a": 1\n}' -u admin:pw https://h`],
    ["a -u value in JSON-escaped quotes", 'curl -u \\"admin:pw\\" https://h'],
    ["a command in a JSON string whose argument holds quotes escaped twice around a separator", '{"command": "curl -d \\"{\\\\\\"a\\\\\\": \\\\\\"b; c\\\\\\"}\\" -u admin:pw"}'],
    ["such a command with one quote escaped twice and the separator in a later quoted argument", '{"command": "curl -d \\"5\\\\\\" wide\\" -H \\"Accept: text/html; q=0.9\\" -u admin:pw https://h"}'],
    ["a password that holds an escaped quote, whose part behind that quote stays", 'curl -u "admin:pw\\"Xyz9" https://h', `curl -u "admin:${REDACTED}"Xyz9" https://h`],
    ["a user name that holds an escaped quote", 'curl -u "ad\\"min:pw" https://h'],
    ["a flag behind a value that holds an escaped quote and a quoted separator", 'curl -u "admin:x\\"y" -H "Accept: a; b" -U proxy:pw https://h', `curl -u "admin:${REDACTED}"y" -H "Accept: a; b" -U proxy:pw https://h`],
    ["a quoted password that holds the other kind of quote, whose part from that quote on stays", `curl -u "admin:O'Brien1x" https://h`, `curl -u "admin:${REDACTED}'Brien1x" https://h`],
    ["a $'…' string that holds a separator, before the flag", "curl -d $'it\\'s; here' -u admin:pw"],
    ["a command substitution with quotes of its own, before the flag", 'curl -d "$(jq -c ".a; .b" f)" -u admin:pw'],
    ["a backslash before a separator outside quotes, before the flag", "curl https://h/a\\;b -u admin:pw"],
    ["a line continuation between the flag and its value", "curl -u \\\nadmin:pw https://h"],
    ["combined short flags", "curl -sSu admin:pw https://h"],
    ["a quoted password after the colon", 'curl -u admin:"pw with space" https://h'],
    ["an argument array", '["curl", "-u", "admin:pw"]'],
    ["curl.exe", "curl.exe -u admin:pw https://h"],
    // Elsewhere.
    ["wget's --user", "wget --user admin:pw https://h"],
    ["http's -u", "http -u admin:pw https://h"],
    ["a .netrc file written over several lines", "machine example.com\nlogin bob\npassword pw"],
    ["an Authorization name with an equals sign and no quotes, whose token stays", "Authorization=Bearer q8Zt1rLm9XaQ", `Authorization=${REDACTED} q8Zt1rLm9XaQ`],
    ["a header name glued behind an underscore, whose token stays", "HTTP_AUTHORIZATION: Bearer q8Zt1rLm9XaQ", `HTTP_AUTHORIZATION: ${REDACTED} q8Zt1rLm9XaQ`],
    ["an Authorization scheme that holds a hyphen, whose credential stays", "Authorization: Api-Key q8Zt1rLm9XaQ", `${REDACTED} q8Zt1rLm9XaQ`],
    ["an Authorization scheme that holds a digit, whose credential stays", '{"Authorization": "OAuth2 q8Zt1rLm9XaQ"}', `{"${REDACTED} q8Zt1rLm9XaQ"}`],
    ["an Authorization credential of several words, whose words behind the first stay", 'Authorization: Digest username="bob", response="6629fae49393a05397450978507c4ef1"', `${REDACTED}"bob", response="6629fae49393a05397450978507c4ef1"`],
    ["a credential of letters only before an escaped line break and another header, whose key stays", "Authorization: abcdef\\r\\nX-Api-Key: Zz9y8x7w6v", `${REDACTED} Zz9y8x7w6v`],
    ["a name that ends in tokens", "refresh_tokens: q8Zt1rLm9XaQ"],
    ["a name in which String stands behind token", "tokenString = q8Zt1rLm9XaQ"],
    ["PowerShell's -Password", "New-LocalUser -Name bob -Password hunter2"],
    ["a quoted cookie value", 'Set-Cookie: sid="Hunter2pw"'],
    ["mysql.exe", "mysql.exe -pHunter2pw db"],
    ["a comparison", 'if (password === "pw") ok()', `if (password =${REDACTED} "pw") ok()`],
    ["a bytes string", 'password=b"pw"', `password=${REDACTED}"pw"`],
    ["a raw string", "token = r'pw'", `token = ${REDACTED}'pw'`],
    ["a value on the line after its name", "password:\npw"],
    ["JSON escaped twice", '{\\\\"password\\\\": \\\\"pw\\\\"}'],
    ["a JWT glued behind an underscore", "x_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"],
    ["a URL password that holds a slash", "https://bob:p/w@host"],
    ["a Python auth pair whose password holds the other kind of quote", `auth=("bob", "O'Brien1x")`],
    ["a Python auth pair behind a name that only ends in _auth", "http_auth=('bob', 'Hunter2pw')"],
  ];

  for (const [what, input, want] of readmeGaps) {
    test(`keeps the README's known gap: ${what}`, () => {
      assert.equal(redact(input), want ?? input);
    });
  }

  // The README's examples of text that is hidden though it is no secret.
  const readmeHidden: ReadonlyArray<readonly [string, string, string]> = [
    ["the text of a plist's key element", "<key>CFBundleName</key>", `<key>${REDACTED}</key>`],
    ["the port of docker run on a line that names mysql", "docker run --name mysql -p8080:80 img", `docker run --name mysql -p${REDACTED} img`],
    ["the word after password on a line that also says login", "enter your login and password carefully", `enter your login and password ${REDACTED}`],
  ];

  for (const [what, input, want] of readmeHidden) {
    test(`hides, as the README says, ${what}`, () => {
      assert.equal(redact(input), want);
    });
  }

  // What five scans read that no output of redact shows. Each is asked on a copy, so that no test
  // moves a scan's own position.
  const scan = (pattern: RegExp, text: string): RegExpExecArray | null => new RegExp(pattern.source, pattern.flags).exec(text);

  test("the name scan finds a name of one letter, which is never secret", () => {
    assert.deepEqual([...(scan(SCANS.NAME_SEPARATOR, "k = v") ?? [])], ["k = ", "k"]);
    assert.equal(redact("k = v"), "k = v");
  });

  test("the flag scan finds a flag of one letter, and no flag in a bare double hyphen", () => {
    assert.deepEqual([...(scan(SCANS.FLAG_SPACE, "--v x") ?? [])], ["--v ", "--v"]);
    assert.equal(scan(SCANS.FLAG_SPACE, "-- x"), null);
    for (const text of ["--v x", "-- x"]) assert.equal(redact(text), text);
  });

  test("the netrc candidate takes a line that ends in the word password, which has no value", () => {
    assert.deepEqual([...(scan(SCANS.NETRC_CANDIDATE, "first\nlogin bob password\nlast") ?? [])], ["login bob password"]);
    assert.equal(redact("login bob password"), "login bob password");
  });

  test("the XML scan finds an element whose name is one letter, which is never secret", () => {
    assert.deepEqual([...(scan(SCANS.XML_ELEMENT, "<a>text</a>") ?? [])], ["<a>text", "<a>", "a"]);
    assert.equal(redact("<a>text</a>"), "<a>text</a>");
  });

  test("the Cookie scan finds a header with nothing behind its colon, where there is no cookie", () => {
    assert.deepEqual([...(scan(SCANS.COOKIE_HEADER, "Cookie:") ?? [])], ["Cookie:", "Cookie:", ""]);
    assert.equal(redact("Cookie:"), "Cookie:");
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
      // A digit or a plus inside a run of scheme characters starts no new attempt at a URL.
      "a1".repeat(50000),
      "a+".repeat(50000),
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
      // A hyphen inside a run of hyphens starts no new attempt at a flag.
      "-".repeat(200000),
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
      `curl ${'-u "a:b" \\" '.repeat(12500)}`,
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
