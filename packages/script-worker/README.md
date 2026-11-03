# `@pagedeck/script-worker`

The script runtime adapter for `build.scripts.runtime`, on
[Partytown](https://partytown.qwik.dev/). It loads each page's `worker`
scripts in a web worker, off the main thread. The build writes Partytown's
service worker and its other files under `/script-runtime/<hash>/` on the
site's own origin, and each page carries Partytown's inline snippet and one
`<script type="text/partytown">` per script.

```sh
npm install @pagedeck/script-worker
```

```ts
import { defineScripts } from "@pagedeck/core";
import { definePartytown } from "@pagedeck/script-worker";

export const runtime = definePartytown({ forward: ["dataLayer.push"] });

// In the site's config, inside build:
scripts: defineScripts({
  scripts: [{ name: "tags", src: "https://example.com/gtm.js" }],
  runtime,
}),
```

It runs Partytown in service-worker mode only, and writes no file for
Partytown's Atomics mode, which needs a cross-origin-isolated page (#275). A
`worker` script that declares `integrity` fails the build, because Partytown
fetches it without an integrity check. A script with a consent `category` never
reaches this adapter: the build loads it on `idle`, behind the consent gate
(#47).

`resolveUrl` maps a vendor's `https` origin to a path prefix on the site, which
an upstream app forwards to that origin. `runtime.inlineScriptHash` is the
snippet's hash for a `Content-Security-Policy`. The package pins
`@qwik.dev/partytown` to one exact version, because a new version changes the
snippet's bytes and so its hash.

## Read more

[Third-party scripts](https://page.deck.cool/docs/reference/third-party-scripts/#run-worker-scripts-on-partytown)
covers every option, `resolveUrl` with an upstream, and the snippet's hash.
