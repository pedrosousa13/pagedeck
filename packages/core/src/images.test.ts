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

const PREVIEW = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";

const PREVIEW_STYLE = {
  backgroundImage: `url("${PREVIEW}")`,
  backgroundSize: "cover",
  backgroundPosition: "center",
  backgroundRepeat: "no-repeat",
} as const;

test("an image with a cached preview carries it as a stretched background", () => {
  const attributes = imageAttributes({
    images: IMAGES,
    image: { src: "/hero.jpg", width: 1600, height: 900, placeholderPreview: PREVIEW },
    page: PAGE,
  });

  expect(attributes.style).toStrictEqual(PREVIEW_STYLE);
});

test("an image with both keeps its dominant color underneath the preview", () => {
  const attributes = imageAttributes({
    images: IMAGES,
    image: {
      src: "/hero.jpg",
      width: 1600,
      height: 900,
      placeholderColor: "#3a2f28",
      placeholderPreview: PREVIEW,
    },
    page: PAGE,
  });

  expect(attributes.style).toStrictEqual({
    backgroundColor: "#3a2f28",
    ...PREVIEW_STYLE,
  });
});

test("an image with no preview renders its color exactly as before, and an absent preview adds no key", () => {
  const image = { src: "/hero.jpg", width: 1600, height: 900 } as const;

  expect(
    imageAttributes({
      images: IMAGES,
      image: { ...image, placeholderColor: "#3a2f28", placeholderPreview: undefined },
      page: PAGE,
    }).style,
  ).toStrictEqual({ backgroundColor: "#3a2f28" });
  expect(
    Object.keys(
      imageAttributes({ images: IMAGES, image: { ...image, placeholderPreview: undefined }, page: PAGE }),
    ),
  ).not.toContain("style");
});

test("a preview changes nothing the browser reserves space with", () => {
  const image = { src: "/hero.jpg", width: 1600, height: 900 } as const;
  const plain = imageAttributes({ images: IMAGES, image, page: PAGE });
  const previewed = imageAttributes({
    images: IMAGES,
    image: { ...image, placeholderPreview: PREVIEW },
    page: PAGE,
  });

  expect({ ...previewed, style: undefined }).toEqual({ ...plain, style: undefined });
});

function renderFault(placeholderPreview: unknown): Error | undefined {
  try {
    imageAttributes({
      images: IMAGES,
      image: {
        src: "/hero.jpg",
        width: 1600,
        height: 900,
        placeholderPreview: placeholderPreview as string,
      },
      page: PAGE,
    });
  } catch (thrown: unknown) {
    return thrown as Error;
  }
  return undefined;
}

test.each([
  ["a quote that closes the url", 'data:image/png;base64,AAAA");background:url("https://x.example/'],
  ["a parenthesis", "data:image/png;base64,AAAA)"],
  ["a semicolon", "data:image/png;base64,AAAA;color:red"],
  ["a backslash", "data:image/png;base64,AA\\29"],
  ["a newline", "data:image/png;base64,AAAA\n"],
  ["a closing style tag", "data:image/png;base64,AAAA</style><script>alert(1)</script>"],
  ["a javascript: URL", "javascript:alert(1)"],
  ["an SVG data URI", "data:image/svg+xml;base64,PHN2Zz4="],
  ["whitespace", " data:image/png;base64,AAAA"],
  ["a non-base64 character", "data:image/png;base64,AA*A"],
  ["an answer over the cap", `data:image/png;base64,${"A".repeat(4096)}`],
  ["a non-string", 17],
])("a preview holding %s is refused at render and never emitted", (_name, value) => {
  const error = renderFault(value);

  expect(error).toBeInstanceOf(RenderError);
  expect(error?.message).toMatch(
    /^Entry \/en\/home: image "\/hero\.jpg" carries a placeholderPreview that is not an image preview, so none is written into the page — pass the answer the sync cached for it, store\.getImagePreview\(src\), or leave the field out:\n {2}.+ — .+$/,
  );
});

test("a credential in a long refused preview is redacted before it is cut short", () => {
  const message = renderFault(
    "https://user:hunter2-very-long-secret-token@cdn.example/x.jpg",
  )?.message;

  expect(message).not.toContain("hunter2");
  expect(message?.split("\n")[1]).toBe(
    '  "https://…@cdn.example/x.jpg" — not a base64 data URI of a png, jpeg, webp, avif or gif image',
  );
});

test("a refused preview is quoted cut short, and names its reason", () => {
  expect(renderFault("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")?.message).toBe(
    'Entry /en/home: image "/hero.jpg" carries a placeholderPreview that is not an image preview, so none is written into the page — pass the answer the sync cached for it, store.getImagePreview(src), or leave the field out:\n' +
      '  "data:image/svg+xml;base64,PHN2Zz…" — not a base64 data URI of a png, jpeg, webp, avif or gif image',
  );
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
    'Entry /en/home: image source would move the image off the host the URL template names, so content could load it from any host — pass the asset\'s own path, starting with "/", such as "/hero.jpg":\n' +
      '  "https://cdn.example/hero.jpg?…" — does not start with "/", so it runs on into the host the template names\n\n' +
      'Entry /en/home: image declares 1 intrinsic dimension that is not a pixel size, so the browser reserves no space for it and the page shifts as it loads — pass the asset\'s own pixel width and height:\n' +
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

const HOST_HEADLINE =
  'Entry /en/home: image source would move the image off the host the URL template names, so content could load it from any host — pass the asset\'s own path, starting with "/", such as "/hero.jpg":';

function sourceRefusal(template: string, src: string): unknown {
  try {
    imageAttributes({
      images: { ...IMAGES, adapter: urlTemplate(template) },
      image: { src, width: 1600, height: 900 },
      page: PAGE,
    });
  } catch (thrown: unknown) {
    return thrown;
  }
  return undefined;
}

test.each([
  [".evil.test/x", '".evil.test/x"'],
  ["@evil.test/x", '"…@evil.test/x"'],
  [":8080/x", '":8080/x"'],
  ["x.jpg", '"x.jpg"'],
])(
  "a source %j after the template's origin is refused for not starting with a slash",
  (src, quoted) => {
    const error = sourceRefusal("https://cdn.example{src}?w={width}", src);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as Error).message).toBe(
      `${HOST_HEADLINE}\n  ${quoted} — does not start with "/", so it runs on into the host the template names`,
    );
  },
);

test("a source that would turn a path template into a protocol-relative URL is refused", () => {
  const error = sourceRefusal("/{src}?w={width}", "/evil.test/x");

  expect(error).toBeInstanceOf(RenderError);
  expect((error as Error).message).toBe(
    `${HOST_HEADLINE}\n  "/evil.test/x" — builds a URL on another host than the one the template names`,
  );
});

test.each([
  ["//evil.test/x", "a protocol-relative URL, which names a host of its own"],
  ["javascript:x", "a javascript: URL, not a path or a web address"],
  ["JavaScript:x", "a javascript: URL, not a path or a web address"],
  ["data:image/png;base64,AAAA", "a data: URL, not a path or a web address"],
])(
  "a template that starts with {src} refuses %j",
  (src, reason) => {
    const error = sourceRefusal("{src}?w={width}", src);

    expect(error).toBeInstanceOf(RenderError);
    expect((error as Error).message).toBe(
      `${HOST_HEADLINE}\n  ${JSON.stringify(src)} — ${reason}`,
    );
  },
);

test.each([
  ["{src}?w={width}", "/uploads/hero.jpg", "/uploads/hero.jpg?w=320"],
  ["{src}?w={width}", "https://media.example/hero.jpg", "https://media.example/hero.jpg?w=320"],
  ["{src}?w={width}", " javascript:x", "%20javascript:x?w=320"],
  ["https://cdn.example{src}?w={width}", "//evil.test/x", "https://cdn.example//evil.test/x?w=320"],
  ["https://cdn.example/w_{width}{src}", "x.jpg", "https://cdn.example/w_320x.jpg"],
  ["/images{src}-{width}", "/hero", "/images/hero-320"],
])("a template %j keeps the source %j on its own host", (template, src, url) => {
  const attributes = imageAttributes({
    images: { ...IMAGES, adapter: urlTemplate(template), widths: [320] },
    image: { src, width: 1600, height: 900 },
    page: PAGE,
  });

  expect(attributes.src).toBe(url);
});
