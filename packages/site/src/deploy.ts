import { DEFAULT_PRUNE_POLICY, diffManifests, fileKey, racedDeployReport } from "@pagedeck/core";
import type {
  BuildStamp,
  DiffStats,
  DiffTree,
  Manifest,
  ManifestFile,
  PrunePolicy,
  PruneWindow,
} from "@pagedeck/core";
import type { EdgeArtifact, EdgeOutput } from "@pagedeck/edge";

export interface StagedArtifact extends EdgeArtifact {
  /** Relative to `--staging`: a domain tree's under its tree key (#669). */
  staged: string;
}

export interface EdgeStaging {
  target: EdgeOutput["target"];
  treeFiles: readonly EdgeArtifact[];
  outOfBand: readonly StagedArtifact[];
}

export interface DeployPlan {
  from?: BuildStamp;
  to: BuildStamp;
  trees: readonly DiffTree[];
  prune: PruneWindow;
  stats: DiffStats;
  raced?: string;
  edge?: EdgeStaging;
}

export interface DeployPlanInput {
  from?: Manifest;
  to: Manifest;
  prune?: PrunePolicy;
  edge?: EdgeOutput;
}

export interface RollbackPlanInput {
  current: Manifest;
  retained: Manifest;
  prune?: PrunePolicy;
  edge?: EdgeOutput;
}

function nothingDeployed(to: Manifest): Manifest {
  return { ...to, build: { id: "", createdAt: to.build.createdAt }, files: [] };
}

function stageEdge(edge: EdgeOutput): EdgeStaging {
  return {
    target: edge.target,
    treeFiles: edge.artifacts.filter((one) => one.role === "tree-file"),
    outOfBand: edge.artifacts
      .filter((one) => one.role !== "tree-file")
      .map((one) => ({
        ...one,
        staged: one.domain === undefined ? one.path : `${one.domain}/${one.path}`,
      })),
  };
}

// Edge tree files stay out of `trees.upload`, so the plan's rows match `pagedeck diff`'s.
export function planDeploy(input: DeployPlanInput): DeployPlan {
  const diff = diffManifests({
    from: input.from ?? nothingDeployed(input.to),
    to: input.to,
    ...(input.prune === undefined ? {} : { prune: input.prune }),
  });
  // No race on a first deploy: its synthesised `from` has an empty id.
  const raced = input.from === undefined ? undefined : racedDeployReport(diff);
  return {
    ...(input.from === undefined ? {} : { from: diff.from }),
    to: diff.to,
    trees: diff.trees,
    prune: diff.prune,
    stats: diff.stats,
    ...(raced === undefined ? {} : { raced }),
    ...(input.edge === undefined ? {} : { edge: stageEdge(input.edge) }),
  };
}

// `{ from: current, to: retained }`: swapped, this deletes the site it was asked to
// restore.
export function planRollback(input: RollbackPlanInput): DeployPlan {
  const { raced: _raced, ...plan } = planDeploy({
    from: input.current,
    to: input.retained,
    ...(input.prune === undefined ? {} : { prune: input.prune }),
    ...(input.edge === undefined ? {} : { edge: input.edge }),
  });
  // A rollback is out of order by definition, so its race report is dropped.
  return plan;
}

export interface SupersededFile {
  key: string;
  droppedBy: string;
  notBefore: string;
}

export interface RetainedPrune {
  due: readonly SupersededFile[];
  waiting: readonly SupersededFile[];
}

export interface RetainedPruneInput {
  live: Manifest;
  // The one served-order fact the history carries: a rollback re-serves an old stamp,
  // so ordering by `createdAt` alone would delete live files (#287).
  wasLive?: Manifest;
  // Only builds the origin served: a runner's local builds would be blamed for drops
  // they never made, and a live chunk deleted with no grace (#287).
  retained: readonly Manifest[];
  deployedAt?: ReadonlyMap<string, Date>;
  prune?: PrunePolicy;
  now: Date;
}

// Compared as strings, not `Date.parse`: ISO stamps sort chronologically, and an
// unparseable `createdAt` still sorts somewhere instead of as `NaN`.
function newestFirst(a: Manifest, b: Manifest): number {
  if (a.build.createdAt !== b.build.createdAt) {
    return a.build.createdAt < b.build.createdAt ? 1 : -1;
  }
  if (a.build.id === b.build.id) return 0;
  return a.build.id < b.build.id ? 1 : -1;
}

// `undefined` for an unreadable instant: a build that cannot say when it went up
// cannot authorize a deletion.
function deadlineOf(from: number, graceSeconds: number): string | undefined {
  if (!Number.isFinite(from)) return undefined;
  const deadline = from + graceSeconds * 1000;
  if (!Number.isFinite(deadline)) return undefined;
  return new Date(deadline).toISOString();
}

// The live build's keys are excluded outright, whatever the stamps say: a document
// stamped ahead of it would otherwise delete the live site. Design: docs/deploy-recipe.md.
export function planRetainedPrune(input: RetainedPruneInput): RetainedPrune {
  const { graceSeconds } = input.prune ?? DEFAULT_PRUNE_POLICY;
  const byId = new Map<string, Manifest>();
  const stated = [input.live, ...(input.wasLive === undefined ? [] : [input.wasLive])];
  for (const manifest of [...stated, ...input.retained]) {
    if (!byId.has(manifest.build.id)) byId.set(manifest.build.id, manifest);
  }
  const history = [...byId.values()].sort(newestFirst);
  const keysOf = (manifest: Manifest): string[] =>
    manifest.files.map((file) => fileKey(file.domain, file.path));
  // A page gets no grace (#555): the window is for a chunk a minute-old page still
  // asks for.
  const graceOf = (file: ManifestFile): number =>
    file.kind === "html" ? 0 : graceSeconds;
  // Timed from `now`: this apply writes its instant, so anything on record is older.
  const replacing =
    input.wasLive !== undefined && input.wasLive.build.id !== input.live.build.id;
  const deployedAt = (manifest: Manifest): number => {
    if (replacing && manifest.build.id === input.live.build.id) return input.now.getTime();
    const recorded = input.deployedAt?.get(manifest.build.id)?.getTime();
    return recorded !== undefined && Number.isFinite(recorded)
      ? recorded
      : Date.parse(manifest.build.createdAt);
  };

  const live = new Set(keysOf(input.live));
  const newer = new Set<string>();
  const superseded: SupersededFile[] = [];
  for (const [index, build] of history.entries()) {
    // The build the origin served until now is blamed on `live` and timed from `now`,
    // whatever its stamp says (#287).
    const previous = history[index - 1];
    const dropped =
      input.wasLive !== undefined && build.build.id === input.wasLive.build.id
        ? { id: input.live.build.id, at: input.now.getTime() }
        : previous === undefined
          ? undefined
          : { id: previous.build.id, at: deployedAt(previous) };
    for (const file of build.files) {
      const key = fileKey(file.domain, file.path);
      if (newer.has(key) || live.has(key)) continue;
      newer.add(key);
      if (dropped === undefined || dropped.id === build.build.id) continue;
      const notBefore = deadlineOf(dropped.at, graceOf(file));
      if (notBefore === undefined) continue;
      superseded.push({ key, droppedBy: dropped.id, notBefore });
    }
  }
  superseded.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const at = input.now.getTime();
  return {
    due: superseded.filter((one) => at >= Date.parse(one.notBefore)),
    waiting: superseded.filter((one) => at < Date.parse(one.notBefore)),
  };
}

function edgeBytes(staging: EdgeStaging | undefined): number {
  return (staging?.treeFiles ?? []).reduce(
    (total, one) => total + Buffer.byteLength(one.contents),
    0,
  );
}

export function describePlan(plan: DeployPlan): readonly string[] {
  const lines: string[] = [];
  const uploads = plan.trees.reduce((n, tree) => n + tree.upload.length, 0);
  const prunes = plan.trees.reduce((n, tree) => n + tree.prune.length, 0);
  const edge = plan.edge;
  lines.push(
    `Deploy ${plan.from === undefined ? "(first deploy)" : plan.from.id} -> ${plan.to.id}`,
  );
  lines.push(
    `  ${String(uploads + (edge?.treeFiles.length ?? 0))} to upload (${String(plan.stats.added)} added, ${String(plan.stats.changed)} changed, ${String(plan.stats.unchanged)} unchanged), ${String(plan.stats.uploadBytes + edgeBytes(edge))} bytes`,
  );
  lines.push(
    `  ${String(prunes)} to prune, ${String(plan.stats.prunedBytes)} bytes, not before ${plan.prune.notBefore}`,
  );
  for (const tree of plan.trees) {
    lines.push(`  tree ${tree.domain ?? "(default)"}`);
    for (const file of tree.upload) {
      lines.push(`    upload ${file.key} (${file.change}, ${String(file.size)} bytes)`);
    }
    for (const file of tree.prune) lines.push(`    prune  ${file.key}`);
  }
  if (plan.raced !== undefined) lines.push(`  RACED: ${plan.raced}`);
  if (edge !== undefined) {
    lines.push(`  edge artifacts, compiled for ${edge.target}`);
    for (const one of edge.treeFiles) lines.push(`    upload ${one.path} (${one.role})`);
    for (const one of edge.outOfBand) {
      const tree = one.domain === undefined ? "" : `, tree ${one.domain}`;
      lines.push(`    stage  ${one.staged} (${one.role}${tree}) — applied out of band by CI`);
    }
  }
  return lines;
}
