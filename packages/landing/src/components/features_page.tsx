import type { ReactNode } from "react";
import { PAGE } from "./shell.js";

export default function FeaturesPage({
  title,
  intro,
  children,
}: {
  title: string;
  intro: string;
  children?: ReactNode;
}) {
  return (
    <div className={PAGE}>
      <div className="fw-hero fw-hero--short">
        <div>
          <h1 className="fw-hero__title">{title}</h1>
          <p className="fw-hero__lede">{intro}</p>
        </div>
      </div>
      {children}
    </div>
  );
}
