import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import type { RoutingManifest, UpstreamRoute } from "@pagedeck/core/routing";

import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { cloudflareWorker } from "./index.js";
import type { CloudflareWorkerOptions } from "./index.js";
import { originStandIn, runWorker } from "./worker.test-support.js";

function routed(
  upstreams: readonly UpstreamRoute[],
  shop: readonly UpstreamRoute[] = [],
): RoutingManifest {
  return {
    ...FIXTURE,
    trees: FIXTURE.trees.map((tree) =>
      tree.domain === undefined
        ? {
            ...tree,
            headers: [
              ...tree.headers,
              { prefix: "/", set: [{ name: "X-Site", value: "site" }] },
            ],
            upstreams,
          }
        : { ...tree, upstreams: shop },
    ),
  };
}

function workerOf(
  manifest: RoutingManifest,
  options: CloudflareWorkerOptions = {},
): string {
  const worker = cloudflareWorker(options)
    .compile(manifest)
    .artifacts.find((artifact) => artifact.domain === undefined);
  if (worker === undefined) throw new Error("no worker.js for the default tree");
  return worker.contents;
}

const APP = { "/api/": { binding: "APP" } };

interface Received {
  method: string;
  url: string;
  headers: Headers;
  redirect: string;
  body?: string;
}

async function throughBinding(
  request: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ response: Response; received: Received[]; answer: Response }> {
  const received: Received[] = [];
  const answer = new Response("from the app", {
    status: 201,
    headers: { "x-app": "app" },
  });
  const response = await runWorker(
    workerOf(routed([{ prefix: "/api/" }]), { upstreams: APP }),
    {
      method: request.method,
      url: `https://default.test${request.path}`,
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
    },
    originStandIn(new Map()).binding,
    {
      services: {
        APP: {
          fetch(sent: Received) {
            received.push(sent);
            return Promise.resolve(answer);
          },
        },
      },
    },
  );
  return { response, received, answer };
}

describe("a prefix the Worker sends to an app through a service binding", () => {
  it("hands the app the request unchanged, whatever its method, and returns its response unchanged", async () => {
    const { response, received, answer } = await throughBinding({
      method: "POST",
      path: "/api/signup?plan=pro&x=1",
      headers: { "content-type": "application/json", cookie: "session=1" },
      body: '{"email":"a@example.test"}',
    });
    expect(response).toBe(answer);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-site")).toBeNull();
    expect(received).toHaveLength(1);
    const [sent] = received;
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toBe("https://default.test/api/signup?plan=pro&x=1");
    expect(sent?.redirect).toBe("manual");
    expect(Object.fromEntries(sent?.headers ?? [])).toEqual({
      "content-type": "application/json",
      cookie: "session=1",
    });
    expect(sent?.body).toBe('{"email":"a@example.test"}');
  });

  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) {
    it(`sends ${method} to the app, not the 405 the site answers`, async () => {
      const { response, received } = await throughBinding({ method, path: "/api/items/1" });
      expect(response.status).toBe(201);
      expect(received.map((sent) => sent.method)).toEqual([method]);
    });
  }

  it("sends the prefix's unslashed path to the app", async () => {
    const { received } = await throughBinding({ method: "GET", path: "/api" });
    expect(received.map((sent) => sent.url)).toEqual(["https://default.test/api"]);
  });

  for (const path of ["/apix", "/apix/", "/ap", "/en/api/"]) {
    it(`keeps ${path} for the site`, async () => {
      const { response, received } = await throughBinding({ method: "GET", path });
      expect(received).toEqual([]);
      expect(response.status).toBe(404);
    });
  }

  it("still answers 405 to a POST outside the prefix", async () => {
    const { response, received } = await throughBinding({ method: "POST", path: "/en/about" });
    expect(received).toEqual([]);
    expect(response.status).toBe(405);
  });
});

describe("a prefix the Worker proxies to the app's url", () => {
  it("fetches the url with the full path and query, and every part of the request", async () => {
    const sent: Request[] = [];
    const answer = new Response(null, { status: 302, headers: { location: "/login" } });
    const response = await runWorker(
      workerOf(routed([{ prefix: "/api/", url: "https://app.example" }])),
      {
        method: "POST",
        url: "https://default.test/api/signup?plan=pro",
        headers: { "content-type": "text/plain", cookie: "session=1" },
        body: "hello",
      },
      originStandIn(new Map()).binding,
      {
        fetch: (request) => {
          sent.push(request);
          return Promise.resolve(answer);
        },
      },
    );
    expect(response).toBe(answer);
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe("https://app.example/api/signup?plan=pro");
    expect(request?.method).toBe("POST");
    expect(request?.redirect).toBe("manual");
    expect(request?.headers.get("content-type")).toBe("text/plain");
    expect(request?.headers.get("cookie")).toBe("session=1");
    expect(await request?.text()).toBe("hello");
  });
});

describe("the Worker's upstream code", () => {
  it("is absent from a tree with no upstreams, byte for byte", () => {
    const plain = workerOf(routed([]));
    expect(plain).not.toContain("UPSTREAMS");
    expect(workerOf(routed([]), { upstreams: {} })).toBe(plain);
  });

  it("adds a binding note, the table, the matcher and the dispatch, and nothing else", () => {
    const plain = workerOf(routed([]));
    const proxied = workerOf(
      routed([
        { prefix: "/api/" },
        { prefix: "/auth/", url: "https://auth.example" },
      ]),
      { upstreams: APP },
    );
    const expected = plain
      .replace(
        "as PAGEDECK_ORIGIN.\n",
        `as PAGEDECK_ORIGIN.
// Bind the Worker that serves "/api/" as the service binding APP.
`,
      )
      .replace(
        "\nfunction headersFor(",
        `
var UPSTREAMS = [
  { prefix: "/api/", binding: "APP" },
  { prefix: "/auth/", url: "https://auth.example" },
];

function headersFor(`,
      )
      .replace(
        "export default {",
        `function upstream(path) {
  for (var at = 0; at < UPSTREAMS.length; at++) {
    var prefix = UPSTREAMS[at].prefix;
    if (path.indexOf(prefix) === 0 || path === prefix.slice(0, -1)) return UPSTREAMS[at];
  }
  return null;
}

function forwarded(url, origin) {
  var start = url.indexOf("/", url.indexOf("//") + 2);
  return origin + (start === -1 ? "/" : url.slice(start));
}

export default {`,
      )
      .replace(
        "    var path = requestPath(request.url);\n",
        `    var path = requestPath(request.url);
    var app = upstream(path);
    if (app !== null) {
      if (app.binding !== undefined) return env[app.binding].fetch(request);
      return fetch(new Request(forwarded(request.url, app.url), request));
    }
`,
      );
    expect(proxied).toBe(expected);
  });
});

describe("upstream refusals", () => {
  it("refuses a prefix with neither a url nor a service binding, per tree", () => {
    expect(() =>
      cloudflareWorker().compile(
        routed(
          [{ prefix: "/api/" }, { prefix: "/auth/", url: "https://auth.example" }, { prefix: "/hooks/" }],
          [{ prefix: "/cart/" }],
        ),
      ),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 2 trees send prefixes to apps with no url, and this target proxies each prefix to the url its app answers at — name a service binding for each in cloudflareWorker({ upstreams }), such as { "/api/": { binding: "APP" } }, or set url on each to the https origin the deployed app answers at:
  the default tree's prefixes "/api/", "/hooks/" (build.routing.upstreams)
  the "shop.example" tree's prefix "/cart/" (build.routing.upstreams)`,
      ),
    );
  });

  it("refuses a binding keyed by a prefix no tree declares", () => {
    expect(() =>
      cloudflareWorker({
        upstreams: { "/api/": { binding: "APP" }, "/apl/": { binding: "APL" } },
      }).compile(routed([{ prefix: "/api/" }], [{ prefix: "/cart/", url: "https://cart.example" }])),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 1 prefix in cloudflareWorker({ upstreams }) is one no tree sends to an app — correct each to a prefix in build.routing.upstreams, or remove it from the option:
  "/apl/" — build.routing.upstreams declares "/api/", "/cart/"`,
      ),
    );
  });

  it("refuses a binding where the document declares no prefix", () => {
    expect(() => cloudflareWorker({ upstreams: APP }).compile(FIXTURE)).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 1 prefix in cloudflareWorker({ upstreams }) is one no tree sends to an app — correct each to a prefix in build.routing.upstreams, or remove it from the option:
  "/api/" — build.routing.upstreams declares no prefix`,
      ),
    );
  });

  it("refuses a binding name that is not a JavaScript variable name", () => {
    expect(() =>
      cloudflareWorker({
        upstreams: { "/api/": { binding: "my-app" }, "/auth/": { binding: "1AUTH" } },
      }).compile(routed([{ prefix: "/api/" }, { prefix: "/auth/" }])),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 2 bindings in cloudflareWorker({ upstreams }) are not valid JavaScript variable names — rename each, in the option and in the Worker's wrangler configuration, to a name such as "APP" that starts with a letter, $ or _ and holds only letters, digits, $ and _:
  "my-app" for "/api/"
  "1AUTH" for "/auth/"`,
      ),
    );
  });

  it("accepts a binding name with $, _ and a letter outside ASCII", () => {
    expect(() =>
      cloudflareWorker({ upstreams: { "/api/": { binding: "$_Äpp2" } } }).compile(
        routed([{ prefix: "/api/" }]),
      ),
    ).not.toThrow();
  });

  it("refuses a prefix with both a url and a binding, rather than pick one", () => {
    expect(() =>
      cloudflareWorker({ upstreams: APP }).compile(
        routed(
          [{ prefix: "/api/", url: "https://app.example" }],
          [{ prefix: "/api/", url: "https://shop-app.example" }],
        ),
      ),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 2 prefixes name both a url and a service binding — remove url from each in build.routing.upstreams, or remove it from cloudflareWorker({ upstreams }):
  the default tree's prefix "/api/" — url "https://app.example", binding "APP"
  the "shop.example" tree's prefix "/api/" — url "https://shop-app.example", binding "APP"`,
      ),
    );
  });

  it("reports every upstream fault in one refusal", () => {
    expect(() =>
      cloudflareWorker({
        upstreams: { "/api/": { binding: "APP" }, "/apl/": { binding: "bad name" } },
      }).compile(
        routed([{ prefix: "/api/", url: "https://app.example" }, { prefix: "/hooks/" }]),
      ),
    ).toThrow(
      new ConfigError(
        `Edge target "cloudflare-worker": 1 tree sends a prefix to an app with no url, and this target proxies each prefix to the url its app answers at — name a service binding for each in cloudflareWorker({ upstreams }), such as { "/api/": { binding: "APP" } }, or set url on each to the https origin the deployed app answers at:
  the default tree's prefix "/hooks/" (build.routing.upstreams)

Edge target "cloudflare-worker": 1 prefix in cloudflareWorker({ upstreams }) is one no tree sends to an app — correct each to a prefix in build.routing.upstreams, or remove it from the option:
  "/apl/" — build.routing.upstreams declares "/api/", "/hooks/"

Edge target "cloudflare-worker": 1 binding in cloudflareWorker({ upstreams }) is not a valid JavaScript variable name — rename each, in the option and in the Worker's wrangler configuration, to a name such as "APP" that starts with a letter, $ or _ and holds only letters, digits, $ and _:
  "bad name" for "/apl/"

Edge target "cloudflare-worker": 1 prefix names both a url and a service binding — remove url from each in build.routing.upstreams, or remove it from cloudflareWorker({ upstreams }):
  the default tree's prefix "/api/" — url "https://app.example", binding "APP"`,
      ),
    );
  });
});
