import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { redact, REDACTED } from "../src/redact.ts";

const pgpBody = "lQOYBF1bU2kBCAC7nV3rXQ9p+Kq/2mZtYw8sH4dLcE6aR0uJfGiT5vNoBxWy1zA3";
const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const mixed40 = "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE3fG5hJ7k";

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
    for (const spared of ["monkey: 3", "--verbose true", "--timeout 30", "keyboard = us"]) {
      assert.equal(redact(spared), spared);
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
    ];
    for (const input of inputs) {
      const start = performance.now();
      redact(input);
      const took = performance.now() - start;
      assert.ok(took < 1000, `${input.slice(0, 24)}... took ${took} ms`);
    }
  });
});
