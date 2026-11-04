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

test("a page's worker loadout is Partytown's snippet in the head, pointed at the runtime's own directory, and one text/partytown element per script in the body", () => {
  const runtime = definePartytown({ forward: ["dataLayer.push"] });
  const { head, body } = runtime({
    scripts: [TAGS, { name: "pixel", src: "/pixel.js?a=1&b=\"2\"" }],
  });

  expect(head).toHaveLength(1);
  expect(inlineText(head[0])).toBe(
    partytownSnippet({
      lib: scriptRuntimeBase(runtime.files),
      forward: ["dataLayer.push"],
    }),
  );
  expect(configOf(inlineText(head[0]))["lib"]).toBe(scriptRuntimeBase(runtime.files));
  expect(body).toEqual([
    '<script type="text/partytown" src="https://example.com/tags.js"></script>',
    '<script type="text/partytown" src="/pixel.js?a=1&amp;b=&quot;2&quot;"></script>',
  ]);
});

test("a script's data attributes are carried onto its element", () => {
  const { body } = definePartytown()({
    scripts: [{ ...TAGS, attributes: { "data-domain": 'a"b&c' } }],
  });

  expect(body[0]).toBe(
    '<script type="text/partytown" src="https://example.com/tags.js" data-domain="a&quot;b&amp;c"></script>',
  );
});

test("the snippet's CSP hash is known before any build, and matches the bytes a page carries", () => {
  const runtime = definePartytown({ forward: ["dataLayer.push"] });
  const snippet = inlineText(runtime({ scripts: [TAGS] }).head[0]);

  expect(runtime.inlineScriptHash).toBe(
    `'sha256-${createHash("sha256").update(snippet, "utf8").digest("base64")}'`,
  );
});

test("every worker script that declares integrity is refused when the config loads, because the worker would fetch it unchecked", () => {
  const runtime = definePartytown();
  const call = (): unknown =>
    defineScripts({
      scripts: [
        { ...TAGS, integrity: "sha384-5FfBCzQ1Vtj7E7RYy8sbesHkODYMt8s0Mbp51zito92HrGRcj7RVGOKZvLnQFPSM" },
        { name: "pixel", src: "/pixel.js", integrity: "sha256-tdElM+RL4sC4HGbyE42jlYTmEorBu+lN6IrC+dWRD2A=" },
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

test("Partytown picks up a late script, so a categorized worker script stays on worker behind the gate (#281)", () => {
  const runtime = definePartytown();
  const gated: ScriptDeclaration = { ...TAGS, category: "analytics" };
  const settings = defineScripts({ scripts: [gated], runtime });

  expect(runtime.latePickup).toEqual({ type: "text/partytown", event: "ptupdate" });
  expect(loadedScriptStrategy(settings, gated, { locale: "en", path: "/" })).toBe("worker");
});

test("a categorized worker script that declares integrity is refused under Partytown, as an uncategorized one is", () => {
  const call = (): unknown =>
    defineScripts({
      scripts: [{ ...TAGS, category: "analytics", integrity: "sha384-5FfBCzQ1Vtj7E7RYy8sbesHkODYMt8s0Mbp51zito92HrGRcj7RVGOKZvLnQFPSM" }],
      runtime: definePartytown(),
    });

  expect(call).toThrow(
    'Script settings: "runtime" loads a worker script without checking its integrity, and 1 script that can reach the worker strategy declare integrity, so each would load unchecked — declare strategy: "idle" for each, and override none of them to "worker", which keeps the check, or drop integrity:\n  "tags" — declares no strategy, so it takes the worker default',
  );
});

test("resolveUrl sends a declared vendor origin to the path prefix this site proxies it under", () => {
  const resolve = workerResolveUrl(
    inlineText(
      definePartytown({
        resolveUrl: { "https://collector.example": "/vendor/collector/" },
      })({ scripts: [TAGS] }).head[0],
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
      })({ scripts: [TAGS] }).head[0],
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
      })({ scripts: [TAGS] }).head[0],
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
  const snippet = inlineText(definePartytown()({ scripts: [TAGS] }).head[0]);

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
    })({ scripts: [TAGS] }).head[0],
  );

  expect(inlineScriptFault(snippet)).toBeUndefined();
});

test("an option no type check reached is refused when it would end the snippet's script element (#290)", () => {
  for (const options of [
    { fallbackTimeout: "1</script><b>x</b>" },
    { strictProxyHas: "true</script><b>x</b>" },
    { debug: "</script><b>x</b>" },
  ]) {
    const call = (): unknown => definePartytown(options as never);
    expect(call).toThrow(ConfigError);
    expect(call).toThrow(Object.keys(options)[0]);
  }
});

test("every option that is unknown or of the wrong type is refused by name, together, with the accepted options listed (#290)", () => {
  const call = (): unknown =>
    definePartytown({
      forwrd: ["dataLayer.push"],
      debug: true,
      fallbackTimeout: Number.POSITIVE_INFINITY,
      strictProxyHas: "true",
    } as never);

  expect(call).toThrow(ConfigError);
  expect(call).toThrow(
    [
      'Partytown runtime "build.scripts.runtime": 4 options this runtime cannot take — write fallbackTimeout as a finite number of milliseconds, 0 or more, strictProxyHas as true or false, and no option but forward, resolveUrl, globalFns, mainWindowAccessors, loadScriptsOnMainThread, fallbackTimeout and strictProxyHas:',
      '  "forwrd" — not an option this runtime takes',
      '  "debug" — not an option this runtime takes',
      '  "fallbackTimeout" — Infinity is not a finite number 0 or more',
      '  "strictProxyHas" — "true" is not true or false',
    ].join("\n"),
  );
});

test("a negative fallbackTimeout is refused by name (#290)", () => {
  expect(() => definePartytown({ fallbackTimeout: -1 })).toThrow(
    '  "fallbackTimeout" — -1 is not a finite number 0 or more',
  );
});

test("a function in a written option is checked as the text Partytown writes for it, not as JSON drops it (#290)", () => {
  const call = (): unknown =>
    definePartytown({
      globalFns: [new Function('return "</script>"')],
    } as never);

  expect(call).toThrow(ConfigError);
  expect(call).toThrow('  "globalFns" — holds "</script"');
});

test("every fault in the options and the routes is reported in one error (#290)", () => {
  const call = (): unknown =>
    definePartytown({
      resolveUrl: { "http://b.example": "/vendor/b/" },
      debug: true,
      forward: ["x</script>"],
    } as never);

  expect(call).toThrow(/"resolveUrl" declares 1 route[\s\S]*"debug" — not an option[\s\S]*"forward" — holds "<\/script"/);
});

test("a valid config writes the snippet it wrote before #290, so a pinned CSP hash still matches", () => {
  expect(
    definePartytown({
      forward: ["dataLayer.push", ["fbq", { preserveBehavior: true }]],
      resolveUrl: { "https://collector.example": "/vendor/collector/" },
      globalFns: ["gtag"],
      mainWindowAccessors: ["config"],
      loadScriptsOnMainThread: ["https://example.com/main.js", /main\.js$/],
      fallbackTimeout: 5000,
      strictProxyHas: true,
    }).inlineScriptHash,
  ).toBe("'sha256-g69oB++1aqVkDDiiPcg1B1VAnYFELn68bpEYOeKOqwk='");
  expect(definePartytown().inlineScriptHash).toBe(
    "'sha256-+btblDztaAZ3NXe34xvcHxTWd9rwzKSCcVsvacjny4w='",
  );
});

const BREAKOUT = "</script><img src=x onerror=alert(1)>";

/** Safe on the first read, the breakout on every read after it. */
function safeOnce<T>(safe: T): () => T | string {
  let reads = 0;
  return () => (reads++ === 0 ? safe : BREAKOUT);
}

test("an option that reads safe when checked and breaks out when built is refused by the text the build emits (#290)", () => {
  for (const options of [
    () => Object.defineProperty({}, "fallbackTimeout", { enumerable: true, get: safeOnce(5000) }),
    () => {
      const read = safeOnce(5000);
      return new Proxy({ fallbackTimeout: 5000 }, {
        get: (target, key) => (key === "fallbackTimeout" ? read() : Reflect.get(target, key)),
      });
    },
    () => ({ globalFns: [{ toJSON: safeOnce("gtag") }] }),
  ]) {
    const call = (): unknown => definePartytown(options() as never);
    expect(call).toThrow(ConfigError);
    expect(call).toThrow(
      'Partytown runtime "build.scripts.runtime": the snippet Partytown writes holds "</script" — an HTML parser ends the script element there, so the rest of the snippet is parsed as markup — write the sequence so it is not one, as "<\\/script"; no option held it when checked, so pass each option as a plain value that reads the same every time',
    );
  }
});

test("a fallbackTimeout that cannot be turned into a string is still refused with a ConfigError (#290)", () => {
  const call = (): unknown => definePartytown({ fallbackTimeout: Object.create(null) as never });

  expect(call).toThrow(ConfigError);
  expect(call).toThrow('  "fallbackTimeout" — an object is not a finite number 0 or more');
});
