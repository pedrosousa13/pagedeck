---
title: 8. The manifest version moves only when a document can be misread
description: The manifest version moves when two documents can be read as different facts, and not for an optional column every reader reads alike.
---

# 8. The manifest version moves only when a document can be misread

Date: 2026-10-01

## Status

Accepted. Each entry below was decided on the issue it names. Until #633 the
rule and the ledger were a comment on `MANIFEST_VERSION` in
`packages/core/src/manifest.ts`, and #633 moved them here.

## Context

`readManifest` refuses a document whose `version` is not `MANIFEST_VERSION`.
That refusal is the only thing that stops a reader from acting on a document
another build wrote as if it meant something else.

The refusal also has a cost. A bump makes every retained manifest of an older
version unreadable, so `fw rollback` to it is refused. A bump also changes
`manifest.json` for every site, including the sites that do not use the new
column.

## Decision

Bump `MANIFEST_VERSION` when an older and a newer document can be read as two
different facts that lead a reader to different actions. A required column
always bumps, because an absent section is a gap that a reader has to
interpret.

Do not bump for an optional column when the two readings of its absence, "this
build recorded nothing" and "this build predates the column", lead every reader
to the same correct action. Do not bump either when a bump would change
`manifest.json` for sites that do not use the feature and the issue asks for
those sites to keep their bytes.

`ROUTING_VERSION` follows the same rule. It is a separate number because
`@fw/edge` reads the routing document alone and never opens a manifest, so a
bump for a manifest column must not become an edge incompatibility. The
reverse does not hold: the routing document is embedded in the manifest, so a
routing change that a reader must refuse moves both `ROUTING_VERSION` and
`MANIFEST_VERSION`, because a manifest holding a routing section its reader
cannot read is unreadable as a whole.

A claim that no older document exists outside a branch is not a reason to skip
a bump. Nothing can check a claim about branch state.

## The ledger

- **2, #28.** The `store` position, and `pages[].components` becomes an input
  that an incremental build replays into `planEntries`. A document written
  when the column meant something else would be replayed as if it meant this.
- **3, #30.** The `routing` section, required. "This build has no redirects"
  and "this build predates redirects" must not read the same.
- **4, #24.** `pages[].foldTuning`, required. Fold tuning is on by default, so
  "never tuned" and "predates tuning" differ on most documents.
- **5, #38.** `pages[].fallbackFrom`, optional. A version-4 reader would see a
  route table with no fallback pages, which is what a site without fallbacks
  looks like. Nothing in the emitted HTML tells the two apart.
- **6, #29.** No new column. An empty `classes` now means "this build's pages
  used no class", not "nothing extracted classes". The drift check would read
  an older empty set as every class on every page drifting.
- **7, #29.** `fullRebuild`, optional. Each reader would read "no rebuild was
  asked for" off a build that asked for one, or off a build that never checked.
  The bump was taken although no version-6 document existed outside the branch.
- **8, #32.** `build.parent`, optional. Last-write-wins detection compares this
  column. A misreading either refuses a deploy that is in order or accepts the
  out-of-order deploy that the detection exists to catch.
- **9, #315.** `pages[].inlineScriptHashes`, optional. A `script-src` built
  from an older document would block the script loader in production.
- **10, #307.** `files[].search`, optional. An incremental build would read "the
  previous build indexed nothing" and write an index that holds only the pages
  it rendered.
- **11, #499.** `pages[].inlineScriptHashes` widens from the script loader to
  every inline script core writes. An older list read as complete would block
  the pre-paint scripts, the speculation rules block and the RUM beacon.

Columns added without a bump:

- **`pages[].variants`, #34.** A build that predates the feature could not have
  a split to record, so both readings are the same fact. #34 also asks for zero
  output difference on builds that declare no variants, and a bump would change
  every site's manifest.
- **`routing.trees[].experiments`, #34**, without a bump of either version, on
  the same ground. One cost falls on the edge alone: an older `@fw/edge`
  compiles a document with splits it does not know about without refusing it,
  and serves the primary page for every request. That is the site as it was
  before the experiment was declared, not a wrong site.
- **`files[].hashed`, #560.** A deploy gives a row without the key `no-cache`,
  which is correct under both readings. A bump would refuse a rollback over a
  key that a reader can do without.
- **`routing.trees[].redirects[].file`, #553**, without a bump of either
  version. Documents built at the first #553 commit (b4c1141) carry file
  targets with no mark, so the misreading can happen. It costs one extra 308
  to a file that exists, which is less than refusing every retained document.
- **`files[].fontPages`, #573.** A build before the column could not scope a
  face, so "no row carries the column" is true either way. A site that scopes
  no face keeps its bytes.
- **`pages[].noindex`, #592.** A page without the key was written without
  `noindex` under both readings.
- **`files[].chunk`, #720.** The name and modules of a chunk Rolldown split off
  outside the tier groups, which the next incremental build pins. A document
  without the column says "this build split nothing off" or "this build
  predates the column", and under both readings an incremental build pins
  nothing, which is what every incremental build did before #720. A site whose
  islands share no module outside the tiers keeps its manifest bytes.

## Consequences

A change to the manifest's shape or meaning is judged against this rule when
it lands, and gets an entry in the ledger above.
