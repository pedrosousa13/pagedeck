import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  DOCS_PACKAGE,
  DOCS_PREPACK,
  packedAsDocs,
  packedBesideDist,
  PUBLIC_PACKAGES,
  PUBLIC_VERSION,
} from "./public-packages.test-support.js";

const execFileAsync = promisify(execFile);

const PACKAGES = join(import.meta.dirname, "..", "..");

interface Manifest {
  name: string;
  private?: boolean;
  version?: string;
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  engines?: { node?: string };
  publishConfig?: { access?: string };
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
}

function workspacePackages(): { dir: string; manifest: Manifest }[] {
  const found: { dir: string; manifest: Manifest }[] = [];
  for (const dir of readdirSync(PACKAGES).sort()) {
    const path = join(PACKAGES, dir, "package.json");
    if (!existsSync(path)) continue;
    found.push({
      dir,
      manifest: JSON.parse(readFileSync(path, "utf8")) as Manifest,
    });
  }
  return found;
}

const MINIMUM_PACKAGES = 10;

// Not the root `pnpm build`, which starts with `rm -rf packages/*/dist`: a pack must not
// delete every other package's output.
const PREPACK = "tsc -b tsconfig.build.json";

const ALWAYS_PACKED =
  /^(package\.json|(README|LICEN[SC]E|CHANGELOG)(\.[^/]+)?)$/i;

const PACK_CONCURRENCY = 4;

async function distFiles(dir: string): Promise<string[]> {
  const root = join(PACKAGES, dir, "dist");
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      posix.join(
        "dist",
        relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
      ),
    );
}

function targetPattern(target: string): RegExp {
  const path = target.replace(/^\.\//, "");
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", "(.*)")}$`);
}

function entryPoints(manifest: Manifest): { where: string; target: string }[] {
  const points: { where: string; target: string }[] = [];
  if (manifest.main !== undefined) {
    points.push({ where: '"main"', target: manifest.main });
  }
  if (manifest.types !== undefined) {
    points.push({ where: '"types"', target: manifest.types });
  }
  for (const [name, target] of Object.entries(manifest.bin ?? {})) {
    points.push({ where: `"bin"."${name}"`, target });
  }
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    if (typeof target !== "object" || target === null) continue;
    for (const condition of ["types", "default"]) {
      const value = (target as Record<string, unknown>)[condition];
      if (typeof value === "string") {
        points.push({
          where: `exports "${subpath}" → "${condition}"`,
          target: value,
        });
      }
    }
  }
  return points;
}

function firstErrorLine(cause: { stdout?: string; stderr?: string }): string {
  const diagnostic = (cause.stdout ?? "")
    .split("\n")
    .find((line) => line.includes("error TS"));
  if (diagnostic !== undefined) return diagnostic.trim();
  return (
    (cause.stderr ?? String(cause))
      .split("\n")
      .find((line) => line.toLowerCase().includes("error"))
      ?.trim() ?? "failed"
  );
}

async function packedEntries(dir: string, into: string): Promise<string[]> {
  // Scripts are deliberately *not* disabled: `prepack` is part of what is under
  // test, and npm runs it here exactly as it would on a publish.
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", into],
    { cwd: join(PACKAGES, dir), maxBuffer: 32 * 1024 * 1024 },
  );
  const [packed] = JSON.parse(stdout) as { filename: string }[];
  const listing = await execFileAsync(
    "tar",
    ["-tzf", join(into, packed.filename)],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return listing.stdout
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .map((line) => line.replace(/^package\//, ""));
}

test("every workspace package packs a tarball its entry points resolve inside", async () => {
  const packages = workspacePackages();
  expect(
    packages.length >= MINIMUM_PACKAGES
      ? ""
      : `Workspace packages: found ${String(packages.length)} of at least ${String(MINIMUM_PACKAGES)} under "${PACKAGES}", so the checks below would loop over too little to mean anything — fix whatever stopped locating manifests, or lower MINIMUM_PACKAGES if a package was deliberately removed. Found: ${packages.map(({ manifest }) => manifest.name).join(", ")}`,
  ).toBe("");

  const into = await mkdtemp(join(tmpdir(), "pagedeck-pack-"));
  const faults: string[] = [];
  try {
    const queue = [...packages];
    await Promise.all(
      Array.from({ length: PACK_CONCURRENCY }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          const { dir, manifest } = next;

          if (manifest.files === undefined) {
            faults.push(
              `Package "${manifest.name}": declares no "files", so npm decides what a tarball carries from its own defaults and the tarball ships this package's src and tests — add "files": ["dist", "!dist/.tsbuildinfo"], which is what every other package here declares`,
            );
          }
          if (manifest.name === DOCS_PACKAGE) {
            if (manifest.scripts?.prepack !== DOCS_PREPACK) {
              faults.push(
                `Package "${manifest.name}": its "prepack" script is ${JSON.stringify(manifest.scripts?.prepack)} rather than ${JSON.stringify(DOCS_PREPACK)}, so its tarball would lack the pages of docs/ it publishes (the ADRs, deploy-recipe.md and error-messages.md), which only that script copies in — set "prepack" to ${JSON.stringify(DOCS_PREPACK)}`,
              );
            }
          } else if (manifest.scripts?.prepack !== PREPACK) {
            faults.push(
              `Package "${manifest.name}": its "prepack" script is ${JSON.stringify(manifest.scripts?.prepack)} rather than ${JSON.stringify(PREPACK)}, so a tarball could be cut from a stale or absent dist — every package in this workspace declares that one command, and it must not be the root "pnpm build", which deletes every package's dist before it starts`,
            );
          }

          const entries = await packedEntries(dir, into).catch(
            (cause: { stdout?: string; stderr?: string }) => {
              faults.push(
                `Package "${manifest.name}": npm pack failed, so this package cannot be published at all — its prepack build is the usual cause: ${firstErrorLine(cause)} — run "npm pack" in packages/${dir} to see the rest`,
              );
              return undefined;
            },
          );
          if (entries === undefined) continue;

          const stowaways = entries.filter(
            (entry) =>
              !ALWAYS_PACKED.test(entry) &&
              !packedBesideDist(manifest).has(entry) &&
              !packedAsDocs(manifest, entry) &&
              (!entry.startsWith("dist/") || entry === "dist/.tsbuildinfo"),
          );
          if (stowaways.length > 0) {
            faults.push(
              `Package "${manifest.name}": its tarball carries ${String(stowaways.length)} file(s) that are not emitted output — ${stowaways.slice(0, 5).join(", ")}${stowaways.length > 5 ? ", …" : ""} — so a consumer downloads this package's source, tests or build cache; a published package carries dist and package.json and nothing else, which is what "files": ["dist", "!dist/.tsbuildinfo"] declares, and create-pagedeck alone adds its template there file by file, as "template/<path>"`,
            );
          }

          const onDisk = await distFiles(dir);
          for (const { where, target } of entryPoints(manifest)) {
            const pattern = targetPattern(target);
            const inTarball = entries.filter((entry) => pattern.test(entry));
            if (inTarball.length === 0) {
              faults.push(
                `Package "${manifest.name}": ${where} points at "${target}", which no file in its tarball matches — a consumer would resolve this entry point to a path the package does not contain; point it at the emitted dist and make sure "files" covers it. The tarball holds: ${entries.join(", ")}`,
              );
              continue;
            }
            const missing = onDisk
              .filter((file) => pattern.test(file))
              .filter((file) => !inTarball.includes(file));
            if (missing.length > 0) {
              faults.push(
                `Package "${manifest.name}": ${where} points at "${target}", and ${String(missing.length)} emitted file(s) it matches are missing from the tarball — ${missing.join(", ")} — so that subpath resolves for some names and not others; widen "files" until every file the wildcard reaches is packed`,
              );
            }
          }
        }
      }),
    );
  } finally {
    await rm(into, { recursive: true, force: true });
  }
  expect(faults).toEqual([]);
}, 120_000);

const REPOSITORY_URL = "git+https://github.com/pedrosousa13/pagedeck.git";

test("the public set declares what a registry needs, and every other package stays private", () => {
  const packages = workspacePackages();
  const publicDirs: readonly string[] = PUBLIC_PACKAGES;
  const faults: string[] = [];
  if (!existsSync(join(PACKAGES, "..", "LICENSE"))) {
    faults.push(
      "Repository: has no LICENSE at its root — add the MIT licence text the public packages carry",
    );
  }
  for (const dir of publicDirs) {
    if (!packages.some((found) => found.dir === dir)) {
      faults.push(
        `Package directory "packages/${dir}": is in PUBLIC_PACKAGES but holds no package.json — remove it from public-packages.test-support.ts, or restore the package`,
      );
    }
  }
  for (const { dir, manifest } of packages) {
    const where = `Package "${manifest.name}"`;
    if (!publicDirs.includes(dir)) {
      if (manifest.private !== true) {
        faults.push(
          `${where}: is not in the public set but does not declare "private": true, so a publish would ship it — declare it private, or add "${dir}" to PUBLIC_PACKAGES with the fields every public package declares`,
        );
      }
      continue;
    }
    if (manifest.private !== undefined) {
      faults.push(`${where}: is in the public set but declares "private" — remove the field`);
    }
    if (manifest.version !== PUBLIC_VERSION) {
      faults.push(
        `${where}: version is ${JSON.stringify(manifest.version)} — set it to "${PUBLIC_VERSION}", the version every public package shares`,
      );
    }
    if (manifest.license !== "MIT") {
      faults.push(`${where}: license is ${JSON.stringify(manifest.license)} — set "license": "MIT"`);
    }
    const repository = manifest.repository;
    if (
      repository?.type !== "git" ||
      repository.url !== REPOSITORY_URL ||
      repository.directory !== `packages/${dir}`
    ) {
      faults.push(
        `${where}: repository is ${JSON.stringify(repository)} — set { "type": "git", "url": "${REPOSITORY_URL}", "directory": "packages/${dir}" }`,
      );
    }
    if (typeof manifest.engines?.node !== "string") {
      faults.push(
        `${where}: declares no engines.node — set the lowest Node version its code and dependencies need`,
      );
    }
    if (manifest.publishConfig?.access !== "public") {
      faults.push(
        `${where}: publishConfig.access is ${JSON.stringify(manifest.publishConfig?.access)} — set "public", or a scoped package publishes as restricted`,
      );
    }
    if (!existsSync(join(PACKAGES, dir, "LICENSE"))) {
      faults.push(`${where}: has no LICENSE file — copy the repository root's LICENSE into packages/${dir}`);
    }
  }
  expect(faults).toEqual([]);
});
