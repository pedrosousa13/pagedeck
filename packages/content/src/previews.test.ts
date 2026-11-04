import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CollectionError } from "./collection.js";
import { MAX_PREVIEW_BYTES } from "./preview.js";
import { DEFAULT_PREVIEW_CONCURRENCY, syncImagePreviews } from "./previews.js";
import type { ImagePreviewSource } from "./previews.js";
import { openStore } from "./store.js";
import type { ContentStore } from "./store.js";

const tempDirs: string[] = [];
const openStores: ContentStore[] = [];

function openTempStore(): ContentStore {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-content-previews-"));
  tempDirs.push(dir);
  const store = openStore(join(dir, "content.db"));
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PREVIEW = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

function on(entry: string, ...srcs: string[]): ImagePreviewSource[] {
  return srcs.map((src) => ({ src, entry }));
}

function countingProbe(previews: Record<string, string | undefined>) {
  const asked: string[] = [];
  let inFlight = 0;
  let peak = 0;
  return {
    asked,
    peak: () => peak,
    probe: async (src: string): Promise<string | undefined> => {
      asked.push(src);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return previews[src];
    },
  };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(CollectionError);
  return error as Error;
}

const FIX = `return a base64 data URI of a png, jpeg, webp, avif or gif image of at most ${String(MAX_PREVIEW_BYTES)} bytes, such as "data:image/webp;base64,UklGR…", or undefined for an image that has none`;

test("one unique source is probed once, however many entries name it", async () => {
  const store = openTempStore();
  const { asked, probe } = countingProbe({ "/hero.jpg": PREVIEW });

  await syncImagePreviews({
    store,
    collection: "pages",
    sources: [...on("/en/home", "/hero.jpg", "/hero.jpg"), ...on("/en/about", "/hero.jpg")],
    probe,
  });

  expect(asked).toEqual(["/hero.jpg"]);
  expect(store.getImagePreview("/hero.jpg")).toBe(PREVIEW);
});

test("a second sync over the same sources makes no probe calls, an answer of undefined included", async () => {
  const store = openTempStore();
  const previews = { "/hero.jpg": PREVIEW, "/logo.svg": undefined };
  const first = countingProbe(previews);
  await syncImagePreviews({
    store,
    collection: "pages",
    sources: on("/en/home", "/hero.jpg", "/logo.svg"),
    probe: first.probe,
  });
  expect(first.asked).toHaveLength(2);

  const second = countingProbe(previews);
  await syncImagePreviews({
    store,
    collection: "pages",
    sources: on("/en/home", "/hero.jpg", "/logo.svg"),
    probe: second.probe,
  });

  expect(second.asked).toEqual([]);
  expect(store.hasImagePreview("/logo.svg")).toBe(true);
});

test("no more probes are in flight at once than the concurrency allows", async () => {
  const store = openTempStore();
  const limited = countingProbe({});

  await syncImagePreviews({
    store,
    collection: "pages",
    sources: on("/en/home", "/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg", "/e.jpg"),
    probe: limited.probe,
    concurrency: 2,
  });

  expect(limited.peak()).toBe(2);
  expect(limited.asked).toHaveLength(5);
});

test("the default concurrency is the color probe's", () => {
  expect(DEFAULT_PREVIEW_CONCURRENCY).toBe(4);
});

test("a source whose probe throws is warned about, left uncached and asked again next sync", async () => {
  const store = openTempStore();
  const warnings: string[] = [];
  let attempts = 0;
  const probe = (src: string): string => {
    if (src === "/broken.jpg") {
      attempts += 1;
      if (attempts === 1) throw new Error("502 Bad Gateway");
    }
    return PREVIEW;
  };

  await syncImagePreviews({
    store,
    collection: "pages",
    sources: on("/en/home", "/hero.jpg", "/broken.jpg"),
    probe,
    onWarning: (message) => warnings.push(message),
  });

  expect(store.getImagePreview("/hero.jpg")).toBe(PREVIEW);
  expect(store.hasImagePreview("/broken.jpg")).toBe(false);
  expect(warnings).toEqual([
    'Collection "pages": 1 image source could not be probed for a preview, so it renders with its dominant color or no placeholder — this is a warning and never a refusal, because a preview is decoration and the host that serves the image is not this site\'s wiring; the next sync asks again:\n' +
      '  "/broken.jpg" — 502 Bad Gateway',
  ]);

  await syncImagePreviews({
    store,
    collection: "pages",
    sources: on("/en/home", "/hero.jpg", "/broken.jpg"),
    probe,
  });
  expect(store.getImagePreview("/broken.jpg")).toBe(PREVIEW);
});

test("a URL in the probe's thrown message loses its credential and its query before the warning prints it", async () => {
  const store = openTempStore();
  const warnings: string[] = [];

  await syncImagePreviews({
    store,
    collection: "pages",
    sources: on("/en/home", "https://cdn.example/x.jpg?token=SECRET"),
    probe: (asked) => {
      throw new Error(
        `GET ${asked} answered 403 after https://reader:s3cret@old.example/x.jpg`,
      );
    },
    onWarning: (message) => warnings.push(message),
  });

  expect(warnings[0]?.split("\n")[1]).toBe(
    '  "https://cdn.example/x.jpg?…" — GET https://cdn.example/x.jpg?… answered 403 after https://…@old.example/x.jpg',
  );
  expect(warnings[0]).not.toContain("SECRET");
  expect(warnings[0]).not.toContain("s3cret");
});

test("a malformed answer fails the sync naming the collection, every entry and the source, with the fix", async () => {
  const store = openTempStore();

  const error = await refusal(
    syncImagePreviews({
      store,
      collection: "pages",
      sources: [
        ...on("/en/home", "/a.svg", "/ok.jpg"),
        ...on("/de/home", "/a.svg"),
      ],
      probe: (src) => (src === "/a.svg" ? "data:image/svg+xml;base64,PHN2Zz4=" : PREVIEW),
    }),
  );

  expect(error.message).toBe(
    `Collection "pages": the image preview probe answered 1 source with something that is not an image preview — ${FIX}:\n` +
      '  "/a.svg" on /de/home, /en/home — "data:image/svg+xml;base64,PHN2Zz…" — not a base64 data URI of a png, jpeg, webp, avif or gif image',
  );
  expect(store.hasImagePreview("/ok.jpg")).toBe(false);
});

test("one refused answer caches none of the run's valid answers, so the next sync asks for them again", async () => {
  const store = openTempStore();
  let svg = true;
  const asked: string[] = [];
  const probe = (src: string): string => {
    asked.push(src);
    return src === "/a.svg" && svg ? "data:image/svg+xml;base64,PHN2Zz4=" : PREVIEW;
  };
  const sources = on("/en/home", "/a.svg", "/b.jpg", "/c.jpg");

  await refusal(syncImagePreviews({ store, collection: "pages", sources, probe }));

  expect(store.hasImagePreview("/b.jpg")).toBe(false);
  expect(store.hasImagePreview("/c.jpg")).toBe(false);

  svg = false;
  asked.length = 0;
  await syncImagePreviews({ store, collection: "pages", sources, probe });

  expect([...asked].sort()).toEqual(["/a.svg", "/b.jpg", "/c.jpg"]);
  expect(store.getImagePreview("/b.jpg")).toBe(PREVIEW);
});

test("an oversized answer fails the sync naming the source and the cap, and is not quoted whole", async () => {
  const store = openTempStore();
  const huge = `data:image/png;base64,${"A".repeat(4000)}`;

  const error = await refusal(
    syncImagePreviews({
      store,
      collection: "pages",
      sources: on("/en/home", "/hero.jpg"),
      probe: () => huge,
    }),
  );

  expect(error.message).toBe(
    `Collection "pages": the image preview probe answered 1 source with something that is not an image preview — ${FIX}:\n` +
      `  "/hero.jpg" on /en/home — "data:image/png;base64,AAAAAAAAAA…" — at least 4022 bytes, over the ${String(MAX_PREVIEW_BYTES)}-byte cap`,
  );
  expect(store.hasImagePreview("/hero.jpg")).toBe(false);
});

test("every bad answer is reported in one refusal, sorted, a non-string among them", async () => {
  const store = openTempStore();
  const answers: Record<string, unknown> = {
    "/b.jpg": 'data:image/png;base64,AAAA");background:url("https://x.example/',
    "/a.jpg": 17,
    "/c.jpg": "javascript:alert(1)",
  };

  const error = await refusal(
    syncImagePreviews({
      store,
      collection: "pages",
      sources: on("/en/home", "/c.jpg", "/b.jpg", "/a.jpg"),
      probe: (src) => answers[src] as string,
    }),
  );

  expect(error.message.split("\n")).toEqual([
    `Collection "pages": the image preview probe answered 3 sources with something that is not an image preview — ${FIX}:`,
    '  "/a.jpg" on /en/home — 17 — not a string',
    '  "/b.jpg" on /en/home — "data:image/png;base64,AAAA\\");bac…" — its payload is not base64 — only A-Z, a-z, 0-9, + and / in groups of four, the last padded with =',
    '  "/c.jpg" on /en/home — "javascript:alert(1)" — not a base64 data URI of a png, jpeg, webp, avif or gif image',
  ]);
});

test("a bad answer's control characters and a hostile entry id are escaped in the refusal", async () => {
  const store = openTempStore();

  const error = await refusal(
    syncImagePreviews({
      store,
      collection: "pages",
      sources: on("/en/x\u001b[2K", "/a.jpg"),
      probe: () => "data:image/png;base64,AAAA\r\n\u009b",
    }),
  );

  const lines = error.message.split("\n");
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
});

test("a concurrency below one is refused, naming this setting's field", async () => {
  const store = openTempStore();
  const { asked, probe } = countingProbe({});

  const error = await refusal(
    syncImagePreviews({
      store,
      collection: "pages",
      sources: on("/en/home", "/a.jpg"),
      probe,
      concurrency: 0,
    }),
  );

  expect(error.message).toBe(
    'Collection "pages": "imagePreviews.concurrency" is not a number of probes — write a whole number of probes above zero, such as { concurrency: 4 }:\n  0 — below one, and a sync that may run no probe at all would never cache a preview',
  );
  expect(asked).toEqual([]);
});

test("a credential in a long answer is redacted before the answer is cut short", async () => {
  const store = openTempStore();

  const error = await refusal(
    syncImagePreviews({
      store,
      collection: "pages",
      sources: on("/en/home", "/a.jpg"),
      probe: () => "https://user:hunter2-very-long-secret-token@cdn.example/x.jpg",
    }),
  );

  expect(error.message).not.toContain("hunter2");
  expect(error.message.split("\n")[1]).toBe(
    '  "/a.jpg" on /en/home — "https://…@cdn.example/x.jpg" — not a base64 data URI of a png, jpeg, webp, avif or gif image',
  );
});
