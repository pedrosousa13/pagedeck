import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, test } from "vitest";
import { BIN, SITE as EXAMPLE } from "./wrangler.test-support.js";

const run = promisify(execFile);

// Inside the example, so the copy resolves its packages; a copy, so `site.build.test.ts` can
// build the example beside it.
const SITE = mkdtempSync(join(EXAMPLE, ".pagedeck-run-worker-first-test-"));

afterAll(() => {
  rmSync(SITE, { recursive: true, force: true });
});

test("the build refuses a wrangler.jsonc whose run_worker_first misses /api/", async () => {
  for (const path of ["pagedeck.config.ts", "wrangler.jsonc", "favicon.ico", "content", "public", "src"]) {
    cpSync(join(EXAMPLE, path), join(SITE, path), { recursive: true });
  }
  const wrangler = join(SITE, "wrangler.jsonc");
  const text = readFileSync(wrangler, "utf8");
  const listed = '"run_worker_first": ["/api", "/api/*", "/account", "/account/*"]';
  expect(text).toContain(listed);
  writeFileSync(wrangler, text.replace(listed, '"run_worker_first": ["/api", "/account", "/account/*"]'));

  await run(process.execPath, [BIN, "sync"], { cwd: SITE });
  const failed = await run(process.execPath, [BIN, "build"], { cwd: SITE }).then(
    () => expect.unreachable("expected the build to fail"),
    (error: { code: number; stderr: string }) => error,
  );
  expect(failed.code).not.toBe(0);
  const message = `Edge target "cloudflare-pages": 1 prefix in build.routing.upstreams does not reach the app through assets.run_worker_first — add each pattern its line names to assets.run_worker_first in the wrangler file, the prefix followed by * and its unslashed path, since Cloudflare does not document that * matches nothing; Workers Static Assets answers a request no pattern matches from the site's files, so it never reaches the app:\n  the default tree's prefix "/api/" — "${wrangler}" lists no "/api/*"`;
  // The CLI marks each line of a refusal as its own.
  expect(failed.stderr).toContain(message.replaceAll(/^/gm, "pagedeck: "));
}, 120_000);
