import { ConfigError } from "./exit.js";
import { pageKey } from "./incremental.js";
import { quote } from "./quote.js";
import { fileKey } from "./manifest.js";
import type { EmittedFile } from "./manifest.js";
import { redirectIndex } from "./routing.js";
import type { ResolvedRedirect, RoutingManifest } from "./routing.js";

const LINK_FIX =
  "check each against the page or the file it should name: an asset URL and its file name are minted at two stages (see chunkPath in client-build.ts), and a route is served only where a page renders one";

export interface LinkCheckSetting {
  readonly broken?: BrokenLinkSetting | false;
  readonly external?: ExternalLinkSetting;
}

export type BrokenLinkSetting = "error" | "warn";

export type LinkProbe = (url: string) => Promise<number>;

export interface ExternalLinkSetting {
  readonly probe: LinkProbe;
  readonly limit?: number;
  readonly intervalMs?: number;
}

export const DEFAULT_EXTERNAL_LIMIT = 50;

export const DEFAULT_EXTERNAL_INTERVAL_MS = 1_000;

export interface ResolvedLinkCheck {
  broken: BrokenLinkSetting;
  external?: ExternalLinkSetting;
}

export function resolveLinkCheck(
  declared: LinkCheckSetting | undefined,
): ResolvedLinkCheck | undefined {
  const broken = declared?.broken ?? "error";
  if (broken === false) return undefined;
  return {
    broken,
    ...(declared?.external === undefined
      ? {}
      : { external: declared.external }),
  };
}

const LINKS_SHAPE_FIX = 'links: { broken: "warn" }';
const BROKEN_FIX =
  'write "error" to fail the build on a broken reference, "warn" to report it and let the build finish, or false to skip the check';
const LINKS_UNKNOWN_FIX =
  "delete the field, or correct it to one of: broken, external";
const EXTERNAL_SHAPE_FIX =
  'declare the probe this build asks each URL with, as external: { probe: async (url) => (await fetch(url, { method: "HEAD" })).status }';
const EXTERNAL_UNKNOWN_FIX =
  "delete the field, or correct it to one of: probe, limit, intervalMs";
const EXTERNAL_LIMIT_FIX =
  "write a whole number of requests above zero, such as { limit: 20 }";
const EXTERNAL_INTERVAL_FIX =
  "write a whole number of milliseconds, 0 or more, such as { intervalMs: 500 }";

export function linksFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.links" must be an object saying what a broken reference does — ${LINKS_SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const sections: string[] = [];

  const unknown = Object.keys(record).filter(
    (key) => key !== "broken" && key !== "external",
  );
  if (unknown.length > 0) {
    const subject =
      unknown.length === 1
        ? "declares 1 field this build does not read"
        : `declares ${String(unknown.length)} fields this build does not read`;
    sections.push(
      `${where}: "build.links" ${subject} — ${LINKS_UNKNOWN_FIX}:\n${unknown
        .map((key) => `  ${JSON.stringify(key)}`)
        .join("\n")}`,
    );
  }

  const broken = Object.hasOwn(record, "broken") ? record["broken"] : undefined;
  if (
    broken !== undefined &&
    broken !== false &&
    broken !== "error" &&
    broken !== "warn"
  ) {
    sections.push(
      `${where}: "build.links" declares a setting no reference check can take — ${BROKEN_FIX}:\n  ${quote(broken)} — not a reference-check setting`,
    );
  }

  const external = Object.hasOwn(record, "external")
    ? record["external"]
    : undefined;
  if (external !== undefined) {
    sections.push(...externalFaults(external, where));
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}

function externalFaults(value: unknown, where: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [
      `${where}: "build.links.external" must be an object holding the probe this build asks each URL with — ${EXTERNAL_SHAPE_FIX}`,
    ];
  }
  const record = value as Record<string, unknown>;
  const sections: string[] = [];

  const unknown = Object.keys(record).filter(
    (key) => key !== "probe" && key !== "limit" && key !== "intervalMs",
  );
  if (unknown.length > 0) {
    const subject =
      unknown.length === 1
        ? "declares 1 field this build does not read"
        : `declares ${String(unknown.length)} fields this build does not read`;
    sections.push(
      `${where}: "build.links.external" ${subject} — ${EXTERNAL_UNKNOWN_FIX}:\n${unknown
        .map((key) => `  ${JSON.stringify(key)}`)
        .join("\n")}`,
    );
  }

  const probe = Object.hasOwn(record, "probe") ? record["probe"] : undefined;
  if (typeof probe !== "function") {
    sections.push(
      `${where}: "build.links.external" names no probe for this build to ask each URL with, and this framework ships none — ${EXTERNAL_SHAPE_FIX}`,
    );
  }

  const limit = Object.hasOwn(record, "limit") ? record["limit"] : undefined;
  const reason = limit === undefined ? undefined : limitFault(limit);
  if (reason !== undefined) {
    sections.push(
      `${where}: "build.links.external" declares a limit that is not a count of requests — ${EXTERNAL_LIMIT_FIX}:\n  ${quote(limit)} — ${reason}`,
    );
  }

  const intervalMs = Object.hasOwn(record, "intervalMs")
    ? record["intervalMs"]
    : undefined;
  const paceReason =
    intervalMs === undefined ? undefined : intervalFault(intervalMs);
  if (paceReason !== undefined) {
    sections.push(
      `${where}: "build.links.external" declares an interval that is not a wait between requests — ${EXTERNAL_INTERVAL_FIX}:\n  ${quote(intervalMs)} — ${paceReason}`,
    );
  }

  return sections;
}

function intervalFault(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value)) {
    return "not a whole number, and the interval counts milliseconds";
  }
  if (value < 0) {
    return "below zero, and a wait shorter than none is not a wait";
  }
  return undefined;
}

function limitFault(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value)) {
    return "not a whole number, and the limit counts requests";
  }
  if (value < 1) {
    return "below one, and a build that asks about no URL is what leaving the field out already gives";
  }
  return undefined;
}

export interface LinkCheckInput {
  documents: readonly EmittedFile[];
  emitted: readonly EmittedFile[];
  routing: RoutingManifest;
}

export interface BrokenReference {
  page: string;
  href: string;
}

export interface RedirectedReference {
  page: string;
  href: string;
  to: string;
}

export interface ExternalReference {
  url: string;
  pages: readonly string[];
}

export interface LinkReport {
  broken: readonly BrokenReference[];
  redirected: readonly RedirectedReference[];
  external: readonly ExternalReference[];
}

type ReferenceKind = "asset" | "route";

interface Reference {
  kind: ReferenceKind;
  url: string;
}

/**
 * Not `<iframe>`, `<object>` or `<embed>`: each embeds another document, most
 * often another origin's, which no build can answer for (#31).
 */
function references(html: string): Reference[] {
  const found = (
    pattern: RegExp,
    kind: ReferenceKind,
    list: boolean,
  ): Reference[] =>
    [...html.matchAll(pattern)].flatMap((match) =>
      (list ? candidates(match[1] as string) : [match[1] as string]).map(
        // Decoded after the split: `&#44;` is a comma, and would split a
        // candidate.
        (url) => ({ kind, url: decodeEntities(url) }),
      ),
    );
  // `\s`, not `\b`, before the name: `\b` matches after the `-` of `data-src` (#649).
  return [
    ...found(/<script\b[^>]*\ssrc="([^"]*)"/g, "asset", false),
    ...found(/<link\b[^>]*\shref="([^"]*)"/g, "asset", false),
    ...found(/<img\b[^>]*\ssrc="([^"]*)"/g, "asset", false),
    ...found(/<img\b[^>]*\ssrcset="([^"]*)"/gi, "asset", true),
    ...found(/<source\b[^>]*\ssrc="([^"]*)"/g, "asset", false),
    ...found(/<source\b[^>]*\ssrcset="([^"]*)"/gi, "asset", true),
    ...found(/<video\b[^>]*\ssrc="([^"]*)"/g, "asset", false),
    ...found(/<video\b[^>]*\sposter="([^"]*)"/g, "asset", false),
    ...found(/<audio\b[^>]*\ssrc="([^"]*)"/g, "asset", false),
    ...found(/<a\b[^>]*\shref="([^"]*)"/g, "route", false),
  ];
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(#\d+|#[xX][0-9a-fA-F]+|amp|lt|gt|quot|apos);/g,
    (reference, body: string) => {
      const character = named[body];
      if (character !== undefined) return character;
      const code = Number.parseInt(
        body.slice(body.startsWith("#x") || body.startsWith("#X") ? 2 : 1),
        body.startsWith("#x") || body.startsWith("#X") ? 16 : 10,
      );
      return code > 0x10ffff
        ? (reference as string)
        : String.fromCodePoint(code);
    },
  );
}

function candidates(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim().split(/\s+/)[0] as string)
    .filter((url) => url !== "");
}

const OFF_ORIGIN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

type ReferenceTarget =
  | { readonly at: "off-origin" }
  | { readonly at: "unservable" }
  | { readonly at: "rooted"; readonly path: string }
  | { readonly at: "relative"; readonly href: string };

/**
 * A route ignores its query; an asset carrying one is served by something other
 * than this tree, since no deploy key holds a `?`.
 */
function referenceTarget(reference: Reference): ReferenceTarget {
  if (OFF_ORIGIN.test(reference.url)) return { at: "off-origin" };
  const addressed = reference.url.split("#")[0] as string;
  if (addressed === "") return { at: "unservable" };
  if (reference.kind === "asset" && addressed.includes("?"))
    return { at: "unservable" };
  const path = addressed.split("?")[0] as string;
  return addressed.startsWith("/")
    ? { at: "rooted", path }
    : { at: "relative", href: path };
}

export function referenceTargets(
  html: string,
): readonly { reference: Reference; target: ReferenceTarget }[] {
  return references(html).map((reference) => ({
    reference,
    target: referenceTarget(reference),
  }));
}

export function emittedKeys(files: readonly EmittedFile[]): Set<string> {
  return new Set(files.map((file) => fileKey(file.domain, file.path)));
}

/**
 * A route may also name a file outright: an `<a href>` to a PDF is ordinary.
 */
function resolves(
  emitted: ReadonlySet<string>,
  reference: Reference,
  domain: string | undefined,
  path: string,
): boolean {
  if (emitted.has(fileKey(domain, path))) return true;
  if (reference.kind === "asset") return false;
  return emitted.has(fileKey(domain, `${path.replace(/\/+$/, "")}/index.html`));
}

export function checkLinks(input: LinkCheckInput): LinkReport {
  const emitted = emittedKeys(input.emitted);
  const redirect = redirectIndex(input.routing);
  const broken: BrokenReference[] = [];
  const redirected: RedirectedReference[] = [];
  const external = new Map<string, string[]>();

  for (const file of input.documents) {
    if (file.kind !== "html") continue;
    const where = file.page === undefined ? file.path : pageKey(file.page);
    const reported = new Set<string>();
    for (const { reference, target } of referenceTargets(
      textOf(file.contents),
    )) {
      if (target.at !== "rooted") {
        if (target.at === "off-origin" && EXTERNAL_URL.test(reference.url)) {
          const pages = external.get(reference.url) ?? [];
          if (!pages.includes(where)) pages.push(where);
          external.set(reference.url, pages);
        }
        continue;
      }
      const path = target.path;
      if (resolves(emitted, reference, file.domain, path)) continue;
      if (reported.has(reference.url)) continue;
      reported.add(reference.url);
      const rule = redirectOf(redirect, file.domain, path);
      if (rule === undefined) {
        broken.push({ page: where, href: reference.url });
      } else {
        redirected.push({ page: where, href: reference.url, to: rule.to });
      }
    }
  }

  return {
    broken,
    redirected,
    external: [...external].map(([url, pages]) => ({ url, pages })),
  };
}

const EXTERNAL_URL = /^https?:\/\//i;

/**
 * Catches `canonicalizePath`'s throw: an href is content, and one bad path must
 * not end the whole pass.
 */
function redirectOf(
  redirect: ReturnType<typeof redirectIndex>,
  domain: string | undefined,
  path: string,
): ResolvedRedirect | undefined {
  try {
    return redirect(domain, path);
  } catch {
    return undefined;
  }
}

/**
 * Sequential on purpose, and never fails a build over what a host answers: a
 * retry fixes that (rule 7). Only a probe returning a non-status is refused.
 */
export async function probeExternalLinks(input: {
  references: readonly ExternalReference[];
  external: ExternalLinkSetting;
}): Promise<readonly string[]> {
  const limit = input.external.limit ?? DEFAULT_EXTERNAL_LIMIT;
  const interval = input.external.intervalMs ?? DEFAULT_EXTERNAL_INTERVAL_MS;
  const asked = input.references.slice(0, limit);
  const unchecked = input.references.slice(limit);

  const answered: string[] = [];
  const unreachable: string[] = [];
  const unusable: string[] = [];
  let previous: number | undefined;
  for (const reference of asked) {
    if (previous !== undefined) await pace(previous, interval);
    previous = Date.now();
    let status: number;
    try {
      status = await input.external.probe(reference.url);
    } catch (thrown) {
      unreachable.push(
        `  ${quote(reference.url)} — ${describe(thrown)} — linked from ${reference.pages.join(", ")}`,
      );
      continue;
    }
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      unusable.push(`  ${quote(reference.url)} — answered ${quote(status)}`);
      continue;
    }
    if (status >= 400) {
      answered.push(
        `  ${quote(reference.url)} — ${String(status)} — linked from ${reference.pages.join(", ")}`,
      );
    }
  }

  if (unusable.length > 0) {
    throw new ConfigError(
      `Site build: the external link probe answered with something that is not an HTTP status ${
        unusable.length === 1 ? "once" : `${String(unusable.length)} times`
      } — ${PROBE_FIX}:\n${[...unusable].sort().join("\n")}`,
    );
  }

  return [
    ...(answered.length === 0
      ? []
      : [
          `Site build: ${
            answered.length === 1
              ? "1 external reference answered with a status a reader will not see the page at"
              : `${String(answered.length)} external references answered with statuses a reader will not see the pages at`
          } — check the link, or the host behind it; this build asks each URL once and takes the status its probe answers with. This is a warning and never a refusal, because a host this site does not control is not this site's wiring and the same URL usually answers on the next run:\n${answered.join("\n")}`,
        ]),
    ...(unreachable.length === 0
      ? []
      : [
          `Site build: ${
            unreachable.length === 1
              ? "1 external reference could not be checked, because the external link probe this site declared threw"
              : `${String(unreachable.length)} external references could not be checked, because the external link probe this site declared threw`
          } — the fault is the network, the host or the probe's own client rather than the page, so nothing here says the link is broken. This is a warning and never a refusal, because a build whose success depends on another host's uptime fails on a Sunday for a reason no reader can act on:\n${unreachable.join("\n")}`,
        ]),
    ...(unchecked.length === 0
      ? []
      : [
          `Site build: ${
            unchecked.length === 1
              ? "1 external reference was not checked"
              : `${String(unchecked.length)} external references were not checked`
          }, because this build reached the ${String(limit)} requests "build.links.external.limit" allows — raise the limit, or read this as the check having stopped rather than as a link that answered:\n${unchecked
            .map(
              (reference) =>
                `  ${quote(reference.url)} — linked from ${reference.pages.join(", ")}`,
            )
            .join("\n")}`,
        ]),
  ];
}

function pace(since: number, interval: number): Promise<void> {
  const remaining = interval - (Date.now() - since);
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, remaining));
}

/**
 * URLs in a thrown message are cut too: undici's names the request (rule 6).
 */
function describe(thrown: unknown): string {
  const message =
    thrown instanceof Error
      ? `${thrown.name}: ${thrown.message}`
      : String(thrown);
  return message.replace(/https?:\/\/\S+/gi, (url) => cutQuery(url));
}

function cutQuery(url: string): string {
  const at = url.search(/[?#]/);
  return at === -1 ? url : `${url.slice(0, at + 1)}…`;
}

const PROBE_FIX =
  'return the status code the request came back with, as probe: async (url) => (await fetch(url, { method: "HEAD" })).status';

function lines(
  faults: readonly (BrokenReference | RedirectedReference)[],
): string {
  return faults
    .map(
      (fault) =>
        `  ${fault.page} — ${quote(fault.href)}${"to" in fault ? ` → ${quote(fault.to)}` : ""}`,
    )
    .sort()
    .join("\n");
}

function brokenSubject(count: number): string {
  return count === 1
    ? "Site build: 1 reference names nothing this build emitted"
    : `Site build: ${String(count)} references name nothing this build emitted`;
}

export function movedReferences(input: {
  reused: readonly EmittedFile[];
  emitted: readonly EmittedFile[];
  routing: RoutingManifest;
  previous: ReadonlySet<string>;
}): BrokenReference[] {
  return checkLinks({
    documents: input.reused,
    emitted: input.emitted,
    routing: input.routing,
  }).broken.filter((fault) => input.previous.has(fault.href.replace(/[?#].*$/s, "")));
}

export function movedReferenceReport(
  moved: readonly BrokenReference[],
  bundles: number,
): string {
  const pages = new Set(moved.map((fault) => fault.page)).size;
  return `Site build: ${String(pages)} ${pages === 1 ? "page" : "pages"} this build reuses still ${pages === 1 ? "names" : "name"} ${moved.length === 1 ? "a chunk or stylesheet" : "chunks or stylesheets"} this build did not emit after ${String(bundles)} ${bundles === 1 ? "bundle" : "bundles"} — each bundle after the first renders again every reused page the one before found naming a file it did not emit, and an incremental build runs no more bundles than that — run pagedeck build to write the whole site again:\n${lines(moved)}`;
}

/**
 * The external half runs last: a build about to be refused should not first
 * spend a minute probing other people's hosts.
 */
export async function checkSiteLinks(input: {
  files: readonly EmittedFile[];
  routing: RoutingManifest;
  check: ResolvedLinkCheck;
}): Promise<readonly string[]> {
  const report = checkLinks({
    documents: input.files,
    emitted: input.files,
    routing: input.routing,
  });

  if (report.broken.length > 0 && input.check.broken === "error") {
    throw new ConfigError(
      `${brokenSubject(report.broken.length)} — ${LINK_FIX}:\n${lines(report.broken)}`,
    );
  }

  return [
    ...(report.broken.length === 0
      ? []
      : [
          `${brokenSubject(report.broken.length)} — ${LINK_FIX}. This is a warning and not a refusal because "build.links" declares broken: "warn":\n${lines(report.broken)}`,
        ]),
    ...(report.redirected.length === 0
      ? []
      : [
          `Site build: ${
            report.redirected.length === 1
              ? "1 reference resolves through a redirect — point it at the target on the line below"
              : `${String(report.redirected.length)} references resolve through redirects — point each at the target on its own line below`
          }, so a visitor's first request is the page rather than a hop. This is a warning and not a refusal because the redirect works and the page it lands on is one this build emitted:\n${lines(report.redirected)}`,
        ]),
    ...(input.check.external === undefined
      ? []
      : await probeExternalLinks({
          references: report.external,
          external: input.check.external,
        })),
  ];
}

export function textOf(contents: string | Uint8Array): string {
  return typeof contents === "string"
    ? contents
    : Buffer.from(contents).toString("utf8");
}
