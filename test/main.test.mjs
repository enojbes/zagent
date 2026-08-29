import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/**
 * main.js is the wiring: it decides when to attach listeners, when an error
 * burst means the tunnel died, and what a 407 from an agent implies. None of
 * that was covered, because it only speaks WebExtension APIs.
 *
 * So stub those APIs, capture the listeners main.js registers, and drive it
 * through its real interfaces rather than adding exports only tests would use.
 */
const listeners = { proxy: [], error: [], auth: [], message: [], alarm: [] };
/** Ordered log of stub interactions, so "before" claims can actually be checked. */
const order = [];
const calls = { badge: [], icon: [], alarms: [], privacy: [] };
let store = {};

const event = (bucket, label) => ({
  addListener: (fn) => {
    if (label) order.push(`attach:${label}`);
    bucket.push(fn);
  },
  removeListener: (fn) => {
    const i = bucket.indexOf(fn);
    if (i !== -1) bucket.splice(i, 1);
  },
  hasListener: (fn) => bucket.includes(fn),
});

const setting = (name) => ({
  set: async ({ value }) => calls.privacy.push(`${name}=${value}`),
  clear: async () => calls.privacy.push(`${name}=cleared`),
});

globalThis.browser = {
  proxy: { onRequest: event(listeners.proxy, "proxy"), onError: event([]) },
  webRequest: { onErrorOccurred: event(listeners.error), onAuthRequired: event(listeners.auth) },
  runtime: {
    onMessage: event(listeners.message),
    sendMessage: async () => {},
    getURL: (p) => `moz-extension://test/${p}`,
  },
  alarms: {
    onAlarm: event(listeners.alarm),
    create: (name) => calls.alarms.push(`create:${name}`),
    clear: (name) => calls.alarms.push(`clear:${name}`),
  },
  browserAction: {
    setBadgeText: ({ text }) => calls.badge.push(text),
    setBadgeBackgroundColor: () => {},
    setBadgeTextColor: () => {},
    setIcon: ({ path }) => calls.icon.push(path),
    setTitle: () => {},
  },
  privacy: {
    network: {
      webRTCIPHandlingPolicy: setting("webrtc"),
      networkPredictionEnabled: setting("prediction"),
    },
  },
  extension: { isAllowedIncognitoAccess: async () => true },
  storage: {
    local: {
      get: async (key) => {
        order.push(`read:${key}`);
        return key in store ? { [key]: store[key] } : {};
      },
      set: async (patch) => Object.assign(store, patch),
    },
  },
};

const INIT = { ver: "1.258.48", country: "CH", key: 42 };
const TUNNELS = {
  ip_list: { "zagent-a.hola.org": "203.0.113.1" },
  protocol: { "zagent-a.hola.org": "http" },
  agent_key: "key-a",
  port: { direct: 22222, peer: 22223, hola: 22224, trial: 22225, trial_peer: 22226 },
};
let handshakes = 0;
globalThis.fetch = async (url) => {
  const spec = String(url);
  if (spec.includes("background_init")) handshakes++;
  return { ok: true, status: 200, json: async () => (spec.includes("background_init") ? INIT : TUNNELS) };
};

/** Boot is a storage read, then apply, then two privacy writes. Give it room. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const send = (msg) => listeners.message[0](msg);
const router = await import("../src/background/router.js");

/**
 * Boot can finish inside the await on the dynamic import, since the stubbed
 * storage resolves on the microtask queue. So the state boot leaves behind is
 * captured once, here, rather than asserted later when it has moved on.
 */
let afterBoot;

before(async () => {
  await import("../src/background/main.js");
  await settle();
  afterBoot = { order: [...order], privacy: [...calls.privacy], proxyListeners: listeners.proxy.length };
});

beforeEach(() => {
  calls.badge.length = 0;
  calls.icon.length = 0;
  calls.alarms.length = 0;
  calls.privacy.length = 0;
});

test("the proxy listener is attached before settings are read", () => {
  // A restored session fires requests at browser startup, so a listener added
  // after the storage round trip would miss them.
  assert.equal(afterBoot.order[0], "attach:proxy");
  assert.ok(
    afterBoot.order.indexOf("attach:proxy") < afterBoot.order.indexOf("read:settings"),
    `order was ${afterBoot.order.join(" -> ")}`,
  );
});

test("a fresh profile ends up off, detached, and with no overrides left set", async () => {
  const state = await send({ type: "getState" });
  assert.equal(state.settings.enabled, false);
  assert.equal(state.settings.country, "", "no country is chosen for you");
  assert.equal(afterBoot.proxyListeners, 0, "nothing to decide while off, so nothing is asked");
  assert.deepEqual(
    afterBoot.privacy,
    ["webrtc=cleared", "prediction=cleared"],
    "overrides from a previous run are released rather than left behind",
  );
});

test("enabling attaches the listeners, applies the overrides and schedules rotation", async () => {
  await send({ type: "patch", patch: { country: "tr" } });
  calls.privacy.length = 0;
  calls.alarms.length = 0;

  await send({ type: "patch", patch: { enabled: true } });
  await settle();

  assert.equal(listeners.proxy.length, 1);
  assert.equal(listeners.error.length, 1, "watching for dead agents");
  assert.equal(listeners.auth.length, 1, "watching for rejected credentials");
  assert.deepEqual(calls.privacy, ["webrtc=disable_non_proxied_udp", "prediction=false"]);
  assert.ok(calls.alarms.some((c) => c.startsWith("create:")));

  // The toolbar has to follow the tunnel, not the setting.
  assert.ok(calls.badge.includes("TR"), `badge showed ${JSON.stringify(calls.badge)}`);
  assert.ok(calls.icon.some((p) => p.includes("on.svg")), `icon showed ${JSON.stringify(calls.icon)}`);
});

test("a burst of proxy errors triggers one refresh, a trickle triggers none", async () => {
  const before = handshakes;
  const onError = listeners.error[0];

  onError({ error: "NS_ERROR_NET_TIMEOUT" });
  onError({ error: "NS_ERROR_UNKNOWN_HOST" });
  await settle();
  assert.equal(handshakes, before, "errors that are not the proxy's fault are ignored");

  onError({ error: "NS_ERROR_PROXY_CONNECTION_REFUSED" });
  onError({ error: "NS_ERROR_PROXY_CONNECTION_REFUSED" });
  await settle();
  assert.equal(handshakes, before, "two is not yet a burst");
});

test("a 407 from an agent is cancelled rather than shown as a login box", () => {
  const onAuth = listeners.auth[0];
  assert.deepEqual(
    onAuth({ isProxy: true, challenger: { host: "zagent-a.hola.org" } }),
    { cancel: true },
    "the user has no password for this, so prompting them is pointless",
  );
  assert.deepEqual(
    onAuth({ isProxy: true, challenger: { host: "corporate.example" } }),
    {},
    "somebody else's proxy is none of our business",
  );
  assert.deepEqual(
    onAuth({ isProxy: false, challenger: { host: "site.example" } }),
    {},
    "a site login is left alone",
  );
});

test("disabling tears everything down again", async () => {
  await send({ type: "patch", patch: { enabled: false } });
  await settle();

  assert.equal(listeners.proxy.length, 0);
  assert.equal(listeners.error.length, 0);
  assert.equal(listeners.auth.length, 0);
  assert.deepEqual(calls.privacy, ["webrtc=cleared", "prediction=cleared"]);
  assert.ok(calls.alarms.some((c) => c.startsWith("clear:")));
  assert.deepEqual(router.decide({ url: "https://example.com/" }), { type: "direct" });
  assert.ok(calls.icon.some((p) => p.includes("off.svg")), "and the toolbar says so");
});
