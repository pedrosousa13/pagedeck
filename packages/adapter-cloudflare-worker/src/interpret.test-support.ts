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
