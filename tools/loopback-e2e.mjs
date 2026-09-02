/**
 * Proves the routing code in a real Firefox without depending on Hola.
 *
 * The Hola-backed check (tools/e2e.mjs) only runs when Hola has not blocked the
 * address, which makes it a poor regression test. This one stands a loopback
 * listener in for the agents and asserts on what Firefox actually sends it, so
 * it answers the question that matters about our own code. Does the chain the
 * router builds make Firefox open a TLS connection to the host and port we
 * named, stepping over a dead entry, and only when it should?
 *
 * Nothing here needs a trusted certificate, because every assertion is about
 * bytes on the wire before the handshake completes. The listener also kills
 * every connection it accepts, which is what makes "this request answered" a
 * sound proof that the request did not go through the tunnel.
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEADLINE_MS = 120_000;
const AUTH = "basic dXNlci11dWlkLXRlc3QtaXNfcHJlbS0wOmFnZW50a2V5";

/** @type {{ firstBytes: Buffer, sni: string | null }[]} */
const arrivals = [];
/** Arrival count at each phase boundary the probe announces. */
const marks = {};
/** @type {any} */
let popupReport = null;

/** Milliseconds of silence from the agent before a phase boundary is trusted. */
const QUIET_MS = 700;
let lastArrivalAt = 0;

const agent = createTcpServer((socket) => {
  socket.once("data", (chunk) => {
    arrivals.push({ firstBytes: chunk.subarray(0, 3), sni: readSni(chunk) });
    lastArrivalAt = Date.now();
    socket.destroy();
  });
  socket.on("error", () => {});
});

/**
 * A connection Firefox opened during one phase can reach the listener after the
 * next phase has started, which blamed the wrong phase and failed at random.
 * Waiting for the agent to fall quiet attributes late arrivals to whatever
 * caused them.
 */
async function quiesce() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && Date.now() - lastArrivalAt < QUIET_MS) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

await new Promise((resolve) => agent.listen(0, "127.0.0.1", resolve));
const LIVE_PORT = agent.address().port;

/** Bound then closed, so connecting to it is refused instantly. */
const scratch = createTcpServer();
await new Promise((resolve) => scratch.listen(0, "127.0.0.1", resolve));
const DEAD_PORT = scratch.address().port;
await new Promise((resolve) => scratch.close(resolve));

/**
 * Two probes report independently: the routing one from the background page and
 * the popup one from its own tab. Resolving on the first to arrive would kill
 * Firefox out from under the other, which showed up as the popup checks failing
 * at random.
 */
let deliver;
const collected = new Promise((resolve) => (deliver = resolve));
let routingReport = null;

function maybeDeliver() {
  if (routingReport !== null && popupReport !== null) deliver(routingReport);
}
const collector = createHttpServer((req, res) => {
  if (req.url.startsWith("/mark/")) {
    quiesce().then(() => {
      marks[req.url.slice(6)] = arrivals.length;
      res.writeHead(204).end();
    });
    return;
  }

  if (req.url === "/popup") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(204).end();
      try {
        popupReport = JSON.parse(body);
      } catch {
        popupReport = { errors: ["unreadable popup report"] };
      }
      maybeDeliver();
    });
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.writeHead(204).end();
    try {
      routingReport = JSON.parse(body);
    } catch {
      routingReport = { error: `unreadable report: ${body.slice(0, 200)}` };
    }
    maybeDeliver();
  });
});
await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
const COLLECTOR = `http://127.0.0.1:${collector.address().port}`;

const staging = mkdtempSync(path.join(tmpdir(), "zagent-loopback-"));
cpSync(path.join(ROOT, "src"), staging, { recursive: true });
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

const phases = await Promise.race([
  collected,
  new Promise((resolve) =>
    setTimeout(
      () =>
        resolve(
          routingReport ?? {
            error: popupReport === null ? "neither probe reported" : "the routing probe never reported",
          },
        ),
      DEADLINE_MS,
    ),
  ),
]);

stopFirefox();
agent.close();
collector.close();
rmSync(staging, { recursive: true, force: true });

if (phases.error !== undefined) {
  console.error(`FAIL ${phases.error}`);
  console.error(log.trim().split("\n").slice(-12).join("\n"));
  process.exit(1);
}

const during = (from, to) => (marks[to] ?? 0) - (marks[from] ?? 0);
const first = arrivals[0];

console.log(`chain        127.0.0.1:${DEAD_PORT} (dead) then localhost:${LIVE_PORT} (listening)`);
console.log(`arrivals     ${arrivals.length} total, by phase ${JSON.stringify(marks)}`);
console.log("             (Firefox's own startup traffic is tunnelled too, which is the point)");
console.log(`first bytes  ${first ? [...first.firstBytes].map((b) => b.toString(16).padStart(2, "0")).join(" ") : "(none)"}`);
console.log(`sni          ${first?.sni ?? "(none)"}`);
for (const [name, result] of Object.entries(phases)) console.log(`${name.padEnd(12)} ${JSON.stringify(result)}`);
console.log("");

console.log(`popup       ${popupReport ? JSON.stringify(popupReport) : "(no report)"}`);
console.log("");

const checks = [
  ["the probe got the listener attached", phases.listenerAttached === true],
  ["the popup reported at all", popupReport !== null],
  ["the popup renders in Firefox without errors", popupReport !== null && popupReport.errors.length === 0],
  ["the popup lists every country", popupReport?.countryRows > 40],
  ["a fresh profile has no country and no armed tunnel", popupReport?.selected === null],
  ["the popup does not steal focus on open", popupReport?.focused === null],
  ["the toggle is unusable until a country is chosen", popupReport?.toggleDisabled === true],
  ["Firefox reached the agent, stepping over the dead first entry", during("start", "routed") > 0],
  ['type "https" makes Firefox speak TLS to the agent', first?.firstBytes[0] === 0x16],
  ["it offers the agent hostname as SNI", first?.sni === "localhost"],
  ["the Hola API bypasses the tunnel", phases.hola?.outcome === "answered"],
  ["fail-closed refuses the request", phases.failClosed?.outcome !== "answered"],
  ["fail-closed does not fall back to the agent", during("hola", "blocked") === 0],
  ["turning it off restores normal browsing", phases.disarmed?.outcome === "answered"],
  ["turning it off stops using the agent", during("blocked", "disarmed") === 0],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? "  ok " : "FAIL "} ${label}`);
  if (!pass) failed++;
}
console.log(failed === 0 ? "\nPASS" : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);

/**
 * Server name from a TLS ClientHello, or null. Firefox omits it for IP literals,
 * which is why the chain names a host rather than an address.
 *
 * @param {Buffer} buf
 */
function readSni(buf) {
  try {
    if (buf[0] !== 0x16 || buf[5] !== 0x01) return null;
    let at = 43 + buf[43] + 1;
    at += buf.readUInt16BE(at) + 2;
    at += buf[at] + 1;
    const extensionsEnd = at + 2 + buf.readUInt16BE(at);
    at += 2;
    while (at < extensionsEnd) {
      const type = buf.readUInt16BE(at);
      const length = buf.readUInt16BE(at + 2);
      if (type === 0x0000) return buf.toString("utf8", at + 9, at + 9 + buf.readUInt16BE(at + 7));
      at += 4 + length;
    }
  } catch {
    return null;
  }
  return null;
}

function stage() {
  const page = path.join(staging, "background", "index.html");
  writeFileSync(
    page,
    readFileSync(page, "utf8").replace(
      '<script type="module" src="main.js"></script>',
      '<script type="module" src="main.js"></script>\n<script type="module" src="probe.js"></script>',
    ),
  );
  writeFileSync(path.join(staging, "background", "probe.js"), probeSource());

  const popup = path.join(staging, "popup", "popup.js");
  writeFileSync(
    popup,
    `${readFileSync(popup, "utf8")}
const REPORT = ${JSON.stringify(COLLECTOR)} + "/popup";
const errors = [];
addEventListener("error", (e) => errors.push(String(e.message)));
addEventListener("unhandledrejection", (e) => errors.push(String(e.reason)));
setTimeout(() => {
  const rows = [...document.querySelectorAll("#countries li[data-code]")];
  fetch(REPORT, {
    method: "POST",
    body: JSON.stringify({
      errors,
      title: document.getElementById("statusTitle").textContent,
      tone: document.getElementById("status").dataset.tone,
      focused: document.activeElement && document.activeElement.id ? document.activeElement.id : null,
      toggleDisabled: document.getElementById("enabled").disabled,
      countryRows: rows.length,
      selected: document.querySelector('#countries [aria-selected="true"]')?.dataset.code ?? null,
      retryHidden: document.getElementById("retry").hidden,
    }),
  });
}, 1200);
`,
  );
}

function probeSource() {
  return `import * as router from "./router.js";

const COLLECTOR = ${JSON.stringify(COLLECTOR)};
const CHAIN = [
  { host: "localhost", ip: "127.0.0.1", port: ${DEAD_PORT} },
  { host: "localhost", ip: "127.0.0.1", port: ${LIVE_PORT} },
];

/** .invalid never resolves, so reaching anything at all proves a proxy was used. */
const UNROUTABLE = "https://marker.invalid/ping";
/** Resolves and answers, so a failure here can only come from the extension. */
const REACHABLE = "https://example.com/";

const mark = (name) => fetch(\`\${COLLECTOR}/mark/\${name}\`, { cache: "no-store" });

async function attempt(url) {
  const start = Date.now();
  try {
    const res = await fetch(url, { cache: "no-store" });
    return { outcome: "answered", status: res.status, ms: Date.now() - start };
  } catch (err) {
    return { outcome: String(err && err.message), ms: Date.now() - start };
  }
}

/**
 * main.js detaches the proxy listener while the extension is off, and off is the
 * default. Waiting for that detach is how the probe knows boot has settled;
 * then it attaches the very same decide function, so the real hot path is under test.
 */
async function takeOverProxyListener() {
  for (let i = 0; i < 100; i++) {
    if (!browser.proxy.onRequest.hasListener(router.decide)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (browser.proxy.onRequest.hasListener(router.decide)) return false;
  browser.proxy.onRequest.addListener(router.decide, { urls: ["<all_urls>"] });
  return true;
}

(async () => {
  const out = {};
  try {
    browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html"), active: false });
    out.listenerAttached = await takeOverProxyListener();
    router.setArmed(true);
    router.setFailClosed(true);
    router.setBypass([]);
    await mark("start");

    router.setRoute(CHAIN, ${JSON.stringify(AUTH)});
    out.routed = await attempt(UNROUTABLE);
    await mark("routed");

    out.hola = await attempt("https://client.hola.org/client_cgi/vpn_countries.json?browser=chrome");
    await mark("hola");

    router.clearRoute();
    out.failClosed = await attempt(REACHABLE);
    await mark("blocked");

    router.setArmed(false);
    out.disarmed = await attempt(REACHABLE);
    await mark("disarmed");
  } catch (err) {
    out.error = String(err && err.stack);
  }
  await fetch(\`\${COLLECTOR}/report\`, { method: "POST", body: JSON.stringify(out) });
})();
`;
}
