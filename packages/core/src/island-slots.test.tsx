// The wire format is literal HTML, not `render.tsx`'s constants: a test built from
// the writer's constants passes through any rename.
import { useId } from "react";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import type { ComponentDefinition, ComponentRegistry } from "@pagedeck/islands";
import { renderPage, RenderError, unescapedHtml } from "./render.js";
import type { EntryNode, RenderedIsland } from "./render.js";

function component(module: unknown): ComponentDefinition {
  return { import: async () => ({ default: module }) };
}

const PAGE = { locale: "en", path: "/home" } as const;

function Panel({ title }: { title: string }) {
  return <p>{title}</p>;
}

function Stack({ children }: { children?: ReactNode }) {
  return <div className="stack">{children}</div>;
}

function Tabs({ active, children }: { active: number; children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  return <div className="tabs">{panels[active]}</div>;
}

function Twice({ children }: { children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  return (
    <div className="dup">
      {panels[0]}
      <span>{panels[0]}</span>
    </div>
  );
}

// `dangerouslySetInnerHTML`, not `unescapedHtml`: the door #109's strip does not
// cover.
function Forged({ body, children }: { body: string; children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  return (
    <div className="tabs">
      <div className="forged" dangerouslySetInnerHTML={{ __html: body }} />
      {panels[1]}
    </div>
  );
}

function Counter({ label }: { label: string }) {
  const id = useId();
  return (
    <button className="counter" id={id}>
      {label}
    </button>
  );
}

function Rich({ body }: { body: string }) {
  return <div className="rich" {...unescapedHtml(body)} />;
}

function Field({ label }: { label: string }) {
  const id = useId();
  return (
    <label htmlFor={id}>
      <input id={id} />
      {label}
    </label>
  );
}

const REGISTRY = {
  Panel: component(Panel),
  Stack: component(Stack),
  Tabs: component(Tabs),
  Twice: component(Twice),
  Forged: component(Forged),
  Counter: component(Counter),
  Field: component(Field),
  Rich: component(Rich),
} satisfies ComponentRegistry;

const CONTAINERS_ARE_CLIENT = {
  Stack: { useClient: true },
  Tabs: { useClient: true },
  Twice: { useClient: true },
  Forged: { useClient: true },
  Counter: { useClient: true },
};

function marker(island: RenderedIsland, props: string): string {
  return (
    `<fw-island data-fw-prefix="${island.prefix}"` +
    ` data-fw-component="${island.component}"` +
    ` data-fw-mode="${island.mode}"` +
    ` data-fw-props="${props}"` +
    ` role="presentation" style="display:contents">${island.html}</fw-island>`
  );
}

function slot(id: string, html: string): string {
  return (
    `<fw-slot data-fw-slot="${id}"` +
    ` role="presentation" style="display:contents">${html}</fw-slot>`
  );
}

function stash(id: string, html: string): string {
  const text = html.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<template data-fw-template="${id}">${text}</template>`;
}

const TWO_PANELS: readonly EntryNode[] = [
  { component: "Panel", props: { title: "One" } },
  { component: "Panel", props: { title: "Two" } },
];

test("a container island's slotted children arrive as opaque already-rendered HTML", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Stack", children: TWO_PANELS }],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  expect(islands).toHaveLength(1);
  const [island] = islands as [RenderedIsland];
  expect(island.component).toBe("Stack");
  expect(island.path).toEqual([0]);

  expect(html).toBe(marker(island, "{}"));
  expect(island.html).toBe(
    '<div class="stack">' +
      slot("0.0", "<p>One</p>") +
      slot("0.1", "<p>Two</p>") +
      "</div>",
  );
});

test("two slotted children of one container get ids from different passes", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Stack",
        children: [
          { component: "Field", props: { label: "One" } },
          { component: "Field", props: { label: "Two" } },
        ],
      },
    ],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const ids = [...(islands[0]?.html ?? "").matchAll(/ id="([^"]*)"/g)].map(
    (match) => match[1],
  );
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

test("a slotted child the container did not render is stashed in a template", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Tabs", props: { active: 1 }, children: TWO_PANELS }],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [island] = islands as [RenderedIsland];

  expect(island.html).toBe(
    '<div class="tabs">' +
      slot("0.1", "<p>Two</p>") +
      "</div>" +
      stash("0.0", "<p>One</p>"),
  );
  expect(html).toBe(marker(island, "{&quot;active&quot;:1}"));
});

test("a slot position spelled in rich text does not cost the reader a panel", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Tabs",
        props: { active: 1 },
        children: [
          { component: "Panel", props: { title: "One" } },
          {
            component: "Rich",
            props: {
              body:
                '<span data-fw-slot="0.0">decoy</span>' +
                '<fw-slot data-fw-slot="0.0"><p>decoy</p></fw-slot>',
            },
          },
        ],
      },
    ],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [island] = islands as [RenderedIsland];

  expect(island.html).toBe(
    '<div class="tabs">' +
      slot("0.1", '<div class="rich"><span>decoy</span><p>decoy</p></div>') +
      "</div>" +
      stash("0.0", "<p>One</p>"),
  );
});

test("a slot position spelled inside a longer name is not a copy of anything", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Tabs",
        props: { active: 1 },
        children: [
          { component: "Panel", props: { title: "One" } },
          {
            component: "Rich",
            props: { body: '<span xdata-fw-slot="0.0">decoy</span>' },
          },
        ],
      },
    ],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [island] = islands as [RenderedIsland];

  expect(island.html).toBe(
    '<div class="tabs">' +
      slot(
        "0.1",
        '<div class="rich"><span xdata-fw-slot="0.0">decoy</span></div>',
      ) +
      "</div>" +
      stash("0.0", "<p>One</p>"),
  );
});

const FORGED_TABS = (body: string): readonly EntryNode[] => [
  {
    component: "Forged",
    props: { body },
    children: TWO_PANELS,
  },
];

test("a slot position spelled on another element is not a copy of anything", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: FORGED_TABS('<span data-fw-slot="0.0">decoy</span>'),
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [island] = islands as [RenderedIsland];

  expect(island.html).toBe(
    '<div class="tabs">' +
      '<div class="forged"><span data-fw-slot="0.0">decoy</span></div>' +
      slot("0.1", "<p>Two</p>") +
      "</div>" +
      stash("0.0", "<p>One</p>"),
  );
});

test("a slot position spelled in a text node is not a copy of anything", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: FORGED_TABS('<p>data-fw-slot="0.0"</p>'),
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [island] = islands as [RenderedIsland];

  expect(island.html).toBe(
    '<div class="tabs">' +
      '<div class="forged"><p>data-fw-slot="0.0"</p></div>' +
      slot("0.1", "<p>Two</p>") +
      "</div>" +
      stash("0.0", "<p>One</p>"),
  );
});

test("a nested container's own slot is not a copy of the slot it sits in", async () => {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Tabs",
        props: { active: 1 },
        children: [
          { component: "Panel", props: { title: "One" } },
          {
            component: "Stack",
            children: [{ component: "Panel", props: { title: "Two" } }],
          },
        ],
      },
    ],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [outer, inner] = islands as [RenderedIsland, RenderedIsland];
  expect(inner.html).toBe(
    '<div class="stack">' + slot("0.1.0", "<p>Two</p>") + "</div>",
  );
  expect(outer.html).toBe(
    '<div class="tabs">' +
      slot("0.1", marker(inner, "{}")) +
      "</div>" +
      stash("0.0", "<p>One</p>"),
  );
});

test("an island inside a slot hydrates on its own, not inside its container's pass", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Stack",
        children: [{ component: "Counter", props: { label: "Add" } }],
      },
    ],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  expect(islands.map((island) => island.component)).toEqual([
    "Stack",
    "Counter",
  ]);
  const [container, inner] = islands as [RenderedIsland, RenderedIsland];
  expect(inner.path).toEqual([0, 0]);

  expect(inner.prefix).not.toBe(container.prefix);
  expect(inner.html).toContain(inner.prefix);
  expect(inner.html).not.toContain(container.prefix);

  expect(container.html).toBe(
    '<div class="stack">' +
      slot("0.0", marker(inner, "{&quot;label&quot;:&quot;Add&quot;}")) +
      "</div>",
  );
  expect(html).toBe(marker(container, "{}"));
});

test("an island in a slot the container hid is still in the page", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Tabs",
        props: { active: 1 },
        children: [
          { component: "Counter", props: { label: "Add" } },
          { component: "Panel", props: { title: "Two" } },
        ],
      },
    ],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [container, inner] = islands as [RenderedIsland, RenderedIsland];
  expect(inner.component).toBe("Counter");

  expect(container.html).toBe(
    '<div class="tabs">' +
      slot("0.1", "<p>Two</p>") +
      "</div>" +
      stash("0.0", marker(inner, "{&quot;label&quot;:&quot;Add&quot;}")),
  );
  expect(html).toContain(`data-fw-prefix="${inner.prefix}"`);
});

test("an island whose node has no children emits the HTML it emits today", async () => {
  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Counter", props: { label: "Add" } }],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  const [island] = islands as [RenderedIsland];
  expect(html).toBe(marker(island, "{&quot;label&quot;:&quot;Add&quot;}"));
  expect(island.html).toMatch(
    /^<button class="counter" id="[^"]+">Add<\/button>$/,
  );

  expect(html).not.toContain("fw-slot");
  expect(html).not.toContain("data-fw-template");
});

test("a container's children never travel through the props payload", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Stack", children: TWO_PANELS }],
    registry: REGISTRY,
    modules: CONTAINERS_ARE_CLIENT,
  });

  expect(html).toContain('data-fw-props="{}"');
});

const DUPLICATE_FIX =
  "slotted content is one node of already-rendered HTML that hydration adopts in place, so a second copy has no DOM of its own and the client would move the first one rather than repeat it; render each slotted child at most once";

test("a container that renders one slotted child twice fails naming both components", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [{ component: "Twice", children: TWO_PANELS }],
      registry: REGISTRY,
      modules: CONTAINERS_ARE_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      'Component "Twice": renders slotted child 0 ("Panel") 2 times, and entry /en/home renders it as an island — ' +
        `${DUPLICATE_FIX}`,
    ),
  );
});

test("every duplicated slot is reported, not the first", async () => {
  await expect(
    renderPage({
      page: PAGE,
      tree: [
        { component: "Twice", children: TWO_PANELS },
        {
          component: "Twice",
          children: [
            { component: "Counter", props: { label: "Add" } },
            { component: "Panel", props: { title: "Two" } },
          ],
        },
      ],
      registry: REGISTRY,
      modules: CONTAINERS_ARE_CLIENT,
    }),
  ).rejects.toThrowError(
    new RenderError(
      "Entry /en/home: 2 slotted children are rendered more than once — " +
        `${DUPLICATE_FIX}:\n` +
        '  Twice: child 0 ("Panel"), 2 times\n' +
        '  Twice: child 0 ("Counter"), 2 times',
    ),
  );
});
