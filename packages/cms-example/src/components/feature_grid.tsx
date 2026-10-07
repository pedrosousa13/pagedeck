interface Props {
  features: readonly { title: string; text: string }[];
}

export default function FeatureGrid({ features }: Props) {
  return (
    <ul data-block="feature_grid">
      {features.map(({ title, text }) => (
        <li key={title}>
          <h2>{title}</h2>
          <p>{text}</p>
        </li>
      ))}
    </ul>
  );
}
