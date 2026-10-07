import { describe, expect, it } from "vitest";

import {
  SITE_404,
  SPELLINGS,
} from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { comparable } from "../../edge/src/interpret.test-support.js";
import { cloudflareWorker } from "./index.js";
import { interpretWorker } from "./interpret.test-support.js";

describe("spellings a host resolves to a reserved deploy key", () => {
  for (const request of SPELLINGS) {
    it(`are answered with the site's 404 on cloudflare-worker: ${request.what}`, async () => {
      const { artifacts } = cloudflareWorker().compile(FIXTURE);
      expect(comparable(await interpretWorker(artifacts, request))).toEqual(
        comparable(SITE_404),
      );
    });
  }
});
