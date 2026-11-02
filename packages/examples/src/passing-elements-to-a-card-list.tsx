// Example: a server component hands a `"use client"` component elements in its props.
import { useState } from "react";
import type { ReactNode } from "react";
import { clientReference, renderPage } from "@pagedeck/core";
import type { ComponentRegistry } from "@pagedeck/islands";

const PAGE = { locale: "en", path: "/cards" } as const;

// In a site this module starts with "use client". Each list item sits in a keyed `<li>`, so
// a reorder moves its server HTML with it.
function CardList({
  items,
  children,
}: {
  items: { id: string; node: ReactNode }[];
  children?: ReactNode;
}) {
  const [reversed, setReversed] = useState(false);
  const shown = reversed ? [...items].reverse() : items;
  return (
    <section>
      <button type="button" onClick={() => setReversed(!reversed)}>
        Reverse
      </button>
      <ul>
        {shown.map((item) => (
          <li key={item.id}>{item.node}</li>
        ))}
      </ul>
      {children}
    </section>
  );
}

// `pagedeck build` substitutes this stand-in for the import; the example does it by hand.
const ProxiedCardList = clientReference(CardList, { name: "card-list", mode: "visible" });

function Card({ name }: { name: string }) {
  return (
    <article>
      <h3>{name}</h3>
    </article>
  );
}

function Cards() {
  return (
    <ProxiedCardList
      items={["Alpha", "Beta"].map((name) => ({ id: name, node: <Card name={name} /> }))}
    >
      <p>Two cards</p>
    </ProxiedCardList>
  );
}

export interface PropSlotExample {
  html: string;
  islands: readonly { component: string; prefix: string }[];
}

export async function passElementsToAnIsland(): Promise<PropSlotExample> {
  const registry = {
    cards: { import: async () => ({ default: Cards }) },
  } satisfies ComponentRegistry;

  const { html, islands } = await renderPage({ page: PAGE, template: "cards", registry });
  return {
    html,
    islands: islands.map((island) => ({ component: island.component, prefix: island.prefix })),
  };
}
