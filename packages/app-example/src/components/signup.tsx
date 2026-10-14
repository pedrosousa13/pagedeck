"use client";

import { hc } from "hono/client";
import { useEffect, useId, useState } from "react";
import type { AppType } from "../app.js";

const client = hc<AppType>("/");

// Declared here, not via the `DOM` lib, which this workspace leaves out.
interface Typed {
  readonly value: string;
}

export default function Signup() {
  const id = useId();
  const [email, setEmail] = useState("");
  const [reply, setReply] = useState("");
  // Before hydration a submit would GET this page with the address in its URL.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const response = await client.api.signup.$post({ json: { email } });
        const body = await response.json();
        setReply("message" in body ? body.message : body.error);
      }}
    >
      <label htmlFor={id}>Email address</label>
      <input
        id={id}
        type="email"
        value={email}
        onChange={(event) => setEmail((event.target as unknown as Typed).value)}
      />
      <button type="submit" disabled={!hydrated}>
        Sign up
      </button>
      <p role="status">{reply}</p>
    </form>
  );
}
