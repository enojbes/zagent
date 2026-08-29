# Zagent

A Firefox extension that routes your browsing through Hola's proxy network, one
country at a time.

It reimplements the handshake from
[hola-proxy](https://github.com/snawoot-proxies-forks/hola-proxy) in JavaScript
and hands the result to `proxy.onRequest`. There is no local daemon, no bundled
binary and no build step. Firefox talks to the agents itself.

Verified end to end against live agents: `country=tr` exits at `94.101.87.40`,
AS42926 Radore, Istanbul.

## Install

Download the signed XPI from the
[latest release](https://github.com/enojbes/zagent/releases/latest) and open it
in Firefox. It installs permanently and updates itself from then on.

Two things to know afterwards.

**Private windows.** Firefox does not run extensions in private windows by
default. Open `about:addons`, find Zagent, and set *Run in Private Windows* to
*Allow*. The popup shows a red warning if you have not, because a tunnel that
silently does not apply is worse than no tunnel.

**Pick a country.** There is no default. The switch stays disabled until you
choose one.

To run from source instead, open `about:debugging#/runtime/this-firefox`, choose
*Load Temporary Add-on*, and pick `src/manifest.json`. It works immediately and
disappears when you restart Firefox.

## Why an extension rather than hola-proxy plus FoxyProxy

`proxy.onRequest` is Firefox-only and hands the extension a per-request
decision. That buys three things a local HTTP proxy cannot.

- Only Firefox is tunnelled. The rest of the machine is untouched, with no
  system proxy settings to remember to undo.
- The failover chain is native. Return an array of agents and Gecko walks it.
- Fail-closed is possible. See below.

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
only step 3. That halves the requests per switch and avoids the rate limit
described below. The identity is retired every 12 hours, and whenever a tunnel
request fails, so a stale session key is never retried.

Credentials live in memory only. They are never written to disk, so closing
Firefox throws them away and the next start does a fresh handshake.

### Hola rate-limits new identities

Mint several user ids from one address in quick succession and Hola answers
`{"blocked": true, "permanent": false}` to everything for a while. "A while" is
not short. One block, caused by roughly six handshakes inside ten minutes, was
still in place two hours later.

It shapes three things. The extension holds one identity so a country switch
costs no new one. The popup waits 400ms before acting on a country click, so
running down the list costs one handshake rather than one per row. And a block
backs off for five minutes, then ten, twenty, forty, capping at an hour, instead
of polling every five minutes all afternoon.

The block is on `background_init`, which mints the identity, so it gates every
exit type equally. Nothing is exempt.

## Exit types

All five are the same protocol. The only thing that changes is the `country`
parameter sent to `zgettunnels`, and for `peer` the port field read from the
answer.

| Type | `country` sent | Port field | Where you come out |
|---|---|---|---|
| Datacenter | `tr` | `trial` | Hola's own servers |
| Datacenter pool | `tr.pool` | `trial` | A shared pool of the same |
| Residential, rented | `tr.pool_lum_tr_shared` | `trial` | A home line from Bright Data's pool |
| Peer | `tr` | `trial_peer` | Another Hola user's home connection |
| Virtual pool | `tr.pool_virt_pool_tr` | `trial` | A pool Hola fills for a couple of countries |

**How much of this is verified matters.** `hola-proxy` documents exactly two,
`direct` and `lum`. The other three are undocumented code paths, and the source
comment on `virt` reads "seems to be for brazil and japan only". Only
`direct` has been measured here. The popup groups them by what they actually
are and says which is which.

Residential and Peer exit through a real person's home connection. That is the
part of Hola's model worth declining, and the popup marks both in red.

To measure them yourself:

```bash
node tools/probe-types.mjs tr
```

It reuses one identity across all five, the way the extension does, and refuses
to run at all while blocked.

## The popup

The switch shows what you asked for. The status block underneath shows what is
actually happening to your traffic, and those are not the same thing while a
tunnel is down.

| State | Says |
|---|---|
| No country | The switch is disabled until you pick one |
| Off | Traffic is going out on your own address |
| Connecting | Traffic is held until the tunnel is up |
| Connected | Country, and the agent carrying it |
| Failed, fail-closed on | **Traffic blocked.** Requests fail until a tunnel is up |
| Failed, fail-closed off | **Not protected.** Traffic is going out on your own address |

A *Try now* link appears only when a retry could plausibly help. It stays hidden
during a Hola block, because retrying through a block is what causes blocks.

The country list keeps the last four countries you picked at the top. The popup
does not steal focus on open; typing anywhere focuses the filter instead. Arrow
keys move the cursor, Enter selects, Escape clears, and the list scrolls to your
current country rather than opening on Argentina. Rows carry `role="option"`
with `aria-activedescendant` on the search field, so it works without a mouse.

*Verify* asks ipinfo.io what address it sees and remembers the answer against
the agent it was checked through, so the reading is discarded the moment the
chain changes rather than going quietly stale. It is the one thing here that
talks to a third party, and only when you press it.

## Settings

**Exit type.** Datacenter unless you have a reason. See the table above.

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
names at the agent, so they leak nothing. Prefetch resolves them locally in
advance, which your ISP sees.

**Never tunnel these hosts.** One per line. An entry covers its subdomains.
Loopback, RFC 1918, link-local and `.local`-style names always skip the tunnel
and are not part of this list.

## What it does not do

- **No fallback bootstrap.** `hola-proxy` can reach Hola through an encrypted
  agent list on S3 when `client.hola.org` is blocked. Useful if you are
  tunnelling *out* of a censored network, dead weight if you are tunnelling
  *into* one. Left out on purpose.
- **No DNS workaround.** `hola-proxy` resolves names over DoH and hands the
  agent an IP, sidestepping Hola's own domain blocklist of roughly 195 hosts,
  mostly webmail. `proxy.onRequest` picks a proxy and cannot rewrite the
  destination without breaking SNI and the `Host` header, so this extension
  inherits that blocklist. Add anything you hit to the bypass list.
- **No identity reset.** Turning the tunnel on does not clear cookies, storage
  or a fingerprint. Sites that knew you before still know you.
- **Nothing outside Firefox.** By design.
- **It is not a VPN.** Hola sees every hostname you visit, from the CONNECT
  target, plus timing and volume. Not the contents of HTTPS pages.

Exiting through a Turkish IP also means inheriting Turkish ISP blocks. It is a
Turkish address, not a freer one.

## Cost per request

`decide` is the only code that runs on every network channel in the browser.

```bash
npm run bench
```

237 ns per request with the default empty bypass list, 322 ns with four entries.
It allocates nothing: the `ProxyInfo` array is built once per tunnel and the
same instance goes back every time, which is safe because Gecko's validation
writes each field back over itself. The hostname comes off the URL string
directly rather than through `new URL()`, which measures 106 ns against 306 ns
and, more to the point, skips an object per request.

None of this is load-bearing. A page making 100 requests spends 24 microseconds
here. It is cheap because there was no reason for it not to be.

## Manifest V2, on purpose

Firefox MV3 makes host permissions opt-in and suspends the background page after
30 seconds idle. For a proxy extension both hurt. Every wake would have to
rehydrate state from storage before it could answer `proxy.onRequest`, adding
latency to the first request after every idle gap, and a user who never grants
`<all_urls>` gets an extension that silently does nothing. MV2 with a persistent
background page keeps the decision in memory and answers synchronously. Mozilla
continues to support MV2, and AMO accepts it.

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
    tools/release.mjs          verify, tag, push; CI signs
    tools/update-manifest.mjs  rewrite updates.json for a release
    tools/loopback-e2e.mjs     drive a real Firefox against a stand-in agent
    tools/e2e.mjs              drive a real Firefox against Hola
    tools/bench.mjs            cost of the per-request decision
    tools/probe-types.mjs      what each exit type actually gives you
    tools/check-amo-credentials.mjs  confirm signing will work before tagging
    updates.json               what Firefox polls to find new versions

`main.js` is the only module that touches `browser.*`, which is what lets the
other four run under plain Node in the test suite. 1,346 lines of source, 12
shipped files, no dependencies.

## Development

```bash
npm test
```

49 tests. The interesting ones are in `test/router.test.mjs`, where `hostOf` is
checked against the platform URL parser over a corpus, and in
`test/session.test.mjs`, where the whole lifecycle runs against a stubbed
`fetch` with mocked timers.

```bash
npm run check
```

Catches what Firefox would only complain about at install time or at runtime:
broken syntax, imports that point nowhere, files the manifest references but
nobody shipped, inline scripts the MV2 CSP refuses, and an add-on id that
disagrees with `updates.json`.

```bash
npm run e2e
```

Loads the extension into a headless Firefox and asserts on bytes Firefox
actually puts on the wire. A loopback listener stands in for the agents, so it
needs neither Hola nor a trusted certificate. Fifteen checks: that the chain
makes Firefox connect to the host and port the router named, that it steps over
a dead first entry to get there, that `type: "https"` really does mean TLS to
the proxy (first bytes are a ClientHello, SNI is the agent hostname), that the
Hola API and a disarmed extension never touch the tunnel, that fail-closed
refuses a request that would otherwise have succeeded, and that the popup
renders without errors. The listener kills every connection it accepts, which is
what makes "this request answered" a sound proof that it did not go through the
tunnel.

```bash
npm run e2e:hola     # or: node tools/e2e.mjs tr de
```

The same idea against Hola itself, including that a country switch costs one
`background_init`. It needs an address Hola has not blocked, which makes it a
good acceptance check and a poor regression test.

Firefox gives a headless `web-ext` run no way to hand console output back, so
both harnesses have their probes post to a loopback collector they own. Loopback
is never tunnelled, so the report cannot be distorted by the thing it reports on.

## Releasing

```bash
npm run release -- 1.0.6
```

Verifies, runs the browser harness, stamps the manifest, tags and pushes. CI
signs through the AMO API, attaches the XPI to a GitHub Release, rewrites
`updates.json` to name it, and commits that back to `main`.

It needs two repository secrets from the
[AMO API key page](https://addons.mozilla.org/en-US/developers/addon/api/key/):
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. The release job checks them against AMO
before it signs, so a mistyped secret fails before a tag exists rather than
after. To check them without releasing anything:

```bash
WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… node tools/check-amo-credentials.mjs
```

Re-pushing a tag for a version already released is a no-op rather than a failure.
Note that Actions runs the workflow file as it stood at the tagged commit, so
changes to the release job only take effect for tags cut after them.

Submissions are **unlisted**, so automated review signs them in a minute or two
and they never appear in the AMO gallery. A *listed* submission would go to
human review, which a Hola client is unlikely to survive, for the same reason
Hola's own extension is no longer on AMO. Unlisted add-ons remain subject to
manual review at any time.

### How updating works

AMO signs unlisted add-ons but does not serve updates for them, so the add-on
points at `updates.json` in this repository, read over
`raw.githubusercontent.com`. That is why the repository is public.

Firefox polls it, compares versions, and checks `update_hash` against the
download before installing. Without that hash a swapped release asset would be
trusted purely for arriving at the expected URL.

An installed copy only ever checks the `update_url` it shipped with, and builds
before 1.0.5 shipped with none. Install any build from 1.0.5 onward by hand once
and every version after it arrives on its own.

## Credit

The protocol work is [Snawoot](https://github.com/Snawoot)'s. The original
repository is gone from GitHub; the reconstruction at
[snawoot-proxies-forks/hola-proxy](https://github.com/snawoot-proxies-forks/hola-proxy)
is what this was ported from.
