// Its own module, because the `<img>` component that imports it is a browser module.
import { defineImages, urlTemplate } from "@pagedeck/core/images";

// `w`, `q`, `fm` and `auto` are this CDN's own parameters, not framework names.
export const SITE_IMAGES = defineImages({
  adapter: urlTemplate(
    "https://images.example{src}?w={width}&q={quality}&fm={format}",
  ),
  widths: [320, 640, 1280],
  quality: 70,
  format: "auto",
  // Images fill half the viewport once there is room for two columns.
  sizes: "(min-width: 60rem) 50vw, 100vw",
});
