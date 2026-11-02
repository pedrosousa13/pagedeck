import semver from "semver";

export interface WhyDependent {
  readonly name: string;
  readonly version: string;
}

/** One entry of `pnpm why <package> --json`: one installed version and its direct dependents. */
export interface WhyEntry {
  readonly name: string;
  readonly version: string;
  readonly dependents?: readonly WhyDependent[];
}

const FIX_SOURCE = '(AGENTS.md, "The published tarball")';

export function rolldownVersionsFault(dir: string, why: readonly WhyEntry[]): string | undefined {
  const brought = new Map<string, Set<string>>();
  for (const { name, version, dependents } of why) {
    if (name !== "rolldown") continue;
    const by = brought.get(version) ?? new Set<string>();
    for (const dependent of dependents ?? []) by.add(`${dependent.name} ${dependent.version}`);
    brought.set(version, by);
  }
  if (brought.size <= 1) return undefined;

  const list = [...brought]
    .sort(([a], [b]) => semver.compare(a, b))
    .map(([version, by]) => `  rolldown ${version}, brought by ${[...by].sort().join(", ")}`)
    .join("\n");
  return `Install "${dir}": holds ${String(brought.size)} rolldown versions, so vite bundles with a different rolldown than the one @pagedeck/core pins — set "rolldown" in packages/core/package.json to a version inside the rolldown range of the newest vite core's "vite" range admits ${FIX_SOURCE}:\n${list}`;
}

export function newestVite(range: string, versions: readonly string[]): string | undefined {
  return semver.maxSatisfying([...versions], range) ?? undefined;
}

export function viteRolldownFault(input: {
  readonly viteRange: string;
  readonly vite: string;
  readonly rolldownRange: string | undefined;
  readonly pin: string;
}): string | undefined {
  const { viteRange, vite, rolldownRange, pin } = input;
  const revisit = `revisit core's rolldown pin against that vite ${FIX_SOURCE}`;
  if (rolldownRange === undefined) {
    return `Package "@pagedeck/core": vite ${vite}, the newest vite its range "${viteRange}" admits, declares no rolldown dependency, so the pin "${pin}" covers no bundler vite runs — ${revisit}`;
  }
  if (semver.validRange(rolldownRange) === null) {
    return `Package "@pagedeck/core": vite ${vite} declares rolldown "${rolldownRange}", which is not a semver range, so the pack harness cannot tell whether the pin "${pin}" is inside it — ${revisit}`;
  }
  if (semver.valid(pin) === null) {
    return `Package "@pagedeck/core": its rolldown pin "${pin}" is not one exact version, so a fresh install may resolve a rolldown the pin was never checked against — set "rolldown" in packages/core/package.json to one version inside "${rolldownRange}", the rolldown range of vite ${vite} ${FIX_SOURCE}`;
  }
  if (semver.satisfies(pin, rolldownRange)) return undefined;
  return `Package "@pagedeck/core": its rolldown pin "${pin}" is outside "${rolldownRange}", the rolldown range of vite ${vite}, the newest vite its range "${viteRange}" admits, so a fresh install holds two rolldowns — move "rolldown" in packages/core/package.json to a version "${rolldownRange}" admits ${FIX_SOURCE}`;
}
