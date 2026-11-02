// @vitest-environment jsdom
import { useState } from "react";
import type { ReactNode } from "react";
import { expect, test } from "vitest";
import type { ComponentDefinition } from "@pagedeck/islands";
import { weighIslandProps } from "./budgets.js";
import { clientReference } from "./client-reference.js";
import { renderPage, RenderError } from "./render.js";

const PAGE = { locale: "en", path: "/home" } as const;

function component(module: unknown): ComponentDefinition {
  return { import: async () => ({ default: module }) };
}

function List({
  title,
  items,
  children,
}: {
  title: string;
  items: readonly { id: string; node: ReactNode }[];
  children?: ReactNode;
}) {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h2>{title}</h2>
      <button id="inc" type="button" onClick={() => setCount(count + 1)}>
        {`count ${String(count)}`}
      </button>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.node}</li>
        ))}
      </ul>
      <footer>{children}</footer>
    </section>
  );
}

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button data-nested="" type="button" onClick={() => setCount(count + 1)}>
      {`nested ${String(count)}`}
    </button>
  );
}

const ProxiedList = clientReference(List, { name: "List", mode: "load" });
const ProxiedCounter = clientReference(Counter, {
  name: "Counter",
  mode: "load",
});

function Card({ name, nested }: { name: string; nested: boolean }) {
  return (
    <article data-card={name}>
      <h3>{name}</h3>
      {nested ? <ProxiedCounter /> : null}
    </article>
  );
}

function Wrapper() {
  return (
    <ProxiedList
      title="Cards"
      items={["A", "B"].map((name) => ({
        id: name,
        node: <Card name={name} nested={name === "A"} />,
      }))}
    >
      <p data-children="">server children</p>
    </ProxiedList>
  );
}

async function render(template: () => ReactNode): Promise<string> {
  const { html } = await renderPage({
    page: PAGE,
    template: "Template",
    registry: { Template: component(template) },
  });
  return html;
}

async function refusal(template: () => ReactNode): Promise<Error> {
  const failure = await render(template).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(RenderError);
  return failure as Error;
}

function markerTag(html: string, name: string): string {
  return (
    new RegExp(`<pagedeck-island[^>]*data-pagedeck-component="${name}"[^>]*>`).exec(
      html,
    )?.[0] ?? ""
  );
}

test("a proxied island's marker lists each prop slot's path and carries null at each", async () => {
  const list = markerTag(await render(Wrapper), "List");

  expect(list).toContain(
    'data-pagedeck-slot-paths="[[&quot;items&quot;,0,&quot;node&quot;],[&quot;items&quot;,1,&quot;node&quot;],[&quot;children&quot;]]"',
  );
  expect(list).toContain(
    'data-pagedeck-props="{&quot;title&quot;:&quot;Cards&quot;,&quot;items&quot;:[{&quot;id&quot;:&quot;A&quot;,&quot;node&quot;:null},{&quot;id&quot;:&quot;B&quot;,&quot;node&quot;:null}],&quot;children&quot;:null}"',
  );
});

test("each placed prop slot renders in its own boundary, opened by its region mark", async () => {
  const html = await render(Wrapper);

  expect(html).toContain(
    '<li><!--$--><template data-pagedeck-region="0"></template><article data-card="A">',
  );
  expect(html).toContain(
    '<li><!--$--><template data-pagedeck-region="1"></template><article data-card="B"><h3>B</h3></article><!--/$--></li>',
  );
  expect(html).toContain(
    '<footer><!--$--><template data-pagedeck-region="2"></template><p data-children="">server children</p><!--/$--></footer>',
  );
  expect(html).not.toContain("<!--$?-->");
});

test("a client component inside a prop slot is an island of its own", async () => {
  const html = await render(Wrapper);

  const counter = markerTag(html, "Counter");
  expect(counter).not.toBe("");
  expect(html).toMatch(
    /<article data-card="A"><h3>A<\/h3><pagedeck-island[^>]*data-pagedeck-component="Counter"[^>]*><button data-nested="" type="button">nested 0<\/button><\/pagedeck-island><\/article>/,
  );
});

test("a proxied island given no element has no path list", async () => {
  function Template() {
    return <ProxiedList title="Empty" items={[]} />;
  }

  const html = await render(Template);
  expect(markerTag(html, "List")).not.toContain("data-pagedeck-slot-paths");
});

test("a prop slot the island does not place is refused, naming the component and the path", async () => {
  function Hidden({ aside }: { aside?: ReactNode }) {
    return <p>{aside === undefined ? "none" : "hidden"}</p>;
  }
  const ProxiedHidden = clientReference(Hidden, { name: "Hidden", mode: "load" });
  function Template() {
    return <ProxiedHidden aside={<span>later</span>} />;
  }

  expect((await refusal(Template)).message).toBe(
    'Component "Hidden": prop "aside" is an element the component does not render on the server, and "Template" renders it in entry /en/home — a prop slot reaches the browser only as the HTML its region rendered, so render the element in the component\'s server output, or pass it only when the component shows it',
  );
});

test("an element inside a Map is refused, naming the path and the fix", async () => {
  function Template() {
    return <ProxiedList title="Map" items={[]} {...{ lookup: new Map([["a", <i key="a" />]]) }} />;
  }

  expect((await refusal(Template)).message).toBe(
    'Component "List": prop "lookup" is a Map holding a React element, and "Template" renders it in entry /en/home — a prop slot is found only in plain objects and arrays, and serializing any other container would drop the element silently, so move the element into a plain object or array',
  );
});

test("an element inside a class instance is refused, naming the path and the fix", async () => {
  class Holder {
    constructor(readonly node: ReactNode) {}
  }
  function Template() {
    return (
      <ProxiedList title="Class" items={[]} {...{ extra: { holder: new Holder(<i />) } }} />
    );
  }

  expect((await refusal(Template)).message).toBe(
    'Component "List": prop "extra.holder" is a class instance holding a React element, and "Template" renders it in entry /en/home — a prop slot is found only in plain objects and arrays, and serializing any other container would drop the element silently, so move the element into a plain object or array',
  );
});

test("a circular prop beside a prop slot fails with the JSON refusal, not a stack overflow", async () => {
  const circular: { self?: unknown; node?: ReactNode } = { node: <i /> };
  circular.self = circular;
  function Template() {
    return <ProxiedList title="Loop" items={[]} {...{ circular }} />;
  }

  const failure = await refusal(Template);
  expect(failure.message).toBe(
    'Component "List": its props do not serialize to JSON, and "Template" renders it in entry /en/home — a hydration marker carries each instance\'s own props inline, so give it props that are JSON',
  );
  expect(failure.cause).toBeInstanceOf(TypeError);
});

test("a prop slot past depth 32 fails with the depth refusal, not a stack overflow", async () => {
  let deep: Record<string, unknown> = { node: <i /> };
  for (let level = 0; level < 10_000; level++) deep = { next: deep };
  function Template() {
    return <ProxiedList title="Deep" items={[]} {...{ deep }} />;
  }

  expect((await refusal(Template)).message).toMatch(
    /^Component "List": prop "deep(\.next){32}" is nested more than 32 levels deep, and "Template" renders it in entry \/en\/home — /,
  );
});

test("an element counts toward islandPropsBudget only as its null placeholder", async () => {
  function Template() {
    return (
      <ProxiedList title="T" items={[]}>
        <p>{"x".repeat(5_000)}</p>
      </ProxiedList>
    );
  }

  const weighed = weighIslandProps(await render(Template), 0);
  expect(weighed.breaches.map((island) => island.bytes)).toEqual([
    '{"title":"T","items":[],"children":null}'.length,
  ]);
});
