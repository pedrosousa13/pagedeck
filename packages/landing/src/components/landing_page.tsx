// `unescapedHtml` from `@pagedeck/core/tree`, never from `@pagedeck/core`, whose index
// reaches Node builtins.
import type { CSSProperties } from "react";
import { unescapedHtml } from "@pagedeck/core/tree";
import { formatBytes } from "../bytes.js";
import { PAGE } from "./shell.js";
import { splitSections, tabbed } from "./sections.js";
import type { Figure } from "./sections.js";

const LAYOUTS: Readonly<Record<string, string>> = {
  "same-react-no-floor": "compare",
  "your-cms-data-stays-on-the-server": "data",
  "early-not-on-npm-yet": "closing",
  sources: "sources",
};

function Ruler({ title, rows }: { title: string; rows: readonly Figure[] }) {
  const largest = Math.max(1, ...rows.map((row) => row.bytes));
  return (
    <figure className="fw-ruler" aria-labelledby="fw-ruler-title">
      <figcaption id="fw-ruler-title" className="fw-ruler__title">
        {title}
      </figcaption>
      <ul className="fw-ruler__rows">
        {rows.map((row) => {
          const share = row.bytes / largest;
          return (
            <li
              key={row.value + row.name}
              className={
                row.value === formatBytes(0) ? "fw-ruler__row fw-ruler__row--zero" : "fw-ruler__row"
              }
            >
              <span className="fw-ruler__name" {...unescapedHtml(row.name)} />
              <span className="fw-ruler__track">
                <span
                  className="fw-ruler__bar"
                  aria-hidden="true"
                  style={{ "--share": String(share) } as CSSProperties}
                />
                <span className="fw-ruler__value">{row.value}</span>
                {row.note === "" ? null : (
                  <span className="fw-ruler__note" {...unescapedHtml(row.note)} />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

export default function LandingPage({
  title,
  html,
  frontmatter,
  island,
}: {
  title: string;
  html: string;
  frontmatter: {
    readonly description: string;
    readonly cta: string;
    readonly ctaHref: string;
    readonly islandCta: string;
    readonly rulerTitle: string;
  };
  island: string;
}) {
  const { figures, sections } = splitSections(html);
  return (
    <div className={PAGE}>
      <div className="fw-hero fw-hero--home">
        <h1 className="fw-hero__title">{title}</h1>
        <p className="fw-hero__lede">{frontmatter.description}</p>
        <p className="fw-actions">
          <a className="fw-button" href={frontmatter.ctaHref}>
            {frontmatter.cta}
          </a>
          <a className="fw-button fw-button--quiet" href={island}>
            {frontmatter.islandCta}
          </a>
        </p>
        <Ruler title={frontmatter.rulerTitle} rows={figures} />
      </div>
      {sections.map((section) => {
        const layout = LAYOUTS[section.id];
        return (
          <section
            key={section.id}
            className={layout === undefined ? "fw-section" : `fw-section fw-section--${layout}`}
            aria-labelledby={section.id}
            {...unescapedHtml(layout === "data" ? tabbed(section.html, section.id) : section.html)}
          />
        );
      })}
    </div>
  );
}
