import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, quoteIdentifier, readManifest } from "@pagedeck/core";
import { netlify } from "@pagedeck/adapter-netlify";
import type { EdgeOutput } from "@pagedeck/edge";
import { pageFacts, redactOrigin } from "./parity.js";
import type { BuiltSite, PageFacts, ParityBaseline, RedirectFact } from "./parity.js";

const MANIFEST_FILE = "manifest.json";

// `netlify`: its `/_redirects` table is text, so reading it back is a split rather
// than an interpreter.
const REDIRECTS_FILE = "/_redirects";

// Core's derived `!` rows and the `/*` 404 row are dropped: neither is a move the
// site declared.
export function redirectRows(compiled: EdgeOutput): readonly RedirectFact[] {
  const table = compiled.artifacts.find(
    (artifact) => artifact.role === "tree-file" && artifact.path === REDIRECTS_FILE,
  );
  if (table === undefined) return [];

  const rows: RedirectFact[] = [];
  for (const line of table.contents.split("\n")) {
    const [from, to, status] = line.trim().split(/\s+/);
    if (from === undefined || to === undefined || status === undefined) continue;
    if (from.includes("*") || status.endsWith("!")) continue;
    rows.push({ from, to, status: Number(status) });
  }
  return rows;
}

// Off the manifest, not a directory walk: a page the build meant to write and did
// not then lands in `missingFromBuild`.
export async function readBuiltSite(outDir: string): Promise<BuiltSite> {
  const file = join(outDir, MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (cause) {
    throw new ConfigError(
      `Parity build ${quoteIdentifier(outDir)}: has no ${MANIFEST_FILE}, so there is no build to read parity facts off — run pagedeck build, or pass --build the directory one wrote`,
      { cause },
    );
  }
  const manifest = readManifest(text, file);

  const pages: PageFacts[] = [];
  for (const page of manifest.pages) {
    const url = page.output === "" ? "/" : page.output;
    const document = join(outDir, page.output, "index.html");
    let html: string;
    try {
      html = await readFile(document, "utf8");
    } catch {
      // Not a throw: the missing page is reported as `missingFromBuild`.
      continue;
    }
    pages.push(pageFacts(url, 200, html));
  }

  return {
    pages,
    redirects: redirectRows(netlify().compile(manifest.routing)),
  };
}

interface Fetched {
  readonly status: number;
  readonly location: string | undefined;
  readonly html: string;
}

// `redirect: "manual"`: a followed redirect is a fact the reader would consume and
// not record.
async function get(origin: string, url: string): Promise<Fetched> {
  const response = await fetch(`${origin}${url}`, { redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("location") ?? undefined,
    html: await response.text(),
  };
}

export interface CaptureRequest {
  readonly origin: string;
  readonly urls: readonly string[];
  readonly redirects: readonly string[];
  readonly at: string;
}

export async function captureBaseline(
  request: CaptureRequest,
): Promise<ParityBaseline> {
  const { origin, at } = request;
  const pages: PageFacts[] = [];
  const failures: string[] = [];

  for (const url of request.urls) {
    const answer = await get(origin, url);
    if (answer.status !== 200) {
      failures.push(
        `  ${url}: ${String(answer.status)}${answer.location === undefined ? "" : ` to ${answer.location}`}`,
      );
      continue;
    }
    pages.push(pageFacts(url, answer.status, answer.html));
  }

  const redirects: RedirectFact[] = [];
  for (const url of request.redirects) {
    const answer = await get(origin, url);
    if (answer.location === undefined) {
      failures.push(
        `  ${url}: ${String(answer.status)} with no location header, so it is not a redirect`,
      );
      continue;
    }
    redirects.push({ from: url, to: answer.location, status: answer.status });
  }

  if (failures.length > 0) {
    throw new ConfigError(
      `Parity capture from "${redactOrigin(origin)}": ${String(failures.length)} of ${String(request.urls.length + request.redirects.length)} URLs did not answer as a baseline needs them to — a baseline recorded from an origin that does not serve the site would make every later report a comparison against a mistake:\n${failures.join("\n")}`,
    );
  }

  // Stored redacted, not only printed: a baseline is a document somebody commits.
  return {
    origin: { kind: "captured", from: redactOrigin(origin), at },
    pages,
    redirects,
  };
}

export function readBaseline(text: string, file: string): ParityBaseline {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`Parity baseline ${quoteIdentifier(file)}: is not valid JSON`, {
      cause,
    });
  }
  const document = parsed as Partial<ParityBaseline>;
  const kind = document.origin?.kind;
  if (kind !== "captured" && kind !== "declared") {
    throw new ConfigError(
      `Parity baseline ${quoteIdentifier(file)}: has no origin, so nothing it is compared against could say where it came from — a baseline records "captured" with the origin it was recorded from, or "declared" with what it is a statement of`,
    );
  }
  if (!Array.isArray(document.pages) || !Array.isArray(document.redirects)) {
    throw new ConfigError(
      `Parity baseline ${quoteIdentifier(file)}: has no "pages" or no "redirects" array — write both, empty if that is what the site has; a missing array and an empty one are different facts`,
    );
  }
  return document as ParityBaseline;
}
