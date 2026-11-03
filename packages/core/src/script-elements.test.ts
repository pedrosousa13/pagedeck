import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { beaconElement } from "./beacon.js";
import { isScriptLoaderText, scriptElements } from "./script-elements.js";
import type { ScriptRuntimeMarkup, ScriptsSetting } from "./scripts.js";
import type { PageIdentity } from "./page-patterns.js";

const HOME = { locale: "en", path: "/" };

function settings(value: ScriptsSetting): ScriptsSetting {
  return value;
}

function emitted(
  declared: ScriptsSetting | undefined,
  page: PageIdentity,
): readonly string[] {
  const { placeholders, elements } = scriptElements(declared, page);
  return [...placeholders.map(({ html }) => html), ...elements];
}

function facadeKey(
  ...facades: readonly (readonly [html: string, src: string])[]
): string {
  return createHash("sha256")
    .update(JSON.stringify(facades))
    .digest("hex")
    .slice(0, 8);
}

test("a page whose scripts all load on idle carries one loader naming each source", () => {
  const elements = emitted(
    settings({
      scripts: [
        { name: "analytics", src: "https://example.com/a.js", strategy: "idle" },
      ],
    }),
    HOME,
  );

  expect(elements).toHaveLength(1);
  expect(elements[0]).toContain("https://example.com/a.js");
  expect(elements[0]).toContain("requestIdleCallback");
});

test("a declared data attribute is emitted beside the source it was declared on", () => {
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "analytics",
          src: "https://example.com/a.js",
          strategy: "idle",
          attributes: { "data-domain": "example.org" },
        },
      ],
    }),
    HOME,
  );

  expect(elements[0]).toContain(
    'load([["https://example.com/a.js","data-domain","example.org"]])',
  );
});

test("a page whose scripts load on interaction listens rather than waiting for idle", () => {
  const elements = emitted(
    settings({
      scripts: [
        { name: "chat", src: "https://example.com/c.js", strategy: "interaction" },
      ],
    }),
    HOME,
  );

  expect(elements).toHaveLength(1);
  expect(elements[0]).toContain("https://example.com/c.js");
  expect(elements[0]).toContain("addEventListener");
  expect(elements[0]).not.toContain("requestIdleCallback");
});

test("a configured runtime is handed the worker loadout and its answer is emitted in order", () => {
  const seen: string[][] = [];
  const elements = emitted(
    settings({
      scripts: [
        { name: "tags", src: "https://example.com/t.js" },
        { name: "pixel", src: "https://example.com/p.js" },
        { name: "chat", src: "https://example.com/c.js", strategy: "idle" },
      ],
      runtime: ({ scripts }) => {
        seen.push(scripts.map((script) => script.name));
        return { body: ["<script>snippet</script>", '<script type="text/x">tags</script>'] };
      },
    }),
    HOME,
  );

  expect(seen).toEqual([["tags", "pixel"]]);
  expect(elements.slice(0, 2)).toEqual([
    "<script>snippet</script>",
    '<script type="text/x">tags</script>',
  ]);
  expect(elements).toHaveLength(3);
  expect(elements[2]).toContain("https://example.com/c.js");
});

test("a runtime's head markup is the layer's head, and its body markup leads the body elements (#283)", () => {
  const layer = scriptElements(
    settings({
      scripts: [
        { name: "tags", src: "https://example.com/t.js" },
        { name: "chat", src: "https://example.com/c.js", strategy: "idle" },
      ],
      runtime: ({ scripts }) => ({
        head: ["<script>snippet</script>"],
        body: scripts.map(({ name }) => `<script type="text/x">${name}</script>`),
      }),
    }),
    HOME,
  );

  expect(layer.head).toEqual(["<script>snippet</script>"]);
  expect(layer.elements[0]).toBe('<script type="text/x">tags</script>');
  expect(layer.elements).toHaveLength(2);
  expect(layer.elements[1]).toContain("https://example.com/c.js");
});

test("a runtime that returns only body markup puts nothing in the head", () => {
  const layer = scriptElements(
    settings({
      scripts: [{ name: "tags", src: "https://example.com/t.js" }],
      runtime: () => ({ body: ["<script>snippet</script>"] }),
    }),
    HOME,
  );

  expect(layer.head).toEqual([]);
  expect(layer.elements).toEqual(["<script>snippet</script>"]);
});

test("a page whose only worker scripts are held still carries the runtime's head markup, and a page with none carries none", () => {
  const declared = settings({
    scripts: [{ name: "pixel", src: "https://example.com/p.js", category: "analytics" }],
    pageTypes: { "/legal/**": { pixel: "off" } },
    runtime: Object.assign(
      ({ scripts }: { scripts: readonly unknown[] }) => ({
        head: ["<script>snippet</script>"],
        body: scripts.map(() => "<script type=\"text/x\"></script>"),
      }),
      { latePickup: { type: "text/x", event: "x-worker:update" } },
    ),
  });

  const held = scriptElements(declared, HOME);
  expect(held.head).toEqual(["<script>snippet</script>"]);
  expect(held.elements).toHaveLength(1);
  expect(held.elements[0]).toContain("https://example.com/p.js");

  expect(scriptElements(declared, { locale: "en", path: "/legal/terms" }).head).toEqual([]);
});

test("a worker script with no runtime configured loads through the idle half of the loader", () => {
  const elements = emitted(
    settings({ scripts: [{ name: "tags", src: "https://example.com/t.js" }] }),
    HOME,
  );

  expect(elements).toHaveLength(1);
  expect(elements[0]).toContain("requestIdleCallback");
  expect(elements[0]).toContain("https://example.com/t.js");
});

test("an override reaches the loader, so a page type can move one script off worker", () => {
  const declared = settings({
    scripts: [
      { name: "tags", src: "https://example.com/t.js" },
      { name: "experiment", src: "https://example.com/e.js" },
    ],
    pageTypes: { "/blog/**": { experiment: "interaction" } },
    runtime: ({ scripts }) => ({ body: scripts.map(({ name }) => `<!--${name}-->`) }),
  });

  expect(emitted(declared, HOME)).toEqual([
    "<!--tags-->",
    "<!--experiment-->",
  ]);

  const post = emitted(declared, { locale: "en", path: "/blog/one" });
  expect(post[0]).toBe("<!--tags-->");
  expect(post[1]).toContain("https://example.com/e.js");
  expect(post[1]).toContain("addEventListener");
});

test("a facade carries its placeholder and a loader that waits on that placeholder", () => {
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "chat",
          src: "https://example.com/c.js",
          strategy: "facade",
          facade: { html: "<button>Chat</button>" },
        },
      ],
    }),
    HOME,
  );

  expect(elements).toHaveLength(2);
  const key = facadeKey(["<button>Chat</button>", "https://example.com/c.js"]);
  expect(elements[0]).toBe(
    `<div data-pagedeck-facade="${key}-0"><button>Chat</button></div>`,
  );
  expect(elements[1]).toContain("data-pagedeck-facade");
  expect(elements[1]).toContain("el.addEventListener");
  expect(elements[1]).toContain("https://example.com/c.js");
  expect(elements[1]).not.toContain("requestIdleCallback");
});

test("a site with no script layer carries no elements at all", () => {
  expect(emitted(undefined, HOME)).toEqual([]);
});

test("a script an override takes off a page contributes no element to it", () => {
  const declared = settings({
    scripts: [
      { name: "analytics", src: "https://example.com/a.js", strategy: "idle" },
    ],
    pageTypes: { "/blog/**": { analytics: "off" } },
  });

  expect(emitted(declared, HOME)).toHaveLength(1);
  expect(emitted(declared, { locale: "en", path: "/blog/one" })).toEqual(
    [],
  );
});

test("a worker script taken off a page never reaches the runtime adapter", () => {
  let calls = 0;
  const elements = emitted(
    settings({
      scripts: [{ name: "tags", src: "https://example.com/t.js" }],
      pages: { "/": { tags: "off" } },
      runtime: () => {
        calls += 1;
        return { body: ["<script>snippet</script>"] };
      },
    }),
    HOME,
  );

  expect(calls).toBe(0);
  expect(elements).toEqual([]);
});

test("taking one facade off a page leaves the rest contiguous and paired with their own scripts", () => {
  const facade = (name: string, html: string) =>
    ({
      name,
      src: `https://example.com/${name}.js`,
      strategy: "facade",
      facade: { html },
    }) as const;
  const elements = emitted(
    settings({
      scripts: [
        facade("chat", "<button>Chat</button>"),
        facade("help", "<button>Help</button>"),
        facade("video", "<button>Video</button>"),
      ],
      pages: { "/": { help: "off" } },
    }),
    HOME,
  );

  const key = facadeKey(
    ["<button>Chat</button>", "https://example.com/chat.js"],
    ["<button>Video</button>", "https://example.com/video.js"],
  );
  expect(elements.slice(0, 2)).toEqual([
    `<div data-pagedeck-facade="${key}-0"><button>Chat</button></div>`,
    `<div data-pagedeck-facade="${key}-1"><button>Video</button></div>`,
  ]);
  expect(elements[2]).toContain(
    'var facades=["https://example.com/chat.js","https://example.com/video.js"]',
  );
  expect(elements[2]).not.toContain("help");
});

test("declaring a mount point leaves every key on the page the key it was", () => {
  const loadout = (mount?: string) =>
    settings({
      scripts: [
        {
          name: "chat",
          src: "https://example.com/c.js",
          strategy: "facade",
          facade: {
            html: "<button>Chat</button>",
            ...(mount === undefined ? {} : { mount }),
          },
        },
        {
          name: "video",
          src: "https://example.com/v.js",
          strategy: "facade",
          facade: { html: "<button>Video</button>" },
        },
      ],
    });

  const plain = scriptElements(loadout(), HOME);
  const mounted = scriptElements(loadout("comments"), HOME);

  expect(mounted.placeholders.map(({ html }) => html)).toEqual(
    plain.placeholders.map(({ html }) => html),
  );
  expect(mounted.elements).toEqual(plain.elements);
  expect(mounted.placeholders.map(({ mount }) => mount)).toEqual([
    "comments",
    undefined,
  ]);
});

test("a runtime is not called on a page whose loadout reaches no worker script", () => {
  let calls = 0;
  const elements = emitted(
    settings({
      scripts: [
        { name: "chat", src: "https://example.com/c.js", strategy: "facade", facade: { html: "x" } },
      ],
      runtime: () => {
        calls += 1;
        return { body: ["<script>snippet</script>"] };
      },
    }),
    HOME,
  );

  expect(calls).toBe(0);
  expect(elements).not.toContain("<script>snippet</script>");
});

test("a source that could close the script block is encoded rather than filtered", () => {
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "hostile",
          src: "https://example.com/a.js#</script><script>alert(1)</script>",
          strategy: "idle",
        },
      ],
    }),
    HOME,
  );

  expect(elements[0]).not.toContain("</script><script>");
  expect(elements[0]).toContain("\\u003c/script>");
  expect(elements[0]?.match(/<\/script>/g)).toHaveLength(1);
});

test("an attribute value that could close the script block is encoded the same way", () => {
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "hostile",
          src: "https://example.com/a.js",
          strategy: "idle",
          attributes: { "data-domain": "</script><script>alert(1)</script>" },
        },
      ],
    }),
    HOME,
  );

  expect(elements[0]).not.toContain("</script><script>");
  expect(elements[0]).toContain("\\u003c/script>");
  expect(elements[0]?.match(/<\/script>/g)).toHaveLength(1);
});

test("a page that categorizes nothing carries the loader it carried before consent existed", () => {
  // Asserted whole rather than by absence: "does not contain gate" would also pass on a
  // loader that had grown some other unconditional byte.
  const elements = emitted(
    settings({
      scripts: [
        { name: "analytics", src: "https://example.com/a.js", strategy: "idle" },
        { name: "pixel", src: "https://example.com/p.js", strategy: "interaction" },
        {
          name: "chat",
          src: "https://example.com/c.js",
          strategy: "facade",
          facade: { html: "<button>Chat</button>" },
        },
      ],
    }),
    HOME,
  );

  const key = facadeKey(["<button>Chat</button>", "https://example.com/c.js"]);
  expect(elements).toEqual([
    `<div data-pagedeck-facade="${key}-0"><button>Chat</button></div>`,
    `<script>(function(){var load=function(u){for(var i=0;i<u.length;i++){var s=document.createElement("script");s.src=u[i];s.async=true;document.head.appendChild(s)}};var run=function(){load(["https://example.com/a.js"])};if("requestIdleCallback" in window)window.requestIdleCallback(run);else setTimeout(run,0);var events=["pointerdown","keydown","wheel"],fire=function(){for(var i=0;i<events.length;i++)removeEventListener(events[i],fire);load(["https://example.com/p.js"])};for(var i=0;i<events.length;i++)addEventListener(events[i],fire,{passive:true});var facades=["https://example.com/c.js"];for(var j=0;j<facades.length;j++)(function(el,src){if(!el)return;var e=["pointerdown","keydown"],go=function(){for(var k=0;k<e.length;k++)el.removeEventListener(e[k],go);var s=document.createElement("script");s.src=src;s.async=true;s.addEventListener("load",function(){el.remove()});document.head.appendChild(s)};for(var k=0;k<e.length;k++)el.addEventListener(e[k],go,{passive:true})})(document.querySelector(\'[data-pagedeck-facade="${key}-\'+j+\'"]\'),facades[j]);})();</script>`,
  ]);
});

test("a page that declares an attribute pays for it in every half that appends", () => {
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "analytics",
          src: "https://example.com/a.js",
          strategy: "idle",
          attributes: { "data-domain": "example.org" },
        },
        { name: "pixel", src: "https://example.com/p.js", strategy: "interaction" },
        {
          name: "chat",
          src: "https://example.com/c.js",
          strategy: "facade",
          facade: { html: "<button>Chat</button>" },
          attributes: { "data-repo": "owner/repo", "data-theme": "dark" },
        },
      ],
    }),
    HOME,
  );

  const key = facadeKey(["<button>Chat</button>", "https://example.com/c.js"]);
  expect(elements).toEqual([
    `<div data-pagedeck-facade="${key}-0"><button>Chat</button></div>`,
    `<script>(function(){var load=function(u){for(var i=0;i<u.length;i++){var t=u[i],s=document.createElement("script");s.src=t[0];for(var a=1;a<t.length;a+=2)s.setAttribute(t[a],t[a+1]);s.async=true;document.head.appendChild(s)}};var run=function(){load([["https://example.com/a.js","data-domain","example.org"]])};if("requestIdleCallback" in window)window.requestIdleCallback(run);else setTimeout(run,0);var events=["pointerdown","keydown","wheel"],fire=function(){for(var i=0;i<events.length;i++)removeEventListener(events[i],fire);load([["https://example.com/p.js"]])};for(var i=0;i<events.length;i++)addEventListener(events[i],fire,{passive:true});var facades=[["https://example.com/c.js","data-repo","owner/repo","data-theme","dark"]];for(var j=0;j<facades.length;j++)(function(el,src){if(!el)return;var e=["pointerdown","keydown"],go=function(){for(var k=0;k<e.length;k++)el.removeEventListener(e[k],go);var s=document.createElement("script");s.src=src[0];for(var a=1;a<src.length;a+=2)s.setAttribute(src[a],src[a+1]);s.async=true;s.addEventListener("load",function(){el.remove()});document.head.appendChild(s)};for(var k=0;k<e.length;k++)el.addEventListener(e[k],go,{passive:true})})(document.querySelector('[data-pagedeck-facade="${key}-'+j+'"]'),facades[j]);})();</script>`,
  ]);
});

test("an attribute map a site declared and left empty costs the page nothing", () => {
  const plain = emitted(
    settings({
      scripts: [
        { name: "analytics", src: "https://example.com/a.js", strategy: "idle" },
      ],
    }),
    HOME,
  );
  const empty = emitted(
    settings({
      scripts: [
        {
          name: "analytics",
          src: "https://example.com/a.js",
          strategy: "idle",
          attributes: {},
        },
      ],
    }),
    HOME,
  );

  expect(empty).toEqual(plain);
});

test("a gated script carries its attributes inside the triple its gate reads", () => {
  const element =
    emitted(
      settings({
        scripts: [
          {
            name: "pixel",
            src: "/p.js",
            strategy: "idle",
            category: "analytics",
            attributes: { "data-domain": "example.org" },
          },
        ],
        consentDefaults: { "en:/**": { analytics: "granted" } },
      }),
      HOME,
    )[0] ?? "";

  expect(element).toContain(
    'var gi=[[["/p.js","data-domain","example.org"],"analytics",1]]',
  );
  expect(element).toContain("var one=function(g){load([g[0]])};");
});

test("a pinned script is emitted with its integrity and CORS mode as two more pairs of its entry", () => {
  const integrity = "sha384-abc";
  const element =
    emitted(
      settings({
        scripts: [
          {
            name: "analytics",
            src: "/a.js",
            strategy: "idle",
            attributes: { "data-domain": "example.org" },
            integrity,
          },
          {
            name: "pixel",
            src: "/p.js",
            strategy: "idle",
            category: "analytics",
            integrity,
          },
          {
            name: "chat",
            src: "/c.js",
            strategy: "facade",
            facade: { html: "<button>Chat</button>" },
            integrity,
          },
        ],
      }),
      HOME,
    )[1] ?? "";

  expect(element).toContain(
    'load([["/a.js","data-domain","example.org","integrity","sha384-abc","crossorigin","anonymous"]])',
  );
  expect(element).toContain(
    'var gi=[[["/p.js","integrity","sha384-abc","crossorigin","anonymous"],"analytics",0]]',
  );
  expect(element).toContain(
    'var facades=[["/c.js","integrity","sha384-abc","crossorigin","anonymous"]]',
  );
});

test("a script with no integrity is emitted as it was before the field existed", () => {
  const absent = emitted(
    settings({
      scripts: [
        { name: "analytics", src: "https://example.com/a.js", strategy: "idle" },
      ],
    }),
    HOME,
  );
  const undefinedValue = emitted(
    settings({
      scripts: [
        {
          name: "analytics",
          src: "https://example.com/a.js",
          strategy: "idle",
          integrity: undefined,
        },
      ],
    }),
    HOME,
  );

  expect(absent).toEqual([
    '<script>(function(){var load=function(u){for(var i=0;i<u.length;i++){var s=document.createElement("script");s.src=u[i];s.async=true;document.head.appendChild(s)}};var run=function(){load(["https://example.com/a.js"])};if("requestIdleCallback" in window)window.requestIdleCallback(run);else setTimeout(run,0);})();</script>',
  ]);
  expect(undefinedValue).toEqual(absent);
});

test("a necessary script is emitted with no gate, and an analytics one with its market's default", () => {
  const declared = settings({
    scripts: [
      { name: "cmp", src: "/cmp.js", strategy: "idle", category: "necessary" },
      { name: "pixel", src: "/p.js", strategy: "idle", category: "analytics" },
    ],
    consentDefaults: { "en:/**": { analytics: "granted" } },
  });

  const english = emitted(declared, HOME)[0] ?? "";
  expect(english).toContain('load(["/cmp.js"])');
  expect(english).toContain('var gi=[["/p.js","analytics",1]]');

  const german = emitted(declared, { locale: "de", path: "/" })[0] ?? "";
  expect(german).toContain('var gi=[["/p.js","analytics",0]]');
});

test("a gated facade's placeholder carries its category's state and the loader tracks it", () => {
  const declared = settings({
    scripts: [
      {
        name: "chat",
        src: "https://example.com/c.js",
        strategy: "facade",
        category: "marketing",
        facade: { html: "<button>Chat</button>" },
      },
    ],
    consentDefaults: { "de:/**": { marketing: "granted" } },
  });

  const key = facadeKey(["<button>Chat</button>", "https://example.com/c.js"]);
  const english = emitted(declared, HOME);
  expect(english[0]).toBe(
    `<div data-pagedeck-facade="${key}-0" data-pagedeck-consent="denied"><button>Chat</button></div>`,
  );

  expect(emitted(declared, { locale: "de", path: "/" })[0]).toBe(
    `<div data-pagedeck-facade="${key}-0" data-pagedeck-consent="granted"><button>Chat</button></div>`,
  );

  const loader = english[1] ?? "";
  expect(loader).toContain(
    'var mark=function(el,g){if(g.length>1)el.setAttribute("data-pagedeck-consent",ok(g)?"granted":"denied")};',
  );
  expect(loader).toContain(
    'mark(el,g);addEventListener("pagedeck:consent",function(){mark(el,g)});',
  );
  expect(loader).toContain("if(g.length>1&&!ok(g))return;");
});

test("a page's consent attribute holds one of two words and nothing a site chose", () => {
  const state = /data-pagedeck-consent="([^"]*)"/.exec(
    emitted(
      settings({
        scripts: [
          {
            name: "chat",
            src: "https://example.com/c.js",
            strategy: "facade",
            category: "analytics",
            facade: { html: "<button>Chat</button>" },
          },
        ],
      }),
      HOME,
    )[0] ?? "",
  )?.[1];

  expect(state).toMatch(/^(granted|denied)$/);
});

test("an uncategorized facade sharing a page with a gated one carries no consent attribute", () => {
  const chat = "<button>Chat</button>";
  const video = "<button>Play</button>";
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "chat",
          src: "https://example.com/c.js",
          strategy: "facade",
          category: "marketing",
          facade: { html: chat },
        },
        {
          name: "video",
          src: "https://example.com/v.js",
          strategy: "facade",
          facade: { html: video },
        },
      ],
    }),
    HOME,
  );

  const key = facadeKey(
    [chat, "https://example.com/c.js"],
    [video, "https://example.com/v.js"],
  );
  expect(elements[0]).toBe(
    `<div data-pagedeck-facade="${key}-0" data-pagedeck-consent="denied">${chat}</div>`,
  );
  expect(elements[1]).toBe(`<div data-pagedeck-facade="${key}-1">${video}</div>`);
});

test("a facade whose own markup carries a data-pagedeck-facade cannot name another placeholder", () => {
  const decoy = '<span data-pagedeck-facade="1">decoy</span>';
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "chat",
          src: "https://example.com/c.js",
          strategy: "facade",
          facade: { html: decoy },
        },
        {
          name: "video",
          src: "https://example.com/v.js",
          strategy: "facade",
          facade: { html: "<button>Video</button>" },
        },
      ],
    }),
    HOME,
  );
  const key = facadeKey(
    [decoy, "https://example.com/c.js"],
    ["<button>Video</button>", "https://example.com/v.js"],
  );

  expect(elements[1]).toBe(
    `<div data-pagedeck-facade="${key}-1"><button>Video</button></div>`,
  );
  expect(elements[0]).not.toContain(`data-pagedeck-facade="${key}-1"`);
  expect(elements[2]).toContain(
    `document.querySelector('[data-pagedeck-facade="${key}-'+j+'"]')`,
  );
});

test("a page's facade key is lowercase hex whatever the site's own bytes hold", () => {
  const elements = emitted(
    settings({
      scripts: [
        {
          name: "chat",
          src: "https://example.com/c.js?q=</script><\"'\\",
          strategy: "facade",
          facade: { html: "<button data-x='\"'>Chat</ script></button>" },
        },
      ],
    }),
    HOME,
  );

  const key = /data-pagedeck-facade="([^"]*)-0"/.exec(elements[0] ?? "")?.[1];
  expect(key).toMatch(/^[0-9a-f]{8}$/);
  expect(elements[1]).toContain(
    `document.querySelector('[data-pagedeck-facade="${key ?? ""}-'+j+'"]')`,
  );
});

function everyLoader(): { name: string; element: string }[] {
  const strategies = ["idle", "interaction", "facade"] as const;
  const loaders: { name: string; element: string }[] = [];
  for (let mask = 1; mask < 1 << strategies.length; mask++) {
    const carried = strategies.filter(
      (_, index) => (mask & (1 << index)) !== 0,
    );
    for (const gated of [false, true]) {
      for (const attributed of [false, true]) {
        const scripts = carried.map((strategy) => ({
          name: strategy,
          src: `https://example.com/${strategy}.js`,
          strategy,
          ...(strategy === "facade"
            ? { facade: { html: "<button>Open</button>" } }
            : {}),
          ...(gated ? { category: "analytics" as const } : {}),
          ...(attributed ? { attributes: { "data-site": "example" } } : {}),
        }));
        const { elements } = scriptElements(settings({ scripts }), HOME);
        loaders.push({
          name: `${carried.join("+")}${gated ? ", gated" : ""}${attributed ? ", attributed" : ""}`,
          element: elements.at(-1) ?? "",
        });
      }
    }
  }
  return loaders;
}

function otherBareScripts(): string[] {
  const beacon = beaconElement({ endpoint: "/rum" }, undefined, HOME) ?? "";
  return [
    "window.snippet = 1",
    'document.documentElement.dataset.theme = "dark"',
    beacon.slice("<script>".length, -"</script>".length),
  ];
}

test("the script loader's text is recognized whatever shape the page's loadout gave it", () => {
  const loaders = everyLoader();
  expect(loaders).toHaveLength(28);
  for (const { name, element } of loaders) {
    expect(element.startsWith("<script>")).toBe(true);
    const text = element.slice("<script>".length, -"</script>".length);
    expect(`${name}: ${String(isScriptLoaderText(text))}`).toBe(
      `${name}: true`,
    );
    expect(text).not.toContain("<script>");
  }
});

test("no other bare inline script is taken for the script loader", () => {
  const others = otherBareScripts();
  expect(others[2]?.startsWith("(function(){")).toBe(true);
  for (const text of others) expect(isScriptLoaderText(text)).toBe(false);
});

test("a runtime is handed the request it always was, whether or not it declares files", () => {
  const requests: object[] = [];
  const record = () => (request: object): ScriptRuntimeMarkup => {
    requests.push(request);
    return {};
  };
  const declared = (runtime: ScriptsSetting["runtime"]): ScriptsSetting =>
    settings({ scripts: [{ name: "tags", src: "https://example.com/t.js" }], runtime });
  emitted(declared(record()), HOME);
  emitted(declared(Object.assign(record(), { files: [{ name: "a.js", contents: "" }] })), HOME);

  expect(requests.map((request) => Object.keys(request))).toEqual([["scripts"], ["scripts"]]);
});

const LATE_PICKUP = { type: "text/partytown", event: "ptupdate" };

function lateRuntime(requests: (readonly string[])[]): NonNullable<ScriptsSetting["runtime"]> {
  return Object.assign(
    ({ scripts }: { scripts: readonly { src: string }[] }): ScriptRuntimeMarkup => {
      requests.push(scripts.map(({ src }) => src));
      return {
        body: [
          "<script>/* snippet */</script>",
          ...scripts.map(({ src }) => `<script type="text/partytown" src="${src}"></script>`),
        ],
      };
    },
    { latePickup: LATE_PICKUP },
  );
}

test("a held worker script never reaches the runtime, and its page still carries the runtime (#281)", () => {
  const requests: (readonly string[])[] = [];
  const elements = emitted(
    settings({
      scripts: [
        { name: "tags", src: "https://example.com/t.js" },
        {
          name: "pixel",
          src: "https://example.com/px.js",
          category: "analytics",
          attributes: { "data-site": "1" },
        },
      ],
      runtime: lateRuntime(requests),
    }),
    HOME,
  );

  expect(requests).toEqual([["https://example.com/t.js"]]);
  expect(elements.slice(0, 2)).toEqual([
    "<script>/* snippet */</script>",
    '<script type="text/partytown" src="https://example.com/t.js"></script>',
  ]);
  expect(elements).toHaveLength(3);
  const loader = elements[2] ?? "";
  expect(loader).not.toContain('src="https://example.com/px.js"');
  expect(loader).toContain('[["https://example.com/px.js","data-site","1"],"analytics",0]');
  expect(loader).toContain('["text/partytown","ptupdate"]');
  expect(isScriptLoaderText(loader.slice("<script>".length, -"</script>".length))).toBe(true);
});

test("a page whose only worker script is held still hands the runtime its empty loadout", () => {
  const requests: (readonly string[])[] = [];
  const elements = emitted(
    settings({
      scripts: [{ name: "pixel", src: "https://example.com/px.js", category: "marketing" }],
      runtime: lateRuntime(requests),
    }),
    HOME,
  );

  expect(requests).toEqual([[]]);
  expect(elements[0]).toBe("<script>/* snippet */</script>");
  expect(elements).toHaveLength(2);
  expect(isScriptLoaderText((elements[1] ?? "").slice("<script>".length, -"</script>".length))).toBe(
    true,
  );
});

function answered(answer: unknown): () => unknown {
  return () =>
    scriptElements(
      settings({
        scripts: [{ name: "tags", src: "https://example.com/t.js" }],
        runtime: (() => answer) as unknown as NonNullable<ScriptsSetting["runtime"]>,
      }),
      HOME,
    );
}

const SHAPE_FAULT = (shown: string): string =>
  `Script runtime: "build.scripts.runtime" returned ${shown} for page "en /", which is not { head, body } — the build writes the head part into the page's <head> and the body part last in its <body>, and reads nothing else from the answer — return an object whose head and body are each a list of element strings, either left out, such as ({ scripts }) => ({ head: ["<script>…</script>"], body: […] })`;

test("a runtime answer that is a list, as the contract once was, is refused rather than dropped (#283)", () => {
  expect(answered(["<script>snippet</script>"])).toThrow(SHAPE_FAULT('["<script>snippet</script>"]'));
  expect(answered(undefined)).toThrow(SHAPE_FAULT("undefined"));
  expect(answered(null)).toThrow(SHAPE_FAULT("null"));
});

const HEAD_FAULTS = (count: number): string =>
  `Script runtime: "build.scripts.runtime" returned ${String(count)} entries for page "en /" this build cannot write — the head part goes into the page's <head> ahead of the pre-paint scripts, so each of its entries must be exactly one <script>…</script>, <link> or <meta> element with double-quoted attributes, which cannot close the <head>, reach into what follows it or speak for the whole document, and each part must be a list of strings — fix each entry as its line says:`;

const NOT_ONE =
  "not one <script>, <link> or <meta> element with double-quoted attributes — write it as one such element, or move it to body, which this check does not read";

const SPECULATES =
  "a speculation rules block, and the page's one is the build's own — declare the rules in build.speculation instead";

const WHOLE_DOCUMENT =
  "a <meta> carrying charset or http-equiv, which decides for the whole document — drop it: the build writes the charset, and a refresh or a policy belongs in a response header";

const CLOSES = `holds "</script" — an HTML parser ends the script element there, so the rest of the snippet is parsed as markup — write the sequence so it is not one, as "<\\/script"`;

test("every head entry that is not one script, link or meta element is refused, in one message, with the body's faults", () => {
  expect(
    answered({
      head: [
        "<script>ok()</script>",
        '<link rel="preload" href="/a.js" as="script">',
        '<meta name="x" content="y">',
        "<div>not head</div>",
        "<script>a()</script><script>b()</script>",
        "<script>x = '</script>'</script>",
        "<script>if (a <!-- b) {}</script>",
        "</head><body>",
        '<script src="/boot.js" async></script>',
        7,
      ],
      body: "<script></script>",
    }),
  ).toThrow(
    [
      HEAD_FAULTS(7),
      `  head[3] — "<div>not head</div>" — ${NOT_ONE}`,
      `  head[4] — "<script>a()</script><script>b()</script>" — ${CLOSES}`,
      `  head[5] — "<script>x = '</script>'</script>" — ${CLOSES}`,
      '  head[6] — "<script>if (a <!-- b) {}</script>" — holds "<!--" — an HTML parser reads it as the start of an escaped script, after which a "<script" in the same snippet stops the closing tag from closing anything — write it as "<\\!--", or use a // comment',
      `  head[7] — "</head><body>" — ${NOT_ONE}`,
      "  head[9] — 7 — not a string — write it as the element's markup",
      '  body — "<script></script>" — not a list — write it as a list of element strings',
    ].join("\n"),
  );
});

test("a head entry whose quoting the build's head reader would read differently is refused", () => {
  expect(
    answered({
      head: [
        `<link title='"' href="/x">`,
        `<meta content='a></head>'>`,
        "<meta content=a>",
        '<SCRIPT>if(a<b"){}</SCRIPT>',
      ],
    }),
  ).toThrow(
    [
      HEAD_FAULTS(4),
      `  head[0] — "<link title='\\"' href=\\"/x\\">" — ${NOT_ONE}`,
      `  head[1] — "<meta content='a></head>'>" — ${NOT_ONE}`,
      `  head[2] — "<meta content=a>" — ${NOT_ONE}`,
      `  head[3] — "<SCRIPT>if(a<b\\"){}</SCRIPT>" — ${NOT_ONE}`,
    ].join("\n"),
  );
});

test("a head entry that speaks for the whole document is refused", () => {
  expect(
    answered({
      head: [
        '<script type="speculationrules">{"prefetch":[]}</script>',
        '<script type=" SpeculationRules ">{}</script>',
        '<meta charset="utf-8">',
        '<meta http-equiv="refresh" content="0;url=/elsewhere">',
        '<meta HTTP-EQUIV="Content-Security-Policy" content="script-src *">',
      ],
    }),
  ).toThrow(
    [
      HEAD_FAULTS(5),
      `  head[0] — "<script type=\\"speculationrules\\">{\\"prefetch\\":[]}</script>" — ${SPECULATES}`,
      `  head[1] — "<script type=\\" SpeculationRules \\">{}</script>" — ${SPECULATES}`,
      `  head[2] — "<meta charset=\\"utf-8\\">" — ${WHOLE_DOCUMENT}`,
      `  head[3] — "<meta http-equiv=\\"refresh\\" content=\\"0;url=/elsewhere\\">" — ${WHOLE_DOCUMENT}`,
      `  head[4] — "<meta HTTP-EQUIV=\\"Content-Security-Policy\\" content=\\"script-src *\\">" — ${WHOLE_DOCUMENT}`,
    ].join("\n"),
  );
});

function headFaultLines(head: readonly string[]): string[] {
  try {
    answered({ head })();
  } catch (error) {
    return (error as Error).message.split("\n").slice(1);
  }
  return [];
}

test("only HTML's own whitespace separates a head entry's attributes", () => {
  const smuggled = [
    '<meta\vname="a">',
    "<script\vx><script>alert(1)</script>",
    '<meta\u00a0name="a">',
    '<link rel="preload"\u2028href="/a.js">',
    '<meta\uFEFFname="a">',
  ];
  const lines = headFaultLines(smuggled);

  expect(lines).toHaveLength(smuggled.length);
  lines.forEach((line, index) => {
    expect(line.startsWith(`  head[${String(index)}] — `)).toBe(true);
    expect(line.endsWith(NOT_ONE)).toBe(true);
  });
  expect(headFaultLines(['<link\trel="preload"\nhref="/a.js"\f\r as="script">'])).toEqual([]);
});

test("a head entry that names an attribute twice, or writes & in a value, is refused", () => {
  expect(
    headFaultLines([
      '<script type="speculationrules" type="x">{}</script>',
      '<meta name="a" NAME="b">',
      '<script type="speculation&#114;ules">{}</script>',
      '<link rel="preload" href="/a.js?x=1&amp;y=2">',
    ]),
  ).toEqual([
    `  head[0] — "<script type=\\"speculationrules\\" type=\\"x\\">{}</script>" — declares "type" more than once, and a browser keeps the first where a reader could take another — declare each attribute once`,
    `  head[1] — "<meta name=\\"a\\" NAME=\\"b\\">" — declares "name" more than once, and a browser keeps the first where a reader could take another — declare each attribute once`,
    `  head[2] — "<script type=\\"speculation&#…" — writes "&" in an attribute value, which a browser decodes as a character reference this check does not read — write the value without it, or move the entry to body`,
    `  head[3] — "<link rel=\\"preload\\" href=\\"/a.js?…" — writes "&" in an attribute value, which a browser decodes as a character reference this check does not read — write the value without it, or move the entry to body`,
  ]);
});

test("an answer with either part left out, or both, is written as given", () => {
  expect(answered({})).not.toThrow();
  expect(answered({ head: ['<script src="/boot.js" defer></script>'] })).not.toThrow();
  expect(answered({ body: ["<div>anything</div>"] })).not.toThrow();
});
