"use client";

// Its copy is its own: copy passed in as props would be counted as product data
// reaching the browser.
import { useId, useState } from "react";

interface Variant {
  readonly id: string;
  readonly colour: string;
  readonly size: string;
}

export default function VariantPicker({
  sku,
  price,
  variants,
}: {
  sku: string;
  price: string;
  variants: readonly Variant[];
}) {
  const colours = [...new Set(variants.map((variant) => variant.colour))];
  const sizes = [...new Set(variants.map((variant) => variant.size))];
  const [colour, setColour] = useState(colours[0]);
  const [size, setSize] = useState(sizes[0]);
  const [cart, setCart] = useState<readonly string[]>([]);
  const name = useId();
  const chosen = variants.find(
    (variant) => variant.colour === colour && variant.size === size,
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen !== undefined) setCart([...cart, chosen.id]);
      }}
    >
      <p>
        <strong>{price}</strong> <span>{sku}</span>
      </p>
      <fieldset>
        <legend>Colour</legend>
        {colours.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={`${name}-colour`}
              value={option}
              checked={option === colour}
              onChange={() => setColour(option)}
            />
            {option}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Size</legend>
        {sizes.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={`${name}-size`}
              value={option}
              checked={option === size}
              onChange={() => setSize(option)}
            />
            {option}
          </label>
        ))}
      </fieldset>
      <p>
        <button type="submit">Add to cart</button>{" "}
        <output>
          {cart.length === 0
            ? "Your cart is empty."
            : `${String(cart.length)} in your cart, last ${String(cart.at(-1))}.`}
        </output>
      </p>
    </form>
  );
}
