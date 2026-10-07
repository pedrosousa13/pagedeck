// A component module is a browser module: the preview target bundles every registered
// component, so this imports only `@pagedeck/core/tree` and `@pagedeck/core/images`.
import { imageAttributes } from "@pagedeck/core/images";
import type { ImageSource } from "@pagedeck/core/images";
import { unescapedHtml, useBuildData, useLocale } from "@pagedeck/core/tree";
import type { PageContext } from "@pagedeck/islands";
import { useId } from "react";
import type { ReactNode } from "react";
import { SITE_IMAGES } from "./site-images.js";

// Ordinary imports: only the template is named by content.
function PricingTable({
  plans,
}: {
  plans: readonly { id: string; name: string; price: number }[];
}) {
  return (
    <table className="plans">
      <tbody>
        {plans.map((plan) => (
          <tr key={plan.id}>
            <td>{plan.name}</td>
            <td>{`€${String(plan.price)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FaqList() {
  return <dl className="faq" />;
}

export function PricingPage({
  title,
  plans,
}: {
  title: string;
  plans: readonly { id: string; name: string; price: number }[];
}) {
  return (
    <div className="pricing">
      <h1>{title}</h1>
      <PricingTable plans={plans} />
      <FaqList />
    </div>
  );
}

// `useLocale` gives the page's locale; the component writes `lang` and `dir` on its own element.
export function Hero({
  headline,
  children,
}: {
  headline: string;
  children?: ReactNode;
}) {
  const { code, direction } = useLocale();
  return (
    <section className="hero" lang={code} dir={direction}>
      <h1>{headline}</h1>
      {children}
    </section>
  );
}

// The site owns the `<img>`; `imageAttributes` computes its attributes. `page` is a prop
// because a missing dimension is refused naming the page.
export function SiteImage({
  image,
  page,
  alt,
}: {
  image: ImageSource;
  page: PageContext;
  alt: string;
}) {
  return <img alt={alt} {...imageAttributes({ images: SITE_IMAGES, image, page })} />;
}

/** Interpolation is escaped by React, so the payload renders as text. */
export function Tagline({ text }: { text: string }) {
  return <p className="tagline">{text}</p>;
}

// `unescapedHtml` writes the HTML verbatim but for the framework's reserved names.
export function RichText({ body }: { body: string }) {
  return <div className="prose" {...unescapedHtml(body)} />;
}

// `useBuildData` reads data resolved before the render; a `fetch` here fails the build.
export function Stats() {
  const stats = useBuildData<{ pages: number }>("stats");
  return <p className="stats">{`${stats.pages} pages`}</p>;
}

// An island: `useId` comes from this island's own prefix.
export function AddToCart({ sku }: { sku: string }) {
  const id = useId();
  return (
    <button className="add" id={id} name={sku} type="button">
      Add to cart
    </button>
  );
}

// An island no entry names; `islanding-a-nested-client-component.tsx` renders it.
export function LikeButton({ count }: { count: number }) {
  const id = useId();
  return (
    <button className="like" id={id} type="button">
      {`${String(count)} likes`}
    </button>
  );
}

// Each child is an opaque, already-rendered node: place, wrap, show, hide or reorder it.
export function Tabs({ open, children }: { open: number; children?: ReactNode }) {
  const panels = children as readonly ReactNode[];
  return <div className="tabs">{panels[open]}</div>;
}

// The same stack wraps the page and every island root, so both sides agree on Context.
export function ThemeProvider({
  theme,
  children,
}: {
  theme: string;
  children?: ReactNode;
}) {
  return <div data-theme={theme}>{children}</div>;
}

