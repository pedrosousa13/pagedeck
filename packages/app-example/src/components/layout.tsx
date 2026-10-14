import type { ReactNode } from "react";

interface Props {
  title: string;
  html: string;
  children?: ReactNode;
}

export default function Layout({ title, html, children }: Props) {
  return (
    <>
      <title>{title}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <article>
        <h1>{title}</h1>
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {children}
      </article>
    </>
  );
}
