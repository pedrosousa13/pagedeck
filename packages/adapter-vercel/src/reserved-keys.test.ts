import { describe, expect, it } from "vitest";

import { contentsOf } from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { vercel } from "./index.js";

describe("the emitted rule", () => {
  it("is the first rows of routes, ahead of the filesystem the origin holds", () => {
    const routes = JSON.parse(contentsOf(vercel(), FIXTURE, "/vercel.json")).routes as readonly {
      src?: string;
      handle?: string;
    }[];
    expect(routes.slice(0, 3).map((route) => route.src)).toEqual([
      "^/manifest\\.json$",
      "^/\\.pagedeck$",
      "^/\\.pagedeck/.*$",
    ]);
    expect(routes[3]).toEqual({ handle: "filesystem" });
  });
});
