import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { EXIT_CODES } from "./exit.js";
import { readManifest } from "./manifest.js";

const SITES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const CORE = import.meta.dirname;
const FIXTURES = join(CORE, "..", "..", "fixtures", "src", "index.ts");

const MOUNTED_SITE = join(SITES, ".pagedeck-mount-mounted-test");
const MISSING_SITE = join(SITES, ".pagedeck-mount-missing-test");
const QUOTED_SITE = join(SITES, ".pagedeck-mount-quoted-test");

// `createElement`, not JSX: `pagedeck.config.ts` loads in plain Node, which does not
// transform JSX.
const MOUNT_COMPONENT = `import { createElement } from "react";
export default function Mount({ id, html }) {
  return createElement(
    "div",
    null,
    html === undefined
      ? null
      : createElement("div", { dangerouslySetInnerHTML: { __html: html } }),
    id === undefined ? null : createElement("div", { id }, "marker-mount-7b3e"),
  );
}
`;

function site(root: string, props: object, scripts: string): string {
  rmSync(root, { recursive: true, force: true });

  mkdirSync(join(root, "components"), { recursive: true });
  writeFileSync(join(root, "components", "Mount.js"), MOUNT_COMPONENT);
  const file = join(root, "content", "en", "home.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ rev: 1, data: {} })}\n`);

  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(join(CORE, "config.ts"))};
import { definePages, fromCollection } from ${JSON.stringify(join(CORE, "pages.ts"))};
import { defineLocales } from ${JSON.stringify(join(CORE, "locales.ts"))};
import { defineScripts } from ${JSON.stringify(join(CORE, "scripts.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(root, "content"))}),
  schema: false,
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    ${scripts}
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: () => "/" })],
    }),
    components: {
      Mount: "./components/Mount.js",
    },
    tierPolicy: { minSize: 0 },
    content: () => ({
      tree: [{ component: "Mount", props: ${JSON.stringify(props)} }],
    }),
  },
});
`,
  );
  return root;
}

const MOUNT_SCRIPTS = `scripts: defineScripts({
      scripts: [
        { name: "comments", src: "https://example.com/comments.js", strategy: "facade", facade: { html: "<button>marker-comments-4d81</button>", mount: "comments" } },
        { name: "chat", src: "https://example.com/chat.js", strategy: "facade", facade: { html: "<button>marker-chat-9f02</button>" } },
      ],
    }),`;

const MISSING_SCRIPTS = `scripts: defineScripts({
      scripts: [
        { name: "comments", src: "https://example.com/comments.js", strategy: "facade", facade: { html: "<button>marker-comments-4d81</button>", mount: "comments" } },
        { name: "chat", src: "https://example.com/chat.js", strategy: "facade", facade: { html: "<button>marker-chat-9f02</button>", mount: "chat" } },
      ],
    }),`;

async function runCode(
  cwd: string,
  ...argv: string[]
): Promise<{ code: number; err: string }> {
  const { runCli } = await import("./cli.js");
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: () => undefined,
    err: (line) => err.push(line),
  });
  return { code, err: err.join("\n") };
}

async function run(cwd: string, ...argv: string[]): Promise<void> {
  const { code, err } = await runCode(cwd, ...argv);
  if (code !== EXIT_CODES.success) throw new Error(err);
}

afterAll(() => {
  for (const root of [MOUNTED_SITE, MISSING_SITE, QUOTED_SITE]) {
    rmSync(root, { recursive: true, force: true });
  }
});

const SAMPLE = '<pre><code>id="comments"</code></pre>';

let mounted: Promise<string> | undefined;

function built(): Promise<string> {
  mounted ??= (async () => {
    const dir = site(
      MOUNTED_SITE,
      { id: "comments", html: SAMPLE },
      MOUNT_SCRIPTS,
    );
    for (const verb of ["sync", "build"]) await run(dir, verb);
    const dist = join(dir, "dist");
    const file = join(dist, "manifest.json");
    const manifest = readManifest(readFileSync(file, "utf8"), file);
    const page = manifest.pages[0] as { html: string };
    return readFileSync(join(dist, page.html), "utf8");
  })();
  return mounted;
}

test("a declared mount point puts the placeholder inside the element that carries it", async () => {
  const html = await built();

  expect(html).toMatch(
    /<div id="comments"><div data-fw-facade="[0-9a-f]{8}-0"><button>marker-comments-4d81<\/button><\/div>marker-mount-7b3e<\/div>/,
  );
}, 120_000);

test("the same page's code sample quoting that id is emitted as it was written", async () => {
  const html = await built();

  expect(html).toContain(SAMPLE);
}, 120_000);

test("the facade that declares no mount point is still last inside the landmark", async () => {
  const html = await built();

  // Each is asserted present first: `indexOf` answers -1 for a missing marker, which
  // orders before everything.
  expect(html).toContain("marker-mount-7b3e");
  expect(html).toContain("marker-chat-9f02");
  expect(html).toContain("marker-comments-4d81");
  expect(html).toContain("</main>");
  const content = html.indexOf("marker-mount-7b3e");
  const closes = html.indexOf("</main>");

  const chat = html.indexOf("marker-chat-9f02");
  expect(chat).toBeGreaterThan(content);
  expect(chat).toBeLessThan(closes);
  const comments = html.indexOf("marker-comments-4d81");
  expect(comments).toBeLessThan(content);
  expect(comments).toBeLessThan(closes);
}, 120_000);

test("a mount point no element carries refuses the build, naming every facade", async () => {
  const dir = site(MISSING_SITE, { id: "elsewhere" }, MISSING_SCRIPTS);
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain(
    'Entry /en/: 2 facades declare a mount point no element on this page carries — a facade\'s placeholder is emitted inside the element its mount point names, so this page has nowhere to put one; render the element, or take the script off this page with a pages or pageTypes override set to "off":',
  );
  expect(err).toContain('  "comments" — no element carries id="comments"');
  expect(err).toContain('  "chat" — no element carries id="chat"');
}, 120_000);

test("the id's bytes in text and inside another attribute are not a mount point", async () => {
  const dir = site(
    QUOTED_SITE,
    {
      html: `${SAMPLE}<div title=' id="comments"'>marker-quoted-3c17</div>`,
    },
    MOUNT_SCRIPTS,
  );
  await run(dir, "sync");
  const { code, err } = await runCode(dir, "build");

  expect(code).toBe(EXIT_CODES.syncFailed);
  expect(err).toContain('  "comments" — no element carries id="comments"');
}, 120_000);
