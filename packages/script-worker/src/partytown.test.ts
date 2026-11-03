import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { expect, test } from "vitest";
import {
  ConfigError,
  defineScripts,
  inlineScriptFault,
  loadedScriptStrategy,
  scriptRuntimeBase,
} from "@pagedeck/core";
import type { ScriptDeclaration } from "@pagedeck/core";
import { partytownSnippet } from "@qwik.dev/partytown/integration";
import { libDirPath } from "@qwik.dev/partytown/utils";
import { definePartytown } from "./partytown.js";

const TAGS: ScriptDeclaration = { name: "tags", src: "https://example.com/tags.js" };

function inlineText(element: string | undefined): string {
  expect(element?.startsWith("<script>")).toBe(true);
  expect(element?.endsWith("</script>")).toBe(true);
  return (element ?? "").slice("<script>".length, -"</script>".length);
}

/** Runs the snippet against a stub window, and reads back the config it set. */
function configOf(snippet: string): Record<string, unknown> {
  const window: Record<string, unknown> = {
    crossOriginIsolated: false,
    addEventListener: () => undefined,
  };
  window["top"] = window;
  runInNewContext(snippet, {
    window,
    top: window,
    navigator: { serviceWorker: {} },
    document: { readyState: "loading" },
  });
  return window["partytown"] as Record<string, unknown>;
}

/** What Partytown's worker does with a function-valued config string. */
type ResolveUrl = (url: URL, location: URL, type: string) => URL | undefined;
function workerResolveUrl(snippet: string): ResolveUrl {
  const source = configOf(snippet)["resolveUrl"];
  expect(typeof source).toBe("string");
  return new Function(`return ${String(source)}`)() as ResolveUrl;
}

test("the runtime declares Partytown's service-worker files and no Atomics or debug file", () => {
  const runtime = definePartytown();
  const lib = libDirPath();

  expect(runtime.files.map(({ name }) => name)).toEqual([
    "partytown-sw.js",
    "partytown-media.js",
    "partytown-sandbox-sw.html",
    "partytown-config.txt",
  ]);
  for (const { name, contents } of runtime.files.slice(0, 3)) {
    expect(Buffer.from(contents).equals(readFileSync(join(lib, name)))).toBe(true);
  }
});

test("every option the snippet carries moves the runtime's directory", () => {
  const base = (options: Parameters<typeof definePartytown>[0]): string =>
    scriptRuntimeBase(definePartytown(options).files);
  const plain = base({});

  for (const options of [
    { resolveUrl: { "https://collector.example": "/vendor/collector/" } },
    { resolveUrl: { "https://collector.example": "/vendor/other/" } },
    { forward: ["dataLayer.push"] },
    { loadScriptsOnMainThread: [/ab\.js$/] },
    { loadScriptsOnMainThread: [/cd\.js$/] },
    { fallbackTimeout: 0 },
  ]) {
    expect(`${JSON.stringify(options)}: ${String(base(options) === plain)}`).toBe(
      `${JSON.stringify(options)}: false`,
    );
  }
  expect(base({ loadScriptsOnMainThread: [/ab\.js$/] })).not.toBe(
    base({ loadScriptsOnMainThread: [/cd\.js$/] }),
  );
  expect(base({})).toBe(plain);
});

test("a page's worker loadout is Partytown's snippet pointed at the runtime's own directory, then one text/partytown element per script", () => {
  const runtime = definePartytown({ forward: ["dataLayer.push"] });
  const elements = runtime({
    scripts: [TAGS, { name: "pixel", src: "/pixel.js?a=1&b=\"2\"" }],
  });

  expect(elements).toHaveLength(3);
  expect(inlineText(elements[0])).toBe(
    partytownSnippet({
      lib: scriptRuntimeBase(runtime.files),
      forward: ["dataLayer.push"],
    }),
  );
  expect(configOf(inlineText(elements[0]))["lib"]).toBe(scriptRuntimeBase(runtime.files));
  expect(elements.slice(1)).toEqual([
    '<script type="text/partytown" src="https://example.com/tags.js"></script>',
    '<script type="text/partytown" src="/pixel.js?a=1&amp;b=&quot;2&quot;"></script>',
  ]);
});

test("a script's data attributes are carried onto its element", () => {
  const elements = definePartytown()({
    scripts: [{ ...TAGS, attributes: { "data-domain": 'a"b&c' } }],
  });

  expect(elements[1]).toBe(
    '<script type="text/partytown" src="https://example.com/tags.js" data-domain="a&quot;b&amp;c"></script>',
  );
});

test("the snippet's CSP hash is known before any build, and matches the bytes a page carries", () => {
  const runtime = definePartytown({ forward: ["dataLayer.push"] });
  const snippet = inlineText(runtime({ scripts: [TAGS] })[0]);

  expect(runtime.inlineScriptHash).toBe(
    `'sha256-${createHash("sha256").update(snippet, "utf8").digest("base64")}'`,
  );
});

test("every worker script that declares integrity is refused when the config loads, because the worker would fetch it unchecked", () => {
  const runtime = definePartytown();
  const call = (): unknown =>
    defineScripts({
      scripts: [
        { ...TAGS, integrity: "sha384-abc" },
        { name: "pixel", src: "/pixel.js", integrity: "sha256-def" },
        { name: "plain", src: "/plain.js" },
      ],
      runtime,
    });

  expect(runtime.checksIntegrity).toBe(false);
  expect(call).toThrow(ConfigError);
  expect(call).toThrow(
    'Script settings: "runtime" loads a worker script without checking its integrity, and 2 scripts that can reach the worker strategy declare integrity, so each would load unchecked — declare strategy: "idle" for each, and override none of them to "worker", which keeps the check, or drop integrity:\n  "tags" — declares no strategy, so it takes the worker default\n  "pixel" — declares no strategy, so it takes the worker default',
  );
});

test("a categorized worker script still falls back to idle with Partytown configured (#47)", () => {
  const gated: ScriptDeclaration = { ...TAGS, category: "analytics" };
  const settings = defineScripts({ scripts: [gated], runtime: definePartytown() });

  expect(loadedScriptStrategy(settings, gated, { locale: "en", path: "/" })).toBe("idle");
});

test("resolveUrl sends a declared vendor origin to the path prefix this site proxies it under", () => {
  const resolve = workerResolveUrl(
    inlineText(
      definePartytown({
        resolveUrl: { "https://collector.example": "/vendor/collector/" },
      })({ scripts: [TAGS] })[0],
    ),
  );
  const page = new URL("https://site.example/pricing");

  for (const type of ["fetch", "xhr", "script", "image", "sendBeacon"]) {
    expect(resolve(new URL("https://collector.example/g/collect?v=2"), page, type)?.href).toBe(
      "https://site.example/vendor/collector/g/collect?v=2",
    );
  }
  expect(resolve(new URL("https://collector.example//evil.example/x"), page, "fetch")?.href).toBe(
    "https://site.example/vendor/collector//evil.example/x",
  );
});

test("resolveUrl never proxies a document: an iframe keeps the vendor's own origin", () => {
  const resolve = workerResolveUrl(
    inlineText(
      definePartytown({
        resolveUrl: { "https://collector.example": "/vendor/collector/" },
      })({ scripts: [TAGS] })[0],
    ),
  );

  expect(
    resolve(new URL("https://collector.example/frame"), new URL("https://site.example/"), "iframe"),
  ).toBeUndefined();
});

test("resolveUrl leaves every origin it was not given to Partytown's default", () => {
  const resolve = workerResolveUrl(
    inlineText(
      definePartytown({
        resolveUrl: { "https://collector.example": "/vendor/collector/" },
      })({ scripts: [TAGS] })[0],
    ),
  );
  const page = new URL("https://site.example/");

  for (const href of [
    "https://evil.example/?u=https://collector.example/",
    "https://collector.example.evil.example/g",
    "http://collector.example/g",
    "https://collector.example:8443/g",
    "https://site.example/vendor/collector/x",
  ]) {
    expect(`${href}: ${String(resolve(new URL(href), page, "fetch"))}`).toBe(`${href}: undefined`);
  }
});

test("a site that declares no resolveUrl puts none in the snippet", () => {
  const snippet = inlineText(definePartytown()({ scripts: [TAGS] })[0]);

  expect(Object.hasOwn(configOf(snippet), "resolveUrl")).toBe(false);
});

test("every resolveUrl route that is not an https origin to a path prefix on this site is refused, together", () => {
  const call = (): unknown =>
    definePartytown({
      resolveUrl: {
        "https://ok.example": "/vendor/ok/",
        "https://a.example/path": "/vendor/a/",
        "http://b.example": "/vendor/b/",
        "https://user@c.example": "/vendor/c/",
        "https://d.example": "//evil.example/",
        "https://e.example": "/vendor/e",
        "https://f.example": "/vendor/../f/",
        "https://g.example": "https://evil.example/",
        "http://h.example": "vendor/h",
        "https://i.example.": "/vendor/i/",
        "https://127.0.0.1": "/vendor/j/",
        "https://[::1]": "/vendor/k/",
        "https://localhost": "/vendor/l/",
        "https://m.localhost": "/vendor/m/",
      },
    });

  expect(call).toThrow(ConfigError);
  expect(call).toThrow(
    [
      'Partytown runtime "build.scripts.runtime": "resolveUrl" declares 13 routes this runtime cannot take — a route sends a request for one vendor origin to one path prefix on this site, which an upstream forwards to that origin, so a page cannot steer it anywhere else — write each key as the https origin of a vendor\'s DNS name, with no path, and each value as a path prefix that starts and ends with "/", such as resolveUrl: { "https://collector.example": "/vendor/collector/" }:',
      '  "https://a.example/path" — not an https origin with nothing after the host',
      '  "http://b.example" — not an https origin with nothing after the host',
      '  "https://user@c.example" — not an https origin with nothing after the host',
      '  "https://d.example" → "//evil.example/" — not a path prefix on this site',
      '  "https://e.example" → "/vendor/e" — not a path prefix on this site',
      '  "https://f.example" → "/vendor/../f/" — not a path prefix on this site',
      '  "https://g.example" → "https://evil.example/" — not a path prefix on this site',
      '  "http://h.example" → "vendor/h" — not an https origin with nothing after the host, and not a path prefix on this site',
      '  "https://i.example." — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://127.0.0.1" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://[::1]" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://localhost" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://m.localhost" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
    ].join("\n"),
  );
});

test("a key the URL parser respells is refused for what it names, or told the origin to write", () => {
  const call = (): unknown =>
    definePartytown({
      resolveUrl: {
        "https://LOCALHOST": "/vendor/a/",
        "https://127.1": "/vendor/b/",
        "https://0x7f.1": "/vendor/c/",
        "https://2130706433": "/vendor/d/",
        "https://Collector.example": "/vendor/e/",
        "https://intranet": "/vendor/f/",
      },
    });

  expect(call).toThrow(ConfigError);
  expect(call).toThrow(
    [
      '  "https://LOCALHOST" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://127.1" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://0x7f.1" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://2130706433" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
      '  "https://Collector.example" — not written as the origin it names — write it as "https://collector.example"',
      '  "https://intranet" — names a host ending in ".", an IP address, localhost or a single label, which is not a vendor\'s DNS name',
    ].join("\n"),
  );
});

test("an option that would end the snippet's own script element is refused by name before any page carries it", () => {
  const call = (): unknown =>
    definePartytown({
      forward: ["x</script><script>alert(1)//"],
      globalFns: ["y<!--"],
    });

  expect(call).toThrow(ConfigError);
  expect(call).toThrow(
    [
      'Partytown runtime "build.scripts.runtime": 2 options hold a sequence that cannot sit inside the snippet\'s <script> element, which carries each option as written — take the sequence out of each:',
      '  "forward" — holds "</script" — an HTML parser ends the script element there, so the rest of the snippet is parsed as markup — write the sequence so it is not one, as "<\\/script"',
      '  "globalFns" — holds "<!--" — an HTML parser reads it as the start of an escaped script, after which a "<script" in the same snippet stops the closing tag from closing anything — write it as "<\\!--", or use a // comment',
    ].join("\n"),
  );
});

test("the snippet Partytown writes passes core's inline script check with every option set", () => {
  const snippet = inlineText(
    definePartytown({
      forward: ["dataLayer.push", ["fbq", { preserveBehavior: true }]],
      resolveUrl: { "https://collector.example": "/vendor/collector/" },
      globalFns: ["gtag"],
      mainWindowAccessors: ["config"],
      loadScriptsOnMainThread: ["https://example.com/main.js", /main\.js$/],
      fallbackTimeout: 5000,
      strictProxyHas: true,
    })({ scripts: [TAGS] })[0],
  );

  expect(inlineScriptFault(snippet)).toBeUndefined();
});
