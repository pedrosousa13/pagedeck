import { execFile, spawn } from "node:child_process";
import { readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import type { Browser, Page as BrowserPage } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CONSENT_EVENT, CONSENT_GLOBAL, readManifest } from "@pagedeck/core";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");
/** Inside the package, so the spawned `pagedeck` resolves `@pagedeck/script-worker` by name. */
const SITE = join(PACKAGE, ".pagedeck-consent-worker-harness");
/** The executable and the adapter as they ship: build first. */
const BIN = join(PACKAGE, "..", "core", "dist", "bin.js");

/** `pixel` is categorized and held; `tags` is not, and shows the worker is running. */
const SCRIPTS = ["tags", "pixel"] as const;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

interface Served {
  readonly origin: string;
  readonly server: Server;
}

function listen(server: Server, host: string): Promise<Served> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ origin: `http://${host}:${String(port)}`, server });
    });
  });
}

function close(served: Served | undefined): Promise<void> {
  return new Promise((done) => {
    if (served === undefined) done();
    else served.server.close(() => done());
  });
}

/** Every request the vendor origin answered, in order: a script fetch or a report from inside it. */
const vendorRequests: string[] = [];

/** `localhost` against the site's `127.0.0.1`: another origin, as a vendor's is. */
function serveVendor(): Promise<Served> {
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    vendorRequests.push(`${url.pathname}${url.search}`);
    response.setHeader("access-control-allow-origin", "*");
    const name = SCRIPTS.find((script) => url.pathname === `/${script}.js`);
    if (name !== undefined) {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(
        `(function(){var where=typeof DedicatedWorkerGlobalScope==="function"?"worker":"main";fetch(${JSON.stringify(`${origin}/hit?script=${name}&where=`)}+where)})();\n`,
      );
      return;
    }
    response.statusCode = url.pathname === "/hit" ? 204 : 404;
    response.end();
  });
  return listen(server, "localhost").then((served) => {
    origin = served.origin;
    return served;
  });
}

function serveSite(dist: string, files: ReadonlySet<string>): Promise<Served> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const file = path === "/" ? "/index.html" : path;
    const type = CONTENT_TYPES[extname(file)];
    if (!files.has(file) || type === undefined) {
      response.statusCode = 404;
      response.end(`Consent worker harness: the build emitted no file at ${path}`);
      return;
    }
    response.setHeader("content-type", type);
    response.end(readFileSync(join(dist, file)));
  });
  return listen(server, "127.0.0.1");
}

function writeSite(vendor: string): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "components"), { recursive: true });
  writeFileSync(
    join(SITE, "components", "Prose.js"),
    'export default function Prose() { return "marker-prose-consent-worker"; }\n',
  );
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, defineScripts, fromCollection } from "@pagedeck/core";
import { definePartytown } from "@pagedeck/script-worker";

const upsert = (writer) => {
  writer.upsert({ locale: "en", path: "home", data: {} });
  return { changed: [{ locale: "en", path: "home" }], deleted: [], cursor: 1 };
};

const pages = {
  name: "pages",
  schema: false,
  loader: {
    syncAll: upsert,
    syncSince: (writer, cursor) =>
      cursor >= 1 ? { changed: [], deleted: [], cursor: 1 } : upsert(writer),
    fetchOne: () => ({}),
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    scripts: defineScripts({
      scripts: [
        { name: "tags", src: ${JSON.stringify(`${vendor}/tags.js`)} },
        {
          name: "pixel",
          src: ${JSON.stringify(`${vendor}/pixel.js`)},
          category: "analytics",
          attributes: { "data-site": "harness" },
        },
        {
          name: "embed",
          src: ${JSON.stringify(`${vendor}/embed.js`)},
          strategy: "facade",
          facade: { html: ${JSON.stringify(`<script>${forwardedCall("body")}</script>`)} },
        },
      ],
      runtime: definePartytown({ forward: ["dataLayer.push"] }),
    }),
    prePaint: [${JSON.stringify(forwardedCall("pre-paint"))}],
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "English", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: { Prose: "./components/Prose.js" },
    content: () => ({ tree: [{ component: "Prose" }] }),
  },
});
`,
  );
}

/** Counts only a call that returned: one that threw leaves the count where it was (#283). */
function forwardedCall(caller: string): string {
  return `dataLayer.push({ event: ${JSON.stringify(caller)} });window.forwardedCalls=(window.forwardedCalls||0)+1;`;
}

async function run(verb: string): Promise<void> {
  await execFileAsync(process.execPath, [BIN, verb], { cwd: SITE });
}

/** `pagedeck dev` over the same site, which serves the runtime's files itself (#282). */
async function startDev(): Promise<{ origin: string; stop(): Promise<void> }> {
  const child = spawn(process.execPath, [BIN, "dev", "--port", "0"], { cwd: SITE });
  const stop = (): Promise<void> =>
    new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done();
      else {
        child.on("exit", () => done());
        child.kill("SIGTERM");
      }
    });
  const origin = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
      const found = /at (http:\/\/[^\s]+)/.exec(out);
      if (found !== null) resolve(found[1] as string);
    });
    child.on("exit", (code) => {
      reject(
        new Error(
          `Consent worker harness: pagedeck dev exited with ${String(code)} before it was listening — it wrote:\n${out}`,
        ),
      );
    });
  });
  return { origin, stop };
}

let browser: Browser;
let vendor: Served | undefined;
let site: Served | undefined;
let document: string;

beforeAll(async () => {
  vendor = await serveVendor();
  writeSite(vendor.origin);
  await run("sync");
  await run("build");

  const dist = join(SITE, "dist");
  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  const page = manifest.pages[0];
  if (page === undefined) {
    throw new Error(
      `Consent worker harness: the build of "${SITE}" routed no page, so there is no document to drive — check the fixture's collection still resolves an entry`,
    );
  }
  document = readFileSync(join(dist, page.html), "utf8");
  const files = new Set(manifest.files.map((file) => `/${file.path.replace(/^\//, "")}`));
  files.add(`/${page.html.replace(/^\//, "")}`);
  site = await serveSite(dist, files);

  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await close(site);
  await close(vendor);
  rmSync(SITE, { recursive: true, force: true });
});

async function open(
  grantedAtLoad = false,
  at: string = site?.origin ?? "",
): Promise<{ page: BrowserPage; errors: string[]; finish(): Promise<void> }> {
  vendorRequests.length = 0;
  const context = await browser.newContext();
  const page = await context.newPage();
  if (grantedAtLoad) {
    await page.addInitScript(
      `window[${JSON.stringify(CONSENT_GLOBAL)}]={granted:function(){return true}}`,
    );
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${at}/`);
  return { page, errors, finish: () => context.close() };
}

async function consent(page: BrowserPage, granted: boolean): Promise<void> {
  await page.addScriptTag({
    content:
      `window[${JSON.stringify(CONSENT_GLOBAL)}]=` +
      `{granted:function(){return ${String(granted)}}};` +
      `window.dispatchEvent(new Event(${JSON.stringify(CONSENT_EVENT)}))`,
  });
}

function requested(name: string): string[] {
  return vendorRequests.filter(
    (request) => request === `/${name}.js` || request.startsWith(`/hit?script=${name}&`),
  );
}

/** The uncategorized script has run in the worker, so Partytown has had its chance at every typed script. */
async function workerRan(): Promise<void> {
  await expect
    .poll(() => requested("tags"), { timeout: 30_000 })
    .toContain("/hit?script=tags&where=worker");
}

test("the built page carries the held script in the loader and nowhere Partytown reads", () => {
  expect(document).toContain('<script type="text/partytown" src="http://localhost:');
  expect(document).not.toMatch(/<script[^>]*pixel\.js/);
  expect(document).toContain('"analytics",0]');
});

test("the snippet is in the <head>, ahead of the pre-paint script and the body's inline call", () => {
  const head = document.slice(0, document.indexOf("</head>"));
  const snippet = head.search(/<script>[^<]*serviceWorker/);
  expect(snippet).toBeGreaterThan(-1);
  expect(snippet).toBeLessThan(head.indexOf(forwardedCall("pre-paint")));
  expect(document.indexOf(forwardedCall("body"))).toBeGreaterThan(document.indexOf("<body>"));
});

test("a forwarded function exists for the pre-paint script and an inline call in the body", async () => {
  const { page, errors, finish } = await open();
  await workerRan();

  expect(await page.evaluate(() => (globalThis as { forwardedCalls?: number }).forwardedCalls)).toBe(2);
  expect(errors).toEqual([]);
  await finish();
});

test("before a grant the held script makes no request and is not in the document", async () => {
  const { page, errors, finish } = await open();

  await workerRan();
  await page.waitForTimeout(1_000);

  expect(requested("pixel")).toEqual([]);
  expect(await page.locator('script[src$="/pixel.js"]').count()).toBe(0);
  expect(errors).toEqual([]);
  await finish();
});

test("a grant appends the held script for Partytown, and it runs in the worker", async () => {
  const { page, errors, finish } = await open();
  await workerRan();
  expect(requested("pixel")).toEqual([]);

  await consent(page, true);

  await expect
    .poll(() => requested("pixel"), { timeout: 30_000 })
    .toContain("/hit?script=pixel&where=worker");
  expect(requested("pixel")).not.toContain("/hit?script=pixel&where=main");
  const held = page.locator('script[src$="/pixel.js"]');
  // Partytown retypes a script it has run.
  expect(await held.getAttribute("type")).toBe("text/partytown-x");
  expect(await held.getAttribute("data-site")).toBe("harness");
  expect(errors).toEqual([]);
  await finish();
});

test("a denial never loads the held script, however often it is answered again", async () => {
  const { page, errors, finish } = await open();
  await workerRan();

  await consent(page, false);
  await page.waitForTimeout(1_000);
  await consent(page, false);
  await page.waitForTimeout(1_000);

  expect(requested("pixel")).toEqual([]);
  expect(await page.locator('script[src$="/pixel.js"]').count()).toBe(0);
  expect(errors).toEqual([]);
  await finish();
});

test("a category granted when the page loads runs the held script in the worker, though the runtime is not listening yet", async () => {
  const { page, errors, finish } = await open(true);

  await expect
    .poll(() => requested("pixel"), { timeout: 30_000 })
    .toContain("/hit?script=pixel&where=worker");
  expect(requested("pixel")).not.toContain("/hit?script=pixel&where=main");
  expect(await page.locator('script[src$="/pixel.js"]').getAttribute("type")).toBe(
    "text/partytown-x",
  );
  expect(errors).toEqual([]);
  await finish();
});

test("under pagedeck dev, Partytown registers its service worker and the worker script reports from the worker", async () => {
  const dev = await startDev();
  try {
    const { page, errors, finish } = await open(false, dev.origin);
    await workerRan();

    expect(requested("tags")).not.toContain("/hit?script=tags&where=main");
    const lib = await page.evaluate(
      () => (globalThis as { partytown?: { lib?: string } }).partytown?.lib ?? "",
    );
    expect(lib).toMatch(/^\/script-runtime\/[0-9a-f]{8}\/$/);
    const scopes = await page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistrations()).map(
        (registration) => new URL(registration.scope).pathname,
      ),
    );
    expect(scopes).toEqual([lib]);
    expect(errors).toEqual([]);
    await finish();
  } finally {
    await dev.stop();
  }
}, 120_000);
