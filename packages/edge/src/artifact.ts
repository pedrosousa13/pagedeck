/**
 * What a deployer does with it, not `ManifestFile.kind`: a function uploaded as `js` would
 * publish nothing and report green.
 */
export type ArtifactRole =
  /** Written into the output tree and uploaded with the site. */
  | "tree-file"
  /** Published out of band and associated with a distribution. */
  | "function"
  /** A key/value payload a `function` reads at request time. */
  | "dataset"
  /** A `FunctionConfig` fragment for the `function` beside it, not for the distribution. */
  | "function-config"
  /** A JSON fragment CI applies to the distribution's own configuration. */
  | "distribution-config"
  /** A config fragment included on the host that serves the tree. */
  | "server-config"
  /** An ES module published to run in front of the origin, which it reads through `binding`. */
  | "edge-module";

/**
 * CloudFront needs two functions: viewer-request cannot decorate an origin response, and
 * viewer-response cannot stop a request.
 */
export type EventSlot = "viewer-request" | "viewer-response";

/** The dataset form imports `cloudfront` and awaits, which only `cloudfront-js-2.0` runs. */
export type FunctionRuntime = "cloudfront-js-1.0" | "cloudfront-js-2.0";

export interface EdgeArtifact {
  /** The output tree this serves; absent = default tree. */
  domain?: string;
  role: ArtifactRole;
  slot?: EventSlot;
  runtime?: FunctionRuntime;
  /** The name an `edge-module` reads the origin's bucket by; bind the bucket under it. */
  binding?: string;
  /** Tree-relative for `"tree-file"` (`/_redirects`); a bare resource name otherwise. */
  path: string;
  /** Text only, with no sourcemap or `sourceMappingURL` (ADR-0002). */
  contents: string;
}

export interface EdgeOutput {
  /** The `EdgeAdapter.name` that compiled it. */
  target: string;
  /** In `RoutingManifest.trees` order, then each compiler's; nothing is re-sorted. */
  artifacts: readonly EdgeArtifact[];
}
