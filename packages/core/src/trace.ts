import { SourceMap } from "node:module";
import { join } from "node:path";
import { ConfigError } from "./exit.js";
import { quote, quoteIdentifier } from "./quote.js";
import {
  listRetainedManifests,
  readStoreFile,
  retainedChunkOf,
  SOURCEMAP_DIR,
  sourcemapOf,
  UNREADABLE_DOCUMENT_CODES,
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
  /** Retained builds whose map for the chunk did not open, so went uncompared. */
  unreadable: readonly string[];
}

const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const ORIGIN = /[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/;
const POSITION = /^(.+):(\d+):(\d+)$/;
// Chrome: `at Counter (<location>)` or `at <location>`.
const CHROME_FRAME = /^\s*at\s+(?:.*\()?(.+?)\)?\s*$/;
// Firefox: `Counter@<location>`; a `://` before the `@` is a URL's userinfo.
const FIREFOX_FRAME = /^\s*([^@]*)@(.+)$/;
// Chrome `eval at Counter (<location>), <anonymous>:3:4`; Firefox `<location> line 10 > eval:3:4`.
const EVAL_FRAME = /\beval at |\sline \d+ > (?:eval|Function)\b/;

export const FRAME_SHAPE =
  "<chunk>:<line>:<column>, as a stack names it, such as https://example.com/assets/Counter-1a2b3c4d.js:1:2345";

function locationOf(text: string): string {
  const chrome = CHROME_FRAME.exec(text);
  if (chrome?.[1] !== undefined) return chrome[1];
  const firefox = FIREFOX_FRAME.exec(text);
  if (firefox?.[2] !== undefined && firefox[1]?.includes("://") === false) {
    return firefox[2];
  }
  return text.trim();
}

/** Rule 6: a frame's URL can carry credentials in its userinfo or query. */
function redacted(location: string): string {
  return location
    .replace(ORIGIN, "")
    .replace(/[?#].*?(?=:\d+:\d+$|$)/, "");
}

export function parseFrame(text: string): Frame | string {
  if (EVAL_FRAME.test(text)) {
    return "pagedeck trace takes a frame in a chunk, and got a frame in code run by eval or new Function, whose line and column count from the start of that code and not of any chunk; trace the next frame down the stack that names a chunk under /assets/.";
  }
  const location = locationOf(text);
  const shown = quote(redacted(location));
  const found = POSITION.exec(location);
  if (found === null) {
    return `pagedeck trace takes a frame as ${FRAME_SHAPE}, and got ${shown}.`;
  }
  const [, spelled = "", line = "", column = ""] = found;
  let path = spelled.replace(/[?#].*$/, "");
  if (SCHEME.test(spelled)) {
    try {
      path = new URL(spelled).pathname;
    } catch {
      return `pagedeck trace takes a frame as ${FRAME_SHAPE}, and got ${shown}, whose chunk is not a URL.`;
    }
  }
  const chunk = path.replace(/^\/+/, "");
  const segments = chunk.split("/");
  if (
    chunk.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `pagedeck trace takes a frame as ${FRAME_SHAPE}, and got ${shown}, whose chunk is not a path in the output tree.`;
  }
  if (Number(line) === 0 || Number(column) === 0) {
    return `pagedeck trace takes a frame's line and column counted from 1, as a browser's stack counts them, and got ${shown}.`;
  }
  return { chunk, line: Number(line), column: Number(column) };
}

function frameName(frame: Frame): string {
  return quoteIdentifier(
    `${frame.chunk}:${String(frame.line)}:${String(frame.column)}`,
  );
}

const REBUILD_FIX =
  "build the commit that served the page again, with build.islandErrors declared: a chunk's name is a hash of its contents, so the same commit writes the same chunk and its map";

async function readHeld(
  frame: Frame,
  build: string,
  file: string,
): Promise<string | undefined> {
  try {
    return await readStoreFile(file);
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code !== undefined && UNREADABLE_DOCUMENT_CODES.has(code)) {
      throw new ConfigError(
        `Trace ${frameName(frame)}: build ${quoteIdentifier(build)}: nothing opened at ${quoteIdentifier(file)} — the open ends there on a link, on a directory, on a mode that forbids the read, or on a name the file system will not take, and the store opens each map and chunk read-only and refuses one that is itself a link rather than follow it; ${REBUILD_FIX}`,
        { cause },
      );
    }
    throw cause;
  }
}

async function retainedIds(root: string): Promise<readonly string[]> {
  return (await listRetainedManifests(root))
    .map((manifest) => manifest.build.id)
    .filter((id) => unusableId(id) === undefined);
}

const POSITION_FIX =
  "check the line and column against the frame, which a browser counts from 1, and check that the report's release is this build";

function lineCount(lines: number): string {
  return lines === 1 ? "1 line" : `${String(lines)} lines`;
}

async function resolveIn(
  root: string,
  frame: Frame,
  build: string,
  file: string,
  text: string,
): Promise<Omit<TracedFrame, "differing" | "unreadable">> {
  let map: SourceMap;
  try {
    map = new SourceMap(JSON.parse(text) as ConstructorParameters<typeof SourceMap>[0]);
  } catch (cause) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: the sourcemap at ${quoteIdentifier(file)} is not a sourcemap this pagedeck can read — pagedeck build writes each map as the bundler emitted it, so this one was cut short or edited; ${REBUILD_FIX}`,
      { cause },
    );
  }
  const code = await readHeld(frame, build, retainedChunkOf(root, build, frame.chunk));
  if (code === undefined) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: build ${quoteIdentifier(build)} retained a sourcemap for ${quoteIdentifier(frame.chunk)} and not the chunk itself, which the frame's line and column are checked against — pagedeck build writes the two together, so the store was edited by hand; ${REBUILD_FIX}`,
    );
  }
  // `findEntry` answers a position past the end from the line's last segment.
  const lines = code.split("\n");
  const generated = lines[frame.line - 1];
  if (generated === undefined) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: line ${String(frame.line)} is past the end of ${quoteIdentifier(frame.chunk)} as build ${quoteIdentifier(build)} wrote it, which has ${lineCount(lines.length)} — ${POSITION_FIX}`,
    );
  }
  if (frame.column > generated.length) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: column ${String(frame.column)} is past the end of line ${String(frame.line)} of ${quoteIdentifier(frame.chunk)} as build ${quoteIdentifier(build)} wrote it, which is ${String(generated.length)} characters long — ${POSITION_FIX}`,
    );
  }
  const entry = map.findEntry(frame.line - 1, frame.column - 1);
  if (
    !("originalSource" in entry) ||
    typeof entry.originalSource !== "string" ||
    entry.generatedLine !== frame.line - 1
  ) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: build ${quoteIdentifier(build)}'s sourcemap for ${quoteIdentifier(frame.chunk)} maps no source at line ${String(frame.line)}, column ${String(frame.column)} — ${POSITION_FIX}`,
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
    const text = await readHeld(frame, id, file);
    if (text === undefined) {
      throw new ConfigError(
        `Trace ${frameName(frame)}: build ${quoteIdentifier(id)} retained no sourcemap for ${quoteIdentifier(frame.chunk)} — a build keeps a map for each chunk it wrote from authored source, and only while build.islandErrors is declared, so check the chunk name against the frame, or leave the build id out to search every retained build`,
      );
    }
    return {
      ...(await resolveIn(root, frame, id, file, text)),
      differing: [],
      unreadable: [],
    };
  }

  let newest: { id: string; file: string; text: string } | undefined;
  const differing: string[] = [];
  const unreadable: string[] = [];
  for (const one of ids) {
    const file = sourcemapOf(root, one, frame.chunk);
    if (newest === undefined) {
      const text = await readHeld(frame, one, file);
      if (text !== undefined) newest = { id: one, file, text };
      continue;
    }
    let text: string | undefined;
    try {
      text = await readHeld(frame, one, file);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      unreadable.push(one);
      continue;
    }
    if (text !== undefined && text !== newest.text) differing.push(one);
  }
  if (newest === undefined) {
    throw new ConfigError(
      `Trace ${frameName(frame)}: no retained build holds a sourcemap for ${quoteIdentifier(frame.chunk)} in ${quoteIdentifier(store)} — a build keeps its maps only while build.islandErrors is declared, and the store keeps the last build.retention.keep builds; check the chunk name against the frame, or ${REBUILD_FIX}`,
    );
  }
  return {
    ...(await resolveIn(root, frame, newest.id, newest.file, newest.text)),
    differing,
    unreadable,
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

export function unreadableWarning(frame: Frame, traced: TracedFrame): string | undefined {
  if (traced.unreadable.length === 0) return undefined;
  const subject =
    traced.unreadable.length === 1
      ? `build ${listed(traced.unreadable)} holds a map for ${quoteIdentifier(frame.chunk)} that did not open, so it was`
      : `builds ${listed(traced.unreadable)} hold maps for ${quoteIdentifier(frame.chunk)} that did not open, so they were`;
  return `Trace ${frameName(frame)}: ${subject} not compared with the one read, the newest build's, ${quoteIdentifier(traced.build)} — pass ${traced.unreadable.length === 1 ? listed(traced.unreadable) : "one of them"} as <build-id> to see why it did not open`;
}
