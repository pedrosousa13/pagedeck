import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER } from "./diagnostic-marker.js";
import { EXIT_CODES } from "./exit.js";
import { ABSENT_FAVICON } from "./favicon.test-support.js";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITES = join(import.meta.dirname, "..");

// The trailing space is load-bearing: this repo's Rolldown plugins are named `pagedeck:…`, so
// the bare marker would select their lines on a clean build (#184).
function markedLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `));
}

test("a bundler line named after a pagedeck plugin is not a framework diagnostic", () => {
  expect(
    markedLines(
      [
        "pagedeck:compile-islands: transform took 812ms",
        "pagedeck:entry-modules: 4 entries",
        'pagedeck: Config "/site/pagedeck.config.ts": has no default export',
      ].join("\n"),
    ),
  ).toEqual(['pagedeck: Config "/site/pagedeck.config.ts": has no default export']);
});

function siteDir(name: string): string {
  const dir = join(SITES, `.pagedeck-build-test-${name}`);
  tempDirs.push(dir);
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

test("the pagedeck executable exits with the config-error code when no config is there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-bin-"));
  tempDirs.push(dir);

  const failure = await execFileAsync(process.execPath, [BIN, "sync"], {
    cwd: dir,
  }).then(
    () => {
      throw new Error("pagedeck sync succeeded in a directory with no config");
    },
    (error: unknown) => error as { code: number; stderr: string },
  );

  expect(failure.code).toBe(EXIT_CODES.configError);
  expect(failure.stderr).toContain("pagedeck.config.ts");
}, 60_000);

test("the pagedeck executable syncs a real site", async () => {
  const dir = siteDir("bin-sync");
  mkdirSync(join(dir, "content", "en"), { recursive: true });
  writeFileSync(
    join(dir, "content", "en", "home.json"),
    JSON.stringify({ rev: 1, data: { title: "Home" } }),
  );
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
      schema: false,
    },
  ],
});
`,
  );

  const { stdout } = await execFileAsync(process.execPath, [BIN, "sync"], {
    cwd: dir,
  });

  expect(stdout.trim()).toBe("pages: 1 changed, 0 deleted, cursor 1");
}, 60_000);

// The store is filled by a second spawn, not `runCli`: importing `cli.js` pulls Vite and
// React into this worker (9.1s against 2.2s for two cold `pagedeck` starts).
test("the pagedeck executable builds a real site end to end", async () => {
  const dir = siteDir("bin-build");
  mkdirSync(join(dir, "components"), { recursive: true });
  mkdirSync(join(dir, "content", "en"), { recursive: true });
  writeFileSync(
    join(dir, "components", "Hero.js"),
    `import { rows } from "./rows.js";\nexport default function Hero() { return "marker-hero-bin-6f31" + rows.length; }\n`,
  );
  // Past Babel's 500KB, so the build writes Babel's note: a line of another tool's to pass through.
  writeFileSync(
    join(dir, "components", "rows.js"),
    `export const rows = ${JSON.stringify(Array.from({ length: 50_000 }, (_, index) => `row-${String(index)}`))};\n`,
  );
  writeFileSync(
    join(dir, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`,
  );
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection, SECURITY_HEADERS } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    // Declared: a site with no headers warns on stderr (#318), and this build must be silent.
    routing: { headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }] },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: {
      Hero: { path: "./components/Hero.js", hydrate: "visible" },
    },
    // Rolldown ignores a group whose modules do not reach \`minSize\`.
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Hero" }] }),
  },
});
`,
  );

  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: dir });
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [BIN, "build"],
    { cwd: dir },
  );

  expect(stdout.trim()).toContain(`built 1 pages,`);
  expect(markedLines(stderr)).toEqual([`${DIAGNOSTIC_MARKER} ${ABSENT_FAVICON}`]);
  const passedThrough = stderr
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith(DIAGNOSTIC_MARKER));
  expect(passedThrough.filter((line) => line.startsWith("[BABEL]")).length).toBeGreaterThan(0);
  expect(existsSync(join(dir, "dist", "manifest.json"))).toBe(true);
  const html = readFileSync(join(dir, "dist", "index.html"), "utf8");
  expect(html).toContain("marker-hero-bin-6f31");
  expect(html).toContain("<fw-island");
}, 60_000);

test("a failing pagedeck build writes a marked, readable diagnostic", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-bin-"));
  tempDirs.push(dir);

  const failure = await execFileAsync(process.execPath, [BIN, "build"], {
    cwd: dir,
  }).then(
    () => {
      throw new Error("pagedeck build succeeded in a directory with no config");
    },
    (error: unknown) => error as { code: number; stderr: string },
  );

  expect(failure.code).toBe(EXIT_CODES.configError);
  const marked = markedLines(failure.stderr);
  expect(marked).toHaveLength(1);
  expect(marked[0]).toContain("No config file in");
  expect(marked[0]).toContain("pagedeck.config.ts");
}, 60_000);

test("a failing pagedeck build marks every line of a collected report", async () => {
  const dir = siteDir("bin-report");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
      schema: false,
    },
  ],
  build: {},
});
`,
  );

  const failure = await execFileAsync(process.execPath, [BIN, "build"], {
    cwd: dir,
  }).then(
    () => {
      throw new Error(
        "pagedeck build succeeded on a site with an empty build section",
      );
    },
    (error: unknown) => error as { code: number; stderr: string },
  );

  expect(failure.code).toBe(EXIT_CODES.configError);
  const written = failure.stderr.trimEnd().split("\n");
  expect(markedLines(failure.stderr)).toEqual(written);
  expect(written.length).toBeGreaterThan(1);
  expect(written[0]).toContain(`"build" is missing 3 fields`);
  expect(written[1]).toBe(
    `${DIAGNOSTIC_MARKER}   "pages" — declare it as a list of page sources, or as a page set from definePages`,
  );
}, 60_000);

test("a config that still declares build.modules exits with the config-error code", async () => {
  const dir = siteDir("bin-modules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
      schema: false,
    },
  ],
  build: {
    outDir: "./dist",
    pages: {},
    components: {},
    modules: { Hero: "./components/Hero.js" },
    content: () => ({ tree: [] }),
  },
});
`,
  );

  const failure = await execFileAsync(process.execPath, [BIN, "build"], {
    cwd: dir,
  }).then(
    () => {
      throw new Error("pagedeck build succeeded on a site declaring build.modules");
    },
    (error: unknown) => error as { code: number; stderr: string },
  );

  expect(failure.code).toBe(EXIT_CODES.configError);
  expect(markedLines(failure.stderr)[0]).toContain(`"build.modules" was removed`);
}, 60_000);

// `"use memo"` because the component uses `createElement`: the compiler's default
// inference only reaches a function returning JSX, and would report no bailout.
test("a compiler bailout on a green build is written as a marked line", async () => {
  const dir = siteDir("bin-compiler");
  mkdirSync(join(dir, "components"), { recursive: true });
  mkdirSync(join(dir, "content", "en"), { recursive: true });
  writeFileSync(
    join(dir, "components", "Bailout.js"),
    `import { createElement } from "react";

let renders = 0;

export default function Bailout() {
  "use memo";
  renders += 1;
  return createElement("p", null, \`marker-bailout-9d24 \${renders}\`);
}
`,
  );
  writeFileSync(
    join(dir, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`,
  );
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: {
      Bailout: { path: "./components/Bailout.js", hydrate: "visible" },
    },
    tierPolicy: { minSize: 0 },
    content: () => ({ tree: [{ component: "Bailout" }] }),
  },
});
`,
  );

  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: dir });
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [BIN, "build"],
    { cwd: dir },
  );

  expect(stdout.trim()).toContain("built 1 pages,");
  const bailout = markedLines(stderr).filter((line) =>
    line.includes("React Compiler skipped"),
  );
  expect(bailout).toHaveLength(1);
  expect(bailout[0]).toContain(`component "Bailout"`);
  expect(bailout[0]).toContain(
    "It renders as written, without automatic memoization.",
  );
  expect(
    stderr
      .split("\n")
      .filter(
        (line) =>
          line.includes("React Compiler") &&
          !line.startsWith(`${DIAGNOSTIC_MARKER} `),
      ),
  ).toEqual([]);
  expect(readFileSync(join(dir, "dist", "index.html"), "utf8")).toContain(
    "marker-bailout-9d24",
  );
}, 60_000);
