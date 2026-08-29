import { test } from "node:test";
import assert from "node:assert/strict";
import * as hola from "../src/background/hola.js";

/** Captured verbatim from a live zgettunnels call for country=tr. */
const TUNNELS_BODY = {
  ztun: { tr: ["HTTP zagent417.hola.org:22222"] },
  ip_list: {
    "zagent417.hola.org": "31.210.91.240",
    "zagent1867.hola.org": "94.101.87.40",
    "zagent9999.hola.org": "203.0.113.9",
  },
  agent_types: { tr: "hola" },
  protocol: {
    "zagent417.hola.org": "http",
    "zagent1867.hola.org": "http",
    "zagent9999.hola.org": "quic",
  },
  vendor: {},
  agent_key: "1454e7f2a977",
  port: { direct: 22222, peer: 22223, hola: 22224, trial: 22225, trial_peer: 22226 },
};

const INIT_OK = { body: { ver: "1.258.48", country: "CH", key: 3775278831 } };
const IDENTITY = { uuid: "9c6d55a67a64478a9d82aae7fb84acd5", sessionKey: 3775278831, extVer: "1.258.48" };

function stubFetch(responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unscripted fetch: ${url}`);
    return { ok: next.status === undefined || next.status < 400, status: next.status ?? 200, json: async () => next.body };
  };
  return calls;
}

test("openIdentity mints a uuid and reports back the version Hola expects", async () => {
  const calls = stubFetch([INIT_OK]);
  const identity = await hola.openIdentity({ extVer: "1.0.0" });

  assert.equal(calls[0].url.pathname, "/client_cgi/background_init");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "login=1&ver=1.0.0");
  assert.match(identity.uuid, /^[0-9a-f]{32}$/);
  assert.equal(calls[0].url.searchParams.get("uuid"), identity.uuid);
  assert.equal(identity.sessionKey, 3775278831);
  assert.equal(identity.extVer, "1.258.48", "the seed version is replaced by the one Hola named");
});

test("two identities do not share a uuid", async () => {
  stubFetch([INIT_OK, INIT_OK]);
  const a = await hola.openIdentity();
  const b = await hola.openIdentity();
  assert.notEqual(a.uuid, b.uuid);
});

test("fetchTunnels sends the identity Hola issued", async () => {
  const calls = stubFetch([{ body: TUNNELS_BODY }]);
  await hola.fetchTunnels({ identity: IDENTITY, country: "tr", proxyType: "direct" });

  const query = calls[0].url.searchParams;
  assert.equal(calls[0].url.pathname, "/client_cgi/zgettunnels");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(query.get("uuid"), IDENTITY.uuid);
  assert.equal(query.get("session_key"), "3775278831");
  assert.equal(query.get("ext_ver"), "1.258.48");
  assert.equal(query.get("browser"), "chrome");
  assert.equal(query.get("product"), "cws");
  assert.equal(query.get("is_premium"), "0");
  assert.equal(query.get("limit"), "3");
});

test("one identity serves any number of countries", async () => {
  const calls = stubFetch([{ body: TUNNELS_BODY }, { body: TUNNELS_BODY }]);
  await hola.fetchTunnels({ identity: IDENTITY, country: "tr", proxyType: "direct" });
  await hola.fetchTunnels({ identity: IDENTITY, country: "de", proxyType: "direct" });

  assert.equal(calls.length, 2, "no background_init in between");
  assert.deepEqual(calls.map((c) => c.url.searchParams.get("country")), ["tr", "de"]);
});

test("only agents that speak HTTP survive, on the trial port", async () => {
  stubFetch([{ body: TUNNELS_BODY }]);
  const creds = await hola.fetchTunnels({ identity: IDENTITY, country: "tr", proxyType: "direct" });

  assert.deepEqual(
    creds.tunnels,
    [
      { host: "zagent417.hola.org", ip: "31.210.91.240", port: 22225 },
      { host: "zagent1867.hola.org", ip: "94.101.87.40", port: 22225 },
    ],
    "the quic agent is dropped",
  );
});

test("peer traffic uses the trial_peer port", async () => {
  stubFetch([{ body: TUNNELS_BODY }]);
  const creds = await hola.fetchTunnels({ identity: IDENTITY, country: "tr", proxyType: "peer" });
  assert.equal(creds.tunnels[0].port, 22226);
});

test("the auth header is basic auth over the templated login", async () => {
  stubFetch([{ body: TUNNELS_BODY }]);
  const creds = await hola.fetchTunnels({ identity: IDENTITY, country: "tr", proxyType: "direct" });

  const [scheme, payload] = creds.authHeader.split(" ");
  assert.equal(scheme, "basic");
  assert.equal(
    Buffer.from(payload, "base64").toString(),
    `user-uuid-${IDENTITY.uuid}-is_prem-0:1454e7f2a977`,
  );
});

test("each proxy type maps to its own country parameter", async () => {
  for (const [type, expected] of [
    ["direct", "tr"],
    ["peer", "tr"],
    ["pool", "tr.pool"],
    ["lum", "tr.pool_lum_tr_shared"],
    ["virt", "tr.pool_virt_pool_tr"],
  ]) {
    const calls = stubFetch([{ body: TUNNELS_BODY }]);
    await hola.fetchTunnels({ identity: IDENTITY, country: "tr", proxyType: type });
    assert.equal(calls[0].url.searchParams.get("country"), expected, `for ${type}`);
  }
});

test("a temporary block asks for a long cooldown, a permanent one is fatal", async () => {
  stubFetch([{ body: { blocked: true } }]);
  await assert.rejects(hola.openIdentity(), (err) => {
    assert.equal(err.permanent, false);
    assert.equal(err.retryAfterMs, 300_000, "retrying in seconds would make the block worse");
    assert.match(err.message, /temporarily blocked/);
    return true;
  });

  stubFetch([{ body: { blocked: true, permanent: true } }]);
  await assert.rejects(hola.openIdentity(), (err) => {
    assert.equal(err.permanent, true);
    return true;
  });
});

test("a block reported by zgettunnels is read as a block, not an empty answer", async () => {
  stubFetch([{ body: { blocked: true, permanent: false } }]);
  await assert.rejects(
    hola.fetchTunnels({ identity: IDENTITY, country: "tr", proxyType: "direct" }),
    /temporarily blocked/,
  );
});

test("an answer with no usable agent is an error, not an empty tunnel", async () => {
  stubFetch([{ body: { ip_list: {}, port: TUNNELS_BODY.port, agent_key: "k" } }]);
  await assert.rejects(
    hola.fetchTunnels({ identity: IDENTITY, country: "zz", proxyType: "direct" }),
    /no usable tunnel for "zz"/,
  );
});

test("an HTTP failure names the endpoint that failed", async () => {
  stubFetch([{ status: 503, body: {} }]);
  await assert.rejects(hola.openIdentity(), /background_init answered 503/);
});

test("fetchCountries lowercases and drops non-strings", async () => {
  stubFetch([{ body: ["TR", "us", 7, "de"] }]);
  assert.deepEqual(await hola.fetchCountries(undefined), ["tr", "us", "de"]);
});
