import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import {
  BEACON_CATEGORY,
  beaconElement,
  beaconFaultReport,
  isBeaconText,
} from "./beacon.js";
import type { BeaconSetting } from "./beacon.js";
import type { ScriptsSetting } from "./scripts.js";

const HOME = { locale: "en", path: "/" };
const ENDPOINT = "https://example.com/rum";
const BEACON: BeaconSetting = { endpoint: ENDPOINT };

function element(scripts?: ScriptsSetting, page = HOME): string {
  const html = beaconElement(BEACON, scripts, page);
  if (html === undefined) throw new Error("no beacon element was emitted");
  return html;
}

test("a site that declares no beacon carries none", () => {
  expect(beaconElement(undefined, undefined, HOME)).toBeUndefined();
});

test("the beacon names the endpoint and this page's identity", () => {
  const html = element(undefined, { locale: "de", path: "/preise" });

  expect(html).toContain(ENDPOINT);
  expect(html).toContain('"de"');
  expect(html).toContain('"/preise"');
});

test("the beacon reports through sendBeacon and never on unload", () => {
  const html = element();

  expect(html).toContain("sendBeacon");
  expect(html).toContain("keepalive:true");
  expect(html).not.toContain("unload");
  expect(html).toContain("visibilitychange");
  expect(html).toContain("pagehide");
});

test("the beacon waits for the analytics category and nothing else", () => {
  const html = element();

  expect(BEACON_CATEGORY).toBe("analytics");
  expect(html).toContain('"fwConsent"');
  expect(html).toContain('granted("analytics")');
});

test("a market's consent default is baked in, one page at a time", () => {
  const scripts: ScriptsSetting = {
    scripts: [{ name: "tags", src: "https://example.com/t.js" }],
    consentDefaults: { "de:/**": { analytics: "granted" } },
  };

  expect(element(scripts, { locale: "de", path: "/" })).toContain(',"/",1]');
  expect(element(scripts, { locale: "en", path: "/" })).toContain(',"/",0]');
  expect(element(undefined)).toContain(',"/",0]');
});

test("an endpoint cannot end the script block it is written into", () => {
  const html = beaconElement(
    { endpoint: "/rum?a=</script><script>alert(1)</script>\u2028" },
    undefined,
    HOME,
  );

  expect(html).not.toContain("</script><script>");
  expect(html).toContain("\\u003c/script");
  expect(html).not.toContain("\u2028");
});

const BEACON_BEFORE_499 =
  "<script>(function(){var q=[\"https://collector.example/rum\",\"en\",\"/\",0],m={};var o=function(t,f,d){try{new PerformanceObserver(f).observe({type:t,buffered:true,durationThreshold:d})}catch(e){}};var start=function(){o(\"largest-contentful-paint\",function(l){var e=l.getEntries(),v=e[e.length-1];if(v)m.lcp=Math.round(v.startTime)});var c=0,f=0,p=0;o(\"layout-shift\",function(l){var e=l.getEntries();for(var i=0;i<e.length;i++){var s=e[i];if(s.hadRecentInput)continue;if(c&&s.startTime-p<1000&&s.startTime-f<5000)c+=s.value;else{c=s.value;f=s.startTime}p=s.startTime;if(c>(m.cls||0))m.cls=Math.round(c*1e4)/1e4}});o(\"event\",function(l){var e=l.getEntries();for(var i=0;i<e.length;i++){var s=e[i];if(s.interactionId&&s.duration>(m.inp||0))m.inp=Math.round(s.duration)}},40);};if(\"requestIdleCallback\" in window)requestIdleCallback(start);else setTimeout(start,0);var sent,send=function(){if(sent)return;var g=window[\"fwConsent\"];if(!(g?!!g.granted(\"analytics\"):q[3]===1))return;m.locale=q[1];m.path=q[2];var b=JSON.stringify(m);if(!(navigator.sendBeacon&&navigator.sendBeacon(q[0],b)))fetch(q[0],{method:\"POST\",body:b,keepalive:true});sent=1};addEventListener(\"visibilitychange\",function(){if(document.visibilityState===\"hidden\")send()});addEventListener(\"pagehide\",send);})();</script>";

test("the beacon is the element it was before its ends became constants", () => {
  expect(
    beaconElement(
      { endpoint: "https://collector.example/rum" },
      undefined,
      HOME,
    ),
  ).toBe(BEACON_BEFORE_499);
});

test("the beacon's text is recognized on every page and market it is written for", () => {
  const scripts: ScriptsSetting = {
    scripts: [{ name: "tags", src: "https://example.com/tags.js" }],
    consentDefaults: { "en:/**": { analytics: "granted" } },
  };
  for (const html of [
    element(),
    element(scripts),
    element(undefined, { locale: "de", path: "/preise" }),
    beaconElement({ endpoint: "/rum?a=</script>" }, undefined, HOME) ?? "",
  ]) {
    const text = html.slice("<script>".length, -"</script>".length);
    expect(isBeaconText(text)).toBe(true);
    expect(text).not.toContain("<script>");
  }
});

test("no other bare inline script is taken for the beacon", () => {
  const text = element().slice("<script>".length, -"</script>".length);
  for (const other of [
    "window.snippet = 1",
    'document.documentElement.dataset.theme = "dark"',
    `${text.slice(0, 40)}})();`,
    `(function(){${text.slice(40)}`,
  ]) {
    expect(isBeaconText(other)).toBe(false);
  }
});

interface Run {
  emit(type: string, entries: readonly Record<string, unknown>[]): void;
  idle(): void;
  fire(event: string): void;
  beacons: [string, string][];
  fetches: [string, Record<string, unknown>][];
  observed: string[];
  thresholds: Map<string, number | undefined>;
}

function run(
  html: string,
  options: {
    consent?: { granted(category: string): boolean };
    hidden?: boolean;
    queued?: boolean;
    idleSupport?: boolean;
  } = {},
): Run {
  const { consent, hidden = true, queued = true, idleSupport = true } = options;
  const observers = new Map<string, (list: { getEntries(): unknown[] }) => void>();
  const thresholds = new Map<string, number | undefined>();
  const listeners = new Map<string, (() => void)[]>();
  const beacons: [string, string][] = [];
  const fetches: [string, Record<string, unknown>][] = [];
  let idleCallback: (() => void) | undefined;

  class FakeObserver {
    constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {}
    observe({
      type,
      buffered,
      durationThreshold,
    }: {
      type: string;
      buffered: boolean;
      durationThreshold?: number;
    }): void {
      expect(buffered).toBe(true);
      observers.set(type, this.callback);
      thresholds.set(type, durationThreshold);
    }
  }

  const window: Record<string, unknown> = {};
  if (consent !== undefined) window["fwConsent"] = consent;
  if (idleSupport) window["requestIdleCallback"] = undefined;

  const body = html.replace(/^<script>/, "").replace(/<\/script>$/, "");
  const source = new Function(
    "window",
    "document",
    "navigator",
    "PerformanceObserver",
    "requestIdleCallback",
    "setTimeout",
    "fetch",
    "addEventListener",
    body,
  );
  source(
    window,
    { visibilityState: hidden ? "hidden" : "visible" },
    {
      sendBeacon: (url: string, payload: string): boolean => {
        beacons.push([url, payload]);
        return queued;
      },
    },
    FakeObserver,
    (callback: () => void) => {
      idleCallback = callback;
    },
    (callback: () => void) => {
      idleCallback = callback;
    },
    (url: string, init: Record<string, unknown>) => {
      fetches.push([url, init]);
    },
    (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
  );

  return {
    emit(type, entries) {
      const observer = observers.get(type);
      if (observer === undefined) throw new Error(`not observing ${type}`);
      observer({ getEntries: () => [...entries] });
    },
    idle() {
      idleCallback?.();
    },
    fire(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    beacons,
    fetches,
    thresholds,
    get observed() {
      return [...observers.keys()].sort();
    },
  };
}

function reported(run: Run): Record<string, unknown> {
  expect(run.beacons).toHaveLength(1);
  const [url, body] = run.beacons[0] ?? ["", "{}"];
  expect(url).toBe(ENDPOINT);
  return JSON.parse(body) as Record<string, unknown>;
}

const GRANTED = { granted: (): boolean => true };
const DENIED = { granted: (): boolean => false };

test("nothing is observed until the browser is idle", () => {
  const one = run(element(), { consent: GRANTED });

  expect(one.observed).toEqual([]);
  one.idle();
  expect(one.observed).toEqual(["event", "largest-contentful-paint", "layout-shift"]);
});

test("a browser without requestIdleCallback still starts the observers", () => {
  const one = run(element(), { consent: GRANTED, idleSupport: false });

  one.idle();
  expect(one.observed).toContain("largest-contentful-paint");
});

test("the payload carries the three metrics and the page's identity", () => {
  const one = run(element(undefined, { locale: "de", path: "/preise" }), {
    consent: GRANTED,
  });
  one.idle();
  one.emit("largest-contentful-paint", [{ startTime: 1200.4 }, { startTime: 2500.6 }]);
  one.emit("layout-shift", [{ startTime: 0, value: 0.1 }, { startTime: 500, value: 0.05 }]);
  one.emit("event", [{ interactionId: 7, duration: 128 }]);
  one.fire("visibilitychange");

  expect(reported(one)).toEqual({
    lcp: 2501,
    cls: 0.15,
    inp: 128,
    locale: "de",
    path: "/preise",
  });
});

test("CLS is the worst session window, not the sum of every shift", () => {
  const one = run(element(), { consent: GRANTED });
  one.idle();
  // Two shifts more than a second apart are two session windows, so CLS is the larger
  // window, 0.1, not the sum 0.15.
  one.emit("layout-shift", [
    { startTime: 0, value: 0.1 },
    { startTime: 4000, value: 0.05 },
  ]);
  one.fire("pagehide");

  expect(reported(one)["cls"]).toBe(0.1);
});

test("a shift the visitor caused is not the page shifting", () => {
  const one = run(element(), { consent: GRANTED });
  one.idle();
  one.emit("layout-shift", [{ startTime: 0, value: 0.4, hadRecentInput: true }]);
  one.fire("pagehide");

  expect(reported(one)["cls"]).toBeUndefined();
});

test("an event that was never an interaction is not INP", () => {
  const one = run(element(), { consent: GRANTED });
  one.idle();
  one.emit("event", [
    { duration: 900 },
    { interactionId: 3, duration: 48.4 },
  ]);
  one.fire("pagehide");

  expect(reported(one)["inp"]).toBe(48);
});

test("a denied visitor's page measures itself and reports nothing", () => {
  const one = run(element(), { consent: DENIED });
  one.idle();
  one.emit("largest-contentful-paint", [{ startTime: 900 }]);
  one.fire("visibilitychange");

  expect(one.beacons).toEqual([]);
  expect(one.fetches).toEqual([]);
});

test("a market default decides only where no consent source has spoken", () => {
  const quiet = run(element());
  quiet.idle();
  quiet.fire("pagehide");
  expect(quiet.beacons).toEqual([]);

  const granted = run(element(), { consent: GRANTED });
  granted.idle();
  granted.fire("pagehide");
  expect(granted.beacons).toHaveLength(1);

  const optOut: ScriptsSetting = {
    scripts: [{ name: "tags", src: "https://example.com/t.js" }],
    consentDefaults: { "en:/**": { analytics: "granted" } },
  };
  const revoked = run(element(optOut), { consent: DENIED });
  revoked.idle();
  revoked.fire("pagehide");
  expect(revoked.beacons).toEqual([]);
});

test("consent granted after a hiding is still reported at the next one", () => {
  let granted = false;
  const one = run(element(), { consent: { granted: () => granted } });
  one.idle();
  one.emit("largest-contentful-paint", [{ startTime: 1500 }]);

  one.fire("visibilitychange");
  expect(one.beacons).toEqual([]);

  granted = true;
  one.fire("pagehide");

  expect(reported(one)).toMatchObject({ lcp: 1500, path: "/" });
});

test("consent withdrawn after a hiding reports nothing at the next one", () => {
  let granted = false;
  const one = run(element(), { consent: { granted: () => granted } });
  one.idle();

  one.fire("visibilitychange");
  granted = true;
  granted = false;
  one.fire("pagehide");

  expect(one.beacons).toEqual([]);
  expect(one.fetches).toEqual([]);
});

test("a granted visit reports once even across several hidings", () => {
  let granted = true;
  const one = run(element(), { consent: { granted: () => granted } });
  one.idle();
  one.fire("visibilitychange");
  one.fire("pagehide");
  granted = false;
  one.fire("visibilitychange");

  expect(one.beacons).toHaveLength(1);
});

test("the event observer asks for interactions the browser would not buffer", () => {
  // 40 ms is `web-vitals`' threshold. Unset, the browser reports nothing under 104 ms,
  // so a 90 ms worst interaction would report no INP at all.
  const one = run(element(), { consent: GRANTED });
  one.idle();

  expect(one.thresholds.get("event")).toBe(40);
  expect(one.thresholds.get("largest-contentful-paint")).toBeUndefined();
  expect(one.thresholds.get("layout-shift")).toBeUndefined();
});

test("a page that is still visible reports nothing on visibilitychange", () => {
  const one = run(element(), { consent: GRANTED, hidden: false });
  one.idle();
  one.fire("visibilitychange");

  expect(one.beacons).toEqual([]);
  one.fire("pagehide");
  expect(one.beacons).toHaveLength(1);
});

test("one visit reports once, whichever of the two events fires first", () => {
  const one = run(element(), { consent: GRANTED });
  one.idle();
  one.fire("visibilitychange");
  one.fire("pagehide");
  one.fire("visibilitychange");

  expect(one.beacons).toHaveLength(1);
});

test("a full send queue falls back to a keep-alive fetch", () => {
  const one = run(element(), { consent: GRANTED, queued: false });
  one.idle();
  one.emit("largest-contentful-paint", [{ startTime: 700 }]);
  one.fire("pagehide");

  expect(one.beacons).toHaveLength(1);
  expect(one.fetches).toHaveLength(1);
  const [url, init] = one.fetches[0] ?? ["", {}];
  expect(url).toBe(ENDPOINT);
  expect(init["method"]).toBe("POST");
  expect(init["keepalive"]).toBe(true);
  expect(JSON.parse(String(init["body"]))).toMatchObject({ lcp: 700, path: "/" });
});

test("the beacon weighs what this feature says it weighs", () => {
  expect(element().length).toBeLessThan(1350);
});

const WHERE = 'Config "/site/pagedeck.config.ts"';

test("a beacon that is not an object says what one looks like", () => {
  expect(beaconFaultReport("https://example.com/rum", WHERE)).toBe(
    `${WHERE}: "build.beacon" must be an object saying where real-user metrics are sent — beacon: { endpoint: "https://example.com/rum" }`,
  );
});

test("a beacon with nowhere to report to is refused, with the fix", () => {
  const report = beaconFaultReport({}, WHERE) ?? "";

  expect(report).toContain("endpoint is undefined");
  expect(report).toContain("nowhere to report to");
  expect(report).toContain('such as "/rum"');
});

test("every fault in one beacon is reported at once", () => {
  const report = beaconFaultReport({ endPoint: "/rum", endpoint: "" }, WHERE) ?? "";

  expect(report).toContain('"endPoint" is not a field this build reads');
  expect(report).toContain("endpoint is \"\"");
  expect(report.split("\n")).toHaveLength(3);
});

test("an endpoint no browser would post to names its scheme", () => {
  const report = beaconFaultReport({ endpoint: "ftp://example.com/rum" }, WHERE) ?? "";

  expect(report).toContain('has the scheme "ftp:"');
  expect(report).toContain("http: or https:");
});

test("an endpoint that is neither a URL nor a path says so", () => {
  const report = beaconFaultReport({ endpoint: "example.com/rum" }, WHERE) ?? "";

  expect(report).toContain("neither an absolute URL nor a path on this site");
});

test("a protocol-relative endpoint is named rather than taken for a path", () => {
  const report = beaconFaultReport({ endpoint: "//example.com/rum" }, WHERE) ?? "";

  expect(report).toContain("protocol-relative");
});

test("a credential in the endpoint is refused, and not echoed", () => {
  const report =
    beaconFaultReport(
      { endpoint: "https://collector:s3cret@example.com/rum?key=t0ken" },
      WHERE,
    ) ?? "";

  expect(report).toContain("carries userinfo");
  expect(report).toContain("written into every page");
  expect(report).not.toContain("s3cret");
  expect(report).toContain("…@example.com/rum");
  expect(report).not.toContain("t0ken");
});

test.each([
  ["a slash in the password", "user:p/w@collector.example/rum", ["p/w", "user:p"]],
  ["a second @ in the password", "https://u:p@ss@h/rum", ["p@ss", "ss@h"]],
  ["a query, a fragment and a space", "https://u:p ?x#y@h/rum", ["p ?x#y", "x#y"]],
  ["no scheme at all", "//u:p/w@h/rum", ["p/w"]],
])("a credential with %s reaches no message", (_name, endpoint, secrets) => {
  const report = beaconFaultReport({ endpoint }, WHERE) ?? "";

  expect(report).not.toBe("");
  for (const secret of secrets) expect(report).not.toContain(secret);
  expect(report).toContain("…@");
});

test("a credential is cut on the line that refuses the scheme too", () => {
  const report =
    beaconFaultReport({ endpoint: "collector:s3cret@example.com/rum" }, WHERE) ??
    "";

  expect(report).toContain('has the scheme "collector:"');
  expect(report).not.toContain("s3cret");
});

test("every catalogued beacon message is one this code produces", () => {
  const doc = readFileSync("docs/error-messages.md", "utf8");
  const catalogued = [
    beaconFaultReport("https://collector.example/rum", WHERE),
    beaconFaultReport(
      { endPoint: "/rum", endpoint: "wss://collector.example/rum?key=t0ken" },
      WHERE,
    ),
    beaconFaultReport(
      { endpoint: "https://user:pw@collector.example/rum" },
      WHERE,
    ),
    beaconFaultReport({ endpoint: "user:p/w@collector.example/rum" }, WHERE),
  ];

  for (const message of catalogued) {
    expect(message).toBeDefined();
    expect(doc, message).toContain(message ?? "");
  }
});

test("a usable beacon is not refused", () => {
  expect(beaconFaultReport({ endpoint: ENDPOINT }, WHERE)).toBeUndefined();
  expect(beaconFaultReport({ endpoint: "/rum" }, WHERE)).toBeUndefined();
  expect(beaconFaultReport({ endpoint: "http://localhost:8080/rum" }, WHERE)).toBeUndefined();
});
