import { describe, expect, it } from "vitest";

import { ConfigError } from "@pagedeck/core/exit";
import {
  planRouting,
  ROUTING_VERSION,
  SECURITY_HEADERS,
} from "@pagedeck/core/routing";
import type {
  RedirectStatus,
  RoutingManifest,
  TrailingSlash,
} from "@pagedeck/core/routing";

import type { EdgeAdapter } from "./adapter.js";
import type { EdgeArtifact } from "./artifact.js";
import { FIXTURE } from "./fixture.test-support.js";
import { comparable } from "./interpret.test-support.js";
import { compiledTree } from "./normalize.js";
import { resolveRequest } from "./oracle.test-support.js";
import type { EdgeRequest, Resolution } from "./oracle.test-support.js";

export interface AdapterUnderTest {
  adapter: EdgeAdapter;
  interpret(
    artifacts: readonly EdgeArtifact[],
    request: EdgeRequest,
  ): Resolution | Promise<Resolution>;
  /** The status a host serves for one the document declares, where it narrows it (#10). */
  servedStatus?(status: RedirectStatus): RedirectStatus;
}

export function textOf(adapter: EdgeAdapter, manifest: RoutingManifest): string {
  return adapter
    .compile(manifest)
    .artifacts.map((artifact) => artifact.contents)
    .join("\n");
}

export function contentsOf(
  adapter: EdgeAdapter,
  manifest: RoutingManifest,
  path: string,
): string {
  const artifact = adapter
    .compile(manifest)
    .artifacts.find(
      (candidate) => candidate.domain === undefined && candidate.path === path,
    );
  if (artifact === undefined) {
    throw new Error(`no ${path} for ${adapter.name}`);
  }
  return artifact.contents;
}

export const HEADER_NAME_FIX =
  'write the name as a header field name, such as "X-Frame-Options"; a name that is not one is emitted verbatim, and each target then either reads that line as a different field than the one written, or refuses it outright after the build has already reported success';
export const HEADER_VALUE_FIX =
  "remove the character; RFC 9110 forbids CR, LF and NUL in a field value, where a line break can write a second header, and a Worker's Headers refuses any character above U+00FF";

export function withHeader(name: string, value: string): RoutingManifest {
  // Written by hand: `planRouting` refuses most of these, but a compiler is handed a document.
  return {
    ...FIXTURE,
    trees: [
      { redirects: [], headers: [{ prefix: "/", set: [{ name, value }] }] },
    ],
  };
}

const REQUESTS: readonly (EdgeRequest & { what: string })[] = [
  { what: "an exact redirect", path: "/en/legacy", found: false },
  {
    what: "a redirect that kept its first hop's status",
    path: "/en/old-docs",
    found: false,
  },
  {
    what: "a hop the chain flattened through",
    path: "/en/docs-v1",
    found: false,
  },
  {
    what: "the longer of two nested header prefixes",
    path: "/en/docs/intro",
    found: true,
  },
  {
    what: "the shorter of two nested header prefixes",
    path: "/en/about",
    found: true,
  },
  {
    what: "a sibling the longer prefix's slash scopes out",
    path: "/en/docsearch",
    found: true,
  },
  { what: "a path no prefix matches", path: "/de/index", found: true },
  { what: "a missing document", path: "/missing", found: false },
  {
    what: "a missing document under a longer prefix than the 404 page's",
    path: "/en/docs/gone",
    found: false,
  },
  {
    what: "the non-canonical spelling of a page",
    path: "/en/about/",
    found: true,
  },
  {
    what: "the non-canonical spelling of a redirect source",
    path: "/en/legacy/",
    found: true,
  },
  { what: "the live manifest", path: "/manifest.json", found: true },
  {
    what: "a manifest in the deploy history",
    path: "/.pagedeck/manifests/0b6e4f53-3f0c-4a5e-9d0f-6f7f1d2a9c11.json",
    found: true,
  },
  {
    what: "a deploy instant in the deploy history",
    path: "/.pagedeck/manifests/0b6e4f53-3f0c-4a5e-9d0f-6f7f1d2a9c11.deployed-at",
    found: true,
  },
  {
    what: "a redirect on the second tree",
    domain: "shop.example",
    path: "/sale",
    found: false,
  },
  {
    what: "a header on the second tree",
    domain: "shop.example",
    path: "/deals",
    found: true,
  },
  {
    what: "a missing document on the second tree",
    domain: "shop.example",
    path: "/gone",
    found: false,
  },
];

export const ESCAPED: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "never" },
  trees: [
    {
      redirects: [
        {
          from: "/en/caf%C3%A9",
          to: "/en/coffee",
          status: 301,
          source: "config",
          via: [],
        },
      ],
      notFound: "/en/404-caf%C3%A9",
      headers: [
        {
          prefix: "/en/caf%C3%A9/",
          set: [{ name: "X-Frame-Options", value: "DENY" }],
        },
      ],
    },
  ],
};

const ESCAPED_REQUESTS: readonly (EdgeRequest & { what: string })[] = [
  { what: "an escaped redirect source", path: "/en/caf%C3%A9", found: false },
  {
    what: "a page under an escaped header prefix",
    path: "/en/caf%C3%A9/menu",
    found: true,
  },
  { what: "a miss served by an escaped 404 page", path: "/gone", found: false },
];

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

export const NEVER = manifestOf("never");
const ALWAYS = manifestOf("always");

const SPELLING_REQUESTS: readonly (EdgeRequest & { what: string })[] = [
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

export const FILE: RoutingManifest = {
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
export const SLASHED_FILE = { path: "/sitemap.xml/", found: false };

export const ALWAYS_FILE = planRouting({
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
export const ALWAYS_FILE_HELD = new Set(["/", "/about/", "/sitemap.xml"]);

export const EN_HEADERS = [
  { name: "X-Content-Type-Options", value: "nosniff" },
  { name: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

export const ID = "0b6e4f53-3f0c-4a5e-9d0f-6f7f1d2a9c11";

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

export const SITE_404: Resolution = {
  kind: "not-found",
  document: "/en/404",
  headers: EN_HEADERS,
};

/** Spellings a host resolves to a reserved deploy key; Netlify's reading of them is not modelled. */
export const SPELLINGS: readonly (EdgeRequest & { what: string })[] = [
  { what: "an escaped dot", path: "/%2Epagedeck/manifests/a.json", found: true },
  { what: "an escaped letter", path: "/manifest.%6Ason", found: true },
  { what: "an escaped slash", path: "/.pagedeck%2Fmanifests%2Fa.json", found: true },
  { what: "a doubled slash", path: "//.pagedeck//manifests/a.json", found: true },
  { what: "a dot segment", path: "/en/../.pagedeck/manifests/a.json", found: true },
  { what: "a current-directory segment", path: "/./manifest.json", found: true },
];

export const SECURITY_MANIFEST: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "never" },
  trees: [
    {
      redirects: [],
      headers: [{ prefix: "/", set: [...SECURITY_HEADERS] }],
    },
  ],
};

const POLICY = "default-src 'self'; script-src 'self' 'sha256-AbC+/='";
export const HARDENED: RoutingManifest = {
  version: ROUTING_VERSION,
  site: { trailingSlash: "never" },
  trees: [
    {
      redirects: [
        { from: "/old", to: "/new", status: 301, source: "config", via: [] },
      ],
      notFound: "/404",
      headers: [
        {
          prefix: "/",
          set: [
            ...SECURITY_HEADERS,
            {
              name: "Strict-Transport-Security",
              value: "max-age=63072000; includeSubDomains",
            },
            { name: "Content-Security-Policy", value: POLICY },
          ],
        },
      ],
    },
  ],
};

const HARDENED_REQUESTS: readonly (EdgeRequest & { what: string })[] = [
  { what: "a page", path: "/new", found: true },
  { what: "a redirect", path: "/old", found: false },
  { what: "a missing page", path: "/gone", found: false },
  { what: "a reserved deploy key", path: "/manifest.json", found: true },
];

export function describeConformance({
  adapter,
  interpret,
  servedStatus = (status) => status,
}: AdapterUnderTest): void {
  const { name } = adapter;
  const answer = async (
    manifest: RoutingManifest,
    request: EdgeRequest,
  ): Promise<Resolution> =>
    comparable(await interpret(adapter.compile(manifest).artifacts, request));
  // The oracle's own claim, narrowed the way this adapter's host narrows a status (#10).
  const claimFor = (manifest: RoutingManifest, request: EdgeRequest): Resolution =>
    resolveRequest(manifest, request, servedStatus);

  describe("one document, every target, one behavior", () => {
    for (const request of REQUESTS) {
      it(`${name} answers ${request.what} the way the document says`, async () => {
        expect(await answer(FIXTURE, request)).toEqual(
          comparable(claimFor(FIXTURE, request)),
        );
      });
    }
  });

  describe("compile is deterministic", () => {
    // Same document, identical artifacts, or an unchanged document republishes a function on
    // every deploy.
    it(`compiles ${name} to identical text twice`, () => {
      expect(adapter.compile(FIXTURE)).toEqual(adapter.compile(FIXTURE));
    });
  });

  describe("an escaped path answers the same on every target", () => {
    for (const request of ESCAPED_REQUESTS) {
      it(`${name} answers ${request.what}`, async () => {
        expect(await answer(ESCAPED, request)).toEqual(
          comparable(claimFor(ESCAPED, request)),
        );
      });
    }
  });

  describe("the site's trailing-slash policy reaches every target", () => {
    it(`${name} rules on the non-canonical spelling of a redirect source`, () => {
      expect(textOf(adapter, NEVER)).toContain("/en/legacy/");
    });

    it(`${name} rules on the non-canonical spelling of a page`, () => {
      expect(textOf(adapter, NEVER)).toContain("/en/about/");
    });

    it(`${name} reads the policy rather than assuming one`, () => {
      // Matched with the following character, since the canonical spelling ends in a slash here.
      const text = textOf(adapter, ALWAYS);
      expect(text).toMatch(/\/en\/legacy[^/]/);
      expect(text).toMatch(/\/en\/about[^/]/);
    });
  });

  describe("a non-canonical spelling answers the same on every target", () => {
    for (const request of SPELLING_REQUESTS) {
      it(`${name} answers ${request.what}`, async () => {
        expect(await answer(NEVER, request)).toEqual(
          comparable(claimFor(NEVER, request)),
        );
      });
    }
  });

  describe("a file target has no other spelling", () => {
    it(`${name} writes no rule for the slashed file`, () => {
      expect(textOf(adapter, FILE)).not.toContain("/sitemap.xml/");
    });

    it(`${name} answers the slashed file as the claim does`, async () => {
      expect(await answer(FILE, SLASHED_FILE)).toEqual(
        comparable(claimFor(FILE, SLASHED_FILE)),
      );
    });
  });

  describe("under trailingSlash always, a file target is not redirected to itself", () => {
    const tree = ALWAYS_FILE.trees[0];
    if (tree === undefined) throw new Error("expected one tree");
    const paths = [
      ...new Set([
        ...compiledTree(tree, "always").redirects.flatMap((rule) => [
          rule.from,
          rule.to,
        ]),
        "/sitemap.xml",
        "/sitemap.xml/",
      ]),
    ];
    const resolve = async (request: EdgeRequest): Promise<Resolution> =>
      interpret(adapter.compile(ALWAYS_FILE).artifacts, request);

    it(`${name} redirects no path to itself, and serves the file`, async () => {
      for (const path of paths) {
        const request = { path, found: ALWAYS_FILE_HELD.has(path) };
        const resolution = await resolve(request);
        expect(comparable(resolution)).toEqual(
          comparable(claimFor(ALWAYS_FILE, request)),
        );
        if (resolution.kind === "redirect") expect(resolution.to).not.toBe(path);
      }
      expect((await resolve({ path: "/sitemap.xml", found: true })).kind).toBe(
        "pass",
      );
    });
  });

  describe("every target answers a reserved deploy key with the site's 404", () => {
    for (const request of KEYS) {
      it(`${name}, for ${request.what}`, async () => {
        const claim = claimFor(FIXTURE, request);
        expect(claim.kind).toBe("not-found");
        expect(await answer(FIXTURE, request)).toEqual(comparable(claim));
      });
    }

    for (const request of NEIGHBOURS) {
      it(`${name}, and serves ${request.what} as the site file it is`, async () => {
        const claim = claimFor(FIXTURE, request);
        expect(claim.kind).toBe("pass");
        expect(await answer(FIXTURE, request)).toEqual(comparable(claim));
      });
    }
  });

  describe("a site with no 404 page", () => {
    for (const request of KEYS.filter((key) => key.domain === undefined)) {
      it(`gets a bare 404 from ${name} for ${request.what}, whatever header rule covers it`, async () => {
        expect(claimFor(BARE, request)).toEqual({ kind: "not-found" });
        expect(await answer(BARE, request)).toEqual(
          comparable({ kind: "not-found" }),
        );
      });
    }

    it(`still gets its headers on a page from ${name}`, async () => {
      const request = { path: "/about", found: true };
      expect(await answer(BARE, request)).toEqual(
        comparable(claimFor(BARE, request)),
      );
    });
  });

  describe("the emitted rule", () => {
    it(`is compiled by ${name} into a tree that declares nothing at all`, () => {
      const empty: RoutingManifest = {
        version: ROUTING_VERSION,
        site: { trailingSlash: "never" },
        trees: [{ redirects: [], headers: [] }],
      };
      expect(adapter.compile(empty).artifacts.length, name).toBeGreaterThan(0);
    });
  });

  describe("a site's whole security set, HSTS and CSP included, on every target", () => {
    for (const request of HARDENED_REQUESTS) {
      it(`answers ${request.what} on ${name} with all five fields, as the document says`, async () => {
        const claim = comparable(claimFor(HARDENED, request));
        expect(
          (("headers" in claim ? claim.headers : undefined) ?? []).map(
            (field) => field.name,
          ),
        ).toEqual([
          "content-security-policy",
          "referrer-policy",
          "strict-transport-security",
          "x-content-type-options",
          "x-frame-options",
        ]);
        expect(await answer(HARDENED, request)).toEqual(claim);
      });
    }
  });

  describe("compile refusals", () => {
    it(`refuses a header name holding a space on ${name}`, () => {
      expect(() =>
        adapter.compile(withHeader("X-Frame Options", "DENY")),
      ).toThrow(
        new ConfigError(
          `Edge target "${name}": 1 header name is not a token — ${HEADER_NAME_FIX}:
  the default tree's header name "X-Frame Options" under prefix "/" — the header name holds " ", and a header name is one RFC 9110 token`,
        ),
      );
    });

    for (const [what, character, named] of [
      ["CR", "\r", "U+000D"],
      ["LF", "\n", "U+000A"],
      ["NUL", "\u0000", "U+0000"],
      ["U+0100", "Ā", "U+0100"],
      ["an emoji", "\u{1F600}", "U+1F600"],
    ] as const) {
      it(`refuses a header value holding ${what} on ${name}, never quoting the value`, () => {
        expect(() =>
          adapter.compile(withHeader("X-Note", `a${character}b`)),
        ).toThrow(
          new ConfigError(
            `Edge target "${name}": 1 header value cannot be sent — ${HEADER_VALUE_FIX}:
  the default tree's header "X-Note" under prefix "/" — the header value holds ${named}`,
          ),
        );
      });
    }

    it(`compiles a header value holding "é", below U+0100, on ${name}`, () => {
      expect(() =>
        adapter.compile(withHeader("X-Note", "café")),
      ).not.toThrow();
    });
  });
}
