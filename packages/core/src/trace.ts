import { SourceMap } from "node:module";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { ConfigError } from "./exit.js";
import { quote, quoteIdentifier } from "./quote.js";
import {
  listRetainedManifests,
  SOURCEMAP_DIR,
  sourcemapOf,
  unusableId,
} from "./retention.js";

export interface Frame {
  /** The chunk's path in the output tree, as `assets/Counter-1a2b3c4d.js`. */
  chunk: string;
  line: number;
  column: number;
}

export interface TracedFrame {
  build: string;
  source: string;
  line: number;
  column: number;
  /** Retained builds whose map for the chunk differs from `build`'s. */
  differing: readonly string[];
}

const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

export const FRAME_SHAPE =
  "<chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345";

export function parseFrame(text: string): Frame | string {
  const found = /^(.+):(\d+):(\d+)$/.exec(text);
  if (found === null) {
    return `pagedeck trace takes a frame as ${FRAME_SHAPE}, and got ${quote(text)}.`;
  }
  const [, spelled, line, column] = found as unknown as [string, string, string, string];
  let path = spelled;
  if (SCHEME.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      return `pagedeck trace takes a frame as ${FRAME_SHAPE}, and got ${quote(text)}, whose chunk is not a URL.`;
    }
  }
  const chunk = path.replace(/^\/+/, "");
  const segments = chunk.split("/");
  if (
    chunk.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `pagedeck trace takes a frame as ${FRAME_SHAPE}, and got ${quote(text)}, whose chunk is not a path in the output tree.`;
  }
  if (Number(line) === 0 || Number(column) === 0) {
    return `pagedeck trace takes a frame's line and column counted from 1, as a browser's stack counts them, and got ${quote(text)}.`;
  }
  return { chunk, line: Number(line), column: Number(column) };
}

function frameName(frame: Frame): string {
  return quoteIdentifier(
    `${frame.chunk}:${String(frame.line)}:${String(frame.column)}`,
  );
}

async function readMap(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
}

const REBUILD_FIX =
  "build the commit that served the page again, with build.islandErrors declared: a chunk's name is a hash of its contents, so the same commit writes the same chunk and its map";

async function retainedIds(root: string): Promise<readonly string[]> {
  return (await listRetainedManifests(root))
    .map((manifest) => manifest.build.id)
    .filter((id) => unusableId(id) === undefined);
}

function resolveIn(
  frame: Frame,
  build: string,
  file: string,
  text: string,
): Omit<TracedFrame, "differing"> {
  let map: SourceMap;
  try {
    map = new SourceMap(JSON.parse(text) as ConstructorParameters<typeof SourceMap>[0]);
  } catch (cause) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: the sourcemap at ${quoteIdentifier(file)} is not a sourcemap this pagedeck can read — pagedeck build writes each map as the bundler emitted it, so this one was cut short or edited; ${REBUILD_FIX}`,
      { cause },
    );
  }
  const entry = map.findEntry(frame.line - 1, frame.column - 1);
  if (
    !("originalSource" in entry) ||
    typeof entry.originalSource !== "string" ||
    entry.generatedLine !== frame.line - 1
  ) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: build ${quoteIdentifier(build)}'s sourcemap for ${quoteIdentifier(frame.chunk)} maps no source at line ${String(frame.line)}, column ${String(frame.column)} — check the line and column against the frame, which a browser counts from 1, and check that the report's release is this build`,
    );
  }
  return {
    build,
    source: entry.originalSource,
    line: entry.originalLine + 1,
    column: entry.originalColumn + 1,
  };
}

function listed(ids: readonly string[]): string {
  return ids.map(quoteIdentifier).join(", ");
}

export async function traceFrame(
  root: string,
  frame: Frame,
  id?: string,
): Promise<TracedFrame> {
  const store = join(root, SOURCEMAP_DIR);
  const ids = await retainedIds(root);
  if (id !== undefined) {
    const reason = unusableId(id);
    if (reason !== undefined) {
      throw new ConfigError(
        `Trace ${frameName(frame)}: build ${quoteIdentifier(id)} is not a build id the store can hold — ${reason}; pass the release the report carries, or leave the build id out to search every retained build`,
      );
    }
    if (!ids.includes(id)) {
      throw new ConfigError(
        `Trace ${frameName(frame)}: build ${quoteIdentifier(id)} is not in the retention store — ${
          ids.length === 0
            ? "the store holds no retained build, so run pagedeck build to fill it"
            : `the retained builds are ${listed(ids)}, so pass one of those, or leave the build id out to search them all; a build past build.retention.keep is pruned with its maps, and to read one again, ${REBUILD_FIX}`
        }`,
      );
    }
    const file = sourcemapOf(root, id, frame.chunk);
    const text = await readMap(file);
    if (text === undefined) {
      throw new ConfigError(
        `Trace ${frameName(frame)}: build ${quoteIdentifier(id)} retained no sourcemap for ${quoteIdentifier(frame.chunk)} — a build keeps a map for each chunk it wrote from authored source, and only while build.islandErrors is declared, so check the chunk name against the frame, or leave the build id out to search every retained build`,
      );
    }
    return { ...resolveIn(frame, id, file, text), differing: [] };
  }

  const held: { id: string; file: string; text: string }[] = [];
  for (const one of ids) {
    const file = sourcemapOf(root, one, frame.chunk);
    const text = await readMap(file);
    if (text !== undefined) held.push({ id: one, file, text });
  }
  const [newest] = held;
  if (newest === undefined) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: no retained build holds a sourcemap for ${quoteIdentifier(frame.chunk)} in ${quoteIdentifier(store)} — a build keeps its maps only while build.islandErrors is declared, and the store keeps the last build.retention.keep builds; check the chunk name against the frame, or ${REBUILD_FIX}`,
    );
  }
  return {
    ...resolveIn(frame, newest.id, newest.file, newest.text),
    differing: held
      .slice(1)
      .filter((other) => other.text !== newest.text)
      .map((other) => other.id),
  };
}

export function differingWarning(frame: Frame, traced: TracedFrame): string | undefined {
  if (traced.differing.length === 0) return undefined;
  const subject =
    traced.differing.length === 1
      ? `build ${listed(traced.differing)} also holds a map for ${quoteIdentifier(frame.chunk)} that differs`
      : `builds ${listed(traced.differing)} also hold maps for ${quoteIdentifier(frame.chunk)} that differ`;
  return `Trace ${frameName(frame)}: ${subject} from the one read, the newest build's, ${quoteIdentifier(traced.build)} — a chunk's name is a hash of its code, so an edit that changes no code, such as a comment, changes the map and keeps the name; pass the report's release as <build-id> to read that build's map`;
}
