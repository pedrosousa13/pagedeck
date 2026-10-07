export default function Card({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <article className="card">
      <h3 className="card-title">{title}</h3>
      <p className="card-body">{body}</p>
    </article>
  );
}
