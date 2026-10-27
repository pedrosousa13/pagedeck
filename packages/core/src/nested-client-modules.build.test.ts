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
  return <output id={id} data-code="badge-code-58e0">{label}</output>;
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
    // Out of reach of every tier group, so each island is a chunk of its own.
    tierPolicy: { minSize: 100_000_000 },
    content: () => ({ tree: [{ component: "page" }] }),
  },
});
`,
};

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

interface Manifest {
  files: readonly { path: string; kind: string }[];
}

function islandTags(html: string): { component: string; at: number }[] {
  return [...html.matchAll(/<fw-island\b[^>]*data-fw-component="([^"]+)"[^>]*>/g)].map(
    (match) => ({ component: match[1] as string, at: match.index }),
  );
}

// A chunk and every chunk it imports statically, not the ones it loads on demand.
function staticClosure(chunk: string): string {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    const code = readFileSync(join(SITE, "site", "assets", path), "utf8");
    for (const match of code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) {
      visit(match[1] as string);
    }
  };
  visit(chunk);
  return [...seen]
    .map((path) => readFileSync(join(SITE, "site", "assets", path), "utf8"))
    .join("\n");
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
  expect(html.match(/<fw-island\b/g)).toHaveLength(2);
  const [panel, badge] = islandTags(html) as [
    { component: string; at: number },
    { component: string; at: number },
  ];
  expect([panel.component, badge.component]).toEqual(["panel", "badge"]);
  const panelMarkup = html.slice(panel.at, html.indexOf("</fw-island>", panel.at));
  expect(panelMarkup).toContain("panel-7c1e");
  expect(panelMarkup).toContain(">inside-3f2a</output>");
  expect(html.slice(badge.at)).toContain(">direct-91d4</output>");

  const manifest = JSON.parse(
    readFileSync(join(SITE, "site", "manifest.json"), "utf8"),
  ) as Manifest;
  const panelChunk = manifest.files.find((file) =>
    /^\/assets\/Panel-[^/]+\.js$/.test(file.path),
  );
  expect(panelChunk).toBeDefined();
  expect(
    staticClosure((panelChunk as { path: string }).path.slice("/assets/".length)),
  ).toContain("badge-code-58e0");
}, 180_000);
