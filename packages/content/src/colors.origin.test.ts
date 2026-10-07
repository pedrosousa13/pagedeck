import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { syncImageColors } from "./colors.js";
import { openStore } from "./store.js";
import type { ContentStore } from "./store.js";

const ASSETS: Record<string, [number, number, number]> = {
  "/hero.jpg": [47, 58, 40],
  "/card.jpg": [200, 16, 16],
};

const requested: string[] = [];

let origin = "";
let server: Server;
let dir = "";
let store: ContentStore;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    requested.push(path);
    const asset = ASSETS[path];
    if (asset === undefined) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.statusCode = 200;
    response.end(Buffer.from(asset));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${String(port)}`;

  dir = mkdtempSync(join(tmpdir(), "pagedeck-content-origin-"));
  store = openStore(join(dir, "content.db"));
});

afterAll(async () => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

async function probe(src: string): Promise<string | undefined> {
  const response = await fetch(`${origin}${src}`);
  if (!response.ok) throw new Error(`${String(response.status)} from the origin`);
  const [red, green, blue] = new Uint8Array(await response.arrayBuffer());
  if (red === undefined || green === undefined || blue === undefined) {
    return undefined;
  }
  return `rgb(${String(red)} ${String(green)} ${String(blue)})`;
}

test("a first sync asks the origin once per unique source and a second asks it nothing", async () => {
  const sources = ["/hero.jpg", "/card.jpg", "/hero.jpg", "/card.jpg"];

  await syncImageColors({ store, collection: "pages", sources, probe });

  expect([...requested].sort()).toEqual(["/card.jpg", "/hero.jpg"]);
  expect(store.getImageColor("/hero.jpg")).toBe("rgb(47 58 40)");
  expect(store.getImageColor("/card.jpg")).toBe("rgb(200 16 16)");

  requested.length = 0;
  await syncImageColors({ store, collection: "pages", sources, probe });

  expect(requested).toEqual([]);
});

test("a source the origin answers 404 for degrades to no placeholder and is asked again", async () => {
  const warnings: string[] = [];
  requested.length = 0;

  await syncImageColors({
    store,
    collection: "pages",
    sources: ["/missing.jpg"],
    probe,
    onWarning: (message) => warnings.push(message),
  });

  expect(store.getImageColor("/missing.jpg")).toBeUndefined();
  expect(warnings).toEqual([
    'Collection "pages": 1 image source could not be probed for a dominant color, so it renders with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site\'s wiring; the next sync asks again:\n' +
      '  "/missing.jpg" — 404 from the origin',
  ]);

  requested.length = 0;
  await syncImageColors({
    store,
    collection: "pages",
    sources: ["/missing.jpg"],
    probe,
    onWarning: () => undefined,
  });

  expect(requested).toEqual(["/missing.jpg"]);
});
