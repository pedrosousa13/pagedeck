# Flight-free RSC: can we author with RSC and hydrate with islands?

**Date:** 2026-08-23
**Status:** Decision input — no decision taken
**Question:** Can the framework run an RSC authoring model at build time (server components render, `"use client"` marks boundaries) while hydrating on the client via independent island roots with inline per-instance props, shipping **no** page-level flight payload?
**Relates to:** [RSC support options](2026-08-23-rsc-support-options.md) Option A+ and Option B; [Bundler deep dive](2026-08-23-bundler-deep-dive.md) §8
**Method note:** the load-bearing claims here were tested, not inferred from documentation. The harness drove React 19.2.8 and `react-server-dom-webpack` 19.2.8 directly — `renderToReadableStream` (rsc) → `createFromReadableStream` (ssr) → `react-dom/server.edge` → `hydrateRoot` in jsdom 30.0.1 — with a hand-written client manifest, all in `NODE_ENV=production`. It did **not** go through a real Vite build; see "what remains unverified".

---

## Verdict

**Qualified yes — the mechanism works, and I have it running end to end. The qualifications are where the cost lives, and one of them is severe.**

What I verified by building it:

- An RSC render at build time produces a flight stream. That stream can be consumed in the SSR environment to produce HTML, and then **discarded**. Nothing in React or `@vitejs/plugin-rsc` forces you to emit it. The tools that ship it (Waku, React Router, Parcel) do so in *their own* entry code, not inside the plugin.
- Per-instance client-boundary props **can** be recovered at build time, by instrumenting the SSR-environment module map so each client reference renders through a wrapper that records its props and emits a marker element.
- Two islands so marked hydrated as independent `hydrateRoot` calls against the RSC-produced HTML, with **zero hydration errors**, working interactivity, and the surrounding server-rendered content untouched. No flight payload was shipped.
- On a synthetic 20-section marketing page, the flight payload was **16,828 bytes** against **12,210 bytes** of HTML — the payload is *larger than the page it describes*. The equivalent inline island props were **60 bytes**. Spec §1's "no page-level data blob" thesis is now confirmed with a number rather than asserted.

The qualifications, in descending order of severity:

1. **`<ClientWrapper><ServerChild /></ClientWrapper>` does not survive the loss of the flight in its full-fidelity form.** Server children crossing a client boundary arrive as `react.lazy` handles backed by the flight stream. Drop the flight and they are gone. There is a workable downgrade — render each such child to a standalone HTML string at build time and inline it as an opaque slot, exactly as Astro does — and I verified that this works. But it converts children from inspectable React elements into opaque HTML, which is a real and permanent capability loss. See §4.
2. **Every island needs a wrapper element that React does not emit.** RSC-rendered HTML contains no delimiter of any kind at client boundaries, and React 19 rejects comment nodes as hydration containers. The framework must inject a wrapper element per island. Astro pays exactly this cost with `<astro-island>` + `display:contents`. See §1.
3. **The APIs this depends on are explicitly outside semver.** React's own words: *"the underlying APIs used to implement a React Server Components bundler or framework do not follow semver and may break between minors in React 19.x."* `react-server-dom-webpack`'s README still reads *"Use it at your own risk."* See §7.
4. **No one has done this.** Not in React, not in `@vitejs/plugin-rsc`, not in Waku, not in React Router, not in Parcel. I searched for it specifically and found nothing. The framework would be first. See §5.
5. **Cross-island shared state is *not* a blocker** — and here the existing spec is too pessimistic. I verified at runtime that one Jotai store passed to `<Provider store={…}>` inside several independent `hydrateRoot` roots shares state correctly, including mutation from outside React. This is an islands-architecture question, unaffected by the RSC decision either way. See §4b.

The honest summary: this is not blocked by React. It is blocked by nobody having built it, and the framework would be maintaining a private integration against APIs React explicitly declines to stabilise.

---

## 1. Flight payload necessity

**Confirmed: standard `hydrateRoot` on an RSC page requires the flight payload. Refuted: that this is the only way to hydrate.**

### What the standard path does

Every RSC toolchain hydrates the same way: decode the flight stream into a React element tree, then hand that tree to `hydrateRoot`. `@vitejs/plugin-rsc`'s own SSG example is explicit ([`examples/ssg/src/framework/entry.browser.tsx`](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-rsc/examples/ssg/src/framework/entry.browser.tsx)):

```js
// deserialize RSC stream back to React VDOM for CSR
const initialPayload = await createFromReadableStream<RscPayload>(
  // initial RSC stream is injected in SSR stream as <script>...FLIGHT_DATA...</script>
  rscStream,
)
```

The reason is structural: the server-rendered HTML carries no description of the component tree that produced it, so the client cannot reconstruct that tree from the DOM. `hydrateRoot` needs the tree. The flight payload *is* the tree.

### Why there is no supported "hydrate only the client subtrees" API

Two hard facts, both verified against React 19.2.8 rather than inferred.

**Fact 1 — RSC-produced HTML contains no client-boundary markers.** I rendered a page with two client components through the real pipeline (`react-server-dom-webpack/server.browser` → `react-server-dom-webpack/client.edge` → `react-dom/server.edge`) and searched the output for comment markers. There are none:

```
---- comment markers found in HTML ----
[]
```

The client component's output sits inline in the stream, indistinguishable from server-rendered content:

```html
<main class="page"><h1 class="page__title">Product marketing page</h1><button>Signups: 0</button><section class="feature feature--card">…
```

There is no `<!--$-->`, no wrapper, nothing. An islands hydrator has nothing to find.

**Fact 2 — React 19 will not accept a comment node as a hydration container.** The obvious workaround is to delimit islands with comments. React 19.2.8's `isValidContainer` (`react-dom/cjs/react-dom-client.development.js:119`) is:

```js
function isValidContainer(node) {
  return !(
    !node ||
    (1 !== node.nodeType && 9 !== node.nodeType && 11 !== node.nodeType)
  );
}
```

Element (1), Document (9), DocumentFragment (11). Comment nodes (8) are rejected — `hydrateRoot` throws `"Target container is not a DOM element."`. The legacy comment-container support went with the legacy roots in React 19.

**A partial mitigation worth knowing:** wrapping a client reference in `<Suspense>` *does* make React emit comment delimiters, with no added DOM element:

```html
<main><p>before</p><!--$--><button>A: 1</button><!--/$--><p>after</p><button>B: 2</button><p>end</p></main>
```

That solves *locating* the boundary but not *hydrating* it, because of Fact 2. Combined with the point above, the conclusion is that **the framework must inject a real wrapper element per island.** Astro reached the same conclusion and ships `<astro-island>` with `astro-island,astro-slot,astro-static-slot{display:contents}` ([`astro-island-styles.ts`](https://github.com/withastro/astro/blob/main/packages/astro/src/runtime/server/astro-island-styles.ts)). That is the prior art and it is proven at scale, but `display:contents` carries known accessibility caveats and the wrapper is not free in `<table>`/`<ul>` contexts.

### The path that does work

Instrument the SSR-environment module map. When React resolves a client reference during the SSR pass, it calls into a loader that returns the module; `@vitejs/plugin-rsc` exposes this as `setRequireModule({ load })` from `@vitejs/plugin-rsc/core/ssr`. Return components wrapped so each one records its props and renders a marker element around the real output.

I built this. On the 20-section page it produced:

```
CAPTURED BOUNDARIES: [
 { "idx": 0, "id": "client-mod-1", "name": "Counter",
   "props": { "label": "Signups", "start": 0 }, "unserializable": [] },
 { "idx": 1, "id": "client-mod-1", "name": "Counter",
   "props": { "label": "Downloads", "start": 5 }, "unserializable": [] }
]
```

and HTML:

```html
<react-island data-i="0" data-c="client-mod-1#Counter"><button>Signups: 0</button></react-island>
```

Then, in jsdom with React 19.2.8, hydrating each marker as its own root with those props:

```
islands found: 2
hydration errors: NONE
after click, island 0: Signups: 1
island 1 untouched: Downloads: 5
server content intact: Feature number 0
total <section> still present: 20
```

No flight payload was loaded. This is the whole thesis, working.

One correctness property worth recording: **nested client components do not double-wrap.** A client component that imports another client component produces only *one* client reference in the flight (`0:["$","main",null,{"children":["$","$L1",null,{"t":"T"}]}]` — one `$L1`, no reference for the inner component), because inside a client subtree the import is an ordinary ESM import. The wrapper therefore fires exactly once per island, which is the desired boundary.

---

## 2. Flight payload composition and size

**Confirmed, emphatically: the flight payload is the serialized rendered host-element tree, and it scales with page size, not client-component count.**

The claim in [bundler deep dive §8](2026-08-23-bundler-deep-dive.md) was correct. Here is the primary evidence — the actual production-build flight output for the 20-section page:

```
1:I["client-mod-1",[],"Counter"]
0:["$","main",null,{"className":"page","children":[["$","h1",null,{"className":"page__title","children":"Product marketing page"}],["$","$L1",null,{"label":"Signups","start":0}],["$","section","0",{"className":"feature feature--card","children":[["$","h2",null,{"className":"feature__title","children":"Feature number 0"}],["$","p",null,{"className":"feature__body","children":"This is body copy for feature 0. …"}],["$","ul",null,{"className":"feature__list","children":[["$","li","0",{"className":"feature__item","children":"Bullet point 1 for feature 0"}], …
```

Every `<section>`, `<h2>`, `<p>`, `<ul>`, `<li>`, every `className`, and every string of body copy appears in full. The only line that concerns client components is the single `I[…]` row declaring the client reference; the two client-component *instances* appear as nine-token entries (`["$","$L1",null,{"label":"Signups","start":0}]`). Everything else is a second copy of the page.

### Measurements

React 19.2.8, `NODE_ENV=production` builds, single page, 20 content sections and 2 client-component instances:

| artifact | raw | gzip -9 | brotli |
|---|---|---|---|
| HTML (island-marked) | 12,210 | 783 | 510 |
| flight payload | 16,828 | 1,036 | 679 |
| inline island props | 60 | 64 | 53 |

- Flight vs HTML: **1.38x raw, 1.32x gzip.** The payload is *bigger than the document it produces*, because JSON structural overhead exceeds HTML tag overhead for this shape of content.
- Flight vs per-instance island props: **280x raw, 16.2x gzip.**

**Caveats on these numbers, stated plainly.** The test page repeats near-identical text 20 times, which is unusually compressible and therefore flattering to *both* columns — the gzip ratios are the conservative ones and real pages with varied copy will sit closer to the raw ratios. Absolute sizes depend entirely on page shape. What generalises is not the multiplier but the *scaling law*: the flight grows with total rendered tree size and is independent of how many components are interactive, while inline island props grow only with interactivity.

Two further observations from the harness:

- The **development** build of the same page produced a **68,248-byte** flight — 4x the production build — because it carries `owner`/`stack` debug frames with absolute file paths for every element. Any size measurement taken in dev is meaningless.
- A page with **zero** client components still serialises its entire tree into a flight payload. The payload cost is not conditional on interactivity; only the *shipping* of it is a framework choice.

**Real-world measurements from other projects:** I did not find published flight-payload size measurements from React, Vercel, or any framework maintainer. A background check of the deployed waku.gg found a blog page whose inline `__FLIGHT_DATA` was roughly 12.8 kB against an 11.7 kB standalone `.txt` — same order, same "payload ≈ page" relationship, but that is a spot observation, not a maintainer-published benchmark.

---

## 3. `@vitejs/plugin-rsc` API surface

**Version 0.5.34, published 2026-08-07** (npm `latest`; the only other dist-tag is `alpha: 0.4.10-alpha.1`). Peer deps are unpinned: `react`, `react-dom`, `react-server-dom-webpack`, `vite` all `"*"`.

### Can it prerender to HTML and not ship the flight? Yes — and more easily than the alternatives.

This is the key structural difference between `@vitejs/plugin-rsc` and Waku/React Router/Parcel. In those three, flight injection is inside the framework and cannot be switched off (§5). In `@vitejs/plugin-rsc` the injection lives in *your* entry file. The plugin's own SSG example ([`examples/ssg/src/framework/entry.ssr.tsx`](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-rsc/examples/ssg/src/framework/entry.ssr.tsx)) does it in userland:

```js
let responseStream: ReadableStream<Uint8Array> = htmlStream
responseStream = responseStream.pipeThrough(injectRSCPayload(rscStream2))
return { stream: responseStream, status }
```

Delete that line and the flight is not shipped. That is the entire mechanism. The same file also shows the SSG path uses `prerender` from `react-dom/static.edge` rather than `renderToReadableStream` — *"for static site generation, let errors throw to fail the build"* — which independently confirms the note in [RSC support options](2026-08-23-rsc-support-options.md) that spec §7's `react-dom/server` should be tightened to `react-dom/static`.

### Does it expose client-reference boundaries as build-time data? Yes — boundaries, but **not props**.

There is an `onClientReference` hook, and it is marked `@experimental` in the source. The type is:

```ts
type OnClientReference = (metadata: ClientReferenceMetadata & {
  deps: ResolvedAssetDeps;
}) => void;
// where ClientReferenceMetadata = { id: string; name: string }
// and   ResolvedAssetDeps       = { js: string[]; css: string[] }
```

It is available in three places: `prerender` and `renderToReadableStream` (as an `extraOptions` argument, both `@experimental`), and `setOnClientReference` on the SSR side (JSDoc: *"Register a callback to be notified when client reference dependencies are loaded. Called during SSR when a client component is accessed. @experimental"*).

The implementation makes the limit clear. `createClientManifest` is a `Proxy` whose `get` trap fires on manifest lookup:

```js
function createClientManifest(options) {
  return new Proxy({}, { get(_target, $$id) {
    let [id, name] = $$id.split("#");
    options?.onClientReference?.({ id, name });
    return { id: id + cacheTag, name, chunks: [], async: true };
  } });
}
```

So `onClientReference` answers *"which client modules/exports does this page use?"* — which is exactly what it is for, namely resolving the JS and CSS assets a page needs. It does **not** answer *"what props does each instance receive?"*, and it does not distinguish instances at all.

**This settles Option B's blocking open question** ("Does `@vitejs/plugin-rsc` expose hooks to prerender and discard flight while extracting client-boundary props?"): discarding the flight, yes, trivially. Extracting props, **no** — not from this hook.

### The hook that does get you props

`setRequireModule({ load: (id) => unknown })`, exported from `@vitejs/plugin-rsc/core/ssr`:

```ts
declare function setRequireModule(options: { load: (id: string) => unknown }): void;
declare function createServerConsumerManifest(): ServerConsumerManifest;
```

This is the SSR-environment module loader — the seam my prototype used. Notably the plugin *itself* already wraps loaded client-reference modules in a Proxy (`wrapResourceProxy`) to trigger CSS/JS preloading on property access, so wrapping at this seam is an established pattern in this codebase. The plugin's wrapper observes *access*; the framework's wrapper would additionally observe *props*.

**Caveat:** `core/ssr` is reachable only through the catch-all exports entry `"./*": "./dist/*.js"` and is **not documented in the README**. It is exported-but-undocumented, which is a weaker stability guarantee than the already-weak `@experimental` label.

One implementation detail that cost me time and will cost the framework the same: React's `requireModule` uses `hasOwnProperty.call(moduleExports, name)` (`react-server-dom-webpack-client.edge.production.js:97`). A bare `Proxy` with only a `get` trap silently returns `undefined` and yields `"Element type is invalid"`. The wrapper must expose real own properties.

### SSG / prerender examples in-repo

From the README, the relevant examples are `./examples/ssg` (*"Static site generation with MDX and client components for interactivity"*) and `./examples/ppr` (*"Partial prerendering with a reusable static HTML shell and request-time RSC content"*). The SSG example emits, per page, an HTML file **and** an `.rsc` file — `handleSsg` does `rscStream.tee()` and returns `{ html, rsc }` — with the payload additionally inlined into the HTML. That is the default shape; it is userland code and the framework would replace it.

### What is marked experimental

`renderToReadableStream`'s Vite extension (*"This is a Vite-specific extension to the standard React RSC API"*), all three `onClientReference` entry points, and the `client-first` example (*"Experimental client-owned page that consumes RSC function results"*). The README documents no islands story and no flight-free hydration story — I checked specifically; neither term appears.

---

## 4. Server children through a client boundary

**This is the crux, and the answer is more nuanced than "it breaks".**

### How React actually transports server children across a client boundary

They are flight-serialized as separate rows, referenced by lazy handles. For `<Tabs titles={…} panels={[<ServerPanel n={1}/>, <ServerPanel n={2}/>, <ServerPanel n={3}/>]} />`, where `ServerPanel` is an `async` server component:

```
1:I["client-mod-2",[],"Tabs"]
0:["$","main",null,{"children":["$","$L1",null,{"titles":["One","Two","Three"],"panels":["$L2","$L3","$L4"]}]}]
2:["$","article",null,{"className":"panel","children":[["$","h3",null,{"children":"Panel 1"}],["$","p",null,{"children":"Server-rendered body 1"}]]}]
3:["$","article",null,{"className":"panel","children":[…"Panel 2"…]}]
4:["$","article",null,{"className":"panel","children":[…"Panel 3"…]}]
```

`panels` is `["$L2","$L3","$L4"]` — three lazy references. On arrival at the client component they are real React nodes. I probed the received prop:

```
PROBE typeof panels[0]: object | $$typeof: Symbol(react.lazy) | keys: $$typeof,_payload,_init
```

So the answer to "can the client component reorder, conditionally render, or wrap slotted content?" under **real RSC** is: **yes, completely.** They are ordinary React elements. This is genuinely more powerful than any islands slot mechanism.

### What precisely breaks without the flight

The `Tabs` component renders only the *selected* panel. The SSR HTML therefore contains only panel 1:

```html
<main><div class="tabs"><div role="tablist"><button role="tab">One</button><button role="tab">Two</button><button role="tab">Three</button></div><div role="tabpanel"><article class="panel"><h3>Panel 1</h3><p>Server-rendered body 1</p></article></div></div></main>

Panel 2 in HTML? false | Panel 3 in HTML? false
```

Panels 2 and 3 exist **only in the flight payload**. Discard it and clicking tab 2 renders nothing. There is no DOM to recover them from and no serializable representation in the island props.

The framework can at least *detect* this precisely rather than failing at runtime. My prop-capture wrapper flags it at build time:

```
{ "idx": 0, "id": "client-mod-2", "name": "Tabs",
  "props": null, "unserializable": [ "panels" ] }
```

A build error naming the component and the offending prop is straightforward.

### The Astro-shaped escape hatch — and it works

Astro solves the analogous problem by rendering slotted server content to an HTML string and handing it to the island as an opaque node. The React integration is [`packages/integrations/react/src/static-html.ts`](https://github.com/withastro/astro/blob/main/packages/integrations/react/src/static-html.ts) — `dangerouslySetInnerHTML` wrapped in `memo(StaticHtml, () => true)`, i.e. a subtree hard-coded never to re-render. Server content that the island did *not* render is stashed in `<template data-astro-template>` and read back by the `<astro-island>` custom element at hydration time.

**I verified the same technique is available in the RSC pipeline.** Given the flight-lazy `panels`, each one can be rendered to a standalone HTML string at build time:

```
PER-SLOT HTML (all three, incl. ones absent from page HTML):
 [0] <article class="panel"><h3>Panel 1</h3><p>Server-rendered body 1</p></article>
 [1] <article class="panel"><h3>Panel 2</h3><p>Server-rendered body 2</p></article>
 [2] <article class="panel"><h3>Panel 3</h3><p>Server-rendered body 3</p></article>

inlined slot HTML bytes: 234 | flight bytes: 592
```

and substituted back as opaque slot elements, producing hydratable island HTML. So the pattern is **recoverable**, at a cost proportional to slotted content rather than to page size.

### What the downgrade actually costs — corrected against Astro's source

My starting assumption (and the framing in [RSC support options](2026-08-23-rsc-support-options.md)) was that slotted content cannot be reordered or conditionally rendered. **That is wrong, and Astro's source disproves it.** Astro's `<template data-astro-template>` mechanism exists specifically so that slots the island did not render on the server are still available to it on the client; toggling and reordering work. There is no documented Astro restriction to the contrary — I had a subagent grep the entire `withastro/docs` English tree for such wording and it does not exist.

The **real** limitation is different and narrower: the slot is an *opaque HTML string*, not a component tree. Astro's own source comment ([`render/slot.ts`](https://github.com/withastro/astro/blob/main/packages/astro/src/runtime/server/render/slot.ts)): *"Framework/`.html` components inline slot content as an opaque string."* Consequences:

| Operation on slotted server content | Real RSC (with flight) | Opaque-HTML slot (Astro-style, flight-free) |
|---|---|---|
| Render it | yes | yes |
| Position / wrap it | yes | yes |
| Conditionally show/hide it | yes | yes (via a stashed template) |
| Reorder it | yes | yes |
| `React.Children.map` / `.count` over it | yes | **no** — one opaque node |
| `cloneElement` to inject props | yes | **no** |
| Re-render it with new data | yes | **no** — `memo(…, () => true)`, and not detectably so: no comparator is shown the data the container meant to push — React bails out above the memo on the shapes a container normally uses, and the one shape that gets through carries the slot's own markup flip instead ([slot re-render detection](2026-08-26-slot-rerender-detection.md)) |
| Duplicate it in two places | yes | not reliably |

Astro has lived with this since 2021 and it generates a steady stream of bug reports — [#7916](https://github.com/withastro/astro/issues/7916) states it canonically (*"all children come at one single child wrapped in a `astro-slot` tag. this breaks many react components such as carousels which need to receive an array of children"*), see also [#9474](https://github.com/withastro/astro/issues/9474), [#6023](https://github.com/withastro/astro/issues/6023), [#12212](https://github.com/withastro/astro/issues/12212). Astro's only escape hatch, `experimentalReactChildren` (*"tell Astro to always pass children to React as React virtual DOM nodes. There is some runtime cost to this"*, [PR #8082](https://github.com/withastro/astro/pull/8082), merged 2023-08-14), is **still experimental three years later** with its own bug trail.

**Read that as a forecast.** If the framework adopts the opaque-slot downgrade, it inherits a known-hard problem that a well-resourced project has not fully solved in five years.

Also worth knowing: Astro's props serialization is stricter than JSON — it supports *"plain object, `number`, `string`, `Array`, `Map`, `Set`, `RegExp`, `Date`, `BigInt`, `URL`, `Uint8Array`, `Uint16Array`, `Uint32Array`, and `Infinity`"* via a tagged-tuple encoding, and explicitly not functions. RSC's serializable-props constraint is broadly similar, which supports the [RSC support options](2026-08-23-rsc-support-options.md) observation that an RSC client boundary and an island boundary are the same boundary described twice.

**Astro Server Islands are not relevant here.** They are runtime-deferred rendering requiring an adapter (*"With an adapter installed to perform the delayed rendering, add the `server:defer` directive…"*), which non-goal §3 rules out.

---

## 4b. Cross-island shared state (Jotai `<Provider>`)

**Verified working at runtime. This is the one place where the existing spec is more pessimistic than reality.**

[RSC support options](2026-08-23-rsc-support-options.md) lists "React Context spanning multiple islands" and "Shared state across islands" as ❌, *"inherent to islands"*. The first is correct. **The second is not** — for Jotai specifically, and I tested it rather than reasoning about it.

### The test

Two `<react-island>` markers in server-rendered HTML, hydrated as **two independent `hydrateRoot` calls**, each wrapping its component in `<Provider store={sharedStore}>` with the *same* store instance created outside React. React 19.2.8, Jotai 2.20.2, production builds:

```
hydration errors: NONE
initial  -> a: count: 0 | b: mirror: 0
after click on A -> a: count: 1 | b: mirror: 1
after store.set(41) outside React -> a: count: 41 | b: mirror: 41
server content intact: untouched server content

RESULT: STATE SHARED ACROSS INDEPENDENT ROOTS
```

Clicking island A updates island B. Mutating the store from plain JavaScript with no React involved updates both. The server-rendered content between them is untouched.

### Why it works

Jotai's `Provider` does nothing root-scoped. The entire component, from [`src/react/Provider.ts`](https://github.com/pmndrs/jotai/blob/main/src/react/Provider.ts) v2.20.2:

```ts
export function Provider({ children, store }) {
  const storeRef = useRef<Store>(null)
  if (store) {
    return createElement(StoreContext.Provider, { value: store }, children)
  }
  if (storeRef.current === null) {
    storeRef.current = createStore()
  }
  return createElement(StoreContext.Provider, { value: storeRef.current }, children)
}
```

When a `store` prop is passed it is a one-line context wrapper. No registration, no mount-time side effect, no lifecycle coupling. Consumers do `const store = useStore(options)` then `store.get` / `store.sub` — **plain vanilla subscriptions, not React context propagation.** Atom state is keyed by the atom config object (`type AtomStateMap = WeakMapLike<AnyAtom, AtomState>`).

So the sharing contract is exactly two object identities: **the same store object and the same atom config object.** React roots are not part of it. The documented pieces are all there — [`createStore`](https://jotai.org/docs/core/store) (*"The store can be used to pass in `Provider`"*), [`Provider`](https://jotai.org/docs/core/provider) (*"A Provider accepts an optional prop `store` that you can use for the Provider subtree"*), and [using a store outside React](https://jotai.org/docs/guides/using-store-outside-react) — but **Jotai never documents the multi-root case.** I had the docs, tests, examples and issues grepped for `island`, `micro.frontend`, `multiple roots`, `hydrateRoot`, `createRoot`: zero hits. It works by construction, not by promise.

Astro says the same thing about its own architecture, and this is the closest thing to an official statement ([Islands concepts](https://docs.astro.build/en/concepts/islands/)):

> An island always runs in isolation from other islands on the page, and multiple islands can exist on a page. **Client islands can still share state and communicate with each other, even though they run in different component contexts.**

Astro's [sharing-state recipe](https://docs.astro.build/en/recipes/sharing-state-islands/) is blunt about the context half — *"when partially hydrating components within Astro or Markdown, you can't use these context wrappers"* — and recommends Nano Stores. It documents the module-level-export mechanism explicitly in its Solid section: *"all components importing `sharedCount` will share the same state."* Astro's React integration also uses exactly one `hydrateRoot` per island element, keyed in a `WeakMap` — the same architecture proposed here.

**So the corrected position for the feature table is:** cross-island *Context* is still ❌ (a provider in one root cannot wrap another root). Cross-island *shared state via an external store* is ✅, including Jotai's `<Provider>`, not merely the provider-less default store.

### Three traps this creates, all load-bearing

**1. The singleton depends on the store module not being duplicated — and Jotai's duplicate detector will not catch your configuration.** Jotai's *"Detected multiple Jotai instances"* warning lives inside `getDefaultStore()` and is gated on `import.meta.env?.MODE !== 'production'`. With `createStore()` + `<Provider store>`, **it never fires, in dev or prod.** A duplicate-module bug would be completely silent, and because atoms are keyed by object identity, duplication breaks sharing twice over — two stores *and* two sets of atom configs. Jotai's own docs name the root cause: *"Jotai is based on object references and not keys (like Recoil). This means there's no identifier for atoms."* This is a real, recurring bug class in that project ([discussion #2044](https://github.com/pmndrs/jotai/discussions/2044) is the one the warning links to). **Recommendation: stamp `globalThis` from the framework's own store module and assert, the way Jotai does, but unconditionally.**

**2. The bundler guarantee is real but narrowly scoped.** [Rolldown documents](https://rolldown.rs/in-depth/automatic-code-splitting) that a module statically imported by two or more entries is hoisted into a common chunk, with the stated purpose *"Ensure every JavaScript module is singleton in the final bundle output"* — and that *"ensuring that modules are singletons takes precedence"* over declared execution order. Rollup: *"Rollup will never duplicate code."* Vite 8 restates neither, delegating to Rolldown. Note the scope: **entries of one `input` config, i.e. one module graph.** No bundler documents anything about *separate* invocations. If the framework ever builds islands independently — per-island builds, module federation, pre-built islands from a package — the guarantee evaporates and nothing warns. Vite's [`resolve.dedupe`](https://vite.dev/config/shared-options.html#resolve-dedupe) exists for the adjacent resolution-layer hazard (*"If you have duplicated copies of the same dependency in your app (likely due to hoisting or linked packages in monorepos)"*), which chunk hoisting does not fix because the bundler never saw them as the same module.

**3. `useHydrateAtoms` is "once per store" and islands hydrate in an order you do not control.** Jotai's [SSR docs](https://jotai.org/docs/utilities/ssr): *"Atoms can only be hydrated once per store. Therefore, if the initial value used is changed during rerenders, it won't update the atom value."* With a shared store, if two islands hydrate the same atom, **the first to run wins and the second's value is silently discarded** — and with `visible`/`idle` hydration strategies (spec §8) the order is nondeterministic. **Hydrate the shared store once, outside React, before any root mounts.** Relatedly, `useAtomCallback` and similar utilities silently fall through to the *default* store unless passed `{ store }`; any escape hatch the framework exposes must thread the store explicitly.

One more mechanical note: React's own docs endorse the multi-root pattern — *"A page that uses 'sprinkles' of React for parts of the page may have as many separate roots as needed"* — and provide `identifierPrefix`, *"Useful to avoid conflicts when using multiple roots on the same page."* Astro passes it per island. The framework should too, or `useId` will collide across islands.

**A caveat on scope:** none of this is affected by the RSC question either way. Cross-island state is an islands-architecture concern, and it behaves identically whether boundaries come from `"use client"` or from the existing registry. It does not argue for or against Option B — but since it was raised as potentially disqualifying, the answer is that **it is not disqualifying.**

---

## 5. Prior art

**Nobody ships this. I searched specifically and found nothing.**

### What the three static-RSC toolchains actually emit

All three inline the flight payload into the prerendered HTML via the same library (`rsc-html-stream`'s `injectRSCPayload`), in the same wire form — `<script>(self.__FLIGHT_DATA||=[]).push("…")</script>` — and all three *additionally* write a sidecar flight file for client-side navigation. A cold load ships the content twice.

| | per static page | flight inlined in HTML? | sidecar | opt-out? | version / status |
|---|---|---|---|---|---|
| **Parcel `react-static`** | `.html` + `.rsc` | yes, unconditional | `.rsc`, fetched on navigation only | none found | 2.16.4 (2026-02-02); docs: *"React Server Components support is currently in beta"* |
| **Waku** | `<route>/index.html` + `RSC/R/<route>.txt` | yes (`injectRSCPayload` in `lib/vite-rsc/ssr.tsx`) | `.txt` | none found | 1.0.0-beta.9 (2026-08-08) |
| **React Router** | `index.html` + `<route>.rsc` | yes, unconditional (2 call sites in `lib/rsc/server.ssr.tsx`) | `.rsc` — regex-scraped back out of the rendered HTML | none found | 8.3.0 (2026-07-22); every RSC symbol prefixed `unstable_` |

Detail worth recording per project:

- **Parcel.** Documented: *"For each page, Parcel outputs two files: A `.html` file… A `.rsc` file, which can be used to perform client side navigation."* `injectRSCPayload` in `ReactStaticPackager.js` is on the unconditional return path; only `bootstrapScriptContent` is gated. Parcel is the only one of the three where a page with no client components emits **no JS bundle at all** — but the inline `__FLIGHT_DATA` script and the `.rsc` file are still written.
- **Waku.** *"The `RSC` directory holds the prerendered payloads that make client-side navigation between static pages fast."* Its static-deployment guide warns *"Do not publish only the HTML and asset files. The generated RSC payloads are part of the static app."* Watch two traps: "pure SSG" removes the *server*, not the client JS; and `unstable_disableSSR` is the opposite of what its name suggests — *"the client still needs JavaScript to render the route… the RSC payload is still requested."* Waku always ships React DOM client + `react-server-dom-webpack/client` + its own client router (itself `'use client'`), even with zero client components of your own.
- **React Router.** Its RSC prerender output is **entirely undocumented** — `docs/how-to/pre-rendering.md` contains no occurrence of "rsc" or "server component"; the `.rsc` emission exists only in `packages/react-router-dev/vite/rsc/plugin.ts`. The documented zero-JS trick (omitting `<Scripts />`) is marked `[MODES: framework]`, not `rsc`, and would not help because injection happens in the SSR stream pipeline.

**The common blocker is architectural, not configurational:** in all three, `injectRSCPayload` is an unconditional stream transform. Suppressing it means patching the framework. This is exactly why `@vitejs/plugin-rsc` is the right substrate for this idea and the three frameworks are not — there, the same call sits in code you own (§3).

### Has anyone proposed "RSC for authoring, islands for hydration, no flight"?

I searched `react/react` (note: the React repo has **moved from `facebook/react` to `react/react`**, and has GitHub Discussions disabled), `vitejs/vite-plugin-react`, and Waku's repos for islands/partial-hydration/flight-size discussions. **Nothing matching this idea.**

The one near-miss is worth reporting precisely because its name is misleading. Waku has an **"islands"** feature, authored by dai-shi — [PR #1166 "experimental: waku islands"](https://github.com/wakujs/waku/pull/1166), **merged** 2025-01-21 — and it survives today as `e2e/fixtures/minimal-examples/src/components/Island.tsx`. It is **not** this idea. It still calls `hydrateRoot(document, …)` on a single page-level root, and its "islands" are *additional flight payloads fetched lazily*:

```js
const useRefetch = () => {
  const mergeElements = useMergeElements_UNSTABLE();
  return useCallback((rscPath) => mergeElements(unstable_fetchRsc(rscPath)), [mergeElements]);
};
```

That is deferred server rendering — closer to Astro's *Server Islands* than to client islands — and it adds flight traffic rather than removing it.

`@vitejs/plugin-rsc`'s README never uses the word "islands", and its `[Tracking] RSC support` issue ([#531](https://github.com/vitejs/vite-plugin-react/issues/531)) is closed.

**Conclusion: the framework would be first.** That is not a reason not to do it, but it means no upstream is maintaining this seam on the framework's behalf, and §7's semver warning lands with full force.

---

## 6. Directive-only path (Option A / A+)

**Confirmed, with an important correction: the premise has already expired on the framework's chosen stack.**

### Directives are inert, but Rolldown does not warn and does not strip

The familiar `MODULE_LEVEL_DIRECTIVE` warning is **Rollup's**, and it is undocumented on the `onwarn` page — it exists only in [`src/utils/logs.ts`](https://github.com/rollup/rollup/blob/master/src/utils/logs.ts):

```ts
message: `Module level directives cause errors when bundled, "${directive}" in "${relativeId(id)}" was ignored.`
```

It is `LOGLEVEL_WARN` (never an error), and `ExpressionStatement.shouldBeIncluded` returns `false` for a Program-level directive, so Rollup **strips** it. No Rollup option preserves directives; "directive" appears zero times in Rollup's changelog for 4.0.0–4.62.5. Rollup latest 4.62.5 (2026-08-20).

**Rolldown behaves differently on both counts**, which matters because [decision #4](2026-08-23-bundler-deep-dive.md) puts the framework on Vite 8 + Rolldown:

- It does not implement the warning. Rolldown's `packages/rollup-tests/src/ignored-by-unsupported-features.md` lists, under *"The error/warning not implement"*: `rollup@function@module-level-directive: module level directives should produce warnings (MODULE_LEVEL_DIRECTIVE warning)`.
- It **preserves** directives in defined cases. [Rolldown's directives documentation](https://rolldown.rs/in-depth/directives) states it *"will output the directive for any of the following cases: The directive is not in the top-level scope; The directive is in the top-level scope and the module is a entry module; The directive is in the top-level scope and `output.preserveModules` is enabled."* Snapshot tests confirm both the preserve case and the loss case (a non-entry shared chunk drops its directives).

Rolldown 1.2.5 (2026-08-19); Vite 8.0.0 (2026-03-12), latest 8.2.2 (2026-08-20). **On Vite 8 the warning does not fire at all**, so the suppression layer described in Option A is dead weight there. `@vitejs/plugin-react` still ships one (`packages/common/warning.ts`, filtering on `warning.code === 'MODULE_LEVEL_DIRECTIVE'`) for Rollup-based setups. If the framework ever needs to match this warning, **match on `warning.code`, never on message text** — the wording changed between Rollup 3 and 4.

**Update (2026-10-09):** on Rolldown 1.2.13, `MODULE_LEVEL_DIRECTIVE` does fire, and its log names the directive only inside the message, so `runBundle` matches the code and then the message for `"use client"` and `"use server"` (#74).

### How to detect `"use client"` at build time

The actively-maintained primitive is in `@vitejs/plugin-rsc` itself, importable **without adopting the RSC runtime**, via the `./transforms` export:

```ts
export function isDirective(node: Node): node is Directive {
  // https://github.com/estree/estree/blob/master/es5.md#directive
  return node.type === 'ExpressionStatement' && 'directive' in node
}
export function hasDirective(viteBody, directive: string): boolean {
  return body.some((stmt) => isDirective(stmt) && stmt.directive === directive)
}
```

The full `./transforms` surface also exports `findDirectives`, `scanModuleExports`, `transformDirectiveProxyExport`, `transformWrapExport` and friends — the machinery for turning a directive into a boundary. **Caveat: `./transforms` is in the exports map but is not documented in the README.**

The alternatives are all stale and none declares Rolldown or Vite 8 support:

| package | version | last publish | what it does |
|---|---|---|---|
| `rollup-plugin-preserve-directives` | 0.4.0 | 2024-02-02 | preserves under `preserveModules`; does **not** silence the warning |
| `rollup-preserve-directives` | 1.1.3 | 2024-11-24 | preserves, and exposes results via `this.getModuleInfo` → `{ preserveDirectives: { directives, shebang } }` |
| `rollup-plugin-add-directive` | 1.0.0 | 2025-02-01 | injects directives by glob |

(`vite-plugin-react-directives` is a red herring — v1.0.0 from 2021-07-09, predating RSC, unrelated.) Among library bundlers: `bunchee` 7.0.1 handles directives (via `rollup-preserve-directives`); `tsup` 8.5.1 preserves them incidentally because esbuild never sees Rollup; **`unbuild` 3.6.1 fails the build outright** on a `"use client"` file, because it defaults `failOnWarn: true` and suppresses only `CIRCULAR_DEPENDENCY`.

### Directive semantics, confirmed from react.dev

The correction in [RSC support options](2026-08-23-rsc-support-options.md) Option A+ is exactly right, and React states it in a dedicated Note on [Server Components](https://react.dev/reference/rsc/server-components):

> **There is no directive for Server Components.**
> A common misunderstanding is that Server Components are denoted by `"use server"`, but there is no directive for Server Components. The `"use server"` directive is used for Server Functions.

And [`use server`](https://react.dev/reference/rsc/use-server): *"`'use server'` marks server-side functions that can be called from client-side code."* Server functions need a runtime request handler; non-goal §3 rules them out, and no rendering decision recovers them.

[`use client`](https://react.dev/reference/rsc/use-client) — placement and scope, verbatim:

> `'use client'` must be at the very beginning of a file, above any imports or other code (comments are OK). They must be written with single or double quotes, but not backticks.

> A component usage is considered a Client Component if it is defined in module with `'use client'` directive or when it is a transitive dependency of a module that contains a `'use client'` directive. Otherwise, it is a Server Component.

> Code that is marked for client evaluation is not limited to components. All code that is a part of the Client module sub-tree is sent to and run by the client.

That last sentence is the one with teeth for the framework's payload goals: **the directive marks a transitive subtree, not a single component.** A directive-derived island set is therefore a *closure*, not a list, and its size is a property of the design system's import graph. This should be measured on the real design system before Option A+ is costed, because it determines whether "derive islands from `"use client"`" produces the same island set the explicit registry would.

Neither directive page carries a Canary or experimental banner; both are presented as stable reference with an "RSC" callout.

---

## 7. Stability and risk

Collected here because it cuts across every section.

- **React's own semver carve-out**, from [Server Components](https://react.dev/reference/rsc/server-components): *"While React Server Components in React 19 are stable and will not break between minor versions, the underlying APIs used to implement a React Server Components bundler or framework do not follow semver and may break between minors in React 19.x."* The flight-free island design depends on precisely those APIs — `registerClientReference`, the client manifest shape, the SSR module map, the flight row format.
- **`react-server-dom-webpack` 19.2.8** ships as a normal stable-tagged npm release, but its README is four lines: *"Experimental React Flight bindings for DOM using Webpack. **Use it at your own risk.**"*
- **There is no non-webpack option.** `react-server-dom-esm` is stuck at 0.0.1 (June 2023); `react-server-dom-vite` was **unpublished from npm on 2025-05-16** and 404s today; `react-server-dom-parcel` tracks React's cadence (19.2.8) but is Parcel-specific. `@vitejs/plugin-rsc` peer-deps `react-server-dom-webpack` for this reason, and Waku's v1 roadmap still gates on *"Wait for `react-server-dom-vite` from React canary?"*.
- **`@vitejs/plugin-rsc` 0.5.34 is pre-1.0**, and the two hooks this design needs are `@experimental` (`onClientReference`) and undocumented (`core/ssr`'s `setRequireModule`).
- **Preview (§14) is still the casualty** identified in Option B, and nothing found here rescues it. Server components do not run in a browser. Note however that the flight-free design *narrows* the divergence: because hydration is per-island with inline props, preview could client-render the same island components with the same props. Only the server-component layer diverges. That is a smaller gap than full RSC preview, but it is still a gap, and §14 currently calls 1:1 a construction guarantee.

---

## What remains unverified

Listed plainly, because a labelled gap is worth more than a confident guess.

1. **Nothing in this document was tested through `@vitejs/plugin-rsc` itself.** My harness drove `react-server-dom-webpack` 19.2.8 directly with a hand-written client manifest. I read plugin-rsc 0.5.34's shipped `.d.ts` and `dist` JavaScript to establish its API surface, but I did **not** run a real Vite build. Whether `setRequireModule` can be overridden cleanly from a framework's `entry.ssr` — the plugin calls it itself at module initialise time — is **unconfirmed and is the first thing a prototype must check.**
2. **The wrapper-element cost is unquantified.** I did not test `<react-island>` + `display:contents` against real CSS, flex/grid parents, table/list contexts, or screen readers. Astro's known `display:contents` accessibility caveats apply and were not investigated.
3. **The Astro-style opaque-slot downgrade is proven in principle, not in a build.** I verified a flight-lazy server child can be rendered to standalone HTML and re-inserted as an opaque slot. I did **not** build the full three-pass pipeline, and did not verify that a client component hydrates cleanly against `dangerouslySetInnerHTML` content in this configuration.
4. **No published flight-payload benchmarks exist.** I found no size measurements from React, Vercel, or any framework maintainer. All numbers in §2 are mine, from one synthetic page, and their absolute values do not generalise.
5. **Interaction with React's document-metadata and stylesheet hoisting is untested.** Whether `<title>`/`<meta>` hoisting, `preinit`/`preload`, and stylesheet precedence survive per-island hydration with no page root is unknown — and §9's CSS tiering already has an unresolved interaction here.
6. **Suspense inside an island, and streaming boundaries generally**, were not tested under per-island hydration.
7. **Whether the `"use client"` transitive closure matches the intended island set** on a real design system. §6 explains why this matters; it needs measuring against the actual package.
8. **React Router's RSC prerender behaviour is source-only.** Its `.rsc` emission is undocumented, so it may change without a changelog entry.
9. **Parcel source quoted in §5 is HEAD of branch `v2`**, which may be ahead of the 2.16.4 release tag.
10. **I did not verify that no RSC feature silently requires the flight at runtime.** Server functions obviously do (and are out of scope). Whether anything else — error replay, `use cache`, temporary references — has a hidden dependency was not audited.
11. **The Jotai cross-root result (§4b) was verified in jsdom, not a real browser**, with two roots and one atom. Jotai does not document the pattern, so it is correct-by-construction rather than promised, and could regress without it counting as a breaking change. Jotai 3.0.0-alpha.0 exists (2026-07-20) and was not examined.
12. **The duplicate-module hazard in §4b was not reproduced.** No bundler documents cross-invocation module identity either way, so the "separate builds do not share instances" claim is inference from documented single-build mechanics, not a sourced statement.
