/**
 * Everything Firefox will only tell you about at install time or, worse, at
 * runtime: broken syntax, an import that points nowhere, a file the manifest
 * references but nobody shipped, an inline script the MV2 CSP will refuse.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const problems = [];
const fail = (file, message) => problems.push(`${path.relative(SRC, file) || file}: ${message}`);

const files = walk(SRC);
const manifest = checkManifest();
checkSyntax();
checkImports();
checkHtml();
checkManifestReferences();
checkUpdateManifest();

if (problems.length !== 0) {
  console.error(`${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`src/ is clean: ${files.length} files, manifest v${manifest.manifest_version}, version ${manifest.version}`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function checkManifest() {
  const file = path.join(SRC, "manifest.json");
  const json = JSON.parse(readFileSync(file, "utf8"));

  for (const key of ["manifest_version", "name", "version", "permissions", "background"]) {
    if (json[key] === undefined) fail(file, `missing "${key}"`);
  }
  if (!json.permissions?.includes("proxy")) fail(file, 'the "proxy" permission is missing');

  const min = json.browser_specific_settings?.gecko?.strict_min_version;
  if (min === undefined) {
    fail(file, "the proxy permission needs browser_specific_settings.gecko.strict_min_version");
  } else if (compareVersions(min, "91.1.0") < 0) {
    fail(file, `strict_min_version ${min} is below the 91.1.0 the proxy permission requires`);
  }
  return json;
}

function checkSyntax() {
  const tmp = mkdtempSync(path.join(tmpdir(), "zagent-check-"));
  try {
    syntaxCheckInto(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {string} tmp */
function syntaxCheckInto(tmp) {
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const copy = path.join(tmp, "unit.mjs");
    writeFileSync(copy, readFileSync(file));
    try {
      execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
    } catch (err) {
      const text = String(err.stderr);
      const line = /unit\.mjs:(\d+)/.exec(text)?.[1];
      const reason = /^\w*(?:Error|Warning):.*$/m.exec(text)?.[0] ?? text.trim();
      fail(file, line === undefined ? reason : `line ${line}: ${reason}`);
    }
  }
}

function checkImports() {
  for (const file of files.filter((f) => f.endsWith(".js"))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)[^'"]*?from\s+["'](\.[^"']+)["']/gm)) {
      const target = path.resolve(path.dirname(file), match[1]);
      if (!existsSync(target)) fail(file, `imports "${match[1]}", which does not exist`);
    }
  }
}

function checkHtml() {
  for (const file of files.filter((f) => f.endsWith(".html"))) {
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (match[2].trim() !== "") fail(file, "has an inline script, which the MV2 CSP blocks");
      const src = /\bsrc=["']([^"']+)["']/.exec(match[1])?.[1];
      if (src === undefined) fail(file, "has a <script> with no src");
      else expectAsset(file, src);
    }
    for (const match of source.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["']/g)) expectAsset(file, match[1]);
    if (/<[^>]+\son[a-z]+=/i.test(source)) fail(file, "has an inline event handler, which the MV2 CSP blocks");
  }
}

function checkManifestReferences() {
  const file = path.join(SRC, "manifest.json");
  const refs = [
    manifest.background?.page,
    manifest.browser_action?.default_popup,
    ...iconPaths(manifest.browser_action?.default_icon),
    ...iconPaths(manifest.icons),
  ].filter(Boolean);

  for (const ref of refs) {
    const target = path.join(SRC, ref.replace(/^\//, ""));
    if (!existsSync(target)) fail(file, `references "${ref}", which does not exist`);
  }

  for (const source of files.filter((f) => f.endsWith(".js"))) {
    for (const match of readFileSync(source, "utf8").matchAll(/["'](\/icons\/[^"']+)["']/g)) {
      const target = path.join(SRC, match[1].slice(1));
      if (!existsSync(target)) fail(source, `references "${match[1]}", which does not exist`);
    }
  }
}

/**
 * An add-on id that disagrees with the update manifest does not fail. It just
 * means updates never arrive, which is the kind of thing you notice months late.
 */
function checkUpdateManifest() {
  const gecko = manifest.browser_specific_settings?.gecko ?? {};
  const file = path.join(SRC, "..", "updates.json");
  if (gecko.update_url === undefined) return;

  if (!existsSync(file)) {
    fail("updates.json", `manifest points at ${gecko.update_url} but no updates.json exists`);
    return;
  }
  const updates = JSON.parse(readFileSync(file, "utf8"));
  const ids = Object.keys(updates.addons ?? {});
  if (!ids.includes(gecko.id)) {
    fail("updates.json", `lists ${ids.join(", ") || "nothing"}, but the add-on id is ${gecko.id}`);
  }
  if (!gecko.update_url.endsWith("/updates.json")) {
    fail("manifest.json", `update_url does not end in /updates.json: ${gecko.update_url}`);
  }
}

function iconPaths(value) {
  if (value === undefined) return [];
  return typeof value === "string" ? [value] : Object.values(value);
}

function expectAsset(from, ref) {
  if (/^(https?:|data:|moz-extension:)/.test(ref)) return;
  const target = ref.startsWith("/") ? path.join(SRC, ref.slice(1)) : path.resolve(path.dirname(from), ref);
  if (!existsSync(target) || !statSync(target).isFile()) fail(from, `references "${ref}", which does not exist`);
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
