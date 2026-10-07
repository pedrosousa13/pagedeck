// The body renders as text, not through `unescapedHtml`: legal copy is pasted in
// from elsewhere.
export default function LegalPage({
  title,
  fields,
}: {
  // The entry's title, which is metadata beside `fields`.
  title: string;
  fields: { body_text: string };
}) {
  return (
    <div className="legal">
      <h1>{title}</h1>
      <p>{fields.body_text}</p>
    </div>
  );
}
