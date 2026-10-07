import type { ImageAttributes } from "@pagedeck/core/images";

export default function ResponsiveImage({
  image,
  alt,
  facts,
}: {
  image: ImageAttributes;
  alt: string;
  facts: readonly { readonly label: string; readonly value: string }[];
}) {
  return (
    <figure className="fw-figure">
      <img {...image} alt={alt} className="fw-figure__img" />
      <figcaption>
        <dl className="fw-facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </figcaption>
    </figure>
  );
}
