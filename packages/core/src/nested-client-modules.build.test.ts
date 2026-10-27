// Spawned, not in process: `installClientReferences` hooks only what Node loads, and
// under Vitest every `import()` in this package is Vitest's.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-nested-client-modules");

const FILES: Readonly<Record<string, string>> = {
  "components/Badge.tsx": `"use client";
import { useId } from "react";

export type BadgeProps = { label: string };
export interface BadgeTone {
  tone: "info";
}

export default function Badge({ label }: BadgeProps) {
  const id = useId();
  return <output id={id}>{label}</output>;
}
`,
  "components/Panel.tsx": `"use client";
import { useState } from "react";
import Badge from "./Badge.tsx";

export default function Panel() {
  const [open, setOpen] = useState(false);
  return (
    <section>
      <button type="button" onClick={() => setOpen(!open)}>panel-7c1e</button>
      <Badge label="inside-3f2a" />
    </section>
  );
}
`,
  "components/Page.tsx": `import Badge from "./Badge.tsx";
import Panel from "./Panel.tsx";

export default function Page() {
  return (
    <div>
      <Panel />
      <Badge label="direct-91d4" />
    </div>
  );
}
`,
  "content/en/index.json": `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`,
  "pagedeck.config.ts": `
import { defineConfig, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages)],
    components: {
      page: "./components/Page.tsx",
      panel: { path: "./components/Panel.tsx", hydrate: "load" },
      badge: { path: "./components/Badge.tsx", hydrate: "load" },
    },
    content: () => ({ tree: [{ component: "page" }] }),
  },
});
`,
};

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

function islandsIn(html: string): { component: string; inner: string }[] {
  return [
    ...html.matchAll(
      /<fw-island\b[^>]*data-fw-component="([^"]+)"[^>]*>([\s\S]*?)<\/fw-island>/g,
    ),
  ].map((match) => ({
    component: match[1] as string,
    inner: match[2] as string,
  }));
}

test("a client module another client module imports islands where the server renders it, and renders inside the other's island", async () => {
  rmSync(SITE, { recursive: true, force: true });
  for (const [file, contents] of Object.entries(FILES)) {
    mkdirSync(dirname(join(SITE, file)), { recursive: true });
    writeFileSync(join(SITE, file), contents);
  }
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: SITE });
  await execFileAsync(process.execPath, [BIN, "build"], { cwd: SITE });

  const html = readFileSync(join(SITE, "site", "index.html"), "utf8");
  const islands = islandsIn(html);
  expect(islands.map((island) => island.component)).toEqual(["panel", "badge"]);
  const [panel, badge] = islands as [
    { component: string; inner: string },
    { component: string; inner: string },
  ];
  expect(panel.inner).toContain("panel-7c1e");
  expect(panel.inner).toContain(">inside-3f2a</output>");
  expect(badge.inner).toContain(">direct-91d4</output>");
}, 180_000);
