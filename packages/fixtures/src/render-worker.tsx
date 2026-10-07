// Not exported from the package index: importing this inside a worker thread attaches
// a `message` listener.
import { useId } from "react";
import type { ReactNode } from "react";
import { parentPort } from "node:worker_threads";
import type { ModuleFacts, PageContext } from "@pagedeck/islands";
import { clientReference, renderPage, useBuildData } from "@pagedeck/core";
import type { EntryNode, RenderedIsland, RootProvider } from "@pagedeck/core";

export interface RenderRequest {
  page: PageContext;
  tree: readonly EntryNode[];
  data?: Readonly<Record<string, unknown>>;
  modules?: Readonly<Record<string, ModuleFacts>>;
}

export interface RenderResponse {
  html: string;
  islands: readonly RenderedIsland[];
  error?: string;
}

function Hero({
  background,
  children,
}: {
  background: string;
  children?: ReactNode;
}) {
  return <section className={`hero hero--${background}`}>{children}</section>;
}

function Counter({ label }: { label: string }) {
  const id = useId();
  return (
    <button className="counter" id={id}>
      {label}
    </button>
  );
}

function Stats() {
  const stats = useBuildData<{ users: number }>("stats");
  return <p className="stats">{`${stats.users} users`}</p>;
}

function Toggle({ on }: { on: boolean }) {
  const id = useId();
  return <input className="toggle" id={id} type="checkbox" defaultChecked={on} />;
}

const ProxiedToggle = clientReference(Toggle, { name: "Toggle", mode: "idle" });

function Panel({ title }: { title: string }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      <ProxiedToggle on />
      <ProxiedToggle on={false} />
    </section>
  );
}

function ThemeProvider({
  theme,
  children,
}: {
  theme: string;
  children?: ReactNode;
}) {
  return <div data-theme={theme}>{children}</div>;
}

export const WORKER_SITE = {
  registry: {
    Hero: { import: async () => ({ default: Hero }) },
    Counter: { import: async () => ({ default: Counter }) },
    Stats: { import: async () => ({ default: Stats }) },
    Panel: { import: async () => ({ default: Panel }) },
  },
  providers: [
    { component: ThemeProvider, props: { theme: "dark" } },
  ] as readonly RootProvider[],
};

// `parentPort` is null on the main thread, where the test imports `WORKER_SITE`.
parentPort?.on("message", (request: RenderRequest) => {
  const port = parentPort;
  if (port === null) return;
  renderPage({
    ...request,
    registry: WORKER_SITE.registry,
    providers: WORKER_SITE.providers,
  }).then(
    ({ html, islands }) => {
      port.postMessage({ html, islands });
    },
    (error: unknown) => {
      port.postMessage({ error: (error as Error).message });
    },
  );
});
