// `unescapedHtml` from `@pagedeck/core/tree`, never from `@pagedeck/core`, whose index
// reaches Node builtins.
import { unescapedHtml } from "@pagedeck/core/tree";
import type { TocEntry } from "@pagedeck/markdown-loader";
import DocsNav from "./nav.js";
import { BODY, PAGE, UNINDEXED } from "./shell.js";
import { neighbours } from "../sections.js";
import type { NavLink, NavSection } from "../sections.js";
import { focusablePre, wrapTables } from "../prose.js";

export default function DocPage({
  title,
  html,
  toc,
  file,
  nav,
}: {
  title: string;
  html: string;
  toc: readonly TocEntry[];
  file: string;
  nav: readonly NavSection[];
}) {
  const { previous, next } = neighbours(nav);
  return (
    <div className={PAGE}>
      <DocsNav nav={nav} />
      <div className={BODY}>
        <h1>{title}</h1>
        {toc.length > 0 && (
          <nav className="fw-toc" aria-label="On this page">
            <p className="fw-toc__label" {...UNINDEXED}>On this page</p>
            <ul>
              {toc.map((entry) => (
                <li key={entry.slug}>
                  <a href={`#${entry.slug}`}>{entry.text}</a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="fw-prose" {...unescapedHtml(focusablePre(wrapTables(html)))} />
        {(previous !== undefined || next !== undefined) && (
          <nav className="fw-pager" aria-label="Previous and next" {...UNINDEXED}>
            {previous !== undefined && <PagerLink link={previous} rel="prev" />}
            {next !== undefined && <PagerLink link={next} rel="next" />}
          </nav>
        )}
        <footer className="fw-source" {...UNINDEXED}>
          <p>Rendered from {file}</p>
        </footer>
      </div>
    </div>
  );
}

function PagerLink({ link, rel }: { link: NavLink; rel: "prev" | "next" }) {
  return (
    <a className="fw-pager__link" href={link.href} rel={rel}>
      <span className="fw-pager__dir">{rel === "prev" ? "Previous" : "Next"}</span>
      <span className="fw-pager__title">{link.label}</span>
    </a>
  );
}
