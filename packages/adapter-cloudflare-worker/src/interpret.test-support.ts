import { covers } from "@pagedeck/core/routing";
import type { RedirectStatus } from "@pagedeck/core/routing";
import type { EdgeArtifact } from "@pagedeck/edge";

import { find, forTree } from "../../edge/src/interpret.test-support.js";
import type { EdgeRequest, Resolution } from "../../edge/src/oracle.test-support.js";
import { objectKey, originStandIn, runWorker } from "./worker.test-support.js";
import type { StoredObject } from "./worker.test-support.js";

// A path whose last segment has no dot is a page, written as `<path>/index.html` as the build
// writes one; anything else is a file at its own path.
function documentOf(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  return last.includes(".") ? path : `${path.replace(/\/+$/, "")}/index.html`;
}

const NOT_FOUND_LINE = /^var NOT_FOUND = (.*);$/m;

const UPSTREAM_LINE = /^ {2}\{ prefix: ("(?:[^"\\]|\\.)*"), url: ("(?:[^"\\]|\\.)*") \},$/gm;

// What the Worker sent, not what its table says: the table only names the prefix it matched.
function upstreamOf(
  source: string,
  path: string,
  sent: Request,
  unchanged: boolean,
): Resolution {
  if (!unchanged) throw new Error("worker.js changed the app's response");
  if (sent.method !== "GET" || sent.redirect !== "manual") {
    throw new Error(`worker.js forwarded ${sent.method} with redirect ${sent.redirect}`);
  }
  if (!sent.url.endsWith(path)) {
    throw new Error(`worker.js forwarded ${sent.url}, not the path and query ${path}`);
  }
  const url = sent.url.slice(0, sent.url.length - path.length);
  const pathname = path.replace(/[?#].*$/s, "");
  for (const [, prefix, origin] of source.matchAll(UPSTREAM_LINE)) {
    const route = { prefix: JSON.parse(prefix ?? "") as string, url: JSON.parse(origin ?? "") as string };
    if (route.url === url && covers(route.prefix, pathname)) return { kind: "upstream", ...route };
  }
  throw new Error(`worker.js forwarded ${sent.url} to an origin no prefix covering ${pathname} names`);
}

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

  const forwarded: Request[] = [];
  const answer = new Response("from the app");
  const response = await runWorker(
    worker.contents,
    {
      method: "GET",
      url: new Request(`https://${request.domain ?? "default.test"}${request.path}`).url,
    },
    originStandIn(objects).binding,
    {
      fetch: (sent) => {
        forwarded.push(sent);
        return Promise.resolve(answer);
      },
    },
  );
  const [sent] = forwarded;
  if (sent !== undefined) return upstreamOf(worker.contents, request.path, sent, response === answer);
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
