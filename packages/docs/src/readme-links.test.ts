import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseFrontmatter } from "@pagedeck/markdown-loader";
import { navPages, PACKAGE, routeOf, sourceOf } from "./pages.test-support.js";
import { docsRenderer } from "./render.test-support.js";

// Where deck-cool's `sites/pagedeck` serves these pages. Every README spells it, and this is
// what they are checked against.
const DOCS_ORIGIN = "https://page.deck.cool/docs";

const REPOSITORY = join(PACKAGE, "..", "..");

function linkingFiles(): string[] {
  const packages = readdirSync(join(REPOSITORY, "packages"))
    .map((name) => join("packages", name, "README.md"))
    .filter((path) => existsSync(join(REPOSITORY, path)));
  return [
    "README.md",
    ...packages,
    join("packages", "create-pagedeck", "src", "index.ts"),
    join("packages", "create-pagedeck", "template-app", "README.md"),
  ].sort();
}

const DOCS_LINK = new RegExp(
  `${DOCS_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/[^)\\s"#]*)(?:#([^)\\s"]*))?`,
  "g",
);

const pagesByRoute = (): Map<string, string> => new Map(navPages().map((page) => [routeOf(page), page]));

test("every docs link a README writes names a page nav.json lists, and a heading on it", async () => {
  const pages = pagesByRoute();
  const render = await docsRenderer();
  const dangling: string[] = [];
  let links = 0;
  for (const file of linkingFiles()) {
    const text = readFileSync(join(REPOSITORY, file), "utf8");
    for (const [href, route, fragment] of text.matchAll(DOCS_LINK)) {
      links += 1;
      const page = pages.get(route as string);
      if (page === undefined) {
        dangling.push(`${file}: ${href} — no page at ${route as string}; link the page's route with its trailing slash`);
        continue;
      }
      if (fragment === undefined) continue;
      const { body } = parseFrontmatter(readFileSync(sourceOf(page), "utf8"), page);
      const { toc } = await render.render(body, page);
      if (!toc.some(({ slug }) => slug === fragment)) {
        dangling.push(`${file}: ${href} — ${route as string} has no heading #${fragment}; link a heading id the page has, or drop the fragment`);
      }
    }
  }
  expect(dangling).toEqual([]);
  expect(links).toBeGreaterThan(20);
});

test("no README links the docs at an origin other than DOCS_ORIGIN", () => {
  const strayLinks = linkingFiles().flatMap((file) =>
    [...readFileSync(join(REPOSITORY, file), "utf8").matchAll(/(https?:\/\/[\w.-]+)[^\s)"'`<>]*/g)]
      .filter(([, origin]) => /\.workers\.dev$|pagedeck-docs/.test(origin as string))
      .map(([href]) => `${file}: ${href}`),
  );
  expect(strayLinks, `link the page at ${DOCS_ORIGIN}/<route>/ instead`).toEqual([]);
});

test("no README links the docs' markdown in the repository instead of the deployed site", () => {
  const repositoryLinks = linkingFiles().flatMap((file) =>
    [
      ...readFileSync(join(REPOSITORY, file), "utf8").matchAll(
        /(?:\]\(|")([^)"\s]*packages\/docs\/[^)"\s]*\.md)/g,
      ),
    ].map((match) => `${file}: ${match[1] as string}`),
  );
  expect(repositoryLinks, `link the page at ${DOCS_ORIGIN}/<route>/ instead`).toEqual([]);
});
