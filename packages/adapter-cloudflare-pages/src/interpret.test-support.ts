// Test-only: a hand-written model of Cloudflare Pages' own engine, close enough to the documented
// rules to check this adapter's compiler against, not a claim that CI has run real Pages. Two
// assumptions it makes that the docs do not settle are recorded in docs/deploy-recipe.md's
// unverified host facts: which path `_headers` matches a proxied (200) response against, and
// whether a redirect response carries `_headers` at all. This models both as the original
// request's own path, matching every other adapter's header attribution.
import type { HeaderField, RedirectStatus } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { find, forTree } from "../../edge/src/interpret.test-support.js";
import type { EdgeRequest, Resolution } from "../../edge/src/oracle.test-support.js";

interface Row {
  source: string;
  destination: string;
  code: number;
}

function parseRedirects(contents: string): Row[] {
  return contents
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [source, destination, code] = line.split(" ");
      return { source: source ?? "", destination: destination ?? "", code: Number(code) };
    });
}

// `_redirects`' own splat, the only wildcard this adapter ever writes.
function matchesSource(pattern: string, path: string): boolean {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : pattern === path;
}

interface Block {
  prefix: string;
  detach: readonly string[];
  set: readonly HeaderField[];
}

function parseHeaders(contents: string): Block[] {
  return contents
    .split("\n\n")
    .map((block) => block.replace(/\n$/, ""))
    .filter((block) => block !== "")
    .map((block) => {
      const [pattern, ...lines] = block.split("\n");
      const detach: string[] = [];
      const set: HeaderField[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("! ")) {
          detach.push(trimmed.slice(2).toLowerCase());
          continue;
        }
        const at = line.indexOf(": ");
        set.push({ name: line.slice(0, at).trim(), value: line.slice(at + 2) });
      }
      return { prefix: (pattern ?? "").replace(/\*$/, ""), detach, set };
    });
}

// Every matching block's headers accumulate, a repeated name joins with a comma, and a `! Name`
// line removes whatever is accumulated for that name so far (headers.md, "Attach a header" and
// "Detach a header"). Blocks are read in file order, least specific first (see cloudflare-pages.ts).
function headersFor(blocks: readonly Block[], path: string): HeaderField[] {
  const value = new Map<string, string>();
  const spelling = new Map<string, string>();
  const order: string[] = [];
  for (const block of blocks) {
    if (!path.startsWith(block.prefix)) continue;
    for (const name of block.detach) value.delete(name);
    for (const field of block.set) {
      const lower = field.name.toLowerCase();
      const existing = value.get(lower);
      value.set(lower, existing === undefined ? field.value : `${existing}, ${field.value}`);
      if (!order.includes(lower)) {
        order.push(lower);
        spelling.set(lower, field.name);
      }
    }
  }
  return order.map((lower) => ({ name: spelling.get(lower) ?? lower, value: value.get(lower) ?? "" }));
}

export function interpretCloudflarePages(
  artifacts: readonly EdgeArtifact[],
  request: EdgeRequest,
): Resolution {
  const tree = forTree(artifacts, request.domain);
  const rows = parseRedirects(find(tree, "/_redirects")?.contents ?? "");
  const blocks = parseHeaders(find(tree, "/_headers")?.contents ?? "");

  // "Redirects are always followed, regardless of whether or not an asset matches the incoming
  // request" (redirects.md) — checked before the origin, whatever `request.found` says.
  const row = rows.find((candidate) => matchesSource(candidate.source, request.path));
  if (row !== undefined) {
    if (row.code === 200) {
      // This adapter only ever proxies (200) a reserved deploy key, to the tree's 404 page or to
      // its own fallback at "/404.html" — never a real page a visitor would otherwise reach.
      const fallback = find(tree, "/404.html");
      const isFallback = fallback !== undefined && row.destination === "/404.html";
      return isFallback
        ? { kind: "not-found" }
        : {
            kind: "not-found",
            document: row.destination,
            headers: headersFor(blocks, request.path),
          };
    }
    return {
      kind: "redirect",
      to: row.destination,
      status: row.code as RedirectStatus,
      headers: headersFor(blocks, request.path),
    };
  }

  if (!request.found) return { kind: "not-found" };
  return { kind: "pass", headers: headersFor(blocks, request.path) };
}
