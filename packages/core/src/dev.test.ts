// Spawned, not in process: `installClientReferences` hooks only what Node loads, and
// under Vitest every `import()` in this package is Vitest's.
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { lanAddresses } from "./cli.js";
import { ConfigError, EXIT_CODES } from "./exit.js";
import { MEMO_CACHE_INIT } from "./react-compiler.test-support.js";

const execFileAsync = promisify(execFile);

// Outside `node_modules`: Vite's watcher ignores it, and Node will not strip types
// from a `pagedeck.config.ts` under it.
const SITE = join(import.meta.dirname, "..", ".pagedeck-dev-test");
const SOURCE = join(SITE, "src");
const CONTENT = join(SITE, "content");
const COUNTER = join(SOURCE, "Counter.js");
const NOTE = join(SOURCE, "Note.tsx");
const PATH_NOTE = join(SOURCE, "PathNote.tsx");
const QUOTE_TEXT = join(SOURCE, "quote-text.ts");
const SHOUT = join(SOURCE, "Shout.tsx");
const BAILING = join(SOURCE, "Bailing.tsx");
const FLAKY = join(SOURCE, "Flaky.tsx");
const CONFIG = join(SITE, "pagedeck.config.ts");
const GLOBAL_CSS = join(SITE, "styles", "global.css");
const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const UNSYNCED = join(import.meta.dirname, "..", ".pagedeck-dev-unsynced");

const FALLBACK = join(import.meta.dirname, "..", ".pagedeck-dev-worker-fallback");

const COMPILED = join(import.meta.dirname, "..", ".pagedeck-dev-compiled");

const STARTUP_TIMEOUT = 60_000;
const MESSAGE_TIMEOUT = 20_000;

function noteSource(marker: string): string {
  return [
    `export default function Note({ text }: { text: string }) {`,
    `  return <p data-text={text}>${marker}</p>;`,
    `}`,
    "",
  ].join("\n");
}

function quoteTextSource(marker: string): string {
  return `export const QUOTE: string = ${JSON.stringify(marker)};\n`;
}

function shoutSource(marker: string): string {
  return [
    `"use client";`,
    `export default function Shout({ items }: { items: readonly string[] }) {`,
    `  const shouted = items.map((item) => item.toUpperCase());`,
    `  return <ul data-marker=${JSON.stringify(marker)}>{shouted.map((item) => <li key={item}>{item}</li>)}</ul>;`,
    `}`,
    "",
  ].join("\n");
}

// `Trimmed` is never rendered: the server freezes props in development, so a
// rendered write to them would throw.
function bailingSource(fixed: boolean): string {
  return [
    `"use client";`,
    `export default function Bailing({ title }: { title: string }) {`,
    `  return <p>{title}</p>;`,
    `}`,
    `export function Trimmed(props: { title: string }) {`,
    fixed ? `  const title = props.title.trim();` : `  props.title = props.title.trim();`,
    `  return <p>{${fixed ? "title" : "props.title"}}${fixed ? "bailing-fixed-3c7a" : ""}</p>;`,
    `}`,
    "",
  ].join("\n");
}

function flakySource(marker: string): string {
  return `"use client";\n${noteSource(marker)}`;
}

const BROKEN_FLAKY = [
  `"use client";`,
  `export default function Flaky( {`,
  `  return <p>;`,
  `}`,
  "",
].join("\n");

function counterSource(marker: string): string {
  return [
    `"use client";`,
    `import { createElement } from "react";`,
    `export default function Counter() {`,
    `  return createElement("button", null, ${JSON.stringify(marker)});`,
    `}`,
    "",
  ].join("\n");
}

let server: ChildProcess;
let announced = "";
let origin: string;
const diagnostics: string[] = [];

const CONFIG_MARKER = "config-before-3a1e";

function writeSite(): void {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(SOURCE, { recursive: true });
  mkdirSync(dirname(GLOBAL_CSS), { recursive: true });
  mkdirSync(join(CONTENT, "en"), { recursive: true });
  writeFileSync(GLOBAL_CSS, `.fw-global-3b91 { color: rgb(1, 2, 3); }\n`);
  writeFileSync(COUNTER, counterSource("counter-before-1f4c"));
  writeFileSync(
    join(SOURCE, "Prose.js"),
    `export default function Prose() { return "prose-8d31"; }\n`,
  );
  writeFileSync(join(SOURCE, "Sidebar.js"), counterSource("sidebar-2c07"));
  writeFileSync(NOTE, noteSource("note-before-4e1a"));
  writeFileSync(join(SOURCE, "Pathed.js"), counterSource("pathed-6d2b"));
  writeFileSync(join(SOURCE, "Aliased.js"), counterSource("aliased-9b14"));
  writeFileSync(PATH_NOTE, noteSource("path-note-before-8a40"));
  writeFileSync(
    join(SOURCE, "Quote.tsx"),
    [
      `import { QUOTE } from "./quote-text.ts";`,
      `export default function Quote() {`,
      `  return <q>{QUOTE}</q>;`,
      `}`,
      "",
    ].join("\n"),
  );
  writeFileSync(QUOTE_TEXT, quoteTextSource("quote-before-5c62"));
  writeFileSync(SHOUT, shoutSource("shout-before-7b2e"));
  writeFileSync(BAILING, bailingSource(false));
  writeFileSync(FLAKY, flakySource("flaky-before-2d9c"));
  writeFileSync(
    join(SOURCE, "NestBadge.tsx"),
    [
      `"use client";`,
      `import { useId } from "react";`,
      `export default function NestBadge({ label }: { label: string }) {`,
      `  return <output id={useId()}>{label}</output>;`,
      `}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(SOURCE, "NestPanel.tsx"),
    [
      `"use client";`,
      `import NestBadge from "./NestBadge.tsx";`,
      `export default function NestPanel() {`,
      `  return <section>nest-panel-6b0d<NestBadge label="nest-inside-2e85" /></section>;`,
      `}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(SOURCE, "NestPage.tsx"),
    [
      `import NestBadge from "./NestBadge.tsx";`,
      `import NestPanel from "./NestPanel.tsx";`,
      `export default function NestPage() {`,
      `  return <div><NestPanel /><NestBadge label="nest-direct-c39a" /></div>;`,
      `}`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(SOURCE, "Foot.js"),
    `export default function Foot() { return "foot-5a90"; }\n`,
  );
  for (const path of ["hot", "twin", "cold", "missing", "broken-head", "framed", "noted", "pathed", "aliased", "path-noted", "quoted", "shouted", "bailing", "flaky", "nested"]) {
    writeFileSync(
      join(CONTENT, "en", `${path}.json`),
      `${JSON.stringify({ rev: 1, data: { title: path } })}\n`,
    );
  }
  writeConfig(CONFIG_MARKER);
}

function writeConfig(marker: string): void {
  writeFileSync(
    CONFIG,
    `
import { ConfigError, defineConfig, defineLocales, definePages, defineScripts, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(CONTENT)}),
  schema: false,
};

const TREES = {
  "/hot": [{ component: "counter" }],
  "/twin": [{ component: "counter" }],
  "/cold": [{ component: "sidebar" }],
  "/missing": [{ component: "nowhere" }],
  "/broken-head": [{ component: "prose" }],
  "/framed": [{ component: "prose" }],
  "/noted": [{ component: "note", props: { text: "noted" } }],
  "/pathed": [{ component: "pathed" }],
  "/aliased": [{ component: "aliased" }],
  "/path-noted": [{ component: "path_note", props: { text: "path-noted" } }],
  "/quoted": [{ component: "quote" }],
  "/shouted": [{ component: "shout", props: { items: ["shout-item-41af"] } }],
  "/bailing": [{ component: "bailing", props: { title: "bailing" } }],
  "/flaky": [{ component: "flaky", props: { text: "flaky" } }],
  "/nested": [{ component: "nest_page" }],
};

// \`@/\` is an alias only the site's plugin knows.
const alias = {
  name: "site:alias",
  resolveId(source: string) {
    return source.startsWith("@/") ? ${JSON.stringify(`${SOURCE}/`)} + source.slice(2) : undefined;
  },
};

export default defineConfig({
  store: "./content.db",
  collections: [pages],
  build: {
    outDir: "./dist",
    css: ["./styles/global.css"],
    vite: { plugins: [alias] },
    // \`worker\` as well as \`idle\`: only \`worker\` calls the site's own \`runtime\`, in the server process.
    scripts: defineScripts({
      scripts: [
        { name: "metrics", src: "https://example.com/metrics-dev-7e21.js", strategy: "idle" },
        { name: "widget", src: "https://example.com/widget-dev-4c88.js", strategy: "worker" },
      ],
      runtime: ({ scripts }) => [
        '<script>marker-worker-boot-2f5a</script>',
        ...scripts.map((s) => '<script type="text/worker" src="' + s.src + '"></script>'),
      ],
    }),
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: (entry) => "/" + entry.path })],
    }),
    components: {
      counter: "./src/Counter.js",
      sidebar: "./src/Sidebar.js",
      prose: "./src/Prose.js",
      foot: "./src/Foot.js",
      note: "./src/Note.tsx",
      pathed: "./src/Pathed.js",
      aliased: "@/Aliased.js",
      path_note: { path: "./src/PathNote.tsx" },
      quote: "./src/Quote.tsx",
      shout: "./src/Shout.tsx",
      bailing: "./src/Bailing.tsx",
      flaky: "./src/Flaky.tsx",
      nest_page: "./src/NestPage.tsx",
      nest_panel: { path: "./src/NestPanel.tsx", hydrate: "load" },
      nest_badge: { path: "./src/NestBadge.tsx", hydrate: "load" },
    },
    content: (page) => ({ tree: TREES[page.path] }),
    chrome: (page) =>
      page.path === "/framed"
        ? { before: [{ component: "sidebar" }], after: [{ component: "foot" }] }
        : undefined,
    // The one config fault a request can meet: every other is refused before the server listens.
    head: (page) => {
      if (page.path === "/broken-head") {
        throw new ConfigError(
          \`Config "\${${JSON.stringify(CONFIG)}}": "build.head" reads a setting this site does not declare, so \${page.locale} \${page.path} has no head to emit — declare the setting, or remove the head callback\`,
          { cause: new Error('Site settings: no "brand" is declared') },
        );
      }
      return { title: ${JSON.stringify(marker)} };
    },
    // pagedeck dev runs no adapter (#20): one that threw would fail every request below.
    adapter: {
      name: "fake-host",
      compile: () => {
        throw new Error("pagedeck dev ran the adapter");
      },
    },
  },
});
`,
  );
}

async function start(): Promise<string> {
  const child = spawn(process.execPath, [BIN, "dev", "--port", "0"], {
    cwd: SITE,
  });
  server = child;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split("\n")) {
      if (line !== "") diagnostics.push(line);
    }
  });

  return await new Promise<string>((resolve, reject) => {
    let out = "";
    const fail = (error: unknown): void => {
      child.kill("SIGKILL");
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => {
      fail(
        new Error(
          `pagedeck dev printed no URL within ${String(STARTUP_TIMEOUT)}ms — it wrote:\n${out}\n${diagnostics.join("\n")}`,
        ),
      );
    }, STARTUP_TIMEOUT);
    child.on("error", fail);
    child.on("exit", (code) => {
      fail(
        new Error(
          `pagedeck dev exited with ${String(code)} before it was listening:\n${diagnostics.join("\n")}`,
        ),
      );
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      announced = out;
      const found = /at (http:\/\/[^\s]+)/.exec(out);
      if (found === null) return;
      clearTimeout(timer);
      resolve(found[1] as string);
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

beforeAll(async () => {
  writeSite();
  const synced = await execFileAsync(process.execPath, [BIN, "sync"], {
    cwd: SITE,
  });
  expect(synced.stdout).toContain("pages:");

  origin = await start();
  try {
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  } catch (error) {
    await stop(server);
    throw error;
  }
}, 120_000);

afterAll(async () => {
  try {
    if (server !== undefined) await stop(server);
  } finally {
    rmSync(SITE, { recursive: true, force: true });
  }
});

async function get(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.text() };
}

function scriptUrls(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/g)].map(
    (match) => match[1] as string,
  );
}

function styleUrls(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*\bhref="([^"]*)"/g)].map(
    (match) => match[1] as string,
  );
}

function importSpecifier(entry: string, file: string): string {
  const found = new RegExp(`import\\("([^"]*${file}[^"]*)"\\)`).exec(entry);
  if (found === null) {
    throw new Error(`no import of "${file}" in this entry module:\n${entry}`);
  }
  return found[1] as string;
}

interface HotMessage {
  type: string;
  updates?: { type: string; path: string; acceptedPath: string }[];
  err?: { message: string; stack: string };
}

class HotClient {
  private readonly received: HotMessage[] = [];
  private readonly waiting: (() => void)[] = [];
  private constructor(private readonly socket: WebSocket) {}

  static async connect(at: string = origin): Promise<HotClient> {
    const socket = new WebSocket(`${at.replace("http", "ws")}/`, [
      "vite-hmr",
    ]);
    const client = new HotClient(socket);
    socket.addEventListener("message", (event) => {
      client.received.push(JSON.parse(String(event.data)) as HotMessage);
      for (const wake of client.waiting.splice(0)) wake();
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => {
        resolve();
      });
      socket.addEventListener("error", () => {
        reject(new Error(`no HMR socket on ${at}`));
      });
    });
    return client;
  }

  get messages(): readonly HotMessage[] {
    return this.received;
  }

  async next(type: string): Promise<HotMessage> {
    const deadline = Date.now() + MESSAGE_TIMEOUT;
    for (;;) {
      const found = this.received.find((message) => message.type === type);
      if (found !== undefined) return found;
      if (Date.now() >= deadline) {
        throw new Error(
          `no "${type}" within ${String(MESSAGE_TIMEOUT)}ms — received ${JSON.stringify(this.received)}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

test("an island component edit updates that page's entry rather than reloading", async () => {
  const page = await get("/hot");
  expect(page.status).toBe(200);
  expect(page.body).toContain('data-pagedeck-component="counter"');
  expect(page.body).toContain("counter-before-1f4c");

  const entryUrl = scriptUrls(page.body).find(
    (url) => url !== "/@vite/client",
  ) as string;
  const entry = await get(entryUrl);
  expect(entry.status).toBe(200);
  expect(entry.body).toContain("hotIslands(import.meta.hot, modules)");
  expect(entry.body).toContain("import.meta.hot.accept();");

  expect((await get("/src/Counter.js")).status).toBe(200);

  const cold = await get("/cold");
  const coldEntryUrl = scriptUrls(cold.body).find(
    (url) => url !== "/@vite/client",
  ) as string;
  expect(coldEntryUrl).not.toBe(entryUrl);
  const coldEntry = await get(coldEntryUrl);
  expect(coldEntry.status).toBe(200);
  const coldSpecifier = importSpecifier(coldEntry.body, "Sidebar.js");
  expect((await get("/src/Sidebar.js")).status).toBe(200);

  const client = await HotClient.connect();
  try {
    writeFileSync(COUNTER, counterSource("counter-after-90b7"));
    const update = await client.next("update");
    const updates = update.updates ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]?.type).toBe("js-update");
    expect(updates[0]?.path).toBe(entryUrl);
    expect(updates[0]?.acceptedPath).toBe(entryUrl);
    expect(
      client.messages.filter((message) => message.type === "full-reload"),
    ).toEqual([]);

    const before = importSpecifier(entry.body, "Counter.js");
    const after = importSpecifier((await get(entryUrl)).body, "Counter.js");
    expect(after).not.toBe(before);

    expect(importSpecifier((await get(coldEntryUrl)).body, "Sidebar.js")).toBe(
      coldSpecifier,
    );
  } finally {
    client.close();
  }
}, 60_000);

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + MESSAGE_TIMEOUT;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function islandModule(
  page: string,
  file: string,
): Promise<{ url: string; body: string }> {
  const served = await get(page);
  expect(served.status).toBe(200);
  const entryUrl = scriptUrls(served.body).find(
    (url) => url !== "/@vite/client",
  ) as string;
  const entry = await get(entryUrl);
  expect(entry.status).toBe(200);
  const url = importSpecifier(entry.body, file);
  const module = await get(url);
  expect(module.status).toBe(200);
  return { url, body: module.body };
}

test("a served island module carries React Compiler's output", async () => {
  const { body } = await islandModule("/shouted", "Shout.tsx");

  expect(body).toMatch(MEMO_CACHE_INIT);
  expect(body).toMatch(/compiler-runtime/);
});

test("a bailout in an island is written once, not once per request, and not again once it is fixed", async () => {
  const skipped = (): string[] =>
    diagnostics.filter((line) =>
      line.startsWith(`pagedeck: Module "${BAILING}" line 6: React Compiler skipped component "Trimmed"`),
    );
  const { url, body } = await islandModule("/bailing", "Bailing.tsx");
  expect(body).toMatch(MEMO_CACHE_INIT);
  expect((await get(url)).status).toBe(200);
  expect((await get(url)).status).toBe(200);
  expect(skipped()).toHaveLength(1);
  expect(skipped()[0]).toContain("It renders as written, without automatic memoization.");

  writeFileSync(BAILING, bailingSource(true));
  const fixed = await until(
    () => get(url),
    (module) => module.body.includes("bailing-fixed-3c7a"),
  );
  expect(fixed.body).toMatch(MEMO_CACHE_INIT);
  expect(skipped()).toHaveLength(1);
}, 60_000);

test("an island module the compiler cannot parse is reported through the run's channel and the overlay, and a save recovers it", async () => {
  const stopped = (): string[] =>
    diagnostics.filter((line) =>
      line.startsWith(`pagedeck: Module "${FLAKY}": React Compiler stopped on 1 fatal diagnostic`),
    );
  const { url } = await islandModule("/flaky", "Flaky.tsx");
  expect(stopped()).toEqual([]);

  const client = await HotClient.connect();
  try {
    writeFileSync(FLAKY, BROKEN_FLAKY);
    const refused = await until(() => get(url), (module) => module.status !== 200);
    expect(refused.status).not.toBe(200);
    const headline = `Module "${FLAKY}": React Compiler stopped on 1 fatal diagnostic and produced no code — correct each line below, then build again:`;
    const detail = "  line 3: Expected `:` but found `<`";
    expect(stopped()[0]).toBe(`pagedeck: ${headline}`);
    expect(diagnostics).toContain(`pagedeck: ${detail}`);
    const overlay = await client.next("error");
    expect(overlay.err?.message).toBe(`${headline}\n${detail}`);
    expect((await get("/hot")).status).toBe(200);

    writeFileSync(FLAKY, flakySource("flaky-after-6e07"));
    const recovered = await until(
      () => get(url),
      (module) => module.status === 200 && module.body.includes("flaky-after-6e07"),
    );
    expect(recovered.status).toBe(200);
    expect(recovered.body).toMatch(MEMO_CACHE_INIT);
  } finally {
    client.close();
  }
}, 60_000);

test("two pages with one island set are served one entry, and it resolves for both", async () => {
  const entries = async (path: string): Promise<string[]> =>
    scriptUrls((await get(path)).body).filter((url) => url.startsWith("/@id/"));
  const hot = await entries("/hot");
  const twin = await entries("/twin");
  expect(hot).toHaveLength(1);
  expect(twin).toEqual(hot);

  const entry = await get(twin[0] as string);
  expect(entry.status).toBe(200);
  expect(importSpecifier(entry.body, "Counter.js")).toBeDefined();
  const cold = await entries("/cold");
  expect(cold).toHaveLength(1);
  expect(cold).not.toEqual(hot);
}, 60_000);

test("a page's chrome is served beside the landmark, and its island joins the page's entry", async () => {
  const page = await get("/framed");
  expect(page.status).toBe(200);
  const body = page.body.slice(page.body.indexOf("<body>"));
  expect(body).toContain("\n<main>\nprose-8d31\n</main>\nfoot-5a90\n");
  expect(body.indexOf("sidebar-2c07")).toBeGreaterThan(-1);
  expect(body.indexOf("sidebar-2c07")).toBeLessThan(body.indexOf("<main>"));

  const entries = scriptUrls(page.body).filter((url) => url.startsWith("/@id/"));
  expect(entries).toHaveLength(1);
  const entry = await get(entries[0] as string);
  expect(entry.status).toBe(200);
  expect(importSpecifier(entry.body, "Sidebar.js")).toBeDefined();
}, 60_000);

test("a registry error reaches the overlay, the response and the run's channel", async () => {
  const client = await HotClient.connect();
  try {
    const failed = await get("/missing");
    expect(failed.status).toBe(500);

    const overlay = await client.next("error");
    const message = `Component "nowhere": not registered, and entry /en/missing references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry`;
    expect(overlay.err?.message).toBe(message);
    expect(failed.body).toContain(message);
    expect(diagnostics).toContain(`pagedeck: ${message}`);
    expect(scriptUrls(failed.body)).toContain("/@vite/client");
    expect(overlay.err?.stack).toContain("RegistryError");
  } finally {
    client.close();
  }
}, 60_000);

test("a config error reaches the overlay with its cause chain unflattened", async () => {
  const client = await HotClient.connect();
  try {
    const failed = await get("/broken-head");
    expect(failed.status).toBe(500);

    const overlay = await client.next("error");
    expect(overlay.err?.message).toBe(
      `Config "${CONFIG}": "build.head" reads a setting this site does not declare, so en /broken-head has no head to emit — declare the setting, or remove the head callback: Site settings: no "brand" is declared`,
    );
    expect(overlay.err?.stack).toContain("ConfigError");
    expect(overlay.err?.stack).toContain('Site settings: no "brand" is declared');
  } finally {
    client.close();
  }
}, 60_000);

test("a page links the site's declared global stylesheet, and it serves", async () => {
  const page = await get("/hot");
  expect(styleUrls(page.body)).toEqual(["/styles/global.css"]);

  const sheet = await fetch(`${origin}/styles/global.css`, {
    headers: { accept: "text/css,*/*;q=0.1" },
  });
  expect(sheet.status).toBe(200);
  expect(sheet.headers.get("content-type")).toContain("text/css");
  expect(await sheet.text()).toContain(".fw-global-3b91");
}, 60_000);

test("a page carries the third-party script layer the site declared", async () => {
  const page = await get("/hot");
  expect(page.status).toBe(200);
  expect(page.body).toContain("https://example.com/metrics-dev-7e21.js");
  expect(page.body).toContain("requestIdleCallback");
  expect(page.body.indexOf("metrics-dev-7e21")).toBeGreaterThan(
    page.body.indexOf("</head>"),
  );

  expect(page.body).toContain("marker-worker-boot-2f5a");
  expect(page.body).toContain(
    '<script type="text/worker" src="https://example.com/widget-dev-4c88.js"></script>',
  );
  expect(page.body.indexOf("marker-worker-boot-2f5a")).toBeLessThan(
    page.body.indexOf('type="text/worker"'),
  );
  expect(page.body).not.toContain('load(["https://example.com/widget-dev-4c88.js"');
}, 60_000);

test("a 404 quotes the path it was asked for, cut at the query", async () => {
  const missing = await get("/nope?token=secret-b41d");
  expect(missing.status).toBe(404);
  expect(missing.body).toContain('"/nope?…"');
  expect(missing.body).not.toContain("secret-b41d");
}, 60_000);

/** One client per edit: `next` answers the first message of a type it holds. */
async function editAndReload(file: string, source: string): Promise<void> {
  const client = await HotClient.connect();
  try {
    writeFileSync(file, source);
    await client.next("full-reload");
  } finally {
    client.close();
  }
}

test("a .tsx component edit is rendered after the reload, three edits in a row", async () => {
  expect((await get("/noted")).body).toContain(
    '<p data-text="noted">note-before-4e1a</p>',
  );

  for (const marker of ["note-after-0c3d", "note-again-71b2", "note-third-e83f"]) {
    await editAndReload(NOTE, noteSource(marker));
    expect((await get("/noted")).body).toContain(
      `<p data-text="noted">${marker}</p>`,
    );
  }
}, 90_000);

test("an edit to a module a component imports from the site is rendered after the reload, three edits in a row", async () => {
  expect((await get("/quoted")).body).toContain("<q>quote-before-5c62</q>");

  for (const marker of ["quote-after-9d14", "quote-again-3a7e", "quote-third-b590"]) {
    await editAndReload(QUOTE_TEXT, quoteTextSource(marker));
    expect((await get("/quoted")).body).toContain(`<q>${marker}</q>`);
  }
}, 90_000);

test("a component declared by path is islanded, and its page's entry imports it", async () => {
  const page = await get("/pathed");
  expect(page.status).toBe(200);
  expect(page.body).toContain('data-pagedeck-component="pathed"');
  expect(page.body).toContain("pathed-6d2b");

  const entries = scriptUrls(page.body).filter((url) => url.startsWith("/@id/"));
  expect(entries).toHaveLength(1);
  const entry = await get(entries[0] as string);
  expect(entry.status).toBe(200);
  expect(importSpecifier(entry.body, "Pathed.js")).toBeDefined();
  expect((await get("/src/Pathed.js")).status).toBe(200);
}, 60_000);

test("a component behind a site plugin's alias is islanded, and its module serves", async () => {
  const page = await get("/aliased");
  expect(page.status).toBe(200);
  expect(page.body).toContain('data-fw-component="aliased"');
  expect(page.body).toContain("aliased-9b14");

  const entries = scriptUrls(page.body).filter((url) => url.startsWith("/@id/"));
  expect(entries).toHaveLength(1);
  const entry = await get(entries[0] as string);
  expect(entry.status).toBe(200);
  expect((await get(importSpecifier(entry.body, "Aliased.js"))).status).toBe(200);
}, 60_000);

test("a component declared by path renders, and an edit to it is rendered after the reload", async () => {
  expect((await get("/path-noted")).body).toContain(
    '<p data-text="path-noted">path-note-before-8a40</p>',
  );

  await editAndReload(PATH_NOTE, noteSource("path-note-after-2b17"));
  expect((await get("/path-noted")).body).toContain(
    '<p data-text="path-noted">path-note-after-2b17</p>',
  );
}, 60_000);

test("a config edit is re-read, and the browser is told to reload", async () => {
  expect((await get("/hot")).body).toContain(`<title>${CONFIG_MARKER}</title>`);

  const client = await HotClient.connect();
  try {
    writeConfig("config-after-6b52");
    await client.next("full-reload");
    expect((await get("/hot")).body).toContain(
      "<title>config-after-6b52</title>",
    );
  } finally {
    client.close();
  }
}, 60_000);

test("a config that will not load leaves the last good one serving", async () => {
  const client = await HotClient.connect();
  try {
    writeFileSync(CONFIG, `export default {\n`);
    const overlay = await client.next("error");
    expect(overlay.err?.message).toContain(`Config "${CONFIG}": failed to load`);
    expect(diagnostics.some((line) => line.includes("failed to load"))).toBe(
      true,
    );
    expect((await get("/hot")).body).toContain(
      "<title>config-after-6b52</title>",
    );
  } finally {
    client.close();
  }

  const restored = await HotClient.connect();
  try {
    writeConfig(CONFIG_MARKER);
    await restored.next("full-reload");
  } finally {
    restored.close();
  }
}, 60_000);

test("a client module another client module imports islands where the server renders it, and renders inside the other's island, as the build does", async () => {
  const { status, body } = await get("/nested");
  expect(status).toBe(200);

  expect(body.match(/<fw-island\b/g)).toHaveLength(2);
  const tags = [
    ...body.matchAll(/<fw-island\b[^>]*data-fw-component="([^"]+)"[^>]*>/g),
  ].map((match) => ({ component: match[1], at: match.index }));
  expect(tags.map((tag) => tag.component)).toEqual(["nest_panel", "nest_badge"]);
  const [panel, badge] = tags as [(typeof tags)[0], (typeof tags)[0]];
  const panelMarkup = body.slice(panel.at, body.indexOf("</fw-island>", panel.at));
  expect(panelMarkup).toContain("nest-panel-6b0d");
  expect(panelMarkup).toContain(">nest-inside-2e85</output>");
  expect(body.slice(badge.at)).toContain(">nest-direct-c39a</output>");
}, 30_000);

test("a dev run wrote no site tree", () => {
  expect(existsSync(join(SITE, "dist"))).toBe(false);
});

test("a dev run with build.adapter configured ran no adapter and wrote no edge tree", () => {
  expect(existsSync(join(SITE, "edge"))).toBe(false);
});

function writeUnsyncedSite(): void {
  rmSync(UNSYNCED, { recursive: true, force: true });
  mkdirSync(join(UNSYNCED, "src"), { recursive: true });
  mkdirSync(join(UNSYNCED, "content", "en"), { recursive: true });
  writeFileSync(
    join(UNSYNCED, "src", "Prose.js"),
    `export default function Prose() { return "prose-4e17"; }\n`,
  );
  writeFileSync(
    join(UNSYNCED, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(UNSYNCED, "content"))}),
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
      sources: [fromCollection(pages, { route: (entry) => "/" + entry.path })],
    }),
    components: { prose: "./src/Prose.js" },
    content: () => ({ tree: [{ component: "prose" }] }),
  },
});
`,
  );
}

// Written out rather than built from `dev.ts`'s constant, so a reword fails here.
const NO_STORE = `Config "${join(UNSYNCED, "pagedeck.config.ts")}": no store to read at "${join(UNSYNCED, "content.db")}", so pagedeck dev has no pages to serve — run pagedeck sync if it has not been created yet`;

function writeUnreadableStore(): void {
  writeFileSync(join(UNSYNCED, "content.db"), "not a database\n");
}

function writeFallbackSite(script: string, root: string = FALLBACK): void {
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "content", "en"), { recursive: true });
  writeFileSync(
    join(root, "src", "Prose.js"),
    `export default function Prose() { return "prose-9a52"; }\n`,
  );
  writeFileSync(
    join(root, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 1, data: { title: "home" } })}\n`,
  );
  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, defineScripts, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

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
    scripts: defineScripts({
      scripts: [{ name: ${JSON.stringify(script)}, src: "https://example.com/worker-dev-5e13.js" }],
    }),
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: (entry) => "/" + entry.path })],
    }),
    components: { prose: "./src/Prose.js" },
    content: () => ({ tree: [{ component: "prose" }] }),
  },
});
`,
  );
}

test("a worker script with no runtime is reported once per config, not per page", async () => {
  rmSync(FALLBACK, { recursive: true, force: true });
  writeFallbackSite("telemetry");
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: FALLBACK });

  const { loadConfig } = await import("./config.js");
  const { startDevServer } = await import("./dev.js");
  const lines: string[] = [];
  const fallbacks = (): string[] =>
    lines.filter((line) => line.startsWith("Script runtime:"));
  const server = await startDevServer({
    config: await loadConfig(FALLBACK),
    port: 0,
    err: (line) => lines.push(line),
  });

  try {
    expect(fallbacks()).toHaveLength(1);
    expect(fallbacks()[0]).toContain('"telemetry"');
    expect(fallbacks()[0]).toContain("loads on idle instead");

    expect((await fetch(`${server.url}/home`)).status).toBe(200);
    expect((await fetch(`${server.url}/home`)).status).toBe(200);
    expect(fallbacks()).toHaveLength(1);

    writeFallbackSite("beacon");
    const deadline = Date.now() + MESSAGE_TIMEOUT;
    while (fallbacks().length < 2 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(fallbacks()).toHaveLength(2);
    expect(fallbacks()[1]).toContain('"beacon"');
  } finally {
    await server.close();
  }
  rmSync(FALLBACK, { recursive: true, force: true });
}, 120_000);

async function announcementOf(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  const child = spawn(process.execPath, [BIN, "dev", ...args], { cwd });
  try {
    return await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        reject(
          new Error(
            `pagedeck dev ${args.join(" ")} printed no URL within ${String(STARTUP_TIMEOUT)}ms — it wrote:\n${out}`,
          ),
        );
      }, STARTUP_TIMEOUT);
      child.on("error", reject);
      child.on("exit", (code) => {
        reject(
          new Error(
            `pagedeck dev ${args.join(" ")} exited with ${String(code)} before it announced itself — it wrote:\n${out}`,
          ),
        );
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
        if (!out.includes("authenticates nothing")) return;
        clearTimeout(timer);
        resolve(out);
      });
    });
  } finally {
    await stop(child);
  }
}

// `pgrep` exits 1 for no match. Polled: a killed child is listed until reaped.
async function compilerChildren(parent: number): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    execFile(
      "pgrep",
      ["-P", String(parent), "-f", "react-compiler-worker"],
      (_error, stdout) => {
        resolve(stdout.split("\n").filter((line) => line !== ""));
      },
    );
  });
}

// In process, so the close is `DevServer.close()` and not the loss of a parent.
// Its own site: this file's `SITE` holds islands Vitest has already loaded.
test("no compiler process outlives a closed dev server", async () => {
  rmSync(COMPILED, { recursive: true, force: true });
  writeFallbackSite("telemetry", COMPILED);
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: COMPILED });

  const { loadConfig } = await import("./config.js");
  const { startDevServer } = await import("./dev.js");
  const dev = await startDevServer({
    config: await loadConfig(COMPILED),
    port: 0,
    err: () => {},
  });
  try {
    expect((await fetch(`${dev.url}/src/Prose.js`)).status).toBe(200);
    expect(await compilerChildren(process.pid)).toHaveLength(1);
  } finally {
    await dev.close();
    rmSync(COMPILED, { recursive: true, force: true });
  }

  const left = await until(
    () => compilerChildren(process.pid),
    (children) => children.length === 0,
  );
  expect(left).toEqual([]);
}, 60_000);

test("a bind beyond loopback names a reachable address and the exposure", async () => {
  writeUnsyncedSite();
  writeUnreadableStore();

  const out = await announcementOf(UNSYNCED, ["--port", "0", "--host", "0.0.0.0"]);

  const lines = out.trimEnd().split("\n");
  expect(lines[0]).toMatch(/^serving .*pagedeck\.config\.ts at http:\/\/0\.0\.0\.0:\d+$/);
  expect(lines.at(-1)).toBe(
    "  this server authenticates nothing and serves from the project root",
  );
  const port = /:(\d+)$/.exec(lines[0] as string)?.[1] as string;
  const reachable = lanAddresses()[0];
  expect(lines.slice(1, -1)).toEqual(
    reachable === undefined
      ? []
      : [`  reachable on this network at http://${reachable}:${port}`],
  );

  rmSync(UNSYNCED, { recursive: true, force: true });
}, 120_000);

async function bindsIpv6(): Promise<boolean> {
  const { createServer } = await import("node:http");
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "::", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

test("an IPv6 wildcard binds and is announced as a URL, both spellings", async () => {
  if (!(await bindsIpv6())) return;
  writeUnsyncedSite();
  writeUnreadableStore();

  const announced: string[][] = [];
  for (const host of ["::", "[::]"]) {
    const out = await announcementOf(UNSYNCED, ["--port", "0", "--host", host]);
    const lines = out.trimEnd().split("\n");
    const origin = lines[0]?.split(" at ")[1] as string;
    expect(origin).toMatch(/^http:\/\/\[::\]:\d+$/);
    expect(new URL(origin).port).toMatch(/^\d+$/);
    expect(lines.at(-1)).toBe(
      "  this server authenticates nothing and serves from the project root",
    );
    announced.push(lines.map((line) => line.replace(/:\d+$/, ":<port>")));
  }
  expect(announced[0]).toEqual(announced[1]);

  rmSync(UNSYNCED, { recursive: true, force: true });
}, 120_000);

test("a bare pagedeck dev says nothing about interfaces or exposure", async () => {
  expect(announced).toContain("serving ");
  expect(announced).not.toContain("reachable on this network");
  expect(announced).not.toContain("authenticates nothing");
});

test("pagedeck dev on a site nobody has synced exits configError, names the store and the fix, and serves nothing", async () => {
  writeUnsyncedSite();

  const failed = (await execFileAsync(
    process.execPath,
    [BIN, "dev", "--port", "0"],
    { cwd: UNSYNCED, timeout: STARTUP_TIMEOUT },
  ).then(
    () => undefined,
    (error: unknown) => error,
  )) as { code?: number; stdout?: string; stderr?: string } | undefined;

  expect(failed?.code).toBe(EXIT_CODES.configError);
  expect(failed?.stderr).toContain(NO_STORE);
  expect(failed?.stdout).not.toContain("serving ");
  rmSync(UNSYNCED, { recursive: true, force: true });
}, 120_000);

test("startDevServer refuses a site with no store file before any server exists", async () => {
  writeUnsyncedSite();
  const { loadConfig } = await import("./config.js");
  const { startDevServer } = await import("./dev.js");
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const lines: string[] = [];

  const outcome = await startDevServer({
    config: await loadConfig(UNSYNCED),
    port,
    err: (line) => lines.push(line),
  }).then(
    async (server) => {
      await server.close();
      return "started";
    },
    (error: unknown) => error,
  );

  expect(outcome).toBeInstanceOf(ConfigError);
  expect((outcome as ConfigError).message).toBe(NO_STORE);
  expect(lines).toEqual([]);
  await expect(fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow();
  rmSync(UNSYNCED, { recursive: true, force: true });
}, 120_000);

test("a store that is not a database still starts, and a request names the store and the fix, and stops twice", async () => {
  writeUnsyncedSite();
  writeUnreadableStore();
  const { loadConfig } = await import("./config.js");
  const { startDevServer } = await import("./dev.js");
  const lines: string[] = [];
  const server = await startDevServer({
    config: await loadConfig(UNSYNCED),
    port: 0,
    err: (line) => lines.push(line),
  });

  try {
    const response = await fetch(`${server.url}/en/home`);
    expect(response.status).toBe(500);
    const message = `Dev server: no store to read at "${join(UNSYNCED, "content.db")}" — run pagedeck sync if it has not been created yet`;
    expect(await response.text()).toContain(message);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(message);
    expect(lines[0]).toContain("file is not a database");
  } finally {
    await server.close();
  }

  await expect(server.close()).resolves.toBeUndefined();
  await expect(server.closed).resolves.toBeUndefined();
  rmSync(UNSYNCED, { recursive: true, force: true });
}, 120_000);

const LAYOUT_SITE = join(import.meta.dirname, "..", ".pagedeck-dev-layout");

function writeLayoutSite(): void {
  rmSync(LAYOUT_SITE, { recursive: true, force: true });
  mkdirSync(join(LAYOUT_SITE, "src"), { recursive: true });
  mkdirSync(join(LAYOUT_SITE, "content", "en"), { recursive: true });
  writeFileSync(
    join(LAYOUT_SITE, "src", "Layout.js"),
    `import { createElement } from "react";
export default function Layout({ title, html, children }) {
  return createElement("article", null, createElement("h1", null, title), createElement("div", { dangerouslySetInnerHTML: { __html: html } }), children);
}
`,
  );
  writeFileSync(join(LAYOUT_SITE, "src", "Counter.js"), counterSource("layout-counter-0b7d"));
  const entries = {
    about: { title: "About layout-about-91c4", html: "<p>about</p>", frontmatter: {} },
    counter: { title: "Counter", html: "<p>counter</p>", frontmatter: { components: ["counter"] } },
  };
  for (const [path, data] of Object.entries(entries)) {
    writeFileSync(
      join(LAYOUT_SITE, "content", "en", `${path}.json`),
      `${JSON.stringify({ rev: 1, data })}\n`,
    );
  }
  writeFileSync(
    join(LAYOUT_SITE, "pagedeck.config.ts"),
    `
import { defineConfig, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(LAYOUT_SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: {
    pages: [fromCollection(pages, { layout: "layout" })],
    components: { layout: "./src/Layout.js", counter: "./src/Counter.js" },
  },
});
`,
  );
}

async function servedFrom(
  cwd: string,
  visit: (origin: string) => Promise<void>,
): Promise<void> {
  const child = spawn(process.execPath, [BIN, "dev", "--port", "0"], { cwd });
  try {
    const at = await new Promise<string>((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        reject(new Error(`pagedeck dev printed no URL within ${String(STARTUP_TIMEOUT)}ms — it wrote:\n${out}\n${err}`));
      }, STARTUP_TIMEOUT);
      child.on("error", reject);
      child.on("exit", (code) => {
        reject(new Error(`pagedeck dev exited with ${String(code)} before it was listening:\n${out}\n${err}`));
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        err += chunk;
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        out += chunk;
        const found = /at (http:\/\/[^\s]+)/.exec(out);
        if (found === null) return;
        clearTimeout(timer);
        resolve(found[1] as string);
      });
    });
    await visit(at);
  } finally {
    await stop(child);
  }
}

test("a page rendered into a layout is served, with a frontmatter island in its entry and none on its neighbour", async () => {
  writeLayoutSite();
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: LAYOUT_SITE });

  await servedFrom(LAYOUT_SITE, async (at) => {
    const about = await fetch(`${at}/about`);
    const aboutBody = await about.text();
    expect(about.status).toBe(200);
    expect(aboutBody).toContain("layout-about-91c4");
    expect(scriptUrls(aboutBody).filter((url) => url.startsWith("/@id/"))).toEqual([]);

    const counter = await fetch(`${at}/counter`);
    const counterBody = await counter.text();
    expect(counter.status).toBe(200);
    expect(counterBody).toContain('data-pagedeck-component="counter"');
    expect(counterBody).toContain("layout-counter-0b7d");
    const entries = scriptUrls(counterBody).filter((url) => url.startsWith("/@id/"));
    expect(entries).toHaveLength(1);
    const entry = await fetch(`${at}${entries[0] as string}`);
    expect(importSpecifier(await entry.text(), "Counter.js")).toBeDefined();
  });
  rmSync(LAYOUT_SITE, { recursive: true, force: true });
}, 120_000);

const FRAMED_SITE = join(import.meta.dirname, "..", ".pagedeck-dev-framed");
const FRAME = join(FRAMED_SITE, "src", "Frame.tsx");

function frameSource(marker: string): string {
  return [
    `import type { ReactNode } from "react";`,
    `export default function Frame({ children }: { children?: ReactNode }) {`,
    `  return <div data-frame="${marker}">{children}</div>;`,
    `}`,
    "",
  ].join("\n");
}

function writeFramedSite(): void {
  rmSync(FRAMED_SITE, { recursive: true, force: true });
  mkdirSync(join(FRAMED_SITE, "src"), { recursive: true });
  mkdirSync(join(FRAMED_SITE, "content", "en"), { recursive: true });
  writeFileSync(FRAME, frameSource("frame-before-6e0a"));
  writeFileSync(
    join(FRAMED_SITE, "src", "providers.ts"),
    `import Frame from "./Frame.tsx";\nexport default [{ component: Frame }];\n`,
  );
  writeFileSync(
    join(FRAMED_SITE, "src", "Prose.js"),
    `export default function Prose() { return "framed-prose-27c9"; }\n`,
  );
  writeFileSync(
    join(FRAMED_SITE, "content", "en", "home.json"),
    `${JSON.stringify({ rev: 1, data: {} })}\n`,
  );
  writeFileSync(
    join(FRAMED_SITE, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";
import providers from "./src/providers.ts";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(FRAMED_SITE, "content"))}),
  schema: false,
};

export default defineConfig({
  collections: [pages],
  build: {
    rootProviders: { stack: providers, module: "./src/providers.ts" },
    pages: definePages({
      trailingSlash: "never",
      locales: defineLocales({ en: { label: "en", direction: "ltr" } }),
      sources: [fromCollection(pages, { route: (entry) => "/" + entry.path })],
    }),
    components: { prose: "./src/Prose.js" },
    content: () => ({ tree: [{ component: "prose" }] }),
  },
});
`,
  );
}

test("a component the config imports by value is rendered edited after the first reload", async () => {
  writeFramedSite();
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: FRAMED_SITE });

  try {
    await servedFrom(FRAMED_SITE, async (at) => {
      expect(await (await fetch(`${at}/home`)).text()).toContain(
        'data-frame="frame-before-6e0a"',
      );

      const client = await HotClient.connect(at);
      try {
        writeFileSync(FRAME, frameSource("frame-after-d41b"));
        await client.next("full-reload");
      } finally {
        client.close();
      }
      expect(await (await fetch(`${at}/home`)).text()).toContain(
        'data-frame="frame-after-d41b"',
      );
    });
  } finally {
    rmSync(FRAMED_SITE, { recursive: true, force: true });
  }
}, 120_000);
