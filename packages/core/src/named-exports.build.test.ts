// @vitest-environment jsdom
// Spawned, not in process: `installClientReferences` hooks only what Node loads, and
// under Vitest every `import()` in this package is Vitest's.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-named-exports");

const counter = (name: string, label: string): string => `export function ${name}() {
  const [count, setCount] = useState(0);
  return <button type="button" data-island="${label}" onClick={() => setCount(count + 1)}>${label} {count}</button>;
}
`;

const FILES: Readonly<Record<string, string>> = {
  "components/LayoutIslands.tsx": `"use client";
import { useState } from "react";

export const LAYOUT_VERSION = "layout-4d1a";

${counter("HeaderIsland", "header-6a2f")}
${counter("FooterIsland", "footer-b83c")}`,
  "components/Mixed.tsx": `"use client";
import { useState } from "react";

${counter("Aside", "aside-1e07")}
export default function Main() {
  const [count, setCount] = useState(0);
  return <button type="button" data-island="main-9c54" onClick={() => setCount(count + 1)}>main-9c54 {count}</button>;
}
`,
  "components/Page.tsx": `import { FooterIsland, HeaderIsland, LAYOUT_VERSION } from "./LayoutIslands.tsx";
import Main, { Aside } from "./Mixed.tsx";

export default function Page() {
  return (
    <div data-version={LAYOUT_VERSION}>
      <HeaderIsland />
      <Main />
      <Aside />
      <FooterIsland />
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
      layout_islands: { path: "./components/LayoutIslands.tsx", hydrate: "load" },
      mixed: { path: "./components/Mixed.tsx", hydrate: "load" },
    },
    content: () => ({ tree: [{ component: "page" }] }),
  },
});
`,
};

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface Element {
  readonly innerHTML: string;
  getAttribute(name: string): string | null;
  querySelector(selectors: string): (Element & { click(): void }) | null;
}
declare const document: {
  documentElement: { innerHTML: string };
  querySelectorAll(selectors: string): ArrayLike<Element>;
};
declare const window: {
  addEventListener(type: "error", listener: (event: { error: unknown }) => void): void;
};

let html: string;

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  for (const [file, contents] of Object.entries(FILES)) {
    mkdirSync(dirname(join(SITE, file)), { recursive: true });
    writeFileSync(join(SITE, file), contents);
  }
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });
  html = readFileSync(join(SITE, "site", "index.html"), "utf8");
}, 180_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

function markerTags(): string[] {
  return [...html.matchAll(/<pagedeck-island\b[^>]*>/g)].map((match) => match[0]);
}

test("a named export's marker names the export, and a default export's marker carries no export attribute", () => {
  const tags = markerTags();
  expect(tags).toHaveLength(4);
  const [header, main, aside, footer] = tags as [string, string, string, string];
  expect(header).toContain('data-pagedeck-component="layout_islands"');
  expect(header).toContain('data-pagedeck-export="HeaderIsland"');
  expect(footer).toContain('data-pagedeck-export="FooterIsland"');
  expect(aside).toContain('data-pagedeck-component="mixed"');
  expect(aside).toContain('data-pagedeck-export="Aside"');
  expect(main).toMatch(
    /^<pagedeck-island data-pagedeck-prefix="[^"]+" data-pagedeck-component="mixed" data-pagedeck-mode="load" data-pagedeck-props="\{\}" role="presentation" style="display:contents">$/,
  );
});

test("every island of a module with named exports hydrates its own export and keeps its server HTML", async () => {
  const errors: unknown[] = [];
  window.addEventListener("error", (event) => {
    errors.push(event.error);
  });
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
  const markers = Array.from(document.querySelectorAll("pagedeck-island"));
  expect(markers).toHaveLength(4);
  const before = markers.map((marker) => marker.innerHTML);
  expect(before.join("")).toMatch(/header-6a2f.*main-9c54.*aside-1e07.*footer-b83c/s);

  const entry = /<script type="module" src="\/(assets\/entry-[^"]+\.js)">/.exec(html)?.[1];
  expect(entry).toBeDefined();
  await import(/* @vite-ignore */ pathToFileURL(join(SITE, "site", entry as string)).href);

  const hydrated = (marker: Element): boolean =>
    Object.keys(marker).some((key) => key.startsWith("__reactContainer$"));
  const deadline = Date.now() + 10_000;
  while (!markers.every(hydrated) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Settled: a component that is not one throws on its first render.
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(errors).toEqual([]);
  expect(markers.map(hydrated)).toEqual([true, true, true, true]);
  expect(markers.map((marker) => marker.innerHTML)).toEqual(before);

  for (const marker of markers) marker.querySelector("button")?.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(
    markers.map((marker) => marker.querySelector("button")?.innerHTML.replace(/<!-- -->/g, "")),
  ).toEqual(["header-6a2f 1", "main-9c54 1", "aside-1e07 1", "footer-b83c 1"]);
}, 30_000);
