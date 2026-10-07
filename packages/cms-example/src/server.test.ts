import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { startCms } from "./server.js";
import type { Cms } from "./server.js";

let cms: Cms | undefined;

afterEach(async () => {
  await cms?.close();
  cms = undefined;
});

async function get(path: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  if (cms === undefined) throw new Error("start the CMS first");
  const response = await fetch(new URL(path, cms.url));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

function ids(body: unknown): string[] {
  return (body as { pages: { id: string }[] }).pages.map((page) => page.id);
}

test("the CMS listens on 127.0.0.1 at the port the system picks", async () => {
  cms = await startCms({ port: 0 });

  expect(cms.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(cms.url).not.toBe("http://127.0.0.1:0/");
});

test("the list serves every page in pages of two, sorted by id, with the CMS's revision", async () => {
  cms = await startCms({ port: 0 });

  const first = await get("pages");
  const second = await get("pages?page=2");

  expect(ids(first.body)).toEqual(["faq", "home"]);
  expect(first.body).toMatchObject({ nextPage: 2, revision: 3 });
  expect(ids(second.body)).toEqual(["signup"]);
  expect(second.body).toMatchObject({ nextPage: null, revision: 3 });
  expect((second.body as { pages: unknown[] }).pages[0]).toMatchObject({
    id: "signup",
    revision: 3,
    title: "Sign up",
    blocks: [{ type: "hero" }, { type: "signup_form" }],
  });
});

test("the changes since a revision name the pages edited and the pages removed after it", async () => {
  cms = await startCms({ port: 0 });

  cms.put("faq", { title: "Questions", blocks: [{ type: "hero", heading: "Q", text: "A" }] });
  cms.remove("home");

  const changes = await get("changes?since=3");
  expect(changes.body).toEqual({
    pages: [
      {
        id: "faq",
        revision: 4,
        title: "Questions",
        blocks: [{ type: "hero", heading: "Q", text: "A" }],
      },
    ],
    deleted: ["home"],
    revision: 5,
  });
  expect(await get("changes?since=5")).toMatchObject({
    body: { pages: [], deleted: [], revision: 5 },
  });
  expect(ids((await get("pages")).body)).toEqual(["faq", "signup"]);
});

test("a page put back after its removal is a change, not a deletion", async () => {
  cms = await startCms({ port: 0 });

  cms.remove("home");
  cms.put("home", { title: "Back", blocks: [] });

  expect((await get("changes?since=3")).body).toMatchObject({
    pages: [{ id: "home", revision: 5 }],
    deleted: [],
  });
});

test("every answer is JSON with a content-length", async () => {
  cms = await startCms({ port: 0 });

  const { headers } = await get("pages");

  expect(headers.get("content-type")).toBe("application/json");
  expect(Number(headers.get("content-length"))).toBeGreaterThan(0);
});

test("a path it does not serve is a 404, and a query it cannot read is a 400", async () => {
  cms = await startCms({ port: 0 });

  expect(await get("nowhere")).toMatchObject({ status: 404 });
  expect(await get("pages?page=0")).toMatchObject({ status: 400 });
  expect(await get("pages?page=two")).toMatchObject({ status: 400 });
  expect(await get("changes")).toMatchObject({ status: 400 });
  expect(await get("changes?since=-1")).toMatchObject({ status: 400 });
});

test("a page file that is not JSON is refused by name, with the parser's error attached", async () => {
  const data = mkdtempSync(join(tmpdir(), "pagedeck-cms-data-"));
  try {
    writeFileSync(join(data, "home.json"), '{ "title": "Home", "blocks": [] }');
    writeFileSync(join(data, "faq.json"), '{ "title": "Questions", ');

    const failure = await startCms({ data, port: 0 }).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message).toBe(
      `CMS page "${join(data, "faq.json")}": is not valid JSON — fix the file, or remove it from "${data}"`,
    );
    expect(failure?.cause).toBeInstanceOf(SyntaxError);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test("every page file that is not JSON is named in one report", async () => {
  const data = mkdtempSync(join(tmpdir(), "pagedeck-cms-data-"));
  try {
    writeFileSync(join(data, "faq.json"), "{");
    writeFileSync(join(data, "signup.json"), "");

    await expect(startCms({ data, port: 0 })).rejects.toThrow(
      new RegExp(
        `^CMS pages in "${data.replaceAll("\\", "\\\\")}": 2 files are not valid JSON — fix each, or remove it:\\n  "faq\\.json" — .+\\n  "signup\\.json" — .+$`,
      ),
    );
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
