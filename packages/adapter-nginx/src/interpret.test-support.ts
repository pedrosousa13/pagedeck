import type { HeaderField, RedirectStatus } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { find, forTree } from "../../edge/src/interpret.test-support.js";
import type { EdgeRequest, Resolution } from "../../edge/src/oracle.test-support.js";

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
