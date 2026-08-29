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
  direct: "Hola's own datacenter servers. Fastest, and nobody else's traffic touches your connection.",
  pool: "A shared datacenter pool. Same trade-offs as datacenter.",
  lum: "A residential IP from Bright Data's shared pool. Harder for sites to block, slower.",
  peer: "Routes through another Hola user's home connection, and theirs may route through yours.",
  virt: "A virtual pool Hola only populates for a few countries.",
};
const RISKY_TYPES = new Set(["peer", "lum"]);

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
  el.search.focus();
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
  const country = `${flagOf(state.country || settings.country)} ${nameOf(state.country || settings.country)}`;
  let tone = "off";
  let title = "Off";
  let detail = `Traffic is going out on your own address. Ready to connect to ${country}.`;

  if (state.status === "on") {
    tone = "good";
    title = `Connected · ${nameOf(state.country)}`;
    detail = `via ${state.agents[0] ?? "an agent"}`;
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
  el.check.disabled = state.status !== "on";

  if (state.status !== "on") {
    el.exitValue.textContent = "Exit address unknown while disconnected";
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
  const all = snapshot.countries.map((code) => ({ code, name: nameOf(code) }));
  const match = (c) => query === "" || c.name.toLowerCase().includes(query) || c.code.includes(query);

  const recent = query === "" ? snapshot.settings.recent.filter((code) => snapshot.countries.includes(code)) : [];
  const recentSet = new Set(recent);
  const rest = all.filter((c) => match(c) && !recentSet.has(c.code)).sort((a, b) => a.name.localeCompare(b.name));

  rows = [...recent.map((code) => ({ code, name: nameOf(code) })), ...rest];
  cursor = rows.findIndex((r) => r.code === selected);

  const frag = document.createDocumentFragment();
  if (rows.length === 0) frag.append(plain("empty", "No match"));
  rows.forEach((row, index) => {
    if (recent.length !== 0 && index === recent.length) frag.append(plain("divider", "All countries"));
    frag.append(option(row, selected));
  });
  el.countries.replaceChildren(frag);
  paintCursor();
}

function option({ code, name }, selected) {
  const li = document.createElement("li");
  li.id = `country-${code}`;
  li.dataset.code = code;
  li.setAttribute("role", "option");
  li.setAttribute("aria-selected", String(code === selected));
  li.append(span("flag", flagOf(code)), span("name", name), span("code", code));
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
  if (code === (pendingCountry ?? snapshot.settings.country)) return;
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
  patch({ country: code });
}

async function reconnect() {
  await browser.storage.local.remove(EXIT_KEY);
  apply(await browser.runtime.sendMessage({ type: "refresh" }));
}

async function patch(values) {
  apply(await browser.runtime.sendMessage({ type: "patch", patch: values }));
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
    el.check.disabled = snapshot.state.status !== "on";
  }
}
