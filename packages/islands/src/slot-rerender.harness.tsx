// @vitest-environment jsdom
import {
  act,
  Children,
  cloneElement,
  createElement,
  memo,
  StrictMode,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { prerender } from "react-dom/static";
import { expect, test, vi } from "vitest";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_REGION_ATTRIBUTE,
  ISLAND_SLOT_PATHS_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_TAG,
  propSlotKey,
} from "./marker.js";
import type { RootProvider } from "./providers.js";
import { hydrateIslands } from "./runtime.js";
import type { IslandElement } from "./runtime.js";
import { propSlotProps } from "./slot.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface HarnessElement {
  innerHTML: string;
  outerHTML: string;
  readonly textContent: string | null;
  appendChild(child: HarnessElement): void;
  getAttribute(name: string): string | null;
  querySelector(selectors: string): HarnessElement | null;
  querySelectorAll(selectors: string): Iterable<HarnessElement>;
  click(): void;
}
declare const document: {
  body: HarnessElement;
  createElement(tag: string): HarnessElement;
};

interface ComparatorCall {
  prev: SlotReplicaProps;
  next: SlotReplicaProps;
}

interface Counts {
  onMount: number;
  perRerender: number;
  bodiesOnMount: number;
  calls: readonly ComparatorCall[];
}

const comparatorCalls: ComparatorCall[] = [];
let bodies = 0;

interface SlotReplicaProps {
  slot: string;
  html: string;
  ref?: { current: unknown };
}

const SlotReplica = memo(
  function SlotReplica({ html, ref }: SlotReplicaProps): ReactElement {
    bodies += 1;
    return createElement(ISLAND_SLOT_TAG, { ref }, html);
  },
  (prev, next) => {
    comparatorCalls.push({ prev, next });
    return true;
  },
);

interface Adoption {
  inPlace: Set<string>;
  slots: ReadonlyMap<string, string>;
}

interface AdoptedReplicaProps {
  slot: string;
  html: string;
  adopt: Adoption;
}

// The `useRef` keeps the React Compiler refusing this replica as it refuses
// `AdoptedSlot`; compiled, it caches on `inPlace` and measures nothing real.
function AdoptedReplica({
  slot,
  html,
  adopt,
}: AdoptedReplicaProps): ReactElement {
  const element = useRef<unknown>(null);
  useEffect(() => {
    adopt.inPlace.delete(slot);
  }, [slot, adopt]);
  const source = adopt.inPlace.has(slot)
    ? html
    : (adopt.slots.get(slot) ?? html);
  return createElement(SlotReplica, { slot, html: source, ref: element });
}

function adoptReplicas(
  slots: ReadonlyMap<string, string>,
): readonly ReactElement[] {
  const adopt: Adoption = { inPlace: new Set(slots.keys()), slots };
  return [...slots].map(([slot]) =>
    createElement(AdoptedReplica, {
      key: slot,
      slot,
      html: `<p>${slot}</p>`,
      adopt,
    }),
  );
}

function twoSlots(): ReadonlyMap<string, string> {
  return new Map([
    ["0.0", "<p>0.0</p><template>stashed</template>"],
    ["0.1", "<p>0.1</p><template>stashed</template>"],
  ]);
}

interface ContainerProps {
  children?: ReactNode;
}

function Restyled({ children }: ContainerProps): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `restyled-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    children,
  );
}

function Reversible({ children }: ContainerProps): ReactElement {
  const [flipped, setFlipped] = useState(false);
  const kids = Children.toArray(children);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { type: "button", onClick: () => setFlipped(!flipped) },
      "flip",
    ),
    ...(flipped ? [...kids].reverse() : kids),
  );
}

function Framed({ children }: ContainerProps): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `framed-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    Children.map(children, (child) => createElement("section", null, child)),
  );
}

function Held({ children }: ContainerProps): ReactElement {
  const [held] = useState(children);
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `held-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    held,
  );
}

function Recloned({ children }: ContainerProps): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `recloned-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    Children.map(children, (child) =>
      cloneElement(child as ReactElement<Record<string, never>>),
    ),
  );
}

function DirectSame(): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `direct-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    createElement(SlotReplica, { slot: "0.0", html: "<p>fixed</p>" }),
  );
}

function DirectSlot(): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `direct-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    createElement(SlotReplica, {
      slot: "0.0",
      html: `<p>render ${String(count)}</p>`,
    }),
  );
}

interface Shape {
  name: string;
  render: (props: ContainerProps) => ReactElement;
  slots: number;
}

const SHAPES: readonly Shape[] = [
  { name: "Restyled", render: Restyled, slots: 2 },
  { name: "Reversible", render: Reversible, slots: 2 },
  { name: "Framed", render: Framed, slots: 2 },
  { name: "Held", render: Held, slots: 2 },
  { name: "Recloned", render: Recloned, slots: 2 },
  { name: "DirectSame", render: DirectSame, slots: 0 },
  { name: "DirectSlot", render: DirectSlot, slots: 0 },
];

async function measure(shape: Shape, strict: boolean): Promise<Counts> {
  comparatorCalls.length = 0;
  bodies = 0;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  const children =
    shape.slots === 0
      ? []
      : adoptReplicas(new Map([...twoSlots()].slice(0, shape.slots)));
  const tree = createElement(shape.render, null, ...children);

  await act(async () => {
    root.render(strict ? createElement(StrictMode, null, tree) : tree);
  });
  const onMount = comparatorCalls.length;
  const bodiesOnMount = bodies;

  comparatorCalls.length = 0;
  await act(async () => {
    host.querySelector("button")?.click();
  });
  const counts: Counts = {
    onMount,
    perRerender: comparatorCalls.length,
    bodiesOnMount,
    calls: [...comparatorCalls],
  };

  await act(async () => {
    root.unmount();
  });
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  return counts;
}

const EXPECTED: Record<string, { perRerender: number; htmlDiffers: boolean }> = {
  Restyled: { perRerender: 0, htmlDiffers: false },
  Reversible: { perRerender: 0, htmlDiffers: false },
  Framed: { perRerender: 0, htmlDiffers: false },
  Held: { perRerender: 0, htmlDiffers: false },
  Recloned: { perRerender: 2, htmlDiffers: true },
  DirectSame: { perRerender: 1, htmlDiffers: false },
  DirectSlot: { perRerender: 1, htmlDiffers: true },
};

for (const strict of [false, true]) {
  for (const shape of SHAPES) {
    test(`${shape.name}, ${strict ? "StrictMode" : "plain"}`, async () => {
      const counts = await measure(shape, strict);
      const expected = EXPECTED[shape.name];
      expect(counts.onMount).toBe(0);
      expect(counts.perRerender).toBe(expected.perRerender);
      expect(
        counts.calls.some((call) => call.prev.html !== call.next.html),
      ).toBe(expected.htmlDiffers);
    });
  }
}

test.each([["Restyled"], ["Reversible"], ["Framed"]])(
  "StrictMode doubles the render function and adds no comparator call: %s",
  async (name) => {
    const shape = SHAPES.find((candidate) => candidate.name === name);
    if (!shape) throw new Error(`no shape named ${name}`);
    const plain = await measure(shape, false);
    const strict = await measure(shape, true);
    expect(plain.bodiesOnMount).toBe(2);
    expect(strict.bodiesOnMount).toBe(4);
    expect(plain.perRerender).toBe(0);
    expect(strict.perRerender).toBe(0);
  },
);

test("StrictMode hands DirectSlot's one comparator call the same prev/next", async () => {
  const plain = await measure(SHAPES[6], false);
  const strict = await measure(SHAPES[6], true);
  expect(plain.calls).toHaveLength(1);
  expect(strict.calls).toEqual(plain.calls);
});

// §3 is this file run with and without `PAGEDECK_REACT_COMPILER=1`, so no case here
// asserts it.

// The prop slot (ADR 0011): the real stand-in `propSlotProps` builds, hydrated
// over server regions, under the same shapes. No comparator sits in its path,
// so what reaches it is counted as fallback mounts, through `hydrate`.

interface PropSlotCounts {
  fallbacksOnHydrate: number;
  fallbacksPerRerender: number;
  nodeKept: boolean;
  contentChanged: boolean;
  rebuilt: number;
  complaints: readonly string[];
}

const PROP_SLOT_HTML = ["<p>slot 0</p>", "<p>slot 1</p>"];

function serverRegion(index: number): ReactElement {
  return createElement(
    Suspense,
    { key: propSlotKey(index), fallback: null },
    createElement("template", { [ISLAND_REGION_ATTRIBUTE]: String(index) }),
    createElement("p", null, `slot ${String(index)}`),
  );
}

function standIns(
  html: readonly string[],
  hydrate: (root: IslandElement) => void,
): readonly ReactNode[] {
  const props = propSlotProps(
    { children: html.map(() => null) },
    {
      paths: html.map((_, index) => ["children", index]),
      html: new Map(html.map((markup, index) => [index, markup])),
    },
    hydrate,
  );
  return props.children as readonly ReactNode[];
}

// Rebuilt on every render: the prop-slot rows for a container that makes its
// own stand-in, which no framework path does.
let directHydrate: (root: IslandElement) => void = () => undefined;
let onServer = false;

function PropDirectSame(): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `direct-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    onServer ? serverRegion(0) : standIns(["<p>slot 0</p>"], directHydrate)[0],
  );
}

function PropDirectSlot(): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "div",
    { className: `direct-${String(count)}` },
    createElement(
      "button",
      { type: "button", onClick: () => setCount(count + 1) },
      "again",
    ),
    onServer
      ? serverRegion(0)
      : standIns([`<p>render ${String(count)}</p>`], directHydrate)[0],
  );
}

const PROP_SHAPES: readonly Shape[] = [
  ...SHAPES.slice(0, 5),
  { name: "DirectSame", render: PropDirectSame, slots: 0 },
  { name: "DirectSlot", render: PropDirectSlot, slots: 0 },
];

async function serverHtml(tree: ReactElement): Promise<string> {
  const { prelude } = await prerender(tree);
  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of prelude) {
    html += decoder.decode(chunk, { stream: true });
  }
  return html + decoder.decode();
}

function content(host: HarnessElement): string {
  return [...host.querySelectorAll("p")]
    .map((paragraph) => paragraph.outerHTML)
    .join("");
}

async function measurePropSlot(
  shape: Shape,
  strict: boolean,
): Promise<PropSlotCounts> {
  let fallbacks = 0;
  const hydrate = (): void => {
    fallbacks += 1;
  };
  directHydrate = hydrate;
  const html = PROP_SLOT_HTML.slice(0, shape.slots);
  onServer = true;
  const server = await serverHtml(
    createElement(shape.render, null, ...html.map((_, index) => serverRegion(index))),
  );
  onServer = false;

  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.innerHTML = server;
  document.body.appendChild(host);
  const first = host.querySelector("p");
  const before = content(host);
  const complaints: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
  });

  const tree = createElement(shape.render, null, ...standIns(html, hydrate));
  let root: { unmount(): void } | undefined;
  await act(async () => {
    root = hydrateRoot(host, strict ? createElement(StrictMode, null, tree) : tree, {
      onRecoverableError: (error) => {
        complaints.push(String(error));
      },
    });
  });
  const fallbacksOnHydrate = fallbacks;
  fallbacks = 0;
  await act(async () => {
    host.querySelector("button")?.click();
  });
  const counts: PropSlotCounts = {
    fallbacksOnHydrate,
    fallbacksPerRerender: fallbacks,
    nodeKept: host.querySelector("p") === first,
    contentChanged: content(host) !== before,
    rebuilt: [...host.querySelectorAll(ISLAND_SLOT_TAG)].length,
    complaints,
  };

  await act(async () => {
    root?.unmount();
  });
  spy.mockRestore();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  return counts;
}

const KEPT = { fallbacksPerRerender: 0, nodeKept: true, contentChanged: false, rebuilt: 0 };

const PROP_SLOT_EXPECTED: Record<
  string,
  Omit<PropSlotCounts, "fallbacksOnHydrate" | "complaints">
> = {
  Restyled: KEPT,
  Reversible: KEPT,
  Framed: KEPT,
  Held: KEPT,
  Recloned: { fallbacksPerRerender: 2, nodeKept: false, contentChanged: false, rebuilt: 2 },
  DirectSame: { fallbacksPerRerender: 1, nodeKept: false, contentChanged: false, rebuilt: 1 },
  DirectSlot: { fallbacksPerRerender: 1, nodeKept: false, contentChanged: true, rebuilt: 1 },
};

for (const strict of [false, true]) {
  for (const shape of PROP_SHAPES) {
    test(`prop slot: ${shape.name}, ${strict ? "StrictMode" : "plain"}`, async () => {
      const { fallbacksOnHydrate, complaints, ...rest } = await measurePropSlot(
        shape,
        strict,
      );
      expect(fallbacksOnHydrate).toBe(0);
      expect(rest).toEqual(PROP_SLOT_EXPECTED[shape.name]);
      expect(complaints).toEqual([]);
    });
  }
}

function NestedCounter(): ReactElement {
  const [count, setCount] = useState(0);
  return createElement(
    "button",
    { type: "button", onClick: () => setCount(count + 1) },
    `nested ${String(count)}`,
  );
}

const NESTED_MARKER = {
  [ISLAND_PREFIX_ATTRIBUTE]: "inested",
  [ISLAND_COMPONENT_ATTRIBUTE]: "NestedCounter",
  [ISLAND_MODE_ATTRIBUTE]: "load",
  [ISLAND_PROPS_ATTRIBUTE]: "{}",
};

function nestedRegion(): ReactElement {
  return createElement(
    Suspense,
    { key: propSlotKey(0), fallback: null },
    createElement("template", { [ISLAND_REGION_ATTRIBUTE]: "0" }),
    createElement(ISLAND_TAG, NESTED_MARKER, createElement(NestedCounter)),
  );
}

interface NestedClone {
  originalCounted: string | null | undefined;
  rootSurvives: boolean;
  hydratedAgain: boolean;
  textAfter: string | null | undefined;
  countsAfter: string | null | undefined;
  complaints: readonly string[];
}

async function measureNestedClone(strict: boolean): Promise<NestedClone> {
  const inner = await serverHtml(createElement(Recloned, null, nestedRegion()));
  const outer = {
    [ISLAND_PREFIX_ATTRIBUTE]: "iouter",
    [ISLAND_COMPONENT_ATTRIBUTE]: "Recloned",
    [ISLAND_MODE_ATTRIBUTE]: "load",
    [ISLAND_PROPS_ATTRIBUTE]: JSON.stringify({ children: [null] }),
    [ISLAND_SLOT_PATHS_ATTRIBUTE]: JSON.stringify([["children", 0]]),
  };
  const attributes = Object.entries(outer)
    .map(([name, value]) => ` ${name}="${value.replaceAll('"', "&quot;")}"`)
    .join("");
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = `<${ISLAND_TAG}${attributes}>${inner}</${ISLAND_TAG}>`;
  const complaints: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
  });
  const nestedSelector = `[${ISLAND_COMPONENT_ATTRIBUTE}="NestedCounter"]`;
  const hydratedNested = (): HarnessElement | null =>
    document.body.querySelector(`${nestedSelector}[${ISLAND_HYDRATED_ATTRIBUTE}]`);
  const until = (condition: () => boolean) =>
    act(async () => {
      await vi.waitFor(() => {
        if (!condition()) throw new Error("not yet");
      });
    });
  const providers: readonly RootProvider[] = strict
    ? [{ component: StrictMode }]
    : [];

  await act(async () => {
    hydrateIslands({
      resolve: async (name) => (name === "Recloned" ? Recloned : NestedCounter),
      providers,
    });
  });
  await until(
    () =>
      [...document.body.querySelectorAll(`[${ISLAND_HYDRATED_ATTRIBUTE}]`)].length === 2,
  );
  const original = hydratedNested();
  await act(async () => {
    original?.querySelector("button")?.click();
  });
  const originalCounted = original?.textContent;
  await act(async () => {
    document.body.querySelector("button")?.click();
  });
  await until(() => hydratedNested() !== null && hydratedNested() !== original);
  const rebuilt = document.body.querySelector(nestedSelector);
  const textAfter = rebuilt?.textContent;
  await act(async () => {
    rebuilt?.querySelector("button")?.click();
  });
  const result: NestedClone = {
    originalCounted,
    rootSurvives: rebuilt === original,
    hydratedAgain: rebuilt?.getAttribute(ISLAND_HYDRATED_ATTRIBUTE) === "",
    textAfter,
    countsAfter: rebuilt?.textContent,
    complaints,
  };
  spy.mockRestore();
  document.body.innerHTML = "";
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  return result;
}

test.each([[false], [true]])(
  "prop slot: cloneElement over a region holding a nested island hydrates it again, reset (StrictMode %s)",
  async (strict) => {
    expect(await measureNestedClone(strict)).toEqual({
      originalCounted: "nested 1",
      rootSurvives: false,
      hydratedAgain: true,
      textAfter: "nested 0",
      countsAfter: "nested 1",
      complaints: [],
    });
  },
);
