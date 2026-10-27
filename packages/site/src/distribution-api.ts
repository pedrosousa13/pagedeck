// This holds the credential: no message here quotes a header, a key or AWS's own error text.
import { ConfigError } from "@pagedeck/core";
import { planDistribution } from "./distribution-config.js";
import type { DistributionFragment } from "./distribution-config.js";
import { signHeaders } from "./sigv4.js";

/** https://docs.aws.amazon.com/general/latest/gr/cf_region.html : one global endpoint, signed for us-east-1. */
export const CLOUDFRONT_ENDPOINT = "https://cloudfront.amazonaws.com";
const REGION = "us-east-1";
const SERVICE = "cloudfront";

export interface CloudFrontAccess {
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
}

const FIXES: Readonly<Record<string, string>> = {
  AccessDenied: "give the credential cloudfront:GetDistributionConfig and cloudfront:UpdateDistribution on this distribution",
  NoSuchDistribution: "check the distribution id",
  PreconditionFailed: "the config changed after this deploy read it",
  InvalidIfMatchVersion: "the ETag this deploy sent was refused; run the deploy again, which reads it afresh",
  TooManyCacheBehaviors: "the distribution is at its cache-behavior quota; raise it, or set cloudfront({ limits: { cacheBehaviors } }) to the quota so the build refuses first",
  TooManyOrigins: "the distribution is at its origin quota; raise it, or route fewer prefixes",
};

function errorCode(body: string): string {
  const code = /<Code>([A-Za-z.]+)<\/Code>/.exec(body)?.[1];
  return code ?? "with no error code";
}

async function call(
  endpoint: string,
  access: CloudFrontAccess,
  distributionId: string,
  action: "GetDistributionConfig" | "UpdateDistribution",
  init: { method: "GET" | "PUT"; body?: string; headers?: Record<string, string> },
): Promise<Response> {
  const url = `${endpoint}/2020-05-31/distribution/${encodeURIComponent(distributionId)}/config`;
  const body = init.body ?? "";
  const headers = signHeaders({
    method: init.method,
    url,
    region: REGION,
    service: SERVICE,
    ...access,
    body,
    ...(init.headers === undefined ? {} : { headers: init.headers }),
  });
  try {
    return await fetch(url, { method: init.method, headers, ...(init.body === undefined ? {} : { body }) });
  } catch (cause) {
    throw new Error(
      `Distribution ${distributionId}: ${action} could not reach ${endpoint} — check the runner's network`,
      { cause },
    );
  }
}

async function refusal(
  response: Response,
  distributionId: string,
  action: string,
  etag?: string,
): Promise<ConfigError> {
  const code = errorCode(await response.text());
  let fix = FIXES[code] ?? "see https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_UpdateDistribution.html#API_UpdateDistribution_Errors";
  if (code === "PreconditionFailed" && etag !== undefined) {
    fix = `${fix} at ETag ${etag}; run the deploy again, which reads it afresh`;
  }
  return new ConfigError(
    `Distribution ${distributionId}: ${action} answered ${String(response.status)} ${code} — ${fix}`,
  );
}

/**
 * Reads the distribution's config and ETag, merges the fragments, and with `apply` sends the
 * whole config back under `If-Match`
 * (https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_UpdateDistribution.html).
 * A config that already holds the fragments is not sent.
 */
export async function applyDistributionConfig(options: {
  distributionId: string;
  fragments: readonly DistributionFragment[];
  access: CloudFrontAccess;
  apply: boolean;
  write: (line: string) => void;
  endpoint?: string;
}): Promise<{ changed: boolean }> {
  const { distributionId, access, write } = options;
  const endpoint = options.endpoint ?? CLOUDFRONT_ENDPOINT;
  const read = await call(endpoint, access, distributionId, "GetDistributionConfig", { method: "GET" });
  if (!read.ok) throw await refusal(read, distributionId, "GetDistributionConfig");
  const etag = read.headers.get("etag");
  if (etag === null || etag === "") {
    throw new ConfigError(
      `Distribution ${distributionId}: GetDistributionConfig answered with no ETag, and an update needs it for If-Match — check that the endpoint is CloudFront's API`,
    );
  }
  const plan = planDistribution(await read.text(), options.fragments, distributionId);
  for (const line of plan.lines) write(line);
  if (!plan.changed) return { changed: false };
  if (!options.apply) {
    write(plan.config.trimEnd());
    write(`Dry run: distribution ${distributionId} is not updated. Pass --apply to send this config.`);
    return { changed: true };
  }
  const update = await call(endpoint, access, distributionId, "UpdateDistribution", {
    method: "PUT",
    body: plan.config,
    headers: { "content-type": "application/xml", "if-match": etag },
  });
  if (!update.ok) throw await refusal(update, distributionId, "UpdateDistribution", etag);
  write(`Updated distribution ${distributionId}: ETag ${etag} is now ${update.headers.get("etag") ?? "unreported"}.`);
  return { changed: true };
}
