import { test } from "node:test";
import assert from "node:assert/strict";

const SRC = new URL("../src/background/router.js", import.meta.url).href;

let instance = 0;
/** A fresh module per test, so one test's route never leaks into the next. */
const fresh = () => import(`${SRC}?n=${instance++}`);

const req = (url) => ({ url });

const TUNNELS = [
  { host: "zagent417.hola.org", ip: "31.210.91.240", port: 22225 },
  { host: "zagent1867.hola.org", ip: "94.101.87.40", port: 22225 },
];
const AUTH = "basic dXNlci11dWlkLXh4eC1pc19wcmVtLTA6a2V5";

test("hostOf agrees with the URL parser on normalized specs", async () => {
  const { hostOf } = await fresh();
  const corpus = [
    "https://example.com/",
    "https://example.com",
    "https://example.com:8443/a/b?c=d#e",
    "http://sub.domain.example.co.uk/path",
    "https://user:pass@example.com/p",
    "https://user@example.com:8443/p",
    "https://user:p@ss@example.com/p",
    "http://127.0.0.1:3000/",
    "http://[::1]:8080/x",
    "https://[2001:db8::1]/",
    "https://[fe80::1]",
    "wss://socket.example.com/ws",
    "https://xn--bcher-kva.example/",
    "https://BÜCHER.example/",
    "https://EXAMPLE.COM/Path",
    "https://example.com?q=a://b",
    "https://example.com#frag://x",
    "ftp://files.example.org/pub",
    "file:///etc/hosts",
    "https://example.com:/p",
  ];

  for (const raw of corpus) {
    const spec = new URL(raw).href;
    const expected = new URL(raw).hostname || null;
    assert.equal(hostOf(spec), expected, `for ${spec}`);
  }
});

test("hostOf returns null for specs with no authority", async () => {
  const { hostOf } = await fresh();
  assert.equal(hostOf("about:blank"), null);
  assert.equal(hostOf("data:text/plain,hello"), null);
  assert.equal(hostOf("moz-extension://abc/popup.html"), "abc");
  assert.equal(hostOf("https://[::1/x"), null);
});

test("isPrivate covers loopback, RFC 1918, link-local and local suffixes", async () => {
  const { isPrivate } = await fresh();
  for (const h of [
    "localhost",
    "dev.localhost",
    "printer.local",
    "db.internal",
    "router.home.arpa",
    "a.test",
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "[::1]",
    "[fe80::1]",
    "[fd00::1]",
    "[fc00::abcd]",
  ]) {
    assert.equal(isPrivate(h), true, `${h} should be private`);
  }

  for (const h of [
    "example.com",
    "172.32.0.1",
    "172.15.0.1",
    "192.169.1.1",
    "11.0.0.1",
    "8.8.8.8",
    "1localhost.example",
    "notlocalhost",
    "[2001:db8::1]",
    "999.1.1.1",
    "10.0.0",
  ]) {
    assert.equal(isPrivate(h), false, `${h} should not be private`);
  }
});

test("a live route is one entry per agent, terminated when fail-closed", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.setFailClosed(true);
  r.setRoute(TUNNELS, AUTH);

  const chain = r.decide(req("https://example.com/"));
  assert.equal(chain.length, 3);
  assert.deepEqual(chain[0], {
    type: "https",
    host: "zagent417.hola.org",
    port: 22225,
    proxyAuthorizationHeader: AUTH,
    failoverTimeout: 5,
  });
  assert.equal(chain[1].host, "zagent1867.hola.org");
  assert.equal(chain[2], null, "a trailing null stops Gecko falling back to the real connection");
});

test("the same array instance is reused across requests", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.setRoute(TUNNELS, AUTH);
  assert.equal(r.decide(req("https://a.example/")), r.decide(req("https://b.example/")));
});

test("toggling fail-closed adds and removes the terminator without a rehandshake", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.setFailClosed(true);
  r.setRoute(TUNNELS, AUTH);
  assert.equal(r.decide(req("https://example.com/")).length, 3);

  r.setFailClosed(false);
  assert.equal(r.decide(req("https://example.com/")).length, 2);

  r.setFailClosed(true);
  assert.equal(r.decide(req("https://example.com/")).at(-1), null);
});

test("the Hola API, private hosts and bypassed hosts skip the tunnel", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.setRoute(TUNNELS, AUTH);
  r.setBypass(["bank.example", "corp.internal.test"]);

  const direct = { type: "direct" };
  assert.deepEqual(r.decide(req("https://client.hola.org/client_cgi/zgettunnels?x=1")), direct);
  assert.deepEqual(r.decide(req("http://127.0.0.1:8080/")), direct);
  assert.deepEqual(r.decide(req("http://localhost:3000/")), direct);
  assert.deepEqual(r.decide(req("https://bank.example/login")), direct);
  assert.deepEqual(r.decide(req("https://www.bank.example/login")), direct);
  assert.deepEqual(r.decide(req("https://a.b.bank.example/login")), direct);
  assert.notDeepEqual(r.decide(req("https://notbank.example/")), direct);
  assert.notDeepEqual(r.decide(req("https://example.com/")), direct);
});

test("with no route, fail-closed blackholes and fail-open goes direct", async () => {
  const closed = await fresh();
  closed.setArmed(true);
  closed.setFailClosed(true);
  const blocked = closed.decide(req("https://example.com/"));
  assert.equal(blocked.at(-1), null);
  assert.equal(blocked[0].host, "127.0.0.1");
  assert.equal(blocked[0].port, 1);

  const open = await fresh();
  open.setArmed(true);
  open.setFailClosed(false);
  assert.deepEqual(open.decide(req("https://example.com/")), { type: "direct" });
});

test("disarming drops the route so nothing keeps tunnelling", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.setRoute(TUNNELS, AUTH);
  r.setArmed(false);
  assert.deepEqual(r.decide(req("https://example.com/")), { type: "direct" });
});

test("requests park on an in-flight handshake instead of leaking", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.setFailClosed(true);

  let land;
  r.holdFor(new Promise((resolve) => (land = resolve)));

  const parked = r.decide(req("https://example.com/"));
  assert.ok(parked instanceof Promise);

  r.setRoute(TUNNELS, AUTH);
  land();
  assert.equal((await parked).at(-1), null);
  assert.equal((await parked)[0].host, "zagent417.hola.org");
});

test("a failed handshake resolves parked requests to the fail-closed blackhole", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.setFailClosed(true);

  r.holdFor(Promise.reject(new Error("no route to host")));
  const parked = await r.decide(req("https://example.com/"));
  assert.equal(parked[0].host, "127.0.0.1");
  assert.equal(parked.at(-1), null);
});

test("the Hola API is never parked, or the handshake would deadlock", async () => {
  const r = await fresh();
  r.setArmed(true);
  r.holdFor(new Promise(() => {}));
  assert.deepEqual(r.decide(req("https://client.hola.org/client_cgi/background_init?uuid=x")), { type: "direct" });
});
