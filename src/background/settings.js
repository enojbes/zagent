/**
 * @typedef {"direct" | "pool" | "lum" | "peer" | "virt"} ProxyType
 *
 * @typedef {object} Settings
 * @property {boolean}  enabled
 * @property {string}   country     Hola country code, e.g. "tr". Not always ISO 3166 ("uk").
 * @property {ProxyType} proxyType
 * @property {boolean}  failClosed  Error the request out when no tunnel is up, rather than
 *                                  falling back to the real connection.
 * @property {boolean}  blockWebRTC Stop WebRTC from opening non-proxied UDP sockets.
 * @property {boolean}  noPrediction Stop DNS prefetch and speculative connections.
 * @property {string[]} bypass      Hostnames kept off the tunnel. An entry also covers
 *                                  its subdomains.
 * @property {string[]} recent      Recently chosen countries, most recent first.
 */

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  enabled: false,
  country: "tr",
  proxyType: "direct",
  failClosed: true,
  blockWebRTC: true,
  noPrediction: true,
  bypass: [],
  recent: [],
});

/** Shown until the first vpn_countries.json fetch lands. */
export const SEED_COUNTRIES = Object.freeze([
  "ae", "ar", "at", "au", "bd", "be", "bg", "br", "ca", "ch", "cl", "co",
  "cz", "de", "dk", "eg", "es", "fi", "fr", "gr", "hk", "hr", "hu", "id",
  "ie", "il", "in", "is", "it", "jp", "kr", "mx", "nl", "no", "nz", "pl",
  "pt", "ro", "ru", "sa", "se", "sg", "sk", "tr", "uk", "us", "ve",
]);

/** Enough to cover the two or three places someone actually switches between. */
export const RECENT_MAX = 4;

const KEY = "settings";
const COUNTRIES_KEY = "countries";

/** @returns {Promise<Settings>} */
export async function load() {
  const stored = await browser.storage.local.get(KEY);
  return sanitize(stored[KEY]);
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function save(patch) {
  const before = await load();
  const merged = { ...before, ...patch };
  if (typeof patch.country === "string" && patch.country !== before.country) {
    merged.recent = [patch.country, ...before.recent.filter((c) => c !== patch.country)].slice(0, RECENT_MAX);
  }
  const next = sanitize(merged);
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

/** @returns {Promise<{ codes: string[], fetchedAt: number }>} */
export async function loadCountries() {
  const stored = await browser.storage.local.get(COUNTRIES_KEY);
  const c = stored[COUNTRIES_KEY];
  if (!c || !Array.isArray(c.codes) || c.codes.length === 0) {
    return { codes: [...SEED_COUNTRIES], fetchedAt: 0 };
  }
  return c;
}

/** @param {string[]} codes */
export async function saveCountries(codes) {
  await browser.storage.local.set({
    [COUNTRIES_KEY]: { codes, fetchedAt: Date.now() },
  });
}

const PROXY_TYPES = new Set(["direct", "pool", "lum", "peer", "virt"]);

/**
 * Storage is the boundary: anything read back from it is untrusted, because an
 * older build or a hand-edited profile can put any shape there.
 *
 * @param {unknown} raw
 * @returns {Settings}
 */
function sanitize(raw) {
  const v = raw && typeof raw === "object" ? /** @type {any} */ (raw) : {};
  return {
    enabled: v.enabled === true,
    country: isCountryCode(v.country) ? v.country : DEFAULTS.country,
    proxyType: PROXY_TYPES.has(v.proxyType) ? v.proxyType : DEFAULTS.proxyType,
    failClosed: v.failClosed !== false,
    blockWebRTC: v.blockWebRTC !== false,
    noPrediction: v.noPrediction !== false,
    bypass: Array.isArray(v.bypass) ? normalizeBypass(v.bypass) : [],
    recent: Array.isArray(v.recent) ? v.recent.filter(isCountryCode).slice(0, RECENT_MAX) : [],
  };
}

/** @param {unknown} c */
function isCountryCode(c) {
  return typeof c === "string" && /^[a-z]{2}$/.test(c);
}

/**
 * @param {unknown[]} list
 * @returns {string[]}
 */
export function normalizeBypass(list) {
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^\*?\./, "")
      .replace(/^[a-z]+:\/\//, "")
      .replace(/[/:?#].*$/, "");
    if (host.length !== 0 && !out.includes(host)) out.push(host);
  }
  return out;
}
