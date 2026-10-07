import { registerHooks } from "node:module";

const TARGET = "/dist/island-facts.js";

// The query makes the shim's re-import a second module, and `TARGET`'s
// `endsWith` misses it, so it loads from disk.
const ORIGINAL = "?pagedeck-island-scan=original";

// A file, because the build owns stdout and its tools write to stderr.
const LOG = "PAGEDECK_ISLAND_SCAN_LOG";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(TARGET)) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      // No `finally`: run while a real scan's rejection was in flight, the log check
      // or write would replace the build's own failure.
      source: `
import { appendFileSync } from "node:fs";
import { scanIslandFacts as inner } from ${JSON.stringify(`${url}${ORIGINAL}`)};

export async function scanIslandFacts(input) {
  const log = process.env[${JSON.stringify(LOG)}];
  if (log === undefined) {
    throw new Error(
      "Island scan probe: ${LOG} names no file, so a scan would have nowhere to put its timing — set it to a path before spawning pagedeck, or drop the --import that installed this probe",
    );
  }
  const started = performance.now();
  const facts = await inner(input);
  appendFileSync(log, String(performance.now() - started) + "\\n");
  return facts;
}
`,
    };
  },
});
