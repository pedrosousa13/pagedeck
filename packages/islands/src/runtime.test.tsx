// @vitest-environment jsdom
import {
  act,
  createContext,
  createElement,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import type { ComponentType, ReactNode } from "react";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ISLAND_COMPONENT_ATTRIBUTE,
  ISLAND_MODE_ATTRIBUTE,
  ISLAND_PREFIX_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_TAG,
} from "./marker.js";
import { wrapInProviders } from "./providers.js";
import { RegistryError } from "./registry.js";
import type { RootProvider } from "./providers.js";
import { hydrateIslands } from "./runtime.js";
import type { IslandRoot } from "./runtime.js";
import { hydrateOnTrigger } from "./startup.js";
import type { Schedule } from "./startup.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  readonly children: ArrayLike<TestElement>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): TestElement | null;
  querySelectorAll(selector: string): Iterable<TestElement>;
  click(): void;
}
declare const document: { body: TestElement };

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  visible.clear();
  FakeObserver.live.length = 0;
  reported.length = 0;
  mounted.length = 0;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const visible = new Set<TestElement>();

interface FakeEntry {
  target: TestElement;
  isIntersecting: boolean;
}

// Models prototype #68 rule 1: a fake that reported the marker visible would
// pass a runtime that observes the marker.
function generatesNoBox(element: TestElement): boolean {
  return /display:\s*contents/.test(element.getAttribute("style") ?? "");
}

class FakeObserver {
  static readonly live: FakeObserver[] = [];

  private readonly targets: TestElement[] = [];

  constructor(private readonly callback: (entries: FakeEntry[]) => void) {
    FakeObserver.live.push(this);
  }

  observe(target: TestElement): void {
    this.targets.push(target);
    this.callback([
      { target, isIntersecting: !generatesNoBox(target) && visible.has(target) },
    ]);
  }

  disconnect(): void {
    this.targets.length = 0;
  }

  watches(target: TestElement): boolean {
    return this.targets.includes(target);
  }

  static reveal(target: TestElement): void {
    for (const observer of FakeObserver.live) {
      if (observer.watches(target)) {
        observer.callback([{ target, isIntersecting: true }]);
      }
    }
  }
}

async function scrollTo(element: TestElement): Promise<void> {
  visible.add(element);
  await act(async () => {
    FakeObserver.reveal(element);
  });
}

// Hoisted: React reads `reportError` once, when `react-dom/client` first loads,
// and this file loads it at import time.
const reported: string[] = vi.hoisted(() => {
  const lines: string[] = [];
  (globalThis as { reportError?: (error: unknown) => void }).reportError = (
    error,
  ) => {
    lines.push(String(error));
  };
  return lines;
});

const idleCallbacks: (() => void)[] = [];

async function runIdleCallbacks(): Promise<void> {
  const due = idleCallbacks.splice(0, idleCallbacks.length);
  await act(async () => {
    for (const callback of due) callback();
  });
}

function fakeBrowser(options: { idle?: boolean } = {}): void {
  idleCallbacks.length = 0;
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  if (options.idle === true) {
    vi.stubGlobal("requestIdleCallback", (callback: () => void) => {
      idleCallbacks.push(callback);
    });
  }
}

type AnyComponent = ComponentType<Record<string, unknown>>;

interface IslandFixture {
  component: string;
  render: ComponentType<never>;
  props?: Readonly<Record<string, unknown>>;
  mode: "load" | "visible" | "idle";
  prefix: string;
}

async function prerenderToHtml(
  tree: ReactNode,
  identifierPrefix: string,
): Promise<string> {
  const { prelude } = await prerender(tree, { identifierPrefix });
  const decoder = new TextDecoder();
  let html = "";
  for await (const chunk of prelude) {
    html += decoder.decode(chunk, { stream: true });
  }
  return html + decoder.decode();
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

async function markerFor(
  island: IslandFixture,
  providers: readonly RootProvider[],
): Promise<string> {
  const props = island.props ?? {};
  const html = await prerenderToHtml(
    wrapInProviders(
      createElement(island.render as AnyComponent, { ...props }),
      providers,
    ),
    island.prefix,
  );
  return (
    `<${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="${island.prefix}"` +
    ` ${ISLAND_COMPONENT_ATTRIBUTE}="${island.component}"` +
    ` ${ISLAND_MODE_ATTRIBUTE}="${island.mode}"` +
    ` ${ISLAND_PROPS_ATTRIBUTE}="${escapeAttribute(JSON.stringify(props))}"` +
    ` role="presentation" style="display:contents">${html}</${ISLAND_TAG}>`
  );
}

async function buildPage(
  islands: readonly IslandFixture[],
  providers: readonly RootProvider[] = [],
): Promise<(name: string) => Promise<ComponentType<never>>> {
  const markers = await Promise.all(
    islands.map((island) => markerFor(island, providers)),
  );
  document.body.innerHTML = markers.join("");
  const modules = new Map(
    islands.map((island) => [island.component, island.render]),
  );
  return async (name) => modules.get(name) as ComponentType<never>;
}

async function click(marker: TestElement | undefined): Promise<void> {
  await act(async () => {
    marker?.querySelector("button")?.click();
  });
}

function markers(): TestElement[] {
  return [...document.body.querySelectorAll(ISLAND_TAG)];
}

// The fixture's `prerender` and the runtime's `hydrateRoot` share one process
// and one context object here; in production they are a build and a browser.
const CROSS_RENDERER_ARTIFACT = "Detected multiple renderers";

async function complaintsWhile(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await run();
  spy.mockRestore();
  return lines;
}

function pageIds(): string[] {
  return markers().flatMap((marker) =>
    [...marker.innerHTML.matchAll(/id="([^"]+)"/g)].map(
      (match) => match[1] as string,
    ),
  );
}

function unexplained(complaints: readonly string[]): string[] {
  return complaints.filter((line) => !line.includes(CROSS_RENDERER_ARTIFACT));
}

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      {label}:{count}
    </button>
  );
}

function Field({ label }: { label: string }) {
  const inputId = useId();
  return (
    <p>
      <label htmlFor={inputId}>{label}</label>
      <input id={inputId} name={label} />
    </p>
  );
}

const ThemeContext = createContext("light");

function ThemeProvider({
  theme,
  children,
}: {
  theme: string;
  children?: ReactNode;
}) {
  return (
    <div data-theme={theme}>
      <ThemeContext value={theme}>{children}</ThemeContext>
    </div>
  );
}

const PROVIDERS: readonly RootProvider[] = [
  { component: ThemeProvider, props: { theme: "dark" } },
];

function Themed() {
  return <span>{useContext(ThemeContext)}</span>;
}

test("an island hydrates with exactly its own props and leaves its sibling alone", async () => {
  fakeBrowser();
  const resolve = await buildPage([
    {
      component: "Counter",
      render: Counter,
      props: { label: "One" },
      mode: "load",
      prefix: "ione",
    },
    {
      component: "Counter",
      render: Counter,
      props: { label: "Two" },
      mode: "load",
      prefix: "itwo",
    },
  ]);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  const [first, second] = markers();
  await click(first);
  await click(first);
  await click(second);

  expect(first?.textContent).toBe("One:2");
  expect(second?.textContent).toBe("Two:1");
});

test("two islands on one page hydrate under their own prefixes, and their ids do not collide", async () => {
  fakeBrowser();
  const resolve = await buildPage([
    {
      component: "Field",
      render: Field,
      props: { label: "Email" },
      mode: "load",
      prefix: "ifirst",
    },
    {
      component: "Field",
      render: Field,
      props: { label: "List" },
      mode: "load",
      prefix: "isecond",
    },
  ]);
  const serverIds = pageIds();

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(complaints).toEqual([]);
  expect(reported).toEqual([]);
  expect(serverIds).toHaveLength(2);
  expect(new Set(serverIds).size).toBe(2);
  expect(pageIds()).toEqual(serverIds);
});

test("every island root is wrapped in the provider stack the build used", async () => {
  fakeBrowser();
  const resolve = await buildPage(
    [{ component: "Themed", render: Themed, mode: "load", prefix: "ithemed" }],
    PROVIDERS,
  );

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve, providers: PROVIDERS });
    });
  });

  const artifact = complaints.filter((line) =>
    line.includes(CROSS_RENDERER_ARTIFACT),
  );
  expect(artifact).toHaveLength(1);
  expect(unexplained(complaints)).toEqual([]);
  expect(reported).toEqual([]);
  expect(markers()[0]?.textContent).toBe("dark");
});

test("hydrating without the provider stack the build used does mismatch", async () => {
  fakeBrowser();
  const resolve = await buildPage(
    [{ component: "Themed", render: Themed, mode: "load", prefix: "ithemed" }],
    PROVIDERS,
  );

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve });
    });
  });

  expect(complaints).toEqual([]);
  expect(reported.join("\n")).toMatch(/hydrat/i);
});

function Reveal() {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount(count + 1)}>
        {count}
      </button>
    </div>
  );
}

test("a visible island hydrates when its content is scrolled to, not before", async () => {
  fakeBrowser();
  const resolve = await buildPage([
    { component: "Reveal", render: Reveal, mode: "visible", prefix: "ibelow" },
  ]);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  const marker = markers()[0] as TestElement;
  await click(marker);
  expect(marker.textContent).toBe("0");

  await scrollTo(marker.children[0] as TestElement);
  await click(marker);

  expect(marker.textContent).toBe("1");
});

test("an idle island waits for the browser to be idle", async () => {
  fakeBrowser({ idle: true });
  const resolve = await buildPage([
    { component: "Reveal", render: Reveal, mode: "idle", prefix: "iidle" },
  ]);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  const marker = markers()[0] as TestElement;
  await click(marker);
  expect(marker.textContent).toBe("0");

  await runIdleCallbacks();
  await click(marker);

  expect(marker.textContent).toBe("1");
});

test("an idle island still hydrates in a browser with no requestIdleCallback", async () => {
  fakeBrowser();
  vi.useFakeTimers();
  const resolve = await buildPage([
    { component: "Reveal", render: Reveal, mode: "idle", prefix: "iidle" },
  ]);

  await act(async () => {
    hydrateIslands({ resolve });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  vi.useRealTimers();
  await click(markers()[0]);

  expect(markers()[0]?.textContent).toBe("1");
});

const mounted: string[] = [];

function Notice({ id }: { id: string }) {
  useEffect(() => {
    mounted.push(id);
  }, [id]);
  return <>a notice</>;
}

test("a visible island with no element children falls back to idle", async () => {
  fakeBrowser({ idle: true });
  const resolve = await buildPage([
    {
      component: "Notice",
      render: Notice,
      props: { id: "text-only" },
      mode: "visible",
      prefix: "inotice",
    },
  ]);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  expect(FakeObserver.live).toHaveLength(0);
  expect(mounted).toEqual([]);

  await runIdleCallbacks();

  expect(mounted).toEqual(["text-only"]);
});

test("a page with no markers does nothing and registers nothing", async () => {
  fakeBrowser({ idle: true });
  document.body.innerHTML = "<main><p>content only</p></main>";
  const resolve = vi.fn(async () => Reveal as ComponentType<never>);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  expect(resolve).not.toHaveBeenCalled();
  expect(FakeObserver.live).toHaveLength(0);
  expect(idleCallbacks).toHaveLength(0);
});

const store = { clicks: 0 };
const StoreContext = createContext(store);

function StoreProvider({ children }: { children?: ReactNode }) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

function Writer() {
  const shared = useContext(StoreContext);
  return (
    <button type="button" onClick={() => (shared.clicks += 1)}>
      write
    </button>
  );
}

// Reads after mounting: the server rendered this island before any write, so
// a first render showing the store would mismatch.
function Reader() {
  const shared = useContext(StoreContext);
  const [seen, setSeen] = useState("?");
  useEffect(() => {
    setSeen(String(shared.clicks));
  }, [shared]);
  return (
    <div>
      <span>{seen}</span>
    </div>
  );
}

test("a later-hydrating island observes what an earlier one wrote to the shared store", async () => {
  fakeBrowser();
  store.clicks = 0;
  const resolve = await buildPage(
    [
      { component: "Writer", render: Writer, mode: "load", prefix: "iwriter" },
      { component: "Reader", render: Reader, mode: "visible", prefix: "ireader" },
    ],
    [{ component: StoreProvider }],
  );

  const complaints = await complaintsWhile(async () => {
    await act(async () => {
      hydrateIslands({ resolve, providers: [{ component: StoreProvider }] });
    });
    const [writer, reader] = markers();
    await click(writer);
    await click(writer);
    await scrollTo((reader as TestElement).children[0] as TestElement);
  });

  expect(unexplained(complaints)).toEqual([]);
  expect(reported).toEqual([]);
  expect(markers()[1]?.textContent).toBe("2");
});

test("a marker missing an attribute the build always writes is refused", async () => {
  fakeBrowser();
  document.body.innerHTML = `<${ISLAND_TAG}><span>hi</span></${ISLAND_TAG}>`;

  expect(() => {
    hydrateIslands({ resolve: async () => Reveal as ComponentType<never> });
  }).toThrowError(
    new RegistryError(
      `Island marker #1: carries no ${ISLAND_COMPONENT_ATTRIBUTE}, so there is nothing to hydrate it as — a marker is written by the build, so remove the hand-written <${ISLAND_TAG}> from the content`,
    ),
  );
});

test("a marker whose props are not JSON is refused, naming the island", async () => {
  fakeBrowser();
  document.body.innerHTML =
    `<${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="ibroken"` +
    ` ${ISLAND_COMPONENT_ATTRIBUTE}="Reveal" ${ISLAND_MODE_ATTRIBUTE}="load"` +
    ` ${ISLAND_PROPS_ATTRIBUTE}="{oops"` +
    ` role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}>`;

  expect(() => {
    hydrateIslands({ resolve: async () => Reveal as ComponentType<never> });
  }).toThrowError(
    new RegistryError(
      `Island "Reveal" (ibroken): its ${ISLAND_PROPS_ATTRIBUTE} is not JSON, so there are no props to hydrate it with — a marker is written by the build, so remove the hand-written <${ISLAND_TAG}> from the content`,
    ),
  );
});

test("the props failure keeps what the parser said as its cause", async () => {
  fakeBrowser();
  document.body.innerHTML =
    `<${ISLAND_TAG} ${ISLAND_PREFIX_ATTRIBUTE}="ibroken"` +
    ` ${ISLAND_COMPONENT_ATTRIBUTE}="Reveal" ${ISLAND_MODE_ATTRIBUTE}="load"` +
    ` ${ISLAND_PROPS_ATTRIBUTE}="{oops"` +
    ` role="presentation" style="display:contents"><span>hi</span></${ISLAND_TAG}>`;

  let thrown: unknown;
  try {
    hydrateIslands({ resolve: async () => Reveal as ComponentType<never> });
  } catch (error) {
    thrown = error;
  }

  expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
});

function handWritten(attributes: string): string {
  return `<${ISLAND_TAG} ${attributes}><span>hi</span></${ISLAND_TAG}>`;
}

test("a marker missing only its prefix is named by the component it does carry", async () => {
  fakeBrowser();
  document.body.innerHTML = handWritten(
    `${ISLAND_COMPONENT_ATTRIBUTE}="Reveal" ${ISLAND_MODE_ATTRIBUTE}="load" ${ISLAND_PROPS_ATTRIBUTE}="{}"`,
  );

  expect(() => {
    hydrateIslands({ resolve: async () => Reveal as ComponentType<never> });
  }).toThrowError(
    new RegistryError(
      `Island "Reveal": carries no ${ISLAND_PREFIX_ATTRIBUTE}, so there is nothing to hydrate it as — a marker is written by the build, so remove the hand-written <${ISLAND_TAG}> from the content`,
    ),
  );
});

test("a marker carrying only a prefix is named by its position and that prefix", async () => {
  fakeBrowser();
  document.body.innerHTML = handWritten(
    `${ISLAND_PREFIX_ATTRIBUTE}="iabc" ${ISLAND_MODE_ATTRIBUTE}="load" ${ISLAND_PROPS_ATTRIBUTE}="{}"`,
  );

  expect(() => {
    hydrateIslands({ resolve: async () => Reveal as ComponentType<never> });
  }).toThrowError(
    new RegistryError(
      `Island marker #1 (iabc): carries no ${ISLAND_COMPONENT_ATTRIBUTE}, so there is nothing to hydrate it as — a marker is written by the build, so remove the hand-written <${ISLAND_TAG}> from the content`,
    ),
  );
});

test("every unreadable marker on a page is reported, not the first", async () => {
  fakeBrowser();
  document.body.innerHTML =
    handWritten(`${ISLAND_MODE_ATTRIBUTE}="load"`) +
    handWritten(
      `${ISLAND_COMPONENT_ATTRIBUTE}="Reveal" ${ISLAND_MODE_ATTRIBUTE}="load" ${ISLAND_PROPS_ATTRIBUTE}="{}"`,
    ) +
    handWritten(
      `${ISLAND_PREFIX_ATTRIBUTE}="ithird" ${ISLAND_COMPONENT_ATTRIBUTE}="Reveal"` +
        ` ${ISLAND_MODE_ATTRIBUTE}="load" ${ISLAND_PROPS_ATTRIBUTE}="{oops"`,
    );

  expect(() => {
    hydrateIslands({ resolve: async () => Reveal as ComponentType<never> });
  }).toThrowError(
    new RegistryError(
      `Island markers: 3 on this page cannot be read, so those islands will not hydrate — a marker is written by the build, so remove the hand-written <${ISLAND_TAG}> from the content:\n` +
        `  marker #1: carries no ${ISLAND_COMPONENT_ATTRIBUTE}\n` +
        `  "Reveal": carries no ${ISLAND_PREFIX_ATTRIBUTE}\n` +
        `  "Reveal" (ithird): its ${ISLAND_PROPS_ATTRIBUTE} is not JSON`,
    ),
  );
});

test("the islands after an unreadable marker still hydrate", async () => {
  fakeBrowser();
  const resolve = await buildPage([
    { component: "Notice", render: Notice, props: { id: "one" }, mode: "load", prefix: "ione" },
    { component: "Notice", render: Notice, props: { id: "two" }, mode: "load", prefix: "itwo" },
  ]);
  document.body.innerHTML =
    handWritten(`${ISLAND_MODE_ATTRIBUTE}="load"`) + document.body.innerHTML;

  let thrown: unknown;
  await act(async () => {
    try {
      hydrateIslands({ resolve });
    } catch (error) {
      thrown = error;
    }
  });

  expect(thrown).toBeInstanceOf(RegistryError);
  expect(mounted).toEqual(["one", "two"]);
});

function Pair({ id }: { id: string }) {
  useEffect(() => {
    mounted.push(id);
  }, [id]);
  return (
    <>
      <div>first</div>
      <div>second</div>
    </>
  );
}

test("a visible island with two element children in view mounts once", async () => {
  fakeBrowser();
  const resolve = await buildPage([
    {
      component: "Pair",
      render: Pair,
      props: { id: "pair" },
      mode: "visible",
      prefix: "ipair",
    },
  ]);
  const marker = markers()[0] as TestElement;
  for (const child of Array.from(marker.children)) visible.add(child);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  expect(mounted).toEqual(["pair"]);
});

test("a visible island with two element children leaves nothing observed", async () => {
  fakeBrowser();
  const resolve = await buildPage([
    {
      component: "Pair",
      render: Pair,
      props: { id: "pair" },
      mode: "visible",
      prefix: "ipair",
    },
  ]);
  const marker = markers()[0] as TestElement;
  const children = Array.from(marker.children);
  for (const child of children) visible.add(child);

  await act(async () => {
    hydrateIslands({ resolve });
  });

  const stillWatched = children.filter((child) =>
    FakeObserver.live.some((observer) => observer.watches(child)),
  );

  expect(stillWatched).toEqual([]);
});

function startsRuntime(
  resolve: (name: string) => Promise<ComponentType<never>>,
): (schedule: Schedule) => Promise<void> {
  return vi.fn(async (schedule: Schedule) => {
    hydrateIslands({ resolve, schedule });
  });
}

test("an all-idle page starts the runtime on its first trigger, once, and each island hydrates on its own", async () => {
  fakeBrowser({ idle: true });
  const resolve = await buildPage([
    { component: "Notice", render: Notice, props: { id: "idle" }, mode: "idle", prefix: "iidle" },
    { component: "Pair", render: Pair, props: { id: "below" }, mode: "visible", prefix: "ibelow" },
  ]);
  const start = startsRuntime(resolve);

  await act(async () => {
    hydrateOnTrigger(start);
  });

  expect(start).not.toHaveBeenCalled();
  expect(mounted).toEqual([]);

  await runIdleCallbacks();

  expect(start).toHaveBeenCalledTimes(1);
  expect(mounted).toEqual(["idle"]);

  await scrollTo(markers()[1]?.children[0] as TestElement);

  expect(start).toHaveBeenCalledTimes(1);
  expect(mounted).toEqual(["idle", "below"]);
});

test("an island whose trigger fires while the runtime loads hydrates once it has loaded", async () => {
  fakeBrowser({ idle: true });
  const resolve = await buildPage([
    { component: "Notice", render: Notice, props: { id: "one" }, mode: "idle", prefix: "ione" },
    { component: "Notice", render: Notice, props: { id: "two" }, mode: "idle", prefix: "itwo" },
  ]);
  let loaded: () => void = () => undefined;
  const start = vi.fn(async (schedule: Schedule) => {
    await new Promise<void>((resolveLoad) => {
      loaded = resolveLoad;
    });
    hydrateIslands({ resolve, schedule });
  });
  hydrateOnTrigger(start);

  await runIdleCallbacks();
  expect(mounted).toEqual([]);

  await act(async () => {
    loaded();
  });

  expect(start).toHaveBeenCalledTimes(1);
  expect(mounted).toEqual(["one", "two"]);
});

test("a page started on a trigger reports an unreadable marker once and still hydrates the rest", async () => {
  fakeBrowser({ idle: true });
  const resolve = await buildPage([
    { component: "Notice", render: Notice, props: { id: "one" }, mode: "idle", prefix: "ione" },
    { component: "Notice", render: Notice, props: { id: "two" }, mode: "idle", prefix: "itwo" },
  ]);
  document.body.innerHTML =
    handWritten(`${ISLAND_MODE_ATTRIBUTE}="idle"`) + document.body.innerHTML;

  hydrateOnTrigger(startsRuntime(resolve));
  await runIdleCallbacks();

  expect(mounted).toEqual(["one", "two"]);
  expect(reported).toEqual([
    expect.stringContaining("RegistryError: Island marker #1: carries no"),
  ]);
});

// A container's re-mounted slot hands the runtime markers that did not exist
// when the startup module read the page.
test("a marker the startup module never saw is scheduled on its own trigger", async () => {
  fakeBrowser({ idle: true });
  const resolve = await buildPage([
    { component: "Notice", render: Notice, props: { id: "seen" }, mode: "idle", prefix: "iseen" },
  ]);
  const fresh = (
    document as unknown as { createElement(tag: string): TestElement }
  ).createElement("div");
  fresh.innerHTML = await markerFor(
    { component: "Notice", render: Notice, props: { id: "later" }, mode: "idle", prefix: "ilater" },
    [],
  );
  hydrateOnTrigger(async (schedule) => {
    hydrateIslands({ resolve, schedule });
    hydrateIslands({ resolve, schedule, root: fresh as unknown as IslandRoot });
  });

  await runIdleCallbacks();
  expect(mounted).toEqual(["seen"]);

  await runIdleCallbacks();
  expect(mounted).toEqual(["seen", "later"]);
});
