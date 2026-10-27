import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileCloudflarePages } from "./cloudflare-pages.js";
import { checkWrangler } from "./wrangler.js";

const UPSTREAM_URL_FIX =
  'Cloudflare Pages proxies only to paths on its own site ("You cannot proxy external domains", https://developers.cloudflare.com/pages/configuration/redirects/), so run the app as Pages Functions under the prefix and remove url';

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export function cloudflarePages(): EdgeAdapter {
  return defineAdapter({
    name: "cloudflare-pages",
    limits: {},
    compileTree: compileCloudflarePages,
    unsupportedFix: UNSUPPORTED_FIX,
    upstreams: { url: "refused", fix: UPSTREAM_URL_FIX },
    checkManifest: checkWrangler,
  });
}
