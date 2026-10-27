import { ConfigError, quoteIdentifier } from "@pagedeck/core";
import { child, children, element, readXml, text, writeXml } from "./distribution-xml.js";
import type { XmlElement } from "./distribution-xml.js";

/** A `distribution-config` artifact as `cloudfront()` writes it: `upstreams.json`, `error-responses.json`. */
export interface DistributionFragment {
  path: string;
  contents: string;
}

export interface DistributionPlan {
  /** The whole `DistributionConfig` an update would send. */
  config: string;
  changed: boolean;
  lines: string[];
}

// The origin Id `cloudfront()` derives from a prefix, `pagedeck-upstream/api/`; a behavior is ours
// when it targets one.
const OURS = "pagedeck-upstream";

const NAMESPACE = "http://cloudfront.amazonaws.com/doc/2020-05-31/";

const LISTS = {
  origin: { list: "Origins", member: "Origin", key: "Id" },
  behavior: { list: "CacheBehaviors", member: "CacheBehavior", key: "PathPattern" },
  error: { list: "CustomErrorResponses", member: "CustomErrorResponse", key: "ErrorCode" },
} as const;
type Kind = keyof typeof LISTS;
const KINDS = Object.keys(LISTS) as Kind[];

// The member element of each `Items` a fragment writes, from the API reference's syntax.
const MEMBER: Readonly<Record<string, string>> = {
  Origins: "Origin",
  CacheBehaviors: "CacheBehavior",
  CustomErrorResponses: "CustomErrorResponse",
  AllowedMethods: "Method",
  CachedMethods: "Method",
  OriginSslProtocols: "SslProtocol",
};

function fragmentFault(fragment: DistributionFragment, what: string): ConfigError {
  return new ConfigError(
    `Distribution-config fragment ${quoteIdentifier(fragment.path)}: ${what} — rebuild the site so the cloudfront-function adapter writes it again`,
  );
}

// Children in the order the API reference lists them, which is alphabetical.
function toXml(name: string, value: unknown, fragment: DistributionFragment): XmlElement {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return element(
      name,
      entries.map(([key, inner]) => {
        if (!Array.isArray(inner)) return toXml(key, inner, fragment);
        const member = MEMBER[name];
        if (member === undefined) throw fragmentFault(fragment, `it holds a list under ${quoteIdentifier(name)}, which this deploy has no member name for`);
        return element(key, inner.map((one) => toXml(member, one, fragment)));
      }),
    );
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return element(name, String(value));
  }
  throw fragmentFault(fragment, `${quoteIdentifier(name)} is ${value === null ? "null" : Array.isArray(value) ? "a list inside a list" : typeof value}`);
}

function readFragments(fragments: readonly DistributionFragment[]): Record<Kind, XmlElement[]> {
  const ours: Record<Kind, XmlElement[]> = { origin: [], behavior: [], error: [] };
  for (const fragment of fragments) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fragment.contents);
    } catch (cause) {
      throw fragmentFault(fragment, `it is not JSON (${(cause as Error).message})`);
    }
    if (typeof parsed !== "object" || parsed === null) throw fragmentFault(fragment, "it is not an object");
    for (const [list, body] of Object.entries(parsed)) {
      const kind = KINDS.find((one) => LISTS[one].list === list);
      if (kind === undefined) throw fragmentFault(fragment, `it names ${quoteIdentifier(list)}, which this deploy does not merge`);
      const items = (body as { Items?: unknown }).Items;
      if (!Array.isArray(items)) throw fragmentFault(fragment, `${quoteIdentifier(list)} has no Items list`);
      ours[kind].push(...items.map((item) => toXml(LISTS[kind].member, item, fragment)));
    }
  }
  return ours;
}

const keyOf = (kind: Kind, node: XmlElement): string => text(child(node, LISTS[kind].key));

function isOurs(kind: Kind, node: XmlElement, fragmentErrors: ReadonlySet<string>): boolean {
  if (kind === "origin") return text(child(node, "Id")).startsWith(OURS);
  if (kind === "behavior") return text(child(node, "TargetOriginId")).startsWith(OURS);
  return fragmentErrors.has(keyOf("error", node));
}

function itemsOf(root: XmlElement, kind: Kind): XmlElement[] {
  const list = root.children.find((one) => one.name === LISTS[kind].list);
  const items = list?.children.find((one) => one.name === "Items");
  return items === undefined ? [] : children(items, LISTS[kind].member);
}

function setItems(root: XmlElement, kind: Kind, members: XmlElement[]): void {
  let list = root.children.find((one) => one.name === LISTS[kind].list);
  if (list === undefined) {
    if (members.length === 0) return;
    list = element(LISTS[kind].list, [element("Items", []), element("Quantity", "0")]);
    root.children.push(list);
  }
  const rest = list.children.filter((one) => one.name !== "Items" && one.name !== "Quantity");
  const quantity = element("Quantity", String(members.length));
  list.children =
    members.length === 0 ? [...rest, quantity] : [element("Items", members), quantity, ...rest];
}

/**
 * Whether a CloudFront path pattern matches the prefix's own path or any path under it. Per
 * https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern :
 * `*` matches 0 or more characters, `?` exactly one, matching is case-sensitive, and a leading
 * `/` is implied.
 */
export function matchesUnder(pattern: string, prefix: string): boolean {
  const glob = pattern.startsWith("/") ? pattern : `/${pattern}`;
  const close = (states: Set<number>): Set<number> => {
    for (const state of states) if (glob[state] === "*") states.add(state + 1);
    return states;
  };
  const step = (states: Set<number>, char: string): Set<number> => {
    const next = new Set<number>();
    for (const state of states) {
      const want = glob[state];
      if (want === "*") next.add(state);
      else if (want === "?" || want === char) next.add(state + 1);
    }
    return close(next);
  };
  let states = close(new Set([0]));
  for (const char of prefix.slice(0, -1)) states = step(states, char);
  if (states.has(glob.length)) return true;
  // Any rest of a pattern can be met by some path, so a live state means some path under the prefix matches.
  return step(states, "/").size > 0;
}

function refusals(
  distributionId: string,
  current: readonly XmlElement[],
  prefixes: readonly string[],
  fragmentErrors: ReadonlySet<string>,
): string[] {
  const firstOurs = current.findIndex((one) => isOurs("behavior", one, fragmentErrors));
  const ahead = firstOurs === -1 ? current : current.slice(0, firstOurs);
  return ahead.flatMap((behavior) => {
    const pattern = text(child(behavior, "PathPattern"));
    return prefixes
      .filter((prefix) => matchesUnder(pattern, prefix))
      .map(
        (prefix) =>
          `Distribution ${distributionId}: the operator's cache behavior "${pattern}" (origin "${text(child(behavior, "TargetOriginId"))}") sits ahead of Pagedeck's and matches paths under the upstream prefix "${prefix}", so applying would take those paths from it — narrow or remove that behavior, or move Pagedeck's behaviors ahead of it by hand (docs/deploy-recipe.md, "CloudFront")`,
      );
  });
}

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

const NOUNS: Record<Kind, [string, string]> = {
  origin: ["origin", "origins"],
  behavior: ["cache behavior", "cache behaviors"],
  error: ["error response", "error responses"],
};

/**
 * Merges the fragments into a config `GetDistributionConfig` returned: Pagedeck's origins,
 * behaviors and error responses are replaced and put first, the operator's kept in their order,
 * and each `Quantity` recounted, since an update replaces each whole list.
 */
export function planDistribution(
  fetched: string,
  fragments: readonly DistributionFragment[],
  distributionId: string,
): DistributionPlan {
  const root = readXml(fetched, `Distribution ${distributionId}'s config`);
  if (root.name !== "DistributionConfig") {
    throw new ConfigError(
      `Distribution ${distributionId}: the config's root element is <${root.name}>, not <DistributionConfig> — check the distribution id, and that the endpoint is CloudFront's API`,
    );
  }
  // https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_UpdateDistribution.html : the
  // request's root carries this namespace, and the response syntax shows none.
  if (!root.attributes.some(([key]) => key === "xmlns")) root.attributes.push(["xmlns", NAMESPACE]);
  const before = writeXml(root);
  const ours = readFragments(fragments);
  const fragmentErrors = new Set(ours.error.map((one) => keyOf("error", one)));
  const prefixes = ours.behavior
    .map((one) => text(child(one, "PathPattern")))
    .filter((pattern) => pattern.endsWith("/*"))
    .map((pattern) => pattern.slice(0, -1));
  const faults = refusals(distributionId, itemsOf(root, "behavior"), prefixes, fragmentErrors);
  if (faults.length > 0) throw new ConfigError(faults.join("\n"));

  const diff: string[] = [];
  const operator: Record<Kind, number> = { origin: 0, behavior: 0, error: 0 };
  for (const kind of KINDS) {
    const current = itemsOf(root, kind);
    const kept = current.filter((one) => !isOurs(kind, one, fragmentErrors));
    operator[kind] = kept.length;
    const was = new Map(
      current.filter((one) => isOurs(kind, one, fragmentErrors)).map((one) => [keyOf(kind, one), writeXml(one)]),
    );
    const label = `  ${kind.padEnd(10)}`;
    for (const one of ours[kind]) {
      const key = keyOf(kind, one);
      const old = was.get(key);
      if (old === undefined) diff.push(`${label}+ ${key}`);
      else if (old !== writeXml(one)) diff.push(`${label}~ ${key}`);
      was.delete(key);
    }
    for (const key of was.keys()) diff.push(`${label}- ${key}`);
    setItems(root, kind, [...ours[kind], ...kept]);
  }
  const config = writeXml(root);
  if (config === before) {
    return {
      config,
      changed: false,
      lines: [`Distribution ${distributionId}: unchanged — its config already holds these fragments.`],
    };
  }
  const list = (counts: Record<Kind, number>, owner: string): string => {
    const [first, second, third] = KINDS.map((kind) => {
      const [one, many] = NOUNS[kind];
      return count(counts[kind], `${owner}${one}`, `${owner}${many}`);
    });
    return `${first as string}, ${second as string} and ${third as string}`;
  };
  const oursCount = { origin: ours.origin.length, behavior: ours.behavior.length, error: ours.error.length };
  return {
    config,
    changed: true,
    lines: [
      `Distribution ${distributionId}: ${list(oursCount, "Pagedeck ")} go ahead of the operator's ${list(operator, "")}.`,
      ...diff,
    ],
  };
}
