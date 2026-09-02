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
 * `state` reports what is carrying traffic. `wanted` holds what the user asked
 * for. Keeping them apart is what stops the panel claiming a country the tunnel
 * is not actually using, which it did while those two were one field.
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
    /** What is actually carrying traffic, which is not always what was asked for. */
    this.serving = null;
    /** What the user last asked for. Retries aim here, not at what is serving. */
    this.wanted = null;
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
    // Compare against what was asked for, not what is serving. After a switch
    // that could not happen those differ, and comparing state would restart a
    // retry that is already in flight and reset its backoff.
    const sameTarget =
      this.wanted !== null &&
      this.wanted.country === settings.country &&
      this.wanted.proxyType === settings.proxyType;
    if (sameTarget && this.state.status !== "off") return;

    this.cancel();
    router.setArmed(true);
    this.wanted = { country: settings.country, proxyType: settings.proxyType };
    this.attempt = 0;
    // `blocks` deliberately survives: a block belongs to the address, not to the
    // country, so changing target must not reset the escalating cooldown.

    // Park traffic rather than serve the country the user just moved away from.
    // `serving` keeps the old credentials so a switch that cannot happen can put
    // the working tunnel back instead of leaving nothing.
    router.clearRoute();

    this.set({
      status: "connecting",
      country: settings.country,
      proxyType: settings.proxyType,
      error: null,
      fatal: false,
      stale: false,
      agents: [],
      retryAt: null,
    });
    this.run();
  }

  stop() {
    this.cancel();
    this.serving = null;
    this.wanted = null;
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

    const target = this.wanted ?? { country: this.state.country, proxyType: this.state.proxyType };
    const work = this.connect(controller.signal, target);
    if (!router.hasRoute()) router.holdFor(work);

    try {
      const creds = await work;
      if (this.abort !== controller) return;
      router.setRoute(creds.tunnels, creds.authHeader);
      this.serving = { ...target, creds };
      this.attempt = 0;
      this.blocks = 0;
      this.set({
        status: "on",
        country: target.country,
        proxyType: target.proxyType,
        error: null,
        fatal: false,
        stale: false,
        agents: creds.tunnels.map((t) => t.host),
        retryAt: null,
      });
    } catch (err) {
      if (this.abort !== controller) return;
      this.fail(err);
    } finally {
      clearTimeout(timer);
      if (this.abort === controller) this.abort = null;
    }
  }

  /**
   * A tunnel failure usually means the session key is spent, so the identity is
   * retired and the next attempt starts clean.
   *
   * A block is the exception, and it matters. Blocks are counted against the
   * address on `background_init`, which is the very call minting an identity, so
   * retiring one during a block means every retry hammers the endpoint doing the
   * blocking. Hola's own extension mints a single identity and keeps it in three
   * places forever; this at least stops digging.
   *
   * @param {AbortSignal} signal
   * @param {{ country: string, proxyType: import("./settings.js").ProxyType }} target
   * @returns {Promise<hola.Credentials>}
   */
  async connect(signal, target) {
    if (this.identity === null) this.identity = await hola.openIdentity({ signal });
    try {
      return await hola.fetchTunnels({
        identity: this.identity,
        country: target.country,
        proxyType: target.proxyType,
        signal,
      });
    } catch (err) {
      if (!(err instanceof hola.HolaError) || err.retryAfterMs === 0) this.identity = null;
      throw err;
    }
  }


  /** @param {unknown} err */
  fail(err) {
    const holaErr = err instanceof hola.HolaError ? err : null;
    const message = err instanceof Error ? err.message : String(err);

    // Agents keep proxying long after Hola's API stops answering, so a failed
    // handshake is no reason to be left with nothing. Put back whatever was
    // working before the attempt.
    if (this.serving !== null && holaErr?.permanent !== true) {
      router.setRoute(this.serving.creds.tunnels, this.serving.creds.authHeader);
      const delay = this.nextDelay(holaErr) * (0.75 + Math.random() * 0.5);
      // The state has to describe what is carrying traffic, not what was asked
      // for, or the panel reports a country the user is not actually using.
      this.set({
        status: "on",
        country: this.serving.country,
        proxyType: this.serving.proxyType,
        agents: this.serving.creds.tunnels.map((t) => t.host),
        stale: true,
        error: message,
        retryAt: Date.now() + delay,
      });
      console.warn(`[zagent] could not reach Hola (${message}); still serving ${this.serving.country}, retrying in ${Math.round(delay / 1000)}s`);
      this.scheduleRetry(delay, true);
      return;
    }

    this.serving = null;
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
      // `run` reads the target from `wanted`, so a retry needs no state change
      // beyond clearing the countdown. Touching country here is what let the
      // panel report a country the tunnel was not using.
      if (!keepServing) this.set({ status: "connecting", retryAt: null });
      else this.set({ retryAt: null });
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
