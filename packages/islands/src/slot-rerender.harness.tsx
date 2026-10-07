// @vitest-environment jsdom
import {
  act,
  Children,
  cloneElement,
  createElement,
  memo,
  StrictMode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface HarnessElement {
  innerHTML: string;
  appendChild(child: HarnessElement): void;
  querySelector(selectors: string): { click(): void } | null;
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
    return createElement("fw-slot", { ref }, html);
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
