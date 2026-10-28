import { ConfigError, quoteIdentifier } from "@pagedeck/core";
import { throwCollected } from "./distribution-config.js";
import { applyDistributionConfig } from "./distribution-api.js";
import type { CloudFrontAccess } from "./distribution-api.js";
import type { DistributionFragment } from "./distribution-config.js";
import type { EdgeStaging } from "./deploy.js";

export const DISTRIBUTION_FLAG = "--distribution";
export const ACCESS_KEY_VARIABLE = "PAGEDECK_CLOUDFRONT_ACCESS_KEY_ID";
export const SECRET_KEY_VARIABLE = "PAGEDECK_CLOUDFRONT_SECRET_ACCESS_KEY";
export const SESSION_TOKEN_VARIABLE = "PAGEDECK_CLOUDFRONT_SESSION_TOKEN";
const EDGE = "cloudfront-function";

export interface Distributions {
  /** By tree key; `undefined` is the default tree. */
  ids: ReadonlyMap<string | undefined, string>;
  access: CloudFrontAccess;
  endpoint?: string;
}

// As the plan names a tree: `(default)` for the default tree.
const label = (tree: string | undefined): string => (tree === undefined ? "(default)" : quoteIdentifier(tree));

/** `values` are the `--distribution` arguments in order: `<id>` or `<tree>=<id>`. */
export function readDistributions(
  values: readonly string[],
  env: NodeJS.ProcessEnv,
  edge: string | undefined,
): Distributions {
  const faults: string[] = [];
  const ids = new Map<string | undefined, string>();
  for (const value of values) {
    const split = value.indexOf("=");
    const tree = split === -1 ? undefined : value.slice(0, split);
    const id = split === -1 ? value : value.slice(split + 1);
    if (id === "" || tree === "") {
      faults.push(
        `Option "${DISTRIBUTION_FLAG}" is given ${quoteIdentifier(value)}, which names no ${id === "" ? "distribution" : "tree"} — pass a distribution id for tree (default), or <tree>=<id> for a domain tree.`,
      );
      continue;
    }
    const already = ids.get(tree);
    if (already !== undefined) {
      faults.push(
        `Option "${DISTRIBUTION_FLAG}" names tree ${label(tree)} twice, as ${quoteIdentifier(already)} and as ${quoteIdentifier(id)} — two sources for one value are refused rather than ranked; pass it once.`,
      );
      continue;
    }
    ids.set(tree, id);
  }
  if (edge !== EDGE) {
    faults.push(
      `Option "${DISTRIBUTION_FLAG}" applies the ${EDGE} adapter's distribution-config fragments, and ${edge === undefined ? "no --edge is given" : `--edge is ${quoteIdentifier(edge)}`} — pass --edge ${EDGE}, or drop ${DISTRIBUTION_FLAG}.`,
    );
  }
  const accessKey = env[ACCESS_KEY_VARIABLE]?.trim() ?? "";
  const secretKey = env[SECRET_KEY_VARIABLE]?.trim() ?? "";
  const sessionToken = env[SESSION_TOKEN_VARIABLE]?.trim() ?? "";
  const missing = [
    ...(accessKey === "" ? [ACCESS_KEY_VARIABLE] : []),
    ...(secretKey === "" ? [SECRET_KEY_VARIABLE] : []),
  ];
  if (missing.length > 0) {
    faults.push(
      `Option "${DISTRIBUTION_FLAG}" calls CloudFront's API, and ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set — set both to a credential allowed cloudfront:GetDistributionConfig and cloudfront:UpdateDistribution, and ${SESSION_TOKEN_VARIABLE} beside them for a temporary one.`,
    );
  }
  if (faults.length > 0) throw new ConfigError(faults.join("\n"));
  return {
    ids,
    access: { accessKey, secretKey, ...(sessionToken === "" ? {} : { sessionToken }) },
  };
}

export interface DistributionTarget {
  tree: string | undefined;
  id: string;
  fragments: readonly DistributionFragment[];
}

// Every tree gets edge artifacts (#556), so the staged artifacts name every tree.
export function distributionTargets(
  distributions: Distributions,
  edge: EdgeStaging | undefined,
): DistributionTarget[] {
  const artifacts = edge?.outOfBand ?? [];
  const trees = [...new Set(artifacts.map((one) => one.domain))];
  const withFragments = [
    ...new Set(artifacts.filter((one) => one.role === "distribution-config").map((one) => one.domain)),
  ];
  const faults: string[] = [];
  const targets: DistributionTarget[] = [];
  for (const [tree, id] of distributions.ids) {
    if (!trees.includes(tree)) {
      faults.push(
        `Distribution ${id}: the build has no tree ${label(tree)} — name one of its trees: ${trees.map(label).join(", ")}`,
      );
      continue;
    }
    const fragments = artifacts
      .filter((one) => one.role === "distribution-config" && one.domain === tree)
      .map(({ path, contents }) => ({ path, contents }));
    if (fragments.length === 0) {
      const others = withFragments.filter((one) => one !== tree);
      faults.push(
        `Distribution ${id}: tree ${label(tree)} has no distribution-config fragment to apply, since its routing declares no upstream and no notFound page — drop it from ${DISTRIBUTION_FLAG}, or ${others.length === 0 ? "declare one" : `name a tree that has one: ${others.map(label).join(", ")}`}`,
      );
      continue;
    }
    targets.push({ tree, id, fragments });
  }
  if (faults.length > 0) throw new ConfigError(faults.join("\n"));
  return targets;
}

/** Each distribution in turn; every failure is reported, and any one stops the deploy. */
export async function updateDistributions(
  targets: readonly DistributionTarget[],
  distributions: Distributions,
  apply: boolean,
  write: (line: string) => void,
): Promise<void> {
  const failures: Error[] = [];
  for (const target of targets) {
    try {
      await applyDistributionConfig({
        distributionId: target.id,
        fragments: target.fragments,
        access: distributions.access,
        apply,
        write,
        ...(distributions.endpoint === undefined ? {} : { endpoint: distributions.endpoint }),
      });
    } catch (error) {
      failures.push(error as Error);
    }
  }
  throwCollected(failures);
}
