# Coding standards

This file is for the reviewer. It does not hold the rules. It says where this
repo records its rulings, so a diff can be held against them. The rules for
working in the repo are in `AGENTS.md`.

## Where the rulings are

- **`GLOSSARY.md`, "Standing decisions"**: decisions that bind work beyond the
  issue that made them. Read the ones that touch the area the diff changes.
- **`docs/adr/`**: architectural decisions, with the alternatives and their
  consequences. Read an ADR when the diff changes the design it records.
- **A package's `README.md`**: rulings on that package's behaviour, marked
  with the issue that made them, such as "ruled on #89". Read the README of
  each package the diff touches.
- **`docs/error-messages.md`**: how a build failure is written. Read it when
  the diff throws or changes a message.

Comments follow `GLOSSARY.md`'s standing decision **Comments say only what the
code cannot**.

## The hard rule

A diff that contradicts a ruling recorded in one of these places is a hard
violation. The fix is to keep the ruling, or to stop and ask the maintainer.
A reviewer never accepts a silent change to a ruling.
