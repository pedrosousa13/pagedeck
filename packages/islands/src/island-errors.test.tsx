// @vitest-environment jsdom
import { act, Component, createElement, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { reportIslandErrors } from "./island-errors.js";
import type {
  IslandErrorReport,
  IslandErrorReporter,
  IslandErrors,
} from "./island-errors.js";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_TAG,
} from "./marker.js";
import { hydrateIslands } from "./runtime.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): Iterable<TestElement>;
  click(): void;
}
declare const document: {
  body: TestElement;
  documentElement: { lang: string };
};
declare const history: {
  replaceState(state: unknown, unused: string, url: string): void;
};

// Hoisted: React reads `reportError` once, when `react-dom/client` first loads.
const globalReports: unknown[] = vi.hoisted(() => {
  const errors: unknown[] = [];
  (globalThis as { reportError?: (error: unknown) => void }).reportError = (
    error,
  ) => {
    errors.push(error);
  };
  return errors;
});

const wiring = vi.hoisted(() => ({
  hydrate: undefined as typeof import("react-dom/client").hydrateRoot | undefined,
  errors: undefined as IslandErrors | undefined,
}));

// The build hands the runtime the wrapper as its `react-dom/client`.
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  wiring.hydrate = original.hydrateRoot;
  return {
    ...original,
    hydrateRoot: ((...args) =>
      errors().hydrateRoot(...args)) as typeof original.hydrateRoot,
  };
});

const RELEASE = "0f6c1d2e-release";
const SENTINEL = "sentinel-prop-5b1e";

let reports: IslandErrorReport[];
let consoleErrors: unknown[];
let fetched: string[];
let manifest: () => Promise<Response>;

function wire(
  load: () => Promise<{ default: IslandErrorReporter }> = async () => ({
    default: (report) => {
      reports.push(report);
    },
  }),
): void {
  if (wiring.hydrate === undefined) throw new Error("react-dom/client not mocked");
  wiring.errors = reportIslandErrors(wiring.hydrate, load);
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.lang = "en";
  history.replaceState(null, "", "/en/pricing/");
  reports = [];
  consoleErrors = [];
  fetched = [];
  globalReports.length = 0;
  manifest = async () =>
    new Response(JSON.stringify({ version: 11, build: { id: RELEASE } }));
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    return manifest();
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args[0]);
  });
  wire();
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

interface Fixture {
  component: string;
  prefix: string;
  serverHtml: string;
  props?: Record<string, unknown>;
}

function marker(fixture: Fixture): string {
  const props = JSON.stringify(fixture.props ?? {}).replaceAll('"', "&quot;");
  return (
    `<${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="${fixture.prefix}"` +
    ` ${ISLAND_COMPONENT_ATTRIBUTE}="${fixture.component}"` +
    ` ${ISLAND_MODE_ATTRIBUTE}="load"` +
    ` ${ISLAND_PROPS_ATTRIBUTE}="${props}">${fixture.serverHtml}</${ISLAND_TAG}>`
  );
}

function errors(): IslandErrors {
  if (wiring.errors === undefined) throw new Error("no wrapper wired");
  return wiring.errors;
}

async function reported(count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(reports).toHaveLength(count);
  });
}

async function hydratePage(
  fixtures: readonly Fixture[],
  components: Record<string, ComponentType<never>>,
): Promise<void> {
  document.body.innerHTML = fixtures.map(marker).join("");
  await act(async () => {
    hydrateIslands({
      resolve: errors().resolve(async (name) => {
        const found = components[name];
        if (found === undefined) throw new Error(`no ${name}`);
        return found;
      }),
    });
  });
}

function Mismatch(_props: { secret?: string }) {
  return <p>client text</p>;
}

function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      count:{count}
    </button>
  );
}

function Throws(): ReactNode {
  throw new Error("render failed in island");
}

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <p>fallback</p> : this.props.children;
  }
}

function Guarded() {
  return createElement(Boundary, null, createElement(Throws));
}

const TWO_ISLANDS: readonly Fixture[] = [
  { component: "Broken", prefix: "i1", serverHtml: "<p>server text</p>" },
  {
    component: "Counter",
    prefix: "i2",
    serverHtml: '<button type="button">count:<!-- -->0</button>',
  },
];

async function expectCounterCounts(): Promise<void> {
  const counter = document.body.querySelector(
    `${ISLAND_TAG}[${ISLAND_COMPONENT_ATTRIBUTE}="Counter"]`,
  );
  await act(async () => {
    counter?.querySelector("button")?.click();
  });
  expect(counter?.textContent).toBe("count:1");
}

test("a hydration mismatch reaches the reporter as recoverable, with page, component and the release manifest.json names", async () => {
  await hydratePage(
    [{ component: "PricingTable", prefix: "i1", serverHtml: "<p>server text</p>" }],
    { PricingTable: Mismatch },
  );

  await reported(1);
  expect(reports[0]).toMatchObject({
    kind: "recoverable",
    page: { locale: "en", path: "/en/pricing/" },
    component: "PricingTable",
    release: RELEASE,
  });
  expect(reports[0]?.error).toBeInstanceOf(Error);
  expect(globalReports).toContain(reports[0]?.error);
  expect(fetched).toEqual(["/manifest.json"]);
});

test("an error a boundary catches is reported as caught, and still logged", async () => {
  await hydratePage(
    [{ component: "Guarded", prefix: "i1", serverHtml: "<p>fallback</p>" }],
    { Guarded },
  );

  await reported(1);
  expect(reports[0]).toMatchObject({
    kind: "caught",
    component: "Guarded",
    release: RELEASE,
  });
  expect(consoleErrors).toContain(reports[0]?.error);
});

test("an error no boundary catches is reported as uncaught, and still reaches reportError", async () => {
  // Outside `act`, which takes an uncaught error for itself instead of
  // calling `onUncaughtError`; a browser has no `act`.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = marker({
    component: "Throws",
    prefix: "i1",
    serverHtml: "<p>server</p>",
  });
  hydrateIslands({
    resolve: errors().resolve(async () => Throws as ComponentType<never>),
  });

  await reported(1);
  expect(reports[0]).toMatchObject({
    kind: "uncaught",
    component: "Throws",
    release: RELEASE,
  });
  expect(globalReports).toContain(reports[0]?.error);
});

test("a rejected island module is reported as module-load and still rejects", async () => {
  const failure = new TypeError("Failed to fetch dynamically imported module");
  const resolve = errors().resolve(() => Promise.reject(failure));

  await expect(resolve("Newsletter", null)).rejects.toBe(failure);
  await reported(1);
  expect(reports).toEqual([
    {
      kind: "module-load",
      page: { locale: "en", path: "/en/pricing/" },
      component: "Newsletter",
      release: RELEASE,
      error: failure,
    },
  ]);
});

test("a page with no error never asks for manifest.json, nor calls the reporter", async () => {
  await hydratePage([TWO_ISLANDS[1] as Fixture], { Counter });
  await expectCounterCounts();

  expect(fetched).toEqual([]);
  expect(reports).toEqual([]);
});

test("two errors at once share one manifest.json request", async () => {
  const failure = new TypeError("Failed to fetch dynamically imported module");
  const resolve = errors().resolve(() => Promise.reject(failure));

  await Promise.allSettled([resolve("Newsletter", null), resolve("Search", null)]);
  await hydratePage(
    [{ component: "PricingTable", prefix: "i1", serverHtml: "<p>server text</p>" }],
    { PricingTable: Mismatch },
  );

  await reported(3);
  expect(fetched).toEqual(["/manifest.json"]);
  expect(reports.map((report) => report.release)).toEqual([
    RELEASE,
    RELEASE,
    RELEASE,
  ]);
});

test.each([
  ["the request fails", () => Promise.reject(new TypeError("Failed to fetch"))],
  ["the host answers 404", async () => new Response("not found", { status: 404 })],
  [
    "the host answers its 404 page with a 200",
    async () => new Response("<!doctype html><title>Not found</title>"),
  ],
  [
    "the document names no build",
    async () => new Response(JSON.stringify({ version: 11 })),
  ],
])("a report carries no release when %s", async (_case, answer) => {
  manifest = answer;
  const failure = new TypeError("Failed to fetch dynamically imported module");

  await expect(
    errors().resolve(() => Promise.reject(failure))("Newsletter"),
  ).rejects.toBe(failure);

  await reported(1);
  expect(reports[0]).toEqual({
    kind: "module-load",
    page: { locale: "en", path: "/en/pricing/" },
    component: "Newsletter",
    error: failure,
  });
  expect("release" in (reports[0] ?? {})).toBe(false);
});

test("a reporter that throws is not called for its own failure, and the next island still hydrates", async () => {
  const thrown = new Error("reporter is down");
  let calls = 0;
  wire(async () => ({
    default: () => {
      calls += 1;
      throw thrown;
    },
  }));

  await hydratePage(TWO_ISLANDS, { Broken: Mismatch, Counter });

  await vi.waitFor(() => {
    expect(consoleErrors).toContain(thrown);
  });
  expect(calls).toBe(1);
  await expectCounterCounts();
});

test("an async reporter that rejects is logged like one that throws, and the next island still hydrates", async () => {
  const rejected = new Error("collector refused the report");
  let calls = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  wire(async () => ({
    default: async () => {
      calls += 1;
      throw rejected;
    },
  }));

  try {
    await hydratePage(TWO_ISLANDS, { Broken: Mismatch, Counter });
    await vi.waitFor(() => {
      expect(consoleErrors).toContain(rejected);
    });
    await new Promise((settle) => setTimeout(settle, 20));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }

  expect(calls).toBe(1);
  expect(consoleErrors.filter((logged) => logged === rejected)).toHaveLength(1);
  expect(unhandled).toEqual([]);
  await expectCounterCounts();
});

test("a reporter module that throws while it loads stops no island, and is logged once", async () => {
  const thrown = new Error("reporter module failed to evaluate");
  wire(() => Promise.reject(thrown));

  await hydratePage(TWO_ISLANDS, { Broken: Mismatch, Counter });

  await vi.waitFor(() => {
    expect(consoleErrors).toContain(thrown);
  });
  await expectCounterCounts();
  expect(consoleErrors.filter((logged) => logged === thrown)).toHaveLength(1);
  expect(fetched).toEqual([]);
});

test("a report carries no props, entry or page data beyond its five fields", async () => {
  await hydratePage(
    [
      {
        component: "PricingTable",
        prefix: "i1",
        serverHtml: "<p>server text</p>",
        props: { secret: SENTINEL, entry: { title: SENTINEL } },
      },
    ],
    { PricingTable: Mismatch },
  );

  await reported(1);
  const [report] = reports;
  expect(Object.keys(report ?? {}).sort()).toEqual([
    "component",
    "error",
    "kind",
    "page",
    "release",
  ]);
  const { error: _error, ...context } = report as IslandErrorReport;
  expect(JSON.stringify(context)).not.toContain(SENTINEL);
  expect(Object.keys(report?.page ?? {}).sort()).toEqual(["locale", "path"]);
});
