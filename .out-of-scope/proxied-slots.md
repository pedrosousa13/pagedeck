# Proxied slots

A `"use client"` component handed JSX children by a server component is refused
at build time (#168). Building it, so those children hydrate as slots, was
issue #173. That issue was deferred until someone measured how often the
refusal is hit, and it is now rejected on that measurement.

## Why this is out of scope

Slots are built on entry-tree identity: a slot id is a position in the entry
tree, digits joined by dots, and `ISLAND_ID_PATTERN` guarantees that shape.
A proxied child has no position. Supporting it means a second id space, a
render pass per proxied child, and a stash for children the container does not
place. That is a feature of its own size, not a design point inside #168.

The deferral set the bar before the number existed: measure how often the
refusal is actually hit while dogfooding before building this. #256 measured it
on every checked-in site. The refusal count says nothing, because the refusal is
fatal and every site builds. The informative number is the population of
proxied instances, meaning client components rendered by another component's
code rather than named by the entry tree. #256 found it zero on `packages/docs`,
`packages/landing` and `packages/site`.

The refusal names the two real fixes: place the component as a node in the
entry tree, where its children become slots, or move `"use client"` down to the
interactive leaves. Nothing has needed a third.

## What would reopen it

A census row with `refusedChildren: true`, or a site that hits the refusal
where neither documented fix fits. Re-take the proxied-instance census
(`PAGEDECK_PROXY_CENSUS`, #256) whenever a site gains a client component placed by
component code rather than by the entry tree, and answer #173's four design
questions with that number in hand.

A row with `refusedChildren: false` is not the trigger. `packages/landing`'s
`/server-data` page (#625) writes one on purpose: its server component renders
the `variant_picker` island from its own code to demonstrate the proxy path,
and hands it no children. The maintainer ruled on 2026-09-30, during #625,
that this row does not meet the trigger and #173 stays closed.

## Prior requests

- #173
- #256 (the measurement)
