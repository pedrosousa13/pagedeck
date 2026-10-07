// Props are the entry's data, so `title` arrives beside `fields`.
export default function DocPage({
  title,
  fields,
}: {
  title: string;
  fields: { lead: string; body: readonly string[] };
}) {
  return (
    <div className="doc">
      <h1 className="doc-title">{title}</h1>
      <p className="doc-lead">{fields.lead}</p>
      {fields.body.map((paragraph, index) => (
        // Paragraphs have no identity of their own, so the index is the key.
        <p key={index} className="doc-body">
          {paragraph}
        </p>
      ))}
    </div>
  );
}
