import { describeConformance } from "../../edge/src/conformance.test-support.js";
import { cloudflarePages } from "./index.js";
import { interpretCloudflarePages } from "./interpret.test-support.js";

// Not "never": this adapter refuses it (refusal.test.ts).
describeConformance({
  adapter: cloudflarePages(),
  interpret: interpretCloudflarePages,
  policies: ["always"],
  unverifiedNotFound: true,
  upstreams: {
    withUrl: "refused",
    withoutUrl: "routed",
    urlFix:
      'Cloudflare Pages proxies only to paths on its own site ("You cannot proxy external domains", https://developers.cloudflare.com/pages/configuration/redirects/), so run the app as Pages Functions under the prefix and remove url',
  },
});
