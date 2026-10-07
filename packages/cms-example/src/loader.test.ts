import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { EntryId } from "@pagedeck/content";
import { describeError, runCli } from "@pagedeck/core";
import { defineExampleCmsLoader } from "./loader.js";
import type { PageEntry } from "./loader.js";
import { startCms } from "./server.js";

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function recordingWriter() {
  const upserts: (EntryId & { data: PageEntry })[] = [];
  const deletes: EntryId[] = [];
  return {
    upserts,
    deletes,
    upsert(entry: EntryId & { data: PageEntry }) {
      upserts.push(entry);
    },
    delete(id: EntryId) {
      deletes.push(id);
    },
  };
}

async function cms() {
  const started = await startCms({ port: 0 });
  closers.push(() => started.close());
  return started;
}

// A stand-in that answers whatever a test needs the CMS to get wrong.
async function answering(body: (request: IncomingMessage) => unknown): Promise<string> {
  const server = createServer((request, response) => {
    const text = JSON.stringify(body(request));
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(text),
    });
    response.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
}

// A stand-in that holds each request open for as long as `respond` keeps it; teardown cuts
// every connection it accepted, so a request the loader never finishes cannot hold the run.
async function holding(respond: (response: ServerResponse) => void): Promise<string> {
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => respond(response));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
}

test("a full sync upserts every page of every list page, by id, and reports the CMS's revision as the cursor", async () => {
  const { url } = await cms();
  const writer = recordingWriter();

  const result = await defineExampleCmsLoader({ endpoint: url, locale: "en" }).syncAll(writer);

  expect(writer.upserts.map(({ locale, path }) => `${locale}/${path}`)).toEqual([
    "en/faq",
    "en/home",
    "en/signup",
  ]);
  expect(writer.upserts[2]?.data).toEqual({
    title: "Sign up",
    blocks: [
      expect.objectContaining({ type: "hero" }),
      expect.objectContaining({ type: "signup_form" }),
    ],
  });
  expect(result).toEqual({
    changed: [
      { locale: "en", path: "faq" },
      { locale: "en", path: "home" },
      { locale: "en", path: "signup" },
    ],
    deleted: [],
    authoritative: true,
    cursor: 3,
  });
});

test("an incremental sync upserts the pages changed since the cursor and reports the pages removed", async () => {
  const server = await cms();
  server.put("faq", { title: "Questions", blocks: [] });
  server.remove("home");
  const writer = recordingWriter();

  const result = await defineExampleCmsLoader({ endpoint: server.url, locale: "en" }).syncSince(
    writer,
    3,
  );

  expect(writer.upserts).toEqual([
    { locale: "en", path: "faq", data: { title: "Questions", blocks: [] } },
  ]);
  expect(result).toEqual({
    changed: [{ locale: "en", path: "faq" }],
    deleted: [{ locale: "en", path: "home" }],
    cursor: 5,
  });
});

test("an endpoint given without a trailing slash still names the API's root", async () => {
  const { url } = await cms();

  const result = await defineExampleCmsLoader({
    endpoint: url.slice(0, -1),
    locale: "en",
  }).syncAll(recordingWriter());

  expect(result.changed).toHaveLength(3);
});

test.each(["api?t=x#f", "api", "api/"])(
  "an endpoint at path %j resolves each request under /api/ and sends none of its query or fragment",
  async (path) => {
    const requested: string[] = [];
    const root = await answering((request) => {
      requested.push(request.url ?? "");
      return { revision: 1, nextPage: null, pages: [], deleted: [] };
    });
    const loader = defineExampleCmsLoader({ endpoint: `${root}${path}`, locale: "en" });

    await loader.syncAll(recordingWriter());
    await loader.syncSince(recordingWriter(), 1);

    expect(requested).toEqual(["/api/pages?page=1", "/api/changes?since=1"]);
  },
);

test("a CMS that is not running fails the sync with the request named and the network error attached", async () => {
  const server = await cms();
  await server.close();
  closers.length = 0;

  const failure = await Promise.resolve(
    defineExampleCmsLoader({ endpoint: server.url, locale: "en" }).syncAll(recordingWriter()),
  ).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

  expect(failure?.message).toBe(
    `CMS request "GET ${server.url}pages": failed before the CMS answered — check that the CMS is running at the endpoint the config names`,
  );
  expect(failure?.cause).toBeInstanceOf(Error);
});

// docs/error-messages.md, rule 6: a query string can carry a token, so a message keeps the
// scheme, host and path of a request and drops the rest.
test("a failed request is quoted without its query string or fragment", async () => {
  const server = await cms();
  await server.close();
  closers.length = 0;
  const loader = defineExampleCmsLoader({
    endpoint: `${server.url}?token=secret#token=secret`,
    locale: "en",
  });

  const messages = await Promise.all(
    [loader.syncAll(recordingWriter()), loader.syncSince(recordingWriter(), 0)].map((sync) =>
      Promise.resolve(sync).then(
        () => "",
        (error: unknown) => (error as Error).message,
      ),
    ),
  );

  expect(messages.map((message) => message.split(":").slice(0, 3).join(":"))).toEqual([
    `CMS request "GET ${server.url}pages"`,
    `CMS request "GET ${server.url}changes"`,
  ]);
  for (const message of messages) {
    expect(message).not.toMatch(/[?#]|secret|page=|since=/);
  }
});

test("an endpoint that is not the API's root fails on the status the server answered", async () => {
  const { url } = await cms();

  await expect(
    defineExampleCmsLoader({ endpoint: `${url}api/`, locale: "en" }).syncSince(
      recordingWriter(),
      0,
    ),
  ).rejects.toThrow(
    `CMS request "GET ${url}api/changes": the CMS answered 404 — check that the endpoint the config names is the root of the CMS's API`,
  );
});

test("a list body of the wrong shape names every field the loader cannot read", async () => {
  const endpoint = await answering(() => ({ pages: [{ id: 7 }, "home"], nextPage: "2" }));

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(recordingWriter()),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}pages": the body is not the list this loader reads — check that the endpoint the config names is the root of the CMS's API:
  pages[0].id is not a string
  pages[1] is not an object
  nextPage is not a whole number or null
  revision is not a whole number`,
  );
});

test("a body that is not an object is refused as a whole", async () => {
  const endpoint = await answering(() => ["home"]);

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en" }).syncSince(recordingWriter(), 0),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}changes": the body is not the list this loader reads — check that the endpoint the config names is the root of the CMS's API:
  the body is not an object`,
  );
});

test("a changes body of the wrong shape names the deletions it cannot read", async () => {
  const endpoint = await answering(() => ({ pages: [], deleted: ["home", 3], revision: 4 }));

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en" }).syncSince(recordingWriter(), 0),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}changes": the body is not the list this loader reads — check that the endpoint the config names is the root of the CMS's API:
  deleted[1] is not a string`,
  );
});

test("a CMS whose revision moves while the list is read fails the full sync rather than prune a page it missed", async () => {
  const endpoint = await answering((request) =>
    request.url === "/pages?page=1"
      ? { pages: [], nextPage: 2, revision: 1 }
      : { pages: [], nextPage: null, revision: 2 },
  );

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(recordingWriter()),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}pages": the CMS moved from revision 1 to 2 while the list was read, so a page could have shifted past the loader and been pruned as deleted — run the sync again`,
  );
});

test("a list that never ends is read for 1000 pages and no more", async () => {
  let requests = 0;
  const endpoint = await answering((request) => {
    requests += 1;
    const page = Number(new URL(request.url ?? "", "http://x").searchParams.get("page"));
    return { pages: [], nextPage: page + 1, revision: 1 };
  });

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(recordingWriter()),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}pages": the list still names a next page after 1000 pages, so the loader stops rather than follow a list that may never end — check that the CMS answers nextPage null on its last page`,
  );
  expect(requests).toBe(1000);
}, 60_000);

test("an endpoint that is not an http: or https: URL is refused when the loader is defined", () => {
  for (const endpoint of ["127.0.0.1:4310", "file:///srv/cms/"]) {
    expect(() => defineExampleCmsLoader({ endpoint, locale: "en" })).toThrow(
      "CMS endpoint: is not an http: or https: URL — pass the URL the CMS serves its API at, such as http://127.0.0.1:4310/",
    );
  }
});

test("an endpoint with a user name and password is refused when the config loads, and the refusal quotes neither", async () => {
  const example = join(import.meta.dirname, "..");
  const before = process.env["PAGEDECK_CMS_EXAMPLE_URL"];
  process.env["PAGEDECK_CMS_EXAMPLE_URL"] = "http://u:secret@127.0.0.1/";
  const printed: string[] = [];
  try {
    const code = await runCli(["sync"], {
      cwd: example,
      env: process.env,
      out: (line) => printed.push(line),
      err: (line) => printed.push(line),
    });

    expect(code).toBe(2);
  } finally {
    if (before === undefined) delete process.env["PAGEDECK_CMS_EXAMPLE_URL"];
    else process.env["PAGEDECK_CMS_EXAMPLE_URL"] = before;
  }

  expect(printed).toEqual([
    `Config "${join(example, "pagedeck.config.ts")}": failed to load: CMS endpoint: carries a user name or password before its host — pass the endpoint without them, and send the credential in a request header such as authorization`,
  ]);
});

test("an endpoint with a user name alone or a password alone is refused when the loader is defined", () => {
  for (const endpoint of ["http://u@127.0.0.1/", "http://:secret@127.0.0.1/"]) {
    expect(() => defineExampleCmsLoader({ endpoint, locale: "en" })).toThrow(
      "CMS endpoint: carries a user name or password before its host — pass the endpoint without them, and send the credential in a request header such as authorization",
    );
  }
});

test("a failing sync prints no credential the endpoint carries in its user name, password, query or fragment", async () => {
  const server = await cms();
  await server.close();
  closers.length = 0;
  const port = new URL(server.url).port;
  const endpoints = [
    `http://cmsuser:userinfo-secret@127.0.0.1:${port}/`,
    `http://127.0.0.1:${port}/?token=query-secret`,
    `http://127.0.0.1:${port}/#token=fragment-secret`,
  ];

  const printed = await Promise.all(
    endpoints.flatMap((endpoint) =>
      [
        async () => defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(recordingWriter()),
        async () =>
          defineExampleCmsLoader({ endpoint, locale: "en" }).syncSince(recordingWriter(), 0),
      ].map((sync) =>
        sync().then(
          () => "",
          (error: unknown) => describeError(error),
        ),
      ),
    ),
  );

  expect(printed).toHaveLength(6);
  for (const output of printed) {
    expect(output).not.toBe("");
    expect(output).not.toMatch(/cmsuser|userinfo-secret|query-secret|fragment-secret/);
  }
});

test("a full sync follows the next page the CMS names rather than counting pages itself", async () => {
  const requested: string[] = [];
  const endpoint = await answering((request) => {
    requested.push(request.url ?? "");
    return request.url === "/pages?page=1"
      ? { pages: [{ id: "home", title: "Home", blocks: [] }], nextPage: 7, revision: 2 }
      : { pages: [{ id: "faq", title: "Questions", blocks: [] }], nextPage: null, revision: 2 };
  });

  const result = await defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(
    recordingWriter(),
  );

  expect(requested).toEqual(["/pages?page=1", "/pages?page=7"]);
  expect(result.changed.map(({ path }) => path)).toEqual(["home", "faq"]);
});

test("an incremental sync refuses a cursor ahead of the CMS's revision rather than wait for edits it would never see", async () => {
  const { url } = await cms();

  await expect(
    defineExampleCmsLoader({ endpoint: url, locale: "en" }).syncSince(recordingWriter(), 7),
  ).rejects.toThrow(
    `CMS request "GET ${url}changes": the CMS is at revision 3, behind the cursor 7 the last sync stored, so it would report no edit until it passed 7 and the edits before then would never be synced — run pagedeck sync without --incremental to read every page again`,
  );
});

test("a CMS that never answers fails the sync once the time limit passes, naming the request and the limit", async () => {
  const endpoint = await holding(() => undefined);
  const started = Date.now();

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en", timeoutMs: 200 }).syncAll(recordingWriter()),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}pages": the CMS did not finish answering within 200 ms, so the loader stopped waiting — check that the CMS is running at the endpoint the config names, or raise timeoutMs in the loader's options if it is slow`,
  );
  expect(Date.now() - started).toBeLessThan(2_000);
}, 5_000);

test("a CMS that sends its headers and then trickles the body fails on the same time limit", async () => {
  const endpoint = await holding((response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => response.write(" "), 20);
    response.on("close", () => clearInterval(timer));
  });

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en", timeoutMs: 300 }).syncSince(
      recordingWriter(),
      0,
    ),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}changes": the CMS did not finish answering within 300 ms, so the loader stopped waiting — check that the CMS is running at the endpoint the config names, or raise timeoutMs in the loader's options if it is slow`,
  );
}, 5_000);

test("a body past the size cap fails the sync while the CMS is still sending it, naming the request and the cap", async () => {
  const total = 64 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, " ");
  let sent = 0;
  const endpoint = await holding((response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const send = (): void => {
      while (sent < total && !response.destroyed) {
        sent += chunk.byteLength;
        if (!response.write(chunk)) return void response.once("drain", send);
      }
      response.end();
    };
    send();
  });

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en", maximumBodyBytes: 1024 * 1024 }).syncAll(
      recordingWriter(),
    ),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}pages": the body is larger than 1048576 bytes, so the rest was not read — check that the endpoint the config names is the root of the CMS's API, or raise maximumBodyBytes in the loader's options if its responses are this large`,
  );
  expect(sent).toBeLessThan(total / 4);
}, 10_000);

test("a time limit or a size cap that is not a usable whole number is refused when the loader is defined, every fault at once", () => {
  expect(() =>
    defineExampleCmsLoader({
      endpoint: "http://127.0.0.1:4310/",
      locale: "en",
      timeoutMs: 0,
      maximumBodyBytes: 1.5,
    }),
  ).toThrow(
    `CMS loader options: 2 limits cannot be used — fix each in the call to defineExampleCmsLoader:
  timeoutMs is not a whole number of milliseconds from 1 to 2147483647
  maximumBodyBytes is not a whole number of bytes from 1 to 9007199254740991`,
  );
  for (const timeoutMs of [Number.NaN, 2 ** 31, -1]) {
    expect(() =>
      defineExampleCmsLoader({ endpoint: "http://127.0.0.1:4310/", locale: "en", timeoutMs }),
    ).toThrow("timeoutMs is not a whole number of milliseconds from 1 to 2147483647");
  }
});

test("a connection cut partway through the body fails the sync as a cut, with the transport's error attached", async () => {
  const endpoint = await holding((response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": 100 });
    response.write('{"pages": [', () => response.destroy());
  });

  const failure = await Promise.resolve(
    defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(recordingWriter()),
  ).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

  expect(failure?.message).toBe(
    `CMS request "GET ${endpoint}pages": the connection failed while the body was read — check that the CMS is running at the endpoint the config names, and run the sync again`,
  );
  expect(failure?.cause).toBeInstanceOf(Error);
});

test("a body that arrives in one piece larger than the size cap fails on the cap", async () => {
  const endpoint = await answering(() => ({
    pages: [],
    nextPage: null,
    revision: 1,
    padding: "x".repeat(100),
  }));

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en", maximumBodyBytes: 10 }).syncAll(
      recordingWriter(),
    ),
  ).rejects.toThrow(
    `CMS request "GET ${endpoint}pages": the body is larger than 10 bytes, so the rest was not read — check that the endpoint the config names is the root of the CMS's API, or raise maximumBodyBytes in the loader's options if its responses are this large`,
  );
});

test("an error status closes the connection rather than hold it open until the time limit", async () => {
  let closed: () => void = () => undefined;
  const connectionClosed = new Promise<void>((resolve) => (closed = resolve));
  const endpoint = await holding((response) => {
    response.on("close", closed);
    response.writeHead(500, { "content-type": "text/plain" });
    response.write("the CMS is down, and this body never ends");
  });

  await expect(
    defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(recordingWriter()),
  ).rejects.toThrow(`CMS request "GET ${endpoint}pages": the CMS answered 500`);
  await connectionClosed;
}, 5_000);

async function recording(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ endpoint: string; requested: string[] }> {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(request.url ?? "");
    respond(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const port = String((server.address() as AddressInfo).port);
  return { endpoint: `http://127.0.0.1:${port}/`, requested };
}

const EMPTY_LIST = JSON.stringify({ pages: [], nextPage: null, revision: 1 });

function redirectTo(location: string, status = 302) {
  return (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(status, { location, "content-type": "text/plain" });
    response.end("moved");
  };
}

test("a redirect to another host fails the sync, naming both hosts, and no request reaches the other host", async () => {
  const other = await recording((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(EMPTY_LIST);
  });
  const otherHost = other.endpoint.slice(0, -1);
  const cms = await recording(redirectTo(`${otherHost}/pages?from=redirect&token=secret`));
  const loader = defineExampleCmsLoader({ endpoint: cms.endpoint, locale: "en" });

  const messages = await Promise.all(
    [
      async () => loader.syncAll(recordingWriter()),
      async () => loader.syncSince(recordingWriter(), 0),
    ].map((sync) =>
      sync().then(
        () => "",
        (error: unknown) => describeError(error),
      ),
    ),
  );

  expect(messages[0]).toBe(
    `CMS request "GET ${cms.endpoint}pages": the CMS answered 302, a redirect to "${otherHost}/pages" — the loader follows no redirect, so every request stays on the host the endpoint names; point the endpoint at the root of the CMS's API`,
  );
  expect(messages[1]).toContain(`CMS request "GET ${cms.endpoint}changes": the CMS answered 302`);
  for (const message of messages) expect(message).not.toMatch(/secret|from=/);
  expect(cms.requested).toEqual(["/pages?page=1", "/changes?since=0"]);
  expect(other.requested).toEqual([]);
});

test("a redirect on the same host fails the sync too, and is not followed", async () => {
  const cms = await recording((request, response) => {
    if (request.url?.startsWith("/v2/") === true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(EMPTY_LIST);
      return;
    }
    redirectTo(`/v2${request.url ?? ""}`, 301)(request, response);
  });

  await expect(
    defineExampleCmsLoader({ endpoint: cms.endpoint, locale: "en" }).syncAll(recordingWriter()),
  ).rejects.toThrow(
    `CMS request "GET ${cms.endpoint}pages": the CMS answered 301, a redirect to "${cms.endpoint}v2/pages" — the loader follows no redirect, so every request stays on the host the endpoint names; point the endpoint at the root of the CMS's API`,
  );
  expect(cms.requested).toEqual(["/pages?page=1"]);
});

test("a redirect with no location fails the sync and says so", async () => {
  const cms = await recording((_request, response) => {
    response.writeHead(307);
    response.end();
  });

  await expect(
    defineExampleCmsLoader({ endpoint: cms.endpoint, locale: "en" }).syncAll(recordingWriter()),
  ).rejects.toThrow(
    `CMS request "GET ${cms.endpoint}pages": the CMS answered 307, a redirect with no location the loader can read — the loader follows no redirect, so every request stays on the host the endpoint names; point the endpoint at the root of the CMS's API`,
  );
});

test("an http: endpoint on a host that is not loopback is refused when the loader is defined", () => {
  for (const [endpoint, host] of [
    ["http://cms.example/", "cms.example"],
    ["http://10.0.0.5:4310/api/", "10.0.0.5"],
    ["http://127.0.0.1.cms.example/", "127.0.0.1.cms.example"],
  ] as const) {
    expect(() => defineExampleCmsLoader({ endpoint, locale: "en" })).toThrow(
      `CMS endpoint: is an http: URL on host "${host}", which is not loopback — http: carries every request, and any token in its headers, across the network in clear text; use https:, or keep http: for 127.0.0.1, ::1 or localhost`,
    );
  }
});

test("an http: endpoint on 127.0.0.1, ::1 or localhost, and an https: endpoint on any host, is accepted", async () => {
  for (const endpoint of ["http://[::1]:4310/", "https://cms.example/", "HTTP://LOCALHOST:4310/"]) {
    expect(() => defineExampleCmsLoader({ endpoint, locale: "en" })).not.toThrow();
  }
  const { url } = await cms();
  const port = new URL(url).port;
  for (const endpoint of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
    const result = await defineExampleCmsLoader({ endpoint, locale: "en" }).syncAll(
      recordingWriter(),
    );
    expect(result.changed, endpoint).toHaveLength(3);
  }
});
