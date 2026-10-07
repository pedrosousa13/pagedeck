import { describe, expect, it } from "vitest";

import type { RoutingManifest } from "@pagedeck/core/routing";

import {
  contentsOf,
  HARDENED,
  SECURITY_MANIFEST,
} from "../../edge/src/conformance.test-support.js";
import { cloudflareWorker } from "./index.js";
import { interpretWorker } from "./interpret.test-support.js";
import { objectKey, originStandIn, runWorker } from "./worker.test-support.js";

describe("a prefix carrying the spread of SECURITY_HEADERS", () => {
  it("reaches the Worker's header table as three fields", () => {
    expect(contentsOf(cloudflareWorker(), SECURITY_MANIFEST, "worker.js")).toContain(
      'var HEADERS = [\n  { prefix: "/", set: [{ name: "X-Content-Type-Options", value: "nosniff" }, { name: "X-Frame-Options", value: "DENY" }, { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] },\n];',
    );
  });
});

describe("a site's whole security set, HSTS and CSP included, on cloudflare-worker", () => {
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
        cloudflareWorker().compile(BARE).artifacts,
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
    const worker = cloudflareWorker().compile(HARDENED).artifacts[0];
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
    const worker = cloudflareWorker().compile(BARE).artifacts[0];
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
