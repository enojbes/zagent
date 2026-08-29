# Zagent

A Firefox extension that routes your browsing through Hola's proxy network, one
country at a time. It reimplements the handshake from
[Snawoot/hola-proxy](https://github.com/snawoot-proxies-forks/hola-proxy) in
JavaScript and feeds the result to `proxy.onRequest`, so there is no local daemon
and no binary to run. Firefox talks to the agents itself.

Verified end to end against live agents: `country=tr` exits at a Radore
datacenter in Istanbul.

## Why an extension rather than hola-proxy plus FoxyProxy

`proxy.onRequest` is Firefox-only and hands the extension a per-request decision.
That buys three things a local HTTP proxy cannot give you.

- Only Firefox is tunnelled. The rest of the machine is untouched, with no
  system proxy settings to remember to undo.
- The failover chain is native. Return an array of agents and Gecko walks it.
- Fail-closed is possible. See below.

## Install

**For a quick try.** Open `about:debugging#/runtime/this-firefox`, choose *Load
Temporary Add-on*, and pick `src/manifest.json`. It works immediately and
disappears when you restart Firefox.

**To keep it.** Build the archive and get it signed as an unlisted add-on.

```bash
npm run build
```

That writes `dist/zagent-<version>.zip`. Upload it at
[addons.mozilla.org](https://addons.mozilla.org/developers/addon/submit/upload-unlisted)
as **On your own** (unlisted). Automated review signs it in a minute or two and
gives you an XPI you can install permanently. A *listed* submission would go to
human review, which a Hola client is unlikely to survive, for the same reason
Hola's own extension is no longer on AMO.

**Private windows.** Firefox does not run extensions in private windows by
default. Open `about:addons`, find Zagent, and set *Run in Private Windows* to
*Allow*, or private tabs will bypass the tunnel entirely. The popup checks
`extension.isAllowedIncognitoAccess()` and shows a warning if you have not,
because a tunnel that silently does not apply is worse than no tunnel.

## How it works

1. Generate a random 32-hex user id.
2. `POST client.hola.org/client_cgi/background_init?uuid=…` with `login=1`. The
   answer carries a session key and, usefully, the extension version Hola
   currently expects. `hola-proxy` scrapes that version from the Chrome Web
   Store; asking Hola directly removes a host permission and a request.
3. `POST …/zgettunnels?…` with the country and session key. The answer lists
   agents (`zagent417.hola.org` and friends), a port map, and an `agent_key`.
4. Build one `ProxyInfo` per agent, `type: "https"` because agents want TLS,
   with `proxyAuthorizationHeader` set to
   `basic base64(user-uuid-<id>-is_prem-0:<agent_key>)`.
5. Hand that array back from `proxy.onRequest`.

Steps 1 and 2 happen once and the identity is kept. Switching country reruns
only step 3. That halves the requests per switch and, more importantly, avoids
the rate limit described below. The identity is retired every 12 hours, and
whenever a tunnel request fails, so a stale session key never gets retried.

Credentials live in memory only. They are never written to disk, so closing
Firefox throws them away and the next start does a fresh handshake.

### Hola rate-limits new identities

Mint several user ids from one address in quick succession and Hola answers
`{"blocked": true, "permanent": false}` to everything for a while. "A while" is
not short. One block, triggered by roughly six handshakes inside ten minutes,
was still in place two hours later.

This is easy to trigger by accident, and it shapes three things. The extension
holds onto one identity so a country switch costs no new one. The popup waits
400ms before acting on a country click, so running down the list costs one
handshake rather than one per row. And a block backs off for five minutes, then
ten, twenty, forty, capping at an hour, instead of polling every five minutes
all afternoon.

The popup reports it as "Hola has temporarily blocked this IP address" and says
when it will try again, rather than showing a generic connection failure.

## The popup

The switch shows what you asked for. The status block underneath shows what is
actually happening to your traffic, and those two are not the same thing while a
tunnel is down. An earlier version of this popup showed a green switch and the
word "Error" in all three failure states, which is how you end up believing you
are in Turkey while your own address is on the wire. Now:

| State | Says |
|---|---|
| Off | Traffic is going out on your own address |
| Connecting | Traffic is held until the tunnel is up |
| Connected | Country and the agent carrying it |
| Failed, fail-closed on | **Traffic blocked.** Requests fail until a tunnel is up |
| Failed, fail-closed off | **Not protected.** Traffic is going out on your own address |

A *Try now* link appears only when a retry could plausibly help. It stays hidden
during a Hola block, because retrying through a block is what causes blocks.

The country list keeps the last four countries you picked at the top. Search is
focused when the popup opens, arrow keys move the cursor, Enter selects, Escape
clears the filter, and the list scrolls to your current country rather than
opening on Argentina. The rows carry `role="option"` with `aria-activedescendant`
on the search field, so the whole thing works without a mouse.

*Verify* asks ipinfo.io what address it sees and remembers the answer against
the agent it was checked through, so the reading is thrown away the moment the
chain changes rather than going quietly stale. It is the one thing in the
extension that talks to a third party, and only when you press it.

## Settings

**Country.** Fetched from Hola daily and cached. Names and flags come from
`Intl.DisplayNames`, so no country table ships with the extension. Hola says
`uk` where ISO 3166 says `GB`; the popup translates.

**Exit type.** `Datacenter` is the default and the one you want. `Residential`
and `Peer` route you through other people's home connections, which is the part
of Hola's model worth avoiding, and the popup says so in red.

**Block traffic when no tunnel is up.** On by default. Gecko's documented
behaviour is to fall back to the browser's own proxy setting once it runs off
the end of the chain, which for most people means the real connection. Ending
the array with `null` truncates the chain instead, so a request fails rather
than quietly leaking. Turn it off and a dead tunnel means normal browsing
instead of errors.

**Stop WebRTC from leaking your IP.** Sets
`privacy.network.webRTCIPHandlingPolicy` to `disable_non_proxied_udp`. WebRTC
opens UDP sockets that never touch an HTTP proxy, so without this a video call
or a fingerprinting script sees your real address.

**Disable DNS prefetch and speculative connections.** Proxied requests resolve
names at the agent, so they leak nothing. Prefetch resolves them locally
in advance, which your ISP sees.

**Never tunnel these hosts.** One per line. An entry covers its subdomains.
Loopback, RFC 1918, link-local and `.local`-style names always skip the tunnel
and are not part of this list.

## What it does not do

- **No fallback bootstrap.** `hola-proxy` can reach Hola through an encrypted
  agent list on S3 when `client.hola.org` is blocked. Useful if you are
  tunnelling *out* of a censored network; dead weight if you are tunnelling
  *into* one, which is the case here. Left out on purpose.
- **No DNS workaround.** `hola-proxy` resolves names over DoH and hands the
  agent an IP, which sidesteps Hola's own domain blocklist. `proxy.onRequest`
  picks a proxy and cannot rewrite the destination host without breaking SNI and
  the `Host` header, so this extension inherits Hola's blocklist.
- **No identity reset.** Turning the tunnel on does not clear cookies, storage
  or a fingerprint. Sites that knew you before still know you. Pair it with a
  container or a fresh profile if that matters.
- **Turkey filters its own internet.** Exiting through a Turkish IP means
  inheriting Turkish ISP blocks. It is a Turkish address, not a freer one.

## Layout

    src/manifest.json          MV2, persistent background page
    src/background/main.js     every WebExtension API call lives here
    src/background/router.js   the proxy.onRequest hot path
    src/background/session.js  handshake lifecycle, retry, rotation
    src/background/hola.js     the three Hola endpoints
    src/background/settings.js storage, defaults, input sanitizing
    src/popup/                 the panel
    tools/check.mjs            manifest, syntax, imports, CSP, dangling refs
    tools/build.mjs            check, test, zip
    tools/loopback-e2e.mjs     drive a real Firefox against a stand-in agent
    tools/e2e.mjs              drive a real Firefox against Hola, check the exit address
    tools/bench.mjs            cost of the per-request decision

`main.js` is the only module that touches `browser.*`, which is what lets the
other four run under plain Node in the test suite.

## Development

```bash
npm test
```

47 tests, no dependencies. The interesting ones are in `test/router.test.mjs`,
where `hostOf` is checked against the platform URL parser over a corpus, and in
`test/session.test.mjs`, where the whole lifecycle runs against a stubbed `fetch`
with mocked timers.

```bash
npm run e2e
```

Loads the extension into a headless Firefox and asserts on bytes Firefox
actually puts on the wire. A loopback listener stands in for the agents, so this
needs neither Hola nor a trusted certificate. It checks that the chain makes
Firefox connect to the host and port the router named, that it steps over a dead
first entry to get there, that `type: "https"` really does mean TLS to the proxy
(the first bytes are a ClientHello, and the SNI is the agent hostname), that the
Hola API and a disarmed extension never touch the tunnel, and that fail-closed
refuses a request that would otherwise have succeeded. It also opens the popup
in that Firefox and checks it renders without errors, lists every country, marks
the current one and focuses search. The listener kills every
connection it accepts, which is what makes "this request answered" a sound proof
that it did not go through the tunnel.

```bash
npm run e2e:hola     # or: node tools/e2e.mjs tr de
```

The same idea against Hola itself. Records the exit address, turns the tunnel
on, records it again, switches country, records it again, turns it off, and
checks all four against each other, including that the country switch cost one
`background_init`. It needs an address Hola has not blocked, which makes it a
good acceptance check and a poor regression test.

Firefox gives a headless `web-ext` run no way to hand console output back, so
both harnesses have their probe post its verdict to a loopback collector they
own. Loopback is never tunnelled, so the report cannot be distorted by the thing
it is reporting on.

```bash
npm run check
```

Catches what Firefox would only complain about at install time or at runtime,
including broken syntax, imports that point nowhere, files the manifest
references but nobody shipped, and inline scripts the MV2 CSP refuses.

```bash
npx web-ext lint --source-dir=src --self-hosted
npx web-ext run --source-dir=src
```

## Cost per request

`decide` is the only code that runs on every network channel in the browser.

```bash
npm run bench
```

On this machine, 211 ns per request with the default empty bypass list, 249 ns
with four entries. It allocates nothing: the `ProxyInfo` array is built once per
tunnel and the same instance goes back every time, which is safe because Gecko's
validation writes each field back over itself. The hostname comes off the URL
string directly rather than through `new URL()`, which measures 103 ns against
289 ns and, more to the point, skips an object per request.

None of this is load-bearing. A page making 100 requests spends 21 microseconds
here. It is cheap because there was no reason for it not to be.

## Manifest V2, on purpose

Firefox MV3 makes host permissions opt-in and suspends the background page after
30 seconds idle. For a proxy extension both hurt. Every wake would have to
rehydrate state from storage before it could answer `proxy.onRequest`, adding
latency to the first request after every idle gap, and a user who never grants
`<all_urls>` gets an extension that silently does nothing. MV2 with a persistent
background page keeps the decision in memory and answers synchronously. Mozilla
continues to support MV2, and AMO accepts it.

## Credit

The protocol work is [Snawoot](https://github.com/Snawoot)'s. The original
repository is gone from GitHub; the reconstruction at
[snawoot-proxies-forks/hola-proxy](https://github.com/snawoot-proxies-forks/hola-proxy)
is what this was ported from.
