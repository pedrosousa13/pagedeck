"use client";

import { hc } from "hono/client";
import { useState } from "react";
import type { AppType } from "../app/index.ts";

const client = hc<AppType>("/");

export default function Hello() {
  const [message, setMessage] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const response = await client.api.hello.$get({ query: { name: "island" } });
          setMessage((await response.json()).message);
        }}
      >
        Ask the app
      </button>
      <p role="status">{message}</p>
    </>
  );
}
