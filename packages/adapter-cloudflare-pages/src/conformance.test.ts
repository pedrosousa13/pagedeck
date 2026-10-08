import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { cloudflarePages } from "./index.js";
import { interpretCloudflarePages } from "./interpret.test-support.js";

// Not "never": this adapter refuses it (refusal.test.ts). The 404 a reserved key is proxied to is
// checked in reserved-keys.test.ts.
describeConformance({
  adapter: cloudflarePages(),
  interpret: interpretCloudflarePages,
  policies: ["always"],
  notFoundByHost: true,
});
