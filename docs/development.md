# Development

No dependencies. Node 24 or newer.

## Checks

```bash
npm test
```

61 tests. The interesting ones are `test/router.test.mjs`, where `hostOf` is
checked against the platform URL parser over a corpus,
`test/session.test.mjs`, where the whole lifecycle runs against a stubbed
`fetch` with mocked timers, and `test/main.test.mjs`, which stubs the
WebExtension APIs, captures the listeners `main.js` registers, and drives it
through those rather than adding exports only tests would use.

```bash
npm run check
```

Catches what Firefox would otherwise only complain about at install time or at
runtime: broken syntax, imports pointing nowhere, files the manifest references
but nobody shipped, inline scripts the MV2 CSP refuses, and an add-on id that
disagrees with `updates.json`. That last one never fails loudly on its own; it
just means updates never arrive.

```bash
npm run bench
```

## Browser harnesses

```bash
npm run e2e
```

Loads the extension into a headless Firefox and asserts on bytes Firefox
actually puts on the wire. A loopback listener stands in for the agents, so this
needs neither Hola nor a trusted certificate. Fifteen checks, including that the
chain makes Firefox connect to the host and port the router named, that it steps
over a dead first entry to get there, that `type: "https"` really does mean TLS
to the proxy (first bytes are a ClientHello, SNI is the agent hostname), that a
disarmed extension never touches the tunnel, that fail-closed refuses a request
which would otherwise have succeeded, and that the panel renders without errors.

The listener kills every connection it accepts, which is what makes "this
request answered" a sound proof that it did not go through the tunnel.

```bash
npm run e2e:hola          # or: node tools/e2e.mjs tr de
```

The same idea against Hola itself, including that a country switch costs one
`background_init`. Needs an address Hola has not blocked, which makes it a good
acceptance check and a poor regression test.

Firefox gives a headless `web-ext` run no way to hand console output back, so
both harnesses have their probes post to a loopback collector they own. Loopback
is never tunnelled, so the report cannot be distorted by the thing it reports on.

```bash
node tools/probe-types.mjs tr
```

Measures all five exit types: agent type, vendor, port, exit address, connect
latency. Reuses one identity across all of them, because minting one per type is
the burst that causes blocks, and refuses to run at all while blocked.

```bash
node tools/capture-popup.mjs
```

Regenerates `docs/img`. Firefox's `--screenshot` fires at load and the panel
renders after an await, so this renders first, posts the settled markup back,
and shoots that.

## Releasing

```bash
npm run release -- 1.0.6
```

Verifies, runs the browser harness, stamps the manifest, tags and pushes. CI
signs through the AMO API, attaches the XPI to a GitHub Release, rewrites
`updates.json` to name it, and commits that back to `main`.

Two repository secrets are needed, from the
[AMO API key page](https://addons.mozilla.org/en-US/developers/addon/api/key/):
`AMO_JWT_ISSUER` and `AMO_JWT_SECRET`. The job checks them against AMO before
signing, so a mistyped secret fails before a tag exists rather than after. To
check without releasing:

```bash
WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… node tools/check-amo-credentials.mjs
```

Submissions are **unlisted**, so automated review signs them in a minute or two
and they never appear in the AMO gallery. A *listed* submission would go to
human review, which a Hola client is unlikely to survive, for the same reason
Hola's own extension is no longer on AMO. Unlisted add-ons remain subject to
manual review at any time.

Two things that will confuse you otherwise:

- Actions runs the workflow file **as it stood at the tagged commit**, not as it
  stands on `main`. Changes to the release job only take effect for tags cut
  after them.
- Re-pushing a tag for an already-released version is a no-op rather than a
  failure.

### How updating works

AMO signs unlisted add-ons but does not serve updates for them, so the add-on
points at `updates.json` in this repository, read over
`raw.githubusercontent.com`. That is why the repository is public.

Firefox polls it, compares versions, and checks `update_hash` against the
download before installing. Without that hash a swapped release asset would be
trusted purely for arriving at the expected URL.

An installed copy only ever checks the `update_url` it shipped with, and builds
before 1.0.5 shipped with none.
