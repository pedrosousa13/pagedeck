import { PAGE } from "./shell.js";

export default function SiteFooter({
  links,
}: {
  links: {
    readonly home: string;
    readonly docs: string;
    readonly island: string;
    readonly features: string;
    readonly serverData: string;
  };
}) {
  return (
    <footer className="fw-foot">
      <div className={`${PAGE} fw-foot__inner`}>
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
              <a href={links.features}>Features</a>
            </li>
            <li>
              <a href={links.island}>Island demo</a>
            </li>
            <li>
              <a href={links.serverData}>Server data</a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
