# `@pagedeck/docs`

Pagedeck's documentation as markdown, published at the same version as
`@pagedeck/core`. A site builds its docs pages from it: Pagedeck's own site on
deck.cool reads it at build time.

The package holds markdown pages, a `nav.json` and an `assets/` directory, and
no code:

- Each page is a `.md` file with a `title` and a `description` in its
  frontmatter. A page's route comes from its path.
- `nav.json` lists the groups of the navigation and the pages in each, in
  reading order. It lists every page once.
- A link between pages is a relative link to the other `.md` file. An image
  is a file under `assets/`, linked relatively.

The tutorials, how-to guides and reference pages live in this directory. The
architecture decision records, `deploy-recipe.md` and `error-messages.md` live
in the repository's `docs/` directory and are copied in when the package is
packed.
