// The standalone roster checker: `node src/check-cli.ts <roster.json>`.
//
// It is not part of the extension: index.ts never imports it, and Pi never loads it. John runs it,
// or nix-config does, on a roster before a session reads it: it parses the file with the router's
// own parser and prints either what each selection and scope routes to, in order, or the first
// error with its place. It imports nothing of Pi's, reads the one file named, needs no credentials
// and sends nothing. Exit status: 0 valid, 1 a roster the router would refuse, 2 a wrong invocation.
//
// Node 22.18 or later runs it as it is. A path is taken as the shell gives it, relative to the
// working directory when it is not absolute; that is this command's alone, and the extension's
// runtime code still reads nothing relative to the working directory.
import { resolve } from "node:path";

import { runCheck } from "./check.ts";

process.exitCode = runCheck(
  process.argv.slice(2).map((path) => (path.startsWith("-") ? path : resolve(path))),
  (line) => void process.stdout.write(`${line}\n`),
);
