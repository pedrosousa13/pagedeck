import { expect, test } from "vitest";
import * as core from "./index.js";
import { contentTypeOf } from "./content-types.js";

test("every extension a site or a script runtime emits maps to a type, with a charset on text", () => {
  const cases: [string, string][] = [
    ["/about/index.html", "text/html; charset=utf-8"],
    ["/assets/app.js", "text/javascript; charset=utf-8"],
    ["/script-runtime/0a1b2c3d/boot.mjs", "text/javascript; charset=utf-8"],
    ["/assets/app.css", "text/css; charset=utf-8"],
    ["/search/en/index.json", "application/json; charset=utf-8"],
    ["/assets/app.js.map", "application/json; charset=utf-8"],
    ["/site.webmanifest", "application/manifest+json"],
    ["/rss.xml", "application/xml; charset=utf-8"],
    ["/robots.txt", "text/plain; charset=utf-8"],
    ["/fonts/mono.woff2", "font/woff2"],
    ["/logo.png", "image/png"],
    ["/logo.webp", "image/webp"],
    ["/photo.jpg", "image/jpeg"],
    ["/photo.jpeg", "image/jpeg"],
    ["/mark.svg", "image/svg+xml"],
    ["/photo.avif", "image/avif"],
    ["/favicon.ico", "image/x-icon"],
    ["/script-runtime/0a1b2c3d/probe.wasm", "application/wasm"],
  ];
  for (const [path, type] of cases) expect(contentTypeOf(path), path).toBe(type);
});

test("the extension is matched without regard to case", () => {
  expect(contentTypeOf("/PHOTO.JPG")).toBe("image/jpeg");
  expect(contentTypeOf("SW.JS")).toBe("text/javascript; charset=utf-8");
});

test("a name with no extension, a dotfile, or an extension the table lacks has no type", () => {
  for (const path of ["/LICENSE", "/.htaccess", "/assets/.js", "/archive.tar.zst", "/dir.js/file"]) {
    expect(contentTypeOf(path), path).toBeUndefined();
  }
});

test("the lookup is exported from @pagedeck/core's root", () => {
  expect(core.contentTypeOf).toBe(contentTypeOf);
});
