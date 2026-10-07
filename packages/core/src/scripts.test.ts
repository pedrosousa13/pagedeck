import { expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import type { ConsentDefaultMap, ScriptAttributes } from "./index.js";
import {
  DEFAULT_CONSENT,
  DEFAULT_SCRIPT_STRATEGY,
  WORKER_FALLBACK_STRATEGY,
  defineScripts,
  loadedScriptStrategy,
  resolveConsentDefault,
  resolveScriptStrategy,
  scriptsFaultReport,
  unloadedScriptWarning,
  workerConsentWarning,
  workerFallbackWarning,
} from "./scripts.js";
import type { ScriptDeclaration, ScriptRuntimeAdapter } from "./scripts.js";

const WORKER_SHAPED: ScriptRuntimeAdapter = ({ scripts }) => [
  `<script type="module">startWorker(${JSON.stringify(scripts.map((script) => script.src))})</script>`,
];

const PARTYTOWN_SHAPED: ScriptRuntimeAdapter = ({ scripts }) => [
  "<script>/* partytown snippet */</script>",
  ...scripts.map(
    (script) =>
      `<script type="text/partytown" src="${script.src}"></script>`,
  ),
];

const ANALYTICS: ScriptDeclaration = {
  name: "analytics",
  src: "https://example.com/analytics.js",
};
const CHAT: ScriptDeclaration = {
  name: "chat",
  src: "https://example.com/chat.js",
  strategy: "facade",
  facade: { html: "<button>Chat</button>" },
};

const HOME = { locale: "en", path: "/home" };
const PRICING = { locale: "en", path: "/pricing" };

test("a script that declares no strategy resolves to worker", () => {
  expect(
    resolveScriptStrategy({ scripts: [ANALYTICS] }, ANALYTICS, HOME),
  ).toBe("worker");
  expect(DEFAULT_SCRIPT_STRATEGY).toBe("worker");
});

test("the script's own strategy is the first layer, and stands where nothing overrides it", () => {
  const idle = { ...ANALYTICS, strategy: "idle" } as const;

  expect(resolveScriptStrategy({ scripts: [idle] }, idle, HOME)).toBe("idle");
});

test("a page-type override alone moves a script off its default", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: { "/**": { analytics: "idle" } },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("idle");
});

test("a per-page override alone moves a script off its default", () => {
  const settings = {
    scripts: [ANALYTICS],
    pages: { "/home": { analytics: "interaction" } },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("interaction");
});

test("a page-type override beats the script's own strategy", () => {
  const declared = { ...ANALYTICS, strategy: "worker" } as const;
  const settings = {
    scripts: [declared],
    pageTypes: { "/**": { analytics: "idle" } },
  } as const;

  expect(resolveScriptStrategy(settings, declared, HOME)).toBe("idle");
});

test("a per-page override beats the script's own strategy", () => {
  const declared = { ...ANALYTICS, strategy: "worker" } as const;
  const settings = {
    scripts: [declared],
    pages: { "/home": { analytics: "idle" } },
  } as const;

  expect(resolveScriptStrategy(settings, declared, HOME)).toBe("idle");
});

test("a per-page override beats a page-type override", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: { "/**": { analytics: "idle" } },
    pages: { "/home": { analytics: "interaction" } },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("interaction");
  expect(resolveScriptStrategy(settings, ANALYTICS, PRICING)).toBe("idle");
});

test("all three layers at once resolve to the last one that speaks", () => {
  const declared = { ...ANALYTICS, strategy: "worker" } as const;
  const settings = {
    scripts: [declared],
    pageTypes: { "/**": { analytics: "idle" } },
    pages: { "/home": { analytics: "interaction" } },
  } as const;

  expect(resolveScriptStrategy(settings, declared, HOME)).toBe("interaction");
});

test("a layer that names a different script leaves this one where it was", () => {
  const settings = {
    scripts: [ANALYTICS, CHAT],
    pageTypes: { "/**": { chat: "idle" } },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("worker");
  expect(resolveScriptStrategy(settings, CHAT, HOME)).toBe("idle");
});

test("inside one layer the more specific pattern wins", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: {
      "/**": { analytics: "idle" },
      "/pricing": { analytics: "interaction" },
    },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, PRICING)).toBe(
    "interaction",
  );
  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("idle");
});

test("a locale scope beats a longer unscoped pattern, as page patterns rank them", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: {
      "/pricing": { analytics: "idle" },
      "en:/**": { analytics: "interaction" },
    },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, PRICING)).toBe(
    "interaction",
  );
  expect(
    resolveScriptStrategy(settings, ANALYTICS, { locale: "de", path: "/pricing" }),
  ).toBe("idle");
});

test("the most specific pattern that names this script wins, not the most specific one that matches", () => {
  const settings = {
    scripts: [ANALYTICS, CHAT],
    pageTypes: {
      "/**": { analytics: "idle" },
      "/pricing": { chat: "interaction" },
    },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, PRICING)).toBe("idle");
});

test("an override takes a script off the pages it names", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: { "/blog/**": { analytics: "off" } },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("worker");
  expect(
    resolveScriptStrategy(settings, ANALYTICS, { locale: "en", path: "/blog/one" }),
  ).toBe("off");
});

test("a broad off and a narrow strategy are how a script is opted in rather than out", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: { "/**": { analytics: "off" } },
    pages: { "/pricing": { analytics: "idle" } },
  } as const;

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("off");
  expect(resolveScriptStrategy(settings, ANALYTICS, PRICING)).toBe("idle");
});

test("a script taken off a page takes neither the worker fallback nor the consent downgrade", () => {
  const gated = { ...ANALYTICS, category: "analytics" } as const;
  const pages = { "/home": { analytics: "off" } } as const;

  expect(loadedScriptStrategy({ scripts: [gated], pages }, gated, HOME)).toBe(
    "off",
  );
  expect(
    loadedScriptStrategy(
      { scripts: [gated], pages, runtime: WORKER_SHAPED },
      gated,
      HOME,
    ),
  ).toBe("off");
});

test("defineScripts hands back settings it can find no fault in", () => {
  const settings = { scripts: [ANALYTICS, CHAT] };

  expect(defineScripts(settings)).toBe(settings);
});

test("script settings that are not an object are refused alone", () => {
  expect(() => defineScripts(7 as never)).toThrow(ConfigError);
  expect(scriptsFaultReport(7, "Script settings")).toBe(
    'Script settings: must be an object declaring the site\'s third-party scripts — scripts: { scripts: [{ name: "analytics", src: "https://example.com/analytics.js" }] }',
  );
});

test("a field this build does not read is a fault of its own", () => {
  expect(
    scriptsFaultReport(
      { scripts: [ANALYTICS], pagetypes: {} },
      "Script settings",
    ),
  ).toBe(
    'Script settings: declares 1 field this build does not read — delete the field, or correct it to one of: scripts, pageTypes, pages, runtime, consentDefaults:\n  "pagetypes"',
  );
});

test("settings with no list of scripts and settings with an empty one are two faults", () => {
  expect(scriptsFaultReport({}, "Script settings")).toBe(
    'Script settings: declares no scripts to load — write scripts as a list of declarations, such as scripts: { scripts: [{ name: "analytics", src: "https://example.com/analytics.js" }] }',
  );
  expect(scriptsFaultReport({ scripts: [] }, "Script settings")).toBe(
    "Script settings: declares an empty list of scripts, so the script layer would do nothing — list at least one, or declare no scripts at all",
  );
});

test("every unusable field of every declared script is reported with the type its line needs", () => {
  const report = scriptsFaultReport(
    {
      scripts: [
        { name: "", src: "https://example.com/a.js" },
        { name: "chat", src: 7, strategy: "lazy" },
        { name: "video", src: "/v.js", facade: { html: "  " } },
      ],
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 4 script fields that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "name" — "" — not a script name — write the name an override addresses this script by, such as "analytics"',
      '  scripts[1] — "src" — 7 — not a script source — write the URL or path the script is served from, such as "https://example.com/analytics.js"',
      '  scripts[1] — "strategy" — "lazy" — not a loading strategy — write one of: worker, idle, interaction, facade',
      '  scripts[2] — "facade.html" — "  " — not placeholder HTML — write the markup the page shows until the script loads, such as "<button>Chat</button>"',
    ].join("\n"),
  );
});

test("a list entry that is not a declaration at all is its own paragraph", () => {
  const report = scriptsFaultReport(
    { scripts: [ANALYTICS, "https://example.com/a.js"] },
    "Script settings",
  );

  expect(report).toBe(
    [
      'Script settings: declares 1 entry that is not a script declaration — write each as a name and a source, as { name: "analytics", src: "https://example.com/analytics.js" }:',
      '  scripts[1] — "https://example.com/a.js"',
    ].join("\n"),
  );
});

test("the attribute map refuses a key the loader owns, at the declaration site", () => {
  // The directives are the assertion: an unused `@ts-expect-error` fails typecheck.
  // One key per declaration, because the excess-property check stops at the first.
  const src: ScriptDeclaration = {
    ...ANALYTICS,
    // @ts-expect-error `src` belongs to the strategy layer and the declaration
    attributes: { src: "https://evil.example/a.js" },
  };
  const async: ScriptDeclaration = {
    ...ANALYTICS,
    // @ts-expect-error `async`, `defer`, `type`, `nonce` and `integrity` are refused too
    attributes: { async: "true" },
  };
  const count: ScriptDeclaration = {
    ...ANALYTICS,
    // @ts-expect-error an attribute is text, whatever the vendor calls it.
    attributes: { "data-count": 7 },
  };
  const domain: ScriptDeclaration = {
    ...ANALYTICS,
    attributes: { "data-domain": "example.org" },
  };

  expect([src, async, count, domain]).toHaveLength(4);
  expect(domain.attributes?.["data-domain"]).toBe("example.org");
});

test("a site can name the map, and the name is where the key is refused", () => {
  const attributes: ScriptAttributes = {
    // @ts-expect-error `async` is the loader's own field
    async: "true",
  };

  const inferred = { async: "true" };

  expect(
    scriptsFaultReport(
      { scripts: [{ ...ANALYTICS, attributes: inferred }] },
      "Script settings",
    ),
  ).toBe(
    [
      "Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "attributes.async" — not a data attribute name — write a key of the form data-<name>, such as "data-domain"',
    ].join("\n"),
  );

  expect(attributes).toEqual(inferred);
});

test("a data attribute map is a field this build reads", () => {
  expect(
    scriptsFaultReport(
      {
        scripts: [{ ...ANALYTICS, attributes: { "data-domain": "example.org" } }],
      },
      "Script settings",
    ),
  ).toBeUndefined();
});

test("an attribute key the loader owns is refused at the config door as well", () => {
  const report = scriptsFaultReport(
    {
      scripts: [
        { ...ANALYTICS, attributes: { src: "https://evil.example/a.js" } },
        { ...CHAT, attributes: { "data-domain": 7 } },
      ],
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 2 script fields that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "attributes.src" — not a data attribute name — write a key of the form data-<name>, such as "data-domain"',
      '  scripts[1] — "attributes.data-domain" — 7 — not an attribute value — write the text the vendor reads, such as "example.com"',
    ].join("\n"),
  );
});

test("a key a browser will set is accepted here, whatever its spelling", () => {
  expect(
    scriptsFaultReport(
      {
        scripts: [
          {
            ...ANALYTICS,
            attributes: {
              "data-Domain": "example.com",
              "data-foo_bar": "on",
              "data-1": "x",
              "data-x.y": "z",
            },
          },
        ],
      },
      "Script settings",
    ),
  ).toBeUndefined();
});

test("the bare prefix configures nothing, and the type cannot refuse it", () => {
  const report = scriptsFaultReport(
    { scripts: [{ ...ANALYTICS, attributes: { "data-": "x" } }] },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "attributes.data-" — not a data attribute name — write a key of the form data-<name>, such as "data-domain"',
    ].join("\n"),
  );
});

test("a key setAttribute would throw on is refused, and the character is named", () => {
  const report = scriptsFaultReport(
    {
      scripts: [
        { ...ANALYTICS, attributes: { "data-domain ": "example.com" } },
        { ...CHAT, attributes: { "data-a b": "x" } },
      ],
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 2 script fields that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "attributes.data-domain " — a name setAttribute throws on — it holds 1 character outside XML\'s Name production, " " (U+0020), and the loader sets every declared attribute as it runs, so one key like this stops script loading on every page that carries it; delete it, or write the name the vendor documents, such as "data-domain"',
      '  scripts[1] — "attributes.data-a b" — a name setAttribute throws on — it holds 1 character outside XML\'s Name production, " " (U+0020), and the loader sets every declared attribute as it runs, so one key like this stops script loading on every page that carries it; delete it, or write the name the vendor documents, such as "data-domain"',
    ].join("\n"),
  );
});

test("every character a name cannot hold is named once, in the order it appears", () => {
  const report = scriptsFaultReport(
    { scripts: [{ ...ANALYTICS, attributes: { "data-<a b b>": "x" } }] },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "attributes.data-<a b b>" — a name setAttribute throws on — it holds 3 characters outside XML\'s Name production, "<" (U+003C), " " (U+0020), ">" (U+003E), and the loader sets every declared attribute as it runs, so one key like this stops script loading on every page that carries it; delete them, or write the name the vendor documents, such as "data-domain"',
    ].join("\n"),
  );
});

test("a key failing both rules is reported on the prefix alone", () => {
  const report = scriptsFaultReport(
    { scripts: [{ ...ANALYTICS, attributes: { "src x": "y" } }] },
    "Script settings",
  );

  expect(report).toContain('"attributes.src x" — not a data attribute name');
  expect(report).not.toContain("setAttribute throws on");
});

test("an attribute map that is not a map is its own line, with nothing enumerated under it", () => {
  expect(
    scriptsFaultReport(
      { scripts: [{ ...ANALYTICS, attributes: "data-domain=example.com" }] },
      "Script settings",
    ),
  ).toBe(
    [
      "Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "attributes" — "data-domain=example.com" — not an attribute map — write a map of data attribute to value, as attributes: { "data-domain": "example.com" }',
    ].join("\n"),
  );
});

test("integrity metadata is a field this build reads", () => {
  expect(
    scriptsFaultReport(
      {
        scripts: [
          {
            ...ANALYTICS,
            integrity:
              "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC",
          },
          { ...CHAT, integrity: "md5-abc sha512-def" },
        ],
      },
      "Script settings",
    ),
  ).toBeUndefined();
});

test("integrity a browser would not check the script against is refused at the config door", () => {
  const report = scriptsFaultReport(
    {
      scripts: [
        { ...ANALYTICS, integrity: 7 },
        { ...CHAT, integrity: "" },
        { name: "video", src: "/v.js", integrity: "md5-abc SHA384-def" },
      ],
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 3 script fields that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "integrity" — 7 — not integrity metadata — write the hash the vendor publishes for this exact file, such as "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"',
      '  scripts[1] — "integrity" — "" — not integrity metadata — write the hash the vendor publishes for this exact file, such as "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"',
      '  scripts[2] — "integrity" — "md5-abc SHA384-def" — holds no sha256-, sha384- or sha512- hash, and a browser ignores integrity it cannot parse, so the script would load unchecked — write the hash the vendor publishes for this exact file, such as "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC"',
    ].join("\n"),
  );
});

test("a script field this build does not read is its own paragraph", () => {
  const report = scriptsFaultReport(
    { scripts: [{ ...ANALYTICS, stratergy: "idle" }] },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 1 script field this build does not read — delete the field, or correct it to one of: name, src, strategy, facade, category, attributes, integrity:",
      '  scripts[0] — "stratergy"',
    ].join("\n"),
  );
});

test("two scripts under one name are refused, because an override addresses a script by name", () => {
  const report = scriptsFaultReport(
    { scripts: [ANALYTICS, CHAT, ANALYTICS] },
    "Script settings",
  );

  expect(report).toBe(
    [
      "Script settings: declares 1 name that more than one script uses, and an override addresses a script by name — give each script its own name:",
      '  "analytics" — scripts[0], scripts[2]',
    ].join("\n"),
  );
});

test("a script that can resolve to facade with no facade to render is refused, from either layer", () => {
  const report = scriptsFaultReport(
    {
      scripts: [
        { name: "chat", src: "/chat.js", strategy: "facade" },
        { name: "video", src: "/video.js" },
      ],
      pageTypes: { "/support/**": { video: "facade" } },
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      'Script settings: 2 scripts can resolve to the facade strategy with no facade to render — declare the placeholder the page shows until the script loads, as facade: { html: "<button>Chat</button>" }:',
      '  "chat" — declares strategy "facade"',
      '  "video" — pageTypes "/support/**" sets "facade"',
    ].join("\n"),
  );
});

test("an override map is checked with the page-pattern language the other build maps use", () => {
  const report = scriptsFaultReport(
    { scripts: [ANALYTICS], pageTypes: { blog: { analytics: "idle" } } },
    "Script settings",
  );

  expect(report).toBe(
    [
      'Script settings: "pageTypes" declares 1 key that is not a page pattern — write a path glob starting with "/", optionally prefixed "<locale>:", such as "en:/pricing":',
      '  "blog" — the path does not start with "/"',
    ].join("\n"),
  );
});

test("an override naming a script the site never declared is refused with the declared names", () => {
  const report = scriptsFaultReport(
    {
      scripts: [ANALYTICS, CHAT],
      pages: { "/home": { analitycs: "idle", chat: "lazy" } },
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      'Script settings: "pages" declares 1 override no script can take — write a map of script name to strategy or "off", such as { "/blog/**": { analytics: "idle" } }:',
      '  "/home" — "analitycs" — not a declared script, and the declared scripts are "analytics", "chat"; "chat" — "lazy" — not a loading strategy or "off" — write one of: worker, idle, interaction, facade, off',
    ].join("\n"),
  );
});

test("off is a value either override layer may set", () => {
  const settings = {
    scripts: [ANALYTICS, CHAT],
    pageTypes: { "/**": { analytics: "off" } },
    pages: { "/home": { chat: "off" } },
  } as const;

  expect(defineScripts(settings)).toBe(settings);
});

test("a declaration cannot take a script off, and its refusal names only the strategies", () => {
  expect(
    scriptsFaultReport(
      { scripts: [{ ...ANALYTICS, strategy: "off" }] },
      "Script settings",
    ),
  ).toBe(
    [
      "Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "strategy" — "off" — not a loading strategy — write one of: worker, idle, interaction, facade',
    ].join("\n"),
  );
});

test("an override is silent about membership when no declaration gave a name to check", () => {
  expect(
    scriptsFaultReport(
      { scripts: [], pages: { "/x": { a: "idle" } } },
      "Script settings",
    ),
  ).toBe(
    "Script settings: declares an empty list of scripts, so the script layer would do nothing — list at least one, or declare no scripts at all",
  );

  expect(
    scriptsFaultReport(
      {
        scripts: [{ name: 7, src: "https://example.com/a.js" }],
        pages: { "/x": { a: "idle" } },
      },
      "Script settings",
    ),
  ).toBe(
    [
      "Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "name" — 7 — not a script name — write the name an override addresses this script by, such as "analytics"',
    ].join("\n"),
  );
});

test("a pair of override patterns no page can choose between is refused", () => {
  const report = scriptsFaultReport(
    {
      scripts: [ANALYTICS],
      pageTypes: {
        "/a/*": { analytics: "idle" },
        "/*/b": { analytics: "interaction" },
      },
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      'Script settings: "pageTypes" holds 1 pair of patterns no page can choose between — make one of the pair more specific, or give both the same strategies:',
      '  "/a/*" and "/*/b" — equally specific, and both match "/a/b"',
    ].join("\n"),
  );
});

test("the report names the config's own field when the build section is the door", () => {
  expect(
    scriptsFaultReport(
      { scripts: [ANALYTICS], pageTypes: { blog: { analytics: "idle" } } },
      'Config "/site/pagedeck.config.ts"',
      "build.scripts",
    ),
  ).toContain(
    'Config "/site/pagedeck.config.ts": "build.scripts.pageTypes" declares 1 key that is not a page pattern',
  );
});

test("every fault of one settings object arrives in one throw", () => {
  const error: unknown = (() => {
    try {
      defineScripts({
        scripts: [{ name: "chat", src: "/chat.js", strategy: "facade" }],
        pagetypes: {},
      } as never);
      return undefined;
    } catch (thrown: unknown) {
      return thrown;
    }
  })();

  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain("declares 1 field this build does not read");
  expect(message).toContain("can resolve to the facade strategy");
});

test("a configured runtime is what makes the worker strategy loadable", () => {
  const settings = { scripts: [ANALYTICS], runtime: WORKER_SHAPED };

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("worker");
  expect(loadedScriptStrategy(settings, ANALYTICS, HOME)).toBe("worker");
});

test("a categorized script takes the same fallback, whatever runtime is configured", () => {
  const gated = { ...ANALYTICS, category: "analytics" } as const;
  const settings = { scripts: [gated], runtime: WORKER_SHAPED } as const;

  expect(resolveScriptStrategy(settings, gated, HOME)).toBe("worker");
  expect(loadedScriptStrategy(settings, gated, HOME)).toBe("idle");

  const necessary = { ...ANALYTICS, category: "necessary" } as const;
  expect(loadedScriptStrategy({ ...settings, scripts: [necessary] }, necessary, HOME)).toBe(
    "worker",
  );
});

test("a category moves a script off worker only where worker is where it landed", () => {
  const gated = { ...CHAT, category: "marketing" } as const;
  const settings = {
    scripts: [gated],
    pages: { "/pricing": { chat: "worker" } },
    runtime: WORKER_SHAPED,
  } as const;

  expect(loadedScriptStrategy(settings, gated, HOME)).toBe("facade");
  expect(resolveScriptStrategy(settings, gated, PRICING)).toBe("worker");
  expect(loadedScriptStrategy(settings, gated, PRICING)).toBe("idle");
});

test("a site with no runtime loads its worker scripts on idle instead", () => {
  const settings = { scripts: [ANALYTICS] };

  expect(resolveScriptStrategy(settings, ANALYTICS, HOME)).toBe("worker");
  expect(loadedScriptStrategy(settings, ANALYTICS, HOME)).toBe("idle");
  expect(WORKER_FALLBACK_STRATEGY).toBe("idle");
});

test("the fallback reaches the worker strategy and no other", () => {
  const idle = { ...ANALYTICS, strategy: "idle" } as const;
  const interaction = { ...ANALYTICS, strategy: "interaction" } as const;
  const settings = { scripts: [idle, interaction, CHAT] };

  expect(loadedScriptStrategy(settings, idle, HOME)).toBe("idle");
  expect(loadedScriptStrategy(settings, interaction, HOME)).toBe("interaction");
  expect(loadedScriptStrategy(settings, CHAT, HOME)).toBe("facade");
});

test("the fallback is applied to the resolved strategy, not to the declared one", () => {
  const idle = { ...ANALYTICS, strategy: "idle" } as const;
  const settings = {
    scripts: [idle, CHAT],
    pageTypes: { "/**": { chat: "interaction" } },
    pages: { "/pricing": { analytics: "worker" } },
  } as const;

  expect(loadedScriptStrategy(settings, CHAT, HOME)).toBe("interaction");
  expect(loadedScriptStrategy(settings, idle, HOME)).toBe("idle");
  expect(loadedScriptStrategy(settings, idle, PRICING)).toBe("idle");
  expect(resolveScriptStrategy(settings, idle, PRICING)).toBe("worker");
});

test("two unlike mechanisms fit through one runtime contract", () => {
  const request = { scripts: [ANALYTICS, CHAT] };

  expect(WORKER_SHAPED(request)).toEqual([
    '<script type="module">startWorker(["https://example.com/analytics.js","https://example.com/chat.js"])</script>',
  ]);
  expect(PARTYTOWN_SHAPED(request)).toEqual([
    "<script>/* partytown snippet */</script>",
    '<script type="text/partytown" src="https://example.com/analytics.js"></script>',
    '<script type="text/partytown" src="https://example.com/chat.js"></script>',
  ]);
  expect(
    defineScripts({ scripts: [ANALYTICS], runtime: PARTYTOWN_SHAPED }).runtime,
  ).toBe(PARTYTOWN_SHAPED);
});

test("a runtime that is not a function is refused at construction", () => {
  expect(
    scriptsFaultReport(
      { scripts: [ANALYTICS], runtime: "partytown" },
      "Script settings",
    ),
  ).toBe(
    'Script settings: declares a script runtime this build cannot call — "partytown" — write the adapter the worker strategy loads through, as runtime: ({ scripts }) => ["<script>…</script>"]',
  );
});

test("a credential nested inside a refused value is cut with the rest", () => {
  expect(
    scriptsFaultReport(
      { scripts: [ANALYTICS], runtime: { url: "https://cdn.example/x?key=SECRET" } },
      "Script settings",
    ),
  ).toBe(
    'Script settings: declares a script runtime this build cannot call — {"url":"https://cdn.example/x?…"} — write the adapter the worker strategy loads through, as runtime: ({ scripts }) => ["<script>…</script>"]',
  );
});

test("the worker fallback is warned about once, naming every script it reaches", () => {
  const settings = {
    scripts: [ANALYTICS, { name: "pixel", src: "/pixel.js", strategy: "idle" }],
    pageTypes: { "/blog/**": { pixel: "worker" } },
  } as const;

  expect(workerFallbackWarning(settings)).toBe(
    [
      "Script runtime: 2 scripts can resolve to the worker strategy and this site configures no script runtime, so each of them loads on idle instead — worker moves a script off the main thread, and core ships no mechanism to do that with because a framework that picked one would carry a vendor's runtime into every site that never asked for it; this is a warning and not a refusal because idle is the fallback spec §12 states for this case, and a site that did not want off-main-thread loading is served correctly by it — supply build.scripts.runtime, or declare strategy: \"idle\" to say the fallback is what you meant:",
      '  "analytics" — declares no strategy, so it takes the worker default',
      '  "pixel" — pageTypes "/blog/**" sets "worker"',
    ].join("\n"),
  );
});

test("a script that can reach worker from both doors is named once", () => {
  const settings = {
    scripts: [{ name: "analytics", src: "/a.js", strategy: "worker" }],
    pages: { "/pricing": { analytics: "worker" } },
  } as const;

  expect(workerFallbackWarning(settings)).toContain(
    '  "analytics" — declares strategy "worker"',
  );
  expect(workerFallbackWarning(settings)).toContain(
    "1 script can resolve to the worker strategy and this site configures no script runtime, so it loads on idle instead",
  );
});

test("an override that takes a script off a page is not a door onto worker", () => {
  const settings = {
    scripts: [{ name: "pixel", src: "/pixel.js", strategy: "idle" }],
    pageTypes: { "/blog/**": { pixel: "off" } },
  } as const;

  expect(workerFallbackWarning(settings)).toBeUndefined();
});

test("a script off everywhere is still named where its declaration takes the worker default", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: { "/**": { analytics: "off" } },
  } as const;

  expect(workerFallbackWarning(settings)).toContain(
    '  "analytics" — declares no strategy, so it takes the worker default',
  );
});

test("a site with a runtime, and a site no script takes to worker, are both silent", () => {
  const reaching = { scripts: [ANALYTICS] };

  expect(workerFallbackWarning({ ...reaching, runtime: WORKER_SHAPED })).toBeUndefined();
  expect(
    workerFallbackWarning({
      scripts: [{ name: "analytics", src: "/a.js", strategy: "idle" }, CHAT],
    }),
  ).toBeUndefined();
  expect(workerFallbackWarning(undefined)).toBeUndefined();
});

const PIXEL: ScriptDeclaration = {
  name: "pixel",
  src: "https://example.com/pixel.js",
  strategy: "idle",
  category: "analytics",
};

const DE_HOME = { locale: "de", path: "/home" };

test("a category with no declared default is denied", () => {
  expect(resolveConsentDefault({ scripts: [PIXEL] }, "analytics", HOME)).toBe(
    "denied",
  );
  expect(DEFAULT_CONSENT).toBe("denied");
});

test("necessary is granted, and no default can move it", () => {
  expect(resolveConsentDefault({ scripts: [PIXEL] }, "necessary", HOME)).toBe(
    "granted",
  );
  expect(
    resolveConsentDefault(
      { scripts: [PIXEL], consentDefaults: { "/**": { analytics: "denied" } } },
      "necessary",
      HOME,
    ),
  ).toBe("granted");
});

test("a market that opts out by default grants its categories before anybody is asked", () => {
  const settings = {
    scripts: [PIXEL],
    consentDefaults: {
      "/**": { analytics: "denied" },
      "en:/**": { analytics: "granted" },
    },
  } as const;

  expect(resolveConsentDefault(settings, "analytics", HOME)).toBe("granted");
  expect(resolveConsentDefault(settings, "analytics", DE_HOME)).toBe("denied");
});

test("the winner is the most specific key that names this category", () => {
  const settings = {
    scripts: [PIXEL],
    consentDefaults: {
      "/**": { marketing: "granted" },
      "/checkout": { analytics: "granted" },
    },
  } as const;

  expect(
    resolveConsentDefault(settings, "marketing", { locale: "en", path: "/checkout" }),
  ).toBe("granted");
  expect(
    resolveConsentDefault(settings, "analytics", { locale: "en", path: "/home" }),
  ).toBe("denied");
});

test("functional is gated like the other two, and a market may grant it", () => {
  const embeds: ConsentDefaultMap = { "en:/**": { functional: "granted" } };
  const settings = {
    scripts: [{ ...PIXEL, category: "functional" }],
    consentDefaults: embeds,
  } as const;

  expect(resolveConsentDefault({ scripts: [PIXEL] }, "functional", HOME)).toBe(
    "denied",
  );
  expect(resolveConsentDefault(settings, "functional", HOME)).toBe("granted");
  expect(resolveConsentDefault(settings, "functional", DE_HOME)).toBe("denied");
  expect(scriptsFaultReport(settings, "Script settings")).toBeUndefined();
});

test("a category that is not one is refused at construction", () => {
  expect(
    scriptsFaultReport(
      { scripts: [{ ...ANALYTICS, category: "analytic" }] },
      "Script settings",
    ),
  ).toBe(
    [
      "Script settings: declares 1 script field that cannot be loaded from — declare each as the type its own line names:",
      '  scripts[0] — "category" — "analytic" — not a consent category — write one of: analytics, functional, marketing, necessary',
    ].join("\n"),
  );
});

test("a consent default no category can take is refused, with every fault of one key on its line", () => {
  const report = scriptsFaultReport(
    {
      scripts: [PIXEL],
      consentDefaults: {
        "/**": { analitycs: "denied", marketing: "maybe", necessary: "denied" },
      },
    },
    "Script settings",
  );

  expect(report).toBe(
    [
      'Script settings: "consentDefaults" declares 1 default no category can take — write a map of consent category to granted or denied, such as { "de:/**": { analytics: "denied" } }:',
      '  "/**" — "analitycs" — not a consent category — write one of: analytics, functional, marketing, necessary; "marketing" — "maybe" — not a consent default — write one of: granted, denied; "necessary" — a necessary script loads without waiting on consent, which is what the category means — delete the key, or give the script a category a visitor can withhold',
    ].join("\n"),
  );
});

test("a misspelled consent category is refused on the line the site wrote", () => {
  // The directive is the assertion: an unused `@ts-expect-error` fails typecheck (#483).
  const misspelled: ConsentDefaultMap = {
    // @ts-expect-error `marketting` is not a consent category
    "en:/**": { marketting: "granted" },
  };
  const every: ConsentDefaultMap = {
    "de:/**": { analytics: "denied", marketing: "denied" },
    "en:/**": { analytics: "granted", marketing: "granted" },
  };

  expect([misspelled, every]).toHaveLength(2);
  expect(
    resolveConsentDefault(
      { scripts: [PIXEL], consentDefaults: every },
      "marketing",
      HOME,
    ),
  ).toBe("granted");
});

test("a necessary consent default is refused on the line the site wrote", () => {
  const necessary: ConsentDefaultMap = {
    // @ts-expect-error a necessary script takes no consent default
    "/**": { necessary: "denied" },
  };

  expect(necessary).toBeDefined();
});

test("consentDefaults is spelled as the config spells it at the other door", () => {
  expect(
    scriptsFaultReport(
      { scripts: [PIXEL], consentDefaults: { blog: {} } },
      'Config "/site/pagedeck.config.ts"',
      "build.scripts",
    ),
  ).toContain(
    'Config "/site/pagedeck.config.ts": "build.scripts.consentDefaults" declares 1 key that is not a page pattern',
  );
});

test("consentDefaults is a settings field this build reads", () => {
  expect(
    scriptsFaultReport(
      { scripts: [PIXEL], consentDefault: {} },
      "Script settings",
    ),
  ).toBe(
    [
      "Script settings: declares 1 field this build does not read — delete the field, or correct it to one of: scripts, pageTypes, pages, runtime, consentDefaults:",
      '  "consentDefault"',
    ].join("\n"),
  );
});

test("a categorized script that reaches worker through a configured runtime is warned about once", () => {
  const settings = {
    scripts: [
      { ...ANALYTICS, category: "marketing" },
      { name: "pixel", src: "/pixel.js", strategy: "idle", category: "analytics" },
    ],
    pageTypes: { "/blog/**": { pixel: "worker" } },
    runtime: WORKER_SHAPED,
  } as const;

  expect(workerConsentWarning(settings)).toBe(
    [
      'Script consent: 2 scripts declare a consent category and can resolve to the worker strategy, so each of them loads on idle instead — the consent gate this build writes lives in the loader that backs the main-thread strategies, and a worker script is loaded by the elements build.scripts.runtime returned, which core never reads, so leaving it there would load a categorized script with no gate on it at all; this is a warning and not a refusal because idle is the fallback spec §12 states for a worker script this build cannot deliver, and it is the strategy the gate does reach — declare strategy: "idle" to say the downgrade is what you meant, or drop the category and gate the script inside the adapter, which is the only place a worker script can be gated:',
      '  "analytics" — category "marketing" — declares no strategy, so it takes the worker default',
      '  "pixel" — category "analytics" — pageTypes "/blog/**" sets "worker"',
    ].join("\n"),
  );

  expect(workerConsentWarning({ ...settings, runtime: undefined })).toBeUndefined();
  expect(workerConsentWarning({ scripts: [PIXEL], runtime: WORKER_SHAPED })).toBeUndefined();
  expect(workerConsentWarning(undefined)).toBeUndefined();
});

test("a script no page loads is warned about once, naming the override that took it off", () => {
  const settings = {
    scripts: [ANALYTICS, CHAT],
    pageTypes: { "/**": { analytics: "off" } },
  } as const;

  expect(unloadedScriptWarning(settings, [HOME, PRICING])).toBe(
    [
      'Script reach: 1 script resolves to "off" on every page this site builds, so no page loads it — this site builds 2 pages, and an override takes a script off every page its key covers, so a key that covers them all leaves a declaration nothing acts on while it still reads in the config like a script that loads; this is a warning and not a refusal because every field of the declaration is well formed and a site mid-migration may have taken a script off every page on purpose — drop the declaration from build.scripts.scripts, or narrow the override that takes it off so at least one page keeps it:',
      '  "analytics" — pageTypes "/**" sets "off"',
    ].join("\n"),
  );
});

test("two scripts off everywhere are one message, and a script off through two keys names both", () => {
  const settings = {
    scripts: [ANALYTICS, CHAT],
    pageTypes: { "/home": { analytics: "off" }, "/pricing": { analytics: "off" } },
    pages: { "/**": { chat: "off" } },
  } as const;

  expect(unloadedScriptWarning(settings, [HOME, PRICING])).toBe(
    [
      'Script reach: 2 scripts resolve to "off" on every page this site builds, so no page loads any of them — this site builds 2 pages, and an override takes a script off every page its key covers, so a key that covers them all leaves a declaration nothing acts on while it still reads in the config like a script that loads; this is a warning and not a refusal because every field of the declaration is well formed and a site mid-migration may have taken a script off every page on purpose — drop the declaration from build.scripts.scripts, or narrow the override that takes it off so at least one page keeps it:',
      '  "analytics" — pageTypes "/home" sets "off", pageTypes "/pricing" sets "off"',
      '  "chat" — pages "/**" sets "off"',
    ].join("\n"),
  );
});

test("the report is sorted, whatever order the config and the route table came in", () => {
  const settings = {
    scripts: [CHAT, ANALYTICS],
    pageTypes: { "/pricing": { analytics: "off" }, "/home": { analytics: "off" } },
    pages: { "/**": { chat: "off" } },
  } as const;

  expect(
    (unloadedScriptWarning(settings, [PRICING, HOME]) ?? "").split("\n").slice(1),
  ).toEqual([
    '  "analytics" — pageTypes "/home" sets "off", pageTypes "/pricing" sets "off"',
    '  "chat" — pages "/**" sets "off"',
  ]);
});

test("a script one narrower key turns back on is loaded, and is not on the list", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: { "/**": { analytics: "off" } },
    pages: { "/pricing": { analytics: "idle" } },
  } as const;

  expect(unloadedScriptWarning(settings, [HOME, PRICING])).toBeUndefined();
});

test("a site that overrides nothing, and a site with no script layer, are both silent", () => {
  expect(
    unloadedScriptWarning({ scripts: [ANALYTICS, CHAT] }, [HOME, PRICING]),
  ).toBeUndefined();
  expect(unloadedScriptWarning(undefined, [HOME])).toBeUndefined();
});

test("a build that rendered no pages names no script at all", () => {
  const settings = {
    scripts: [ANALYTICS],
    pageTypes: { "/**": { analytics: "off" } },
  } as const;

  expect(unloadedScriptWarning(settings, [])).toBeUndefined();
});
