import DocsNav from "./nav.js";
import { BODY, PAGE } from "./shell.js";
import type { ReactNode } from "react";
import type { NavSection } from "../sections.js";

export default function SearchPage({
  title,
  intro,
  nav,
  children,
}: {
  title: string;
  intro: string;
  nav: readonly NavSection[];
  children?: ReactNode;
}) {
  return (
    <div className={PAGE}>
      <DocsNav nav={nav} />
      <div className={BODY}>
        <h1>{title}</h1>
        <p className="fw-lede">{intro}</p>
        {children}
      </div>
    </div>
  );
}
