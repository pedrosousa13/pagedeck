import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER, readManifest } from "@pagedeck/core";
import type { Manifest, ManifestPage } from "@pagedeck/core";
import { STYLING_OPTIONS } from "./styling.js";

const execFileAsync = promisify(execFile);

// Not under `node_modules`, where Node refuses to strip types, and inside this
// package, so its self-referencing subpaths resolve from here.
const SITE = join(import.meta.dirname, "..", ".pagedeck-site-build-test");
const DIST = join(SITE, "dist");
const SUPPORT = join(import.meta.dirname, "site.test-support.ts");

const ISLANDED = [
  ["en", "en", "/"],
  ["de", "de", "/"],
  ["en/pricing", "en", "/pricing"],
] as const;
const STATIC = [["en/legal/terms", "en", "/legal/terms"]] as const;

const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// Only lines the executable marked count: tools the build loads write their own
// advisories to stderr, and an empty-stderr check flaked on them (#184, #202).
async function run(verb: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(process.execPath, [BIN, verb], {
    cwd: SITE,
  });
  expect(
    stderr
      .split("\n")
      .filter((line) => line.startsWith(`${DIAGNOSTIC_MARKER} `))
      .join("\n"),
  ).toBe("");
  return stdout;
}

function assetUrls(html: string): string[] {
  return [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g),
    ...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g),
  ].map((match) => match[1] as string);
}

// Drops stylesheets: `build.css` links one on every page, and the checks that
// read this list are about JavaScript.
function nonStyleAssetUrls(html: string): string[] {
  return assetUrls(html).filter((url) => !url.endsWith(".css"));
}

function modulePreloads(html: string): string[] {
  return [...html.matchAll(/<link rel="modulepreload" href="([^"]*)">/g)].map(
    (match) => match[1] as string,
  );
}

// Escapes twice: once as the sheet writes the selector, then the result for
// `RegExp`, where an unescaped `.` or `[` compiles and silently mis-matches.
function selectorPattern(name: string): string {
  const selector = name.replace(/[^\w-]/g, (char) => `\\${char}`);
  return selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function document(path: string): string {
  return readFileSync(join(DIST, path, "index.html"), "utf8");
}

function page(manifest: Manifest, locale: string, path: string): ManifestPage {
  const found = manifest.pages.find(
    (row) => row.locale === locale && row.path === path,
  );
  if (found === undefined) {
    throw new Error(
      `Manifest: records no page ${locale} ${path} — it holds ${manifest.pages
        .map((row) => `${row.locale} ${row.path}`)
        .join(", ")}`,
    );
  }
  return found;
}

let manifest: Manifest;

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `import { testSiteConfig } from ${JSON.stringify(SUPPORT)};\nexport default testSiteConfig();\n`,
  );

  await run("sync");
  await run("build");

  manifest = readManifest(
    readFileSync(join(DIST, "manifest.json"), "utf8"),
    "manifest.json",
  );
}, 120_000);

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("the site's entries become the route table their entry ids describe", () => {
  expect(manifest.pages.map((row) => `${row.locale} ${row.path}`)).toEqual([
    "de /",
    "en /",
    "en /legal/terms",
    "en /pricing",
  ]);
  expect(manifest.pages.map((row) => row.output)).toEqual([
    "/de",
    "/en",
    "/en/legal/terms",
    "/en/pricing",
  ]);
  expect(manifest.routing.trees.length).toBeGreaterThan(0);
});

test("every page renders its own entry through the real components", () => {
  // Asserted as rendered markup, never as a bare value: an island's props also
  // appear in its `data-fw-props`, where `<` is escaped.
  expect(document("en")).toContain("<h1>Ship the site</h1>");
  expect(document("en")).toContain(">See pricing</a>");
  expect(document("en")).toContain("<h2>Fast</h2>");
  expect(document("de")).toContain("<h1>Bau die Seite</h1>");
  expect(document("en/pricing")).toContain("<h1>Plans</h1>");
  expect(document("en/pricing")).toContain("<td>Starter</td>");
  expect(document("en/legal/terms")).toContain("<h1>Terms</h1>");
  expect(document("en/legal/terms")).toContain("<p>The terms.</p>");

  expect(document("en")).toContain('href="/en/pricing"');
});

test("an islanded page ships the entry chunk the manifest names for it", () => {
  const html = document("en");
  expect(html).toContain('data-fw-component="hero"');
  expect(html).toContain('data-fw-mode="visible"');

  const row = page(manifest, "en", "/");
  expect(row.components.map((component) => component.name)).toEqual(["hero"]);
  expect(row.components[0]?.module).toBe("@pagedeck/design-system/components/hero");

  // Nothing in the build compares the document's script to the manifest's entry
  // chunk; `checkSiteLinks` would pass on another page's chunk.
  expect(row.entryChunk).toBeDefined();
  expect(nonStyleAssetUrls(html)).toEqual([row.entryChunk, ...modulePreloads(html)]);
  expect(manifest.files.some((file) => file.path === row.entryChunk)).toBe(true);

  const other = page(manifest, "de", "/");
  expect(nonStyleAssetUrls(document("de"))).toEqual([
    other.entryChunk,
    ...modulePreloads(document("de")),
  ]);
  expect(other.entryChunk).toBe(row.entryChunk);
});

test("a real `use client` component of the catalog islands through the executable", () => {
  const html = document("en/pricing");
  expect(html).toContain('data-fw-component="pricing_page"');
  expect(html).toContain('data-fw-mode="visible"');

  const row = page(manifest, "en", "/pricing");
  expect(row.components.map((component) => component.name)).toEqual([
    "pricing_page",
  ]);
  expect(row.components[0]?.module).toBe(
    "@pagedeck/design-system/components/pricing_page",
  );

  expect(row.entryChunk).toBeDefined();
  expect(nonStyleAssetUrls(html)).toEqual([row.entryChunk, ...modulePreloads(html)]);
  expect(manifest.files.some((file) => file.path === row.entryChunk)).toBe(true);

  const home = page(manifest, "en", "/");
  expect(row.entryChunk).not.toBe(home.entryChunk);
});

test("a page the build islands nothing on ships no JavaScript at all", () => {
  for (const [path, locale, route] of STATIC) {
    const html = document(path);
    expect(html).not.toContain("<fw-island");
    expect(html).not.toContain("<script");
    expect(nonStyleAssetUrls(html)).toEqual([]);
    expect(page(manifest, locale, route).entryChunk).toBeUndefined();
    expect(page(manifest, locale, route).components).toEqual([]);
  }
});

test("no JavaScript a production build emits holds the dev server's hot-update code", () => {
  // Every `.js` in the tree, for tokens that survive minification: a specifier and
  // `import.meta.hot` would be absent from a failing build too.
  const emitted = readdirSync(DIST, { recursive: true })
    .map((file) => String(file))
    .filter((file) => file.endsWith(".js"));
  expect(emitted.length).toBeGreaterThan(0);
  for (const file of emitted) {
    const code = readFileSync(join(DIST, file), "utf8");
    expect(code).not.toContain("hotIslands");
    // Spelled rather than imported, so a rename cannot move the assertion with the
    // code.
    expect(code).not.toContain("fw:islands");
  }
});

test("every URL the emitted HTML references is a file the build wrote", () => {
  const referenced: string[] = [];
  for (const [path] of [...ISLANDED, ...STATIC]) {
    for (const url of assetUrls(document(path))) {
      referenced.push(url);
      expect(url.startsWith("/")).toBe(true);
      expect(existsSync(join(DIST, url))).toBe(true);
    }
  }
  expect(referenced.length).toBeGreaterThan(0);
  expect(existsSync(join(DIST, "/assets", referenced[0] as string))).toBe(false);
});

test("every file the manifest records is a file on disk", () => {
  const missing = manifest.files.filter(
    (file) => !existsSync(join(DIST, file.domain ?? "", file.path)),
  );
  expect(missing.map((file) => file.path)).toEqual([]);
  expect(manifest.files.some((file) => file.kind === "js")).toBe(true);
  expect(manifest.files.some((file) => file.kind === "html")).toBe(true);
});

const FIX =
  "bring the class within an @source of styles/global.css, or drop the value from STYLING_OPTIONS";

test("every class an entry can reach has a rule behind it in the emitted CSS", () => {
  const linked = new Set<string>();
  for (const [path] of [...ISLANDED, ...STATIC]) {
    const sheets = assetUrls(document(path)).filter((url) =>
      url.endsWith(".css"),
    );
    expect(sheets).toHaveLength(1);
    linked.add(sheets[0] as string);
  }
  expect([...linked]).toHaveLength(1);

  const css = readFileSync(join(DIST, [...linked][0] as string), "utf8");
  expect(Object.keys(STYLING_OPTIONS).length).toBeGreaterThan(0);
  const faults: string[] = [];
  for (const [field, option] of Object.entries(STYLING_OPTIONS)) {
    const classes = new Set(
      Object.values(option.values).flatMap((all) => all.split(" ")),
    );
    expect(classes.size).toBeGreaterThan(0);
    for (const name of classes) {
      const rule = new RegExp(
        `\\.${selectorPattern(name)}(?![\\w-])\\s*\\{([^}]+)\\}`,
      ).exec(css);
      if (rule === null) {
        faults.push(
          `  ${field}: ${name} — no rule in the emitted stylesheet — ${FIX}`,
        );
        continue;
      }
      const body = rule[1] as string;
      for (const [, variable] of body.matchAll(/var\((--[\w-]+)/g)) {
        if (!css.includes(`${variable as string}:`)) {
          faults.push(
            `  ${field}: ${name} — {${body}} reaches ${variable as string}, which this sheet never defines — ${FIX}`,
          );
        }
      }
    }
  }
  expect(faults.length === 0 ? "" : `\n${faults.join("\n")}`).toBe("");
});
