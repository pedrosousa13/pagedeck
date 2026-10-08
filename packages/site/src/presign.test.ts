import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ConfigError } from "@pagedeck/core";
import { readDeployUrls } from "./deploy-urls.js";
import {
  PRESIGN_EXPIRES_SECONDS,
  presignRequests,
  readRequests,
  signingAccess,
} from "./presign.js";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV = {
  PAGEDECK_S3_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  PAGEDECK_S3_REGION: "auto",
  PAGEDECK_S3_BUCKET: "landing",
  PAGEDECK_S3_ACCESS_KEY_ID: "AKIDEXAMPLEACCESSKEY",
  PAGEDECK_S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYsecretkey",
};
const NOW = new Date("2026-10-03T12:00:00.000Z");

// What `deploy.bin.js --requests` writes: GETs with nothing to sign, PUTs with their metadata.
const REQUESTS = JSON.stringify({
  get: { "/manifest.json": {} },
  put: {
    "/index.html": { contentType: "text/html; charset=utf-8", cacheControl: "no-cache", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" },
    "/en/caf%C3%A9/index.html": { contentType: "text/html; charset=utf-8", cacheControl: "no-cache", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" },
    "/.pagedeck/manifests/b1.json": { contentType: "application/json; charset=utf-8", cacheControl: "no-cache", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" },
    "/.pagedeck/manifests/b1.deployed-at": { contentType: "text/plain; charset=utf-8", cacheControl: "no-cache" },
    "/manifest.json": { contentType: "application/json; charset=utf-8", cacheControl: "no-cache", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" },
  },
  delete: { "/old/index.html": {}, "/assets/app-0a1b2c.js": {} },
});

type Signed = Record<"get" | "put" | "delete", Record<string, string>>;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pagedeck-presign-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function signed(): Signed {
  return JSON.parse(
    presignRequests(readRequests(REQUESTS, "requests.json"), signingAccess(ENV), NOW),
  ) as Signed;
}

describe("presignRequests", () => {
  test("signs each request path-style, for the key it is listed under, in the configured region", () => {
    const document = signed();
    expect(Object.keys(document.get)).toEqual(["/manifest.json"]);
    expect(Object.keys(document.put)).toEqual([
      "/index.html",
      "/en/caf%C3%A9/index.html",
      "/.pagedeck/manifests/b1.json",
      "/.pagedeck/manifests/b1.deployed-at",
      "/manifest.json",
    ]);
    const url = new URL(document.put["/en/caf%C3%A9/index.html"] as string);
    expect(url.origin).toBe(ENV.PAGEDECK_S3_ENDPOINT);
    // The key is stored as written, so its `%` is escaped once more in the path.
    expect(url.pathname).toBe("/landing/en/caf%25C3%25A9/index.html");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      `${ENV.PAGEDECK_S3_ACCESS_KEY_ID}/20261003/auto/s3/aws4_request`,
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261003T120000Z");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("cache-control;content-md5;content-type;host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("signs each PUT's content type and cache policy, and its MD5 where the requests carry one, so the host refuses other bytes, another type or another policy (#60)", () => {
    const document = signed();
    const headersOf = (url: string | undefined): string | null =>
      new URL(url as string).searchParams.get("X-Amz-SignedHeaders");
    expect(headersOf(document.put["/index.html"])).toBe("cache-control;content-md5;content-type;host");
    expect(headersOf(document.put["/.pagedeck/manifests/b1.deployed-at"])).toBe("cache-control;content-type;host");
    expect(headersOf(document.get["/manifest.json"])).toBe("host");
    expect(headersOf(document.delete["/old/index.html"])).toBe("host");
    const one = (entry: Record<string, string>): string | undefined =>
      (
        JSON.parse(
          presignRequests(readRequests(JSON.stringify({ put: { "/index.html": entry } }), "requests.json"), signingAccess(ENV), NOW),
        ) as Signed
      ).put["/index.html"];
    const base = { contentType: "text/html; charset=utf-8", cacheControl: "no-cache", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" };
    expect(one(base)).toBe(document.put["/index.html"]);
    expect(one({ ...base, contentType: "text/plain; charset=utf-8" })).not.toBe(document.put["/index.html"]);
    expect(one({ ...base, contentMd5: "XUFAKrxLKna5cZ2REBfFkg==" })).not.toBe(document.put["/index.html"]);
    expect(one({ ...base, cacheControl: "public, max-age=31536000, immutable" })).not.toBe(document.put["/index.html"]);
  });

  test("lets each URL live minutes, not days", () => {
    expect(PRESIGN_EXPIRES_SECONDS).toBeLessThanOrEqual(15 * 60);
    const document = signed();
    for (const url of [...Object.values(document.get), ...Object.values(document.put), ...Object.values(document.delete)]) {
      expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe(String(PRESIGN_EXPIRES_SECONDS));
    }
  });

  test("signs a GET and a PUT for one key differently", () => {
    const document = signed();
    expect(document.get["/manifest.json"]).not.toBe(document.put["/manifest.json"]);
  });

  test("signs a DELETE for each key the prune deletes, path-style, for that key (#659)", () => {
    const document = signed();
    expect(Object.keys(document.delete)).toEqual(["/old/index.html", "/assets/app-0a1b2c.js"]);
    const url = new URL(document.delete["/old/index.html"] as string);
    expect(url.pathname).toBe("/landing/old/index.html");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    const asGet = JSON.parse(
      presignRequests(readRequests(JSON.stringify({ get: { "/old/index.html": {} } }), "requests.json"), signingAccess(ENV), NOW),
    ) as Signed;
    expect(document.delete["/old/index.html"]).not.toBe(asGet.get["/old/index.html"]);
  });

  test("writes a document the deploy itself accepts, key for key", async () => {
    const file = join(dir, "signed.json");
    writeFileSync(file, JSON.stringify(signed()));
    const urls = await readDeployUrls(file);
    expect([...urls.get.keys()]).toEqual(["/manifest.json"]);
    expect([...urls.put.keys()]).toEqual(Object.keys(signed().put));
    expect([...urls.delete.keys()]).toEqual(Object.keys(signed().delete));
  });

  test("never holds the secret key, in any spelling", () => {
    const text = JSON.stringify(signed());
    expect(text).not.toContain(ENV.PAGEDECK_S3_SECRET_ACCESS_KEY);
    expect(text).not.toContain(encodeURIComponent(ENV.PAGEDECK_S3_SECRET_ACCESS_KEY));
  });
});

describe("signingAccess", () => {
  test("names every variable it is missing, and quotes no value", () => {
    const run = () =>
      signingAccess({ PAGEDECK_S3_SECRET_ACCESS_KEY: ENV.PAGEDECK_S3_SECRET_ACCESS_KEY, PAGEDECK_S3_REGION: " " });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(
      new ConfigError(
        "Signing: 4 variables are not set — set each from the repository's secrets, in the step that signs and in no other: PAGEDECK_S3_ENDPOINT, PAGEDECK_S3_REGION, PAGEDECK_S3_BUCKET, PAGEDECK_S3_ACCESS_KEY_ID",
      ),
    );
  });

  test("refuses an endpoint that is not a bare https: origin, and quotes no part of it", () => {
    for (const endpoint of [
      `http://${ACCOUNT}.r2.cloudflarestorage.com`,
      `https://${ACCOUNT}.r2.cloudflarestorage.com/landing`,
      `https://user:pass@${ACCOUNT}.r2.cloudflarestorage.com`,
      "not a url",
    ]) {
      let thrown: unknown;
      try {
        signingAccess({ ...ENV, PAGEDECK_S3_ENDPOINT: endpoint });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, endpoint).toBeInstanceOf(ConfigError);
      expect((thrown as Error).message).toBe(
        "Signing: PAGEDECK_S3_ENDPOINT is not an https: origin with no path, user or query — set it to the bucket host's S3 endpoint, such as https://<account id>.r2.cloudflarestorage.com; its value is not printed",
      );
    }
  });
});

describe("readRequests", () => {
  test("refuses a file that is not JSON without quoting it", () => {
    expect(() => readRequests("{ not json", "requests.json")).toThrow(
      new ConfigError(
        'Signing: "requests.json" is not valid JSON — pass the file deploy.bin.js --requests wrote; the parser\'s own message is not printed, because it quotes the file',
      ),
    );
  });

  test("names every entry it cannot sign, in one report", () => {
    expect(() =>
      readRequests(
        JSON.stringify({
          get: { "manifest.json": {} },
          put: [],
          post: {},
          delete: {
            "/old.html": {},
            "/manifest.json": {},
            "/.pagedeck/deploy-history.json": {},
            "/.pagedeck/manifests/b1.json": {},
            "/assets/../index.html": {},
          },
        }),
        "requests.json",
      ),
    ).toThrow(
      new ConfigError(
        [
          'Signing: "requests.json" has 7 entries that cannot be signed, and nothing was signed — pass the file deploy.bin.js --requests wrote:',
          '  "post": is not a field the deploy reads — the fields are "get", "put" and "delete"',
          '  get "manifest.json": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character',
          '  "put": is not an object of key to request — write it as {key: {}}',
          '  delete "/manifest.json": is a key the deploy writes for itself, and a prune never deletes one — sign no DELETE for "/manifest.json" or under "/.pagedeck/"',
          '  delete "/.pagedeck/deploy-history.json": is a key the deploy writes for itself, and a prune never deletes one — sign no DELETE for "/manifest.json" or under "/.pagedeck/"',
          '  delete "/.pagedeck/manifests/b1.json": is a key the deploy writes for itself, and a prune never deletes one — sign no DELETE for "/manifest.json" or under "/.pagedeck/"',
          '  delete "/assets/../index.html": is not a deploy key — a deploy key starts with "/" and holds no ".", ".." or empty segment, no backslash and no control character',
        ].join("\n"),
      ),
    );
  });
});

test("readRequests refuses a PUT without the type, cache policy or checksum it would be signed for (#60)", () => {
  expect(() =>
    readRequests(
      JSON.stringify({
        put: {
          "/a.html": { cacheControl: "no-cache", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" },
          "/b.html": { contentType: "text/html; charset=utf-8", cacheControl: "no-cache", contentMd5: "not an md5" },
          "/c.html": "text/html",
          "/d.html": { contentType: "text/html; charset=utf-8", cacheControl: "no-cache" },
          "/e.html": { contentType: "text/html; charset=utf-8", contentMd5: "1B2M2Y8AsgTpgAmY7PhCfg==" },
          "/.pagedeck/manifests/b1.deployed-at": { contentType: "text/plain; charset=utf-8", cacheControl: "no-cache" },
        },
      }),
      "requests.json",
    ),
  ).toThrow(
    new ConfigError(
      [
        'Signing: "requests.json" has 5 entries that cannot be signed, and nothing was signed — pass the file deploy.bin.js --requests wrote:',
        '  put "/a.html": has no "contentType" string — a PUT is signed for the type it sends',
        '  put "/b.html": its "contentMd5" is not the base64 MD5 of a body — a PUT is signed for the bytes it sends',
        '  put "/c.html": is not an object — write it as {contentType, cacheControl, contentMd5}',
        '  put "/d.html": has no "contentMd5" — a PUT is signed for the bytes it sends, and only the deploy instant has none; run the dry run again on the same build and sign the file it writes',
        '  put "/e.html": has no "cacheControl" string — a PUT is signed for the cache policy it sends',
      ].join("\n"),
    ),
  );
});
