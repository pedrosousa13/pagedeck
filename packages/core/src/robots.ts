import { ConfigError } from "./exit.js";
import { localeTree } from "./locales.js";
import type { LocaleSet } from "./locales.js";
import { collisionLines } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import { quote } from "./quote.js";
import { sitemapIndexUrl } from "./sitemap.js";

export interface RobotsSetting {
  readonly disallow?: readonly string[];
  readonly allow?: readonly string[];
  readonly verbatim?: readonly string[];
}

const SHAPE_FIX = 'robots: { disallow: ["/admin"] }';

// `example-bot`, not a real crawler: no vendor's token ships in this source
// (#438).
const VERBATIM_FIX =
  'verbatim: ["User-agent: example-bot", "Disallow: /drafts"]';

const SEPARATOR = /\s/;

export function robotsFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  const sections: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    sections.push(
      `${where}: "build.robots" must be an object holding the directives the site adds — ${SHAPE_FIX}`,
    );
  } else {
    const faults = settingFaults(value as Record<string, unknown>);
    if (faults.length > 0) {
      sections.push(
        `${where}: "build.robots" declares ${String(faults.length)} ${
          faults.length === 1 ? "field" : "fields"
        } this build cannot write a robots.txt from — declare each as the type its own line names:\n${faults.join("\n")}`,
      );
    }
  }
  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function settingFaults(record: Record<string, unknown>): string[] {
  const faults: string[] = [];
  const verbatim = Object.hasOwn(record, "verbatim")
    ? record["verbatim"]
    : undefined;
  if (verbatim !== undefined && !Array.isArray(verbatim)) {
    faults.push(
      `  ${JSON.stringify("verbatim")} — ${quote(verbatim)} — not a list of lines — list the lines to write above the group, one string per line — ${VERBATIM_FIX}`,
    );
  } else if (Array.isArray(verbatim)) {
    (verbatim as readonly unknown[]).forEach((line, index) => {
      if (typeof line === "string") return;
      faults.push(
        `  ${JSON.stringify(`verbatim[${String(index)}]`)} — ${quote(line)} — not a line a robots.txt can hold — write each entry as the text of one line, which this build writes into the file unread — ${VERBATIM_FIX}`,
      );
    });
  }
  for (const key of ["disallow", "allow"] as const) {
    const declared = Object.hasOwn(record, key) ? record[key] : undefined;
    if (declared === undefined) continue;
    if (!Array.isArray(declared)) {
      faults.push(
        `  ${JSON.stringify(key)} — ${quote(declared)} — not a list of paths — list the paths crawlers ${
          key === "disallow" ? "must not" : "may"
        } fetch — ${key}: ["/admin"]`,
      );
      continue;
    }
    (declared as readonly unknown[]).forEach((path, index) => {
      if (
        typeof path === "string" &&
        path.startsWith("/") &&
        !SEPARATOR.test(path)
      ) {
        return;
      }
      faults.push(
        `  ${JSON.stringify(`${key}[${String(index)}]`)} — ${quote(path)} — not a path a robots.txt rule can hold — write the path a crawler would request, starting at the root, with any space percent-encoded as %20 — ${key}: ["/admin"]`,
      );
    });
  }
  return faults;
}

const ROBOTS_PATH = "/robots.txt";

export interface RobotsInput {
  setting: RobotsSetting;
  origin: string | undefined;
  sitemaps: boolean;
  locales: LocaleSet;
  emitted: readonly EmittedFile[];
}

export function robotsFiles(input: RobotsInput): readonly EmittedFile[] {
  // `""`, not `undefined`: `sort` moves `undefined` last without calling the
  // comparator.
  const trees = new Map<string, { code: string; domain?: string }>();
  for (const locale of input.locales.values()) {
    const key = localeTree(locale) ?? "";
    const held = trees.get(key);
    if (held === undefined || locale.code < held.code) trees.set(key, locale);
  }
  const domains = [...trees.keys()].sort();

  const files: EmittedFile[] = domains.map((domain) => ({
    ...(domain === "" ? {} : { domain }),
    path: ROBOTS_PATH,
    kind: "asset",
    contents: policyText(
      input.setting,
      input.sitemaps && input.origin !== undefined
        ? sitemapIndexUrl(input.origin, trees.get(domain)?.domain)
        : undefined,
    ),
  }));

  const collisions = collisionLines(files, input.emitted);
  if (collisions.length > 0) {
    throw new ConfigError(
      `Robots: ${String(collisions.length)} ${
        collisions.length === 1 ? "file is" : "files are"
      } at a deploy key this build already wrote — a deploy key holds one file, and the site's own pages, chunks and assets are written before the robots.txt is; move the page off that address:\n${collisions.join("\n")}`,
    );
  }
  return files;
}

function policyText(
  setting: RobotsSetting,
  sitemap: string | undefined,
): string {
  const rules = [
    ...(setting.disallow ?? []).map((path) => `Disallow: ${path}`),
    ...(setting.allow ?? []).map((path) => `Allow: ${path}`),
  ];
  const verbatim = setting.verbatim ?? [];
  const sections: string[] = [];
  // The site's lines first: a group ends only at a `user-agent` line or the end
  // of the file, so lines after the `*` group would join it (RFC 9309, #438).
  if (verbatim.length > 0) sections.push(verbatim.join("\n"));
  if (rules.length > 0) sections.push(["User-agent: *", ...rules].join("\n"));
  if (sitemap !== undefined) sections.push(`Sitemap: ${sitemap}`);
  return sections.length === 0 ? "" : `${sections.join("\n\n")}\n`;
}
