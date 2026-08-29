# Internals

## The handshake

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
5. Return that array from `proxy.onRequest`.

Steps 1 and 2 happen once. Switching country reruns only step 3, which halves
the requests per switch and matters for the reason below. The identity is
retired every 12 hours and whenever a tunnel request fails, so a stale session
key is never retried.

Credentials live in memory only and are never written to disk. Closing Firefox
throws them away.

All five exit types are the same protocol. Only the `country` parameter changes,
plus which port field `peer` reads.

| Type | `country` sent | Port field |
| --- | --- | --- |
| Datacenter | `tr` | `trial` |
| Datacenter pool | `tr.pool` | `trial` |
| Residential | `tr.pool_lum_tr_shared` | `trial` |
| Peer | `tr` | `trial_peer` |
| Virtual pool | `tr.pool_virt_pool_tr` | `trial` |

## Hola rate-limits new identities

Mint several user ids from one address in quick succession and Hola answers
`{"blocked": true, "permanent": false}` to everything. "A while" is not short:
one block, caused by roughly six handshakes inside ten minutes, was still in
place two hours later.

It shapes three things. The extension holds one identity so a country switch
costs no new one. The panel waits 400ms before acting on a click, so running
down the list costs one handshake rather than one per row. And a block backs off
five minutes, then ten, twenty, forty, capping at an hour.

The block is on `background_init`, which mints the identity, so it gates every
exit type equally when you need a *new* session. Nothing is exempt.

### A block does not stop an existing tunnel

Measured from a currently-blocked address, against a live Turkish agent:

    CONNECT example.com:443, no Proxy-Authorization  ->  HTTP/1.1 200 OK
    CONNECT example.com:443, junk credentials        ->  HTTP/1.1 403 Auth Failed

The tunnel carried traffic and came out at `31.210.91.240`, Turkey, Radore. So
the ban lives on Hola's API, not on the agents. Once you hold an agent hostname
and port, it keeps proxying regardless. Curiously, offering no credentials fares
better than offering wrong ones.

This also explains a question that looks paradoxical from the outside: why
Datacenter keeps working during a block while Residential will not connect.
Datacenter is already connected, and its agent does not care about the block.
Residential is a different `country` parameter, so reaching it needs a
`zgettunnels` call, which the block refuses.

The extension keeps sending its credentials, the way Hola's own client does.
What this changes is failure handling. A refresh that cannot reach the API is
not evidence that the tunnel is dead, so `Session.fail` no longer discards a
route that is still carrying traffic. It marks the session stale, keeps serving,
and retries in the background.

Switching country or exit type is handled the same way, with one difference.
Traffic is parked for the duration rather than served through the exit the user
just moved away from, because asking for Germany and silently getting Turkey is
the same kind of lie the status block exists to prevent. The old credentials are
kept, so a switch that cannot happen puts the working tunnel back rather than
leaving nothing. The panel then reports what is actually serving alongside what
was asked for, and the retry aims at what was asked for.

## Fail-closed

Gecko walks the returned array as a failover chain and, once it runs off the
end, falls back to whatever proxy the browser itself would use. For most people
that is the real connection, so a dead tunnel would silently stop protecting
anything.

Appending `null` truncates the chain instead, and the request fails. See
`createProxyInfoFromData` in Gecko's `ProxyChannelFilter.sys.mjs`.

While no tunnel is up, the router returns an unroutable `127.0.0.1:1` followed
by that `null`. Port 1 needs root to bind, so it is refused instantly and the
request errors rather than hanging.

Requests that arrive during a handshake are parked on the pending promise rather
than let out, so the window between "switched on" and "tunnel ready" does not
leak.

## The hot path

`decide` runs once per network channel in the browser, so it allocates nothing.
The `ProxyInfo` array is built once per tunnel and the same instance is returned
every time, which is safe because Gecko's validation writes each field back over
itself.

```
npm run bench
```

| | |
| --- | --- |
| `decide`, no bypass list | 237 ns |
| `decide`, four bypass entries | 322 ns |
| `hostOf` | 106 ns |
| `new URL().hostname` | 306 ns |

The hostname comes off the URL string directly rather than through `new URL()`,
which is three times faster and, more to the point, skips an object per request.
`test/router.test.mjs` checks it against the platform parser over a corpus.

None of this is load-bearing. A page making 100 requests spends 24 microseconds
here. It is cheap because there was no reason for it not to be.

## Manifest V2, on purpose

Firefox MV3 makes host permissions opt-in and suspends the background page after
30 seconds idle. Both hurt a proxy extension. Every wake would have to rehydrate
state from storage before it could answer `proxy.onRequest`, adding latency to
the first request after each idle gap, and a user who never grants `<all_urls>`
gets an extension that silently does nothing.

MV2 with a persistent background page keeps the decision in memory and answers
synchronously. Mozilla continues to support MV2 and AMO accepts it.

## Deliberate omissions

**No fallback bootstrap.** `hola-proxy` can reach Hola through an encrypted
agent list on S3 when `client.hola.org` is blocked. That helps if you are
tunnelling *out* of a censored network, and is dead weight if you are tunnelling
*into* one.

**No DNS workaround.** `hola-proxy` resolves names over DoH and hands the agent
an IP, sidestepping Hola's blocklist. `proxy.onRequest` only picks a proxy and
cannot rewrite the destination without breaking SNI and the `Host` header, so
this inherits that blocklist.

## Layout

    src/manifest.json          MV2, persistent background page
    src/background/main.js     every WebExtension API call lives here
    src/background/router.js   the proxy.onRequest hot path
    src/background/session.js  handshake lifecycle, retry, rotation
    src/background/hola.js     the three Hola endpoints
    src/background/settings.js storage, defaults, input sanitizing
    src/popup/                 the panel

`main.js` is the only module that touches `browser.*`, which is what lets the
other four run under plain Node in the test suite.
