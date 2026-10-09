import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { Marked } from "marked";
import type { Token } from "marked";
import { beforeAll, expect, test } from "vitest";
import { parseFrontmatter } from "@pagedeck/markdown-loader";

const execFileAsync = promisify(execFile);

const PACKAGE = join(import.meta.dirname, "..");

const NOT_PAGES = new Set(["README.md", "CHANGELOG.md", "LICENSE.md"]);

const DEMO_MARKER = /^<!-- demo:[A-Za-z0-9_-]+ -->$/;

const ALLOWED_SCHEME = /^(https?|mailto):/i;

let packed: string[] = [];

beforeAll(async () => {
  const { stdout } = await execFileAsync("pnpm", ["pack", "--dry-run", "--json"], {
    cwd: PACKAGE,
    maxBuffer: 32 * 1024 * 1024,
  });
  // pnpm echoes the prepack command before the JSON.
  const tarball = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { files: { path: string }[] };
  packed = tarball.files.map(({ path }) => path).sort();
}, 120_000);

function pages(): string[] {
  return packed.filter(
    (path) => path.endsWith(".md") && !NOT_PAGES.has(path) && !path.startsWith("assets/"),
  );
}

function read(path: string): string {
  return readFileSync(join(PACKAGE, path), "utf8");
}

interface Nav {
  label: string;
  pages: string[];
}

function nav(): Nav[] {
  return JSON.parse(read("nav.json")) as Nav[];
}

function tokensOf(page: string): Token[] {
  const marked = new Marked();
  const tokens = marked.lexer(parseFrontmatter(read(page), page).body);
  const found: Token[] = [];
  marked.walkTokens(tokens, (token) => {
    found.push(token);
  });
  return found;
}

test("pnpm pack lists only markdown, nav.json, assets, package.json and LICENSE", () => {
  expect(
    packed.filter(
      (path) => !/^(package\.json|LICENSE|nav\.json|assets\/.+|.+\.md)$/.test(path),
    ),
  ).toEqual([]);
  expect(packed).toEqual(expect.arrayContaining(["package.json", "LICENSE", "nav.json"]));
  expect(pages().length).toBeGreaterThan(40);
});

test("every page has a title and a description in its frontmatter", () => {
  const faults = pages().flatMap((page) => {
    const { frontmatter } = parseFrontmatter(read(page), page);
    return ["title", "description"]
      .filter((field) => {
        const value = frontmatter[field];
        return typeof value !== "string" || value.trim() === "";
      })
      .map((field) => `${page}: no "${field}" — add it to the page's frontmatter`);
  });
  expect(faults).toEqual([]);
});

test("nav.json is a list of labelled groups that lists every page once, and nothing else", () => {
  const groups = nav();
  expect(Array.isArray(groups)).toBe(true);
  for (const group of groups) {
    expect(typeof group.label === "string" && group.label !== "", JSON.stringify(group)).toBe(true);
    expect(Array.isArray(group.pages), group.label).toBe(true);
  }
  const listed = groups.flatMap((group) => group.pages);
  expect(listed.filter((page, index) => listed.indexOf(page) !== index), "listed twice").toEqual([]);
  expect(listed.filter((page) => !pages().includes(page)), "listed, but not a page").toEqual([]);
  expect(pages().filter((page) => !listed.includes(page)), "a page nav.json does not list").toEqual([]);
});

test("no two pages share a route", () => {
  const routes = pages().map((page) => page.replace(/\.md$/, "").replace(/(^|\/)index$/, ""));
  expect(routes.filter((route, index) => routes.indexOf(route) !== index)).toEqual([]);
});

test("every link is a relative link to a page, a fragment or a web address, and every image is under assets/", () => {
  const faults: string[] = [];
  for (const page of pages()) {
    for (const token of tokensOf(page)) {
      if (token.type !== "link" && token.type !== "image") continue;
      const href = (token as { href: string }).href;
      const fault = linkFault(page, href, token.type === "image");
      if (fault !== undefined) faults.push(`${page}: "${href}" — ${fault}`);
    }
  }
  expect(faults).toEqual([]);
});

function linkFault(page: string, href: string, image: boolean): string | undefined {
  if (href.includes("&")) return "holds &, which the docs site refuses; write the character itself or percent-encode it";
  if (ALLOWED_SCHEME.test(href)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return "a scheme other than http, https or mailto";
  if (href.startsWith("//")) return "names another host without a scheme; write https:";
  if (href.startsWith("/")) return "a site route; link the page by its relative .md path";
  if (href.startsWith("#") && !image) return undefined;
  const target = posix.join(posix.dirname(page), href.split("#")[0] ?? "");
  if (image) {
    return target.startsWith("assets/") && packed.includes(target)
      ? undefined
      : "an image that is not a packed file under assets/";
  }
  if (!target.endsWith(".md")) return "a relative link to a file that is not a .md page";
  return pages().includes(target) ? undefined : `no page at ${target}`;
}

test("the only HTML a page holds is a demo marker, on a line of its own", () => {
  const faults: string[] = [];
  for (const page of pages()) {
    for (const token of tokensOf(page)) {
      if (token.type !== "html") continue;
      const raw = (token as { raw: string }).raw;
      const own = (token as { block?: boolean }).block === true && DEMO_MARKER.test(raw.trim());
      if (!own) faults.push(`${page}: ${JSON.stringify(raw.trim())}`);
    }
  }
  expect(faults).toEqual([]);
});
