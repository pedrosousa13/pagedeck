// @vitest-environment jsdom
import {
  act,
  Children,
  cloneElement,
  createElement,
  useEffect,
  useState,
} from "react";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_SLOT_ATTRIBUTE,
  ISLAND_SLOT_TAG,
  ISLAND_TAG,
  ISLAND_TEMPLATE_ATTRIBUTE,
} from "./marker.js";
import { RegistryError } from "./registry.js";
import { adoptSlots, SlotContent } from "./slot.js";
import { hydrateIslands } from "./runtime.js";
import type { IslandElement } from "./runtime.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  readonly children: ArrayLike<TestElement>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): Iterable<TestElement>;
  click(): void;
}
declare const document: { body: TestElement };

// Hoisted: React reads `reportError` once, when `react-dom/client` first loads,
// and this file loads it at import time.
const reported: string[] = vi.hoisted(() => {
  const lines: string[] = [];
  (globalThis as { reportError?: (error: unknown) => void }).reportError = (
    error,
  ) => {
    lines.push(String(error));
  };
  return lines;
});

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  reported.length = 0;
  mounted.length = 0;
  visible.clear();
  FakeObserver.live.length = 0;
  idleCallbacks.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const visible = new Set<TestElement>();

interface FakeEntry {
  target: TestElement;
  isIntersecting: boolean;
}

function generatesNoBox(element: TestElement): boolean {
  return /display:\s*contents/.test(element.getAttribute("style") ?? "");
}

class FakeObserver {
  static readonly live: FakeObserver[] = [];

  private readonly targets: TestElement[] = [];

  constructor(private readonly callback: (entries: FakeEntry[]) => void) {
    FakeObserver.live.push(this);
  }

  observe(target: TestElement): void {
    this.targets.push(target);
    this.callback([
      { target, isIntersecting: !generatesNoBox(target) && visible.has(target) },
    ]);
  }

  disconnect(): void {
    this.targets.length = 0;
  }

  watches(target: TestElement): boolean {
    return this.targets.includes(target);
  }

  static reveal(target: TestElement): void {
    for (const observer of FakeObserver.live) {
      if (observer.watches(target)) {
        observer.callback([{ target, isIntersecting: true }]);
      }
    }
  }
}

async function scrollTo(element: TestElement): Promise<void> {
  visible.add(element);
  await act(async () => {
    FakeObserver.reveal(element);
  });
}

const idleCallbacks: (() => void)[] = [];

function fakeIdle(): void {
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    idleCallbacks.push(callback);
  });
}

async function runIdleCallbacks(): Promise<void> {
  const due = idleCallbacks.splice(0, idleCallbacks.length);
  await act(async () => {
    for (const callback of due) callback();
  });
}

type AnyComponent = ComponentType<Record<string, unknown>>;

interface Node {
  component: string;
  render: ComponentType<never>;
  props?: Readonly<Record<string, unknown>>;
  mode?: "load" | "visible" | "idle";
  children?: readonly Node[];
}

async function prerenderToHtml(
  tree: ReactNode,
  identifierPrefix: string,
): Promise<string> {
  const { prelude } = await prerender(tree, { identifierPrefix });
  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of prelude) {
    html += decoder.decode(chunk, { stream: true });
  }
  return html + decoder.decode();
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

async function buildNode(
  node: Node,
  position: readonly number[],
): Promise<string> {
  const slots: { id: string; html: string }[] = [];
  for (const [at, child] of (node.children ?? []).entries()) {
    const childPosition = [...position, at];
    slots.push({
      id: childPosition.join("."),
      html: await buildNode(child, childPosition),
    });
  }
  const prefix = `i${position.join("")}`;
  const html = await prerenderToHtml(
    createElement(
      node.render as AnyComponent,
      { ...node.props },
      ...slots.map((slot) =>
        createElement(SlotContent, {
          key: slot.id,
          slot: slot.id,
          html: slot.html,
        }),
      ),
    ),
    prefix,
  );
  if (node.mode === undefined) return html;

  const stash = slots
    .filter((slot) => !html.includes(`${ISLAND_SLOT_ATTRIBUTE}="${slot.id}"`))
    .map(
      (slot) =>
        `<template ${ISLAND_TEMPLATE_ATTRIBUTE}="${slot.id}">${escapeText(slot.html)}</template>`,
    )
    .join("");
  const props = escapeAttribute(JSON.stringify(node.props ?? {}));
  return (
    `<${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="${prefix}"` +
    ` ${ISLAND_COMPONENT_ATTRIBUTE}="${node.component}"` +
    ` ${ISLAND_MODE_ATTRIBUTE}="${node.mode}"` +
    ` ${ISLAND_PROPS_ATTRIBUTE}="${props}"` +
    ` role="presentation" style="display:contents">${html + stash}</${ISLAND_TAG}>`
  );
}

function modulesIn(node: Node, into: Map<string, ComponentType<never>>): void {
  into.set(node.component, node.render);
  for (const child of node.children ?? []) modulesIn(child, into);
}

async function buildPage(
  tree: readonly Node[],
): Promise<(name: string) => Promise<ComponentType<never>>> {
  const html = await Promise.all(tree.map((node, at) => buildNode(node, [at])));
  document.body.innerHTML = html.join("");
  const modules = new Map<string, ComponentType<never>>();
  for (const node of tree) modulesIn(node, modules);
  return async (name) => modules.get(name) as ComponentType<never>;
}

async function complaintsWhile(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await run();
  spy.mockRestore();
  return lines;
}

function container(): TestElement {
  return document.body.querySelector(ISLAND_TAG) as TestElement;
}

async function click(element: TestElement | null): Promise<void> {
  await act(async () => {
    element?.querySelector("button")?.click();
  });
}

function Block({ title }: { title: string }) {
  return <p data-block={title}>{title}</p>;
}

function Stack({ children }: { children?: ReactNode }) {
  return <div className="stack">{children}</div>;
}

function Tabs({ active, children }: { active: number; children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  const [open, setOpen] = useState(active);
  return (
    <div className="tabs">
      <button type="button" onClick={() => setOpen((open + 1) % panels.length)}>
        next
      </button>
      {panels[open]}
    </div>
  );
}

test("a container adopts the DOM its slotted children already have", async () => {
  const resolve = await buildPage([
    {
      component: "Stack",
      render: Stack,
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  // Compared by identity: re-rendered content would be an equal-looking, different
  // node.
  const before = [...document.body.querySelectorAll("p")];

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(before).toHaveLength(2);
  expect([...document.body.querySelectorAll("p")]).toEqual(before);
  expect(container().textContent).toBe("OneTwo");
});

test("the stash is out of the marker before React is given it", async () => {
  const resolve = await buildPage([
    {
      component: "Tabs",
      render: Tabs,
      props: { active: 0 },
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  expect(container().querySelector(`[${ISLAND_TEMPLATE_ATTRIBUTE}]`)).not.toBe(
    null,
  );

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  // Asserted directly: React 19.2 tolerates a trailing stash in silence, so a
  // mismatch would never report it.
  expect(container().querySelector(`[${ISLAND_TEMPLATE_ATTRIBUTE}]`)).toBe(null);
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

test("a template that is not a marker's own child is left where its author put it", async () => {
  const resolve = await buildPage([
    {
      component: "Stack",
      render: Stack,
      mode: "load",
      children: [{ component: "Block", render: Block, props: { title: "One" } }],
    },
  ]);
  document.body.innerHTML += `<div class="cms"><template ${ISLAND_TEMPLATE_ATTRIBUTE}="9.9"><p>theirs</p></template></div>`;

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(
    document.body.querySelector(`.cms [${ISLAND_TEMPLATE_ATTRIBUTE}]`),
  ).not.toBe(null);
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("One");
});

function Authored() {
  return (
    <div className="cms">
      <template {...{ [ISLAND_TEMPLATE_ATTRIBUTE]: "9.9" }} />
    </div>
  );
}

test("a template inside a marker but not its own child is left where its author put it", async () => {
  const resolve = await buildPage([
    {
      component: "Stack",
      render: Stack,
      mode: "load",
      children: [{ component: "Authored", render: Authored }],
    },
  ]);
  expect(
    container().querySelector(`.cms [${ISLAND_TEMPLATE_ATTRIBUTE}]`),
  ).not.toBe(null);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(
    container().querySelector(`.cms [${ISLAND_TEMPLATE_ATTRIBUTE}]`),
  ).not.toBe(null);
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

function Mislabelled() {
  return <div className="cms" {...{ [ISLAND_TEMPLATE_ATTRIBUTE]: "9.9" }} />;
}

test("an element that is not a template but sits where a stash does is left where its author put it", async () => {
  const resolve = await buildPage([
    { component: "Mislabelled", render: Mislabelled, mode: "load" },
  ]);
  const before = container().querySelector(`div[${ISLAND_TEMPLATE_ATTRIBUTE}]`);
  expect(before).not.toBe(null);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  // Identity, because React recovers from a mismatch by rendering the element
  // again, which an equality check cannot tell from "never removed".
  expect(container().querySelector(`div[${ISLAND_TEMPLATE_ATTRIBUTE}]`)).toBe(
    before,
  );
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

test("a <fw-slot> outside every marker is not what a re-shown panel is rebuilt from", async () => {
  const resolve = await buildPage([
    {
      component: "Tabs",
      render: Tabs,
      props: { active: 0 },
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  document.body.innerHTML += `<div class="cms"><${ISLAND_SLOT_TAG} ${ISLAND_SLOT_ATTRIBUTE}="0.0"><p>spoofed</p></${ISLAND_SLOT_TAG}></div>`;

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    await click(container());
    await click(container());
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("nextOne");
  expect(document.body.querySelector(".cms")?.textContent).toBe("spoofed");
});

function Quoted() {
  return (
    <div className="cms">
      {createElement(
        ISLAND_SLOT_TAG,
        { [ISLAND_SLOT_ATTRIBUTE]: '0"]', role: "presentation" },
        "theirs",
      )}
    </div>
  );
}

test("a slot id outside the shape the build writes is left to whoever wrote it", async () => {
  const resolve = await buildPage([
    {
      component: "Stack",
      render: Stack,
      mode: "load",
      children: [
        { component: "Quoted", render: Quoted },
        {
          component: "Counter",
          render: Counter,
          props: { label: "Add" },
          mode: "load",
        },
      ],
    },
  ]);
  expect(container().querySelector(`.cms [${ISLAND_SLOT_ATTRIBUTE}]`)).not.toBe(
    null,
  );

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("theirsAdd:0");
  expect(container().querySelector(`.cms [${ISLAND_SLOT_ATTRIBUTE}]`)).not.toBe(
    null,
  );

  await act(async () => {
    counter()?.click();
  });

  expect(counter()?.textContent).toBe("Add:1");
});

// The early `>` in `title` ends the start tag `slotCopies` scans for, so the
// build counts no copy (#129).
const FORGED = `<${ISLAND_SLOT_TAG} title="a>b" ${ISLAND_SLOT_ATTRIBUTE}="0.0" role="presentation">spoofed</${ISLAND_SLOT_TAG}>`;

function Forger() {
  return (
    <div
      className="cms"
      dangerouslySetInnerHTML={{ __html: `<p>real</p>${FORGED}` }}
    />
  );
}

test("a <fw-slot> under a nested marker cannot claim the panel it is inside", async () => {
  const resolve = await buildPage([
    {
      component: "Stack",
      render: Stack,
      mode: "load",
      children: [{ component: "Forger", render: Forger, mode: "load" }],
    },
  ]);
  expect(
    container()
      .querySelector(`.cms [${ISLAND_SLOT_ATTRIBUTE}]`)
      ?.getAttribute(ISLAND_SLOT_ATTRIBUTE),
  ).toBe("0.0");
  const panel = container().querySelector(ISLAND_TAG);
  expect(panel).not.toBe(null);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().querySelector(ISLAND_TAG)).toBe(panel);
  expect(container().textContent).toBe("realspoofed");
});

function forgery(id: string): string {
  return `<${ISLAND_SLOT_TAG} ${ISLAND_SLOT_ATTRIBUTE}="${id}" role="presentation">FORGED(${id})</${ISLAND_SLOT_TAG}>`;
}

const ANY_SLOT = `[${ISLAND_SLOT_ATTRIBUTE}]`;

const ADOPTED_SLOT = `${ANY_SLOT}:not(.cms *)`;

function slotIds(selector: string): string[] {
  return [...container().querySelectorAll(selector)].map(
    (element) => element.getAttribute(ISLAND_SLOT_ATTRIBUTE) as string,
  );
}

const MISMATCH = "Hydration failed because the server rendered HTML";

function expectOneMismatch(complaints: readonly string[]): void {
  expect(reported).toHaveLength(1);
  expect(reported[0]).toContain(MISMATCH);
  expect(complaints).toEqual([]);
}

function Planted({
  forged,
  where,
  children,
}: {
  forged: string;
  where: "before" | "after";
  children?: ReactNode;
}) {
  const cms = (
    <div className="cms" dangerouslySetInnerHTML={{ __html: forgery(forged) }} />
  );
  return (
    <div className="stack">
      {where === "before" ? cms : null}
      {children}
      {where === "after" ? cms : null}
    </div>
  );
}

const PLANTED = [
  [
    "1",
    "after",
    {
      order: ["0.0", "0.1", "1"],
      adopted: ["0.0", "0.1", "1"],
      text: "OneTwoFORGED(1)FORGED(1)",
    },
  ],
  [
    "1",
    "before",
    {
      order: ["1", "0.0", "0.1"],
      adopted: ["0.0", "0.1", "1"],
      text: "FORGED(1)OneTwoFORGED(1)",
    },
  ],
  [
    "2.1",
    "after",
    {
      order: ["0.0", "0.1", "2.1"],
      adopted: ["0.0", "0.1", "2.1"],
      text: "OneTwoFORGED(2.1)FORGED(2.1)",
    },
  ],
  [
    "2.1",
    "before",
    {
      order: ["2.1", "0.0", "0.1"],
      adopted: ["0.0", "0.1", "2.1"],
      text: "FORGED(2.1)OneTwoFORGED(2.1)",
    },
  ],
] as const;

test.each(PLANTED)(
  'a forged slot id sharing a panel\'s last segment is adopted beside it ("%s", %s the panels)',
  async (forged, where, { order, adopted, text }) => {
    const resolve = await buildPage([
      {
        component: "Planted",
        render: Planted,
        props: { forged, where },
        mode: "load",
        children: [
          { component: "Block", render: Block, props: { title: "One" } },
          { component: "Block", render: Block, props: { title: "Two" } },
        ],
      },
    ]);
    expect(slotIds(ANY_SLOT)).toEqual(order);

    const complaints = await complaintsWhile(async () => {
      await act(async () => {
        hydrateIslands({ resolve });
      });
    });

    expect(slotIds(ADOPTED_SLOT)).toEqual(adopted);
    expectOneMismatch(complaints);
    expect(container().textContent).toBe(text);
  },
);

const NESTED_FORGERY = `[${ISLAND_SLOT_ATTRIBUTE}="0.0"] .cms [${ISLAND_SLOT_ATTRIBUTE}]`;

function Planter() {
  return (
    <div
      className="cms"
      dangerouslySetInnerHTML={{
        __html: `<p data-block="One">One</p>${forgery("1")}`,
      }}
    />
  );
}

test('a forged slot id sharing a panel\'s last segment is adopted beside it ("1", nested in the first panel)', async () => {
  const resolve = await buildPage([
    {
      component: "Stack",
      render: Stack,
      mode: "load",
      children: [
        { component: "Planter", render: Planter },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  expect(slotIds(ANY_SLOT)).toEqual(["0.0", "1", "0.1"]);
  expect(
    container()
      .querySelector(NESTED_FORGERY)
      ?.getAttribute(ISLAND_SLOT_ATTRIBUTE),
  ).toBe("1");

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(slotIds(ADOPTED_SLOT)).toEqual(["0.0", "0.1", "1"]);
  expectOneMismatch(complaints);
  expect(
    container()
      .querySelector(NESTED_FORGERY)
      ?.getAttribute(ISLAND_SLOT_ATTRIBUTE),
  ).toBe("1");
  expect(container().textContent).toBe("OneFORGED(1)TwoFORGED(1)");
});

function adoptedOrder(written: readonly string[]): string[] {
  document.body.innerHTML = written
    .map(
      (id) =>
        `<${ISLAND_SLOT_TAG} ${ISLAND_SLOT_ATTRIBUTE}="${id}">${id}</${ISLAND_SLOT_TAG}>`,
    )
    .join("");
  const adopted = adoptSlots({
    marker: document.body as unknown as IslandElement,
    component: "Order",
    slots: undefined,
    hydrate: () => {},
    owns: () => true,
  });
  return adopted.map((node) => (node as ReactElement).key as string);
}

test("ids that share a last segment are ordered by their whole path", () => {
  expect(adoptedOrder(["9.9.9.1", "2.1", "1", "0.1"])).toEqual([
    "0.1",
    "1",
    "2.1",
    "9.9.9.1",
  ]);
});

test("segments are compared numerically rather than as text", () => {
  expect(adoptedOrder(["0.10", "0.9", "0.2"])).toEqual(["0.2", "0.9", "0.10"]);
});

test("an id sorts before the deeper ids that extend it", () => {
  expect(adoptedOrder(["0.0.0", "0.1", "0", "0.0"])).toEqual([
    "0",
    "0.0",
    "0.0.0",
    "0.1",
  ]);
});

test("real sibling panels keep the order they have always had", () => {
  expect(adoptedOrder(["0.2", "0.0", "0.1"])).toEqual(["0.0", "0.1", "0.2"]);
});

test("a panel the build never rendered is shown from the stash after hydration", async () => {
  const resolve = await buildPage([
    {
      component: "Tabs",
      render: Tabs,
      props: { active: 0 },
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  expect(container().textContent).toBe("nextOne");

  await act(async () => {
    hydrateIslands({ resolve });
  });
  await click(container());

  expect(container().textContent).toBe("nextTwo");
  expect(container().querySelector('[data-block="One"]')).toBe(null);
});

function Modal({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="modal">
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open ? children : null}
    </div>
  );
}

test("a container that stashed every child is still found to be one", async () => {
  const resolve = await buildPage([
    {
      component: "Modal",
      render: Modal,
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  expect(container().querySelector(ISLAND_SLOT_TAG)).toBe(null);
  expect([
    ...container().querySelectorAll(`[${ISLAND_TEMPLATE_ATTRIBUTE}]`),
  ]).toHaveLength(2);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    await click(container());
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("openOneTwo");
});

function Reversible({ children }: { children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  const [reversed, setReversed] = useState(false);
  return (
    <div className="reversible">
      <button type="button" onClick={() => setReversed(!reversed)}>
        flip
      </button>
      {reversed ? [...panels].reverse() : panels}
    </div>
  );
}

test("reordering slotted children moves their DOM rather than rebuilding it", async () => {
  const resolve = await buildPage([
    {
      component: "Reversible",
      render: Reversible,
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);

  await act(async () => {
    hydrateIslands({ resolve });
  });
  const [one, two] = [...document.body.querySelectorAll("p")];
  await click(container());

  expect(container().textContent).toBe("flipTwoOne");
  expect([...document.body.querySelectorAll("p")]).toEqual([two, one]);
});

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button className="counter" type="button" onClick={() => setCount(count + 1)}>
      {label}:{count}
    </button>
  );
}

function counter(): TestElement | null {
  return document.body.querySelector("button.counter");
}

test("an island in a panel the container never rendered hydrates when the panel opens", async () => {
  const resolve = await buildPage([
    {
      component: "Tabs",
      render: Tabs,
      props: { active: 0 },
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        {
          component: "Counter",
          render: Counter,
          props: { label: "Add" },
          mode: "load",
        },
      ],
    },
  ]);
  expect(counter()).toBe(null);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    await click(container());
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(counter()?.textContent).toBe("Add:0");

  await act(async () => {
    counter()?.click();
  });

  expect(counter()?.textContent).toBe("Add:1");
});

function Reveal({ children }: { children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  const [open, setOpen] = useState(false);
  return (
    <div className="reveal">
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {panels[0]}
      {open ? panels[1] : null}
    </div>
  );
}

// Unquoted, so `slotCopies`, which looks for the quoted attribute, counts no
// copy and the panel is stashed as usual.
const DECOY = `<${ISLAND_SLOT_TAG} ${ISLAND_SLOT_ATTRIBUTE}=0.1 role=presentation><i>decoy</i></${ISLAND_SLOT_TAG}>`;

function Decoy() {
  return <div className="cms" dangerouslySetInnerHTML={{ __html: DECOY }} />;
}

test("a forged <fw-slot> cannot take the hydrate meant for the panel being opened", async () => {
  const resolve = await buildPage([
    {
      component: "Reveal",
      render: Reveal,
      mode: "load",
      children: [
        { component: "Decoy", render: Decoy, mode: "load" },
        {
          component: "Counter",
          render: Counter,
          props: { label: "Add" },
          mode: "load",
        },
      ],
    },
  ]);
  expect(
    container()
      .querySelector(`.cms [${ISLAND_SLOT_ATTRIBUTE}]`)
      ?.getAttribute(ISLAND_SLOT_ATTRIBUTE),
  ).toBe("0.1");
  expect(counter()).toBe(null);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    await click(container());
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(counter()?.textContent).toBe("Add:0");

  await act(async () => {
    counter()?.click();
  });

  expect(counter()?.textContent).toBe("Add:1");
});

test("a container hydrates against the DOM as it is at mount, not as it was at capture", async () => {
  const resolve = await buildPage([
    {
      component: "Stack",
      render: Stack,
      mode: "idle",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  fakeIdle();

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    container().innerHTML = container().innerHTML.replaceAll("One", "Uno");
    await runIdleCallbacks();
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("UnoTwo");
});

function Moving({ children }: { children?: ReactNode }) {
  const [moved, setMoved] = useState(false);
  return (
    <div className="moving">
      <button type="button" onClick={() => setMoved(!moved)}>
        move
      </button>
      {moved ? null : <div className="a">{children}</div>}
      {moved ? <div className="b">{children}</div> : null}
    </div>
  );
}

test("moving a slotted child to a different parent element rebuilds it, silently", async () => {
  const resolve = await buildPage([
    {
      component: "Moving",
      render: Moving,
      mode: "load",
      children: [
        {
          component: "Counter",
          render: Counter,
          props: { label: "Add" },
          mode: "load",
        },
      ],
    },
  ]);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    await act(async () => {
      counter()?.click();
    });
    expect(counter()?.textContent).toBe("Add:1");
    await click(container());
  });

  expect(document.body.querySelector(".b .counter")).not.toBe(null);
  expect(counter()?.textContent).toBe("Add:0");
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

const mounted: string[] = [];

function Bare({ id, children }: { id: string; children?: ReactNode }) {
  useEffect(() => {
    mounted.push(id);
  }, [id]);
  return <>{children}</>;
}

function Closed({ id }: { id: string; children?: ReactNode }) {
  useEffect(() => {
    mounted.push(id);
  }, [id]);
  return null;
}

test("a visible container whose only children are slots observes what is inside them", async () => {
  const resolve = await buildPage([
    {
      component: "Bare",
      render: Bare,
      props: { id: "bare" },
      mode: "visible",
      children: [{ component: "Block", render: Block, props: { title: "One" } }],
    },
  ]);
  const panel = document.body.querySelector("p") as TestElement;

  await act(async () => {
    hydrateIslands({ resolve });
  });
  expect(mounted).toEqual([]);

  await scrollTo(panel);

  expect(mounted).toEqual(["bare"]);
});

test("a visible container that rendered no slot at all falls back to idle", async () => {
  fakeIdle();
  const resolve = await buildPage([
    {
      component: "Closed",
      render: Closed,
      props: { id: "closed" },
      mode: "visible",
      children: [{ component: "Block", render: Block, props: { title: "One" } }],
    },
  ]);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  expect(FakeObserver.live).toHaveLength(0);
  expect(mounted).toEqual([]);

  await runIdleCallbacks();

  expect(mounted).toEqual(["closed"]);
});

function Framed({ children }: { children?: ReactNode }) {
  return (
    <div className="framed">
      {Children.count(children)} panels:{" "}
      {Children.map(children, (child) => (
        <section>{child}</section>
      ))}
    </div>
  );
}

function Numbered({ children }: { children?: ReactNode }) {
  return (
    <div className="numbered">
      {Children.map(children, (child, index) =>
        cloneElement(child as ReactElement<Record<string, unknown>>, {
          index,
        }),
      )}
    </div>
  );
}

test("a container that clones a slotted child to inject props is refused, naming it", async () => {
  const resolve = await buildPage([
    {
      component: "Numbered",
      render: Numbered,
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);

  let thrown: unknown;
  await complaintsWhile(async () => {
    try {
      await act(async () => {
        hydrateIslands({ resolve });
      });
    } catch (error) {
      thrown = error;
    }
  });

  expect(thrown).toBeInstanceOf(RegistryError);
  expect((thrown as Error).message).toBe(
    'Component "Numbered": gives slotted child 0 props it cannot receive (index) — ' +
      "slotted content is one node of already-rendered HTML that hydration adopts in place, " +
      "so there is no element inside it for cloneElement to give props to and it can never re-render; " +
      "position, wrap, show, hide and reorder it instead",
  );
});

function Restyled({ children }: { children?: ReactNode }) {
  const [count, setCount] = useState(0);
  return (
    <div className={`restyled-${String(count)}`}>
      <button type="button" onClick={() => setCount(count + 1)}>
        again
      </button>
      {children}
    </div>
  );
}

test("a container that re-renders its slotted children silently does nothing", async () => {
  const resolve = await buildPage([
    {
      component: "Restyled",
      render: Restyled,
      mode: "load",
      children: [{ component: "Block", render: Block, props: { title: "One" } }],
    },
  ]);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });
  const [panel] = [...document.body.querySelectorAll("p")];
  await click(container());

  expect(container().querySelector(".restyled-1")).not.toBe(null);
  expect([...document.body.querySelectorAll("p")]).toEqual([panel]);
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

function Doubling({ children }: { children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  const [doubled, setDoubled] = useState(false);
  return (
    <div className="doubling">
      <button type="button" onClick={() => setDoubled(true)}>
        double
      </button>
      {panels[0]}
      {doubled ? panels[0] : null}
      {panels[1]}
    </div>
  );
}

test("a container that mounts one slotted child in two places is refused, naming it", async () => {
  const resolve = await buildPage([
    {
      component: "Doubling",
      render: Doubling,
      mode: "load",
      children: [
        {
          component: "Counter",
          render: Counter,
          props: { label: "Add" },
          mode: "load",
        },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  await act(async () => {
    hydrateIslands({ resolve });
  });
  await act(async () => {
    counter()?.click();
  });
  expect(counter()?.textContent).toBe("Add:1");

  let thrown: unknown;
  await complaintsWhile(async () => {
    try {
      await click(container());
    } catch (error) {
      thrown = error;
    }
  });

  expect(thrown).toBeInstanceOf(RegistryError);
  expect((thrown as Error).message).toBe(
    'Component "Doubling": mounts slotted child 0 in two places at once — ' +
      "slotted content is one node of already-rendered HTML that hydration adopts in place, " +
      "so a second copy has no DOM of its own and the client moves the first one rather than " +
      "repeating it; render each slotted child at most once",
  );
});

function DoublingAll({ children }: { children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  const [doubled, setDoubled] = useState(false);
  return (
    <div className="doubling-all">
      <button type="button" onClick={() => setDoubled(true)}>
        double
      </button>
      {panels}
      {doubled ? panels : null}
    </div>
  );
}

test("two slots duplicated at once arrive as React's AggregateError", async () => {
  const resolve = await buildPage([
    {
      component: "DoublingAll",
      render: DoublingAll,
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);
  await act(async () => {
    hydrateIslands({ resolve });
  });

  let thrown: unknown;
  await complaintsWhile(async () => {
    try {
      await click(container());
    } catch (error) {
      thrown = error;
    }
  });

  expect(thrown).toBeInstanceOf(AggregateError);
  expect(thrown).not.toBeInstanceOf(RegistryError);
  const { errors } = thrown as AggregateError;
  expect(errors.every((error) => error instanceof RegistryError)).toBe(true);
  expect(errors.map((error: Error) => error.message)).toEqual([
    'Component "DoublingAll": mounts slotted child 0 in two places at once — ' +
      "slotted content is one node of already-rendered HTML that hydration adopts in place, " +
      "so a second copy has no DOM of its own and the client moves the first one rather than " +
      "repeating it; render each slotted child at most once",
    'Component "DoublingAll": mounts slotted child 1 in two places at once — ' +
      "slotted content is one node of already-rendered HTML that hydration adopts in place, " +
      "so a second copy has no DOM of its own and the client moves the first one rather than " +
      "repeating it; render each slotted child at most once",
  ]);
});

test("counting and wrapping slotted children is allowed, and stays silent", async () => {
  const resolve = await buildPage([
    {
      component: "Framed",
      render: Framed,
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("2 panels: OneTwo");
});

function Recloned({ children }: { children?: ReactNode }) {
  const [count, setCount] = useState(0);
  return (
    <div className={`recloned-${String(count)}`}>
      <button type="button" onClick={() => setCount(count + 1)}>
        again
      </button>
      {Children.map(children, (child) => cloneElement(child as ReactElement))}
    </div>
  );
}

test("cloning a slotted child with no new props is allowed, and stays silent", async () => {
  const resolve = await buildPage([
    {
      component: "Recloned",
      render: Recloned,
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        { component: "Block", render: Block, props: { title: "Two" } },
      ],
    },
  ]);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    const panels = [...document.body.querySelectorAll("p")];
    await click(container());

    expect(container().querySelector(".recloned-1")).not.toBe(null);
    expect([...document.body.querySelectorAll("p")]).toEqual(panels);
  });
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

const NESTED_MODES = [
  ["load", "load"],
  ["load", "idle"],
  ["idle", "load"],
  ["idle", "idle"],
] as const;

test.each(NESTED_MODES)(
  "nested containers, outer %s and inner %s, keep their panels through a hide and a re-show",
  async (outer, inner) => {
    const resolve = await buildPage([
      {
        component: "Tabs",
        render: Tabs,
        props: { active: 0 },
        mode: outer,
        children: [
          {
            component: "Tabs",
            render: Tabs,
            props: { active: 0 },
            mode: inner,
            children: [
              { component: "Block", render: Block, props: { title: "Two" } },
              { component: "Block", render: Block, props: { title: "Three" } },
            ],
          },
          { component: "Block", render: Block, props: { title: "One" } },
        ],
      },
    ]);
    fakeIdle();

    const onHydration = await complaintsWhile(async () => {
      await act(async () => {
        hydrateIslands({ resolve });
      });
      await runIdleCallbacks();
    });
    expect(onHydration).toEqual([]);
    expect(reported).toEqual([]);

    const complaints = await complaintsWhile(async () => {
      await click(container());
      await click(container());
      await runIdleCallbacks();
    });

    expect(complaints).toEqual([]);
    expect(reported).toEqual([]);
    expect(container().textContent).toBe("nextnextTwo");
    await act(async () => {
      document.body.querySelector(".tabs .tabs button")?.click();
    });
    expect(container().textContent).toBe("nextnextThree");
  },
);

test("a container stashed inside another container's panel adopts its own slots", async () => {
  const resolve = await buildPage([
    {
      component: "Tabs",
      render: Tabs,
      props: { active: 0 },
      mode: "load",
      children: [
        { component: "Block", render: Block, props: { title: "One" } },
        {
          component: "Reversible",
          render: Reversible,
          mode: "load",
          children: [
            { component: "Block", render: Block, props: { title: "Two" } },
            { component: "Block", render: Block, props: { title: "Three" } },
          ],
        },
      ],
    },
  ]);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
    await click(container());
  });
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("nextflipTwoThree");

  await act(async () => {
    document.body.querySelector(".reversible button")?.click();
  });

  expect(container().textContent).toBe("nextflipThreeTwo");
});

test("three containers nested on load hydrate without a mismatch", async () => {
  const resolve = await buildPage([
    {
      component: "Tabs",
      render: Tabs,
      props: { active: 0 },
      mode: "load",
      children: [
        {
          component: "Tabs",
          render: Tabs,
          props: { active: 0 },
          mode: "load",
          children: [
            {
              component: "Tabs",
              render: Tabs,
              props: { active: 0 },
              mode: "load",
              children: [
                { component: "Block", render: Block, props: { title: "Deep" } },
                { component: "Block", render: Block, props: { title: "Deeper" } },
              ],
            },
            { component: "Block", render: Block, props: { title: "Mid" } },
          ],
        },
        { component: "Block", render: Block, props: { title: "One" } },
      ],
    },
  ]);

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(container().textContent).toBe("nextnextnextDeep");
});
