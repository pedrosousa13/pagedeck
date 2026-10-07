import { describe, expect, it } from "vitest";

import {
  contentsOf,
  SITE_404,
  SPELLINGS,
} from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { nginx } from "./index.js";
import { interpretNginx } from "./interpret.test-support.js";

describe("spellings a host resolves to a reserved deploy key", () => {
  for (const request of SPELLINGS) {
    it(`are answered with the site's 404 on nginx: ${request.what}`, () => {
      const { artifacts } = nginx().compile(FIXTURE);
      expect(interpretNginx(artifacts, request)).toEqual(SITE_404);
    });
  }
});

describe("the emitted rule", () => {
  it("is a server-level return in the nginx fragment, ahead of every location", () => {
    const conf = contentsOf(nginx(), FIXTURE, "routing.conf");
    const deny = conf.indexOf('if ($uri = "/manifest.json") { return 404; }');
    expect(deny).toBeGreaterThan(-1);
    expect(conf).toContain('if ($uri ~ "^/\\.pagedeck(/|$)") { return 404; }');
    expect(deny).toBeLessThan(conf.indexOf("location"));
  });
});
