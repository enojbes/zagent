import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/background/session.js";
import * as router from "../src/background/router.js";

const INIT = { ver: "1.258.48", country: "CH", key: 42 };
const tunnelsFor = (tag) => ({
  ip_list: { [`zagent-${tag}.hola.org`]: "203.0.113.1" },
  protocol: { [`zagent-${tag}.hola.org`]: "http" },
  agent_key: `key-${tag}`,
  port: { direct: 22222, peer: 22223, hola: 22224, trial: 22225, trial_peer: 22226 },
});

/** Dispatches on endpoint rather than call order, so a test never desyncs. */
let onInit;
let onTunnels;
let requests;

globalThis.fetch = async (url) => {
  const spec = String(url);
  requests.push(spec);
  const body = await (spec.includes("background_init") ? onInit : onTunnels)(new URL(spec));
  return { ok: true, status: 200, json: async () => body };
};

const uuidsUsed = () => [
  ...new Set(requests.map((r) => new URL(r).searchParams.get("uuid")).filter(Boolean)),
];
const countriesAsked = () =>
  requests.filter((r) => r.includes("zgettunnels")).map((r) => new URL(r).searchParams.get("country"));
const initCount = () => requests.filter((r) => r.includes("background_init")).length;
const settle = () => new Promise((resolve) => process.nextTick(resolve));

/** @type {Session} */
let session;

beforeEach(() => {
  requests = [];
  onInit = async () => INIT;
  onTunnels = async () => tunnelsFor("a");
  router.setArmed(false);
  router.setFailClosed(true);
  session = new Session(() => {});
});

const SETTINGS = { country: "tr", proxyType: "direct" };
const host = () => router.decide({ url: "https://example.com/" })[0].host;

test("start publishes a route and reports the agents it got", async () => {
  session.start(SETTINGS);
  assert.equal(session.state.status, "connecting");

  await settle();
  assert.equal(session.state.status, "on");
  assert.deepEqual(session.state.agents, ["zagent-a.hola.org"]);

  const chain = router.decide({ url: "https://example.com/" });
  assert.equal(chain[0].port, 22225);
  assert.equal(chain.at(-1), null);
});

test("start is a no-op once connected to the same country", async () => {
  session.start(SETTINGS);
  await settle();
  session.start(SETTINGS);
  assert.equal(requests.length, 2, "no second handshake");
});

test("switching country reuses the identity instead of minting a new one", async () => {
  session.start(SETTINGS);
  await settle();
  assert.equal(initCount(), 1);

  onTunnels = async () => tunnelsFor("de");
  session.start({ country: "de", proxyType: "direct" });
  await settle();

  assert.equal(initCount(), 1, "background_init is not repeated for a country change");
  assert.deepEqual(countriesAsked(), ["tr", "de"]);
  assert.equal(uuidsUsed().length, 1, "the same user id serves both countries");
  assert.equal(session.state.country, "de");
});

test("switching country drops the old route rather than serving stale traffic", async () => {
  session.start(SETTINGS);
  await settle();
  assert.equal(host(), "zagent-a.hola.org");

  onTunnels = async () => tunnelsFor("de");
  session.start({ country: "de", proxyType: "direct" });
  assert.ok(
    router.decide({ url: "https://example.com/" }) instanceof Promise,
    "requests park while the new tunnel opens",
  );

  await settle();
  assert.equal(host(), "zagent-de.hola.org");
});

test("a failed handshake retries with growing, jittered backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onTunnels = async () => {
    throw new Error("network down");
  };

  session.start(SETTINGS);
  await settle();
  assert.equal(session.state.status, "error");
  assert.match(session.state.error, /network down/);
  assert.equal(session.state.fatal, false);

  t.mock.timers.tick(5_000);
  await settle();
  assert.ok(requests.length > 2, "a retry fired within 3s plus jitter");

  onTunnels = async () => tunnelsFor("late");
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(session.state.status, "on", "backoff keeps trying until it lands");
});

test("a tunnel failure retires the identity so the retry starts clean", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onTunnels = async () => {
    throw new Error("agent list unavailable");
  };

  session.start(SETTINGS);
  await settle();
  assert.equal(initCount(), 1);

  onTunnels = async () => tunnelsFor("b");
  t.mock.timers.tick(5_000);
  await settle();

  assert.equal(initCount(), 2, "the retry mints a fresh session key");
  assert.equal(uuidsUsed().length, 2);
  assert.equal(session.state.status, "on");
});

test("a temporary block waits out its cooldown instead of hammering Hola", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onInit = async () => ({ blocked: true, permanent: false });

  session.start(SETTINGS);
  await settle();
  assert.match(session.state.error, /temporarily blocked/);

  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(requests.length, 1, "no retry inside the first minute");

  onInit = async () => INIT;
  t.mock.timers.tick(6 * 60_000);
  await settle();
  assert.equal(session.state.status, "on", "it retries once the cooldown is over");
});

test("repeated blocks double the wait instead of polling every five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onInit = async () => ({ blocked: true, permanent: false });

  const waits = [];
  session.start(SETTINGS);
  await settle();

  for (let round = 0; round < 5; round++) {
    waits.push((session.state.retryAt - Date.now()) / 60_000);
    t.mock.timers.tick(90 * 60_000);
    await settle();
  }

  // 5, 10, 20, 40, then capped at 60, each carrying up to 25% jitter either way.
  for (const [round, base] of [5, 10, 20, 40, 60].entries()) {
    assert.ok(
      waits[round] > base * 0.7 && waits[round] < base * 1.3,
      `round ${round} waited ${waits[round].toFixed(1)} min, expected about ${base}`,
    );
  }

  onInit = async () => INIT;
  t.mock.timers.tick(70 * 60_000);
  await settle();
  assert.equal(session.state.status, "on");
  assert.equal(session.state.retryAt, null, "a live tunnel has nothing scheduled");
});

test("an ordinary failure after a block starts from the short backoff again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onInit = async () => ({ blocked: true, permanent: false });

  session.start(SETTINGS);
  await settle();
  assert.ok(session.state.retryAt - Date.now() > 3 * 60_000, "a block waits minutes");

  onInit = async () => INIT;
  onTunnels = async () => {
    throw new Error("network down");
  };
  t.mock.timers.tick(70 * 60_000);
  await settle();
  assert.ok(session.state.retryAt - Date.now() < 30_000, "a plain failure waits seconds");
});

test("a permanent block stops the retry loop", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  onInit = async () => ({ blocked: true, permanent: true });

  session.start(SETTINGS);
  await settle();
  assert.equal(session.state.status, "error");
  assert.equal(session.state.fatal, true);

  t.mock.timers.tick(60 * 60_000);
  await settle();
  assert.equal(requests.length, 1, "no retry was scheduled");
});

test("refresh is rate limited so an error burst cannot hammer the API", async () => {
  session.start(SETTINGS);
  await settle();

  session.refresh("burst");
  await settle();
  assert.equal(requests.length, 2, "the rate limit swallows a refresh right after connecting");

  onTunnels = async () => tunnelsFor("b");
  session.refresh("forced", 0);
  await settle();
  assert.equal(session.state.agents[0], "zagent-b.hola.org");
  assert.equal(initCount(), 1, "a refresh keeps the identity");
});

test("rotation mints a new identity", async () => {
  session.start(SETTINGS);
  await settle();

  session.refresh("scheduled rotation", 0, true);
  await settle();
  assert.equal(initCount(), 2);
  assert.equal(uuidsUsed().length, 2);
});

test("a failed refresh keeps the working tunnel instead of tearing it down", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.start(SETTINGS);
  await settle();
  assert.equal(host(), "zagent-a.hola.org");

  // Agents keep proxying after Hola's API stops answering, which is exactly the
  // moment the old code threw away a tunnel that was still carrying traffic.
  onInit = async () => ({ blocked: true, permanent: false });
  onTunnels = async () => {
    throw new Error("should not be reached");
  };
  session.refresh("scheduled rotation", 0, true);
  await settle();

  assert.equal(session.state.status, "on", "still connected");
  assert.equal(session.state.stale, true, "but flagged as unrefreshed");
  assert.equal(host(), "zagent-a.hola.org", "traffic still flows through the live agent");
  assert.ok(session.state.retryAt > Date.now(), "a retry is scheduled");
});

test("a recovered refresh clears the stale flag", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.start(SETTINGS);
  await settle();

  onInit = async () => ({ blocked: true, permanent: false });
  session.refresh("rotation", 0, true);
  await settle();
  assert.equal(session.state.stale, true);

  onInit = async () => INIT;
  onTunnels = async () => tunnelsFor("b");
  t.mock.timers.tick(70 * 60_000);
  await settle();
  assert.equal(session.state.stale, false);
  assert.equal(host(), "zagent-b.hola.org");
});

test("a switch that cannot happen does not cost you the tunnel you had", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.start(SETTINGS);
  await settle();
  assert.equal(host(), "zagent-a.hola.org");

  // Hola blocks the address, then the user tries a different exit type.
  onInit = async () => ({ blocked: true, permanent: false });
  onTunnels = async () => ({ blocked: true, permanent: false });
  session.start({ country: "tr", proxyType: "lum" });
  await settle();

  assert.equal(session.state.status, "on", "the working tunnel survives the attempt");
  assert.equal(host(), "zagent-a.hola.org");
  assert.equal(session.state.proxyType, "direct", "state reports what is serving, not what was asked");
  assert.equal(session.state.stale, true);
});

test("the retry after a failed switch aims at what was asked for", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.start(SETTINGS);
  await settle();

  onInit = async () => ({ blocked: true, permanent: false });
  onTunnels = async () => ({ blocked: true, permanent: false });
  session.start({ country: "de", proxyType: "direct" });
  await settle();
  assert.equal(session.state.country, "tr", "still serving the old country");

  onInit = async () => INIT;
  onTunnels = async () => tunnelsFor("de");
  t.mock.timers.tick(70 * 60_000);
  await settle();

  assert.equal(session.state.country, "de", "the retry went for what the user wanted");
  assert.equal(session.state.stale, false);
  assert.equal(host(), "zagent-de.hola.org");
});

test("refreshing keeps the old route serving until the new one lands", async () => {
  session.start(SETTINGS);
  await settle();

  let land;
  const held = new Promise((resolve) => (land = resolve));
  onTunnels = async () => {
    await held;
    return tunnelsFor("b");
  };

  session.refresh("rotation", 0);
  await settle();
  assert.equal(host(), "zagent-a.hola.org", "traffic keeps flowing through the live tunnel");

  land();
  await settle();
  assert.equal(host(), "zagent-b.hola.org");
});

test("stop disarms the router", async () => {
  session.start(SETTINGS);
  await settle();

  session.stop();
  assert.equal(session.state.status, "off");
  assert.deepEqual(router.decide({ url: "https://example.com/" }), { type: "direct" });
});
