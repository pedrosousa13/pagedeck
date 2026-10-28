import { defineAdapter } from "@pagedeck/edge";
import type { EdgeAdapter } from "@pagedeck/edge";

import { compileCloudflarePages } from "./cloudflare-pages.js";
import { checkWrangler } from "./wrangler.js";

const UPSTREAM_URL_FIX =
  'Cloudflare Pages proxies only to paths on its own site ("You cannot proxy external domains", https://developers.cloudflare.com/pages/configuration/redirects/), so run the app as Pages Functions under the prefix and remove url';

const UNSUPPORTED_FIX =
  "drop the experiment, or compile cloudfront-function, the only target that compiles a split";

export interface CloudflarePagesOptions {
  /** Says the site's wrangler file sets `assets.run_worker_first` to `true`, so the app runs before every request; the build refuses `true` without it. */
  runWorkerFirst?: boolean;
}

export function cloudflarePages(options: CloudflarePagesOptions = {}): EdgeAdapter {
  const runWorkerFirst = options.runWorkerFirst ?? false;
  return defineAdapter({
    name: "cloudflare-pages",
    limits: {},
    compileTree: compileCloudflarePages,
    unsupportedFix: UNSUPPORTED_FIX,
    upstreams: { url: "refused", fix: UPSTREAM_URL_FIX },
    checkManifest: (manifest, faults, site) => {
      checkWrangler(manifest, faults, site, runWorkerFirst);
    },
  });
}
