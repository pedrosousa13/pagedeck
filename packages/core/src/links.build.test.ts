// One site directory per setting: Node's ESM cache is keyed by URL, and a verb never
// re-executes a config it has imported.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const EXTERNAL_SITE = join(SITES, ".pagedeck-links-external-test");
const INCREMENTAL_SITE = join(SITES, ".pagedeck-links-incremental-test");
const ERROR_SITE = join(SITES, ".pagedeck-links-error-test");
const WARN_SITE = join(SITES, ".pagedeck-links-warn-test");
const OFF_SITE = join(SITES, ".pagedeck-links-off-test");
const SRCSET_SITE = join(SITES, ".pagedeck-links-srcset-test");

const BROKEN = "/missing";
const EXTERNAL = "https://example.com/moved";

const NAV = `import { createElement } from "react";
export default function Nav({ title, links }) {
  return createElement(
    "nav",
    null,
    "marker-nav-8c14 " + title,
    links.map((href) => createElement("a", { key: href, href }, href)),
  );
}
`;

const HERO = `import { createElement } from "react";
export default function Nav() {
  return createElement("img", {
    src: "https://images.example/hero.jpg",
    srcSet: "/hero-2x.png 2x",
    alt: "",
  });
}
`;

function site(root: string, links: string, component = NAV): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Nav.js"), component);

  for (const [path, data] of [
    ["home", { title: "Home", links: ["/about", BROKEN, EXTERNAL] }],
    ["about", { title: "About", links: ["/"] }],
  ] as const) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data })}\n`);
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
    outDir: "./dist",${links}
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
      Nav: { path: "./components/Nav.js", hydrate: "visible" },
    },
    content: (page, store) => {
      const entry = store.getEntry("pages", page.locale, page.entry.path);
      return {
        tree: [
          {
            component: "Nav",
            props: { title: entry.data.title, links: entry.data.links },
          },
        ],
      };
    },
  },
});
`,
  );
  return root;
}

afterAll(() => {
  for (const root of [
    ERROR_SITE,
    WARN_SITE,
    OFF_SITE,
    SRCSET_SITE,
    EXTERNAL_SITE,
    INCREMENTAL_SITE,
  ]) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Run {
  code: number;
  err: string;
}

async function run(cwd: string, ...argv: string[]): Promise<Run> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  return { code, err: err.join("\n") };
}

async function build(root: string): Promise<Run> {
  const synced = await run(root, "sync");
  if (synced.code !== EXIT_CODES.success) throw new Error(synced.err);
  return run(root, "build");
}

test("a broken internal link fails the build, naming the page and the href", async () => {
  const result = await build(site(ERROR_SITE, ""));

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toMatch(/^ {2}en \/ — "\/missing"$/m);
  expect(result.err).toContain(
    "Site build: 1 reference names nothing this build emitted",
  );
  expect(result.err).not.toContain('"/about"');
  expect(existsSync(join(ERROR_SITE, "dist"))).toBe(false);
}, 120_000);

test('a site declaring broken: "warn" ships the page and reports the href', async () => {
  const result = await build(
    site(WARN_SITE, `\n    links: { broken: "warn" },`),
  );

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toMatch(/^ {2}en \/ — "\/missing"$/m);
  expect(result.err).toContain('"build.links" declares broken: "warn"');
  const html = readFileSync(join(WARN_SITE, "dist", "index.html"), "utf8");
  expect(html).toContain(`href="${BROKEN}"`);
  expect(existsSync(join(WARN_SITE, "dist", "manifest.json"))).toBe(true);
}, 120_000);

test("a site declaring links: { broken: false } builds and says nothing", async () => {
  const result = await build(site(OFF_SITE, `\n    links: { broken: false },`));

  expect(result.code).toBe(EXIT_CODES.success);
  const html = readFileSync(join(OFF_SITE, "dist", "index.html"), "utf8");
  expect(html).toContain(`href="${BROKEN}"`);
  expect(
    result.err.split("\n").filter((line) => line.includes(BROKEN)),
  ).toEqual([]);
  expect(result.err).not.toContain("Site build:");
}, 120_000);

test("a srcSet candidate React writes that names a missing file is reported", async () => {
  const result = await build(
    site(SRCSET_SITE, `\n    links: { broken: "warn" },`, HERO),
  );

  expect(result.code).toBe(EXIT_CODES.success);
  const html = readFileSync(join(SRCSET_SITE, "dist", "index.html"), "utf8");
  expect(html).toContain('srcSet="/hero-2x.png 2x"');
  expect(result.err).toMatch(/^ {2}en \/ — "\/hero-2x\.png"$/m);
}, 120_000);

test("a site declaring an external probe reports the status it answers with", async () => {
  const result = await build(
    site(
      EXTERNAL_SITE,
      `\n    links: {
      broken: "warn",
      external: { probe: async () => 410 },
    },`,
    ),
  );

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toContain(
    "Site build: 1 external reference answered with a status a reader will not see the page at",
  );
  expect(result.err).toMatch(
    /^ {2}"https:\/\/example\.com\/moved" — 410 — linked from en \/$/m,
  );
  const html = readFileSync(join(EXTERNAL_SITE, "dist", "index.html"), "utf8");
  expect(html).toContain(`href="${EXTERNAL}"`);
  expect(result.err).toMatch(/^ {2}en \/ — "\/missing"$/m);
}, 120_000);

// The probe counts calls in a file: the config module's own counter cannot be
// imported from here.
test("an incremental build makes no external probe call, and a full build of the same site does", async () => {
  const root = site(
    INCREMENTAL_SITE,
    `\n    links: {
      broken: "warn",
      external: {
        probe: async (url) => {
          (await import("node:fs")).appendFileSync(${JSON.stringify(join(INCREMENTAL_SITE, "probed.log"))}, url + "\\n");
          return 200;
        },
        intervalMs: 0,
      },
    },`,
  );
  const log = join(root, "probed.log");
  const probed = (): string[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];

  const full = await build(root);
  expect(full.code).toBe(EXIT_CODES.success);
  expect(probed()).toEqual([EXTERNAL]);

  rmSync(log);
  writeFileSync(
    join(root, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 2, data: { title: "Home again", links: ["/about", BROKEN, EXTERNAL] } })}\n`,
  );
  const synced = await run(root, "sync");
  if (synced.code !== EXIT_CODES.success) throw new Error(synced.err);
  const incremental = await run(root, "build", "--incremental");

  expect(incremental.code).toBe(EXIT_CODES.success);
  expect(probed()).toEqual([]);
  const html = readFileSync(join(root, "dist", "index.html"), "utf8");
  expect(html).toContain("Home again");
  expect(html).toContain(`href="${EXTERNAL}"`);
  expect(incremental.err).toMatch(/^ {2}en \/ — "\/missing"$/m);
}, 360_000);
