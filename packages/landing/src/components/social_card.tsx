// A server component, because the hook is read only in the page's own render
// pass. Lazy, since React writes no preload for a lazy `<img>`.
import { useSocialCard } from "@pagedeck/core/tree";

export default function SocialCard({
  alt,
  missing,
}: {
  alt: string;
  missing: string;
}) {
  const card = useSocialCard();
  if (card === undefined) return <p className="fw-plate">{missing}</p>;
  return (
    <figure className="fw-figure">
      <img
        src={card.href}
        width={card.width}
        height={card.height}
        loading="lazy"
        decoding="async"
        alt={alt}
        className="fw-figure__img"
      />
      <figcaption>
        <dl className="fw-facts">
          <div>
            <dt>og:image</dt>
            <dd>{card.href}</dd>
          </div>
          <div>
            <dt>size</dt>
            <dd>{`${String(card.width)} x ${String(card.height)}`}</dd>
          </div>
        </dl>
      </figcaption>
    </figure>
  );
}
