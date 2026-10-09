import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const SITE = join(import.meta.dirname, "..", ".pagedeck-build-test-react-compiler");

const COUNTER = `"use client";
import { useState } from "react";

export default function Counter({ items }: { items: readonly string[] }) {
  const [count, setCount] = useState(0);
  const shouted = items.map((item) => item.toUpperCase());
  return (
    <button type="button" onClick={() => setCount(count + 1)}>
      {shouted.join(" ")} <b>marker-counter-6d21</b> {count}
    </button>
  );
}
`;

const CONFIG = `
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
      Counter: { path: "./components/counter.tsx", hydrate: "load" },
    },
    content: () => ({
      tree: [{ component: "Counter", props: { items: ["a", "b"] } }],
    }),
  },
});
`;

function write(file: string, contents: string): void {
  mkdirSync(dirname(join(SITE, file)), { recursive: true });
  writeFileSync(join(SITE, file), contents);
}

async function pagedeck(verb: string): Promise<string> {
  const { stderr } = await execFileAsync(process.execPath, [BIN, verb], { cwd: SITE });
  return stderr;
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("a build compiles its island and writes no Babel note about React's own runtime to stderr", async () => {
  rmSync(SITE, { recursive: true, force: true });
  write("components/counter.tsx", COUNTER);
  write("content/en/home.json", `${JSON.stringify({ rev: 1, data: { title: "Home" } })}\n`);
  write("pagedeck.config.ts", CONFIG);
  await pagedeck("sync");

  const stderr = await pagedeck("build");

  expect(stderr.split("\n").filter((line) => line.startsWith("[BABEL]"))).toEqual([]);
  const manifest = JSON.parse(readFileSync(join(SITE, "site", "manifest.json"), "utf8")) as {
    files: readonly { path: string; kind: string }[];
  };
  const island = manifest.files
    .filter((file) => file.kind === "js")
    .map((file) => readFileSync(join(SITE, "site", file.path), "utf8"))
    .find((code) => code.includes("marker-counter-6d21"));
  expect(island).toMatch(/memo_cache_sentinel.{0,120}marker-counter-6d21/);
}, 120_000);
