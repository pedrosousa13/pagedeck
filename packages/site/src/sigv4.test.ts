import { describe, expect, test } from "vitest";
import { canonicalHeaders, objectPath, presignPath, signingKey } from "./sigv4.js";

const EXAMPLE = {
  accessKey: "AKIAIOSFODNN7EXAMPLE",
  secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

test("the signing key matches AWS's published derivation example", () => {
  // "Examples of how to derive a signing key for Signature Version 4", which
  // is written for IAM rather than S3 — hence the region and service here.
  const key = signingKey(
    "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    "20120215",
    "us-east-1",
    "iam",
  );
  expect(key.toString("hex")).toBe(
    "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
  );
});

test("a presigned GET matches AWS's published query-string example, signature and all", () => {
  // AWS's query-parameter vector, virtual-hosted: `presignPath` takes the path as given,
  // so it reaches the code the harness's path-style URLs do.
  const url = presignPath({
    endpoint: "https://examplebucket.s3.amazonaws.com",
    ...EXAMPLE,
    region: "us-east-1",
    path: "/test.txt",
    method: "GET",
    expires: 86_400,
    now: new Date("2013-05-24T00:00:00Z"),
  });
  const parsed = new URL(url);
  expect(`${parsed.origin}${parsed.pathname}`).toBe(
    "https://examplebucket.s3.amazonaws.com/test.txt",
  );
  expect(parsed.searchParams.get("X-Amz-Credential")).toBe(
    "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
  );
  expect(parsed.searchParams.get("X-Amz-Signature")).toBe(
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
  expect(url).not.toContain(EXAMPLE.secretKey);
  expect(url).not.toContain(encodeURIComponent(EXAMPLE.secretKey));
});

test("an object path is path-style, RFC 3986-encoded, with the key's slashes kept", () => {
  expect(objectPath("site", "index.html")).toBe("/site/index.html");
  expect(objectPath("site", "a b/c!(x)*'.txt")).toBe(
    "/site/a%20b/c%21%28x%29%2A%27.txt",
  );
  // Unreserved characters stay as they are: encoding one signs a path the host never
  // sees.
  expect(objectPath("site", "_assets/a-b.c~d.js")).toBe("/site/_assets/a-b.c~d.js");
});

describe("signed headers", () => {
  const PUT = {
    endpoint: "https://examplebucket.s3.amazonaws.com",
    ...EXAMPLE,
    region: "us-east-1",
    path: "/index.html",
    method: "PUT",
    expires: 900,
    now: new Date("2013-05-24T00:00:00Z"),
  };
  const HEADERS = { "content-type": "text/html; charset=utf-8", "content-md5": "1B2M2Y8AsgTpgAmY7PhCfg==" };
  const signature = (headers?: Record<string, string>): string | null =>
    new URL(presignPath({ ...PUT, ...(headers === undefined ? {} : { headers }) })).searchParams.get(
      "X-Amz-Signature",
    );

  test("each header is in the canonical request beside host, sorted by name, and listed as signed", () => {
    expect(canonicalHeaders("examplebucket.s3.amazonaws.com", HEADERS)).toEqual({
      canonical:
        "content-md5:1B2M2Y8AsgTpgAmY7PhCfg==\ncontent-type:text/html; charset=utf-8\nhost:examplebucket.s3.amazonaws.com\n",
      signed: "content-md5;content-type;host",
    });
    const url = new URL(presignPath({ ...PUT, headers: HEADERS }));
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-md5;content-type;host");
  });

  test("the signature changes with the content type and with the checksum", () => {
    const base = signature(HEADERS);
    expect(base).not.toBe(signature());
    expect(base).not.toBe(signature({ ...HEADERS, "content-type": "text/plain; charset=utf-8" }));
    expect(base).not.toBe(signature({ ...HEADERS, "content-md5": "XUFAKrxLKna5cZ2REBfFkg==" }));
    expect(signature({ ...HEADERS })).toBe(base);
  });

  test("a name is lowercased before it is sorted and signed", () => {
    expect(canonicalHeaders("h", { "Content-Type": "text/html", "X-Amz-Meta-A": "1" })).toEqual({
      canonical: "content-type:text/html\nhost:h\nx-amz-meta-a:1\n",
      signed: "content-type;host;x-amz-meta-a",
    });
  });

  test("a value's outer spaces are trimmed and inner runs collapsed, as SigV4 canonicalises it", () => {
    expect(canonicalHeaders("h", { "content-type": "  text/html;   charset=utf-8 " }).canonical).toBe(
      "content-type:text/html; charset=utf-8\nhost:h\n",
    );
  });
});
