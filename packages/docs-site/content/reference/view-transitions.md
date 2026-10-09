---
section: reference
title: View Transitions
description: Turn on cross-document View Transitions for every page with build.viewTransitions, restyle the animation, and see which browsers support it.
---

# View Transitions

`build.viewTransitions` opts every page into cross-document [View
Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API):
a browser that supports them animates the change from one page to the next
instead of blanking the screen, and a full page load starts to feel like a
single-page app.

```ts
build: {
  outDir: "./site",
  viewTransitions: true,
  // ...
}
```

**A site that declares nothing — or declares `false` — gets exactly the build it
got before the field existed.** No element is written and no page's bytes move.

## What it emits

One element, first in the `<head>`'s stylesheet block, on every page:

```
<style>@view-transition { navigation: auto; }</style>
```

That is the whole of what the framework writes. `@view-transition` is a CSS
at-rule, so this adds no JavaScript, no chunk and no event listener — the
transition is run by the browser.

**Both documents need it**, which is why it is on every page rather than on the
pages you name: a cross-document transition is an agreement between the page
being left and the page being entered, and a navigation where only one side
carries the rule is a navigation that does not animate. It is written inline
rather than linked for the same reason — a page that links no stylesheet at all
still gets it.

## Making it yours

The default transition is a cross-fade. Everything past that is ordinary CSS in
your own stylesheets, which this framework never writes and never reads:

```
::view-transition-old(root) {
  animation: 120ms ease-out both fade-out;
}

header {
  view-transition-name: site-header;
}
```

Give an element the same `view-transition-name` on both pages and the browser
animates it from where it was to where it now is. Because your rules come after
the framework's, a rule of your own can also turn the feature back off for part
of a site.

## Browser support

Cross-document transitions are a progressive enhancement. A browser without them
ignores the at-rule and navigates the way it always did, so there is nothing to
feature-detect and no fallback to write.

Pair it with [speculation rules](./speculation-rules.md) if you want the
navigation to be fast as well as smooth: one makes the next page arrive early,
the other makes the arrival look like a transition rather than a reload.
