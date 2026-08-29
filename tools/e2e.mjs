/**
 * Proves the extension in a real Firefox rather than a mock of one: loads it
 * headless, turns the tunnel on, and checks where traffic actually comes out.
 *
 * Firefox gives a headless web-ext run no way to hand console output back, so
 * the probe posts its verdict to a loopback collector this script owns.
 * Loopback is never tunnelled, so the report cannot be distorted by the thing it
 * is reporting on.
 *
 * Usage: node tools/e2e.mjs [country]
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const COUNTRY = process.argv[2] ?? "tr";
const SECOND = process.argv[3] ?? (COUNTRY === "de" ? "nl" : "de");
const iso = (c) => (c === "uk" ? "GB" : c.slice(0, 2).toUpperCase());
const EXPECT = iso(COUNTRY);
const EXPECT_SECOND = iso(SECOND);
const DEADLINE_MS = 180_000;

const staging = mkdtempSync(path.join(tmpdir(), "zagent-e2e-"));
cpSync(path.join(ROOT, "src"), staging, { recursive: true });

let deliver;
const collected = new Promise((resolve) => (deliver = resolve));
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.writeHead(204).end();
    try {
      deliver(JSON.parse(body));
    } catch {
      deliver({ error: `unreadable report: ${body.slice(0, 200)}` });
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const collector = `http://127.0.0.1:${server.address().port}/report`;

stage();

const firefox = spawn(
  "npx",
  ["--yes", "web-ext@latest", "run", `--source-dir=${staging}`, "--arg=--headless", "--no-reload", "--no-input"],
  // Detached so it leads its own process group: killing the npx wrapper alone
  // leaves web-ext, and the Firefox it started, running for the rest of the day.
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true },
);
const stopFirefox = () => {
  try {
    process.kill(-firefox.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
};
process.on("exit", stopFirefox);
let log = "";
firefox.stdout.on("data", (chunk) => (log += chunk));
firefox.stderr.on("data", (chunk) => (log += chunk));

const result = await Promise.race([
  collected,
  new Promise((resolve) => setTimeout(() => resolve({ error: "timed out waiting for the probe" }), DEADLINE_MS)),
]);

stopFirefox();
server.close();
rmSync(staging, { recursive: true, force: true });

if (result.error !== undefined) {
  console.error(`FAIL ${result.error}`);
  console.error(log.trim().split("\n").slice(-12).join("\n"));
  process.exit(1);
}

console.log(`baseline   ${describe(result.baseline)}`);
console.log(`tunnelled  ${describe(result.tunnelled)}`);
console.log(`switched   ${describe(result.switched)}`);
console.log(`restored   ${describe(result.restored)}`);
console.log(`chain      ${(result.agents ?? []).join(", ") || "(none)"}`);
console.log(`identities ${result.initCalls} background_init call(s)`);
console.log(`session    ${result.status} ${result.sessionError ?? ""}`.trim());
if (result.proxyErrors?.length) console.log(`onError    ${result.proxyErrors.join("; ")}`);
console.log("");

const checks = [
  ["a tunnel opened", (result.agents ?? []).length > 0],
  ["the chain is terminated so fail-closed holds", result.terminated === true],
  [`traffic exits in ${EXPECT}`, result.tunnelled?.country === EXPECT],
  ["the exit address is not the real one", result.tunnelled?.ip !== result.baseline?.ip],
  [`switching moves the exit to ${EXPECT_SECOND}`, result.switched?.country === EXPECT_SECOND],
  ["the switch reused one identity", result.initCalls === 1],
  ["turning it off restores the real address", result.restored?.ip === result.baseline?.ip],
  ["proxy.onRequest raised no errors", (result.proxyErrors ?? []).length === 0],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "  ok " : "FAIL "} ${label}`);
  if (!pass) failed++;
}
console.log(failed === 0 ? "\nPASS" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

function describe(info) {
  return info ? `${info.ip} ${info.country} ${info.org ?? ""}`.trim() : "(no answer)";
}

function stage() {
  const main = path.join(staging, "background", "main.js");
  writeFileSync(main, `${readFileSync(main, "utf8")}\nexport { apply, session };\n`);

  const page = path.join(staging, "background", "index.html");
  writeFileSync(
    page,
    readFileSync(page, "utf8").replace(
      '<script type="module" src="main.js"></script>',
      '<script type="module" src="main.js"></script>\n<script type="module" src="probe.js"></script>',
    ),
  );

  writeFileSync(path.join(staging, "background", "probe.js"), probeSource());
}

function probeSource() {
  return `import { apply, session } from "./main.js";
import * as router from "./router.js";
import { DEFAULTS } from "./settings.js";

const COLLECTOR = ${JSON.stringify(collector)};
const TARGET = { url: "https://example.com/" };
const proxyErrors = [];
browser.proxy.onError.addListener((e) => proxyErrors.push(String(e && e.message)));

let initCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url).includes("background_init")) initCalls++;
  return realFetch(url, init);
};

async function where() {
  try {
    const res = await fetch("https://ipinfo.io/json", { cache: "no-store" });
    const info = await res.json();
    return { ip: info.ip, country: info.country, org: info.org };
  } catch {
    return null;
  }
}

async function waitForTunnel(ms) {
  for (let waited = 0; waited < ms; waited += 200) {
    if (session.state.status === "on" || session.state.status === "error") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const decision = router.decide(TARGET);
  return Array.isArray(decision) && String(decision[0] && decision[0].host).endsWith(".hola.org") ? decision : null;
}

(async () => {
  const out = { proxyErrors };
  try {
    out.baseline = await where();

    await apply({ ...DEFAULTS, enabled: true, country: ${JSON.stringify(COUNTRY)}, proxyType: "direct" });
    const chain = await waitForTunnel(60000);
    out.status = session.state.status;
    out.sessionError = session.state.error;
    out.agents = (chain ?? []).filter(Boolean).map((p) => p.host);
    out.terminated = Array.isArray(chain) && chain[chain.length - 1] === null;
    out.tunnelled = out.agents.length === 0 ? null : await where();

    if (out.tunnelled) {
      await apply({ ...DEFAULTS, enabled: true, country: ${JSON.stringify(SECOND)}, proxyType: "direct" });
      out.switched = (await waitForTunnel(60000)) === null ? null : await where();
    }
    out.initCalls = initCalls;

    await apply({ ...DEFAULTS, enabled: false });
    out.restored = await where();
  } catch (err) {
    out.error = String(err && err.stack);
  }
  await fetch(COLLECTOR, { method: "POST", body: JSON.stringify(out) });
})();
`;
}
