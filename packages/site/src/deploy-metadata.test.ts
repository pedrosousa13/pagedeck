import { expect, test } from "vitest";
import type { FileKind } from "@pagedeck/core";
import {
  documentMetadata,
  fileMetadata,
  IMMUTABLE,
  REVALIDATE,
  UNKNOWN_TYPE,
} from "./deploy-metadata.js";

const row = (path: string, kind: FileKind, hashed?: true) => ({
  path,
  kind,
  ...(hashed === undefined ? {} : { hashed }),
});

test("every extension a site emits maps to a type, with a charset on text", () => {
  const cases: [string, FileKind, string][] = [
    ["/about/index.html", "html", "text/html; charset=utf-8"],
    ["/assets/app-C52oINTW.js", "js", "text/javascript; charset=utf-8"],
    ["/assets/fw-core-Cu0imwtP.css", "css", "text/css; charset=utf-8"],
    ["/search/en/index.json", "asset", "application/json; charset=utf-8"],
    ["/rss.xml", "asset", "application/xml; charset=utf-8"],
    ["/robots.txt", "asset", "text/plain; charset=utf-8"],
    ["/fonts/mono.4ac224af.woff2", "asset", "font/woff2"],
    ["/assets/images/logo.png", "asset", "image/png"],
    ["/assets/images/logo.webp", "asset", "image/webp"],
    ["/assets/images/photo.jpg", "asset", "image/jpeg"],
    ["/assets/images/photo.jpeg", "asset", "image/jpeg"],
    ["/assets/images/mark.svg", "asset", "image/svg+xml"],
    ["/assets/images/photo.avif", "asset", "image/avif"],
    ["/favicon.ico", "asset", "image/x-icon"],
  ];
  for (const [path, kind, type] of cases) {
    expect(fileMetadata(row(path, kind)).contentType, path).toBe(type);
  }
});

test("the extension is matched without regard to case", () => {
  expect(fileMetadata(row("/assets/images/PHOTO.JPG", "asset")).contentType).toBe("image/jpeg");
});

test("an extension the mapping does not know is application/octet-stream", () => {
  expect(fileMetadata(row("/downloads/archive.tar.zst", "asset"))).toEqual({
    contentType: UNKNOWN_TYPE,
    cacheControl: REVALIDATE,
  });
  expect(fileMetadata(row("/LICENSE", "asset")).contentType).toBe(UNKNOWN_TYPE);
  expect(UNKNOWN_TYPE).toBe("application/octet-stream");
});

test("a page is text/html and revalidated, whatever its name holds", () => {
  expect(fileMetadata(row("/posts/a-1a2b3c4d/index.html", "html"))).toEqual({
    contentType: "text/html; charset=utf-8",
    cacheControl: "no-cache",
  });
});

test("a row the build recorded as hashed is immutable, whatever its kind", () => {
  for (const [path, kind] of [
    ["/assets/entry-81ab8ea221ac5c49-C52oINTW.js", "js"],
    ["/assets/fw-core-Cu0imwtP.css", "css"],
    ["/assets/logo-BJKXE2ia.png", "asset"],
    ["/fonts/red-hat-mono-400-normal.4ac224af.woff2", "asset"],
  ] as const) {
    expect(fileMetadata(row(path, kind, true)).cacheControl, path).toBe(IMMUTABLE);
  }
  expect(IMMUTABLE).toBe("public, max-age=31536000, immutable");
});

test("a row without the column is revalidated, however hashed its name looks", () => {
  for (const [path, kind] of [
    ["/assets/lunr-language.js", "js"],
    ["/assets/entry-81ab8ea221ac5c49-C52oINTW.js", "js"],
    ["/assets/fw-core-Cu0imwtP.css", "css"],
    ["/fonts/mono.4ac224af.woff2", "asset"],
  ] as const) {
    expect(fileMetadata(row(path, kind)).cacheControl, path).toBe(REVALIDATE);
  }
});

test("a page is revalidated even if a row claims it is hashed", () => {
  expect(fileMetadata(row("/index.html", "html", true)).cacheControl).toBe(REVALIDATE);
});

test("an unhashed asset is revalidated", () => {
  for (const path of ["/assets/images/logo.png", "/search/en/index.json", "/rss.xml", "/favicon.ico"]) {
    expect(fileMetadata(row(path, "asset")).cacheControl, path).toBe(REVALIDATE);
  }
  expect(REVALIDATE).toBe("no-cache");
});

test("the deploy's own documents are typed and revalidated", () => {
  const json = { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" };
  const text = { contentType: "text/plain; charset=utf-8", cacheControl: "no-cache" };
  expect(documentMetadata("/manifest.json")).toEqual(json);
  expect(documentMetadata("/.pagedeck/manifests/b1.json")).toEqual(json);
  expect(documentMetadata("/.pagedeck/manifests/b1.deployed-at")).toEqual(text);
  expect(documentMetadata("/_headers")).toEqual(text);
  expect(documentMetadata("/_redirects")).toEqual(text);
  expect(documentMetadata("//example.com/_redirects")).toEqual(text);
  expect(documentMetadata("/_unknown")).toEqual({ contentType: UNKNOWN_TYPE, cacheControl: "no-cache" });
});
