import { existsSync, readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { ConfigError } from "@pagedeck/core";
import type {
  SocialImageAdapter,
  SocialImageRequest,
  SocialImageResult,
} from "@pagedeck/core";

type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

export interface SocialImageFont {
  readonly family: string;
  /** An absolute path to a `.ttf`, `.otf` or `.woff` file. */
  readonly src: string;
  /** Defaults to `400`. */
  readonly weight?: FontWeight;
  /** Defaults to `"normal"`. */
  readonly style?: "normal" | "italic";
}

export interface SocialImageOptions {
  readonly fonts: readonly SocialImageFont[];
}

const CARD = { width: 1200, height: 630 } as const;

const PALETTE = {
  ground: "#0b0d10",
  headline: "#f5f7fa",
  eyebrow: "#8a94a6",
  rule: "#2b323c",
} as const;

const NO_FONTS_FIX =
  'declare at least one font: defineSocialImage({ fonts: [{ family: "Fira Sans", src: "/site/fonts/FiraSans-Regular.ttf" }] })';
const MISSING_FONT_FIX =
  "point src at each font's real file, or remove the declaration";

function pageLabel(request: SocialImageRequest): string {
  return `${request.page.locale} ${request.page.path}`;
}

function textInput(
  request: SocialImageRequest,
  key: string,
): string | undefined {
  const value = request.inputs[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(
      `Social image: "build.socialImages.inputs" gave ${JSON.stringify(pageLabel(request))} a ${JSON.stringify(key)} that is not text — ${JSON.stringify(value)} — return ${JSON.stringify(key)} as a string, or leave it out`,
    );
  }
  return value;
}

// `satori` refuses a node without `display: flex`.
function card(input: { headline: string; eyebrow: string | undefined }): {
  type: string;
  props: Record<string, unknown>;
} {
  const children: unknown[] = [];
  if (input.eyebrow !== undefined) {
    children.push({
      type: "div",
      props: {
        style: {
          display: "flex",
          fontSize: 28,
          letterSpacing: 2,
          color: PALETTE.eyebrow,
        },
        children: input.eyebrow.toUpperCase(),
      },
    });
  }
  children.push({
    type: "div",
    props: {
      style: {
        display: "flex",
        width: 96,
        height: 6,
        marginTop: 24,
        marginBottom: 24,
        backgroundColor: PALETTE.rule,
      },
      children: "",
    },
  });
  children.push({
    type: "div",
    props: {
      style: {
        display: "flex",
        fontSize: 68,
        fontWeight: 600,
        lineHeight: 1.15,
        color: PALETTE.headline,
      },
      children: input.headline,
    },
  });

  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        width: "100%",
        height: "100%",
        padding: 72,
        backgroundColor: PALETTE.ground,
      },
      children,
    },
  };
}

export function defineSocialImage(
  options: SocialImageOptions,
): SocialImageAdapter {
  if (options.fonts.length === 0) {
    throw new ConfigError(
      `Social image: defineSocialImage was given no fonts, and text cannot be shaped without one — ${NO_FONTS_FIX}`,
    );
  }

  const missing = options.fonts.filter((font) => !existsSync(font.src));
  if (missing.length > 0) {
    throw new ConfigError(
      `Social image: defineSocialImage was given ${String(missing.length)} ${
        missing.length === 1 ? "font" : "fonts"
      } whose file does not exist — ${MISSING_FONT_FIX}:\n${missing
        .map(
          (font) =>
            `  ${JSON.stringify(font.family)} — ${JSON.stringify(font.src)} does not exist`,
        )
        .join("\n")}`,
    );
  }

  const fonts = options.fonts.map((font) => ({
    name: font.family,
    data: readFileSync(font.src),
    weight: font.weight ?? (400 as FontWeight),
    style: font.style ?? ("normal" as const),
  }));
  const fontFamily = options.fonts[0]?.family ?? "";

  return {
    name: "@pagedeck/social-image",
    async draw(request: SocialImageRequest): Promise<SocialImageResult> {
      const headline = textInput(request, "headline") ?? request.title;
      if (headline === undefined || headline.trim() === "") {
        throw new ConfigError(
          `Social image: ${JSON.stringify(pageLabel(request))} has no headline to draw — give the page a title in "build.head", or return a "headline" string from "build.socialImages.inputs"`,
        );
      }

      const svg = await satori(
        // `satori` walks a plain object tree shaped like a `ReactElement`; this
        // package has no React.
        card({
          headline,
          eyebrow: textInput(request, "eyebrow"),
        }) as Parameters<typeof satori>[0],
        {
          width: CARD.width,
          height: CARD.height,
          fonts,
          embedFont: true,
        },
      );

      const png = new Resvg(svg, {
        // The build machine's own fonts would make the card depend on the build agent.
        font: { loadSystemFonts: false, defaultFontFamily: fontFamily },
      })
        .render()
        .asPng();

      return { bytes: png, width: CARD.width, height: CARD.height };
    },
  };
}
