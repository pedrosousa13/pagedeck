---
section: reference
title: robots.txt
description: Generate a robots.txt in every output tree with build.robots, pointing crawlers at the sitemap the same build wrote, plus your own disallow lines.
---

# robots.txt

`build.robots` writes a `robots.txt` in every output tree, pointing crawlers at
the sitemap the same build emitted.

```ts
build: {
  outDir: "./site",
  origin: "https://example.com",
  sitemap: { pattern: "suffix" },
  robots: { disallow: ["/admin"] },
  // ...
}
```

That site is written:

```
User-agent: *
Disallow: /admin

Sitemap: https://example.com/sitemap.xml
```

**A site that declares no `robots` gets exactly the build it got before the
field existed.** No file is written and no manifest row appears. The framework
does not guess a crawl policy on your behalf — a `robots.txt` you did not ask
for is a rule you did not write, published under your name for as long as the
site is up.

`origin` is not required, unlike for a [sitemap](./sitemaps.md) or a
[feed](./feeds.md). The only URL a `robots.txt` holds is the `Sitemap:` line, and
that line is written only when you declared a `sitemap` — which does require an
`origin`. Declare `robots` without one and you get the directives you wrote,
with no `Sitemap:` line to write.

## What the build writes and what you write

The build contributes one line: where your sitemap is. Everything else in the
file is yours, written as you spelled it, in the order you declared it.

```ts
robots: {
  disallow: ["/admin", "/drafts"],
  allow: ["/admin/public"],
}
```

Every field is optional. `disallow` and `allow` go into one `User-agent: *`
group, disallow lines first — the order a carve-out is usually read in, since
the most specific rule is the one that applies and an `Allow` wins a tie.

Paths are written as a `robots.txt` spells them: starting at `/`, matched as
prefixes, with `*` and `$` carrying whatever meaning the crawler reading them
gives those characters. Nothing is normalized and nothing is checked against
your route table — a disallow list is routinely about addresses that do not
exist yet.

A path that does not start with `/`, or that holds a space or a newline, is
refused when your config loads. The message names the field, and the entry's
position in the list where there is one — a `disallow` that is not a list at all
has no position to name. A directive ends at the end of its line, so a value
carrying a newline would be a second directive you never wrote; a path that
really does hold a space is written the way a crawler requests it, with the
space percent-encoded as `%20`.

## Declaring the field and nothing else

`robots: {}` is a whole declaration. What it asks for is the one line you cannot
write for yourself:

```
Sitemap: https://example.com/sitemap.xml
```

That is a complete `robots.txt`, and it means what having no file means — no
rules — plus the pointer.

If you declare `robots` without declaring `sitemap` — or without an `origin` to
address one at — there is no line to write, and what is left is your own
directives. Declare neither those nor a sitemap and the file is empty. An empty
`robots.txt` is valid and says "no rules", which is what that site has said. The
build does not fill it with an allow-everything group, because that is a policy
nobody declared.

## Per-tree, and each names its own sitemap

A crawler asks the host it is about to fetch a page from for `/robots.txt`, so a
site whose locales sit on [domains of their own](./canonicals-and-hreflang.md)
gets the file in each of those trees — and the `Sitemap:` line in each names
that tree's own index, not your `origin`'s. A crawler on `example.de` is pointed
at `https://example.de/sitemap.xml`, which is the only pointer it will follow.

That is the [favicon](./favicon.md)'s arrangement rather than the
[feed](./feeds.md)'s, and for the same reason: a browser and a crawler both
construct these addresses from the host they are on, while a reader reaches a
feed through a link.

The line points at the sitemap **index**, which names every locale's file, so one
URL per tree gives a crawler the whole tree whichever
[pattern](./sitemaps.md) you declared.

## Lines the build does not read

`disallow` and `allow` are the two directives this build composes. Everything
else a `robots.txt` can hold — a second crawler's group, a comment, a directive
no standard names — you write yourself, in `verbatim`:

```ts
robots: {
  verbatim: [
    "User-agent: example-bot",
    "Disallow: /drafts",
    "",
    "# Crawl this site gently.",
    "Crawl-delay: 10",
  ],
  allow: ["/"],
}
```

That site is written:

```
User-agent: example-bot
Disallow: /drafts

# Crawl this site gently.
Crawl-delay: 10

User-agent: *
Allow: /

Sitemap: https://example.com/sitemap.xml
```

One string is one line, and an entry may be empty, which is how you space one
group off the next. A blank line does not end a group — a group ends at a
`User-agent:` line or at the end of the file, and nowhere else — but the spacing
is your text and the build keeps it. Nothing in the list is parsed, checked for
well-formed syntax, normalized or reordered. A directive this framework has
never heard of is the ordinary use of the field: what the line means is between
your site and the crawler reading it.

**Your lines are written first**, above the `User-agent: *` group and above the
`Sitemap:` line. Because a group ends only at a `User-agent:` line or at the end
of the file — not at a blank line, and not at the `Sitemap:` line — the order is
what decides which half can fall into the other's group.

Written first, yours cannot fall into the build's: the `User-agent: *` line
opens after all of them. Where you declared `disallow` or `allow`, that line
also closes whatever group your last line was in, so the directives under it
still mean what you declared. Where you declared neither, the build composes no
group at all: your lines are the whole policy, and the `Sitemap:` line under
them is not a rule and joins nothing. Written *after* the group, a leading
`Disallow:` of yours would join the group the build composed, and a rule you
wrote for one crawler would apply to all of them.

The cost of that position is the smaller one: a directive written with no
`User-agent:` line above it is in no group at all, and a crawler ignores it. If
you want a line **inside** the `*` group, write that whole group in `verbatim` —
`User-agent: *` and its directives together — and leave `disallow` and `allow`
undeclared.

**One case first does not cover**, and the build cannot warn you about it
because it does not read your lines. Consecutive `User-agent:` lines are one
group, so if your block ends on a bare `User-agent: example-bot` with no rule
under it, the `User-agent: *` the build writes next joins that same group — and
your `disallow` and `allow` then apply to `example-bot` too. End the block with
that crawler's rules, or write the `*` group in `verbatim` as well.

An entry that is not text is refused when your config loads, naming its position
in the list, and a `verbatim` that is not a list at all is refused with no
position to name. Those two are every check there is: a line you spelled is a
line this build writes, and all it needs of it is that it can be written.

## What it does not do

This build learns no directive beyond `Disallow` and `Allow`, and there is no
structured way to declare a second group — a per-crawler group is lines you
write, above. What the build would need before it grew one is something to
*derive* per group, and nothing does.

A staging site's `Disallow: /` is not here either, and that is a different
answer: it is a property of where a build is deployed rather than of the build,
and belongs to your deploy step.

A page of your own cannot be published at `/robots.txt`: the build refuses the
collision rather than overwrite one file with the other, and the fix is to move
the page.
