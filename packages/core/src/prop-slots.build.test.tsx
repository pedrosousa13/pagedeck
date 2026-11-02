// @vitest-environment jsdom
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { act } from "react";
import type { ComponentType } from "react";
import { afterAll, expect, test, vi } from "vitest";
import { hydrateIslands } from "@pagedeck/islands/runtime";

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

const execFileAsync = promisify(execFile);
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const SITE = join(
  import.meta.dirname,
  "..",
  ".pagedeck-build-test-prop-slots",
);

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
  const shown = reversed ? [...items].reverse() : items;
  return (
    <section>
      <h2>{title}</h2>
      <button id="inc" type="button" onClick={() => setCount(count + 1)}>{"count " + String(count)}</button>
      <button id="reverse" type="button" onClick={() => setReversed(!reversed)}>reverse</button>
      <button id="show-aside" type="button" onClick={() => setShowAside(true)}>aside</button>
      <ul>{shown.map((item) => <li key={item.id}>{item.node}</li>)}</ul>
      {showAside ? <aside>{aside}</aside> : null}
      <footer>{children}</footer>
    </section>
  );
}
`,
  "components/Counter.tsx": `"use client";
import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button data-nested="" type="button" onClick={() => setCount(count + 1)}>{"nested " + String(count)}</button>;
}
`,
  "components/Card.tsx": `import Counter from "./Counter.tsx";

export default function Card({ name, nested }: { name: string; nested: boolean }) {
  return (
    <article data-card={name}>
      <h3>{name}</h3>
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
      items={["A", "B"].map((name) => ({ id: name, node: <Card name={name} nested={name === "A"} /> }))}
      aside={<p data-aside="">server aside</p>}
    >
      <p data-children="">server children</p>
    </List>
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
      wrapper: "./components/Wrapper.tsx",
      list: { path: "./components/List.tsx", hydrate: "load" },
      counter: { path: "./components/Counter.tsx", hydrate: "load" },
    },
    content: () => ({ tree: [{ component: "wrapper" }] }),
  },
});
`,
};

const MODULES: Readonly<Record<string, string>> = {
  list: "List",
  counter: "Counter",
};

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

async function resolve(name: string): Promise<ComponentType<never>> {
  const file = join(SITE, "components", `${MODULES[name] ?? name}.tsx`);
  const module = (await import(/* @vite-ignore */ file)) as {
    default: ComponentType<never>;
  };
  return module.default;
}

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

const order = (): string =>
  [...document.body.querySelectorAll("[data-card]")]
    .map((card) => card.getAttribute("data-card"))
    .join("");

test("pagedeck build writes prop slots that hydrate in place, and an unplaced one shows its server HTML once placed", async () => {
  rmSync(SITE, { recursive: true, force: true });
  for (const [file, contents] of Object.entries(FILES)) {
    mkdirSync(dirname(join(SITE, file)), { recursive: true });
    writeFileSync(join(SITE, file), contents);
  }
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });

  const html = readFileSync(join(SITE, "site", "index.html"), "utf8");
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  expect(body).toContain(
    'data-pagedeck-slot-paths="[[&quot;items&quot;,0,&quot;node&quot;],[&quot;items&quot;,1,&quot;node&quot;],[&quot;aside&quot;],[&quot;children&quot;]]"',
  );
  expect(body).toContain(
    '<template data-pagedeck-region-stash="2">&lt;p data-aside="">server aside&lt;/p></template>',
  );
  expect(body).toContain('data-pagedeck-component="counter"');
  expect(body).not.toContain("<!--$?-->");

  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const complaints: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    complaints.push(args.map(String).join(" "));
  });
  document.body.innerHTML = body;
  const list = $('[data-pagedeck-component="list"]');
  const serverHtml = list.innerHTML.replace(
    /<template data-pagedeck-region-stash[\s\S]*?<\/template>/,
    "",
  );
  const cardA = $('[data-card="A"]');
  const children = $("[data-children]");

  await act(async () => {
    hydrateIslands({ resolve });
  });
  await act(async () => new Promise((done) => setTimeout(done, 50)));

  expect(list.getAttribute("data-pagedeck-hydrated")).toBe("");
  expect(list.innerHTML.replaceAll(' data-pagedeck-hydrated=""', "")).toBe(
    serverHtml,
  );
  expect($('[data-card="A"]')).toBe(cardA);
  expect($("[data-children]")).toBe(children);

  await click("#inc");
  await click("#inc");
  expect($("#inc").textContent).toBe("count 2");
  expect($('[data-card="A"]')).toBe(cardA);
  expect($("[data-children]")).toBe(children);

  await click("[data-nested]");
  expect($("[data-nested]").textContent).toBe("nested 1");

  await click("#reverse");
  expect(order()).toBe("BA");
  expect($('[data-card="A"]')).toBe(cardA);
  await click("[data-nested]");
  expect($("[data-nested]").textContent).toBe("nested 2");

  await click("#show-aside");
  expect($("aside").innerHTML).toBe(
    '<pagedeck-slot role="presentation" style="display: contents;"><p data-aside="">server aside</p></pagedeck-slot>',
  );
  await click("#inc");
  expect($("#inc").textContent).toBe("count 3");
  expect($('[data-card="A"]')).toBe(cardA);

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
}, 180_000);
