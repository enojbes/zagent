/**
 * Measures the only code that runs on every network request in the browser.
 *
 * Two numbers matter. What `decide` costs per request, and whether hand-rolling
 * the hostname split off the URL string is worth keeping over `new URL()`.
 */
import { decide, hostOf, setArmed, setBypass, setFailClosed, setRoute } from "../src/background/router.js";

const URLS = [
  "https://www.example.com/",
  "https://cdn.example.com/assets/app.8f3a2c.js",
  "https://api.example.org/v2/items?page=3&sort=name",
  "https://images.example.net/a/b/c/d/photo.jpg?w=1200&h=800&fit=crop",
  "https://sub.domain.example.co.uk/path/to/a/fairly/deep/resource",
  "https://analytics.tracker.example/collect?v=2&tid=UA-1&cid=abc#x",
  "http://192.168.1.14:8123/api/states",
  "http://localhost:5173/@vite/client",
  "https://client.hola.org/client_cgi/zgettunnels?country=tr",
  "https://bank.example/accounts/overview",
  "wss://realtime.example.com/socket?token=abcdefghijklmnop",
  "https://user:secret@legacy.example.com:8443/old/endpoint",
];

setArmed(true);
setFailClosed(true);
setBypass([]);
setRoute(
  [
    { host: "zagent417.hola.org", ip: "31.210.91.240", port: 22225 },
    { host: "zagent1867.hola.org", ip: "94.101.87.40", port: 22225 },
    { host: "zagent1733.hola.org", ip: "94.101.87.41", port: 22225 },
  ],
  "basic dXNlci11dWlkLWFhYWEtaXNfcHJlbS0wOmtleQ==",
);

const requests = URLS.map((url) => ({ url }));

report("decide, no bypass list (the default)", () => {
  for (let i = 0; i < requests.length; i++) decide(requests[i]);
});

setBypass(["bank.example", "intranet.corp", "git.internal.example", "mail.example.org"]);
report("decide, 4 bypass entries", () => {
  for (let i = 0; i < requests.length; i++) decide(requests[i]);
});

report("hostOf", () => {
  for (let i = 0; i < URLS.length; i++) hostOf(URLS[i]);
});

report("new URL().hostname", () => {
  for (let i = 0; i < URLS.length; i++) new URL(URLS[i]).hostname;
});

/**
 * @param {string} label
 * @param {() => void} pass One pass over the whole URL list.
 */
function report(label, pass) {
  for (let i = 0; i < 2000; i++) pass();

  const runs = [];
  for (let run = 0; run < 7; run++) {
    const iterations = 50_000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) pass();
    runs.push(Number(process.hrtime.bigint() - start) / (iterations * URLS.length));
  }
  runs.sort((a, b) => a - b);
  const median = runs[runs.length >> 1];
  console.log(`${label.padEnd(38)} ${median.toFixed(1).padStart(6)} ns/request   ${Math.round(1e9 / median).toLocaleString("en-US").padStart(12)} req/s`);
}
