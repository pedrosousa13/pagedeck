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

export interface EdgeArtifact {
  /** The output tree this serves; absent = default tree. */
  domain?: string;
  role: ArtifactRole;
  /** The name an `edge-module` reads the origin's bucket by; bind the bucket under it. */
  binding?: string;
  /** Tree-relative for `"tree-file"`; a bare resource name otherwise. */
  path: string;
  /** Text only, with no sourcemap or `sourceMappingURL` (ADR-0002). */
  contents: string;
}

export interface EdgeOutput<A extends EdgeArtifact = EdgeArtifact> {
  target: string;
  /** In `RoutingManifest.trees` order, then each compiler's; nothing is re-sorted. */
  artifacts: readonly A[];
}
