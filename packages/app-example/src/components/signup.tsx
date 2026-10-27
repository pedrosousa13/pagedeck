"use client";

import { hc } from "hono/client";
import { useId, useRef, useState } from "react";
import type { AppType } from "../app.js";

const client = hc<AppType>("/");

// Declared here, not via the `DOM` lib, which this workspace leaves out.
interface Typed {
  readonly value: string;
}

type Status =
  | { readonly phase: "idle" | "pending" | "failed" }
  | { readonly phase: "sent" | "refused"; readonly text: string };

const PENDING = "Signing up…";
const FAILED =
  "Something went wrong, so you are not signed up yet. Your address is still in the form: try again.";

async function send(email: string): Promise<Status> {
  try {
    const response = await client.api.signup.$post(
      { form: { email } },
      { headers: { Accept: "application/json" } },
    );
    if (response.status === 201) return { phase: "sent", text: (await response.json()).message };
    if (response.status === 422) return { phase: "refused", text: (await response.json()).error };
  } catch {
    // A request that never arrived, or a body that is not the JSON its status promised.
  }
  return { phase: "failed" };
}

function announcement(status: Status): string {
  if (status.phase === "sent" || status.phase === "refused") return status.text;
  if (status.phase === "pending") return PENDING;
  return status.phase === "failed" ? FAILED : "";
}

export default function Signup() {
  const id = useId();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ phase: "idle" });
  const sending = useRef(false);
  const pending = status.phase === "pending";
  const refused = status.phase === "refused";
  return (
    <form
      method="post"
      action="/api/signup"
      onSubmit={async (event) => {
        event.preventDefault();
        if (sending.current) return;
        sending.current = true;
        setStatus({ phase: "pending" });
        setStatus(await send(email));
        sending.current = false;
      }}
    >
      <label htmlFor={id}>Email address</label>
      <input
        id={id}
        name="email"
        type="email"
        autoComplete="email"
        value={email}
        aria-invalid={refused}
        aria-describedby={refused ? `${id}-status` : undefined}
        onChange={(event) => setEmail((event.target as unknown as Typed).value)}
      />
      <button type="submit" aria-disabled={pending}>
        Sign up
      </button>
      <p id={`${id}-status`} role="status">
        {announcement(status)}
      </p>
    </form>
  );
}
