import { join } from "node:path";
import { defineImages, urlTemplate } from "@pagedeck/core/images";
import type { ImagesSetting } from "@pagedeck/core/images";

export const PUBLIC_DIR = join(import.meta.dirname, "..", "public");

// `quality` is what the checked-in files were encoded at; the template writes none.
export const SITE_IMAGES: ImagesSetting = defineImages({
  adapter: urlTemplate("/images{src}-{width}.{format}"),
  widths: [320, 640, 1280],
  quality: 70,
  format: "webp",
});
