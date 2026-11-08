import assert from "node:assert/strict";
import { appendFileSync, chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { agentFile, OPEN_FLAGS, readUserFile } from "../src/files.ts";
import type { FileSystem, Parsed } from "../src/files.ts";
import { expectKind, scratch, write } from "./support/fixtures.ts";

const UID = process.getuid?.() ?? -1;
const CAP = 1024;

/** The real descriptor calls, recorded, with an optional hook that runs right after fstat. */
function recording(afterStat?: () => void) {
  const calls = { flags: [] as number[], opened: 0, closed: 0, reads: 0, requested: 0 };
  const fs: FileSystem = {
    openSync(path, flags) {
      calls.flags.push(flags);
      const fd = openSync(path, flags);
      calls.opened += 1;
      return fd;
    },
    fstatSync(fd) {
      const stat = fstatSync(fd);
      afterStat?.();
      return stat;
    },
    readSync(fd, buffer, offset, length, position) {
      calls.reads += 1;
      calls.requested += length;
      return readSync(fd, buffer, offset, length, position);
    },
    closeSync(fd) {
      calls.closed += 1;
      closeSync(fd);
    },
  };
  return { fs, calls };
}

test("reads a regular file owned by this user, read-only and non-blocking, through one descriptor", (t) => {
  const path = write(scratch(t), "roster.json", '{"version": 1}');
  const { fs, calls } = recording();
  const read = expectKind(readUserFile(path, { maxBytes: CAP, fs }), "read");
  assert.equal(read.text, '{"version": 1}');
  assert.equal(read.identity.size, 14);
  assert.deepEqual([calls.opened, calls.closed], [1, 1]);
  assert.deepEqual(calls.flags, [OPEN_FLAGS]);
  assert.equal(OPEN_FLAGS & (constants.O_WRONLY | constants.O_RDWR), 0);
  if (constants.O_NONBLOCK !== undefined) assert.notEqual(OPEN_FLAGS & constants.O_NONBLOCK, 0);
});

test("refuses a path that is not absolute, without opening it", () => {
  const { fs, calls } = recording();
  const result = expectKind(readUserFile("relative/smart-router.json", { maxBytes: CAP, fs }), "invalid");
  assert.match(result.error, /is not an absolute path/);
  assert.equal(calls.opened, 0);
});

test("reports a missing file as missing", (t) => {
  expectKind(readUserFile(join(scratch(t), "absent.json"), { maxBytes: CAP }), "missing");
});

test("refuses anything but a regular file, and closes it", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "folder"));
  for (const path of [join(dir, "folder"), "/dev/null"]) {
    const { fs, calls } = recording();
    const result = expectKind(readUserFile(path, { maxBytes: CAP, fs }), "unsafe");
    assert.match(result.error, /is not a regular file/);
    assert.deepEqual([calls.opened, calls.closed, calls.reads], [1, 1, 0], path);
  }
});

test("refuses a file owned by another user", (t) => {
  const path = write(scratch(t), "roster.json", "{}");
  const result = expectKind(readUserFile(path, { maxBytes: CAP, uid: UID + 1 }), "unsafe");
  assert.match(result.error, new RegExp(`is owned by uid ${UID}, not ${UID + 1}`));
});

test("refuses a group- or world-writable file", (t) => {
  const dir = scratch(t);
  for (const mode of [0o620, 0o602, 0o666, 0o622]) {
    const result = expectKind(readUserFile(write(dir, `w${mode.toString(8)}.json`, "{}", mode), { maxBytes: CAP }), "unsafe");
    assert.match(result.error, /writable by its group or by others/);
  }
  for (const mode of [0o600, 0o644, 0o400, 0o640]) {
    expectKind(readUserFile(write(dir, `r${mode.toString(8)}.json`, "{}", mode), { maxBytes: CAP }), "read");
  }
});

test("follows a symlink to its target, and refuses one whose target is unsafe", (t) => {
  const dir = scratch(t);
  symlinkSync(write(dir, "safe.json", "{}"), join(dir, "to-safe.json"));
  symlinkSync(write(dir, "open.json", "{}", 0o666), join(dir, "to-open.json"));
  symlinkSync(join(dir, "nowhere.json"), join(dir, "dangling.json"));
  expectKind(readUserFile(join(dir, "to-safe.json"), { maxBytes: CAP }), "read");
  expectKind(readUserFile(join(dir, "to-open.json"), { maxBytes: CAP }), "unsafe");
  expectKind(readUserFile(join(dir, "dangling.json"), { maxBytes: CAP }), "missing");
});

test("enforces the size cap on the file's size", (t) => {
  const dir = scratch(t);
  expectKind(readUserFile(write(dir, "full.json", "x".repeat(CAP)), { maxBytes: CAP }), "read");
  const over = expectKind(readUserFile(write(dir, "over.json", "x".repeat(CAP + 1)), { maxBytes: CAP }), "invalid");
  assert.match(over.error, new RegExp(`is larger than ${CAP} bytes`));
});

test("refuses a file that grows between fstat and the read, at cap + 1 bytes", (t) => {
  const path = write(scratch(t), "growing.json", "x".repeat(CAP - 10));
  const { fs, calls } = recording(() => appendFileSync(path, "y".repeat(100)));
  const result = expectKind(readUserFile(path, { maxBytes: CAP, fs }), "invalid");
  assert.match(result.error, new RegExp(`is larger than ${CAP} bytes`));
  assert.equal(calls.requested, CAP + 1, "the reads ask for cap + 1 bytes in all, no more");
  assert.deepEqual([calls.opened, calls.closed], [1, 1]);
});

test("reports an unchanged identity without reading", (t) => {
  const dir = scratch(t);
  const path = write(dir, "roster.json", "{}");
  const first = expectKind(readUserFile(path, { maxBytes: CAP }), "read");
  const { fs, calls } = recording();
  expectKind(readUserFile(path, { maxBytes: CAP, previous: first.identity, fs }), "unchanged");
  assert.deepEqual([calls.reads, calls.closed], [0, 1]);
  write(dir, "roster.json", '{"changed": true}');
  expectKind(readUserFile(path, { maxBytes: CAP, previous: first.identity }), "read");
});

test("checks owner and mode even when the identity is unchanged", (t) => {
  const path = write(scratch(t), "roster.json", "{}");
  const first = expectKind(readUserFile(path, { maxBytes: CAP }), "read");
  chmodSync(path, 0o666);
  expectKind(readUserFile(path, { maxBytes: CAP, previous: first.identity }), "unsafe");
});

test("refuses text that is not UTF-8", (t) => {
  const path = write(scratch(t), "bad.json", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
  const result = expectKind(readUserFile(path, { maxBytes: CAP }), "invalid");
  assert.match(result.error, /is not valid UTF-8/);
});

test("turns a failed read into an error and still closes the descriptor", (t) => {
  const path = write(scratch(t), "roster.json", "{}");
  const { fs, calls } = recording();
  const failing: FileSystem = {
    ...fs,
    readSync() {
      throw Object.assign(new Error("boom"), { code: "EIO" });
    },
  };
  const result = expectKind(readUserFile(path, { maxBytes: CAP, fs: failing }), "invalid");
  assert.match(result.error, /cannot be read \(EIO\)/);
  assert.deepEqual([calls.opened, calls.closed], [1, 1]);
});

// ─── agentFile ────────────────────────────────────────────────────────────────

function counting(): { parse: (text: string) => Parsed<string>; count: () => number } {
  let parses = 0;
  return {
    parse: (text) => {
      parses += 1;
      return text.startsWith("bad") ? { ok: false, error: "bad content" } : { ok: true, value: text };
    },
    count: () => parses,
  };
}

test("an agent file is refused when PI_CODING_AGENT_DIR is relative", () => {
  const { parse, count } = counting();
  const file = agentFile({ agentDir: () => "relative/agent", name: "smart-router.json", maxBytes: CAP, parse });
  const state = expectKind(file.current(), "invalid");
  assert.match(state.error, /PI_CODING_AGENT_DIR is relative/);
  assert.equal(count(), 0);
});

test("an agent file is cached by identity and reloaded when it changes", (t) => {
  const dir = scratch(t);
  const path = write(dir, "smart-router.json", "one");
  const { parse, count } = counting();
  const file = agentFile({ agentDir: () => dir, name: "smart-router.json", maxBytes: CAP, parse, now: () => 7 });
  const first = file.current();
  assert.deepEqual(first, { kind: "ok", path, value: "one", loadedAt: 7 });
  assert.equal(file.current(), first);
  assert.equal(file.refresh(), first, "an unchanged identity keeps the parsed state");
  assert.equal(count(), 1);

  write(dir, "smart-router.json", "two!");
  const second = expectKind(file.refresh(), "ok");
  assert.equal(second.value, "two!");
  assert.equal(file.current(), second);
  assert.equal(count(), 2);

  write(dir, "smart-router.json", "tri!");
  utimesSync(path, new Date(2_000_000_000_000), new Date(2_000_000_000_000));
  const third = expectKind(file.refresh(), "ok");
  assert.equal(third.value, "tri!", "a same-size edit is seen through its mtime");
  assert.equal(count(), 3);

  assert.notEqual(file.reload(), third);
  assert.equal(count(), 4, "reload reads whatever the identity");
});

test("an agent file keeps no last-known-good copy", (t) => {
  const dir = scratch(t);
  write(dir, "smart-router.json", "good");
  const { parse } = counting();
  const file = agentFile({ agentDir: () => dir, name: "smart-router.json", maxBytes: CAP, parse });
  expectKind(file.refresh(), "ok");
  write(dir, "smart-router.json", "bad content now");
  expectKind(file.refresh(), "invalid");
  expectKind(file.current(), "invalid");
  rmSync(join(dir, "smart-router.json"));
  expectKind(file.refresh(), "missing");
  write(dir, "smart-router.json", "good again");
  expectKind(file.refresh(), "ok");
});

test("an agent file follows a change of agent directory", (t) => {
  const first = scratch(t);
  const second = scratch(t);
  write(first, "smart-router.json", "first");
  write(second, "smart-router.json", "second");
  let dir = first;
  const { parse } = counting();
  const file = agentFile({ agentDir: () => dir, name: "smart-router.json", maxBytes: CAP, parse });
  const before = expectKind(file.current(), "ok");
  assert.deepEqual([before.path, before.value], [join(first, "smart-router.json"), "first"]);
  dir = second;
  const after = expectKind(file.refresh(), "ok");
  assert.deepEqual([after.path, after.value], [join(second, "smart-router.json"), "second"]);
});
