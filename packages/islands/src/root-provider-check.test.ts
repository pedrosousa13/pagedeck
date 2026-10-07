import { expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import {
  checkRootProviders,
  rootProviderStackDigest,
} from "./root-provider-check.js";
import type { RootProvider } from "./providers.js";

function StoreProvider({ children }: { children?: ReactNode }): ReactNode {
  return children;
}

function createStore() {
  let value = 0;
  return { read: () => value, write: (next: number) => (value = next) };
}

function reports(run: () => void): string[] {
  const lines: string[] = [];
  const spy = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return lines;
}

test("two evaluations of one declaration digest identically", () => {
  const stack = (): readonly RootProvider[] => [
    { component: StoreProvider, props: { store: createStore(), label: "en" } },
  ];

  expect(rootProviderStackDigest(stack())).toBe(
    rootProviderStackDigest(stack()),
  );
  expect(rootProviderStackDigest(stack())).toBe(
    "stack[0] label=string#411a658a, store=object#7ee4f3ca",
  );
});

test("a prop computed from a clock digests differently", () => {
  const built: readonly RootProvider[] = [
    { component: StoreProvider, props: { now: 1_756_500_000_000 } },
  ];
  const loaded: readonly RootProvider[] = [
    { component: StoreProvider, props: { now: 1_756_500_009_999 } },
  ];

  expect(rootProviderStackDigest(built)).not.toBe(
    rootProviderStackDigest(loaded),
  );
});

test("two halves that are not one declaration digest differently", () => {
  const built: readonly RootProvider[] = [
    { component: StoreProvider, props: { store: createStore() } },
  ];
  const loaded: readonly RootProvider[] = [
    { component: StoreProvider, props: { store: createStore() } },
    { component: StoreProvider },
  ];

  expect(rootProviderStackDigest(built)).not.toBe(
    rootProviderStackDigest(loaded),
  );
});

test("a matching digest is reported as nothing at all", () => {
  const stack: readonly RootProvider[] = [
    { component: StoreProvider, props: { store: createStore() } },
  ];

  expect(
    reports(() => {
      checkRootProviders(stack, rootProviderStackDigest(stack));
    }),
  ).toEqual([]);
});

test("a divergence is reported, quoting both stacks by index", () => {
  const loaded: readonly RootProvider[] = [
    {
      component: StoreProvider,
      props: { now: 1_756_500_000_000, store: createStore() },
    },
  ];

  expect(
    reports(() => {
      checkRootProviders(loaded, "stack[0] store=object#7ee4f3ca");
    }),
  ).toEqual([
    [
      `Root providers: the stack this page was built with and the stack the browser imported are not one declaration, so every island root wraps in providers the markup it hydrates was not rendered with — write both halves of "build.rootProviders" from one import in pagedeck.config.ts, and compute no provider prop from a clock, an environment or a random value:`,
      `  built with 1 provider:`,
      `    stack[0] store=object#7ee4f3ca`,
      `  imported 1 provider:`,
      `    stack[0] now=number#a2de48c1, store=object#7ee4f3ca`,
    ].join("\n"),
  ]);
});

test("two distinct symbol props digest differently", () => {
  const built: readonly RootProvider[] = [
    { component: StoreProvider, props: { key: Symbol("cart") } },
  ];
  const loaded: readonly RootProvider[] = [
    { component: StoreProvider, props: { key: Symbol("wishlist") } },
  ];

  expect(rootProviderStackDigest(built)).not.toBe(
    rootProviderStackDigest(loaded),
  );
  expect(rootProviderStackDigest(built)).toBe(
    rootProviderStackDigest([
      { component: StoreProvider, props: { key: Symbol("cart") } },
    ]),
  );
});

test("a default export that is not an array is reported, not thrown", () => {
  const lines = reports(() => {
    checkRootProviders(StoreProvider, "stack[0] store=object");
  });

  expect(lines).toEqual([
    [
      `Root providers: the module "build.rootProviders.module" default-exports is not a stack this page can apply, so nothing here can check it against the stack this page was built with — default-export the same array of { component, props } that "build.rootProviders.stack" holds, outermost first:`,
      `  the default export — a function, not an array of providers`,
    ].join("\n"),
  ]);
});

test("a default export of the wrong shape is reported by index", () => {
  const lines = reports(() => {
    checkRootProviders(
      ["nope", { component: undefined }, { component: StoreProvider, props: 7 }],
      "stack[0] store=object",
    );
  });

  expect(lines).toEqual([
    [
      `Root providers: the module "build.rootProviders.module" default-exports is not a stack this page can apply, so nothing here can check it against the stack this page was built with — default-export the same array of { component, props } that "build.rootProviders.stack" holds, outermost first:`,
      `  stack[0] — not an object`,
      `  stack[1].component — not a component`,
      `  stack[2].props — not an object`,
    ].join("\n"),
  ]);
});

test("a malformed default export is reported once, not twice", () => {
  expect(
    reports(() => {
      checkRootProviders(undefined, "stack[0] store=object");
    }),
  ).toHaveLength(1);
});

test("the counts in the report are the two stacks' own", () => {
  const loaded: readonly RootProvider[] = [
    { component: StoreProvider },
    { component: StoreProvider },
  ];

  expect(
    reports(() => {
      checkRootProviders(loaded, "stack[0]");
    })[0],
  ).toContain("imported 2 providers:");
});

function digestOfProps(props: Readonly<Record<string, unknown>>): string {
  return rootProviderStackDigest([{ component: StoreProvider, props }]);
}

test("an object prop whose field moved digests differently", () => {
  expect(digestOfProps({ config: { mode: "dev" } })).not.toBe(
    digestOfProps({ config: { mode: "prod" } }),
  );
});

test("an object prop whose keys differ digests differently", () => {
  expect(digestOfProps({ config: { mode: "dev" } })).not.toBe(
    digestOfProps({ config: { stage: "dev" } }),
  );
});

test("an array prop whose elements differ digests differently", () => {
  expect(digestOfProps({ locales: ["en", "fr"] })).not.toBe(
    digestOfProps({ locales: ["en", "de"] }),
  );
});

test("an array prop is not the plain object of the same entries", () => {
  expect(digestOfProps({ config: ["en"] })).not.toBe(
    digestOfProps({ config: { 0: "en" } }),
  );
});

test("two objects of the same shape and different identity digest identically", () => {
  expect(digestOfProps({ config: { mode: "dev" } })).toBe(
    digestOfProps({ config: { mode: "dev" } }),
  );
});

test("an object prop written in a different key order digests identically", () => {
  expect(digestOfProps({ config: { mode: "dev", region: "eu" } })).toBe(
    digestOfProps({ config: { region: "eu", mode: "dev" } }),
  );
});

test("a store's nested state is not read into", () => {
  const store = (count: number) => ({
    state: { count },
    read: () => count,
  });

  expect(digestOfProps({ store: store(0) })).toBe(
    digestOfProps({ store: store(41) }),
  );
});

test("two objects differing only at depth 2 digest identically", () => {
  expect(digestOfProps({ config: { nested: { mode: "dev" } } })).toBe(
    digestOfProps({ config: { nested: { mode: "prod" } } }),
  );
});

test("a class instance is tagged without reading its constructor name", () => {
  class Store {
    value = 0;
  }
  class a {
    value = 7;
  }

  expect(digestOfProps({ store: new Store() })).toBe(
    digestOfProps({ store: new a() }),
  );
  expect(digestOfProps({ store: new Store() })).toBe("stack[0] store=object");
});

test("a function prop is tagged without reading its name or its properties", () => {
  function makeStore() {
    return 0;
  }
  const b = () => 7;
  Object.assign(b, { cache: 1 });

  expect(digestOfProps({ make: makeStore })).toBe(digestOfProps({ make: b }));
  expect(digestOfProps({ make: makeStore })).toBe("stack[0] make=function");
});

test("a null prop is tagged as null and not read into", () => {
  expect(digestOfProps({ config: null })).toBe("stack[0] config=null");
});

test("neither a nested value nor a nested key name reaches the digest text", () => {
  const digest = digestOfProps({
    config: { "sk-live-key-name": "sk-live-value" },
  });

  expect(digest).not.toContain("sk-live-key-name");
  expect(digest).not.toContain("sk-live-value");
  expect(digest.startsWith("stack[0] config=object#")).toBe(true);
});

test("a prop whose field throws when read keeps the bare tag", () => {
  const config = {
    get secret(): string {
      throw new Error("read me and the build stops");
    },
  };

  expect(digestOfProps({ config })).toBe("stack[0] config=object");
});

test("a revoked proxy prop keeps the bare tag", () => {
  const { proxy, revoke } = Proxy.revocable({ mode: "dev" }, {});
  revoke();

  expect(digestOfProps({ config: proxy })).toBe("stack[0] config=object");
});

test("a null-prototype object prop is read into", () => {
  const dev = Object.create(null) as Record<string, unknown>;
  dev["mode"] = "dev";
  const prod = Object.create(null) as Record<string, unknown>;
  prod["mode"] = "prod";

  expect(digestOfProps({ config: dev })).not.toBe(
    digestOfProps({ config: prod }),
  );
  expect(digestOfProps({ config: dev })).toBe(
    digestOfProps({ config: { mode: "dev" } }),
  );
});

test("a plain-object store carrying a primitive is read into, and that false positive is deliberate", () => {
  const store = {
    count: 0,
    inc(): void {
      this.count += 1;
    },
  };
  const freshlyLoaded = digestOfProps({ store });

  store.inc();

  expect(digestOfProps({ store })).not.toBe(freshlyLoaded);
});

test("a diverging object prop is reported by the name the site typed", () => {
  const loaded: readonly RootProvider[] = [
    { component: StoreProvider, props: { config: { mode: "prod" } } },
  ];

  expect(
    reports(() => {
      checkRootProviders(
        loaded,
        rootProviderStackDigest([
          { component: StoreProvider, props: { config: { mode: "dev" } } },
        ]),
      );
    })[0],
  ).toBe(
    [
      `Root providers: the stack this page was built with and the stack the browser imported are not one declaration, so every island root wraps in providers the markup it hydrates was not rendered with — write both halves of "build.rootProviders" from one import in pagedeck.config.ts, and compute no provider prop from a clock, an environment or a random value:`,
      `  built with 1 provider:`,
      `    stack[0] config=object#f0666347`,
      `  imported 1 provider:`,
      `    stack[0] config=object#735fd00b`,
    ].join("\n"),
  );
});

test("a prop that is itself a throwing getter still fails the build", () => {
  const props = {
    get config(): unknown {
      throw new Error("read me and the build stops");
    },
  };

  expect(() =>
    rootProviderStackDigest([{ component: StoreProvider, props }]),
  ).toThrow("read me and the build stops");
});
