/**
 * Answers what each exit type actually gives you, by asking Hola for one of
 * each and looking at where traffic comes out.
 *
 * It mints a single identity and reuses it across all five, the same way the
 * extension does. Minting one per type is exactly the burst that gets an
 * address blocked, and a tool that breaks the thing it measures is no use.
 *
 * Note that `peer` and `lum` exit through somebody's home connection, so this
 * sends one request each through a stranger's line and no more.
 *
 * Usage: node tools/probe-types.mjs [country...]
 */
import tls from "node:tls";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const CCGI = "https://client.hola.org/client_cgi/";
const COUNTRIES = process.argv.slice(2).length ? process.argv.slice(2) : ["tr"];
/** Hola throttles bursts, so space the calls out rather than race them. */
const GAP_MS = 1_500;
const TARGET = { host: "ipinfo.io", port: 443 };

/** Mirrors src/background/hola.js. Kept here so the probe stays standalone. */
const COUNTRY_PARAM = {
  direct: (c) => c,
  peer: (c) => c,
  pool: (c) => `${c}.pool`,
  lum: (c) => `${c}.pool_lum_${c}_shared`,
  virt: (c) => `${c}.pool_virt_pool_${c}`,
};
const PORT_FIELD = { direct: "trial", pool: "trial", lum: "trial", virt: "trial", peer: "trial_peer" };

const uuid = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

const init = await post(`${CCGI}background_init?uuid=${uuid}`, {
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ login: "1", ver: "1.258.48" }).toString(),
});
if (init.blocked) {
  console.error(
    `Hola has ${init.permanent ? "permanently" : "temporarily"} blocked this address. Nothing to measure until it lifts.`,
  );
  process.exit(1);
}
console.log(`identity ${uuid.slice(0, 8)}… · ext ${init.ver} · Hola sees this address in ${init.country}\n`);

for (const COUNTRY of COUNTRIES) {
  console.log(`--- ${COUNTRY} ---`);
  for (const type of Object.keys(COUNTRY_PARAM)) {
    await new Promise((r) => setTimeout(r, GAP_MS));
    const param = COUNTRY_PARAM[type](COUNTRY);
    process.stdout.write(`${type.padEnd(7)} country=${param.padEnd(28)}`);

    let tun;
    try {
      tun = await post(
        `${CCGI}zgettunnels?` +
          new URLSearchParams({
            country: param,
            limit: "3",
            ping_id: String(Math.random()),
            ext_ver: init.ver,
            browser: "chrome",
            product: "cws",
            uuid,
            session_key: String(init.key),
            is_premium: "0",
          }),
      );
    } catch (err) {
      console.log(`request failed: ${err.message}`);
      continue;
    }

    if (tun.blocked) {
      console.log("blocked mid-run; stopping so it does not get worse");
      process.exit(1);
    }

    const hosts = Object.keys(tun.ip_list ?? {});
    if (hosts.length === 0) {
      console.log(`no agent (agent_types ${JSON.stringify(tun.agent_types ?? {})})`);
      continue;
    }

    const host = hosts.find((h) => String(tun.protocol?.[h]).toLowerCase() === "http") ?? hosts[0];
    const port = tun.port?.[PORT_FIELD[type]];
    const auth = "basic " + Buffer.from(`user-uuid-${uuid}-is_prem-0:${tun.agent_key}`).toString("base64");
    const exit = await probe(host, port, auth);

    console.log(
      [
        `agent=${Object.values(tun.agent_types ?? {})[0] ?? "?"}`,
        `vendor=${tun.vendor?.[host] ?? "?"}`,
        `port=${port}`,
        exit.err ? `FAILED ${exit.err}` : `${exit.ip} ${exit.country} ${exit.connectMs}ms · ${exit.org}`,
      ].join(" · "),
    );
  }
  console.log("");
}

async function post(url, init = {}) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    ...init,
    headers: { "User-Agent": UA, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** TLS to the agent, CONNECT with auth, TLS-in-TLS to the target. What Firefox does. */
function probe(host, port, auth) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setTimeout(() => finish({ err: "timeout" }), 20_000);
    const finish = (value) => {
      clearTimeout(timer);
      outer.destroy();
      resolve(value);
    };

    const outer = tls.connect({ host, port, servername: host, ALPNProtocols: ["http/1.1"] }, () =>
      outer.write(
        `CONNECT ${TARGET.host}:${TARGET.port} HTTP/1.1\r\nHost: ${TARGET.host}:${TARGET.port}\r\n` +
          `Proxy-Authorization: ${auth}\r\nUser-Agent: ${UA}\r\n\r\n`,
      ),
    );
    outer.on("error", (e) => finish({ err: e.message }));

    let head = "";
    const onHead = (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      outer.removeListener("data", onHead);
      const status = head.slice(0, head.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01] 200/.test(status)) return finish({ err: status });

      const connectMs = Date.now() - started;
      const inner = tls.connect({ socket: outer, servername: TARGET.host, ALPNProtocols: ["http/1.1"] }, () =>
        inner.write(`GET /json HTTP/1.1\r\nHost: ${TARGET.host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`),
      );
      let body = "";
      inner.on("error", (e) => finish({ err: `inner: ${e.message}` }));
      inner.on("data", (c) => (body += c));
      inner.on("end", () => {
        try {
          const json = JSON.parse(body.slice(body.indexOf("\r\n\r\n") + 4).replace(/^[0-9a-f]+\r\n/i, ""));
          finish({ connectMs, ip: json.ip, country: json.country, org: json.org });
        } catch {
          finish({ err: "unparsable answer" });
        }
      });
    };
    outer.on("data", onHead);
  });
}
