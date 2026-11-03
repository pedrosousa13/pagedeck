import { runInNewContext } from "node:vm";
import { performance } from "node:perf_hooks";
import { describe, expect, test } from "vitest";
import {
  LOADOUT,
  MIXES,
  buildFailure,
  declaredScripts,
  expectedHits,
  loadoutSource,
  median,
  offMachine,
  readRun,
  runFailures,
  siteConfigSource,
  table,
} from "./loadout-lighthouse.harness.js";
import { NoLighthouseResult } from "./lighthouse-run.test-support.js";

const LOADOUT_ORIGIN = "http://localhost:4100";
const SITE_ORIGIN = "http://127.0.0.1:4200";

interface Appended {
  readonly tag: string;
  readonly src?: string;
  readonly text?: string;
}

function runScript(name: string): {
  appended: Appended[];
  beacons: string[];
  images: string[];
  fetched: string[];
  elapsed: number;
} {
  const appended: Appended[] = [];
  const beacons: string[] = [];
  const images: string[] = [];
  const fetched: string[] = [];
  const element = (tag: string): Record<string, unknown> => ({ tag, style: {} });
  const append = (node: Record<string, unknown>): void => {
    appended.push({
      tag: String(node["tag"]),
      ...(typeof node["src"] === "string" ? { src: node["src"] } : {}),
      ...(typeof node["textContent"] === "string" ? { text: node["textContent"] } : {}),
    });
  };
  const context = {
    navigator: {
      sendBeacon: (url: string) => {
        beacons.push(url);
        return true;
      },
    },
    fetch: (url: string) => {
      fetched.push(url);
      return Promise.resolve();
    },
    Image: class {
      set src(url: string) {
        images.push(url);
      }
    },
    document: {
      createElement: element,
      head: { appendChild: append },
      body: { appendChild: append },
    },
  };
  const script = LOADOUT.find((one) => one.name === name);
  if (script === undefined) throw new Error(`no script ${name}`);
  const start = performance.now();
  runInNewContext(loadoutSource(script, LOADOUT_ORIGIN), context);
  return { appended, beacons, images, fetched, elapsed: performance.now() - start };
}

describe("the loadout", () => {
  test("declares six scripts, four on the page and two the tag manager injects", () => {
    expect(
      LOADOUT.map(({ name, costMs, injectedBy, widget }) => ({ name, costMs, injectedBy, widget })),
    ).toEqual([
      { name: "tag-manager", costMs: 40, injectedBy: undefined, widget: undefined },
      { name: "tag-1", costMs: 20, injectedBy: "tag-manager", widget: undefined },
      { name: "tag-2", costMs: 20, injectedBy: "tag-manager", widget: undefined },
      { name: "analytics", costMs: 60, injectedBy: undefined, widget: undefined },
      { name: "pixel", costMs: 30, injectedBy: undefined, widget: undefined },
      { name: "chat", costMs: 80, injectedBy: undefined, widget: true },
    ]);
  });

  test("each script spins the main thread or the worker for at least its declared cost", () => {
    for (const { name, costMs } of LOADOUT) {
      expect(runScript(name).elapsed).toBeGreaterThanOrEqual(costMs);
    }
  });

  test("the tag manager injects its two tags from the loadout origin", () => {
    const { appended } = runScript("tag-manager");
    expect(appended).toEqual([
      { tag: "script", src: `${LOADOUT_ORIGIN}/tag-1.js` },
      { tag: "script", src: `${LOADOUT_ORIGIN}/tag-2.js` },
    ]);
  });

  test("analytics beacons, the pixel requests an image, and every other script fetches", () => {
    expect(runScript("analytics").beacons).toEqual([
      `${LOADOUT_ORIGIN}/collect?script=analytics&where=main`,
    ]);
    expect(runScript("pixel").images).toEqual([
      `${LOADOUT_ORIGIN}/pixel.gif?script=pixel&where=main`,
    ]);
    for (const name of ["tag-manager", "tag-1", "tag-2", "chat"]) {
      expect(runScript(name).fetched).toEqual([
        `${LOADOUT_ORIGIN}/hit?script=${name}&where=main`,
      ]);
    }
  });

  test("the chat widget puts its button on the page", () => {
    expect(runScript("chat").appended).toEqual([{ tag: "button", text: "Chat" }]);
  });
});

describe("the strategy mixes", () => {
  test("are idle, the default and a facade for chat, in that order", () => {
    expect(MIXES).toEqual(["idle", "default", "facade"]);
  });

  test("declare the four page scripts and never the injected tags", () => {
    for (const mix of MIXES) {
      expect(declaredScripts(mix, LOADOUT_ORIGIN).map(({ name, src }) => ({ name, src }))).toEqual(
        ["tag-manager", "analytics", "pixel", "chat"].map((name) => ({
          name,
          src: `${LOADOUT_ORIGIN}/${name}.js`,
        })),
      );
    }
  });

  test("everything idle declares idle on every script", () => {
    expect(declaredScripts("idle", LOADOUT_ORIGIN).map(({ strategy }) => strategy)).toEqual([
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
  });

  test("the default declares no strategy and no category, so each script takes worker", () => {
    for (const script of declaredScripts("default", LOADOUT_ORIGIN)) {
      expect(Object.keys(script).sort()).toEqual(["name", "src"]);
    }
  });

  test("the facade mix puts chat behind a placeholder and leaves the rest on the default", () => {
    const scripts = declaredScripts("facade", LOADOUT_ORIGIN);
    expect(scripts.filter(({ name }) => name !== "chat").map(Object.keys)).toEqual([
      ["name", "src"],
      ["name", "src"],
      ["name", "src"],
    ]);
    expect(scripts.find(({ name }) => name === "chat")).toMatchObject({
      strategy: "facade",
      facade: { html: expect.stringContaining("Chat") },
    });
  });

  test("each mix expects every script it loads to report once, from the thread its strategy puts it on", () => {
    const all = ["tag-manager", "tag-1", "tag-2", "analytics", "pixel", "chat"];
    expect(expectedHits("idle")).toEqual(all.map((name) => `${name}@main`).sort());
    expect(expectedHits("default")).toEqual(all.map((name) => `${name}@worker`).sort());
    expect(expectedHits("facade")).toEqual(
      all.filter((name) => name !== "chat").map((name) => `${name}@worker`).sort(),
    );
  });

  test("every mix's site declares the Partytown runtime and its scripts", () => {
    for (const mix of MIXES) {
      const source = siteConfigSource(mix, LOADOUT_ORIGIN);
      expect(source).toContain('from "@pagedeck/script-worker"');
      expect(source).toContain("runtime: definePartytown()");
      expect(source).toContain(JSON.stringify(declaredScripts(mix, LOADOUT_ORIGIN)));
    }
  });
});

describe("no request leaves the machine", () => {
  const origins = [SITE_ORIGIN, LOADOUT_ORIGIN];

  test("requests to the two origins, and data URLs, stay on it", () => {
    expect(
      offMachine(
        [
          `${SITE_ORIGIN}/`,
          `${SITE_ORIGIN}/script-runtime/abcd1234/partytown-sw.js`,
          `${LOADOUT_ORIGIN}/analytics.js`,
          `blob:${SITE_ORIGIN}/2f1c6a52-6e0e-4a8e-9a43-0c1f1b5f3e10`,
          "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
        ],
        origins,
      ),
    ).toEqual([]);
  });

  test("any other origin is reported, loopback or not", () => {
    expect(
      offMachine(
        [
          `${SITE_ORIGIN}/`,
          "https://collector.example/collect",
          "http://127.0.0.1:9999/other",
          "http://localhost:4200/",
          "blob:https://elsewhere.example/2f1c6a52",
          "ws://127.0.0.1:4200/",
        ],
        origins,
      ),
    ).toEqual([
      "https://collector.example/collect",
      "http://127.0.0.1:9999/other",
      "http://localhost:4200/",
      "blob:https://elsewhere.example/2f1c6a52",
      "ws://127.0.0.1:4200/",
    ]);
  });

  test("a URL the parser cannot read is reported rather than passed", () => {
    expect(offMachine(["not a url"], origins)).toEqual(["not a url"]);
  });
});

describe("a Lighthouse run", () => {
  const lhr = {
    categories: { performance: { score: 0.874 } },
    audits: {
      metrics: {
        details: {
          items: [
            {
              totalBlockingTime: 412.6,
              largestContentfulPaint: 1834.2,
              cumulativeLayoutShift: 0.0123,
              firstContentfulPaint: 900,
            },
          ],
        },
      },
      "network-requests": {
        details: { items: [{ url: `${SITE_ORIGIN}/` }, { url: `${LOADOUT_ORIGIN}/chat.js` }] },
      },
    },
  };

  test("is read as its score, TBT, LCP, CLS and every URL it requested", () => {
    expect(readRun(lhr)).toEqual({
      performance: 87,
      tbt: 412.6,
      lcp: 1834.2,
      cls: 0.0123,
      urls: [`${SITE_ORIGIN}/`, `${LOADOUT_ORIGIN}/chat.js`],
    });
  });

  test("with a metric missing is refused, so a run never reads as a zero", () => {
    expect(() =>
      readRun({ ...lhr, audits: { ...lhr.audits, metrics: { details: { items: [{}] } } } }),
    ).toThrow(/totalBlockingTime/);
    expect(() => readRun({ ...lhr, categories: { performance: { score: null } } })).toThrow(
      /performance/,
    );
  });

  test("that failed says why, in Lighthouse's own words", () => {
    expect(() =>
      readRun({
        ...lhr,
        categories: { performance: { score: null } },
        runtimeError: { code: "NO_FCP", message: "The page did not paint any content." },
      }),
    ).toThrow(/NO_FCP: The page did not paint any content\./);
  });
});

test("the median of an odd count is the middle value, of an even count the mean of the two", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 3, 2])).toBe(2.5);
});

test("the table prints every run, then each mix's median", () => {
  const run = (performance: number, tbt: number, cls = 0) => ({
    performance,
    tbt,
    lcp: 1500,
    cls,
    urls: [],
  });
  expect(
    table([
      { mix: "idle", runs: [run(70, 700), run(72, 650.4), run(71, 690, 0.0123)] },
      { mix: "default", runs: [run(98, 40), run(99, 20), run(97, 60)] },
    ]),
  ).toBe(
    [
      "mix       run  perf  TBT ms  LCP ms    CLS",
      "idle        1    70     700    1500  0.000",
      "idle        2    72     650    1500  0.000",
      "idle        3    71     690    1500  0.012",
      "idle      med    71     690    1500  0.000",
      "default     1    98      40    1500  0.000",
      "default     2    99      20    1500  0.000",
      "default     3    97      60    1500  0.000",
      "default   med    98      40    1500  0.000",
    ].join("\n"),
  );
});

describe("a run's failures", () => {
  const origins = [SITE_ORIGIN, LOADOUT_ORIGIN];
  const figures = {
    performance: 100,
    tbt: 0,
    lcp: 600,
    cls: 0,
    urls: [`${SITE_ORIGIN}/`, `${LOADOUT_ORIGIN}/tag-manager.js`],
  };

  test("are none when every request stays home and every script reports as the mix calls for", () => {
    expect(
      runFailures({ mix: "default", run: 1, outcome: figures, hits: expectedHits("default"), origins }),
    ).toEqual([]);
  });

  test("name the mix and run of a run Lighthouse could not finish once, and keep its reason", () => {
    expect(
      runFailures({
        mix: "idle",
        run: 2,
        outcome: new NoLighthouseResult("Loadout harness", "http://127.0.0.1:4200/"),
        hits: [],
        origins,
      }),
    ).toEqual([
      'mix "idle" run 2: Loadout harness: Lighthouse returned no result, so this page contributed nothing to the report — re-run, and if it repeats the page is not loading at http://127.0.0.1:4200/',
    ]);
  });

  test("keep a run with no figure to the message readRun gives it", () => {
    let thrown: unknown;
    try {
      readRun({ categories: { performance: { score: null } }, audits: {} });
    } catch (error) {
      thrown = error;
    }
    const [failure] = runFailures({ mix: "idle", run: 1, outcome: thrown as Error, hits: [], origins });
    expect(failure).toMatch(/^mix "idle" run 1: Loadout harness: Lighthouse reported no "performance" score/);
    expect(failure).not.toContain("    at ");
  });

  test("keep the stack and cause of an error the harness did not expect", () => {
    const cause = new RangeError("inner fault");
    const outcome = new TypeError("lhr.audits is undefined", { cause });
    const [failure] = runFailures({ mix: "default", run: 1, outcome, hits: [], origins });
    expect(failure).toMatch(/^mix "default" run 1: an error the harness did not expect, which is a fault in the harness — fix it:\n/);
    expect(failure).toContain("TypeError: lhr.audits is undefined");
    expect(failure).toContain("    at ");
    expect(failure).toContain("RangeError: inner fault");
  });

  test("list a request to another origin and a script that reported from the wrong thread, both", () => {
    const failures = runFailures({
      mix: "default",
      run: 3,
      outcome: { ...figures, urls: [...figures.urls, "https://collector.example/collect"] },
      hits: expectedHits("idle"),
      origins,
    });
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatch(/^mix "default" run 3: 1 request went to neither/);
    expect(failures[0]).toContain("  https://collector.example/collect");
    expect(failures[1]).toMatch(/^mix "default" run 3: the loadout reported/);
  });
});

test("a fixture build that fails names the mix and the verb, and carries the failure as its cause", () => {
  const cause = Object.assign(new Error("Command failed"), { stderr: "pagedeck: Config fault\n" });
  const error = buildFailure("facade", "build", "/work/facade", cause);
  expect(error.message).toMatch(/^Loadout harness, mix "facade": `pagedeck build` failed in \/work\/facade/);
  expect(error.message).toContain("pagedeck: Config fault");
  expect(error.cause).toBe(cause);
});
