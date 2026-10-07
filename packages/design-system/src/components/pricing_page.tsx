"use client";

import { useState } from "react";

interface Plan {
  name: string;
  price: string;
}

function yearly(monthly: string): string {
  return String(Math.round(Number(monthly) * 10));
}

export default function PricingPage({
  fields,
}: {
  fields: { headline: string; plans: readonly Plan[] };
}) {
  const [annual, setAnnual] = useState(false);
  return (
    <div className="pricing">
      <h1>{fields.headline}</h1>
      <button
        className="pricing__toggle"
        onClick={() => {
          setAnnual(!annual);
        }}
        type="button"
      >
        {annual ? "Billed yearly" : "Billed monthly"}
      </button>
      <table>
        <tbody>
          {fields.plans.map((plan) => (
            <tr key={plan.name}>
              <td>{plan.name}</td>
              <td>{annual ? yearly(plan.price) : plan.price}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
