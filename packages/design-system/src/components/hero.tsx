import { classesFor } from "../styling.js";
import type { ImageAttributes } from "@pagedeck/core/images";
import type { ReactNode } from "react";

// Taken resolved, never composed here, so the site's image scheme has one
// speller.
export type HeroImage = ImageAttributes & { readonly alt: string };

export default function Hero({
  headline,
  theme,
  image,
  children,
}: {
  headline: string;
  theme?: string;
  image?: HeroImage;
  children?: ReactNode;
}) {
  return (
    <section className={`hero ${classesFor("hero.theme", theme)}`}>
      {image === undefined ? null : <img {...image} />}
      <h1>{headline}</h1>
      {children}
    </section>
  );
}
