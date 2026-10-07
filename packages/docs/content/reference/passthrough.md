---
section: reference
title: Passthrough files
description: Files in a passthrough directory are published at the addresses you place them, in every output tree, with collisions refused and links checked.
---

# Passthrough files

`build.passthrough` publishes a directory of files your site owns — a logo, an
Open Graph image you drew yourself, an SVG icon, a PDF — at the addresses you
put them at, in every output tree.

```ts
build: {
  outDir: "./site",
  passthrough: { root: "./public" },
  // ...
}
```

Both directories are resolved against the config file, not against whatever
directory `pagedeck` was run from. A path that names nothing, or names a file rather
than a directory, refuses the build before a page is rendered, naming the key you
wrote:

```
Config "/site/pagedeck.config.ts": "build.passthrough.root" names a directory that does not exist — "/site/nowhere" — point root at the directory of files the site publishes, or remove passthrough
```

**A site that declares no `passthrough` gets exactly the build it got before the
field existed.** No file is written and no manifest row appears.

`contentRoot` is the second key, and it answers a different question — the
images a post points at from beside its own markdown. It has a section of its
own below. Both keys are optional, so a site whose only files are the ones its
posts point at declares `contentRoot` alone, and nothing is published whole:

```ts
passthrough: { contentRoot: "./src" },
```

## The address is where you put the file

Every file beneath `root` is published at its own path beneath `root`, with a
leading slash:

| On disk | Served at |
| --- | --- |
| `public/favicon.svg` | `/favicon.svg` |
| `public/assets/logo.png` | `/assets/logo.png` |
| `public/docs/rate-card.pdf` | `/docs/rate-card.pdf` |

Nesting is preserved, nothing is flattened, and no content hash is added to a
name. That is the point: these are addresses you already published, and a site
moving onto this framework keeps serving them.

There is no ignore list and no pattern. Every file in the directory is
published, so what a reader can fetch is what you can see on disk.

## The bytes are yours

The build writes each file byte for byte. Nothing decodes an image, resizes it
or converts it — this field is about **emission**, not optimization. Build-time
image processing is a separate question and is not answered here.

## Collisions are refused

A file whose address one of the build's own stages already claimed fails the
build, naming the address and what was written there:

```
Passthrough: 1 file is at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and the files this build composes are all written first; move the page off that address, or take the file out of the directory "build.passthrough.root" names:
  "/about/index.html" — the build already emitted an html file there
```

Neither side wins silently. A page shadowed by a file is a route that 404s for a
reader and builds green in CI; a file shadowed by a page is an image that stops
loading with nothing to say why.

The build's own addresses are its pages, its chunks under `/assets/`, and the
files the optional stages write: [sitemaps](./sitemaps.md), a [feed](./feeds.md)
at `/rss.xml`, a [favicon](./favicon.md) at `/favicon.ico`, a
[`robots.txt`](./robots.md), a [preview app](./preview.md) under its declared
path, and a search index. Your own `/assets/` directory and the build's share a
directory and not an address: a chunk is named after the module it came from and
carries a hash, so `public/assets/logo.png` collides with nothing.

**A page also cannot need a directory where the build writes a file**, or the
reverse. A page's HTML file is its route plus `/index.html`, so under
`trailingSlash: "always"` a page at `/sitemap.xml/` needs `/sitemap.xml` as a
directory, and the sitemap index is a file there. The build checks every page
against every file it emits into the same output tree, under every
`trailingSlash` policy, before it writes anything. It reports every collision in
one run:

```
Site build: 1 page document collides with a file this build emits into the same tree — a path in an output tree holds a file or a directory, never both, so no page below can be written beside the file its line names; route each page below at another path, or move the file if it is a passthrough file:
  en /sitemap.xml/ — its document "/sitemap.xml/index.html" needs "/sitemap.xml" as a directory, where the build emits an asset file
```

## Images a post points at from beside its content

A markdown post that writes

```
![Ferry logo](../../assets/images/ferry/logo.png)
```

reaches the emitted HTML as an `<img src>` holding exactly that, and a browser
reading the post resolves it against the page's own address. Until this key
existed nothing in the build looked at such a reference: it was not root-relative
and it was not an external URL, so the link check skipped it, and the page
shipped a dead image on a green build.

`contentRoot` is where those files live:

```ts
build: {
  outDir: "./site",
  passthrough: { root: "./public", contentRoot: "./src" },
  // ...
}
```

A post at `/posts/ferry` writing `../../assets/images/ferry/logo.png` asks for
`/assets/images/ferry/logo.png`, so the build publishes
`src/assets/images/ferry/logo.png` there. The address the reference reaches and
the address the file takes are the same string, which is what makes the reference
work rather than a coincidence you have to check.

**Only a file a page points at is published.** That is the difference from
`root`, and it is why `contentRoot` can be a tree that also holds your markdown,
your components and your layouts: nothing publishes them, because no page's
`<img>` names them. An image sitting in the tree that no post uses is not
published either.

**A reference that names nothing there refuses the build**, naming the page, what
it wrote, the address this build went looking at, and the entry the reference is
written in — which is the file you open to fix it:

```
Passthrough: 1 reference a page makes to a file beside its content resolves to nothing this build can publish — put the file at that path beneath the directory "build.passthrough.contentRoot" names, or point the reference at a file that is already there:
  en /posts/ferry — "../../assets/images/ferry/rules.png" → "/assets/images/ferry/rules.png" — content entry "posts en posts/ferry"
```

**Without `contentRoot`, the build warns instead.** A site that declares no
content tree still ships each content-relative reference as written, with no
file behind it, and the build passes. It prints one warning, with one line per
address: the first page that reaches it, what that page wrote, the address, and
the entry it is written in. The fix is to declare `contentRoot`:

```
Passthrough: 1 content-relative reference resolves to nothing this build publishes, because this site declares no build.passthrough.contentRoot — a content-relative reference resolves against the address its page is served at, and the file it names is published from the content tree that key declares, so without it each page below points at an address nothing in this build emits; this is a warning and not a refusal because the host may serve these files from somewhere this build never reads — declare build.passthrough.contentRoot as the directory these files sit beneath, and the build publishes each one and refuses any that is missing:
  en /posts/ferry — "../../assets/images/ferry/logo.png" → "/assets/images/ferry/logo.png" — content entry "posts en posts/ferry"
```

Your `trailingSlash` decides the address each page is
served at, so it decides what a relative reference resolves to: `./logo.png` on
`/posts/ferry` asks for `/posts/logo.png` under `"never"` and
`/posts/ferry/logo.png` under `"always"`. The build resolves it the way the
browser will.

A root-relative reference and an `https:` one are untouched by this key — the
first already names an address and `root` is where its file comes from, and the
second names another origin's file.

## The link check sees them

A root-relative reference to a published file resolves. A page writing
`<img src="/assets/logo.png">` builds green where that file is in the directory,
and is reported as a [broken reference](./link-checking.md) where it is not — so
a file removed from `root` while a page still points at it is a failed build
rather than a broken image in production.

## One copy per output tree

A reference like `/assets/logo.png` is resolved by the browser against the host
that served the page, so a site whose locales sit on
[domains of their own](./canonicals-and-hreflang.md) gets the whole directory in
each of those trees rather than one copy somewhere.

`origin` is **not** required, which is where this differs from a
[sitemap](./sitemaps.md) and a feed. Those hold absolute URLs and are refused
without one; the build composes no URL from a file you own.

## What this is not

Fonts have a field of their own. A face declared in `build.fonts` is subset,
hashed and linked from a stylesheet the build writes, which is work this field
does none of — leave your font files out of `root` and declare them there.

The same is true of the icon at `/favicon.ico`, the social cards
`build.socialImages` draws into `/social/` and every build-time document: each
is a stage with its own field, and this one is for the files that have no stage
because nothing derives them. An Open Graph image you drew and pointed a page's
`image` at is not one of those cards — nothing drew it here, so it belongs in
`root` with the rest of what you own.
