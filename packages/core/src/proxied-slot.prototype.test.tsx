// @vitest-environment jsdom
// PROTOTYPE (#240): throwaway, never merges. One proxied slot end to end: a
// server wrapper hands a "use client" component `children`, `items[n].node`
// and an unplaced `aside`; `pagedeck build` writes the page; the runtime
// hydrates it in jsdom.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { act } from "react";
import type { ComponentType } from "react";
import { afterAll, expect, test } from "vitest";
import { hydrateIslands } from "@pagedeck/islands/runtime";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface El {
  innerHTML: string;
  outerHTML: string;
  textContent: string | null;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): Iterable<El>;
  getAttribute(name: string): string | null;
  dispatchEvent(event: unknown): boolean;
}
declare const document: { body: El };
declare const window: { MouseEvent: new (type: string, init: object) => unknown };

const execFileAsync = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-proxied-slot");

const FILES: Readonly<Record<string, string>> = {
  "components/List.tsx": `"use client";
import { useState } from "react";
import type { ReactNode } from "react";

export default function List({ title, items, aside, children }: {
  title: string;
  items: { id: string; node: ReactNode }[];
  aside: ReactNode;
  children?: ReactNode;
}) {
  const [count, setCount] = useState(0);
  const [reversed, setReversed] = useState(false);
  const [showAside, setShowAside] = useState(false);
  const list = reversed ? [...items].reverse() : items;
  return (
    <section>
      <h2>{title}</h2>
      <button id="inc" type="button" onClick={() => setCount((n) => n + 1)}>{"count " + String(count)}</button>
      <button id="rev" type="button" onClick={() => setReversed((r) => !r)}>reverse</button>
      <button id="show-aside" type="button" onClick={() => setShowAside((s) => !s)}>aside</button>
      <ul>{list.map((item) => <li key={item.id}>{item.node}</li>)}</ul>
      {showAside ? <aside>{aside}</aside> : null}
      <footer>{children}</footer>
    </section>
  );
}
`,
  "components/Cloner.tsx": `"use client";
import { cloneElement, useState } from "react";
import type { ReactElement } from "react";

export default function Cloner({ children }: { children: ReactElement }) {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button id="clone-inc" type="button" onClick={() => setCount((n) => n + 1)}>{"clones " + String(count)}</button>
      {cloneElement(children)}
    </div>
  );
}
`,
  "components/Counter.tsx": `"use client";
import { useState } from "react";

export default function Counter() {
  const [n, setN] = useState(0);
  return <button data-nested="" type="button" onClick={() => setN(n + 1)}>{"nested " + String(n)}</button>;
}
`,
  "components/Card.tsx": `import Counter from "./Counter.tsx";

export default function Card({ name, nested }: { name: string; nested: boolean }) {
  return (
    <article data-card={name}>
      <h3>{name}</h3>
      <p>server text {name}</p>
      {nested ? <Counter /> : null}
    </article>
  );
}
`,
  "components/Wrapper.tsx": `import Card from "./Card.tsx";
import List from "./List.tsx";

export default function Wrapper() {
  return (
    <List
      title="Cards"
      items={["A", "B", "C"].map((name) => ({ id: name, node: <Card name={name} nested={name === "A"} /> }))}
      aside={<p data-aside="">server aside</p>}
    >
      <p data-children="">server children</p>
    </List>
  );
}
`,
  "components/Page.tsx": `import Cloner from "./Cloner.tsx";
import Wrapper from "./Wrapper.tsx";

export default function Page() {
  return (
    <div>
      <Wrapper />
      <Cloner><p data-cloned="">cloned child</p></Cloner>
    </div>
  );
}
`,
  "content/en/index.json": `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`,
  "pagedeck.config.ts": `
import { defineConfig, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages)],
    components: {
      page: "./components/Page.tsx",
      list: { path: "./components/List.tsx", hydrate: "load" },
      cloner: { path: "./components/Cloner.tsx", hydrate: "load" },
      counter: { path: "./components/Counter.tsx", hydrate: "load" },
    },
    content: () => ({ tree: [{ component: "page" }] }),
  },
});
`,
};

afterAll(() => {
  if (process.env.PAGEDECK_PROTOTYPE_KEEP === undefined) {
    rmSync(SITE, { recursive: true, force: true });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

const MODULES: Record<string, string> = {
  list: "List",
  cloner: "Cloner",
  counter: "Counter",
};

async function resolve(name: string): Promise<ComponentType<never>> {
  const file = join(SITE, "components", `${MODULES[name] ?? name}.tsx`);
  return ((await import(/* @vite-ignore */ file)) as { default: ComponentType<never> }).default;
}

const $ = (selector: string): El => {
  const found = document.body.querySelector(selector);
  if (found === null) throw new Error(`no ${selector}`);
  return found;
};
const click = (selector: string) =>
  act(async () => {
    $(selector).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
const order = () =>
  [...document.body.querySelectorAll("[data-card]")].map((e) => e.getAttribute("data-card")).join("");

test("a proxied slot builds, hydrates around its server HTML, and survives the island's re-renders", async () => {
  rmSync(SITE, { recursive: true, force: true });
  for (const [file, contents] of Object.entries(FILES)) {
    mkdirSync(dirname(join(SITE, file)), { recursive: true });
    writeFileSync(join(SITE, file), contents);
  }
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });

  const html = readFileSync(join(SITE, "site", "index.html"), "utf8");
  const body = (/<body[^>]*>([\s\S]*)<\/body>/.exec(html) as RegExpExecArray)[1] as string;
  const list = /<pagedeck-island[^>]*data-pagedeck-component="list"[^>]*>/.exec(body)?.[0] ?? "";
  if (process.env.PAGEDECK_PROTOTYPE_KEEP !== undefined) console.log(body);

  // Build side: the paths on the marker, `null` at each in the JSON props, a
  // region per placed slot, a stash for the one the island did not place.
  expect(list).toContain(
    'data-pagedeck-slots="[[&quot;items&quot;,0,&quot;node&quot;],[&quot;items&quot;,1,&quot;node&quot;],[&quot;items&quot;,2,&quot;node&quot;],[&quot;aside&quot;],[&quot;children&quot;]]"',
  );
  expect(list).toContain("&quot;aside&quot;:null,&quot;children&quot;:null");
  expect(body).toContain('<li><!--$--><template data-pagedeck-region="0"></template><article data-card="A">');
  expect(body).toContain('<template data-pagedeck-region-stash="3">&lt;p data-aside="">server aside&lt;/p></template>');
  expect(body).not.toContain("<!--$?-->");
  expect(body).toContain('data-pagedeck-component="counter"');

  // Client side.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(String(args[0]).split("\n")[0] as string);
  };
  try {
    document.body.innerHTML = body;
    const listMarker = $('[data-pagedeck-component="list"]');
    const serverInner = listMarker.innerHTML.replace(/<template data-pagedeck-region-stash[\s\S]*?<\/template>/, "");
    const cardA = $('[data-card="A"]');
    const children = $("[data-children]");
    const cloned = $("[data-cloned]");

    await act(async () => {
      hydrateIslands({ resolve });
    });
    await act(async () => new Promise((done) => setTimeout(done, 50)));

    expect(listMarker.getAttribute("data-pagedeck-hydrated")).toBe("");
    expect(listMarker.innerHTML.replaceAll(' data-pagedeck-hydrated=""', "")).toBe(serverInner);
    expect($('[data-card="A"]')).toBe(cardA);
    expect($("[data-children]")).toBe(children);

    await click("#inc");
    expect($("#inc").textContent).toBe("count 1");
    expect($('[data-card="A"]')).toBe(cardA);
    expect($("[data-children]")).toBe(children);

    // The island inside a region is a root of its own.
    await click("[data-nested]");
    expect($("[data-nested]").textContent).toBe("nested 1");

    // Each region sits in a keyed <li>, so it moves with it.
    await click("#rev");
    expect(order()).toBe("CBA");
    expect($('[data-card="A"]')).toBe(cardA);
    await click("[data-nested]");
    expect($("[data-nested]").textContent).toBe("nested 2");

    // The unplaced slot, placed after hydration: the stand-in's fallback
    // carries the stashed HTML.
    await click("#show-aside");
    expect($("aside").innerHTML).toBe(
      '<pagedeck-slot style="display: contents;"><p data-aside="">server aside</p></pagedeck-slot>',
    );

    await click("#inc");
    expect($("#inc").textContent).toBe("count 2");
    expect($('[data-card="A"]')).toBe(cardA);
    expect(order()).toBe("CBA");

    // cloneElement: a new props object on the dehydrated boundary. React
    // drops the server DOM; the fallback brings the HTML back as new DOM.
    expect($("[data-cloned]")).toBe(cloned);
    await click("#clone-inc");
    expect($("#clone-inc").textContent).toBe("clones 1");
    const after = $("[data-cloned]");
    expect(after).not.toBe(cloned);
    expect(after.textContent).toBe("cloned child");
    expect($('[data-pagedeck-component="cloner"] div').innerHTML).toContain(
      '<pagedeck-slot style="display: contents;"><p data-cloned="">cloned child</p></pagedeck-slot>',
    );

    expect(errors).toEqual([]);
  } finally {
    console.error = consoleError;
  }
}, 180_000);
