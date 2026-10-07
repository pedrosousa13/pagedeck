import { describe, expect, it } from "vitest";

import type { EdgeArtifact } from "@pagedeck/edge";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { vercel } from "./index.js";

function defaultTree(): readonly EdgeArtifact[] {
  return vercel().compile(FIXTURE).artifacts.filter(
    (artifact) => artifact.domain === undefined,
  );
}

function contentsOf(path: string): string {
  const artifact = defaultTree().find((candidate) => candidate.path === path);
  if (artifact === undefined) throw new Error(`no ${path} for vercel`);
  return artifact.contents;
}

describe("vercel", () => {
  it("emits one vercel.json with every row the routing document compiles to", () => {
    expect(JSON.parse(contentsOf("/vercel.json"))).toEqual({
      trailingSlash: false,
      cleanUrls: true,
      redirects: [
        { source: "/en/about/", destination: "/en/about", statusCode: 308 },
        {
          source: "/en/docs/intro/",
          destination: "/en/docs/intro",
          statusCode: 308,
        },
        { source: "/en/legacy", destination: "/en/about", statusCode: 301 },
        { source: "/en/legacy/", destination: "/en/about", statusCode: 301 },
        {
          source: "/en/old-docs",
          destination: "/en/docs/intro",
          statusCode: 308,
        },
        {
          source: "/en/old-docs/",
          destination: "/en/docs/intro",
          statusCode: 308,
        },
      ],
      headers: [
        {
          source: "/en/docs/:rest(.*)",
          headers: [{ key: "X-Frame-Options", value: "DENY" }],
        },
        {
          source: "/en/:rest((?!docs/).*)",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            {
              key: "Referrer-Policy",
              value: "strict-origin-when-cross-origin",
            },
          ],
        },
      ],
      routes: [
        {
          src: "^/manifest\\.json$",
          status: 404,
          dest: "/en/404",
          headers: {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        },
        {
          src: "^/\\.pagedeck$",
          status: 404,
          dest: "/en/404",
          headers: {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        },
        {
          src: "^/\\.pagedeck/.*$",
          status: 404,
          dest: "/en/404",
          headers: {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        },
        { handle: "filesystem" },
        {
          src: "^/.*$",
          status: 404,
          dest: "/en/404",
          headers: {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
          },
        },
      ],
    });
  });

  it("ends the file with a newline", () => {
    expect(contentsOf("/vercel.json").endsWith("\n")).toBe(true);
  });
});
