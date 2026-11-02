# Can React delimit and hydrate an element passed through a client component's props?

**Date:** 2026-11-02
**Status:** Finding. Decision input for the proxied-slots ADR (#237); decides nothing.
**Question:** When a server component renders a `"use client"` component and passes it React elements, as `children` or deep in a prop (`items: [{ node: <X/> }]`), can each element be rendered on the server so the client finds its HTML as a delimited region and hydrates around it, keeping its server HTML, with no flight payload? What does hydration do with a region whose element the client never receives, and what does a reordered array do to it? (#238)
**Relates to:** [Flight-free RSC](2026-08-23-flight-free-rsc.md) §1 (the `<Suspense>` delimiters, and Fact 2: a comment is not a hydration container); [ADR-0005](../adr/0005-slot-re-render-is-not-detectable.md); [ADR-0006](../adr/0006-slot-ids-are-not-authenticated.md); `.out-of-scope/proxied-slots.md`; #175.
**Method note:** measured, not inferred. The check at the end of this note drives React 19.2.8 and `react-dom` 19.2.8 (`react-dom/server`'s `renderToString`, `react-dom/static`'s `prerender`, `react-dom/client`'s `hydrateRoot`) in jsdom 30.0.1, the versions the workspace installs. It runs in development and with `NODE_ENV=production`, and both give the same results; only the error text differs, because production minifies it. The source citations are to the `v19.2.8` tag of facebook/react.

---

## Verdict

**Yes, with five qualifications. The qualifications decide the design.**

The mechanism has two halves:

- **Build side.** Before the client component renders, the build replaces each element at its prop path with `<Suspense fallback={null}>{element}</Suspense>`. Fizz writes `<!--$-->` before the element's HTML and `<!--/$-->` after it, wherever the client component places it, at any depth. It adds no element, so the delimiters survive inside `<tbody>`, where a wrapper element would not.
- **Client side.** At the same prop path, the client passes a stand-in: `<Suspense>` around a component that suspends on a promise that never settles. React does not hydrate a dehydrated boundary on its first pass. When it tries later, the stand-in suspends, and React leaves the server DOM in place. The region keeps its server HTML and its DOM nodes. The client component around it hydrates, takes events and re-renders. No flight payload and no copy of the element go to the client.

The qualifications:

1. **A stand-in must be the same element object for the island's whole life.** If a re-render gives the boundary a new props object, React gives up on hydrating it. A sync update then deletes the server HTML and shows the fallback, and nothing is reported. A transition never commits. `cloneElement(child)` with no new props is enough to cause this. `Children.map` is not.
2. **A reorder moves a region only if the region sits inside a host element the client component keys.** If the client component reorders bare siblings, for example keyed fragments of `<tr>` in a `<tbody>`, React reorders its fibers but not the DOM. The page keeps the server order, and nothing is reported.
3. **A hydration mismatch in the client component's own markup deletes every region in it**, unless the stand-in's fallback carries the region's HTML. A fallback that carries it brings the content back as new DOM inside a wrapper element (§5).
4. **`prerender`, which the build calls, outlines a large boundary.** Above a running total of 12,800 bytes, it writes the boundary as pending (`<!--$?-->`) with an inline `$RC` script. Pass `progressiveChunkSize: Infinity`, which is what `renderToString` does internally.
5. **This rests on React internals.** The source comments describe the behaviour, but react.dev does not document it. It needs a harness to pin it, as ADR-0005's slot harness does.

---

## 1. Delimiters at any depth

The client component in the check takes three elements in `items[n].node` and one in `children`, and places them two components deep inside `<ul><li>` and in a `<footer>`. The build-side wrap is `wrap = (element) => <Suspense fallback={null}>{element}</Suspense>`, applied at each prop path. `renderToString` writes:

```html
<section><button id="inc">count 0</button><button id="rev">reverse</button><h2>server</h2><div class="deep"><div><ul><li><!--$--><article data-card="A"><h3>A</h3><p>server text A</p></article><!--/$--></li><li><!--$--><article data-card="B">…</article><!--/$--></li><li><!--$--><article data-card="C">…</article><!--/$--></li></ul></div></div><footer><!--$--><p data-children="">server children</p><!--/$--></footer></section>
```

`prerender` writes the same bytes for this page (§4 covers when it does not). There are four `<!--$-->`/`<!--/$-->` pairs, one for each element, and no added element.

Fizz writes a completed boundary as `startCompletedSuspenseBoundary = '<!--$-->'` and `endSuspenseBoundary = '<!--/$-->'` (`packages/react-dom-bindings/src/server/ReactFizzConfigDOM.js`, lines 4577 and 4584). The client reads the same markers: `SUSPENSE_START_DATA = '$'` and `SUSPENSE_END_DATA = '/$'` (`packages/react-dom-bindings/src/client/ReactFiberConfigDOM.js`, lines 264–265). A boundary is a boundary wherever it sits in the render output. Depth does not matter, because the element's position is wherever the client component's render put it. The `table` layout in §3 renders each element as a bare `<tr>` sibling inside `<tbody>`. The comments survive the HTML parser there (jsdom follows the spec's in-table insertion mode), and the regions hydrate.

This answers the flight-free note's Fact 2 from the other side. A comment still cannot be a hydration *container*, but the regions do not need one. The island's root stays the element marker the framework already writes, and the regions are boundaries inside that root.

## 2. Hydrating around a region the client never receives

The client passes a stand-in at each prop path where the server had an element:

```js
const never = new Promise(() => {});
function Hole() { use(never); return null; }
const hole = () => <Suspense fallback={null}><Hole /></Suspense>;
```

Measured, for both layouts:

| Check | `li` layout | `table` layout |
| --- | --- | --- |
| container `innerHTML` after hydration equals the server HTML | yes | yes |
| region's DOM node is the same object after hydration | yes | yes |
| the island's own state update (`count 1`) commits | yes | yes |
| region's DOM node is the same object after that update | yes | yes |
| recoverable errors or console errors | none | none |

**Control:** if the client passes `null` where the server had an element, hydration fails ("Hydration failed because the server rendered HTML didn't match the client"), React regenerates the root on the client, and every region is gone. The stand-in is what makes this work.

Why it holds, in `packages/react-reconciler/src/ReactFiberBeginWork.js`:

- **First pass.** `mountDehydratedSuspenseComponent` (line 2911): *"During the first pass, we'll bail out and not drill into the children. Instead, we'll leave the content in place and try to hydrate it later."* It schedules the boundary at `OffscreenLane`.
- **Hydration attempt.** `updateDehydratedSuspenseComponent` (line 2936) enters the boundary and renders the stand-in, which suspends. On the second pass (line 3127): *"Something suspended and we should still be in dehydrated mode. Leave the existing child in place."* The promise never settles, so React never retries, and the dehydrated fragment (the server DOM) stays.

The region's content is never hydrated by the island's root. It is static HTML, which is what a slot is today. A nested island inside it hydrates as a root of its own (§3).

## 3. Reorder

The client component reverses its list on a click.

| Layout | DOM order after reverse | Region DOM node kept | Errors |
| --- | --- | --- | --- |
| each element inside a keyed `<li>` | `CBA` (correct) | yes | none |
| each element as a keyed fragment of `<tr>` in `<tbody>` | `ABC` (**wrong**: React's fibers say `CBA`) | yes | none |

A dehydrated boundary has no host node that React can move. `insertOrAppendPlacementNode` (`packages/react-reconciler/src/ReactFiberCommitHostEffects.js`, line 438) inserts `HostComponent` and `HostText` fibers and otherwise recurses into children. A dehydrated boundary's only child is a `DehydratedFragment` with no fiber children, so the placement inserts nothing. In the `li` layout, the `<li>` is the host node that moves, and the region moves inside it. In the bare layout, nothing moves. `getHostSibling` (line 322) does treat a `DehydratedFragment` as an insertion anchor (line 344). So a later insertion next to a misplaced region is anchored to where that region really is, not to where React thinks it is. I infer that from the source and did not measure it.

A nested island inside a region (its own `hydrateRoot` on an element inside the region) works, and keeps working after the outer island reverses an `li` list: `nested 1`, then `BA`, then `nested 2`, with no errors.

## 4. When the stand-in stops holding the HTML

**A new props object on the boundary.** `beginWork` sets `didReceiveUpdate` when `oldProps !== newProps` (line 4118). In `updateDehydratedSuspenseComponent`, *"This boundary has changed since the first render. This means that we are now unable to hydrate it."* (line 3018). React tries once at a higher lane, the stand-in suspends again, and then *"We must now give up. Instead, we're going to delete the whole subtree"* (line 3048), through `retrySuspenseComponentWithoutHydrating`. Measured:

| What the client component does | Region after its next update |
| --- | --- |
| renders the same stand-in objects | kept |
| `Children.map(children, (c) => c)` | kept (the props object carries over) |
| `cloneElement(children)` with no new props | **gone**, with no error |
| a parent builds new stand-ins on each render (sync update) | **gone**, with no error |
| the same, inside `startTransition` | kept, but the transition **never commits** (`renderDidSuspendDelayIfPossible`) |

This turns one of ADR-0005's rows around. Today `cloneElement(child)` with no new props is legal and silent (`slot.test.tsx` pins it). With a dehydrated stand-in it would delete the content, again with nothing reported, unless the fallback carries the HTML (§5). The runtime has to build the stand-ins once for the island's life, which is what `adoptSlots` already does for slot elements.

**A mismatch in the client component's own markup.** The check renders `<h2>client</h2>` over `<h2>server</h2>`. React reports a recoverable error, regenerates the whole root on the client, and every region is gone. Each stand-in suspends, so each boundary shows its `null` fallback.

**An outlined boundary.** `prerender` uses `DEFAULT_PROGRESSIVE_CHUNK_SIZE = 12800` (`packages/react-server/src/ReactFizzServer.js`, line 420). A completed boundary larger than 500 bytes is outlined once the running total would pass that size: *"Inlining this boundary would make the current sequence being written too large"* (line 5760). Outlining writes `<!--$?--><template id="B:0"></template><!--/$-->`, puts the content in a hidden `<div>`, and adds the inline `$RC` script that moves the content in. The legacy `renderToString` passes `Infinity` (`packages/react-dom/src/server/ReactDOMLegacyServerImpl.js`, line 72). Measured with three 5 kB slots:

| Server call | `<!--$?-->` | `$RC` script | `<!--$-->` |
| --- | --- | --- | --- |
| `prerender`, default | 1 | yes | 3 |
| `prerender`, `progressiveChunkSize: Infinity` | 0 | no | 4 |
| `renderToString` | 0 | no | 4 |

`render.tsx`'s `prerenderToHtml` passes no `progressiveChunkSize` today. The `$RC` script is inline JavaScript that each site's CSP would need a hash for, and a pending boundary on the client takes the `isSuspenseInstancePending` branch instead. The build should pass `Infinity`. Fizz also outlines a boundary with "suspensey" content (`hasSuspenseyContent`: a `precedence` stylesheet, or an image under a `ViewTransition`). The framework already refuses `data-precedence` sheets.

## 5. A fallback that carries the region's HTML

Every loss in §4 shows the stand-in's fallback. If the client reads each region's HTML off the DOM before hydrating, the way `adoptSlots` reads `<pagedeck-slot>` today, and passes it as the fallback:

```js
<Suspense fallback={<pagedeck-slot style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: html }} />}>
  <Hole />
</Suspense>
```

then the dehydrated path is unchanged (React never renders a dehydrated boundary's fallback), and both losses measured in §4 bring the content back:

| Case | Cards | Children | Wrappers |
| --- | --- | --- | --- |
| new stand-ins on a sync re-render | `ABC` | present | 4 `<pagedeck-slot>` |
| island markup mismatch | `ABC` | present | 4 `<pagedeck-slot>` |

The content comes back as new DOM inside a wrapper element. A nested island inside the region loses its root with the old DOM and would have to be hydrated again, which is what `AdoptedSlot`'s re-mount path does today. I did not measure whether a fallback-rendered region moves on a bare-sibling reorder. It should, because the wrapper is a host node, but the dehydrated case in §3 does not. That reorder fault holds until a region leaves the dehydrated state.

## 6. What this means for the ADR

These are inputs, not decisions:

- **The id space is the prop path.** The build wraps elements at paths it found in the props, and the client must put a stand-in at exactly those paths. So the island's marker has to carry the list of paths. That list is the "second id space" that `.out-of-scope/proxied-slots.md` names. ADR-0006's reasoning carries over unchanged: a path is a position, and a position is public.
- **The server render pass is the client component's own render**, with wrapped elements in its props. No separate pass per element is needed to delimit them. The current `ScopedProxy` drops `children` and renders `null` in the collect phase. It would have to render the real component with the wrapped props instead.
- **An element the client component does not place** writes no region and no HTML. This is the "client stash for unplaced children" question. The region cannot be recovered on the client later unless the build writes the HTML somewhere else.
- **Regions are static HTML.** Only a nested island inside one is interactive, as with slots today.
- **Two faults have no signal:** a reorder of bare siblings, and a new props object on a still-dehydrated boundary. §5 covers the second fault and not the first.
- **Element props are not JSON.** They leave the props that `islandPropsBudget` measures, which settles that question for #237.

## Re-running the check

From a checkout with `pnpm install` done:

```sh
node check.mjs            # from the repository root, or
node check.mjs /path/to/pagedeck
```

It prints one section per heading above. The script:

```js
// node check.mjs [repository root, default the working directory]
// React 19.2.8, react-dom 19.2.8 and jsdom 30.0.1, as the workspace installs them.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const repo = process.argv[2] ?? process.cwd();
const require = createRequire(pathToFileURL(`${repo}/packages/core/`));
const { JSDOM } = require("jsdom");
const React = require("react");
const { renderToString } = require("react-dom/server");
const { prerender } = require("react-dom/static");
const { Suspense, Fragment, createElement: h, use, useState, startTransition } = React;

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: typeof React.act === "function",
});
const { hydrateRoot } = require("react-dom/client");
// Production React has no `act`: let the scheduler drain instead.
const act = React.act ?? (async (fn) => { await fn(); await new Promise((r) => setTimeout(r, 100)); });

// The client component. It gets elements in `children` and at
// `items[n].node` / `items[n].row`, and places them at depth.
function Deep({ children }) {
  return h("div", { className: "deep" }, h("div", null, children));
}
function Island({ items, children, layout, label = "server" }) {
  const [count, setCount] = useState(0);
  const [reversed, setReversed] = useState(false);
  const list = reversed ? [...items].reverse() : items;
  return h(
    "section",
    null,
    h("button", { id: "inc", onClick: () => setCount((n) => n + 1) }, `count ${count}`),
    h("button", { id: "rev", onClick: () => setReversed((r) => !r) }, "reverse"),
    h("h2", null, label),
    layout === "li"
      ? h(Deep, null, h("ul", null, list.map((i) => h("li", { key: i.id }, i.node))))
      : h("table", null, h("tbody", null, list.map((i) => h(Fragment, { key: i.id }, i.row)))),
    h("footer", null, children),
  );
}

// Server-only content: the client never receives these elements.
const Card = ({ name, filler = "" }) =>
  h("article", { "data-card": name }, h("h3", null, name), h("p", null, `server text ${name}${filler}`));
const Row = ({ name }) => h("tr", { "data-row": name }, h("td", null, name));
const Para = () => h("p", { "data-children": "" }, "server children");

// What the build would do: wrap each element prop in a Suspense boundary.
const wrap = (element) => h(Suspense, { fallback: null }, element);
const serverProps = (filler) => ({
  items: ["A", "B", "C"].map((name) => ({
    id: name,
    node: wrap(h(Card, { name, filler })),
    row: wrap(h(Row, { name })),
  })),
  children: wrap(h(Para)),
});

// What the client passes instead: a boundary whose content suspends forever.
const never = new Promise(() => {});
function Hole() {
  use(never);
  return null;
}
const hole = () => h(Suspense, { fallback: null }, h(Hole));
const clientProps = () => ({
  items: ["A", "B", "C"].map((id) => ({ id, node: hole(), row: hole() })),
  children: hole(),
});

async function prerenderHtml(element, options) {
  const { prelude } = await prerender(element, options);
  let html = "";
  for await (const chunk of prelude) html += new TextDecoder().decode(chunk);
  return html;
}

const errors = [];
const origError = console.error;
console.error = (...args) => errors.push(String(args[0]).split("\n")[0]);
const rootOptions = {
  onRecoverableError: (e) => errors.push(`recoverable: ${e.message.split("\n")[0]}`),
};

async function mount(serverHtml, element) {
  const container = document.createElement("div");
  container.innerHTML = serverHtml;
  document.body.replaceChildren(container);
  const before = container.querySelector("[data-card=A]") ?? container.querySelector("[data-row=A]");
  let root;
  await act(async () => {
    root = hydrateRoot(container, element, rootOptions);
  });
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  return { container, root, before };
}
const click = (container, id) =>
  act(async () => container.querySelector(`#${id}`).dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
const order = (container, attr) =>
  [...container.querySelectorAll(`[${attr}]`)].map((e) => e.getAttribute(attr)).join("") || "(none)";
const report = (name, lines) => {
  console.log(`\n## ${name}`);
  for (const line of lines) console.log(`  ${line}`);
  console.log(`  errors: ${errors.length ? errors.splice(0).join(" | ") : "none"}`);
};

// 1. Delimiters, both server paths.
const html = renderToString(h(Island, { ...serverProps(), layout: "li" }));
const prerendered = await prerenderHtml(h(Island, { ...serverProps(), layout: "li" }));
console.log("## 1. server HTML (renderToString)\n  " + html);
report("1. delimiters", [
  `renderToString === prerender: ${html === prerendered}`,
  `<!--$--> count: ${html.match(/<!--\$-->/g).length}, <!--/$--> count: ${html.match(/<!--\/\$-->/g).length}`,
]);

// 2. Hydrate around the holes, then update the island's own state.
for (const layout of ["li", "table"]) {
  const serverHtml = renderToString(h(Island, { ...serverProps(), layout }));
  const attr = layout === "li" ? "data-card" : "data-row";
  const props = clientProps();
  const { container, before } = await mount(serverHtml, h(Island, { ...props, layout }));
  const lines = [
    `after hydrate: innerHTML unchanged: ${container.innerHTML === serverHtml}`,
    `slot DOM node kept: ${container.querySelector(`[${attr}=A]`) === before}`,
    `children region kept: ${container.querySelector("[data-children]") !== null}`,
  ];
  await click(container, "inc");
  lines.push(
    `after state update: button reads "${container.querySelector("#inc").textContent}", slot node kept: ${container.querySelector(`[${attr}=A]`) === before}, order ${order(container, attr)}`,
  );
  await click(container, "rev");
  lines.push(`after reverse: order ${order(container, attr)}, slot node kept: ${container.querySelector(`[${attr}=A]`) === before}`);
  await click(container, "rev");
  lines.push(`after reverse back: order ${order(container, attr)}`);
  report(`2. hydrate and reorder, layout "${layout}"`, lines);
}

// 3. Client passes a new hole element on every render (props change on the dehydrated boundary).
{
  const serverHtml = renderToString(h(Island, { ...serverProps(), layout: "li" }));
  function Fresh() {
    const [, force] = useState(0);
    return h(Fragment, null, h("button", { id: "force", onClick: () => force((n) => n + 1) }), h(Island, { ...clientProps(), layout: "li" }));
  }
  const { container } = await mount(`<button id="force"></button>${serverHtml}`, h(Fresh));
  const lines = [`after hydrate: cards ${order(container, "data-card")}`];
  await click(container, "force");
  lines.push(`after parent re-render with new hole elements (sync): cards ${order(container, "data-card")}`);
  report("3. new hole elements on re-render", lines);
}
{
  const serverHtml = renderToString(h(Island, { ...serverProps(), layout: "li" }));
  let force;
  function Fresh() {
    const [n, set] = useState(0);
    force = set;
    return h(Fragment, null, h("p", { id: "n" }, n), h(Island, { ...clientProps(), layout: "li" }));
  }
  const { container } = await mount(`<p id="n">0</p>${serverHtml}`, h(Fresh));
  await act(async () => startTransition(() => force((n) => n + 1)));
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  report("3b. new hole elements on re-render, in a transition", [
    `cards ${order(container, "data-card")}, the transition's own update committed: ${container.querySelector("#n").textContent === "1"}`,
  ]);
}

// 3c. Stable hole elements, but the island clones `children` (no new props) or maps them.
for (const how of ["cloneElement", "Children.map"]) {
  function Wrapper({ children }) {
    const [n, set] = useState(0);
    const placed =
      how === "cloneElement"
        ? React.cloneElement(children)
        : React.Children.map(children, (child) => child);
    return h("div", null, h("button", { id: "inc", onClick: () => set(n + 1) }, `count ${n}`), placed);
  }
  const serverHtml = renderToString(h(Wrapper, null, wrap(h(Para))));
  const { container } = await mount(serverHtml, h(Wrapper, null, hole()));
  const lines = [`after hydrate: children region kept: ${container.querySelector("[data-children]") !== null}`];
  await click(container, "inc");
  lines.push(`after state update: children region kept: ${container.querySelector("[data-children]") !== null}`);
  report(`3c. island applies ${how} to a stable hole`, lines);
}

// 4. Control: the client passes null where the server had an element.
{
  const serverHtml = renderToString(h(Island, { ...serverProps(), layout: "li" }));
  const props = { items: ["A", "B", "C"].map((id) => ({ id, node: null, row: null })), children: null };
  const { container } = await mount(serverHtml, h(Island, { ...props, layout: "li" }));
  report("4. control: null instead of a hole", [`cards ${order(container, "data-card")}, children ${container.querySelector("[data-children]") !== null}`]);
}

// 5. The island's own markup mismatches: the root falls back to a client render.
{
  const serverHtml = renderToString(h(Island, { ...serverProps(), layout: "li" }));
  const { container } = await mount(serverHtml, h(Island, { ...clientProps(), layout: "li", label: "client" }));
  report("5. island markup mismatch", [`cards ${order(container, "data-card")}, children ${container.querySelector("[data-children]") !== null}`]);
}

// 6. Outlining: a large completed boundary under prerender's default progressiveChunkSize.
{
  const filler = "x".repeat(5000);
  const big = await prerenderHtml(h(Island, { ...serverProps(filler), layout: "li" }));
  const capped = await prerenderHtml(h(Island, { ...serverProps(filler), layout: "li" }), { progressiveChunkSize: Infinity });
  const asString = renderToString(h(Island, { ...serverProps(filler), layout: "li" }));
  report("6. outlining of a large slot", [
    `prerender default: <!--$?--> ${(big.match(/<!--\$\?-->/g) ?? []).length}, <template id="B: ${(big.match(/<template id="B:/g) ?? []).length}, $RC script: ${big.includes("$RC")}, <!--$--> ${(big.match(/<!--\$-->/g) ?? []).length}`,
    `prerender progressiveChunkSize Infinity: <!--$?--> ${(capped.match(/<!--\$\?-->/g) ?? []).length}, $RC script: ${capped.includes("$RC")}, <!--$--> ${(capped.match(/<!--\$-->/g) ?? []).length}`,
    `renderToString: <!--$?--> ${(asString.match(/<!--\$\?-->/g) ?? []).length}, $RC script: ${asString.includes("$RC")}, <!--$--> ${(asString.match(/<!--\$-->/g) ?? []).length}`,
  ]);
}

// 7. A nested island inside a slot region: its own hydrateRoot, then the outer island reorders.
{
  function Counter() {
    const [n, set] = useState(0);
    return h("button", { "data-nested": "", onClick: () => set(n + 1) }, `nested ${n}`);
  }
  const NestedCard = ({ name }) => h("article", { "data-card": name }, h("div", { "data-island": name }, h(Counter)));
  const server = {
    items: ["A", "B"].map((name) => ({ id: name, node: wrap(h(NestedCard, { name })) })),
    children: null,
  };
  const serverHtml = renderToString(h(Island, { ...server, layout: "li" }));
  const { container } = await mount(serverHtml, h(Island, { items: ["A", "B"].map((id) => ({ id, node: hole() })), children: null, layout: "li" }));
  const inner = container.querySelector("[data-island=A]");
  await act(async () => {
    hydrateRoot(inner, h(Counter), rootOptions);
  });
  const nested = () => container.querySelector("[data-island=A] button");
  await act(async () => nested().dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  const lines = [`nested island after click: "${nested().textContent}"`];
  await click(container, "rev");
  await act(async () => nested().dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  lines.push(`after outer reverse: order ${order(container, "data-card")}, nested reads "${nested().textContent}"`);
  report("7. nested island inside a slot", lines);
}
// 8. The stand-in's fallback carries the region's HTML, read off the DOM before hydrating.
{
  const regionHtml = (container) => {
    const regions = [];
    const walker = document.createTreeWalker(container, window.NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.data !== "$") continue;
      let html = "";
      for (let at = node.nextSibling; !(at.nodeType === 8 && at.data === "/$"); at = at.nextSibling) {
        html += at.nodeType === 1 ? at.outerHTML : at.textContent;
      }
      regions.push(html);
    }
    return regions;
  };
  const kept = (html) =>
    h(Suspense, { fallback: h("pagedeck-slot", { style: { display: "contents" }, dangerouslySetInnerHTML: { __html: html } }) }, h(Hole));
  for (const how of ["new stand-ins on re-render (sync)", "island markup mismatch"]) {
    const serverHtml = renderToString(h(Island, { ...serverProps(), layout: "li" }));
    const probe = document.createElement("div");
    probe.innerHTML = serverHtml;
    const [a, b, c, children] = regionHtml(probe);
    const props = () => ({
      items: [["A", a], ["B", b], ["C", c]].map(([id, html]) => ({ id, node: kept(html) })),
      children: kept(children),
    });
    let force;
    function Fresh() {
      const [, set] = useState(0);
      force = set;
      return h(Island, { ...props(), layout: "li", label: how === "island markup mismatch" ? "client" : "server" });
    }
    const { container } = await mount(serverHtml, h(Fresh));
    if (how !== "island markup mismatch") await act(async () => force((n) => n + 1));
    report(`8. fallback holds the region's HTML: ${how}`, [
      `cards ${order(container, "data-card")}, children ${container.querySelector("[data-children]") !== null}, wrapped in <pagedeck-slot>: ${container.querySelectorAll("pagedeck-slot").length}`,
    ]);
  }
}
console.error = origError;
```
