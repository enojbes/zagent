import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

let store = {};
globalThis.browser = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (patch) => Object.assign(store, patch),
    },
  },
};

const settings = await import("../src/background/settings.js");

beforeEach(() => {
  store = {};
});

test("empty storage yields the defaults", async () => {
  assert.deepEqual(await settings.load(), settings.DEFAULTS);
});

test("save merges a patch and hands back the result", async () => {
  const next = await settings.save({ country: "de", enabled: true });
  assert.equal(next.country, "de");
  assert.equal(next.enabled, true);
  assert.equal(next.proxyType, "direct");
  assert.deepEqual((await settings.load()).country, "de");
});

test("storage is treated as untrusted input", async () => {
  store.settings = {
    enabled: "yes",
    country: "not-a-country",
    proxyType: "socks",
    failClosed: "no",
    bypass: "example.com",
  };
  const loaded = await settings.load();
  assert.equal(loaded.enabled, false, "only a real boolean enables the tunnel");
  assert.equal(loaded.country, settings.DEFAULTS.country);
  assert.equal(loaded.proxyType, "direct");
  assert.equal(loaded.failClosed, true, "a non-false value keeps the safe default");
  assert.deepEqual(loaded.bypass, []);
});

test("protective settings stay on unless explicitly turned off", async () => {
  store.settings = { failClosed: false, blockWebRTC: false, noPrediction: false };
  const off = await settings.load();
  assert.equal(off.failClosed, false);
  assert.equal(off.blockWebRTC, false);
  assert.equal(off.noPrediction, false);

  store.settings = {};
  const on = await settings.load();
  assert.equal(on.failClosed, true);
  assert.equal(on.blockWebRTC, true);
  assert.equal(on.noPrediction, true);
});

test("there is no country until one is chosen", async () => {
  const fresh = await settings.load();
  assert.equal(fresh.country, "");
  assert.equal(fresh.enabled, false);
});

test("the tunnel cannot arm without somewhere to connect to", async () => {
  store.settings = { enabled: true, country: "" };
  assert.equal((await settings.load()).enabled, false, "enabled without a country is not a state");

  const chosen = await settings.save({ country: "tr" });
  assert.equal(chosen.enabled, false, "picking a country does not switch it on by itself");

  const armed = await settings.save({ enabled: true });
  assert.equal(armed.enabled, true);
});

test("pinning is manual and toggles", async () => {
  assert.deepEqual((await settings.load()).pinned, [], "nothing is pinned for you");

  await settings.togglePinned("tr");
  await settings.togglePinned("de");
  assert.deepEqual((await settings.load()).pinned, ["tr", "de"]);

  await settings.togglePinned("tr");
  assert.deepEqual((await settings.load()).pinned, ["de"], "pinning again unpins");
});

test("using a country does not pin it", async () => {
  await settings.save({ country: "de" });
  await settings.save({ country: "nl" });
  assert.deepEqual((await settings.load()).pinned, [], "the list reflects decisions, not history");
});

test("the pin list is capped, deduped and survives unrelated saves", async () => {
  store.settings = { pinned: ["tr", "tr", "de", "nl", "us", "gr", "jp", "it", "es", "fr", "pl"] };
  const pinned = (await settings.load()).pinned;
  assert.equal(pinned.length, settings.PINNED_MAX);
  assert.equal(new Set(pinned).size, pinned.length, "no duplicates");

  await settings.save({ blockWebRTC: false });
  assert.deepEqual((await settings.load()).pinned, pinned, "toggling something else leaves it alone");
});

test("a garbage pin list from storage is discarded", async () => {
  store.settings = { pinned: ["tr", 7, "not-a-country", "de"] };
  assert.deepEqual((await settings.load()).pinned, ["tr", "de"]);
});

test("bypass entries are reduced to bare hostnames", () => {
  assert.deepEqual(
    settings.normalizeBypass([
      "  Example.COM  ",
      "*.bank.example",
      ".cdn.example",
      "https://portal.example/login?a=b",
      "intranet:8080",
      "example.com",
      "",
      "   ",
      42,
    ]),
    ["example.com", "bank.example", "cdn.example", "portal.example", "intranet"],
  );
});
