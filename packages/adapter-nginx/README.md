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

An experiment split is refused, naming every page it was declared on:
`@pagedeck/adapter-cloudfront` is the only adapter that compiles one.

## Reserved deploy keys

Two `if ($uri …) { return 404; }` lines at server level deny them. They run
before any `location` is selected, which is the only place that holds: a
header rule's `^~` prefix under `/.pagedeck/` would be longer than any deny prefix
and win. `$uri` is already decoded, merged and resolved, and carries no query
string.
