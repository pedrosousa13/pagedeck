export default function EmbedFrame({
  mount,
  label,
}: {
  mount: string;
  label: string;
}) {
  return (
    <div className="fw-embed">
      <p className="fw-embed__label">{label}</p>
      <div id={mount} className="fw-embed__mount" />
    </div>
  );
}
