# `@pagedeck/adapter-nginx`

Compiles a built site's routing document into `routing.conf`, an nginx config
fragment to `include` inside the `server` block that serves the tree. Its
refusals name it `nginx`.

```sh
npm install @pagedeck/adapter-nginx @pagedeck/core
```

After `npx pagedeck build`, from the site's directory:

```ts
import { readFileSync } from "node:fs";
import { readManifest } from "@pagedeck/core";
import { nginx } from "@pagedeck/adapter-nginx";

const manifest = readManifest(readFileSync("site/manifest.json", "utf8"), "site/manifest.json");
for (const artifact of nginx().compile(manifest.routing).artifacts) {
  console.log(artifact.role, artifact.path);
}
```

Each artifact's `role` says where it goes, as
[`@pagedeck/edge`'s README](../edge/README.md#what-comes-out) lists. What every
adapter shares (the refusals, the 404 page's headers, the reserved deploy keys
and trailing slashes) is documented there too.

## The fragment

The fragment is only `location` blocks, one `error_page`, and the two
server-level lines that deny the reserved deploy keys. It sets no `root`
and no `try_files`, because how a route becomes a filename is the build's
decision; include it inside a `server` block that already has both.

Locations are written **decoded**, because nginx decodes the request URI before
it selects one: a route stored as `/caf%C3%A9` is emitted as
`location = "/café"`, and written escaped it would match nothing. A redirect's
target is not decoded — it goes into a `Location` header, which is a URI. A
path that cannot survive the round trip is refused rather than emitted: `%2F`,
which nginx cannot tell from a real separator, an escape that is not valid
UTF-8, and anything decoding to a control character or a `$`.

## An app beside the site

Each prefix in `build.routing.upstreams` must name `url`, the `https` origin
the app answers at, and becomes two proxy locations: `location = "/api"` and
`location ^~ "/api/"`. Without the exact one, nginx answers `/api` with a 301
to `/api/`. `^~` keeps any regular-expression location from taking the path.
`proxy_pass` names the origin with no URI part, so the app gets the request
URI and query as the client sent them.

Each proxy location sends `Host` as the app's own name, which its certificate
and virtual host expect, and the visitor's host, address and scheme in
`X-Forwarded-Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. It verifies the
app's certificate, with SNI, against `/etc/ssl/certs/ca-certificates.crt`, the
Debian and Ubuntu bundle. Name another with
`nginx({ trustedCertificate: "/etc/pki/tls/certs/ca-bundle.crt" })`. nginx
resolves the app's hostname when it loads the config, and refuses to start if
it cannot.

A tree with an upstream also gets `http.conf`, the `map` that sets
`Connection` to `upgrade` for a WebSocket and `close` otherwise. `map` is valid
only in the `http` block, so include `http.conf` there, once, whichever tree it
came from:

```nginx
http {
    include /etc/nginx/pagedeck/http.conf;
    server {
        root /srv/site;
        include /etc/nginx/pagedeck/routing.conf;
    }
}
```

The app sets its own headers. The fragment puts no `add_header` in a proxy
location and none at server level, and writes no location for a header rule
inside a prefix. An `add_header` in your own `server` block still reaches the
app's responses, because nginx inherits it into every location that has none.

An experiment split is refused, naming every page it was declared on:
`@pagedeck/adapter-cloudfront` is the only adapter that compiles one.

## Reserved deploy keys

Two `if ($uri …) { return 404; }` lines at server level deny them. They run
before any `location` is selected, which is the only place that holds: a
header rule's `^~` prefix under `/.pagedeck/` would be longer than any deny prefix
and win. `$uri` is already decoded, merged and resolved, and carries no query
string.
