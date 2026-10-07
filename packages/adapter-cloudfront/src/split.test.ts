import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { ROUTING_VERSION, variantPath } from "@pagedeck/core/routing";
import type { RoutingManifest, RoutingTree } from "@pagedeck/core/routing";

import type { EdgeArtifact } from "@pagedeck/edge";

import { cloudfront } from "./index.js";

const PRIMARY = "/en/pricing";
const MOVED = "/en/legacy-pricing";
const COOKIE = "fw_pricing";

// Weights 1 and 3, so a boundary is off the middle and a divisor off-by-one shows.
const TREE: RoutingTree = {
  redirects: [
    {
      from: MOVED,
      to: PRIMARY,
      status: 301,
      source: "config",
      via: [],
    },
  ],
  headers: [],
  experiments: [
    {
      path: PRIMARY,
      cookie: COOKIE,
      variants: [
        { name: "a", weight: 1 },
        { name: "b", weight: 3 },
      ],
    },
  ],
};

function manifestOf(tree: RoutingTree): RoutingManifest {
  return {
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [tree],
  };
}

const SPLIT = manifestOf(TREE);

const ARTIFACTS = new WeakMap<RoutingManifest, readonly EdgeArtifact[]>();

function artifacts(manifest: RoutingManifest = SPLIT): readonly EdgeArtifact[] {
  const cached = ARTIFACTS.get(manifest);
  if (cached !== undefined) return cached;
  const compiled = cloudfront().compile(manifest).artifacts;
  ARTIFACTS.set(manifest, compiled);
  return compiled;
}

function sourceOf(path: string, manifest?: RoutingManifest): string {
  const artifact = artifacts(manifest).find(
    (candidate) => candidate.path === path,
  );
  if (artifact === undefined) throw new Error(`no ${path}`);
  return artifact.contents;
}

// Cached by source text: distribution tests run one function over thousands of ids.
const COMPILED = new Map<string, (event: unknown) => unknown>();

function handlerFor(source: string): (event: unknown) => unknown {
  const cached = COMPILED.get(source);
  if (cached !== undefined) return cached;
  const context = vm.createContext({});
  const compiled = vm.runInContext(`${source}\nhandler`, context) as (
    event: unknown,
  ) => unknown;
  COMPILED.set(source, compiled);
  return compiled;
}

interface CloudFrontCookie {
  value: string;
  attributes?: string;
}

interface Visit {
  uri: string;
  status?: number;
  location?: string;
  cookies: Record<string, CloudFrontCookie>;
}

const REQUEST_ID = "req-0";

// Constants, so a change to the emitted hash fails an assertion instead of shifting a scan.
const ID_A = "req-5";
const ID_B = "req-0";

// The viewer-response half gets the viewer's own path, as CloudFront hands it; only
// `context.requestId` is shared.
function visit(options: {
  path: string;
  cookies?: Record<string, string>;
  requestId?: string;
  manifest?: RoutingManifest;
}): Visit {
  const cookies = Object.fromEntries(
    Object.entries(options.cookies ?? {}).map(([name, value]) => [
      name,
      { value },
    ]),
  );
  const context = { requestId: options.requestId ?? REQUEST_ID };

  const request = { uri: options.path, headers: {}, cookies };
  const answered = handlerFor(sourceOf("routing.request.js", options.manifest))(
    { request, context },
  ) as {
    uri?: string;
    statusCode?: number;
    headers?: Record<string, { value: string }>;
  };
  if (answered.statusCode !== undefined) {
    return {
      uri: options.path,
      status: answered.statusCode,
      location: answered.headers?.["location"]?.value ?? "",
      cookies: {},
    };
  }

  const served = answered.uri ?? options.path;
  const response = { statusCode: 200, headers: {}, cookies: {} };
  const finished = handlerFor(
    sourceOf("routing.response.js", options.manifest),
  )({
    request: { uri: options.path, headers: {}, cookies },
    response,
    context,
  }) as { cookies: Record<string, CloudFrontCookie> };
  return { uri: served, cookies: finished.cookies };
}

function assigned(visited: Visit): string | undefined {
  return visited.cookies[COOKIE]?.value;
}

describe("one visit to a split page", () => {
  const A = variantPath("a", PRIMARY);
  const B = variantPath("b", PRIMARY);

  const rows: {
    name: string;
    path: string;
    cookies?: Record<string, string>;
    requestId?: string;
    uri: string;
    assigned?: string;
  }[] = [
    {
      name: "no cookie is served an arm and given that arm on the way out",
      path: PRIMARY,
      requestId: ID_A,
      uri: A,
      assigned: "a",
    },
    {
      name: "another request id with no cookie lands on the other arm",
      path: PRIMARY,
      requestId: ID_B,
      uri: B,
      assigned: "b",
    },
    {
      name: "a cookie naming a known arm is rewritten to that arm",
      path: PRIMARY,
      cookies: { [COOKIE]: "b" },
      requestId: ID_A,
      uri: B,
    },
    {
      name: "a cookie naming an arm that no longer exists is re-derived",
      path: PRIMARY,
      cookies: { [COOKIE]: "c" },
      requestId: ID_A,
      uri: A,
      assigned: "a",
    },
    {
      name: "an empty cookie value is re-derived",
      path: PRIMARY,
      cookies: { [COOKIE]: "" },
      requestId: ID_A,
      uri: A,
      assigned: "a",
    },
    {
      name: "a cookie value that is a path escape reaches no URI",
      path: PRIMARY,
      cookies: { [COOKIE]: "../../etc" },
      requestId: ID_A,
      uri: A,
      assigned: "a",
    },
    {
      name: "a cookie value naming an Object.prototype member reaches no URI",
      path: PRIMARY,
      cookies: { [COOKIE]: "__proto__" },
      requestId: ID_A,
      uri: A,
      assigned: "a",
    },
    {
      name: "a cookie value naming a constructor reaches no URI",
      path: PRIMARY,
      cookies: { [COOKIE]: "constructor" },
      requestId: ID_A,
      uri: A,
      assigned: "a",
    },
    {
      name: "a page with no experiment is neither rewritten nor assigned",
      path: "/en/about",
      uri: "/en/about",
    },
    {
      name: "another split's cookie assigns nothing here",
      path: "/en/about",
      cookies: { [COOKIE]: "b" },
      uri: "/en/about",
    },
  ];

  it.each(rows)("$name", (row) => {
    const result = visit(row);
    expect(result.uri).toBe(row.uri);
    expect(assigned(result)).toBe(row.assigned);
  });
});

describe("assign and rewrite on the same request", () => {
  it("serves an arm and sets the cookie naming that same arm", () => {
    for (let n = 0; n < 250; n++) {
      const result = visit({ path: PRIMARY, requestId: `req-${String(n)}` });
      const arm = assigned(result);
      expect(arm).toBeDefined();
      expect(result.uri).toBe(variantPath(arm ?? "", PRIMARY));
    }
  });

  it("never serves the primary's own path to a request for it", () => {
    for (let n = 0; n < 50; n++) {
      expect(
        visit({ path: PRIMARY, requestId: `req-${String(n)}` }).uri,
      ).not.toBe(PRIMARY);
    }
  });
});

describe("the cookie the split writes", () => {
  it("is readable by the site's own tooling and survives a browser restart", () => {
    expect(visit({ path: PRIMARY }).cookies[COOKIE]?.attributes).toBe(
      "Path=/; Max-Age=7776000; Secure; SameSite=Lax",
    );
  });

  it("is not rewritten for a visitor who already holds a usable arm", () => {
    expect(assigned(visit({ path: PRIMARY, cookies: { [COOKIE]: "b" } }))).toBe(
      undefined,
    );
  });

  it("wins over the derived arm, so a returning visitor is sticky", () => {
    const held = visit({
      path: PRIMARY,
      cookies: { [COOKIE]: "b" },
      requestId: ID_A,
    });
    expect(held.uri).toBe(variantPath("b", PRIMARY));
    expect(assigned(held)).toBe(undefined);
  });
});

describe("the weights the arms are drawn on", () => {
  const DRAWS = 4000;

  function shares(
    manifest: RoutingManifest,
    path: string,
    cookie: string,
  ): Record<string, number> {
    const counts: Record<string, number> = {};
    for (let n = 0; n < DRAWS; n++) {
      const visited = visit({ path, requestId: `req-${String(n)}`, manifest });
      const arm = visited.cookies[cookie]?.value ?? "";
      counts[arm] = (counts[arm] ?? 0) + 1;
    }
    return counts;
  }

  it("draws the two arms at roughly one to three", () => {
    const counts = shares(SPLIT, PRIMARY, COOKIE);
    expect((counts["a"] ?? 0) / DRAWS).toBeCloseTo(0.25, 1);
    expect((counts["b"] ?? 0) / DRAWS).toBeCloseTo(0.75, 1);
  });

  it("draws arms whose weights are not whole numbers", () => {
    // A fractional weight: a modulo would draw the same two arms and hide it.
    const fractional = manifestOf({
      redirects: [],
      headers: [],
      experiments: [
        {
          path: PRIMARY,
          cookie: COOKIE,
          variants: [
            { name: "a", weight: 0.5 },
            { name: "b", weight: 1.5 },
          ],
        },
      ],
    });
    const counts = shares(fractional, PRIMARY, COOKIE);
    expect((counts["a"] ?? 0) / DRAWS).toBeCloseTo(0.25, 1);
    expect((counts["b"] ?? 0) / DRAWS).toBeCloseTo(0.75, 1);
    expect(counts[""]).toBe(undefined);
  });

  it("draws every arm of a three-way split", () => {
    // Three arms: a walk that stopped at the second would pass every two-arm test.
    const three = manifestOf({
      redirects: [],
      headers: [],
      experiments: [
        {
          path: PRIMARY,
          cookie: COOKIE,
          variants: [
            { name: "blue", weight: 1 },
            { name: "green", weight: 1 },
            { name: "red", weight: 2 },
          ],
        },
      ],
    });
    const counts = shares(three, PRIMARY, COOKIE);
    expect((counts["blue"] ?? 0) / DRAWS).toBeCloseTo(0.25, 1);
    expect((counts["green"] ?? 0) / DRAWS).toBeCloseTo(0.25, 1);
    expect((counts["red"] ?? 0) / DRAWS).toBeCloseTo(0.5, 1);
    expect(counts[""]).toBe(undefined);
  });
});

describe("the response function handed a rewritten URI", () => {
  function respond(uri: string, requestId: string): Visit["cookies"] {
    const response = { statusCode: 200, headers: {}, cookies: {} };
    const finished = handlerFor(sourceOf("routing.response.js"))({
      request: { uri, headers: {}, cookies: {} },
      response,
      context: { requestId },
    }) as { cookies: Record<string, CloudFrontCookie> };
    return finished.cookies;
  }

  it("writes the cookie for an arm's own path, not only for the page's", () => {
    expect(respond(PRIMARY, ID_A)[COOKIE]?.value).toBe("a");
    expect(respond(variantPath("a", PRIMARY), ID_A)[COOKIE]?.value).toBe("a");
    expect(respond(variantPath("b", PRIMARY), ID_A)[COOKIE]?.value).toBe("a");
  });

  it("still writes nothing for a path no split names", () => {
    expect(respond("/_v/a/en/about", ID_A)[COOKIE]).toBe(undefined);
    expect(respond("/en/about", ID_A)[COOKIE]).toBe(undefined);
  });
});

describe("the request function handed a rewritten URI", () => {
  it("leaves an arm's own path alone", () => {
    const arm = variantPath("b", PRIMARY);
    const answered = handlerFor(sourceOf("routing.request.js"))({
      request: { uri: arm, headers: {}, cookies: {} },
      context: { requestId: ID_A },
    }) as { uri: string };
    expect(answered.uri).toBe(arm);
  });
});

describe("two splits declared on one tree", () => {
  const SECOND = "/en/plans";
  const SECOND_COOKIE = "fw_plans";
  const ARMS = [
    { name: "a", weight: 1 },
    { name: "b", weight: 3 },
  ];
  const both = manifestOf({
    redirects: [],
    headers: [],
    experiments: [
      { path: PRIMARY, cookie: COOKIE, variants: ARMS },
      { path: SECOND, cookie: SECOND_COOKIE, variants: ARMS },
    ],
  });

  it("assigns each page only its own cookie", () => {
    const first = visit({ path: PRIMARY, manifest: both });
    expect(Object.keys(first.cookies)).toEqual([COOKIE]);
    const second = visit({ path: SECOND, manifest: both });
    expect(Object.keys(second.cookies)).toEqual([SECOND_COOKIE]);
  });

  it("rewrites each page into its own arms", () => {
    const second = visit({ path: SECOND, requestId: ID_A, manifest: both });
    expect(second.uri).toBe(
      variantPath(second.cookies[SECOND_COOKIE]?.value ?? "", SECOND),
    );
  });

  it("does not assign the two in lockstep", () => {
    let differ = 0;
    for (let n = 0; n < 200; n++) {
      const id = `req-${String(n)}`;
      const first = visit({ path: PRIMARY, requestId: id, manifest: both });
      const second = visit({ path: SECOND, requestId: id, manifest: both });
      if (
        first.cookies[COOKIE]?.value !== second.cookies[SECOND_COOKIE]?.value
      ) {
        differ++;
      }
    }
    // Independent 1:3 draws disagree about three times in eight; one shared roll never would.
    expect(differ).toBeGreaterThan(40);
  });
});

describe("composing with #33's redirect output", () => {
  it("emits one artifact set, not a second pair of functions", () => {
    expect(
      artifacts().map((artifact) => `${artifact.role} ${artifact.path}`),
    ).toEqual(["function routing.request.js", "function routing.response.js"]);
  });

  it("answers the redirect and does not rewrite, even holding an arm", () => {
    const result = visit({ path: MOVED, cookies: { [COOKIE]: "b" } });
    expect(result.status).toBe(301);
    expect(result.location).toBe(PRIMARY);
  });

  it("keeps the split's own page out of the redirect table", () => {
    expect(visit({ path: PRIMARY, cookies: { [COOKIE]: "b" } }).status).toBe(
      undefined,
    );
  });

  it("emits a viewer-request function for a tree with no redirects at all", () => {
    const only = manifestOf({ ...TREE, redirects: [] });
    expect(artifacts(only).map((artifact) => artifact.path)).toEqual([
      "routing.request.js",
      "routing.response.js",
    ]);
  });
});

describe("headers and assignment in one viewer-response function", () => {
  const withHeaders = manifestOf({
    redirects: [],
    headers: [
      { prefix: "/en/", set: [{ name: "X-Frame-Options", value: "DENY" }] },
    ],
    experiments: TREE.experiments ?? [],
  });

  it("sets the header and writes the cookie on the same response", () => {
    const response = { statusCode: 200, headers: {}, cookies: {} };
    const finished = handlerFor(sourceOf("routing.response.js", withHeaders))({
      request: { uri: PRIMARY, headers: {}, cookies: {} },
      response,
      context: { requestId: ID_A },
    }) as {
      headers: Record<string, { value: string }>;
      cookies: Record<string, CloudFrontCookie>;
    };
    expect(finished.headers["x-frame-options"]?.value).toBe("DENY");
    expect(finished.cookies[COOKIE]?.value).toBe("a");
  });

  it("declares one function, so neither stage's loop is the other's", () => {
    const source = sourceOf("routing.response.js", withHeaders);
    expect(source.match(/^function handler\(event\) \{$/gm)).toHaveLength(1);
    expect(source).toContain("var HEADERS = Object.freeze([");
    expect(source).toContain("var SPLITS = Object.freeze({");
  });
});

describe("the arm order the cookie depends on", () => {
  it("assigns by walking the document's order and sorts nothing", () => {
    // Reversed on purpose, a shape core never produces, so the cookie must follow the array.
    const reversed = manifestOf({
      ...TREE,
      experiments: [
        {
          path: PRIMARY,
          cookie: COOKIE,
          variants: [
            { name: "b", weight: 1 },
            { name: "a", weight: 3 },
          ],
        },
      ],
    });
    expect(assigned(visit({ path: PRIMARY, requestId: ID_A }))).toBe("a");
    expect(
      assigned(visit({ path: PRIMARY, requestId: ID_A, manifest: reversed })),
    ).toBe("b");
  });
});

describe("the emitted source", () => {
  const ONLY_SPLIT = manifestOf({ ...TREE, redirects: [] });

  it("writes the rewrite table with one composed variant path per arm", () => {
    expect(sourceOf("routing.request.js", ONLY_SPLIT))
      .toBe(`// Generated by @pagedeck/edge from the routing document. Do not edit.
// CloudFront viewer-request function for the default tree.

var DEPLOY_MANIFEST = "/manifest.json";
var DEPLOY_DIRECTORY = "/.pagedeck";
var UNSERVED = "/.pagedeck/unserved";

function reservedKey(uri) {
  var path = uri;
  try {
    path = decodeURIComponent(uri);
  } catch (malformed) {
    path = uri;
  }
  var parts = path.split("/");
  var kept = [];
  for (var at = 0; at < parts.length; at++) {
    if (parts[at] === "" || parts[at] === ".") continue;
    if (parts[at] === "..") {
      kept.pop();
      continue;
    }
    kept.push(parts[at]);
  }
  var resolved = "/" + kept.join("/");
  return resolved === DEPLOY_MANIFEST ||
    resolved === DEPLOY_DIRECTORY ||
    resolved.indexOf(DEPLOY_DIRECTORY + "/") === 0;
}

var SPLIT_0 = Object.freeze({ cookie: "fw_pricing", total: 4, arms: [{ name: "a", weight: 1, to: "/_v/a/en/pricing" }, { name: "b", weight: 3, to: "/_v/b/en/pricing" }] });

var SPLITS = Object.freeze({
  "/en/pricing": SPLIT_0,
});

function armFor(split, request, requestId) {
  var carried = request.cookies || {};
  var held = Object.prototype.hasOwnProperty.call(carried, split.cookie)
    ? carried[split.cookie].value
    : null;
  for (var kept = 0; kept < split.arms.length; kept++) {
    if (split.arms[kept].name === held) {
      return { arm: split.arms[kept], held: true };
    }
  }
  var seed = requestId + "|" + split.cookie;
  var hash = 5381;
  for (var at = 0; at < seed.length; at++) {
    hash = (((hash << 5) + hash) ^ seed.charCodeAt(at)) >>> 0;
  }
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = (hash + ((hash << 3) >>> 0)) >>> 0;
  hash = (hash ^ (hash >>> 11)) >>> 0;
  hash = (hash + ((hash << 15) >>> 0)) >>> 0;
  var roll = (hash / 4294967296) * split.total;
  var seen = 0;
  var chosen = split.arms[split.arms.length - 1];
  for (var walk = 0; walk < split.arms.length; walk++) {
    seen += split.arms[walk].weight;
    if (roll < seen) {
      chosen = split.arms[walk];
      break;
    }
  }
  return { arm: chosen, held: false };
}

function handler(event) {
  var request = event.request;
  if (reservedKey(request.uri)) request.uri = UNSERVED;
  var split = Object.prototype.hasOwnProperty.call(SPLITS, request.uri)
    ? SPLITS[request.uri]
    : null;
  if (split) {
    request.uri = armFor(split, request, event.context.requestId).arm.to;
  }
  return request;
}
`);
  });

  it("writes that entry and that derivation into the other half too", () => {
    const request = sourceOf("routing.request.js", ONLY_SPLIT);
    const response = sourceOf("routing.response.js", ONLY_SPLIT);
    const armFor = (source: string): string =>
      source.slice(
        source.indexOf("function armFor("),
        source.indexOf("function handler("),
      );
    const entry = `var SPLIT_0 = Object.freeze({ cookie: "fw_pricing", total: 4, arms: [{ name: "a", weight: 1, to: "/_v/a/en/pricing" }, { name: "b", weight: 3, to: "/_v/b/en/pricing" }] });`;
    expect(armFor(response)).toBe(armFor(request));
    expect(request).toContain(entry);
    expect(response).toContain(entry);
  });

  it("keys the response half by the page and by every arm's path", () => {
    expect(sourceOf("routing.response.js", ONLY_SPLIT)).toContain(
      `var SPLITS = Object.freeze({\n  "/en/pricing": SPLIT_0,\n  "/_v/a/en/pricing": SPLIT_0,\n  "/_v/b/en/pricing": SPLIT_0,\n});`,
    );
  });

  it("keys the request half by the page alone", () => {
    expect(sourceOf("routing.request.js", ONLY_SPLIT)).toContain(
      `var SPLITS = Object.freeze({\n  "/en/pricing": SPLIT_0,\n});`,
    );
  });

  it("writes the assignment stage and the cookie attributes it uses", () => {
    const source = sourceOf("routing.response.js", ONLY_SPLIT);
    expect(source.slice(source.indexOf("function handler(")))
      .toBe(`function handler(event) {
  var request = event.request;
  var response = event.response;
  var split = Object.prototype.hasOwnProperty.call(SPLITS, request.uri)
    ? SPLITS[request.uri]
    : null;
  if (split) {
    var assigned = armFor(split, request, event.context.requestId);
    if (!assigned.held) {
      if (!response.cookies) response.cookies = {};
      response.cookies[split.cookie] = {
        value: assigned.arm.name,
        attributes: COOKIE_ATTRIBUTES,
      };
    }
  }
  return response;
}
`);
    expect(source).toContain(
      'var COOKIE_ATTRIBUTES = "Path=/; Max-Age=7776000; Secure; SameSite=Lax";',
    );
  });

  it("uses Math.random nowhere: two rolls could not agree", () => {
    for (const artifact of artifacts()) {
      expect(artifact.contents).not.toContain("Math.random");
    }
  });

  it("carries no sourcemap and no sourceMappingURL", () => {
    for (const artifact of artifacts()) {
      expect(artifact.contents).not.toContain("sourceMappingURL");
    }
  });
});
