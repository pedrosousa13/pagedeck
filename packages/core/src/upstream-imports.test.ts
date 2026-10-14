import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildClient } from "./client-build.js";
import type { ClientBuild } from "./client-build.js";
import { planEntries } from "./entries.js";
import { ConfigError } from "./exit.js";
import type { UpstreamRule } from "./routing.js";
import { planTiers } from "./tiers.js";
import { upstreamImportCheck, upstreamSources } from "./upstream-imports.js";

const FIXTURE_DIR = fileURLToPath(
  new URL("../node_modules/.pagedeck-upstream-imports-test/", import.meta.url),
);
const ORIGIN = `${FIXTURE_DIR}pagedeck.config.js`;

const APP_MARKER = "app-secret-9f2c";
const SERVER_MARKER = "server-secret-41ad";

const FIXTURE: Record<string, string> = {
  "app/index.ts": `export const SECRET = "${APP_MARKER}";\nexport type AppType = { ok: true };\n`,
  "server.ts": `export const KEY = "${SERVER_MARKER}";\n`,
  "src/Cart.tsx": `import { SECRET } from "../app/index.ts";\nexport default function Cart() { return <p>{SECRET}</p>; }\n`,
  "src/helper.ts": `import { SECRET } from "../app/index.ts";\nexport function label() { return SECRET; }\n`,
  "src/Badge.tsx": `import { label } from "./helper.ts";\nexport default function Badge() { return <p>{label()}</p>; }\n`,
  "src/Typed.tsx": `import type { AppType } from "../app/index.ts";\nconst ok: AppType["ok"] = true;\nexport default function Typed() { return <p>{String(ok)} typed-7c1e</p>; }\n`,
  "src/Key.tsx": `import { KEY } from "../server.ts";\nexport default function Key() { return <p>{KEY}</p>; }\n`,
};

const MODULES = {
  Cart: "./src/Cart.tsx",
  Badge: "./src/Badge.tsx",
  Typed: "./src/Typed.tsx",
  Key: "./src/Key.tsx",
};

const FIX =
  'import only the app\'s types, with "import type", or move the code both need out of the app\'s source';
const SOURCE_FIX =
  'write the path of the app\'s file or directory, relative to the site root, such as "app/"';

beforeAll(() => {
  for (const [file, source] of Object.entries(FIXTURE)) {
    mkdirSync(dirname(`${FIXTURE_DIR}${file}`), { recursive: true });
    writeFileSync(`${FIXTURE_DIR}${file}`, source);
  }
  writeFileSync(ORIGIN, "export default {};\n");
});

afterAll(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

async function built(
  islands: readonly (keyof typeof MODULES)[],
  upstreams: readonly UpstreamRule[],
): Promise<ClientBuild> {
  const plan = planEntries(
    [
      {
        page: { locale: "en", path: "/", output: "/en", dependencies: [] },
        islands: islands.map((component) => ({
          component,
          mode: "load" as const,
        })),
      },
    ],
    { modules: MODULES },
  );
  return await buildClient({
    root: FIXTURE_DIR,
    origin: ORIGIN,
    plan,
    tiers: planTiers({
      entries: plan.entries,
      ranking: [],
      policy: { minSize: 0 },
    }),
    upstreams,
  });
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("the build did not fail");
  return outcome;
}

function textOf(contents: string | Uint8Array): string {
  return typeof contents === "string"
    ? contents
    : new TextDecoder().decode(contents);
}

test("a value import of the app's directory from an island is refused", async () => {
  const error = await refusal(
    built(["Cart"], [{ prefix: "/api/", source: "app/" }]),
  );
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Client build: 1 import from island code reaches the source of an upstream app, so the app's code would ship to the browser — ${FIX}:`,
      '  "./src/Cart.tsx" imports "../app/index.ts" — build.routing.upstreams[0] source "app/"',
    ].join("\n"),
  );
}, 60_000);

test("an import one module removed from the island is refused, naming that module", async () => {
  const error = await refusal(
    built(["Badge"], [{ prefix: "/api/", source: "app" }]),
  );
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Client build: 1 import from island code reaches the source of an upstream app, so the app's code would ship to the browser — ${FIX}:`,
      '  "./src/helper.ts" imports "../app/index.ts" — build.routing.upstreams[0] source "app"',
    ].join("\n"),
  );
}, 60_000);

test("a type-only import of the app builds, and no chunk holds the app's code", async () => {
  const build = await built(["Typed"], [{ prefix: "/api/", source: "app/" }]);
  const text = build.files.map((file) => textOf(file.contents)).join("\n");
  expect(text).toContain("typed-7c1e");
  expect(text).not.toContain(APP_MARKER);
}, 60_000);

test("a source naming one file refuses an import of that file", async () => {
  const error = await refusal(
    built(["Key", "Typed"], [{ prefix: "/rpc/", source: "./server.ts" }]),
  );
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Client build: 1 import from island code reaches the source of an upstream app, so the app's code would ship to the browser — ${FIX}:`,
      '  "./src/Key.tsx" imports "../server.ts" — build.routing.upstreams[0] source "./server.ts"',
    ].join("\n"),
  );
}, 60_000);

test("every import that reaches an app's source is reported in one refusal", async () => {
  const error = await refusal(
    built(
      ["Cart", "Badge", "Key"],
      [
        { prefix: "/api/", source: "app/" },
        { prefix: "/rpc/" },
        { prefix: "/hooks/", source: "server.ts" },
      ],
    ),
  );
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Client build: 3 imports from island code reach the source of an upstream app, so the app's code would ship to the browser — ${FIX}:`,
      '  "./src/Cart.tsx" imports "../app/index.ts" — build.routing.upstreams[0] source "app/"',
      '  "./src/Key.tsx" imports "../server.ts" — build.routing.upstreams[2] source "server.ts"',
      '  "./src/helper.ts" imports "../app/index.ts" — build.routing.upstreams[0] source "app/"',
    ].join("\n"),
  );
}, 60_000);

test("a source that is not on disk is refused, beside every other", async () => {
  const error = await refusal(
    built(
      ["Typed"],
      [
        { prefix: "/api/", source: "apps/" },
        { prefix: "/rpc/", source: "app/" },
        { prefix: "/hooks/", source: "hooks.ts" },
      ],
    ),
  );
  expect(error).toBeInstanceOf(ConfigError);
  expect(error.message).toBe(
    [
      `Config "${ORIGIN}": "build.routing" declares 2 upstream fields this build cannot route to — correct each as its own line says:`,
      `  upstreams[0] — "source" — "apps/" — nothing is on disk at "${FIXTURE_DIR}apps" — ${SOURCE_FIX}`,
      `  upstreams[2] — "source" — "hooks.ts" — nothing is on disk at "${FIXTURE_DIR}hooks.ts" — ${SOURCE_FIX}`,
    ].join("\n"),
  );
});

test("in a dev server the check passes every import a server-side load makes, and reports a browser module's", async () => {
  const reached: string[][] = [];
  const { sources } = upstreamSources(FIXTURE_DIR, ORIGIN, [
    { prefix: "/api/", source: "app/" },
  ]);
  const server = await createServer({
    configFile: false,
    logLevel: "silent",
    root: FIXTURE_DIR,
    appType: "custom",
    server: { middlewareMode: true, hmr: false, ws: false },
    plugins: [
      upstreamImportCheck({
        root: FIXTURE_DIR,
        origin: ORIGIN,
        sources: () => sources,
        entryName: () => undefined,
        reached: (lines) => reached.push([...lines]),
      }),
    ],
  });
  try {
    const helper = (await server.ssrLoadModule("/src/helper.ts")) as {
      label(): string;
    };
    expect(helper.label()).toBe(APP_MARKER);
    expect(reached).toEqual([]);

    await server.transformRequest("/src/helper.ts");
    expect(reached).toEqual([
      [
        '  "./src/helper.ts" imports "../app/index.ts" — build.routing.upstreams[0] source "app/"',
      ],
    ]);
  } finally {
    await server.close();
  }
}, 60_000);
