// @vitest-environment jsdom
import { act, createContext, useContext, useId } from "react";
import type { ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clientReference } from "./client-reference.js";
import { renderPage } from "./render.js";
import type { RenderedIsland, RootProvider } from "./render.js";
import type { ComponentRegistry } from "@pagedeck/islands";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
declare const document: {
  createElement(tag: "div"): { innerHTML: string; remove(): void };
  body: { appendChild(node: unknown): void };
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
  vi.restoreAllMocks();
});

const PAGE = { locale: "en", path: "/signup" } as const;

const ThemeContext = createContext("light");

function ThemeProvider({
  theme,
  children,
}: {
  theme: string;
  children?: ReactNode;
}) {
  return <ThemeContext value={theme}>{children}</ThemeContext>;
}

const PROVIDERS: readonly RootProvider[] = [
  { component: ThemeProvider, props: { theme: "dark" } },
];

function SignupForm({ heading }: { heading: string }) {
  const emailId = useId();
  const listId = useId();
  const theme = useContext(ThemeContext);
  return (
    <form className={`signup signup--${theme}`}>
      <h2>{heading}</h2>
      <label htmlFor={emailId}>Email</label>
      <input id={emailId} name="email" />
      <label htmlFor={listId}>List</label>
      <input id={listId} name="list" />
    </form>
  );
}

const REGISTRY = {
  Page: { import: async () => ({ default: Shell }) },
  SignupForm: { import: async () => ({ default: SignupForm }) },
} satisfies ComponentRegistry;

function Shell({ children }: { children?: ReactNode }) {
  return <main>{children}</main>;
}

async function buildIsland(): Promise<RenderedIsland> {
  const { islands } = await renderPage({
    page: PAGE,
    tree: [
      {
        component: "Page",
        children: [
          { component: "SignupForm", props: { heading: "Stay in touch" } },
        ],
      },
    ],
    registry: REGISTRY,
    providers: PROVIDERS,
    modules: { SignupForm: { useClient: true } },
  });
  return islands[0] as RenderedIsland;
}

// React warns when two renderers share a context, as `prerender` and `hydrateRoot`
// do in one process here. Expected, and asserted rather than filtered.
const CROSS_RENDERER_ARTIFACT = "Detected multiple renderers";

interface Hydration {
  complaints: string[];
  setAside: string[];
  html: string;
}

function expectSetAsideArtifact(hydration: Hydration): void {
  expect(hydration.setAside).toHaveLength(1);
  expect(hydration.setAside[0]).toContain(CROSS_RENDERER_ARTIFACT);
}

async function hydrateIsland(
  island: RenderedIsland,
  prefix: string,
  clientTree: ReactNode,
): Promise<Hydration> {
  const container = document.createElement("div");
  container.innerHTML = island.html;
  document.body.appendChild(container);

  const lines: string[] = [];
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    });

  await act(async () => {
    hydrateRoot(container, clientTree, {
      identifierPrefix: prefix,
      onRecoverableError(error: unknown) {
        lines.push(String(error));
      },
    });
  });

  consoleError.mockRestore();
  const html = container.innerHTML;
  container.remove();
  return {
    complaints: lines.filter(
      (line) => !line.includes(CROSS_RENDERER_ARTIFACT),
    ),
    setAside: lines.filter((line) => line.includes(CROSS_RENDERER_ARTIFACT)),
    html,
  };
}

function clientRoot(heading = "Stay in touch"): ReactNode {
  return (
    <ThemeProvider theme="dark">
      <SignupForm heading={heading} />
    </ThemeProvider>
  );
}

// Ids, not markup: jsdom re-serialises `<input />` as `<input>`.
const idsIn = (markup: string): string[] =>
  [...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1] as string);

test("an island hydrates under its assigned prefix with no hydration errors", async () => {
  const island = await buildIsland();

  expect(island.html).toContain('class="signup signup--dark"');
  expect(island.html).toContain(island.prefix);

  const hydration = await hydrateIsland(island, island.prefix, clientRoot());
  const { complaints, html } = hydration;

  expectSetAsideArtifact(hydration);
  expect(complaints).toEqual([]);

  const serverIds = idsIn(island.html);
  expect(serverIds).toHaveLength(2);
  expect(serverIds.every((id) => id.includes(island.prefix))).toBe(true);
  expect(idsIn(html)).toEqual(serverIds);
});

test("hydrating the same HTML under a different prefix does mismatch", async () => {
  const island = await buildIsland();

  const hydration = await hydrateIsland(island, "iwrongprefix", clientRoot());

  expectSetAsideArtifact(hydration);
  expect(hydration.complaints.join("\n")).toMatch(/hydrat/i);
});

test("hydrating without the provider stack mismatches too", async () => {
  const island = await buildIsland();

  const hydration = await hydrateIsland(
    island,
    island.prefix,
    <SignupForm heading="Stay in touch" />,
  );

  expect(hydration.setAside).toEqual([]);
  expect(hydration.complaints.join("\n")).toMatch(/hydrat/i);
});

const ProxiedSignup = clientReference(SignupForm, {
  name: "SignupForm",
  mode: "load",
});

function ProxyTemplate({ headings }: { headings: readonly string[] }) {
  return (
    <main>
      {headings.map((heading) => (
        <ProxiedSignup key={heading} heading={heading} />
      ))}
    </main>
  );
}

const PROXY_REGISTRY = {
  ProxyTemplate: { import: async () => ({ default: ProxyTemplate }) },
} satisfies ComponentRegistry;

async function buildProxyIslands(
  headings: readonly string[],
): Promise<readonly RenderedIsland[]> {
  const { html, islands } = await renderPage({
    page: PAGE,
    template: "ProxyTemplate",
    props: { headings },
    registry: PROXY_REGISTRY,
    providers: PROVIDERS,
  });
  const markers = [...html.matchAll(/data-fw-prefix="([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
  expect(markers).toEqual(islands.map((island) => island.prefix));
  return islands;
}

test("a proxied instance hydrates under its assigned prefix with no hydration errors", async () => {
  const [island] = await buildProxyIslands(["Stay in touch"]);
  expect(island).toBeDefined();
  const proxied = island as RenderedIsland;

  expect(proxied.html).toContain('class="signup signup--dark"');
  expect(proxied.html).toContain(proxied.prefix);

  const hydration = await hydrateIsland(proxied, proxied.prefix, clientRoot());
  const { complaints, html } = hydration;

  expectSetAsideArtifact(hydration);
  expect(complaints).toEqual([]);

  const serverIds = idsIn(proxied.html);
  expect(serverIds).toHaveLength(2);
  expect(serverIds.every((id) => id.includes(proxied.prefix))).toBe(true);
  expect(idsIn(html)).toEqual(serverIds);
});

test("two proxied instances hydrated as separate roots get non-colliding useId values", async () => {
  const headings = ["First", "Second"];
  const islands = await buildProxyIslands(headings);
  expect(islands).toHaveLength(2);

  const hydratedIds: string[] = [];
  for (const [at, island] of islands.entries()) {
    const hydration = await hydrateIsland(
      island,
      island.prefix,
      clientRoot(headings[at]),
    );
    expect(hydration.complaints).toEqual([]);
    hydratedIds.push(...idsIn(hydration.html));
  }

  expect(hydratedIds).toHaveLength(4);
  expect(new Set(hydratedIds).size).toBe(4);
});

test("hydrating a proxied instance under a different prefix does mismatch", async () => {
  const [island] = await buildProxyIslands(["Stay in touch"]);
  const proxied = island as RenderedIsland;

  const hydration = await hydrateIsland(proxied, "iwrongprefix", clientRoot());

  expectSetAsideArtifact(hydration);
  expect(hydration.complaints.join("\n")).toMatch(/hydrat/i);
});
