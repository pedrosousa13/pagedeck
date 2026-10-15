---
section: how-to
title: Deploy to nginx
description: Serve a site from your own nginx server, include the config the build writes, and proxy a path prefix to an app with TLS checked.
---

# Deploy to nginx

This page serves a site from a server you run with [nginx](https://nginx.org/).
`nginx()` from `@pagedeck/adapter-nginx` compiles the site's redirects, header
rules and 404 page into a config fragment you include in the `server` block
that serves the site. [Deploy a site](./deploy-a-site.md) covers what every
host shares: what to upload, the plan `pagedeck diff` writes, and rolling
back.

## Name the adapter

```sh
npm install @pagedeck/adapter-nginx
```

```ts
import { defineConfig } from "@pagedeck/core";
import { nginx } from "@pagedeck/adapter-nginx";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: nginx(),
  },
});
```

`pagedeck build` writes `edge/routing.conf`, beside `site/`, and
`edge/http.conf` when the site sends a path prefix to an app. Neither is part
of the upload: copy them to the server's nginx configuration, for instance
under `/etc/nginx/pagedeck/`.

## Copy the site to the server

Copy `site/` to the directory nginx serves, deleting what the new build no
longer writes, with `manifest.json` last:

```sh
npx pagedeck sync
npx pagedeck build
rsync -a --exclude manifest.json site/ deploy@example.com:/srv/site/
rsync -a site/manifest.json deploy@example.com:/srv/site/manifest.json
```

The `rsync` above deletes nothing. Delete the files a new build no longer
writes with the `prune` rows of the plan `pagedeck diff` writes, after the
time the plan gives, as [Deploy a site](./deploy-a-site.md) describes.

## Include the fragment

`routing.conf` holds `location` blocks, one `error_page`, and two lines that
answer `/manifest.json` and `/.pagedeck/` with a 404. It sets no `root` and no
`try_files`, so include it in a `server` block that has both:

```nginx
server {
    listen 443 ssl;
    server_name example.com;
    root /srv/site;
    index index.html;
    try_files $uri $uri/ =404;

    include /etc/nginx/pagedeck/routing.conf;
}
```

Reload nginx after you copy a new `routing.conf`. Its redirects and header
rules take effect on the reload, so copy the site first, then the fragment.

nginx decodes a request's path before it picks a `location`, so the fragment
writes each path decoded: a route stored as `/caf%C3%A9` is
`location = "/café"`. A path that cannot survive that is refused when the site
builds: one holding `%2F`, an escape that is not valid UTF-8, or a control
character or `$` once decoded.

## Proxy a path prefix to an app

A site that declares `build.routing.upstreams` sends each prefix to an app you
run yourself, as [Run an app beside the site](./run-an-app-beside-the-site.md)
describes. On nginx each upstream must name `url`, the `https` origin the app
answers at:

```ts
import { defineConfig } from "@pagedeck/core";
import { nginx } from "@pagedeck/adapter-nginx";

export default defineConfig({
  collections: [],
  build: {
    pages: [],
    components: {},
    adapter: nginx(),
    routing: {
      upstreams: [{ prefix: "/api/", url: "https://api.example.com" }],
    },
  },
});
```

Each prefix becomes two proxy locations in `routing.conf`,
`location = "/api"` and `location ^~ "/api/"`. The app gets the request's
path and query as the client sent them, `Host` set to its own name, and the
visitor's host, address and scheme in `X-Forwarded-Host`, `X-Forwarded-For`
and `X-Forwarded-Proto`. nginx checks the app's certificate against
`/etc/ssl/certs/ca-certificates.crt`, the Debian and Ubuntu bundle. Name
another with `nginx({ trustedCertificate: "/etc/pki/tls/certs/ca-bundle.crt" })`.

The build also writes `http.conf`, which sets the `Connection` header a
WebSocket needs. nginx takes it only in the `http` block, so include it there
once, whatever server includes `routing.conf`:

```nginx
http {
    include /etc/nginx/pagedeck/http.conf;
    server {
        root /srv/site;
        include /etc/nginx/pagedeck/routing.conf;
    }
}
```

Two nginx facts are yours to manage:

- nginx resolves the app's host name when it loads the config, refuses to
  start if the lookup fails, and keeps the addresses until the next reload.
- An `add_header` in your own `server` block reaches the app's answers,
  because a location with no `add_header` of its own inherits it. Put the
  site's headers in `build.routing.headers` instead, and the app sets its own.
