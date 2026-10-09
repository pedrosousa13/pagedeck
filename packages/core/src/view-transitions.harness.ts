import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";
import { VIEW_TRANSITION_STYLE } from "./view-transitions.js";

const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const SITE = fileURLToPath(
  new URL("../node_modules/.pagedeck-view-transitions-harness", import.meta.url),
);

const REVEALED = "__pagedeckRevealed";

function writeSite(root: string): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(
    join(root, "components", "Next.js"),
    `import { createElement } from "react";\n` +
      `export default function Next() { return createElement("a", { id: "next", href: "/next" }, "next"); }\n`,
  );
  for (const id of ["home", "next"]) {
    const entry = join(root, "content", "en", `${id}.json`);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, `${JSON.stringify({ rev: 1, data: { title: id } })}\n`);
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    viewTransitions: true,
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [
        fromCollection(pages, {
          route: (entry) => (entry.path === "home" ? "/" : "/" + entry.path),
        }),
      ],
    }),
    components: {
      Next: "./components/Next.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Next" }] }),
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
      `View transitions harness: pagedeck ${argv.join(" ")} failed in "${cwd}" — ${err.join("\n")}`,
    );
  }
}

let browser: Browser;
let server: Server;
let origin: string;
const documents = new Map<string, string>();

beforeAll(async () => {
  writeSite(SITE);
  await run(SITE, "sync");
  await run(SITE, "build");

  const dist = join(SITE, "dist");
  const manifestFile = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(manifestFile, "utf8"), manifestFile);
  for (const page of manifest.pages) {
    documents.set(page.path, readFileSync(join(dist, page.html), "utf8"));
  }
  if (!documents.has("/") || !documents.has("/next")) {
    throw new Error(
      `View transitions harness: the build of "${SITE}" routed ${JSON.stringify([...documents.keys()])}, not "/" and "/next" — check the fixture's routes`,
    );
  }

  server = createServer((request, response) => {
    const html = documents.get(new URL(request.url ?? "/", "http://x").pathname);
    if (html === undefined) {
      response.writeHead(404, { "content-type": "text/plain" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((done) => server?.close(done));
  rmSync(SITE, { recursive: true, force: true });
});

async function revealAfterNavigating(
  reducedMotion: "reduce" | "no-preference",
): Promise<unknown> {
  const context = await browser.newContext({ reducedMotion });
  await context.addInitScript(`
    addEventListener("pagereveal", (event) => {
      window[${JSON.stringify(REVEALED)}] = event.viewTransition !== null;
    });
  `);
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  expect(
    await page.evaluate(
      `matchMedia("(prefers-reduced-motion: ${reducedMotion})").matches`,
    ),
  ).toBe(true);

  await page.locator("#next").click();
  await page.waitForURL(`${origin}/next`);
  const revealed = (): Promise<unknown> => page.evaluate(`window.${REVEALED}`);
  await expect.poll(revealed, { timeout: 10_000 }).toBeTypeOf("boolean");
  const transitioned = await revealed();
  await context.close();
  return transitioned;
}

test("every built page carries the rule", () => {
  for (const html of documents.values()) {
    expect(html).toContain(VIEW_TRANSITION_STYLE);
  }
});

test("with no motion preference, following a link reveals the new page through a view transition", async () => {
  expect(await revealAfterNavigating("no-preference")).toBe(true);
});

test("under prefers-reduced-motion: reduce, following a link reveals the new page with no view transition", async () => {
  expect(await revealAfterNavigating("reduce")).toBe(false);
});
