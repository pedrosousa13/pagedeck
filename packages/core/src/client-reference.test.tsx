import { Suspense, use, useId } from "react";
import type { ReactNode } from "react";
import { prerender } from "react-dom/static";
import { expect, test } from "vitest";
import { RegistryError } from "@pagedeck/islands";
import type { ComponentDefinition, ComponentRegistry } from "@pagedeck/islands";
import { clientReference } from "./client-reference.js";
import { renderPage, RenderError, useBuildData } from "./render.js";
import type { EntryNode } from "./render.js";

function component(module: unknown): ComponentDefinition {
  return { import: async () => ({ default: module }) };
}

const PAGE = { locale: "en", path: "/home" } as const;

function Counter({ label }: { label?: string; onPress?: () => void }) {
  const id = useId();
  return (
    <button type="button" id={id}>
      {label ?? "count"}
    </button>
  );
}

function Toggle({ on }: { on?: boolean; ref?: unknown }) {
  const id = useId();
  return <input id={id} type="checkbox" defaultChecked={on ?? false} />;
}

function Chart({ series }: { series?: unknown }) {
  return <figure>{typeof series}</figure>;
}

function Accordion({ children }: { children?: ReactNode }) {
  return <details>{children}</details>;
}

const ProxiedCounter = clientReference(Counter, {
  name: "Counter",
  mode: "load",
});
const ProxiedToggle = clientReference(Toggle, { name: "Toggle", mode: "idle" });
const ProxiedChart = clientReference(Chart, { name: "Chart", mode: "visible" });
const ProxiedAccordion = clientReference(Accordion, {
  name: "Accordion",
  mode: "load",
});

function prefixes(html: string): string[] {
  return [...html.matchAll(/data-fw-prefix="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}

function ids(html: string): string[] {
  return [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1] as string);
}

test("two proxied instances on one page get distinct prefixes", async () => {
  function Template({ title }: { title: string }) {
    return (
      <main>
        <h1>{title}</h1>
        <ProxiedCounter label="left" />
        <ProxiedCounter label="right" />
      </main>
    );
  }

  const { html, islands } = await renderPage({
    page: PAGE,
    template: "Template",
    props: { title: "Home" },
    registry: { Template: component(Template) },
  });

  expect(islands).toHaveLength(2);
  const seen = prefixes(html);
  expect(seen).toHaveLength(2);
  expect(new Set(seen).size).toBe(2);
  expect(seen).toEqual(islands.map((island) => island.prefix));
});

test("two proxied instances put non-colliding useId values in the page", async () => {
  function Template() {
    return (
      <main>
        <ProxiedCounter label="left" />
        <ProxiedToggle on />
      </main>
    );
  }

  const { html } = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  });

  const seen = ids(html);
  expect(seen).toHaveLength(2);
  expect(new Set(seen).size).toBe(2);
  for (const [at, prefix] of prefixes(html).entries()) {
    expect(seen[at]).toContain(prefix);
  }
});

test("a suspending sibling below a proxy leaves its prefix and the island count unchanged", async () => {
  function Tabs({ children }: { children?: ReactNode }) {
    return <div className="tabs">{children}</div>;
  }

  function Panel({ children }: { children?: ReactNode }) {
    return (
      <section>
        <ProxiedCounter label="inside" />
        {children}
      </section>
    );
  }

  function Reader() {
    const stats = useBuildData<{ users: number }>("stats");
    return <p>{stats.users}</p>;
  }

  function Quiet() {
    return <p>quiet</p>;
  }

  const tree = (below: string): readonly EntryNode[] => [
    {
      component: "Tabs",
      children: [
        { component: "Panel", children: [{ component: below }] },
      ],
    },
  ];

  const registry = {
    Tabs: { ...component(Tabs), hydrate: "load" },
    Panel: component(Panel),
    Reader: component(Reader),
    Quiet: component(Quiet),
  } satisfies ComponentRegistry;

  const settled = await renderPage({
    page: PAGE,
    tree: tree("Quiet"),
    registry,
    data: { stats: { users: 7 } },
  });
  const suspending = await renderPage({
    page: PAGE,
    tree: tree("Reader"),
    registry,
    data: { stats: { users: 7 } },
  });

  const counterPrefix = (page: { islands: readonly { component: string; prefix: string }[] }) =>
    page.islands.find((island) => island.component === "Counter")?.prefix;

  expect(counterPrefix(suspending)).toBe(counterPrefix(settled));
  expect(counterPrefix(settled)).toBeDefined();
  expect(suspending.islands).toHaveLength(settled.islands.length);
  expect(settled.islands).toHaveLength(2);
});

test("two renders of a page holding proxies produce byte-identical HTML", async () => {
  function Template() {
    return (
      <main>
        <ProxiedCounter label="a" />
        <ProxiedToggle />
      </main>
    );
  }
  const input = {
    page: PAGE,
    template: "Template" as const,
    registry: { Template: component(Template) },
  };

  const first = await renderPage(input);
  const second = await renderPage(input);
  expect(second.html).toBe(first.html);
  expect(second.islands).toEqual(first.islands);
});

test("a proxy inside a container's slotted child lands in that slot's HTML", async () => {
  function Tabs({ children }: { children?: ReactNode }) {
    return <div className="tabs">{children}</div>;
  }
  function Panel() {
    return (
      <section>
        <ProxiedCounter label="inside" />
      </section>
    );
  }

  const { html, islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Tabs", children: [{ component: "Panel" }] }],
    registry: {
      Tabs: { ...component(Tabs), hydrate: "load" },
      Panel: component(Panel),
    },
  });

  const names = islands.map((island) => island.component);
  expect(names).toContain("Counter");
  expect(names).toContain("Tabs");
  const counter = islands.find((island) => island.component === "Counter");
  expect(counter?.path).toBeUndefined();
  expect(html).toContain(`data-fw-prefix="${counter?.prefix ?? ""}"`);
  const tabs = islands.find((island) => island.component === "Tabs");
  expect(tabs?.html).toContain(`data-fw-prefix="${counter?.prefix ?? ""}"`);
});

test("a function prop on a proxied instance names the component, its parent and the entry", async () => {
  function Template() {
    return <ProxiedCounter label="ok" onPress={() => undefined} />;
  }

  await expect(
    renderPage({
      page: PAGE,
      template: "Template",
      registry: { Template: component(Template) },
    }),
  ).rejects.toThrow(
    /Component "Counter": prop "onPress" is a function, and "Template" renders it in entry \/en\/home/,
  );
});

test("two refused props on two proxied instances are reported in one throw", async () => {
  function Template() {
    return (
      <main>
        <ProxiedCounter onPress={() => undefined} />
        <ProxiedToggle ref={{ current: null }} />
      </main>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  const message = (failure as Error).message;
  expect(message).toContain("2 props");
  expect(message).toContain("Counter");
  expect(message).toContain("Toggle");
  expect(message).toContain("Template");
});

test("a circular prop on a proxied instance names the component and its parent", async () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;

  function Template() {
    return <ProxiedChart series={circular} />;
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  expect((failure as Error).message).toBe(
    'Component "Chart": its props do not serialize to JSON, and "Template" renders it in entry /en/home — a hydration marker carries each instance\'s own props inline, so give it props that are JSON',
  );
  expect((failure as Error).cause).toBeInstanceOf(TypeError);
});

test("a proxied instance with JSON props builds", async () => {
  function Template() {
    return <ProxiedCounter label="fine" />;
  }
  const { html, islands } = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  });
  expect(islands).toHaveLength(1);
  expect(html).toContain('data-fw-props="{&quot;label&quot;:&quot;fine&quot;}"');
});

test("a proxied instance given JSX children is refused, naming both components", async () => {
  function Template() {
    return (
      <ProxiedAccordion>
        <span>child</span>
      </ProxiedAccordion>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  const message = (failure as Error).message;
  expect(message).toContain('Component "Accordion"');
  expect(message).toContain("Template");
  expect(message).toContain("/en/home");
  expect(message).toContain("use client");
});

test("a proxied instance given an empty array as children builds", async () => {
  function Template() {
    return <ProxiedAccordion>{[]}</ProxiedAccordion>;
  }

  const { islands } = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  });

  expect(islands.map((island) => island.component)).toEqual(["Accordion"]);
});

test("a proxied instance given null as children builds", async () => {
  function Template() {
    return <ProxiedAccordion>{null}</ProxiedAccordion>;
  }

  const { islands } = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  });

  expect(islands.map((island) => island.component)).toEqual(["Accordion"]);
});

test("a refused prop and a refused child are reported in one throw", async () => {
  function Template() {
    return (
      <main>
        <ProxiedCounter onPress={() => undefined} />
        <ProxiedAccordion>
          <span>child</span>
        </ProxiedAccordion>
      </main>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  const message = (failure as Error).message;
  expect(message).toContain(
    "Entry /en/home: the framework refuses 1 prop on client components",
  );
  expect(message).toContain(
    "Entry /en/home: 1 client component is given JSX children",
  );
  expect(message).toContain("  Counter, rendered by Template: onPress");
  expect(message).toContain("  Accordion, rendered by Template");
});

test("an entry node with entry children still slots rather than being refused", async () => {
  function Tabs({ children }: { children?: ReactNode }) {
    return <div className="tabs">{children}</div>;
  }
  function Panel() {
    return <p>panel</p>;
  }

  const { islands } = await renderPage({
    page: PAGE,
    tree: [{ component: "Tabs", children: [{ component: "Panel" }] }],
    registry: {
      Tabs: { ...component(Tabs), hydrate: "load" },
      Panel: component(Panel),
    },
  });

  expect(islands).toHaveLength(1);
  expect(islands[0]?.html).toContain('data-fw-slot="0.0"');
});

const ProxiedStatic = clientReference(Counter, {
  name: "Static",
  mode: "none",
});

test("a proxied instance registered hydrate: none is refused, naming both sides", async () => {
  function Template() {
    return (
      <main>
        <ProxiedStatic label="left" />
      </main>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RegistryError);
  expect((failure as Error).message).toBe(
    'Component "Static": its module carries "use client" but the registry declares hydrate: "none", and "Template" renders it in entry /en/home — a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module',
  );
});

test("one contradicted component rendered twice is reported once", async () => {
  function Template() {
    return (
      <main>
        <ProxiedStatic label="left" />
        <ProxiedStatic label="right" />
      </main>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect((failure as Error).message).toContain('Component "Static"');
  expect((failure as Error).message).not.toContain("2 client components");
});

const ProxiedFrozen = clientReference(Toggle, { name: "Frozen", mode: "none" });

const ProxiedPanel = clientReference(
  function Panel() {
    return (
      <section>
        <ProxiedStatic label="inner" />
      </section>
    );
  },
  { name: "Panel", mode: "load" },
);

test("one contradicted component rendered from two parents names both, once", async () => {
  function Template() {
    return (
      <main>
        <ProxiedStatic label="outer" />
        <ProxiedPanel />
      </main>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RegistryError);
  expect((failure as Error).message).toBe(
    'Component "Static": its module carries "use client" but the registry declares hydrate: "none", and "Template" and "Panel" render it in entry /en/home — a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module',
  );
});

test("two contradicted components count as two however many parents render them", async () => {
  function Template() {
    return (
      <main>
        <ProxiedStatic label="outer" />
        <ProxiedFrozen />
        <ProxiedPanel />
      </main>
    );
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(Template) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RegistryError);
  expect((failure as Error).message).toBe(
    [
      'Entry /en/home: 2 client components carry "use client" but are registered hydrate: "none" — a client component cannot be static, so drop the hydrate: "none", or drop the directive from the module:',
      "  Static, rendered by Template and Panel",
      "  Frozen, rendered by Template",
    ].join("\n"),
  );
});

test("a nested React root stops dead the moment its tree needs the event loop", async () => {
  let nested: Promise<string> | undefined;

  function Slow() {
    return (
      <p>{use(new Promise<string>((done) => setTimeout(() => { done("slow"); }, 0)))}</p>
    );
  }

  function Nested() {
    nested ??= (async () => {
      const { prelude } = await prerender(<Slow />);
      const decoder = new TextDecoder();
      let out = "";
      for await (const chunk of prelude as AsyncIterable<Uint8Array>) {
        out += decoder.decode(chunk, { stream: true });
      }
      return out + decoder.decode();
    })();
    return <div>{use(nested)}</div>;
  }

  const failure = await renderPage({
    page: PAGE,
    template: "Nested",
    registry: { Nested: component(Nested) },
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(RenderError);
  const message = (failure as Error).message;
  expect(message).toContain("suspended on data the framework did not resolve");
  expect(message).toContain('Component "Nested"');
  expect(message).not.toContain("Slow");
});

test("Suspense inside the nested root does not give it the turn it needs", async () => {
  let nested: Promise<string> | undefined;

  function Slow() {
    return (
      <p>{use(new Promise<string>((done) => setTimeout(() => { done("slow"); }, 0)))}</p>
    );
  }

  function Inner() {
    nested ??= prerender(
      <Suspense fallback={<i>waiting</i>}>
        <Slow />
      </Suspense>,
    ).then(() => "done");
    return <div>{use(nested)}</div>;
  }

  await expect(
    renderPage({
      page: PAGE,
      template: "Inner",
      registry: { Inner: component(Inner) },
    }),
  ).rejects.toThrow(/suspended on data the framework did not resolve/);
});
