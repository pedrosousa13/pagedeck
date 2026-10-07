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
import { readManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { listRetainedManifests, RETENTION_DIR } from "./retention.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");
const SITE = join(SITES, ".pagedeck-retention-test");

const COPY = `export default function Copy() { return "marker-copy-1f47"; }\n`;

function site(root: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Copy.js"), COPY);
  for (const [path, title] of [
    ["home", "Home"],
    ["about", "About"],
  ]) {
    const file = join(root, "content", "en", `${path}.json`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ rev: 1, data: { title } })}\n`);
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
    retention: { keep: 2 },
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
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
  return root;
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

async function run(cwd: string, ...argv: string[]): Promise<readonly string[]> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  if (code !== EXIT_CODES.success) throw new Error(err.join("\n"));
  return err;
}

function emitted(root: string): Manifest {
  const file = join(root, "dist", "manifest.json");
  return readManifest(readFileSync(file, "utf8"), file);
}

interface Built {
  root: string;
  builds: readonly Manifest[];
}

const built = buildThrice();

async function buildThrice(): Promise<Built> {
  const root = site(SITE);
  await run(root, "sync");
  const builds: Manifest[] = [];
  for (let index = 0; index < 3; index += 1) {
    await run(root, "build");
    builds.push(emitted(root));
  }
  return { root, builds };
}

test("a build retains the document it wrote beside the site, and the first names no parent", async () => {
  const { root, builds } = await built;
  const [first] = builds;
  const last = builds[2];

  expect(first?.build.parent).toBeUndefined();
  const retained = join(root, RETENTION_DIR, `${String(last?.build.id)}.json`);
  expect(existsSync(retained)).toBe(true);
  expect(readFileSync(retained, "utf8")).toBe(
    readFileSync(join(root, "dist", "manifest.json"), "utf8"),
  );
}, 120_000);

test("each build records the manifest it was built on", async () => {
  const { builds } = await built;
  const [first, second, third] = builds;

  expect(second?.build.parent).toBe(first?.build.id);
  expect(third?.build.parent).toBe(second?.build.id);
  expect(new Set(builds.map((build) => build.build.id)).size).toBe(3);
}, 120_000);

test("the store keeps the count the site declared, newest first", async () => {
  const { root, builds } = await built;

  const retained = await listRetainedManifests(root);

  expect(retained.map((manifest) => manifest.build.id)).toEqual([
    builds[2]?.build.id,
    builds[1]?.build.id,
  ]);
}, 120_000);

test("the store is beside the output tree and not inside it", async () => {
  const { root } = await built;

  expect(existsSync(join(root, "dist", ".pagedeck"))).toBe(false);
  expect(existsSync(join(root, RETENTION_DIR))).toBe(true);
}, 120_000);

test("a build over a store holding a document it cannot read finishes, and says what it removed", async () => {
  // Last in the file on purpose: a fourth build over the fixture the tests above read.
  const { root, builds } = await built;
  const planted = join(root, RETENTION_DIR, "b-from-an-older-pagedeck.json");
  writeFileSync(
    planted,
    JSON.stringify({
      version: 1,
      build: { id: "b0", createdAt: "2099-01-01T00:00:00.000Z" },
    }),
  );

  const err = await run(root, "build");

  expect(emitted(root).build.parent).toBe(builds[2]?.build.id);
  expect(existsSync(planted)).toBe(false);
  expect(err.join("\n")).toContain(
    `Retention store: 1 retained manifest could not be read and has been pruned`,
  );
  expect(err.join("\n")).toContain(`Manifest "${planted}": is version 1`);
}, 120_000);
