import { describe, expect, it } from "vitest";

import { ROUTING_VERSION, SECURITY_HEADERS } from "@pagedeck/core/routing";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { compileRouting } from "./index.js";
import {
  comparable,
  interpretCloudFront,
  interpretNetlify,
  interpretNginx,
  interpretWorker,
} from "./interpret.test-support.js";
import { resolveRequest } from "./oracle.test-support.js";
import { objectKey, originStandIn, runWorker } from "./worker.test-support.js";
import type { EdgeRequest } from "./oracle.test-support.js";

const MANIFEST: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "never" },
  trees: [
    {
      redirects: [],
      headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
    },
  ],
};

function contentsOf(target: string, path: string): string {
  const artifact = compileRouting(MANIFEST, { target }).artifacts.find(
    (candidate) => candidate.domain === undefined && candidate.path === path,
  );
  if (artifact === undefined) throw new Error(`no ${path} for ${target}`);
  return artifact.contents;
}

describe("a prefix carrying the spread of SECURITY_HEADERS", () => {
  it("reaches the CloudFront viewer-response table as three fields", () => {
    expect(contentsOf("cloudfront-function", "routing.response.js")).toContain(
      'var HEADERS = Object.freeze([\n  { prefix: "/", set: [{ name: "x-content-type-options", value: "nosniff" }, { name: "x-frame-options", value: "DENY" }, { name: "referrer-policy", value: "strict-origin-when-cross-origin" }] },\n]);',
    );
  });

  it("reaches _headers as one block under the prefix", () => {
    expect(contentsOf("netlify", "/_headers")).toContain(
      [
        "/*",
        "  X-Content-Type-Options: nosniff",
        "  X-Frame-Options: DENY",
        "  Referrer-Policy: strict-origin-when-cross-origin",
      ].join("\n"),
    );
  });

  it("reaches the Worker's header table as three fields", () => {
    expect(contentsOf("cloudflare-worker", "worker.js")).toContain(
      'var HEADERS = [\n  { prefix: "/", set: [{ name: "X-Content-Type-Options", value: "nosniff" }, { name: "X-Frame-Options", value: "DENY" }, { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] },\n];',
    );
  });

  it("reaches the nginx config as three add_header directives", () => {
    const conf = contentsOf("nginx", "routing.conf");
    expect(conf).toContain(
      'add_header "X-Content-Type-Options" "nosniff" always;',
    );
    expect(conf).toContain('add_header "X-Frame-Options" "DENY" always;');
    expect(conf).toContain(
      'add_header "Referrer-Policy" "strict-origin-when-cross-origin" always;',
    );
  });
});

describe("a site's whole security set, HSTS and CSP included, on every target", () => {
  const POLICY = "default-src 'self'; script-src 'self' 'sha256-AbC+/='";
  const HARDENED: RoutingManifest = {
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      {
        redirects: [
          { from: "/old", to: "/new", status: 301, source: "config", via: [] },
        ],
        notFound: "/404",
        headers: [
          {
            prefix: "/",
            set: [
              ...SECURITY_HEADERS,
              {
                name: "Strict-Transport-Security",
                value: "max-age=63072000; includeSubDomains",
              },
              { name: "Content-Security-Policy", value: POLICY },
            ],
          },
        ],
      },
    ],
  };
  const REQUESTS: readonly (EdgeRequest & { what: string })[] = [
    { what: "a page", path: "/new", found: true },
    { what: "a redirect", path: "/old", found: false },
    { what: "a missing page", path: "/gone", found: false },
    { what: "a reserved deploy key", path: "/manifest.json", found: true },
  ];

  for (const request of REQUESTS) {
    it(`answers ${request.what} with all five fields, as the document says`, async () => {
      const claim = comparable(resolveRequest(HARDENED, request));
      expect(
        (("headers" in claim ? claim.headers : undefined) ?? []).map((field) => field.name),
      ).toEqual([
        "content-security-policy",
        "referrer-policy",
        "strict-transport-security",
        "x-content-type-options",
        "x-frame-options",
      ]);
      const compiled = (target: string) =>
        compileRouting(HARDENED, { target }).artifacts;
      expect({
        "cloudfront-function": comparable(
          await interpretCloudFront(compiled("cloudfront-function"), request),
        ),
        netlify: comparable(interpretNetlify(compiled("netlify"), request)),
        nginx: comparable(interpretNginx(compiled("nginx"), request)),
        "cloudflare-worker": comparable(
          await interpretWorker(compiled("cloudflare-worker"), request),
        ),
      }).toEqual({
        "cloudfront-function": claim,
        netlify: claim,
        nginx: claim,
        "cloudflare-worker": claim,
      });
    });
  }

  // No 404 page, as on the landing page: the host's own 404, and a refused method, still
  // carry the set. The oracle makes no claim about a bare 404, so this reads the Worker raw.
  const BARE: RoutingManifest = {
    ...HARDENED,
    trees: HARDENED.trees.map(({ notFound: _dropped, ...tree }) => tree),
  };
  const FIVE = [
    "content-security-policy",
    "referrer-policy",
    "strict-transport-security",
    "x-content-type-options",
    "x-frame-options",
  ];
  const names = (headers: Iterable<[string, string]>): string[] =>
    [...headers].map(([name]) => name).filter((name) => FIVE.includes(name));

  for (const request of [
    { what: "a missing page", path: "/gone", found: false },
    { what: "a reserved deploy key", path: "/manifest.json", found: true },
  ]) {
    it(`gives cloudflare-worker's bare 404 for ${request.what} all five fields, with no 404 page`, async () => {
      const resolution = await interpretWorker(
        compileRouting(BARE, { target: "cloudflare-worker" }).artifacts,
        request,
      );
      expect(resolution.kind).toBe("not-found");
      expect(
        names(
          ("headers" in resolution ? (resolution.headers ?? []) : []).map(
            (field): [string, string] => [field.name.toLowerCase(), field.value],
          ),
        ).sort(),
      ).toEqual(FIVE);
    });
  }

  it("gives cloudflare-worker's 304 every field its 200 carries", async () => {
    const worker = compileRouting(HARDENED, { target: "cloudflare-worker" })
      .artifacts[0];
    const origin = originStandIn(
      new Map([
        [objectKey(undefined, "/new/index.html"), { body: "/new" }],
        [
          "manifest.json",
          { body: JSON.stringify({ files: [{ path: "/new/index.html" }] }) },
        ],
      ]),
    ).binding;
    const serve = (headers?: Record<string, string>) =>
      runWorker(
        worker?.contents ?? "",
        {
          method: "GET",
          url: "https://site.test/new",
          ...(headers === undefined ? {} : { headers }),
        },
        origin,
      );
    const whole = await serve();
    expect(whole.status).toBe(200);
    expect(names(whole.headers).sort()).toEqual(FIVE);
    const unchanged = await serve({
      "if-none-match": whole.headers.get("etag") ?? "",
    });
    expect(unchanged.status).toBe(304);
    expect([...unchanged.headers]).toEqual([...whole.headers]);
  });

  it("gives cloudflare-worker's 405 all five fields beside Allow", async () => {
    const worker = compileRouting(BARE, { target: "cloudflare-worker" })
      .artifacts[0];
    const response = await runWorker(
      worker?.contents ?? "",
      { method: "POST", url: "https://site.test/new" },
      originStandIn(new Map()).binding,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(names(response.headers)).toEqual(FIVE);
  });
});
