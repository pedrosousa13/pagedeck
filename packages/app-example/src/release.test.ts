import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { checkLive, prepareRelease, redact } from "./release.js";

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

// An origin that answers `/api/release` with one status and body.
async function origin(status: number, body: unknown): Promise<{ url: string; close: () => void }> {
  const server = createServer((_, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => server.close(),
  };
}

test("an origin that answers /api/release with an error is named with its status", async () => {
  const live = await origin(500, { error: "Something went wrong. Try again." });
  try {
    await expect(checkLive({ releases: "/nowhere", release: "b", live: live.url })).rejects.toThrow(
      `Release "b": "${live.url}/api/release" answered 500, so which release is live is unknown — check the origin, or pass --force to deploy without the check`,
    );
  } finally {
    live.close();
  }
});

test("a live release id that cannot name a directory is refused before it reaches a path", async () => {
  const live = await origin(200, { release: "../../etc" });
  try {
    await expect(checkLive({ releases: "/nowhere", release: "b", live: live.url })).rejects.toThrow(
      `Release "b": "${live.url}/api/release" names "../../etc" as live, which is not a build id — the build id holds "/", which would place the document in another directory; check what the origin serves, or pass --force`,
    );
  } finally {
    live.close();
  }
});

test("a live release this runner does not hold is named, with where it looked", async () => {
  const live = await origin(200, { release: "a" });
  const { releases } = site({});
  try {
    await expect(checkLive({ releases, release: "b", live: live.url })).rejects.toThrow(
      `Release "b": release "a" is not in "${releases}" — restore the releases kept outside this runner, or pass --force`,
    );
  } finally {
    live.close();
  }
});

test("wrangler's output loses every email and account ID before it reaches an error", () => {
  expect(
    redact("Logged in as reader@example.com, account 0123456789abcdef0123456789ABCDEF, version 4.148.0"),
  ).toBe("Logged in as <email>, account <id>, version 4.148.0");
});
