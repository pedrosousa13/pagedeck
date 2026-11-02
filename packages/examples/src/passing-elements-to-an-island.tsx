// Example: a server component hands a `"use client"` component elements in its props. Each
// element becomes a prop slot: the build renders it once, and the browser keeps that HTML.
import { useState } from "react";
import type { ReactNode } from "react";
import { clientReference, renderPage } from "@pagedeck/core";
import type { ComponentRegistry } from "@pagedeck/islands";

const PAGE = { locale: "en", path: "/cards" } as const;

// In a site this module starts with "use client". Each list item sits in a keyed `<li>`, so
// a reorder moves its server HTML with it.
function Carousel({
  title,
  items,
  children,
}: {
  title: string;
  items: readonly { id: string; node: ReactNode }[];
  children?: ReactNode;
}) {
  const [reversed, setReversed] = useState(false);
  const shown = reversed ? [...items].reverse() : items;
  return (
    <section>
      <h2>{title}</h2>
      <button type="button" onClick={() => setReversed(!reversed)}>
        Reverse
      </button>
      <ul>
        {shown.map((item) => (
          <li key={item.id}>{item.node}</li>
        ))}
      </ul>
      <footer>{children}</footer>
    </section>
  );
}

// `pagedeck build` substitutes this stand-in for the import; the example does it by hand.
const ProxiedCarousel = clientReference(Carousel, { name: "Carousel", mode: "visible" });

// A server component: it ships no JavaScript, and its HTML reaches the browser inside the
// carousel's prop slots.
function Card({ name }: { name: string }) {
  return (
    <article>
      <h3>{name}</h3>
    </article>
  );
}

function Gallery() {
  return (
    <ProxiedCarousel
      title="Cards"
      items={["Alpha", "Beta"].map((name) => ({ id: name, node: <Card name={name} /> }))}
    >
      <p>Two cards</p>
    </ProxiedCarousel>
  );
}

export interface PropSlotExample {
  html: string;
  islands: readonly { component: string; prefix: string }[];
}

export async function passElementsToAnIsland(): Promise<PropSlotExample> {
  const registry = {
    Gallery: { import: async () => ({ default: Gallery }) },
  } satisfies ComponentRegistry;

  const { html, islands } = await renderPage({ page: PAGE, template: "Gallery", registry });
  return {
    html,
    islands: islands.map((island) => ({ component: island.component, prefix: island.prefix })),
  };
}
