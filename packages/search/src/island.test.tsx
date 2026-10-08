// @vitest-environment jsdom
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SearchIsland from "./island.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface El {
  id: string;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  setSelectionRange(start: number, end: number): void;
  textContent: string | null;
  getAttribute(name: string): string | null;
  focus(): void;
  click(): void;
  dispatchEvent(event: object): boolean;
}
interface Container {
  innerHTML: string;
  remove(): void;
  querySelector(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
}
declare const document: {
  createElement(tag: "div"): Container;
  body: { appendChild(node: unknown): void };
  addEventListener(
    type: string,
    handler: (event: { target: El; preventDefault(): void }) => void,
  ): void;
  removeEventListener(type: string, handler: (event: never) => void): void;
};
declare const HTMLInputElement: { prototype: object };
interface Keydown {
  readonly defaultPrevented: boolean;
}
declare const KeyboardEvent: new (
  type: string,
  init: { key: string; bubbles: boolean; cancelable: boolean },
) => Keydown;
declare const Event: new (
  type: string,
  init: { bubbles: boolean },
) => object;

// A prefixed locale, so `output` differs from `path` and a wrong link fails.
const FILES: Readonly<Record<string, unknown>> = {
  "/search/en/index.json": {
    format: 1,
    locale: "en",
    documents: "documents.json",
    shards: [
      { file: "terms-0000.json", first: "alpha", last: "loader" },
      { file: "terms-0001.json", first: "moose", last: "zebra" },
    ],
  },
  "/search/en/documents.json": [
    { path: "/guide", output: "/en/guide", title: "Guide" },
    { path: "/loaders", output: "/en/loaders", title: "Loaders" },
  ],
  "/search/en/terms-0000.json": [
    ["alpha", [{ d: 0, f: 1, w: 4 }]],
    ["loader", [
      { d: 0, f: 3, w: 4 },
      { d: 1, f: 1, w: 1 },
    ]],
  ],
  "/search/en/terms-0001.json": [["zebra", [{ d: 1, f: 1, w: 4 }]]],
};

// Installed globally, not passed as a prop: the criterion is what the island does on a page.
const fetched: string[] = [];
function installFetch(): void {
  fetched.length = 0;
  vi.stubGlobal("fetch", (url: string) => {
    fetched.push(url);
    const body = FILES[url];
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("no body")) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
}

const PROPS = {
  locale: "en",
  label: "Search the docs",
  emptyLabel: "No results",
} as const;

const mounted: { root?: { unmount(): void }; container?: Container } = {};

// Through the prototype's setter: React drops an `input` event whose value it already saw.
function setValue(element: El, text: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    element,
    text,
  );
}

function mount({
  beforeHydrating = () => undefined,
  onRecoverableError = () => undefined,
}: {
  beforeHydrating?: (container: Container) => void;
  onRecoverableError?: (error: unknown) => void;
} = {}): Container {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    createElement(SearchIsland, PROPS),
  );
  document.body.appendChild(container);
  beforeHydrating(container);
  act(() => {
    mounted.root = hydrateRoot(
      container as never,
      createElement(SearchIsland, PROPS),
      { onRecoverableError },
    );
  });
  mounted.container = container;
  return container;
}

function input(container: Container): El {
  const found = container.querySelector("input");
  if (found === null) {
    throw new Error(`the island renders no input — it holds ${container.innerHTML}`);
  }
  return found;
}

async function focus(container: Container): Promise<void> {
  await act(async () => {
    input(container).focus();
    await Promise.resolve();
  });
}

async function type(container: Container, text: string): Promise<void> {
  const element = input(container);
  await act(async () => {
    setValue(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// Cancelable, as a real keydown is, or `defaultPrevented` stays false whatever the island does.
async function press(container: Container, key: string): Promise<Keydown> {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    input(container).dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

function options(container: Container): El[] {
  return Array.from(container.querySelectorAll('[role="option"]'));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installFetch();
});

afterEach(() => {
  if (mounted.root !== undefined) act(() => mounted.root?.unmount());
  mounted.container?.remove();
  mounted.root = undefined;
  mounted.container = undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("the island fetches no index file until the reader touches it", () => {
  const container = mount();

  expect(fetched).toEqual([]);
  expect(input(container).getAttribute("role")).toBe("combobox");
});

// Typed before hydration: the server HTML is live, and an `idle` island hydrates later (#94).
test("text typed before the island hydrates is searched at once, with the caret left where it was", async () => {
  const faults: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    faults.push(args);
  });
  const container = mount({
    beforeHydrating: (html) => {
      const box = input(html);
      setValue(box, "zebra");
      box.setSelectionRange(1, 3);
    },
    onRecoverableError: (error) => faults.push(error),
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(options(container).map((option) => option.textContent)).toEqual([
    "Loaders",
  ]);
  const box = input(container);
  expect(box.value).toBe("zebra");
  expect([box.selectionStart, box.selectionEnd]).toEqual([1, 3]);
  expect(faults).toEqual([]);
});

test("an empty input hydrates with no search run", async () => {
  const faults: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    faults.push(args);
  });
  const container = mount({
    onRecoverableError: (error) => faults.push(error),
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(fetched).toEqual([]);
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(input(container).getAttribute("aria-expanded")).toBe("false");
  expect(faults).toEqual([]);
});

test("focusing the input fetches the shard ranges and no shard", async () => {
  const container = mount();

  await focus(container);

  expect(fetched).toEqual(["/search/en/index.json"]);
});

test("typing fetches the shard the word is in and lists what it found", async () => {
  const container = mount();

  await type(container, "zebra");

  expect([...fetched].sort()).toEqual([
    "/search/en/documents.json",
    "/search/en/index.json",
    "/search/en/terms-0001.json",
  ]);
  expect(options(container).map((option) => option.textContent)).toEqual([
    "Loaders",
  ]);
});

test("a listbox of results is announced as the combobox's own", async () => {
  const container = mount();
  const box = input(container);

  expect(box.getAttribute("aria-expanded")).toBe("false");
  expect(box.getAttribute("aria-autocomplete")).toBe("list");

  await type(container, "loader");

  const listbox = container.querySelector('[role="listbox"]');
  expect(listbox).not.toBeNull();
  expect(box.getAttribute("aria-expanded")).toBe("true");
  expect(box.getAttribute("aria-controls")).toBe(listbox?.id);
  expect(options(container)).toHaveLength(2);
});

test("the arrow keys walk the results and Enter follows the active one", async () => {
  const container = mount();
  const box = input(container);
  const followed: (string | null)[] = [];
  const intercept = (event: { target: El; preventDefault(): void }): void => {
    // jsdom has no navigation, and a real browser would leave the page here.
    event.preventDefault();
    followed.push(event.target.getAttribute("href"));
  };
  document.addEventListener("click", intercept);

  await type(container, "loader");
  expect(box.getAttribute("aria-activedescendant")).toBeNull();

  await press(container, "ArrowDown");
  const [first, second] = options(container);
  expect(box.getAttribute("aria-activedescendant")).toBe(first?.id);
  expect(first?.getAttribute("aria-selected")).toBe("true");

  await press(container, "ArrowDown");
  expect(box.getAttribute("aria-activedescendant")).toBe(second?.id);

  await press(container, "ArrowUp");
  expect(box.getAttribute("aria-activedescendant")).toBe(first?.id);

  await press(container, "Enter");
  expect(followed).toEqual(["/en/loaders"]);

  document.removeEventListener("click", intercept as never);
});

test("Escape closes the results and leaves the query alone", async () => {
  const container = mount();

  await type(container, "loader");
  const escape = await press(container, "Escape");

  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(input(container).getAttribute("aria-expanded")).toBe("false");
  expect(input(container).value).toBe("loader");
  // jsdom never clears a search input on Escape; Chromium does unless it is prevented.
  expect(escape.defaultPrevented).toBe(true);
});

test("Escape with no results showing leaves the browser's own behaviour alone", async () => {
  const container = mount();

  await type(container, "loader");
  await press(container, "Escape");
  expect((await press(container, "Escape")).defaultPrevented).toBe(false);

  await type(container, "aardvark");
  expect((await press(container, "Escape")).defaultPrevented).toBe(false);
});

test("a query with nothing behind it says so rather than showing an empty box", async () => {
  const container = mount();

  await type(container, "aardvark");

  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "No results",
  );
});

test("a query the runtime could not answer is reported, and the box says nothing was found", async () => {
  const written: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    written.push(args);
  });
  vi.stubGlobal("fetch", (url: string) => {
    const body = url === "/search/en/index.json" ? FILES[url] : undefined;
    return Promise.resolve(
      body === undefined
        ? { ok: false, status: 404, json: () => Promise.reject(new Error("no body")) }
        : { ok: true, status: 200, json: () => Promise.resolve(body) },
    );
  });
  const container = mount();

  await type(container, "zebra");

  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "No results",
  );
  expect(written).toEqual([
    [
      'Search index "/search/en/terms-0001.json": the request failed with status 404, so this query cannot be answered — check that the build wrote a search index for locale "en" and that it was deployed with the pages',
    ],
  ]);
});
