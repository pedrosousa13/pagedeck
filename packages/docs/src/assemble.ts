import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Run by `prepack` in this package's directory. Writes only what differs, so a
// docs site syncing from this directory meanwhile never sees a file vanish.
const PACKAGE = process.cwd();
const DOCS = join(PACKAGE, "..", "..", "docs");

interface Group {
  readonly pages: readonly string[];
}

const listed = (JSON.parse(readFileSync(join(PACKAGE, "nav.json"), "utf8")) as Group[]).flatMap(
  (group) => group.pages,
);
const copied = listed.filter((page) => existsSync(join(DOCS, page)));

for (const directory of new Set(copied.map((page) => page.split("/")[0] ?? page))) {
  const target = join(PACKAGE, directory);
  if (directory.endsWith(".md") || !existsSync(target)) continue;
  for (const file of readdirSync(target, { recursive: true, encoding: "utf8" })) {
    const page = `${directory}/${file.split("\\").join("/")}`;
    if (page.endsWith(".md") && !copied.includes(page)) rmSync(join(PACKAGE, page));
  }
}

for (const page of copied) {
  const text = readFileSync(join(DOCS, page), "utf8");
  const target = join(PACKAGE, page);
  if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}
