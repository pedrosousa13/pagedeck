import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runCli } from "./cli.js";
import { ConfigError, EXIT_CODES } from "./exit.js";
import { MANIFEST_VERSION } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import { retainedChunkOf, retainManifest, sourcemapOf } from "./retention.js";
import { differingWarning, parseFrame, traceFrame, unreadableWarning } from "./trace.js";

const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "src", "index.ts");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function siteRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pagedeck-trace-"));
  roots.push(root);
  writeFileSync(
    join(root, "pagedeck.config.ts"),
    `import { defineConfig } from ${JSON.stringify(join(import.meta.dirname, "config.ts"))};
import { createFixtureLoader } from ${JSON.stringify(FIXTURES)};
export default defineConfig({
  store: "./content.db",
  collections: [{ name: "pages", loader: createFixtureLoader("./content"), schema: false }],
});
`,
  );
  return root;
}

function manifest(id: string, createdAt: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    build: { id, createdAt },
    store: { seq: 1 },
    site: { trailingSlash: "never" },
    routing: {
      version: 1,
      site: { trailingSlash: "never" },
      trees: [{ redirects: [], headers: [] }],
    },
    files: [],
    pages: [],
    tiers: {
      policy: {
        coreMinShare: 0.6,
        coreMinUsageShare: 0.25,
        midMinPages: 2,
        exclude: [],
        minSize: 20000,
        minShareCount: 1,
      },
      pageCount: 0,
      shippedUsages: 0,
      groups: [],
      assignments: [],
    },
    classes: [],
  };
}

// One generated line, mapped from `src/Chart.js`: column 10 is the segment at
// generated column 9, original column 24, counted from 0.
function chartMap(sourcesContent = "export default function Chart() {}\n"): string {
  return JSON.stringify({
    version: 3,
    file: "Chart-a1.js",
    names: ["Chart"],
    sources: ["src/Chart.js"],
    sourcesContent: [sourcesContent],
    mappings: "AAAA,SAAwBA,GAAQ,CAAE,MAAO,mBAAqB",
  });
}

// Line 1 is 60 characters long and line 2, which the map leaves unmapped, 20.
const CHART_CODE = `${"x".repeat(60)}\n${"y".repeat(20)}`;

async function retain(root: string, id: string, createdAt: string, map?: string): Promise<void> {
  await retainManifest(
    root,
    manifest(id, createdAt),
    { keep: 20 },
    map === undefined
      ? []
      : [{ path: "/assets/Chart-a1.js.map", contents: map, code: CHART_CODE }],
  );
}

const FRAME = { chunk: "assets/Chart-a1.js", line: 1, column: 10 };

async function refusal(run: Promise<unknown>): Promise<Error> {
  const failure = await run.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(ConfigError);
  return failure as Error;
}

test("a frame is read as a stack names it: a URL, a path from the root, or a path in the output tree", () => {
  for (const text of [
    "https://example.com/assets/Chart-a1.js:1:10",
    "https://example.com/assets/Chart-a1.js?v=2:1:10",
    "/assets/Chart-a1.js:1:10",
    "assets/Chart-a1.js:1:10",
  ]) {
    expect(parseFrame(text), text).toEqual(FRAME);
  }
});

test("a frame is read as Chrome and Firefox print it in a stack", () => {
  for (const text of [
    "    at Counter (https://example.com/assets/Chart-a1.js:1:10)",
    "at async Counter (https://example.com/assets/Chart-a1.js:1:10)",
    "at https://example.com/assets/Chart-a1.js:1:10",
    "Counter@https://example.com/assets/Chart-a1.js:1:10",
    "@https://example.com/assets/Chart-a1.js:1:10",
    "Counter@https://user:secret@example.com/assets/Chart-a1.js:1:10",
  ]) {
    expect(parseFrame(text), text).toEqual(FRAME);
  }
});

test("a frame in code run by eval or new Function is refused, not read as a chunk", () => {
  for (const text of [
    "    at eval (eval at Counter (https://example.com/assets/Chart-a1.js:10:5), <anonymous>:3:4)",
    "    at Counter (eval at render (https://example.com/assets/Chart-a1.js:10:5), <anonymous>:3:4)",
    "Counter@https://example.com/assets/Chart-a1.js line 10 > eval:3:4",
    "Counter@https://example.com/assets/Chart-a1.js line 10 > Function:3:4",
  ]) {
    expect(parseFrame(text), text).toBe(
      "pagedeck trace takes a frame in a chunk, and got a frame in code run by eval or new Function, whose line and column count from the start of that code and not of any chunk; trace the next frame down the stack that names a chunk under /assets/.",
    );
  }
});

test("a frame refusal names no userinfo, host or query string of the frame it was given", () => {
  const refusals = [
    "https://user:secret@intranet.test/assets/Chart-a1.js?token=abc",
    "https://user:secret@intranet.test/assets/Chart-a1.js?token=abc:0:2",
    "    at Counter (https://user:secret@intranet.test/assets/Chart-a1.js?token=a:b:1)",
    "https://user:secret@[intranet.test/assets/Chart-a1.js?token=abc:1:2",
    "assets/../Chart-a1.js?token=abc:1:2",
  ].map((text) => parseFrame(text));

  expect(refusals).toEqual([
    'pagedeck trace takes a frame as <chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345, and got "/assets/Chart-a1.js".',
    'pagedeck trace takes a frame\'s line and column counted from 1, as a browser\'s stack counts them, and got "/assets/Chart-a1.js:0:2".',
    'pagedeck trace takes a frame as <chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345, and got "/assets/Chart-a1.js".',
    'pagedeck trace takes a frame as <chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345, and got "/assets/Chart-a1.js:1:2", whose chunk is not a URL.',
    'pagedeck trace takes a frame as <chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345, and got "assets/../Chart-a1.js:1:2", whose chunk is not a path in the output tree.',
  ]);
  for (const refusal of refusals) {
    for (const secret of ["user", "secret", "intranet", "token", "abc"]) {
      expect(refusal).not.toContain(secret);
    }
  }
});

test("a frame with no position, a position counted from 0, or a chunk outside the tree is refused by its shape", () => {
  expect(parseFrame("assets/Chart-a1.js")).toBe(
    'pagedeck trace takes a frame as <chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345, and got "assets/Chart-a1.js".',
  );
  expect(parseFrame("assets/Chart-a1.js:0:10")).toBe(
    'pagedeck trace takes a frame\'s line and column counted from 1, as a browser\'s stack counts them, and got "assets/Chart-a1.js:0:10".',
  );
  expect(parseFrame("../assets/Chart-a1.js:1:10")).toBe(
    'pagedeck trace takes a frame as <chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345, and got "../assets/Chart-a1.js:1:10", whose chunk is not a path in the output tree.',
  );
});

test("a frame resolves to its source through the named build's map, counted from 1", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());

  expect(await traceFrame(root, FRAME, "b1")).toEqual({
    build: "b1",
    source: "src/Chart.js",
    line: 1,
    column: 25,
    differing: [],
    unreadable: [],
  });
});

test("with no build id, the newest retained build holding the chunk answers, and a differing older map is named", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-27T10:00:00.000Z", chartMap("// an older comment\n"));
  await retain(root, "b2", "2026-10-28T10:00:00.000Z", chartMap());
  await retain(root, "b3", "2026-10-29T10:00:00.000Z");

  const traced = await traceFrame(root, FRAME);

  expect(traced).toEqual({
    build: "b2",
    source: "src/Chart.js",
    line: 1,
    column: 25,
    differing: ["b1"],
    unreadable: [],
  });
  expect(differingWarning(FRAME, traced)).toBe(
    'Trace "assets/Chart-a1.js:1:10": build "b1" also holds a map for "assets/Chart-a1.js" that differs from the one read, the newest build\'s, "b2" — a chunk\'s name is a hash of its code, so an edit that changes no code, such as a comment, changes the map and keeps the name; pass the report\'s release as <build-id> to read that build\'s map',
  );
});

test("builds holding the same map for the chunk raise no warning", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-27T10:00:00.000Z", chartMap());
  await retain(root, "b2", "2026-10-28T10:00:00.000Z", chartMap());

  const traced = await traceFrame(root, FRAME);

  expect(traced.differing).toEqual([]);
  expect(differingWarning(FRAME, traced)).toBeUndefined();
});

test("a build id the store does not hold is refused with the ids it does hold", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());

  expect((await refusal(traceFrame(root, FRAME, "b9"))).message).toBe(
    'Trace "assets/Chart-a1.js:1:10": build "b9" is not in the retention store — the retained builds are "b1", so pass one of those, or leave the build id out to search them all; a build past build.retention.keep is pruned with its maps, and to read one again, build the commit that served the page again, with build.islandErrors declared: a chunk\'s name is a hash of its contents, so the same commit writes the same chunk and its map',
  );
});

test("a build id over an empty store is refused with its own sentence", async () => {
  const root = siteRoot();

  expect((await refusal(traceFrame(root, FRAME, "b9"))).message).toBe(
    'Trace "assets/Chart-a1.js:1:10": build "b9" is not in the retention store — the store holds no retained build, so run pagedeck build to fill it',
  );
});

test("a build id that is not a path segment is refused before it reaches the store", async () => {
  const root = siteRoot();

  expect((await refusal(traceFrame(root, FRAME, ".."))).message).toBe(
    'Trace "assets/Chart-a1.js:1:10": build ".." is not a build id the store can hold — the build id is a dot segment, which resolves out of the retention store; pass the release the report carries, or leave the build id out to search every retained build',
  );
});

test("a retained build with no map for the chunk is refused by build and chunk", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z");

  expect((await refusal(traceFrame(root, FRAME, "b1"))).message).toBe(
    'Trace "assets/Chart-a1.js:1:10": build "b1" retained no sourcemap for "assets/Chart-a1.js" — a build keeps a map for each chunk it wrote from authored source, and only while build.islandErrors is declared, so check the chunk name against the frame, or leave the build id out to search every retained build',
  );
});

test("a chunk no retained build holds a map for is refused with the store it searched", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z");

  expect((await refusal(traceFrame(root, FRAME))).message).toBe(
    `Trace "assets/Chart-a1.js:1:10": no retained build holds a sourcemap for "assets/Chart-a1.js" in ${JSON.stringify(join(root, ".pagedeck/sourcemaps"))} — a build keeps its maps only while build.islandErrors is declared, and the store keeps the last build.retention.keep builds; check the chunk name against the frame, or build the commit that served the page again, with build.islandErrors declared: a chunk's name is a hash of its contents, so the same commit writes the same chunk and its map`,
  );
});

test("a position on a line the map does not cover is refused rather than guessed", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());

  expect((await refusal(traceFrame(root, { ...FRAME, line: 2 }, "b1"))).message).toBe(
    'Trace "assets/Chart-a1.js:2:10": build "b1"\'s sourcemap for "assets/Chart-a1.js" maps no source at line 2, column 10 — check the line and column against the frame, which a browser counts from 1, and check that the report\'s release is this build',
  );
});

test("a column past the end of its line is refused, though the map would answer it from the line's last segment", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());

  expect((await refusal(traceFrame(root, { ...FRAME, column: 61 }, "b1"))).message).toBe(
    'Trace "assets/Chart-a1.js:1:61": column 61 is past the end of line 1 of "assets/Chart-a1.js" as build "b1" wrote it, which is 60 characters long — check the line and column against the frame, which a browser counts from 1, and check that the report\'s release is this build',
  );
  expect(await traceFrame(root, { ...FRAME, column: 60 }, "b1")).toMatchObject({
    source: "src/Chart.js",
  });
});

test("a line past the end of the chunk is refused", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());

  expect((await refusal(traceFrame(root, { ...FRAME, line: 3 }, "b1"))).message).toBe(
    'Trace "assets/Chart-a1.js:3:10": line 3 is past the end of "assets/Chart-a1.js" as build "b1" wrote it, which has 2 lines — check the line and column against the frame, which a browser counts from 1, and check that the report\'s release is this build',
  );
});

test("a map retained without its chunk is refused, since the position cannot be checked", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());
  rmSync(retainedChunkOf(root, "b1", FRAME.chunk));

  expect((await refusal(traceFrame(root, FRAME, "b1"))).message).toBe(
    'Trace "assets/Chart-a1.js:1:10": build "b1" retained a sourcemap for "assets/Chart-a1.js" and not the chunk itself, which the frame\'s line and column are checked against — pagedeck build writes the two together, so the store was edited by hand; build the commit that served the page again, with build.islandErrors declared: a chunk\'s name is a hash of its contents, so the same commit writes the same chunk and its map',
  );
});

function linkInPlace(root: string, file: string): void {
  const elsewhere = join(root, `elsewhere-${String(Math.random()).slice(2)}`);
  writeFileSync(elsewhere, "{}");
  rmSync(file);
  symlinkSync(elsewhere, file);
}

const UNOPENED =
  "the open ends there on a link, on a directory, on a mode that forbids the read, or on a name the file system will not take, and the store opens each map and chunk read-only and refuses one that is itself a link rather than follow it; build the commit that served the page again, with build.islandErrors declared: a chunk's name is a hash of its contents, so the same commit writes the same chunk and its map";

test("a map or chunk that is a link is refused by frame, build and path, with or without a build id", async () => {
  for (const of of [sourcemapOf, retainedChunkOf]) {
    const root = siteRoot();
    await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());
    const file = of(root, "b1", FRAME.chunk);
    linkInPlace(root, file);

    for (const id of ["b1", undefined]) {
      const failure = await refusal(traceFrame(root, FRAME, id));
      expect(failure.message).toBe(
        `Trace "assets/Chart-a1.js:1:10": build "b1": nothing opened at ${JSON.stringify(file)} — ${UNOPENED}`,
      );
      expect(failure.cause).toMatchObject({ code: "ELOOP" });
    }
  }
});

test("with no build id, an older build's map that will not open leaves the newest build's answer standing, and is named in a warning", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-27T10:00:00.000Z", chartMap());
  await retain(root, "b2", "2026-10-28T10:00:00.000Z", chartMap());
  linkInPlace(root, sourcemapOf(root, "b1", FRAME.chunk));

  const traced = await traceFrame(root, FRAME);

  expect(traced).toEqual({
    build: "b2",
    source: "src/Chart.js",
    line: 1,
    column: 25,
    differing: [],
    unreadable: ["b1"],
  });
  expect(unreadableWarning(FRAME, traced)).toBe(
    'Trace "assets/Chart-a1.js:1:10": build "b1" holds a map for "assets/Chart-a1.js" that did not open, so it was not compared with the one read, the newest build\'s, "b2" — pass "b1" as <build-id> to see why it did not open',
  );
});

test("a map that does not parse is refused with its path and the parser's error as the cause", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", "{ cut sh");

  const failure = await refusal(traceFrame(root, FRAME, "b1"));
  expect(failure.message).toContain(
    `Trace "assets/Chart-a1.js:1:10": the sourcemap at ${JSON.stringify(sourcemapOf(root, "b1", "assets/Chart-a1.js"))} is not a sourcemap this pagedeck can read`,
  );
  expect(failure.cause).toBeInstanceOf(SyntaxError);
});

async function run(cwd: string, ...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    cwd,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("pagedeck trace prints the source, line and column of a reported frame", async () => {
  const root = siteRoot();
  await retain(root, "b1", "2026-10-28T10:00:00.000Z", chartMap());

  for (const args of [["https://example.com/assets/Chart-a1.js:1:10"], ["/assets/Chart-a1.js:1:10", "b1"]]) {
    expect(await run(root, "trace", ...args)).toEqual({
      code: EXIT_CODES.success,
      out: "src/Chart.js:1:25",
      err: "",
    });
  }
});

test("pagedeck trace with no frame, too many arguments or an unknown option is refused with the usage", async () => {
  const root = siteRoot();

  const none = await run(root, "trace");
  expect(none.code).toBe(EXIT_CODES.configError);
  expect(none.err.split("\n")[0]).toBe(
    "pagedeck trace takes one <frame> and at most one <build-id>, the release the report carries, and got 0 arguments.",
  );
  expect(none.err).toContain("Usage:");

  const many = await run(root, "trace", "assets/Chart-a1.js:1:10", "b1", "b2", "--json");
  expect(many.code).toBe(EXIT_CODES.configError);
  expect(many.err.split("\n").slice(0, 2)).toEqual([
    'Unknown option "--json" for pagedeck trace.',
    "pagedeck trace takes one <frame> and at most one <build-id>, the release the report carries, and got 3 arguments.",
  ]);
});

test("pagedeck trace exits 2 on a frame it cannot resolve", async () => {
  const root = siteRoot();

  const result = await run(root, "trace", "assets/Chart-a1.js:1:10");

  expect(result.code).toBe(EXIT_CODES.configError);
  expect(result.err).toContain('Trace "assets/Chart-a1.js:1:10": no retained build holds a sourcemap');
});
