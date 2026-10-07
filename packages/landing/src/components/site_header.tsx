// Renders the page's `<meta name="viewport">`, which core lifts into the
// `<head>` (#239).
import { PAGE } from "./shell.js";

export default function SiteHeader({
  links,
  current,
}: {
  links: {
    readonly home: string;
    readonly docs: string;
    readonly island: string;
    readonly features: string;
    readonly serverData: string;
  };
  current: string;
}) {
  const here = (href: string) => (href === current ? "page" : undefined);
  return (
    <header className="fw-bar">
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <div className={`${PAGE} fw-bar__inner`}>
        <a className="fw-wordmark" href={links.home} aria-current={here(links.home)}>
          Pagedeck
        </a>
        <nav aria-label="Site">
          <ul className="fw-nav">
            <li>
              <a href={links.docs}>Docs</a>
            </li>
            <li>
              <a href={links.features} aria-current={here(links.features)}>
                Features
              </a>
            </li>
            <li>
              <a href={links.island} aria-current={here(links.island)}>
                Island demo
              </a>
            </li>
            <li>
              <a href={links.serverData} aria-current={here(links.serverData)}>
                Server data
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
}
