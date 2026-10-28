import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { planRouting } from "@pagedeck/core";
import { cloudflarePages } from "@pagedeck/adapter-cloudflare-pages";
import type { AdapterSite, EdgeArtifact } from "@pagedeck/edge";

export interface AppBeforeEveryRequest {
  artifacts: readonly EdgeArtifact[];
  refusal: string;
}

/**
 * A site whose `wrangler.jsonc` beside `pagedeck.config.ts` sends every request
 * to the app first. `pagedeck build` hands the adapter the site's root, as
 * `compile`'s second argument does here.
 */
export function runAppBeforeEveryRequest(root: string): AppBeforeEveryRequest {
  writeFileSync(
    join(root, "wrangler.jsonc"),
    `{
  "name": "site",
  "main": "src/app.ts",
  // Every request runs the app first, a built page included.
  "assets": { "directory": "./site", "run_worker_first": true }
}
`,
  );
  const routing = planRouting({
    pages: [{ locale: "en", path: "/", output: "/en/", dependencies: [] }],
    trailingSlash: "always",
    config: { upstreams: [{ prefix: "/api/" }] },
  });

  const site: AdapterSite = { root };

  const { artifacts } = cloudflarePages({ runWorkerFirst: true }).compile(routing, site);

  let refusal = "";
  try {
    cloudflarePages().compile(routing, site);
  } catch (error) {
    refusal = (error as Error).message;
  }
  return { artifacts, refusal };
}
