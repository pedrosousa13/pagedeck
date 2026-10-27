import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RoutingManifest } from "@pagedeck/core/routing";

import { treeOf } from "@pagedeck/edge";
import type { AdapterSite, Fault } from "@pagedeck/edge";

const NAMES = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"] as const;

const UNPARSED = {
  subject: {
    one: "wrangler file is not valid JSON with comments",
    many: "wrangler files are not valid JSON with comments",
  },
  fix: "correct it where the line says; wrangler refuses the same file when it deploys",
};

const MISSHAPEN = {
  subject: {
    one: "wrangler file's assets.run_worker_first is neither true, false nor a list of patterns",
    many: "wrangler files' assets.run_worker_first are neither true, false nor lists of patterns",
  },
  fix: 'write a list of patterns, one per prefix in build.routing.upstreams, such as ["/api/*"]',
};

const TOML = {
  subject: {
    one: "wrangler.toml cannot be checked against build.routing.upstreams",
    many: "wrangler.toml files cannot be checked against build.routing.upstreams",
  },
  fix: "write it as wrangler.jsonc, which wrangler also reads; the build reads JSON and JSONC only, so it cannot check assets.run_worker_first in TOML",
};

const EVERY_REQUEST = {
  subject: {
    one: "wrangler file sets assets.run_worker_first to true",
    many: "wrangler files set assets.run_worker_first to true",
  },
  fix: 'list one pattern per prefix in build.routing.upstreams instead, such as ["/api/*"]; true runs the app before every request, so each built page costs a Worker invocation',
};

const UNROUTED = {
  subject: {
    one: "prefix in build.routing.upstreams does not reach the app through assets.run_worker_first",
    many: "prefixes in build.routing.upstreams do not reach the app through assets.run_worker_first",
  },
  fix: "add each pattern its line names to assets.run_worker_first in the wrangler file; Workers Static Assets answers a request no pattern matches from the site's files, so it never reaches the app",
};

const STRAY = {
  subject: {
    one: "pattern in assets.run_worker_first names no prefix in build.routing.upstreams",
    many: "patterns in assets.run_worker_first name no prefix in build.routing.upstreams",
  },
  fix: "remove each, or declare its prefix in build.routing.upstreams; the app answers every path a pattern matches, and the build checks only a declared prefix against the paths it writes",
};

const EXCLUDED = {
  subject: {
    one: "negative pattern in assets.run_worker_first keeps part of an upstream prefix from the app",
    many: "negative patterns in assets.run_worker_first keep parts of upstream prefixes from the app",
  },
  fix: "remove each; a request it matches is answered from the site's files, which hold nothing under an upstream prefix",
};

/** The text with every comment and trailing comma removed, strings left as written. */
function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === "," && /^\s*[}\]]/.test(text.slice(index + 1))) {
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

function isTomlPagesProject(text: string): boolean {
  const topLevel = text.split(/^\s*\[/m)[0] ?? "";
  return /^\s*pages_build_output_dir\s*=/m.test(topLevel);
}

function quoteAll(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(" or ");
}

interface WranglerConfig {
  pages_build_output_dir?: unknown;
  assets?: { run_worker_first?: unknown; not_found_handling?: unknown };
}

function patternsOf(setting: unknown): readonly string[] | undefined {
  if (setting === false) return [];
  if (!Array.isArray(setting)) return undefined;
  return setting.every((pattern) => typeof pattern === "string") ? (setting as string[]) : undefined;
}

/**
 * On Workers Static Assets the site's own wrangler file sends each upstream prefix to the app
 * (ADR-0010), so it is held to `build.routing.upstreams` here.
 */
export function checkWrangler(
  manifest: RoutingManifest,
  faults: Fault[],
  site: AdapterSite | undefined,
): void {
  if (site === undefined) return;
  const name = NAMES.find((candidate) => existsSync(join(site.root, candidate)));
  if (name === undefined) return;
  const file = join(site.root, name);
  const text = readFileSync(file, "utf8");
  const upstreams = manifest.trees.flatMap((tree) =>
    (tree.upstreams ?? []).map(({ prefix }) => ({ domain: tree.domain, prefix })),
  );

  if (name === "wrangler.toml") {
    if (upstreams.length > 0 && !isTomlPagesProject(text)) {
      faults.push({ kind: "adapter", ...TOML, line: JSON.stringify(file) });
    }
    return;
  }

  let config: WranglerConfig;
  try {
    config = JSON.parse(stripJsonc(text)) as WranglerConfig;
  } catch (error) {
    faults.push({
      kind: "adapter",
      ...UNPARSED,
      line: `${JSON.stringify(file)} — ${(error as Error).message}`,
    });
    return;
  }
  if (config.pages_build_output_dir !== undefined) return;

  const setting = config.assets?.run_worker_first ?? false;
  if (setting === true) {
    faults.push({ kind: "adapter", ...EVERY_REQUEST, line: JSON.stringify(file) });
    return;
  }
  const patterns = patternsOf(setting);
  if (patterns === undefined) {
    faults.push({
      kind: "adapter",
      ...MISSHAPEN,
      line: `${JSON.stringify(file)} — it is ${JSON.stringify(setting)}`,
    });
    return;
  }

  const notFound = config.assets?.not_found_handling ?? "none";
  for (const { domain, prefix } of upstreams) {
    const bare = prefix.slice(0, -1);
    const missing = [`${prefix}*`];
    // The build writes nothing at the unslashed path, so it reaches the Worker as a miss
    // unless not_found_handling answers misses from the site's files.
    if (notFound !== "none") missing.push(bare);
    const unlisted = missing.filter((pattern) => !patterns.includes(pattern));
    if (unlisted.length === 0) continue;
    const why = unlisted.includes(bare)
      ? `, and its not_found_handling ${JSON.stringify(notFound)} answers ${JSON.stringify(bare)} from the site's files`
      : "";
    faults.push({
      kind: "adapter",
      ...UNROUTED,
      line: `${treeOf(domain)}'s prefix ${JSON.stringify(prefix)} — ${JSON.stringify(file)} lists no ${quoteAll(unlisted)}${why}`,
    });
  }

  const prefixes = [...new Set(upstreams.map(({ prefix }) => prefix))];
  const declared =
    prefixes.length === 0
      ? "build.routing.upstreams declares no prefix"
      : `build.routing.upstreams declares ${prefixes.map((prefix) => JSON.stringify(prefix)).join(", ")}`;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      const path = pattern.slice(1);
      const under = prefixes.find((prefix) => path.startsWith(prefix) || path === prefix.slice(0, -1));
      if (under === undefined) continue;
      faults.push({
        kind: "adapter",
        ...EXCLUDED,
        line: `${JSON.stringify(pattern)} in ${JSON.stringify(file)} — under ${JSON.stringify(under)}`,
      });
      continue;
    }
    if (prefixes.some((prefix) => pattern === `${prefix}*` || pattern === prefix.slice(0, -1))) continue;
    faults.push({
      kind: "adapter",
      ...STRAY,
      line: `${JSON.stringify(pattern)} in ${JSON.stringify(file)} — ${declared}`,
    });
  }
}
