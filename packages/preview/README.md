# `@pagedeck/preview`

The preview app a build can emit for a visual editor. It loads the site's
whole component registry and renders each draft the editor sends it, through
the same render code that built the pages. Declare `build.preview`, and
`pagedeck build` writes the app under the path you name. The app imports this
package, so a site that declares `build.preview` installs it.

```sh
npm install @pagedeck/preview
```

```ts
// In the site's config, inside build:
preview: {
  path: "/_preview",
  bridge: "./src/preview-bridge.ts",
},
```

This writes `/_preview/index.html`, with the app's own chunks under
`/_preview/assets/`. Your pages load none of it.

`bridge` is optional. It names a module of yours that default-exports a
`PreviewBridge`: an object with a `subscribe(onDraft)` method that passes each
draft from your editor to `onDraft` and returns a function that stops. Without
a bridge, the app renders nothing until something sends it a draft.

The app authenticates nothing. Anyone who can reach its path can post a draft
to it and see it rendered, so put the path behind whatever access control your
drafts need.

## Read more

[Preview app](https://github.com/pedrosousa13/pagedeck/blob/main/packages/docs/content/reference/preview.md) covers security, how to
write a bridge, the path rules, sites with a domain per locale, and what the
app does not do.
