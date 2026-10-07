import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const PACKAGES = join(import.meta.dirname, "..", "..");

interface Manifest {
  name: string;
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

// A lower bound, not an equality: a package added tomorrow is checked, not gated on
// this number.
const MINIMUM_PACKAGES = 10;

function refuseEmptyWalk(packages: { manifest: Manifest }[]): void {
  expect(
    packages.length >= MINIMUM_PACKAGES
      ? ""
      : `Workspace packages: found ${String(packages.length)} of at least ${String(MINIMUM_PACKAGES)} under "${PACKAGES}", so the checks in this file would loop over too little to mean anything — fix whatever stopped locating manifests, or lower MINIMUM_PACKAGES if a package was deliberately removed. Found: ${packages.map(({ manifest }) => manifest.name).join(", ")}`,
  ).toBe("");
}

test("every workspace package is configured to emit JavaScript", () => {
  const packages = workspacePackages();
  refuseEmptyWalk(packages);

  const faults: string[] = [];
  for (const { dir, manifest } of packages) {
    if (!existsSync(join(PACKAGES, dir, "tsconfig.build.json"))) {
      faults.push(
        `Package "${manifest.name}": has no tsconfig.build.json, so pnpm build cannot emit it — copy the one beside any other package, add { "path": "packages/${dir}/tsconfig.build.json" } to the root tsconfig.build.json, and give its "references" the workspace packages this package's emitted source imports, which is narrower than its dependencies: a package the tests alone import must be left out, or tsc -b refuses the reference cycle`,
      );
    }
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (typeof target !== "object" || target === null) {
        faults.push(
          `Package "${manifest.name}": exports subpath "${subpath}" is the bare string ${JSON.stringify(target)}, which points Node at TypeScript source it cannot load — give it "types", "source" and "default" conditions, with "default" at the emitted .js`,
        );
        continue;
      }
      for (const condition of ["types", "source", "default"]) {
        if (typeof (target as Record<string, unknown>)[condition] !== "string") {
          faults.push(
            `Package "${manifest.name}": exports subpath "${subpath}" declares no "${condition}" condition — all three are required, "source" at the TypeScript under src, "types" at the emitted .d.ts and "default" at the emitted .js, in that order: conditions match in declaration order and "types" is always on for tsc, so a "source" listed after it would never be reached`,
          );
        }
      }
    }
  }
  expect(faults).toEqual([]);
});

// `cwd` is the package directory, so the bare specifier resolves by Node's
// self-reference rule.
test("every workspace subpath imports by bare specifier in a plain Node process", async () => {
  const specifiers: { dir: string; specifier: string }[] = [];
  const packages = workspacePackages();
  refuseEmptyWalk(packages);
  for (const { dir, manifest } of packages) {
    for (const subpath of Object.keys(manifest.exports ?? {})) {
      if (subpath.includes("*")) continue;
      specifiers.push({ dir, specifier: manifest.name + subpath.slice(1) });
    }
  }
  expect(specifiers.length).toBeGreaterThanOrEqual(MINIMUM_PACKAGES);

  const failures: string[] = [];
  await Promise.all(
    specifiers.map(async ({ dir, specifier }) => {
      await execFileAsync(
        process.execPath,
        ["-e", `import(${JSON.stringify(specifier)})`],
        { cwd: join(PACKAGES, dir) },
      ).catch((cause: { stderr?: string }) => {
        failures.push(
          `  ${specifier}: ${(cause.stderr ?? String(cause)).split("\n").find((line) => line.includes("Error")) ?? "failed"}`,
        );
      });
    }),
  );
  expect(failures.join("\n")).toBe("");
}, 60_000);
