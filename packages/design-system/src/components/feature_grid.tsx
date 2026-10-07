// Filenames here are the CMS component names verbatim, so a catalog row's key
// and specifier can be compared without a spelling rule.
import { classesFor } from "../styling.js";
import type { ReactNode } from "react";

export default function FeatureGrid({
  columns,
  children,
}: {
  columns?: string;
  children?: ReactNode;
}) {
  return (
    <div className={`grid ${classesFor("feature_grid.columns", columns)}`}>
      {children}
    </div>
  );
}
