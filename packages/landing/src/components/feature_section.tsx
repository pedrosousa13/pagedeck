import type { ReactNode } from "react";

export default function FeatureSection({
  id,
  heading,
  body,
  docs,
  children,
}: {
  id: string;
  heading: string;
  body: readonly string[];
  docs?: { readonly href: string; readonly label: string };
  children?: ReactNode;
}) {
  const headingId = `${id}-heading`;
  return (
    <section id={id} aria-labelledby={headingId} className="fw-feature">
      <div className="fw-feature__text">
        <h2 id={headingId}>{heading}</h2>
        {body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {docs === undefined ? null : (
          <p className="fw-feature__docs">
            <a href={docs.href}>{docs.label}</a>
          </p>
        )}
      </div>
      <div className="fw-feature__demo">{children}</div>
    </section>
  );
}
