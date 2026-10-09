import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, relative, resolve as resolvePath, sep } from "node:path";
import { createServer as createViteServer } from "vite";
import type { ViteDevServer } from "vite";
import { openStoreReadOnly } from "@pagedeck/content";
import type { ContentStoreReader } from "@pagedeck/content";
import { documentHtml } from "./build.js";
import { installClientReferences } from "./client-reference-loader.js";
import { loadConfig } from "./config.js";
import type { LoadedBuildSection, LoadedConfig } from "./config.js";
import { rootProviderStackDigest } from "@pagedeck/islands/root-provider-check";
import { planEntries, renderEntryModule } from "./entries.js";
import { serveGeneratedEntries } from "./entry-modules.js";
import { ConfigError, describeError } from "./exit.js";
import { resolveFoldStrategy } from "./fold.js";
import { scanIslandFacts } from "./island-facts.js";
import type { IslandFacts } from "./island-facts.js";
import { contentOf, layoutContents } from "./layout.js";
import { collectPages } from "./pages.js";
import type { Page } from "./pages.js";
import { renderPage } from "./render.js";
import { workerConsentWarning, workerFallbackWarning } from "./scripts.js";
import { stamp, trackSiteModules } from "./site-modules.js";
import type { SiteModules } from "./site-modules.js";
import { installStylesheetStubs } from "./stylesheet-loader.js";

export interface DevServerInput {
  config: LoadedConfig;
  /** Installed before `config` loaded, so its imports are tracked too. */
  modules?: SiteModules;
  port?: number;
  host?: string;
  err(line: string): void;
}

export interface DevServer {
  readonly url: string;
  readonly port: number;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

const MISSING_BUILD_FIX =
  "add a build section to pagedeck.config.ts — build: { pages, components, content }";
const UNROUTED_FIX =
  "check the path, or run pagedeck sync if the store has not fetched this page yet";

const UNREADABLE_STORE_FIX = "run pagedeck sync if it has not been created yet";

const ROUTES_LISTED = 20;

/**
 * Vite's `/@id/` prefix and null-byte escape, spelled here because Vite exports
 * neither.
 */
const VIRTUAL_URL_PREFIX = "/@id/";
const NULL_BYTE_ESCAPE = "__x00__";

const FS_URL_PREFIX = "/@fs";

const POLL_INTERVAL = 250;

export function devOrigin(host: string, port: number): string {
  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${String(port)}`;
}

export async function startDevServer(
  input: DevServerInput,
): Promise<DevServer> {
  const { config } = input;
  const section = config.build;
  if (section === undefined) {
    throw new ConfigError(
      `Config "${config.configPath}": declares no build section, so pagedeck dev has no pages to serve — ${MISSING_BUILD_FIX}`,
    );
  }
  if (!existsSync(config.storePath)) {
    throw new ConfigError(
      `Config "${config.configPath}": no store to read at "${config.storePath}", so pagedeck dev has no pages to serve — ${UNREADABLE_STORE_FIX}`,
    );
  }
  const root = dirname(config.configPath);

  const { facts, clientComponents, warnings } = await scanIslandFacts({
    root,
    origin: config.configPath,
    modules: section.componentModules,
    components: section.components,
    css: (section.css ?? []).map((path) => resolvePath(root, path)),
  });
  for (const warning of warnings) input.err(warning);
  reportScriptWarnings(section, input.err);

  const entrySources = new Map<string, string>();

  const undo: (() => Promise<void> | void)[] = [];
  try {
    const stylesheets = installStylesheetStubs();
    undo.push(() => stylesheets.close());
    const modules = input.modules ?? trackSiteModules(root);
    if (input.modules === undefined) undo.push(() => modules.close());
    modules.leaveClientModules(
      new Set(Object.keys(clientComponents).map((id) => resolvePath(root, id))),
    );
    const references = await installClientReferences({
      clientComponents,
      registry: section.components,
    });
    undo.push(() => references.close());

    // Handed to Vite so HMR shares this origin; otherwise Vite opens its own
    // server on fixed port 24678.
    const http = createHttpServer();
    undo.push(async () => {
      http.closeAllConnections();
      // Guarded: `close()` on a server never opened errors and would mask the
      // real failure.
      if (!http.listening) return;
      await new Promise<void>((settle, reject) => {
        http.close((error) => {
          if (error === undefined) settle();
          else reject(error);
        });
      });
    });

    const vite = await createViteServer({
      configFile: false,
      logLevel: "warn",
      root,
      appType: "custom",
      server: { middlewareMode: true, hmr: { server: http } },
      plugins: [
        serveGeneratedEntries(entrySources, config.configPath),
        // Last: a site plugin ahead of these could claim the generated entries'
        // ids.
        ...(section.vite?.plugins ?? []),
      ],
    });
    undo.push(() => vite.close());

    const site = { current: siteState(config, section, root) };
    undo.push(
      watchSite({ vite, site, root, clientComponents, modules, err: input.err }),
    );

    const handler = pageHandler({
      ...input,
      site,
      facts,
      entrySources,
      vite,
    });
    // Appended, so Vite's own middlewares answer first.
    vite.middlewares.use((request, response, next) => {
      handler(request, response).catch(next);
    });
    http.on("request", vite.middlewares);

    const host = input.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(input.port ?? 0, host, resolve);
    });

    const closed = new Promise<void>((resolve) => {
      http.on("close", resolve);
    });

    const port = (http.address() as AddressInfo).port;
    return {
      url: devOrigin(host, port),
      port,
      closed,
      close: async () => {
        await unwind(undo);
      },
    };
  } catch (error) {
    await unwind(undo);
    throw error;
  }
}

async function unwind(undo: (() => Promise<void> | void)[]): Promise<void> {
  for (const close of undo.splice(0).reverse()) await close();
}

interface SiteState {
  config: LoadedConfig;
  section: LoadedBuildSection;
  foldStrategy: ReturnType<typeof resolveFoldStrategy>;
  styles: readonly string[];
}

function reportScriptWarnings(
  section: LoadedBuildSection,
  err: (line: string) => void,
): void {
  const warning = workerFallbackWarning(section.scripts);
  if (warning !== undefined) err(warning);
  const consent = workerConsentWarning(section.scripts);
  if (consent !== undefined) err(consent);
}

function siteState(
  config: LoadedConfig,
  section: LoadedBuildSection,
  root: string,
): SiteState {
  return {
    config,
    section,
    foldStrategy: resolveFoldStrategy(section.foldStrategy),
    styles: (section.css ?? []).map((path) =>
      devFileUrl(resolvePath(root, path), root),
    ),
  };
}

function devFileUrl(file: string, root: string): string {
  const inside = relative(root, file);
  if (inside === "" || inside.startsWith("..")) return `${FS_URL_PREFIX}${file}`;
  return `/${inside.split(sep).join("/")}`;
}

interface WatchInput {
  vite: ViteDevServer;
  site: { current: SiteState };
  root: string;
  clientComponents: IslandFacts["clientComponents"];
  modules: SiteModules;
  err(line: string): void;
}

function watchSite(input: WatchInput): () => void {
  const { site, root, clientComponents, modules } = input;
  const boundaries = new Set(
    Object.keys(clientComponents).map((id) => resolvePath(root, id)),
  );
  const watched = (): Map<string, string | undefined> =>
    new Map<string, string | undefined>([
      [resolvePath(root, site.current.config.configPath), undefined],
      ...Object.values(site.current.section.componentModules)
        .map((path) => resolvePath(root, path))
        .filter((path) => !boundaries.has(path))
        .map((path): [string, undefined] => [path, undefined]),
      ...modules.files(),
    ]);

  // An imported file starts from its stamp at import, so an edit made before
  // the next poll still counts. A module a new config adds has none.
  const seen = new Map<string, string>();
  const changes = (): string[] => {
    const changed: string[] = [];
    for (const [file, imported] of watched()) {
      const now = stamp(file);
      const before = seen.get(file) ?? imported;
      seen.set(file, now);
      if (before !== undefined && before !== now) changed.push(file);
    }
    return changed;
  };
  changes();
  let reading = Promise.resolve();
  const poll = setInterval(() => {
    const changed = changes();
    if (changed.length === 0) return;
    // Serialized: overlapping re-reads could leave the older config in
    // `site.current`.
    reading = reading.then(async () => {
      modules.changed(changed);
      await reread(input);
    });
  }, POLL_INTERVAL);
  poll.unref();
  return () => {
    clearInterval(poll);
  };
}

async function reread(input: WatchInput): Promise<void> {
  const { vite, site, root, err } = input;
  try {
    const config = await loadConfig(root, { reload: true });
    if (config.build === undefined) {
      throw new ConfigError(
        `Config "${config.configPath}": declares no build section, so pagedeck dev has no pages to serve — ${MISSING_BUILD_FIX}`,
      );
    }
    site.current = siteState(config, config.build, root);
    reportScriptWarnings(config.build, err);
    vite.ws.send({ type: "full-reload" });
  } catch (error) {
    const message = describeError(error);
    err(message);
    vite.ws.send({
      type: "error",
      err: { message, stack: stackChain(error) },
    });
  }
}

interface HandlerInput extends DevServerInput {
  site: { current: SiteState };
  facts: IslandFacts["facts"];
  entrySources: Map<string, string>;
  vite: ViteDevServer;
}

function pageHandler(
  input: HandlerInput,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { site, vite } = input;

  return async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(
        `Dev server: ${request.method ?? "this method"} is not a request this server answers — request a page with GET\n`,
      );
      return;
    }

    const { config, section, foldStrategy, styles } = site.current;
    const url = request.url ?? "/";
    const path = requestPath(url);
    let store: ContentStoreReader | undefined;
    try {
      store = openStore(config.storePath);
      // The clock, deliberately: a dev server answers what the site looks like
      // now.
      const pages = collectPages(store, section.pages, new Date().toISOString());
      const page = matchPage(pages, hostOf(request), path);
      if (page === undefined) {
        respondText(
          response,
          404,
          unroutedReport(quotedRequestPath(url), pages),
        );
        return;
      }
      const html = await renderDocument({
        ...input,
        section,
        page,
        store,
        foldStrategy,
        styles,
      });
      respondHtml(response, await vite.transformIndexHtml(path, html));
    } catch (error) {
      await respondFailure(input, response, path, error);
    } finally {
      store?.close();
    }
  };
}

function openStore(storePath: string): ContentStoreReader {
  try {
    return openStoreReadOnly(storePath);
  } catch (cause) {
    throw new Error(
      `Dev server: no store to read at "${storePath}" — ${UNREADABLE_STORE_FIX}`,
      { cause },
    );
  }
}

async function renderDocument(input: {
  section: LoadedBuildSection;
  facts: HandlerInput["facts"];
  entrySources: Map<string, string>;
  page: Page;
  store: ContentStoreReader;
  foldStrategy: ReturnType<typeof resolveFoldStrategy>;
  styles: readonly string[];
}): Promise<string> {
  const { section, page, store } = input;
  const layouts = layoutContents([page], store, section.components);
  const content = await contentOf(page, layouts, store, section.content);
  const chrome = await section.chrome?.(page, store);
  const locale = section.pages.locales.get(page.locale);
  const rendered = await renderPage({
    ...content,
    ...(chrome === undefined ? {} : { chrome }),
    page: { locale: page.locale, path: page.path },
    ...(locale === undefined ? {} : { locale }),
    registry: section.components,
    ...(section.rootProviders === undefined
      ? {}
      : { providers: section.rootProviders.stack }),
    modules: input.facts,
    ...(input.foldStrategy === undefined
      ? {}
      : { foldStrategy: input.foldStrategy }),
  });

  const plan = planEntries([{ page, islands: rendered.islands }], {
    modules: section.componentModules,
    ...(section.rootProviders === undefined
      ? {}
      : {
          providers: section.rootProviders.module,
          providersDigest: rootProviderStackDigest(section.rootProviders.stack),
        }),
  });
  const entry = plan.entries[0];
  if (entry !== undefined) {
    input.entrySources.set(entry.id, renderEntryModule(entry, { hot: true }));
  }

  return documentHtml({
    page,
    html: rendered.html,
    absorbed: rendered.absorbed,
    ...(rendered.chrome === undefined ? {} : { chrome: rendered.chrome }),
    styles: input.styles,
    script: entry === undefined ? undefined : virtualModuleUrl(entry.id),
    inlineStyles: [],
    head: await section.head?.(page, store),
    links: undefined,
    section,
  });
}

function virtualModuleUrl(id: string): string {
  return `${VIRTUAL_URL_PREFIX}${id.replace("\0", NULL_BYTE_ESCAPE)}`;
}

function requestPath(url: string): string {
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function quotedRequestPath(url: string): string {
  return url.includes("?") ? `${requestPath(url)}?…` : requestPath(url);
}

function hostOf(request: IncomingMessage): string | undefined {
  const header = request.headers.host;
  if (header === undefined) return undefined;
  return header.replace(/:\d+$/, "");
}

function matchPage(
  pages: readonly Page[],
  host: string | undefined,
  path: string,
): Page | undefined {
  const index = new Map<string, Page>();
  for (const page of pages) {
    const key = `${page.domain ?? ""} ${requestPath(page.output)}`;
    if (!index.has(key)) index.set(key, page);
  }
  return index.get(`${host ?? ""} ${path}`) ?? index.get(` ${path}`);
}

function unroutedReport(path: string, pages: readonly Page[]): string {
  const outputs = pages.map((page) => requestPath(page.output));
  const listed = outputs
    .slice(0, ROUTES_LISTED)
    .map((output) => `  "${output}"`);
  const rest = outputs.length - listed.length;
  if (rest > 0) listed.push(`  …and ${String(rest)} more`);
  return `Dev server: no page of this site is routed at "${path}" — ${UNROUTED_FIX}; this store holds ${String(outputs.length)} ${
    outputs.length === 1 ? "page" : "pages"
  }:\n${listed.join("\n")}\n`;
}

async function respondFailure(
  input: HandlerInput,
  response: ServerResponse,
  path: string,
  error: unknown,
): Promise<void> {
  const message = describeError(error);
  input.err(message);
  input.vite.ws.send({
    type: "error",
    err: { message, stack: stackChain(error) },
  });
  const html = await input.vite.transformIndexHtml(
    path,
    failureDocument(message),
  );
  respondHtml(response, html, 500);
}

function stackChain(error: unknown): string {
  const stacks: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    stacks.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (stacks.length === 0) stacks.push(String(error));
  return stacks.join("\nCaused by: ");
}

/**
 * Deliberately not `documentHtml`: the failure may be that there is no page.
 */
function failureDocument(message: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>pagedeck dev</title></head>',
    `<body><pre>${escapeText(message)}</pre></body>`,
    "</html>",
    "",
  ].join("\n");
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

function respondHtml(
  response: ServerResponse,
  html: string,
  status = 200,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(html);
}

function respondText(
  response: ServerResponse,
  status: number,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(body);
}
