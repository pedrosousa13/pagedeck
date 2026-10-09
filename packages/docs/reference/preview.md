---
section: reference
title: Preview app
description: Emit the CMS preview app into the output tree at a path you choose with build.preview, and what the bridge module you supply connects.
---

# Preview app

`build.preview` emits the CMS preview app into your output tree, at the address
you name.

```ts
build: {
  outDir: "./site",
  preview: {
    path: "/_preview",
    bridge: "./src/preview-bridge.ts",
  },
  // ...
}
```

That site gets a `/_preview/index.html` and, under `/_preview/assets/`,
the app's own chunks. `pagedeck build` says so under its summary, on one line:

```
preview: /_preview — this app authenticates nothing and renders any draft posted to it; put the deployment behind whatever the drafts need (Pagedeck documentation: Preview app, Security)
```

The app is a client-rendered build target for a CMS visual editor. It loads your
whole component registry and renders whatever draft the editor posts to it,
through the same render function that built your pages.

## Security

Read this before you declare `build.preview`.

**The preview app authenticates nothing.** There is no login, no token and no
session. Anything that can reach the URL can post a draft to it and see it
rendered, and the drafts your editor sends are your unpublished content.

The framework provides no access control and is not going to. What stands in
front of the app is whatever stands in front of your site: a password on the
path at your CDN or reverse proxy, an allowlist, a separate bucket that is not
public. If your published site is public and your drafts must not be, the app's
path needs something the rest of the site does not have.

The document carries `<meta name="robots" content="noindex">`, which asks
crawlers that honour it not to list the address. That is not access control and
it is not offered as any.

The bridge's own defence is an origin allowlist, which decides who may *post* a
draft, not who may *load* the app. The allowlist lives in your bridge module,
as in the [example below](#the-bridge), so widening it is an edit to a file you
review. Write it with these rules:

- **Compare each origin whole, with `===` or an array's `includes`.** A
  prefix or substring test admits `https://editor.example.attacker.test` as
  `https://editor.example`.
- **List exact origins, with no wildcard and no default.** A bridge that
  accepts any origin renders whatever any page on the internet posts at it.
- **Never list `"null"`.** A sandboxed frame or a `file:` page posts with that
  origin, so listing it admits any page that can make one.
- **Drop a message from an unlisted origin without a report.** A browser tab
  receives `postMessage` traffic from other software all the time, and a report
  for each message fills the console. The cost is that a wrong origin looks
  exactly like an editor that sent nothing. When a preview never updates, check
  the list first.

## Declared or absent

**A site that declares no `preview` gets exactly the build it got before the
field existed.** No document, no chunk, no manifest row. That is the whole
design: an unauthenticated renderer of your drafts is not something a build
ships because somebody forgot a flag, so it ships only where somebody wrote the
address down.

There is no default path, for the same reason. A default would put the app at
one well-known address on every site built with this framework, and since the
app authenticates nothing the address is the only thing about who finds it that
you control.

## Everything it emits is under one path

The document and every chunk live under the `path` you declared — nothing of the
app is mixed into your site's own `/assets/`. So the prefix you put a login in
front of is the prefix the app is at, and a diff of two output trees shows the
app arriving as one subtree.

Your pages are unaffected. The preview app and your site are two separate
bundler runs sharing no module graph, so no chunk any page of yours loads holds
a byte of it.

## Per-tree

A site whose locales sit on [domains of their own](./canonicals-and-hreflang.md)
gets the whole app in each of those trees. The document loads its app with a
root-relative URL, which a browser resolves against the host that served the
document — so one copy in one tree would be a broken page on every other host.
Point each market's editor at that market's host.

## The bridge

`bridge` names one of your own modules, which default-exports a
`PreviewBridge` from `@pagedeck/preview`. It is an interface with one method:

```ts
interface PreviewBridge {
  subscribe(onDraft: (payload: unknown) => void): () => void;
}
```

The app calls `subscribe` once when it mounts. Your bridge listens to your
editor, passes each draft to `onDraft`, and returns a function that stops
listening. The app reads each payload as a draft and refuses one it cannot
read, naming every fault. Everything about your editor's messages is the
bridge's job, because the framework knows no editor.

A bridge for an editor that sends each draft with `postMessage` is a short
module. `src/preview-bridge.ts`:

```ts
import type { PreviewBridge } from "@pagedeck/preview";

// The exact origins your editor runs on. Nothing else may post a draft.
const EDITOR_ORIGINS: readonly string[] = ["https://editor.example"];

const bridge: PreviewBridge = {
  subscribe(onDraft) {
    const listener = (event: MessageEvent): void => {
      if (!EDITOR_ORIGINS.includes(event.origin)) return;
      onDraft(event.data);
    };
    window.addEventListener("message", listener);
    return () => {
      window.removeEventListener("message", listener);
    };
  },
};

export default bridge;
```

The allowlist is in this file and not in the config, so the config key stays a
module path and nothing else. If your editor also sends handshakes or pings on
the same channel, drop them in the listener as well. The app reports each
payload it cannot read as a draft, so one forwarded ping is one error.

`bridge` is optional. An app built without one renders nothing until something
sends it a draft, which is what you want if you are wiring a bridge of your
own somewhere else.

## What it does not do

There is no `pagedeck preview` verb and no dev-server preview route. `pagedeck build` is
what emits the app, because the app is a deployed artifact and a deploy is what
an editor loads.

The path is not a route. No `definePages()` declares it, no page carries it, and
your sitemaps and feeds never mention it. If a page of yours would be published
under the same address, the build refuses the collision rather than overwrite one
file with the other, and names every key it collided at — move the page, or
declare a different `path`.
