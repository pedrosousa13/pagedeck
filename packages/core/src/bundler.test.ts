import { build } from "vite";
import type { Plugin } from "vite";
import { expect, test } from "vitest";
import { runBundle } from "./bundler.js";
import { ConfigError } from "./exit.js";

const ENTRY = "\0fw:bundler-test/entry";

function serveEntry(): Plugin {
  return {
    name: "pagedeck:bundler-test-entry",
    resolveId(source) {
      return source === ENTRY ? ENTRY : undefined;
    },
    load(id) {
      return id === ENTRY ? "export default 1;\n" : undefined;
    },
  };
}

const CONFIG = {
  configFile: false,
  envDir: false,
  logLevel: "silent",
  root: import.meta.dirname,
  build: {
    write: false,
    rolldownOptions: { input: { entry: ENTRY } },
  },
} as const;

async function thrownBy(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

test("a ConfigError a hook throws reaches the caller as itself, cause and all", async () => {
  const refusal = new ConfigError("Bundler test: refused", {
    cause: new Error("what actually broke"),
  });
  const refusing: Plugin = {
    name: "pagedeck:bundler-test-refusing",
    transform() {
      throw refusal;
    },
  };

  const bare = await thrownBy(async () =>
    build({ ...CONFIG, plugins: [serveEntry(), refusing] }),
  );
  expect(bare).toBeInstanceOf(Error);
  expect(bare).not.toBeInstanceOf(ConfigError);
  expect((bare as Error).cause).toBeUndefined();

  const guarded = await thrownBy(async () =>
    runBundle({ plugins: [serveEntry(), refusing], config: CONFIG }),
  );
  expect(guarded).toBe(refusal);
  expect(guarded).toBeInstanceOf(ConfigError);
  expect((guarded as ConfigError).cause).toBe(refusal.cause);
}, 120_000);

test("a hook that rejects is recorded like one that threw", async () => {
  const refusal = new ConfigError("Bundler test: refused asynchronously");
  const guarded = await thrownBy(async () =>
    runBundle({
      plugins: [
        serveEntry(),
        {
          name: "pagedeck:bundler-test-rejecting",
          async transform() {
            await Promise.resolve();
            throw refusal;
          },
        },
      ],
      config: CONFIG,
    }),
  );

  expect(guarded).toBe(refusal);
}, 120_000);

test("a hook written in the object form is guarded through its handler", async () => {
  const refusal = new ConfigError("Bundler test: refused from a handler");
  const guarded = await thrownBy(async () =>
    runBundle({
      plugins: [
        serveEntry(),
        {
          name: "pagedeck:bundler-test-object-hook",
          transform: {
            order: "pre",
            handler() {
              throw refusal;
            },
          },
        },
      ],
      config: CONFIG,
    }),
  );

  expect(guarded).toBe(refusal);
}, 120_000);

test("a throw that is not an Error arrives as one, quoting what was thrown", async () => {
  const guarded = await thrownBy(async () =>
    runBundle({
      plugins: [
        serveEntry(),
        {
          name: "pagedeck:bundler-test-throws-a-string",
          transform() {
            throw "not an error";
          },
        },
      ],
      config: CONFIG,
    }),
  );

  expect(guarded).toBeInstanceOf(Error);
  expect((guarded as Error).message).toBe("not an error");
}, 120_000);

test("a fault is caught at every hook position #225 measured the flattening at", async () => {
  for (const hook of ["buildEnd", "generateBundle"] as const) {
    const refusal = new ConfigError(`Bundler test: refused from ${hook}`);
    const guarded = await thrownBy(async () =>
      runBundle({
        plugins: [
          serveEntry(),
          {
            name: `pagedeck:bundler-test-${hook}`,
            [hook]: () => {
              throw refusal;
            },
          },
        ],
        config: CONFIG,
      }),
    );

    expect(guarded, hook).toBe(refusal);
  }
}, 120_000);

test("a throw from applyToEnvironment is not flattened, which is why it is not guarded", async () => {
  const refusal = new ConfigError("Bundler test: refused before the build", {
    cause: new Error("what actually broke"),
  });
  const caught = await thrownBy(async () =>
    build({
      ...CONFIG,
      plugins: [
        serveEntry(),
        {
          name: "pagedeck:bundler-test-environment-throw",
          applyToEnvironment() {
            throw refusal;
          },
        },
      ],
    }),
  );

  expect(caught).toBe(refusal);
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as ConfigError).cause).toBe(refusal.cause);
}, 120_000);

test("a plugin whose applyToEnvironment answers undefined is dropped from the build", async () => {
  const ran: string[] = [];
  const counting = (name: string, applies: boolean | undefined): Plugin => ({
    name,
    applyToEnvironment: () => applies as boolean,
    transform() {
      ran.push(name);
      return null;
    },
  });

  await build({
    ...CONFIG,
    plugins: [serveEntry(), counting("applies", true), counting("silent", undefined)],
  });

  expect(ran).toContain("applies");
  expect(ran).not.toContain("silent");
}, 120_000);

test("the first fault recorded is the one thrown", async () => {
  const first = new ConfigError("Bundler test: the first fault");
  const second = new ConfigError("Bundler test: the second fault");
  const guarded = await thrownBy(async () =>
    runBundle({
      plugins: [
        serveEntry(),
        {
          name: "pagedeck:bundler-test-two-faults",
          // `buildStart` runs before any module loads, so the order is the bundler's own.
          buildStart() {
            throw first;
          },
          transform() {
            throw second;
          },
        },
      ],
      config: CONFIG,
    }),
  );

  expect(guarded).toBe(first);
}, 120_000);

test("a build that failed on its own rethrows unchanged", async () => {
  const guarded = await thrownBy(async () =>
    runBundle({
      plugins: [],
      config: {
        ...CONFIG,
        build: {
          write: false,
          rolldownOptions: { input: { entry: "./nothing-is-here.js" } },
        },
      },
    }),
  );

  expect(guarded).toBeInstanceOf(Error);
  expect(guarded).not.toBeInstanceOf(ConfigError);
}, 120_000);

test("a site plugin throwing from a hook is left to the bundler", async () => {
  const refusal = new ConfigError("Bundler test: a site plugin refused");
  const guarded = await thrownBy(async () =>
    runBundle({
      plugins: [serveEntry()],
      sitePlugins: [
        {
          name: "site:refusing",
          transform() {
            throw refusal;
          },
        },
      ],
      config: CONFIG,
    }),
  );

  expect(guarded).not.toBe(refusal);
  expect(guarded).not.toBeInstanceOf(ConfigError);
}, 120_000);

test("a build nothing faulted in returns what the bundler emitted", async () => {
  const result = await runBundle({
    plugins: [serveEntry()],
    config: CONFIG,
  });

  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap((one) =>
    "output" in one
      ? one.output.filter((emitted) => emitted.type === "chunk")
      : [],
  );
  expect(chunks.map((chunk) => chunk.name)).toEqual(["entry"]);
}, 120_000);
