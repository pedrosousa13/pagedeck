"use client";

import { useEffect, useId, useState } from "react";

interface Props {
  label: string;
  button: string;
  confirmation: string;
}

// Posts nowhere: a form backend is the site's to choose (spec §3).
export default function SignupForm({ label, button, confirmation }: Props) {
  const id = useId();
  const [sent, setSent] = useState(false);
  // Before hydration a submit would GET this page with the address in its URL (#727).
  // Not method="post": a POST to a made-up action still sends the address to the host.
  // A site with a real backend sets method="post" and a real action instead.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  if (sent) return <p data-block="signup_form" role="status">{confirmation}</p>;
  return (
    <form
      data-block="signup_form"
      onSubmit={(event) => {
        event.preventDefault();
        setSent(true);
      }}
    >
      <label htmlFor={id}>{label}</label>
      <input id={id} name="email" type="email" required />
      <button type="submit" disabled={!hydrated}>
        {button}
      </button>
    </form>
  );
}
