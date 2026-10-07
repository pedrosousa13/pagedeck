export default function LocaleLinks({
  links,
}: {
  links: readonly {
    readonly href: string;
    readonly locale: string;
    readonly label: string;
  }[];
}) {
  return (
    <ul className="fw-locales">
      {links.map((link) => (
        <li key={link.locale}>
          <a href={link.href} hrefLang={link.locale} lang={link.locale}>
            {link.label}
          </a>
          <span className="fw-locales__code">{link.locale}</span>
        </li>
      ))}
    </ul>
  );
}
