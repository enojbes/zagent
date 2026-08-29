/**
 * Client for the three Hola endpoints a tunnel needs. Ported from
 * Snawoot/hola-proxy (holaapi.go), with the differences noted at `openIdentity`
 * and `PORT_FIELD`.
 *
 * The split between `openIdentity` and `fetchTunnels` matters: one identity
 * serves any number of countries. Minting a new one per country switch is what
 * gets an IP temporarily banned.
 *
 * @typedef {object} Identity
 * @property {string} uuid
 * @property {number} sessionKey
 * @property {string} extVer
 *
 * @typedef {object} Tunnel
 * @property {string} host  TLS name of the agent, e.g. "zagent417.hola.org".
 * @property {string} ip    Agent address. Diagnostics only; Firefox resolves `host` itself.
 * @property {number} port
 *
 * @typedef {object} Credentials
 * @property {Tunnel[]} tunnels
 * @property {string} authHeader  Ready-to-send Proxy-Authorization value.
 */

const CCGI = "https://client.hola.org/client_cgi/";
export const API_HOST = "client.hola.org";

const BROWSER = "chrome";
const PRODUCT = "cws";
const TUNNEL_LIMIT = 3;

/**
 * Seed only. `background_init` answers with the version it actually expects, so
 * hola-proxy's Chrome Web Store lookup is not needed here.
 */
const SEED_EXT_VER = "1.258.48";

/** Hola flags an IP that mints identities in a burst. Hammering it makes that worse. */
const BAN_COOLDOWN_MS = 5 * 60_000;

/**
 * hola-proxy defaults to the trial ports and so do we: measured against a live
 * tr agent, `direct`, `peer`, `trial` and `trial_peer` all tunnel, while `hola`
 * answers 403 Forbidden Host.
 */
const PORT_FIELD = { direct: "trial", pool: "trial", lum: "trial", virt: "trial", peer: "trial_peer" };

export class HolaError extends Error {
  /** @param {string} message @param {{ permanent?: boolean, retryAfterMs?: number }} [opts] */
  constructor(message, opts = {}) {
    super(message);
    this.name = "HolaError";
    this.permanent = opts.permanent === true;
    this.retryAfterMs = opts.retryAfterMs ?? 0;
  }
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string[]>} Hola country codes, lowercase.
 */
export async function fetchCountries(signal) {
  const res = await request(`${CCGI}vpn_countries.json?browser=${BROWSER}`, { method: "GET", signal });
  const list = await res.json();
  if (!Array.isArray(list)) throw new HolaError("vpn_countries.json was not a list");
  return list.filter((c) => typeof c === "string").map((c) => c.toLowerCase());
}

/**
 * Mints a user id and session key. Hola's answer also carries the extension
 * version it currently expects, which is where the next call gets `ext_ver`.
 *
 * @param {{ extVer?: string, signal?: AbortSignal }} opts
 * @returns {Promise<Identity>}
 */
export async function openIdentity({ extVer = SEED_EXT_VER, signal } = {}) {
  const uuid = randomUuidHex();
  const res = await request(`${CCGI}background_init?uuid=${uuid}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: "1", ver: extVer }).toString(),
  });
  const init = await res.json();
  throwIfBlocked(init);
  if (typeof init.key !== "number") throw new HolaError("background_init returned no session key");

  return {
    uuid,
    sessionKey: init.key,
    extVer: typeof init.ver === "string" && init.ver.length !== 0 ? init.ver : extVer,
  };
}

/**
 * @param {{ identity: Identity, country: string, proxyType: import("./settings.js").ProxyType, signal?: AbortSignal }} opts
 * @returns {Promise<Credentials>}
 */
export async function fetchTunnels({ identity, country, proxyType, signal }) {
  const query = new URLSearchParams({
    country: countryParam(country, proxyType),
    limit: String(TUNNEL_LIMIT),
    ping_id: String(Math.random()),
    ext_ver: identity.extVer,
    browser: BROWSER,
    product: PRODUCT,
    uuid: identity.uuid,
    session_key: String(identity.sessionKey),
    is_premium: "0",
  });
  const res = await request(`${CCGI}zgettunnels?${query}`, { method: "POST", signal });
  const body = await res.json();
  throwIfBlocked(body);

  const tunnels = readTunnels(body, proxyType);
  if (tunnels.length === 0) throw new HolaError(`Hola returned no usable tunnel for "${country}"`);
  if (typeof body.agent_key !== "string") throw new HolaError("zgettunnels returned no agent key");

  return { tunnels, authHeader: basicAuth(`user-uuid-${identity.uuid}-is_prem-0`, body.agent_key) };
}

/** @param {any} body */
function throwIfBlocked(body) {
  if (body?.blocked !== true) return;
  if (body.permanent === true) {
    throw new HolaError("Hola has permanently blocked this IP address", { permanent: true });
  }
  throw new HolaError("Hola has temporarily blocked this IP address", { retryAfterMs: BAN_COOLDOWN_MS });
}

/**
 * @param {any} body
 * @param {string} proxyType
 * @returns {Tunnel[]}
 */
function readTunnels(body, proxyType) {
  const ipList = body?.ip_list;
  const port = body?.port?.[PORT_FIELD[proxyType] ?? "trial"];
  if (!ipList || typeof ipList !== "object" || typeof port !== "number") return [];

  const protocol = body.protocol ?? {};
  const out = [];
  for (const host of Object.keys(ipList)) {
    if (String(protocol[host]).toLowerCase() !== "http") continue;
    out.push({ host, ip: String(ipList[host]), port });
  }
  return out;
}

/**
 * @param {string} country
 * @param {string} proxyType
 */
function countryParam(country, proxyType) {
  switch (proxyType) {
    case "lum":
      return `${country}.pool_lum_${country}_shared`;
    case "virt":
      return `${country}.pool_virt_pool_${country}`;
    case "pool":
      return `${country}.pool`;
    default:
      return country;
  }
}

/**
 * @param {string} url
 * @param {RequestInit} init
 */
async function request(url, init) {
  const res = await fetch(url, { ...init, credentials: "omit", cache: "no-store" });
  if (!res.ok) throw new HolaError(`${url.slice(CCGI.length).split("?")[0]} answered ${res.status}`);
  return res;
}

/** hola-proxy sends a lowercase scheme and Hola's agents accept it; keep it identical. */
function basicAuth(login, password) {
  return "basic " + btoa(`${login}:${password}`);
}

/** 32 hex characters, the same shape hola-proxy derives from a v4 UUID. */
function randomUuidHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  for (let i = 0; i < 16; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
