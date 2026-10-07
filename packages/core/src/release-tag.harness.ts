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
  if (tag === "") {
    return 'Release tag: none was given, so this run publishes nothing. Pass the pushed tag as the first argument, as release.yml does with "$GITHUB_REF_NAME"';
  }
  const published = manifests.filter((manifest) => manifest.private !== true);
  const carried = new Set(published.map((manifest) => manifest.version));
  const shared = carried.size === 1 ? [...carried][0] : undefined;
  const disagreement = `The public packages carry different versions (${versionList(carried)})`;

  if (!tag.startsWith("v")) {
    const fix =
      shared === undefined
        ? `${disagreement}, so set every one's "version" to one version first, then push "v" followed by it`
        : `Push the tag "v${shared}", the version every public package carries`;
    return `Release tag "${tag}": does not start with "v", so it names no version and this run publishes nothing. ${fix}`;
  }

  const version = tag.slice(1);
  const mismatched = published.filter((manifest) => manifest.version !== version);
  if (mismatched.length === 0) return undefined;

  const list = mismatched
    .map(
      ({ path, name, version: own }) =>
        `  ${name} (${path}) ${own === undefined ? "declares no version" : `is "${own}"`}`,
    )
    .join("\n");
  const count =
    mismatched.length === 1
      ? "1 public package does not carry"
      : `${String(mismatched.length)} public packages do not carry`;
  const fix =
    shared === undefined
      ? `${disagreement}, so set every one's "version" to "${version}" and tag that commit`
      : `Set each one's "version" to "${version}" and tag that commit, or push the tag "v${shared}", the version every public package carries`;
  return `Release tag "${tag}": ${count} version "${version}", so this run publishes nothing. ${fix}:\n${list}`;
}

function versionList(carried: ReadonlySet<string | undefined>): string {
  const versions = [...carried]
    .filter((version) => version !== undefined)
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((version) => `"${version}"`);
  if (carried.has(undefined)) versions.push("no version");
  return versions.join(", ");
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
