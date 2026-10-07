import vm from "node:vm";

import type { HeaderField, RedirectStatus } from "@pagedeck/core/routing";

import type { EdgeArtifact } from "./artifact.js";
import { UNSERVED_KEY } from "./reserved-keys.js";
import type { EdgeRequest, Resolution } from "./oracle.test-support.js";
import { objectKey, originStandIn, runWorker } from "./worker.test-support.js";
import type { StoredObject } from "./worker.test-support.js";

function forTree(
  artifacts: readonly EdgeArtifact[],
  domain: string | undefined,
): readonly EdgeArtifact[] {
  return artifacts.filter((artifact) => artifact.domain === domain);
}

function find(
  artifacts: readonly EdgeArtifact[],
  path: string,
): EdgeArtifact | undefined {
  return artifacts.find((artifact) => artifact.path === path);
}

// Case-insensitive (RFC 9110): CloudFront keys `response.headers` in lowercase. Sorted, because
// the Fetch API's `Headers` iterates by name and field order carries no meaning.
function normalize(fields: readonly HeaderField[]): readonly HeaderField[] {
  return fields
    .map((field) => ({ name: field.name.toLowerCase(), value: field.value }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export function comparable(resolution: Resolution): Resolution {
  if (resolution.kind === "not-found" && !("document" in resolution)) {
    return { kind: "not-found" };
  }
  return "headers" in resolution && resolution.headers !== undefined
    ? { ...resolution, headers: normalize(resolution.headers) }
    : resolution;
}

// `node:vm` cannot link the one `import` without `--experimental-vm-modules`, so `cf` is a
// context global.
async function runFunction(
  source: string,
  event: unknown,
  store: ReadonlyMap<string, string>,
): Promise<unknown> {
  const context = vm.createContext({
    cf: {
      kvs: () => ({
        get: (key: string): Promise<string> => {
          const value = store.get(key);
          // The real `get` throws on a miss.
          if (value === undefined) throw new Error(`no key ${key}`);
          return Promise.resolve(value);
        },
      }),
    },
  });
  const stripped = source.replace(/^import cf from "cloudfront";\n/m, "");
  const handler = vm.runInContext(`${stripped}\nhandler`, context) as (
    e: unknown,
  ) => unknown;
  return handler(event);
}

interface CloudFrontResponse {
  statusCode?: number;
  headers?: Record<string, { value: string }>;
}

function fields(
  headers: Record<string, { value: string }> | undefined,
): HeaderField[] {
  return Object.entries(headers ?? {}).map(([name, field]) => ({
    name,
    value: field.value,
  }));
}

async function viewerResponseHeaders(
  tree: readonly EdgeArtifact[],
  event: object,
  store: ReadonlyMap<string, string>,
  statusCode: number,
): Promise<HeaderField[]> {
  const viewerResponse = find(tree, "routing.response.js");
  if (viewerResponse === undefined) return [];
  const response = { statusCode, headers: {} as Record<string, unknown> };
  const result = (await runFunction(
    viewerResponse.contents,
    { ...event, response },
    store,
  )) as CloudFrontResponse;
  return fields(result.headers);
}

function keyValueStore(tree: readonly EdgeArtifact[]): Map<string, string> {
  const dataset = tree.find((artifact) => artifact.role === "dataset");
  const store = new Map<string, string>();
  if (dataset === undefined) return store;
  const parsed = JSON.parse(dataset.contents) as {
    data: readonly { key: string; value: string }[];
  };
  for (const row of parsed.data) store.set(row.key, row.value);
  return store;
}

export async function interpretCloudFront(
  artifacts: readonly EdgeArtifact[],
  request: EdgeRequest,
): Promise<Resolution> {
  const tree = forTree(artifacts, request.domain);
  const store = keyValueStore(tree);
  // `context` and `cookies` keep a split from throwing a `TypeError` inside the function.
  const event = {
    request: { uri: request.path, headers: {}, cookies: {} },
    context: { requestId: "equivalence" },
  };

  let found = request.found;
  const viewerRequest = find(tree, "routing.request.js");
  if (viewerRequest !== undefined) {
    const result = (await runFunction(
      viewerRequest.contents,
      event,
      store,
    )) as CloudFrontResponse;
    if (result.statusCode !== undefined) {
      const { location, ...rest } = result.headers ?? {};
      return {
        kind: "redirect",
        to: location?.value ?? "",
        status: result.statusCode as RedirectStatus,
        headers: fields(rest),
      };
    }
    if ((result as { uri?: string }).uri === UNSERVED_KEY) found = false;
  }

  if (!found) {
    const config = find(tree, "error-responses.json");
    if (config === undefined) return { kind: "not-found" };
    const parsed = JSON.parse(config.contents) as {
      CustomErrorResponses: {
        Items: readonly { ErrorCode: number; ResponsePagePath: string }[];
      };
    };
    const item = parsed.CustomErrorResponses.Items.find(
      (candidate) => candidate.ErrorCode === 404,
    );
    if (item === undefined) return { kind: "not-found" };
    return {
      kind: "not-found",
      document: item.ResponsePagePath,
      headers: await viewerResponseHeaders(tree, event, store, 404),
    };
  }

  return {
    kind: "pass",
    headers: await viewerResponseHeaders(tree, event, store, 200),
  };
}

function netlifyMatches(pattern: string, path: string): boolean {
  return pattern.endsWith("*")
    ? path.startsWith(pattern.slice(0, -1))
    : pattern === path;
}

function netlifyAnswer(
  from: string,
  to: string,
  status: string,
  headersFor: (path: string) => readonly HeaderField[],
): Resolution {
  if (status === "404") {
    return to === UNSERVED_KEY
      ? { kind: "not-found" }
      : { kind: "not-found", document: to, headers: headersFor(to) };
  }
  return {
    kind: "redirect",
    to,
    status: Number(status) as RedirectStatus,
    headers: headersFor(from),
  };
}

function netlifyHeaders(
  tree: readonly EdgeArtifact[],
): (path: string) => readonly HeaderField[] {
  const file = find(tree, "/_headers");
  const blocks = (file?.contents ?? "")
    .split("\n\n")
    .map((block) => block.replace(/\n$/, ""))
    .filter((block) => block !== "")
    .map((block) => {
      // Line 0 is the pattern: `planRouting` refuses a header name holding `/` (#317).
      const [pattern, ...lines] = block.split("\n");
      return {
        prefix: (pattern ?? "").replace(/\*$/, ""),
        set: lines.map((line) => {
          const at = line.indexOf(": ");
          return { name: line.slice(0, at).trim(), value: line.slice(at + 2) };
        }),
      };
    });
  return (path) =>
    blocks.find((candidate) => path.startsWith(candidate.prefix))?.set ?? [];
}

export function interpretNetlify(
  artifacts: readonly EdgeArtifact[],
  request: EdgeRequest,
): Resolution {
  const tree = forTree(artifacts, request.domain);
  const table = find(tree, "/_redirects");
  const rows = (table?.contents ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split(" "));
  const headersFor = netlifyHeaders(tree);

  const forced = rows.find(
    ([from, , status]) =>
      netlifyMatches(from ?? "", request.path) && (status ?? "").endsWith("!"),
  );
  if (forced !== undefined) {
    const [, to, status] = forced;
    return netlifyAnswer(
      request.path,
      to ?? "",
      (status ?? "").slice(0, -1),
      headersFor,
    );
  }

  if (!request.found) {
    const row = rows.find(([from]) => netlifyMatches(from ?? "", request.path));
    if (row !== undefined) {
      const [, to, status] = row;
      return netlifyAnswer(request.path, to ?? "", status ?? "", headersFor);
    }
    return { kind: "not-found" };
  }

  return { kind: "pass", headers: headersFor(request.path) };
}

function unquote(literal: string): string {
  return literal.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

// Decoded, as nginx's location algorithm reads it: the one place this does not mirror the
// emitter.
function nginxRequestUri(path: string): string {
  // Merged and dot-resolved too, because `$uri` is (`merge_slashes` is on by default).
  const merged = decodeURIComponent(path).replace(/\/{2,}/g, "/");
  const segments: string[] = [];
  for (const segment of merged.split("/").slice(1)) {
    if (segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

// `encodeURI` leaves `?` and `#` alone, and a canonical path always escapes them.
function routingSpelling(decoded: string): string {
  return encodeURI(decoded).replaceAll("?", "%3F").replaceAll("#", "%23");
}

const REDIRECT_LINE =
  /^location = ("(?:[^"\\]|\\.)*") \{ return (\d{3}) ("(?:[^"\\]|\\.)*"); \}$/;
const INTERNAL_LINE = /^location = ("(?:[^"\\]|\\.)*") \{ internal; \}$/;
const EXACT_LINE = /^location = ("(?:[^"\\]|\\.)*") \{$/;
const PREFIX_LINE = /^location \^~ ("(?:[^"\\]|\\.)*") \{$/;
const ADD_HEADER_LINE =
  /^ {4}add_header ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*") always;$/;
const RETURN_LINE = /^ {4}return (\d{3}) ("(?:[^"\\]|\\.)*");$/;
const ERROR_PAGE_LINE = /^error_page 404 ("(?:[^"\\]|\\.)*");$/;
const DENY_EXACT_LINE =
  /^if \(\$uri = ("(?:[^"\\]|\\.)*")\) \{ return 404; \}$/;
const DENY_PATTERN_LINE = /^if \(\$uri ~ "((?:[^"\\]|\\.)*)"\) \{ return 404; \}$/;

interface NginxLocation {
  set: HeaderField[];
  returned?: { to: string; status: number };
}

// nginx's precedence, not the emitter's order: exact `=` wins, then the longest `^~`.
export function interpretNginx(
  artifacts: readonly EdgeArtifact[],
  request: EdgeRequest,
): Resolution {
  const config = find(forTree(artifacts, request.domain), "routing.conf");
  const lines = (config?.contents ?? "").split("\n");

  const exact = new Map<string, NginxLocation>();
  const prefixes: (NginxLocation & { prefix: string })[] = [];
  let notFound: string | undefined;
  let open: NginxLocation | undefined;
  const denied: ((uri: string) => boolean)[] = [];

  for (const line of lines) {
    const exactDeny = DENY_EXACT_LINE.exec(line);
    if (exactDeny !== null) {
      const path = unquote(exactDeny[1] ?? "");
      denied.push((uri) => uri === path);
      continue;
    }
    // PCRE read as a JavaScript pattern: the one emitted reads the same in both engines.
    const patternDeny = DENY_PATTERN_LINE.exec(line);
    if (patternDeny !== null) {
      const pattern = new RegExp(patternDeny[1] ?? "");
      denied.push((uri) => pattern.test(uri));
      continue;
    }
    const redirect = REDIRECT_LINE.exec(line);
    if (redirect !== null) {
      exact.set(unquote(redirect[1] ?? ""), {
        set: [],
        returned: {
          to: unquote(redirect[3] ?? ""),
          status: Number(redirect[2]),
        },
      });
      continue;
    }
    const internal = INTERNAL_LINE.exec(line);
    if (internal !== null) {
      exact.set(unquote(internal[1] ?? ""), { set: [] });
      continue;
    }
    const opened = EXACT_LINE.exec(line);
    if (opened !== null) {
      open = { set: [] };
      exact.set(unquote(opened[1] ?? ""), open);
      continue;
    }
    const prefix = PREFIX_LINE.exec(line);
    if (prefix !== null) {
      const block = { prefix: unquote(prefix[1] ?? ""), set: [] };
      prefixes.push(block);
      open = block;
      continue;
    }
    const header = ADD_HEADER_LINE.exec(line);
    if (header !== null && open !== undefined) {
      open.set.push({
        name: unquote(header[1] ?? ""),
        value: unquote(header[2] ?? ""),
      });
      continue;
    }
    const returned = RETURN_LINE.exec(line);
    if (returned !== null && open !== undefined) {
      open.returned = {
        to: unquote(returned[2] ?? ""),
        status: Number(returned[1]),
      };
      continue;
    }
    const error = ERROR_PAGE_LINE.exec(line);
    if (error !== null) notFound = unquote(error[1] ?? "");
    if (line === "}") open = undefined;
  }

  const select = (uri: string): NginxLocation | undefined =>
    exact.get(uri) ??
    prefixes
      .filter((candidate) => uri.startsWith(candidate.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];

  const missing = (): Resolution =>
    notFound === undefined
      ? { kind: "not-found" }
      : {
          kind: "not-found",
          document: routingSpelling(notFound),
          headers: select(notFound)?.set ?? [],
        };

  const uri = nginxRequestUri(request.path);

  if (denied.some((deny) => deny(uri))) return missing();

  const answered = exact.get(uri)?.returned;
  if (answered !== undefined) {
    return {
      kind: "redirect",
      to: answered.to,
      status: answered.status as RedirectStatus,
      headers: exact.get(uri)?.set ?? [],
    };
  }
  if (!request.found) return missing();

  const longest = prefixes
    .filter((candidate) => uri.startsWith(candidate.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return { kind: "pass", headers: longest?.set ?? [] };
}

// A path whose last segment has no dot is a page, written as `<path>/index.html` as the build
// writes one; anything else is a file at its own path.
function documentOf(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".") ? path : `${path.replace(/\/+$/, "")}/index.html`;
}

const NOT_FOUND_LINE = /^var NOT_FOUND = (.*);$/m;

const REDIRECT_STATUSES: readonly number[] = [301, 302, 307, 308];

// The origin holds what the request says it holds, and the live manifest names it, even a
// reserved deploy key: the Worker has to refuse those on its own, not because the manifest
// left them out. Each object's body is the path it was stored for.
export async function interpretWorker(
  artifacts: readonly EdgeArtifact[],
  request: EdgeRequest,
): Promise<Resolution> {
  const worker = find(forTree(artifacts, request.domain), "worker.js");
  if (worker === undefined) throw new Error("no worker.js for this tree");
  const notFound = JSON.parse(
    NOT_FOUND_LINE.exec(worker.contents)?.[1] ?? "null",
  ) as string | null;

  const objects = new Map<string, StoredObject>();
  const files: { domain?: string; path: string }[] = [];
  const hold = (path: string): void => {
    const file = documentOf(path);
    files.push({
      ...(request.domain === undefined ? {} : { domain: request.domain }),
      path: file,
    });
    objects.set(objectKey(request.domain, file), { body: path });
  };
  if (notFound !== null) hold(notFound);
  if (request.found) hold(request.path);
  objects.set("manifest.json", { body: JSON.stringify({ files }) });

  const response = await runWorker(
    worker.contents,
    {
      method: "GET",
      url: new Request(`https://${request.domain ?? "default.test"}${request.path}`).url,
    },
    originStandIn(objects).binding,
  );
  // The etag belongs to the stored object, and the document says nothing about it.
  const fields = [...response.headers]
    .filter(([name]) => name !== "etag")
    .map(([name, value]) => ({ name, value }));

  if (REDIRECT_STATUSES.includes(response.status)) {
    return {
      kind: "redirect",
      to: response.headers.get("location") ?? "",
      status: response.status as RedirectStatus,
      headers: fields.filter((field) => field.name !== "location"),
    };
  }
  if (response.status === 404) {
    const body = await response.text();
    return notFound !== null && body === notFound
      ? { kind: "not-found", document: notFound, headers: fields }
      : { kind: "not-found", headers: fields };
  }
  if (response.status !== 200) {
    throw new Error(`worker.js answered ${String(response.status)}`);
  }
  return { kind: "pass", headers: fields };
}
