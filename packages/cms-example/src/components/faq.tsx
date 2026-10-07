"use client";

import { useId, useState } from "react";

interface Props {
  questions: readonly { question: string; answer: string }[];
}

export default function Faq({ questions }: Props) {
  const id = useId();
  const [open, setOpen] = useState<number | undefined>(undefined);
  return (
    <section data-block="faq">
      {questions.map(({ question, answer }, index) => (
        <div key={question}>
          <h2>
            <button
              type="button"
              aria-expanded={open === index}
              aria-controls={`${id}-${String(index)}`}
              onClick={() => setOpen(open === index ? undefined : index)}
            >
              {question}
            </button>
          </h2>
          <p id={`${id}-${String(index)}`} hidden={open !== index}>
            {answer}
          </p>
        </div>
      ))}
    </section>
  );
}
