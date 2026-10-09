import { WRAP } from "./shell.js";

export interface SiteLinks {
  readonly home: string;
  readonly docs: string;
  readonly search: string;
}

export default function SiteFooter({ links }: { links: SiteLinks }) {
  return (
    <footer className="fw-foot">
      <div className={`${WRAP} fw-foot__inner`}>
        <p>This site is built with Pagedeck, the framework it describes.</p>
        <nav aria-label="Footer">
          <ul className="fw-nav">
            <li>
              <a href={links.home}>Home</a>
            </li>
            <li>
              <a href={links.docs}>Docs</a>
            </li>
            <li>
              <a href={links.search}>Search</a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
