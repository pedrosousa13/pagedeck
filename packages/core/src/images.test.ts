import { expect, test } from "vitest";
import { ConfigError } from "./exit.js";
import {
  DEFAULT_IMAGE_SIZES,
  defineImages,
  imageAttributes,
  urlTemplate,
} from "./images.js";
import type { ImagesSetting } from "./images.js";
import { RenderError } from "./tree.js";

const PAGE = { locale: "en", path: "/home" } as const;

// Out of order and holding a duplicate on purpose: srcset order must come from the
// value, not from how it was written.
const IMAGES: ImagesSetting = {
  adapter: urlTemplate(
    "https://cdn.example{src}?w={width}&q={quality}&fm={format}",
  ),
  widths: [1280, 640, 1280, 320],
  quality: 70,
  format: "auto",
};

test("a url template fills the four contract parameters", () => {
  const adapter = urlTemplate(
    "https://cdn.example{src}?w={width}&q={quality}&fm={format}",
  );

  expect(
    adapter({ src: "/photos/hero.jpg", width: 640, quality: 70, format: "webp" }),
  ).toBe("https://cdn.example/photos/hero.jpg?w=640&q=70&fm=webp");
});

test("a url template keeps the source's slashes and escapes what would restructure the URL", () => {
  const adapter = urlTemplate("https://cdn.example{src}?w={width}");

  expect(
    adapter({
      src: "/a b/c&d.jpg",
      width: 320,
      quality: 70,
      format: "auto",
    }),
  ).toBe("https://cdn.example/a%20b/c%26d.jpg?w=320");
});

test("a url template encodes a source that sits in a query parameter", () => {
  const adapter = urlTemplate("https://cdn.example/resize?url={srcParam}&w={width}");

  expect(
    adapter({ src: "/a/b.jpg", width: 320, quality: 70, format: "auto" }),
  ).toBe("https://cdn.example/resize?url=%2Fa%2Fb.jpg&w=320");
});

test("a url template refuses a template that would build one URL for every image", () => {
  const error: unknown = (() => {
    try {
      urlTemplate("https://cdn.example/fixed.jpg");
    } catch (thrown: unknown) {
      return thrown;
    }
    return undefined;
  })();

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    'Image URL template: holds no "{src}" or "{srcParam}" placeholder, so every image would get the same URL — write the source where the CDN takes it, {src} in a path or {srcParam} in a query parameter, as "https://cdn.example{src}?w={width}"\n\n' +
      'Image URL template: holds no "{width}" placeholder, so every srcset entry would be the same URL — write the CDN\'s width parameter as {width}, as "https://cdn.example{src}?w={width}"',
  );
});

test("a url template refuses a placeholder it cannot fill", () => {
  const error: unknown = (() => {
    try {
      urlTemplate("https://cdn.example{src}?w={width}&q={quailty}");
    } catch (thrown: unknown) {
      return thrown;
    }
    return undefined;
  })();

  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe(
    'Image URL template: holds 1 placeholder this adapter cannot fill — correct each to one of: {src}, {srcParam}, {width}, {quality}, {format}:\n  "{quailty}"',
  );
});

test("an image carries srcset, sizes, intrinsic dimensions and a loading mode", () => {
  const attributes = imageAttributes({
    images: IMAGES,
    image: { src: "/hero.jpg", width: 1600, height: 900 },
    page: PAGE,
  });

  expect(attributes).toEqual({
    src: "https://cdn.example/hero.jpg?w=1280&q=70&fm=auto",
    srcSet:
      "https://cdn.example/hero.jpg?w=320&q=70&fm=auto 320w, " +
      "https://cdn.example/hero.jpg?w=640&q=70&fm=auto 640w, " +
      "https://cdn.example/hero.jpg?w=1280&q=70&fm=auto 1280w",
    sizes: DEFAULT_IMAGE_SIZES,
    width: 1600,
    height: 900,
    loading: "lazy",
    fetchPriority: "auto",
  });
});

test("an image drops the candidate widths that would upscale it", () => {
  const attributes = imageAttributes({
    images: IMAGES,
    image: { src: "/icon.png", width: 400, height: 400 },
    page: PAGE,
  });

  expect(attributes.srcSet).toBe(
    "https://cdn.example/icon.png?w=320&q=70&fm=auto 320w",
  );
  expect(attributes.src).toBe("https://cdn.example/icon.png?w=320&q=70&fm=auto");
});

test("an image narrower than every candidate width is asked for at its own width", () => {
  const attributes = imageAttributes({
    images: IMAGES,
    image: { src: "/pixel.png", width: 120, height: 60 },
    page: PAGE,
  });

  expect(attributes.srcSet).toBe(
    "https://cdn.example/pixel.png?w=120&q=70&fm=auto 120w",
  );
});

test("an image takes its own sizes over the site's, and the site's over the default", () => {
  const declared: ImagesSetting = { ...IMAGES, sizes: "(min-width: 60rem) 50vw, 100vw" };

  expect(
    imageAttributes({
      images: declared,
      image: { src: "/hero.jpg", width: 1600, height: 900 },
      page: PAGE,
    }).sizes,
  ).toBe("(min-width: 60rem) 50vw, 100vw");

  expect(
    imageAttributes({
      images: declared,
      image: { src: "/hero.jpg", width: 1600, height: 900, sizes: "320px" },
      page: PAGE,
    }).sizes,
  ).toBe("320px");
});

test("an image above the fold loads eagerly at high priority and one below it lazily", () => {
  const above = imageAttributes({
    images: IMAGES,
    image: { src: "/hero.jpg", width: 1600, height: 900, aboveFold: true },
    page: PAGE,
  });
  const below = imageAttributes({
    images: IMAGES,
    image: { src: "/hero.jpg", width: 1600, height: 900, aboveFold: false },
    page: PAGE,
  });

  expect(above.loading).toBe("eager");
  expect(above.fetchPriority).toBe("high");
  expect(below.loading).toBe("lazy");
  expect(below.fetchPriority).toBe("auto");
});

test("an image with a dominant color carries it as a background, and one without carries no style", () => {
  const withColor = imageAttributes({
    images: IMAGES,
    image: {
      src: "/hero.jpg",
      width: 1600,
      height: 900,
      placeholderColor: "#3a2f28",
    },
    page: PAGE,
  });
  const withoutColor = imageAttributes({
    images: IMAGES,
    image: { src: "/hero.jpg", width: 1600, height: 900 },
    page: PAGE,
  });

  expect(withColor.style).toEqual({ backgroundColor: "#3a2f28" });
  expect(withoutColor.style).toBeUndefined();
});

test("a dominant-color placeholder changes nothing the browser reserves space with", () => {
  const image = { src: "/hero.jpg", width: 1600, height: 900 } as const;
  const plain = imageAttributes({ images: IMAGES, image, page: PAGE });
  const placeheld = imageAttributes({
    images: IMAGES,
    image: { ...image, placeholderColor: "rgb(58 47 40)" },
    page: PAGE,
  });

  expect({ ...placeheld, style: undefined }).toEqual({
    ...plain,
    style: undefined,
  });
  expect(placeheld.style).toEqual({ backgroundColor: "rgb(58 47 40)" });
});

test("an image with no intrinsic dimensions fails the build naming the page and the image", () => {
  const error: unknown = (() => {
    try {
      imageAttributes({
        images: IMAGES,
        image: {
          src: "/hero.jpg",
          width: undefined as unknown as number,
          height: 0,
        },
        page: PAGE,
      });
    } catch (thrown: unknown) {
      return thrown;
    }
    return undefined;
  })();

  expect(error).toBeInstanceOf(RenderError);
  expect((error as Error).message).toBe(
    'Entry /en/home: image "/hero.jpg" declares 2 intrinsic dimensions that are not pixel sizes, so the browser reserves no space for it and the page shifts as it loads — pass the asset\'s own pixel width and height:\n' +
      "  width — undefined — not a number\n" +
      "  height — 0 — not a whole number of pixels above zero",
  );
});

test("an unusable image source is reported above the dimensions, and redacted", () => {
  const error: unknown = (() => {
    try {
      imageAttributes({
        images: IMAGES,
        image: {
          src: "https://cdn.example/hero.jpg?signature=SECRET",
          width: 0,
          height: 900,
        },
        page: PAGE,
      });
    } catch (thrown: unknown) {
      return thrown;
    }
    return undefined;
  })();

  expect((error as Error).message).toBe(
    'Entry /en/home: image "https://cdn.example/hero.jpg?…" declares 1 intrinsic dimension that is not a pixel size, so the browser reserves no space for it and the page shifts as it loads — pass the asset\'s own pixel width and height:\n' +
      "  width — 0 — not a whole number of pixels above zero",
  );
});

test("an image source's controls are escaped where it is quoted", () => {
  const error: unknown = (() => {
    try {
      imageAttributes({
        images: IMAGES,
        image: { src: "/a\u001b[2K\r\n\u009b .jpg", width: 0, height: 900 },
        page: PAGE,
      });
    } catch (thrown: unknown) {
      return thrown;
    }
    return undefined;
  })();

  expect((error as Error).message).toContain('image "/a\\u001b[2K\\r\\n\\u009b\\u2028.jpg" declares');
  expect((error as Error).message).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/);
});

test("an empty image source is refused before any dimension is read", () => {
  const error: unknown = (() => {
    try {
      imageAttributes({
        images: IMAGES,
        image: { src: "   ", width: 0, height: 0 },
        page: PAGE,
      });
    } catch (thrown: unknown) {
      return thrown;
    }
    return undefined;
  })();

  expect(error).toBeInstanceOf(RenderError);
  expect((error as Error).message).toBe(
    'Entry /en/home: image source is not usable, so no URL can be built for it — pass the asset\'s own path or URL, such as "/hero.jpg":\n' +
      '  "   " — the source is only whitespace\n\n' +
      "Entry /en/home: image declares 2 intrinsic dimensions that are not pixel sizes, so the browser reserves no space for it and the page shifts as it loads — pass the asset's own pixel width and height:\n" +
      "  width — 0 — not a whole number of pixels above zero\n" +
      "  height — 0 — not a whole number of pixels above zero",
  );
});

function refusal(settings: unknown): string {
  try {
    defineImages(settings as never);
  } catch (thrown: unknown) {
    if (!(thrown instanceof ConfigError)) throw thrown;
    return thrown.message;
  }
  return "no error";
}

test("image settings that are not an object are refused alone", () => {
  expect(refusal("cloudinary")).toBe(
    'Image settings: must be an object declaring an adapter, widths, quality and format — images: { adapter: urlTemplate("https://cdn.example{src}?w={width}&q={quality}&fm={format}"), widths: [640, 1280], quality: 70, format: "auto" }',
  );
});

test("well-formed image settings are returned unchanged", () => {
  expect(defineImages(IMAGES)).toBe(IMAGES);
});

test("image settings report every unusable field and every unusable width", () => {
  expect(
    refusal({
      adapter: "https://cdn.example{src}",
      widths: [640, "1280", 0],
      quality: "70",
      format: "",
      sizes: 100,
      formats: ["webp"],
    }),
  ).toBe(
    "Image settings: declares 1 field this build does not read — delete the field, or correct it to one of: adapter, widths, quality, format, sizes:\n" +
      '  "formats"\n\n' +
      "Image settings: declares 4 fields images cannot be built from — declare each as the type its own line names:\n" +
      '  "adapter" — not a function — pass a function of (src, width, quality, format) returning a URL, or urlTemplate("https://cdn.example{src}?w={width}")\n' +
      '  "quality" — "70" — not a number — write the number your CDN\'s quality scale takes, such as 70\n' +
      '  "format" — "" — not a format the adapter can pass on — write the token your CDN takes, such as "auto"\n' +
      '  "sizes" — 100 — not a sizes attribute — write a CSS sizes list, such as "(min-width: 60rem) 50vw, 100vw"\n\n' +
      "Image settings: declares 2 widths that are not pixel widths — write each as a whole number of pixels above zero, such as widths: [640, 1280]:\n" +
      '  widths[1] — "1280" — not a number\n' +
      "  widths[2] — 0 — not a whole number of pixels above zero",
  );
});

test("an empty widths list is refused in a paragraph of its own", () => {
  expect(refusal({ ...IMAGES, widths: [] })).toBe(
    "Image settings: declares no widths, so there is no srcset entry to build — list at least one, such as widths: [640, 1280]",
  );
});

test("a signed template pasted into the wrong field is not echoed whole", () => {
  expect(
    refusal({
      ...IMAGES,
      quality: "https://cdn.example{src}?w={width}&sig=SECRET",
    }),
  ).toBe(
    "Image settings: declares 1 field images cannot be built from — declare each as the type its own line names:\n" +
      '  "quality" — "https://cdn.example{src}?…" — not a number — write the number your CDN\'s quality scale takes, such as 70',
  );
});

test("a source ending in a comma keeps its width descriptor attached", () => {
  const adapter = urlTemplate("https://cdn.example/w_{width}{src}");
  const attributes = imageAttributes({
    images: { ...IMAGES, adapter, widths: [320] },
    image: { src: "/uploads/chart,", width: 800, height: 600 },
    page: PAGE,
  });

  expect(attributes.srcSet).toBe("https://cdn.example/w_320/uploads/chart%2C 320w");
});

test("a dimension that is not a finite number is quoted as what was written", () => {
  const error: unknown = (() => {
    try {
      imageAttributes({
        images: IMAGES,
        image: { src: "/hero.jpg", width: Number.NaN, height: 900 },
        page: PAGE,
      });
    } catch (thrown: unknown) {
      return thrown;
    }
    return undefined;
  })();

  expect((error as Error).message).toContain("  width — NaN — not a number");
});
