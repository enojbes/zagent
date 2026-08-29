/**
 * Owns the tunnel lifecycle: identity, handshake, retry, rotation, teardown. It
 * is the only writer of the router's route, and it keeps the previous route
 * serving traffic while a replacement handshake is in flight.
 *
 * The Hola identity outlives a country switch on purpose. Only `zgettunnels`
 * needs to run again when the country changes, and minting identities in a
 * burst is what gets an IP temporarily banned.
 *
 * @typedef {"off" | "connecting" | "on" | "error"} Status
 *
 * @typedef {object} State
 * @property {Status} status
 * @property {string} country
 * @property {import("./settings.js").ProxyType} proxyType
 * @property {string | null} error
 * @property {boolean} fatal     Retrying will not help; the user has to change something.
 * @property {boolean} stale     Connected, but the last refresh failed.
 * @property {string[]} agents   Agent hostnames currently in the chain.
 * @property {number | null} retryAt Epoch ms of the next scheduled attempt.
 * @property {number} since      Epoch ms of the last status change.
 */

import * as hola from "./hola.js";
import * as router from "./router.js";

const RETRY_BASE_MS = 3_000;
const RETRY_MAX_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * A block outlasts its first cooldown by a lot. One observed block was still in
 * place two hours after the burst that caused it, so each further block doubles
 * the wait rather than polling every five minutes for an afternoon.
 */
const BLOCK_MAX_MS = 60 * 60_000;

export class Session {
  /** @param {(state: State) => void} onChange */
  constructor(onChange) {
    this.onChange = onChange;
    /** @type {State} */
    this.state = { status: "off", country: "", proxyType: "direct", error: null, fatal: false, stale: false, agents: [], retryAt: null, since: Date.now() };
    /** @type {hola.Identity | null} */
    this.identity = null;
    /** @type {AbortController | null} */
    this.abort = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.retryTimer = null;
    this.attempt = 0;
    this.blocks = 0;
    this.lastRefreshAt = 0;
  }

  /**
   * Connects, or reconnects when the country or proxy type changed. Safe to call
   * repeatedly with the same settings; it becomes a no-op once connected.
   *
   * @param {import("./settings.js").Settings} settings
   */
  start(settings) {
    const sameTarget = this.state.country === settings.country && this.state.proxyType === settings.proxyType;
    if (sameTarget && (this.state.status === "on" || this.state.status === "connecting")) return;

    this.cancel();
    router.setArmed(true);
    router.clearRoute();
    this.attempt = 0;
    this.blocks = 0;
    this.set({ status: "connecting", country: settings.country, proxyType: settings.proxyType, error: null, fatal: false, stale: false, agents: [], retryAt: null });
    this.run();
  }

  stop() {
    this.cancel();
    router.setArmed(false);
    this.set({ status: "off", error: null, fatal: false, stale: false, agents: [], retryAt: null });
  }

  /**
   * Re-handshakes without dropping the current tunnel. Rate limited, because the
   * rotation alarm, the request-error watcher and the popup can all call it.
   *
   * @param {string} reason
   * @param {number} minGapMs
   * @param {boolean} newIdentity
   */
  refresh(reason, minGapMs = 60_000, newIdentity = false) {
    if (this.state.status === "off") return;
    if (Date.now() - this.lastRefreshAt < minGapMs) return;
    console.info(`[zagent] refreshing tunnel: ${reason}`);
    if (newIdentity) this.identity = null;
    this.cancel();
    this.attempt = 0;
    this.run();
  }

  cancel() {
    this.abort?.abort();
    this.abort = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  async run() {
    const controller = new AbortController();
    this.abort = controller;
    this.lastRefreshAt = Date.now();
    const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);

    const live = this.state.status === "on";
    const work = this.connect(controller.signal);
    if (!live) router.holdFor(work);

    try {
      const creds = await work;
      if (this.abort !== controller) return;
      router.setRoute(creds.tunnels, creds.authHeader);
      this.attempt = 0;
      this.blocks = 0;
      this.set({ status: "on", error: null, fatal: false, stale: false, agents: creds.tunnels.map((t) => t.host), retryAt: null });
    } catch (err) {
      if (this.abort !== controller) return;
      this.fail(err, live);
    } finally {
      clearTimeout(timer);
      if (this.abort === controller) this.abort = null;
    }
  }

  /**
   * Any tunnel failure retires the identity, so the next attempt starts from a
   * clean session key rather than retrying against one Hola may have expired.
   *
   * @param {AbortSignal} signal
   * @returns {Promise<hola.Credentials>}
   */
  async connect(signal) {
    if (this.identity === null) this.identity = await hola.openIdentity({ signal });
    try {
      return await hola.fetchTunnels({
        identity: this.identity,
        country: this.state.country,
        proxyType: this.state.proxyType,
        signal,
      });
    } catch (err) {
      this.identity = null;
      throw err;
    }
  }

  /**
   * @param {unknown} err
   * @param {boolean} live Whether a working tunnel was already carrying traffic.
   */
  fail(err, live = false) {
    const holaErr = err instanceof hola.HolaError ? err : null;
    const message = err instanceof Error ? err.message : String(err);

    // Agents keep proxying long after Hola's API stops answering, so a failed
    // refresh is no reason to tear down a tunnel that is still working. Only
    // give up the route when there was nothing carrying traffic to begin with.
    if (live) {
      const delay = this.nextDelay(holaErr) * (0.75 + Math.random() * 0.5);
      this.set({ stale: true, error: message, retryAt: Date.now() + delay });
      console.warn(`[zagent] could not refresh (${message}); keeping the current tunnel, retrying in ${Math.round(delay / 1000)}s`);
      this.scheduleRetry(delay, true);
      return;
    }

    router.clearRoute();
    if (holaErr?.permanent === true) {
      this.set({ status: "error", error: message, fatal: true, stale: false, agents: [], retryAt: null });
      return;
    }

    const delay = this.nextDelay(holaErr) * (0.75 + Math.random() * 0.5);
    this.set({ status: "error", error: message, fatal: false, stale: false, agents: [], retryAt: Date.now() + delay });
    console.warn(`[zagent] handshake failed (${message}); retrying in ${Math.round(delay / 1000)}s`);
    this.scheduleRetry(delay, false);
  }

  /**
   * @param {number} delay
   * @param {boolean} keepServing Leave the current tunnel in place while retrying.
   */
  scheduleRetry(delay, keepServing) {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!keepServing) this.set({ status: "connecting", retryAt: null });
      this.run();
    }, delay);
  }

  /** @param {hola.HolaError | null} holaErr */
  nextDelay(holaErr) {
    if (holaErr?.retryAfterMs) {
      const wait = Math.min(holaErr.retryAfterMs * 2 ** this.blocks, BLOCK_MAX_MS);
      this.blocks++;
      return wait;
    }
    this.blocks = 0;
    return Math.min(RETRY_BASE_MS * 1.5 ** this.attempt++, RETRY_MAX_MS);
  }

  /** @param {Partial<State>} patch */
  set(patch) {
    this.state = { ...this.state, ...patch, since: Date.now() };
    this.onChange(this.state);
  }
}
