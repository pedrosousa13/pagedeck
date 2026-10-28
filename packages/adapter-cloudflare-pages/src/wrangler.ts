import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

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

function unmet(name: string) {
  return {
    subject: {
      one: "opt-in to run_worker_first: true is not met by the site's wrangler file",
      many: "opt-ins to run_worker_first: true are not met by the site's wrangler files",
    },
    fix: `set assets.run_worker_first to true in ${name}, or remove runWorkerFirst from cloudflarePages() and list the two patterns for each prefix in build.routing.upstreams, such as ["/api", "/api/*"]; the build holds the wrangler file to what the adapter says`,
  };
}

const UNHELD = {
  subject: {
    one: "opt-in to run_worker_first: true has no Workers Static Assets wrangler file to hold",
    many: "opt-ins to run_worker_first: true have no Workers Static Assets wrangler files to hold",
  },
  fix: "remove runWorkerFirst from cloudflarePages(); only a wrangler.json or wrangler.jsonc of a Worker with static assets, beside pagedeck.config.ts, has assets.run_worker_first",
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

function readWrangler(
  root: string,
  faults: Fault[],
): { file: string; text: string } | "absent" | undefined {
  const name = NAMES.find((candidate) => existsSync(join(root, candidate)));
  if (name === undefined) return "absent";
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

type Wrangler =
  | { kind: "absent"; root: string }
  | { kind: "pages"; file: string }
  | { kind: "toml"; file: string }
  | { kind: "workers"; file: string; setting: unknown };

function loadWrangler(root: string, faults: Fault[]): Wrangler | undefined {
  const read = readWrangler(root, faults);
  if (read === "absent") return { kind: "absent", root };
  if (read === undefined) return undefined;
  const { file, text } = read;
  if (file.endsWith(".toml")) {
    return isTomlPagesProject(text) ? { kind: "pages", file } : { kind: "toml", file };
  }
  const config = parseWrangler(file, text, faults);
  if (config === undefined) return undefined;
  if (config.pages_build_output_dir !== undefined) return { kind: "pages", file };
  return { kind: "workers", file, setting: config.assets?.run_worker_first };
}

function upstreamsOf(manifest: RoutingManifest): readonly Upstream[] {
  return manifest.trees.flatMap((tree) =>
    (tree.upstreams ?? []).map(({ prefix }) => ({ domain: tree.domain, prefix })),
  );
}

type Hold = (wrangler: Wrangler, upstreams: readonly Upstream[], faults: Fault[]) => void;

const holdToTrue: Hold = (wrangler, upstreams, faults) => {
  switch (wrangler.kind) {
    case "absent":
      faults.push({
        kind: "adapter",
        ...UNHELD,
        line: `no ${NAMES.slice(0, -1).join(", ")} or ${NAMES.at(-1)!} in ${JSON.stringify(wrangler.root)}`,
      });
      return;
    case "pages":
      faults.push({
        kind: "adapter",
        ...UNHELD,
        line: `${JSON.stringify(wrangler.file)} is a Cloudflare Pages project, which has no run_worker_first`,
      });
      return;
    case "toml":
      holdToml(wrangler.file, upstreams, faults);
      return;
    case "workers": {
      const { file, setting } = wrangler;
      if (setting === true) return;
      const sets = setting === undefined ? "sets none" : `sets it to ${JSON.stringify(setting)}`;
      faults.push({ kind: "adapter", ...unmet(basename(file)), line: `${JSON.stringify(file)} ${sets}` });
    }
  }
};

const holdToUpstreams: Hold = (wrangler, upstreams, faults) => {
  if (wrangler.kind === "toml") holdToml(wrangler.file, upstreams, faults);
  if (wrangler.kind !== "workers") return;
  const { file } = wrangler;
  const setting = wrangler.setting ?? false;
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
};

function holdToml(file: string, upstreams: readonly Upstream[], faults: Fault[]): void {
  if (upstreams.length > 0) faults.push({ kind: "adapter", ...TOML, line: JSON.stringify(file) });
}

/**
 * On Workers Static Assets the site's own wrangler file sends each upstream prefix to the app
 * (ADR-0010), so it is held to `build.routing.upstreams` here, or, with the opt-in, to `true`.
 */
export function wranglerCheck(
  runWorkerFirst: boolean,
): (manifest: RoutingManifest, faults: Fault[], site: AdapterSite | undefined) => void {
  const hold = runWorkerFirst ? holdToTrue : holdToUpstreams;
  return (manifest, faults, site) => {
    if (site === undefined) return;
    const wrangler = loadWrangler(site.root, faults);
    if (wrangler !== undefined) hold(wrangler, upstreamsOf(manifest), faults);
  };
}
