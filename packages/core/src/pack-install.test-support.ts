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
