"use client";

// Deliberately trivial: what is measured is the per-page cost of carrying an island.
import { useState } from "react";

export default function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button
      className="counter"
      type="button"
      onClick={() => {
        setCount((previous) => previous + 1);
      }}
    >
      {label}: {count}
    </button>
  );
}
