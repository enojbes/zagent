/**
 * The hot path. `decide` runs once per network channel in the browser, so it
 * allocates nothing: the ProxyInfo array is built once per session and the same
 * instance is handed back on every call.
 *
 * Firefox reads that array as a failover chain and, once it runs off the end,
 * falls back to whatever proxy the browser itself would have used. A trailing
 * `null` truncates the chain instead, which is what makes fail-closed work. See
 * `createProxyInfoFromData` in Gecko's ProxyChannelFilter.sys.mjs.
 */

import { API_HOST } from "./hola.js";

/**
 * @typedef {object} ProxyInfo
 * @property {string} type
 * @property {string} [host]
 * @property {number} [port]
 * @property {string} [proxyAuthorizationHeader]
 * @property {number} [failoverTimeout]
 *
 * @typedef {(ProxyInfo | null)[]} Chain
 */

const DIRECT = { type: "direct" };

/**
 * Live agents answered a CONNECT in 0.5-2.6s when measured. Gecko's own default
 * is 10s, long enough that one dead agent stalls a page load visibly.
 */
const FAILOVER_TIMEOUT_SEC = 5;

/**
 * Port 1 needs root to bind, so this is refused immediately and a fail-closed
 * request errors out instead of hanging. The trailing null is what stops Gecko
 * from quietly falling back to the real connection.
 *
 * @type {Chain}
 */
const BLACKHOLE = [{ type: "http", host: "127.0.0.1", port: 1 }, null];

/** @type {Chain | null} */
let route = null;
/** @type {Promise<Chain | ProxyInfo> | null} */
let pending = null;
/** True while the extension intends to proxy, including before the first tunnel is up. */
let armed = false;
let failClosed = true;
/** @type {Set<string>} */
let bypass = new Set();

/** @param {boolean} value */
export function setArmed(value) {
  armed = value;
  if (!value) clearRoute();
}

/**
 * Gecko writes each field back over itself while validating (`type` to `type`,
 * `port` to `Number.parseInt(port)`), so handing the same objects back on every
 * request is safe as well as free.
 *
 * @param {import("./hola.js").Tunnel[]} tunnels
 * @param {string} authHeader
 */
export function setRoute(tunnels, authHeader) {
  const chain = tunnels.map((t) => ({
    type: "https",
    host: t.host,
    port: t.port,
    proxyAuthorizationHeader: authHeader,
    failoverTimeout: FAILOVER_TIMEOUT_SEC,
  }));
  if (failClosed) chain.push(null);
  route = chain;
  pending = null;
}

export function clearRoute() {
  route = null;
  pending = null;
}

/**
 * Parks requests on `work` while a handshake is in flight, rather than leaking
 * them onto the real connection. Gecko awaits whatever the listener returns.
 *
 * @param {Promise<unknown>} work
 */
export function holdFor(work) {
  const held = work.then(settle, settle);
  pending = held;

  function settle() {
    if (pending === held) pending = null;
    return route ?? pending ?? fallback();
  }
}

/** @param {boolean} value */
export function setFailClosed(value) {
  failClosed = value;
  if (route === null) return;
  const terminated = route[route.length - 1] === null;
  if (value && !terminated) route = [...route, null];
  else if (!value && terminated) route = route.slice(0, -1);
}

/** @param {string[]} hosts */
export function setBypass(hosts) {
  bypass = new Set(hosts);
}

/**
 * @param {{ url: string }} details
 * @returns {ProxyInfo | Chain | Promise<Chain | ProxyInfo>}
 */
export function decide(details) {
  const host = hostOf(details.url);
  if (host === null || host === API_HOST) return DIRECT;
  if (isPrivate(host)) return DIRECT;
  if (bypass.size !== 0 && isBypassed(host)) return DIRECT;
  return route ?? pending ?? fallback();
}

function fallback() {
  return armed && failClosed ? BLACKHOLE : DIRECT;
}

/**
 * Hostname of an absolute URL, without building a URL object. Gecko hands the
 * listener an already-normalized spec, so this splits and never canonicalizes.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function hostOf(url) {
  const scheme = url.indexOf("://");
  if (scheme === -1) return null;
  const start = scheme + 3;
  const len = url.length;

  let authorityEnd = len;
  for (let i = start; i < len; i++) {
    const c = url.charCodeAt(i);
    if (c === 47 || c === 63 || c === 35) {
      authorityEnd = i;
      break;
    }
  }

  let hostStart = start;
  for (let i = authorityEnd - 1; i >= start; i--) {
    if (url.charCodeAt(i) === 64) {
      hostStart = i + 1;
      break;
    }
  }

  if (url.charCodeAt(hostStart) === 91) {
    const close = url.indexOf("]", hostStart);
    if (close === -1 || close >= authorityEnd) return null;
    return url.slice(hostStart, close + 1).toLowerCase();
  }

  let hostEnd = authorityEnd;
  for (let i = hostStart; i < authorityEnd; i++) {
    if (url.charCodeAt(i) === 58) {
      hostEnd = i;
      break;
    }
  }
  return hostEnd === hostStart ? null : url.slice(hostStart, hostEnd).toLowerCase();
}

/**
 * A bypass entry covers its subdomains. Scanning the entries beats walking the
 * host's parent domains, because slicing off each label would allocate on a path
 * that runs for every request.
 */
function isBypassed(host) {
  if (bypass.has(host)) return true;
  for (const entry of bypass) {
    const offset = host.length - entry.length;
    if (offset > 0 && host.charCodeAt(offset - 1) === 46 && host.endsWith(entry)) return true;
  }
  return false;
}

const LOCAL_SUFFIXES = [".local", ".localhost", ".internal", ".home.arpa", ".test"];

/**
 * Loopback, link-local and RFC 1918 never belong on a public proxy. That is not
 * a user preference, so it is not part of the bypass list.
 *
 * @param {string} host
 */
export function isPrivate(host) {
  const first = host.charCodeAt(0);
  if (first === 91) return isPrivateV6(host.slice(1, -1).toLowerCase());
  if (first >= 48 && first <= 57) return isPrivateV4(host);
  if (host === "localhost") return true;
  for (let i = 0; i < LOCAL_SUFFIXES.length; i++) {
    if (host.endsWith(LOCAL_SUFFIXES[i])) return true;
  }
  return false;
}

/** @param {string} host */
function isPrivateV4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false;
    octets[i] = Number(parts[i]);
    if (octets[i] > 255) return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** @param {string} addr Bracket-stripped, lowercase. */
function isPrivateV6(addr) {
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true;
  return /^fe[89ab]/.test(addr);
}
