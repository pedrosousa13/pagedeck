// @vitest-environment jsdom
import {
  Children,
  createContext,
  createElement,
  use,
  useContext,
  useState,
} from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { expect, test, vi, beforeEach } from "vitest";
import { renderPage, RenderError } from "@pagedeck/core";
import { unescapedHtml } from "@pagedeck/core/tree";
import type { EntryNode } from "@pagedeck/core";
import type { ComponentRegistry, ModuleFacts } from "@pagedeck/islands";
import { readDraft, PreviewDraftError } from "./draft.js";
import { mountPreview, PREVIEW_ATTRIBUTE, PREVIEW_MARK } from "./mount.js";
import { PreviewParityError } from "./parity.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface TestElement {
  innerHTML: string;
  readonly childNodes: ArrayLike<TestNode>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  replaceWith(...nodes: TestNode[]): void;
  remove(): void;
  querySelector(selectors: string): TestElement | null;
  querySelectorAll(selectors: string): ArrayLike<TestElement>;
}

type TestNode = TestElement | { readonly nodeType: number };

interface TestDocument {
  body: TestElement & { appendChild(node: TestElement): void };
  createElement(tag: string): TestElement;
}

declare const document: TestDocument;

function Layout({ children }: { children?: ReactNode }): ReactNode {
  return createElement("section", null, children);
}

function Card({
  title,
  children,
}: {
  title?: string;
  children?: ReactNode;
}): ReactNode {
  return createElement(
    "div",
    { className: "card" },
    createElement("h2", null, title),
    children,
  );
}

function Body({ text }: { text?: string }): ReactNode {
  return createElement("p", null, text);
}

function Counter({ children }: { children?: ReactNode }): ReactNode {
  return createElement(
    "div",
    { "data-count": String(Children.count(children)) },
    children,
  );
}

function Cloner({ children }: { children?: ReactNode }): ReactNode {
  return createElement(
    "div",
    null,
    Children.map(children, (child) => {
      const element = child as unknown as {
        type: never;
        props: Record<string, unknown>;
      };
      return createElement(element.type, { ...element.props, injected: true });
    }),
  );
}

function Twice({ children }: { children?: ReactNode }): ReactNode {
  return createElement("div", null, children, children);
}

const Ambient = createContext("from-nowhere");

function Ambience({ children }: { children?: ReactNode }): ReactNode {
  return createElement(
    "div",
    null,
    createElement(Ambient.Provider, { value: "from-container" }, children),
  );
}

function Reader(): ReactNode {
  return createElement("p", null, useContext(Ambient));
}

let bump: (() => void) | undefined;

function Bumper({ children }: { children?: ReactNode }): ReactNode {
  const [count, setCount] = useState(0);
  bump = () => {
    setCount((was) => was + 1);
  };
  return createElement("div", { "data-bumped": String(count) }, children);
}

let counted = 0;

function Counted(): ReactNode {
  counted += 1;
  return createElement("p", null, "slotted");
}

function Fetcher(): ReactNode {
  use(new Promise<void>(() => undefined));
  return createElement("p", null, "never");
}

function Rich({ body }: { body?: string }): ReactNode {
  return createElement("div", {
    className: "rich",
    ...unescapedHtml(body ?? ""),
  });
}

const registry: ComponentRegistry = {
  Layout: { import: () => Promise.resolve({ default: Layout }) },
  Card: { import: () => Promise.resolve({ default: Card }) },
  Body: { import: () => Promise.resolve({ default: Body }) },
  Counter: { import: () => Promise.resolve({ default: Counter }) },
  Cloner: { import: () => Promise.resolve({ default: Cloner }) },
  Twice: { import: () => Promise.resolve({ default: Twice }) },
  Ambience: { import: () => Promise.resolve({ default: Ambience }) },
  Reader: { import: () => Promise.resolve({ default: Reader }) },
  Bumper: { import: () => Promise.resolve({ default: Bumper }) },
  Counted: { import: () => Promise.resolve({ default: Counted }) },
  Rich: { import: () => Promise.resolve({ default: Rich }) },
  Fetcher: { import: () => Promise.resolve({ default: Fetcher }) },
};

const modules: Record<string, ModuleFacts> = {
  Card: { useClient: true },
  Counter: { useClient: true },
  Cloner: { useClient: true },
  Twice: { useClient: true },
  Ambience: { useClient: true },
  Bumper: { useClient: true },
};

const page = { locale: "en", path: "/home" } as const;

const tree: readonly EntryNode[] = [
  {
    component: "Layout",
    children: [
      {
        component: "Card",
        props: { title: "Hello" },
        children: [{ component: "Body", props: { text: "draft copy" } }],
      },
    ],
  },
];

beforeEach(() => {
  // Off: `act` would take over React's uncaught-error path, which is the path under test.
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  document.body.innerHTML = "";
});

// Draining microtasks is enough: every await is on a settled promise, and the commit is
// synchronous.
async function settled(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

function container(): TestElement {
  const element = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(element);
  return element;
}

// Parsed, not string-edited, and applied to both sides: preview renders an `<fw-slot>` too.
function withoutMarkers(html: string): string {
  const host = document.createElement("div");
  host.innerHTML = html;
  for (const stash of Array.from(host.querySelectorAll("template"))) {
    stash.remove();
  }
  for (;;) {
    const markers = Array.from(host.querySelectorAll("fw-island, fw-slot"));
    if (markers.length === 0) break;
    for (const marker of markers) {
      marker.replaceWith(...Array.from(marker.childNodes));
    }
  }
  return host.innerHTML;
}

test("a draft renders client-side into the DOM the static build of it produces", async () => {
  const built = await renderPage({ page, tree, registry, modules });
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });

  await preview.render({ page, tree });

  expect(withoutMarkers(into.innerHTML)).toBe(withoutMarkers(built.html));
  expect(built.islands.map((island) => island.component)).toStrictEqual(["Card"]);
  expect(into.getAttribute(PREVIEW_ATTRIBUTE)).toBe(PREVIEW_MARK);
  preview.stop();
});

test("a bridge event re-renders in place, with no reload and no remount", async () => {
  let publish: ((payload: unknown) => void) | undefined;
  const stopped = vi.fn();
  const bridge = {
    subscribe(onDraft: (payload: unknown) => void) {
      publish = onDraft;
      return stopped;
    },
  };
  const into = container();
  const preview = mountPreview({ registry, modules, container: into, bridge });

  await preview.render({ page, tree });
  const card = into.querySelector("div.card");
  expect(card?.querySelector("h2")?.innerHTML).toBe("Hello");

  const edited: readonly EntryNode[] = [
    {
      component: "Layout",
      children: [
        {
          component: "Card",
          props: { title: "Edited" },
          children: [{ component: "Body", props: { text: "draft copy" } }],
        },
      ],
    },
  ];
  publish?.({ page, tree: edited });
  await settled();

  expect(into.querySelector("h2")?.innerHTML).toBe("Edited");
  expect(into.querySelector("div.card")).toBe(card);

  preview.stop();
  expect(stopped).toHaveBeenCalledOnce();
});

test("a draft naming an unregistered component is refused, not invoked", async () => {
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  await expect(
    preview.render({
      page,
      tree: [{ component: "constructor" }],
    }),
  ).rejects.toThrow(
    'Component "constructor": not registered, and entry /en/home references it',
  );
  preview.stop();
});

test("a draft prop the framework refuses fails with the build's own message", async () => {
  const refused: readonly EntryNode[] = [
    {
      component: "Body",
      props: { dangerouslySetInnerHTML: { __html: "<script>x</script>" } },
    },
  ];
  const built = await renderPage({ page, tree: refused, registry, modules }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  const previewed = await preview.render({ page, tree: refused }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

  expect(previewed?.message).toBe(built?.message);
  expect(previewed?.message).toContain(
    'Component "Body": prop "dangerouslySetInnerHTML" is a name the framework refuses',
  );
  preview.stop();
});

test("a draft locale that does not name its own code is refused", () => {
  const thrown = (() => {
    try {
      readDraft({
        page,
        locale: { label: "English", direction: "ltr", prefix: "" },
        tree: [{ component: "Body" }],
      });
    } catch (error) {
      return error as PreviewDraftError;
    }
    return undefined;
  })();

  expect(thrown?.message).toBe(
    "Preview draft: locale.code — is not a locale code — send the entry as the CMS holds it, or fix the bridge that shaped it",
  );
});

test("a draft locale that is not the page's own is refused, as a build refuses it", async () => {
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });

  const refused = preview.render({
    page,
    locale: { code: "ar", label: "العربية", direction: "rtl", prefix: "/ar" },
    tree: [{ component: "Body", props: { text: "draft copy" } }],
  });

  await expect(refused).rejects.toThrow(
    new RenderError(
      'Locale "ar": is not entry /en/home\'s locale, which is "en" — pass the locale the set defineLocales() returned under "en"',
    ),
  );
  await expect(refused).rejects.toBeInstanceOf(RenderError);

  preview.stop();
});

test("a payload that is not a draft reports every fault at once", () => {
  const thrown = (() => {
    try {
      readDraft({ page: { locale: 1 }, data: 7, tree: [{ props: {} }] });
    } catch (error) {
      return error as PreviewDraftError;
    }
    return undefined;
  })();

  expect(thrown).toBeInstanceOf(PreviewDraftError);
  expect(thrown?.faults).toStrictEqual([
    "page.locale — is not a locale code",
    "page.path — is not a route, which leads with \"/\" — root the store's entry id, as \"/home\"",
    "data — is not an object of build data",
    "tree[0].component — is not a registered component's name",
  ]);
  expect(thrown?.message).toBe(
    [
      "Preview draft: 4 fields are not what a draft entry carries — send the entry as the CMS holds it, or fix the bridge that shaped it:",
      "  page.locale — is not a locale code",
      "  page.path — is not a route, which leads with \"/\" — root the store's entry id, as \"/home\"",
      "  data — is not an object of build data",
      "  tree[0].component — is not a registered component's name",
    ].join("\n"),
  );
});

test("a page path with no leading slash is refused, not rendered", () => {
  const thrown = (() => {
    try {
      readDraft({ page: { locale: "en", path: "home" }, tree: [] });
    } catch (error) {
      return error as PreviewDraftError;
    }
    return undefined;
  })();

  expect(thrown?.faults).toStrictEqual([
    'page.path — is not a route, which leads with "/" — root the store\'s entry id, as "/home"',
  ]);
});

test("a report reads the tree in the order the content was written", () => {
  const thrown = (() => {
    try {
      readDraft({
        page,
        tree: [
          { component: 1 },
          { component: "Layout", children: [{ component: 2 }, { component: 3 }] },
          { component: 4 },
        ],
      });
    } catch (error) {
      return error as PreviewDraftError;
    }
    return undefined;
  })();

  expect(thrown?.faults).toStrictEqual([
    "tree[0].component — is not a registered component's name",
    "tree[1].children[0].component — is not a registered component's name",
    "tree[1].children[1].component — is not a registered component's name",
    "tree[2].component — is not a registered component's name",
  ]);
});

test("one fault keeps its own sentence", () => {
  expect(() => readDraft({ page })).toThrow(
    "Preview draft: tree — is missing, and no template is named either — send the entry as the CMS holds it, or fix the bridge that shaped it",
  );
});

test("a container counts its slotted children the way production lets it", async () => {
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  await preview.render({
    page,
    tree: [
      {
        component: "Counter",
        children: [
          { component: "Body", props: { text: "a" } },
          { component: "Body", props: { text: "b" } },
        ],
      },
    ],
  });
  expect(into.querySelector("div")?.getAttribute("data-count")).toBe("2");
  preview.stop();
});

const cloned = {
  page,
  tree: [
    {
      component: "Cloner",
      children: [{ component: "Body", props: { text: "a" } }],
    },
  ],
};

test("a container that injects props into a slotted child is refused", async () => {
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });

  const refusal = await preview.render(cloned).then(
    () => undefined,
    (error: unknown) => error as PreviewParityError,
  );
  expect(refusal).toBeInstanceOf(PreviewParityError);
  expect(refusal?.message).toBe(
    'Component "Cloner": gives slotted child 0 props it cannot receive (injected) — slotted content is one node of already-rendered HTML that hydration adopts in place, so there is no element inside it for cloneElement to give props to and it can never re-render; position, wrap, show, hide and reorder it instead',
  );
  expect(into.querySelector("p")).toBeNull();
  preview.stop();
});

test("a refusal a render-phase throw makes still reaches a bridge's onError", async () => {
  let publish: ((payload: unknown) => void) | undefined;
  const bridge = {
    subscribe(onDraft: (payload: unknown) => void) {
      publish = onDraft;
      return () => undefined;
    },
  };
  const into = container();
  let seen: (error: unknown) => void = () => undefined;
  const reported = new Promise<unknown>((settle) => {
    seen = settle;
  });
  const preview = mountPreview({
    registry,
    modules,
    container: into,
    bridge,
    onError: seen,
  });

  publish?.(cloned);

  expect(await reported).toBeInstanceOf(PreviewParityError);
  preview.stop();
});

test("a container that renders one slotted child twice is refused, as the build refuses it", async () => {
  const twice = {
    page,
    tree: [
      {
        component: "Twice",
        children: [{ component: "Body", props: { text: "a" } }],
      },
    ],
  };
  const built = await renderPage({
    page,
    tree: twice.tree as readonly EntryNode[],
    registry,
    modules,
  }).then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  expect(built?.message).toContain(
    'Component "Twice": renders slotted child 0 ("Body") 2 times',
  );

  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  const refusal = await preview.render(twice).then(
    () => undefined,
    (error: unknown) => error as PreviewParityError,
  );
  expect(refusal).toBeInstanceOf(PreviewParityError);
  expect(refusal?.message).toBe(
    'Component "Twice": mounts slotted child 0 in two places at once — slotted content is one node of already-rendered HTML that hydration adopts in place, so a second copy has no DOM of its own and the client moves the first one rather than repeating it; render each slotted child at most once',
  );
  preview.stop();
});

test("context a container provides does not reach its slotted children", async () => {
  const ambient: readonly EntryNode[] = [
    { component: "Ambience", children: [{ component: "Reader" }] },
  ];
  const built = await renderPage({ page, tree: ambient, registry, modules });
  expect(built.html).toContain("from-nowhere");

  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  await preview.render({ page, tree: ambient });

  expect(withoutMarkers(into.innerHTML)).toBe(withoutMarkers(built.html));
  expect(into.querySelector("p")?.innerHTML).toBe("from-nowhere");
  preview.stop();
});

test("a draft that suspends is refused, not left showing a fallback", async () => {
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  const refusal = await preview.render({
    page,
    tree: [{ component: "Fetcher" }],
  }).then(
    () => undefined,
    (error: unknown) => error as PreviewParityError,
  );

  expect(refusal).toBeInstanceOf(PreviewParityError);
  expect(refusal?.message).toContain(
    "Preview draft: a component suspended on data the framework did not resolve",
  );
  preview.stop();
});

test("a container cannot re-render its slotted children", async () => {
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  counted = 0;
  await preview.render({
    page,
    tree: [{ component: "Bumper", children: [{ component: "Counted" }] }],
  });
  expect(counted).toBe(1);

  flushSync(() => {
    bump?.();
  });

  expect(into.querySelector("div")?.getAttribute("data-bumped")).toBe("1");
  expect(counted).toBe(1);
  expect(into.querySelector("p")?.innerHTML).toBe("slotted");
  preview.stop();
});

test("a draft's rich text cannot mint a marker preview would honour", async () => {
  const forged: readonly EntryNode[] = [
    {
      component: "Rich",
      props: {
        body: '<fw-island data-fw-component="Cloner"><fw-slot data-fw-slot="0.0"></fw-slot></fw-island><em>copy &amp; paste</em>',
      },
    },
  ];
  const built = await renderPage({ page, tree: forged, registry, modules });
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  await preview.render({ page, tree: forged });

  expect(withoutMarkers(into.innerHTML)).toBe(withoutMarkers(built.html));
  expect(into.querySelectorAll("fw-island").length).toBe(0);
  expect(into.querySelectorAll("fw-slot").length).toBe(0);
  expect(into.querySelector("em")?.innerHTML).toBe("copy &amp; paste");
});

test("a draft prop that is text stays text on both sides", async () => {
  const scripted: readonly EntryNode[] = [
    { component: "Body", props: { text: '<script>alert("x")</script>' } },
  ];
  const built = await renderPage({ page, tree: scripted, registry, modules });
  const into = container();
  const preview = mountPreview({ registry, modules, container: into });
  await preview.render({ page, tree: scripted });

  expect(withoutMarkers(into.innerHTML)).toBe(withoutMarkers(built.html));
  expect(into.querySelectorAll("script").length).toBe(0);
});

test("a wired bridge is not a licence to decorate the draft", async () => {
  const bridge = { subscribe: () => () => undefined };
  const into = container();
  const preview = mountPreview({ registry, modules, container: into, bridge });

  await preview.render({
    page,
    tree: [
      {
        component: "Body",
        props: { text: "draft copy" },
        ...{ sourceId: "uid-body" },
      },
    ],
  });

  expect(into.innerHTML).toBe("<p>draft copy</p>");
  preview.stop();
});

test("PreviewParityError is what a forbidden slot operation throws", () => {
  expect(new PreviewParityError("x")).toBeInstanceOf(Error);
  expect(new PreviewParityError("x").name).toBe("PreviewParityError");
});
