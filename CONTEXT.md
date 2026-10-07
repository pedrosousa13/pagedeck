# Pagedeck

A static-site framework: content is synced into a store, rendered to HTML at
build time, and hydrated island by island. This file holds the project's
shared vocabulary and the standing decisions that bind work beyond the issue
that produced them.

Architectural decisions with alternatives and consequences live in
`docs/adr/`. This file does not repeat them; it points at them.

## Language

**Pagedeck**:
The product's name, chosen on 2026-10-02 (#651). The CLI is `pagedeck`, the
packages are `@pagedeck/*`, a site's config file is `pagedeck.config.ts`, the
environment variables start `PAGEDECK_`, and the working directory is
`.pagedeck/`. Until #651 the working name was "framework", with an `fw` CLI and
an `@fw/*` scope. ADRs, research notes and issue text keep the old name. What a
page ships keeps the `fw` prefix, as the standing decision
**Page output keeps the `fw` prefix** records.
_Avoid_: "fw" and "the framework" as the product's name. "The framework" as a
common noun, for what Pagedeck is, is fine.

**Entry id**:
The key an entry is filed under, a `locale` and a `path`. It is a key, not a
file path or a URL, so a loader may build either one out of it.
_Avoid_: entry path, entry key. Also `slug` for the id itself — but `slug` is
right where it names a field a CMS spells that way.

**Loader**:
The site-supplied source a collection syncs from. It reports entries to a
`CollectionWriter`, and may also resolve a single entry on demand.
_Avoid_: provider, adapter

**Image adapter**:
The site-supplied function spec §10 states as `(src, width, quality, format) →
URL`. Core ships exactly one, the URL template (`urlTemplate`), and names no
service anywhere.

It is written down because **Loader**, above, puts *adapter* under _Avoid_, and
that entry is what governs: a loader is not an adapter, and calling one an
adapter is the drift being refused there. This is the one thing in the codebase
that *is* one — it adapts a request the framework composes to the URL shape a
service reads, holds no state, and syncs nothing — and it is named for what the
spec and issue #43 call it, so the word is claimed here rather than left to
collide. An image adapter never reports entries and a loader never builds a URL;
if a future contract needs the noun again, it earns an entry here too.
_Avoid_: image loader, image provider, CDN driver

**Font adapter**:
The site-supplied function `build.fonts.adapter.subset` names: in, one
declared face's resolved source path and the Unicode ranges its subset is
built from (`FontSubsetRequest`); out, the subset bytes and the metrics the
adapter read while it had the font open (`FontSubsetResult`, `FontAdapter`,
spec §10, #45). Core ships none and names no subsetting engine, on `search`'s
precedent. Subsetting means parsing an OpenType binary and writing a new one,
work spec decision 13 already pushed out of core for images, and a font has no
CDN that serves an arbitrary subset at a templated URL. So core keeps what it
can decide from data it holds (the CSS, the fallback math, which faces preload)
and hands the one step that needs a parsed font to the site.

The ranges are declared by the site, never scanned off rendered pages — the
guarantee this noun carries beyond `search`'s own precedent: a subset does not
depend on which pages a build rendered, so an incremental build owes it nothing
— where `build.search` is owed a patch of the previous index, or every page
rendered for an adapter without one (#307) — and the font's own bytes do not
change just because a page's wording did.
A face's page scope (`FontFace.pages`, #573) is not part of this guarantee:
it decides which pages link a face's stylesheet, not what the subset holds, so
an incremental build after a scope moves renders the pages the old and new
patterns match.

It claims *adapter* on **Image adapter**'s terms, and the case is worth making
against both of that entry's counterparts rather than only asserted. It is not
a **Supplement compiler**: that entry's own test is "handed names, returns
bytes that did not exist until the site's toolkit ran", and a font subset
genuinely is such bytes — but `SearchAdapter` (`search.ts`) answers with an
index's own bytes on the identical test and was still named *adapter*, because
what a compiler's bytes answer to is unconstrained beyond validity, while this
one's answer fills a container core already decided the shape of:
`fontFaceRule` writes `src: url(href)` and `fontPreloadLink` writes the `href`
attribute itself, both already-decided CSS and HTML this build composes once
the adapter answers, the way an image adapter's URL fills an attribute this
build had already decided on. It is not a **Dominant-color probe**, for that
entry's own test: a probe "goes and asks a host about one thing" and answers
with a value core folds into its own decision, where this answers with the
bytes a browser fetches and renders outright — load-bearing output the build
serves, the way an image adapter's URL and a script runtime adapter's markup
are. The one thing neither counterpart's answer carries is
`FontSubsetResult.metrics`, and it travels for a script runtime adapter's own
reason: nobody but the adapter has the font open, so nobody but the adapter can
answer what that font's own tables say.
_Avoid_: font loader (*loader* is a collection's sync source), font compiler,
subset compiler (a Supplement compiler's freedom over its own bytes is not
this seam's — its answer fills a container core already decided), font probe,
font provider (*provider* is Root provider stack's)

**Social image adapter**:
The site-supplied function `build.socialImages.adapter.draw` names: in, one
page, the title `build.head` gave it and whatever `build.socialImages.inputs`
returned for it; out, the drawn bytes and how big they are
(`SocialImageRequest`, `SocialImageResult`, `SocialImageAdapter`, spec §13,
#326). Core ships none and names no renderer — `@pagedeck/social-image` is a
**publishable package** beside it, the arrangement `@pagedeck/font-subset` has.

It claims *adapter* on **Font adapter**'s terms rather than on a fourth set of
its own, and meets that entry's test the same way: the answer is bytes, but
bytes filling a container core had already decided the shape of. The URL lands
in `PageHead.image` — the field a site has always been able to fill by hand —
and the size lands in the three `<meta>` tags `headElements` derives from it, so
where a card goes and what says so are not the adapter's to decide. That is the
whole of why it is a *source* and not a second writer of the `<head>` (Standing
decisions, below): it draws, and `headElements` writes.
_Avoid_: OG image adapter (*og:image* is one tag a card fills, not the thing),
card renderer, social image generator, image adapter (taken, above — that one
answers a URL for a picture the site already has, and draws nothing)

**Card**:
What a social image adapter drew for one page: the file the build
content-hashes into `/social/`, and what that page's `og:image` then points at
(`SocialCard`, #326).

The word is already spoken for — `feature_card` is a `@pagedeck/design-system`
component, and `component-classes.ts` gives it the CSS class `card` — so the two
are told apart the way **Script loader** is told apart from *loader*: by
compounding. Write "social card" in any sentence that could be about either.
The bare noun is granted the same scoped exception, and for that entry's reason:
inside the social-image stage of `packages/core/src/build.ts`,
`packages/social-image`, and the `build.socialImages` half of the page-head
reference, there is nothing a *card* could be except this one.

A card is drawn for a page this build **renders**, and never for one it
carried: an incremental build reads a reused page's card back off the tree
beside its document, the way #281 already reads the document (Standing
decisions, below).

A card is drawn **before any page renders** (#574), so a page's components can
show their own page's card: `useSocialCard()` from `@pagedeck/core/tree` hands them
the same URL the `og:image` names, and `undefined` on a page with no card. The
path stays a hash of the drawn bytes; it is known early because the drawing
moved, not because the path is composed from the page. The cost is order: a
site's `head`, `socialImages.inputs` and `adapter.draw` callbacks run before
its `content` and `chrome` callbacks.
_Avoid_: OG image (that is the tag), social image (that is the *feature* —
`build.socialImages` — and the file is one card of it), preview image, share
image, thumbnail

**Script runtime adapter**:
The site-supplied function that backs the `worker` strategy of the third-party
script layer: in, one page's `worker` loadout; out, the finished elements that
load it off the main thread (`ScriptRuntimeAdapter`, spec §12, #46). Core ships
none and names no vendor.

It earns an entry because **Image adapter**, above, says a future contract
needing the noun does, and this is that contract. The two are the same
arrangement and not the same thing: an image adapter answers one URL that core
then puts in an attribute it had already decided on, while this one returns the
markup itself, because the mechanism is a client-side one and a place in the
document is the only thing core can hand across that boundary without knowing
it. Both are adapters in the sense that entry claims — they adapt what the
framework composed to the shape a service reads, hold no state, and sync
nothing.
_Avoid_: worker adapter (the field is `runtime`, and `worker` is one strategy of
four), script provider, Partytown adapter (core names no vendor)

**Script loader**:
The `<script>` element a page carries so that its `idle`, `interaction` and
`facade` scripts are appended when their trigger fires
(`packages/core/src/script-elements.ts`). The build composes it as a string and
emits it in the `<body>`, after the page's own entry chunk; it runs only in a
browser.

There is one of it per page and it is not the only script the layer's neighbours
write there: since #48 a **RUM beacon** (below) may sit after it. So this is the
one script loader a page carries rather than the one script — the article
belongs to the noun, not to the slot.

Written down because **Loader**, above, holds the bare noun for a collection's
sync source, and these two share nothing but the word: a loader reports entries
into a store at build time, a script loader appends `<script>` elements in a
browser and never sees an entry. The collision is resolved by compounding, the
way **Image adapter** resolves *adapter* — write "script loader" in any sentence
that could be about either, and the bare noun only inside the script layer's own
modules, where nothing syncs a collection. Renaming the thing in code was the
alternative and is refused for the same reason as there: it is what the feature
does, and a word invented to dodge a collision reads as a different mechanism.
_Avoid_: script runtime (that is the site's adapter, above), bootstrap, shim,
loader (unqualified, outside the script layer)

**Script "off"**:
The one value an override layer may set that is not a loading strategy: it
takes the script off every page the key covers, so those pages carry none of
its bytes (`ScriptOverrideMap`, spec §12, #345). A **Script loader**, above, is
emitted for what a page keeps, and a page every declared script is off on emits
nothing at all.

Written down because the four strategies answer *how* a script loads and this
answers *whether* it loads, and the two are told apart the way this page tells
*adapter* apart from *loader*: `"off"` is a member of the override map's value
union and never of `ScriptStrategy`, so a sentence calling it a strategy is
naming a fifth member of a type that has four. It is also not an exclusion
list. Because `pages` beats `pageTypes`, the same value is how a script is
opted *in* — a broad key sets it off and a narrow one names a strategy — and
calling it a disable switch describes a second mechanism this layer does not
have.

A declaration cannot say it: `ScriptDeclaration.strategy` takes a
`ScriptStrategy` and stays one, and a script no page loads is what
`unloadedScriptWarning` reports rather than a config shape to write on purpose.
_Avoid_: the off strategy, the fifth strategy, disable, exclusion map, opt-out
map

**Facade key**:
The eight lowercase hex characters a page's `data-fw-facade` values begin with,
minted from a digest of that page's facade markup and shared by every
placeholder on it (`packages/core/src/script-elements.ts`, #316). The whole
attribute is that key and the facade's position — `data-fw-facade="9f1c2ab3-0"`
— and only the position tells two placeholders on one page apart.

It is per page and not per site: two pages carrying different facades carry
different keys, and one unchanged page built twice carries the same one, which
is what keeps it inside the determinism invariant rather than beside it.

Written down because *key* is spoken for twice already on this page. It is not
an **Entry id**, above, which opens "the key an entry is filed under" and names
content; and it is not a key of the script override layer, which is a page
pattern a site writes in config (**Script "off"**, above, is one value such a
key can take). This one is written by no site and read by no site: the build
mints it and the **Script loader**, above, reads it back out of a selector.

It is also not an authenticator, and calling it a token or a signature claims
what `docs/adr/0006-slot-ids-are-not-authenticated.md` refuses. It is derived
from bytes a site can read, so what it does is stop a facade's own markup from
naming another facade's placeholder; a page's own JSX, and a `data-fw-facade`
typed into a rich-text field, are untouched by it. The second is stripped at
the content door instead (`unescapedHtml`, #394).
_Avoid_: facade id, facade token, facade nonce, facade hash (that is the digest
it is cut from), key (unqualified, outside the script layer)

**Facade mount point**:
The `id` of the element a facade's placeholder is emitted inside, declared by
the site as `ScriptFacade.mount` (`packages/core/src/scripts.ts`, #461) and
resolved against the page's own rendered tree by `mountFacades`
(`packages/core/src/build.ts`). A facade that declares none takes the default:
last inside `<main>`, after the page's content. A page that renders no element
carrying the id fails the build rather than falling back to that default.

It is a point *in the page*, which is what the noun is doing: the id is spelled
in a component the site wrote, and the declaration only names it. That is why
the mount point is an id rather than a position the config states — the layer
that knows where an embed belongs is the component tree, and the page still
reaches the document writer as one rendered string.

It is not the element the vendor mounts into, though it is usually the same
element: the placeholder goes *inside* the mount point and is removed once the
script loads, so what the vendor finds is the site's own element, still there.
_Avoid_: facade anchor, facade slot, facade target, mount element (that is the
element, not the point), mount selector (it is an id)

**Consent state attribute**:
The `data-fw-consent` a gated facade's placeholder carries, whose value is what
that script's consent category answers right now — `granted` or `denied`.
`CONSENT_ATTRIBUTE` is the name, `CONSENT_GRANTED` and `CONSENT_DENIED` are the
two words (all three in `packages/core/src/consent.ts`, and `ConsentDefault` is
declared from the pair), and `scriptElements`
(`packages/core/src/script-elements.ts`) is what writes it (#460). The build
bakes this page's market default into the emitted markup and the **Script
loader**, above, rewrites it on every consent change, so it tracks rather than
reports once.

It exists so that a press refused by the gate is something a site can answer.
Core says nothing to the reader — it has no copy and no locale to say it in —
and this is the state a site's own CSS restyles, disables or routes from.

*State* is compounded rather than left bare, and the survey is owed before the
noun is claimed. One sense is live here as the bare noun and it is **Shared
store**'s, below: state a page *holds* — cross-island state, the module-level
state one module graph makes one store of
(`docs/adr/0007-islands-are-built-in-one-module-graph.md`), the stored state the
**Pre-paint script**, below, reads before the first paint. That sense is
something kept, and it is what this one is not: the framework holds no consent
state of its own (`packages/docs/content/reference/third-party-scripts.md` says
so to a site's author), the loader asks the site's source again at every
decision and remembers nothing, and what this attribute carries is a reading of
an answer somebody else owns. Every other sense is compounded already —
publication state in the incremental build, ARIA state in the islands — and
*state* is this repository's standing verb besides, which is no rival for a
noun.

*Consent state* is then inherited rather than minted here, which is what makes
the compound cheap: the code has used the term since #47
(`packages/core/src/consent.ts`), and the reference page writes it. This entry adds the
head noun and nothing else. Write "consent state" in any sentence that could be
about either sense, the way **Script loader**, above, compounds *loader*; the
bare noun is safe only where the script layer is already the subject, as it is
in this entry.

Written down because the sentence that gets it wrong is the one it invites:
**it is not a gate and not a second answer.** The gate is read at the press and
is unmoved by this; a value forged in a site's own markup styles the element it
is on and reaches nothing, which is
`docs/adr/0006-slot-ids-are-not-authenticated.md`'s holding arriving again one
attribute along from the **Facade key**, above. Nor is it a promotion: a grant
moves the attribute and loads nothing, because a facade asks whether this
visitor wants this embed and an ask does not keep.

A script with no category, and a `necessary` one, have no state to report and
their placeholders carry none of it.
_Avoid_: consent flag, consent gate attribute (it gates nothing), denied slot,
facade state (the placeholder has no other state to be about), data-consent
(one spelling: `data-fw-consent`, in the `data-fw-*` family the **Facade key**
already names on the same element), state (unqualified, inside the script layer)

**Consent source**:
The site-supplied object at `window.fwConsent` that answers, in the browser,
whether this visitor has consented to one category — `ConsentSource`, spec §12,
#47. Core ships none, names no consent manager, and reads it only at the moment
a gated script would load.

It is deliberately **not** called an adapter, and that is the entry above
governing rather than an oversight. An image adapter and a script runtime
adapter both take something the framework composed and return something the
framework then places; this returns neither markup nor a URL, is not called by
the build at all, and exists only at runtime. What it is is a *source of an
answer*, which is what the word says. Nor is it a loader: it reports no entries
and loads nothing.
_Avoid_: consent adapter, consent provider, CMP (that is the product a site
wires this to, and core names none), consent manager

**RUM beacon**:
The `<script>` a page carries when a site declares `build.beacon`, one per page
and last in the `<body>`, which measures that visit's LCP, CLS and INP and
reports them, with the page's
`(locale, path)`, to the endpoint the site named (`packages/core/src/beacon.ts`,
spec §12, #48). Core writes it, sends nothing itself, and receives nothing: what
is behind the endpoint is the site's.

Written down because *beacon* is already a word on this page's territory in two
other senses, and neither is this. It is not a **Script loader**, above: that one
loads somebody else's `src` on a trigger, and this one has no `src` and loads
nothing — it is core's own code, inline, which is why it is `build.beacon` and
not a fifth `ScriptDeclaration`. And it is not `navigator.sendBeacon`, which is
the browser API this thing reports *through*; write "the RUM beacon" for the
feature and spell the API in full when the sentence is about the transport.

The compound is kept even where the context is unambiguous, for **Script
loader**'s reason: a bare "beacon" in a file that also mentions `sendBeacon`
reads as the API.
_Avoid_: web-vitals script (it is not a vendor's script and there is no
`web-vitals` library in this tree), analytics beacon (*analytics* is the consent
category it waits on, not what it is), telemetry, metrics client

**Reference banner**:
`@pagedeck/design-system`'s `consent_banner` — the worked consent banner #47 asks for,
static markup the build renders plus an island that turns a press into a
**consent source** (above). It is one implementation of that interface and not a
feature of the framework: no package of `@pagedeck/core` imports it, no build emits
it, and a site gets it by registering it like any other component.

Written down because the entry above puts *CMP* under _Avoid_ and this is the
thing nearest to being one. It is not: it records one visitor's answer in that
browser and answers `granted` from it, keeping no audit log and syncing nothing.
The distinction is what the reference page's two CMP recipes are for — a site
that must prove consent wires a real consent manager to the same one method, and
the banner is what a site with nothing to prove uses instead.
_Avoid_: cookie banner (it is about consent, of which cookies are one
mechanism), consent widget, the CMP

**Pre-paint script**:
A synchronous script the site declares in `build.prePaint`, which `headElements`
writes into every page's `<head>` in a block of its own between the font
preloads and the stylesheets, so that stored state the first paint depends on —
a theme, a returning visitor's consent decision — is installed before the parser
reaches anything that reads it (`packages/core/src/pre-paint.ts`, #311, #330).
Core carries the slot and never learns what is in it: the text is the site's,
and the **Reference banner**, above, ships one for the record it keeps.

Written down because *script* is the most contested noun on this page and this
is its fourth sense, and because the sentence that gets it wrong is one somebody
will write: it is **not a fifth `ScriptStrategy`**. `idle`, `interaction`,
`facade` and `worker` all answer when a *deferred* script runs; this one runs at
parse, inline, with no request in front of it and no trigger behind it. That is
**Script "off"**'s test read one door along — `"off"` is not a strategy because
it answers *whether* rather than *how*, and this is not one because it is not
that layer's script at all. Declared as a strategy it would inherit the layer's
consent gate, and gating the snippet that installs the consent answer on the
consent answer is a circle.

It is not a **Script loader**, above, on that entry's own terms. A script loader
is core's own code, one per page, at the end of the `<body>`, appending somebody
else's `src` when a trigger fires; this is the site's own code, in the `<head>`,
finished before the loader has been parsed, and a page carries as many as the
site declared rather than one. Nor is it a **RUM beacon**, which is also core's
code and also last in the body — core writes not a byte of this one, which is
the whole reason the slot exists rather than a consent bootstrap of core's.

The *pre-paint* half of the compound is load-bearing and names *when* rather
than what for: there are two consumers already, and a door called "consent"
would have had to be widened for the other one.
_Avoid_: pre-paint strategy, the fifth strategy (**Script "off"**'s refusal, one
door along), consent bootstrap (the slot names no feature and core emits none),
head script, inline script (a **Script loader** and a **RUM beacon** are inline
too), prepaint (one spelling: `pre-paint` in prose, `prePaint` for the field)

**Root provider stack**:
The site-supplied list of `{ component, props }` the framework wraps around both
the build-time page render and every island root at hydration
(`RootProviderStack`, `build.rootProviders`, #66). It is declared in two halves
that have to agree: `stack`, the values the build renders with, and `module`, the
specifier the generated island entry imports the same stack from in a browser.

It claims *provider*, which **Loader**, above, puts under _Avoid_ — so it earns
an entry the way **Image adapter** does, and for the same reason: this is the one
site-facing contract that is actually one, and leaving the word unclaimed is what
lets it collide. A provider here is a React context provider and nothing looser;
it reports no entries, syncs nothing, and is never a source a collection reads.

It is deliberately **not** an adapter. An image adapter and a script runtime
adapter each take something the framework composed and return something the
framework then places. This is the other direction: the site hands over
components, and the framework applies them unchanged on both sides of the wire.
The stack does not own the state it delivers, which is the whole design — a
provider that creates state per instance hands every island root a different
object, and that is the fault the dev-mode probe exists to report.
_Avoid_: provider stack (unqualified — *provider* alone is Loader's to refuse),
root context, app shell, wrapper components

**Shared store**:
The one Jotai store `@pagedeck/islands/store` exports, and the object every island
root's provider points at (#252). It is what the **Root provider stack** above
delivers rather than owns: state that crosses islands cannot travel through
React Context, because each island is its own root, so it lives here — outside
React, in a module — and the sharing contract is exactly two object identities,
this store and the atom config object. React roots are not part of it.

*Store* is already taken in this repo by the content store — `pagedeck store`, the
SQLite file a build reads entries out of — and the two have nothing to do with
each other. Neither name is qualified enough to stand alone in a sentence that
could mean either, so this one is always the *shared* store and that one is
always the *content* store.

It earns an entry because it is the noun three separate guarantees are about,
and each of them means a different thing by "one". #64's chunk-graph assertion
means one chunk holds the module; the `globalThis` stamp means one store object
in the realm, adopted by any second copy of the module rather than counted; and
`hydrateStore` means one hydration per atom per shared store, before the first
root mounts. Calling all three "the singleton" is what lets a reader think fixing any
one of them fixed the others.

*Shared* and not *global*: the shared store is reached through one module, not
off a window property, and a second realm — a worker, an iframe — has its own.
_Avoid_: global store, the singleton, app state, the Jotai store (the library is
an implementation this word is deliberately above)

**Class manifest**:
Every class one full build's pages rendered, sorted and deduped into
`Manifest.classes` — spec §9's own name for the set an incremental build checks
against (#29). It is read off the rendered HTML by `classesOfHtml`
(`packages/core/src/classes.ts`) and off nothing else, so it records what the
*documents* used and never what the site's stylesheets *cover*. Those two sets
differ in both directions, and every limit of this protocol is one of those
differences.

It is a field of the manifest and not a second document: *the* manifest is
`manifest.json`, the per-page record of what a build decided (Standing
decisions, below), and this is one column of it. Say "class manifest" in any
sentence that could be about either, the way **Shared store** above is never
just the store.
_Avoid_: safelist (that is the **declared safelist** below — a different set,
and a gap in one is the fault drift usually reports), the CSS manifest (nothing
in this protocol opens a stylesheet), class list

**Declared safelist**:
Every class a site's code states, keyed by where each one came from, declared as
`build.safelist` and typed `StylingSafelist` (spec §9, #260, #261). It is the
whole of §9's invariant — "Variants are enumerated in component source;
CMS-exposed styling options come from an enumerated safelist declared to the
registry" — and until #260 it survived only as a sentence inside a drift
warning.

**Two key shapes, one per clause.** `component.field` is a CMS-exposed styling
option (#260); a bare component name is the classes that component states in its
own source (#261). Nothing in core parses a key — `checkDrift` flattens both
into one set — so the shapes are a convention a report and a reader use, not a
rule the check enforces. The second shape arrived because the first left half
the invariant undeclared: a class a component states in a branch no page took is
in no **class manifest** either, so the first incremental build to render it
called it drift and defeated spec §9's "zero cascade".

**Two senses collide here, not three.** The **class manifest** above is classes
a build's pages *did* render; this is classes the site's code is *able to*
render. They are equal only by coincidence, so say the compound in any sentence
that could be about either, which is the rule the class manifest states above
read from this side.

A third sense is a hazard a reader arrives with rather than one written here: a
CSS toolkit's safelist, the classes that toolkit must generate rules for. This
repo holds no instance of it — `packages/design-system/styles/global.css` points
Tailwind at two `@source` roots and declares no safelist — but a site usually
derives all three sets from one enumeration, which is what makes conflating them
easy and wrong.

The bare noun is what most of this repo already says, and that stays right where
nothing else it could mean is nearby: `drift.ts`, `supplement.ts`, `classes.ts`,
the design system and `docs/error-messages.md` all write "safelist gap" and mean
this set, in sentences that are about the drift protocol and nothing else.

It is declared to the config rather than to `defineComponents`, against spec
§9's literal "declared to the registry": `ComponentRegistry` *is* the map of
components that every render and both generated island entries index, so
making it a wrapper would break the most-used type in the framework to carry a
field none of those readers wants (#260). What the phrase governs is the boundary: the framework learns this set
by being **told** it, never by reading CSS, which is "the framework names no CSS
solution" (Standing decisions) applied to the input side of the drift check.
_Avoid_: safelist unqualified in any sentence the **class manifest** could also
be about, class allowlist, whitelist, the CSS safelist (nothing here opens a
stylesheet)

**Class drift**:
A class a re-rendered page used that neither the **class manifest** nor the
**declared safelist** holds. Spec §9 has classes derive from code and never from
content, so drift is always a safelist gap or a content-hygiene bug — never a
tolerance to budget.
`build.driftThreshold` says nothing about that: it decides only when the
manifest asks for a full rebuild, and every drifted page is reported at any
threshold. Its default of 5 is one editor's one-entry mistake on a site of up
to five markets, since an entry renders once per locale; a site with more
markets raises it (#29).

*Drift* is the whole word, and it is about **two builds and one declaration**:
what this build rendered, against what the last full build recorded and what the
site declared. A class no stylesheet covers is a different fault, and nothing
here detects it — a page unstyled since the last full build has both builds
agreeing. `checkDrift` (`packages/core/src/drift.ts`) is called by `pagedeck build
--incremental` and by no other build (#281): a full build cannot drift by
construction, since it records the classes it just rendered.

Reporting a class that already had a rule behind it was the defect #261 closed,
and it is worth keeping straight from the fault above: the **declared safelist**
is what a class with a rule is now recognised by, and the guarantee that follows
is conditional on a site declaring all of it. A site that declares both of
spec §9's clauses, its components' classes and its CMS options, gets a check
whose every report is a class with no rule anywhere, the case the supplement
exists for. A site that declares half gets half the guarantee, and the check
cannot tell it from a site whose components state no class. The safelist is
flat, so a declared class is sanctioned on every page.
_Avoid_: missing class (that is a class with no rule behind it, which is a
different set), unknown class, CSS drift, class regression

**Drift supplement**:
The one `<style>` element a drifted page carries, holding rules for that page's
missing classes and for nothing else — spec §9's "only the missing rules …
inlined into the affected pages' HTML". One per page rather than one per build,
because it is inlined and cached by nobody.

It is not the **critical CSS** of a flagged page, and the difference is what
each does to the head: `build.criticalCss` *replaces* a page's `<link>` tags
with the same sheets in the same order, while a supplement is an *addition*
after everything the page already had, which is what leaves an undrifted page
byte-identical to its no-supplement self. Both arrive through `headElements`,
because the `<head>` has one writer (Standing decisions, below). Neither is
written to a file: no stylesheet this build emitted is rewritten, appended to or
re-emitted.
_Avoid_: critical CSS (that is what `build.criticalCss` inlines — Standing
decisions, below), patch stylesheet, drift CSS, fixup sheet

**Supplement compiler**:
The site-supplied function `build.driftSupplement` names: in, one drifted page's
missing classes; out, the stylesheet covering them (`SupplementCompiler`, spec
§9, #29). Core ships none and names no toolkit, which is the standing decision
below rather than an absence.

It earns an entry on the terms **Image adapter** sets, that a later contract
needing one of these words claims it here. The word it claims is *compiler*, and
that it is not the fourth *adapter* is the distinction those entries already
draw: an image adapter answers a URL and a script runtime adapter answers
markup, each translating something the framework composed into the shape a
service reads and holding nothing of its own, while this one is handed names and
returns bytes that did not exist until the site's toolkit ran. It answers with a
stylesheet and not with an element because the `<head>` has one writer (Standing
decisions, below), and a seam that could hand back markup would be a second.

What core does with an answer it cannot use — a throw, a non-string, an empty
sheet, a sheet holding `</style` — is the bargain this door is opened on, and it
is recorded with the standing decision below rather than here.
_Avoid_: supplement adapter, CSS adapter (it compiles rather than translates),
CSS provider (*provider* is Loader's to refuse), drift compiler (it compiles the
supplement; the drift is what it is handed)

**External link probe**:
The site-supplied function `build.links.external.probe` names: in, one absolute
URL a page links; out, the HTTP status the request came back with (`LinkProbe`,
spec §13, #31). Core ships none and makes no request of its own, so a build
talks to the internet only where a site wrote this function.

It earns an entry on the terms **Image adapter** sets, that a later contract
needing one of these words claims it here. The word it claims is *probe*, which
`@pagedeck/islands`' root provider probe already holds — a dev-mode browser check that
reports what it found through the console. Both carry the sense the word
actually has, something that goes and asks, and they are told apart the way
**Script loader** is told apart from *loader*: by compounding. Write "external
link probe" in any sentence that could be about either — every message a build
writes about one, and every reference to it outside the link check's own files.

The bare noun is granted the same scoped exception **Script loader** grants
itself, and for that entry's reason: inside `packages/core/src/links.ts` and
the reference page for `build.links`, there is nothing a *probe* could be except this one, and writing the compound in every
sentence of a module that is entirely about it reads as a different mechanism
each time. `@pagedeck/islands`' root provider probe is named in full wherever it
appears, which is what makes the exception safe rather than a race to claim the
word.

It is deliberately **not** an adapter. An image adapter and a script runtime
adapter each take something the framework composed and return something the
framework then places; this returns a number nothing places, which puts it
nearer a **Consent source** — a source of an answer. It is not called one of
those either: a consent source is an object a browser reads at runtime, and this
is a function a build calls about a URL rather than about a visitor.

What core does with an answer it cannot use — a throw, a value that is not a
status, a limit reached before the URL was asked about — is the bargain this
door is opened on, and it is recorded in `probeExternalLinks`
(`packages/core/src/links.ts`) and `docs/error-messages.md` rule 8. A throw is
a warning, because a network failure is the one kind of fault that does come
right on a retry; a non-status is a `ConfigError`, because a declared function
answers that way on every run until somebody edits it.
_Avoid_: link checker (that is the whole pass, and most of it is internal), link
adapter, fetcher, URL validator (it validates nothing; it asks a host)

**Dominant-color probe**:
The site-supplied function a collection's `imageColors` names: in, one image
source; out, the CSS color painted behind that image until its bytes arrive
(`ImageColorProbe`, spec §10, #44). Core ships none, because Node decodes no
images and the two ways to change that are a native dependency and a vendor
service.

It claims the word *probe* on the terms **External link probe** sets, and is
told apart from that one the way **Script loader** is told apart from *loader*:
by compounding. Write "dominant-color probe" in any sentence that could be about
either, and the bare noun only inside `packages/content/src/colors.ts`, where
there is nothing else a probe could be. Both carry the sense the word has —
something that goes and asks a host about one thing — and this is the second, so
the exception is scoped rather than a race to claim it.

It is deliberately **not** an adapter, for the reason the external link probe is
not: an adapter translates something the framework composed into the shape a
service reads, and this goes and comes back with a value that did not exist here
before. What the framework does with an answer it cannot use is the bargain this
door is opened on, and it is recorded in `syncImageColors`
(`packages/content/src/colors.ts`), `docs/error-messages.md` rule 8, and the
standing decision below.
_Avoid_: color extractor (it extracts nothing here; it asks), palette adapter,
image color loader (*loader* is a collection's sync source), placeholder
generator (the placeholder is what core makes of the answer)

**Dominant color**:
The one CSS color a **dominant-color probe** answered for one image source,
cached in the store by source and rendered as that image's background until it
loads (`ContentStore.getImageColor`, `ImageSource.placeholderColor`). It is a
value, not an image: spec §10's blur-up and LQIP placeholders are pictures, and
this is one property in a `style`.
_Avoid_: placeholder image, LQIP, blur-up, thumbnail, average color (it is what
the site's probe decided, and core never says how)

**Island**:
A component the build marks in the emitted HTML so the client runtime can
hydrate it. Everything else on the page ships as static HTML.
_Avoid_: widget, interactive component

**Shell**:
The frame every page of one site renders inside: the markup, and the class
strings that carry it. It belongs to a site and never to the framework — the
docs site's `src/components/shell.ts` holds two, the landing site's holds one,
and each is imported by that site's own templates (#358).

It earns an entry because **Root provider stack** above puts *app shell* under
_Avoid_, and a word half-refused is a word two readers will use differently.
The refusal there is exact and stays: a root provider stack is not a shell, it
is React context the framework applies on both sides of the wire, and calling it
one is what that _Avoid_ line prevents. A shell has no runtime behaviour at all
— it is markup and classes a template writes, and the framework never composes,
inspects or names one.
_Avoid_: app shell (that is what **Root provider stack** refuses), layout
(**Layout** below is a registered component the framework composes; a shell is
usually constants rather than a component, and the registry names no shell —
spec §8 says what an entry tree may name), frame, and chrome for this sense
(**Chrome** below is the build's field, not a shell)

**Chrome**:
What `build.chrome` returns for one page and the build renders beside the
`<main>` landmark: entry nodes for a header or nav before the landmark and a
footer after it (`PageChrome`, #409). Core composes it into the document, so it
is the framework's concept, where a **Shell** is markup a site's own template
writes and the framework never sees. It is not a slot either: a slot is a
container island's child, rendered in a pass of its own and handed back opaque,
and the chrome is two lists of top-level nodes outside the page tree.
_Avoid_: slot (that word belongs to container islands), layout (**Layout**
below renders inside the landmark, and the chrome sits outside it), frame, shell

**Layout**:
The registered component a `fromCollection` source names with `layout` (#712).
The framework composes each entry of that source into it, with the entry's
`title` and `html` as props and the components its `frontmatter.components`
names, in order and with no props, as its children. A page from such a source
never reaches `build.content`. A layout is the page's tree, so it renders
inside the `<main>` landmark; a **Shell** is markup a site's own template
writes, and **Chrome** is the build's nodes outside the landmark.
_Avoid_: template (that is `PageContent.template`, a component a content
callback names), shell, chrome, wrapper

**Fallback page**:
A page a locale gets from its fallback chain because no source claimed that
path in it: the untranslated locale's own URL and output tree, rendered from
the nearest chain locale that has the page. `Page.fallbackFrom` names the
locale that supplied the content, and is absent on a page its own locale
claimed.
_Avoid_: untranslated page (that is the gap the fallback fills, not the page),
duplicate page, mirrored page

**Experiment variant**:
One arm of a split a site declares in `build.routing.experiments` — a name, a
weight, and the document the build emits at `variantPath(name, …)` under
`VARIANT_SEGMENT` (`VariantRule`, `WeightedVariant`, `ResolvedExperiment`,
`ManifestVariant`; spec §12, #34). Its bytes are the primary's, so it
canonicalizes to the primary's URL and is not an indexable page of the site.

It earns an entry because *variant* was already taken. `alternates.ts` (#39)
uses it for a **locale variant** — the same path in another locale, which is a
row of the route table with its own URL, its own content and its own place in a
sitemap (`variantUrl`, `LocaleAlternate`, `PageLinksInput.variants`). The two
senses share the word and nothing else: one is a different page that *should* be
indexed and hreflang-linked, the other is the same page's bytes at a second
address that must not be. A reader who conflates them gets the sitemap wrong in
both directions.

The collision is live rather than hypothetical, which is why the compound is
written rather than the word left to context. `stageSite` holds both in one
function — it passes `variants: alternates.get(page.path)` to `pageLinks` and,
a few lines down, builds the map of `ManifestVariant`s the emitter fills — and
`@pagedeck/core` exports `variantUrl` and `variantPath` side by side.

Resolved by compounding, the way **Script loader** resolves *loader*: write
"experiment variant" or "locale variant" in any sentence that could be about
either, and never a bare *variant* where both are in scope. `stageSite` follows
its own rule: the map it builds is `experimentVariants`, so the only bare
`variants` left in that function is `pageLinks`' own field, which is the locale
one. Renaming either public export was the alternative and is refused
for **Script loader**'s reason: `variants` is what the spec and the site's
author write in both places, and a word invented to dodge a collision reads as a
third mechanism.

The bare noun keeps the same scoped exception **Script loader** grants itself:
inside the split's own modules — `routing.ts`'s `experiments` half, the emission
block in `build.ts`, `ManifestVariant` and `ManifestPage.variants`, and #35's
compiler — nothing a *variant* could be is a locale, and inside `alternates.ts`
nothing it could be is an arm.

*Arm* is this codebase's prose word for one experiment variant and is sanctioned
**in docblocks and comments only**. It never reaches a message a site's author
reads: the field they type is `variants`, and `docs/error-messages.md` rule 3
asks a fix to name what the author writes, not what the implementation calls it.
*Split* is the same bargain for the whole experiment.
_Avoid_: bucket, cohort, treatment, test cell; *variant* unqualified where a
locale variant could be meant; *arm* and *split* in any text a build prints.

**Fold position**:
A node's index in a pre-order walk of one page's entry tree, counting every
node. It is what fold-driven hydration compares against a threshold, once per
instance per page. It is **not** `ComponentUsage.foldScore`, a minimum over one
component's occurrences within one entry, and not `ComponentRanking.avgFoldScore`,
which averages that across the store: those two are one number per component for
the whole build and are tiering inputs. Neither is it a pixel measurement — no
stage of this build opens a stylesheet.
_Avoid_: fold score (for this meaning), above the fold (for the pixel one)

**Page head**:
What one page declares about itself — its title, description, OG image URL and
JSON-LD. It is the site's content, returned per page by `BuildSection.head` and
typed as `PageHead`, and every field of it is optional.

It is **not** the `<head>` element, and the two must not be said with one word.
The `<head>` is a region of the emitted document that the framework owns and is
the sole writer of (Standing decisions, below); the page head is one of the
things written into it, beside the CSS tier links, which are not a page head at
all. "The build owns the head" and "the site declares the head" are both true
and about different things.
_Avoid_: metadata (broader — a manifest row is metadata too), SEO fields (only
some of them are), head tags, meta tags

**Absorbed metadata**:
A `<title>` or a `<meta>` a *component* rendered, taken out of the body React
hoisted it into and written into the `<head>` by the build (`AbsorbedMetadata`,
#239). Absorbing is the whole verb: the element is moved, not copied, so the
body it came from no longer holds it.

It is not a **page head**, above, and the two arrive by different doors: a page
head is what the site declares for a page through `BuildSection.head`, and this
is what a component declared inside its own markup, which the build only ever
learns by reading the bytes React emitted. They meet in the one region, which is
why a *claim* — the head singleton one of them sets, keyed for a `<meta>` by
the first of `charset`, `name`, `property` and `http-equiv` it carries — is what
a conflict is about rather than either term.
_Avoid_: hoisted metadata (that is what React did, and the framework's word is
for what it does about it — the CSS side keeps *hoisted* for the sheet it
refuses), lifted, promoted, head injection

**Head block**:
One span of the `<head>`'s write order, named. `headElements`
(`packages/core/src/head.ts`) fixes that order as a numbered list and hands
each block a name in the parenthesis after its bolded lead, `head:charset`
through `head:speculation`, and prose across this repo cites the name (#469).
The numbers are the order and are read as the order; the name is how a block is
referred to from anywhere else, because a number carries none of what it names
and an insertion above one falsifies every reference below it.
`head-block-numbering.test.ts` walks the repo's prose off disk and refuses a
cited name that list does not declare.

The eight are written down here and not only under Standing decisions because
one of them has to be resolved rather than merely listed. **Page head**, above,
puts *metadata* under _Avoid_ as "broader — a manifest row is metadata too",
and one block of that list is named `head:metadata`. The breadth is what makes
it the right name: that block holds a page head *and* the **absorbed metadata**
a component rendered, which the two entries above keep apart on purpose, so a
word covering both is exactly what this name needs and either narrower word
would name one half and mislead about the other. What _Avoid_ governs is
untouched — *metadata* is still the wrong word for a page head. It is the right
word for a region that holds a page head and more, and it is said here only as
the `head:` span, which names a place in one written-down order and so cannot be
read as either of the things written into that place.
_Avoid_: a bare number in place of the name, which is the spelling #469
replaced and the one that drifted twice; metadata block, head section, head
slot

**Page relation**:
What a page's source declares a reader may go to next — refs to other entries,
returned per page by `fromCollection`'s `relatesTo` callback and carried as
`Page.relations` (#42). Speculation rules are the join over it.

It is **not** a page's **dependencies**, and the distinction is the reason the
field exists rather than a shade of one. `dependsOn` is defined as what a page's
render *reads*, which an incremental build uses to decide what to rebuild; a
page may read an entry it never links, and link a page its render never reads.
`packages/docs` declares `sharedDependsOn: everyDocument` for rebuild
correctness alone, so reading one as the other gave all 45 of its pages a rules
block naming the first documents in collection order — wrong output rather than
absent output. `dedupeRefs` flattens both callbacks with no provenance, so the
two are separated where they are declared and nowhere later.

It earns an entry on the terms **External link probe** sets. The word it claims
is *link*, which `BuildSection.links` already holds for the link *checker* over
rendered `<a href>`s — the opposite direction of travel, and a reader who
conflated them would expect this list to be checked. *Relation* was the word
the CMS loader removed in #746 used for the same refs, and it names refs rather
than URLs, which is what these are.
_Avoid_: links (taken, above), dependencies (taken, and the bug), outbound
links, related pages

**Paged list**:
A list of entries a site declares once and the build emits as several pages:
page 1 at the list's own path, and every page after it under `page/2` upward
(`paginate`, `PagedList`, `Paging`, #323). Each of those pages is an ordinary
row of the route table carrying `Page.paging` — its number, the list's total,
and the finished addresses either side of it — so the sitemap lists it, the
canonical writer canonicalizes it to its own address, and the link checker
resolves a link to it, with nothing anywhere taught what a paged list is.

Written down because *page* is the most contested noun in this codebase and
this compound reads two ways. A **paged list** is the whole run; one row of it
is a *page of a list*, and that row is a **page** in the route-table sense
exactly as much as any other row is. Write "paged list" for the run and "page 2
of a list" for one of them. There is no third thing, and in particular a paged
list is not a *kind* of page source a site chooses between — `fromCollection`,
`fromTemplate` and `paginate` all answer with the same `PageSource`, and
`collectPages` cannot tell their rows apart.

The word it takes from elsewhere is *list*, which `listEntries` already holds
for the store query. The two are told apart the way **Script loader** is told
apart from *loader*: by compounding. A list is *paged* here and nowhere else,
and the bare noun still means the query's answer.

**`prev` and `next` are addresses and never routes**, which is the guarantee
the noun carries beyond "a list, cut up". An address is only final once the
locale prefix and the trailing-slash policy have been applied; both are
`PageSet` facts and a render sees neither, so a component handed a route could
not finish one and a helper that spelled its own would be the second opinion
about a path. They are spelled by the same function `href` is
(`docs/adr/0003-one-canonical-path-spelling.md`), which is why
`PageSource.instances` is handed the site as a third parameter at all.
_Avoid_: pagination (the feature *is* the paged list; there is no second
object to name), paginator, page set (taken — a `PageSet` is a whole site's
route declaration), archive page, index page (an *index* here is
`manifest.json` and the search index), infinite scroll (ruled out of #323 —
these are static pages)

**Publication window**:
The span an entry is a page for — half-open, from the instant in the field a
collection names as `publishField` inclusive until the instant in its
`unpublishField` exclusive (`PublishWindow`, `listDue`, spec §11, #36). A
collection naming either field is a **scheduled collection**; one naming
neither is unscheduled and every entry of it is published, which is almost
every collection anyone writes.

An end a collection does not name is *no bound at that end* rather than a
missing value: no publish field is already published, no unpublish field never
expires. An entry whose named field is absent or null is unscheduled at that
end the same way.

It earns an entry as the noun three separate guarantees are about, the bar
**Class manifest** sets. Half-open is the first: an author who writes one
instant into an entry's end and the next entry's start gets a handover with no
moment in which both are live and none in which neither is, and the same
subtraction is what makes such a handover one change in one build rather than
two or none (`publicationChanges`, `incremental.ts`). The second is that the
build's instant is `BuildStamp.createdAt`, supplied rather than read where it
is used, so two builds of one commit agree and `check:build-twice` compares
trees built from one instant each. The third is that a collection declaring a
window and collected with no instant is refused rather than published
wholesale.

An **inverted window** is one whose unpublish instant is at or before its
publish instant, and it is the fourth guarantee (#283): such an entry is
refused, collected across the collection, rather than emitting no page and
saying nothing. It earns the adjective because half-open is what makes it a
fault rather than an empty span — the unpublish end being exclusive means
equal instants invert too, so *at or before* is the condition and "reversed"
or "backwards" would both name it one case too narrow. It is a fault in the
entry's own data, so it is refused where the window is read off the
collection (`listDueEntries`) and not in the store, the division the
neither-end refusal above already draws.
_Avoid_: publish date (one end, not the span), schedule (the site's cron is
also a schedule, and that is the thing the framework does not own), embargo,
go-live, backwards window (equal instants invert without being reversed)

**Origin**:
The place a built site's files are published to and served from — the bucket, or
the directory standing in for one. A **deploy plan** names the files to upload
to it and the files to prune from it, and a `DeployTarget` is the small
interface through which either happens (`packages/site/src/deploy-target.ts`,
#57).

It is **not** an **edge artifact**'s destination, and the deploy plan keeps the
two apart because they are applied by different things at different times: a
`tree-file` is uploaded to the origin with the site, and every other
`ArtifactRole` is published out of band against a distribution, which the plan
stages rather than applies. A pipeline that conflated them would try to upload
a CloudFront function to a bucket.

It earns an entry because the deploy wiring is the site's and not core's
(decision #10), so the word is load-bearing across a package that core cannot
see, and because *deploy artifact* is already refused above as a name for an
edge artifact — leaving the thing that receives one unnamed.

A **dev server's origin** is the other word — the URL sense, scheme plus
authority, as in `devOrigin(host, port)` and `DevServer.url`
(`packages/core/src/dev.ts`, #268). Nothing is published to it and no
`DeployTarget` reaches it; it is where a browser on this machine or on the LAN
sends a request. The two never meet in one function, and the URL sense is what
`pagedeck dev --host` prints.
_Avoid_: bucket (one implementation of it; the filesystem target is another),
host (taken by the snapshot host refusal, which is about a URL's authority —
`pagedeck dev --host` names an interface to bind, the same sense and not this one),
CDN, distribution (that is what an out-of-band artifact is applied to)

**Deploy instant**:
When a build was last deployed to an **origin**: the clock reading an apply
takes as it runs, filed beside that build's document in the origin's deploy
history as `.pagedeck/manifests/<build id>.deployed-at` and overwritten by each
re-deploy (`deployInstantKey`, `packages/site/src/deploy-target.ts`, #403).
The retained prune opens the grace window on a file at the deploy instant of
the build that dropped it, falling back to that build's `BuildStamp.createdAt`
where none is on record.

It is **not** the publish instant of a **publication window**, which is a
field in an entry that says when the entry becomes a page and is read by a
build. A deploy instant is written by a deploy and read only by the prune, and
it says nothing about any entry. It earns an entry because both are "the
instant something goes live", and a reader who met the one word in both places
would look for a schedule in the deploy history, or for a deploy in an entry.
_Avoid_: publish instant, published-at (both the publication window's), deploy
time (the elapsed time an apply takes, which the build test measures)

**History index**:
The one object at an **origin** that names every build in its deploy history,
`/.pagedeck/deploy-history.json`, rewritten by every apply with the build it
deploys added (`HISTORY_INDEX_KEY`, `packages/site/src/deploy-target.ts`,
#659). A presigned origin cannot be listed, so its prune finds the history
through this object and never by a listing; a directory origin's prune still
lists. It names builds and nothing else: when each was deployed is its
**deploy instant**, and what each served is its document.

It is **not** the deploy history, which is the documents under
`/.pagedeck/manifests/`, nor a site's retention store, which `pagedeck build`
keeps beside the output tree and prunes by `build.retention.keep`. The origin's
history is never pruned, and the index never drops a build an apply put in it,
except by losing a race between two applies. Nor is it either *index* **Paged
list** reserves the word for: `manifest.json`, the per-page record of what one
build decided, or the search index a build emits for the site's search.

It earns an entry because "index" already names two things a build writes, and
this third one is written by a deploy, at an origin, and read only by a prune: a
reader who met the bare word here would look for it in a build's output.
_Avoid_: manifest list, history listing (a listing is what it replaces),
retention index (retention is the site's store), index unqualified (the two
senses above)

**Tree key**:
The host that names an output tree: the host the URL parser reads out of a
locale's declared `domain` — lowercased, IDNA-encoded, an IPv4 address in its
dotted-quad form (`localeTree` and `domainHost`, `packages/core/src/locales.ts`,
#396). It is `Page.domain`, the directory under `outDir`, the manifest's
`domain` and the host half of every deploy key, and it is what `treeSizes`
counts, so `münchen.de` and `xn--mnchen-3ya.de` are one tree whose locales are
prefixed.

The **declared domain** is the other value, and the two are kept apart on
purpose: `LocaleDefinition.domain` exactly as the site wrote it, carried to a
page as `Page.declaredDomain`. It is the only thing a URL writer reads —
`variantUrl` takes that field by name — so a canonical, an hreflang, a sitemap
`<loc>`, a `robots.txt` line and a feed link keep the site's own spelling while
the file lands in the key's directory. For a domain already written in
lowercase ASCII the two are one string, which is why a sentence can get away
with "the domain" until it cannot.
_Avoid_: domain unqualified in any sentence that could be about either,
normalized domain (say which of the two), host (taken by **Origin**'s dev-server
sense and by the snapshot host refusal)

**Reserved deploy key**:
A tree-relative path the deploy writes for itself rather than for the site:
`/manifest.json`, `/.pagedeck` and everything under `/.pagedeck/`
(`isReservedDeployKey`, `packages/core/src/routing.ts`, #556). Every **edge
artifact** answers one with the site's 404, and the routing planner refuses a
page or a redirect at one. A redirect *to* one is refused too, as a dead
target, even when the build emits a file there (#553). It is narrower than a deploy key, which is any key a
deploy writes, prefixed with the **tree key** on a domain tree; a reserved one
carries no tree key because it is reserved in every tree.
_Avoid_: deploy key unqualified (that is every key a deploy writes), system file

**Site feed**:
The RSS document `build.feed` publishes over one collection, at `/rss.xml`
(`packages/core/src/feed.ts`, spec §7, #324). Its **channel** is the document's
one header — the title and description a site declares, and the link back to the
site — and its **items** are the pages of that collection, one element each.

*Item* and *channel* are what earn the entry: two nouns this repository did not
have, claimed here so they stay RSS's. An **item** is one element of the site
feed and is never a row, an entry or a page — it is composed *from* a page,
which is the join `feed.ts` exists to make, and a sentence calling a page an
item loses the fact that a page the feed skips is still a page. A **channel** is
the one wrapper element and never the feed as a whole: a file is a site feed,
and the channel is what is inside it.

*Feed* is compounded rather than left bare, and the collision it is written
against is weaker than **Experiment variant**'s. There both senses are live in
shipping code and meet inside one function. Here the other sense is a `PageFeed`
(`packages/content/src/collection.test.ts`) — the entries and deletions a loader
replays into a sync, so *input to the store* against a site feed's *output of a
build* — and it is a test-local interface rather than a shipping type. The
compound is written all the same, because what that test names is what a loader
does and a loader is `@pagedeck/content`'s subject. Scoped by module the way **Script
loader** scopes *loader*: write "site feed" in any sentence that could be about
either, and the bare noun inside `@pagedeck/core` and the reference page, where
nothing replays a sync.
_Avoid_: RSS feed (as the noun for the framework's own — it is right where the
sentence is about the format), feed entry and feed post (an item is composed
from an entry and is not one), the RSS channel as a name for the file

**Passthrough file**:
A file the site itself owns, published at the address the site chose:
`build.passthrough` names one directory, and every file beneath it is emitted at
its own path beneath it, in every output tree (`passthroughFiles`,
`packages/core/src/passthrough.ts`, #439).

**Two directories name them and the noun covers both.** `root` is published
whole, and `contentRoot` is a content tree from which only the files a page
points at are published (#474) — the difference is which files land, not what a
landed file is, and both take their address from the same `passthroughAddress`.
Either key may be declared alone (#491).
A content tree holds a site's markdown, its layouts and its components beside
the images its posts reference, so publishing it whole would serve a site's own
sources to a reader; that is the whole of why the second key reads a set rather
than a walk.

The noun exists because the file has no stage. Every other file in an output
tree is something this build *made* — a page, a chunk, a font subset, a social
card, an icon, one of spec §7's build-time documents — and the address is the
framework's to decide. A logo the author drew is authored, so a build-time
document's first property, "derived from the build", is exactly what it is not,
and stretching that class to hold it would cost the class the word it is
defined by.

**A passthrough file's address is never won and never lost.** Where a generated
stage claims the same deploy key the build refuses and names both sides, because
either silence is a defect nobody sees: a page shadowed by a file is a route
that 404s on a reader and builds green in CI, and a file shadowed by a page is
an image that stops loading with nothing to say why.

*Passthrough* is the word because it names the file's relation to the build,
where every candidate the _Avoid_ list rejects names the file, its source or its
mechanism. That relation is the only thing telling one of these apart from every
other file in a tree: the bytes reach a reader having had nothing done to them —
not subset, not hashed, not rewritten — and a name for the mechanism goes stale
the day the copy becomes a hard link, where "passed through untouched" does not.
The bare word is nearly free here. The hyphenated adjective is live twice —
`packages/adapter-cloudfront/src/cloudfront.ts`'s one pass-through exit, and the
`useStoreCallback`, which cannot be a pass-through of Jotai's
`useAtomCallback` because that hook falls back to a default store nothing on
the page uses — but both are a path a value takes inside one module and neither
could be a file, which is a weaker collision than the one **Site feed** is
written against. It is closed up and compounded all the same, on that entry's
stance.
_Avoid_: static file (every file this build emits is static, which is the
framework's whole subject), static asset and asset (an *asset* is a `FileKind`
this build records, and `/assets/` is where the chunks go — both would be this
word naming a directory it does not own), public directory and `publicDir` (one
other framework's spelling of the field, and a name for the source rather than
for the file), copied file (the copy is how it gets there, not what it is)

**Verbatim line**:
A line of a `robots.txt` the site spells itself, which the build writes into the
file and does not read: `build.robots.verbatim` carries them, and a second
crawler's group, a comment and a directive no standard names are all written as
these (`RobotsSetting` in `packages/core/src/robots.ts`, #438). They go above the
`User-agent: *` group the emitter composes and above the derived `Sitemap:` line.
RFC 9309 ends a group only at a `user-agent` line or at the end of the file, so
lines written last would fall into the composed `*` group, and a `Disallow: /`
meant for one crawler would close the site to all of them.

*Verbatim* is the word because the only thing that tells one of these from every
other line in the file is that the build composed none of it — and the
alternatives each name the mechanism or the field's history instead. The unit is
the line, which is where this parts company with the `disallow` paths beside it:
those are carried unaltered too, but into a `Disallow:` the emitter writes, so
the emitter still decided what kind of line it was. Nothing decides that here.

*Verbatim* is also this repo's standing adverb, and the survey is owed before
the noun is claimed. It is live in comments in nearly every package — a carried
object *pushed verbatim* into a sitemap's file list, an alternate's URL
*appended verbatim*, a tier plan *pinned verbatim* into the manifest, a content
blob the class scan says this build *passes through verbatim* — and every one of
those is an adverb or an adjective about how a value travelled. None of them is
a name. That is what parts this entry from the two above, each of which is
written against another *noun*: **Site feed** against a `PageFeed`,
**Passthrough file** against a pass-through exit and a pass-through callback.
Nothing in this codebase is *called* verbatim, and "verbatim line" is written
nowhere but at this field, so there is no sentence the compound could be
mistaken in. The volume is the argument for the word rather than against it: the
repo already spends it on one meaning, *unaltered by this build*, which is the
property this noun is defined by.

*Passthrough* is the word this is **not**, and the collision is close enough to
be worth stating: **Passthrough file**, above, claims it for a file the site
publishes at an address it chose, one `build` field along. Both are the site's
own bytes reaching an output tree untouched, so a sentence using the bare word
for either could be about the other — and the file is the older claim and the
larger noun, naming a whole class of thing a build emits rather than a line
inside one document.
_Avoid_: passthrough line and robots passthrough (**Passthrough file**'s word,
above), raw directive (most of what a site writes here is a group or a comment,
and *raw* names the absence of processing rather than the line), escape hatch
(it names what the emitter lacks rather than what the site wrote), custom
directive (a site writing another crawler's group has written no directive this
framework could call custom)

**Content-relative reference**:
A reference a page makes to a file beside its own content, written relative to
the page rather than to the site root: a post's
`![Ferry logo](../../assets/images/ferry/logo.png)` reaching the emitted HTML as
an `<img src>` holding exactly that (`contentRelativeReferences`,
`packages/core/src/passthrough.ts`, #474). It resolves against the address the
page is served at, the way a browser resolves it, and the file it names is the
one at that address beneath `build.passthrough.contentRoot` — which is what makes
it a **passthrough file** once published rather than a third kind of file.

That base is ruled, not defaulted (#474, 2026-09-23). The build never rewrites
the `src`, so the address a browser resolves it against is the only thing it can
mean. Resolving it against the file its author wrote it in would need the file,
and core holds an **Entry id**, which is a key and not a path; a reference that
means where its author wrote it is a seam on the **Loader** contract, and its
own issue.

The compound is the whole name and the bare noun is not granted here, because
*reference* is already two things in one module: `links.ts` tells an **asset
reference**, which names a file, from a **content reference**, which names a
route. The adjective is what tells this from the second of those — *content* is
where it was written and *content-relative* is how — so write it in full in any
sentence that could be about either. **The code spells it in full too**: the
function is `contentRelativeReferences` and the shapes it answers with are
`ContentRelativeReference` and `ContentRelativeReferenceInput`, in the module
this entry cites.

It is deliberately not an **Image reference**. Nothing about the resolution is
about images: the same rule reads a `<source>`, a `<video poster>` and a
`<link href>`, and naming it for the case that raised it would put a
picture's name on a rule about addresses.
_Avoid_: relative link (a link names a route, and this names a file), relative
image reference and in-post image (the rule reads every asset reference, not
images), content reference (taken in code rather than in this glossary —
`resolves` in `packages/core/src/links.ts` reads one as a route), asset
reference (taken, and this is one of them rather than a rival to them)

**Edge adapter**:
The compiler for one host, published as `@pagedeck/adapter-<host>`: its factory
returns an `EdgeAdapter`, a name and a `compile` over the routing document,
built on the contract in `@pagedeck/edge`, which names no host. Ruled on #19;
`docs/adr/0009-one-package-per-edge-adapter.md` holds the alternatives.
_Avoid_: edge target (the string `compileRouting` took before #19, which survives
only as an adapter's `name` and the `--edge` value of the site port's deploy)

**Edge artifact**:
A file an edge adapter (`@pagedeck/adapter-<host>`, built on `@pagedeck/edge`)
emits for a host to serve routing from.
_Avoid_: edge bundle, deploy artifact

**Publishable package**:
A workspace package whose `npm pack` produces a tarball a consumer could
install: its emitted `dist` and its `package.json`, with every entry point the
manifest names resolving to a file inside it. The adjective is a claim about
what packing produces and **not** about a registry. The public set of #690 is
published to npm by the release workflow on a `v*` tag (#7); every package
outside it is `private: true`, which is why the standing decision below binds
packages nobody has written yet.

Written as the compound, because *publish* is spoken for twice above and
neither sense is this one: an **origin** is what a built site's files are
published *to*, and an **edge artifact** is published out of band against a
distribution. Both are a site's output reaching a host; this is the repository's
own source reaching a tarball. The bare adjective is safe only in `AGENTS.md`'s
"The published tarball" section and in the test it names, where nothing else is
under discussion.
_Avoid_: published package (a private package is publishable and never
published, and the difference is the point), publishing (the registry act,
which only the release workflow does, #7), distributable, npm package (every package here is an npm package; only some of
what one could ship belongs in the tarball)

**Example site**:
A site whose config is in this repository to be copied — it is here to
demonstrate the framework, so a reader arrives at it looking for how to write
their own. The docs site, the landing site and the site port are the three so
far, and `AGENTS.md` describes each. A site published under its own name is not
one, however much of the framework it exercises and wherever its config lives:
what a reader finds there is one deployment's answers, chosen for that
deployment, and nobody starts a site from them.

The compound is claimed because *dogfood site* cannot carry that distinction.
Spec decision #8 is "dogfood on one real site", so a site published under its
own name and built on this framework is dogfooding in the spec's own words, and
the two placeholder decisions below turn on exactly what the word cannot say.
Being served to the public settles nothing either way, and neither does whose
content the site carries, nor which repository holds it.
_Avoid_: dogfood site (wherever the sentence turns on who reads a config and
what this repository is seen to recommend, which is what the two decisions below
hold; it stays right where the sentence is about exercising the framework on
real content, which is spec decision #8's "dogfood on one real site" and what
`docs/success-criteria.md` and `docs/deploy-recipe.md` mean by it), demo site,
sample site, fixture site (a fixture is input to a test, and `packages/fixtures`
holds those)

**Site parity**:
Two implementations of one site agreeing about what they serve at each of its
URLs — the framework's build against the site it replaces (#58,
`packages/site/src/parity.ts`). What "agreeing" means is a fixed field list per
URL, `PageFacts`, and the fields it leaves out are as load-bearing as the ones
it holds: attribute order, whitespace, class names and script bytes are
excluded, because two renderers have no reason to agree on any of them and a
comparison that included them would report the framework's central claim as its
largest defect.

Written with the qualifier, always. `packages/preview/src/parity.tsx` already
holds the bare word for something else — a *preview* render matching a
*production* render of the same content, whose refusal is `PreviewParityError`
(spec §14, [ADR-0005](./docs/adr/0005-slot-re-render-is-not-detectable.md)) —
and the two share nothing but the noun: one is about two renderers of one
document, the other about two implementations of one site. The collision is
resolved by compounding, the way **Class manifest** resolves *manifest*: write
"site parity" or "preview parity" in any sentence that could be about either,
and the bare word only inside the module that owns it. Nothing in
`packages/site/src/parity.ts` exports the unqualified noun.
_Avoid_: parity (unqualified, outside `@pagedeck/preview`), diff, snapshot (a snapshot
agrees with the build that produced it by construction, which is the thing a
parity baseline is defined against — see below), visual regression

**Parity baseline**:
What a build is compared against for **site parity**, and where that came from:
a page's facts per URL, the site's redirects, and an `origin` saying which of
two kinds it is. A **captured** baseline is a recording of an origin that serves
the site, and is evidence about that origin at that instant. A **declared**
baseline is written by hand in this repository as an independent statement of
what the site is supposed to serve, and is **not** evidence of parity with
production.

The origin is a field of the baseline rather than something a reader is trusted
to remember, and it is carried into `ParityReport.baselineOrigin` and printed by
the runnable before any count and any verdict. A report that does not say where
its baseline came from is the report #58 exists to prevent — "no differences"
means two different things depending on the answer, and only one of them is
worth anything.

It is not a **snapshot**, and the standing decision below is why the word is
under _Avoid_ rather than treated as a synonym.
_Avoid_: golden file, fixture (a fixture is input to a test; this is the
statement a test is measured against), snapshot, expected output

**Security sweep**:
A full OWASP Top 10 pass over the code in a milestone, filed and triaged as
its own issue. It files its findings as new issues rather than fixing them.
See `docs/agents/triage-labels.md`.
_Avoid_: audit, security review

**Security finding**:
An issue about a way this software can hurt the person running it or the people
its output reaches. Input nobody here wrote reaching a decision that trusted it,
and a secret reaching an output that carries it to a reader who should not have
it, are the two shapes this repository keeps finding, and they are the common
cases rather than the edge of the class: a build a planted file can stop is one,
and so is a dependency shipping a known vulnerability or a published site
missing a header it should send. Everything a **Security sweep**'s OWASP pass
can come back with is inside this, which it has to be, since a sweep files
these. What makes one is the fault it describes and never the issue that filed
it.

A sweep is not the only route in: of the three this repository has decided on,
none came from one. #356 was filed against a fix that had already landed,
#378 was found while landing the fix for the same leak in a neighbouring
function, and #383 came out of triage recon on #378. The routes are several and
none of them is the class, which is the whole reason to define it by the fault.
The category label is no signal either, because there is none for this: a
finding arrives as a `Bug` or an `Improvement` like anything else, which is why
the class has to be written down rather than read off an issue. It is the unit
the ordering decision below is about.
_Avoid_: vuln, security bug, security-sweep finding (as a name for the class; it
stays right for a finding a **Security sweep** actually filed)

**Site audit**:
The browser-driven pass over a built site: Lighthouse for scores and resource
budgets, axe-core for accessibility violations, both against a local origin
serving the build (`packages/site/src/audit.ts`, #59). It runs a browser, so it
is out of `pnpm test` and behind harnesses and a CI workflow of its own.

The noun is claimed here because **Security sweep**, above, puts *audit* under
_Avoid_, and that entry is what governs the security sense: a sweep is not an
audit and calling one an audit is the drift being refused there. This is the
other thing the word is already used for in this repository, and it is qualified
rather than bare for the same reason **site parity** is — the unqualified noun
in a sentence that could be about either is the collision. Say "site audit", and
never "audit" alone outside the module that owns it.

It is not **site parity**: parity compares this build against another statement
of what the site should serve, and a site audit asks a browser what this build
does on its own. Neither is evidence for the other, and the two are bounded by
different things — parity by the absence of a twin, an audit by the absence of a
production origin.
_Avoid_: audit (unqualified), Lighthouse run (Lighthouse is one of the two
tools), perf test, a11y test

**Watch**:
A run that repeats until something stops it, rather than doing its work once
and exiting. One turn of it is a **tick** and the pause between two ticks is a
**rest**, which is what `pagedeck sync --interval` sets, in seconds
(`packages/core/src/watch.ts`, #51).

All three are load-bearing across the loop, the command line and the reference
page, so they are claimed here rather than left to be re-coined per file. The
rest is named apart from the tick because the two are what the loop's whole
design is a statement about: a rest is measured *between* ticks and never on a
grid, so a slow tick pushes the next one out instead of being overtaken by it,
and the words have to be able to say that. *Interval* is the flag's spelling
and stays the flag's — it is the number a person types, and a rest is the wait
that number buys.

**`watchSync` and `watchSite` are two different verbs and neither is the
other.** `watchSite` (`packages/core/src/dev.ts`) watches the *config* and every
site file that dev server has imported, and re-reads the config when one changes
(#703); `watchSync` re-runs a *sync*
on a timer and watches nothing at all — it looks at no file, and the loaders
are what decide whether anything moved. The collision is in the prefix rather
than in the meaning, so the rule is that neither is ever shortened to "the
watch" outside its own module, and a sentence about content edits reaching a
dev server says which of the two it is about.
_Avoid_: poll (a tick is not a request and the loop asks nobody), live reload
and hot reload (nothing is pushed at the dev server — it re-reads the store per
request), iteration and cycle (for a tick), interval (for the rest itself —
that is the flag), file watcher (for `watchSync`, which watches no file)

**Heading slug**:
The `id` `@pagedeck/markdown-loader` mints for one heading and writes into the markup
it renders, and the same string it reports in that document's **outline**
(`TocEntry.slug`, `packages/markdown-loader/src/render.ts`, #327).

It is a third sense of *slug* in this repository, and that is what earns the
entry. **Entry id**, above, refuses *slug* for an entry's own id and grants it
to a CMS field that spells one (#161); `AGENTS.md` uses it for a
route segment of that same field. This is neither: it names a place *inside* a
document and never the document, so a sentence that says "slug" and means an
entry, a route or a heading has three readings and no way to pick one. Write
"heading slug" wherever more than one of the three could be meant. The bare
noun keeps the scoped exception **Card**, above, is granted: inside `render.ts`
and a template rendering an outline, there is nothing else a slug could be.
_Avoid_: anchor (that is the element the slug names, not the string), heading
key, heading path

**Outline**:
A document's headings in order, each with its **heading slug** and the text it
reads as (`RenderedMarkdown.toc`, `TocEntry`, #327). The loader reports one and
emits no markup for it; where it goes on a page, what it is called and which
levels it shows are a template's (`packages/docs/src/components/doc_page.tsx`
renders this site's).

*Outline* rather than *table of contents* because the two are not the same
thing: a table of contents is markup on a page, and a document has an outline
whether or not a site renders one. `toc` survives as the field name, which is
what a template already reaches for.
_Avoid_: table of contents and TOC (for the data — that is what a template
makes of it), heading list, contents, index

## Standing decisions

### A security finding is picked before any other work

A **security finding** is selected off the Queue ahead of every issue that is
not one, at any priority and at any age. Priority labels do not override this: a
`P2` finding is picked before a `P1` `Improvement`, and a finding carrying no
priority label at all is still picked before both.

Two security findings order against each other by the Queue's own order and
nothing else (`PROTOCOL.md`, the Factory plugin's own protocol document — not a
file in this repo). This decision lifts a class over the rest of the Queue and
settles nothing inside that class, so there is no second ordering to learn here
and no reason to restate the first one.

It does not license inventing work. A session picks from the Queue and from
nowhere else, so a finding is picked early only once it has been filed and
triaged onto the Queue like any other issue. This moves an issue up an order; it
does not put one there.

**Widened by #390: the class it binds was feature work, which was too narrow to
do the job it was recorded for.** #134's holding named feature issues, so it
said nothing whenever the head of the Queue was an `Improvement` or an ordinary
`Bug` — which is most of this repository's Queue — and the two picks it was
consulted for in one Loop Session of 2026-09-07 met that silence in opposite
ways. #356, a planted retention document that crashes every build and leaks file
contents into a warning, was taken ahead of a `P1` `Improvement` *under* this
decision, which had never covered an `Improvement` at all — the rule was invoked
for a case its letter did not reach, and nobody noticed the gap it was carried
across. #378 and #383, two credential leaks in `docs/error-messages.md` rule 6's
redaction worked as one change, were taken ahead of an older `P2` `Improvement`
at the head on this decision's *spirit*, the pickup saying in as many words that
the letter covers feature issues and this was therefore a deliberate ordering
call rather than the rule applying itself. One pick saw the silence and argued
its way across; the other did not see it and read the rule as covering the case
anyway. Both are the same missing sentence. A decision recorded so the next
Queue decision would not have to rediscover it, and then argued rather than
applied at every consultation, is not the decision it was recorded as. The
silence had a price in the order itself: #378 carried no priority label, so it
sorted last of thirty-three `ready-for-agent` issues — a credential leak behind
roughly thirty issues, most of them `Improvement`s — until a hand-applied
`P2` lifted it off the bottom and a reading of this decision's spirit took it
past the older `P2` at the head. Ruled on #134, widened on #390.

### Third-party actions are pinned to commit SHAs

Every `uses:` in `.github/workflows/` names a commit SHA, with the version that
SHA is in a trailing comment beside it. A tag is a moving pointer its owner can
repoint, so a pin to one is a pin to whatever that owner pushes next: a tag
moved upstream runs unreviewed code on the runner, inside the job, with
whatever the job's `GITHUB_TOKEN` and secrets reach. What caps that is the
`permissions: contents: read` each workflow declares. This binds a workflow
file added later as much as the ones that exist today.

To update a pin, resolve the tag to its commit
(`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`) and replace the SHA and
the trailing comment together. The comment is the only human-readable record of
which version is pinned, and nothing derives it from the SHA or checks it,
which is why **Comments say only what the code cannot** keeps it. Ruled on
#121.

**`release.yml` holds more than `contents: read`.** It also holds
`id-token: write`, which can publish every public package once trusted
publishing is on, and runs two third-party actions (`pnpm/action-setup` and
`actions/setup-node`) in that job. A moved tag there could publish to npm, which
is worse than anywhere else. What limits it is the same SHA pin, and a trigger
that only a pushed `v*` tag fires, which needs repo write access. Ruled on #7.

### No workflow interpolates a `${{ }}` expression into a `run:` block

An operator-supplied value reaches a `run:` step as an `env:` entry and is read
as a shell variable; the command's arguments are built in the shell as an array.
An interpolated value is shell source rather than an argument, which is why the
spelling is the rule rather than a preference: the expression evaluator
substitutes text before a shell has seen the line, so a value containing `;`
ends the command and starts another, and the substituted line is the one the
runner echoes into the log. An `env:` entry has neither property, because the
value is never parsed as source and never appears in the echoed command.

It binds a workflow added tomorrow, which is what puts it here rather than in
the section below: `packages/core/src/workflow-interpolations.test.ts` reads
every file in `.github/workflows/` off disk and reports every expression it
finds inside a `run:` block, with the file, the line, the step and the
expression, so a new workflow is held to the rule the day it lands with no list
to add itself to. That the rule *fails* is the point — it was stated in a
comment and one file drifted from it for as long as nothing checked, which is
the #225 argument that a docblock cannot fail. What the guard does not reach is
an action input that is itself code, a value the shell then expands unquoted, a
composite action under `.github/actions/`, and a `run:` written as anything but
a block scalar or a value on its own key's line.

**The finding it closed had no impact and the record should not imply
otherwise.** A dispatch needs repo write access and `ci.yml` runs `on: push`, so
the drift bought an attacker nothing they did not already have. What was wrong
was that one file contradicted a convention the rest of the repo obeys, which is
how a convention stops being true. Ruled on #337.

### Every package declares the same three fields, and packs only `dist`

Every directory under `packages/` that holds a manifest declares
`"files": ["dist", "!dist/.tsbuildinfo"]`, a `"prepack"` of
`tsc -b tsconfig.build.json`, and a `"types"` pointing into `dist` — the same
three fields, spelled the same way — and the tarball `npm pack` cuts holds
that emitted `dist`, its `package.json`, and the README and LICENSE npm always
packs, and nothing else. Uniformity is the holding rather than an accident of
there being twenty: a per-package variant of any of the three is a per-package
thing to get wrong, so the check compares `prepack` as an exact string and
reports a tarball's every stowaway.

It binds a package added tomorrow, which is what puts it here rather than in
the section below: `packages/core/src/publishable-packages.test.ts` walks
`packages/` off disk and packs whatever it finds, so a new package is held to
all of it the day it lands, with no list to add itself to. `AGENTS.md` under
"The published tarball" carries the three fields and the argument for each,
including where `packages/docs` makes uniformity a choice; do not restate them
here. Ruled on #185.

Each package's `tsconfig.build.json` holds to the same rule. Only `references`
differs between packages; `extends`, `compilerOptions`, `include` and `exclude`
are the same in every one, even where a glob matches nothing in that package,
because a per-package variant is a per-package thing to get wrong. Its
`exclude` keeps tests, their support modules and harnesses out of the emit:
Vitest reaches them as source, nothing in `dist` imports them, and a harness's
test-only dependency, such as `playwright`, stays off the package's runtime
import graph. Nothing compares the files: `workspace-packages.test.ts` checks
only that each package has one. Extended on #662.

**Amended by #691: `create-pagedeck` also packs `template/`**, the site
`npm create pagedeck` copies, because that site must be real files in the
package. Its `files` names each template file one by one, and that list bounds
what is packed, what is copied and what the tarball check admits (#731).

### The bundler is reached through one door, and every hook it is handed is guarded

Outside a `*.test.ts` file, `build` is imported from `vite` by
`packages/core/src/bundler.ts` and by nothing else. `runBundle` there wraps
every hook on every plugin the framework hands a build, so a hook that throws or
rejects is recorded and rethrown once `build()` has settled instead of escaping
into Rolldown, which flattens it into a plain `Error` and drops the class rule 7
branches on and the cause rule 4 attaches. The suite exclusion is part of the
holding: a test building its own fixture is measuring a plugin, not reporting to
a reader.

It binds a plugin added tomorrow, which is what puts it here rather than in the
section below: `packages/core/src/bundler-invocations.test.ts` walks
`packages/` off disk and refuses a second non-suite importer, so a fifth plugin
has nowhere to be handed to a build except through the guard, with no list to
add itself to. That the rule *fails* is the whole holding — twelve docblocks
asserted it before and nothing checked them, which is the #137/#138 argument
that a docblock cannot fail. What the guard does not reach — a framework plugin
misfiled into `sitePlugins`, the dev server's `createServer`, a suite's own
`build()` — is listed in `AGENTS.md` under "One door onto the bundler", which
carries the rule, and is not restated here. Ruled on #225.

### A route segment list refuses dot segments and empty segments

A `Route` is a list of segments, and a segment that is a dot segment or empty
is refused rather than encoded or resolved away. Encoding cannot make one
safe — an escaped dot segment resolves too — so a segment list would
otherwise give no protection the string form does not. A route written as a
*string* is untouched: its dot segments resolve as they always did. Ruled on
#87.

### Edge artifacts are emitted, not provisioned

An edge adapter emits the files a host needs and records what the
host must be given. It does not create host resources, so what it emits is
inert until an operator installs it. What that installation requires is
recorded in the artifacts themselves, so a deploy verb reads it rather than
inferring it.

Past an inline size limit the redirect table moves out of the function into a
host-side lookup store, which keeps the function flat in rule count. Sharding
the table across several functions was the strategy first named, and it was
not built: each shard needs its own cache behaviour, and CloudFront caps cache
behaviours per distribution — the sharded strategy collapses at about the
scale that makes it necessary. Ruled on #33.

### A snapshot has no maximum size

Snapshots are streamed, so there is no memory ceiling to cap. Do not add a
size limit, a config option for one, or a precheck that refuses a large body
before reading it. A cap would mean picking a number that has to sit above
every plausible content store and below what a CI runner absorbs, and nobody
can pick that honestly today. Ruled on #76.

**Extended by #118: the premise is true of both directions now.** Until #118 the
push read the whole store into the process before sending it, so "snapshots are
streamed" described the pull alone and the reasoning above held in one direction
only. Both directions stream off and onto disk a chunk at a time.

### A pull takes a body whose end can be recognised, and that is not a size limit

An https pull refuses a response framed by neither a `content-length` nor a
chunked `transfer-encoding`. Where a length is declared, the pull counts the bytes it
wrote and compares them before the temporary file is renamed over the store; a
body that misses it in either direction leaves the store as it was. The refusal
is not a ceiling and must not become one — the decision above stands, and the
only number involved is the host's own.

What it catches is the one shape nothing caught: an unframed body ends where the
connection does, so a cut transfer ends the read *cleanly* and a partial
database was renamed over the store, surfacing later as corruption. The header
check cannot see it — 16 bytes pass long before the truncation.

A chunked body is accepted and not counted. Its own framing is the completeness
check: the terminating zero-length chunk ends the body, so a close before it is
an error the transport raises rather than an ending — measured on Node v24.18.1
as `TypeError: terminated`. Refusing chunked for want of a length would take
away a framing that was never the defect. What counts as chunked is the last
coding in the `transfer-encoding` list, not the header's presence:
`transfer-encoding: identity` is a body with no transfer coding at all, ends
where the connection does, and is refused with every other unframed body.

The issue asked nothing about `content-encoding`; it is a consequence this
change had to settle. It is refused **only where a `content-length` is counted**,
because `fetch` decodes before the module sees a byte and the declared length
then counts other bytes than the ones written. Under chunked framing nothing is
counted, so a content-encoded body is accepted there — refusing it would cost
gzip-served snapshots and buy nothing. Ruled on #313.

### A paged read has a maximum page count, and that is not the snapshot cap

A loader that pages an upstream bounds how many pages one paged read asks for
and refuses past it, as the example CMS loader does (`MAXIMUM_PAGES`,
`packages/cms-example/src/loader.ts`). The bound belongs on the loop, and a
loop whose only exit is the upstream agreeing to stop is not bounded at all.
Ruled on #335, for a CMS loader whose code was removed in #746.

**This does not reopen "A snapshot has no maximum size" above, and the
difference is what makes both true.** That ruling refuses to pick a number
that must sit above every plausible content store and below what a CI runner
absorbs, and it is right: a snapshot is one opaque body whose shape the
framework does not know and does not control, so there is no honest number.
A page count is the other case. The loader #335 ruled on set the page size
itself, so it knew what a page cost before it asked for one. The example CMS
loader sets no page size, because its CMS fixes two pages to a response, but it
caps every response at `maximumBodyBytes`, so it knows the most one request can
cost before it asks. Either way the quantity being capped is requests in a loop
rather than bytes in a body — the number can be argued from what the framework itself does, which is
precisely what the snapshot number could not be. The test is not "is this a limit" but **does this code know the
size of the thing it is counting**. Where it does, cap it; where it does not,
stream it and refuse only what is unframed (the pull-framing ruling above
draws the same line from the other side).

**Where the cap goes matters as much as the number.** It sits on the shared
paging function, not on the entry points, so every caller inherits it — #335's
loop was reachable from a full sync, a delta sync and a removals read, and
three guards kept in agreement would have been three chances to leave a door
open. An adapter that grows a fourth paged call gets the bound for free.

### A read that must hold the whole body takes a byte cap the site author sets

The ruling above says to stream a body whose size the code cannot know. A read
that must hold the whole body before parsing it cannot stream: `JSON.parse`
takes the body as one string. So such a read takes a byte cap, counted as the
body arrives, and stops reading past it. The code still does not know the size,
so the cap is not a fixed number. It is an option the site author sees and
sets, with a default, and the refusal names the option to raise. The example
CMS loader's `maximumBodyBytes` is the case (`packages/cms-example/README.md`).
A snapshot streams to disk, so "A snapshot has no maximum size" stands. Ruled
on #728.

### The snapshot host refusal takes no override

A snapshot target on a loopback or link-local host is refused, and there is no
flag, config field or environment variable that turns the refusal off. The cost
is accepted rather than overlooked: a job that runs its object store as a
service container reaches it on `localhost`, and such a job cannot push. What
the refusal guards against is a CI variable somebody edited or an interpolation
that lost its host, and a switch that turns it off is a switch that same edit
can set — so the override would be reachable by exactly the mistake it exists
for. Ruled on #118.

### A deploy's default is a dry run, and its refusals differ on purpose

`deploy.bin.js` prints the plan and writes nothing unless `--apply` is passed.
There is no config field and no environment variable that changes the default —
the snapshot host refusal's reasoning applied one layer out: a switch a CI file
can set by accident is a switch that deploys by accident, and the whole point of
a dry run is that reaching the writing path is a thing somebody typed.

Three refusals sit on that writing path for a directory origin, and for a
presigned origin whose history index names a build; a presigned origin with no
index has two. One of them takes no override, which is the part worth recording
because it looks inconsistent and is not. The third, a damaged origin, is
recorded below the test that decides it, and how a presigned origin meets it is
recorded below that.

- **The raced-deploy refusal takes `--force`.** `racedDeployReport` reports that
  this build was built on a manifest other than the one currently live, so
  applying it would drop whatever landed in between. That is a fact about two
  deploys, and a human looking at both can legitimately decide the overwrite is
  what they want — a redeploy of a reverted change, say. A refusal a person can
  be right to overrule needs a way to overrule it.
- **The dry-run default does not take one**, for the reason above: it is not a
  judgement about the state of the world that a human might read differently,
  it is the guard that makes every other refusal reachable at all.

The test is whether the thing being refused is a *fact somebody may know better
about* or a *default that exists to be deliberate*. The first earns a flag; the
second does not. Ruled on #57.

**Widened by #561: a third refusal, and it takes `--from`.** An origin that
holds a deploy history under `.pagedeck/manifests/` and no `manifest.json` is refused
as damaged rather than planned as a first deploy, because a prune planned that
way can delete files the origin is serving with no grace. It fires before
anything is planned, so a dry run is refused too. Which build the origin serves
is a fact somebody may know better about, so by the test above it earns an
override, and the override is the one that already exists: `--from` the
manifest of the build the origin serves. Ruled on #57, widened on #561.

**Narrowed by #652: against a presigned origin, the third refusal does not
fire.** A presigned origin is reached through one URL per object, which cannot
list the deploy history, so a missing `/manifest.json` there cannot be told
apart from a damaged origin, and it is planned as a first deploy. That was safe
because no prune could follow: `--prune` was refused against a presigned origin
until #659, so a first-deploy plan over a live origin uploaded every file and
deleted none. The refusal applies again once a prune can read that history.
Ruled on #652.

**Restored by #659: the refusal fires again against a presigned origin whose
history index names a build.** Every apply now writes the **history index**, and
a prune reads it, so a 404 on `/manifest.json` beside an index naming builds is
a damaged origin, refused before anything is planned, with `--from` as the
override. An origin with no index is still planned as a first deploy: it was
last deployed before the index existed, and its prune deletes nothing until an
apply writes one. This is the condition #652's narrowing named, met by #659, and
not a new ruling.

### The snapshot host refusal is named cases, not a general rule

The refusal names the addresses it refuses — loopback and link-local, in every
spelling the URL parser can produce. It does not implement the general rule
"refuse any target that reaches this runner", because deciding that amounts to
resolving the name and inspecting the route, which no check made before a
connect can do. Two gaps are left deliberately and for different reasons: a
private range is a snapshot host somebody meant, and a DNS name resolving to a
loopback address cannot be decided without a DNS query. The next spelling that
turns up is another named refusal, not a reopening of the general rule. Ruled on
#118.

### Two sources for one value is refused, not ranked

Where the CLI takes a value from more than one place — `pagedeck store`'s target,
from `<url>` or from `PAGEDECK_SNAPSHOT_URL` — supplying both is a usage error
naming both sources. Do not add a precedence rule, and do not let a later
source win "because it is more specific". A caller who set both held two
intentions in one invocation, and acting on either silently is how a store
gets uploaded somewhere nobody chose. The refusal names the edit, and quotes
each source through `redactTarget` like every other message. Ruled on #117.

### The build promises "nothing of mine" on stderr, not "nothing at all"

A successful `pagedeck build` writes nothing of the framework's own to stderr.
Third-party advisories from the tools it runs are not suppressed. Filtering
them by prefix is a treadmill — every new tool that writes a performance note
reopens it — while marking the framework's own output is closed under tools
nobody has heard of yet. Ruled on #184.

### The island scan refuses named parser cases, not a general rule

The scan refuses named cases where the parser moves or strands a hydration
marker. It does not implement the general rule "refuse an island the parser
will not leave where the build put it", because deciding what survives the
parser amounts to re-implementing the parser — the same reason the scan
already declines to judge unbalanced rich text. The next case that turns up is
another named refusal, not a reopening of the general rule. Ruled on #91.

### The `<head>` is the framework's, written by one writer

The `<head>` of every emitted document is written entirely by the build — the
CSS tier links, the metadata, anything a resource lands in later. Having one
writer for that region is what makes the tier order deterministic at all, so a
component that places a resource there is refused, whatever mechanism it used.
React 19's `precedence` prop is the first case: a build-time render prerenders
a *fragment*, so React hoists the sheet into `<body>`, where it beats a `<head>`
tier sheet at equal specificity, silently
(`docs/research/2026-08-29-react-19-stylesheets-under-island-roots.md`). The
refusal is written as the ownership and not as a rule about one React feature,
which is what makes it read correctly for the next resource React grows. Ruled
on #22.

**Extended by #41: one writer means one written-down order.** The metadata a
site declares through `build.head` goes into the same region, so "who writes the
head" was no longer the whole question — "in what order" is the other half, and
an order nobody recorded is one the next feature rearranges by accident.
`headElements` (`packages/core/src/head.ts`) writes it, and `head.test.ts` and
`head.build.test.ts` pin it. The list reserved a slot for #39's
`<link rel="canonical">` and `hreflang` links, between the metadata and the
stylesheets, and **#39 landed as an append into that slot rather than as a
redesign** — which is the evidence the practice is worth the words. Reserve the
slot when a later issue's element is already known.

The blocks, in the order `headElements` writes them:

1. **`<meta charset>`** (`head:charset`). First, because the HTML spec asks for
    the encoding declaration in the first 1024 bytes, and a parser that meets a
    late one restarts.
2. **The document's own metadata** (`head:metadata`): `<title>`, the
    description, the OG tags. Metadata a render hoisted goes at the end of the
    block, after the site's own (#239).
3. **`<link rel="canonical">`, the `<link rel="alternate" hreflang>` set and
    the feed's autodiscovery link** (`head:addresses`, #39, #324). Statements
    about which document this is, so beside the `head:metadata` block. Composed
    by `pageLinks` (`alternates.ts`) and written here, and absent whole on a
    site that declared no origin. A not-found page has no links and carries
    `<meta name="robots" content="noindex">` in the canonical's place (#592).
4. **Font preload links** (`head:font-preloads`, #45, spec §10), for the faces a
    site marked above-fold, from `fontPreloadLink` (`fonts.ts`) in the order
    `build.fonts.faces` declares them (#573). Before the `head:stylesheets`
    block, so the browser starts a face's request before it has parsed the
    sheet whose font-face rule names it.
5. **The site's own pre-paint scripts** (`head:pre-paint`, #311, #330), where it
    declared `build.prePaint`. In front of the `head:stylesheets` block, because
    a classic script after a stylesheet link waits for that sheet to load; here,
    when the code runs is a fact about the parser rather than the network.
    Behind the `head:addresses` and `head:font-preloads` blocks, so the parser
    hands those requests over before it stops to run a site's code.
6. **The stylesheets** (`head:stylesheets`), linked or inlined, in the order
    `entryStyles` fixed, and contiguous: the cascade is the order of this
    block, so nothing that is not a stylesheet goes into the middle of it. On a
    site that asked for view transitions it opens with
    `@view-transition { navigation: auto; }`, so a site's own rule comes later
    and wins (#42).
7. **The JSON-LD block** (`head:json-ld`). Often the largest element, and a
    browser's preload scanner should not step over it to reach the CSS.
8. **The speculation rules block** (`head:speculation`, #42). Last, because it
    is the only child about the *next* document rather than this one.

A page whose site declared none of `head`, `origin`, `fonts`,
`viewTransitions`, `prePaint` and `speculation` gets the `head:charset` block
and the `head:stylesheets` block and nothing else, byte for byte the document
the build wrote before #41, #39, #45 and #42. This list is the record of the
order; the copy in `headElements`' docstring goes in #632.

**Amended by #449: the numbers are checked, because twice they were not.** The
list numbers its blocks and prose across the repo refers to those numbers, and a
number carries none of what it names — so an insertion in the middle of the list
falsifies every reference below it and nothing about the reference then looks
wrong. #45 inserted the font preloads and left `view-transitions.ts`' and
`script-elements.ts`' references behind; #311 inserted the pre-paint scripts on
top of that, had to correct five, left `script-elements.ts`' behind a second
time, and had nothing but a reader stopping it correcting three.
`packages/core/src/head-block-numbering.test.ts` is the #225 answer to that:
it reads the numbering out of the list above, walks every package's `src`
comments and every Markdown file off disk, and refuses a
reference whose sentence describes a block other than the one it names, with no
list of files to add itself to. Most references it found it could not place,
and those — a sentence that named its place in ordinary words rather than in a
spelling the list hands to one block alone — were listed reference by reference
in that file rather than passed over, and #469 below is what emptied the list. A
reference written in a spelling the walk does not match is invisible, which is
what hid `script-elements.ts`' number for two insertions: it was written as a
word, and the walk read digits. It reads both now.

**Amended by #469: the blocks have names, and a reference cites the name.** The
number was the thing under suspicion — it carries none of what it names, which
is how both insertions above falsified references that went on looking right.
Each block of the order now declares a name beside its lead in the list above,
`head:charset` through `head:speculation`, and prose across the repo cites it. A reference citing a name places itself whatever is inserted above
it, so the guard checks it against the list rather than against the words
around it, and refuses a name the list does not declare — which is what makes a
renamed block's leftovers red instead of quiet. The numbers stay in the list,
because they are the order and an order is what that list is; what
went is their use as a way to refer to a block from anywhere else. The census
of 35 unplaceable references went with them, mechanism included: a sentence
that cannot carry an anchor can always carry a name, so a number no sentence
places is now red rather than listed, and the one edit a reviewer had to check
by hand no longer exists.

**Amended by #239: one writer, and the head now takes content the render
produced.** "A component that places a resource there is refused, whatever
mechanism it used" was too wide by one case, and the case is document metadata.
A `<title>` or a `<meta>` a component renders is **absorbed** — the build takes
it out of the body React hoisted it into and writes it into the head itself —
rather than refused. What the refusal protects is the *order* of a region with
one writer, and metadata has no order for a second writer to invert: a title is
a value, not a place in a cascade. A stylesheet still does, so #22's
`data-precedence` refusal is unchanged and stays the case this decision is named
for.

The single writer is unchanged, which is what makes absorption possible at all:
`documentFile` still writes every byte of the head, and `headElements` still
fixes where each one goes. What widened is where a child may *come from*.

Two claims on one head singleton fail the build, naming both claimants and both
values (`absorbedHeadConflicts`, `packages/core/src/head.ts`). Picking a winner
would be the build deciding what a page says it is, and under per-island
hydration which one won would be a fact about hydration order — the research
doc's §3 measured `document.title` becoming a function of where the reader
scrolled.

A singleton is keyed by what identifies it and not by its tag. A `<meta>` is
claimed by the first of `charset`, `name`, `property` and `http-equiv` it
carries, so two `og:image` elements are ordinary and two `og:title` elements are
a conflict. `charset` and `http-equiv` are in that list because they are the
other two ways a `<meta>` speaks for the whole document rather than being one
more element — a second charset restarts the parser, a second `refresh` decides
where the page goes. A `<meta>` carrying none of the four claims nothing and is
written as often as it was rendered.

`build.head` and the build's own `<meta charset>` are claimants like any other,
because a component contradicting the site is the same defect as two components
contradicting each other. Claims that *agree* are not a conflict: one component
rendered twice on a page has said one thing twice, and the head gets one
element.

Ruled on #239, against §6's table in
`docs/research/2026-08-29-react-19-stylesheets-under-island-roots.md`, which says
"refuse" for these rows and was written from the CSS side. That document's
**Status** line records which of its rows this superseded.

**Extended by #281: a build that does not render a page reads its document back,
and never composes one.** An incremental build re-renders the pages its plan
names and keeps the rest. The obvious way to "keep" one is to compose its
document again from the row the previous manifest holds — and that is refused
here, because a second composition of the `<head>` is a second writer of it, by
this decision's own definition. Whatever the two writers agreed on today, they
would be free to disagree the next time an element is added to one of them, and
the disagreement would show up as a byte difference on the pages nobody
re-rendered.

So a reused page's emitted document is **read back off the output tree** the
build is merging into, and carried as ordinary bytes. `documentFile` stays the
one writer of every head this framework emits, and a page's head is written
exactly once in its life. Two consequences follow and are worth naming, because
they look like costs until this decision explains them:

- The tree at `outDir` is an **input** to an incremental build, so a document
  that is missing or has been edited there is a refusal naming the page, not a
  page quietly recomposed.
- A `<head>` element that joins over the *whole route table* — hreflang
  alternates, speculation rules — goes stale on a carried page when another page
  moves. That cannot be patched into the carried bytes without becoming the
  second writer this refuses, so the page is re-rendered instead:
  `crossPageAffected` (`packages/core/src/incremental.ts`) widens the render set
  before anything is rendered.

Binding on every later consumer of the incremental writer (#300, #301, #326,
#307): a narrowing that would have to touch a carried page's head re-renders
that page. What a failed read-back costs is each consumer's own to answer and
the answers differ — `carryDocuments` refuses the build, `carrySitemaps`
composes the file again, `carriedCards` (#326) keeps nothing for that tree and
draws nothing, because a missing card costs a page its preview image rather than
its document, and `carrySearchIndex` (#307) refuses the build, because an index
is composed from every page's render and an incremental build holds only the
ones it rendered. The third answer is decided per tree because #415 gave one card one
copy per output tree: the trees that still hold theirs are carried as they
were.

**Extended by #311: one writer, and one slot in the order the site fills.** A
returning visitor's stored consent decision has to be installed before the
script layer's loader parses, and no island can do it — an island hydrates after
the body the loader sits at the end of. So `build.prePaint` carries the site's
own synchronous scripts and `headElements` writes them, in a block of their own
between the font preloads and the stylesheets. #330's theme toggle is the other
consumer and the reason the slot is named for *when* it runs rather than for
what it is for: pre-paint stored state is the shared shape, and a door called
"consent" would have had to be widened for the second thing through it.

This does not widen #22's refusal, and the two are worth telling apart. What is
refused is a *component* placing a resource — a second writer arriving through a
render, which the head's order cannot survive. This arrives through the config,
lands where the one writer put the block, and is one more child in a
written-down order rather than another way into the region. The site supplies
the text; core still writes the element.

The boundary it keeps is the whole reason for the shape. Core emitting the
consent bootstrap itself was the obvious fix and would have made `@pagedeck/core` know
`CONSENT_BANNER_STORAGE_KEY`, which is the reference banner's own business —
`FontAdapter` and `ImageAdapter` exist to keep core from knowing a vendor's
shape, and a stored record is that rule's next case. A site-supplied script
keeps it: core promises when the bytes run and learns nothing about them, and
the banner ships its snippet beside the key it reads so the two cannot drift.
What core does check is that the text can be carried at all — `</script` and
`<!--` are refused at config load, because a program is the one value it cannot
encode its way out of — `prePaintFaultReport` in
`packages/core/src/pre-paint.ts`. Ruled on #330 (2026-09-06) and #311
(2026-09-13).

### The framework names no CSS solution

No source, config default or dependency of this framework resolves, imports or
branches on a CSS toolkit. A site brings its own, as a Vite plugin through
`build.vite.plugins`, at the version it chose.

**What the ruling forbids is behaviour, not the word.** #22 rejected a build
that *detected* a named toolkit, and that is the thing measured here: no
specifier, no dependency, no code path that asks which toolkit produced a
class. Prose may name one where the alternative is a comment that cannot say
why the code is shaped as it is. `classes.ts`'s five-entry escape set is the
case that earns it: those five character references are the spelling
Tailwind's arbitrary variants arrive in, and without the name the set stops at
five for no reason a reader can check. Deleting such a sentence would change no
behaviour. Ruled on #29, after a review read the earlier wording literally and
counted four violations in a branch that removed two more than it added. That key is scoped to `plugins` and is deliberately not a
general Vite config merge: everything else the client build pins is pinned
because #56 shipped three defects from leaving it ambient, and a merge would
hand them all back. The bargain is that determinism inside the array becomes
the site's responsibility — spec §11 makes byte-identical output a CI-checked
invariant, no type can stop a plugin writing a timestamp, and
`pnpm check:build-twice` is what catches it. A narrow key plus that check is the
trade, and it is the shape any future escape hatch is measured against. Ruled
on #22.

**Extended by #29: there is a second door, and core calls this one.**
`build.driftSupplement` is the other way a site's toolkit reaches this build — a
function core hands one drifted page's missing classes and takes a stylesheet
back (`SupplementCompiler`, spec §9). The ruling above is why that field exists
rather than something it bends: spec §9 describes the supplement as a scoped run
of a named toolkit, core cannot make one, and #22's rejected detection is why it
may not learn to, so the compile is the site's exactly as the plugin array is.
The pass runs on an incremental build and on no other kind, since a full build
cannot drift by construction (`packages/core/src/drift.ts`, #281) — so what is
settled here is the door, and the door now has traffic through it.

The two doors are not the same bargain, and what separates them is which way the
bytes travel. A Vite plugin's output core never reads: it is placed in a tier,
and what generated it is invisible (Global CSS pins to the core tier, below), so
the whole trade there is determinism inside the array. A supplement is an answer
core takes back and puts in a page's `<head>`, so core has to say what it does
with an answer it cannot use, and that classification is this door's half of the
trade (`packages/core/src/supplement.ts`). No compiler declared, and a compiler
answering with nothing or with whitespace, are warnings: a site whose CSS is
hand-written has none to declare, and the pages the build emitted are the pages
it would have emitted anyway. A compiler that throws stops the pass as a plain
`Error` and exit 1, a loader's throw's class, because the site's own code failed
while running. An answer that is not a string, or one holding `</style`, is a
`ConfigError` and exit 2, because a declared function answers that way on every
run until somebody edits it. That last line — whether the fault comes right on a
retry — is `docs/error-messages.md` rule 7's, and it is what a third door of
this kind is measured against, beside the narrow-key trade above.

### The framework names one state library, and it is not the CSS bargain

`@pagedeck/islands` depends on Jotai at an exact version and re-exports the part of it
a site writes against, so a site never installs it (#252). That is the opposite
of the decision above it, and the two are not in tension: what makes the CSS
bargain work is that a stylesheet is *placed* by the build and never read by it,
so a site can bring any toolkit and the framework only has to put the output in
a tier. Cross-island state is the other kind of thing entirely. The framework
has to hold the shared store instance, hydrate it before any root mounts, and
assert on its identity in the emitted chunk graph — none of which can be done about a
library the framework does not name.

The version is exact rather than a range, and the reason is recorded because it
is unusual here: the multi-root behaviour the whole design rests on is
undocumented. Jotai's docs, tests, examples and issues hold zero hits for
`island`, `micro.frontend`, `multiple roots`, `hydrateRoot` or `createRoot`, so
it works by construction rather than by promise, and #252 took the version its
runtime evidence was gathered on rather than the newest. A bump is meant to cost
somebody a re-verification, which is what `store.test.ts` buys by asserting the
declared specifier and the installed manifest are the same exact version: a
lockfile refresh cannot move it quietly, and widening the specifier to a range
fails the same test.

What this does *not* commit to is a second one. A site wanting a different state
library still has the root provider stack, which delivers whatever instance the
site hands it; what it does not get is the stamp, the hydrate-once seam or a
chunk-graph assertion naming its module. Ruled on #252, from #66's 2026-08-24
design review.

### Global CSS pins to the core tier

A stylesheet the site declares in `build.css` is pinned into the core tier and
**reaches every page, content-only pages included**. "Global" and "cached
site-wide" are the same claim, and the core tier is this build's spelling of
"cached site-wide" — a declared sheet left in whichever tier its importer earned
is a sheet some pages ship class names for with no rules behind them. The pin
therefore follows from the declaration rather than being a case beside it, and
the framework never opens the file: what generated the bytes is invisible to it.
Ruled on #22.

**Amended by #23: "reaches" was "is linked from", and a flagged page inlines
instead.** `build.criticalCss` moves a page's whole reachable set — the core
tier included — out of its `<link>` tags and into `<style>` elements in its
head, so such a page links none of it. The pin is unchanged: the sheet is still
core-tier, still one file, still linked by every page the site did not flag.
What changed is that "every page gets these rules" and "every page gets them
over one cached URL" are no longer the same sentence, and only the first is the
promise this decision makes.

**Amended by #50: the pin is a build-time fact, and `pagedeck dev` keeps the promise
without it.** A tier is computed over the whole site's island set, which spec
§10b keeps out of the dev server — so there is no core tier there to pin
anything into. A dev page links each declared sheet at its own URL instead, and
Vite serves it. What survives is the part that is a promise about pages rather
than about files: every page gets these rules, content-only pages included, on
both targets. What is build-time is "over one cached URL", which was already
only half the sentence after #23.

### A flagged page inlines its whole reachable CSS, core tier included

`build.criticalCss` is all-or-nothing per page: a flagged page inlines every
stylesheet it would have linked, in the same order, and links none of them.
There is no narrower set to compute. Spec §9 says a page's critical CSS is
"computed from its known component set (no headless-browser heuristics)", and
the build's reachable set — `planEntryStyles` plus `ClientBuild.globalStyles` —
already *is* that set, so with above-the-fold measurement ruled out, "critical"
and "reachable" name the same list. Do not add a heuristic that narrows it; the
place to argue for one is an issue that first reopens the spec's parenthetical.

The core tier goes in with the rest, and the lost site-wide cache entry is
accepted rather than overlooked. A visitor who continues to a second page
downloads the core sheet there for the first time. The feature exists for
cold-cache ad traffic that had no cache hit to lose, which is why it is opt-in
per page and never a site-wide setting — and why the next feature that wants to
inline something should ask whose cache it is spending before copying this.

An inlined sheet is still emitted and still deployed. On a site that flags every
page, the core file ships with nothing linking it. Pruning it is a manifest and
deploy question rather than a CSS one, so it is a known limit here, not a defect
(`packages/core/src/critical-css.ts`). Ruled on #23.

**Amended by #611: the reachable set has a third source, the font stage.** A
page's style list opens with the font sheets it links — the site-wide one and
each route-scoped one (#573) that matches the page — ahead of
`ClientBuild.globalStyles` and `planEntryStyles`' sheets, so "the build's
reachable set" above is all three. A flagged page inlines them with the rest,
in that position; their `src: url()`s are root-relative, so the text resolves
from the page's head as it did from the file.

### Fold tuning moves a defaulted mode up and a declared mode only down

Fold-driven hydration decides **per occurrence**, from that node's own fold
position (Language, above) and never from a recorded per-component figure — no
average can give one component two answers on two pages, which is what the
feature is for.

Which direction a mode may move is decided by where it came from, not by what
it is. A mode the `"use client"` directive defaulted to may be **promoted**
(`visible` → `load` above the fold). A mode the registry **declared** is never
promoted — an author who demoted a heavy above-fold component measured
something the build cannot — but a declared `load` **is** demoted below the fold,
which is the only shape a demotion can reach, since no directive ever defaults
to `load`. That asymmetry is the settlement of a real conflict: the 2026-08-24
design review's "an explicit `hydrate` is never overridden" and issue #24's
"demote an explicitly-declared `load`" cannot both hold literally, and reading
the review as governing promotion alone is what leaves the feature
bidirectional. A demotion takes bytes off first render; a promotion adds them,
which is the direction an author's explicit judgement is protecting. Ruled on
#24.

### The manifest is the per-page record of what a build decided

A per-page decision a build takes on the site's behalf is recorded in
`manifest.json`, not in `budget-report.json`. The budget report is written only
for a site that declared `build.budget` or `build.criticalCss`, or whose build
breached the island props limit (#653), so a listing
that lived only there is invisible on most builds that produced one; the
manifest is written by every `pagedeck build`. The budget report still carries such a
decision where it explains a *spend* — `BudgetPageSpend.causes` — and both are
rendered from one derivation in `stageSite`, so the two documents cannot
disagree about what happened. Ruled on #24, and it is the question the next
build-report criterion should be measured against.

### The entry-id contract holds on write

Recorded in [ADR-0004](./docs/adr/0004-the-entry-id-contract-holds-on-write.md),
not here. It settles where an unusable entry id is refused, that one shared
predicate answers the question for both doors, and that an id is read in its
raw, percent-decoded and URL-parser spellings (#141, #142).

### A parity baseline is never generated from the build, and its coverage is enforced

Two rules, because they are one failure wearing two faces: a parity report that
is green for a reason that has nothing to do with the site.

**A baseline generated from `pagedeck build`'s own output is refused.** It would agree
with that build by construction, on every field, forever — a snapshot test
wearing a parity harness's name, reporting "no differences" for the reason a
broken clock reports the time. So the facts in
`packages/site/src/parity-baseline.ts` are written from the site's own entries
and from what the design system's components render, and the only thing
derived from a build is the *URL set*, because a URL is a decision
`definePages` makes out of the locale map and the slug and guessing at one is
how #161 happened. This binds
any later site that grows a baseline, not just this one.

**Coverage is enforced rather than reported.** `compareParity` throws on a
baseline with no pages, and on a URL on either side accounted for other than
exactly once — it does not merely put the counts in the report and leave a
reader to notice. "0 defects" over four of four URLs and "0 defects" over none
of four print the same three characters, and a coverage number nobody reads is
not a guard. The refusals are what stand between the harness and "no differences
because it compared almost nothing", which is the failure mode the issue was
filed against.

The same reasoning is why an expectation rule must carry a reason and a blank
one is refused: a rule with no reason is not a rule, it is a tolerance, and a
tolerance in a parity harness is indistinguishable from the harness being wrong.
Ruled on #58.

### A site audit asserts only what is deterministic, and records the rest

A **site audit** may fail a build on a figure that answers the same on an idle
laptop and on a loaded runner — a byte count off an emitted build, a request
count, a score computed from static markup. It may **not** fail a build on a
figure derived from wall-clock time: the Lighthouse performance score, LCP,
TBT, FCP, speed index and CLS are recorded in the report and compared against
nothing.

The reasoning is #57's closing comment, which ruled on the same shape one issue
earlier: "a wall-clock assertion on a shared 4-core runner would manufacture
exactly the flake class #183 is about". #183 is the class where several
`.build.test.ts` suites time out at 5 s under full parallelism on this project's
four-core box. A red build that means "the runner was busy" trains a reader to
re-run rather than to read, and the audit is what loses the argument — the next
real failure is read as noise.

**Recorded is not a weaker form of asserted; it is the deliverable.** The report
`.github/workflows/lighthouse.yml` keeps as an artifact carries every metric with
the machine and the run conditions beside it, and `docs/success-criteria.md`
reads them as data. A trend somebody looks at is what a timing figure is for; a
gate is what it is not.

**A score floor is a ratchet, not a claim.** The floors in
`packages/site/src/audit-site.ts` are set at what the build measures today so
that the known-open findings cannot get worse while they are open, and each open
finding is filed rather than rounded away. A floor is raised when its findings
are closed, never nudged down to make a run pass. This binds any later site that
grows an audit, not just this one. Ruled on #59.

### A failed color probe is retried, never cached as a failure

A **dominant color** the probe answered with is cached, and that includes the
answer "this image has none" — without a row for it, an image with no color
would be fetched again on every sync for ever. A probe that **threw** is not
cached, and the next sync asks that source again.

The alternative — caching the failure as "no color" — makes a repeat sync cheap
in the case that is already cheap, since a failing host is a small minority of
sources, and buys it by making a five-minute outage permanent. Nothing in this
framework clears an image-color row: there is no verb for it, no expiry, and no
message that would send anyone to look. Retrying costs one request per sync per
*unique* broken source, under the same concurrency ceiling as everything else,
and it is reported every time (`colorFailureWarning`), so the cost is visible to
the person who can act on it.

**The retry is over every source the collection holds, not over the entries a
sync happened to write**, and that is a consequence of this decision rather than
an implementation detail beside it: a source reached only through a changed
entry is never asked about again on an incremental sync, which is the permanent
outage this decision rejects, arriving by the other door. So a sync reads its
collection's entries back and asks about every source with no cached answer.
What that costs is one local read of the collection per sync and no ceiling on
the total number of requests a fully broken collection makes — `writeImageColors`
(`packages/content/src/collection.ts`) states both.

The tie is broken by the ruling this repo already made one feature over: an
**external link probe** that throws is a warning "because a network failure is
the one kind of fault that does come right on a retry". A transient failure
should heal itself and a permanent one should be visible; only retrying gives
both of those what they want. A probe that answers with something that is *not*
a color is the other half of that entry too — a `CollectionError`, exit 2,
because a declared function answers that way on every run until somebody edits
it. Ruled on #44.

### An image's fold verdict is a node's, and the caller states it

`ImageSource.aboveFold` is an input a site passes, and the framework supplies the
comparison — `isAboveFold` (`packages/core/src/fold.ts`), the same one
`tuneHydration` takes — rather than deriving the flag itself.

**The framework also supplies the numbering the comparison reads, which #299
added and this entry originally left to the site.** `foldPositions` walks a
caller's own nodes and answers each one's `position` and the tree's `treeSize`,
so a site building a tree from its CMS's shape numbers it with the build's own
walk instead of a copy. `islandInstances` reads the same function, so there is
one definition of what position 3 is rather than two free to drift.

**One definition is not the same promise as one answer**, and the difference is
worth stating because the stronger claim is the easy reading. What
this guarantees is that a site and the build *count the same way*. That their
counts land on the same node also requires the site to number the tree it
actually emits — a map that drops, filters or reorders nodes on the way out
produces a tree the numbers no longer describe, and nothing here can catch that.
Both callers in this repository are total one-to-one maps, so the stronger thing
is true today by construction rather than by enforcement.

None of that moves the line this entry draws; it moves what sits on the
framework's side of it. Core answers what the node *is* — where it falls in the
tree — and the site still decides what that means for a given image. Before #299
a site had to answer both, and the walks it hand-rolled to do so are what #299
deleted: one in `packages/site/src/props.ts` and one in the example. Core's own
private counter inside `islandInstances` went at the same time, for a different
reason — it was the second implementation this export exists to remove.

The reason is what the datum is. The finest fold information this build holds is
a **fold position**, a node's index in its entry's tree, and an image is a *prop
of a node* rather than a node: two images one component renders share one
verdict, and `ComponentUsage.foldScore` is coarser still. A framework that read
a node's position as every image's position would be claiming a precision no
stage of this build has, and it would claim it on the expensive side — `eager`
and `fetchpriority="high"` on four images to be right about one, an error that
costs bytes a phone never renders.

So the fold rule is exported and the site applies it: one image per node is a
pass-through, and a component drawing four decides which of them the verdict was
about. This is the same division **Image adapter** and the entries around it
draw everywhere else — the framework decides what it can decide from data it
holds, and the site states what only it knows. Ruled on #44.

### A site describes a vendor's code, never core's

A consent category is a claim about what a script is loaded *for*, and who may
make that claim depends on whose code it is about.
`ScriptDeclaration.category` is a site's, because a third-party script is
something the site chose to carry and only the site knows what it is doing
there. The category of code **this framework emitted** is not a config field:
the RUM beacon waits on `analytics` and there is no way to say otherwise
(`BEACON_CATEGORY`, `packages/core/src/beacon.ts`), because a field there would
let a config declare, on core's behalf, that core's own code is `necessary` and
may run for a visitor who declined.

This binds every core-emitted runtime that comes after it, not the beacon
alone: whatever it is for, core names the category, states it in the reference
page, and refuses to make it configurable. A site that disagrees is disagreeing
about whether to carry the feature, which is what the field turning it on is
already for. Ruled on #48.

### Market consent defaults live in one map, and a beacon-only site has none

`build.scripts.consentDefaults` is the only place a site says what a market
assumes about a consent category before that site's own `ConsentSource` has
spoken, and `defineScripts` refuses an empty `scripts` list. So a site that
declares `build.beacon` and carries no vendor scripts has nowhere to write one:
`beaconElement` (`packages/core/src/beacon.ts`, #48) is handed no script layer,
falls back to `DEFAULT_CONSENT`, and bakes `denied` for `analytics` into every
page of every market until a source answers in the browser. No field is added to
close that. The limit is recorded here instead, so the next reader meets a
decision rather than a gap.

**It is not a state of its own**, and that is the first thing to know about it.
A site with no map gets what a site whose map names no market gets:
`resolveConsentDefault` (`packages/core/src/scripts.ts`) answers
`DEFAULT_CONSENT` for every key it was not given, and absent is "the opt-in
regime" rather than an omission. A beacon-only site is not being handled
specially; it is being handled as the site it is, one that has said nothing
about any market.

**`denied` is the direction to be wrong in**, which is what makes the limit
liveable rather than merely tolerated. The beacon reports a real visit to an
endpoint the site owns, so the two errors are not the same size: a silent beacon
on a market nobody described costs a row in somebody's dashboard, and a
reporting one costs the visitor the thing the category exists to protect. A site
that finds the silence expensive has an answer that is one line and is the
contract anyway — the source decides this at runtime, and the default was only
ever what the page assumed until it spoke.

**A second `consentDefaults` map on `build.beacon` is refused.** Two maps can
disagree about one category on one market, which is the failure a single map
exists to prevent, and nothing in the config would say which of them won. The
sharper reason is what a market default *is*: a fact about the jurisdiction a
page is served into, not a property of any one thing loaded there — which is why
the map is keyed by page pattern rather than by script, and why
`resolveConsentDefault` is asked per category rather than per script. A map per
feature would let one market be opt-out for the beacon and opt-in for the pixel
on the same page, and no jurisdiction says that.

**Relaxing `defineScripts`' empty-list refusal is refused separately**, because
that refusal is load-bearing where it stands: a declared layer means something
loads, and a site with no third-party scripts declares no layer at all — issue
#46's zero bytes on a page that asked for nothing. Admitting an empty list so
that `consentDefaults` had somewhere to live would make `defineScripts` a door
for something other than scripts, and would put back into the tree the layer
that does nothing, for every later reader of that function to re-argue. A limit
recorded is cheaper than a refusal weakened for a reason outside its own
subject.

**What #311 changed is where the pointer points, and it does not close this.**
`build.prePaint` is a head slot for the site's own synchronous scripts, written
into every document ahead of the stylesheets, so a `ConsentSource` can be
installed at parse — before the first paint, before the loader at the end of the
body, and before the beacon's first opportunity to report. It is a `build` field
of its own, which is the half that matters here: a beacon-only site reaches it
with no script layer at all, either with three lines of its own JavaScript or
with `CONSENT_PRE_PAINT_SCRIPT` (`packages/design-system/src/consent.ts`) where
the **Reference banner** is what is asking. "Install a `ConsentSource`" is
therefore no longer only advice about runtime wiring: it has a declared address
in the config, and that is the sentence this decision sends a reader to.

It is still not a per-market default, and nothing written about it may imply
otherwise. A `prePaint` entry is a flat list of text every page carries, keyed
by nothing, so a site whose answer varies by market writes that branch in its
own snippet — the site's own code describing the site's own record, so it is not
the second map refused above. The banner's snippet installs nothing at all where
the browser holds no record, so a first-time visitor leaves the site's
`consentDefaults` in charge — `DEFAULT_CONSENT` on a site that has no map —
exactly as before, and a site declaring no `prePaint` entry keeps the behaviour
it had. The limit above is unchanged by #311. What changed is that the answer to
it is now something a site declares rather than something it arranges. Ruled on
#364, on a limit #48 found and deliberately left open.

### An example site's image host is a placeholder

No **example site** in this repository names a real image service. The **Image
adapter** entry above says *core* names none, which is a fact about what core
ships; this is the wider holding, and it binds every example site added here
after it.

A site's image template is legitimately a site's own — that is the whole shape
of the adapter, and a real deployment writes a real host into it — so nothing
about the contract forbids one. What forbids it here is who reads these
packages: a consumer copies an example site's config before it copies core's
source, and a service named in `packages/site` would be this repository
recommending one, under the name of the framework, in the file a reader reaches
first. That is the same asymmetry **A site describes a vendor's code, never
core's** draws one door along — a claim a site is entitled to make in general is
not one it may make on core's behalf.

So a host an example site's template names is a name under RFC 2606's
reserved `.example`, resolving nowhere, and the URL scheme is documented where a
reader meets it so that swapping in a real host is one string. Choosing the real
host is out of scope for this repository, not deferred in it.

**The narrowing is derived from the reason above rather than laid over it.**
That reason rests on one asymmetry — this is the file a consumer copies first —
and a site published under its own name is no such file: its host is one
deployment's own setting, and nobody copies it to start a site. So there is
nothing for "this repository recommends a service" to be built out of, and the
reason has nothing left to forbid. Which side a site falls on is **Example
site** above and never a list of names, because a list is a thing to get wrong
the day a real deployment lands.

**Same-origin candidates are not an image host, so this entry does not apply to
them.** A file an example site publishes itself, from its `public/` through
`build.passthrough`, is that site's own and names no service, which is the
doctrine `AGENTS.md` states for `packages/landing`'s showcase (#551).
`packages/site`'s hero is the second such image (#628): its template named
`images.example`, which resolves nowhere, so the hero never loaded, and it now
points at checked-in candidates under that package's `public/`.
`packages/site/src/site.build.test.ts` joins every `<img>` candidate and every
image preload candidate to a file the build wrote, against the emitted
documents rather than the config. Ruled on #213, narrowed on #384, amended on
#628.

### An example site's third-party script sources are placeholders

No **example site** in this repository names a real analytics product, tag
manager or consent manager, and none may. It is the entry above over
`build.scripts` instead of over an image template — the same holding rather than
an analogous one, which is also how the narrowing to example sites reaches this
entry without being argued a second time.

It is recorded separately because the thing being named is different in a way
that matters. An image host is infrastructure a site points at; a third-party
script is a *product relationship* — a contract, an account, a category
vocabulary that is that vendor's rather than this framework's. Core already
holds the narrow half of this twice over: `ScriptRuntimeAdapter` is a function
the site supplies and **Consent source** is an object the site installs, and
neither names a mechanism. An example site naming one would be the first place
in this repository a product appears, in the file a consumer copies first.

So `packages/site` declares two scripts against hosts under RFC 2606's reserved
`.example`, and the demonstration is the wiring rather than the loadout: a site
declaring scripts, assigning strategies, categorizing them for consent, and
scoping them to pages. Swapping in a real vendor is the two sources plus a
`ConsentSource` mapping that vendor's categories onto the four core names,
which is the edit this arrangement exists to make small.

The consent *categories* are not placeholders and cannot be, and **this is
where the entry departs from the ruling that produced it.** #212's 2026-08-31
ruling asked for "a placeholder script source **and a placeholder category
vocabulary**"; the first half is what the paragraphs above record, and the
second half is unmeetable. `ConsentCategory` (`packages/core/src/consent.ts`) is
a closed union of `analytics`, `functional`, `marketing` and `necessary` —
core's vocabulary, spec §12, where `functional` was added for third-party embeds
on #459 — so a site has no vocabulary of its own to make placeholders of: it
chooses among the four or declares none, and a fifth name is a type error
rather than a stand-in. What a site does supply is the mapping from its vendor's
categories onto those four, which is the half the ruling was reaching for and
is what keeps the swap small.

The two worked adapters in
`packages/docs/content/reference/third-party-scripts.md` stay the only place in
this repository a consent manager is named — a reference page describing a
vendor's code, which **A site describes a vendor's code, never core's** already
permits. Ruled on #212, narrowed on #384, with that one departure recorded here
rather than left for a reader to find in the issue's comments.

### The `<main>` landmark is the framework's, written once per document

Core wraps a page's rendered tree in `<main>`, in `documentHtml`, and no
component of any site renders one. Since #461 the landmark holds a little more
than that tree: a facade's placeholder is emitted inside it too — inside the
element the facade named as its **Facade mount point**, above, or after the
page's content where it named none — so a control standing in for an embed
belongs to the same region the content does. It is **The `<head>` is the
framework's, written by one writer** applied to the body's one singleton
region: a document may hold exactly one `main` landmark, so one writer owns it
or two claimants fight over it.

The reason it cannot be a component's is what a CMS page is. A page composed
from a flat list of blocks has no component that owns the whole page, so there
is nowhere in the tree for the landmark to go — which is how the dogfood site's
two tree-driven pages came to sit in no landmark at all. Asking every root
component to render one instead makes the landmark a thing a site can forget,
and it makes a page that mounts two root components emit two. Ruled on #296,
which also ruled out `build.rootProviders`: that stack wraps every island root
at hydration, so a landmark there is re-emitted once per island.

**Two consequences are recorded here because they bind sites rather than this
change.**

A site's chrome is declared, and it is the only markup outside the landmark.
`BuildSection.chrome` is a callback that returns one page's chrome as two lists
of entry nodes: `before` renders ahead of `<main>` (a header, a nav) and `after`
renders behind `</main>` (a footer), so the three are siblings in `<body>`. It
is called per page with `content`'s arguments, which is how a nav marks the
current page, and its nodes go through the page's own render: the registry, the
root providers, the island passes, the page's entry and its class manifest.
Until #409 there was no such field. "The whole rendered tree" admitted no exception,
so a top-level `<nav>`, banner or `contentinfo` was a descendant of `<main>`
rather than a sibling, and `packages/docs`' own navigation still is until it
moves onto the chrome. The ruling on #409 chose the field over the two answers that
make the landmark depend on what a site rendered: a marker a component carries
to opt out, which a site can forget, and skipping the wrap when the tree already
holds a `<main>`, which would let rich-text content remove the page's landmark.
The wrap stays unconditional, and a `<main>` the chrome renders is refused
naming the page rather than taken in place of core's.

The rule is enforced, and it was not for the whole of #296's life. The head's
singletons are owned by a refusal — a component placing a resource there is
refused outright — and this one was owned by a comment and by the repository's
own packages having been changed to follow it. What that cost is on the record:
a site's 404 page rendered a second `<main>` inside core's, shipped through
two `/review` rounds and a Landing gate on #328, and `landmark-main-is-top-level`
went unreported because nothing read the rule. So `documentHtml` now counts the
landmarks in each document it composes and throws a `RenderError` on the second
one, naming the page and the fix. Ruled on #455, which also rejected the two
placements that would have left the guard optional: a per-site build test is a
rule each new site has to remember to copy, and a site audit asserts only what is
deterministic and would have reported this rather than failed on it.

**The refusal counts the finished document, not the render.** Subtracting core's
own landmark and counting the rest holds only while the landmark has one writer,
which is the claim being enforced, so a second `"<main>"` added to the document
composer is caught by the same line as a component's. It reads emitted bytes and
never source: a component that computes the tag name, or renders the landmark
behind a condition, fails the same way a literal does.

**What guards it is not what measures it.** Lighthouse's accessibility category
scores `landmark-one-main` and `heading-order` and does not contain `region`,
`landmark-no-duplicate-main` or `landmark-unique`, so the audit's score floor —
100, and every regression it can see fails the build — cannot see a duplicated
or nested landmark at all. `packages/core/src/landmark.build.test.ts` measures
what the build refuses instead, over both of the doors a document reaches a tree
by: a component that renders `<main>` fails the build that composes its page,
and a two-landmark document an incremental run would have reused off `outDir`
fails as `carryDocuments` reads it back (#455). The refusal is the guard. That
file is what pins it, and going red when either door stops refusing is a
different job from being the rule.

### An example site declares a placeholder origin

An **example site** in this repository declares a `build.origin` under RFC
2606's reserved `.example`, so that the emission gated on that field is
dogfooded without the site claiming an address it does not have.
`packages/site` declares `https://dogfood.example`, which is what puts a
`<link rel="canonical">` on each of its pages and the `hreflang` set on the one
path both locales publish.

**It is a third placeholder entry and the first with a different reason, which
is why it is recorded rather than folded into either of the two above.** Those
forbid naming a real image service or a real script vendor, and the reason both
give is that a consumer copies an example site's config before it copies core's
source, so a product named there would be this repository recommending one. An
origin names no product. It is the site's own address, and the reason it is a
placeholder is narrower: the site's content is a module of its own with no
deployment behind it, so a host written here would be invented — the same
refusal `LOCALES` already makes one field over when it maps no domain to any
locale. Reading the image host's argument onto this field would prove a
stronger claim than the field needs, and the wrong one: nothing about
`build.origin` forbids a real host, and a real deployment writes its own.

**The declaration is what makes the absence testable, which is the whole of the
holding.** Before it, `packages/core`'s canonical and hreflang emission was
covered by core's own tests and by no build of a real site — a feature with no
dogfood consumer, which is what #288 was filed to name. The placeholder buys
that consumer for one string. As with both entries above, the assertions are
written against the emitted documents rather than against the config, because
the config is precisely what a site owner changes.

**An origin is not owed to every gated field.** `build.sitemap` is also gated on
this one and stays undeclared, so declaring it emitted no sitemap and added no
file. What a placeholder is for is an emission this repository wants exercised,
not a switch to be turned on because it can be. Ruled on #288.

### The framework emits no header a site did not write

A response header reaches a generated site's output because the site's config
asked for it, and for no other reason. Core states a posture and ships it as
*data* — `SECURITY_HEADERS` (`packages/core/src/routing.ts`), three fields an
author spreads into a `HeaderRule`'s `set` — rather than as a default the build
supplies on the site's behalf. A default fails twice over: a site whose CDN or
reverse proxy already sets these headers would serve each one twice, from two
places, one of which its own config does not show; and every existing site
would get a change in what it serves without having consented to one. Opt-in
data makes the safe posture one line and leaves the emitted document exactly
what the author asked for.

The absence is *warned*, not filled. `undeclaredHeadersWarning` says once that
a site declared no header set at all, and names the constant that closes it, on
`uncompiledGlobalCssWarning`'s terms: every page the build emitted is correct,
so this is not a refusal, and a site whose host sets these headers a layer out
has nothing to fix. Any declared rule ends the warning whatever it carries —
grading a site's set against names core would have preferred is the silent
default arriving by another door.

`Strict-Transport-Security` and `Content-Security-Policy` are excluded, and not
for effort. Each needs a fact no build can read. HSTS is a promise about a
*domain*: a browser told once to refuse plain HTTP keeps refusing, and
`includeSubDomains` reaches hosts whose owners never saw this config — nothing
in a config or a manifest says whether that domain is ready. A CSP is a claim
about what a *page* may load, and a wrong one breaks the page in production on
the first request that violates it. A value that has to be read is not a value
a constant people spread unread may carry.

What this binds is the next proposal to ship a header, a policy or a default on
a site's behalf: the answer is data the site opts into, plus a message where
the silence would otherwise be. #315 is the first issue it governs — the inline
script loader and a strict CSP cannot both hold, and whatever settles that may
not settle it by emitting a policy the site never wrote. Ruled on #318,
excepted on #556.

**Settled by #315: the script loader's hash is an ingredient, and core still
writes no header.** Each page's manifest row carries `inlineScriptHashes`, the
CSP source expression of the script loader that page's document holds, read off
the bytes the build wrote. A site builds its own `script-src` from it; core
emits no `Content-Security-Policy` and no `<meta http-equiv>`, and mints no
nonce. #499 widened the same list to the RUM beacon, each pre-paint script and
the speculation-rules block: every inline script core writes, in document
order, and none a site writes itself.

**Excepted by #556: the reserved deploy keys answer 404 on every site, a deny
and not a header.** Every edge artifact denies `/manifest.json` and `/.pagedeck/`
whatever the site wrote, and no rule a site writes can undo it. This does not
reopen the argument above, which is about what a site serves on its own pages:
these files are the deploy's, nothing in a browser reads them, and the deploy
fetches them from the origin directly. What the planner's refusal takes from a
site is small. On the default tree, `/manifest.json` was already the build's
own manifest, which `writeSite` (`build.ts`) writes last, over anything else at
that key, so a request for that address was answered with the manifest and
never with a page. `/.pagedeck/`, and `/manifest.json` on a domain tree, are paths a
site could have routed before, and they are given up so that the rule reads the
same in every tree.

**Amended by #665: the Worker answers a method it does not serve with `405`
and `Allow: GET, HEAD`, a header the site did not write.** `cloudflare-worker`
is the first target that answers every request itself, so it is the first that
has to refuse a `POST` or a `PUT`, and HTTP requires a `405` to name the methods
the resource takes. The field states what the Worker does, not a posture on the
site's behalf, and it travels with the site's own set: the `405` carries the
header rule the requested path matches, as every other response the Worker
writes does.

**Amended by #670: the Worker's `200` and `304` carry the R2 object's
`httpEtag` as `ETag`, a header the site did not write.** Like `Allow`, the
field states what the Worker does, not a posture on the site's behalf. The
object's value wins over a site rule naming `ETag`, because the Worker matches
`If-None-Match` against the object: a site's value would make every
revalidation a `200`, or, matched in its place, a stale `304`. The Worker sends
no `Last-Modified`.

### A build-time document is configured by a field of its own

The build writes files that are not pages: the per-locale sitemaps it already
emits, and the favicon (#297), the feed (#324) and the `robots.txt` (#325) that
come next. Spec §7's **Build-time documents** says what the class is and what
its members share; what is recorded here is how one is configured, because that
binds those three and the fourth nobody has filed. **Each build-time document is
its own `BuildSection` field, beside `sitemap`, and there is no registry to add
one to.**

Each is a build field for `sitemap`'s own reason — the value is read by the
pipeline, and the only place every page exists at once is inside a build — so
what is decided here is not where the fields live but whether there is a field
per build-time document or one field holding a list.

That registry is the alternative, and it fails on what the settings are. They
share their timing and nothing else: a feed needs a collection, the entry fields
an item is built from and the channel's own metadata; a `robots.txt` needs
directives and the sitemap it points at; an icon needs source bytes and the
sizes to emit them at. A registry's value type is the union of those three, or
it is opaque and every stage narrows it again, and either way a config load
stops being able to answer the question `routingFaultReport`
(`packages/core/src/routing.ts`) exists to answer — is each field the type the
pass will read it as. A separate field answers it with that field's own declared
type and costs nothing to state. It is also the split `speculation` and
`viewTransitions` already make two fields along, for that split's reason: two
features named in one sentence of the spec share the sentence and not a setting,
and a site that wants a feed has said nothing about whether it wants a crawl
policy.

What the registry would buy is a fourth build-time document arriving without a
config change, and that is the thing this repository does not want cheap. Each
of these is a stage that reads the whole route table and writes a file at an
address something other than a reader goes looking for, and what a site gets for
it is that file served under its own name for as long as the site is up. The
argument for one belongs in the issue that adds its field, as `sitemap`'s is in
#40. Ruled on #384, which builds none of the three.

**Borrowed by #382, and the borrowing is not a membership.** `build.preview`
(`packages/core/src/preview.ts`) is configured by this grammar — its own field,
checked at config load, absent by default — and is **not** a build-time
document. Spec §7's class is files at fixed addresses, derived from the whole
build, that something other than a reader goes looking for; a preview app is at
the address the *site* declared, is derived from the registry and the module map
rather than from the pages, and is opened by a person in an editor tab. It is
also an app rather than a document: a second bundler invocation whose output is
a graph of chunks, where every other member is a pure function over the staged
set. So spec §7's list is left at four, and the next optional stage is free to
reach through this seam without joining that class either. What decides
membership is those four properties, not the shape of the config.

### Preview is declared or absent, and every byte of it lives under one path

A site declares `build.preview: { path }` or it has no preview app. `path` is
required and has no default; a site that declares nothing emits nothing and its
`dist/` is byte for byte what it was before the field existed
(`preview.build.test.ts` compares two trees). Every file the field adds — the
document and every chunk — lands under that one path, and `pagedeck build` prints on
stdout what it published and that the app authenticates nothing.

The reason is what a preview app is. It renders arbitrary draft JSON posted to
it and authenticates none of it, by design: the preview reference page,
`packages/docs/content/reference/preview.md`, says so under **Security**, and
#54 scoped hardening past a bridge's origin allowlist out. So the failure to
design against is a production deploy shipping one unasked, and declared-or-absent makes that impossible by construction rather
than by an operator remembering. A fixed address on every build was the
alternative and would put an unauthenticated renderer at one well-known path on
every site this framework builds. A separate `dist-preview/` tree was the other
and would need a second deploy story, a second manifest and a second thing to
forget. What stands in front of the app is therefore whatever stands in front of
the site, and the framework provides none of it.

**One path rather than "somewhere in `dist/`" is the operable half.** A posture
nobody can act on is a note; a single prefix is something an operator puts a
password in front of and a reviewer sees appear in a diff. That is why the
preview bundle's assets go under `${path}/assets/` and not the site's own
`/assets/`, and why the two targets stay one invocation each — they are told
apart by address, so there is no filter to get wrong.

**Spec §14's "zero preview bytes in production output" is narrowed, not
dropped**, and §14 records the narrowing. It goes on holding absolutely for
every site that declares nothing, and for every site that declares the field it
holds where it was always aimed: no page's chunk holds a preview module, because
the two builds share no graph and no input map. `preview-build.test.ts` asserts
the module half where a graph exists to assert it of, against `chunk.modules`;
`preview.build.test.ts` asserts what a real `dist/` can answer now that the two
share one — nothing written outside the declared path carries the preview app's
mark. Ruled on #382, which is also where the
deployment posture #339 asked for was decided.

### A provider prop is digested one level down, and no prop opts out

`rootProviderStackDigest` (`packages/islands/src/root-provider-check.ts`) reads
a prop that is a plain object, a null-prototype object or an array one level in
and hashes the shape it finds; every other prop keeps exactly the tag it
carried before. The depth is fixed at one for every prop, and a site has no
field, no marker and no convention by which it excludes a prop of its own from
the walk.

The depth is what the decision is about. A bare `object` on both sides of the
wire let an object prop computed from an environment variable digest
identically however far the two environments had diverged, so #66's fifth
criterion held for primitive props and not for object ones. A walk that kept
going would read the state of a store a prop *holds*, and the build renders the
whole page through the stack before the digest is taken — that state has moved
by the time it is read, while the browser's is freshly loaded, and the site is
reported for a divergence it does not have.

Stopping at one level does not buy that away, it narrows it, and the ruling
took the remainder knowingly rather than trading it for an escape hatch: a
store passed as the prop itself, keeping a primitive on the object rather than
behind a closure or in a class, digests differently once its counter moves
during that render. A per-prop opt-out was the alternative and it was declined.
The prop a site would silence is the prop this check exists to compare, and a
field set once to stop a report is a field nobody revisits — the check would
then be quiet on the sites that had already seen it fire. What this binds is
the proposal that comes back, from either side: not a deeper walk, and not a
way out of the walk. Ruled on #255.

### A recorded corpus keeps the names it recorded

A recorded corpus was content from a source a build cannot reach, committed
here as a data module and replayed through the real loader. The CMS corpus and
its recorder were removed in #746.

The 2026-08-23 naming rule scrubbed this repository of employer, design-system
and CMS vendor names, and what it reached was what this repository *writes*:
package names, API names, documentation, an example site's config. It did not
reach what a recorded corpus *contained*. A recording of another site's
content, read at a named upstream commit, kept every name that content
carried, a vendor's or an employer's included, and those bytes stayed as
recorded.

The line is authorship, and it is the one **A site describes a vendor's code,
never core's** already draws a door along. A name this repository *chose* is
this repository recommending something, under the name of the framework. A name
this repository *recorded* is a fact about what a third party published, and
carries no recommendation whoever reads it. A recording is not this
repository's prose in the first place: its recorder must be its only author,
with a digest beside each source so that nobody edits it by hand — this rule
included.

Two alternatives were rejected on #328 and the reasons generalise. **Scrubbing
at record time** leaves the digest attesting our own transform rather than
upstream parity, and the loader stops reaching the corpus as written, which
#328's 2026-09-06 ruling asked for; "recorded verbatim" becomes "recorded and
rewritten" with nothing in the artifact saying so. **Dropping the affected
sources** makes the corpus a sample filtered by which vendor a document happens
to mention — a biased selection of exactly the content the recording exists to
render, against the "real content, not lorem ipsum" criterion it was built to
meet.

What this does not license is a name this repository picks, wherever it sits. A
vendor name reached `@pagedeck/markdown-loader` while #328 was in review and was
removed; that file is this repository's own writing, and being adjacent to a
recording does not make it one. Nor does it license recording something *in
order to* name it: what falls on the far side of this line is content that
exists independently of this repository and is read at a named commit, never
content composed here. A captured parity baseline, `baseline.json`, is on that
far side too, and is settled here rather than asked a third time. Ruled on
#328.

A URL a recorded site actually serves is on the recorded side of that line,
and quoting one in this repository's prose does not move it across. A sentence
may quote an address this repository requested and got an answer from, with a
vendor's name as its slug: that slug is not this repository referring to a
vendor, it is part of an address the site publishes, and all the sentence
asserts about it is that it answered.

What separates this from a picked name is that the name could not have been
another name. `@pagedeck/markdown-loader` named the same module whatever word stood
in it, which is what made the vendor word there a choice. Write such a sentence
with a different slug and it is either claiming an answer it never saw, or
waiting on somebody to re-request the new address from a server this
repository does not run.

That is a second test, and the entry carries two on purpose. The first — read
at a named commit, with a digest beside it — is how a corpus proves its own
fidelity, and it is a recording's mechanism rather than the definition of
recorded. There is nothing in a quoted address for it to attest: a commit pins
bytes at rest, and the sentence asserts what a running server answered. Its
absence is why a second test is needed, not an oversight. Both decide the same
question, which is whether the recorder had any latitude over the name. A
corpus answers by construction, the bytes being upstream's and its digest
saying so; a quoted live URL answers by what its own sentence claims, which
goes false the moment the slug changes. The clause barring content *composed
here* is met either way: the site composed the address, and this repository
quoted it.

What it does not extend to is the prose around the quote. A document about
another site is this repository's own writing, so the words it picks for itself
are bound exactly as `@pagedeck/markdown-loader`'s were, and a URL quoted for its
shape rather than for having been served is a choice again — write it with a
placeholder segment, as `/tags/<tag>/1` does. Ruled on #453.

A parity baseline captured from a live site is the same kind of recording. It
holds what the site served, verbatim, so its text names whatever the site's
content names, and an address in its sample is a URL that was requested and
answered, which is the second test above. The naming rule binds this
repository's code, docs and tracker; it does not reach the maintainer's own
published site as recorded, whether as a corpus or as a capture. Ruled on #331,
2026-09-28.

### Comments say only what the code cannot

A comment in `packages/**` or `.github/workflows/` is kept only when it is one
of three things:

- a tool directive: `// @ts-expect-error`, `// @ts-ignore`, a lint or coverage
  pragma, `/// <reference>`, a `#!` line;
- the version comment beside a SHA-pinned `uses:` in `.github/workflows/`,
  which **Third-party actions are pinned to commit SHAs** requires;
- a short *why*, one or two lines, where the code alone would lead a competent
  reader to "fix" it: a workaround for a named upstream bug, an ordering
  constraint that is not obvious, a deliberate deviation. It links the issue
  number rather than restating the history.

Everything else goes: a docblock that restates the signature or the code,
design history, an issue narrative, a cross-reference to another docblock, an
essay on why the code does not do something else, a section banner. An
exported API gets no docblock unless it says something its types cannot.

Decision history belongs in issues, in `docs/adr/` and in this file, never in
source. A doc does not defer to a source comment either: where a doc needs a
reason, it states the reason or names the issue or ADR that holds it. A comment
cannot fail, and a reason that lives only in a comment drifts from the code
beside it with nothing to say so.

It binds a file added tomorrow as much as the ones that exist today. At the
ruling, comments were 42% of the non-blank lines under `packages/**` and
`.github/workflows/` (88,753 lines), and the reduction is done package by
package in #632 to #637. Ruled on #631.

### Page output keeps the `fw` prefix

The rename to **Pagedeck** (#651) stops at page output: the HTML, CSS and
JavaScript a page ships. #651 named what it keeps: the `fw-island` element, the
`data-fw-*` attributes and the shared brand's `fw-` CSS classes. Renaming them
would move every byte budget and every figure measured on emitted bytes, and a
page deployed before the rename would no longer hydrate against a runtime
deployed after it.

The same reason keeps the rest of the `fw` names a page ships, which #651 did
not list: the other custom elements (`fw-slot`, `fw-region`), the `--fw-*`
custom properties, the `fw-core` and `fw-mid` chunks, the `fw:consent` event
and the `fwConsent` global, the consent banner's `fw-consent` storage key, the
`fw.shared-store` symbol, the `fw:islands` HMR event and the preview's `fw-`
ids.

What a developer types or reads is renamed: the packages, the CLI, the config
file, the environment variables and the working directory. The origin's deploy
keys (`/.pagedeck/manifests/`, a **Reserved deploy key**) and the edge
artifacts that refuse them were renamed too, on purpose: no origin had been
deployed when the rename landed, so there was no deployed history to keep
reading. A later issue can rename the page-output prefix if the maintainer asks
for it. Ruled on #651.

### An example runs in process, and a contract it cannot show is listed

`packages/examples/src/examples.test.ts` compiles each example and runs it in
the test process: it calls an exported function and asserts what it returned.
It starts no bundler, mounts no DOM and makes no request. Spec §14b asks for an
example per public contract, and a contract gets one only when that harness can
show the thing a reader gets wrong about it.

A contract is listed in `packages/examples/README.md`, not given an example,
when it is one of these:

- a claim about a build's output, about two builds, about a browser or about
  the network;
- a type, which has no call to be an example of;
- a constant, where an example would only test the constant;
- a config field whose content is a refusal at config load, which
  `a-broken-entry.ts` already shows for another field;
- a function the site supplies (an adapter, a probe, a compiler), where an
  example would have to pass a fake one and assert that its own input came
  back.

An example that feeds a contract hand-written input and asserts the echo is
refused for the same reason: it stays green whatever the contract does (#270).
A listed contract is executed by a test that can make its claim, usually a
`*.build.test.ts`, and its reference page under
`packages/docs/content/reference/` carries the config the example would have
shown. It moves into `packages/examples` when the harness gains what it lacked:
a build, a DOM or a second build.

A contract that has an example changes together with its example. Ruled on #77.

## Considered and not recorded here

These rulings were read in the same pass and judged per-issue. A ruling is
recorded above when the holding itself governs how later issues are decided.
A ruling whose *reasoning* generalises, but whose holding settles one issue's
design, belongs here.

- **#125 — one throw, not two.** Refusals of non-island prop names join the
  existing pre-pass so a page reports both classes at once. It explicitly
  leaves `docs/error-messages.md` rule 5 unchanged, so it decides nothing
  outside that render path.
- **#101 — `PlacedLocale` carries its code.** A shape choice for one type,
  landed in code, with the invariant it creates local to that map.
- **#161 — a default `route` that splits a nested CMS slug.** An API choice
  for one open issue: the reason it gives generalises (docs do not stop a trap
  that type-checks), but the holding is about `fromCollection`'s signature and
  nothing else.
- **#268 — a dev server bound beyond loopback announces its exposure.** Under
  `pagedeck dev --host <addr>`, a non-loopback bind prints what it exposed, and a
  wildcard bind also prints an address a reader can reach it at; a bare
  `pagedeck dev` prints what it always printed. The reasoning generalises — state a
  consequence where the person who caused it is looking, rather than only in a
  docblock they are not reading — but the holding is #161's kind: it settles one
  flag on one verb, and that issue's own out-of-scope list forecloses `--host`
  anywhere else, so there is no second surface for it to govern.
- **#158 — spike first.** Process for that issue's implementation only.
- **#92 — install browser tooling, but prove the harness first.** Sequencing
  within one issue.
- **#142 — validate on write.** Standing, but recorded in ADR-0004 rather
  than duplicated here; a decision written twice drifts.
- **#31 — a broken internal reference refuses, an external one can only
  warn.** The reasoning generalises and is already written down: it is
  `docs/error-messages.md` rule 7's question, does the fault come right on a
  retry, which the standing CSS decision above already names as what "a third
  door of this kind is measured against". A host's 503 comes right on a retry
  and a misspelled href does not, so the split is that rule applied rather than
  a new one. Recording it again is the duplication #142 declines.
- **#31 — the link check reads the documents it is handed.** `LinkCheckInput`
  takes the documents a pass reads separately from the set it resolves against,
  so a full build passes every page and an incremental build could pass its
  re-rendered ones. That is a shape choice for one input type, #101's kind,
  and the seam is `LinkCheckInput` in `packages/core/src/links.ts`. #281 built
  the incremental build and did not take the narrowing — a carried page is an
  ordinary emitted file by the time that stage runs, so the check reads the
  whole route table on every kind of build — which turns "no build passes a
  subset" from an absence into a decision.
- **#22 — detection, replaced by declaration.** The first two rulings above
  arrived as maintainer rulings on 2026-08-30, part-way through the branch, and
  what they superseded is worth knowing so nobody proposes it again as
  unexplored. `047ffc7` got the shared layer into the core tier by *detecting* a
  named CSS toolkit: it resolved that toolkit's Vite plugin from the site by
  package name, and decided which stylesheet was the shared layer by scanning
  transformed source for the toolkit's own `@import`. It worked and it is
  rejected — a framework source that names a CSS solution is not agnostic to
  one, however narrowly the name is used. `a3f8a95` replaced it with the site
  declaring both (`build.css`, `build.vite.plugins`), and `6be07c7` added the
  refusal that the `<head>` ownership ruling makes enforceable.
- **#42 — speculation reads a declared relation, not a dependency.** The
  holding is one module's input and the term it claims is recorded above as
  **Page relation**, so what belongs here is only the provenance: joining
  `Page.dependencies` was built first, measured, and rejected, and it is worth
  knowing so nobody proposes it again as unexplored. `88bf71c` joined
  `dependencies` because both are `EntryRef` lists and the graph looked like
  one graph; `f7b0d6d` replaced the input with `relatesTo`/`Page.relations`
  after the measurement in the glossary entry showed the join emitting rules
  for pages whose sources had asked for none. The reasoning generalises the way
  #161's does — a field's *definition* is its contract, and a second consumer
  asking a different question declares its own input rather than borrowing one
  whose definition it does not match — but the holding settles this issue's
  design and nothing else.
- **#281 — criterion 3 does not hold over a removal, and tier pinning is
  why.** An incremental build that lost a page writes a manifest whose
  `tiers.pageCount` still counts it, because spec §11 pins tier assignments
  between full builds and `pageCount` is the denominator those assignments'
  `pageShare` values were computed from. Recomputing the denominator while
  keeping the assignments would produce a manifest whose own numbers no longer
  follow from each other, which is a worse artifact than a knowingly stale one,
  and it was rejected on that ground rather than on effort. So the issue's
  criterion 3 reads "the `build` stamp **and the pinned tier plan** excepted",
  and `incremental-verb.build.test.ts` asserts the divergence explicitly rather
  than filtering it out — if a later change ever makes the two agree, that test
  fails and says so. Recorded here and not above because the holding amends one
  issue's acceptance criterion: what generalises is already spec §11's pinning,
  which is where a later reader should go. **A maintainer ruling was asked for
  on the issue and none had arrived when this landed**; if it goes the other
  way, the consistent alternative is re-planning tiers on any build whose page
  set changed, which trades away spec §11's chunk stability.

  **Amended by #304 (ruling of 2026-09-24): the removal redirects are the
  second exception.** Spec §11 has a removed page redirect, and an incremental
  build now does: `stageSite` hands `IncrementalPlan.redirects` to
  `planRouting` as `RoutingInput.removals`, the only path those records take,
  so the routing document in the manifest holds a `deleted-page` row from the
  removed page's output to its nearest live ancestor, and every edge adapter
  compiles it like any other. A full build has no removals, so
  its document is unchanged. Criterion 3 therefore reads: an incremental
  build's manifest equals a full build's of the same store, excepting the
  `build` stamp, the pinned tier plan, and the routing document's redirect rows
  that come from removals. The two removal comparisons in
  `incremental-verb.build.test.ts` ("an incremental build over a removal emits
  the files a full build emits" and its broken-relation sibling) assert that
  third divergence explicitly, as the full build's document plus the expected
  rows.

  **The residual, known and not fixed: a removal redirect lives only in the
  build that removed the page.** The next build, full or incremental, plans
  from a manifest that no longer lists the page, has no removal to redirect,
  and drops the row, after which the old URL gets whatever the host serves for
  a missing path. The link check shows the same edge: a surviving link to the
  removed page is a redirect warning on the incremental build that removed it,
  and a broken-reference refusal on the next build of either kind. Carrying the
  rows forward is the manifest-as-history option the ruling passed over, not a
  gap in this one.
- **#36 — the publication window is half-open.** Published from `publishField`
  inclusive until `unpublishField` exclusive, which decides what an author's
  handover looks like and what `publicationChanges` counts as one change. The
  holding does bind every later schedule-aware consumer, so it would belong in
  Standing decisions — except that it is the *definition* of a term, and it is
  recorded above as **Publication window**, where a definition belongs and
  where the three guarantees it carries are stated together. Noted here only so
  a reader who looks for it in this section finds the pointer rather than a
  second copy, which is the duplication #142's bullet warns about.
- **#338 — the origin allowlist is checked and `event.source` is not.** A
  security sweep asked the CMS preview bridge, removed in #746, to compare the
  sender window as well as the origin; the ruling was to add no such option, because the origin
  check is the whole of the boundary. `event.origin` is the browser's to write,
  so a message that passes the comparison came from script on a listed editor
  origin, and that script already owns the window an `event.source` check
  would compare against. The reasoning generalises the way #161's
  does — a second door that refuses nobody the first admits is cost without a
  boundary — but the holding settles one listener on one
  transport, where the framework is the embeddee and posts nothing back, so it
  decides nothing about any later message door of a different shape.
- **#351 — the spec describes the render the code performs, not a worker
  pool.** §16 said page rendering "runs as a parallel pure function across
  workers from day one" while `renderAll` renders sequentially: a render is
  CPU work behind React's own scheduler, the seam refuses build-time IO, and a
  failing page names itself in the order a reader is reading.
  The ruling of 2026-09-06 fixed the sentence rather than building the pool, and
  §16 now states the property that is true — a pure function that can fan out —
  beside the measurement that makes the sequential choice a decision:
  ~1 ms/page, linear from 2,000 pages to 50,000, in
  `docs/scaling-verification.md`. Recorded here and not above because the
  holding is one document line. What belongs here is the provenance, the
  way #22's and #42's bullets carry theirs: the pool was the issue's other
  branch and was declined on the measurement, so nobody proposes it again as
  unexplored — and the decline is not permanent, because it rests on a figure a
  later ladder could move.
