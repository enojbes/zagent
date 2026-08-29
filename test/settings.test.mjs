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

test("choosing a country pushes it to the front of the recent list", async () => {
  await settings.save({ country: "de" });
  await settings.save({ country: "nl" });
  await settings.save({ country: "tr" });
  assert.deepEqual((await settings.load()).recent, ["tr", "nl", "de"]);

  await settings.save({ country: "nl" });
  assert.deepEqual((await settings.load()).recent, ["nl", "tr", "de"], "no duplicates, most recent first");
});

test("the recent list is capped and survives unrelated saves", async () => {
  for (const c of ["de", "nl", "us", "gr", "jp"]) await settings.save({ country: c });
  const recent = (await settings.load()).recent;
  assert.equal(recent.length, settings.RECENT_MAX);
  assert.deepEqual(recent, ["jp", "gr", "us", "nl"]);

  await settings.save({ blockWebRTC: false });
  assert.deepEqual((await settings.load()).recent, recent, "toggling something else leaves it alone");
});

test("a garbage recent list from storage is discarded", async () => {
  store.settings = { recent: ["tr", 7, "not-a-country", "de"] };
  assert.deepEqual((await settings.load()).recent, ["tr", "de"]);
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
