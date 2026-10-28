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
  fix: "correct it where the cause says; wrangler refuses the same file when it deploys",
};

const UNREAD = {
  subject: {
    one: "wrangler file cannot be read",
    many: "wrangler files cannot be read",
  },
  fix: "make it a file this user can read, or remove it; the build reads it to check assets.run_worker_first against build.routing.upstreams",
};

const MISSHAPEN = {
  subject: {
    one: "wrangler file's assets.run_worker_first is neither true, false nor a list of patterns",
    many: "wrangler files' assets.run_worker_first are neither true, false nor lists of patterns",
  },
  fix: 'write a list of patterns, the two for each prefix in build.routing.upstreams, such as ["/api", "/api/*"]',
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
  fix: 'list the two patterns for each prefix in build.routing.upstreams instead, such as ["/api", "/api/*"], or pass cloudflarePages({ runWorkerFirst: true }) to run the app before every request on purpose; true makes each built page cost a Worker invocation',
};

const UNMET = {
  subject: {
    one: "opt-in to run_worker_first: true is not met by the site's wrangler file",
    many: "opt-ins to run_worker_first: true are not met by the site's wrangler files",
  },
  fix: 'set assets.run_worker_first to true in wrangler.jsonc beside pagedeck.config.ts, or remove runWorkerFirst from cloudflarePages() and list the two patterns for each prefix in build.routing.upstreams, such as ["/api", "/api/*"]; the build holds the wrangler file to what the adapter says',
};

const UNROUTED = {
  subject: {
    one: "prefix in build.routing.upstreams does not reach the app through assets.run_worker_first",
    many: "prefixes in build.routing.upstreams do not reach the app through assets.run_worker_first",
  },
  fix: "add each pattern its line names to assets.run_worker_first in the wrangler file, the prefix followed by * and its unslashed path, since Cloudflare does not document that * matches nothing; Workers Static Assets answers a request no pattern matches from the site's files, so it never reaches the app",
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

// Each comment and trailing comma becomes spaces, newlines kept, so a parse error's line and
// column are the file's own. An unterminated comment or string is left for JSON.parse to refuse.
function blankJsonc(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    let end: number | undefined;
    if (text.startsWith("//", index)) {
      const newline = text.indexOf("\n", index);
      end = newline === -1 ? text.length : newline;
    } else if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      end = close === -1 ? undefined : close + 2;
    }
    if (end === undefined) {
      out += char;
      index += 1;
      continue;
    }
    out += text.slice(index, end).replace(/[^\n]/g, " ");
    index = end;
  }
  return out.replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, (_match, string?: string) =>
    string ?? " ",
  );
}

function isTomlPagesProject(text: string): boolean {
  const topLevel = text.split(/^\s*\[/m)[0] ?? "";
  return /^\s*pages_build_output_dir\s*=/m.test(topLevel);
}

// run_worker_first takes "glob patterns with * for deep matching"
// (https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first): `*`
// matches any run of characters, `/` included, and every other character only itself.
function globStates(glob: string, text: string): ReadonlySet<number> {
  const close = (states: Iterable<number>): Set<number> => {
    const closed = new Set<number>();
    for (let state of states) {
      closed.add(state);
      while (glob[state] === "*") closed.add(++state);
    }
    return closed;
  };
  let states = close([0]);
  for (const char of text) {
    const next: number[] = [];
    for (const state of states) {
      if (glob[state] === "*") next.push(state);
      else if (glob[state] === char) next.push(state + 1);
    }
    states = close(next);
  }
  return states;
}

function matchesUnder(glob: string, prefix: string): boolean {
  return globStates(glob, unslashed(prefix)).has(glob.length) || globStates(glob, prefix).size > 0;
}

function unslashed(prefix: string): string {
  return prefix.slice(0, -1);
}

function quoteAll(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(" or ");
}

interface WranglerConfig {
  pages_build_output_dir?: unknown;
  assets?: { run_worker_first?: unknown };
}

interface Upstream {
  domain: string | undefined;
  prefix: string;
}

function patternsOf(setting: unknown): readonly string[] | undefined {
  if (setting === false) return [];
  if (!Array.isArray(setting)) return undefined;
  return setting.every((pattern) => typeof pattern === "string") ? (setting as string[]) : undefined;
}

function readWrangler(root: string, faults: Fault[]): { file: string; text: string } | undefined {
  const name = NAMES.find((candidate) => existsSync(join(root, candidate)));
  if (name === undefined) return undefined;
  const file = join(root, name);
  try {
    return { file, text: readFileSync(file, "utf8") };
  } catch (cause) {
    faults.push({ kind: "adapter", ...UNREAD, line: JSON.stringify(file), cause });
    return undefined;
  }
}

function parseWrangler(file: string, text: string, faults: Fault[]): WranglerConfig | undefined {
  try {
    return JSON.parse(blankJsonc(text)) as WranglerConfig;
  } catch (cause) {
    faults.push({ kind: "adapter", ...UNPARSED, line: JSON.stringify(file), cause });
    return undefined;
  }
}

function checkPatterns(
  file: string,
  patterns: readonly string[],
  upstreams: readonly Upstream[],
  faults: Fault[],
): void {
  for (const { domain, prefix } of upstreams) {
    const unlisted = [`${prefix}*`, unslashed(prefix)].filter((pattern) => !patterns.includes(pattern));
    if (unlisted.length === 0) continue;
    faults.push({
      kind: "adapter",
      ...UNROUTED,
      line: `${treeOf(domain)}'s prefix ${JSON.stringify(prefix)} — ${JSON.stringify(file)} lists no ${quoteAll(unlisted)}`,
    });
  }

  const prefixes = [...new Set(upstreams.map(({ prefix }) => prefix))];
  const declared =
    prefixes.length === 0
      ? "build.routing.upstreams declares no prefix"
      : `build.routing.upstreams declares ${prefixes.map((prefix) => JSON.stringify(prefix)).join(", ")}`;
  for (const pattern of patterns) {
    const where = `${JSON.stringify(pattern)} in ${JSON.stringify(file)}`;
    if (pattern.startsWith("!")) {
      const under = prefixes.find((prefix) => matchesUnder(pattern.slice(1), prefix));
      if (under === undefined) continue;
      faults.push({
        kind: "adapter",
        ...EXCLUDED,
        line: `${where} — it matches a path under ${JSON.stringify(under)}`,
      });
      continue;
    }
    if (prefixes.some((prefix) => pattern === `${prefix}*` || pattern === unslashed(prefix))) continue;
    faults.push({ kind: "adapter", ...STRAY, line: `${where} — ${declared}` });
  }
}

/**
 * On Workers Static Assets the site's own wrangler file sends each upstream prefix to the app
 * (ADR-0010), so it is held to `build.routing.upstreams` here.
 */
export function checkWrangler(
  manifest: RoutingManifest,
  faults: Fault[],
  site: AdapterSite | undefined,
  runWorkerFirst: boolean,
): void {
  if (site === undefined) return;
  const unmet = (line: string): void => {
    if (runWorkerFirst) faults.push({ kind: "adapter", ...UNMET, line });
  };
  if (!NAMES.some((name) => existsSync(join(site.root, name)))) {
    unmet(`no wrangler.json or wrangler.jsonc in ${JSON.stringify(site.root)}`);
    return;
  }
  const read = readWrangler(site.root, faults);
  if (read === undefined) return;
  const { file, text } = read;
  const pagesProject = `${JSON.stringify(file)} is a Cloudflare Pages project, which has no run_worker_first`;
  const upstreams = manifest.trees.flatMap((tree) =>
    (tree.upstreams ?? []).map(({ prefix }) => ({ domain: tree.domain, prefix })),
  );

  if (file.endsWith(".toml")) {
    if (isTomlPagesProject(text)) unmet(pagesProject);
    else if (upstreams.length > 0 || runWorkerFirst) {
      faults.push({ kind: "adapter", ...TOML, line: JSON.stringify(file) });
    }
    return;
  }

  const config = parseWrangler(file, text, faults);
  if (config === undefined) return;
  if (config.pages_build_output_dir !== undefined) {
    unmet(pagesProject);
    return;
  }

  const raw = config.assets?.run_worker_first;
  if (runWorkerFirst) {
    if (raw !== true) {
      const sets = raw === undefined ? "sets none" : `sets it to ${JSON.stringify(raw)}`;
      unmet(`${JSON.stringify(file)} ${sets}`);
    }
    return;
  }
  const setting = raw ?? false;
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
  checkPatterns(file, patterns, upstreams, faults);
}
