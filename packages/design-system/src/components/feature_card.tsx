// A fixed `<h2>`: only an `<h1>` sits above a grid in the site's entries, and no
// nesting can make `<h2>` skip a level (#296).
export default function FeatureCard({
  title,
  body,
}: {
  title: string;
  body?: string;
}) {
  return (
    <article className="card">
      <h2>{title}</h2>
      {body === undefined ? null : <p>{body}</p>}
    </article>
  );
}
