import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { openStoreReadOnly } from "@pagedeck/content";
import { RegistryError } from "@pagedeck/islands";
import type { ComponentRegistry } from "@pagedeck/islands";
import {
  devServingLines,
  lanAddresses,
  parseDevArgs,
  parseSyncArgs,
  runCli,
} from "./cli.js";
import { markDiagnostic } from "./diagnostic-marker.js";
import { EXIT_CODES } from "./exit.js";
import { MANIFEST_VERSION } from "./manifest.js";
import { RenderError, renderPage } from "./render.js";
import { RETENTION_DIR } from "./retention.js";
import { DEFAULT_TIER_POLICY } from "./tiers.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-core-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Run {
  code: number;
  out: string;
  err: string;
}

async function runIn(
  cwd: string,
  env: Readonly<Record<string, string>>,
  argv: readonly string[],
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function run(cwd: string, ...argv: string[]): Promise<Run> {
  return runIn(cwd, {}, argv);
}

const CORE_CONFIG = join(import.meta.dirname, "config.ts");
const CORE_PAGES = join(import.meta.dirname, "pages.ts");
const CORE_LOCALES = join(import.meta.dirname, "locales.ts");
const ISLANDS = join(
  import.meta.dirname,
  "..",
  "..",
  "islands",
  "src",
  "index.ts",
);
const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "src",
  "index.ts",
);

function writeFixture(dir: string, relative: string, body: unknown): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function siteDir(): string {
  const dir = tempDir();
  const fixtures = join(dir, "content");
  writeFixture(fixtures, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(fixtures, "en/about.json", { rev: 2, data: { title: "About" } });
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: createFixtureLoader(${JSON.stringify(fixtures)}),
      schema: false,
    },
  ],
});
`,
  );
  return dir;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("a registry collision in the site's config is written to the run's error channel", async () => {
  const dir = siteDir();
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};
import { defineComponents, mergeComponents } from ${JSON.stringify(ISLANDS)};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

mergeComponents(
  defineComponents({ hero: "@acme/design-system/components/hero" }),
  defineComponents({ hero: "./components/hero.tsx" }),
);

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
      schema: false,
    },
  ],
});
`,
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const result = await run(dir, "sync");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe(
    'Component "hero": registered by two merged registries — the later one wins and the earlier one is unreachable; rename one of them, or drop the merge',
  );
  expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});

test("sync loads pagedeck.config.ts and reports per-collection counts and the new cursor", async () => {
  const dir = siteDir();

  const result = await run(dir, "sync");

  expect(result.err).toBe("");
  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.out).toContain("pages: 2 changed, 0 deleted, cursor 2");
  expect(existsSync(join(dir, "content.db"))).toBe(true);
});

test("sync --incremental syncs from the stored cursor after a fixture edit", async () => {
  const dir = siteDir();
  await run(dir, "sync");

  writeFixture(join(dir, "content"), "en/about.json", {
    rev: 3,
    data: { title: "About v2" },
  });
  const result = await run(dir, "sync", "--incremental");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.out).toContain("pages: 1 changed, 0 deleted, cursor 3");
});

test("a missing config exits with the config-error code and names what to add", async () => {
  const dir = tempDir();

  const result = await run(dir, "sync");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("pagedeck.config.ts");
  expect(result.out).toBe("");
});

test("a failing collection exits with the sync-failure code, naming the collection and the reason", async () => {
  const dir = tempDir();
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: {
        syncAll() { throw new Error("the CMS is down"); },
        syncSince() { throw new Error("the CMS is down"); },
      },
      schema: false,
    },
  ],
});
`,
  );

  const result = await run(dir, "sync");

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).toContain("pages");
  expect(result.err).toContain("the CMS is down");
});

test("a collection declaring no usage for a template it names exits with the config-error code", async () => {
  const dir = tempDir();
  const fixtures = join(dir, "content");
  writeFixture(fixtures, "en/pricing.json", {
    rev: 1,
    data: { template: "PricingPage" },
  });
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: createFixtureLoader(${JSON.stringify(fixtures)}),
      templates: {
        templateOf: (entry) => entry.data.template,
        byTemplate: {},
      },
      schema: false,
    },
  ],
});
`,
  );

  const result = await run(dir, "sync");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    'template "PricingPage" declares no component usage',
  );
});

test("a registry error exits with the config-error code, like a config error", async () => {
  const err: string[] = [];
  const code = await runCli(["sync"], {
    env: {},
    get cwd(): string {
      throw new RegistryError(
        'Component "hero": not registered, and entry /en/home references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry',
      );
    },
    out: () => {},
    err: (line) => err.push(line),
  });

  expect(code).toBe(EXIT_CODES.configError);
  expect(err.join("\n")).toContain('Component "hero": not registered');
});

test("a component that throws a wiring-fault class still exits with the sync-failure code", async () => {
  const registry: ComponentRegistry = {
    Boom: {
      import: async () => ({
        default: () => {
          throw new RegistryError(
            'Component "hero": not registered, and entry /en/home references it — declare it under build.components, or add it to the registry passed to renderPage, or remove the reference from the entry',
          );
        },
      }),
    },
  };

  let rendered: unknown;
  try {
    await renderPage({
      page: { locale: "en", path: "/home" },
      registry,
      tree: [{ component: "Boom" }],
    });
  } catch (error) {
    rendered = error;
  }
  expect(rendered).toBeInstanceOf(RenderError);
  expect((rendered as Error).cause).toBeInstanceOf(RegistryError);

  const err: string[] = [];
  const code = await runCli(["sync"], {
    env: {},
    get cwd(): string {
      throw rendered;
    },
    out: () => {},
    err: (line) => err.push(line),
  });

  expect(code).toBe(EXIT_CODES.syncFailed);
});

test("an unknown verb exits with the config-error code and prints the usage", async () => {
  const dir = siteDir();

  const result = await run(dir, "deploy");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("deploy");
  expect(result.err).toContain("pagedeck sync");
});

test("pagedeck build on a site with no build section says what to declare", async () => {
  const dir = siteDir();

  const result = await run(dir, "build");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("declares no build section");
  expect(result.err).toContain(
    "add a build section to pagedeck.config.ts — build: { pages, components, content }",
  );
});

test("an unknown flag on build is refused rather than ignored", async () => {
  const dir = siteDir();

  const result = await run(dir, "build", "--watch");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("--watch");
});

test("pagedeck dev on a site with no build section says what to declare", async () => {
  const dir = siteDir();

  const result = await run(dir, "dev");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("declares no build section");
  expect(result.err).toContain("pagedeck dev has no pages to serve");
  expect(result.err).toContain(
    "add a build section to pagedeck.config.ts — build: { pages, components, content }",
  );
});

test("pagedeck dev refuses a port that is not one", async () => {
  const dir = siteDir();

  const result = await run(dir, "dev", "--port", "70000");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("--port");
  expect(result.err).toContain("70000");
  expect(result.err).toContain("between 0 and 65535");
});

test("--host names the interface the dev server binds", () => {
  expect(parseDevArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
});

test("--host composes with --port rather than replacing it", () => {
  expect(parseDevArgs(["--port", "4000", "--host", "0.0.0.0"])).toEqual({
    port: 4000,
    host: "0.0.0.0",
  });
  expect(parseDevArgs(["--host", "0.0.0.0", "--port", "4000"])).toEqual({
    port: 4000,
    host: "0.0.0.0",
  });
});

test("a bare pagedeck dev names no host, so the loopback default stands", () => {
  expect(parseDevArgs([])).toEqual({ port: 5173, host: undefined });
});

test("pagedeck dev refuses a --host with no address after it", async () => {
  const dir = siteDir();

  const result = await run(dir, "dev", "--host");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("pagedeck dev --host");
  expect(result.err).toContain("nothing");
});

test("pagedeck dev refuses an empty --host", async () => {
  const dir = siteDir();

  const result = await run(dir, "dev", "--host", "");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("pagedeck dev --host");
});

test("pagedeck dev refuses a --host that swallowed the next flag", async () => {
  const dir = siteDir();

  const result = await run(dir, "dev", "--host", "--port", "4000");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("pagedeck dev --host");
  expect(result.err).toContain("--port");
});

// Composed by `devOrigin`, never written by hand (#268). Imported here because
// `./dev.js` statically imports the bundler.
async function served(
  host: string,
  port: number,
): Promise<{ url: string; port: number }> {
  const { devOrigin } = await import("./dev.js");
  return { url: devOrigin(host, port), port };
}

test("a bare pagedeck dev announces exactly the line it announced before", async () => {
  expect(
    devServingLines(
      "/site/pagedeck.config.ts",
      await served("127.0.0.1", 5173),
      undefined,
      ["192.168.1.24"],
    ),
  ).toEqual(["serving /site/pagedeck.config.ts at http://127.0.0.1:5173"]);
});

test("loopback asked for by name announces the same single line", async () => {
  for (const host of ["127.0.0.1", "127.0.0.53", "localhost", "::1"])
    expect(
      devServingLines(
        "/site/pagedeck.config.ts",
        await served(host, 5173),
        host,
        ["192.168.1.24"],
      ),
    ).toHaveLength(1);
  expect((await served("::1", 5173)).url).toBe("http://[::1]:5173");
});

test("a wildcard bind names a reachable address and the exposure", async () => {
  expect(
    devServingLines(
      "/site/pagedeck.config.ts",
      await served("0.0.0.0", 5173),
      "0.0.0.0",
      ["192.168.1.24", "10.1.2.3"],
    ),
  ).toEqual([
    "serving /site/pagedeck.config.ts at http://0.0.0.0:5173",
    "  reachable on this network at http://192.168.1.24:5173",
    "  this server authenticates nothing and serves from the project root",
  ]);
});

test("an IPv6 wildcard bind is announced bracketed, and still gets a hint", async () => {
  expect(
    devServingLines("/site/pagedeck.config.ts", await served("::", 5173), "::", [
      "192.168.1.24",
    ]),
  ).toEqual([
    "serving /site/pagedeck.config.ts at http://[::]:5173",
    "  reachable on this network at http://192.168.1.24:5173",
    "  this server authenticates nothing and serves from the project root",
  ]);
});

test("a bracketed IPv6 host binds what the bare one binds", () => {
  expect(parseDevArgs(["--host", "[::]"]).host).toBe("::");
  expect(parseDevArgs(["--host", "[::1]"]).host).toBe("::1");
  expect(parseDevArgs(["--host", "[::"]).host).toBe("[::");
  expect(parseDevArgs(["--host", "0.0.0.0"]).host).toBe("0.0.0.0");
});

test("a bracketed IPv6 host is announced the way the bare one is", async () => {
  const wildcard = parseDevArgs(["--host", "[::]"]).host;
  expect(
    devServingLines("/site/pagedeck.config.ts", await served("::", 5173), wildcard, [
      "192.168.1.24",
    ]),
  ).toHaveLength(3);
  const loopback = parseDevArgs(["--host", "[::1]"]).host;
  expect(
    devServingLines("/site/pagedeck.config.ts", await served("::1", 5173), loopback, [
      "192.168.1.24",
    ]),
  ).toEqual(["serving /site/pagedeck.config.ts at http://[::1]:5173"]);
});

test("a wildcard bind with no address found still says what is exposed", async () => {
  for (const host of ["0.0.0.0", "::"])
    expect(
      devServingLines(
        "/site/pagedeck.config.ts",
        await served(host, 5173),
        host,
        [],
      ),
    ).toEqual([
      `serving /site/pagedeck.config.ts at ${(await served(host, 5173)).url}`,
      "  this server authenticates nothing and serves from the project root",
    ]);
});

test("a specific non-loopback bind states the exposure and nothing more", async () => {
  expect(
    devServingLines(
      "/site/pagedeck.config.ts",
      await served("192.168.1.24", 5173),
      "192.168.1.24",
      ["192.168.1.24"],
    ),
  ).toEqual([
    "serving /site/pagedeck.config.ts at http://192.168.1.24:5173",
    "  this server authenticates nothing and serves from the project root",
  ]);
});

test("the reachable line is composed from the port, not from the origin", () => {
  expect(
    devServingLines(
      "/site/pagedeck.config.ts",
      { url: "http://:::5173", port: 5173 },
      "0.0.0.0",
      ["192.168.1.24"],
    )[1],
  ).toBe("  reachable on this network at http://192.168.1.24:5173");
});

test("every address lanAddresses reports is one another device could reach", () => {
  for (const address of lanAddresses())
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
});

test("an unknown flag on dev is refused rather than ignored", async () => {
  const dir = siteDir();

  const result = await run(dir, "dev", "--open");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("--open");
});

test("an unknown flag on sync is refused rather than ignored", async () => {
  const dir = siteDir();

  const result = await run(dir, "sync", "--all");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("--all");
});

test("pagedeck sync refuses an interval that is not one", async () => {
  const dir = siteDir();

  for (const value of ["abc", "0", "-1", "2.5"]) {
    const result = await run(dir, "sync", "--watch", "--interval", value);

    expect(result.code).toBe(EXIT_CODES.configError);
    expect(result.err).toContain(
      `pagedeck sync --interval takes a whole number of seconds above zero, and got "${value}".`,
    );
  }
});

test("pagedeck sync refuses an interval with no value after it", async () => {
  const dir = siteDir();

  const result = await run(dir, "sync", "--watch", "--interval");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "pagedeck sync --interval takes a whole number of seconds above zero, and got nothing.",
  );
});

test("pagedeck sync refuses an interval with no watch to time", async () => {
  const dir = siteDir();

  const result = await run(dir, "sync", "--interval", "10");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "pagedeck sync --interval sets how long a watch rests between syncs, and this run has no watch — add --watch, or drop --interval.",
  );
});

test("--interval N is N seconds of rest, in milliseconds", () => {
  expect(parseSyncArgs(["--watch", "--interval", "12"]).intervalMs).toBe(
    12_000,
  );
});

test("a watch with no --interval rests for the default five seconds", () => {
  expect(parseSyncArgs(["--watch"]).intervalMs).toBe(5_000);
});

test("pagedeck sync accepts the longest rest a timer can hold", () => {
  expect(parseSyncArgs(["--watch", "--interval", "2147483"]).intervalMs).toBe(
    2_147_483_000,
  );
});

test("pagedeck sync refuses a rest one second longer than a timer holds", async () => {
  const dir = siteDir();

  const result = await run(dir, "sync", "--watch", "--interval", "2147484");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    'pagedeck sync --interval takes at most 2147483 seconds, the longest rest a JavaScript timer holds, and got "2147484" — Node clamps a longer delay to 1ms, which is the sync loop with no rest in it that this flag refuses zero to prevent.',
  );
});

test("no verb at all prints the usage", async () => {
  const dir = siteDir();

  const result = await run(dir);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("pagedeck store pull");
});

test("store push then store pull round-trip the synced store byte for byte", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const storePath = join(dir, "content.db");
  const before = sha256(storePath);
  const remote = pathToFileURL(join(dir, "remote", "snapshot.db")).href;

  const pushed = await run(dir, "store", "push", remote);
  rmSync(storePath);
  const pulled = await run(dir, "store", "pull", remote);

  expect(pushed.code).toBe(EXIT_CODES.success);
  expect(pulled.code).toBe(EXIT_CODES.success);
  expect(sha256(storePath)).toBe(before);
  const store = openStoreReadOnly(storePath);
  try {
    expect(store.listEntries("pages")).toHaveLength(2);
  } finally {
    store.close();
  }
});

test("a snapshot url the CLI cannot use is a config error naming the scheme", async () => {
  const dir = siteDir();
  await run(dir, "sync");

  const result = await run(dir, "store", "pull", "s3://bucket/site.db");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain('"s3:"');
});

test("a snapshot url that cannot be reached is a sync failure, not a config error", async () => {
  const dir = siteDir();
  await run(dir, "sync");

  const result = await run(
    dir,
    "store",
    "pull",
    pathToFileURL(join(dir, "absent.db")).href,
  );

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).toContain("absent.db");
});

test("store push with no url is refused before anything is copied", async () => {
  const dir = siteDir();
  await run(dir, "sync");

  const result = await run(dir, "store", "push");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "needs a <url> to push, or PAGEDECK_SNAPSHOT_PUSH_URL set to one",
  );
});

test("store pull reads PAGEDECK_SNAPSHOT_PULL_URL and store push reads PAGEDECK_SNAPSHOT_PUSH_URL", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const storePath = join(dir, "content.db");
  const before = sha256(storePath);
  const remote = pathToFileURL(join(dir, "remote", "snapshot.db")).href;
  const unused = pathToFileURL(join(dir, "unused.db")).href;

  const pushed = await runIn(
    dir,
    { PAGEDECK_SNAPSHOT_PUSH_URL: remote, PAGEDECK_SNAPSHOT_PULL_URL: unused },
    ["store", "push"],
  );
  rmSync(storePath);
  const pulled = await runIn(
    dir,
    { PAGEDECK_SNAPSHOT_PULL_URL: remote, PAGEDECK_SNAPSHOT_PUSH_URL: unused },
    ["store", "pull"],
  );

  expect(pushed.code).toBe(EXIT_CODES.success);
  expect(pulled.code).toBe(EXIT_CODES.success);
  expect(sha256(storePath)).toBe(before);
  expect(existsSync(join(dir, "unused.db"))).toBe(false);
});

test("store pull does not read the push variable", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const remote = pathToFileURL(join(dir, "remote.db")).href;
  await run(dir, "store", "push", remote);

  const result = await runIn(dir, { PAGEDECK_SNAPSHOT_PUSH_URL: remote }, [
    "store",
    "pull",
  ]);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "needs a <url> to pull, or PAGEDECK_SNAPSHOT_PULL_URL set to one",
  );
});

test("store push does not read the pull variable", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const remote = pathToFileURL(join(dir, "remote.db")).href;

  const result = await runIn(dir, { PAGEDECK_SNAPSHOT_PULL_URL: remote }, [
    "store",
    "push",
  ]);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "needs a <url> to push, or PAGEDECK_SNAPSHOT_PUSH_URL set to one",
  );
  expect(existsSync(join(dir, "remote.db"))).toBe(false);
});

test("a target given as both <url> and the verb's variable is refused", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const remote = pathToFileURL(join(dir, "remote.db")).href;

  const result = await runIn(dir, { PAGEDECK_SNAPSHOT_PUSH_URL: remote }, [
    "store",
    "push",
    remote,
  ]);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("given a target twice");
  expect(result.err).toContain("unset PAGEDECK_SNAPSHOT_PUSH_URL");
  expect(existsSync(join(dir, "remote.db"))).toBe(false);
});

test("an empty PAGEDECK_SNAPSHOT_PUSH_URL leaves the <url> argument working", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const remote = pathToFileURL(join(dir, "remote.db")).href;

  const result = await runIn(dir, { PAGEDECK_SNAPSHOT_PUSH_URL: "" }, [
    "store",
    "push",
    remote,
  ]);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(existsSync(join(dir, "remote.db"))).toBe(true);
});

test("an empty PAGEDECK_SNAPSHOT_PULL_URL and no <url> is the usage error, not a transfer failure", async () => {
  const dir = siteDir();
  await run(dir, "sync");

  const result = await runIn(dir, { PAGEDECK_SNAPSHOT_PULL_URL: "   " }, ["store", "pull"]);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain(
    "needs a <url> to pull, or PAGEDECK_SNAPSHOT_PULL_URL set to one",
  );
});

test("the success line for a target from PAGEDECK_SNAPSHOT_PUSH_URL is redacted", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const presigned = `${pathToFileURL(join(dir, "remote.db")).href}?X-Amz-Signature=deadbeefcafe`;

  const result = await runIn(dir, { PAGEDECK_SNAPSHOT_PUSH_URL: presigned }, [
    "store",
    "push",
  ]);

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.out).not.toContain("deadbeefcafe");
  expect(result.out).toContain("remote.db");
});

test("the refusal of a target given twice quotes neither credential", async () => {
  const dir = siteDir();
  const argvUrl = `${pathToFileURL(join(dir, "argv.db")).href}?X-Amz-Signature=argvsecret`;
  const envUrl = `${pathToFileURL(join(dir, "env.db")).href}?X-Amz-Signature=envsecret`;

  const result = await runIn(dir, { PAGEDECK_SNAPSHOT_PULL_URL: envUrl }, [
    "store",
    "pull",
    argvUrl,
  ]);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).not.toContain("argvsecret");
  expect(result.err).not.toContain("envsecret");
  expect(result.err).toContain("argv.db");
  expect(result.err).toContain("env.db");
});

test("an unknown store subcommand is refused", async () => {
  const dir = siteDir();

  const result = await run(dir, "store", "sync", "file:///tmp/x.db");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("store sync");
});

test("a snapshot url is never printed with its credential-bearing query", async () => {
  const dir = siteDir();
  await run(dir, "sync");
  const presigned = `${pathToFileURL(join(dir, "remote.db")).href}?X-Amz-Signature=deadbeefcafe`;

  const pushed = await run(dir, "store", "push", presigned);
  const pulled = await run(dir, "store", "pull", presigned);

  expect(pushed.code).toBe(EXIT_CODES.success);
  expect(pulled.code).toBe(EXIT_CODES.success);
  for (const line of [pushed.out, pushed.err, pulled.out, pulled.err]) {
    expect(line).not.toContain("deadbeefcafe");
    expect(line).not.toContain("X-Amz-Signature");
  }
  expect(pushed.out).toContain("remote.db");
});

function writeManifest(
  dir: string,
  name: string,
  build: { id: string; createdAt: string; parent?: string },
  files: readonly {
    domain?: string;
    path: string;
    kind: string;
    hash: string;
    size: number;
  }[],
): string {
  const file = join(dir, name);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: MANIFEST_VERSION,
        build,
        store: { seq: 1 },
        site: { trailingSlash: "never" },
        routing: { version: 1, site: { trailingSlash: "never" }, trees: [] },
        files,
        pages: [],
        tiers: {
          policy: DEFAULT_TIER_POLICY,
          pageCount: 0,
          shippedUsages: 0,
          groups: [],
          assignments: [],
        },
        classes: [],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

const OLD_BUILD = { id: "build-01", createdAt: "2026-08-25T10:00:00.000Z" };
const NEW_BUILD = {
  id: "build-02",
  createdAt: "2026-08-26T09:30:00.000Z",
  parent: "build-01",
};
const RACED_BUILD = {
  id: "build-03",
  createdAt: "2026-08-26T09:45:00.000Z",
  parent: "build-99",
};

const OLD_FILES = [
  { path: "/assets/en-aaa.js", kind: "js", hash: "sha256:aa", size: 10 },
  { path: "/index.html", kind: "html", hash: "sha256:11", size: 20 },
];

const NEW_FILES = [
  { path: "/assets/en-bbb.js", kind: "js", hash: "sha256:bb", size: 12 },
  { path: "/index.html", kind: "html", hash: "sha256:22", size: 24 },
];

function diffSite(): string {
  const dir = tempDir();
  writeManifest(dir, "before.json", OLD_BUILD, OLD_FILES);
  writeManifest(dir, "after.json", NEW_BUILD, NEW_FILES);
  writeManifest(dir, "raced.json", RACED_BUILD, OLD_FILES);
  return dir;
}

test("diff writes one JSON document, assets before HTML, prune held back", async () => {
  const dir = diffSite();

  const result = await run(dir, "diff", "before.json", "after.json");

  expect(result.code).toBe(EXIT_CODES.success);
  const diff = JSON.parse(result.out) as {
    prune: { notBefore: string };
    trees: {
      upload: { key: string; change: string }[];
      prune: { key: string }[];
    }[];
  };
  expect(diff.trees[0]?.upload.map((file) => [file.change, file.key])).toEqual([
    ["added", "/assets/en-bbb.js"],
    ["changed", "/index.html"],
  ]);
  expect(diff.trees[0]?.prune.map((file) => file.key)).toEqual([
    "/assets/en-aaa.js",
  ]);
  expect(diff.prune.notBefore).toBe("2026-09-02T09:30:00.000Z");
});

test("diff --grace-seconds moves the deadline it prints", async () => {
  const dir = diffSite();

  const result = await run(
    dir,
    "diff",
    "before.json",
    "after.json",
    "--grace-seconds",
    "3600",
  );

  expect(result.code).toBe(EXIT_CODES.success);
  expect(
    (JSON.parse(result.out) as { prune: { notBefore: string } }).prune
      .notBefore,
  ).toBe("2026-08-26T10:30:00.000Z");
});

test("diff of a build against itself exits 0 with an empty document", async () => {
  const dir = diffSite();

  const result = await run(dir, "diff", "after.json", "after.json");

  expect(result.code).toBe(EXIT_CODES.success);
  const diff = JSON.parse(result.out) as {
    trees: { upload: unknown[]; prune: unknown[] }[];
    stats: { unchanged: number };
  };
  expect(diff.trees[0]?.upload).toEqual([]);
  expect(diff.trees[0]?.prune).toEqual([]);
  expect(diff.stats.unchanged).toBe(2);
});

test("diff refuses a build that was not based on the build it is deploying over", async () => {
  const dir = diffSite();

  const result = await run(dir, "diff", "after.json", "raced.json");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("build-03");
  expect(result.err).toContain("build-99");
  expect(result.err).toContain("build-02");
  expect(result.err).toContain("--force");
});

test("diff of one build against itself needs no --force: it deploys nothing", async () => {
  const dir = diffSite();

  const result = await run(dir, "diff", "after.json", "after.json");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe("");
  const document = JSON.parse(result.out) as {
    trees: { upload: unknown[]; prune: unknown[] }[];
  };
  expect(document.trees[0]?.upload).toEqual([]);
  expect(document.trees[0]?.prune).toEqual([]);
});

test("diff refuses two builds stamped with one id when they hold different files", async () => {
  const dir = diffSite();
  writeManifest(dir, "twin.json", { ...NEW_BUILD, parent: "build-99" }, [
    ...OLD_FILES,
  ]);

  const result = await run(dir, "diff", "after.json", "twin.json");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("build-99");
  expect(result.err).toContain("--force");
});

test("diff refuses a build that records no parent, and says so in its own words", async () => {
  const dir = diffSite();

  const result = await run(dir, "diff", "after.json", "before.json");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("records no parent");
  expect(result.err).toContain("build-01");
  expect(result.err).toContain("build-02");
  expect(result.err).toContain("--force");
});

test("diff --force deploys a build that did not follow the one it deploys over", async () => {
  const dir = diffSite();

  const result = await run(dir, "diff", "after.json", "raced.json", "--force");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(result.err).toBe("");
  expect(
    (JSON.parse(result.out) as { version: number }).version,
  ).toBeGreaterThan(0);
});

test("diff --force records on the document that the check was skipped", async () => {
  const dir = diffSite();

  const forced = await run(dir, "diff", "after.json", "raced.json", "--force");
  const ordinary = await run(dir, "diff", "before.json", "after.json");

  expect(JSON.parse(forced.out)).toHaveProperty("forced", true);
  expect(JSON.parse(ordinary.out)).not.toHaveProperty("forced");
  expect(ordinary.out).not.toContain("forced");
});

test("two manifests that cannot be read are both named in one report", async () => {
  const dir = tempDir();

  const result = await run(dir, "diff", "before.json", "after.json");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("before.json");
  expect(result.err).toContain("after.json");
});

test("diff refuses a bad grace period and a missing path in one report", async () => {
  const dir = diffSite();

  const result = await run(
    dir,
    "diff",
    "before.json",
    "--grace-seconds",
    "a while",
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("a while");
  expect(result.err).toContain("two manifest paths");
  expect(result.err).toContain("pagedeck diff");
});

test("diff of a manifest another version wrote is refused at the version", async () => {
  const dir = diffSite();
  const ahead = join(dir, "ahead.json");
  writeFileSync(
    ahead,
    JSON.stringify({
      ...JSON.parse(readFileSync(join(dir, "after.json"), "utf8")),
      version: 99,
    }),
  );

  const result = await run(dir, "diff", "before.json", "ahead.json");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("ahead.json");
  expect(result.err).toContain("version 99");
});

test("two manifests another version wrote are both named in one report", async () => {
  const dir = tempDir();
  for (const name of ["before.json", "after.json"]) {
    writeFileSync(
      join(dir, name),
      JSON.stringify({ version: 99, build: OLD_BUILD, files: [] }),
    );
  }

  const result = await run(dir, "diff", "before.json", "after.json");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("before.json");
  expect(result.err).toContain("after.json");
});

test("a grace period no deadline can be expressed as is refused, not crashed on", async () => {
  const dir = diffSite();

  const result = await run(
    dir,
    "diff",
    "before.json",
    "after.json",
    "--grace-seconds",
    "9999999999999",
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("--grace-seconds");
  expect(result.err).toContain("604800");
});

function rollbackSite(): string {
  const dir = tempDir();
  const fixtures = join(dir, "content");
  writeFixture(fixtures, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};
import { definePages, fromCollection } from ${JSON.stringify(CORE_PAGES)};
import { defineLocales } from ${JSON.stringify(CORE_LOCALES)};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(fixtures)}),
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
    components: { Copy: "./components/Copy.js" },
    content: () => ({ tree: [{ component: "Copy" }] }),
  },
});
`,
  );
  mkdirSync(join(dir, "components"), { recursive: true });
  writeFileSync(
    join(dir, "components", "Copy.js"),
    "export default function Copy() { return null; }\n",
  );
  mkdirSync(join(dir, "dist"), { recursive: true });
  mkdirSync(join(dir, RETENTION_DIR), { recursive: true });
  writeManifest(dir, join("dist", "manifest.json"), NEW_BUILD, NEW_FILES);
  writeManifest(
    dir,
    join(RETENTION_DIR, `${OLD_BUILD.id}.json`),
    OLD_BUILD,
    OLD_FILES,
  );
  writeManifest(
    dir,
    join(RETENTION_DIR, `${NEW_BUILD.id}.json`),
    NEW_BUILD,
    NEW_FILES,
  );
  return dir;
}

test("rollback writes the document pagedeck diff writes for the same pair", async () => {
  const dir = rollbackSite();

  const rolled = await run(dir, "rollback", OLD_BUILD.id);
  const diffed = await run(
    dir,
    "diff",
    join("dist", "manifest.json"),
    join(RETENTION_DIR, `${OLD_BUILD.id}.json`),
    "--force",
  );

  expect(rolled.code).toBe(EXIT_CODES.success);
  expect(rolled.err).toBe("");
  expect(JSON.parse(rolled.out)).not.toHaveProperty("forced");
  expect(
    diffed.out
      .split("\n")
      .filter((line) => line !== `  "forced": true,`)
      .join("\n"),
  ).toBe(rolled.out);
  const document = JSON.parse(rolled.out) as {
    trees: { upload: { key: string }[]; prune: { key: string }[] }[];
  };
  expect(document.trees[0]?.upload.map((file) => file.key)).toContain(
    "/assets/en-aaa.js",
  );
  expect(document.trees[0]?.prune.map((file) => file.key)).toEqual([
    "/assets/en-bbb.js",
  ]);
});

test("rollback --grace-seconds moves the deadline the restore prints", async () => {
  const dir = rollbackSite();

  const result = await run(dir, "rollback", OLD_BUILD.id, "--grace-seconds", "3600");

  expect(result.code).toBe(EXIT_CODES.success);
  expect(
    (JSON.parse(result.out) as { prune: { notBefore: string } }).prune
      .notBefore,
  ).toBe("2026-08-25T11:00:00.000Z");
});

test("rollback to a build the store does not hold names the ones it does", async () => {
  const dir = rollbackSite();

  const result = await run(dir, "rollback", "build-99");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain('Retained manifest "build-99"');
  expect(result.err).toContain(OLD_BUILD.id);
  expect(result.err).toContain(NEW_BUILD.id);
  expect(result.err).toContain("build.retention.keep");
});

test.skipIf(process.platform === "win32")(
  "a rollback target that is a symlink cannot put the file it points at into the report",
  async () => {
    const dir = rollbackSite();
    const secret = join(dir, "secret.txt");
    writeFileSync(secret, "leaked-secret-value\n");
    symlinkSync(secret, join(dir, RETENTION_DIR, "build-99.json"));

    const result = await run(dir, "rollback", "build-99");

    expect(result.code).toBe(EXIT_CODES.configError);
    expect(result.err).not.toContain("leaked-sec");
    expect(result.err).toContain(
      'Retained manifest "build-99": nothing opened at',
    );
  },
);

test("rollback reports a bad grace period and an unknown build id in one run", async () => {
  const dir = rollbackSite();

  const result = await run(
    dir,
    "rollback",
    "build-99",
    "--grace-seconds",
    "a while",
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("a while");
  expect(result.err).toContain("build-99");
});

test("a forged rollback target cannot forge a line in the report that refuses it", async () => {
  const dir = rollbackSite();
  const forged = 'build-99"\n\u001B[Kfw: Site build: 0 problems\r';

  const result = await run(
    dir,
    "rollback",
    forged,
    "--grace-seconds",
    "a while",
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  const written = markDiagnostic(result.err).split("\n");
  expect(written).toHaveLength(3);
  expect(written.every((line) => line.startsWith("pagedeck: "))).toBe(true);
  expect(written.some((line) => /^pagedeck: Site build/.test(line))).toBe(false);
  expect(written.some((line) => /[\u0000-\u001F\u007F]/.test(line))).toBe(
    false,
  );
  expect(written[0]).toContain(`Rollback to build ${JSON.stringify(forged)}`);
});

const FORGED_ARG = 'x"\n\u001B[Kfw: Site build: 0 problems\r';

function writtenWithoutForgery(forged: Run, plain: Run): string[] {
  expect(forged.code).toBe(EXIT_CODES.configError);
  expect(plain.code).toBe(EXIT_CODES.configError);
  const written = markDiagnostic(forged.err).split("\n");
  expect(written).toHaveLength(markDiagnostic(plain.err).split("\n").length);
  expect(written.some((line) => /^pagedeck: Site build/.test(line))).toBe(false);
  expect(written.some((line) => /[\u0000-\u001F\u007F]/.test(line))).toBe(
    false,
  );
  return written;
}

for (const verb of ["sync", "build", "dev"] as const) {
  test(`an unknown option on pagedeck ${verb} cannot forge a line in its refusal`, async () => {
    const dir = siteDir();
    const option = `--${FORGED_ARG}`;

    const written = writtenWithoutForgery(
      await run(dir, verb, option),
      await run(dir, verb, "--bogus"),
    );

    expect(written[0]).toBe(
      `pagedeck: Unknown option ${JSON.stringify(option)} for pagedeck ${verb}.`,
    );
  });
}

test("an unknown option on pagedeck diff cannot forge a line in its refusal", async () => {
  const dir = tempDir();
  const option = `--${FORGED_ARG}`;

  const written = writtenWithoutForgery(
    await run(dir, "diff", option),
    await run(dir, "diff", "--bogus"),
  );

  expect(written[0]).toBe(
    `pagedeck: Unknown option ${JSON.stringify(option)} for pagedeck diff.`,
  );
});

test("an unknown option on pagedeck rollback cannot forge a line in its refusal", async () => {
  const dir = rollbackSite();
  const option = `--${FORGED_ARG}`;

  const written = writtenWithoutForgery(
    await run(dir, "rollback", option),
    await run(dir, "rollback", "--bogus"),
  );

  expect(written[0]).toBe(
    `pagedeck: Unknown option ${JSON.stringify(option)} for pagedeck rollback.`,
  );
});

test("a pagedeck rollback --grace-seconds value cannot forge a line in its refusal", async () => {
  const dir = rollbackSite();

  const written = writtenWithoutForgery(
    await run(dir, "rollback", "--grace-seconds", FORGED_ARG),
    await run(dir, "rollback", "--grace-seconds", "a while"),
  );

  expect(written[0]).toBe(
    `pagedeck: pagedeck rollback --grace-seconds takes a whole number of seconds, and got ${JSON.stringify(FORGED_ARG)}.`,
  );
});

test("a pagedeck dev --port value cannot forge a line in its refusal", async () => {
  const dir = siteDir();

  const written = writtenWithoutForgery(
    await run(dir, "dev", "--port", FORGED_ARG),
    await run(dir, "dev", "--port", "70000"),
  );

  expect(written[0]).toBe(
    `pagedeck: pagedeck dev --port takes a port between 0 and 65535, and got ${JSON.stringify(FORGED_ARG)}.`,
  );
});

test("a pagedeck sync --interval value cannot forge a line in its refusal", async () => {
  const dir = siteDir();

  const written = writtenWithoutForgery(
    await run(dir, "sync", "--watch", "--interval", FORGED_ARG),
    await run(dir, "sync", "--watch", "--interval", "soon"),
  );

  expect(written[0]).toBe(
    `pagedeck: pagedeck sync --interval takes a whole number of seconds above zero, and got ${JSON.stringify(FORGED_ARG)}.`,
  );
});

test("a pagedeck dev --host value cannot forge a line in its refusal", async () => {
  const dir = siteDir();
  const value = `--${FORGED_ARG}`;

  const written = writtenWithoutForgery(
    await run(dir, "dev", "--host", value),
    await run(dir, "dev", "--host", "--port"),
  );

  expect(written[0]).toBe(
    `pagedeck: pagedeck dev --host takes the address to bind — 127.0.0.1 for this machine only, 0.0.0.0 for every interface — and got ${JSON.stringify(value)}.`,
  );
});

test("a pagedeck diff --grace-seconds value cannot forge a line in its refusal", async () => {
  const dir = tempDir();

  const written = writtenWithoutForgery(
    await run(dir, "diff", "--grace-seconds", FORGED_ARG),
    await run(dir, "diff", "--grace-seconds", "a while"),
  );

  expect(written[0]).toBe(
    `pagedeck: pagedeck diff --grace-seconds takes a whole number of seconds, and got ${JSON.stringify(FORGED_ARG)}.`,
  );
});

test("an unknown pagedeck store subcommand cannot forge a line in its refusal", async () => {
  const dir = siteDir();

  const written = writtenWithoutForgery(
    await run(dir, "store", FORGED_ARG),
    await run(dir, "store", "sync"),
  );

  expect(written[0]).toBe(
    `pagedeck: Unknown command ${JSON.stringify(`pagedeck store ${FORGED_ARG}`)}.`,
  );
});

test("an unknown verb cannot forge a line in its refusal", async () => {
  const dir = siteDir();

  const written = writtenWithoutForgery(
    await run(dir, FORGED_ARG),
    await run(dir, "deploy"),
  );

  expect(written[0]).toBe(
    `pagedeck: Unknown command ${JSON.stringify(FORGED_ARG)}.`,
  );
});

const C1_FORGED = "x\u009B2K\u0085fw: Site build: 0 problems";

test("a C1 control in a rollback target reaches stderr written out", async () => {
  const dir = rollbackSite();

  const result = await run(
    dir,
    "rollback",
    C1_FORGED,
    "--grace-seconds",
    "a while",
  );

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(/[\u0080-\u009F]/.test(result.err)).toBe(false);
  // Literal, not JSON.stringify: JSON.stringify leaves C1 raw.
  expect(result.err).toContain(
    'Rollback to build "x\\u009b2K\\u0085fw: Site build: 0 problems"',
  );
});

test("a C1 control in a typed argument reaches stderr written out", async () => {
  const dir = siteDir();

  const written = writtenWithoutForgery(
    await run(dir, "dev", "--port", C1_FORGED),
    await run(dir, "dev", "--port", "70000"),
  );

  expect(/[\u0080-\u009F]/.test(written.join("\n"))).toBe(false);
  // Literal, not JSON.stringify: JSON.stringify leaves C1 raw.
  expect(written[0]).toBe(
    'pagedeck: pagedeck dev --port takes a port between 0 and 65535, and got "x\\u009b2K\\u0085fw: Site build: 0 problems".',
  );
});

test("a target given twice cannot forge a line, and neither credential is quoted", async () => {
  const dir = siteDir();
  const argvUrl = `//AKIAARGV:argvsecret@bucket/a"b\nfw: Site build: 0 problems?sig=argvsig`;
  const envUrl = `//AKIAENV:envsecret@bucket/c"d\nfw: Site build: 0 problems?sig=envsig`;

  const forged = await runIn(dir, { PAGEDECK_SNAPSHOT_PULL_URL: envUrl }, [
    "store",
    "pull",
    argvUrl,
  ]);
  const written = writtenWithoutForgery(
    forged,
    await runIn(dir, { PAGEDECK_SNAPSHOT_PULL_URL: "//bucket/env.db" }, [
      "store",
      "pull",
      "//bucket/argv.db",
    ]),
  );

  expect(written[0]).toContain(`<url> is "…@bucket/a\\"b`);
  expect(written[0]).toContain(`PAGEDECK_SNAPSHOT_PULL_URL is "…@bucket/c\\"d`);
  for (const secret of ["argvsecret", "envsecret", "argvsig", "envsig"])
    expect(forged.err).not.toContain(secret);
});

test("an unreadable manifest path cannot forge a line in its refusal", async () => {
  const dir = tempDir();

  const written = writtenWithoutForgery(
    await run(dir, "diff", FORGED_ARG, "after.json"),
    await run(dir, "diff", "before.json", "after.json"),
  );

  expect(
    written.some((line) =>
      line.startsWith(
        `pagedeck:   Manifest ${JSON.stringify(resolve(dir, FORGED_ARG))}: could not be read — pass the path pagedeck build wrote it to`,
      ),
    ),
  ).toBe(true);
});

test("rollback with no build id is refused with the usage", async () => {
  const dir = rollbackSite();

  const result = await run(dir, "rollback");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("pagedeck rollback");
  expect(result.err).toContain("<build-id>");
});

test("rollback of a site with no build section says which field is missing", async () => {
  const dir = siteDir();

  const result = await run(dir, "rollback", OLD_BUILD.id);

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain("no build section");
  expect(result.err).toContain("outDir");
  expect(result.err).toContain(
    "add a build section to pagedeck.config.ts — build: { pages, components, content }",
  );
});

// Each byte can rewrite or forge a terminal line (#730).
const HOSTILE_ID = "x\u001b[2K\rpagedeck: sync complete\n\u009b2K";

function hostileSite(path: string, schema: string): string {
  const dir = tempDir();
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from ${JSON.stringify(CORE_CONFIG)};

export default defineConfig({
  store: "./content.db",
  collections: [
    {
      name: "pages",
      loader: {
        syncAll(writer) {
          writer.upsert({ locale: "en", path: ${JSON.stringify(path)}, data: {} });
          return { changed: [], deleted: [], cursor: 1 };
        },
        syncSince() { throw new Error("unused"); },
      },
      schema: ${schema},
    },
  ],
});
`,
  );
  return dir;
}

test("pagedeck sync prints an unusable entry id with no raw control character from it", async () => {
  const dir = hostileSite(`${HOSTILE_ID}\u0000/../y`, "false");

  const result = await run(dir, "sync");

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(result.err.split("\n").slice(1)).toEqual([
    '  /en/x\ufffd[2K\ufffdpagedeck: sync complete\ufffd\ufffd2K\ufffd/../y: its path holds a NUL and a ".."',
  ]);
});

test("pagedeck sync prints a schema failure on a hostile entry id with no raw control character from it", async () => {
  const dir = hostileSite(
    HOSTILE_ID,
    `{ "~standard": { version: 1, vendor: "hand", validate: () => ({ issues: [{ path: ["title"], message: "expected a string" }] }) } }`,
  );

  const result = await run(dir, "sync");

  expect(result.code).toBe(EXIT_CODES.syncFailed);
  expect(result.err).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(result.err.split("\n").slice(1)).toEqual([
    "  /en/x\ufffd[2K\ufffdpagedeck: sync complete\ufffd\ufffd2K: title — expected a string",
  ]);
});
