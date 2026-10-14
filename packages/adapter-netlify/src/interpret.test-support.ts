import type { HeaderField, RedirectStatus } from "@pagedeck/core/routing";
import { UNSERVED_KEY } from "@pagedeck/edge";
import type { EdgeArtifact } from "@pagedeck/edge";

import { find, forTree } from "../../edge/src/interpret.test-support.js";
import type { EdgeRequest, Resolution } from "../../edge/src/oracle.test-support.js";

// https://docs.netlify.com/manage/routing/redirects/redirect-options/ : "Netlify will match
// paths to rules regardless of whether or not they contain a trailing slash."
function withoutSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function netlifyMatches(pattern: string, path: string): boolean {
  return pattern.endsWith("*")
    ? path.startsWith(pattern.slice(0, -1))
    : withoutSlash(pattern) === withoutSlash(path);
}

// https://docs.netlify.com/routing/redirects/rewrites-proxies/ : ":splat" is what "*" matched.
// Netlify applies no `_headers` rule to proxied content, so the answer carries none.
function netlifyProxy(pattern: string, to: string, path: string): Resolution {
  const forwarded = new URL(
    pattern.endsWith("*")
      ? to.replace(":splat", path.slice(pattern.length - 1))
      : to,
  );
  if (forwarded.pathname !== path) {
    throw new Error(
      `the row "${pattern} ${to}" sends "${path}" to the app as "${forwarded.pathname}"`,
    );
  }
  return {
    kind: "upstream",
    prefix: pattern.endsWith("*") ? pattern.slice(0, -1) : `${pattern}/`,
    url: forwarded.origin,
  };
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

  // https://docs.netlify.com/manage/routing/redirects/redirect-options/ : a rule with no query
  // parameters matches on the path alone.
  const path = request.path.replace(/[?#].*$/s, "");

  const forced = rows.find(
    ([from, , status]) =>
      netlifyMatches(from ?? "", path) && (status ?? "").endsWith("!"),
  );
  if (forced !== undefined) {
    const [from, to, status] = forced;
    if (status === "200!") return netlifyProxy(from ?? "", to ?? "", path);
    return netlifyAnswer(
      request.path,
      to ?? "",
      (status ?? "").slice(0, -1),
      headersFor,
    );
  }

  if (!request.found) {
    const row = rows.find(([from]) => netlifyMatches(from ?? "", path));
    if (row !== undefined) {
      const [, to, status] = row;
      return netlifyAnswer(request.path, to ?? "", status ?? "", headersFor);
    }
    return { kind: "not-found" };
  }

  return { kind: "pass", headers: headersFor(request.path) };
}
