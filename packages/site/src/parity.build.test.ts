import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, normalize as normalizePath } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { readManifest } from "@pagedeck/core";
import { compileRouting } from "@pagedeck/edge";
import { compareParity } from "./parity.js";
import type { ParityBaseline } from "./parity.js";
import { readBuiltSite, redirectRows } from "./parity-read.js";
import { DECLARED_BASELINE, EXPECTATION_RULES } from "./parity-baseline.js";

const execFileAsync = promisify(execFile);

const SITE = join(import.meta.dirname, "..", ".pagedeck-parity-build-test");
const OUT = join(SITE, "site");
const BROKEN = join(import.meta.dirname, "..", ".pagedeck-parity-build-test-broken");
const CAPTURED = join(SITE, "captured.json");

const FW = join(import.meta.dirname, "..", "..", "core", "dist", "bin.js");
const PARITY = join(import.meta.dirname, "..", "dist", "parity.bin.js");

const URLS = ["/de", "/en", "/en/legal/terms", "/en/pricing"];

function writeSite(): void {
  mkdirSync(SITE, { recursive: true });
  writeFileSync(
    join(SITE, "pagedeck.config.ts"),
    ['import { siteConfig } from "@pagedeck/site";', "", "export default siteConfig();", ""].join("\n"),
  );
}

async function pagedeck(verb: string): Promise<void> {
  await execFileAsync(process.execPath, [FW, verb], { cwd: SITE });
}

// Redirects from the compiled `@pagedeck/edge` artifact, not the config: the artifact is
// what a host is given.
function serve(
  root: string,
  redirects: readonly { from: string; to: string; status: number }[],
): Promise<{ origin: string; close: () => Promise<void> }> {
  const byFrom = new Map(redirects.map((rule) => [rule.from, rule]));
  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const rule = byFrom.get(path);
    if (rule !== undefined) {
      response.statusCode = rule.status;
      response.setHeader("location", rule.to);
      response.end();
      return;
    }
    const inside = normalizePath(path)
      .replace(/^(\.\.[/\\])+/, "")
      .replace(/^[/\\]+/, "");
    const file = [join(root, inside), join(root, inside, "index.html")].find(
      (one) => existsSync(one) && statSync(one).isFile(),
    );
    if (file === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

let served: { origin: string; close: () => Promise<void> };

beforeAll(async () => {
  rmSync(SITE, { recursive: true, force: true });
  rmSync(BROKEN, { recursive: true, force: true });
  writeSite();
  await pagedeck("sync");
  await pagedeck("build");

  const file = join(OUT, "manifest.json");
  const manifest = readManifest(readFileSync(file, "utf8"), file);
  const compiled = compileRouting(manifest.routing, { target: "netlify" });
  served = await serve(OUT, redirectRows(compiled));
}, 180_000);

afterAll(async () => {
  if (served !== undefined) await served.close();
  rmSync(SITE, { recursive: true, force: true });
  rmSync(BROKEN, { recursive: true, force: true });
});

test("the build matches its declared baseline, over every locale and every page type", async () => {
  const built = await readBuiltSite(OUT);
  const report = compareParity({
    baseline: DECLARED_BASELINE,
    built,
    rules: EXPECTATION_RULES,
  });

  expect(report.baselineOrigin.kind).toBe("declared");
  expect(report.coverage).toEqual({
    baselineUrls: URLS.length,
    builtUrls: URLS.length,
    compared: URLS.length,
    missingFromBuild: [],
    newInBuild: [],
  });
  expect(report.defects).toEqual([]);
  expect(report.expected).toEqual([]);
  expect(report.stale).toEqual([]);

  expect(built.pages.map((page) => page.url).sort()).toEqual(URLS);
  expect(report.redirects.map((one) => one.outcome)).toEqual(["same", "same"]);
});

test("a capture over real HTTP reads the same facts the disk reader reads", async () => {
  await execFileAsync(
    process.execPath,
    [PARITY, "capture", "--origin", served.origin, "--out", CAPTURED],
    { cwd: SITE },
  );

  const baseline = JSON.parse(readFileSync(CAPTURED, "utf8")) as ParityBaseline;
  expect(baseline.origin.kind).toBe("captured");
  expect(baseline.origin.kind === "captured" && baseline.origin.from).toBe(
    served.origin,
  );
  expect(baseline.pages.map((page) => page.url).sort()).toEqual(URLS);

  const report = compareParity({ baseline, built: await readBuiltSite(OUT) });
  expect(report.defects).toEqual([]);
  expect(report.coverage.compared).toBe(URLS.length);

  expect(baseline.redirects).toEqual([
    { from: "/en/plans", to: "/en/pricing", status: 301 },
    { from: "/en/terms", to: "/en/legal/terms", status: 301 },
  ]);
}, 60_000);

test("an origin's query never reaches the log the refusal is printed to", async () => {
  const failed = await execFileAsync(
    process.execPath,
    [
      PARITY,
      "capture",
      "--origin",
      `${served.origin}/?token=SECRET`,
      "--out",
      join(SITE, "never-written.json"),
    ],
    { cwd: SITE },
  ).catch((error: { code?: number; stderr?: string }) => error);

  expect(failed).toHaveProperty("code", 2);
  const stderr = String((failed as { stderr?: string }).stderr);
  expect(stderr).toContain(`Parity capture from "${served.origin}"`);
  expect(stderr).not.toContain("SECRET");
  expect(existsSync(join(SITE, "never-written.json"))).toBe(false);
}, 60_000);

test("a page removed from the built tree is missing from the build, and fails the run", async () => {
  cpSync(OUT, BROKEN, { recursive: true });
  rmSync(join(BROKEN, "en", "pricing"), { recursive: true, force: true });

  const report = compareParity({
    baseline: DECLARED_BASELINE,
    built: await readBuiltSite(BROKEN),
    rules: EXPECTATION_RULES,
  });

  expect(report.coverage.missingFromBuild).toEqual(["/en/pricing"]);
  expect(report.coverage.compared).toBe(URLS.length - 1);
  expect(report.defects).toContainEqual({
    url: "/en/pricing",
    field: "status",
    baseline: "200",
    built: "absent",
  });

  const failed = await execFileAsync(
    process.execPath,
    [PARITY, "compare", "--build", BROKEN],
    { cwd: SITE },
  ).catch((error: { code?: number; stdout?: string }) => error);
  expect(failed).toHaveProperty("code", 1);
  const stdout = String((failed as { stdout?: string }).stdout);
  expect(stdout).toContain("baseline origin: declared");
  expect(stdout).toContain("\nstale rules: 0\n");
}, 60_000);
