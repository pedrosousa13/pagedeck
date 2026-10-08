import { isDeepStrictEqual } from "node:util";

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
import { headersAt, resolveRequest } from "./oracle.test-support.js";
import type { EdgeRequest, Resolution } from "./oracle.test-support.js";

export interface AdapterUnderTest {
  adapter: EdgeAdapter;
  interpret(
    artifacts: readonly EdgeArtifact[],
    request: EdgeRequest,
  ): Resolution | Promise<Resolution>;
  /** The status a host serves for one the document declares, where it narrows it (#10). */
  servedStatus?(status: RedirectStatus): RedirectStatus;
  policies: readonly TrailingSlash[];
  /**
   * A 404 the host serves itself is checked for its kind (#559), and a proxied 404's headers only
   * where the 404 page's set and the requested path's agree (#39).
   */
  unverifiedNotFound?: boolean;
  /** No rule can redirect one trailing-slash spelling to the other, so the origin answers (#35). */
  noSlashRedirects?: boolean;
}

interface Spelling {
  page(path: string): string;
  other(path: string): string;
}

// Takes a path as a "never" site spells it.
function spellingOf(policy: TrailingSlash): Spelling {
  return policy === "always"
    ? { page: (path) => (path.endsWith("/") ? path : `${path}/`), other: (path) => path }
    : { page: (path) => path, other: (path) => `${path}/` };
}

// Respells a "never" fixture as `planRouting` would: a file target keeps its spelling, and a header
// prefix already ends in "/".
function underPolicy(
  manifest: RoutingManifest,
  policy: TrailingSlash,
): RoutingManifest {
  if (policy === "never") return manifest;
  const { page } = spellingOf(policy);
  return {
    ...manifest,
    site: { ...manifest.site, trailingSlash: policy },
    trees: manifest.trees.map((tree) => ({
      ...tree,
      redirects: tree.redirects.map((rule) => ({
        ...rule,
        from: page(rule.from),
        to: rule.file === true ? rule.to : page(rule.to),
        via: rule.via.map(page),
      })),
      ...(tree.notFound === undefined ? {} : { notFound: page(tree.notFound) }),
    })),
  };
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
  "remove the character; RFC 9110 forbids every control character but HTAB in a field value, where a line break can write a second header, and a Worker's Headers refuses any character above U+00FF";

export function withHeader(
  name: string,
  value: string,
  policy: TrailingSlash,
): RoutingManifest {
  // Written by hand: `planRouting` refuses most of these, but a compiler is handed a document.
  return {
    ...underPolicy(FIXTURE, policy),
    trees: [
      { redirects: [], headers: [{ prefix: "/", set: [{ name, value }] }] },
    ],
  };
}

const requests = ({
  page,
  other,
}: Spelling): readonly (EdgeRequest & { what: string })[] => [
  { what: "an exact redirect", path: page("/en/legacy"), found: false },
  {
    what: "a redirect that kept its first hop's status",
    path: page("/en/old-docs"),
    found: false,
  },
  {
    what: "a hop the chain flattened through",
    path: page("/en/docs-v1"),
    found: false,
  },
  {
    what: "the longer of two nested header prefixes",
    path: page("/en/docs/intro"),
    found: true,
  },
  {
    what: "the shorter of two nested header prefixes",
    path: page("/en/about"),
    found: true,
  },
  {
    what: "a sibling the longer prefix's slash scopes out",
    path: page("/en/docsearch"),
    found: true,
  },
  { what: "a path no prefix matches", path: page("/de/index"), found: true },
  { what: "a missing document", path: page("/missing"), found: false },
  {
    what: "a missing document under a longer prefix than the 404 page's",
    path: page("/en/docs/gone"),
    found: false,
  },
  {
    what: "the non-canonical spelling of a page",
    path: other("/en/about"),
    found: true,
  },
  {
    what: "the non-canonical spelling of a redirect source",
    path: other("/en/legacy"),
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
    path: page("/sale"),
    found: false,
  },
  {
    what: "a header on the second tree",
    domain: "shop.example",
    path: page("/deals"),
    found: true,
  },
  {
    what: "a missing document on the second tree",
    domain: "shop.example",
    path: page("/gone"),
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

const escapedRequests = ({
  page,
}: Spelling): readonly (EdgeRequest & { what: string })[] => [
  { what: "an escaped redirect source", path: page("/en/caf%C3%A9"), found: false },
  {
    what: "a page under an escaped header prefix",
    path: page("/en/caf%C3%A9/menu"),
    found: true,
  },
  { what: "a miss served by an escaped 404 page", path: page("/gone"), found: false },
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

const spellingRequests = ({
  page,
  other,
}: Spelling): readonly (EdgeRequest & { what: string })[] => [
  {
    what: "the non-canonical spelling of a redirect source",
    path: other("/en/legacy"),
    found: true,
  },
  {
    what: "the non-canonical spelling of a live page",
    path: other("/en/about"),
    found: true,
  },
  {
    what: "the canonical spelling of a live page",
    path: page("/en/about"),
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

const hardenedRequests = ({
  page,
}: Spelling): readonly (EdgeRequest & { what: string })[] => [
  { what: "a page", path: page("/new"), found: true },
  { what: "a redirect", path: page("/old"), found: false },
  { what: "a missing page", path: page("/gone"), found: false },
  { what: "a reserved deploy key", path: "/manifest.json", found: true },
];

export function describeConformance({
  adapter,
  interpret,
  servedStatus = (status) => status,
  policies,
  unverifiedNotFound = false,
  noSlashRedirects = false,
}: AdapterUnderTest): void {
  for (const policy of policies) {
    describe(`under trailingSlash "${policy}"`, () => {
      describePolicy(
        { adapter, interpret, servedStatus, unverifiedNotFound, noSlashRedirects },
        policy,
      );
    });
  }
}

function describePolicy(
  {
    adapter,
    interpret,
    servedStatus,
    unverifiedNotFound,
    noSlashRedirects,
  }: Required<Omit<AdapterUnderTest, "policies">>,
  policy: TrailingSlash,
): void {
  const { name } = adapter;
  const spelling = spellingOf(policy);
  const fixture = underPolicy(FIXTURE, policy);
  const escaped = underPolicy(ESCAPED, policy);
  const spellings = manifestOf(policy);
  const file = underPolicy(FILE, policy);
  const bare = underPolicy(BARE, policy);
  const hardened = underPolicy(HARDENED, policy);
  // The oracle's own claim, narrowed the way this adapter's host narrows a status (#10).
  const claimFor = (manifest: RoutingManifest, request: EdgeRequest): Resolution =>
    resolveRequest(manifest, request, servedStatus, noSlashRedirects);
  const check = (
    manifest: RoutingManifest,
    request: EdgeRequest,
    resolution: Resolution,
  ): void => {
    const answer = comparable(resolution);
    const claim = comparable(claimFor(manifest, request));
    if (
      !unverifiedNotFound ||
      answer.kind !== "not-found" ||
      claim.kind !== "not-found" ||
      !("document" in claim)
    ) {
      expect(answer).toEqual(claim);
    } else if (!("document" in answer)) {
      expect(answer).toEqual({ kind: "not-found" });
    } else if (
      isDeepStrictEqual(
        claim.headers,
        comparable({ kind: "pass", headers: headersAt(manifest, request) }).headers,
      )
    ) {
      expect(answer).toEqual(claim);
    } else {
      expect(answer.document).toBe(claim.document);
    }
  };
  const expectAnswer = async (
    manifest: RoutingManifest,
    request: EdgeRequest,
  ): Promise<void> => {
    check(
      manifest,
      request,
      await interpret(adapter.compile(manifest).artifacts, request),
    );
  };

  describe("one document, every target, one behavior", () => {
    for (const request of requests(spelling)) {
      it(`${name} answers ${request.what} the way the document says`, async () => {
        await expectAnswer(fixture, request);
      });
    }
  });

  describe("compile is deterministic", () => {
    // Same document, identical artifacts, or an unchanged document republishes a function on
    // every deploy.
    it(`compiles ${name} to identical text twice`, () => {
      expect(adapter.compile(fixture)).toEqual(adapter.compile(fixture));
    });
  });

  describe("an escaped path answers the same on every target", () => {
    for (const request of escapedRequests(spelling)) {
      it(`${name} answers ${request.what}`, async () => {
        await expectAnswer(escaped, request);
      });
    }
  });

  describe("the site's trailing-slash policy reaches every target", () => {
    // Not followed by "/": under "always" the other spelling is a prefix of the canonical one.
    const alone = (path: string) => new RegExp(`${spelling.other(path)}(?!/)`);

    it(`${name} rules on the non-canonical spelling of a redirect source`, () => {
      expect(textOf(adapter, spellings)).toMatch(alone("/en/legacy"));
    });

    if (!noSlashRedirects) {
      it(`${name} rules on the non-canonical spelling of a page`, () => {
        expect(textOf(adapter, spellings)).toMatch(alone("/en/about"));
      });
    }
  });

  describe("a non-canonical spelling answers the same on every target", () => {
    for (const request of spellingRequests(spelling)) {
      it(`${name} answers ${request.what}`, async () => {
        await expectAnswer(spellings, request);
      });
    }
  });

  describe("a file target has no other spelling", () => {
    it(`${name} writes no rule for the slashed file`, () => {
      expect(textOf(adapter, file)).not.toContain("/sitemap.xml/");
    });

    it(`${name} answers the slashed file as the claim does`, async () => {
      await expectAnswer(file, SLASHED_FILE);
    });
  });

  if (policy === "always") {
    describe("a file target is not redirected to itself", () => {
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
          check(ALWAYS_FILE, request, resolution);
          if (resolution.kind === "redirect") expect(resolution.to).not.toBe(path);
        }
        expect((await resolve({ path: "/sitemap.xml", found: true })).kind).toBe(
          "pass",
        );
      });
    });
  }

  describe("every target answers a reserved deploy key with the site's 404", () => {
    for (const request of KEYS) {
      it(`${name}, for ${request.what}`, async () => {
        const claim = claimFor(fixture, request);
        expect(claim.kind).toBe("not-found");
        await expectAnswer(fixture, request);
      });
    }

    for (const request of NEIGHBOURS) {
      it(`${name}, and serves ${request.what} as the site file it is`, async () => {
        const claim = claimFor(fixture, request);
        expect(claim.kind).toBe("pass");
        await expectAnswer(fixture, request);
      });
    }
  });

  describe("a site with no 404 page", () => {
    for (const request of KEYS.filter((key) => key.domain === undefined)) {
      it(`gets a bare 404 from ${name} for ${request.what}, whatever header rule covers it`, async () => {
        expect(claimFor(bare, request)).toEqual({ kind: "not-found" });
        await expectAnswer(bare, request);
      });
    }

    it(`still gets its headers on a page from ${name}`, async () => {
      const request = { path: spelling.page("/about"), found: true };
      await expectAnswer(bare, request);
    });
  });

  describe("the emitted rule", () => {
    it(`is compiled by ${name} into a tree that declares nothing at all`, () => {
      const empty: RoutingManifest = {
        version: ROUTING_VERSION,
        site: { trailingSlash: policy },
        trees: [{ redirects: [], headers: [] }],
      };
      expect(adapter.compile(empty).artifacts.length, name).toBeGreaterThan(0);
    });
  });

  describe("a site's whole security set, HSTS and CSP included, on every target", () => {
    for (const request of hardenedRequests(spelling)) {
      it(`answers ${request.what} on ${name} with all five fields, as the document says`, async () => {
        const claim = comparable(claimFor(hardened, request));
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
        await expectAnswer(hardened, request);
      });
    }
  });

  describe("compile refusals", () => {
    it(`refuses a header name holding a space on ${name}`, () => {
      expect(() =>
        adapter.compile(withHeader("X-Frame Options", "DENY", policy)),
      ).toThrow(
        new ConfigError(
          `Edge target "${name}": 1 header name is not a token — ${HEADER_NAME_FIX}:
  the default tree's header name "X-Frame Options" under prefix "/" — the header name holds " ", and a header name is one RFC 9110 token`,
        ),
      );
    });

    for (const [character, reason] of [
      ["#", "which a line-based headers file can read as the start of a comment"],
      ["!", "which a line-based headers file can read as a detach"],
    ] as const) {
      it(`refuses a header name beginning ${JSON.stringify(character)} on ${name}`, () => {
        expect(() =>
          adapter.compile(withHeader(`${character}X-Frame-Options`, "DENY", policy)),
        ).toThrow(
          new ConfigError(
            `Edge target "${name}": 1 header name is not a token — ${HEADER_NAME_FIX}:
  the default tree's header name "${character}X-Frame-Options" under prefix "/" — the header name begins "${character}", ${reason}`,
          ),
        );
      });
    }

    for (const [what, character, named] of [
      ["CR", "\r", "U+000D"],
      ["U+0001", "\u0001", "U+0001"],
      ["backspace", "\b", "U+0008"],
      ["a vertical tab", "\v", "U+000B"],
      ["U+001F", "\u001F", "U+001F"],
      ["DEL", "\u007F", "U+007F"],
      ["LF", "\n", "U+000A"],
      ["NUL", "\u0000", "U+0000"],
      ["U+0100", "Ā", "U+0100"],
      ["an emoji", "\u{1F600}", "U+1F600"],
    ] as const) {
      it(`refuses a header value holding ${what} on ${name}, never quoting the value`, () => {
        expect(() =>
          adapter.compile(withHeader("X-Note", `a${character}b`, policy)),
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
        adapter.compile(withHeader("X-Note", "café", policy)),
      ).not.toThrow();
    });

    // RFC 9110's obs-text is %x80-FF, so a C1 control is a field-value character.
    for (const [what, value] of [
      ["HTAB", "a\tb"],
      ["U+0080", "a\u0080b"],
      ["U+0085", "a\u0085b"],
      ["U+009F", "a\u009Fb"],
    ] as const) {
      it(`compiles a header value holding ${what} on ${name}`, () => {
        expect(() =>
          adapter.compile(withHeader("X-Note", value, policy)),
        ).not.toThrow();
      });
    }
  });
}
