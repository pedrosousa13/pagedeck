import { describe, expect, it } from "vitest";

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
import type { EdgeRequest } from "./oracle.test-support.js";

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

describe("one document, every target, one behavior", () => {
  for (const request of REQUESTS) {
    it(`cloudfront-function answers ${request.what} the way the document says`, async () => {
      const { artifacts } = compileRouting(FIXTURE, {
        target: "cloudfront-function",
      });
      expect(comparable(await interpretCloudFront(artifacts, request))).toEqual(
        comparable(resolveRequest(FIXTURE, request)),
      );
    });

    it(`netlify answers ${request.what} the way the document says`, () => {
      const { artifacts } = compileRouting(FIXTURE, { target: "netlify" });
      expect(comparable(interpretNetlify(artifacts, request))).toEqual(
        comparable(resolveRequest(FIXTURE, request)),
      );
    });

    it(`nginx answers ${request.what} the way the document says`, () => {
      const { artifacts } = compileRouting(FIXTURE, { target: "nginx" });
      expect(comparable(interpretNginx(artifacts, request))).toEqual(
        comparable(resolveRequest(FIXTURE, request)),
      );
    });

    it(`cloudflare-worker answers ${request.what} the way the document says`, async () => {
      const { artifacts } = compileRouting(FIXTURE, {
        target: "cloudflare-worker",
      });
      expect(comparable(await interpretWorker(artifacts, request))).toEqual(
        comparable(resolveRequest(FIXTURE, request)),
      );
    });
  }
});

describe("compileRouting is deterministic", () => {
  // Same document, identical artifacts, or an unchanged document republishes a function on
  // every deploy.
  for (const target of [
    "cloudfront-function",
    "netlify",
    "nginx",
    "cloudflare-worker",
  ] as const) {
    it(`compiles ${target} to identical text twice`, () => {
      expect(compileRouting(FIXTURE, { target })).toEqual(
        compileRouting(FIXTURE, { target }),
      );
    });
  }
});
