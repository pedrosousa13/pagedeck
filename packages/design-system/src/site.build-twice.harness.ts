import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ComparedTrees } from "@pagedeck/core/determinism";

const WORK = join(import.meta.dirname, "..", ".pagedeck-build-twice-check");

// Named apart from `site.build.test.ts`'s directory, so a suite running beside
// this check cannot build into the tree it compares.
const SITE = join(WORK, "site");
const OUT = join(SITE, "dist");

// Beside the site, never inside it, so build 2 reads exactly what build 1 read.
const TREES = join(WORK, "trees");
const FIRST = join(TREES, "first");
const SECOND = join(TREES, "second");
const SUPPORT = join(import.meta.dirname, "site.test-support.ts");

const BIN = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// Imported dynamically after this guard: a static import of `dist` is evaluated
// first and would fail with a resolver stack instead of this message.
if (!existsSync(BIN)) {
  throw new Error(
    `Build-twice determinism: no executable at "${BIN}" — run pnpm build first, which is what emits it; this check spawns the shipped pagedeck rather than calling the build in process`,
  );
}
const { diffOutputTrees, outputDifferenceReport } = await import(
  "@pagedeck/core/determinism"
);

function fileCount(root: string): number {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile(),
  ).length;
}

const ISLAND_CHUNK = /^pricing_page-.+\.js$/;

function hasIslandChunk(tree: string): boolean {
  const assets = join(tree, "assets");
  return (
    existsSync(assets) && readdirSync(assets).some((n) => ISLAND_CHUNK.test(n))
  );
}

function buildStamp(tree: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(tree, "manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const stamp = (parsed as { build?: unknown }).build;
  return stamp === undefined ? undefined : JSON.stringify(stamp);
}

export function buildTwiceFailure(
  trees: ComparedTrees,
  builds: readonly [number, number],
): string | undefined {
  if (builds.includes(process.pid)) {
    return `Build-twice determinism: a build ran in this process (pid ${String(process.pid)}), so the toolchain was evaluated once and the comparison would certify no more than packages/core/src/build.test.ts already does — spawn each pagedeck build as its own process, which is the whole of what this check adds`;
  }
  if (builds[0] === builds[1]) {
    return `Build-twice determinism: one process (pid ${String(builds[0])}) ran both builds, so Rolldown, React and React DOM kept their module-scope values across the pair — spawn a process per build, so the second one evaluates the toolchain again`;
  }

  const empty = [trees.first, trees.second].filter(
    (tree) => fileCount(tree) === 0,
  );
  if (empty.length > 0) {
    return `Build-twice determinism: ${empty
      .map((tree) => `"${tree}"`)
      .join(
        " and ",
      )} emitted no files, so comparing the two trees would prove nothing — check that pagedeck build wrote to the outDir this script compares`;
  }

  const unislanded = [trees.first, trees.second].filter(
    (tree) => !hasIslandChunk(tree),
  );
  if (unislanded.length > 0) {
    return `Build-twice determinism: ${unislanded
      .map((tree) => `"${tree}"`)
      .join(
        " and ",
      )} holds no assets/pricing_page-*.js chunk, so the "use client" path this check is cited for went unbuilt — restore the directive-driven island to the site's entries, or stop citing this check for #178 in build.test.ts and AGENTS.md`;
  }

  const stamps = [buildStamp(trees.first), buildStamp(trees.second)];
  const unstamped = [trees.first, trees.second].filter(
    (_, index) => stamps[index] === undefined,
  );
  if (unstamped.length > 0) {
    return `Build-twice determinism: ${unstamped
      .map((tree) => `"${tree}"`)
      .join(
        " and ",
      )} has no build stamp to excuse, so the one field this comparison drops from the manifest is unproven — emit manifest.json with a build field, or stop excusing it in packages/core/src/determinism.ts`;
  }
  if (stamps[0] === stamps[1]) {
    return `Build-twice determinism: both manifests carry the same build stamp ${String(stamps[0])}, so the field this comparison excuses is not the per-run field it is excused for — mint the stamp per run, as runBuildVerb does, or stop excusing it in packages/core/src/determinism.ts`;
  }

  const differences = diffOutputTrees(trees.first, trees.second);
  return differences.length === 0
    ? undefined
    : outputDifferenceReport(trees, differences);
}

function pagedeck(verb: string): number {
  const result = spawnSync(process.execPath, [BIN, verb], {
    cwd: SITE,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw new Error(
      `Build-twice determinism: pagedeck ${verb} could not be started in "${SITE}" — this check spawns "${BIN}" as its own process and has no in-process fallback, by design; fix what the cause names`,
      { cause: result.error },
    );
  }
  if (result.signal !== null) {
    throw new Error(
      `Build-twice determinism: pagedeck ${verb} was killed by ${result.signal} in "${SITE}" — the build did not fail, it was stopped; two full builds is what this check costs, so on a container this is usually the memory limit`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Build-twice determinism: pagedeck ${verb} failed in "${SITE}" with exit code ${String(result.status)} — see the diagnostic above; this check needs a site that builds before it can compare two builds of it`,
    );
  }
  return result.pid;
}

function main(): number {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(SITE, { recursive: true });
  mkdirSync(TREES, { recursive: true });
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    `import { testSiteConfig } from ${JSON.stringify(SUPPORT)};\nexport default testSiteConfig();\n`,
  );

  // Synced once, so a second store cannot make a difference ambiguous.
  pagedeck("sync");
  const first = pagedeck("build");
  renameSync(OUT, FIRST);
  const second = pagedeck("build");
  renameSync(OUT, SECOND);

  const failure = buildTwiceFailure({ first: FIRST, second: SECOND }, [
    first,
    second,
  ]);
  if (failure === undefined) {
    rmSync(WORK, { recursive: true, force: true });
    process.stdout.write(
      `Build-twice determinism: two pagedeck build processes (pids ${String(first)} and ${String(second)}) emitted identical trees\n`,
    );
    return 0;
  }
  process.stderr.write(`${failure}\n`);
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
