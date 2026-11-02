import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RETENTION_DIR } from "@pagedeck/core";
import { startCms } from "./server.js";
import type { Cms } from "./server.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..");
const OUT = join(SITE, "site");
const STORE = join(SITE, "content.db");
const BIN = join(SITE, "..", "core", "dist", "bin.js");

const ISLANDS = ["faq", "signup_form"] as const;

const PAGES = ["/", "/faq/", "/signup/"] as const;

let cms: Cms;
let before: string | undefined;
let firstChunks: Map<string, string[]>;

function clean(): void {
  for (const path of [OUT, STORE, join(SITE, RETENTION_DIR)]) {
    rmSync(path, { recursive: true, force: true });
  }
}

async function pagedeck(...argv: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [BIN, ...argv], {
    cwd: SITE,
    env: { ...process.env, PAGEDECK_CMS_EXAMPLE_URL: cms.url },
  });
  return stdout;
}

// The page's entry and every chunk its text names, the islands it imports on demand
// among them.
function chunksOf(page: string): string[] {
  const html = readFileSync(join(OUT, page, "index.html"), "utf8");
  const entry = /<script type="module" src="\/(assets\/[^"]+\.js)">/.exec(html)?.[1];
  if (entry === undefined) return [];
  const text = readFileSync(join(OUT, entry), "utf8");
  const named = readdirSync(join(OUT, "assets"))
    .filter((file) => file.endsWith(".js") && text.includes(file))
    .map((file) => `assets/${file}`);
  return [entry, ...named].sort();
}

function pageChunks(): Map<string, string[]> {
  return new Map(PAGES.map((page) => [page, chunksOf(page)]));
}

// Each block's component marks its root with `data-block`, so a chunk holding that
// literal holds the island's code, whichever chunk the bundler put it in.
function islandsOf(chunks: readonly string[] | undefined): string[] {
  const code = (chunks ?? []).map((path) => readFileSync(join(OUT, path), "utf8"));
  return ISLANDS.filter((island) =>
    code.some((source) => new RegExp(`"data-block":[\`"]${island}[\`"]`).test(source)),
  );
}

function documents(root: string): Map<string, string> {
  return new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(root, file), readFileSync(file, "utf8")];
      }),
  );
}

beforeAll(async () => {
  clean();
  cms = await startCms({ port: 0 });
  await pagedeck("sync");
  await pagedeck("build");
  firstChunks = pageChunks();
  before = mkdtempSync(join(tmpdir(), "pagedeck-cms-example-"));
  cpSync(OUT, before, { recursive: true });
}, 180_000);

afterAll(async () => {
  await cms.close();
  clean();
  if (before !== undefined) rmSync(before, { recursive: true, force: true });
});

test("the home page, built from static blocks alone, ships no JavaScript", () => {
  expect(readFileSync(join(OUT, "index.html"), "utf8")).not.toContain("<script");
  expect(firstChunks.get("/")).toEqual([]);
});

test("the FAQ page ships the faq island and not the sign-up form's", () => {
  expect(islandsOf(firstChunks.get("/faq/"))).toEqual(["faq"]);
});

test("the sign-up page ships the sign-up form's island and not the faq's", () => {
  expect(islandsOf(firstChunks.get("/signup/"))).toEqual(["signup_form"]);
});

test("the sign-up form names no address to post to", () => {
  const html = readFileSync(join(OUT, "signup", "index.html"), "utf8");

  expect(html).toContain("<form");
  expect(html).not.toMatch(/<form[^>]*\saction=/);
});

test("the sign-up form, before it hydrates, cannot put the address in a URL", () => {
  const html = readFileSync(join(OUT, "signup", "index.html"), "utf8");
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
  const posts = /^<form\b[^>]*\smethod="post"/i.test(form);
  const submits = (form.match(/<(?:button|input)\b[^>]*>/g) ?? []).filter((tag) =>
    tag.startsWith("<button")
      ? !/\stype="(?:button|reset)"/.test(tag)
      : /\stype="(?:submit|image)"/.test(tag),
  );

  expect(submits).not.toEqual([]);
  expect(posts || submits.every((tag) => /\sdisabled(?:=|\s|>|\/)/.test(tag))).toBe(true);
});

function changedDocuments(): string[] {
  const after = documents(OUT);
  return [...documents(before as string)]
    .filter(([file, html]) => after.get(file) !== html)
    .map(([file]) => file);
}

test("a page edited in the CMS is the only page an incremental sync and build write again", async () => {
  cms.put("faq", {
    title: "Questions",
    blocks: [
      { type: "hero", heading: "Questions", text: "Edited in the CMS." },
      {
        type: "faq",
        questions: [{ question: "Was this page edited?", answer: "Yes, and only this one." }],
      },
    ],
  });

  expect(await pagedeck("sync", "--incremental")).toContain("pages: 1 changed, 0 deleted, cursor 4");
  expect(await pagedeck("build", "--incremental")).toContain(
    "incremental: 1 of 3 pages rendered, 2 reused, 0 removed",
  );

  expect(changedDocuments()).toEqual([join("faq", "index.html")]);
  expect(readFileSync(join(OUT, "faq", "index.html"), "utf8")).toContain("Edited in the CMS.");
  const second = pageChunks();
  expect(islandsOf(second.get("/faq/"))).toEqual(["faq"]);
  expect(second.get("/")).toEqual(firstChunks.get("/"));
  expect(second.get("/signup/")).toEqual(firstChunks.get("/signup/"));
}, 180_000);

test("a page whose faq block becomes a sign-up form switches islands in an incremental build", async () => {
  cms.put("faq", {
    title: "Questions",
    blocks: [
      { type: "hero", heading: "Questions", text: "Ask by signing up." },
      {
        type: "signup_form",
        label: "Email address",
        button: "Ask",
        confirmation: "Thanks. This example sends nothing.",
      },
    ],
  });

  expect(await pagedeck("sync", "--incremental")).toContain("pages: 1 changed, 0 deleted, cursor 5");
  expect(await pagedeck("build", "--incremental")).toContain(
    "incremental: 1 of 3 pages rendered, 2 reused, 0 removed",
  );

  expect(changedDocuments()).toEqual([join("faq", "index.html")]);
  const third = pageChunks();
  expect(islandsOf(third.get("/faq/"))).toEqual(["signup_form"]);
  expect(islandsOf(third.get("/signup/"))).toEqual(["signup_form"]);
  expect(third.get("/")).toEqual(firstChunks.get("/"));
  expect(third.get("/signup/")).toEqual(firstChunks.get("/signup/"));
}, 180_000);
