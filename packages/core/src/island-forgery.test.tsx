// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ComponentDefinition, HydrationMode, ComponentRegistry } from "@pagedeck/islands";
// The runtime entry point: the package root is what a build reads.
import { hydrateIslands } from "@pagedeck/islands/runtime";
import { schedule } from "@pagedeck/islands/startup";
import { renderPage, unescapedHtml } from "./render.js";
import type { EntryNode } from "./render.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  querySelectorAll(selector: string): Iterable<TestElement>;
}
declare const document: { body: TestElement };

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mounted.length = 0;
  vi.stubGlobal("IntersectionObserver", ImmediateObserver);
  vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
    callback();
  });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

class ImmediateObserver {
  constructor(
    private readonly callback: (
      entries: { target: TestElement; isIntersecting: boolean }[],
    ) => void,
  ) {}

  observe(target: TestElement): void {
    this.callback([{ target, isIntersecting: true }]);
  }

  disconnect(): void {}
}

const mounted: string[] = [];

function component(
  module: unknown,
  hydrate?: HydrationMode,
): ComponentDefinition {
  return { import: async () => ({ default: module }), hydrate };
}

function Notice({ id }: { id: string }) {
  useEffect(() => {
    mounted.push(id);
  }, [id]);
  return <p className="notice">{id}</p>;
}

function Stack({ id, children }: { id: string; children?: ReactNode }) {
  useEffect(() => {
    mounted.push(id);
  }, [id]);
  return <div className="stack">{children}</div>;
}

function Tabs({
  id,
  active,
  children,
}: {
  id: string;
  active: number;
  children?: ReactNode;
}) {
  useEffect(() => {
    mounted.push(id);
  }, [id]);
  const panels = children as readonly ReactNode[];
  return <div className="tabs">{panels[active]}</div>;
}

function Reveal({ id, children }: { id: string; children?: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    mounted.push(id);
    setShown(true);
  }, [id]);
  return <div className="reveal">{shown ? children : null}</div>;
}

function Panel({ title }: { title: string }) {
  return <p>{title}</p>;
}

function Rich({ body }: { body: string }) {
  return <div className="rich" {...unescapedHtml(body)} />;
}

const REGISTRY = {
  NoticeOnLoad: component(Notice, "load"),
  NoticeWhenVisible: component(Notice, "visible"),
  NoticeWhenIdle: component(Notice, "idle"),
  Stack: component(Stack, "load"),
  Tabs: component(Tabs, "load"),
  Reveal: component(Reveal, "load"),
  Panel: component(Panel),
  Rich: component(Rich),
} satisfies ComponentRegistry;

const PAGE = { locale: "en", path: "/home" } as const;

async function resolveModule(name: string): Promise<ComponentType<never>> {
  const definitions = REGISTRY as Readonly<Record<string, ComponentDefinition>>;
  const module = (await definitions[name]?.import()) as {
    default: ComponentType<never>;
  };
  return module.default;
}

async function build(tree: readonly EntryNode[]): Promise<void> {
  const { html } = await renderPage({ page: PAGE, tree, registry: REGISTRY });
  document.body.innerHTML = html;
}

async function buildAndHydrate(tree: readonly EntryNode[]): Promise<void> {
  await build(tree);
  await act(async () => {
    hydrateIslands({ schedule, resolve: resolveModule });
  });
}

function markers(): TestElement[] {
  return [...document.body.querySelectorAll("fw-island")];
}

test("a hydration marker typed into rich text does not mount", async () => {
  await buildAndHydrate([
    {
      component: "Rich",
      props: {
        body:
          '<fw-island data-fw-prefix="ideadbeef0000"' +
          ' data-fw-component="NoticeOnLoad" data-fw-mode="load"' +
          ' data-fw-props="{&quot;id&quot;:&quot;forged&quot;}">' +
          "<span>hi</span></fw-island>",
      },
    },
    { component: "NoticeOnLoad", props: { id: "real" } },
  ]);

  expect(mounted).toEqual(["real"]);
  expect(markers()).toHaveLength(1);
  expect(document.body.textContent).toContain("hi");
});

test("a marker typed into rich text inside a slot does not mount either", async () => {
  await buildAndHydrate([
    {
      component: "Stack",
      props: { id: "stack" },
      children: [
        {
          component: "Rich",
          props: {
            body:
              '<fw-island data-fw-prefix="ideadbeef0000"' +
              ' data-fw-component="NoticeOnLoad" data-fw-mode="load"' +
              ' data-fw-props="{&quot;id&quot;:&quot;forged&quot;}"></fw-island>',
          },
        },
      ],
    },
  ]);

  expect(mounted).toEqual(["stack"]);
  expect(markers()).toHaveLength(1);
});

test("every hydration mode still hydrates", async () => {
  await buildAndHydrate([
    { component: "NoticeOnLoad", props: { id: "load" } },
    { component: "NoticeWhenVisible", props: { id: "visible" } },
    { component: "NoticeWhenIdle", props: { id: "idle" } },
  ]);

  expect([...mounted].sort()).toEqual(["idle", "load", "visible"]);
  expect(markers()).toHaveLength(3);
});

test("nested container islands still hydrate, stash and all", async () => {
  await buildAndHydrate([
    {
      component: "Stack",
      props: { id: "outer" },
      children: [
        { component: "Panel", props: { title: "Static" } },
        {
          component: "Tabs",
          props: { id: "inner", active: 1 },
          children: [
            { component: "Panel", props: { title: "One" } },
            { component: "NoticeOnLoad", props: { id: "nested" } },
          ],
        },
      ],
    },
  ]);

  expect([...mounted].sort()).toEqual(["inner", "nested", "outer"]);
  expect(markers()).toHaveLength(3);

  expect([...document.body.querySelectorAll("template")]).toHaveLength(0);
});

const CLOSES_THE_STASH =
  '<p>Deep</p></template><img src="cms.png"><template>';

test("rich text closing the stash template does not put live DOM in a marker", async () => {
  await build([
    {
      component: "Tabs",
      props: { id: "tabs", active: 0 },
      children: [
        { component: "Panel", props: { title: "One" } },
        { component: "Rich", props: { body: CLOSES_THE_STASH } },
      ],
    },
  ]);

  expect([...document.body.querySelectorAll("img")]).toHaveLength(0);
  expect([...document.body.querySelectorAll("template")]).toHaveLength(1);

  await act(async () => {
    hydrateIslands({ schedule, resolve: resolveModule });
  });

  expect(mounted).toEqual(["tabs"]);
  expect([...document.body.querySelectorAll("img")]).toHaveLength(0);
  expect(document.body.textContent).toContain("One");
});

test("a stash nested in a stash round-trips the panel it holds", async () => {
  await buildAndHydrate([
    {
      component: "Reveal",
      props: { id: "outer" },
      children: [
        {
          component: "Tabs",
          props: { id: "inner", active: 0 },
          children: [
            { component: "Panel", props: { title: "Fish & chips <b>" } },
            { component: "Rich", props: { body: CLOSES_THE_STASH } },
          ],
        },
      ],
    },
  ]);

  expect([...mounted].sort()).toEqual(["inner", "outer"]);

  expect(document.body.textContent).toContain("Fish & chips <b>");
  expect([...document.body.querySelectorAll("b")]).toHaveLength(0);

  expect([...document.body.querySelectorAll("img")]).toHaveLength(0);
});
