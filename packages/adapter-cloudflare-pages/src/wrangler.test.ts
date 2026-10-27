import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest } from "@pagedeck/core/routing";

import { ALWAYS_FIXTURE } from "./fixture.test-support.js";
import { cloudflarePages } from "./index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function siteWith(name: string, text: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), "pagedeck-wrangler-"));
  roots.push(root);
  const file = join(root, name);
  writeFileSync(file, text);
  return { root, file };
}

function declaring(...prefixes: string[]): RoutingManifest {
  const [tree] = ALWAYS_FIXTURE.trees;
  return {
    ...ALWAYS_FIXTURE,
    trees: [{ ...tree!, upstreams: prefixes.map((prefix) => ({ prefix })) }],
  };
}

function workerFirst(assets: unknown): string {
  return JSON.stringify({ name: "site", main: "src/app.ts", assets });
}

function refusal(manifest: RoutingManifest, root: string): string {
  try {
    cloudflarePages().compile(manifest, { root });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).message;
  }
  return expect.unreachable("expected a refusal");
}

const UNROUTED_ONE = `Edge target "cloudflare-pages": 1 prefix in build.routing.upstreams does not reach the app through assets.run_worker_first — add each pattern its line names to assets.run_worker_first in the wrangler file; Workers Static Assets answers a request no pattern matches from the site's files, so it never reaches the app:`;

describe("a declared prefix run_worker_first does not reach", () => {
  it("is refused when no pattern is the prefix followed by *", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ directory: "./site", run_worker_first: [] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `${UNROUTED_ONE}\n  the default tree's prefix "/api/" — "${file}" lists no "/api/*"`,
    );
  });

  it("is refused when run_worker_first and assets are absent", () => {
    const { root, file } = siteWith("wrangler.json", JSON.stringify({ name: "site" }));
    expect(refusal(declaring("/api/", "/hooks/"), root)).toBe(
      `Edge target "cloudflare-pages": 2 prefixes in build.routing.upstreams do not reach the app through assets.run_worker_first — add each pattern its line names to assets.run_worker_first in the wrangler file; Workers Static Assets answers a request no pattern matches from the site's files, so it never reaches the app:\n  the default tree's prefix "/api/" — "${file}" lists no "/api/*"\n  the default tree's prefix "/hooks/" — "${file}" lists no "/hooks/*"`,
    );
  });

  it("needs the unslashed path listed when a miss does not reach the Worker", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ not_found_handling: "404-page", run_worker_first: ["/api/*"] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `${UNROUTED_ONE}\n  the default tree's prefix "/api/" — "${file}" lists no "/api", and its not_found_handling "404-page" answers "/api" from the site's files`,
    );
  });

  it("names both patterns when both are missing", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ not_found_handling: "single-page-application" }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `${UNROUTED_ONE}\n  the default tree's prefix "/api/" — "${file}" lists no "/api/*" or "/api", and its not_found_handling "single-page-application" answers "/api" from the site's files`,
    );
  });

  it("passes with the prefix's pattern, and the unslashed path where a miss is the site's", () => {
    const missToWorker = siteWith(
      "wrangler.jsonc",
      workerFirst({ not_found_handling: "none", run_worker_first: ["/api/*"] }),
    );
    expect(() => cloudflarePages().compile(declaring("/api/"), missToWorker)).not.toThrow();
    const missToSite = siteWith(
      "wrangler.jsonc",
      workerFirst({ not_found_handling: "404-page", run_worker_first: ["/api", "/api/*"] }),
    );
    expect(() => cloudflarePages().compile(declaring("/api/"), missToSite)).not.toThrow();
  });
});

describe("run_worker_first: true", () => {
  it("is refused", () => {
    const { root, file } = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: true }));
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 1 wrangler file sets assets.run_worker_first to true — list one pattern per prefix in build.routing.upstreams instead, such as ["/api/*"]; true runs the app before every request, so each built page costs a Worker invocation:\n  "${file}"`,
    );
  });
});

describe("a pattern no upstream declares", () => {
  it("is refused, naming what build.routing.upstreams declares", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ run_worker_first: ["/api/*", "/admin/*", "/*"] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 2 patterns in assets.run_worker_first name no prefix in build.routing.upstreams — remove each, or declare its prefix in build.routing.upstreams; the app answers every path a pattern matches, and the build checks only a declared prefix against the paths it writes:\n  "/admin/*" in "${file}" — build.routing.upstreams declares "/api/"\n  "/*" in "${file}" — build.routing.upstreams declares "/api/"`,
    );
  });

  it("is refused when no upstream is declared at all", () => {
    const { root, file } = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: ["/api/*"] }));
    expect(refusal(ALWAYS_FIXTURE, root)).toBe(
      `Edge target "cloudflare-pages": 1 pattern in assets.run_worker_first names no prefix in build.routing.upstreams — remove each, or declare its prefix in build.routing.upstreams; the app answers every path a pattern matches, and the build checks only a declared prefix against the paths it writes:\n  "/api/*" in "${file}" — build.routing.upstreams declares no prefix`,
    );
  });

  it("is refused when it keeps part of a declared prefix from the app", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ run_worker_first: ["/api/*", "!/api/docs/*", "!/assets/*"] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 1 negative pattern in assets.run_worker_first keeps part of an upstream prefix from the app — remove each; a request it matches is answered from the site's files, which hold nothing under an upstream prefix:\n  "!/api/docs/*" in "${file}" — under "/api/"`,
    );
  });
});

describe("reading the wrangler file", () => {
  it("reads comments and trailing commas in JSONC", () => {
    const { root } = siteWith(
      "wrangler.jsonc",
      `{
  // The Worker answers "/api/*" // not a comment inside a string
  "name": "site", /* block
  comment */
  "assets": {
    "run_worker_first": ["/api/*", "/x//y",],
  },
}
`,
    );
    expect(refusal(declaring("/api/"), root)).toContain(`"/x//y" in `);
  });

  it("refuses a file that does not parse", () => {
    const { root, file } = siteWith("wrangler.jsonc", `{ "assets": { "run_worker_first": [ } }`);
    expect(refusal(declaring("/api/"), root)).toMatch(
      new RegExp(
        `^Edge target "cloudflare-pages": 1 wrangler file is not valid JSON with comments — correct it where the line says; wrangler refuses the same file when it deploys:\\n  "${file.replaceAll("/", "\\/")}" — Unexpected token .+$`,
      ),
    );
  });

  it("refuses a run_worker_first that is neither a boolean nor a list of strings", () => {
    const { root, file } = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: ["/api/*", 3] }));
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 1 wrangler file's assets.run_worker_first is neither true, false nor a list of patterns — write a list of patterns, one per prefix in build.routing.upstreams, such as ["/api/*"]:\n  "${file}" — it is ["/api/*",3]`,
    );
  });

  it("refuses wrangler.toml when upstreams are declared", () => {
    const { root, file } = siteWith("wrangler.toml", `name = "site"\n[assets]\nrun_worker_first = ["/api/*"]\n`);
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 1 wrangler.toml cannot be checked against build.routing.upstreams — write it as wrangler.jsonc, which wrangler also reads; the build reads JSON and JSONC only, so it cannot check assets.run_worker_first in TOML:\n  "${file}"`,
    );
  });

  it("reads wrangler.json before wrangler.jsonc and wrangler.toml", () => {
    const { root } = siteWith("wrangler.json", workerFirst({ run_worker_first: ["/api/*"] }));
    writeFileSync(join(root, "wrangler.jsonc"), "not json");
    writeFileSync(join(root, "wrangler.toml"), "not toml");
    expect(() => cloudflarePages().compile(declaring("/api/"), { root })).not.toThrow();
  });
});

describe("no check", () => {
  it("with no wrangler file beside the config", () => {
    const root = mkdtempSync(join(tmpdir(), "pagedeck-wrangler-"));
    roots.push(root);
    expect(() => cloudflarePages().compile(declaring("/api/"), { root })).not.toThrow();
  });

  it("for a Cloudflare Pages project's wrangler file", () => {
    const json = siteWith("wrangler.jsonc", JSON.stringify({ name: "site", pages_build_output_dir: "./site" }));
    expect(() => cloudflarePages().compile(declaring("/api/"), json)).not.toThrow();
    const toml = siteWith("wrangler.toml", `name = "site"\npages_build_output_dir = "./site"\n`);
    expect(() => cloudflarePages().compile(declaring("/api/"), toml)).not.toThrow();
  });

  it("with a wrangler.toml and no upstream declared", () => {
    const { root } = siteWith("wrangler.toml", `name = "site"\n`);
    expect(() => cloudflarePages().compile(ALWAYS_FIXTURE, { root })).not.toThrow();
  });

  it("when compile is handed no site", () => {
    expect(() => cloudflarePages().compile(declaring("/api/"))).not.toThrow();
  });
});

describe("one report", () => {
  it("names every fault together", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ run_worker_first: ["/admin/*"] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `${UNROUTED_ONE}\n  the default tree's prefix "/api/" — "${file}" lists no "/api/*"\n\nEdge target "cloudflare-pages": 1 pattern in assets.run_worker_first names no prefix in build.routing.upstreams — remove each, or declare its prefix in build.routing.upstreams; the app answers every path a pattern matches, and the build checks only a declared prefix against the paths it writes:\n  "/admin/*" in "${file}" — build.routing.upstreams declares "/api/"`,
    );
  });
});
