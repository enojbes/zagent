/**
 * Regenerates the popup screenshots in docs/img.
 *
 * Firefox's --screenshot fires at load, and the popup renders after an await,
 * so shooting it directly catches a half-drawn panel. This renders the popup
 * first, posts the settled markup back, and shoots that instead.
 *
 * Usage: node tools/capture-popup.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUT = path.join(ROOT, "docs", "img");
const STATES = ["on", "failopen"];
const SIZE = "340,430";

/** Every Firefox this script starts, so none outlive it. */
const started = new Set();

const stage = mkdtempSync(path.join(tmpdir(), "zagent-shots-"));
const profile = path.join(stage, "profile");
mkdirSync(profile);
mkdirSync(OUT, { recursive: true });
cpSync(path.join(ROOT, "src", "popup"), path.join(stage, "popup"), { recursive: true });
cpSync(path.join(ROOT, "src", "background"), path.join(stage, "background"), { recursive: true });

writeFileSync(path.join(stage, "popup", "shim.js"), shim());
const page = path.join(stage, "popup", "popup.html");
writeFileSync(
  page,
  readFileSync(page, "utf8").replace(
    '<script type="module" src="popup.js"></script>',
    '<script src="shim.js"></script>\n  <script type="module" src="popup.js"></script>',
  ),
);

const settled = new Map();
let notify = () => {};
const server = createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      settled.set(req.url.slice(1), body);
      res.writeHead(204).end();
      notify();
    });
    return;
  }
  const file = path.join(stage, decodeURIComponent(req.url.split("?")[0]));
  let body;
  try {
    body = readFileSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": type(file) }).end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

for (const state of STATES) {
  await render(state);
  const target = path.join(stage, "popup", `${state}.html`);
  writeFileSync(target, settled.get(state));
  await shoot(`${origin}/popup/${state}.html`, path.join(OUT, `popup-${state}.png`));
  console.log(`docs/img/popup-${state}.png`);
}

server.close();
rmSync(stage, { recursive: true, force: true });

function render(state) {
  return new Promise((resolve, reject) => {
    const child = firefox([`${origin}/popup/popup.html#${state}`]);
    const timer = setTimeout(() => {
      stop(child);
      reject(new Error(`${state} never settled`));
    }, 60_000);
    notify = () => {
      if (!settled.has(state)) return;
      clearTimeout(timer);
      stop(child);
      resolve();
    };
  });
}

function shoot(url, out) {
  return new Promise((resolve, reject) => {
    const child = firefox([`--screenshot=${out}`, url]);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`screenshot exited ${code}`))));
  });
}

/**
 * A private profile, so this never disturbs a Firefox the user already has open,
 * and detached so it leads its own process group. Firefox re-execs itself, so
 * signalling the process we spawned leaves the real one running.
 */
function firefox(args) {
  const child = spawn(
    "firefox",
    ["--headless", "--no-remote", "--profile", profile, "--window-size", SIZE, ...args],
    { stdio: "ignore", detached: true },
  );
  started.add(child);
  child.on("exit", () => started.delete(child));
  return child;
}

function stop(child) {
  started.delete(child);
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

process.on("exit", () => {
  for (const child of started) stop(child);
});

function type(file) {
  if (file.endsWith(".css")) return "text/css";
  if (file.endsWith(".js")) return "text/javascript";
  if (file.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

function shim() {
  return `const COUNTRIES = ${JSON.stringify(
    "ae ar at au bd be bg br ca ch cl co cz de dk eg es fi fr gr hk hr hu id ie il in is it jp kr mx nl no nz pl pt ro ru sa se sg sk tr uk us ve".split(" "),
  )};
const base = { enabled: true, country: "tr", proxyType: "direct", failClosed: true, blockWebRTC: true, noPrediction: true, bypass: [], recent: ["tr", "de", "us"] };
const agents = ["zagent417.hola.org"];
const STATES = {
  on: { state: { status: "on", country: "tr", agents, error: null, fatal: false, retryAt: null }, settings: base, privateAllowed: true },
  failopen: { state: { status: "error", country: "tr", agents: [], error: "NetworkError when attempting to fetch resource.", fatal: false, retryAt: Date.now() + 12000 }, settings: { ...base, failClosed: false }, privateAllowed: true },
};
const name = location.hash.slice(1) || "on";
const snapshot = { ...STATES[name], countries: COUNTRIES };
const mem = { lastExit: { ip: "94.101.87.40", country: "TR", agent: "zagent417.hola.org", at: Date.now() - 240000 } };
globalThis.browser = {
  runtime: { sendMessage: async () => snapshot, onMessage: { addListener() {} } },
  storage: { local: { get: async (k) => (k in mem ? { [k]: mem[k] } : {}), set: async (o) => Object.assign(mem, o), remove: async () => {} } },
};
addEventListener("load", () => setTimeout(() => {
  // checked is a property; outerHTML only serialises the attribute, so a live
  // toggle would come out looking off in the capture.
  document.querySelectorAll("input[type=checkbox]").forEach((i) => {
    i.toggleAttribute("checked", i.checked);
  });
  document.querySelectorAll("script").forEach((s) => s.remove());
  fetch("/" + name, { method: "POST", body: "<!doctype html>" + document.documentElement.outerHTML });
}, 900));
`;
}
