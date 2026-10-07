import { describe, expect, it } from "vitest";

import type { RoutingManifest } from "@pagedeck/core/routing";
import { ROUTING_VERSION } from "@pagedeck/core/routing";

import { compileRouting } from "./index.js";
import { FIXTURE } from "./fixture.test-support.js";
import {
  comparable,
  interpretCloudFront,
  interpretNetlify,
  interpretNginx,
  interpretWorker,
} from "./interpret.test-support.js";
import { resolveRequest } from "./oracle.test-support.js";
import type { EdgeRequest, Resolution } from "./oracle.test-support.js";

const EN_HEADERS = [
  { name: "X-Content-Type-Options", value: "nosniff" },
  { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const ID = "0b6e4f53-3f0c-4a5e-9d0f-6f7f1d2a9c11";

const KEYS: readonly (EdgeRequest & { what: string })[] = [
  { what: "the live manifest", path: "/manifest.json", found: true },
  {
    what: "a manifest in the history",
    path: `/.pagedeck/manifests/${ID}.json`,
    found: true,
  },
  {
    what: "a deploy instant in the history",
    path: `/.pagedeck/manifests/${ID}.deployed-at`,
    found: true,
  },
  // `found: false`: no origin holds a file at the manifest's name with a slash after it.
  { what: "the live manifest, slashed", path: "/manifest.json/", found: false },
  { what: "the history's directory", path: "/.pagedeck", found: true },
  { what: "the history's directory, slashed", path: "/.pagedeck/", found: true },
  {
    what: "the live manifest on a domain tree",
    domain: "shop.example",
    path: "/manifest.json",
    found: true,
  },
  {
    what: "the history on a domain tree",
    domain: "shop.example",
    path: `/.pagedeck/manifests/${ID}.json`,
    found: true,
  },
];

const NEIGHBOURS: readonly (EdgeRequest & { what: string })[] = [
  { what: "a sibling of the history's directory", path: "/.fwd", found: true },
  { what: "a manifest under a page", path: "/en/manifest.json", found: true },
];

async function answers(
  manifest: RoutingManifest,
  request: EdgeRequest,
): Promise<Record<string, Resolution>> {
  const compiled = (target: string) =>
    compileRouting(manifest, { target }).artifacts;
  return {
    "cloudfront-function": comparable(
      await interpretCloudFront(compiled("cloudfront-function"), request),
    ),
    netlify: comparable(interpretNetlify(compiled("netlify"), request)),
    nginx: comparable(interpretNginx(compiled("nginx"), request)),
    "cloudflare-worker": comparable(
      await interpretWorker(compiled("cloudflare-worker"), request),
    ),
  };
}

function everywhere(resolution: Resolution): Record<string, Resolution> {
  const expected = comparable(resolution);
  return {
    "cloudfront-function": expected,
    netlify: expected,
    nginx: expected,
    "cloudflare-worker": expected,
  };
}

describe("the oracle", () => {
  it("claims the site's 404 for a reserved deploy key the origin holds", () => {
    expect(
      resolveRequest(FIXTURE, { path: "/manifest.json", found: true }),
    ).toEqual({ kind: "not-found", document: "/en/404", headers: EN_HEADERS });
    expect(
      resolveRequest(FIXTURE, {
        domain: "shop.example",
        path: `/.pagedeck/manifests/${ID}.deployed-at`,
        found: true,
      }),
    ).toEqual({
      kind: "not-found",
      document: "/shop-404",
      headers: [{ name: "X-Content-Type-Options", value: "nosniff" }],
    });
  });

  it("does not claim a path that only begins like the history's directory", () => {
    expect(resolveRequest(FIXTURE, { path: "/.fwd", found: true })).toEqual({
      kind: "pass",
      headers: [],
    });
  });
});

describe("every target answers a reserved deploy key with the site's 404", () => {
  for (const request of KEYS) {
    it(`for ${request.what}`, async () => {
      const claim = resolveRequest(FIXTURE, request);
      expect(claim.kind).toBe("not-found");
      expect(await answers(FIXTURE, request)).toEqual(everywhere(claim));
    });
  }

  for (const request of NEIGHBOURS) {
    it(`and serves ${request.what} as the site file it is`, async () => {
      const claim = resolveRequest(FIXTURE, request);
      expect(claim.kind).toBe("pass");
      expect(await answers(FIXTURE, request)).toEqual(everywhere(claim));
    });
  }
});

const BARE: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "never" },
  trees: [
    {
      redirects: [],
      headers: [
        {
          prefix: "/.pagedeck/manifests/",
          set: [{ name: "Cache-Control", value: "public, max-age=60" }],
        },
        {
          prefix: "/",
          set: [{ name: "X-Content-Type-Options", value: "nosniff" }],
        },
      ],
    },
  ],
};

describe("a site with no 404 page", () => {
  for (const request of KEYS.filter((key) => key.domain === undefined)) {
    it(`gets a bare 404 for ${request.what}, whatever header rule covers it`, async () => {
      expect(resolveRequest(BARE, request)).toEqual({ kind: "not-found" });
      expect(await answers(BARE, request)).toEqual(
        everywhere({ kind: "not-found" }),
      );
    });
  }

  it("still gets its headers on a page", async () => {
    const request = { path: "/about", found: true };
    expect(await answers(BARE, request)).toEqual(
      everywhere(resolveRequest(BARE, request)),
    );
  });
});

const SITE_404: Resolution = {
  kind: "not-found",
  document: "/en/404",
  headers: EN_HEADERS,
};

const SPELLINGS: readonly (EdgeRequest & { what: string })[] = [
  { what: "an escaped dot", path: "/%2Epagedeck/manifests/a.json", found: true },
  { what: "an escaped letter", path: "/manifest.%6Ason", found: true },
  { what: "an escaped slash", path: "/.pagedeck%2Fmanifests%2Fa.json", found: true },
  { what: "a doubled slash", path: "//.pagedeck//manifests/a.json", found: true },
  { what: "a dot segment", path: "/en/../.pagedeck/manifests/a.json", found: true },
  { what: "a current-directory segment", path: "/./manifest.json", found: true },
];

describe("spellings a host resolves to a reserved deploy key", () => {
  for (const request of SPELLINGS) {
    it(`are answered with the site's 404 on cloudfront-function: ${request.what}`, async () => {
      const { artifacts } = compileRouting(FIXTURE, {
        target: "cloudfront-function",
      });
      expect(
        comparable(await interpretCloudFront(artifacts, request)),
      ).toEqual(comparable(SITE_404));
    });

    it(`are answered with the site's 404 on nginx: ${request.what}`, () => {
      const { artifacts } = compileRouting(FIXTURE, { target: "nginx" });
      expect(interpretNginx(artifacts, request)).toEqual(SITE_404);
    });

    it(`are answered with the site's 404 on cloudflare-worker: ${request.what}`, async () => {
      const { artifacts } = compileRouting(FIXTURE, {
        target: "cloudflare-worker",
      });
      expect(comparable(await interpretWorker(artifacts, request))).toEqual(
        comparable(SITE_404),
      );
    });
  }
});

describe("the emitted rule", () => {
  function contentsOf(
    manifest: RoutingManifest,
    target: string,
    path: string,
  ): string {
    const artifact = compileRouting(manifest, { target }).artifacts.find(
      (candidate) => candidate.domain === undefined && candidate.path === path,
    );
    if (artifact === undefined) throw new Error(`no ${path} for ${target}`);
    return artifact.contents;
  }

  it("is the first rows of _redirects, forced past the files the origin holds", () => {
    expect(contentsOf(FIXTURE, "netlify", "/_redirects")).toMatch(
      /^\/manifest\.json \/en\/404 404!\n\/\.pagedeck \/en\/404 404!\n\/\.pagedeck\/\* \/en\/404 404!\n/,
    );
  });

  it("is a server-level return in the nginx fragment, ahead of every location", () => {
    const conf = contentsOf(FIXTURE, "nginx", "routing.conf");
    const deny = conf.indexOf('if ($uri = "/manifest.json") { return 404; }');
    expect(deny).toBeGreaterThan(-1);
    expect(conf).toContain('if ($uri ~ "^/\\.pagedeck(/|$)") { return 404; }');
    expect(deny).toBeLessThan(conf.indexOf("location"));
  });

  it("is compiled into a tree that declares nothing at all", () => {
    const empty: RoutingManifest = {
      version: ROUTING_VERSION,
      site: { trailingSlash: "never" },
      trees: [{ redirects: [], headers: [] }],
    };
    for (const target of [
      "cloudfront-function",
      "netlify",
      "nginx",
      "cloudflare-worker",
    ]) {
      expect(
        compileRouting(empty, { target }).artifacts.length,
        target,
      ).toBeGreaterThan(0);
    }
  });
});
