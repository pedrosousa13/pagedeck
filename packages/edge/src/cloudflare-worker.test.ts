import { describe, expect, it } from "vitest";

import type { EdgeArtifact } from "./artifact.js";
import { compileRouting } from "./index.js";
import { FIXTURE } from "./fixture.test-support.js";
import {
  UPLOADED,
  objectKey,
  originStandIn,
  runWorker,
} from "./worker.test-support.js";
import type { StoredObject } from "./worker.test-support.js";

const ORIGIN = "https://site.test";

function workerSource(domain?: string): string {
  const artifact = compileRouting(FIXTURE, {
    target: "cloudflare-worker",
  }).artifacts.find(
    (one: EdgeArtifact) => one.domain === domain && one.path === "worker.js",
  );
  if (artifact === undefined) throw new Error("no worker.js");
  return artifact.contents;
}

const PAGE = {
  contentType: "text/html; charset=utf-8",
  cacheControl: "no-cache",
};

// What a deploy of the fixture's default tree leaves in the bucket. `secret.txt` is held and
// named by no manifest; the history document, and any `named` path, is held and,
// adversarially, named.
function bucket(named: readonly string[] = []): Map<string, StoredObject> {
  const files: { domain?: string; path: string }[] = [
    ...named.map((path) => ({ path })),
    { path: "/index.html" },
    { path: "/en/about/index.html" },
    { path: "/en/docs/intro/index.html" },
    { path: "/en/404/index.html" },
    { path: "/.pagedeck/manifests/b1.json" },
    { domain: "shop.example", path: "/deals/index.html" },
    { domain: "shop.example", path: "/shop-404/index.html" },
  ];
  const objects = new Map<string, StoredObject>(
    files.map((file) => [
      objectKey(file.domain, file.path),
      { body: `${file.domain ?? ""}${file.path}`, ...PAGE },
    ]),
  );
  objects.set("secret.txt", { body: "not in any manifest" });
  objects.set("manifest.json", {
    body: JSON.stringify({ files }),
    contentType: "application/json; charset=utf-8",
  });
  return objects;
}

async function get(
  url: string,
  options: {
    method?: string;
    domain?: string;
    objects?: Map<string, StoredObject>;
    headers?: Record<string, string>;
  } = {},
): Promise<{ response: Response; body: string; reads: string[] }> {
  const origin = originStandIn(options.objects ?? bucket());
  const response = await runWorker(
    workerSource(options.domain),
    {
      method: options.method ?? "GET",
      url,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    },
    origin.binding,
  );
  return { response, body: await response.text(), reads: origin.reads };
}

const NOT_FOUND_PAGE = "/en/404/index.html";
// The live manifest and the 404 page: the only reads a refused request may make.
const REFUSAL_READS = ["manifest.json", "en/404/index.html"];

describe("a path that traverses, plainly or escaped, is the site's 404 and reads no object", () => {
  // Handed over as the runtime might pass it, unparsed: a `Request` would resolve the dot
  // segments before the Worker saw them.
  const TRAVERSALS: readonly [string, string][] = [
    ["a plain dot-dot segment", "/en/../index.html"],
    [
      "a dot-dot segment to a reserved key",
      "/en/../.pagedeck/manifests/b1.json",
    ],
    ["a dot segment", "/./index.html"],
    ["an escaped dot-dot segment", "/en/%2e%2e/index.html"],
    [
      "an upper-case escaped dot-dot segment",
      "/en/%2E%2E/.pagedeck/manifests/b1.json",
    ],
    ["an escaped slash after a dot-dot", "/en/..%2Findex.html"],
    [
      "escaped slashes throughout",
      "/en%2F..%2F.pagedeck%2Fmanifests%2Fb1.json",
    ],
    ["an escaped backslash", "/en/%5C..%5Cindex.html"],
    ["a plain backslash", "/en\\..\\index.html"],
    ["an escaped NUL", "/index.html%00"],
    ["a malformed escape", "/en/%E0%A4%A"],
  ];

  for (const [what, path] of TRAVERSALS) {
    it(`for ${what}, though the manifest names and holds it: ${path}`, async () => {
      const { response, body, reads } = await get(`${ORIGIN}${path}`, {
        objects: bucket([path]),
      });
      expect(response.status).toBe(404);
      expect(body).toBe(NOT_FOUND_PAGE);
      expect(reads).toEqual(REFUSAL_READS);
    });
  }
});

describe("a reserved deploy key is the site's 404 and is never read", () => {
  for (const path of [
    "/manifest.json",
    "/manifest.json/",
    "/.pagedeck",
    "/.pagedeck/manifests/b1.json",
    "/%2Epagedeck/manifests/b1.json",
    "//.pagedeck//manifests/b1.json",
  ]) {
    it(`for ${path}, though the manifest names it and the bucket holds it`, async () => {
      const { response, body, reads } = await get(`${ORIGIN}${path}`);
      expect(response.status).toBe(404);
      expect(body).toBe(NOT_FOUND_PAGE);
      expect(reads).toEqual(REFUSAL_READS);
    });
  }
});

describe("the Worker serves only keys the live manifest names", () => {
  it("serves a named page with its stored type and cache policy, and the routing set", async () => {
    const { response, body, reads } = await get(`${ORIGIN}/en/about`);
    expect(response.status).toBe(200);
    expect(body).toBe("/en/about/index.html");
    expect(reads).toEqual(["manifest.json", "en/about/index.html"]);
    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "no-cache",
      "content-type": "text/html; charset=utf-8",
      etag: expect.stringMatching(/^"[0-9a-f]{32}"$/),
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    });
  });

  it("answers a key the bucket holds and no manifest names with the 404, without reading it", async () => {
    const { response, body, reads } = await get(`${ORIGIN}/secret.txt`);
    expect(response.status).toBe(404);
    expect(body).toBe(NOT_FOUND_PAGE);
    expect(reads).toEqual(REFUSAL_READS);
  });

  it("serves nothing before the first deploy has published a manifest", async () => {
    const objects = bucket();
    objects.delete("manifest.json");
    const { response, body, reads } = await get(`${ORIGIN}/en/about`, {
      objects,
    });
    expect(response.status).toBe(404);
    expect(body).toBe("Not Found");
    expect(reads).toEqual(["manifest.json"]);
  });

  it("lets a routing header override the policy the object was stored with", async () => {
    const source = compileRouting(
      {
        ...FIXTURE,
        trees: [
          {
            redirects: [],
            headers: [
              {
                prefix: "/",
                set: [{ name: "Cache-Control", value: "public, max-age=60" }],
              },
            ],
          },
        ],
      },
      { target: "cloudflare-worker" },
    ).artifacts[0] as EdgeArtifact;
    const response = await runWorker(
      source.contents,
      { method: "GET", url: `${ORIGIN}/en/about` },
      originStandIn(bucket()).binding,
    );
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("serves a domain tree's own files from its own keys, and not the default tree's", async () => {
    const own = await get("https://shop.example/deals", {
      domain: "shop.example",
    });
    expect(own.response.status).toBe(200);
    expect(own.body).toBe("shop.example/deals/index.html");
    expect(own.reads).toEqual([
      "manifest.json",
      "/shop.example/deals/index.html",
    ]);

    const other = await get("https://shop.example/en/about", {
      domain: "shop.example",
    });
    expect(other.response.status).toBe(404);
    expect(other.body).toBe("shop.example/shop-404/index.html");
    expect(other.reads).toEqual([
      "manifest.json",
      "/shop.example/shop-404/index.html",
    ]);
  });
});

describe("a redirect leaves the site only where the routing document says", () => {
  for (const path of [
    "//evil.example/",
    "//evil.example/en/legacy",
    "/%2F%2Fevil.example",
    "/%5Cevil.example",
    "/https://evil.example/",
    "/en/legacy/..//evil.example",
  ]) {
    it(`sends no Location for ${path}`, async () => {
      const { response } = await get(`${ORIGIN}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    });
  }

  it("sends the declared target, tree-relative, for a declared source", async () => {
    const { response, reads } = await get(`${ORIGIN}/en/legacy`);
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/en/about");
    expect(reads).toEqual([]);
  });
});

describe("methods", () => {
  it("refuses a method that is not GET or HEAD before reading anything", async () => {
    const { response, reads } = await get(`${ORIGIN}/en/about`, { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(reads).toEqual([]);
  });

  it("answers HEAD with the headers GET would carry and no body", async () => {
    const { response, body } = await get(`${ORIGIN}/en/about`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(body).toBe("");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("conditional requests", () => {
  const ABOUT = `${ORIGIN}/en/about`;

  async function etagOf(url: string): Promise<string> {
    const { response } = await get(url);
    const etag = response.headers.get("etag");
    if (etag === null) throw new Error(`no etag on ${url}`);
    return etag;
  }

  it("gives a 200 the object's quoted etag", async () => {
    const { response } = await get(ABOUT);
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("answers a matching If-None-Match with 304, no body and every header the 200 carries", async () => {
    const whole = await get(ABOUT);
    const etag = whole.response.headers.get("etag") ?? "";
    const { response, body } = await get(ABOUT, {
      headers: { "if-none-match": etag },
    });
    expect(response.status).toBe(304);
    expect(body).toBe("");
    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "no-cache",
      "content-type": "text/html; charset=utf-8",
      etag,
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    });
    expect(Object.fromEntries(response.headers)).toEqual(
      Object.fromEntries(whole.response.headers),
    );
  });

  it("answers an If-None-Match naming another object's etag with the whole 200", async () => {
    const { response, body } = await get(ABOUT, {
      headers: { "if-none-match": await etagOf(`${ORIGIN}/`) },
    });
    expect(response.status).toBe(200);
    expect(body).toBe("/en/about/index.html");
  });

  it("answers If-None-Match: * with 304 for an object that exists", async () => {
    const { response, body } = await get(ABOUT, {
      headers: { "if-none-match": "*" },
    });
    expect(response.status).toBe(304);
    expect(body).toBe("");
  });

  it("answers a list of etags that holds the object's with 304", async () => {
    const etag = await etagOf(ABOUT);
    const { response } = await get(ABOUT, {
      headers: {
        "if-none-match": `"stale", ${await etagOf(`${ORIGIN}/`)},${etag} , W/"older"`,
      },
    });
    expect(response.status).toBe(304);
  });

  it("answers a list of etags that lacks the object's with 200", async () => {
    const { response } = await get(ABOUT, {
      headers: { "if-none-match": `"stale", W/"older"` },
    });
    expect(response.status).toBe(200);
  });

  it("compares weakly: W/ on the object's etag still matches", async () => {
    const etag = await etagOf(ABOUT);
    const { response } = await get(ABOUT, {
      headers: { "if-none-match": `W/${etag}` },
    });
    expect(response.status).toBe(304);
  });

  it("answers a matching HEAD with 304 and the same headers", async () => {
    const whole = await get(ABOUT, { method: "HEAD" });
    const etag = whole.response.headers.get("etag") ?? "";
    const { response, body } = await get(ABOUT, {
      method: "HEAD",
      headers: { "if-none-match": etag },
    });
    expect(response.status).toBe(304);
    expect(body).toBe("");
    expect(Object.fromEntries(response.headers)).toEqual(
      Object.fromEntries(whole.response.headers),
    );
  });

  it("answers If-Modified-Since at or after the upload with 304", async () => {
    const { response, body } = await get(ABOUT, {
      headers: { "if-modified-since": UPLOADED.toUTCString() },
    });
    expect(response.status).toBe(304);
    expect(body).toBe("");
  });

  it("answers If-Modified-Since before the upload with 200", async () => {
    const { response } = await get(ABOUT, {
      headers: {
        "if-modified-since": new Date(UPLOADED.getTime() - 1000).toUTCString(),
      },
    });
    expect(response.status).toBe(200);
  });

  it("lets If-None-Match win over an If-Modified-Since that would match", async () => {
    const { response, body } = await get(ABOUT, {
      headers: {
        "if-none-match": `"stale"`,
        "if-modified-since": UPLOADED.toUTCString(),
      },
    });
    expect(response.status).toBe(200);
    expect(body).toBe("/en/about/index.html");
  });

  // UPLOADED is Thursday 1 October 2026, 12:00:00.500 UTC. The machine's time zone must not
  // move a date, so each form is tried at the upload second and one second before it.
  const HTTP_DATES: readonly [string, string, string][] = [
    ["IMF-fixdate", "Thu, 01 Oct 2026 12:00:00 GMT", "Thu, 01 Oct 2026 11:59:59 GMT"],
    ["rfc850-date", "Thursday, 01-Oct-26 12:00:00 GMT", "Thursday, 01-Oct-26 11:59:59 GMT"],
    ["asctime-date", "Thu Oct  1 12:00:00 2026", "Thu Oct  1 11:59:59 2026"],
  ];

  for (const [form, atUpload, before] of HTTP_DATES) {
    it(`answers an If-Modified-Since in ${form} at the upload with 304`, async () => {
      const { response } = await get(ABOUT, {
        headers: { "if-modified-since": atUpload },
      });
      expect(response.status).toBe(304);
    });

    it(`answers an If-Modified-Since in ${form} before the upload with 200`, async () => {
      const { response } = await get(ABOUT, {
        headers: { "if-modified-since": before },
      });
      expect(response.status).toBe(200);
    });
  }

  for (const [what, value] of [
    ["a value that is no date", "yesterday"],
    ["an ISO 8601 date", "2026-10-02T00:00:00Z"],
  ]) {
    it(`ignores an If-Modified-Since holding ${what}`, async () => {
      const { response, body } = await get(ABOUT, {
        headers: { "if-modified-since": value },
      });
      expect(response.status).toBe(200);
      expect(body).toBe("/en/about/index.html");
    });
  }

  it("sends the object's etag over a site rule naming ETag, and matches against it", async () => {
    const source = (
      compileRouting(
        {
          ...FIXTURE,
          trees: [
            {
              redirects: [],
              headers: [{ prefix: "/", set: [{ name: "ETag", value: '"x"' }] }],
            },
          ],
        },
        { target: "cloudflare-worker" },
      ).artifacts[0] as EdgeArtifact
    ).contents;
    const serve = (headers?: Record<string, string>) =>
      runWorker(
        source,
        {
          method: "GET",
          url: ABOUT,
          ...(headers === undefined ? {} : { headers }),
        },
        originStandIn(bucket()).binding,
      );
    const own = await etagOf(ABOUT);
    const whole = await serve();
    expect(whole.status).toBe(200);
    expect(whole.headers.get("etag")).toBe(own);
    const unchanged = await serve({ "if-none-match": own });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(own);
  });

  it("leaves the 404 page, a redirect and a 405 as they were", async () => {
    const headers = { "if-none-match": "*" };
    const missing = await get(`${ORIGIN}/gone`, { headers });
    expect(missing.response.status).toBe(404);
    expect(missing.body).toBe(NOT_FOUND_PAGE);
    expect(missing.response.headers.get("etag")).toBeNull();
    const moved = await get(`${ORIGIN}/en/legacy`, { headers });
    expect(moved.response.status).toBe(301);
    expect(moved.response.headers.get("etag")).toBeNull();
    const refused = await get(ABOUT, { method: "PUT", headers });
    expect(refused.response.status).toBe(405);
    expect(refused.response.headers.get("etag")).toBeNull();
  });

  it("leaves the bare 404 before a first deploy as it was", async () => {
    const objects = bucket();
    objects.delete("manifest.json");
    const { response, body } = await get(ABOUT, {
      objects,
      headers: { "if-none-match": "*" },
    });
    expect(response.status).toBe(404);
    expect(body).toBe("Not Found");
    expect(response.headers.get("etag")).toBeNull();
  });
});
