import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { coalesce, publish } from "./publish.js";
import type { PublishResult, StepName } from "./publish.js";
import { startCms } from "./server.js";
import type { Cms, PageContent } from "./server.js";
import { createWebhookReceiver } from "./webhook.js";

const EXAMPLE = join(import.meta.dirname, "..");
const PAGEDECK = join(EXAMPLE, "..", "core", "dist", "bin.js");
const DEPLOY = join(EXAMPLE, "..", "site", "dist", "deploy.bin.js");
const SECRET = "a-shared-secret-of-at-least-32-bytes-0123456789";

// Inside the example, so the copied config resolves `@pagedeck/cms-example` and React from
// its package; a copy of its own, so `site.build.test.ts` can build the example beside it.
const SITE = mkdtempSync(join(EXAMPLE, ".pagedeck-publish-test-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "pagedeck-publish-"));
const STATE = join(OUTSIDE, "state");
const ORIGIN = join(OUTSIDE, "origin");

interface Span {
  readonly start: number;
  end?: number;
  result?: PublishResult;
}

let cms: Cms;
let receiver: Server;
let schedule = true;
let gate: ((step: StepName) => Promise<void>) | undefined;
const spans: Span[] = [];

function job(url = cms.url): Promise<PublishResult> {
  return publish({
    site: SITE,
    state: STATE,
    pagedeck: PAGEDECK,
    deploy: [DEPLOY, "--origin", ORIGIN],
    env: { ...process.env, PAGEDECK_CMS_EXAMPLE_URL: url },
    afterStep: async (step) => gate?.(step),
  });
}

function failedAt(result: PublishResult): string | undefined {
  return result.ok ? undefined : result.failed;
}

const runs = coalesce(async () => {
  const span: Span = { start: performance.now() };
  spans.push(span);
  span.result = await job();
  span.end = performance.now();
  if (!span.result.ok) throw new Error(`the run failed at ${span.result.failed}`);
});

function hero(heading: string): PageContent {
  return { title: heading, blocks: [{ type: "hero", heading, text: `${heading}.` }] };
}

function served(route: string): string | undefined {
  const file = join(ORIGIN, route, "index.html");
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function liveManifest(): { build: { id: string; createdAt: string }; files: { path: string }[] } {
  return JSON.parse(readFileSync(join(ORIGIN, "manifest.json"), "utf8")) as ReturnType<typeof liveManifest>;
}

// Every file under a directory and its digest, to show a failed run moved no byte.
function tree(root: string): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(root, file), createHash("sha256").update(readFileSync(file)).digest("hex")];
      }),
  );
}

async function published(): Promise<void> {
  await cms.delivered();
  await runs.idle();
}

async function until(instant: number): Promise<void> {
  while (Date.now() <= instant) await new Promise((resolve) => setTimeout(resolve, instant - Date.now() + 5));
}

beforeAll(async () => {
  cpSync(join(EXAMPLE, "pagedeck.config.ts"), join(SITE, "pagedeck.config.ts"));
  cpSync(join(EXAMPLE, "src", "components"), join(SITE, "src", "components"), { recursive: true });
  mkdirSync(ORIGIN);
  const receive = createWebhookReceiver({
    secret: SECRET,
    dispatch: () => {
      if (schedule) runs.request();
    },
  });
  receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const body = Buffer.concat(chunks);
      void receive(new Request("http://127.0.0.1/", { method: "POST", headers, body })).then(
        (answer) => response.writeHead(answer.status).end(),
      );
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const { port } = receiver.address() as AddressInfo;
  cms = await startCms({ port: 0, webhook: { url: `http://127.0.0.1:${String(port)}/`, secret: SECRET } });
});

afterAll(async () => {
  await cms.close();
  await new Promise<void>((resolve, reject) =>
    receiver.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  rmSync(SITE, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

test("a first run on no retained state syncs and builds in full, deploys, and saves the state", async () => {
  const result = await job();

  expect(result.ok, failedAt(result)).toBe(true);
  expect(result.incremental).toBe(false);
  expect(result.steps.map(({ argv }) => argv.slice(1).join(" "))).toEqual([
    "sync",
    "build",
    `--origin ${ORIGIN} --apply --prune`,
  ]);
  expect(served("")).toContain("A site built from a headless CMS");
  expect(served("faq")).toBeDefined();
  expect(served("signup")).toBeDefined();
  expect(existsSync(join(STATE, "content.db"))).toBe(true);
  expect(existsSync(join(STATE, "site", "manifest.json"))).toBe(true);
}, 240_000);

test("a page created in the CMS reaches the origin through the webhook and an incremental run", async () => {
  cms.put("news", hero("Fresh news"));
  await published();

  const run = spans.at(-1)?.result;
  expect(run?.incremental).toBe(true);
  expect(run?.steps.map(({ argv }) => argv.slice(1).join(" "))).toEqual([
    "sync --incremental",
    "build --incremental",
    `--origin ${ORIGIN} --apply --prune`,
  ]);
  expect(served("news")).toContain("Fresh news");
}, 240_000);

test("a page edited in the CMS is served edited after the next run", async () => {
  cms.put("news", hero("Edited news"));
  await published();

  expect(served("news")).toContain("Edited news");
  expect(served("news")).not.toContain("Fresh news");
}, 240_000);

test("a page removed in the CMS is deleted from the origin, not only dropped from its manifest", async () => {
  cms.remove("news");
  await published();

  expect(served("news")).toBeUndefined();
  expect(liveManifest().files.map(({ path }) => path)).not.toContain("news/index.html");
}, 240_000);

test("a burst of edits runs one job at a time, folds into two runs, and serves the last edit", async () => {
  const before = spans.length;

  for (let edit = 1; edit <= 8; edit += 1) cms.put("faq", hero(`Burst edit ${String(edit)}`));
  await published();

  const burst = spans.slice(before);
  expect(burst).toHaveLength(2);
  for (const [index, span] of burst.entries()) {
    if (index > 0) expect(span.start).toBeGreaterThanOrEqual(burst[index - 1]?.end ?? Infinity);
  }
  expect(served("faq")).toContain("Burst edit 8");
  expect(served("faq")).not.toContain("Burst edit 7");
}, 480_000);

test("an edit made after a run's sync read the CMS is deployed by the run waiting behind it", async () => {
  const before = spans.length;
  let firstDeployed: string | undefined;
  gate = async (step) => {
    if (spans.length !== before + 1) return;
    if (step === "sync") {
      cms.put("faq", hero("Edited after the sync"));
      await cms.delivered();
    }
    if (step === "deploy") firstDeployed = served("faq");
  };
  try {
    cms.put("faq", hero("Edited before the sync"));
    await published();
  } finally {
    gate = undefined;
  }

  const runsMade = spans.slice(before);
  expect(runsMade).toHaveLength(2);
  expect(runsMade[1]?.start).toBeGreaterThanOrEqual(runsMade[0]?.end ?? Infinity);
  expect(firstDeployed).toContain("Edited before the sync");
  expect(firstDeployed).not.toContain("Edited after the sync");
  expect(served("faq")).toContain("Edited after the sync");
}, 480_000);

test("a scheduled page is published by the first run after its publishAt and retracted by the first run after its unpublishAt", async () => {
  const publishAt = Math.ceil((Date.now() + 15_000) / 1000) * 1000;
  const unpublishAt = publishAt + 15_000;
  cms.put("launch", {
    ...hero("Launch day"),
    // With milliseconds, as the build's instant has them: the window compares the two as text.
    publishAt: new Date(publishAt).toISOString(),
    unpublishAt: new Date(unpublishAt).toISOString(),
  });
  await published();
  expect(Date.parse(liveManifest().build.createdAt)).toBeLessThan(publishAt);
  expect(served("launch")).toBeUndefined();

  // The schedule fires: no edit, no webhook.
  await until(publishAt);
  runs.request();
  await runs.idle();
  expect(Date.parse(liveManifest().build.createdAt)).toBeGreaterThanOrEqual(publishAt);
  expect(served("launch")).toContain("Launch day");

  await until(unpublishAt);
  runs.request();
  await runs.idle();
  expect(served("launch")).toBeUndefined();
  expect(liveManifest().files.map(({ path }) => path)).not.toContain("launch/index.html");
}, 480_000);

async function failsAndRecovers(
  fail: () => string | undefined,
  mend: () => void,
  step: StepName,
): Promise<{ failed: PublishResult; recovered: PublishResult }> {
  schedule = false;
  try {
    const origin = tree(ORIGIN);
    const state = tree(STATE);
    const url = fail();
    await cms.delivered();

    const failed = await job(url);

    expect(failedAt(failed)).toBe(step);
    expect(tree(ORIGIN)).toEqual(origin);
    expect(tree(STATE)).toEqual(state);

    mend();
    await cms.delivered();
    const recovered = await job();
    expect(recovered.ok, failedAt(recovered)).toBe(true);
    expect(recovered.incremental).toBe(true);
    expect(recovered.steps.flatMap(({ argv }) => argv)).not.toContain("--force");
    return { failed, recovered };
  } finally {
    schedule = true;
  }
}

test("a CMS outage fails the run at sync, leaves the origin and the state as they were, and the next run deploys the edit", async () => {
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const down = `http://127.0.0.1:${String((closed.address() as AddressInfo).port)}/`;
  await new Promise<void>((resolve) => closed.close(() => resolve()));

  await failsAndRecovers(
    () => {
      cms.put("faq", hero("Written during the outage"));
      return down;
    },
    () => undefined,
    "sync",
  );

  expect(served("faq")).toContain("Written during the outage");
}, 480_000);

test("a page the schema refuses fails the run at sync, and the corrected page deploys", async () => {
  const { failed } = await failsAndRecovers(
    () => {
      cms.put("faq", { title: "Broken", blocks: [{ type: "carousel" }] });
      return undefined;
    },
    () => cms.put("faq", hero("Mended after a bad block")),
    "sync",
  );

  expect(failed.steps.at(-1)?.stderr).toContain("faq");
  expect(served("faq")).toContain("Mended after a bad block");
}, 480_000);

test("a build that fails its budget fails the run at build, and the corrected page deploys", async () => {
  const { failed } = await failsAndRecovers(
    () => {
      cms.put("home", {
        title: "Welcome",
        blocks: [{ type: "faq", questions: [{ question: "Why?", answer: "Because." }] }],
      });
      return undefined;
    },
    () => cms.put("home", hero("Welcome back")),
    "build",
  );

  expect(failed.steps.at(-1)?.stderr).toContain("budget");
  expect(served("")).toContain("Welcome back");
}, 480_000);

// Root writes through a read-only directory, so the deploy could not fail this way.
test.skipIf(process.getuid?.() === 0)(
  "a deploy that cannot write leaves the live build serving, and a re-run deploys the edit",
  async () => {
    const faq = join(ORIGIN, "faq");
    try {
      const { failed } = await failsAndRecovers(
        () => {
          cms.put("faq", hero("Written while the origin refused it"));
          chmodSync(join(faq, "index.html"), 0o444);
          chmodSync(faq, 0o555);
          return undefined;
        },
        () => {
          chmodSync(faq, 0o755);
          chmodSync(join(faq, "index.html"), 0o644);
        },
        "deploy",
      );

      expect(failed.steps.at(-1)?.code).toBe(1);
    } finally {
      chmodSync(faq, 0o755);
      chmodSync(join(faq, "index.html"), 0o644);
    }
    expect(served("faq")).toContain("Written while the origin refused it");
  },
  480_000,
);

test("a run whose retained state was lost is refused at deploy, and the live build's document put back in the retention store lets the next run deploy", async () => {
  schedule = false;
  try {
    rmSync(STATE, { recursive: true, force: true });
    const origin = tree(ORIGIN);

    const refused = await job();

    expect(failedAt(refused)).toBe("deploy");
    expect(refused.incremental).toBe(false);
    expect(refused.steps.at(-1)?.code).toBe(2);
    expect(refused.steps.at(-1)?.stderr).toContain("records no parent");
    expect(tree(ORIGIN)).toEqual(origin);

    const live = liveManifest().build.id;
    mkdirSync(join(STATE, ".pagedeck", "manifests"), { recursive: true });
    cpSync(
      join(ORIGIN, ".pagedeck", "manifests", `${live}.json`),
      join(STATE, ".pagedeck", "manifests", `${live}.json`),
    );
    const seeded = await job();

    expect(seeded.ok, failedAt(seeded)).toBe(true);
    expect(seeded.incremental).toBe(false);
    expect(seeded.steps.flatMap(({ argv }) => argv)).not.toContain("--force");
  } finally {
    schedule = true;
  }
}, 480_000);

test("every deploy was built on the one before it, so no run raced another", () => {
  const history = join(ORIGIN, ".pagedeck", "manifests");
  const builds = readdirSync(history)
    .filter((name) => name.endsWith(".json"))
    .map(
      (name) =>
        (JSON.parse(readFileSync(join(history, name), "utf8")) as {
          build: { id: string; createdAt: string; parent?: string };
        }).build,
    )
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : 1));

  expect(builds.length).toBeGreaterThanOrEqual(10);
  expect(builds[0]?.parent).toBeUndefined();
  for (let index = 1; index < builds.length; index += 1) {
    expect(builds[index]?.parent).toBe(builds[index - 1]?.id);
  }
});
