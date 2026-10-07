import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CollectionError } from "./collection.js";
import { DEFAULT_COLOR_CONCURRENCY, syncImageColors } from "./colors.js";
import { openStore } from "./store.js";
import type { ContentStore } from "./store.js";

const tempDirs: string[] = [];
const openStores: ContentStore[] = [];

function openTempStore(): ContentStore {
  const dir = mkdtempSync(join(tmpdir(), "pagedeck-content-colors-"));
  tempDirs.push(dir);
  const store = openStore(join(dir, "content.db"));
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function countingProbe(colors: Record<string, string | undefined>) {
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
      // A timer is the suspension point that makes overlap observable.
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return colors[src];
    },
  };
}

test("one unique source is probed once, however many images name it", async () => {
  const store = openTempStore();
  const { asked, probe } = countingProbe({ "/hero.jpg": "#2f3a28" });

  await syncImageColors({
    store,
    collection: "pages",
    sources: ["/hero.jpg", "/hero.jpg", "/hero.jpg"],
    probe,
  });

  expect(asked).toEqual(["/hero.jpg"]);
  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");
});

test("a second sync over the same sources issues no requests at all", async () => {
  const store = openTempStore();
  const colors = { "/hero.jpg": "#2f3a28", "/logo.svg": undefined };
  const first = countingProbe(colors);
  await syncImageColors({
    store,
    collection: "pages",
    sources: ["/hero.jpg", "/logo.svg"],
    probe: first.probe,
  });
  expect(first.asked).toHaveLength(2);

  const second = countingProbe(colors);
  await syncImageColors({
    store,
    collection: "pages",
    sources: ["/hero.jpg", "/logo.svg"],
    probe: second.probe,
  });

  expect(second.asked).toEqual([]);
});

test("no more probes are in flight at once than the concurrency allows", async () => {
  const store = openTempStore();
  const sources = ["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg", "/e.jpg"];
  const limited = countingProbe({});

  await syncImageColors({
    store,
    collection: "pages",
    sources,
    probe: limited.probe,
    concurrency: 2,
  });

  expect(limited.peak()).toBe(2);
  expect(limited.asked).toHaveLength(5);
});

test("the concurrency ceiling is the limit and not the shape of the loop", async () => {
  const store = openTempStore();
  const sources = ["/a.jpg", "/b.jpg", "/c.jpg", "/d.jpg", "/e.jpg"];
  const wide = countingProbe({});

  // The control: with the limit raised, the same probe reaches five at once.
  await syncImageColors({
    store,
    collection: "pages",
    sources,
    probe: wide.probe,
    concurrency: 5,
  });

  expect(wide.peak()).toBe(5);
});

test("a source whose probe throws keeps its color absent and takes the sync with nothing", async () => {
  const store = openTempStore();
  const warnings: string[] = [];

  await syncImageColors({
    store,
    collection: "pages",
    sources: ["/hero.jpg", "/broken.jpg"],
    probe: (src) => {
      if (src === "/broken.jpg") throw new Error("502 Bad Gateway");
      return "#2f3a28";
    },
    onWarning: (message) => warnings.push(message),
  });

  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");
  expect(store.getImageColor("/broken.jpg")).toBeUndefined();
  expect(store.hasImageColor("/broken.jpg")).toBe(false);
});

test("a failed probe is retried by the next sync, and succeeds", async () => {
  const store = openTempStore();
  let attempts = 0;
  const probe = (): string => {
    attempts += 1;
    if (attempts === 1) throw new Error("502 Bad Gateway");
    return "#2f3a28";
  };

  await syncImageColors({ store, collection: "pages", sources: ["/hero.jpg"], probe });
  await syncImageColors({ store, collection: "pages", sources: ["/hero.jpg"], probe });

  expect(attempts).toBe(2);
  expect(store.getImageColor("/hero.jpg")).toBe("#2f3a28");
});

test("every failed source is reported in one warning, not the first of them", async () => {
  const store = openTempStore();
  const warnings: string[] = [];

  await syncImageColors({
    store,
    collection: "pages",
    sources: ["/b.jpg", "/a.jpg", "/ok.jpg"],
    probe: (src) => {
      if (src === "/ok.jpg") return "#2f3a28";
      throw new Error(src === "/a.jpg" ? "timed out" : "502 Bad Gateway");
    },
    onWarning: (message) => warnings.push(message),
  });

  expect(warnings).toEqual([
    'Collection "pages": 2 image sources could not be probed for a dominant color, so they render with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site\'s wiring; the next sync asks again:\n' +
      '  "/a.jpg" — timed out\n' +
      '  "/b.jpg" — 502 Bad Gateway',
  ]);
});

test("a probe that answers with something that is not a color is a wiring fault", async () => {
  const store = openTempStore();

  const error: unknown = await syncImageColors({
    store,
    collection: "pages",
    sources: ["/a.jpg", "/b.jpg"],
    probe: (src) => (src === "/a.jpg" ? (17 as unknown as string) : "#2f3a28"),
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(CollectionError);
  expect((error as Error).message).toBe(
    'Collection "pages": the image color probe answered 1 source with something that is not a CSS color — return a CSS color such as "#2f3a28", or undefined for an image that has none:\n' +
      "  \"/a.jpg\" — 17 — not a string",
  );
});

test("a nested signed URL in a bad answer is cut at its query before it is quoted", async () => {
  const store = openTempStore();

  const error: unknown = await syncImageColors({
    store,
    collection: "pages",
    sources: ["/a.jpg"],
    probe: () =>
      ({
        url: "https://cdn.example/hero.jpg?sig=SECRET",
      }) as unknown as string,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect((error as Error).message).toBe(
    'Collection "pages": the image color probe answered 1 source with something that is not a CSS color — return a CSS color such as "#2f3a28", or undefined for an image that has none:\n' +
      '  "/a.jpg" — {"url":"https://cdn.example/hero.jpg?…"} — not a string',
  );
  expect((error as Error).message).not.toContain("SECRET");
});

const CONTROLS = "\u001b[2K\r\n\u009b\u2028";
const RAW_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

function linesOf(message: string): readonly string[] {
  return message.split("\n");
}

test("a bad answer's control characters are escaped, nested or not", async () => {
  const store = openTempStore();

  const error: unknown = await syncImageColors({
    store,
    collection: "pages",
    sources: ["/a.jpg", "/b.jpg"],
    probe: (src) =>
      (src === "/a.jpg"
        ? { color: CONTROLS }
        : Symbol(CONTROLS)) as unknown as string,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  const lines = linesOf((error as Error).message);
  expect(lines).toHaveLength(3);
  for (const line of lines) expect(line).not.toMatch(RAW_CONTROL);
  expect(lines[1]).toBe(
    '  "/a.jpg" — {"color":"\\u001b[2K\\r\\n\\u009b\\u2028"} — not a string',
  );
  expect(lines[2]).toBe(
    '  "/b.jpg" — Symbol(\ufffd[2K\ufffd\ufffd\ufffd\u2028) — not a string',
  );
});

test("a concurrency holding control characters is escaped in the refusal", async () => {
  const store = openTempStore();

  const error: unknown = await syncImageColors({
    store,
    collection: "pages",
    sources: ["/a.jpg"],
    probe: () => undefined,
    concurrency: CONTROLS as unknown as number,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  const lines = linesOf((error as Error).message);
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line).not.toMatch(RAW_CONTROL);
  expect(lines[1]).toBe('  "\\u001b[2K\\r\\n\\u009b\\u2028" — not a number');
});

test("a credential in front of the host is dropped before the source is quoted", async () => {
  const store = openTempStore();
  const warnings: string[] = [];

  await syncImageColors({
    store,
    collection: "pages",
    sources: ["https://reader:s3cret@cdn.example/a.jpg"],
    probe: () => {
      throw new Error("401 Unauthorized");
    },
    onWarning: (message) => warnings.push(message),
  });

  expect(warnings).toEqual([
    'Collection "pages": 1 image source could not be probed for a dominant color, so it renders with no placeholder — this is a warning and never a refusal, because a color is decoration and the host that serves the image is not this site\'s wiring; the next sync asks again:\n' +
      '  "https://…@cdn.example/a.jpg" — 401 Unauthorized',
  ]);
  expect(warnings[0]).not.toContain("s3cret");
});

test("a concurrency below one is refused, naming the field and the fix", async () => {
  const store = openTempStore();
  const { asked, probe } = countingProbe({});

  const error: unknown = await syncImageColors({
    store,
    collection: "pages",
    sources: ["/a.jpg"],
    probe,
    concurrency: 0,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(CollectionError);
  expect((error as Error).message).toBe(
    'Collection "pages": "imageColors.concurrency" is not a number of probes — write a whole number of probes above zero, such as { concurrency: 4 }:\n  0 — below one, and a sync that may run no probe at all would never cache a color',
  );
  expect(asked).toEqual([]);
});

test("the default concurrency is a small burst against one host", () => {
  expect(DEFAULT_COLOR_CONCURRENCY).toBe(4);
});

test("a hostile source and the probe's text about it reach the warning with their controls neutralised", async () => {
  const store = openTempStore();
  const warnings: string[] = [];
  const src = "/x\u009b2K\u001b[1G.jpg";

  await syncImageColors({
    store,
    collection: "pages",
    sources: [src],
    probe: (asked) => {
      throw new Error(`no image at ${asked}\r\npagedeck: sync complete`);
    },
    onWarning: (message) => warnings.push(message),
  });

  const lines = (warnings[0] ?? "").split("\n");
  expect(warnings[0]).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(lines.slice(1)).toEqual([
    '  "/x\\u009b2K\\u001b[1G.jpg" — no image at /x\ufffd2K\ufffd[1G.jpg\ufffd\ufffdpagedeck: sync complete',
  ]);
});
