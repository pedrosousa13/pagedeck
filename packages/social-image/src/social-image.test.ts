import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "@pagedeck/core";
import { expect, test } from "vitest";
import { defineSocialImage } from "./social-image.js";

const FONT = join(
  import.meta.dirname,
  "..",
  "..",
  "site",
  "fonts",
  "FiraSans-Regular.ttf",
);

if (!existsSync(FONT)) {
  throw new Error(
    `Social image tests: the fixture font ${JSON.stringify(FONT)} does not exist — point FONT at a real font file, or add one to this package`,
  );
}

const FONTS = [{ family: "Fira Sans", src: FONT }];

const PAGE = { locale: "en", path: "/pricing" } as never;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test("a card is a PNG at the size the adapter reports", async () => {
  const result = await defineSocialImage({ fonts: FONTS }).draw({
    page: PAGE,
    title: "What it costs",
    inputs: {},
  });

  expect([...result.bytes.subarray(0, 8)]).toEqual(PNG_MAGIC);
  const header = Buffer.from(result.bytes);
  expect(header.readUInt32BE(16)).toBe(result.width);
  expect(header.readUInt32BE(20)).toBe(result.height);
});

test("the adapter is reported by a name of its own", () => {
  expect(defineSocialImage({ fonts: FONTS }).name).toBe("@pagedeck/social-image");
});

test("two adapters drawing one request produce byte-identical cards", async () => {
  const request = {
    page: PAGE,
    title: "What it costs",
    inputs: { eyebrow: "Docs" },
  };

  const first = await defineSocialImage({ fonts: FONTS }).draw(request);
  const second = await defineSocialImage({ fonts: FONTS }).draw(request);

  expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true);
});

test("a card the site gave no headline for is refused as config", async () => {
  const thrown: unknown = await Promise.resolve(
    defineSocialImage({ fonts: FONTS }).draw({
      page: PAGE,
      title: undefined,
      inputs: {},
    }),
  ).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toContain("en /pricing");
  expect((thrown as Error).message).toContain("headline");
});

test("a headline the site declared as something other than text is refused", async () => {
  const thrown: unknown = await Promise.resolve(
    defineSocialImage({ fonts: FONTS }).draw({
      page: PAGE,
      title: "What it costs",
      inputs: { headline: 7 },
    }),
  ).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toContain('"headline"');
  expect((thrown as Error).message).toContain("7");
});

test("a declared headline is drawn instead of the page's title", async () => {
  const adapter = defineSocialImage({ fonts: FONTS });
  const fromTitle = await adapter.draw({
    page: PAGE,
    title: "What it costs",
    inputs: {},
  });
  const fromInputs = await adapter.draw({
    page: PAGE,
    title: "What it costs",
    inputs: { headline: "Pricing, plainly" },
  });

  expect(
    Buffer.from(fromInputs.bytes).equals(Buffer.from(fromTitle.bytes)),
  ).toBe(false);
});

test("an eyebrow the site declared as something other than text is refused", async () => {
  const thrown: unknown = await Promise.resolve(
    defineSocialImage({ fonts: FONTS }).draw({
      page: PAGE,
      title: "What it costs",
      inputs: { eyebrow: [] },
    }),
  ).catch((error: unknown) => error);

  expect(thrown).toBeInstanceOf(ConfigError);
  expect((thrown as Error).message).toContain('"eyebrow"');
});

test("an adapter declared with no font is refused where it is constructed", () => {
  expect(() => defineSocialImage({ fonts: [] })).toThrow(ConfigError);
});

test("every font file that does not exist is named in one refusal", () => {
  let message = "";
  try {
    defineSocialImage({
      fonts: [
        { family: "Fira Sans", src: FONT },
        { family: "Missing One", src: "/no/such/one.ttf" },
        { family: "Missing Two", src: "/no/such/two.ttf" },
      ],
    });
  } catch (error) {
    message = (error as Error).message;
  }

  expect(message).toContain("2 fonts");
  expect(message).toContain("/no/such/one.ttf");
  expect(message).toContain("/no/such/two.ttf");
  expect(message).not.toContain("FiraSans-Regular.ttf");
});
