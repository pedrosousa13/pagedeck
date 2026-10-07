import {
  DEPLOY_DIRECTORY,
  DEPLOY_MANIFEST_PATH,
  offsiteReason,
} from "@pagedeck/core/routing";

import type { EdgeArtifact } from "./artifact.js";
import { jsLiteral } from "./encode.js";
import type { Fault } from "./faults.js";
import { treeOf } from "./faults.js";
import type { CompiledTree } from "./normalize.js";

/**
 * The Workers Free plan's script limit, read as decimal megabytes. Cloudflare measures it
 * compressed and this measures the text, which errs toward refusing.
 */
export const CLOUDFLARE_WORKER_LIMIT = 3 * 1000 * 1000;

export const WORKER_ORIGIN_BINDING = "PAGEDECK_ORIGIN";

// A domain tree's deploy keys carry `//<tree key>` (`fileKey`), and an R2 key is a deploy key
// without its leading `/`, the mapping the signing step uses.
function keyPrefix(domain: string | undefined): string {
  return domain === undefined ? "" : `//${domain}`;
}

function redirectTable(tree: CompiledTree): readonly string[] {
  return [
    "var REDIRECTS = new Map([",
    ...tree.redirects.map(
      (rule) =>
        `  [${jsLiteral(rule.from)}, { to: ${jsLiteral(rule.to)}, status: ${String(rule.status)} }],`,
    ),
    "]);",
  ];
}

function headerTable(tree: CompiledTree): readonly string[] {
  return [
    "var HEADERS = [",
    ...tree.headers.map((rule) => {
      const fields = rule.set
        .map(
          (field) =>
            `{ name: ${jsLiteral(field.name)}, value: ${jsLiteral(field.value)} }`,
        )
        .join(", ");
      return `  { prefix: ${jsLiteral(rule.prefix)}, set: [${fields}] },`;
    }),
    "];",
  ];
}

// The path is cut from `request.url` unparsed, so a dot segment the runtime passed through
// is still seen. Etags compare weakly (RFC 9110 §13.1.2); `uploaded` is cut to the whole
// second an HTTP-date holds.
const RUNTIME: readonly string[] = [
  "function headersFor(path, headers) {",
  "  for (var i = 0; i < HEADERS.length; i++) {",
  "    if (path.indexOf(HEADERS[i].prefix) !== 0) continue;",
  "    for (var j = 0; j < HEADERS[i].set.length; j++) {",
  "      headers.set(HEADERS[i].set[j].name, HEADERS[i].set[j].value);",
  "    }",
  "    break;",
  "  }",
  "  return headers;",
  "}",
  "",
  "function requestPath(url) {",
  '  var start = url.indexOf("/", url.indexOf("//") + 2);',
  '  if (start === -1) return "/";',
  '  var end = url.indexOf("?", start);',
  "  return end === -1 ? url.slice(start) : url.slice(start, end);",
  "}",
  "",
  "function decoded(path) {",
  "  if (/%2f|%5c|\\\\/i.test(path)) return null;",
  "  var text;",
  "  try {",
  "    text = decodeURIComponent(path);",
  "  } catch (malformed) {",
  "    return null;",
  "  }",
  "  if (/[\\u0000-\\u001f\\u007f]/.test(text)) return null;",
  '  var parts = text.split("/");',
  "  for (var at = 0; at < parts.length; at++) {",
  '    if (parts[at] === "." || parts[at] === "..") return null;',
  "  }",
  "  return text;",
  "}",
  "",
  "function reserved(text) {",
  '  var bare = "/" + text.split("/").filter(function (part) { return part !== ""; }).join("/");',
  "  return bare === DEPLOY_MANIFEST ||",
  "    bare === DEPLOY_DIRECTORY ||",
  '    bare.indexOf(DEPLOY_DIRECTORY + "/") === 0;',
  "}",
  "",
  "async function named(origin) {",
  "  var paths = new Set();",
  "  var live = await origin.get(DEPLOY_MANIFEST.slice(1));",
  "  if (live === null) return paths;",
  "  var files = JSON.parse(await live.text()).files;",
  "  for (var at = 0; at < files.length; at++) {",
  "    var domain = files[at].domain === undefined ? null : files[at].domain;",
  "    if (domain === DOMAIN) paths.add(files[at].path);",
  "  }",
  "  return paths;",
  "}",
  "",
  "async function read(origin, paths, path) {",
  '  var keys = path.endsWith("/") ? [path + "index.html"] : [path, path + "/index.html"];',
  "  for (var at = 0; at < keys.length; at++) {",
  "    if (paths.has(keys[at])) return await origin.get((KEY_PREFIX + keys[at]).slice(1));",
  "  }",
  "  return null;",
  "}",
  "",
  "function respond(request, object, status, path) {",
  "  var headers = new Headers();",
  "  object.writeHttpMetadata(headers);",
  '  return new Response(request.method === "HEAD" ? null : object.body, { status: status, headers: headersFor(path, headers) });',
  "}",
  "",
  'var MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";',
  "var IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d\\d) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\\d{4}) (\\d\\d):(\\d\\d):(\\d\\d) GMT$/;",
  "var RFC850_DATE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d\\d)-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\\d\\d) (\\d\\d):(\\d\\d):(\\d\\d) GMT$/;",
  "var ASCTIME_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([ \\d]\\d) (\\d\\d):(\\d\\d):(\\d\\d) (\\d{4})$/;",
  "",
  "function utc(year, month, day, hour, minute, second) {",
  "  return Date.UTC(year, MONTHS.indexOf(month) / 3, Number(day), Number(hour), Number(minute), Number(second));",
  "}",
  "",
  "function rfc850Year(digits) {",
  "  var now = new Date().getUTCFullYear();",
  "  var year = now - (now % 100) + Number(digits);",
  "  return year > now + 50 ? year - 100 : year;",
  "}",
  "",
  "function httpDate(text) {",
  "  var parts;",
  "  if (text === null) return NaN;",
  "  if ((parts = IMF_FIXDATE.exec(text)) !== null) return utc(Number(parts[3]), parts[2], parts[1], parts[4], parts[5], parts[6]);",
  "  if ((parts = RFC850_DATE.exec(text)) !== null) return utc(rfc850Year(parts[3]), parts[2], parts[1], parts[4], parts[5], parts[6]);",
  "  if ((parts = ASCTIME_DATE.exec(text)) !== null) return utc(Number(parts[6]), parts[1], parts[2], parts[3], parts[4], parts[5]);",
  "  return NaN;",
  "}",
  "",
  "function unchanged(request, object) {",
  '  var tags = request.headers.get("if-none-match");',
  "  if (tags !== null) {",
  '    if (tags.trim() === "*") return true;',
  '    var own = object.httpEtag.replace(/^W\\//, "");',
  '    var listed = tags.match(/(?:W\\/)?"[^"]*"/g) || [];',
  "    for (var at = 0; at < listed.length; at++) {",
  '      if (listed[at].replace(/^W\\//, "") === own) return true;',
  "    }",
  "    return false;",
  "  }",
  '  var since = httpDate(request.headers.get("if-modified-since"));',
  "  return !isNaN(since) && Math.floor(object.uploaded.getTime() / 1000) * 1000 <= since;",
  "}",
  "",
  "function serve(request, object, path) {",
  "  var headers = new Headers();",
  "  object.writeHttpMetadata(headers);",
  "  headersFor(path, headers);",
  '  headers.set("etag", object.httpEtag);',
  "  if (unchanged(request, object)) return new Response(null, { status: 304, headers: headers });",
  '  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers: headers });',
  "}",
  "",
  "async function missing(request, origin, paths, path) {",
  "  if (NOT_FOUND !== null) {",
  "    var page = await read(origin, paths, NOT_FOUND);",
  "    if (page !== null) return respond(request, page, 404, NOT_FOUND);",
  "  }",
  '  return new Response(request.method === "HEAD" ? null : "Not Found", { status: 404, headers: headersFor(path, new Headers()) });',
  "}",
  "",
  "export default {",
  "  async fetch(request, env) {",
  "    var origin = env[ORIGIN];",
  "    var path = requestPath(request.url);",
  '    if (request.method !== "GET" && request.method !== "HEAD") {',
  "      var refused = headersFor(path, new Headers());",
  '      refused.set("allow", "GET, HEAD");',
  "      return new Response(null, { status: 405, headers: refused });",
  "    }",
  "    var text = decoded(path);",
  "    if (text === null || reserved(text)) return missing(request, origin, await named(origin), path);",
  "    var rule = REDIRECTS.get(path);",
  "    if (rule !== undefined) {",
  "      var headers = headersFor(path, new Headers());",
  '      headers.set("location", rule.to);',
  "      return new Response(null, { status: rule.status, headers: headers });",
  "    }",
  "    var paths = await named(origin);",
  "    var object = await read(origin, paths, path);",
  "    if (object === null) return missing(request, origin, paths, path);",
  "    return serve(request, object, path);",
  "  },",
  "};",
];

export function compileWorker(
  tree: CompiledTree,
  _limit: number | undefined,
  faults: Fault[],
): readonly EdgeArtifact[] {
  // Refused, not dropped: compiling the rest would ship the primary with no word that the split
  // is gone.
  if (tree.experiments !== undefined) {
    const pages = tree.experiments.map((split) => `"${split.path}"`).join(", ");
    faults.push({
      kind: "unsupported",
      line: `${treeOf(tree.domain)}'s ${
        tree.experiments.length === 1 ? "experiment" : "experiments"
      } on ${pages} (build.routing.experiments)`,
    });
  }
  // `planRouting` refuses these; a compiler is handed a document, not necessarily one it wrote.
  for (const rule of tree.redirects) {
    if (rule.normalizing) continue;
    const why = offsiteReason(rule.to, "target");
    if (why !== undefined) {
      faults.push({
        kind: "offsite",
        line: `${treeOf(tree.domain)}'s redirect target on "${rule.from}" — ${why}`,
      });
    }
  }

  const contents = [
    "// Generated by @pagedeck/edge from the routing document. Do not edit.",
    `// Cloudflare Worker for ${treeOf(tree.domain)}. Bind the R2 bucket the deploy writes to as ${WORKER_ORIGIN_BINDING}.`,
    "",
    `var ORIGIN = ${jsLiteral(WORKER_ORIGIN_BINDING)};`,
    `var DOMAIN = ${tree.domain === undefined ? "null" : jsLiteral(tree.domain)};`,
    `var KEY_PREFIX = ${jsLiteral(keyPrefix(tree.domain))};`,
    `var DEPLOY_MANIFEST = ${jsLiteral(DEPLOY_MANIFEST_PATH)};`,
    `var DEPLOY_DIRECTORY = ${jsLiteral(DEPLOY_DIRECTORY)};`,
    `var NOT_FOUND = ${tree.notFound === undefined ? "null" : jsLiteral(tree.notFound)};`,
    "",
    ...redirectTable(tree),
    "",
    ...headerTable(tree),
    "",
    ...RUNTIME,
    "",
  ].join("\n");

  return [
    {
      ...(tree.domain === undefined ? {} : { domain: tree.domain }),
      role: "edge-module",
      binding: WORKER_ORIGIN_BINDING,
      path: "worker.js",
      contents,
    },
  ];
}
