// Renders the page's `<meta name="viewport">`, which core lifts into the
// `<head>` (#239).
import { WRAP } from "./shell.js";
import type { SiteLinks } from "./site_footer.js";

export default function SiteHeader({
  links,
  current,
}: {
  links: SiteLinks;
  current: string;
}) {
  const here = (href: string) => (href === current ? "page" : undefined);
  return (
    <header className="fw-bar">
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <div className={`${WRAP} fw-bar__inner`}>
        <a className="fw-wordmark" href={links.home}>
          Pagedeck
        </a>
        <nav aria-label="Site">
          <ul className="fw-nav">
            <li>
              <a href={links.docs} aria-current={here(links.docs)}>
                Docs
              </a>
            </li>
            <li>
              <a href={links.search} aria-current={here(links.search)}>
                Search
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
