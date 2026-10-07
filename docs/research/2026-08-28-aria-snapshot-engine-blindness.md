# Can a Playwright harness see one engine's accessibility tree from another's?

**Date:** 2026-08-28
**Status:** Finding — negative result, recorded. Closes step 1 of issue #92 and stops it there.
**Question:** Issue #92 wants `<fw-island role="presentation" style="display: contents">` checked in Firefox and WebKit, because prototype #68 measured it in Chrome 149/150 alone. Before any such test is written: can a Playwright harness report a **difference between engines** at all? If its accessibility snapshot is computed by Playwright rather than by the engine, running one in three browsers returns three identical answers by construction — a test that looks like it verifies Firefox and WebKit while verifying nothing about either.
**Relates to:** `packages/islands/src/marker.ts`, whose `ISLAND_TAG` docblock carried the Chrome-only scope when this was written; prototype #68; issue #59, which needs browser tooling regardless of this outcome.
**Method note:** Playwright 1.62.1, engines as installed by `npx playwright install`: Chromium 151.0.7922.34 (headless shell), Firefox 153.0 (Gecko), WebKit 605.1.15 / Safari 26.5 (WPE MiniBrowser). Source read out of `node_modules/.pnpm/playwright-core@1.62.1/.../lib/coreBundle.js`. Every snapshot below was taken with `page.locator("body").ariaSnapshot()` on a `setContent` page with no stylesheet.

**Re-running it.** `packages/islands/src/aria-engine.harness.ts` is §1–§4 as assertions, for the reason `2026-08-26-slot-rerender-detection.md` gives for its own: §7 names the releases that would need this re-measured, and a document is not a thing that fails when it goes stale.

```
pnpm test:aria-harness
```

It sits beside `src/slot-rerender.harness.tsx`, where this repo's other harness is, and `packages/islands/vitest.aria-engine.config.ts` runs it alone. The root `vitest.config.ts` does not reach it, so `pnpm test` neither needs a browser installed nor pays for three launches on every run. `tsconfig.build.json`'s exclude list keeps both harness extensions out of `dist`, so `playwright` stays a `devDependency` of `packages/islands` and off its runtime import graph.

---

## Verdict

**It cannot.** Playwright's ARIA snapshot is computed by Playwright's own implementation of the ARIA spec, injected into the page as script. Every browser facility in the code paths §1 quotes is the DOM and `getComputedStyle`; no engine accessibility API appears in any of them, and none is reachable from the injected bundle in any of the three browsers. Three engines therefore return the same string because the same JavaScript ran three times, and that is a fact about the harness, not a finding about the engines.

The result is sharper than "identical output". **The snapshot does not contain the property issue #92 is about.** A wrapper element between a `<ul>` and its `<li>`s produces the same snapshot with `role="presentation"` and without it, in every engine — because in Playwright's renderer an element with no role and an element with `role="presentation"` take the same branch and both emit no node. The harness has no observable for the thing the marker's role exists to do, before engines even enter the question.

And that non-difference is not a property of the page. Chromium's own tree, read over CDP on the same two pages, **does** separate them when the wrapper is a `<div>`: §3. It does not separate them for the marker's own element, which is absent from that tree either way — §4, and a finding of its own about the docblock rather than about the harness. So the snapshot is not merely agreeing with the engines — it is discarding a distinction the one engine we can interrogate makes.

**Step 2 does not proceed.** A `<ul>`/`<li>` test written on this harness would pass in Firefox and WebKit on the day the marker was broken in both. What could settle #92 instead is §6.

---

## 0. Getting three engines to run, which is not free on Linux

Recorded because #59 inherits it. `npx playwright install chromium firefox webkit` downloads all three, and Chromium and Firefox then launch on an unprepared Ubuntu 24.04 box. WebKit does not:

```
webkit FAIL browserType.launch:
╔══════════════════════════════════════════════════════╗
║ Host system is missing dependencies to run browsers. ║
║     sudo npx playwright install-deps                 ║
║ Alternatively, use apt:                              ║
║     sudo apt-get install libevent-2.1-7t64\          ║
║         libgstreamer-plugins-bad1.0-0\               ║
║         libavif16                                    ║
╚══════════════════════════════════════════════════════╝
```

There is no root on this machine. The libraries were supplied without it: `apt-get download` the three packages plus `libavif`'s own transitive codecs (`libgav1-1`, `libdav1d7`, `libyuv0`, `librav1e0`, `libsvtav1enc1d1`, `libaom3`), `dpkg-deb -x` them, and copy the `.so` files into `~/.cache/ms-playwright/webkit-2336/minibrowser-wpe/sys/lib/`. That directory rather than `LD_LIBRARY_PATH`, because Playwright's launcher wrapper **overwrites** the variable:

```sh
# minibrowser-wpe/MiniBrowser
export LD_LIBRARY_PATH="${MYDIR}/lib:${MYDIR}/sys/lib"
exec "${MYDIR}/bin/MiniBrowser" "$@"
```

With the libraries in place, `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` gets past the preflight check, which still reads the system package database and still says no. `vitest.aria-engine.config.ts` sets that variable itself, so `pnpm test:aria-harness` runs as written rather than only under an exported shell variable named nowhere near the script. On a CI image with root, `npx playwright install-deps` replaces all of this; the point for #59 is that WebKit on Linux is the expensive engine and the one that will fail first.

## 1. Where the snapshot is computed, from the source

`ariaSnapshot()` resolves to `generateAriaTree`, and `generateAriaTree` is inside the string literal `coreBundle.js` carries as the injected script — the escaped newlines are what a JavaScript string looks like in a bundle, and the file it came from is named in the comment the bundler left:

```
// packages/injected/src/ariaSnapshot.ts
var lastRef = 0;
function toInternalOptions(options) {
```

The role of an element comes from a table keyed on tag name, in that same injected file:

```js
var kImplicitRoleByTagName = {
  "A": (e) => { return e.hasAttribute("href") ? "link" : null; },
  "ARTICLE": () => "article",
  "BUTTON": () => "button",
  "DETAILS": () => "group",
  "DT": () => "term",
  …
};
function computeAriaRole(element) {
  const explicitRole = getExplicitAriaRole(element);
  if (!explicitRole) return getImplicitAriaRole(element);
  …
}
```

The only browser facility anywhere near it is `getComputedStyle`, used for visibility and for `display: contents`:

```js
function isElementHiddenForAria(element) {
  if (isElementIgnoredForAria(element)) return true;
  const style = getElementComputedStyle(element);
  const isSlot = element.nodeName === "SLOT";
  if ((style == null ? void 0 : style.display) === "contents" && !isSlot) { … }
```

So the snapshot is the ARIA spec re-implemented over the DOM. An engine can only change it by disagreeing about a computed style — never by exposing a role differently, which is the whole of what #92 asks about.

**The line that matters most for the marker.** Emitting a node is decided here:

```js
const defaultRole = options.includeGenericRole ? "generic" : null;
const role = (_a = getAriaRole(element)) != null ? _a : defaultRole;
if (!role || role === "presentation" || role === "none")
  return null;
```

`includeGenericRole` is set only by `mode: "ai"`; `ariaSnapshot()` uses `mode: "default"`, so the flag is off. A `<div>` is not in the tag table, so `getAriaRole` returns null, so the node is dropped — by **exactly the same branch** that drops a `role="presentation"` node. The two states the marker's docblock distinguished are one state to this renderer. §2 measures it.

**The older API is not an alternative.** `page.accessibility.snapshot()` was Chromium-only and backed by CDP, which would have been the mirror problem. It is moot: in 1.62.1 the namespace is not on the object at all.

```
page.accessibility = undefined
_snapshotForAI = undefined
```

## 2. Nine structures, three engines, byte-identical

Structures chosen because the engines are known or plausibly claimed to expose them differently: `display: contents` on a container (the exact mechanism #92 is about), `<summary>`, date and colour inputs, the `<search>` element, a table with its display overridden, and inline SVG.

| Case | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| `<ul style="display:contents">` | `- list:`↵`  - listitem: one`↵`  - listitem: two` | same | same |
| `<details><summary>` | `- group: More` | same | same |
| `<input type="week">` | `- textbox "wk"` | same | same |
| `<input type="color">` | `- textbox "col": "#000000"` | same | same |
| `<search>` | `- search:`↵`  - textbox "q"` | same | same |
| `<table style="display:block">` | `- table:`↵`  - rowgroup:`↵`    - row "cell":`↵`      - cell "cell"` | same | same |
| `<svg aria-label="pic">` | `- img "pic"` | same | same |
| `<ul><li>one</li><x-wrap style="display:contents"><li>two</li></x-wrap></ul>` | `- list:`↵`  - listitem: one`↵`  - listitem: two` | same | same |
| …with `role="presentation"` on `x-wrap` | `- list:`↵`  - listitem: one`↵`  - listitem: two` | same | same |

Not one character differs, anywhere.

**Three genuinely different engines really ran, and they really do disagree about these pages.** The identity above is not a harness that launched Chromium three times:

| | Chromium | Firefox | WebKit |
| --- | --- | --- | --- |
| `navigator.vendor` | `Google Inc.` | `` | `Apple Computer, Inc.` |
| `"mozInnerScreenX" in window` | false | **true** | false |
| `CSS.supports("-moz-appearance","none")` | false | **true** | false |
| **`input[type=week].type`** | **`week`** | `text` | `text` |
| `input[type=datetime-local]` width | 211px | 225px | 39px |

The fourth row is the one to read. Chromium implements `type="week"`; Gecko and WebKit fall the element back to a plain text field, so on that page the three engines are not looking at the same control at all — and the harness reported `- textbox "wk"` for all three, because Playwright's table maps `INPUT` to `textbox` and never asks the engine what it made of the attribute.

**And the last two rows of the first table are the marker's own question.** `x-wrap` with `role="presentation"` and `x-wrap` without it produce identical output. So does the `<div>` pair in §3. The harness cannot see the role at all, in the engine where prototype #68 measured that the role matters.

## 3. Chromium's own tree, which does see it

The same two pages, in the same Chromium, read through `Accessibility.getFullAXTree` over CDP — an engine API, not an injected script. `InlineTextBox` rows dropped; ignored nodes kept and marked, because an ignored node is still a node in the tree the engine built.

`<ul><li>one</li><div><li>two</li></div></ul>`:

```
RootWebArea
  [ignored] none
    [ignored] none
      list
        listitem
          ListMarker
            [ignored] none
          StaticText
        [ignored] none          ← the wrapper
          listitem
            ListMarker
              [ignored] none
            StaticText
```

`<ul><li>one</li><div role="presentation"><li>two</li></div></ul>`:

```
RootWebArea
  [ignored] none
    [ignored] none
      list
        listitem
          ListMarker
            [ignored] none
          StaticText
        listitem
          ListMarker
            [ignored] none
          StaticText
```

The wrapper is a node between `list` and the second `listitem` when it has no role, and the `listitem` is a direct child of `list` when it does. That is the shape prototype #68 describes. **`ariaSnapshot()` returned the same string for both of these.**

This is what turns §2 from "the engines agree" into "the harness is blind". A distinction the one engine we can interrogate makes is a distinction the cross-engine harness discards.

**One byproduct, and it is not the answer to #92.** In Chromium, a custom element with `display: contents` and *no* role — `<ul><li>one</li><x-wrap style="display:contents"><li>two</li></x-wrap></ul>` — produced no intermediate node either, unlike the `<div>` above. §4 follows that hint to the marker's own element.

## 4. The same tree, read for the marker itself

§3's two pages are a `<div>`, which is not what the build emits. The marker is `<fw-island role="presentation" style="display: contents">`. The measurement §3 already builds costs one more `setContent` per case, so it was taken: same Chromium 151.0.7922.34, same `Accessibility.getFullAXTree` over CDP, same `<ul>` with the wrapper between the first `<li>` and the second, same `InlineTextBox` rows dropped and ignored nodes kept.

**`<div>` wrapper, no role** — §3's control, repeated here so the four trees can be read against each other:

```
RootWebArea
  [ignored] none
    [ignored] none
      list
        listitem
          ListMarker
            [ignored] none
          StaticText
        [ignored] none          ← the wrapper
          listitem
            ListMarker
              [ignored] none
            StaticText
```

**`<div role="presentation">` wrapper** — §3's other control:

```
RootWebArea
  [ignored] none
    [ignored] none
      list
        listitem
          ListMarker
            [ignored] none
          StaticText
        listitem
          ListMarker
            [ignored] none
          StaticText
```

**`<fw-island style="display: contents">` — the marker's element, no role:**

```
RootWebArea
  [ignored] none
    [ignored] none
      list
        listitem
          ListMarker
            [ignored] none
          StaticText
        listitem
          ListMarker
            [ignored] none
          StaticText
```

**`<fw-island role="presentation" style="display: contents">` — the marker as the build emits it:**

```
RootWebArea
  [ignored] none
    [ignored] none
      list
        listitem
          ListMarker
            [ignored] none
          StaticText
        listitem
          ListMarker
            [ignored] none
          StaticText
```

**The last three are the same tree, to the byte.** Only the first differs. In Chromium 151 the marker's element contributes no node to the accessibility tree whether or not it carries `role="presentation"` — so on this measurement, on this structure, in this engine, the role is not what removes it. The role is what removes a `<div>`.

**What does remove it, from four more controls.** The wrapper's node survives exactly when the wrapper generates a box of its own:

| Wrapper in the `<ul>` | Wrapper node in Chromium's tree |
| --- | --- |
| `<div>` | present, `[ignored] none` |
| `<div role="presentation">` | absent |
| `<div style="display: contents">` | **absent** |
| `<span>` | absent |
| `<fw-island>` (no `display`, no role) | absent |
| `<fw-island style="display: contents">` | absent |
| `<fw-island role="presentation" style="display: contents">` | absent |
| `<x-wrap style="display: contents">` | absent |

`display: contents` alone is enough, on a `<div>`. So is being inline: a `<span>`, and an unknown hyphenated element, which the engine lays out as inline because that is the default for a tag it has no sheet rule for. Nothing here is specific to the hyphen or to the custom-element-ness — the marker is absent from this tree twice over, once for its `display: contents` and once for being an unknown element, before the role is considered at all.

**What this does not say.** It is one engine, one structure, and a tree read by a protocol rather than by an assistive technology. It is also not the tree prototype #68 described: the node the `<div>` leaks here is an `[ignored]` one, and #68 reported a `generic` node, so either Chrome 149/150 built that tree differently or #68's page was not this page. And an `[ignored]` node is one the engine has already decided not to expose — whether the difference in the first tree is a difference any screen reader can hear is exactly the question §6's third and fourth bullets exist for, and it is still not answered.

**What it does say** is that the sentence in `marker.ts` — that `display: contents` is not what removes the wrapper and the role is — does not hold for this element in this engine, in either half. `marker.ts` was changed to carry the measurement rather than the claim. Whether the marker should keep `role="presentation"` on the strength of this is not decided here: choosing the marker's role is out of scope for #92, one Chromium is not the three engines the docblock's scope line is about, and a role that is redundant in Chromium is not thereby wrong in Gecko or WebKit, where nothing has been read.

## 5. What was therefore not established

Nothing about Firefox or WebKit's accessibility trees. The measurements above say what Playwright computes; they contain no reading of Gecko's or WebKit's own tree, because no facility in this harness produces one. The docblock's "Verified in Chrome 149/150; Firefox and WebKit are untested" was still exactly true when this was written, and this document does not shorten it — it establishes that the tool #92 proposed to shorten it with cannot.

`role="presentation"` on the marker was re-verified in Chromium, and §4 is that measurement: in Chromium 151 the marker's element is absent from the tree with the role and without it. That is a reading of one engine through a debugging protocol. It is not a reading of what a screen reader announces, and it is not Gecko or WebKit.

## 6. What could settle it

In rough order of cost, and none of them is Playwright:

- **Chromium's CDP tree** is real, is already reachable, and has now been read for the marker itself: §3 and §4, both pinned in the harness. It answers for one engine and there is no equivalent in Playwright's Firefox or WebKit builds, so it cannot close #92 — and what it says about the marker is that Chromium builds no node for that element with the role or without it, which is a smaller claim than the one prototype #68's sentence carried.
- **Each engine's own inspector protocol.** Firefox exposes an accessibility actor over the Remote Debugging Protocol; WebKit exposes an accessibility object model to its own inspector. Both are outside what Playwright surfaces, so this means driving the engines directly — a much larger tool than #59 needs for anything else.
- **Platform accessibility APIs.** AT-SPI on Linux, UIA on Windows, AX on macOS — the tree an assistive technology actually receives, which is one conversion further out than any of the above and the only place `role="presentation"` finally means something to a user. `accerciser` or an AT-SPI binding reading a real Firefox is the honest version of this measurement.
- **A real screen reader.** NVDA and VoiceOver with the `<ul>` case, listening to what is announced. Not automatable here, and the only method that measures the thing the issue is actually about.

The cheapest honest close for #92 is the first bullet — taken, in §4 — plus a manual pass of the third or fourth on the structures #68 named. What should not happen is a green three-engine Playwright test, which would read as evidence and be none.

## 7. What would reopen this

`packages/islands/src/aria-engine.harness.ts` fails if any of it stops holding:

- A Playwright release that computed roles through an engine API would break §2's byte-identity, and that is the event that makes step 2 worth reopening.
- A release that stopped collapsing `role="presentation"` into "no role" — `mode: "ai"` already keeps generic nodes, it is simply not on the public `Page` API in 1.62.1 — would give the harness an observable for the marker's role. It would still be Playwright's own computation, so it would still not be a cross-engine measurement.
- The engine identities in §2's second table are assertions too, so a Chromium that shipped `type="week"` differently, or an install that quietly gave three copies of one engine, fails rather than passing silently.
- §4's four trees are assertions, so a Chromium that started building a node for a `display: contents` custom element — which would make the marker's role load-bearing in that engine after all — fails here rather than being read out of a document nobody re-ran. That is a maintainer's decision to reopen, not a bug in the marker.

Re-run it on a Playwright release.
