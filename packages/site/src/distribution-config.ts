import { ConfigError, describeError, quoteIdentifier } from "@pagedeck/core";
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

function fragmentFault(fragment: DistributionFragment, what: string, cause?: unknown): ConfigError {
  return new ConfigError(
    `Distribution-config fragment ${quoteIdentifier(fragment.path)}: ${what} — rebuild the site so the cloudfront-function adapter writes it again`,
    cause === undefined ? undefined : { cause },
  );
}

/**
 * Throws a lone failure whole, so it keeps its chain, and several as one report with each
 * chain on its own line (docs/error-messages.md, rule 4).
 */
export function throwCollected(failures: readonly Error[]): void {
  const [first] = failures;
  if (first === undefined) return;
  if (failures.length === 1) throw first;
  const message = failures.map((one) => describeError(one)).join("\n");
  throw failures.every((one) => one instanceof ConfigError) ? new ConfigError(message) : new Error(message);
}

// Children in the order the API reference lists them, which is alphabetical.
function toXml(name: string, value: unknown, faults: string[]): XmlElement {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return element(
      name,
      entries.map(([key, inner]) => {
        if (!Array.isArray(inner)) return toXml(key, inner, faults);
        const member = MEMBER[name];
        if (member === undefined) {
          faults.push(`it holds a list under ${quoteIdentifier(name)}, which this deploy has no member name for`);
          return element(key, []);
        }
        return element(key, inner.map((one) => toXml(member, one, faults)));
      }),
    );
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return element(name, String(value));
  }
  faults.push(`${quoteIdentifier(name)} is ${value === null ? "null" : Array.isArray(value) ? "a list inside a list" : typeof value}`);
  return element(name, "");
}

function readFragments(fragments: readonly DistributionFragment[]): Record<Kind, XmlElement[]> {
  const ours: Record<Kind, XmlElement[]> = { origin: [], behavior: [], error: [] };
  const failures: Error[] = [];
  for (const fragment of fragments) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fragment.contents);
    } catch (cause) {
      failures.push(fragmentFault(fragment, "it is not JSON", cause));
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      failures.push(fragmentFault(fragment, "it is not an object"));
      continue;
    }
    const faults: string[] = [];
    for (const [list, body] of Object.entries(parsed)) {
      const kind = KINDS.find((one) => LISTS[one].list === list);
      if (kind === undefined) {
        faults.push(`it names ${quoteIdentifier(list)}, which this deploy does not merge`);
        continue;
      }
      const items = (body as { Items?: unknown }).Items;
      if (!Array.isArray(items)) {
        faults.push(`${quoteIdentifier(list)} has no Items list`);
        continue;
      }
      ours[kind].push(...items.map((item) => toXml(LISTS[kind].member, item, faults)));
    }
    failures.push(...faults.map((what) => fragmentFault(fragment, what)));
  }
  throwCollected(failures);
  return ours;
}

/**
 * Whether `have` holds everything `want` sets, in any order: a field the service filled in
 * with its default, or a list it reordered, is no change.
 */
function covers(have: XmlElement, want: XmlElement): boolean {
  if (have.name !== want.name) return false;
  if (want.children.length === 0) return have.children.length === 0 && have.text === want.text;
  const pool = [...have.children];
  return want.children.every((one) => {
    const at = pool.findIndex((candidate) => covers(candidate, one));
    if (at === -1) return false;
    pool.splice(at, 1);
    return true;
  });
}

// The children in the order `like` holds them, at every depth; a name `like` lacks keeps the
// reference's alphabetical place after them.
function orderLike(node: XmlElement, like: XmlElement | undefined): XmlElement {
  if (like === undefined || node.children.length === 0) return node;
  const names = [...new Set(like.children.map((one) => one.name))];
  const rank = (name: string): number => {
    const at = names.indexOf(name);
    return at === -1 ? names.length : at;
  };
  const sorted = [...node.children].sort((a, b) => rank(a.name) - rank(b.name));
  return { ...node, children: sorted.map((one) => orderLike(one, like.children.find((t) => t.name === one.name))) };
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

// Items and Quantity stay where the config put them.
function setItems(root: XmlElement, kind: Kind, members: XmlElement[]): void {
  let list = root.children.find((one) => one.name === LISTS[kind].list);
  if (list === undefined) {
    if (members.length === 0) return;
    list = element(LISTS[kind].list, []);
    root.children.push(list);
  }
  const items = element("Items", members);
  const quantity = element("Quantity", String(members.length));
  const next = list.children.flatMap((one) => {
    if (one.name === "Items") return members.length === 0 ? [] : [items];
    return one.name === "Quantity" ? [quantity] : [one];
  });
  if (!next.includes(quantity)) next.push(quantity);
  if (members.length > 0 && !next.includes(items)) next.splice(next.indexOf(quantity), 0, items);
  list.children = next;
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
  const ours = readFragments(fragments);
  const fragmentErrors = new Set(ours.error.map((one) => keyOf("error", one)));
  const prefixes = ours.behavior
    .map((one) => text(child(one, "PathPattern")))
    .filter((pattern) => pattern.endsWith("/*"))
    .map((pattern) => pattern.slice(0, -1));
  const faults = refusals(distributionId, itemsOf(root, "behavior"), prefixes, fragmentErrors);
  if (faults.length > 0) throw new ConfigError(faults.join("\n"));

  const diff: string[] = [];
  let reordered = false;
  const operator: Record<Kind, number> = { origin: 0, behavior: 0, error: 0 };
  for (const kind of KINDS) {
    const current = itemsOf(root, kind);
    const kept = current.filter((one) => !isOurs(kind, one, fragmentErrors));
    operator[kind] = kept.length;
    const was = new Map(
      current.filter((one) => isOurs(kind, one, fragmentErrors)).map((one) => [keyOf(kind, one), one]),
    );
    const label = `  ${kind.padEnd(10)}`;
    const merged = ours[kind].map((one) => {
      const key = keyOf(kind, one);
      const old = was.get(key);
      was.delete(key);
      if (old === undefined) {
        diff.push(`${label}+ ${key}`);
        return orderLike(one, current[0]);
      }
      if (covers(old, one)) return old;
      diff.push(
        kind === "error"
          ? `${label}~ ${key} (the distribution's own ${key} response is replaced, since the site declares ${key})`
          : `${label}~ ${key}`,
      );
      return orderLike(one, old);
    });
    for (const key of was.keys()) diff.push(`${label}- ${key}`);
    const members = [...merged, ...kept];
    if (members.some((one, at) => one !== current[at])) reordered = true;
    setItems(root, kind, members);
  }
  const config = writeXml(root);
  if (diff.length === 0 && !reordered) {
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
