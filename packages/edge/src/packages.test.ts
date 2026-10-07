import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { PUBLIC_PACKAGES } from "../../core/src/public-packages.test-support.js";
import * as base from "./index.js";

const PACKAGES = join(import.meta.dirname, "..", "..");

// A host's name, or a word only one host's artifacts use.
const HOST = /cloudfront|cloudflare|netlify|nginx|\bworkers?\b|_redirects|_headers/i;

const ADAPTERS = [
  "adapter-cloudfront",
  "adapter-netlify",
  "adapter-nginx",
  "adapter-cloudflare-worker",
] as const;

// Tests and test support included: a suite that imports an adapter is an edge all the same.
function sourceFiles(dir: string): string[] {
  const root = join(PACKAGES, dir, "src");
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(root, file));
}

function specifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
    (match) => match[1] as string,
  );
}

function dependencies(dir: string): string[] {
  const manifest = JSON.parse(
    readFileSync(join(PACKAGES, dir, "package.json"), "utf8"),
  ) as Record<string, Record<string, string> | undefined>;
  return [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].flatMap((field) => Object.keys(manifest[field] ?? {}));
}

// Every way one package can reach another's code: by name, or by a relative path into it.
function adaptersReached(dir: string): string[] {
  const named = [
    ...dependencies(dir),
    ...sourceFiles(dir).flatMap(specifiers),
  ].flatMap((specifier) =>
    ADAPTERS.filter(
      (adapter) =>
        specifier === `@pagedeck/${adapter}` ||
        specifier.startsWith(`@pagedeck/${adapter}/`) ||
        specifier.includes(`../${adapter}/`),
    ),
  );
  return [...new Set(named)].filter((adapter) => adapter !== dir).sort();
}

describe("the edge packages (#19)", () => {
  it("puts the base and every adapter in the public set", () => {
    expect(PUBLIC_PACKAGES).toEqual(
      expect.arrayContaining(["edge", ...ADAPTERS]),
    );
  });

  it("builds every adapter on the base", () => {
    for (const adapter of ADAPTERS) {
      expect(dependencies(adapter), adapter).toContain("@pagedeck/edge");
    }
  });

  it("keeps every adapter out of the base", () => {
    expect(adaptersReached("edge")).toEqual([]);
  });

  it("names no host in anything the base exports", () => {
    expect(Object.keys(base).filter((name) => HOST.test(name))).toEqual([]);
  });

  it("names no host anywhere in the base's shipped source", () => {
    const named = sourceFiles("edge")
      .filter((file) => !/\.test(-support)?\.tsx?$/.test(file))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ file, line: index + 1, text: line }))
          .filter(({ text }) => HOST.test(text))
          .map(
            ({ file, line, text }) =>
              `${relative(PACKAGES, file)}:${String(line)}: ${text.trim()}`,
          ),
      );
    expect(named).toEqual([]);
  });

  for (const adapter of ADAPTERS) {
    it(`keeps every other adapter out of ${adapter}`, () => {
      expect(adaptersReached(adapter)).toEqual([]);
    });
  }
});
