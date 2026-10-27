import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { prepareRelease } from "./release.js";

const dirs: string[] = [];

function site(files: Record<string, string>): { site: string; releases: string } {
  const root = mkdtempSync(join(tmpdir(), "pagedeck-release-unit-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, "site", path, ".."), { recursive: true });
    writeFileSync(join(root, "site", path), text);
  }
  return { site: root, releases: join(root, "releases") };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a secret-named file in the built tree is refused before anything is bundled, each one named", async () => {
  const input = site({
    "index.html": "<p>hi</p>",
    ".dev.vars": "TOKEN=1",
    "nested/.env.production": "TOKEN=2",
  });
  await expect(prepareRelease(input)).rejects.toThrow(
    `Release of "${join(input.site, "site")}": holds 2 files named like secrets — ".dev.vars", "nested/.env.production" — wrangler uploads every file there that .assetsignore does not name, so move each one out of public/ (wrangler reads .dev.vars beside wrangler.jsonc), then build again`,
  );
  expect(existsSync(input.releases)).toBe(false);
});

test("a tree with no manifest is refused, and no release is written", async () => {
  const input = site({ "index.html": "<p>hi</p>" });
  await expect(prepareRelease(input)).rejects.toThrow(
    `Release of "${join(input.site, "site")}": has no manifest.json, so there is no build id to name the release by — run pagedeck build in "${input.site}" first`,
  );
  expect(existsSync(input.releases) ? readdirSync(input.releases) : []).toEqual([]);
});
