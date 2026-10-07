import vm from "node:vm";

import type { HeaderField, RedirectStatus } from "@pagedeck/core/routing";
import { UNSERVED_KEY } from "@pagedeck/edge";
import type { EdgeArtifact } from "@pagedeck/edge";

import { find, forTree } from "../../edge/src/interpret.test-support.js";
import type { EdgeRequest, Resolution } from "../../edge/src/oracle.test-support.js";

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
