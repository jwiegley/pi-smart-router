import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { redact, REDACTED } from "../src/redact.ts";

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

  test("leaves ordinary text alone", () => {
    assert.equal(redact("rename foo to bar in src/a.ts"), "rename foo to bar in src/a.ts");
    const lower = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";
    assert.equal(lower.length, 40);
    assert.equal(redact(lower), lower);
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
    ];
    const start = performance.now();
    for (const input of inputs) redact(input);
    assert.ok(performance.now() - start < 2000, `took ${performance.now() - start} ms`);
  });
});
