/**
 * Produces the archive you upload to addons.mozilla.org for signing. The manifest
 * has to sit at the archive root, so the zip is taken from inside src/.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run(process.execPath, ["tools/check.mjs"]);
run(process.execPath, ["--test"]);

const { version } = JSON.parse(readFileSync(path.join(SRC, "manifest.json"), "utf8"));
const archive = path.join(DIST, `zagent-${version}.zip`);

mkdirSync(DIST, { recursive: true });
rmSync(archive, { force: true });

try {
  run("zip", ["-qr9X", archive, ".", "-x", ".*"], SRC);
} catch {
  console.error('Could not run "zip". Install it, or archive src/ yourself with the manifest at the root.');
  process.exit(1);
}

const kb = (statSync(archive).size / 1024).toFixed(1);
console.log(`\n${path.relative(ROOT, archive)}  ${kb} kB`);
console.log("Upload it as an unlisted add-on at https://addons.mozilla.org/developers/addon/submit/upload-unlisted");
