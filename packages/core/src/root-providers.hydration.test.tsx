// @vitest-environment jsdom
import {
  act,
  createContext,
  useContext,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { hydrateIslands } from "@pagedeck/islands/runtime";
import { rootProviderProbe } from "@pagedeck/islands/root-provider-probe";
import type { RootProvider, ComponentRegistry } from "@pagedeck/islands";
import { renderPage } from "./render.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Declared here rather than adding the `DOM` lib to the workspace tsconfig, which would
// let `document` typecheck in node-only packages. jsdom supplies it at runtime.
interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): Iterable<TestElement>;
  click(): void;
}
declare const document: { body: TestElement };

// Hoisted above the imports: React reads `reportError` once, when `react-dom/client`
// first loads.
const reported: string[] = vi.hoisted(() => {
  const lines: string[] = [];
  (globalThis as { reportError?: (error: unknown) => void }).reportError = (
    error,
  ) => {
    lines.push(String(error));
  };
  return lines;
});

function createStore() {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    write(next: number) {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Emptying `document.body` does not unmount a root, so without this the previous test's
    // roots stay subscribed and React warns about updates outside `act`.
    reset() {
      listeners.clear();
      value = 0;
    },
  };
}

type Store = ReturnType<typeof createStore>;

const store = createStore();

const StoreContext = createContext<Store | null>(null);

const deliveredStores: Store[] = [];

function StoreProvider({
  store,
  children,
}: {
  store: Store;
  children?: ReactNode;
}) {
  deliveredStores.push(store);
  return <StoreContext value={store}>{children}</StoreContext>;
}

const STACK: readonly RootProvider[] = [
  { component: StoreProvider, props: { store } },
];

function useCount(): string {
  const store = useContext(StoreContext);
  const value = useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    () => store?.read() ?? -1,
    () => store?.read() ?? -1,
  );
  return store === null ? "no-store" : String(value);
}

function Hero() {
  const store = useContext(StoreContext);
  const count = useCount();
  const id = useId();
  return (
    <section>
      <span id={id}>hero:{count}</span>
      <button
        type="button"
        onClick={() => {
          store?.write(store.read() + 1);
        }}
      >
        bump
      </button>
    </section>
  );
}

function Chart() {
  const count = useCount();
  const id = useId();
  return <section id={id}>chart:{count}</section>;
}

const REGISTRY = {
  Hero: { import: async () => ({ default: Hero }), hydrate: "load" },
  Chart: { import: async () => ({ default: Chart }), hydrate: "visible" },
} satisfies ComponentRegistry;

const MODULES: Record<string, typeof Hero> = { Hero, Chart };

interface FakeEntry {
  target: TestElement;
  isIntersecting: boolean;
}

class FakeObserver {
  static readonly live: FakeObserver[] = [];
  private readonly targets: TestElement[] = [];

  constructor(private readonly callback: (entries: FakeEntry[]) => void) {
    FakeObserver.live.push(this);
  }

  observe(target: TestElement): void {
    this.targets.push(target);
    this.callback([{ target, isIntersecting: false }]);
  }

  disconnect(): void {
    this.targets.length = 0;
  }

  static reveal(target: TestElement): void {
    for (const observer of FakeObserver.live) {
      if (observer.targets.includes(target)) {
        observer.callback([{ target, isIntersecting: true }]);
      }
    }
  }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  FakeObserver.live.length = 0;
  deliveredStores.length = 0;
  reported.length = 0;
  store.reset();
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  store.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PAGE = { locale: "en", path: "/careers" } as const;

// React warns when two renderers touch one context, and here the build's `prerender`
// and the runtime's `hydrateRoot` share a process. In production they do not.
const CROSS_RENDERER_ARTIFACT = "Detected multiple renderers";

async function buildPage(): Promise<void> {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Hero" }, { component: "Chart" }],
    registry: REGISTRY,
    providers: STACK,
  });
  document.body.innerHTML = html;
}

async function hydrate(): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await act(async () => {
    hydrateIslands({
      resolve: async (name) => MODULES[name] as typeof Hero,
      providers: STACK,
    });
  });
  spy.mockRestore();
  return [...lines, ...reported].filter(
    (line) => !line.includes(CROSS_RENDERER_ARTIFACT),
  );
}

function markers(): TestElement[] {
  return [...document.body.querySelectorAll("fw-island")];
}

async function scrollTo(marker: TestElement): Promise<void> {
  const child = marker.querySelector("section");
  await act(async () => {
    if (child !== null) FakeObserver.reveal(child);
  });
}

function pageIds(): string[] {
  return [...document.body.innerHTML.matchAll(/id="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}

test("two islands on one page hydrate under distinct prefixes, and their useId values do not collide", async () => {
  await buildPage();

  const prefixes = markers().map((one) => one.getAttribute("data-fw-prefix"));
  expect(new Set(prefixes).size).toBe(2);

  const serverIds = markers().map((one) => {
    const ids = [...one.innerHTML.matchAll(/id="([^"]+)"/g)];
    expect(ids).toHaveLength(1);
    return ids[0]?.[1] as string;
  });
  expect(serverIds[0]).toContain(prefixes[0]);
  expect(serverIds[1]).toContain(prefixes[1]);
  expect(new Set(serverIds).size).toBe(2);

  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await act(async () => {
    hydrateIslands({
      resolve: async (name) => MODULES[name] as typeof Hero,
      providers: STACK,
    });
  });
  const [, chart] = markers() as [TestElement, TestElement];
  await scrollTo(chart);
  spy.mockRestore();

  expect(
    [...lines, ...reported].filter(
      (line) => !line.includes(CROSS_RENDERER_ARTIFACT),
    ),
  ).toEqual([]);
  expect(pageIds()).toEqual(serverIds);
});

test("two islands under two strategies share one store through their own providers", async () => {
  await buildPage();

  expect(markers().map((one) => one.getAttribute("data-fw-mode"))).toEqual([
    "load",
    "visible",
  ]);
  expect(document.body.textContent).toContain("hero:0");
  expect(document.body.textContent).toContain("chart:0");

  expect(new Set(deliveredStores)).toEqual(new Set([store]));
  expect(deliveredStores.length).toBeGreaterThan(1);
  deliveredStores.length = 0;

  const complaints = await hydrate();
  expect(complaints).toEqual([]);

  const [hero, chart] = markers() as [TestElement, TestElement];
  expect(deliveredStores).toHaveLength(1);

  await scrollTo(chart);
  expect(deliveredStores).toHaveLength(2);

  expect(new Set(deliveredStores).size).toBe(1);
  expect(deliveredStores[0]).toBe(store);

  await act(async () => {
    hero.querySelector("button")?.click();
  });
  expect(hero.textContent).toContain("hero:1");
  expect(chart.textContent).toContain("chart:1");

  await act(async () => {
    store.write(41);
  });
  expect(hero.textContent).toContain("hero:41");
  expect(chart.textContent).toContain("chart:41");
});

function OwnStoreProvider({ children }: { children?: ReactNode }) {
  const [own] = useState(createStore);
  return <StoreContext value={own}>{children}</StoreContext>;
}

const OWN_STACK: readonly RootProvider[] = [{ component: OwnStoreProvider }];

test("a provider that owns its state is named once both islands have mounted", async () => {
  const { html } = await renderPage({
    page: PAGE,
    tree: [{ component: "Hero" }, { component: "Chart" }],
    registry: REGISTRY,
    providers: OWN_STACK,
  });
  document.body.innerHTML = html;

  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await act(async () => {
    hydrateIslands({
      resolve: async (name) => MODULES[name] as typeof Hero,
      providers: OWN_STACK,
      probe: rootProviderProbe(),
    });
  });
  const mine = () =>
    lines.filter((line) => line.startsWith("Root provider "));

  expect(mine()).toEqual([]);

  const [, chart] = markers() as [TestElement, TestElement];
  await scrollTo(chart);
  spy.mockRestore();

  expect(mine()).toEqual([
    `Root provider "OwnStoreProvider": delivers a different value to each island root, so two islands that look like they share state do not — the provider creates its own state instead of receiving one, so move that state to a module-level instance and pass it in, as { component: OwnStoreProvider, props: { store } }; this is a warning and not a refusal because the page renders and only its behaviour is wrong, and because this probe sees only a provider whose component is a plain function returning a context element`,
  ]);
});

test("a provider handed the shared store is named by nothing", async () => {
  await buildPage();

  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await act(async () => {
    hydrateIslands({
      resolve: async (name) => MODULES[name] as typeof Hero,
      providers: STACK,
      probe: rootProviderProbe(),
    });
  });
  const [, chart] = markers() as [TestElement, TestElement];
  await scrollTo(chart);
  spy.mockRestore();

  expect(lines.filter((line) => line.startsWith("Root provider "))).toEqual([]);

  expect(
    [...lines, ...reported].filter(
      (line) => !line.includes(CROSS_RENDERER_ARTIFACT),
    ),
  ).toEqual([]);
});

test("hydrating an island without the configured stack mismatches", async () => {
  await buildPage();

  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await act(async () => {
    hydrateIslands({ resolve: async (name) => MODULES[name] as typeof Hero });
  });
  spy.mockRestore();

  expect([...lines, ...reported].join("\n")).toMatch(/hydrat/i);
  expect(document.body.textContent).toContain("hero:no-store");
});
