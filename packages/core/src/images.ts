import { ConfigError } from "./exit.js";
import { quote } from "./quote.js";
import type { PageContext } from "@pagedeck/islands";
import { entryId } from "@pagedeck/islands";
import { RenderError } from "./tree.js";

export type ImageAdapter = (request: ImageRequest) => string;

export interface ImageRequest {
  readonly src: string;
  readonly width: number;
  readonly quality: number;
  readonly format: string;
}

export interface ImagesSetting {
  readonly adapter: ImageAdapter;
  readonly widths: readonly number[];
  readonly quality: number;
  readonly format: string;
  readonly sizes?: string;
}

export const DEFAULT_IMAGE_SIZES = "100vw";

export interface ImageSource {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly sizes?: string;
  readonly aboveFold?: boolean;
  readonly placeholderColor?: string;
}

export interface ImageAttributes {
  readonly src: string;
  readonly srcSet: string;
  readonly sizes: string;
  readonly width: number;
  readonly height: number;
  readonly loading: "lazy" | "eager";
  readonly fetchPriority: "high" | "auto";
  readonly style?: { readonly backgroundColor: string };
}

export interface ImageAttributesInput {
  readonly images: ImagesSetting;
  readonly image: ImageSource;
  readonly page: PageContext;
}

export function imageAttributes(input: ImageAttributesInput): ImageAttributes {
  const { images, image, page } = input;
  refuseUnusableImage(image, page);

  const widths = candidateWidths(images.widths, image.width);
  const url = (width: number): string =>
    images.adapter({
      src: image.src,
      width,
      quality: images.quality,
      format: images.format,
    });

  return {
    src: url(widths[widths.length - 1] as number),
    srcSet: widths
      .map((width) => `${url(width)} ${String(width)}w`)
      .join(", "),
    sizes: image.sizes ?? images.sizes ?? DEFAULT_IMAGE_SIZES,
    width: image.width,
    height: image.height,
    loading: image.aboveFold === true ? "eager" : "lazy",
    fetchPriority: image.aboveFold === true ? "high" : "auto",
    ...(image.placeholderColor === undefined
      ? {}
      : { style: { backgroundColor: image.placeholderColor } }),
  };
}

function candidateWidths(
  declared: readonly number[],
  intrinsic: number,
): readonly number[] {
  const usable = [...new Set(declared)]
    .filter((width) => width <= intrinsic)
    .sort((a, b) => a - b);
  return usable.length === 0 ? [intrinsic] : usable;
}

const SOURCE_FIX = 'pass the asset\'s own path or URL, such as "/hero.jpg"';
const DIMENSION_FIX = "pass the asset's own pixel width and height";

function refuseUnusableImage(image: ImageSource, page: PageContext): void {
  const where = `Entry ${entryId(page)}`;
  const sections: string[] = [];

  const source = sourceFault(image.src);
  if (source !== undefined) {
    sections.push(
      `${where}: image source is not usable, so no URL can be built for it — ${SOURCE_FIX}:\n  ${source}`,
    );
  }

  const dimensions = [
    ["width", image.width],
    ["height", image.height],
  ] as const;
  const faults = dimensions.flatMap(([field, value]) => {
    const reason = dimensionFault(value);
    return reason === undefined
      ? []
      : [`  ${field} — ${quote(value)} — ${reason}`];
  });
  if (faults.length > 0) {
    const subject =
      source === undefined
        ? `image ${quote(image.src)} declares`
        : "image declares";
    const count =
      faults.length === 1
        ? "1 intrinsic dimension that is not a pixel size"
        : `${String(faults.length)} intrinsic dimensions that are not pixel sizes`;
    sections.push(
      `${where}: ${subject} ${count}, so the browser reserves no space for it and the page shifts as it loads — ${DIMENSION_FIX}:\n${faults.join("\n")}`,
    );
  }

  if (sections.length > 0) throw new RenderError(sections.join("\n\n"));
}

function sourceFault(src: unknown): string | undefined {
  if (typeof src !== "string") return "not a string";
  if (src === "") return `${quote(src)} — the source is empty`;
  if (src.trim() === "") return `${quote(src)} — the source is only whitespace`;
  try {
    encodeURI(src);
  } catch {
    return `${quote(src)} — the source cannot be percent-encoded, which a lone surrogate is the only cause of`;
  }
  return undefined;
}

function dimensionFault(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
  if (!Number.isInteger(value) || value <= 0) {
    return "not a whole number of pixels above zero";
  }
  return undefined;
}

const PLACEHOLDERS = ["src", "srcParam", "width", "quality", "format"] as const;

const PLACEHOLDER = /\{(\w*)\}/g;

const TEMPLATE_EXAMPLE = '"https://cdn.example{src}?w={width}"';

/**
 * The comma is here only because srcset strips a URL's trailing commas; the
 * `", "` join between entries is safe.
 */
const PATH_DELIMITERS = /[?#&=+,]/g;

export function urlTemplate(template: string): ImageAdapter {
  const found = [...template.matchAll(PLACEHOLDER)].map(
    ([, name]) => name as string,
  );
  const sections: string[] = [];

  if (!found.includes("src") && !found.includes("srcParam")) {
    sections.push(
      `Image URL template: holds no "{src}" or "{srcParam}" placeholder, so every image would get the same URL — write the source where the CDN takes it, {src} in a path or {srcParam} in a query parameter, as ${TEMPLATE_EXAMPLE}`,
    );
  }
  if (!found.includes("width")) {
    sections.push(
      `Image URL template: holds no "{width}" placeholder, so every srcset entry would be the same URL — write the CDN's width parameter as {width}, as ${TEMPLATE_EXAMPLE}`,
    );
  }
  const unknown = found.filter(
    (name) => !(PLACEHOLDERS as readonly string[]).includes(name),
  );
  if (unknown.length > 0) {
    const lines = unknown.map((name) => `  "{${name}}"`).join("\n");
    sections.push(
      `Image URL template: holds ${String(unknown.length)} ${
        unknown.length === 1 ? "placeholder" : "placeholders"
      } this adapter cannot fill — correct each to one of: ${PLACEHOLDERS.map(
        (name) => `{${name}}`,
      ).join(", ")}:\n${lines}`,
    );
  }
  if (sections.length > 0) throw new ConfigError(sections.join("\n\n"));

  // One pass, so a value that spells a placeholder is never expanded again.
  return (request) =>
    template.replace(PLACEHOLDER, (_match, name: string) =>
      fill(name, request),
    );
}

function fill(name: string, request: ImageRequest): string {
  switch (name) {
    case "src":
      return encodeURI(request.src).replace(
        PATH_DELIMITERS,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    case "srcParam":
      return encodeURIComponent(request.src);
    case "width":
      return String(request.width);
    case "quality":
      return String(request.quality);
    default:
      return encodeURIComponent(request.format);
  }
}

const IMAGES_SHAPE_FIX =
  'images: { adapter: urlTemplate("https://cdn.example{src}?w={width}&q={quality}&fm={format}"), widths: [640, 1280], quality: 70, format: "auto" }';
const IMAGES_UNKNOWN_FIX = `delete the field, or correct it to one of: ${["adapter", "widths", "quality", "format", "sizes"].join(", ")}`;
const IMAGES_FIELD_FIX = "declare each as the type its own line names";
const IMAGES_WIDTH_FIX =
  "write each as a whole number of pixels above zero, such as widths: [640, 1280]";
const IMAGES_EMPTY_FIX = "list at least one, such as widths: [640, 1280]";

export function defineImages(settings: ImagesSetting): ImagesSetting {
  const report = imagesFaultReport(settings);
  if (report !== undefined) throw new ConfigError(report);
  return settings;
}

const IMAGES_WHERE = "Image settings";

function imagesFaultReport(value: unknown): string | undefined {
  const where = IMAGES_WHERE;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${where}: must be an object declaring an adapter, widths, quality and format — ${IMAGES_SHAPE_FIX}`;
  }
  const record = value as Record<string, unknown>;
  const sections: string[] = [];

  const unknownFields = Object.keys(record).filter(
    (key) => !IMAGES_FIELDS.includes(key),
  );
  if (unknownFields.length > 0) {
    const lines = unknownFields
      .map((key) => `  ${JSON.stringify(key)}`)
      .join("\n");
    sections.push(
      `${where}: declare${unknownFields.length === 1 ? "s 1 field" : `s ${String(unknownFields.length)} fields`} this build does not read — ${IMAGES_UNKNOWN_FIX}:\n${lines}`,
    );
  }

  const read = (field: string): unknown =>
    Object.hasOwn(record, field) ? record[field] : undefined;
  const fields = [
    ["adapter", adapterFault(read("adapter"))],
    ["widths", widthsFault(read("widths"))],
    ["quality", qualityFault(read("quality"))],
    ["format", formatFault(read("format"))],
    ["sizes", sizesFault(read("sizes"))],
  ] as const;
  const faults = fields.flatMap(([field, reason]) =>
    reason === undefined ? [] : [`  ${JSON.stringify(field)} — ${reason}`],
  );
  if (faults.length > 0) {
    sections.push(
      `${where}: declare${
        faults.length === 1
          ? "s 1 field images cannot be built from"
          : `s ${String(faults.length)} fields images cannot be built from`
      } — ${IMAGES_FIELD_FIX}:\n${faults.join("\n")}`,
    );
  }

  const widths = read("widths");
  if (Array.isArray(widths)) {
    if (widths.length === 0) {
      sections.push(
        `${where}: declares no widths, so there is no srcset entry to build — ${IMAGES_EMPTY_FIX}`,
      );
    }
    const bad = (widths as readonly unknown[]).flatMap((width, index) => {
      const reason = dimensionFault(width);
      return reason === undefined
        ? []
        : [`  widths[${String(index)}] — ${quote(width)} — ${reason}`];
    });
    if (bad.length > 0) {
      sections.push(
        `${where}: declare${
          bad.length === 1
            ? "s 1 width that is not a pixel width"
            : `s ${String(bad.length)} widths that are not pixel widths`
        } — ${IMAGES_WIDTH_FIX}:\n${bad.join("\n")}`,
      );
    }
  }

  return sections.length === 0 ? undefined : sections.join("\n\n");
}

const IMAGES_FIELDS = ["adapter", "widths", "quality", "format", "sizes"];

function adapterFault(value: unknown): string | undefined {
  if (typeof value === "function") return undefined;
  return `not a function — pass a function of (src, width, quality, format) returning a URL, or urlTemplate(${TEMPLATE_EXAMPLE})`;
}

function widthsFault(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return "not an array — write a list of pixel widths, such as widths: [640, 1280]";
  }
  return undefined;
}

function qualityFault(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isNaN(value)) return undefined;
  return `${quote(value)} — not a number — write the number your CDN's quality scale takes, such as 70`;
}

function formatFault(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return undefined;
  return `${quote(value)} — not a format the adapter can pass on — write the token your CDN takes, such as "auto"`;
}

function sizesFault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() !== "") return undefined;
  return `${quote(value)} — not a sizes attribute — write a CSS sizes list, such as "(min-width: 60rem) 50vw, 100vw"`;
}
