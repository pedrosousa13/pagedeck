import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { EdgeArtifact } from "@pagedeck/edge";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { MANIFEST_TTL_MS } from "./cloudflare-worker.js";
import { cloudflareWorker } from "./index.js";
import {
  UPLOADED,
  isolate,
  objectKey,
  originStandIn,
  runWorker,
} from "./worker.test-support.js";
import type { OriginBinding, StoredObject } from "./worker.test-support.js";

const ORIGIN = "https://site.test";

function workerSource(domain?: string): string {
  const artifact = cloudflareWorker().compile(FIXTURE).artifacts.find(
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
// A refused path never reaches the manifest: its one read is the 404 page, by its own key.
const REFUSAL_READS = ["en/404/index.html"];
// A path the manifest does not name reads the manifest, then the 404 page it names.
const MISSING_READS = ["manifest.json", "en/404/index.html"];

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
    expect(reads).toEqual(MISSING_READS);
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
    const source = cloudflareWorker().compile(
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
      cloudflareWorker().compile(
        {
          ...FIXTURE,
          trees: [
            {
              redirects: [],
              headers: [{ prefix: "/", set: [{ name: "ETag", value: '"x"' }] }],
            },
          ],
        },
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

describe("one isolate reads the live manifest at most once per bound", () => {
  function warmIsolate(objects: Map<string, StoredObject> = bucket()) {
    let now = 1_000_000;
    const errors: string[] = [];
    const origin = originStandIn(objects);
    const fetch = isolate(workerSource(), { now: () => now, errors });
    let failing = 0;
    const binding: OriginBinding = {
      get(key) {
        if (failing > 0) {
          failing -= 1;
          origin.reads.push(key);
          return Promise.reject(new Error("R2 is unavailable"));
        }
        return origin.binding.get(key);
      },
    };
    return {
      objects,
      errors,
      reads: origin.reads,
      advance(ms: number) {
        now += ms;
      },
      failNext(count: number) {
        failing = count;
      },
      async get(path: string, method = "GET") {
        const response = await fetch({ method, url: `${ORIGIN}${path}` }, binding);
        return { response, body: await response.text() };
      },
    };
  }

  it("states the bound in the README as the Worker keeps it", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain(
      `reads \`manifest.json\` at most once every ${String(MANIFEST_TTL_MS / 1000)} seconds`,
    );
  });

  it("serves a second page from the cached manifest, reading only the page", async () => {
    const worker = warmIsolate();
    await worker.get("/en/about");
    worker.reads.length = 0;
    const { response, body } = await worker.get("/en/docs/intro");
    expect(response.status).toBe(200);
    expect(body).toBe("/en/docs/intro/index.html");
    expect(worker.reads).toEqual(["en/docs/intro/index.html"]);
  });

  it("shares one manifest read among concurrent requests on a cold isolate", async () => {
    const worker = warmIsolate();
    const answers = await Promise.all(
      ["/en/about", "/en/docs/intro", "/nowhere", "/", "/en/about"].map((path) =>
        worker.get(path),
      ),
    );
    expect(answers.map(({ response }) => response.status)).toEqual([200, 200, 404, 200, 200]);
    expect(worker.reads.filter((key) => key === "manifest.json")).toEqual(["manifest.json"]);
  });

  const REFUSED = [
    "/manifest.json",
    "/.pagedeck/manifests/b1.json",
    "//.pagedeck//manifests/b1.json",
    "/en/../index.html",
    "/en/%2e%2e/index.html",
    "/en%2F..%2F.pagedeck%2Fmanifests%2Fb1.json",
    "/en/%5C..%5Cindex.html",
    "/index.html%00",
    "/en/%E0%A4%A",
  ];

  for (const path of REFUSED) {
    it(`refuses ${path} with the site's 404 and reads nothing from the bucket`, async () => {
      const worker = warmIsolate();
      await worker.get("/manifest.json");
      worker.reads.length = 0;
      const { response, body } = await worker.get(path);
      expect(response.status).toBe(404);
      expect(body).toBe(NOT_FOUND_PAGE);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(worker.reads).toEqual([]);
    });
  }

  it("refuses a path on a cold isolate without reading the manifest", async () => {
    const worker = warmIsolate();
    await worker.get("/.pagedeck/manifests/b1.json");
    await worker.get("/en/../index.html");
    expect(worker.reads).toEqual(["en/404/index.html"]);
  });

  it("refuses a reserved key with a bare 404 when the bucket holds no 404 page", async () => {
    const objects = bucket();
    objects.delete("en/404/index.html");
    const worker = warmIsolate(objects);
    const { response, body } = await worker.get("/manifest.json");
    expect(response.status).toBe(404);
    expect(body).toBe("Not Found");
    expect(worker.reads).toEqual(["en/404/index.html"]);
  });

  it("refuses a domain tree's reserved key with that tree's 404 page, by its own key", async () => {
    const origin = originStandIn(bucket());
    const response = await runWorker(
      workerSource("shop.example"),
      { method: "GET", url: "https://shop.example/manifest.json" },
      origin.binding,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("shop.example/shop-404/index.html");
    expect(origin.reads).toEqual(["/shop.example/shop-404/index.html"]);
  });

  it("answers a path no manifest names with the cached 404 page, reading nothing", async () => {
    const worker = warmIsolate();
    const first = await worker.get("/nowhere");
    worker.reads.length = 0;
    const again = await worker.get("/secret.txt");
    expect(again.response.status).toBe(404);
    expect(again.body).toBe(NOT_FOUND_PAGE);
    expect(Object.fromEntries(again.response.headers)).toEqual(
      Object.fromEntries(first.response.headers),
    );
    expect(worker.reads).toEqual([]);
    const head = await worker.get("/nowhere", "HEAD");
    expect(head.response.status).toBe(404);
    expect(head.body).toBe("");
  });

  it("serves a new deploy once the bound has passed, and not before", async () => {
    const worker = warmIsolate();
    expect((await worker.get("/en/new")).response.status).toBe(404);
    const files = (
      JSON.parse(worker.objects.get("manifest.json")?.body ?? "") as {
        files: { path: string }[];
      }
    ).files;
    worker.objects.set("en/new/index.html", { body: "/en/new/index.html", ...PAGE });
    worker.objects.set("manifest.json", {
      body: JSON.stringify({ files: [...files, { path: "/en/new/index.html" }] }),
    });

    worker.advance(MANIFEST_TTL_MS - 1);
    expect((await worker.get("/en/new")).response.status).toBe(404);
    worker.advance(1);
    worker.reads.length = 0;
    const { response, body } = await worker.get("/en/new");
    expect(response.status).toBe(200);
    expect(body).toBe("/en/new/index.html");
    expect(worker.reads).toEqual(["manifest.json", "en/new/index.html"]);
  });

  it("keeps a missing manifest's bare 404 for the bound, then serves the first deploy", async () => {
    const objects = bucket();
    const manifest = objects.get("manifest.json");
    objects.delete("manifest.json");
    const worker = warmIsolate(objects);
    expect((await worker.get("/en/about")).body).toBe("Not Found");
    if (manifest === undefined) throw new Error("no manifest");
    objects.set("manifest.json", manifest);
    worker.reads.length = 0;
    expect((await worker.get("/en/about")).body).toBe("Not Found");
    expect(worker.reads).toEqual([]);
    worker.advance(MANIFEST_TTL_MS);
    expect((await worker.get("/en/about")).response.status).toBe(200);
  });

  it("does not keep a manifest read that failed: the next request reads it again", async () => {
    const worker = warmIsolate();
    worker.failNext(1);
    await expect(worker.get("/en/about")).rejects.toThrow("R2 is unavailable");
    const { response } = await worker.get("/en/about");
    expect(response.status).toBe(200);
    expect(worker.reads).toEqual(["manifest.json", "manifest.json", "en/about/index.html"]);
  });

  const LOG_PREFIX =
    "pagedeck Worker: manifest.json in the bucket bound as PAGEDECK_ORIGIN is not a deploy manifest";
  const LOG_FIX = `, so every request but a refused one is answered 503 until it is read again ${String(MANIFEST_TTL_MS / 1000)} s after this read — deploy again to put a valid one`;

  for (const [what, text, reason] of [
    [
      "is not JSON",
      "{\"files\": [",
      "it is not JSON (Unexpected end of JSON input)",
    ],
    [
      "is JSON the parser quotes back",
      "not json",
      "it is not JSON (Unexpected token 'o', \"…\" is not valid JSON)",
    ],
    ["holds no files list", JSON.stringify({ files: "everything" }), "it has no files list"],
    ["holds a row without a path", JSON.stringify({ files: [null] }), "files[0] has no path"],
    [
      "holds several rows without a path",
      JSON.stringify({ files: [{ path: "/a" }, 7, { path: "/b" }, { domain: "x" }, { path: 1 }] }),
      "files[1], files[3] and files[4] have no path",
    ],
  ] as const) {
    it(`answers 503 and logs once while the manifest ${what}`, async () => {
      const objects = bucket();
      objects.set("manifest.json", { body: text });
      const worker = warmIsolate(objects);
      for (const path of ["/en/about", "/nowhere"]) {
        const { response, body } = await worker.get(path);
        expect(response.status, path).toBe(503);
        expect(body, path).toBe("Service Unavailable");
      }
      expect((await worker.get("/en/about")).response.headers.get("x-content-type-options")).toBe(
        "nosniff",
      );
      expect(worker.reads).toEqual(["manifest.json"]);
      expect(worker.errors).toEqual([`${LOG_PREFIX}: ${reason}${LOG_FIX}`]);
    });
  }

  it("logs a broken manifest once for concurrent requests on a cold isolate", async () => {
    const objects = bucket();
    objects.set("manifest.json", { body: "not json" });
    const worker = warmIsolate(objects);
    const answers = await Promise.all(
      ["/en/about", "/nowhere", "/", "/en/docs/intro"].map((path) => worker.get(path)),
    );
    expect(answers.map(({ response }) => response.status)).toEqual([503, 503, 503, 503]);
    expect(worker.reads).toEqual(["manifest.json"]);
    expect(worker.errors).toHaveLength(1);
  });

  it("answers a reserved key with the site's 404 while the manifest is broken", async () => {
    const objects = bucket();
    objects.set("manifest.json", { body: "not json" });
    const worker = warmIsolate(objects);
    for (const path of ["/manifest.json", "/.pagedeck/manifests/b1.json"]) {
      const { response, body } = await worker.get(path);
      expect(response.status, path).toBe(404);
      expect(body, path).toBe(NOT_FOUND_PAGE);
    }
    expect(worker.reads).toEqual(["en/404/index.html"]);
    expect(worker.errors).toEqual([]);
  });

  it("serves again once a broken manifest is replaced and the bound has passed", async () => {
    const objects = bucket();
    const manifest = objects.get("manifest.json");
    if (manifest === undefined) throw new Error("no manifest");
    objects.set("manifest.json", { body: "not json" });
    const worker = warmIsolate(objects);
    expect((await worker.get("/en/about")).response.status).toBe(503);
    objects.set("manifest.json", manifest);
    worker.advance(MANIFEST_TTL_MS);
    expect((await worker.get("/en/about")).response.status).toBe(200);
  });
});
