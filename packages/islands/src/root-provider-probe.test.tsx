// @vitest-environment jsdom
import { act, createContext, useContext, useRef } from "react";
import { Component } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { wrapInProviders } from "./providers.js";
import type { RootProvider } from "./providers.js";
import { rootProviderProbe } from "./root-provider-probe.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface TestElement {
  innerHTML: string;
  readonly textContent: string | null;
  appendChild(child: TestElement): void;
}
declare const document: {
  body: TestElement;
  createElement(tag: string): TestElement;
};

type Store = { read(): number };

const StoreContext = createContext<Store | null>(null);

function SharedStoreProvider({
  store,
  children,
}: {
  store: Store;
  children?: ReactNode;
}) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

function OwnStoreProvider({ children }: { children?: ReactNode }) {
  const store = useRef<Store>({ read: () => 0 });
  return <StoreContext value={store.current}>{children}</StoreContext>;
}

class ClassStoreProvider extends Component<{ children?: ReactNode }> {
  override render(): ReactNode {
    return (
      <StoreContext value={{ read: () => 0 }}>
        {this.props.children}
      </StoreContext>
    );
  }
}

function Leaf() {
  return <span>{useContext(StoreContext) === null ? "none" : "store"}</span>;
}

async function mountTwice(stack: readonly RootProvider[]): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  const probe = rootProviderProbe();
  await act(async () => {
    for (const _root of [0, 1]) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      createRoot(container as never).render(
        wrapInProviders(<Leaf />, stack, probe),
      );
    }
  });
  spy.mockRestore();
  return lines;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

test("a provider handed one store is reported as nothing at all", async () => {
  const store: Store = { read: () => 0 };

  expect(
    await mountTwice([{ component: SharedStoreProvider, props: { store } }]),
  ).toEqual([]);
  expect(document.body.textContent).toBe("storestore");
});

test("a provider that creates its own state is reported, naming it", async () => {
  expect(await mountTwice([{ component: OwnStoreProvider }])).toEqual([
    `Root provider "OwnStoreProvider": delivers a different value to each island root, so two islands that look like they share state do not — the provider creates its own state instead of receiving one, so move that state to a module-level instance and pass it in, as { component: OwnStoreProvider, props: { store } }; this is a warning and not a refusal because the page renders and only its behaviour is wrong, and because this probe sees only a provider whose component is a plain function returning a context element`,
  ]);
});

const WrapperContext = createContext<{ store: Store } | null>(null);

function WrappedStoreProvider({
  store,
  children,
}: {
  store: Store;
  children?: ReactNode;
}) {
  return (
    <WrapperContext value={{ store }}>
      <StoreContext value={store}>{children}</StoreContext>
    </WrapperContext>
  );
}

test("a shared store inside a fresh wrapper is reported as nothing at all", async () => {
  const store: Store = { read: () => 0 };

  expect(
    await mountTwice([{ component: WrappedStoreProvider, props: { store } }]),
  ).toEqual([]);
  expect(document.body.textContent).toBe("storestore");
});

test("a shared value that moved between two roots is reported as nothing at all", async () => {
  let shared: Store = { read: () => 1 };
  function MovingStoreProvider({ children }: { children?: ReactNode }) {
    return <StoreContext value={shared}>{children}</StoreContext>;
  }
  const stack: readonly RootProvider[] = [{ component: MovingStoreProvider }];

  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  const probe = rootProviderProbe();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const first = createRoot(container as never);
  await act(async () => {
    first.render(wrapInProviders(<Leaf />, stack, probe));
  });
  shared = { read: () => 2 };
  await act(async () => {
    first.render(wrapInProviders(<Leaf />, stack, probe));
  });
  await act(async () => {
    const second = document.createElement("div");
    document.body.appendChild(second);
    createRoot(second as never).render(wrapInProviders(<Leaf />, stack, probe));
  });
  spy.mockRestore();

  expect(lines).toEqual([]);
});

const CLASS_STACK: readonly RootProvider[] = [
  { component: ClassStoreProvider as unknown as RootProvider["component"] },
];

test("a provider the probe cannot look into is reported as nothing at all", async () => {
  expect(await mountTwice(CLASS_STACK)).toEqual([]);
  expect(document.body.textContent).toBe("storestore");
});

test("one root alone reports nothing, because one root cannot show the fault", async () => {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  const probe = rootProviderProbe();
  await act(async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    createRoot(container as never).render(
      wrapInProviders(<Leaf />, [{ component: OwnStoreProvider }], probe),
    );
  });
  spy.mockRestore();

  expect(lines).toEqual([]);
});

test("the same provider is named once, however many roots mount it", async () => {
  const probe = rootProviderProbe();
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  await act(async () => {
    for (const _root of [0, 1, 2, 3]) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      createRoot(container as never).render(
        wrapInProviders(<Leaf />, [{ component: OwnStoreProvider }], probe),
      );
    }
  });
  spy.mockRestore();

  expect(lines).toHaveLength(1);
});

test("without a probe the stack is wrapped exactly as it was", async () => {
  await act(async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    createRoot(container as never).render(
      wrapInProviders(<Leaf />, [{ component: OwnStoreProvider }]),
    );
  });

  expect(document.body.textContent).toBe("store");
});
