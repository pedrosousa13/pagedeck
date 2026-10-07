// The counter arrives as a child node, not an import, because a tree position is
// what fold tuning reads (#24).
import type { ReactNode } from "react";
import { PAGE } from "./shell.js";

export default function IslandPage({
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
      <div className="fw-hero">
        <div>
          <h1 className="fw-hero__title">{title}</h1>
          <p className="fw-hero__lede">{intro}</p>
        </div>
        <div className="fw-demo">{children}</div>
      </div>
      <p className="fw-back">
        <a href="/">Back to the page that ships no JavaScript</a>
      </p>
    </div>
  );
}
