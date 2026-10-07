import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const PLAIN_SITE = join(SITES, ".pagedeck-beacon-plain-test");
const BEACON_SITE = join(SITES, ".pagedeck-beacon-declared-test");

const COMPONENTS: Record<string, string> = {
  "Copy.js": `export default function Copy() { return "marker-copy-6a04"; }\n`,
};

function site(root: string, build = ""): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  for (const [file, source] of Object.entries(COMPONENTS)) {
    writeFileSync(join(root, "components", file), source);
  }
  for (const path of ["home", "post"]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title: path } })}\n`);
  }

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const usage = (component) => [
  { component, count: 1, foldScore: 0, depth: 0, isRoot: true },
];

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
  templates: {
    templateOf: (entry) => (entry.path === "home" ? "landing" : "article"),
    byTemplate: { landing: usage("Copy"), article: usage("Copy") },
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    ${build}
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
      Copy: "./components/Copy.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
  return root;
}

async function run(cwd: string, ...argv: string[]): Promise<number> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return code;
}

const built = new Map<string, Promise<Map<string, string>>>();

function build(root: string, beacon = ""): Promise<Map<string, string>> {
  let one = built.get(root);
  if (one === undefined) {
    one = buildOnce(root, beacon);
    built.set(root, one);
  }
  return one;
}

async function buildOnce(
  root: string,
  beacon: string,
): Promise<Map<string, string>> {
  const dir = site(root, beacon);
  await run(dir, "sync");
  await run(dir, "build");
  const dist = join(dir, "dist");
  const file = join(dist, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  return new Map(
    manifest.pages.map((page) => [
      page.path,
      readFileSync(join(dist, page.html), "utf8"),
    ]),
  );
}

afterAll(() => {
  for (const root of [PLAIN_SITE, BEACON_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

const BEACON = 'beacon: { endpoint: "https://collector.example/rum" },';

function beaconLine(html: string): string {
  return (
    html.split("\n").find((line) => line.startsWith("<script>(function(){var q=")) ??
    ""
  );
}

test("a site that declares no beacon emits the document it always did", async () => {
  const plain = await build(PLAIN_SITE);
  const html = plain.get("/") ?? "";

  expect(html).toContain("marker-copy-6a04");
  expect(html).not.toContain("sendBeacon");
  expect(html).not.toContain("PerformanceObserver");
  expect(html).not.toContain("collector.example");
  expect(html).not.toContain("requestIdleCallback");
}, 120_000);

test("the beacon's whole footprint is one line, and without it the files match", async () => {
  const plain = await build(PLAIN_SITE);
  const declared = await build(BEACON_SITE, BEACON);

  expect([...declared.keys()].sort()).toEqual([...plain.keys()].sort());
  expect(declared.size).toBeGreaterThan(0);
  for (const [path, html] of declared) {
    const line = beaconLine(html);
    expect(`${path}: ${line}`).not.toBe(`${path}: `);
    const without = html
      .split("\n")
      .filter((one) => one !== line)
      .join("\n");
    expect(`${path}: ${without}`).toBe(`${path}: ${plain.get(path) ?? ""}`);
  }
}, 120_000);

test("each page reports its own identity to the configured endpoint", async () => {
  const declared = await build(BEACON_SITE, BEACON);

  expect(beaconLine(declared.get("/") ?? "")).toContain(
    '["https://collector.example/rum","en","/",0]',
  );
  expect(beaconLine(declared.get("/post") ?? "")).toContain(
    '["https://collector.example/rum","en","/post",0]',
  );
}, 120_000);

test("the beacon is the last thing in the body, after the page's own content", async () => {
  const declared = await build(BEACON_SITE, BEACON);
  const html = declared.get("/") ?? "";

  expect(html.indexOf("marker-copy-6a04")).toBeLessThan(
    html.indexOf("collector.example"),
  );
  expect(html.indexOf("collector.example")).toBeLessThan(html.indexOf("</body>"));
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head).not.toContain("collector.example");
}, 120_000);

test("the beacon reports through sendBeacon, on idle, behind the consent global", async () => {
  const declared = await build(BEACON_SITE, BEACON);
  const line = beaconLine(declared.get("/") ?? "");

  expect(line).toContain("navigator.sendBeacon");
  expect(line).toContain("keepalive:true");
  expect(line).toContain("requestIdleCallback");
  expect(line).toContain('window["fwConsent"]');
  expect(line).toContain('granted("analytics")');
  expect(line).not.toContain("unload");
}, 120_000);
