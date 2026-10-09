---
section: explanation
title: Why this site ships no JavaScript
description: Nothing on these pages is declared interactive, so none carries a script tag, and the search page is the one exception because its control must run.
---

# Why this site ships no JavaScript

View the source of any page of this documentation and you will find no
`<script>` tag. That is not a setting anyone turned on. It is what happens when
nothing on the page is declared interactive.

One page is not a page of the documentation, and it is the exception this
document ends on: `/search` offers a control, and a control has to run
somewhere.

## Where the script tag comes from

The framework decides what to hydrate from the module, not from a list. A
component whose module opens with `"use client"` is a boundary and defaults to
hydrating when it scrolls into view; a component whose module does not is
rendered on the server and stops there. A site can override either direction by
declaring `hydrate` on the component's registry row.

So a page with no island has none to plan. With no island there is no generated
entry module, with no entry module there is no bundler input, and with no bundle
there is nothing for the document writer to reference. The page gets no tag at
all rather than an empty one.

Every document of this site renders through one template whose module carries no
directive, and whose registry row declares no `hydrate`. The whole
zero-JavaScript property is those two facts.

## What it costs, honestly

A page that ships no script cannot reveal anything it was not rendered with. So
the navigation on every page lists every document; on a narrow screen it folds
into the browser's own `<details>` disclosure, which needs no script. Nothing on
it responds to a keystroke.

The syntax highlighting you see in the code samples is not an exception to any
of this. It happened while the site was being built: the loader that read each
markdown file also tokenised its code fences and wrote the colours into the
markup as inline `style` attributes. Nothing about it runs in your browser, and
it needs no stylesheet either. This site does link one — declared as
`build.css`, and it carries the layout — but block it and the code samples are
still in colour, because the colours were never in it.

This site has a dark theme, and it keeps the same arrangement for its light
colours. The loader takes a light theme and a dark one: the light colours are
written inline as above and need no stylesheet, and the dark colours sit beside
them in the same `style` attribute as CSS custom properties. Those take effect
only through one CSS rule that the site supplies in its own stylesheet. Here
that rule is keyed on the reader's `prefers-color-scheme`, so there is no
toggle; a site that wants one keys the rule on the attribute its toggle sets,
and the toggle, and the choice to ship one, belong to that site. Either way it
is no script from the loader.

## The one page that does

Search is the thing a reader of a documentation site asks for that a rendered
document cannot answer. The index itself is built rather than served: every page
of this site is tokenised at build time and written out as JSON beside the
pages, so there is no search server anywhere. But something has to read what you
type, fetch the part of that index it needs and show you the results, and that
something is JavaScript.

It could have gone on every page as a box in the header. It did not, and the
reason is the promise above: a search box in the header is a bundle on every
page, paid for by every reader, including the ones who followed a link and never
searched. So the control lives on one page — `/search` — which is the only page
of this site that ships a script. It loads when the browser is idle, and it asks
for nothing at all until you focus the box or type into it.

That is the trade this framework is built to let a site make: not "no JavaScript
anywhere", which is a promise no site with a search box can keep, but *only the
JavaScript one page needs, on that page*.

## Why the docs are the right thing to prove it on

Documentation is the case a static-site framework is most obviously right for,
and it is the case where the promise is easiest to break. Almost every docs site
ships a highlighter, a search box and a theme toggle, and pays for them on every
page whether or not the reader uses one. Building the documentation on the
framework, with the constraint held, is how the claim gets tested by use rather
than asserted.
