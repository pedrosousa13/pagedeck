import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser, Page as BrowserPage } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CONSENT_ATTRIBUTE, CONSENT_EVENT, CONSENT_GLOBAL } from "./consent.js";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const SITE = fileURLToPath(
  new URL("../node_modules/.pagedeck-consent-facade-harness", import.meta.url),
);

const CHAT_SRC = "https://vendor.example/chat.js";
const VIDEO_SRC = "https://vendor.example/video.js";

const PAGE_URL = "https://consent-facade.harness.invalid/";

function writeSite(root: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(
    join(root, "components", "Copy.js"),
    `export default function Copy() { return "marker-copy-consent-facade"; }\n`,
  );
  const entry = join(root, "content", "en", "home.json");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `${JSON.stringify({ rev: 1, data: { title: "home" } })}\n`);

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { defineScripts } from ${JSON.stringify(join(CORE, "scripts.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const usage = (component) => [
  { component, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
  templates: {
    templateOf: () => "landing",
    byTemplate: { landing: usage("Copy") },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    scripts: defineScripts({
      scripts: [
        {
          name: "chat",
          src: ${JSON.stringify(CHAT_SRC)},
          strategy: "facade",
          category: "marketing",
          facade: { html: '<button id="chat">Chat</button>' },
        },
        {
          name: "video",
          src: ${JSON.stringify(VIDEO_SRC)},
          strategy: "facade",
          facade: { html: '<button id="video">Play</button>' },
        },
      ],
    }),
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: {
      Copy: "./components/Copy.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
}

async function run(cwd: string, ...argv: string[]): Promise<void> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) {
    throw new Error(
      `Consent facade harness: pagedeck ${argv.join(" ")} failed in "${cwd}" — ${err.join("\n")}`,
    );
  }
}

let browser: Browser;
let document: string;
let files: Map<string, Buffer>;

beforeAll(async () => {
  writeSite(SITE);
  await run(SITE, "sync");
  await run(SITE, "build");

  const dist = join(SITE, "dist");
  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  const page = manifest.pages[0];
  if (page === undefined) {
    throw new Error(
      `Consent facade harness: the build of "${SITE}" routed no page, so there is no document to drive — check the fixture's collection still resolves an entry`,
    );
  }
  document = readFileSync(join(dist, page.html), "utf8");
  files = new Map(
    manifest.files.map((file) => [`/${file.path}`, readFileSync(join(dist, file.path))]),
  );

  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  rmSync(SITE, { recursive: true, force: true });
});

async function open(): Promise<{
  page: BrowserPage;
  requested: string[];
  errors: string[];
}> {
  const page = await browser.newPage();
  const requested: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url === CHAT_SRC || url === VIDEO_SRC) {
      requested.push(url);
      await route.fulfill({
        contentType: "text/javascript; charset=utf-8",
        body: "/* the vendor, stubbed */",
      });
      return;
    }
    if (url === PAGE_URL) {
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: document,
      });
      return;
    }
    const contents = files.get(new URL(url).pathname);
    if (contents === undefined) {
      await route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: `Consent facade harness: the build emitted no file at ${url}`,
      });
      return;
    }
    await route.fulfill({ body: contents });
  });

  await page.goto(PAGE_URL);
  return { page, requested, errors };
}

function state(page: BrowserPage, control: string): Promise<string | null> {
  return page
    .locator(`[data-fw-facade]:has(#${control})`)
    .getAttribute(CONSENT_ATTRIBUTE);
}

async function consent(page: BrowserPage, granted: boolean): Promise<void> {
  await page.addScriptTag({
    content:
      `window[${JSON.stringify(CONSENT_GLOBAL)}]=` +
      `{granted:function(){return ${String(granted)}}};` +
      `window.dispatchEvent(new Event(${JSON.stringify(CONSENT_EVENT)}))`,
  });
}

test("the built document carries the state on the gated facade and on no other", () => {
  expect(document).toContain(`${CONSENT_ATTRIBUTE}="denied"`);
  expect(document).not.toContain(`${CONSENT_ATTRIBUTE}="granted"`);
  expect(document.split(`${CONSENT_ATTRIBUTE}="`)).toHaveLength(2);
});

test("a press under a denied category makes no request, and the state says why", async () => {
  const { page, requested, errors } = await open();

  expect(await state(page, "chat")).toBe("denied");
  expect(await state(page, "video")).toBeNull();

  await page.locator("#chat").click();

  expect(requested).toEqual([]);
  expect(await page.locator("#chat").count()).toBe(1);
  expect(await state(page, "chat")).toBe("denied");

  expect(errors).toEqual([]);
  await page.close();
});

test("a consent change moves the attribute with no reload", async () => {
  const { page, requested, errors } = await open();
  expect(await state(page, "chat")).toBe("denied");

  await consent(page, true);

  await expect
    .poll(() => state(page, "chat"), { timeout: 10_000 })
    .toBe("granted");
  expect(requested).toEqual([]);

  expect(await state(page, "video")).toBeNull();

  await consent(page, false);
  await expect
    .poll(() => state(page, "chat"), { timeout: 10_000 })
    .toBe("denied");

  expect(errors).toEqual([]);
  await page.close();
});

test("the press after a grant is what loads the vendor, and the control goes with it", async () => {
  const { page, requested, errors } = await open();

  await page.locator("#chat").click();
  expect(requested).toEqual([]);

  await consent(page, true);
  await expect
    .poll(() => state(page, "chat"), { timeout: 10_000 })
    .toBe("granted");
  await page.locator("#chat").click();

  await expect.poll(() => requested, { timeout: 10_000 }).toEqual([CHAT_SRC]);
  await expect.poll(() => page.locator("#chat").count(), { timeout: 10_000 }).toBe(0);

  expect(errors).toEqual([]);
  await page.close();
});
