/**
 * Wiring. Everything that touches a WebExtension API lives here, which keeps the
 * modules it pulls in testable under plain Node.
 *
 * The proxy listener is registered at module load, before settings are read,
 * because a restored session starts firing requests immediately at browser
 * startup and a listener attached a few milliseconds later would miss them.
 */

import * as settings from "./settings.js";
import * as router from "./router.js";
import * as hola from "./hola.js";
import { Session } from "./session.js";

const ALL_URLS = { urls: ["<all_urls>"] };
const ROTATE_ALARM = "rotate-tunnel";
const ROTATE_MINUTES = 12 * 60;
const COUNTRY_TTL_MS = 24 * 60 * 60 * 1000;

/** Every agent in the chain unreachable, this many times over, means a stale list. */
const ERROR_BURST = 3;
const ERROR_WINDOW_MS = 60_000;

browser.proxy.onRequest.addListener(router.decide, ALL_URLS);
let proxyListenerAttached = true;

/** @type {settings.Settings} */
let current = settings.DEFAULTS;
const session = new Session(onStateChange);

let errorCount = 0;
let errorWindowStart = 0;
let rotationScheduled = false;

router.holdFor(boot());

async function boot() {
  await apply(await settings.load());
}

/** @param {settings.Settings} next */
async function apply(next) {
  current = next;
  router.setFailClosed(next.failClosed);
  router.setBypass(next.bypass);

  if (next.enabled) {
    attachProxyListener();
    attachRequestWatchers();
    session.start(next);
    scheduleRotation();
  } else {
    session.stop();
    detachProxyListener();
    detachRequestWatchers();
    browser.alarms.clear(ROTATE_ALARM);
    rotationScheduled = false;
  }

  await applyPrivacy(next);
}

/** Recreating the alarm restarts its period, so a chatty settings panel could hold rotation off forever. */
function scheduleRotation() {
  if (rotationScheduled) return;
  browser.alarms.create(ROTATE_ALARM, { periodInMinutes: ROTATE_MINUTES });
  rotationScheduled = true;
}

function attachProxyListener() {
  if (proxyListenerAttached) return;
  browser.proxy.onRequest.addListener(router.decide, ALL_URLS);
  proxyListenerAttached = true;
}

/** Leaving it attached would be cheap, but not being called at all is cheaper. */
function detachProxyListener() {
  if (!proxyListenerAttached) return;
  browser.proxy.onRequest.removeListener(router.decide);
  proxyListenerAttached = false;
}

function attachRequestWatchers() {
  if (browser.webRequest.onErrorOccurred.hasListener(onRequestError)) return;
  browser.webRequest.onErrorOccurred.addListener(onRequestError, ALL_URLS);
  browser.webRequest.onAuthRequired.addListener(onProxyAuthRequired, ALL_URLS, ["blocking"]);
}

function detachRequestWatchers() {
  browser.webRequest.onErrorOccurred.removeListener(onRequestError);
  browser.webRequest.onAuthRequired.removeListener(onProxyAuthRequired);
  errorCount = 0;
}

/**
 * Firefox has already failed over across every agent in the chain by the time it
 * reports this, so a burst means the whole tunnel list died, not one agent.
 *
 * @param {{ error?: string }} details
 */
function onRequestError(details) {
  if (typeof details.error !== "string" || !details.error.startsWith("NS_ERROR_PROXY")) return;
  if (session.state.status !== "on") return;

  const now = Date.now();
  if (now - errorWindowStart > ERROR_WINDOW_MS) {
    errorWindowStart = now;
    errorCount = 0;
  }
  if (++errorCount < ERROR_BURST) return;
  errorCount = 0;
  session.refresh("agents unreachable");
}

/**
 * A 407 from an agent means the credentials died early. Cancelling suppresses
 * Firefox's login prompt, which the user has no password for anyway.
 *
 * @param {{ isProxy?: boolean, challenger?: { host: string } }} details
 */
function onProxyAuthRequired(details) {
  if (details.isProxy !== true) return {};
  if (!String(details.challenger?.host ?? "").endsWith(".hola.org")) return {};
  session.refresh("credentials rejected", 10_000);
  return { cancel: true };
}

/** @param {settings.Settings} next */
async function applyPrivacy(next) {
  await set(browser.privacy.network.webRTCIPHandlingPolicy, next.enabled && next.blockWebRTC, "disable_non_proxied_udp");
  await set(browser.privacy.network.networkPredictionEnabled, next.enabled && next.noPrediction, false);

  async function set(setting, active, value) {
    try {
      if (active) await setting.set({ value });
      else await setting.clear({});
    } catch (err) {
      console.warn("[zagent] could not change a privacy setting:", err);
    }
  }
}

/** @param {import("./session.js").State} state */
function onStateChange(state) {
  paint(state);
  browser.runtime.sendMessage({ type: "state", state, settings: current }).catch(() => {});
}

/** @param {import("./session.js").State} state */
function paint(state) {
  const badge = { on: state.country.slice(0, 2).toUpperCase(), connecting: "...", error: "!", off: "" }[state.status];
  const color = { on: "#1f8a45", connecting: "#a06a00", error: "#b3261e", off: "#5f6368" }[state.status];

  browser.browserAction.setBadgeText({ text: badge });
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setBadgeTextColor?.({ color: "#ffffff" });
  browser.browserAction.setIcon({ path: state.status === "on" ? "/icons/on.svg" : "/icons/off.svg" });
  browser.browserAction.setTitle({
    title: state.status === "on" ? `Zagent: ${state.country.toUpperCase()} via ${state.agents[0] ?? "?"}` : `Zagent: ${state.status}`,
  });
}

browser.alarms.onAlarm.addListener((alarm) => {
  // Refreshes the agent list, deliberately on the same identity. Rotating it
  // while the address is unchanged unlinks nothing, because Hola correlates on
  // the address anyway, and every rotation is one more call to the endpoint that
  // rate-limits us.
  if (alarm.name === ROTATE_ALARM) session.refresh("scheduled agent refresh", 0);

});

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case "getState":
      refreshCountries().catch(() => {});
      return snapshot();
    case "patch":
      return settings.save(msg.patch).then(async (next) => {
        await apply(next);
        return snapshot();
      });
    case "pin":
      return settings.togglePinned(msg.code).then(async (next) => {
        current = next;
        return snapshot();
      });
    case "refresh":
      session.refresh("requested from the popup", 0);
      return snapshot();
    default:
      return undefined;
  }
});

async function snapshot() {
  return {
    state: session.state,
    settings: current,
    countries: (await settings.loadCountries()).codes,
    privateAllowed: await privateBrowsingAllowed(),
  };
}

/**
 * Without this permission Firefox never runs the extension in a private window,
 * so proxy.onRequest is never consulted there and the tunnel is silently skipped.
 * The user has to grant it in about:addons; nothing here can do it for them.
 */
async function privateBrowsingAllowed() {
  try {
    return await browser.extension.isAllowedIncognitoAccess();
  } catch {
    return true;
  }
}

/**
 * Never blocks the popup: it renders from the cached list and swaps in a fresh
 * one only if the fetch beats the user to a decision.
 */
async function refreshCountries() {
  const cached = await settings.loadCountries();
  if (Date.now() - cached.fetchedAt < COUNTRY_TTL_MS) return;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const codes = await hola.fetchCountries(abort.signal);
    if (codes.length === 0) return;
    await settings.saveCountries(codes);
    browser.runtime.sendMessage({ type: "countries", codes }).catch(() => {});
  } catch (err) {
    console.warn("[zagent] country list refresh failed:", err);
  } finally {
    clearTimeout(timer);
  }
}

paint(session.state);
