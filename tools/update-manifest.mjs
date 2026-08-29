/**
 * Writes the update manifest Firefox polls to discover new versions.
 *
 * AMO does not serve updates for unlisted add-ons, so the manifest has to live
 * somewhere public. It sits at the repository root and is read over
 * raw.githubusercontent.com, which the release workflow keeps current.
 *
 * Usage: node tools/update-manifest.mjs <version> <xpi-path> <download-url>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const [version, xpiPath, downloadUrl] = process.argv.slice(2);

if (!version || !xpiPath || !downloadUrl) {
  console.error("Usage: node tools/update-manifest.mjs <version> <xpi-path> <download-url>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8"));
const gecko = manifest.browser_specific_settings.gecko;
const target = path.join(ROOT, "updates.json");

const entry = {
  version,
  update_link: downloadUrl,
  // Firefox checks this before installing, so a tampered release asset is
  // rejected rather than trusted because it came from the right URL.
  update_hash: `sha256:${createHash("sha256").update(readFileSync(xpiPath)).digest("hex")}`,
  applications: { gecko: { strict_min_version: gecko.strict_min_version } },
};

const existing = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : { addons: {} };
const updates = (existing.addons?.[gecko.id]?.updates ?? []).filter((u) => u.version !== version);
updates.push(entry);
updates.sort((a, b) => compare(a.version, b.version));

writeFileSync(
  target,
  `${JSON.stringify({ addons: { [gecko.id]: { updates } } }, null, 2)}\n`,
);
console.log(`updates.json now offers ${version} at ${downloadUrl}`);

/** @param {string} a @param {string} b */
function compare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
