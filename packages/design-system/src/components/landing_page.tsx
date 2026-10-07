"use client";

import { useId, useState } from "react";

const COPY_FIELDS = ["email_label", "apply_label", "send_label"] as const;

function refuseMissingCopy(fields: Record<string, unknown>): void {
  const missing = COPY_FIELDS.filter((field) => {
    const value = fields[field];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length === 0) return;
  const headline = fields["headline"];
  const subject =
    typeof headline === "string" && headline.trim() !== ""
      ? `LandingPage "${headline}"`
      : "LandingPage with no headline";
  throw new Error(
    `${subject}: ${String(missing.length)} copy field${missing.length === 1 ? " is" : "s are"} missing, and the signup form's controls would have no text a visitor can read — give each of these a non-blank string:\n${missing
      .map((field) => `  ${field}`)
      .join("\n")}`,
  );
}

export default function LandingPage({
  fields,
}: {
  fields: {
    headline: string;
    email_label: string;
    apply_label: string;
    send_label: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const emailId = useId();
  // Checked on every render, the server's included: the form starts closed, so a
  // check inside it would wait for a visitor's press.
  refuseMissingCopy(fields);
  return (
    <div className="landing">
      <h1>{fields.headline}</h1>
      <button
        onClick={() => {
          setOpen(true);
        }}
        type="button"
      >
        {fields.apply_label}
      </button>
      {open ? (
        <form className="landing__signup">
          <label htmlFor={emailId}>{fields.email_label}</label>
          <input id={emailId} name="email" type="email" />
          <button type="submit">{fields.send_label}</button>
        </form>
      ) : null}
    </div>
  );
}
