import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterAll, expect, test } from "vitest";
import { build } from "vite";
import { renderPage } from "./render.js";
import { WORKER_SITE } from "@pagedeck/fixtures/render-worker";
import type { RenderRequest, RenderResponse } from "@pagedeck/fixtures/render-worker";

const WORKER_SOURCE = fileURLToPath(
  new URL("../../fixtures/src/render-worker.tsx", import.meta.url),
);

const WORKER_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-worker-test/", import.meta.url),
);
const WORKER_ENTRY = new URL("worker.mjs", `file://${WORKER_DIR}`);

afterAll(() => {
  rmSync(WORKER_DIR, { recursive: true, force: true });
});

const PAGES: readonly RenderRequest[] = ["en", "de", "fr"].flatMap((locale) => [
  {
    page: { locale, path: "/home" },
    tree: [
      {
        component: "Hero",
        props: { background: "gradient" },
        children: [
          { component: "Counter", props: { label: `Add (${locale})` } },
        ],
      },
      { component: "Counter", props: { label: "Buy" } },
    ],
    data: { stats: { users: 7 } },
    modules: { Counter: { useClient: true } },
  },
  {
    page: { locale, path: "/pricing" },
    tree: [
      { component: "Stats" },
      { component: "Counter", props: { label: "Compare" } },
    ],
    data: { stats: { users: 12 } },
    modules: { Counter: { useClient: true } },
  },
  {
    page: { locale, path: "/settings" },
    tree: [{ component: "Panel", props: { title: `Settings (${locale})` } }],
  },
]);

async function renderSerially(): Promise<RenderResponse[]> {
  const out: RenderResponse[] = [];
  for (const request of PAGES) {
    const { html, islands } = await renderPage({
      ...request,
      registry: WORKER_SITE.registry,
      providers: WORKER_SITE.providers,
    });
    out.push({ html, islands });
  }
  return out;
}

async function buildWorkerEntry(): Promise<void> {
  await build({
    configFile: false,
    logLevel: "warn",
    build: {
      ssr: true,
      outDir: WORKER_DIR,
      emptyOutDir: true,
      rollupOptions: {
        input: WORKER_SOURCE,
        output: { entryFileNames: "worker.mjs", format: "esm" },
      },
    },
    ssr: { noExternal: [/^@pagedeck\//] },
  });
}

function renderInWorker(requests: readonly RenderRequest[]): Promise<RenderResponse[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_ENTRY);
    const out: RenderResponse[] = [];
    worker.on("message", (response: RenderResponse & { error?: string }) => {
      if (response.error !== undefined) {
        void worker.terminate();
        reject(new Error(response.error));
        return;
      }
      out.push({ html: response.html, islands: response.islands });
      if (out.length === requests.length) {
        void worker.terminate().then(() => {
          resolve(out);
        });
        return;
      }
      worker.postMessage(requests[out.length]);
    });
    worker.on("error", reject);
    worker.postMessage(requests[0]);
  });
}

test("two workers rendering disjoint page sets match a serial render", async () => {
  const serial = await renderSerially();
  await buildWorkerEntry();

  const even = PAGES.filter((_, at) => at % 2 === 0);
  const odd = PAGES.filter((_, at) => at % 2 === 1);
  const [fromEven, fromOdd] = await Promise.all([
    renderInWorker(even),
    renderInWorker(odd),
  ]);

  const parallel = PAGES.map((_, at) =>
    at % 2 === 0
      ? (fromEven[at / 2] as RenderResponse)
      : (fromOdd[(at - 1) / 2] as RenderResponse),
  );

  expect(parallel).toEqual(serial);

  expect(serial[0]?.islands).toHaveLength(2);
  const proxied = serial[2] as RenderResponse;
  expect(proxied.islands.map((island) => island.component)).toEqual([
    "Toggle",
    "Toggle",
  ]);
  expect(proxied.islands.every((island) => island.path === undefined)).toBe(true);
  expect(new Set(serial.map((page) => page.html)).size).toBe(PAGES.length);
  const prefixes = serial.flatMap((page) =>
    page.islands.map((island) => island.prefix),
  );
  expect(new Set(prefixes).size).toBe(prefixes.length);
}, 60_000);
