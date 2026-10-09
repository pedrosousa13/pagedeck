import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize as normalizePath } from "node:path";
import { promisify } from "node:util";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { budgetReportPath, readManifest } from "@pagedeck/core";
import {
  emittedHashes,
  hashInsensitiveGzip,
  runtimeSplit,
  servedUrl,
  totalBytes,
} from "./audit.js";
import { BASELINE_URLS } from "./parity-baseline.js";
import type {
  AuditBudget,
  PayloadBytes,
  RuntimeCeiling,
  RuntimeSplit,
} from "./audit.js";

const execFileAsync = promisify(execFile);

export const AUDIT_URLS: readonly string[] = BASELINE_URLS;

// Transfer bytes over the uncompressed local origin, measured; derivation in
// AGENTS.md, "The site audit harnesses".
export const BUDGETS: Readonly<Record<string, AuditBudget>> = {
  "/de/": { scriptBytes: 0, scriptRequests: 0 },
  "/en/": { scriptBytes: 0, scriptRequests: 0 },
  "/en/legal/terms/": { scriptBytes: 0, scriptRequests: 0 },
  "/en/pricing/": { scriptBytes: 225 * 1024, scriptRequests: 4 },
};

// Cited from `docs/research/2026-08-23-app-router-static-export.md`, never
// re-measured: no twin is reachable from this repository (#53).
export const TWIN_PAYLOAD = {
  content: { raw: 452_538, gzip: 133_120 },
  interactive: { raw: 452_538 + 283, gzip: 133_120 },
} as const;

// Per URL, not derived from the build: a page that started shipping JavaScript would
// otherwise be compared against the generous baseline.
export const TWIN_PAGE_KIND: Readonly<
  Record<string, keyof typeof TWIN_PAYLOAD>
> = {
  "/de/": "content",
  "/en/": "content",
  "/en/legal/terms/": "content",
  "/en/pricing/": "interactive",
};

// Measured minimums on Lighthouse 13.4.1, a ratchet. `performance` is timing-derived
// and never floored (#57).
export const SCORE_FLOORS: Readonly<Record<string, number>> = {
  accessibility: 100,
  "best-practices": 96,
  seo: 100,
};

const FW = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");

// A scratch directory: `site.build.test.ts` builds this package's root, and Vitest
// runs files in parallel.
export async function buildAuditSite(site: string): Promise<string> {
  return buildScratchSite(site, [
    'import { siteConfig } from "@pagedeck/site";',
    "",
    "export default siteConfig();",
  ]);
}

async function buildScratchSite(
  site: string,
  config: readonly string[],
): Promise<string> {
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "pagedeck.config.ts"), [...config, ""].join("\n"));
  for (const verb of ["sync", "build"]) {
    await execFileAsync(process.execPath, [FW, verb], { cwd: site });
  }
  return join(site, "site");
}

// No default: a chunk served as `application/octet-stream` does not run, and a page
// that does not hydrate passes a script budget.
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export interface ServedOrigin {
  readonly origin: string;
  close(): Promise<void>;
}

// Uncompressed on purpose: `BUDGETS` is written in uncompressed transfer bytes, and
// a host's compression is the host's choice.
export function serveBuild(root: string): Promise<ServedOrigin> {
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const inside = normalizePath(path)
      .replace(/^(\.\.[/\\])+/, "")
      .replace(/^[/\\]+/, "");
    const file = [join(root, inside), join(root, inside, "index.html")].find(
      (one) => existsSync(one) && statSync(one).isFile(),
    );
    if (file === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const type = CONTENT_TYPES[extname(file)];
    if (type === undefined) {
      response.statusCode = 500;
      response.end(
        `Audit origin "${path}": the build emitted a "${extname(file)}" file and this server maps no content type for it, so a browser would not know what to do with it — add the type to CONTENT_TYPES in packages/site/src/audit-site.ts`,
      );
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", type);
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

export interface PagePayload {
  readonly url: string;
  readonly chunks: readonly (PayloadBytes & { readonly path: string })[];
  readonly total: PayloadBytes;
}

// Declared here: `BudgetReport` is internal to `@pagedeck/core`.
interface BudgetRow {
  locale: string;
  path: string;
  chunks: readonly { path: string; bytes: number }[];
}

// gzip at level 9: the twin's figures are `gzip -9`.
export function measurePayload(root: string, out: string): readonly PagePayload[] {
  const report = JSON.parse(readFileSync(budgetReportPath(root), "utf8")) as {
    pages: readonly BudgetRow[];
  };
  const manifest = join(out, "manifest.json");
  const { trailingSlash } = readManifest(readFileSync(manifest, "utf8"), manifest).site;
  return report.pages.map((row) => {
    const chunks = row.chunks.map((chunk) => {
      const bytes = readFileSync(
        join(out, chunk.path.startsWith("/") ? chunk.path.slice(1) : chunk.path),
      );
      return {
        path: chunk.path,
        raw: bytes.byteLength,
        gzip: gzipSync(bytes, { level: 9 }).byteLength,
        brotli: brotliCompressSync(bytes).byteLength,
      };
    });
    return {
      url: servedUrl(row, trailingSlash),
      chunks,
      total: totalBytes(chunks),
    };
  });
}

export const RUNTIME_URL = "/en/pricing/";

export const REACT_CHUNK = "fw-measure-react";

// A ratchet: lowered when the runtime shrinks, and raised only by a ruling
// recorded under criterion 2 of `docs/success-criteria.md`.
export const RUNTIME_CEILING: RuntimeCeiling = { raw: 6_714, gzip: 3_404 };

// React in a chunk of its own, so the framework's bytes read off files (#292). The
// plugin is source text: a generated config resolves only published exports (#182).
export async function buildRuntimeSite(site: string): Promise<string> {
  return buildScratchSite(site, [
    'import { siteConfig } from "@pagedeck/site";',
    "",
    "const site = siteConfig();",
    "const react = {",
    `  name: ${JSON.stringify(REACT_CHUNK)},`,
    "  priority: Number.MAX_SAFE_INTEGER,",
    "  minSize: 0,",
    "  minShareCount: 1,",
    "  test: /[\\\\/]node_modules[\\\\/](?:react|react-dom|scheduler)[\\\\/]/,",
    "};",
    "",
    "export default {",
    "  ...site,",
    "  build: {",
    "    ...site.build,",
    "    vite: {",
    "      plugins: [",
    "        ...(site.build.vite?.plugins ?? []),",
    "        {",
    `          name: ${JSON.stringify(REACT_CHUNK)},`,
    "          outputOptions: (options) => ({",
    "            ...options,",
    "            codeSplitting: {",
    "              ...options.codeSplitting,",
    "              groups: [react, ...options.codeSplitting.groups],",
    "            },",
    "          }),",
    "        },",
    "      ],",
    "    },",
    "  },",
    "};",
  ]);
}

export function measureRuntime(root: string, out: string): RuntimeSplit {
  const page = measurePayload(root, out).find((one) => one.url === RUNTIME_URL);
  if (page === undefined) {
    throw new Error(
      `Runtime bytes "${RUNTIME_URL}": the build's budget report has no row for this page, so there is nothing to measure — check that packages/site/src/site.ts still publishes it`,
    );
  }
  const hashes = emittedHashes(readdirSync(join(out, "assets")));
  const chunks = page.chunks.map((chunk) => ({
    ...chunk,
    gzip: hashInsensitiveGzip(
      readFileSync(join(out, chunk.path.startsWith("/") ? chunk.path.slice(1) : chunk.path)),
      hashes,
    ),
  }));
  return runtimeSplit({ url: page.url, react: REACT_CHUNK, chunks });
}
