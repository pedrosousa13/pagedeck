// Spawned, not in process: under Vitest every `import()` in this package is Vitest's,
// which compiles JSX itself.
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER } from "./diagnostic-marker.js";
import { EXIT_CODES } from "./exit.js";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-jsx");
const BROKEN = join(
  import.meta.dirname,
  "..",
  ".pagedeck-build-test-jsx-broken",
);

// The island is rendered from inside another component, so the build reaches it
// through the client-reference stand-in rather than the page tree.
const ARTICLE = `import Counter from "./Counter.tsx";

interface Props {
  title: string;
}

export default function Article({ title }: Props) {
  return (
    <article>
      <h1>{title}</h1>
      <Counter label="Count" />
    </article>
  );
}
`;

const COUNTER = `"use client";
import { useState } from "react";

interface Props {
  label: string;
}

export default function Counter({ label }: Props) {
  const [count, setCount] = useState<number>(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      {label} marker-counter-7a2e {count}
    </button>
  );
}
`;

function config(dir: string, head: string, components: string): string {
  return `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";
${head}
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
${components}
    tierPolicy: { minSize: 0 },
    content: () => ({
      tree: [{ component: "Article", props: { title: "marker-article-3d58" } }],
    }),
  },
});
`;
}

const COMPONENTS = `    components: {
      Article: "./components/Article.tsx",
      Counter: { path: "./components/Counter.tsx", hydrate: "load" },
    },`;

function writeSite(dir: string, files: Record<string, string>): void {
  rmSync(dir, { recursive: true, force: true });
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
}

afterAll(() => {
  for (const dir of [SITE, BROKEN]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

let built: Promise<string> | undefined;

function build(): Promise<string> {
  built ??= (async () => {
    writeSite(SITE, {
      "components/Article.tsx": ARTICLE,
      "components/Counter.tsx": COUNTER,
      "content/en/home.json": `${JSON.stringify({ rev: 1, data: {} })}\n`,
      "pagedeck.config.ts": config(SITE, "", COMPONENTS),
    });
    await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
    await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });
    return readFileSync(join(SITE, "dist", "index.html"), "utf8");
  })();
  return built;
}

test("a .tsx component with types and JSX renders into the page with no build step", async () => {
  const html = await build();

  expect(html).toContain("<article><h1>marker-article-3d58</h1>");
}, 120_000);

test('a .tsx module carrying "use client" is islanded and its code shipped to hydrate it', async () => {
  const html = await build();

  const article = html.slice(
    html.indexOf("<article>"),
    html.indexOf("</article>"),
  );
  expect(article).toMatch(
    /<fw-island[^>]*data-fw-component="Counter"[^>]*>.*marker-counter-7a2e/s,
  );
  expect(html).toContain('<script type="module"');
  const shipped = filesUnder(join(SITE, "dist")).filter(
    (file) =>
      file.endsWith(".js") &&
      readFileSync(file, "utf8").includes("marker-counter-7a2e"),
  );
  expect(shipped).toHaveLength(1);
}, 120_000);

test("a JSX syntax error in a module the config imports fails naming the module and its line", async () => {
  writeSite(BROKEN, {
    "components/Article.tsx": `export default function Article() {\n  return <article>{title</article>;\n}\n`,
    "components/Counter.tsx": COUNTER,
    "content/en/home.json": `${JSON.stringify({ rev: 1, data: {} })}\n`,
    "pagedeck.config.ts": config(
      BROKEN,
      `import "./components/Article.tsx";\n`,
      COMPONENTS,
    ),
  });

  const failure = await execFileAsync(process.execPath, [BIN, "sync"], {
    cwd: BROKEN,
  }).then(
    () => {
      throw new Error(
        "pagedeck sync succeeded on a module that will not compile",
      );
    },
    (error: unknown) => error as { code: number; stderr: string },
  );

  expect(failure.code).toBe(EXIT_CODES.configError);
  expect(failure.stderr.trimEnd()).toBe(
    `${DIAGNOSTIC_MARKER} Config "${join(BROKEN, "pagedeck.config.ts")}": failed to load: Module "${join(BROKEN, "components", "Article.tsx")}" line 2: does not compile — fix the syntax at the line named: column 26: Unterminated regular expression`,
  );
}, 60_000);
