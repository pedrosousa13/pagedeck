interface Props {
  paragraphs: readonly string[];
}

export default function RichText({ paragraphs }: Props) {
  return (
    <section data-block="rich_text">
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </section>
  );
}
