import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ConfigError } from "@pagedeck/core";
import { ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";
import { cloudfront } from "@pagedeck/adapter-cloudfront";
import { matchesUnder, planDistribution } from "./distribution-config.js";
import type { DistributionFragment } from "./distribution-config.js";
import { child, children, readXml, text } from "./distribution-xml.js";

const RECORDED = readFileSync(new URL("./distribution-config.fixture.xml", import.meta.url), "utf8")
  .replace(/<!--[\s\S]*?-->\n/, "");

function fragments(prefixes: readonly string[]): DistributionFragment[] {
  const routing: RoutingManifest = {
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      {
        redirects: [],
        notFound: "/404",
        headers: [],
        upstreams: prefixes.map((prefix) => ({ prefix, url: "https://app.example.net" })),
      },
    ],
  };
  return cloudfront()
    .compile(routing)
    .artifacts.filter((artifact) => artifact.role === "distribution-config")
    .map(({ path, contents }) => ({ path, contents }));
}

function behaviors(xml: string): string[] {
  const list = child(child(readXml(xml, "test"), "CacheBehaviors"), "Items");
  return children(list, "CacheBehavior").map(
    (one) => `${text(child(one, "PathPattern"))} -> ${text(child(one, "TargetOriginId"))}`,
  );
}

function quantity(xml: string, list: string): string {
  return text(child(child(readXml(xml, "test"), list), "Quantity"));
}

test("a dry run over a recorded config prints the merged config, ours first", () => {
  const plan = planDistribution(RECORDED, fragments(["/api/"]), "E2EXAMPLE");
  expect(plan.changed).toBe(true);
  expect(behaviors(plan.config)).toEqual([
    "/api -> pagedeck-upstream/api/",
    "/api/* -> pagedeck-upstream/api/",
    "/images/* -> site-bucket",
  ]);
  expect(quantity(plan.config, "CacheBehaviors")).toBe("3");
  expect(quantity(plan.config, "Origins")).toBe("2");
  expect(quantity(plan.config, "CustomErrorResponses")).toBe("2");
  const origins = children(child(child(readXml(plan.config, "t"), "Origins"), "Items"), "Origin");
  expect(origins.map((one) => text(child(one, "Id")))).toEqual([
    "pagedeck-upstream/api/",
    "site-bucket",
  ]);
  expect(plan.config).toContain("<DomainName>app.example.net</DomainName>");
  expect(plan.config).toContain("<Method>POST</Method>");
  expect(plan.config).toContain("<ResponsePagePath>/404</ResponsePagePath>");
  expect(plan.config).toContain("<Comment>Operator &amp; Pagedeck</Comment>");
  expect(plan.config).toContain("<CNAME>www.example.com</CNAME>");
  expect(plan.lines.join("\n")).toMatchInlineSnapshot(`
    "Distribution E2EXAMPLE: 1 Pagedeck origin, 2 Pagedeck cache behaviors and 1 Pagedeck error response go ahead of the operator's 1 origin, 1 cache behavior and 1 error response.
      origin    + pagedeck-upstream/api/
      behavior  + /api
      behavior  + /api/*
      error     + 404"
  `);
});

test("merging the merged config changes nothing", () => {
  const once = planDistribution(RECORDED, fragments(["/api/"]), "E2EXAMPLE");
  const twice = planDistribution(once.config, fragments(["/api/"]), "E2EXAMPLE");
  expect(twice.changed).toBe(false);
  expect(twice.config).toBe(once.config);
  expect(twice.lines[0]).toBe("Distribution E2EXAMPLE: unchanged — its config already holds these fragments.");
});

test("a prefix the site dropped loses its origin and behaviors; the operator's stay", () => {
  const before = planDistribution(RECORDED, fragments(["/api/", "/old/"]), "E2EXAMPLE").config;
  const after = planDistribution(before, fragments(["/api/"]), "E2EXAMPLE");
  expect(behaviors(after.config)).toEqual([
    "/api -> pagedeck-upstream/api/",
    "/api/* -> pagedeck-upstream/api/",
    "/images/* -> site-bucket",
  ]);
  expect(after.lines).toContain("  origin    - pagedeck-upstream/old/");
  expect(after.lines).toContain("  behavior  - /old/*");
});

test("an operator behavior that answers a path under a prefix first is refused, naming the distribution", () => {
  const operator = RECORDED.replace("<PathPattern>/images/*</PathPattern>", "<PathPattern>/api/admin/*</PathPattern>");
  let caught: unknown;
  try {
    planDistribution(operator, fragments(["/api/"]), "E2EXAMPLE");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as Error).message).toBe(
    `Distribution E2EXAMPLE: the operator's cache behavior "/api/admin/*" (origin "site-bucket") sits ahead of Pagedeck's and matches paths under the upstream prefix "/api/", so applying would take those paths from it — narrow or remove that behavior, or move Pagedeck's behaviors ahead of it by hand (docs/deploy-recipe.md, "CloudFront")`,
  );
});

test("an operator behavior behind Pagedeck's is left alone", () => {
  const merged = planDistribution(RECORDED, fragments(["/api/"]), "E2EXAMPLE").config;
  const operator = merged.replace("<PathPattern>/images/*</PathPattern>", "<PathPattern>/api/admin/*</PathPattern>");
  expect(planDistribution(operator, fragments(["/api/"]), "E2EXAMPLE").changed).toBe(false);
});

test.each([
  ["/api/*", "/api/", true],
  ["api/*", "/api/", true],
  ["/api", "/api/", true],
  ["/a*", "/api/", true],
  ["*.jpg", "/api/", true],
  ["/ap?/*", "/api/", true],
  ["/API/*", "/api/", false],
  ["/images/*", "/api/", false],
  ["/apis/*", "/api/", false],
  ["/ap", "/api/", false],
  ["/api?", "/api/", true],
])("pattern %s matches under %s: %s", (pattern, prefix, expected) => {
  expect(matchesUnder(pattern, prefix)).toBe(expected);
});

test("the config sent carries the 2020-05-31 namespace even when the one read did not", () => {
  const bare = RECORDED.replace(' xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"', "");
  const plan = planDistribution(bare, fragments(["/api/"]), "E2EXAMPLE");
  expect(plan.config).toContain('<DistributionConfig xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">');
});

test("a lone bad fragment keeps its cause, and several are reported together", () => {
  let lone: unknown;
  try {
    planDistribution(RECORDED, [{ path: "upstreams.json", contents: "{" }], "E2EXAMPLE");
  } catch (error) {
    lone = error;
  }
  expect(lone).toBeInstanceOf(ConfigError);
  expect((lone as Error).message).toBe(
    'Distribution-config fragment "upstreams.json": it is not JSON — rebuild the site so the cloudfront-function adapter writes it again',
  );
  expect((lone as Error).cause).toBeInstanceOf(SyntaxError);

  let many: unknown;
  try {
    planDistribution(
      RECORDED,
      [
        { path: "upstreams.json", contents: "{" },
        { path: "error-responses.json", contents: '{"Aliases":{"Items":[]},"Origins":{"Items":[{"Id":null}]}}' },
      ],
      "E2EXAMPLE",
    );
  } catch (error) {
    many = error;
  }
  expect(many).toBeInstanceOf(ConfigError);
  const lines = (many as Error).message.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^Distribution-config fragment "upstreams.json": it is not JSON — rebuild .*: .+/);
  expect(lines[1]).toBe(
    'Distribution-config fragment "error-responses.json": it names "Aliases", which this deploy does not merge — rebuild the site so the cloudfront-function adapter writes it again',
  );
  expect(lines[2]).toBe(
    'Distribution-config fragment "error-responses.json": "Id" is null — rebuild the site so the cloudfront-function adapter writes it again',
  );
});
