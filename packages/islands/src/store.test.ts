// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Provider as JotaiProvider, atom, createStore, useAtomValue } from "jotai";
import { useAtomCallback } from "jotai/utils";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Provider, hydrateStore, store, useStoreCallback } from "./store.js";
import {
  StoreError,
  checkSharedStore,
  markRootsMounting,
} from "./store-stamp.js";
import { readSharedStoreStamp } from "./store-realm.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface TestElement {
  innerHTML: string;
}
declare const document: {
  createElement(tag: string): TestElement;
};

let reported: string[];
beforeEach(() => {
  reported = [];
  vi.spyOn(console, "error").mockImplementation((message: unknown) => {
    reported.push(String(message));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

test("the module exports one store, stamped on globalThis", () => {
  expect(readSharedStoreStamp()?.store).toBe(store);
});

// One module id evaluated twice. Vite's linked-package case is two ids in one
// realm and is not covered here.
test("a second evaluation of the module adopts the first store and reports nothing", async () => {
  vi.resetModules();
  const second = (await import("./store.js")) as { store: unknown };
  vi.resetModules();
  const third = (await import("./store.js")) as { store: unknown };

  expect(second.store).toBe(store);
  expect(third.store).toBe(store);
  expect(reported).toEqual([]);
});

function stackWith(value: unknown): unknown {
  return [{ component: Provider, props: { store: value } }];
}

const SECOND_INSTANCE = [
  `Shared store: 1 provider delivers a store this framework did not mint, so two island roots resolve the same atoms on two stores and neither sees the other's writes — pass the one instance "@pagedeck/islands/store" exports, and call createStore() nowhere in site code; islands are separate React roots, so one store object reached through one module is the only thing that carries state between them, and a build, a dev server and a preview app refuse this where a shipped page only reports it, because the build's chunk-graph assertion is the gate and a canary must not take a visitor's page away:`,
  `  stack[0].props.store`,
].join("\n");

// The stack is captured before the second evaluation and checked after it,
// which is what lets a second minted store fail this.
test("a second evaluation leaves a dev-mode check with nothing to refuse", async () => {
  const captured = stackWith(store);
  vi.resetModules();
  const second = (await import("./store.js")) as { store: unknown };

  expect(second.store).toBe(store);
  expect(() => {
    checkSharedStore(captured, false);
  }).not.toThrow();
  expect(reported).toEqual([]);
});

test("a foreign store is refused where the caller is a build, a dev server or preview", () => {
  expect(() => {
    checkSharedStore(stackWith(createStore()), false);
  }).toThrow(StoreError);
  expect(() => {
    checkSharedStore(stackWith(createStore()), false);
  }).toThrow(SECOND_INSTANCE);
  expect(reported).toEqual([]);
});

test("a foreign store is reported and not thrown where the caller is a shipped page", () => {
  checkSharedStore(stackWith(createStore()), true);
  expect(reported).toEqual([SECOND_INSTANCE]);
});

test("every offending provider is named, not the first", () => {
  const stack = [
    { component: Provider, props: { store: createStore() } },
    { component: Provider, props: { store } },
    { component: Provider, props: { store: createStore() } },
  ];
  checkSharedStore(stack, true);
  expect(reported).toHaveLength(1);
  expect((reported[0] as string).split("\n").slice(1)).toEqual([
    "  stack[0].props.store",
    "  stack[2].props.store",
  ]);
});

test("the shared store itself is never refused, by either caller", () => {
  checkSharedStore(stackWith(store), false);
  checkSharedStore(stackWith(store), true);
  expect(reported).toEqual([]);
});

test("a store under a provider that is not the framework's is left alone", () => {
  const OwnProvider = ({ children }: { children?: unknown }) => children;
  for (const stack of [
    [{ component: OwnProvider, props: { store: createStore() } }],
    [
      {
        component: OwnProvider,
        props: { store: { get: () => 1, set: () => 1, sub: () => () => {} } },
      },
    ],
    [{ component: Provider, props: { theme: "dark" } }],
    [{ component: Provider }],
    [{ component: Provider, props: {} }],
  ]) {
    checkSharedStore(stack, false);
  }
  expect(reported).toEqual([]);
});

test("a realm with no store module has nothing to check", () => {
  const stamped = readSharedStoreStamp();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("fw.shared-store")];
  try {
    expect(() => {
      checkSharedStore(stackWith(createStore()), false);
    }).not.toThrow();
    expect(reported).toEqual([]);
  } finally {
    (globalThis as Record<symbol, unknown>)[Symbol.for("fw.shared-store")] =
      stamped;
  }
});

test("a stack that is not an array is left to checkRootProviders", () => {
  checkSharedStore(undefined, false);
  checkSharedStore({ component: () => null }, false);
  expect(reported).toEqual([]);
});


test("the shared store hydrates once, outside React", () => {
  const count = atom(0);
  count.debugLabel = "count";

  hydrateStore([[count, 7]]);
  expect(store.get(count)).toBe(7);
  expect(reported).toEqual([]);
});

test("a second hydration is reported, and the first value is kept", () => {
  const first = atom(0);
  first.debugLabel = "cart";
  const second = atom(0);
  const third = atom(0);

  hydrateStore([
    [first, 1],
    [second, 2],
  ]);
  hydrateStore([
    [first, 99],
    [third, 3],
    [second, 99],
  ]);

  expect(store.get(first)).toBe(1);
  expect(store.get(second)).toBe(2);
  expect(store.get(third)).toBe(3);

  expect(reported).toEqual([
    [
      `Shared store: 2 atoms are hydrated a second time, and an atom hydrates once per store, so the value this call brought was dropped and the first one kept — hydrate the shared store once, from the page and before any root mounts, and give an island its own atom rather than a second value for a shared one; island hydration order is not controlled under the "visible" and "idle" strategies, so which value survives is not the site's to choose. This is reported and not refused because the page renders and only its state is wrong, and refusing here would cost every island that has not hydrated yet:`,
      `  atom[0] "cart"`,
      `  atom[2] — no debugLabel`,
    ].join("\n"),
  ]);
});

test("a hydration after roots begin mounting is reported, and still lands", () => {
  const late = atom(0);
  late.debugLabel = "late";
  const stamped = readSharedStoreStamp();
  const before = stamped?.mounted ?? false;
  markRootsMounting();
  try {
    hydrateStore([[late, 5]]);
  } finally {
    if (stamped !== undefined) stamped.mounted = before;
  }

  expect(store.get(late)).toBe(5);
  expect(reported).toEqual([
    `Shared store: hydrateStore was called after island roots began mounting, so every root that had already rendered did it with the value the store held before this call — a visible flash where the value is rendered, and a wrong answer for anything that read it in an effect or an event before the write landed — call hydrateStore from the page, above the module that hydrates the islands, so the store is complete before the first root mounts. This is reported and not refused because the page renders and only its state is wrong, and refusing here would take away the roots that mounted correctly.`,
  ]);
});

test("a second hydration quotes no value", () => {
  const secret = atom("");
  secret.debugLabel = "session";
  hydrateStore([[secret, "token-4f21-SECRET"]]);
  hydrateStore([[secret, "token-4f21-SECRET"]]);

  expect(reported).toHaveLength(1);
  expect(reported[0]).not.toContain("token-4f21-SECRET");
  expect(reported[0]).toContain(`atom[0] "session"`);
});

test("useStoreCallback threads the shared store, where the plain hook does not", () => {
  const value = atom("default-store");
  store.set(value, "shared-store");

  let threaded: string | undefined;
  let fallen: string | undefined;
  function Probe(): null {
    threaded = useStoreCallback((get) => get(value))();
    fallen = useAtomCallback((get) => get(value))();
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container as never);
  act(() => {
    root.render(createElement(Probe));
  });
  act(() => {
    root.unmount();
  });

  expect(threaded).toBe("shared-store");
  expect(fallen).toBe("default-store");
});

test("two independent React roots share one store through the module", () => {
  const shared = atom("initial");
  const seen: Record<string, string> = {};

  function Island({ name }: { name: string }): null {
    seen[name] = useAtomValue(shared);
    return null;
  }
  function mount(name: string): { unmount: () => void } {
    const container = document.createElement("div");
    const root = createRoot(container as never);
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Island, { name }),
        ),
      );
    });
    return root;
  }

  const a = mount("a");
  const b = mount("b");
  expect(seen).toEqual({ a: "initial", b: "initial" });

  act(() => {
    store.set(shared, "written");
  });
  expect(seen).toEqual({ a: "written", b: "written" });

  act(() => {
    a.unmount();
    b.unmount();
  });
});

test("the re-exported Provider is Jotai's own object", () => {
  expect(Provider).toBe(JotaiProvider);
});

test("jotai is pinned to the exact version the multi-root behaviour was verified on", () => {
  const declared = JSON.parse(
    readFileSync(join(HERE, "../package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  expect(declared.dependencies["jotai"]).toBe("2.20.2");

  const installed = JSON.parse(
    readFileSync(join(HERE, "../node_modules/jotai/package.json"), "utf8"),
  ) as { version: string };
  expect(installed.version).toBe("2.20.2");
});
