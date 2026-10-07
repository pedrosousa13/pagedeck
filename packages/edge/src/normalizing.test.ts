import { describe, expect, it } from "vitest";

import { planRouting, ROUTING_VERSION } from "@pagedeck/core/routing";
import type { RoutingManifest, TrailingSlash } from "@pagedeck/core/routing";

import { compileRouting } from "./index.js";
import { compiledTree } from "./normalize.js";
import {
  comparable,
  interpretCloudFront,
  interpretNetlify,
  interpretNginx,
  interpretWorker,
} from "./interpret.test-support.js";
import { resolveRequest } from "./oracle.test-support.js";
import type { EdgeRequest } from "./oracle.test-support.js";

function manifestOf(trailingSlash: TrailingSlash): RoutingManifest {
  const slash = trailingSlash === "always" ? "/" : "";
  return {
    version: ROUTING_VERSION,
    site: { trailingSlash },
    trees: [
      {
        redirects: [
          {
            from: `/en/legacy${slash}`,
            to: `/en/about${slash}`,
            status: 301,
            source: "config",
            via: [],
          },
        ],
        notFound: `/en/404${slash}`,
        headers: [],
      },
    ],
  };
}

const NEVER = manifestOf("never");
const ALWAYS = manifestOf("always");

function textOf(manifest: RoutingManifest, target: string): string {
  return compileRouting(manifest, { target })
    .artifacts.map((artifact) => artifact.contents)
    .join("\n");
}

const TARGETS = [
  "cloudfront-function",
  "netlify",
  "nginx",
  "cloudflare-worker",
] as const;

describe("the site's trailing-slash policy reaches every target", () => {
  for (const target of TARGETS) {
    it(`${target} rules on the non-canonical spelling of a redirect source`, () => {
      expect(textOf(NEVER, target)).toContain("/en/legacy/");
    });

    it(`${target} rules on the non-canonical spelling of a page`, () => {
      expect(textOf(NEVER, target)).toContain("/en/about/");
    });

    it(`${target} reads the policy rather than assuming one`, () => {
      // Matched with the following character, since the canonical spelling ends in a slash here.
      const text = textOf(ALWAYS, target);
      expect(text).toMatch(/\/en\/legacy[^/]/);
      expect(text).toMatch(/\/en\/about[^/]/);
    });
  }
});

const REQUESTS: readonly (EdgeRequest & { what: string })[] = [
  {
    what: "the non-canonical spelling of a redirect source",
    path: "/en/legacy/",
    found: true,
  },
  {
    what: "the non-canonical spelling of a live page",
    path: "/en/about/",
    found: true,
  },
  {
    what: "the canonical spelling of a live page",
    path: "/en/about",
    found: true,
  },
];

describe("a non-canonical spelling answers the same on every target", () => {
  for (const request of REQUESTS) {
    it(`cloudfront-function answers ${request.what}`, async () => {
      const { artifacts } = compileRouting(NEVER, {
        target: "cloudfront-function",
      });
      expect(comparable(await interpretCloudFront(artifacts, request))).toEqual(
        comparable(resolveRequest(NEVER, request)),
      );
    });

    it(`netlify answers ${request.what}`, () => {
      const { artifacts } = compileRouting(NEVER, { target: "netlify" });
      expect(comparable(interpretNetlify(artifacts, request))).toEqual(
        comparable(resolveRequest(NEVER, request)),
      );
    });

    it(`nginx answers ${request.what}`, () => {
      const { artifacts } = compileRouting(NEVER, { target: "nginx" });
      expect(comparable(interpretNginx(artifacts, request))).toEqual(
        comparable(resolveRequest(NEVER, request)),
      );
    });

    it(`cloudflare-worker answers ${request.what}`, async () => {
      const { artifacts } = compileRouting(NEVER, {
        target: "cloudflare-worker",
      });
      expect(comparable(await interpretWorker(artifacts, request))).toEqual(
        comparable(resolveRequest(NEVER, request)),
      );
    });
  }
});

describe("the claim the three are checked against", () => {
  it("sends a redirect source's other spelling where the source goes", () => {
    expect(resolveRequest(NEVER, { path: "/en/legacy/", found: true })).toEqual(
      { kind: "redirect", to: "/en/about", status: 301, headers: [] },
    );
  });

  it("sends a page's other spelling to the page, permanently", () => {
    expect(resolveRequest(NEVER, { path: "/en/about/", found: true })).toEqual({
      kind: "redirect",
      to: "/en/about",
      status: 308,
      headers: [],
    });
  });

  it("leaves the 404 page's other spelling alone", () => {
    expect(textOf(NEVER, "nginx")).not.toContain('"/en/404/"');
  });

  it("leaves the root alone, which has one spelling under either policy", () => {
    const root: RoutingManifest = {
      version: ROUTING_VERSION,
      site: { trailingSlash: "never" },
      trees: [
        {
          redirects: [
            { from: "/old", to: "/", status: 301, source: "config", via: [] },
          ],
          headers: [],
        },
      ],
    };
    expect(textOf(root, "netlify")).toBe(
      "/manifest.json /.pagedeck/unserved 404!\n/.pagedeck /.pagedeck/unserved 404!\n/.pagedeck/* /.pagedeck/unserved 404!\n/old / 301\n/old/ / 301!\n",
    );
  });
});

describe("a file target has no other spelling", () => {
  const FILE: RoutingManifest = {
    version: ROUTING_VERSION,
    site: { trailingSlash: "never" },
    trees: [
      {
        redirects: [
          {
            from: "/sitemap-index.xml",
            to: "/sitemap.xml",
            status: 301,
            source: "config",
            via: [],
            file: true,
          },
        ],
        headers: [],
      },
    ],
  };
  const request = { path: "/sitemap.xml/", found: false };

  it("the claim answers the slashed file with a 404", () => {
    expect(resolveRequest(FILE, request)).toEqual({ kind: "not-found" });
    expect(
      resolveRequest(FILE, { path: "/sitemap-index.xml/", found: false }),
    ).toEqual({ kind: "redirect", to: "/sitemap.xml", status: 301, headers: [] });
  });

  for (const target of TARGETS) {
    it(`${target} writes no rule for the slashed file`, () => {
      expect(textOf(FILE, target)).not.toContain("/sitemap.xml/");
    });
  }

  it("cloudfront-function answers the slashed file as the claim does", async () => {
    const { artifacts } = compileRouting(FILE, { target: "cloudfront-function" });
    expect(comparable(await interpretCloudFront(artifacts, request))).toEqual(
      comparable(resolveRequest(FILE, request)),
    );
  });

  it("netlify answers the slashed file as the claim does", () => {
    const { artifacts } = compileRouting(FILE, { target: "netlify" });
    expect(comparable(interpretNetlify(artifacts, request))).toEqual(
      comparable(resolveRequest(FILE, request)),
    );
  });

  it("nginx answers the slashed file as the claim does", () => {
    const { artifacts } = compileRouting(FILE, { target: "nginx" });
    expect(comparable(interpretNginx(artifacts, request))).toEqual(
      comparable(resolveRequest(FILE, request)),
    );
  });

  it("cloudflare-worker answers the slashed file as the claim does", async () => {
    const { artifacts } = compileRouting(FILE, { target: "cloudflare-worker" });
    expect(comparable(await interpretWorker(artifacts, request))).toEqual(
      comparable(resolveRequest(FILE, request)),
    );
  });
});

describe("under trailingSlash always, a file target is not redirected to itself", () => {
  const ALWAYS_FILE = planRouting({
    pages: [
      { locale: "en", path: "/", output: "/", dependencies: [] },
      { locale: "en", path: "/about/", output: "/about/", dependencies: [] },
    ],
    trailingSlash: "always",
    emitted: [{ path: "/sitemap.xml" }],
    config: {
      redirects: [
        { from: "/sitemap-index.xml", to: "/sitemap.xml", status: 301 },
        { from: "/legacy", to: "/about" },
      ],
    },
  });
  const tree = ALWAYS_FILE.trees[0];
  if (tree === undefined) throw new Error("expected one tree");
  const compiled = compiledTree(tree, "always").redirects;
  const HELD = new Set(["/", "/about/", "/sitemap.xml"]);
  const paths = [
    ...new Set([
      ...compiled.flatMap((rule) => [rule.from, rule.to]),
      "/sitemap.xml",
      "/sitemap.xml/",
    ]),
  ];

  it("the document spells the target as the file and marks it", () => {
    expect(tree.redirects).toContainEqual(
      expect.objectContaining({
        from: "/sitemap-index.xml/",
        to: "/sitemap.xml",
        file: true,
      }),
    );
  });

  it("the compiled tree holds no rule onto its own source and none from the file", () => {
    expect(compiled.filter((rule) => rule.from === rule.to)).toEqual([]);
    expect(compiled.filter((rule) => rule.from === "/sitemap.xml")).toEqual([]);
  });

  const answer = {
    "cloudfront-function": (request: EdgeRequest) =>
      interpretCloudFront(
        compileRouting(ALWAYS_FILE, { target: "cloudfront-function" }).artifacts,
        request,
      ),
    netlify: (request: EdgeRequest) =>
      interpretNetlify(
        compileRouting(ALWAYS_FILE, { target: "netlify" }).artifacts,
        request,
      ),
    nginx: (request: EdgeRequest) =>
      interpretNginx(
        compileRouting(ALWAYS_FILE, { target: "nginx" }).artifacts,
        request,
      ),
    "cloudflare-worker": (request: EdgeRequest) =>
      interpretWorker(
        compileRouting(ALWAYS_FILE, { target: "cloudflare-worker" }).artifacts,
        request,
      ),
  } as const;

  for (const target of TARGETS) {
    it(`${target} redirects no path to itself, and serves the file`, async () => {
      for (const path of paths) {
        const request = { path, found: HELD.has(path) };
        const resolution = await answer[target](request);
        expect(comparable(resolution)).toEqual(
          comparable(resolveRequest(ALWAYS_FILE, request)),
        );
        if (resolution.kind === "redirect") expect(resolution.to).not.toBe(path);
      }
      expect((await answer[target]({ path: "/sitemap.xml", found: true })).kind).toBe(
        "pass",
      );
    });
  }
});
