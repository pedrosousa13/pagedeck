"use client";

// Registered `idle`, yet fetches nothing until touched (#62): focus warms the shard ranges,
// and typing fetches shards.
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { reportBrowserFault } from "@pagedeck/islands/browser-report";
import { createSearchClient } from "./query.js";
import type { SearchHit } from "./query.js";

// Declared here, not via the `DOM` lib: a workspace-wide `document` would typecheck
// in node-only packages.
interface Typed {
  readonly value: string;
}
interface Clickable {
  click(): void;
}

export default function SearchIsland({
  locale,
  label,
  emptyLabel,
}: {
  locale: string;
  /** Required copy: a control announced only as "search box" passes a build and a sighted review. */
  label: string;
  emptyLabel: string;
}) {
  const client = useMemo(() => createSearchClient({ locale }), [locale]);

  const [query, setQuery] = useState("");
  // `undefined` until a query is asked: no message before typing, a status after an empty result.
  const [hits, setHits] = useState<readonly SearchHit[] | undefined>(undefined);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);

  // Fetches finish out of order; the ticket drops an answer a newer query has overtaken.
  const ticket = useRef(0);

  const options = useRef(new Map<number, Clickable>());

  const ids = useId();
  const inputId = `${ids}input`;
  const listId = `${ids}list`;
  const optionId = (position: number): string => `${ids}option-${String(position)}`;

  // Through `reportBrowserFault`, not `console`: it is the one console channel (rule 8).
  const report = useCallback((cause: unknown): void => {
    reportBrowserFault(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const run = useCallback(
    (text: string): void => {
      ticket.current += 1;
      const mine = ticket.current;
      if (text.trim() === "") {
        setHits(undefined);
        setOpen(false);
        setActive(-1);
        return;
      }
      client
        .search(text)
        .then((found) => {
          if (ticket.current !== mine) return;
          setHits(found);
          setActive(-1);
          setOpen(true);
        })
        .catch((cause: unknown) => {
          if (ticket.current !== mine) return;
          report(cause);
          setHits([]);
          setActive(-1);
          setOpen(true);
        });
    },
    [client, report],
  );

  const showing = open && hits !== undefined && hits.length > 0;

  return (
    <div className="fw-search">
      <label className="fw-search__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        aria-autocomplete="list"
        {...(showing && active >= 0
          ? { "aria-activedescendant": optionId(active) }
          : {})}
        {...(showing ? { "aria-controls": listId } : {})}
        aria-expanded={showing}
        autoComplete="off"
        className="fw-search__input"
        id={inputId}
        onChange={(event) => {
          const { value } = event.target as unknown as Typed;
          setQuery(value);
          run(value);
        }}
        onFocus={() => {
          client.warm().catch(report);
        }}
        onKeyDown={(event) => {
          if (!showing || hits === undefined) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((at) => Math.min(at + 1, hits.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((at) => Math.max(at - 1, 0));
          } else if (event.key === "Enter") {
            if (active < 0) return;
            event.preventDefault();
            options.current.get(active)?.click();
          } else if (event.key === "Escape") {
            // Prevented, or Chromium clears a `type="search"` input on the same Escape. With nothing
            // showing, Escape is the browser's and clears the query.
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          }
        }}
        role="combobox"
        type="search"
        value={query}
      />
      {showing ? (
        // A `<div>` of `<a role="option">`, not a `<ul>`: an `<li>` would break the listbox's
        // required owner. Focus stays in the input; arrows move `aria-activedescendant`.
        <div
          aria-label={label}
          className="fw-search__results"
          id={listId}
          role="listbox"
        >
          {hits.map((hit, position) => (
            <a
              aria-selected={position === active}
              className="fw-search__result"
              // `output`, not `path`: on a prefixed locale only `output` is served.
              href={hit.output}
              id={optionId(position)}
              key={hit.path}
              ref={(node) => {
                const rendered = options.current;
                if (node !== null) {
                  rendered.set(position, node as unknown as Clickable);
                }
                return () => {
                  rendered.delete(position);
                };
              }}
              role="option"
            >
              {hit.title ?? hit.path}
            </a>
          ))}
        </div>
      ) : null}
      {open && hits !== undefined && hits.length === 0 ? (
        // `role="status"`, so a reader who cannot see the list is told nothing matched.
        <p className="fw-search__empty" role="status">
          {emptyLabel}
        </p>
      ) : null}
    </div>
  );
}
