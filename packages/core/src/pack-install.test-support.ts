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
    .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
    .map(([version, by]) => `  rolldown ${version}, brought by ${[...by].sort().join(", ")}`)
    .join("\n");
  return `Install "${dir}": holds ${String(brought.size)} rolldown versions, so the rolldown @pagedeck/core pins is not the one vite bundles with — move "rolldown" in packages/core/package.json to a version inside the rolldown range of the vite core's range resolves to (AGENTS.md, "The published tarball"):\n${list}`;
}

type Version = readonly [number, number, number];

function parseVersion(text: string): Version | undefined {
  const found = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return found === null ? undefined : [Number(found[1]), Number(found[2]), Number(found[3])];
}

function compare(left: Version, right: Version): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

// The forms vite writes its dependencies in: `x.y.z`, `~x.y.z`, `^x.y.z` and `>=x.y.z`, joined by `||`.
function rangeAdmits(range: string, version: Version): boolean | undefined {
  const verdicts = range.split("||").map((alternative) => {
    const found = /^\s*(~|\^|>=)?(\d+\.\d+\.\d+)\s*$/.exec(alternative);
    if (found === null) return undefined;
    const floor = parseVersion(found[2] as string) as Version;
    if (compare(version, floor) < 0) return false;
    switch (found[1]) {
      case undefined:
        return compare(version, floor) === 0;
      case "~":
        return version[0] === floor[0] && version[1] === floor[1];
      case "^":
        return floor[0] === 0
          ? version[0] === 0 && version[1] === floor[1]
          : version[0] === floor[0];
      default:
        return true;
    }
  });
  if (verdicts.includes(undefined)) return undefined;
  return verdicts.includes(true);
}

export function viteRolldownFault(input: {
  readonly viteRange: string;
  readonly vite: string;
  readonly rolldownRange: string;
  readonly pin: string;
}): string | undefined {
  const { viteRange, vite, rolldownRange, pin } = input;
  const pinned = parseVersion(pin);
  if (pinned === undefined) {
    return `Package "@pagedeck/core": its rolldown pin "${pin}" is not an exact version, so a fresh install may resolve a rolldown the pin was not checked against — pin "rolldown" in packages/core/package.json to one version (AGENTS.md, "The published tarball")`;
  }
  const admitted = rangeAdmits(rolldownRange, pinned);
  if (admitted === undefined) {
    return `Package "@pagedeck/core": vite ${vite} declares rolldown "${rolldownRange}", a range the pack harness cannot read, so it cannot tell whether the pin "${pin}" is inside it — teach rangeAdmits in packages/core/src/pack-install.test-support.ts the form`;
  }
  if (admitted) return undefined;
  return `Package "@pagedeck/core": its rolldown pin "${pin}" is outside "${rolldownRange}", the rolldown range of vite ${vite}, the newest vite its range "${viteRange}" admits, so a fresh install holds two rolldowns — move "rolldown" in packages/core/package.json to a version "${rolldownRange}" admits (AGENTS.md, "The published tarball")`;
}
