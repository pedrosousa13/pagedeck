import { writeFile } from "node:fs/promises";
import { ConfigError, EXIT_CODES, quoteIdentifier } from "@pagedeck/core";
import type { Manifest } from "@pagedeck/core";
import { planDeploy, planRetainedPrune, planRollback, describePlan } from "./deploy.js";
import type {
  DeployPlan,
  DeployPlanInput,
  RetainedPrune,
  RollbackPlanInput,
} from "./deploy.js";
import { applyPlan, filesystemTarget, prunePlan, pruneSuperseded } from "./deploy-target.js";
import type { DeployTarget } from "./deploy-target.js";
import { UNKNOWN_TYPE } from "./deploy-metadata.js";
import {
  DEPLOY_URLS_VARIABLE,
  plannedPuts,
  requestsDocument,
  reservedDeletes,
  signedUrlTarget,
  unsignedDeletes,
  unsignedPuts,
} from "./deploy-urls.js";
import type { DeployUrls } from "./deploy-urls.js";

export const APPLY_FLAG = "--apply";

export const FORCE_FLAG = "--force";

export const PRUNE_FLAG = "--prune";

export interface DeployRun {
  source: string;
  origin: string;
  staging?: string;
  apply?: boolean;
  // Not `prune`: `runDeploy` takes one object that is also a `DeployPlanInput`, whose
  // `prune` is the grace-period policy.
  pruneAfterUpload?: boolean;
  force?: boolean;
  now?: Date;
  target?: DeployTarget;
  history?: readonly string[];
  // Why the prune deletes nothing this run, as a clause: it could not read the history.
  pruneWithheld?: string;
  presigned?: {
    urls: DeployUrls;
    // The keys this run read through a signed GET, listed again in `requests`.
    reads: readonly string[];
    requests?: string;
  };
  // Read before the apply, which is not a race: the apply adds only `live`.
  retention?: {
    live: Manifest;
    wasLive?: Manifest;
    published: readonly Manifest[];
    deployedAt?: ReadonlyMap<string, Date>;
    unreadableDeployInstants?: readonly UnreadableDeployInstant[];
  };
}

export interface UnreadableDeployInstant {
  key: string;
  reason: string;
}

export type Out = (line: string) => void;

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

// Build ids go through `quoteIdentifier`: they are read off the origin (#399).
function describeSuperseded(prune: RetainedPrune): readonly string[] {
  if (prune.due.length === 0 && prune.waiting.length === 0) return [];
  const lines = [
    `  superseded at the origin: ${String(prune.due.length)} due, ${String(prune.waiting.length)} waiting`,
  ];
  for (const one of prune.due) {
    lines.push(
      `    due    ${one.key} (dropped by ${quoteIdentifier(one.droppedBy)}, since ${one.notBefore})`,
    );
  }
  for (const one of prune.waiting) {
    lines.push(
      `    hold   ${one.key} (dropped by ${quoteIdentifier(one.droppedBy)}, until ${one.notBefore})`,
    );
  }
  return lines;
}

function describeUntyped(untyped: readonly string[]): readonly string[] {
  if (untyped.length === 0) return [];
  const headline =
    untyped.length === 1
      ? `sent 1 file as ${UNKNOWN_TYPE}, because the deploy knows no type for its extension, so a browser downloads it rather than showing it — rename the file, or add its extension to the table in packages/site/src/deploy-metadata.ts:`
      : `sent ${String(untyped.length)} files as ${UNKNOWN_TYPE}, because the deploy knows no type for their extensions, so a browser downloads them rather than showing them — rename the files, or add their extensions to the table in packages/site/src/deploy-metadata.ts:`;
  return [`Deploy: ${headline}`, ...untyped.map((key) => `  ${quoteIdentifier(key)}`)];
}

// Warned, not refused: the stamp fallback can hand a key a deadline already past,
// but it is no worse than a build deployed before instants were recorded.
function describeUnreadableInstants(
  unreadable: readonly UnreadableDeployInstant[],
): readonly string[] {
  if (unreadable.length === 0) return [];
  const headline =
    unreadable.length === 1
      ? "1 deploy instant at the origin could not be read, so the keys its build dropped are timed from that build's stamp, which can be earlier than the build was deployed and so shortens their grace — rewrite the file as the ISO-8601 UTC instant the build was deployed, or delete it to accept the stamp:"
      : `${String(unreadable.length)} deploy instants at the origin could not be read, so the keys their builds dropped are timed from each build's stamp, which can be earlier than the build was deployed and so shortens their grace — rewrite each file as the ISO-8601 UTC instant its build was deployed, or delete it to accept the stamp:`;
  return [
    `Deploy history: ${headline}`,
    ...unreadable.map((one) => `  ${quoteIdentifier(one.key)}: ${one.reason}`),
  ];
}

export async function executePlan(
  plan: DeployPlan,
  run: DeployRun,
  out: Out,
): Promise<number> {
  for (const line of describePlan(plan)) out(line);

  // Before the write, and with the plan's own grace period, so the window printed is
  // the window that runs.
  const now = run.now ?? new Date();
  const superseded =
    run.retention === undefined
      ? undefined
      : planRetainedPrune({
          ...run.retention,
          retained: run.retention.published,
          prune: { graceSeconds: plan.prune.graceSeconds },
          now,
        });
  if (superseded !== undefined) for (const line of describeSuperseded(superseded)) out(line);
  for (const line of describeUnreadableInstants(
    run.retention?.unreadableDeployInstants ?? [],
  )) {
    out(line);
  }

  const pruning = run.pruneAfterUpload === true && run.pruneWithheld === undefined;
  const prune = async (target: DeployTarget): Promise<readonly string[]> =>
    superseded === undefined
      ? await prunePlan(plan, { target, now })
      : await pruneSuperseded(superseded, { target });
  // The prune itself against a target that records, so the list cannot drift from it.
  const deletes: string[] = [];
  if (pruning && run.presigned !== undefined) {
    await prune({
      name: "planned deletes",
      async put() {
        throw new Error("Deploy: a prune puts nothing");
      },
      async delete(key) {
        deletes.push(key);
      },
    });
    const reserved = reservedDeletes(deletes, run.retention?.published ?? []);
    if (reserved !== undefined) throw reserved;
  }

  if (run.apply !== true) {
    const requests = run.presigned?.requests;
    if (run.presigned !== undefined && requests !== undefined) {
      const puts = await plannedPuts(plan, run.source);
      await writeFile(requests, requestsDocument(run.presigned.reads, puts, deletes));
      out(
        `Wrote the ${String(run.presigned.reads.length + puts.length + deletes.length)} requests an apply sends to ${quoteIdentifier(requests)}: sign each one, and pass the signed file to the --apply run as ${DEPLOY_URLS_VARIABLE}.`,
      );
    }
    if (run.pruneAfterUpload === true && run.pruneWithheld !== undefined) {
      out(`Prune: deletes nothing — ${run.pruneWithheld}.`);
    }
    out(`DRY RUN: nothing was uploaded. Pass ${APPLY_FLAG} to deploy this plan.`);
    return EXIT_CODES.success;
  }

  if (plan.raced !== undefined && run.force !== true) {
    throw new ConfigError(
      `${plan.raced} — this run refused to upload; pass ${FORCE_FLAG} beside ${APPLY_FLAG} to deploy it anyway`,
    );
  }

  let target: DeployTarget;
  if (run.presigned === undefined) {
    target = run.target ?? filesystemTarget(run.origin);
  } else {
    const unsigned =
      unsignedPuts(run.presigned.urls, await plannedPuts(plan, run.source)) ??
      unsignedDeletes(run.presigned.urls, deletes);
    if (unsigned !== undefined) throw unsigned;
    target = signedUrlTarget(run.presigned.urls);
  }
  const report = await applyPlan(plan, {
    source: run.source,
    target,
    ...(run.staging === undefined ? {} : { staging: run.staging }),
    now,
    ...(run.history === undefined ? {} : { history: run.history }),
  });
  // Less three: the history copy, the deploy instant and the index have their own lines.
  out(`Uploaded ${String(report.uploaded.length - 3)} files to ${target.name}.`);
  out(
    `Filed this build into the origin's deploy history at ${report.retained}, so a later prune can read it back.`,
  );
  out(
    `Recorded when it was deployed at ${report.deployInstant}, so a later prune times what it drops from the deploy rather than the stamp.`,
  );
  out(
    `Named it in the origin's history index at ${report.index}, so a prune finds the history without listing the origin.`,
  );
  for (const line of describeUntyped(report.untyped)) out(line);
  if (report.staged.length > 0) {
    out(
      `Staged ${String(report.staged.length)} out-of-band edge artifacts for CI to apply.`,
    );
    for (const one of plan.edge?.outOfBand ?? []) {
      out(`    staged ${one.staged} (tree ${one.domain ?? "(default)"})`);
    }
  }
  if (run.pruneAfterUpload !== true) {
    const rows = plan.trees.flatMap((tree) => tree.prune);
    const pages = rows.filter((file) => file.kind === "html").length;
    const rest = rows.length - pages;
    const halves = [
      ...(pages === 0 ? [] : [`${count(pages, "page")} on the next ${PRUNE_FLAG} run`]),
      ...(rest === 0 && pages > 0
        ? []
        : [`${count(rest, "file")} no earlier than ${plan.prune.notBefore}`]),
    ];
    out(`Prune ${halves.join(", and ")}.`);
    return EXIT_CODES.success;
  }
  if (run.pruneWithheld !== undefined) {
    out(`Pruned nothing: ${run.pruneWithheld}.`);
    return EXIT_CODES.success;
  }
  const deleted = await prune(target);
  let held: number;
  let deadline: string;
  if (superseded === undefined) {
    const graceOver = now.getTime() >= Date.parse(plan.prune.notBefore);
    held = graceOver
      ? 0
      : plan.trees.flatMap((tree) => tree.prune).filter((file) => file.kind !== "html").length;
    deadline = plan.prune.notBefore;
  } else {
    held = superseded.waiting.length;
    deadline = superseded.waiting.map((one) => one.notBefore).sort()[0] ?? plan.prune.notBefore;
  }
  if (deleted.length === 0) {
    out(
      held === 0
        ? "Pruned nothing: the origin holds nothing superseded."
        : `Pruned nothing: the grace period on ${count(held, "file")} is out no earlier than ${deadline}.`,
    );
    return EXIT_CODES.success;
  }
  out(`Pruned ${count(deleted.length, "file")} from ${target.name}.`);
  for (const key of deleted) out(`    prune  ${key}`);
  if (held > 0) {
    out(
      `Held ${count(held, "file")}: the grace period on ${held === 1 ? "it" : "them"} is out no earlier than ${deadline}.`,
    );
  }
  return EXIT_CODES.success;
}

export async function runDeploy(
  input: DeployPlanInput & DeployRun,
  out: Out,
): Promise<number> {
  return await executePlan(planDeploy(input), input, out);
}

// The history is dropped, not merely not passed: the retained prune assumes the
// newest history build is live, which a restore makes false (#287).
export async function runRollback(
  input: RollbackPlanInput & DeployRun,
  out: Out,
): Promise<number> {
  const { retention: _retention, ...run } = input;
  return await executePlan(planRollback(input), run, out);
}
