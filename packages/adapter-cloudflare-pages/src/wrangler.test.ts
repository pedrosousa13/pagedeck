import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function refused(
  manifest: RoutingManifest,
  root: string,
  adapter = cloudflarePages(),
): ConfigError {
  try {
    adapter.compile(manifest, { root });
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  return expect.unreachable("expected a refusal");
}

function refusal(manifest: RoutingManifest, root: string, adapter = cloudflarePages()): string {
  return refused(manifest, root, adapter).message;
}

const UNROUTED_ONE = `Edge target "cloudflare-pages": 1 prefix in build.routing.upstreams does not reach the app through assets.run_worker_first — add each pattern its line names to assets.run_worker_first in the wrangler file, the prefix followed by * and its unslashed path, since Cloudflare does not document that * matches nothing; Workers Static Assets answers a request no pattern matches from the site's files, so it never reaches the app:`;

describe("a declared prefix run_worker_first does not reach", () => {
  it("is refused when no pattern is the prefix followed by *", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ directory: "./site", run_worker_first: ["/api"] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `${UNROUTED_ONE}\n  the default tree's prefix "/api/" — "${file}" lists no "/api/*"`,
    );
  });

  it("is refused when no pattern is the unslashed path, whatever not_found_handling says", () => {
    for (const notFound of ["none", "404-page", undefined]) {
      const { root, file } = siteWith(
        "wrangler.jsonc",
        workerFirst({ not_found_handling: notFound, run_worker_first: ["/api/*"] }),
      );
      expect(refusal(declaring("/api/"), root)).toBe(
        `${UNROUTED_ONE}\n  the default tree's prefix "/api/" — "${file}" lists no "/api"`,
      );
    }
  });

  it("is refused when run_worker_first and assets are absent", () => {
    const { root, file } = siteWith("wrangler.json", JSON.stringify({ name: "site" }));
    expect(refusal(declaring("/api/", "/hooks/"), root)).toBe(
      `Edge target "cloudflare-pages": 2 prefixes in build.routing.upstreams do not reach the app through assets.run_worker_first — add each pattern its line names to assets.run_worker_first in the wrangler file, the prefix followed by * and its unslashed path, since Cloudflare does not document that * matches nothing; Workers Static Assets answers a request no pattern matches from the site's files, so it never reaches the app:\n  the default tree's prefix "/api/" — "${file}" lists no "/api/*" or "/api"\n  the default tree's prefix "/hooks/" — "${file}" lists no "/hooks/*" or "/hooks"`,
    );
  });

  it("passes with the prefix followed by * and the unslashed path", () => {
    const site = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: ["/api", "/api/*"] }));
    expect(() => cloudflarePages().compile(declaring("/api/"), site)).not.toThrow();
  });
});

describe("run_worker_first: true", () => {
  it("is refused without the opt-in, naming it", () => {
    const { root, file } = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: true }));
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 1 wrangler file sets assets.run_worker_first to true — list the two patterns for each prefix in build.routing.upstreams instead, such as ["/api", "/api/*"], or pass cloudflarePages({ runWorkerFirst: true }) to run the app before every request on purpose; true makes each built page cost a Worker invocation:\n  "${file}"`,
    );
  });

  it("passes with cloudflarePages({ runWorkerFirst: true }), with or without upstreams", () => {
    const site = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: true }));
    const adapter = cloudflarePages({ runWorkerFirst: true });
    expect(() => adapter.compile(declaring("/api/", "/account/"), site)).not.toThrow();
    expect(() => adapter.compile(ALWAYS_FIXTURE, site)).not.toThrow();
  });
});

const UNMET = `Edge target "cloudflare-pages": 1 opt-in to run_worker_first: true is not met by the site's wrangler file — set assets.run_worker_first to true in wrangler.jsonc beside pagedeck.config.ts, or remove runWorkerFirst from cloudflarePages() and list the two patterns for each prefix in build.routing.upstreams, such as ["/api", "/api/*"]; the build holds the wrangler file to what the adapter says:`;

describe("cloudflarePages({ runWorkerFirst: true }) without run_worker_first: true", () => {
  it("is refused when the wrangler file lists patterns, and checks none of them", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ run_worker_first: ["/api", "/admin/*"] }),
    );
    expect(refusal(declaring("/api/"), root, cloudflarePages({ runWorkerFirst: true }))).toBe(
      `${UNMET}\n  "${file}" sets it to ["/api","/admin/*"]`,
    );
  });

  it("is refused when the wrangler file sets none", () => {
    const { root, file } = siteWith("wrangler.json", JSON.stringify({ name: "site" }));
    expect(refusal(ALWAYS_FIXTURE, root, cloudflarePages({ runWorkerFirst: true }))).toBe(
      `${UNMET}\n  "${file}" sets none`,
    );
  });

  it("is refused with no wrangler file beside the config", () => {
    const root = mkdtempSync(join(tmpdir(), "pagedeck-wrangler-"));
    roots.push(root);
    expect(refusal(ALWAYS_FIXTURE, root, cloudflarePages({ runWorkerFirst: true }))).toBe(
      `${UNMET}\n  no wrangler.json or wrangler.jsonc in "${root}"`,
    );
  });

  it("is refused for a Cloudflare Pages project's wrangler file", () => {
    const { root, file } = siteWith(
      "wrangler.toml",
      `name = "site"\npages_build_output_dir = "./site"\n`,
    );
    expect(refusal(ALWAYS_FIXTURE, root, cloudflarePages({ runWorkerFirst: true }))).toBe(
      `${UNMET}\n  "${file}" is a Cloudflare Pages project, which has no run_worker_first`,
    );
  });

  it("refuses a wrangler.toml it cannot check, with no upstream declared", () => {
    const { root, file } = siteWith("wrangler.toml", `name = "site"\n[assets]\nrun_worker_first = true\n`);
    expect(refusal(ALWAYS_FIXTURE, root, cloudflarePages({ runWorkerFirst: true }))).toBe(
      `Edge target "cloudflare-pages": 1 wrangler.toml cannot be checked against build.routing.upstreams — write it as wrangler.jsonc, which wrangler also reads; the build reads JSON and JSONC only, so it cannot check assets.run_worker_first in TOML:\n  "${file}"`,
    );
  });

  it("reports only the read error for a wrangler file it cannot read", () => {
    const root = mkdtempSync(join(tmpdir(), "pagedeck-wrangler-"));
    roots.push(root);
    mkdirSync(join(root, "wrangler.jsonc"));
    expect(refusal(ALWAYS_FIXTURE, root, cloudflarePages({ runWorkerFirst: true }))).toMatch(
      /^Edge target "cloudflare-pages": 1 wrangler file cannot be read — [^\n]*\n  "[^"]*wrangler\.jsonc"$/,
    );
  });

  it("is not checked when compile is handed no site", () => {
    expect(() => cloudflarePages({ runWorkerFirst: true }).compile(declaring("/api/"))).not.toThrow();
  });
});

const STRAY = `Edge target "cloudflare-pages": %COUNT% in assets.run_worker_first %VERB% no prefix in build.routing.upstreams — remove each, or declare its prefix in build.routing.upstreams; the app answers every path a pattern matches, and the build checks only a declared prefix against the paths it writes:`;

const EXCLUDED_ONE = `Edge target "cloudflare-pages": 1 negative pattern in assets.run_worker_first keeps part of an upstream prefix from the app — remove each; a request it matches is answered from the site's files, which hold nothing under an upstream prefix:`;

describe("a pattern no upstream declares", () => {
  it("is refused, naming what build.routing.upstreams declares", () => {
    const { root, file } = siteWith(
      "wrangler.jsonc",
      workerFirst({ run_worker_first: ["/api", "/api/*", "/admin/*", "/*"] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `${STRAY.replace("%COUNT%", "2 patterns").replace("%VERB%", "name")}\n  "/admin/*" in "${file}" — build.routing.upstreams declares "/api/"\n  "/*" in "${file}" — build.routing.upstreams declares "/api/"`,
    );
  });

  it("is refused when no upstream is declared at all", () => {
    const { root, file } = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: ["/api/*"] }));
    expect(refusal(ALWAYS_FIXTURE, root)).toBe(
      `${STRAY.replace("%COUNT%", "1 pattern").replace("%VERB%", "names")}\n  "/api/*" in "${file}" — build.routing.upstreams declares no prefix`,
    );
  });
});

describe("a negative pattern", () => {
  it.each(["!/api/docs/*", "!/*", "!/api*", "!/api", "!/a*i/x"])(
    "is refused when %s matches a path under a declared prefix",
    (negative) => {
      const { root, file } = siteWith(
        "wrangler.jsonc",
        workerFirst({ run_worker_first: ["/api", "/api/*", negative] }),
      );
      expect(refusal(declaring("/api/"), root)).toBe(
        `${EXCLUDED_ONE}\n  ${JSON.stringify(negative)} in "${file}" — it matches a path under "/api/"`,
      );
    },
  );

  it.each(["!/assets/*", "!/apis/*", "!/ap", "!/apx*"])(
    "passes when %s matches no path under a declared prefix",
    (negative) => {
      const site = siteWith(
        "wrangler.jsonc",
        workerFirst({ run_worker_first: ["/api", "/api/*", negative] }),
      );
      expect(() => cloudflarePages().compile(declaring("/api/"), site)).not.toThrow();
    },
  );
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
    "run_worker_first": ["/api", "/api/*", "/x//y",],
  },
}
`,
    );
    expect(refusal(declaring("/api/"), root)).toContain(`"/x//y" in `);
  });

  it("reads a trailing comma followed by a comment", () => {
    const { root } = siteWith(
      "wrangler.jsonc",
      `{
  "assets": {
    "run_worker_first": ["/api", "/api/*", // the app
    ],
    "html_handling": "auto-trailing-slash", /* last */ },
}
`,
    );
    expect(() => cloudflarePages().compile(declaring("/api/"), { root })).not.toThrow();
  });

  it("refuses a file that does not parse, with the parser's error as the cause", () => {
    const { root, file } = siteWith("wrangler.jsonc", `{\n  /* block */ "a" 1\n}`);
    const error = refused(declaring("/api/"), root);
    expect(error.message).toBe(
      `Edge target "cloudflare-pages": 1 wrangler file is not valid JSON with comments — correct it where the cause says; wrangler refuses the same file when it deploys:\n  "${file}"`,
    );
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect((error.cause as SyntaxError).message).toBe(
      "Expected ':' after property name in JSON at position 20 (line 2 column 19)",
    );
  });

  it("refuses an unterminated block comment", () => {
    const { root, file } = siteWith("wrangler.jsonc", `{ "name": "site" /* open`);
    const error = refused(declaring("/api/"), root);
    expect(error.message).toContain(`not valid JSON with comments`);
    expect(error.message).toContain(`"${file}"`);
    expect(error.cause).toBeInstanceOf(SyntaxError);
  });

  it("refuses a file it cannot read, with the read error as the cause", () => {
    const root = mkdtempSync(join(tmpdir(), "pagedeck-wrangler-"));
    roots.push(root);
    const file = join(root, "wrangler.jsonc");
    mkdirSync(file);
    const error = refused(declaring("/api/"), root);
    expect(error.message).toBe(
      `Edge target "cloudflare-pages": 1 wrangler file cannot be read — make it a file this user can read, or remove it; the build reads it to check assets.run_worker_first against build.routing.upstreams:\n  "${file}"`,
    );
    expect((error.cause as NodeJS.ErrnoException).code).toBe("EISDIR");
  });

  it("refuses a run_worker_first that is neither a boolean nor a list of strings", () => {
    const { root, file } = siteWith("wrangler.jsonc", workerFirst({ run_worker_first: ["/api/*", 3] }));
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 1 wrangler file's assets.run_worker_first is neither true, false nor a list of patterns — write a list of patterns, the two for each prefix in build.routing.upstreams, such as ["/api", "/api/*"]:\n  "${file}" — it is ["/api/*",3]`,
    );
  });

  it("refuses wrangler.toml when upstreams are declared", () => {
    const { root, file } = siteWith("wrangler.toml", `name = "site"\n[assets]\nrun_worker_first = ["/api/*"]\n`);
    expect(refusal(declaring("/api/"), root)).toBe(
      `Edge target "cloudflare-pages": 1 wrangler.toml cannot be checked against build.routing.upstreams — write it as wrangler.jsonc, which wrangler also reads; the build reads JSON and JSONC only, so it cannot check assets.run_worker_first in TOML:\n  "${file}"`,
    );
  });

  it("reads wrangler.json before wrangler.jsonc and wrangler.toml", () => {
    const { root } = siteWith("wrangler.json", workerFirst({ run_worker_first: ["/api", "/api/*"] }));
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
      workerFirst({ run_worker_first: ["/api", "/admin/*"] }),
    );
    expect(refusal(declaring("/api/"), root)).toBe(
      `${UNROUTED_ONE}\n  the default tree's prefix "/api/" — "${file}" lists no "/api/*"\n\n${STRAY.replace("%COUNT%", "1 pattern").replace("%VERB%", "names")}\n  "/admin/*" in "${file}" — build.routing.upstreams declares "/api/"`,
    );
  });
});
