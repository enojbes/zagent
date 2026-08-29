/**
 * @typedef {"direct" | "pool" | "lum" | "peer" | "virt"} ProxyType
 *
 * @typedef {object} Settings
 * @property {boolean}  enabled
 * @property {string}   country     Hola country code, e.g. "tr". Not always ISO 3166 ("uk").
 *                                  Empty until the user picks one; the tunnel cannot arm without it.
 * @property {ProxyType} proxyType
 * @property {boolean}  failClosed  Error the request out when no tunnel is up, rather than
 *                                  falling back to the real connection.
 * @property {boolean}  blockWebRTC Stop WebRTC from opening non-proxied UDP sockets.
 * @property {boolean}  noPrediction Stop DNS prefetch and speculative connections.
 * @property {string[]} bypass      Hostnames kept off the tunnel. An entry also covers
 *                                  its subdomains.
 * @property {string[]} pinned      Countries the user pinned to the top of the list.
 */

/** @type {Readonly<Settings>} */
export const DEFAULTS = Object.freeze({
  enabled: false,
  country: "",
  proxyType: "direct",
  failClosed: true,
  blockWebRTC: true,
  noPrediction: true,
  bypass: [],
  pinned: [],
});

/** Shown until the first vpn_countries.json fetch lands. */
export const SEED_COUNTRIES = Object.freeze([
  "ae", "ar", "at", "au", "bd", "be", "bg", "br", "ca", "ch", "cl", "co",
  "cz", "de", "dk", "eg", "es", "fi", "fr", "gr", "hk", "hr", "hu", "id",
  "ie", "il", "in", "is", "it", "jp", "kr", "mx", "nl", "no", "nz", "pl",
  "pt", "ro", "ru", "sa", "se", "sg", "sk", "tr", "uk", "us", "ve",
]);

/** A pinned list longer than this stops being a shortcut. */
export const PINNED_MAX = 8;

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
  const next = sanitize({ ...(await load()), ...patch });
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

/**
 * Pinning is deliberately manual. Ordering the list by what you happened to use
 * last guesses at a workflow; a pin is something you decided.
 *
 * @param {string} code
 * @returns {Promise<Settings>}
 */
export async function togglePinned(code) {
  const current = (await load()).pinned;
  const pinned = current.includes(code) ? current.filter((c) => c !== code) : [...current, code];
  return save({ pinned });
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
  const country = isCountryOrUnset(v.country) ? v.country : DEFAULTS.country;
  return {
    // There is nowhere to connect to without a country, so the two cannot
    // disagree. This is the only place that invariant needs enforcing.
    enabled: v.enabled === true && country !== "",
    country,
    proxyType: PROXY_TYPES.has(v.proxyType) ? v.proxyType : DEFAULTS.proxyType,
    failClosed: v.failClosed !== false,
    blockWebRTC: v.blockWebRTC !== false,
    noPrediction: v.noPrediction !== false,
    bypass: Array.isArray(v.bypass) ? normalizeBypass(v.bypass) : [],
    pinned: Array.isArray(v.pinned) ? [...new Set(v.pinned.filter(isCountryCode))].slice(0, PINNED_MAX) : [],
  };
}

/** @param {unknown} c */
function isCountryCode(c) {
  return typeof c === "string" && /^[a-z]{2}$/.test(c);
}

/** @param {unknown} c */
function isCountryOrUnset(c) {
  return c === "" || isCountryCode(c);
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
