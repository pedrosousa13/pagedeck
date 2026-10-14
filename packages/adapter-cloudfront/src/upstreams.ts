import { isIP } from "node:net";

import type { UpstreamRoute } from "@pagedeck/core/routing";

import { treeOf } from "@pagedeck/edge";
import type { CompiledTree, Fault } from "@pagedeck/edge";

export const UPSTREAMS_PATH = "upstreams.json";

// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html :
// "Cache behaviors per distribution", 75 by default, and an account may request more.
export const CLOUDFRONT_CACHE_BEHAVIOR_QUOTA = 75;

// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern :
// "The maximum length of a path pattern is 255 characters", and the characters it lists.
const PATH_PATTERN_LIMIT = 255;
const PATH_PATTERN_CHARACTER = /[A-Za-z0-9_\-.*$/~"'@:+&]/;

// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html :
// CachingDisabled, "useful for dynamic content". A policy with a minimum TTL above 0 caches
// "even if the Cache-Control: no-cache, no-store, or private directives are present".
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html :
// AllViewerExceptHostHeader forwards every viewer header but Host, every cookie and every query
// string, and "CloudFront adds a new Host header with the origin's domain name".
const ALL_VIEWER_EXCEPT_HOST_HEADER = "b689b0a8-53d0-40ab-baf2-68738e2966ac";

// https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_AllowedMethods.html : 7 is the
// one Quantity that forwards a POST.
const ALL_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];
const CACHED_METHODS = ["GET", "HEAD"];

// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html#DownloadDistValuesHTTPSPort :
// "Valid values include ports 80, 443, and 1024 to 65535."
function servablePort(port: number): boolean {
  return port === 80 || port === 443 || (port >= 1024 && port <= 65535);
}

function originId(prefix: string): string {
  return `pagedeck-upstream${prefix}`;
}

function pathPatterns(prefix: string): readonly string[] {
  return [prefix.slice(0, -1), `${prefix}*`];
}

function refuse(
  tree: CompiledTree,
  { prefix, url }: UpstreamRoute,
  faults: Fault[],
): void {
  const where = `${treeOf(tree.domain)}'s upstream prefix "${prefix}"`;
  const unmatched = [
    ...new Set([...prefix].filter((one) => !PATH_PATTERN_CHARACTER.test(one))),
  ];
  if (unmatched.length > 0) {
    faults.push({
      kind: "unexpressible",
      line: `${where} — CloudFront's path patterns hold only letters, digits and _ - . $ / ~ " ' @ : + &, so no cache behavior can match ${unmatched.map((one) => JSON.stringify(one)).join(", ")}`,
    });
  }
  const longest = `${prefix}*`;
  if (longest.length > PATH_PATTERN_LIMIT) {
    faults.push({
      kind: "limit",
      line: `${where} — its path pattern "${longest}" is ${String(longest.length)} characters, and CloudFront's limit is ${String(PATH_PATTERN_LIMIT)}`,
    });
  }
  if (url === undefined) return;
  const { hostname, port } = new URL(url);
  // https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html :
  // a custom origin's domain name "can't include a colon (:) and can't be an IP address".
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) {
    faults.push({
      kind: "unexpressible",
      line: `${where} — its url ${JSON.stringify(url)} names an IP address, and CloudFront takes only a DNS name as a custom origin's domain name`,
    });
  }
  if (port !== "" && !servablePort(Number(port))) {
    faults.push({
      kind: "unexpressible",
      line: `${where} — its url ${JSON.stringify(url)} names port ${port}, and CloudFront connects to a custom origin only on port 80, 443 or 1024 to 65535`,
    });
  }
}

/**
 * Distribution configuration, not the viewer-request function: a cache behavior keeps the app's
 * requests out of the default behavior's cache policy and functions, since "the default cache
 * behavior is always the last to be processed"
 * (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html).
 * Field names are the API's: https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_Origin.html,
 * API_CustomOriginConfig.html and API_CacheBehavior.html.
 */
export function upstreamConfig(
  tree: CompiledTree,
  cacheBehaviorLimit: number,
  faults: Fault[],
): string | undefined {
  const upstreams = tree.upstreams ?? [];
  if (upstreams.length === 0) return undefined;
  for (const upstream of upstreams) refuse(tree, upstream, faults);
  const behaviors = upstreams.length * 2;
  if (behaviors > cacheBehaviorLimit) {
    const option = "cloudfront({ limits: { cacheBehaviors } })";
    const limit =
      cacheBehaviorLimit === CLOUDFRONT_CACHE_BEHAVIOR_QUOTA
        ? `CloudFront's default quota is ${String(cacheBehaviorLimit)} per distribution; set ${option} if your account's is higher`
        : `${option} sets ${String(cacheBehaviorLimit)} per distribution`;
    faults.push({
      kind: "limit",
      line: `${treeOf(tree.domain)}'s upstream prefixes — ${String(upstreams.length)} prefixes need ${String(behaviors)} cache behaviors, and ${limit}`,
    });
  }
  // One with no url is already a fault `defineAdapter` reports.
  const routed = upstreams.flatMap(({ prefix, url }) =>
    url === undefined ? [] : [{ prefix, url: new URL(url) }],
  );
  const origins = routed.map(({ prefix, url }) => ({
    Id: originId(prefix),
    DomainName: url.hostname,
    CustomOriginConfig: {
      HTTPPort: 80,
      HTTPSPort: url.port === "" ? 443 : Number(url.port),
      OriginProtocolPolicy: "https-only",
      OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] },
    },
  }));
  const cacheBehaviors = routed.flatMap(({ prefix }) =>
    pathPatterns(prefix).map((pattern) => ({
      PathPattern: pattern,
      TargetOriginId: originId(prefix),
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {
        Quantity: ALL_METHODS.length,
        Items: ALL_METHODS,
        CachedMethods: { Quantity: CACHED_METHODS.length, Items: CACHED_METHODS },
      },
      CachePolicyId: CACHING_DISABLED,
      OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST_HEADER,
      Compress: false,
    })),
  );
  return `${JSON.stringify(
    {
      Origins: { Quantity: origins.length, Items: origins },
      CacheBehaviors: { Quantity: cacheBehaviors.length, Items: cacheBehaviors },
    },
    null,
    2,
  )}\n`;
}
