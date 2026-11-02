// @vitest-environment jsdom
import { act, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { ComponentDefinition } from "@pagedeck/islands";
import { hydrateIslands } from "@pagedeck/islands/runtime";
import { weighIslandProps } from "./budgets.js";
import { clientReference } from "./client-reference.js";
import { renderPage, RenderError } from "./render.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): Iterable<TestElement>;
  click(): void;
}
declare const document: { body: TestElement };

// Hoisted: React reads `reportError` once, when `react-dom/client` first loads.
const reported: string[] = vi.hoisted(() => {
  const lines: string[] = [];
  (globalThis as { reportError?: (error: unknown) => void }).reportError = (
    error,
  ) => {
    lines.push(String(error));
  };
  return lines;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  reported.length = 0;
  vi.restoreAllMocks();
});

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
  const [reversed, setReversed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const shown = reversed ? [...items].reverse() : items;
  return (
    <section>
      <h2>{title}</h2>
      <button id="inc" type="button" onClick={() => setCount(count + 1)}>
        {`count ${String(count)}`}
      </button>
      <button id="reverse" type="button" onClick={() => setReversed(!reversed)}>
        reverse
      </button>
      <button id="collapse" type="button" onClick={() => setCollapsed(!collapsed)}>
        collapse
      </button>
      {collapsed ? null : (
        <ul>
          {shown.map((item) => (
            <li key={item.id}>{item.node}</li>
          ))}
        </ul>
      )}
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

test("two JSX children are two prop slots, rendered without a key warning", async () => {
  const complaints: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
  });
  function Template() {
    return (
      <ProxiedList title="Two" items={[]}>
        <p>one</p>
        <p>two</p>
      </ProxiedList>
    );
  }

  const html = await render(Template);
  expect(markerTag(html, "List")).toContain(
    'data-pagedeck-slot-paths="[[&quot;children&quot;,0],[&quot;children&quot;,1]]"',
  );
  expect(html).toContain(
    '<footer><!--$--><template data-pagedeck-region="0"></template><p>one</p><!--/$--><!--$--><template data-pagedeck-region="1"></template><p>two</p><!--/$--></footer>',
  );
  expect(complaints).toEqual([]);
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

test("a prop slot the island renders twice is refused, naming the component and the path", async () => {
  function Twice({ children }: { children?: ReactNode }) {
    return (
      <div>
        {children}
        {children}
      </div>
    );
  }
  const ProxiedTwice = clientReference(Twice, { name: "Twice", mode: "load" });
  function Template() {
    return (
      <ProxiedTwice>
        <span>once</span>
      </ProxiedTwice>
    );
  }

  expect((await refusal(Template)).message).toBe(
    'Component "Twice": prop "children" is an element the component renders in more than one place, and "Template" renders it in entry /en/home — a prop slot has one region of server HTML and the browser keeps it where it is, so render the element once',
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

const MODULES: Readonly<Record<string, ComponentType<never>>> = {
  List: List as ComponentType<never>,
  Counter: Counter as ComponentType<never>,
};

function $(selector: string): TestElement {
  const found = document.body.querySelector(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    $(selector).click();
  });
}

function order(): string {
  return [...document.body.querySelectorAll("[data-card]")]
    .map((card) => card.getAttribute("data-card"))
    .join("");
}

const withoutHydratedMark = (html: string): string =>
  html.replaceAll(' data-pagedeck-hydrated=""', "");

async function hydrate(
  resolve: (name: string) => Promise<ComponentType<never>> = async (name) =>
    MODULES[name] as ComponentType<never>,
): Promise<string[]> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const complaints: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
  });
  await act(async () => {
    hydrateIslands({ resolve });
  });
  return complaints;
}

test("a proxied island hydrates around its prop slots and keeps their server DOM", async () => {
  document.body.innerHTML = await render(Wrapper);
  const list = $('[data-pagedeck-component="List"]');
  const serverHtml = list.innerHTML;
  const cardA = $('[data-card="A"]');
  const children = $("[data-children]");

  const complaints = await hydrate();

  expect(list.getAttribute("data-pagedeck-hydrated")).toBe("");
  expect(withoutHydratedMark(list.innerHTML)).toBe(serverHtml);
  expect($('[data-card="A"]')).toBe(cardA);
  expect($("[data-children]")).toBe(children);

  await click("#inc");
  await click("#inc");
  expect($("#inc").textContent).toBe("count 2");
  expect($('[data-card="A"]')).toBe(cardA);
  expect($("[data-children]")).toBe(children);

  await click("[data-nested]");
  expect($("[data-nested]").textContent).toBe("nested 1");

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

test("a keyed reverse moves each prop slot's region with its nodes", async () => {
  document.body.innerHTML = await render(Wrapper);
  const cardA = $('[data-card="A"]');
  const cardB = $('[data-card="B"]');

  const complaints = await hydrate();
  await click("#reverse");

  expect(order()).toBe("BA");
  expect($('[data-card="A"]')).toBe(cardA);
  expect($('[data-card="B"]')).toBe(cardB);
  await click("[data-nested]");
  expect($("[data-nested]").textContent).toBe("nested 1");
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

test("a prop slot's HTML is read before any island mounts, so a nested island's state stays out of it", async () => {
  document.body.innerHTML = await render(Wrapper);
  let release = (): void => {};
  const listMayMount = new Promise<void>((resolve) => {
    release = resolve;
  });

  await hydrate(async (name) => {
    if (name === "List") await listMayMount;
    return MODULES[name] as ComponentType<never>;
  });
  await click("[data-nested]");
  expect($("[data-nested]").textContent).toBe("nested 1");
  await act(async () => {
    release();
  });

  await click("#collapse");
  await click("#collapse");

  const restored = $('[data-card="A"]');
  expect(restored.textContent).toBe("Anested 0");
  expect(restored.innerHTML).not.toContain("data-pagedeck-hydrated");
});

function BareList({ items }: { items: readonly { id: string; node: ReactNode }[] }) {
  const [reversed, setReversed] = useState(false);
  return (
    <section>
      <button id="reverse" type="button" onClick={() => setReversed(!reversed)}>
        reverse
      </button>
      <div>{(reversed ? [...items].reverse() : items).map((item) => item.node)}</div>
    </section>
  );
}

const ProxiedBareList = clientReference(BareList, { name: "BareList", mode: "load" });

test("bare sibling regions with no wrapper key keep server order on a reverse, silently", async () => {
  function Template() {
    return (
      <ProxiedBareList
        items={["A", "B"].map((name) => ({ id: name, node: <Card name={name} nested={false} /> }))}
      />
    );
  }
  document.body.innerHTML = await render(Template);
  const cardA = $('[data-card="A"]');
  const cardB = $('[data-card="B"]');

  const complaints = await hydrate(async () => BareList as ComponentType<never>);
  await click("#reverse");

  expect(order()).toBe("AB");
  expect($('[data-card="A"]')).toBe(cardA);
  expect($('[data-card="B"]')).toBe(cardB);
  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
});

test("a prop slot's key cannot collide with a key the island gives its own sibling", async () => {
  function Pair({ children }: { children?: ReactNode }) {
    return <div>{[<i key="0">own</i>, children]}</div>;
  }
  const ProxiedPair = clientReference(Pair, { name: "Pair", mode: "load" });
  const complaints: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
  });
  function Template() {
    return (
      <ProxiedPair>
        <p data-children="">slot</p>
      </ProxiedPair>
    );
  }
  document.body.innerHTML = await render(Template);
  expect(complaints.filter((line) => line.includes("same key"))).toEqual([]);
  const slot = $("[data-children]");

  const hydrating = await hydrate(async () => Pair as ComponentType<never>);

  expect(hydrating.filter((line) => line.includes("same key"))).toEqual([]);
  expect($("[data-children]")).toBe(slot);
});
