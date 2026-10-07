import { chromium, firefox, webkit } from "playwright";
import type { BrowserType } from "playwright";
import { expect, test } from "vitest";

const page = (body: string): string =>
  `<!doctype html><html><body>${body}</body></html>`;

// `input type="week"` is the one Gecko and WebKit fall back to `type="text"`.
const DIVERGENCE_CANDIDATES: Record<string, string> = {
  "ul display:contents": `<ul style="display:contents"><li>one</li><li>two</li></ul>`,
  "details/summary": `<details><summary>More</summary><p>body</p></details>`,
  "input type=week": `<input type="week" aria-label="wk">`,
  "input type=color": `<input type="color" aria-label="col">`,
  "search element": `<search><input aria-label="q"></search>`,
  "table display:block": `<table style="display:block"><tr><td>cell</td></tr></table>`,
  svg: `<svg width="10" height="10" aria-label="pic"><circle cx="5" cy="5" r="4"/></svg>`,
};

const WRAPPED_LIST = {
  bare: `<ul><li>one</li><div><li>two</li></div></ul>`,
  presentation: `<ul><li>one</li><div role="presentation"><li>two</li></div></ul>`,
};

// Spelled out rather than imported, so renaming `ISLAND_TAG` cannot change what
// was measured.
const WRAPPED_LIST_MARKER = {
  bare: `<ul><li>one</li><fw-island style="display: contents"><li>two</li></fw-island></ul>`,
  presentation: `<ul><li>one</li><fw-island role="presentation" style="display: contents"><li>two</li></fw-island></ul>`,
};

const ENGINES: [string, BrowserType][] = [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
];

test("the three engines are genuinely different, and disagree about the same DOM", async () => {
  const seen: Record<string, { vendor: string; weekType: string }> = {};
  for (const [name, launcher] of ENGINES) {
    const browser = await launcher.launch();
    const tab = await browser.newPage();
    await tab.setContent(page(`<input type="week" id="w">`));
    // No DOM lib in this program: adding it breaks files that describe the DOM
    // structurally, so the two globals the callback reads are typed here.
    seen[name] = await tab.evaluate(() => {
      const browserGlobals = globalThis as unknown as {
        navigator: { vendor: string };
        document: { getElementById(id: string): { type: string } | null };
      };
      return {
        vendor: browserGlobals.navigator.vendor,
        weekType: browserGlobals.document.getElementById("w")?.type ?? "",
      };
    });
    await browser.close();
  }

  expect(seen).toEqual({
    chromium: { vendor: "Google Inc.", weekType: "week" },
    firefox: { vendor: "", weekType: "text" },
    webkit: { vendor: "Apple Computer, Inc.", weekType: "text" },
  });
});

test("ariaSnapshot is byte-identical across the three engines", async () => {
  const perEngine: Record<string, Record<string, string>> = {};
  for (const [name, launcher] of ENGINES) {
    const browser = await launcher.launch();
    const tab = await browser.newPage();
    const snapshots: Record<string, string> = {};
    for (const [label, body] of Object.entries({
      ...DIVERGENCE_CANDIDATES,
      ...WRAPPED_LIST,
    })) {
      await tab.setContent(page(body));
      snapshots[label] = await tab.locator("body").ariaSnapshot();
    }
    perEngine[name] = snapshots;
    await browser.close();
  }

  expect(perEngine.firefox).toEqual(perEngine.chromium);
  expect(perEngine.webkit).toEqual(perEngine.chromium);

  expect(perEngine.chromium?.presentation).toBe(perEngine.chromium?.bare);
});

const chromiumAxTrees = async (
  pages: Record<string, string>,
): Promise<Record<string, string>> => {
  const browser = await chromium.launch();
  const tab = await browser.newPage();
  const trees: Record<string, string> = {};

  for (const [label, body] of Object.entries(pages)) {
    await tab.setContent(page(body));
    const cdp = await tab.context().newCDPSession(tab);
    await cdp.send("Accessibility.enable");
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const children = new Set(nodes.flatMap((node) => node.childIds ?? []));
    const lines: string[] = [];
    const walk = (node: (typeof nodes)[number], depth: number): void => {
      if (node.role?.value === "InlineTextBox") return;
      lines.push(
        `${"  ".repeat(depth)}${node.ignored ? "[ignored] " : ""}${String(node.role?.value)}`,
      );
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) walk(child, depth + 1);
      }
    };
    for (const node of nodes) if (!children.has(node.nodeId)) walk(node, 0);
    trees[label] = lines.join("\n");
    await cdp.detach();
  }
  await browser.close();
  return trees;
};

const LIST_WITHOUT_WRAPPER_NODE = [
  "RootWebArea",
  "  [ignored] none",
  "    [ignored] none",
  "      list",
  "        listitem",
  "          ListMarker",
  "            [ignored] none",
  "          StaticText",
  "        listitem",
  "          ListMarker",
  "            [ignored] none",
  "          StaticText",
].join("\n");

test("Chromium's own tree separates the two the snapshot cannot", async () => {
  const trees = await chromiumAxTrees(WRAPPED_LIST);

  expect(trees.bare).toBe(
    [
      "RootWebArea",
      "  [ignored] none",
      "    [ignored] none",
      "      list",
      "        listitem",
      "          ListMarker",
      "            [ignored] none",
      "          StaticText",
      "        [ignored] none",
      "          listitem",
      "            ListMarker",
      "              [ignored] none",
      "            StaticText",
    ].join("\n"),
  );
  expect(trees.presentation).toBe(LIST_WITHOUT_WRAPPER_NODE);
});

test("Chromium's own tree does not separate them for the marker's element", async () => {
  const trees = await chromiumAxTrees(WRAPPED_LIST_MARKER);

  expect(trees.bare).toBe(LIST_WITHOUT_WRAPPER_NODE);
  expect(trees.presentation).toBe(LIST_WITHOUT_WRAPPER_NODE);
  expect(trees.presentation).toBe(trees.bare);
});

test("the engine-backed accessibility API Playwright used to expose is gone", async () => {
  const browser = await chromium.launch();
  const tab = await browser.newPage();
  expect((tab as unknown as { accessibility?: unknown }).accessibility).toBe(
    undefined,
  );
  await browser.close();
});
