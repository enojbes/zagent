import { normalizeBypass } from "../background/settings.js";

const $ = (id) => document.getElementById(id);
const el = {
  enabled: $("enabled"),
  status: $("status"),
  statusTitle: $("statusTitle"),
  statusDetail: $("statusDetail"),
  privateWarning: $("privateWarning"),
  exitValue: $("exitValue"),
  check: $("check"),
  search: $("search"),
  countries: $("countries"),
  proxyType: $("proxyType"),
  typeNote: $("typeNote"),
  failClosed: $("failClosed"),
  blockWebRTC: $("blockWebRTC"),
  noPrediction: $("noPrediction"),
  bypass: $("bypass"),
  reconnect: $("reconnect"),
  retry: $("retry"),
};

const EXIT_KEY = "lastExit";
const regionNames = new Intl.DisplayNames([navigator.language, "en"], { type: "region" });

/** Hola says "uk" where ISO 3166 says "GB". Everything else lines up. */
const toRegion = (code) => (code === "uk" ? "GB" : code.slice(0, 2).toUpperCase());

const nameOf = (code) => {
  try {
    return regionNames.of(toRegion(code)) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
};

const flagOf = (code) =>
  String.fromCodePoint(...[...toRegion(code)].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

const TYPE_NOTES = {
  direct:
    "Hola's own datacenter servers. Fastest, and nothing of your connection is shared with anyone. Verified working; this is the one to use.",
  pool: "A shared pool of datacenter servers. Undocumented upstream and untested here.",
  lum: "A home address rented from Bright Data's shared pool. Harder for sites to block, and slower, but you are borrowing a stranger's line.",
  peer: "Routes through another Hola user's home connection. Undocumented upstream, and the arrangement is meant to run both ways.",
  virt: "A pool Hola appears to fill only for Brazil and Japan. Expect it to fail everywhere else.",
};
const RISKY_TYPES = new Set(["peer", "lum"]);
const TYPE_LABELS = {
  direct: "Datacenter",
  pool: "Datacenter pool",
  lum: "Residential",
  peer: "Peer",
  virt: "Virtual pool",
};

/** @type {{ state: any, settings: any, countries: string[], privateAllowed: boolean } | null} */
let snapshot = null;
/** Rows currently rendered, so the keyboard cursor and click handler agree. */
let rows = [];
let cursor = -1;
let pendingCountry = null;
let pickTimer = null;

init();

async function init() {
  apply(await browser.runtime.sendMessage({ type: "getState" }));
  wire();
  revealSelected();
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "state" && snapshot !== null) {
    apply({ ...snapshot, state: msg.state, settings: msg.settings });
  }
  if (msg?.type === "countries" && snapshot !== null) {
    apply({ ...snapshot, countries: msg.codes });
  }
});

function apply(next) {
  snapshot = next;
  const { state, settings, privateAllowed } = next;

  el.enabled.checked = settings.enabled;
  el.enabled.disabled = settings.country === "";
  el.proxyType.value = settings.proxyType;
  el.failClosed.checked = settings.failClosed;
  el.blockWebRTC.checked = settings.blockWebRTC;
  el.noPrediction.checked = settings.noPrediction;
  if (document.activeElement !== el.bypass) el.bypass.value = settings.bypass.join("\n");
  paintTypeNote(settings.proxyType);

  el.privateWarning.hidden = privateAllowed !== false || !settings.enabled;

  paintStatus(state, settings);
  paintExit(state);
  renderCountries();
}

/**
 * The switch reflects the setting. This reflects what is happening to traffic,
 * which diverges exactly when it matters: a tunnel that is down either blocks
 * everything or quietly puts you back on your own address.
 */
function paintStatus(state, settings) {
  if (settings.country === "") {
    el.status.dataset.tone = "off";
    el.statusTitle.textContent = "No country chosen";
    el.statusDetail.textContent = "Pick one below, then switch the tunnel on.";
    el.retry.hidden = true;
    return;
  }

  const country = `${flagOf(state.country || settings.country)} ${nameOf(state.country || settings.country)}`;
  let tone = "off";
  let title = "Off";
  let detail = `Traffic is going out on your own address. Ready to connect to ${country}.`;

  if (state.status === "on") {
    const agent = state.agents[0] ?? "an agent";
    const asked = state.country !== settings.country || state.proxyType !== settings.proxyType;
    tone = state.stale ? "wait" : "good";
    title = `Connected · ${nameOf(state.country)}`;
    if (!state.stale) {
      detail = `via ${agent}`;
    } else if (asked) {
      // Saying "connected" while quietly serving a different country than the
      // one selected would be the same lie the status block exists to prevent.
      detail =
        `Could not switch to ${nameOf(settings.country)} ${TYPE_LABELS[settings.proxyType] ?? settings.proxyType}, ` +
        `Hola is unreachable. Still on ${nameOf(state.country)} ${TYPE_LABELS[state.proxyType] ?? state.proxyType} ` +
        `via ${agent}. Retrying ${whenFrom(state.retryAt)}.`;
    } else {
      detail = `via ${agent}. Could not reach Hola to refresh; retrying ${whenFrom(state.retryAt)}.`;
    }
  } else if (state.status === "connecting") {
    tone = "wait";
    title = "Connecting";
    detail = `Opening a tunnel to ${country}. Traffic is held until it is up.`;
  } else if (state.status === "error") {
    tone = "bad";
    title = settings.failClosed ? "Traffic blocked" : "Not protected";
    detail = settings.failClosed
      ? `${explain(state)} Requests fail until a tunnel is up.`
      : `${explain(state)} Traffic is going out on your own address.`;
  }

  el.status.dataset.tone = tone;
  el.statusTitle.textContent = title;
  el.statusDetail.textContent = detail;

  // Retrying through a block is what causes blocks, so only offer it when the
  // failure is something a retry could plausibly fix.
  el.retry.hidden = state.status !== "error" || isBlock(state);
}

/** @param {{ error: string | null }} state */
function isBlock(state) {
  return /blocked this IP address/i.test(state.error ?? "");
}

/** @param {{ error: string | null, fatal: boolean, retryAt: number | null }} state */
function explain(state) {
  const reason = isBlock(state)
    ? state.fatal
      ? "Hola has permanently blocked this address."
      : "Hola has temporarily blocked this address."
    : "Could not reach Hola.";
  const next = state.fatal
    ? " Retrying will not help; try again from a different network."
    : ` Trying again ${whenFrom(state.retryAt)}.`;
  return reason + next;
}

/** @param {number | null} at Epoch ms. */
function whenFrom(at) {
  const seconds = at === null ? 0 : Math.round((at - Date.now()) / 1000);
  if (seconds <= 1) return "now";
  if (seconds < 90) return `in ${seconds}s`;
  return `in ${Math.round(seconds / 60)} min`;
}

/**
 * A checked exit address only describes the agent it was checked through, so it
 * is thrown away as soon as the chain changes.
 */
async function paintExit(state) {
  const stored = (await browser.storage.local.get(EXIT_KEY))[EXIT_KEY];
  const agent = state.agents[0];

  // A control that cannot do anything should not be on screen looking clickable.
  el.check.hidden = state.status !== "on";
  if (state.status !== "on") {
    el.exitValue.textContent = "";
    return;
  }
  if (!stored || stored.agent !== agent) {
    el.exitValue.textContent = "Exit address not checked";
    return;
  }
  el.exitValue.textContent = `Seen as ${stored.ip} in ${stored.country}, checked ${ageOf(stored.at)}`;
}

function ageOf(at) {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function paintTypeNote(type) {
  el.typeNote.textContent = TYPE_NOTES[type] ?? "";
  el.typeNote.classList.toggle("warn", RISKY_TYPES.has(type));
}

function renderCountries() {
  const query = el.search.value.trim().toLowerCase();
  const selected = pendingCountry ?? snapshot.settings.country;
  const pinned = new Set(snapshot.settings.pinned);
  const match = (c) => query === "" || c.name.toLowerCase().includes(query) || c.code.includes(query);
  const all = snapshot.countries
    .map((code) => ({ code, name: nameOf(code), pinned: pinned.has(code) }))
    .filter(match)
    .sort((a, b) => a.name.localeCompare(b.name));

  // Pins only lead the list when it is the whole list. Once you are searching,
  // a match buried under pins is worse than plain alphabetical order.
  const lead = query === "" ? all.filter((c) => c.pinned) : [];
  const rest = query === "" ? all.filter((c) => !c.pinned) : all;

  rows = [...lead, ...rest];
  cursor = rows.findIndex((r) => r.code === selected);

  const frag = document.createDocumentFragment();
  if (rows.length === 0) frag.append(plain("empty", "No match"));
  rows.forEach((row, index) => {
    if (lead.length !== 0 && index === lead.length) frag.append(plain("divider", "All countries"));
    frag.append(option(row, selected));
  });
  el.countries.replaceChildren(frag);
  paintCursor();
}

function option({ code, name, pinned }, selected) {
  const li = document.createElement("li");
  li.id = `country-${code}`;
  li.dataset.code = code;
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(code === selected));

  const pin = document.createElement("button");
  pin.type = "button";
  pin.className = "pin";
  pin.dataset.pin = code;
  pin.textContent = pinned ? "★" : "☆";
  pin.setAttribute("aria-pressed", String(pinned));
  pin.title = pinned ? `Unpin ${name}` : `Pin ${name} to the top`;
  pin.setAttribute("aria-label", pin.title);

  li.append(span("flag", flagOf(code)), span("name", name), span("code", code), pin);
  return li;
}

function plain(className, text) {
  const li = document.createElement("li");
  li.className = className;
  li.textContent = text;
  return li;
}

function span(className, text) {
  const s = document.createElement("span");
  s.className = className;
  s.textContent = text;
  return s;
}

function paintCursor() {
  for (const li of el.countries.querySelectorAll("li[data-code]")) {
    li.classList.toggle("active", li.dataset.code === rows[cursor]?.code);
  }
  el.search.setAttribute("aria-activedescendant", cursor === -1 ? "" : `country-${rows[cursor].code}`);
}

/** Opening on Argentina while you are connected through Turkey helps nobody. */
function revealSelected() {
  el.countries.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "center" });
}

function moveCursor(delta) {
  if (rows.length === 0) return;
  cursor = (cursor + delta + rows.length) % rows.length;
  paintCursor();
  el.countries.querySelector(`#country-${rows[cursor].code}`)?.scrollIntoView({ block: "nearest" });
}

function wire() {
  el.enabled.addEventListener("change", () => patch({ enabled: el.enabled.checked }));

  el.search.addEventListener("input", () => {
    renderCountries();
    if (el.search.value.trim() !== "") {
      cursor = 0;
      paintCursor();
    }
  });

  el.search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") moveCursor(1);
    else if (event.key === "ArrowUp") moveCursor(-1);
    else if (event.key === "Enter" && rows[cursor] !== undefined) pickCountry(rows[cursor].code);
    else if (event.key === "Escape" && el.search.value !== "") el.search.value = "";
    else return;
    event.preventDefault();
    if (event.key === "Escape") renderCountries();
  });

  el.countries.addEventListener("click", (event) => {
    const pin = event.target.closest("[data-pin]");
    if (pin !== null) {
      patch(null, { type: "pin", code: pin.dataset.pin });
      return;
    }
    const code = event.target.closest("li")?.dataset.code;
    if (code !== undefined) pickCountry(code);
  });

  el.proxyType.addEventListener("change", () => {
    paintTypeNote(el.proxyType.value);
    patch({ proxyType: el.proxyType.value });
  });

  for (const key of ["failClosed", "blockWebRTC", "noPrediction"]) {
    el[key].addEventListener("change", () => patch({ [key]: el[key].checked }));
  }

  el.bypass.addEventListener("change", () => {
    const hosts = normalizeBypass(el.bypass.value.split("\n"));
    el.bypass.value = hosts.join("\n");
    patch({ bypass: hosts });
  });

  // The popup no longer steals focus on open, so typing anywhere still reaches
  // the filter. Keyboard users keep the shortcut without the search field
  // looking like an open dropdown every time the popup appears.
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key.length !== 1) return;
    if (document.activeElement !== document.body) return;
    el.search.focus();
  });

  el.retry.addEventListener("click", reconnect);
  el.reconnect.addEventListener("click", reconnect);
  el.check.addEventListener("click", verifyExit);
  window.addEventListener("pagehide", commitPick);
}

/**
 * Every country change costs a zgettunnels call, and Hola blocks an address that
 * makes a burst of them. Running down the list should cost one, not one per row.
 * Closing the popup commits the last pick, so a click then a close is not lost.
 */
function pickCountry(code) {
  const already = code === (pendingCountry ?? snapshot.settings.country) && snapshot.settings.enabled;
  if (already) return;
  pendingCountry = code;
  renderCountries();
  if (pickTimer !== null) clearTimeout(pickTimer);
  pickTimer = setTimeout(commitPick, 400);
}

function commitPick() {
  if (pickTimer !== null) clearTimeout(pickTimer);
  pickTimer = null;
  if (pendingCountry === null) return;
  const code = pendingCountry;
  pendingCountry = null;
  // Picking a country is the act of connecting to it, so this switches on too.
  patch({ country: code, enabled: true });
}

async function reconnect() {
  await browser.storage.local.remove(EXIT_KEY);
  apply(await browser.runtime.sendMessage({ type: "refresh" }));
}

/**
 * @param {object | null} values Settings to change, or null when sending `message`.
 * @param {object} [message] A message other than a settings patch.
 */
async function patch(values, message) {
  apply(await browser.runtime.sendMessage(message ?? { type: "patch", patch: values }));
}

async function verifyExit() {
  const agent = snapshot.state.agents[0];
  el.check.disabled = true;
  el.exitValue.textContent = "Checking…";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12_000);
  try {
    const res = await fetch("https://ipinfo.io/json", { cache: "no-store", signal: abort.signal });
    const info = await res.json();
    await browser.storage.local.set({
      [EXIT_KEY]: { ip: info.ip, country: info.country ?? "?", agent, at: Date.now() },
    });
    await paintExit(snapshot.state);
  } catch {
    el.exitValue.textContent = "Exit address check got no answer";
  } finally {
    clearTimeout(timer);
    el.check.disabled = false;
  }
}
