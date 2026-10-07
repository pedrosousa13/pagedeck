import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(import.meta.dirname, "..", "..", "..");

export interface Manifest {
  readonly path: string;
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
}

export function releaseTagFault(tag: string, manifests: readonly Manifest[]): string | undefined {
  if (!tag.startsWith("v")) {
    return `Release tag "${tag}": does not start with "v", so it names no version and this run publishes nothing. Push a tag "v" followed by the version every public package carries, such as "v${tag}"`;
  }
  const version = tag.slice(1);
  const mismatched = manifests.filter(
    (manifest) => manifest.private !== true && manifest.version !== version,
  );
  if (mismatched.length === 0) return undefined;

  const list = mismatched
    .map(
      ({ path, name, version: carried }) =>
        `  ${name} (${path}) ${carried === undefined ? "declares no version" : `is "${carried}"`}`,
    )
    .join("\n");
  const count =
    mismatched.length === 1
      ? "1 public package does not carry"
      : `${String(mismatched.length)} public packages do not carry`;
  return `Release tag "${tag}": ${count} version "${version}", so this run publishes nothing. Set each one's "version" to "${version}" and tag that commit, or tag the version they carry:\n${list}`;
}

function workspaceManifests(): Manifest[] {
  const packages = join(REPO, "packages");
  return readdirSync(packages)
    .sort()
    .map((dir) => `packages/${dir}/package.json`)
    .filter((path) => existsSync(join(REPO, path)))
    .map((path) => ({
      path,
      ...(JSON.parse(readFileSync(join(REPO, path), "utf8")) as Omit<Manifest, "path">),
    }));
}

function main(): number {
  const tag = process.argv[2] ?? "";
  const fault = releaseTagFault(tag, workspaceManifests());
  if (fault !== undefined) {
    process.stderr.write(`${fault}\n`);
    return 1;
  }
  process.stdout.write(`Release tag "${tag}": every public package carries its version\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
