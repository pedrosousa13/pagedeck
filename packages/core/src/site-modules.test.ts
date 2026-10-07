// Spawned, not in process: under Vitest every `import()` in this package is
// Vitest's, and the hook sees only what Node loads.
import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-site-modules-test");
const MODULES = join(import.meta.dirname, "..", "dist", "site-modules.js");
const EDITS = 50;

function counted(name: string, imports = ""): string {
  return `${imports}globalThis.evaluated ??= {};\nglobalThis.evaluated[${JSON.stringify(name)}] = (globalThis.evaluated[${JSON.stringify(name)}] ?? 0) + 1;\nexport const name = ${JSON.stringify(name)};\n`;
}

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("an edit loads afresh only the changed file and the site files above it, edit after edit", async () => {
  rmSync(SITE, { recursive: true, force: true });
  mkdirSync(join(SITE, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(SITE, "node_modules", "dep", "index.js"), counted("dep"));
  writeFileSync(join(SITE, "leaf.js"), counted("leaf"));
  writeFileSync(
    join(SITE, "page.js"),
    counted("page", `import "./leaf.js";\nimport "./node_modules/dep/index.js";\n`),
  );
  writeFileSync(join(SITE, "aside.js"), counted("aside", `import "./node_modules/dep/index.js";\n`));

  const script = `
    import { pathToFileURL } from "node:url";
    const { trackSiteModules } = await import(${JSON.stringify(MODULES)});
    const site = ${JSON.stringify(SITE)};
    const modules = trackSiteModules(site);
    const load = async () => {
      await import(pathToFileURL(site + "/page.js").href);
      await import(pathToFileURL(site + "/aside.js").href);
    };
    await load();
    for (let edit = 0; edit < ${String(EDITS)}; edit += 1) {
      modules.changed([site + "/leaf.js"]);
      await load();
    }
    modules.close();
    console.log(JSON.stringify({ evaluated: globalThis.evaluated, files: [...modules.files().keys()].sort() }));
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ]);
  const result = JSON.parse(stdout) as {
    evaluated: Record<string, number>;
    files: string[];
  };
  expect(result.evaluated).toEqual({
    leaf: EDITS + 1,
    page: EDITS + 1,
    aside: 1,
    dep: 1,
  });
  expect(result.files).toEqual([
    join(SITE, "aside.js"),
    join(SITE, "leaf.js"),
    join(SITE, "page.js"),
  ]);
}, 60_000);
