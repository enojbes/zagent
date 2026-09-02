/**
 * The extension uses the trial ports, following hola-proxy's default. This asks
 * whether the other ports in the port map behave differently, which matters
 * because the warnings about `peer` routing through somebody's home connection
 * rest on an assumption nobody here has tested.
 *
 * One identity, one tunnel list, every port. Usage: node tools/probe-ports.mjs [country]
 */
import tls from "node:tls";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const CCGI = "https://client.hola.org/client_cgi/";
const COUNTRY = process.argv[2] ?? "tr";
const TARGET = { host: "ipinfo.io", port: 443 };

const uuid = [...crypto.getRandomValues(new Uint8Array(16))]
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

const init = await post(`${CCGI}background_init?uuid=${uuid}`, {
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ login: "1", ver: "1.258.48" }).toString(),
});
if (init.blocked) {
  console.error("Hola has blocked this address. Nothing to measure.");
  process.exit(1);
}

const tun = await post(
  `${CCGI}zgettunnels?` +
    new URLSearchParams({
      country: COUNTRY,
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
if (tun.blocked || !tun.ip_list) {
  console.error("no tunnels returned");
  process.exit(1);
}

const host = Object.keys(tun.ip_list).find((h) => String(tun.protocol?.[h]).toLowerCase() === "http");
const auth = "basic " + Buffer.from(`user-uuid-${uuid}-is_prem-0:${tun.agent_key}`).toString("base64");

console.log(`${COUNTRY} · agent ${host} · vendor ${tun.vendor?.[host] ?? "?"}`);
console.log(`ports ${JSON.stringify(tun.port)}\n`);

for (const [field, port] of Object.entries(tun.port)) {
  await new Promise((r) => setTimeout(r, 1200));
  const withAuth = await probe(host, port, auth);
  const without = await probe(host, port, null);
  console.log(
    `${field.padEnd(11)} :${String(port).padEnd(6)} ` +
      `auth=${describe(withAuth).padEnd(46)} no-auth=${describe(without)}`,
  );
}

function describe(r) {
  return r.err ? r.err.slice(0, 44) : `${r.ip} ${r.country} ${r.org ?? ""}`.trim();
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

function probe(host, port, authHeader) {
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(timer);
      outer.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done({ err: "timeout" }), 20_000);
    const outer = tls.connect({ host, port, servername: host, ALPNProtocols: ["http/1.1"] }, () =>
      outer.write(
        `CONNECT ${TARGET.host}:${TARGET.port} HTTP/1.1\r\nHost: ${TARGET.host}:${TARGET.port}\r\n` +
          (authHeader ? `Proxy-Authorization: ${authHeader}\r\n` : "") +
          `User-Agent: ${UA}\r\n\r\n`,
      ),
    );
    outer.on("error", (e) => done({ err: e.message }));

    let head = "";
    const onHead = (chunk) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      outer.removeListener("data", onHead);
      const status = head.slice(0, head.indexOf("\r\n"));
      if (!/^HTTP\/1\.[01] 200/.test(status)) return done({ err: status });

      const inner = tls.connect({ socket: outer, servername: TARGET.host, ALPNProtocols: ["http/1.1"] }, () =>
        inner.write(`GET /json HTTP/1.1\r\nHost: ${TARGET.host}\r\nConnection: close\r\n\r\n`),
      );
      let body = "";
      inner.on("error", (e) => done({ err: `inner: ${e.message}` }));
      inner.on("data", (c) => (body += c));
      inner.on("end", () => {
        try {
          const j = JSON.parse(body.slice(body.indexOf("\r\n\r\n") + 4).replace(/^[0-9a-f]+\r\n/i, ""));
          done({ ip: j.ip, country: j.country, org: j.org });
        } catch {
          done({ err: "unparsable" });
        }
      });
    };
    outer.on("data", onHead);
  });
}
