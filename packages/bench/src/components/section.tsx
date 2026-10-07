import type { ReactNode } from "react";

export default function Section({
  heading,
  tone,
  children,
}: {
  heading: string;
  tone: string;
  children?: ReactNode;
}) {
  return (
    <section className={`section section-${tone}`}>
      <h2 className="section-heading">{heading}</h2>
      {children}
    </section>
  );
}
