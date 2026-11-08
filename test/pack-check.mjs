// Reads `npm pack --dry-run --json` on stdin and fails unless the tarball holds exactly the
// shipped surface: index.ts, src/**/*.ts, README.md, LICENSE and package.json. Test-only; never
// shipped. The input is checked strictly, so a failed `npm pack` (no output, or an error object)
// fails this check even though the shell pipeline reports this script's status.
const REQUIRED = ["LICENSE", "README.md", "index.ts", "package.json"];
const allowed = (path) => REQUIRED.includes(path) || /^src\/(?:[\w.-]+\/)*[\w.-]+\.ts$/.test(path);

const fail = (message) => {
  console.error(`pack:check: ${message}`);
  process.exit(1);
};

let input = "";
for await (const chunk of process.stdin) input += chunk;
let packs;
try {
  packs = JSON.parse(input);
} catch {
  fail("npm pack produced no JSON; did it fail?");
}
if (!Array.isArray(packs) || packs.length !== 1) fail(`expected one package, got ${JSON.stringify(packs)}`);
const [pack] = packs;
if (pack === null || typeof pack !== "object" || !Array.isArray(pack.files)) fail("the package lists no files");
if (Array.isArray(pack.bundled) && pack.bundled.length > 0) fail(`bundled dependencies: ${pack.bundled.join(", ")}`);
const paths = pack.files.map((file) => String(file?.path)).sort();
const unexpected = paths.filter((path) => !allowed(path));
if (unexpected.length > 0) fail(`not part of the shipped surface: ${unexpected.join(", ")}`);
const missing = REQUIRED.filter((path) => !paths.includes(path));
if (missing.length > 0) fail(`missing: ${missing.join(", ")}`);
if (!paths.some((path) => path.startsWith("src/"))) fail("missing: src/");
console.log(`pack:check: ${pack.name}@${pack.version} ships ${paths.length} files: ${paths.join(", ")}`);
