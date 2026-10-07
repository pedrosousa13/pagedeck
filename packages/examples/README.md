# @pagedeck/examples

Runnable examples of the public contracts. `src/examples.test.ts` compiles and
runs each one in CI. Change a contract that has an example, and change its
example with it.

## Contracts without an example

Which contracts get an example is `CONTEXT.md`'s standing decision **An example
runs in process, and a contract it cannot show is listed**. A new public
contract gets an example or joins this list:

- `@pagedeck/core`: `defineConfig`, `runCli`, `syncSite`, `defineLocales`,
  `loadConfig` and the `LoadedConfig` and `LoadedBuildSection` it returns
  (#708),
  `canonicalizePath`, `getEntryCached`, `openStoreReadOnly`,
  `loadFixtureStore`, `readDelta` (#28), `RootProviderStack` (#66), the
  snapshot verbs, `PageChrome` (#409), the paged list (`paginate` and its
  types, #323), the script layer and consent (`defineScripts`,
  `resolveScriptStrategy`, `ScriptRuntimeAdapter`, `ConsentSource`,
  `resolveConsentDefault`, the five consent names; #46, #47, #460), drift
  (`checkDrift`, `driftWarnings`, `compileSupplements`,
  `DEFAULT_DRIFT_THRESHOLD`, their types, `FullRebuildRequest`,
  `StylingSafelist`; #29, #260), search (`SearchAdapter`, `SearchDocument`,
  `SEARCH_ATTRIBUTE`; #62, #566), links (`LinkProbe` and its setting types,
  #31), retention and the deploy chain (`listRetainedManifests`,
  `retainManifest`, `readRetainedManifest`, `RetentionPolicy`,
  `DEFAULT_RETENTION_POLICY`, `RETENTION_DIR`, `BuildStamp.parent`,
  `pagedeck rollback`, `pagedeck diff --force`; #32), routing and experiments
  (`RoutingConfig` and its types, `VARIANT_SEGMENT`, `VariantRule`,
  `WeightedVariant`, `ResolvedExperiment`, `RoutingTree.experiments`,
  `ManifestVariant`, `ManifestPage.variants`, `variantPath`; #270, #34), the
  publication window (`publicationChanges`, `ScheduledCollection`, #36), the
  font seam (`FontAdapter` and its four shapes), and the `BuildSection` fields
  `head`, `chrome`, `driftThreshold`, `driftSupplement`, `safelist`, `search`,
  `links`, `retention`, `routing`, `sitemap`, `feed`, `favicon`, `robots`,
  `preview`, `passthrough`, `speculation`, `viewTransitions` and `fonts`, with
  the setting types each is written in (#40, #42), and `fromCollection`'s
  `layout` with the frontmatter `components` list it reads, a claim about a
  build's output (#712).
- `@pagedeck/core/dev`: `startDevServer`, `devOrigin`, `DevServer` (#268).
- `@pagedeck/content`: `PublishWindow`.
- `@pagedeck/content/escape`: `printable` and `quoteIdentifier`, which keep a
  value from outside out of a message's terminal controls (#730).
- `@pagedeck/islands`: `entryId`, `hydrationContradiction`,
  `HYDRATION_CONTRADICTION_FIX`, `checkRootProviders`, `rootProviderProbe`
  (#66); `store`, `hydrateStore`, `useStoreCallback`, `checkSharedStore`,
  `markRootsMounting`, `StoreError` (#252); `hotIslands`; `componentFaults`,
  which `loadConfig` runs on a config's components (#708).
- `@pagedeck/search`: `defineSearch`, `QUERY_CAP` (#457), `createSearchClient`
  and the search island (#62).
- `@pagedeck/font-subset`: `defineFontSubset`.
- `@pagedeck/edge`: `defineAdapter`, `EdgeAdapter`, `AdapterDefinition` and the
  artifact types, and each adapter package's factory (#19). `build.adapter`
  (#20) is where a config first calls one.
- `create-pagedeck`: `create` and `ArgumentError`, which its bin calls (#691).
- `@pagedeck/bench`: every export. Its `./components/*` subpath is not a
  contract.
