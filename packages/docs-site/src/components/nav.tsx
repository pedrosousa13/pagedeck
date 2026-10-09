// Not a registered component: no entry tree names it. Kept out of the index by
// `data-fw-search`, which unlike `hidden` changes nothing a reader gets.
import type { NavSection } from "../sections.js";
import { UNINDEXED } from "./shell.js";

export default function DocsNav({ nav }: {
  nav: readonly NavSection[];
}) {
  return (
    <nav className="fw-docnav" aria-label="Documentation" {...UNINDEXED}>
      <details className="fw-docnav__toggle">
        <summary className="fw-docnav__summary">Contents</summary>
        {nav.map((section) => (
          <section key={section.label}>
            <h2>{section.label}</h2>
            <ul>
              {section.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} {...(link.current ? { "aria-current": "page" as const } : {})}>
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </details>
    </nav>
  );
}
