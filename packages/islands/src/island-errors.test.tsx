// @vitest-environment jsdom
import { act, Component, createElement, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { IslandErrorReport, IslandErrors } from "./island-errors.js";
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
  reporter: (_report: IslandErrorReport): void => {},
  errors: undefined as IslandErrors | undefined,
}));

// What the build does for a site that declares `build.islandErrors`: the
// runtime's `react-dom/client` is the reporting wrapper.
vi.mock("react-dom/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/client")>();
  const { reportIslandErrors } = await import("./island-errors.js");
  wiring.errors = reportIslandErrors(original.hydrateRoot, (report) => {
    wiring.reporter(report);
  });
  return { ...original, hydrateRoot: wiring.errors.hydrateRoot };
});

const RELEASE = "0f6c1d2e-release";
const SENTINEL = "sentinel-prop-5b1e";

let reports: IslandErrorReport[];
let consoleErrors: unknown[];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  document.documentElement.lang = "en";
  history.replaceState(null, "", "/en/pricing/");
  reports = [];
  consoleErrors = [];
  globalReports.length = 0;
  wiring.reporter = (report) => {
    reports.push(report);
  };
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args[0]);
  });
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
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
  if (wiring.errors === undefined) throw new Error("react-dom/client not mocked");
  return wiring.errors;
}

async function hydratePage(
  fixtures: readonly Fixture[],
  components: Record<string, ComponentType<never>>,
): Promise<void> {
  document.body.innerHTML = fixtures.map(marker).join("");
  await act(async () => {
    hydrateIslands({
      resolve: errors().resolve(RELEASE, async (name) => {
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

test("a hydration mismatch reaches the reporter as recoverable, with page, component and release", async () => {
  await hydratePage(
    [{ component: "PricingTable", prefix: "i1", serverHtml: "<p>server text</p>" }],
    { PricingTable: Mismatch },
  );

  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatchObject({
    kind: "recoverable",
    page: { locale: "en", path: "/en/pricing/" },
    component: "PricingTable",
    release: RELEASE,
  });
  expect(reports[0]?.error).toBeInstanceOf(Error);
  expect(globalReports).toContain(reports[0]?.error);
});

test("an error a boundary catches is reported as caught, and still logged", async () => {
  await hydratePage(
    [{ component: "Guarded", prefix: "i1", serverHtml: "<p>fallback</p>" }],
    { Guarded },
  );

  const caught = reports.filter((report) => report.kind === "caught");
  expect(caught).toHaveLength(1);
  expect(caught[0]).toMatchObject({ component: "Guarded", release: RELEASE });
  expect(consoleErrors).toContain(caught[0]?.error);
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
    resolve: errors().resolve(RELEASE, async () => Throws as ComponentType<never>),
  });
  await vi.waitFor(() => {
    expect(reports.some((report) => report.kind === "uncaught")).toBe(true);
  });

  const uncaught = reports.filter((report) => report.kind === "uncaught");
  expect(uncaught).toHaveLength(1);
  expect(uncaught[0]).toMatchObject({ component: "Throws", release: RELEASE });
  expect(globalReports).toContain(uncaught[0]?.error);
});

test("a rejected island module is reported as module-load and still rejects", async () => {
  const failure = new TypeError("Failed to fetch dynamically imported module");
  const resolve = errors().resolve(RELEASE, () => Promise.reject(failure));

  await expect(resolve("Newsletter")).rejects.toBe(failure);
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

test("a reporter that throws is not called for its own failure, and the next island still hydrates", async () => {
  const thrown = new Error("reporter is down");
  let calls = 0;
  wiring.reporter = () => {
    calls += 1;
    throw thrown;
  };

  await hydratePage(
    [
      { component: "Broken", prefix: "i1", serverHtml: "<p>server text</p>" },
      { component: "Counter", prefix: "i2", serverHtml: '<button type="button">count:<!-- -->0</button>' },
    ],
    { Broken: Mismatch, Counter },
  );

  expect(calls).toBe(1);
  expect(consoleErrors).toContain(thrown);
  const counter = [...document.body.querySelectorAll(ISLAND_TAG)][1];
  await act(async () => {
    counter?.querySelector("button")?.click();
  });
  expect(counter?.textContent).toBe("count:1");
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

  expect(reports).toHaveLength(1);
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
