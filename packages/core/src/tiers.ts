import { ConfigError } from "./exit.js";
import type { PageEntry } from "./entries.js";
import type { ComponentRanking } from "@pagedeck/content";

export type Tier = "core" | "mid" | "tail";

export const CORE_GROUP = "fw-core";
export const MID_GROUP = "fw-mid";

const CORE_PRIORITY = 30;
const MID_PRIORITY = 20;

const ISLANDS_RUNTIME = "@pagedeck/islands/runtime";

export interface TierPolicy {
  coreMinShare: number;
  coreMinUsageShare: number;
  midMinPages: number;
  /**
   * An array: the policy is recorded on the manifest, where a `Set` is `{}`.
   */
  exclude: readonly string[];
  minSize: number;
  minShareCount: number;
}

export const DEFAULT_TIER_POLICY: TierPolicy = {
  coreMinShare: 0.6,
  coreMinUsageShare: 0.25,
  midMinPages: 2,
  exclude: [],
  minSize: 20_000,
  minShareCount: 1,
};

export interface TierPlanInput {
  entries: readonly PageEntry[];
  ranking: readonly ComponentRanking[];
  policy?: Partial<TierPolicy>;
  alwaysCore?: readonly string[];
}

export interface TierAssignment {
  component: string;
  module: string;
  tier: Tier;
  group?: string;
  pageCount: number;
  pageShare: number;
  totalUsages: number;
  usageShare: number;
  avgFoldScore: number;
}

export interface TierGroup {
  name: string;
  priority: number;
  entriesAware: boolean;
  entriesAwareMergeThreshold?: number;
  minSize: number;
  minShareCount: number;
  modules: readonly string[];
}

export interface TierPlan {
  policy: TierPolicy;
  pageCount: number;
  shippedUsages: number;
  groups: readonly TierGroup[];
  assignments: readonly TierAssignment[];
}

const POLICY_FIX = {
  one: "correct it, or drop it to take the default",
  many: "correct each, or drop it to take the default",
} as const;

const GROUP_NAME_COLLISION_FIX =
  "report it upstream with the names below: the framework mints both entry names and tier group names, so no site setting can separate them";

const MISSING_ID_FIX = {
  one: "map the specifier to the id the bundler resolves it to, or drop the component from the pages that use it",
  many: "map each specifier to the id the bundler resolves it to, or drop the component from the pages that use it",
} as const;

interface PolicyFault {
  setting: string;
  value: number;
  requirement: string;
}

function policyFaults(policy: TierPolicy): PolicyFault[] {
  const faults: PolicyFault[] = [];
  if (!(policy.coreMinShare > 0 && policy.coreMinShare <= 1)) {
    faults.push({
      setting: "coreMinShare",
      value: policy.coreMinShare,
      requirement: "must be greater than 0 and at most 1",
    });
  }
  if (!(policy.coreMinUsageShare > 0 && policy.coreMinUsageShare <= 1)) {
    faults.push({
      setting: "coreMinUsageShare",
      value: policy.coreMinUsageShare,
      requirement: "must be greater than 0 and at most 1",
    });
  }
  if (!Number.isInteger(policy.midMinPages) || policy.midMinPages < 1) {
    faults.push({
      setting: "midMinPages",
      value: policy.midMinPages,
      requirement: "must be a whole number of pages, at least 1",
    });
  }
  if (!Number.isInteger(policy.minSize) || policy.minSize < 0) {
    faults.push({
      setting: "minSize",
      value: policy.minSize,
      requirement: "must be a whole number of bytes, at least 0",
    });
  }
  if (!Number.isInteger(policy.minShareCount) || policy.minShareCount < 1) {
    faults.push({
      setting: "minShareCount",
      value: policy.minShareCount,
      requirement: "must be a whole number of entry chunks, at least 1",
    });
  }
  return faults;
}

function policyReport(faults: readonly PolicyFault[]): string {
  const count = faults.length;
  const headline =
    count === 1
      ? `1 policy setting is out of range — ${POLICY_FIX.one}`
      : `${String(count)} policy settings are out of range — ${POLICY_FIX.many}`;
  const detail = faults
    .map((one) => `  ${one.setting} ${String(one.value)} — ${one.requirement}`)
    .join("\n");
  return `Chunk tiers: ${headline}:\n${detail}`;
}

interface GroupNameCollision {
  name: string;
  claimants: { locale: string; path: string }[];
}

function groupNameCollisionReport(
  collisions: readonly GroupNameCollision[],
): string {
  const count = collisions.length;
  const subject =
    count === 1
      ? "1 chunk group name is also an entry name"
      : `${String(count)} chunk group names are also entry names`;
  const detail = collisions
    .map(
      (one) =>
        `  "${one.name}" — ${one.claimants
          .map((page) => `${page.locale} ${page.path}`)
          .join(", ")}`,
    )
    .join("\n");
  return `Chunk tiers: ${subject} — ${GROUP_NAME_COLLISION_FIX}:\n${detail}`;
}

interface MissingId {
  module: string;
  group: string;
}

function missingIdReport(missing: readonly MissingId[]): string {
  const count = missing.length;
  const headline =
    count === 1
      ? `1 grouped module has no bundler id — ${MISSING_ID_FIX.one}`
      : `${String(count)} grouped modules have no bundler id — ${MISSING_ID_FIX.many}`;
  const detail = missing
    .map((one) => `  "${one.module}" — grouped into "${one.group}"`)
    .join("\n");
  return `Chunk tiers: ${headline}:\n${detail}`;
}

interface Demand {
  module: string;
  pageCount: number;
  usages: number;
  eager: boolean;
}

export function planTiers(input: TierPlanInput): TierPlan {
  const policy: TierPolicy = {
    ...DEFAULT_TIER_POLICY,
    ...input.policy,
    exclude: [...(input.policy?.exclude ?? DEFAULT_TIER_POLICY.exclude)].sort(),
  };
  const faults = policyFaults(policy);
  if (faults.length > 0) throw new ConfigError(policyReport(faults));

  const excluded = new Set(policy.exclude);
  const pageCount = input.entries.length;

  // Per specifier, not per registry name: two names on one module must not put
  // it in both groups, which Rolldown resolves silently in favour of core.
  const demand = new Map<string, Demand>();
  const components = new Map<string, Demand>();
  const pinned = new Set<string>([
    ISLANDS_RUNTIME,
    ...(input.alwaysCore ?? []),
  ]);
  for (const entry of input.entries) {
    if (entry.providers !== undefined) pinned.add(entry.providers);
    const reached = new Set<string>();
    for (const component of entry.components) {
      if (excluded.has(component.name)) continue;
      let seen = demand.get(component.module);
      if (seen === undefined) {
        seen = {
          module: component.module,
          pageCount: 0,
          usages: 0,
          eager: false,
        };
        demand.set(component.module, seen);
      }
      seen.eager ||= component.eager;
      components.set(component.name, seen);
      if (reached.has(component.module)) continue;
      reached.add(component.module);
      seen.pageCount += 1;
    }
  }

  const ranks = new Map(input.ranking.map((one) => [one.component, one]));
  let shippedUsages = 0;
  for (const [component, seen] of components) {
    const usages = ranks.get(component)?.totalUsages ?? 0;
    seen.usages += usages;
    shippedUsages += usages;
  }

  const assignments: TierAssignment[] = [];
  const coreModules = new Set(pinned);
  const midModules = new Set<string>();
  for (const [
    component,
    { module, pageCount: pages, usages, eager },
  ] of components) {
    const pageShare = pages / pageCount;
    // `0` promotes nothing only because the policy check forbids a threshold
    // of 0.
    const usageShare = shippedUsages === 0 ? 0 : usages / shippedUsages;
    const onPages: Tier =
      pageShare >= policy.coreMinShare
        ? "core"
        : pages >= policy.midMinPages
          ? "mid"
          : "tail";
    // Grouping a component no page hydrates on load would put its bytes on
    // every load page's critical path (#105).
    const tier: Tier = !eager
      ? "tail"
      : onPages === "mid" && usageShare >= policy.coreMinUsageShare
        ? "core"
        : onPages;
    if (tier === "core") coreModules.add(module);
    if (tier === "mid") midModules.add(module);
    const rank = ranks.get(component);
    assignments.push({
      component,
      module,
      tier,
      ...(tier === "tail"
        ? {}
        : { group: tier === "core" ? CORE_GROUP : MID_GROUP }),
      pageCount: pages,
      pageShare,
      totalUsages: rank?.totalUsages ?? 0,
      usageShare,
      avgFoldScore: rank?.avgFoldScore ?? 0,
    });
  }
  assignments.sort((a, b) => (a.component < b.component ? -1 : 1));

  const groups: TierGroup[] = [];
  if (coreModules.size > 0) {
    groups.push({
      name: CORE_GROUP,
      priority: CORE_PRIORITY,
      // Not entries-aware: core is one chunk every page shares.
      entriesAware: false,
      minSize: policy.minSize,
      minShareCount: policy.minShareCount,
      modules: [...coreModules].sort(),
    });
  }
  if (midModules.size > 0) {
    groups.push({
      name: MID_GROUP,
      priority: MID_PRIORITY,
      entriesAware: true,
      entriesAwareMergeThreshold: policy.minSize,
      minSize: policy.minSize,
      minShareCount: policy.minShareCount,
      modules: [...midModules].sort(),
    });
  }

  const collisions = groupNameCollisions(groups, input.entries);
  if (collisions.length > 0) {
    throw new ConfigError(groupNameCollisionReport(collisions));
  }

  return { policy, pageCount, shippedUsages, groups, assignments };
}

function groupNameCollisions(
  groups: readonly TierGroup[],
  entries: readonly PageEntry[],
): GroupNameCollision[] {
  const names = new Set(groups.map((group) => group.name));
  const collisions = new Map<string, GroupNameCollision>();
  for (const entry of entries) {
    if (!names.has(entry.name)) continue;
    const seen = collisions.get(entry.name);
    if (seen === undefined) {
      collisions.set(entry.name, {
        name: entry.name,
        claimants: [{ locale: entry.locale, path: entry.path }],
      });
    } else {
      seen.claimants.push({ locale: entry.locale, path: entry.path });
    }
  }
  return [...collisions.values()].sort(
    (a, b) =>
      groups.findIndex((group) => group.name === a.name) -
      groups.findIndex((group) => group.name === b.name),
  );
}

export type ModuleIds = Readonly<Record<string, string>>;

export interface CodeSplittingConfig {
  minSize: number;
  minShareCount: number;
  /** Mutable: a `readonly` array will not assign to Rolldown's `groups`. */
  groups: {
    name: string;
    priority: number;
    entriesAware?: boolean;
    entriesAwareMergeThreshold?: number;
    minSize?: number;
    minShareCount?: number;
    test: (id: string) => boolean;
  }[];
}

export function codeSplitting(
  plan: TierPlan,
  moduleIds: ModuleIds | (() => ModuleIds),
): CodeSplittingConfig {
  if (typeof moduleIds !== "function") assertModuleIds(plan, moduleIds);

  const groups = plan.groups.map((group) => {
    let ids: Set<string> | undefined;
    const members = (): Set<string> => {
      ids ??= groupIds(
        group,
        typeof moduleIds === "function" ? moduleIds() : moduleIds,
      );
      return ids;
    };
    return {
      name: group.name,
      priority: group.priority,
      entriesAware: group.entriesAware,
      ...(group.entriesAwareMergeThreshold === undefined
        ? {}
        : { entriesAwareMergeThreshold: group.entriesAwareMergeThreshold }),
      minSize: group.minSize,
      minShareCount: group.minShareCount,
      test: (id: string) => {
        const query = id.indexOf("?");
        return members().has(query === -1 ? id : id.slice(0, query));
      },
    };
  });

  return {
    minSize: plan.policy.minSize,
    minShareCount: plan.policy.minShareCount,
    groups,
  };
}

function groupIds(group: TierGroup, moduleIds: ModuleIds): Set<string> {
  const ids = new Set<string>();
  for (const module of group.modules) {
    if (!Object.hasOwn(moduleIds, module)) continue;
    ids.add(moduleIds[module]);
  }
  return ids;
}

export function assertModuleIds(plan: TierPlan, moduleIds: ModuleIds): void {
  const missing: MissingId[] = [];
  for (const group of plan.groups) {
    for (const module of group.modules) {
      if (!Object.hasOwn(moduleIds, module)) {
        missing.push({ module, group: group.name });
      }
    }
  }
  if (missing.length > 0) throw new ConfigError(missingIdReport(missing));
}
