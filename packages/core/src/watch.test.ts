import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { DIAGNOSTIC_MARKER } from "./diagnostic-marker.js";
import { rest, watchSync } from "./watch.js";

const execFileAsync = promisify(execFile);

const BIN = join(import.meta.dirname, "..", "dist", "bin.js");

const sites: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of sites.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFixture(dir: string, relative: string, body: unknown): void {
  const file = join(dir, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

function stopAfter(ticks: number): {
  signal: AbortSignal;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  const controller = new AbortController();
  const slept: number[] = [];
  return {
    signal: controller.signal,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      if (slept.length >= ticks) controller.abort();
    },
  };
}

test("the loop syncs, rests for the interval, and syncs again", async () => {
  const driver = stopAfter(3);
  let ticks = 0;

  await watchSync({
    intervalMs: 5000,
    signal: driver.signal,
    tick: async () => {
      ticks += 1;
    },
    onFailure: (error) => {
      throw error;
    },
    sleep: driver.sleep,
  });

  expect(ticks).toBe(3);
  expect(driver.slept).toEqual([5000, 5000, 5000]);
});

test("a tick that throws is reported and the loop takes the next one", async () => {
  const driver = stopAfter(3);
  const reported: string[] = [];
  let ticks = 0;

  await watchSync({
    intervalMs: 1000,
    signal: driver.signal,
    tick: async () => {
      ticks += 1;
      throw new Error(`tick ${String(ticks)} failed`);
    },
    onFailure: (error) => reported.push((error as Error).message),
    sleep: driver.sleep,
  });

  expect(ticks).toBe(3);
  expect(reported).toEqual(["tick 1 failed", "tick 2 failed", "tick 3 failed"]);
});

test("a tick still running when the rest ends does not overlap the next", async () => {
  const driver = stopAfter(4);
  let inFlight = 0;
  let mostInFlight = 0;

  await watchSync({
    intervalMs: 0,
    signal: driver.signal,
    tick: async () => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
    },
    onFailure: (error) => {
      throw error;
    },
    sleep: driver.sleep,
  });

  expect(mostInFlight).toBe(1);
  expect(driver.slept).toHaveLength(4);
});

test("a signal that is already aborted syncs nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  let ticks = 0;

  await watchSync({
    intervalMs: 1000,
    signal: controller.signal,
    tick: async () => {
      ticks += 1;
    },
    onFailure: (error) => {
      throw error;
    },
    sleep: async () => {},
  });

  expect(ticks).toBe(0);
});

const NOT_THE_INTERVAL = 5_000;

test("a rest ends when its signal aborts, rather than waiting the interval out", async () => {
  const controller = new AbortController();
  const started = Date.now();

  const resting = rest(60_000, controller.signal);
  controller.abort();
  await resting;

  expect(Date.now() - started).toBeLessThan(NOT_THE_INTERVAL);
});

test("a signal that arrives during a rest ends the loop then, not an interval later", async () => {
  const controller = new AbortController();
  const started = Date.now();
  let ticks = 0;

  await watchSync({
    intervalMs: 60_000,
    signal: controller.signal,
    tick: async () => {
      ticks += 1;
      setTimeout(() => {
        controller.abort();
      }, 10);
    },
    onFailure: (error) => {
      throw error;
    },
    sleep: rest,
  });

  expect(ticks).toBe(1);
  expect(Date.now() - started).toBeLessThan(NOT_THE_INTERVAL);
});

// Under `packages/core`: the spawned `dist/bin.js` resolves `@pagedeck/*` from here, and
// Node will not strip types from a config under `node_modules`.
function siteDir(name: string): string {
  const dir = join(import.meta.dirname, "..", `.pagedeck-watch-${name}`);
  rmSync(dir, { recursive: true, force: true });
  sites.push(dir);
  const fixtures = join(dir, "content");
  writeFixture(fixtures, "en/home.json", { rev: 1, data: { title: "Home" } });
  writeFixture(fixtures, "en/about.json", { rev: 2, data: { title: "About" } });
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

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

const LINE_TIMEOUT = 30_000;

interface Watching {
  out: string[];
  err: string[];
  ended: boolean;
}

// The tail after the last newline waits for the next read: a `data` event is a read,
// not a line (#183).
function lineCollector(lines: string[]): (chunk: string) => void {
  let residual = "";
  return (chunk: string) => {
    residual += chunk;
    const parts = residual.split("\n");
    residual = parts.pop() ?? "";
    for (const line of parts) {
      if (line !== "") lines.push(line);
    }
  };
}

function startWatch(cwd: string, ...args: string[]): Watching {
  const child = spawn(process.execPath, [BIN, "sync", "--watch", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const watching: Watching = { out: [], err: [], ended: false };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", lineCollector(watching.out));
  child.stderr?.on("data", lineCollector(watching.err));
  child.on("exit", () => {
    watching.ended = true;
  });
  return watching;
}

function reported(watching: Watching, line: string): number {
  return watching.out.filter((written) => written === line).length;
}

// Filtered by marker, not `toEqual([])`: a spawned process shares stderr with
// everything it loads (#184).
function diagnostics(watching: Watching): string[] {
  return watching.err.filter((line) => line.startsWith(DIAGNOSTIC_MARKER));
}

async function until(
  watching: Watching,
  what: string,
  ready: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + LINE_TIMEOUT;
  while (!(await ready()) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (!(await ready())) {
    throw new Error(
      `the watch never ${what}\nstdout:\n${watching.out.join("\n")}\nstderr:\n${watching.err.join("\n")}`,
    );
  }
}

test("a watch keeps syncing on the interval, tick after tick", async () => {
  const dir = siteDir("full");

  const tick = "pages: 2 changed, 0 deleted, cursor 2";

  const watching = startWatch(dir, "--interval", "1");
  await until(
    watching,
    "reported two ticks",
    () => reported(watching, tick) >= 2,
  );

  expect(reported(watching, tick)).toBeGreaterThanOrEqual(2);
  expect(diagnostics(watching)).toEqual([]);
  expect(watching.ended).toBe(false);
}, 60_000);

test("--watch composes with --incremental: the ticks are incremental ones", async () => {
  const dir = siteDir("incremental");
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: dir });

  const watching = startWatch(dir, "--incremental", "--interval", "1");
  await until(watching, "reported a tick", () =>
    watching.out.includes("pages: 0 changed, 0 deleted, cursor 2"),
  );
  expect(watching.out).not.toContain("pages: 2 changed, 0 deleted, cursor 2");

  writeFixture(join(dir, "content"), "en/about.json", {
    rev: 3,
    data: { title: "About v2" },
  });
  await until(watching, "picked the edit up", () =>
    watching.out.includes("pages: 1 changed, 0 deleted, cursor 3"),
  );

  expect(watching.ended).toBe(false);
}, 60_000);

test("a failing tick is reported and the watch stays up", async () => {
  const dir = join(import.meta.dirname, "..", ".pagedeck-watch-failing");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sites.push(dir);
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig } from "@pagedeck/core";

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

  const watching = startWatch(dir, "--interval", "1");
  await until(
    watching,
    "reported two failures",
    () => diagnostics(watching).length >= 2,
  );

  for (const line of diagnostics(watching).slice(0, 2)) {
    expect(line).toContain('Collection "pages": loader syncAll failed');
    expect(line).toContain("the CMS is down");
  }
  expect(watching.ended).toBe(false);
}, 60_000);

function devSiteDir(): string {
  const dir = siteDir("dev");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "Prose.js"),
    "export default function Prose({ text }) { return text; }\n",
  );
  writeFileSync(
    join(dir, "pagedeck.config.ts"),
    `
import { defineConfig, defineLocales, definePages, fromCollection } from "@pagedeck/core";
import { createFixtureLoader } from "@pagedeck/fixtures";

const pages = {
  name: "pages",
  loader: createFixtureLoader(${JSON.stringify(join(dir, "content"))}),
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
    content: (page, store) => ({
      tree: [
        {
          component: "prose",
          props: {
            text: store.getEntry("pages", page.entry.locale, page.entry.path)
              .data.title,
          },
        },
      ],
    }),
  },
});
`,
  );
  return dir;
}

test("a fixture edit reaches a running dev session after a tick, with no restart", async () => {
  const dir = devSiteDir();
  await execFileAsync(process.execPath, [BIN, "sync"], { cwd: dir });
  const { loadConfig } = await import("./config.js");
  const { startDevServer } = await import("./dev.js");
  const server = await startDevServer({
    config: await loadConfig(dir),
    port: 0,
    err: () => {},
  });
  const page = async (): Promise<string> =>
    (await fetch(`${server.url}/home`)).text();

  try {
    expect(await page()).toContain("Home");

    // Started before the edit, first tick awaited: an edit made before the spawn is
    // picked up by the first tick even if the watch never loops.
    const watching = startWatch(dir, "--interval", "1");
    await until(
      watching,
      "reported its first tick",
      () => watching.out.length > 0,
    );

    writeFixture(join(dir, "content"), "en/home.json", {
      rev: 3,
      data: { title: "Home v2" },
    });
    await until(watching, "served the edit", async () =>
      (await page()).includes("Home v2"),
    );
  } finally {
    await server.close();
  }
}, 120_000);
