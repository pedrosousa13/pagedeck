import { expect, test } from "vitest";
import { objectPath, presignPath, signingKey } from "./sigv4.js";

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
