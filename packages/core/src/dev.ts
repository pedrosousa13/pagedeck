import { existsSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
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
import { covers } from "./routing.js";
import type { UpstreamRule } from "./routing.js";
import { workerConsentWarning, workerFallbackWarning } from "./scripts.js";
import { redactTarget } from "./snapshot.js";
import { stamp, trackSiteModules } from "./site-modules.js";
import type { SiteModules } from "./site-modules.js";
import { installStylesheetStubs } from "./stylesheet-loader.js";
import {
  entryLabel,
  upstreamImportCheck,
  upstreamImportReport,
  upstreamSources,
} from "./upstream-imports.js";
import type { UpstreamSources } from "./upstream-imports.js";

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

const UPSTREAMS = "build.routing.upstreams";
const NO_DEV_URL_FIX =
  'set "dev" to the http or https URL the app listens on while you develop, such as "http://localhost:8787"';

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
  const site = { current: siteState(config, section, root) };
  reportConfigFaults(site.current, input.err);

  const entrySources = new Map<string, string>();
  const entryNames = new Map<string, string>();

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
        upstreamImportCheck({
          root,
          origin: config.configPath,
          sources: () => site.current.upstreams.sources,
          entryName: (id) => entryNames.get(id),
          reached: (lines) => {
            const message = upstreamImportReport("Dev server", lines);
            input.err(message);
            throw new ConfigError(message);
          },
        }),
        serveGeneratedEntries(entrySources, config.configPath),
        // Last: a site plugin ahead of these could claim the generated entries'
        // ids.
        ...(section.vite?.plugins ?? []),
      ],
    });
    undo.push(() => vite.close());

    undo.push(
      watchSite({ vite, site, root, clientComponents, modules, err: input.err }),
    );

    const handler = pageHandler({
      ...input,
      site,
      facts,
      entrySources,
      entryNames,
      vite,
    });
    // Appended, so Vite's own middlewares answer first.
    vite.middlewares.use((request, response, next) => {
      handler(request, response).catch(next);
    });
    http.on("request", (request, response) => {
      const upstream = upstreamFor(site.current.section, request);
      if (upstream === undefined) vite.middlewares(request, response);
      else forwardRequest(upstream, request, response, input.err);
    });
    // Vite's own listener answers only its HMR path, "/", which no upstream
    // prefix covers, so the two never both write to one socket.
    http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const upstream = upstreamFor(site.current.section, request);
      if (upstream !== undefined) {
        forwardUpgrade(upstream, request, socket, head, input.err);
      }
    });

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
  upstreams: UpstreamSources;
  foldStrategy: ReturnType<typeof resolveFoldStrategy>;
  styles: readonly string[];
}

function reportConfigFaults(
  { section, upstreams }: SiteState,
  err: (line: string) => void,
): void {
  if (upstreams.missing !== undefined) err(upstreams.missing);
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
    upstreams: upstreamSources(
      root,
      config.configPath,
      section.routing?.upstreams ?? [],
    ),
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
    reportConfigFaults(site.current, err);
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
  entryNames: Map<string, string>;
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

interface Upstream {
  entry: string;
  prefix: string;
  dev: string | undefined;
  url: string;
  asked: string;
}

/** RFC 9110 §7.6.1, plus the `Proxy-` fields that only ever name one hop. */
const HOP_BY_HOP: readonly string[] = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
];

const NO_HOP_KEPT: ReadonlySet<string> = new Set();
const UPGRADE_KEPT: ReadonlySet<string> = new Set(["connection", "upgrade"]);

function upstreamFor(
  section: LoadedBuildSection,
  request: IncomingMessage,
): Upstream | undefined {
  const upstreams = section.routing?.upstreams ?? [];
  const url = request.url ?? "/";
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  const index = upstreamAt(upstreams, hostOf(request), path);
  const upstream = upstreams[index];
  if (upstream === undefined) return undefined;
  return {
    entry: `${UPSTREAMS}[${String(index)}]`,
    prefix: upstream.prefix,
    dev: upstream.dev,
    url,
    asked: query === -1 ? path : `${path}?…`,
  };
}

function noDevUrlMessage({ entry, prefix, asked }: Upstream): string {
  return `Dev server: ${entry} declares "${prefix}" with no "dev" URL, so pagedeck dev has no app to forward "${asked}" to — ${NO_DEV_URL_FIX}`;
}

function unansweredMessage(
  { entry, prefix, asked }: Upstream,
  dev: string,
  cause: unknown,
): string {
  const shown = redactTarget(dev);
  const code = (cause as NodeJS.ErrnoException).code ?? "no error code";
  return describeError(
    new Error(
      `Dev server: ${entry} forwards "${prefix}" to "${shown}", which did not answer "${asked}" (${code}) — start the app at "${shown}" first, or correct "dev" to the URL it listens on`,
      { cause },
    ),
  );
}

function hopByHop(
  connection: string | string[] | undefined,
  kept: ReadonlySet<string>,
): ReadonlySet<string> {
  const named = [connection ?? []]
    .flat()
    .flatMap((value) => value.split(","))
    .map((name) => name.trim().toLowerCase());
  return new Set(
    [...HOP_BY_HOP, ...named].filter((name) => name !== "" && !kept.has(name)),
  );
}

function forwardedHeaders(
  request: IncomingMessage,
  target: URL,
  kept: ReadonlySet<string>,
): IncomingHttpHeaders {
  const dropped = hopByHop(request.headers.connection, kept);
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !dropped.has(name)),
  );
  const chain = request.headers["x-forwarded-for"];
  const client = request.socket.remoteAddress;
  return {
    ...headers,
    host: target.host,
    ...(client === undefined
      ? {}
      : {
          "x-forwarded-for":
            chain === undefined ? client : `${chain}, ${client}`,
        }),
    ...(request.headers.host === undefined
      ? {}
      : { "x-forwarded-host": request.headers.host }),
    "x-forwarded-proto": "http",
  };
}

/** Flat name, value pairs, so a repeated `set-cookie` stays repeated. */
function answerHeaders(
  answer: IncomingMessage,
  kept: ReadonlySet<string>,
): string[] {
  const dropped = hopByHop(answer.headers.connection, kept);
  const raw = answer.rawHeaders;
  const headers: string[] = [];
  for (let at = 0; at + 1 < raw.length; at += 2) {
    const name = raw[at] as string;
    if (!dropped.has(name.toLowerCase())) headers.push(name, raw[at + 1] as string);
  }
  return headers;
}

function sendTo(
  dev: string,
  request: IncomingMessage,
  kept: ReadonlySet<string>,
): ClientRequest {
  const target = new URL(dev);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return send({
    protocol: target.protocol,
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: target.port,
    method: request.method,
    path: request.url ?? "/",
    headers: forwardedHeaders(request, target, kept),
  });
}

function forwardRequest(
  upstream: Upstream,
  request: IncomingMessage,
  response: ServerResponse,
  err: (line: string) => void,
): void {
  const { dev } = upstream;
  if (dev === undefined) {
    const message = noDevUrlMessage(upstream);
    err(message);
    respondText(response, 502, `${message}\n`);
    return;
  }

  const forwarded = sendTo(dev, request, NO_HOP_KEPT);
  forwarded.on("response", (answer) => {
    response.writeHead(
      answer.statusCode ?? 502,
      answer.statusMessage,
      answerHeaders(answer, NO_HOP_KEPT),
    );
    answer.on("error", (cause) => response.destroy(cause));
    answer.pipe(response);
  });
  let abandoned = false;
  forwarded.on("error", (cause) => {
    if (abandoned) return;
    if (response.headersSent) {
      response.destroy(cause);
      return;
    }
    const message = unansweredMessage(upstream, dev, cause);
    err(message);
    respondText(response, 502, `${message}\n`);
  });
  response.on("close", () => {
    if (response.writableFinished) return;
    abandoned = true;
    forwarded.destroy();
  });
  request.pipe(forwarded);
}

function forwardUpgrade(
  upstream: Upstream,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  err: (line: string) => void,
): void {
  const { dev } = upstream;
  if (dev === undefined) {
    const message = noDevUrlMessage(upstream);
    err(message);
    refuseUpgrade(socket, message);
    return;
  }

  const forwarded = sendTo(dev, request, UPGRADE_KEPT);
  let answered = false;
  let abandoned = false;
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    abandoned = true;
    forwarded.destroy();
  });
  forwarded.on("upgrade", (answer, app: Duplex, appHead: Buffer) => {
    answered = true;
    socket.write(statusHead(answer, answerHeaders(answer, UPGRADE_KEPT)));
    if (appHead.length > 0) socket.write(appHead);
    if (head.length > 0) app.write(head);
    app.on("error", () => socket.destroy());
    socket.on("close", () => app.destroy());
    app.pipe(socket).pipe(app);
  });
  forwarded.on("response", (answer) => {
    answered = true;
    socket.write(
      statusHead(answer, [
        ...answerHeaders(answer, NO_HOP_KEPT),
        "connection",
        "close",
      ]),
    );
    answer.on("error", () => socket.destroy());
    answer.pipe(socket);
  });
  forwarded.on("error", (cause) => {
    if (abandoned) return;
    if (answered) {
      socket.destroy();
      return;
    }
    const message = unansweredMessage(upstream, dev, cause);
    err(message);
    refuseUpgrade(socket, message);
  });
  forwarded.end();
}

function statusHead(answer: IncomingMessage, headers: readonly string[]): string {
  const lines = [
    `HTTP/1.1 ${String(answer.statusCode ?? 502)} ${answer.statusMessage ?? ""}`,
  ];
  for (let at = 0; at + 1 < headers.length; at += 2) {
    lines.push(`${headers[at] as string}: ${headers[at + 1] as string}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function refuseUpgrade(socket: Duplex, message: string): void {
  const body = Buffer.from(`${message}\n`);
  socket.end(
    Buffer.concat([
      Buffer.from(
        [
          "HTTP/1.1 502 Bad Gateway",
          "content-type: text/plain; charset=utf-8",
          `content-length: ${String(body.length)}`,
          "connection: close",
          "",
          "",
        ].join("\r\n"),
      ),
      body,
    ]),
  );
}

function upstreamAt(
  upstreams: readonly UpstreamRule[],
  host: string | undefined,
  path: string,
): number {
  const covering = (domain: string | undefined): number =>
    upstreams.findIndex(
      (rule) => rule.domain === domain && covers(rule.prefix, path),
    );
  const own = host === undefined ? -1 : covering(host);
  return own === -1 ? covering(undefined) : own;
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
  entryNames: Map<string, string>;
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
    input.entryNames.set(entry.id, entryLabel(entry));
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
