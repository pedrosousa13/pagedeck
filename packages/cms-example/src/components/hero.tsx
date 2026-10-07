interface Props {
  heading: string;
  text: string;
}

export default function Hero({ heading, text }: Props) {
  return (
    <section data-block="hero">
      <h1>{heading}</h1>
      <p>{text}</p>
    </section>
  );
}
