import { describe, expect, it } from "vitest";

import {
  SITE_404,
  SPELLINGS,
} from "../../edge/src/conformance.test-support.js";
import { FIXTURE } from "../../edge/src/fixture.test-support.js";
import { comparable } from "../../edge/src/interpret.test-support.js";
import { cloudfront } from "./index.js";
import { interpretCloudFront } from "./interpret.test-support.js";

describe("spellings a host resolves to a reserved deploy key", () => {
  for (const request of SPELLINGS) {
    it(`are answered with the site's 404 on cloudfront-function: ${request.what}`, async () => {
      const { artifacts } = cloudfront().compile(FIXTURE);
      expect(
        comparable(await interpretCloudFront(artifacts, request)),
      ).toEqual(comparable(SITE_404));
    });
  }
});
