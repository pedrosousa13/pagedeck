import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { signDelivery } from "./webhook.js";

export interface PageContent {
  readonly title: string;
  readonly blocks: readonly unknown[];
  /** UTC, as `2026-11-01T09:00:00Z`. */
  readonly publishAt?: string;
  readonly unpublishAt?: string;
}

export interface StoredPage extends PageContent {
  readonly id: string;
  readonly revision: number;
}

export interface Cms {
  /** Ends in `/`; the API's paths resolve against it. */
  readonly url: string;
  put(id: string, page: PageContent): void;
  remove(id: string): void;
  /** Settles once every webhook delivery sent so far has been answered or has failed. */
  delivered(): Promise<void>;
  close(): Promise<void>;
}

export interface CmsOptions {
  /** A directory of `<id>.json` files, each one page. Defaults to this package's `data/pages`. */
  readonly data?: string;
  /** `0` asks the system for a free port. */
  readonly port?: number;
  /** Where every edit and removal is POSTed, signed with `secret`. */
  readonly webhook?: { readonly url: string; readonly secret: string };
}

const HOST = "127.0.0.1";

const PAGE_SIZE = 2;

// `src` under Vitest and `dist` under Node, so `..` is this package either way.
const DATA = join(import.meta.dirname, "..", "data", "pages");

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function wholeNumber(value: string | null, least: number): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number >= least ? number : undefined;
}

// docs/error-messages.md, rule 4: one fault carries the parser's error as its cause, and
// several quote it a line each.
function refuseUnparsed(directory: string, faults: readonly { file: string; cause: unknown }[]): void {
  const [only] = faults;
  if (only === undefined) return;
  if (faults.length === 1) {
    throw new Error(
      `CMS page "${join(directory, only.file)}": is not valid JSON — fix the file, or remove it from "${directory}"`,
      { cause: only.cause },
    );
  }
  const lines = faults.map(
    ({ file, cause }) => `  "${file}" — ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  throw new Error(
    `CMS pages in "${directory}": ${String(faults.length)} files are not valid JSON — fix each, or remove it:\n${lines.join("\n")}`,
  );
}

export async function startCms(options: CmsOptions = {}): Promise<Cms> {
  let revision = 0;
  const pages = new Map<string, StoredPage>();
  const deleted = new Map<string, number>();
  const deliveries = new Set<Promise<void>>();

  // A real CMS retries a failed delivery; this one drops it, and the next scheduled
  // run picks the edit up all the same.
  const deliver = (type: "page.updated" | "page.removed", id: string): void => {
    const webhook = options.webhook;
    if (webhook === undefined) return;
    const body = JSON.stringify({ type, id, revision });
    const sending = signDelivery(webhook.secret, {
      id: randomUUID(),
      timestamp: Math.floor(Date.now() / 1000),
      body,
    })
      .then((headers) => fetch(webhook.url, { method: "POST", headers, body, redirect: "manual" }))
      .then((response) => response.body?.cancel())
      .catch(() => undefined)
      .finally(() => deliveries.delete(sending));
    deliveries.add(sending);
  };

  const store = (id: string, page: PageContent): void => {
    revision += 1;
    pages.set(id, {
      id,
      revision,
      title: page.title,
      blocks: page.blocks,
      ...(page.publishAt === undefined ? {} : { publishAt: page.publishAt }),
      ...(page.unpublishAt === undefined ? {} : { unpublishAt: page.unpublishAt }),
    });
    deleted.delete(id);
  };

  const put = (id: string, page: PageContent): void => {
    store(id, page);
    deliver("page.updated", id);
  };

  const directory = options.data ?? DATA;
  const faults: { file: string; cause: unknown }[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const text = readFileSync(join(directory, file), "utf8");
    try {
      store(basename(file, ".json"), JSON.parse(text) as PageContent);
    } catch (cause) {
      faults.push({ file, cause });
    }
  }
  refuseUnparsed(directory, faults);

  const sorted = (): StoredPage[] =>
    [...pages.values()].sort((left, right) => (left.id < right.id ? -1 : 1));

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${HOST}`);
    if (url.pathname === "/pages") {
      const page = url.searchParams.has("page")
        ? wholeNumber(url.searchParams.get("page"), 1)
        : 1;
      if (page === undefined) {
        send(response, 400, { error: "page must be a whole number from 1" });
        return;
      }
      const all = sorted();
      const start = (page - 1) * PAGE_SIZE;
      send(response, 200, {
        pages: all.slice(start, start + PAGE_SIZE),
        nextPage: start + PAGE_SIZE < all.length ? page + 1 : null,
        revision,
      });
      return;
    }

    if (url.pathname === "/changes") {
      const since = wholeNumber(url.searchParams.get("since"), 0);
      if (since === undefined) {
        send(response, 400, { error: "since must be a whole number, a revision this API returned" });
        return;
      }
      send(response, 200, {
        pages: sorted().filter((page) => page.revision > since),
        deleted: [...deleted]
          .filter(([, at]) => at > since)
          .map(([id]) => id)
          .sort(),
        revision,
      });
      return;
    }

    send(response, 404, { error: "the API serves /pages and /changes" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, HOST, resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${HOST}:${String(port)}/`,
    put,
    remove(id) {
      if (!pages.delete(id)) return;
      revision += 1;
      deleted.set(id, revision);
      deliver("page.removed", id);
    },
    delivered: async () => {
      await Promise.all(deliveries);
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
