"use client";

import { useState } from "react";

export default function Counter({
  label,
}: {
  label: string;
}) {
  const [presses, setPresses] = useState(0);
  return (
    <p>
      <button type="button" onClick={() => setPresses(presses + 1)}>
        {label}
      </button>{" "}
      <output>Pressed {presses} times</output>
    </p>
  );
}
