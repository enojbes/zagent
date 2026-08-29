/**
 * Cuts a release: verifies, tags, pushes. CI does the signing, so nothing here
 * needs an AMO credential on this machine.
 *
 * Usage: npm run release -- 1.0.3
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: npm run release -- <major.minor.patch>");
  process.exit(2);
}

const run = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
const read = (cmd, args) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" }).trim();

if (read("git", ["status", "--porcelain"]) !== "") {
  console.error("Working tree is dirty. Commit or stash first.");
  process.exit(1);
}

const manifestPath = path.join(ROOT, "src", "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

run(process.execPath, ["tools/check.mjs"]);
run(process.execPath, ["--test"]);
run(process.execPath, ["tools/loopback-e2e.mjs"]);

// The manifest may already carry this version, in which case there is nothing
// to commit and the tag is the only thing missing.
if (read("git", ["status", "--porcelain", "src/manifest.json"]) !== "") {
  run("git", ["add", "src/manifest.json"]);
  run("git", ["commit", "-m", `Release ${version}`]);
}
// Annotated, not lightweight. --follow-tags ignores lightweight tags, so the
// first cut of 1.0.5 tagged locally, pushed nothing, and reported success.
run("git", ["tag", "-a", `v${version}`, "-m", `Zagent ${version}`]);
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", `v${version}`]);

if (read("git", ["ls-remote", "--tags", "origin", `v${version}`]) === "") {
  console.error(`\nv${version} did not reach the remote. Nothing will build.`);
  process.exit(1);
}

const slug = read("git", ["remote", "get-url", "origin"]).replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
console.log(`\nTagged v${version} and pushed it. CI signs and publishes from here.`);
console.log(`https://github.com/${slug}/actions`);
