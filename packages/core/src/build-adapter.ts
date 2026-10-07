import type { EmittedFile } from "./manifest.js";
import { quote } from "./quote.js";
import type { RoutingManifest } from "./routing.js";

/**
 * Where a deployer puts it: a `"tree-file"` is written into the output tree
 * beside the site's own files, and every other role goes to `edge/` instead
 * (`@pagedeck/edge`'s `ArtifactRole` names them; core reads only the one it
 * routes on).
 */
export const TREE_FILE_ROLE = "tree-file";

/** The fields core reads off an edge package's artifact (`EdgeArtifact`). */
export interface BuildAdapterArtifact {
  readonly domain?: string;
  readonly role: string;
  readonly path: string;
  readonly contents: string;
}

export interface BuildAdapterOutput {
  readonly artifacts: readonly BuildAdapterArtifact[];
}

/**
 * The shape `build.adapter` takes: an edge package's `EdgeAdapter` is
 * assignable to it, and core declares it without importing `@pagedeck/edge`
 * (docs/adr/0009-one-package-per-edge-adapter.md).
 */
export interface BuildAdapter {
  readonly name: string;
  compile(routing: RoutingManifest): BuildAdapterOutput;
}

const SHAPE_FIX =
  'adapter: { name: "netlify", compile: (routing) => ({ artifacts: [] }) }, or an adapter package\'s factory, as adapter: netlify()';
const NAME_FIX = 'write the name this adapter is reported by, such as "netlify"';
const COMPILE_FIX =
  "write the function this build hands the routing document to, as compile: (routing) => ({ artifacts: [...] })";

export function adapterFaultReport(
  value: unknown,
  where: string,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: "build.adapter" must be an object with a name and a compile function — ${SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const read = (key: string): unknown =>
    Object.hasOwn(record, key) ? record[key] : undefined;
  const faults: string[] = [];
  const name = read("name");
  if (typeof name !== "string" || name.trim() === "") {
    faults.push(`  "name" — ${quote(name)} — not an adapter name — ${NAME_FIX}`);
  }
  if (typeof read("compile") !== "function") {
    faults.push(
      `  "compile" — ${quote(read("compile"))} — not a compile function — ${COMPILE_FIX}`,
    );
  }
  if (faults.length === 0) return undefined;
  return `${where}: "build.adapter" declares ${String(faults.length)} ${
    faults.length === 1 ? "field" : "fields"
  } this build cannot compile through — declare each as the type its own line names:\n${faults.join("\n")}`;
}

/** The tree-file artifacts, as the `EmittedFile`s that ride the site's own write and prune (#20). */
export function adapterTreeFiles(
  output: BuildAdapterOutput,
): readonly EmittedFile[] {
  return output.artifacts
    .filter((artifact) => artifact.role === TREE_FILE_ROLE)
    .map((artifact) => ({
      ...(artifact.domain === undefined ? {} : { domain: artifact.domain }),
      path: artifact.path,
      kind: "asset" as const,
      contents: artifact.contents,
    }));
}

/** Every artifact an adapter writes outside the output tree, into `edge/`. */
export function adapterEdgeArtifacts(
  output: BuildAdapterOutput,
): readonly BuildAdapterArtifact[] {
  return output.artifacts.filter((artifact) => artifact.role !== TREE_FILE_ROLE);
}
