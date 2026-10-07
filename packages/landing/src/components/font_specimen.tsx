export default function FontSpecimen({
  sample,
  facts,
}: {
  sample: string;
  facts: readonly { readonly label: string; readonly value: string }[];
}) {
  return (
    <div className="fw-plate">
      <p className="fw-specimen">{sample}</p>
      <dl className="fw-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
