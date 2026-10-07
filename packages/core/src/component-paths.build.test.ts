// Spawned, not in process: under Vitest every `import()` in this package is Vitest's,
// which compiles JSX itself.
import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { budgetReportPath } from "./budgets.js";
import type { BudgetReport } from "./budgets.js";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");
const DESIGN_SYSTEM = join(import.meta.dirname, "..", "..", "design-system");
const PRICING = "@pagedeck/design-system/components/pricing_page";

const BY_PATH = join(
  import.meta.dirname,
  "..",
  ".pagedeck-build-test-paths-by-path",
);

// Every component is an island, so a component missing from the derived module
// map changes what the build ships. `Pricing` is declared by package specifier.
const COUNTER = `"use client";
import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState<number>(0);
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      marker-counter-61d0 {count}
    </button>
  );
}
`;

const TOGGLE = `"use client";
import { useState } from "react";

export default function Toggle() {
  const [on, setOn] = useState<boolean>(false);
  return (
    <button type="button" onClick={() => setOn(!on)}>
      marker-toggle-c3a9 {on ? "on" : "off"}
    </button>
  );
}
`;

function config(dir: string): string {
  return `
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
      Counter: "./components/Counter.tsx",
      Toggle: { path: "./components/Toggle.tsx", hydrate: "load" },
      Pricing: "${PRICING}",
    },
    budget: { "/**": "1mb" },
    tierPolicy: { minSize: 0 },
    content: () => ({
      tree: [
        { component: "Counter" },
        { component: "Toggle" },
        {
          component: "Pricing",
          props: { fields: { headline: "marker-pricing-7f3b", plans: [{ name: "Basic", price: "9" }] } },
        },
      ],
    }),
  },
});
`;
}

function writeSite(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  const files: Record<string, string> = {
    "components/Counter.tsx": COUNTER,
    "components/Toggle.tsx": TOGGLE,
    "content/en/home.json": `${JSON.stringify({ rev: 1, data: {} })}\n`,
    "pagedeck.config.ts": config(dir),
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), source);
  }
  // The specifier resolves from the site, as a design system a site installed would.
  mkdirSync(join(dir, "node_modules", "@pagedeck"), { recursive: true });
  symlinkSync(
    DESIGN_SYSTEM,
    join(dir, "node_modules", "@pagedeck", "design-system"),
  );
}

afterAll(() => {
  rmSync(BY_PATH, { recursive: true, force: true });
});

interface Built {
  markers: string[];
  report: BudgetReport;
}

async function build(dir: string): Promise<Built> {
  writeSite(dir);
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: dir });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: dir });
  const html = readFileSync(join(dir, "dist", "index.html"), "utf8");
  return {
    markers: [...html.matchAll(/<fw-island\b[^>]*>/g)].map((match) => match[0]),
    report: JSON.parse(
      readFileSync(budgetReportPath(dir), "utf8"),
    ) as BudgetReport,
  };
}

test("a site declaring its components by path and by package specifier ships an island for each", async () => {
  const byPath = await build(BY_PATH);

  expect(byPath.markers).toHaveLength(3);
  for (const name of ["Counter", "Toggle", "Pricing"]) {
    expect(byPath.markers.join("\n")).toContain(`data-fw-component="${name}"`);
  }
  const [page] = byPath.report.pages;
  expect(page?.actual).toBeGreaterThan(0);
  expect(page?.chunks.length).toBeGreaterThan(0);
}, 180_000);
