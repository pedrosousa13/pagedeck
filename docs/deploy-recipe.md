---
description: How the dogfood site deploys through presigned uploads and the landing and docs sites through wrangler, with dry runs, rollbacks and proofs.
---

# Deploy recipe

How the dogfood site (`packages/site`) is deployed: the verbs in order, what the
one secret is, what a dry run does, how to roll back, and what the grace period
protects. Issue #57. The landing page and the docs site are deployed to
Cloudflare as Workers Static Assets with wrangler, not through this CLI. Their
runbooks are the last two sections, "The landing page on Cloudflare" and "The
docs site on Cloudflare".

## What has been proven, and what has not

**Nothing here has been run against a real distribution, and nothing here has
touched a cloud account.** No CDN, no bucket, no DNS record and no credential
exists in this repository. What has run is the presigned half of the pipeline
against an S3 implementation, locally, with a credential minted for one run and
thrown away. Read this as a pipeline whose uploads are proven and whose serving
is not:

- The **deploy CLI against a presigned origin, and the snapshot transport**,
  are what `pnpm test:origin-harness` (`packages/site/src/origin.harness.ts`,
  #302) proves against a real S3 origin: SeaweedFS 4.47's S3 gateway
  (`chrislusf/seaweedfs:4.47`, pinned by digest). It first passed on
  2026-09-28, and first passed through the spawned CLI on 2026-10-02 (#652).
  The harness starts the origin in Docker, over TLS, at a fixed address on an
  internal bridge network it creates. It signs real SigV4 URLs and runs the
  shipped `deploy.bin.js` as a child process, through both passes of
  "Deploying to a presigned origin" below. `pagedeck store push` and `pull` run
  through `runCli`. A passing run asserts that:
  - every uploaded object reads back **byte-identical** to the file the build
    wrote;
  - a second deploy reads the live `manifest.json` off the origin with a signed
    GET, and puts only the files whose hash changed, the build's history copy,
    its deploy instant, the history index and the manifest;
  - a rollback reads the live manifest and the retained one off the origin's
    deploy history with signed GETs, and leaves the origin serving the first
    build's manifest and bytes;
  - no access key, secret key or signed query string appears in the CLI's argv,
    stdout or stderr, on every run above and on the failures below;
  - an origin error is the origin's real 403, to a PUT and to a GET, and the
    run exits 1;
  - an `http:` URL and a URL on `127.0.0.1` are refused with exit 2 before any
    request, and the origin still serves what it served before;
  - a presigned `DELETE` takes an object from 200 to 404, through
    `presignedTarget` directly;
  - a PUT URL signed by `presignRequests` for one type, one cache policy and
    one MD5 refuses another `Content-Type` or `Cache-Control` (403
    `SignatureDoesNotMatch`), other bytes under
    the signed `Content-MD5` (400 `BadDigest`), other bytes under their own
    MD5 or with no MD5 (403), and the object keeps its type, cache policy and
    bytes (#60);
  - three builds deployed to a bucket and to a directory origin, then pruned
    with `--prune` on each, lose the same files: a page the second build
    dropped, and a passthrough file it dropped once its grace was backdated
    past. A file the third build dropped stays inside its grace on both, every
    document in the deploy history stays, and the live build reads back
    byte-identical (#659). The prune reads the history index and each document
    it names with signed GETs, and sends each DELETE to the URL signed for its
    key;
  - with the history index removed, the same `--prune` run deletes nothing,
    says why, and the apply writes a new index;
  - an index naming builds beside no `/manifest.json` is refused as a damaged
    origin, exit 2, before anything is planned;
  - `pagedeck store push` then `pull` round-trips the store byte-identical, and the
    target it prints carries **no query string**;
  - the loopback refusal still fires, with its full message, on the same URL
    pointed at `127.0.0.1`.

  It skips with a stated reason where there is no Docker daemon, and `pnpm
  test` does not run it. `AGENTS.md`, "The origin harness", says how to run it.
  One S3 implementation passing is not every S3 origin passing: neither AWS S3
  nor Cloudflare R2 has been sent a request.
- **It is not a CI service container, and cannot be one.** A service container
  is reached on `localhost`, which is the case the snapshot host refusal blocks
  with no override (`CONTEXT.md`), so the deploy half would pass and
  `pagedeck store push` would be refused. The harness creates, fills and starts a
  SeaweedFS container itself (`docker create`, `docker cp`, `docker start`) on a
  user-defined network with a private address instead, which the refusal does
  not name.
- The **planner, the uploader seam and the rollback** are exercised end to end,
  locally: `packages/site/src/deploy.build.test.ts` builds a fixture site twice
  with one page's content edited between the builds, deploys into a directory
  standing in for the origin, serves it back over a `node:http` server bound to
  `127.0.0.1`, and rolls back to the retained build through the same seam.
- The **`--edge` compile** produces text and is asserted as text. A spawned dry
  run in the build test names every out-of-band artifact and writes none of
  them.
- The **edge artifacts** are asserted as compiled text and never as a live
  distribution — the standing decision that edge artifacts are emitted, not
  provisioned. **SeaweedFS is not CloudFront**: the edge function, cache
  behaviours, invalidation and propagation are unproven, and
  `--edge cloudfront-function` compiles text that nothing here executes.
  `--edge cloudflare-worker` is the exception: its `worker.js` is run in
  `node:vm` against a stand-in for its R2 binding, by `pnpm test` and by the
  origin harness over what a deploy put into SeaweedFS. The Workers runtime has
  not run it. Nothing in this repository creates a CDN or cloud resource,
  except that `deploy-landing.yml` and `deploy-docs.yml` publish the landing
  page and the docs site with `wrangler deploy` (below).
- **`.github/workflows/deploy.yml` has never deployed anything**, and cannot
  until a maintainer adds the secret below and passes `apply: true`. It is
  `workflow_dispatch` and `repository_dispatch` only; it is never `on: push`.
  It still passes `--origin` a directory. Moving it to a presigned origin needs
  a signing step that holds the credentials, and this repository has none.
- **`.github/workflows/deploy-landing.yml` has never deployed anything**
  either. It publishes only with `apply: true` and the two `CLOUDFLARE_*`
  secrets set, and has run only as `wrangler deploy --dry-run`, locally, which
  sends nothing to Cloudflare. It does not use `deploy.bin.js` or the signing
  step, `presign.bin.js`, which the origin harness proves in region `auto`.
- **`.github/workflows/deploy-docs.yml` has never deployed anything**, on the
  same terms: `apply: true` and the two secrets, and a local `wrangler deploy
  --dry-run` only.
- The **deferred prune** reads the history back off a directory origin by
  listing it, and off a presigned origin through the history index (#659,
  below). `packages/site/src/deploy.test.ts` pins the arithmetic —
  three builds, a fresh runner each time, and the third deploy really deleting
  what the first left behind — and `deploy.build.test.ts` pins that the runnable
  files a real build's own document at the origin and that the retention
  store's reader opens it there. The origin harness runs the prune end to end
  against a real S3 origin, and compares what it deletes with a directory
  origin given the same history. Nothing lists the bucket.
- Spec §11's "publish in under 60 s" is a figure about a staging distribution.
  The build test measures the local publish and **prints** it rather than
  asserting on it, and so does the origin harness. Its figures are a round trip
  over a local bridge, not publish-to-live, so they do not settle #295.

## The secret

One secret, `PAGEDECK_SNAPSHOT_URL`, and it is **a presigned `https:` URL** — not an
AWS access key, not a role to assume, not a credential chain. The transport
uses no SDK: a presigned S3 URL *is* an HTTPS GET and PUT, so an SDK would buy
nothing but a dependency and a set of credentials on the runner. Whoever holds
the real credentials signs a URL and stores the URL.

Two consequences worth knowing before storing one:

- **Never name it on a command line.** `pagedeck store pull` and `pagedeck store push` read
  `PAGEDECK_SNAPSHOT_URL` when the command line names no URL, and that is the whole
  protection: an argument is in `/proc/<pid>/cmdline`, which is world-readable on
  a shared runner, and in the `run:` line CI echoes. Writing
  `pagedeck store pull "$PAGEDECK_SNAPSHOT_URL"` gets no benefit at all — the shell expands
  it before `pagedeck` starts. Giving both the variable and an argument is refused
  rather than ranked.
- **A presigned URL carries its credential in the query string.** No message in
  the deploy path prints one, and CI secret masking will not save you if one is
  composed at run time rather than stored.

Loopback and link-local targets are refused with no override, so a job that runs
its object store as a service container on `localhost` cannot push.

**In the workflow the secret is declared on three steps and nowhere else** — the
gate, the snapshot pull and the snapshot push. A job-level `env:` is exported to
every step of the job, which would have handed a write credential for the
content store to `actions/checkout`, `pnpm/action-setup`, `actions/setup-node`,
`actions/upload-artifact` and `pnpm install --frozen-lockfile` — that is, to
every dependency lifecycle script in the workspace. That exposure is what
`CONTEXT.md`'s **Third-party actions are pinned to commit SHAs** guards, and
pinning an action does not help against a package.

## The pipeline, verb by verb

Run from `packages/site`, where `pagedeck.config.ts` is:

```sh
# 1. the content store, from the snapshot the secret points at
node ../core/dist/bin.js store pull

# 2. render, bundle and write the whole site into ./site
node ../core/dist/bin.js build

# 3. the plan: what would be uploaded, in what order, and what would be pruned
#    <live-manifest.json> is <origin>/manifest.json, which the last deploy published
node ../core/dist/bin.js diff <live-manifest.json> site/manifest.json

# 4. the same plan, carried out — see "Dry run and --apply" below.
#    No --from: the runnable reads <origin>/manifest.json for itself
node dist/deploy.bin.js --origin <dir> --staging <dir> \
  --edge cloudfront-function

# 5. the store, back to where it came from, so the next run starts here
node ../core/dist/bin.js store push
```

Step 3 and step 4 read the same function: `deploy.bin.js` calls `diffManifests`
and recomputes nothing, so the document `pagedeck diff` printed and the plan the
deploy carries out are the same rows in the same order. Step 3 exists because a
person should be able to read the plan before anyone authorizes step 4.

**`--edge <target>` is what compiles the routing document**, and omitting it is
what leaves the plan with no edge group at all. It is a flag rather than a
config field because the host is not a property of the site: `build.routing` is
one declaration and an edge adapter compiles it for whichever host is serving it.
The targets are the names of the four adapters the deploy depends on,
`cloudfront-function`, `netlify`, `nginx` and `cloudflare-worker`; an unknown
one is refused with the list in the message.

**Which build is live is read off the origin.** `applyPlan` publishes
`manifest.json` with the site, last of all the keys it puts, so
`<origin>/manifest.json` *is* the previous build's document and `deploy.bin.js`
reads it back. Omit `--from` and that is what the plan diffs against; an origin
holding no manifest and no deploy history is a first deploy, which is what an
origin nothing has deployed to actually is.

**An origin with a deploy history and no manifest is refused** (#561). Every
document under `<origin>/.pagedeck/manifests/` is a build an apply published before
it put `manifest.json`, so a history with no manifest beside it, or with a
dangling link in its place, is an origin that lost its manifest. Planned as a
first deploy, the prune would not know which build was live and could delete
the files it serves with no grace, so the run exits 2 before it plans, dry run
included, and uploads, deletes and prunes nothing. The refusal names the build
to put back: the one whose `<build id>.deployed-at` holds the newest instant,
since every apply writes one, rollbacks included. Copy its
`<origin>/.pagedeck/manifests/<build id>.json` to `<origin>/manifest.json` (the bytes
are the same), or pass `--from` that file for this run. When an instant there
cannot be read, the refusal names no build; copy the history file the last
apply's `Filed this build into the origin's deploy history at …` line names
instead. The next
apply publishes `manifest.json` again either way.

That is what makes the webhook path incremental. `repository_dispatch` carries
no `inputs`, so while the previous manifest could only arrive as an operator
input, every run on the trigger content editing actually uses planned a first
deploy — every file. `--from` is now an override rather than the only source,
for the cases the origin cannot answer: an origin this process cannot read, or a
deliberate re-deploy over an older build.

**`--from` twice, or `--from` beside `--rollback`, is refused rather than
ranked.** A repeated option used to take the last value in silence and a
`--from` beside a rollback was dropped in silence; both now name both values and
exit 2. A rollback's left-hand side is the live build read from `--out`, so
there is no second source for that side to rank against.

**Which build is live is also what `pagedeck diff` refuses on.** A build that was not
based on the build it is deploying over is a raced deploy. `pagedeck diff` reports it
and exits 2 rather than printing a document a pipeline would act on, and
`deploy.bin.js` now does the same on the writing path: the plan carries the
report, a dry run prints it as a `RACED:` line, and `--apply` refuses to upload
unless `--force` is passed beside it. `pagedeck rollback` has no such flag and neither
does a rollback plan, because a rollback is out of order by definition.

**A forced `pagedeck diff` says so on the document it writes.** `pagedeck diff --force`
prints `"forced": true` as the document's second key, straight after `version`;
every other `pagedeck diff`, and every `pagedeck rollback`, omits the key rather than
writing `false`. Nothing else in the document moves — the plan a forced run
prints is the plan the same pair of manifests would have produced anyway, and
`DIFF_VERSION` stays at 1, so a recipe reading `from`, `to`, `trees` and `stats`
reads exactly the keys it always did. It is there for the pipeline that archives
its diffs: the two manifests say which builds were compared and nothing at all
about which flags the run was given, so after an incident this key is the only
record that the raced-deploy check was skipped rather than passed.

**Reading an archive that predates this release: absence means "unforced *or*
older than this".** Every diff written before the key existed omits it, forced
or not, and there is nothing in the document that separates the two — the
version did not move, for the reason above. So a pipeline that has archived
diffs across the upgrade should read a missing `forced` as "no override
recorded" rather than as "no override happened", and date the boundary from the
release it upgraded on.

## What `pagedeck build` writes outside the output tree

Step 2 above writes the site into `./site`, and that directory is what a deploy
publishes. Two things a build produces are deliberately **not** in it, and both
are anchored at the site directory — the one holding `pagedeck.config.ts` — rather
than at `outDir`:

- **`.pagedeck/manifests/`** — the retention store (#32), read back by `pagedeck rollback`.
  Its size grows with `build.retention.keep`. A deploy does **not** publish it:
  what reaches the origin is one document per apply, the manifest of the build
  that apply published, with a one-line file beside it holding the instant it
  was deployed. The origin's copy is bounded by nothing (#287, #403, and
  "The grace period" below).
- **`.pagedeck/budget-report.json`** — the per-page size report (#21, #336), written
  by any build that declares `build.budget` or `build.criticalCss`, including a
  build that fails on a breach.

**The placement is about the second kind of deploy, not the first.** The
pipeline above is manifest-driven: `pagedeck diff` and `deploy.bin.js` upload the rows
in `Manifest.files`, plus `manifest.json`, a second copy of it under
`.pagedeck/manifests/` and the instant that copy was deployed, so a file outside
those lists is never sent no matter where it sits on disk. Nothing reads this
site's `.pagedeck/` directory to decide what to upload — the second copy is the
document the deploy already holds, filed under a second key — so the budget
report beside it is not on the list and cannot be. A directory-sync host —
Netlify or Vercel with a publish directory, or
`aws s3 sync site/` — reads no manifest and copies the tree, so for that host
the filesystem *is* the upload list. The budget report names the build id, the
build time, every budgeted page's limit and spend, and every emitted chunk's
path and size; inside `outDir` it answered `GET /budget-report.json` for anyone.
Under `.pagedeck/` there is nothing for either deploy to exclude — for the layout step
2 above sets up, and for every site in this repo: `outDir` inside the site
directory.

That premise is the whole of the guarantee, so it is worth stating rather than
implying. `build.outDir` is yours to point anywhere; the build checks only that
it is a string. A site that aims it at the site directory itself, or at an
ancestor of it, puts `.pagedeck/` back inside the tree a directory-sync host copies.
Nothing in the framework refuses that layout — a site publishing its own source
directory is already publishing `pagedeck.config.ts` — so read the placement as what
it is: the report is outside the directory you publish, not outside every
directory you could name.

**A full build removes what the previous build wrote and this one did not**
(#515), which is what lets a directory-sync host drop a retracted page. Such a
host publishes whatever is in the tree, so a post set to `draft: true` or
deleted since the last build would stay at its old URL for as long as its file
stayed in `outDir`. `pagedeck build` reads the `manifest.json` already in `outDir`,
writes its files and its own manifest, and then deletes every file the old
manifest named and the new one does not: the same prune
`pagedeck build --incremental` makes. A file you put in `outDir` by hand is in no
manifest and is never deleted, and a directory the prune empties is left in
place. The host still has to delete on its side: `aws s3 sync` removes a file
from the bucket only when you pass `--delete`.

**A manifest-driven deploy retracts a page only when it runs with `--prune`**
(#555). It never uploads the page again, but the copy the previous deploy put
at the origin stays there until a prune deletes it. With `--prune`, that
happens in the same run, because a page has no grace period ("The grace
period" below). Without it, the page is served at its old URL until a later
deploy passes `--prune`. A CDN in front of the origin can serve its cached copy
for as long as its own TTL after that.

The prune needs a manifest this `pagedeck` can read and trust. After an upgrade that
changed the manifest version, or over a `manifest.json` edited by hand, the
build still succeeds but deletes nothing, and writes a warning that starts
`Output "<outDir>":`. Before a directory-sync deploy of that tree, delete the
stale pages yourself, or point `build.outDir` at a new, empty directory and
build again. Do not empty `outDir` blindly: nothing stops it being the site
directory or one above it. A manifest-driven deploy has nothing to do, because
it never uploads a file the manifest does not name.

`.pagedeck/` is one directory a site's `.gitignore` names once, which is why both live
under it rather than taking a top-level entry each. Neither is derived from the
other and neither is site content, so a CI job that wants to keep them keeps
them as build artifacts.

## Dry run and `--apply`

**A dry run is what you get.** `deploy.bin.js` prints the plan and writes
nothing unless `--apply` is on the command line, and there is no config field
and no environment variable that changes that. The reasoning is the snapshot
host refusal's: a switch a CI file can set by accident is a switch that deploys
by accident.

```sh
node dist/deploy.bin.js --origin ../../.origin                    # prints the plan
node dist/deploy.bin.js --origin ../../.origin --apply            # writes it
node dist/deploy.bin.js --origin ../../.origin --apply --prune    # and deletes
node dist/deploy.bin.js --origin ../../.origin --apply --force    # over a race
```

**`--prune` and `--force` are not second ways out of the dry run.** Neither
moves a byte without `--apply` beside it: `--prune` asks for the delete pass
that spec §11 puts after the grace period, and `--force` only lifts the
raced-deploy refusal. The count of switches that can deploy by accident stays at
zero.

**The exit code comes from the class** (`docs/error-messages.md` rule 7). A bad
command line, an unreadable manifest, an unsupported `--edge` target and a
refused raced deploy are `ConfigError` and exit **2**, which promises CI that
retrying will not help. Everything else — an I/O failure reading the build's
bytes, an HTTP failure from a presigned target — exits **1**, where a retry may.
`@pagedeck/site` depends on `@pagedeck/core`, so both the class and `EXIT_CODES` are
imported rather than spelled as numbers.

**The runnable is `node dist/deploy.bin.js` and nothing else.** There is no
`pnpm deploy`: no `packages/*/package.json` in this workspace carries a
`scripts` field — the root holds every runnable — and the name would collide
with pnpm's own `pnpm deploy` besides. The workflow and this recipe invoke the
file directly.

The plan names every file rather than counting them, because the question it
answers is "is that the file I changed" — and it leads with the counts and the
byte totals, so a deploy that is unexpectedly the whole site is visible in the
first line.

**`--origin` is a directory.** A presigned origin is not a second spelling of
`--origin`: it is `PAGEDECK_DEPLOY_URLS`, a file of presigned URLs, described in
the next section. Giving both is refused rather than ranked, and exits 2.

**What the workflow adds is two locks, not a third mode.**
`.github/workflows/deploy.yml` guards every writing step on `apply: true` *and*
on `PAGEDECK_SNAPSHOT_URL` being set. With no secret configured — this repository's
state — a run pulls nothing, syncs the site's own entries instead, builds, prints
the plan, uploads it as a build artifact and finishes green. A `repository_dispatch`
run (the CMS webhook) never reaches the writing steps at all, whatever its
payload says: `inputs` is empty on that event, and the guards test `inputs`.

## Deploying to a presigned origin

`deploy.bin.js` deploys to a bucket through presigned URLs, one per object and
per method, minted by the operator's own signing step (#652). It holds no
credential, uses no SDK and knows no provider. Any host that answers an S3-style
presigned GET and PUT is a target, and a prune also sends a presigned DELETE.

**The URLs arrive in a file, and the file's path in `PAGEDECK_DEPLOY_URLS`.** Not
on the command line: an argument is in `/proc/<pid>/cmdline` and in the `run:`
line CI echoes, the reason `pagedeck store` reads `PAGEDECK_SNAPSHOT_URL` (see "The
secret"). Not the JSON itself in the variable: a site of a few hundred files
passes Linux's 128 KB limit on one environment string. The file is keyed by
deploy key:

```json
{
  "get": { "/manifest.json": "https://…", "/.pagedeck/deploy-history.json": "https://…" },
  "put": { "/index.html": "https://…", "/manifest.json": "https://…" },
  "delete": { "/old/index.html": "https://…" }
}
```

`delete` is there only for a run with `--prune` ("Pruning a presigned origin"
below).

**Signing takes two passes, because the keys are not known until the build.** A
content-hashed asset is named by its bytes, and which keys a deploy writes
depends on what is live.

1. Sign a GET for `/manifest.json` and one for `/.pagedeck/deploy-history.json`,
   the two keys every run reads, and write them to the file. A rollback also
   reads `/.pagedeck/manifests/<build-id>.json`, so sign a GET for that too.
2. Run the dry run with `--requests <file>`. It plans against the live
   manifest it read and writes every request an apply would send, in the same
   shape: each GET key, each PUT key with the `contentType` and
   `cacheControl` the PUT will carry and the base64 `contentMd5` of its body,
   and with `--prune` each DELETE key. The deploy instant has no
   `contentMd5`: its bytes are the time of the apply. "What a signed PUT
   binds" below says what the signer does with them.
3. Sign every request in that file, write the URLs over the same keys, and run
   `--apply` with `PAGEDECK_DEPLOY_URLS` pointing at the result.

```sh
PAGEDECK_DEPLOY_URLS=reads.json  node dist/deploy.bin.js --requests requests.json
# sign every key in requests.json into signed.json
PAGEDECK_DEPLOY_URLS=signed.json node dist/deploy.bin.js --apply
```

If the live manifest changes between the passes, the apply plans different
keys, finds no URL for some of them, and is refused before it sends anything.
Run both passes again.

**What is refused, before any request.** The file is read and checked
whole before the first GET, and every fault is listed at once, by method and
key, never by URL:

- a URL that is not `https:`;
- a URL with a user name or password before its host, which `fetch` would
  refuse with a message quoting the URL whole;
- a URL on a loopback or link-local host, the snapshot host refusal's named
  cases (`localAddressKind`, `packages/core/src/snapshot.ts`). A private
  address passes, as it does for a snapshot;
- a URL whose decoded path does not end in the key it is listed under;
- a URL whose host, or whose path before the key, differs from the other URLs
  in the file. A URL signed for `/en/index.html` also ends in `/index.html`,
  and this is what tells the two apart;
- a field other than `get`, `put` and `delete`, a key not starting with `/`,
  a key with a `.`, `..` or empty segment, a backslash or a control
  character, and a value that is not a string. `readManifest` refuses a
  manifest whose file row spells such a key, and so does the signer, so no deploy or prune, on either
  kind of origin, acts on a key that resolves to another one;
- a `delete` URL for `/manifest.json`, or for `/.pagedeck` or any key under
  it. The prune deletes only files a build served, never a key the deploy
  writes for itself.

An apply then plans, and is refused before the first PUT if any key it writes,
or any key its prune deletes, has no URL. Each PUT and each DELETE goes to the
URL listed for its key and to no other. A malformed file is refused without the
JSON parser's message, because that message quotes the file.

**`--requests` is for a dry run against a presigned origin only.** Beside `--apply`, or
with `--origin`, it is refused, and so is a `--requests` naming the file
`PAGEDECK_DEPLOY_URLS` names, by its path or through a link, which the dry run
would write over.

**Which build is live is read with a signed GET.** A 404 on `/manifest.json` is
a first deploy, unless the history index names a build: then the origin lost
its manifest, and the run is refused before it plans, as #561 refuses a
directory origin. Put the document of the build the origin last served back at
`/manifest.json`, or pass `--from` a copy of it. That build is the one whose
`.deployed-at` holds the newest instant. Any other failure is an error, exit 1,
and names the key. `--from` still overrides the read.

**No URL is in any message.** A presigned URL carries its
credential in the query string, so every message names the deploy key, and the
success lines say `presigned https target`. A key or field the file holds is
quoted through `redactTarget`, so a map written backwards does not print the
URL standing where a key belongs. A request that fails keeps its cause, with
the URL and its query string cut from every message in the chain.

### Pruning a presigned origin

**A presigned origin cannot be listed, so the deploy keeps its own list** (#659).
Per-object presigned URLs cannot list a prefix, and Cloudflare R2 presigns
GET, HEAD, PUT and DELETE only, with no list operation. So every apply, to any
origin and rollbacks included, also puts the **history index**,
`/.pagedeck/deploy-history.json`:

```json
{"builds":["<build id>","<build id>"]}
```

It names every build in the origin's deploy history and the build the apply
deploys, sorted. It goes after the build's deploy instant and before
`manifest.json`, so it never names a build whose document is not up yet. When
each build was deployed is not in it: that is the build's `.deployed-at` file
("The grace period" below), and the prune reads that file, as a directory prune
does. On a directory origin the index is written from the directory's listing.
On a presigned origin it is the index the run read, plus the build read off
`/manifest.json`, plus the build deployed.

An index is refused, naming the cap, when it names more than 100,000 builds,
ten deploys a day for 27 years; when an id is longer than 243 bytes, the most a
`<build id>.deployed-at` file name can hold; or when its body is longer than
the 24,600,014 bytes those two caps allow, which the read stops at. A refused
index stops every deploy to the origin until it is fixed, so the caps sit
beyond any history an origin reaches.

**A prune against a presigned origin reads the index, never a listing.** With
`--prune`, the run reads the index, then each document it names and each
document's deploy instant, all with signed GETs. Then it plans with the same
retained prune a directory origin runs, with the same grace periods. A document
that is absent or does not parse is left out, as the directory's reader leaves
it out. The DELETE keys go into the `--requests` file for the signer.

That takes one more signing pass than a deploy, because the documents to read
are known only once the index is read:

```sh
# GETs signed for /manifest.json and /.pagedeck/deploy-history.json
PAGEDECK_DEPLOY_URLS=reads.json   node dist/deploy.bin.js --prune --requests requests.json
# sign every key in requests.json into history.json: it now lists the history's GETs
PAGEDECK_DEPLOY_URLS=history.json node dist/deploy.bin.js --prune --requests requests.json
# sign every key in requests.json into signed.json: it now lists the DELETEs
PAGEDECK_DEPLOY_URLS=signed.json  node dist/deploy.bin.js --prune --apply
```

The first dry run says `Prune: deletes nothing — the prune reads <n> keys of the
origin's deploy history that PAGEDECK_DEPLOY_URLS holds no GET URL for …` and
lists those keys as GETs. The second plans the prune and lists its DELETEs. If
a key's grace runs out between the second dry run and the apply, the apply
finds no DELETE URL for it and is refused before it sends anything. Run the
passes again.

**An origin with no index prunes nothing, and says so.** An origin last deployed
by a pagedeck older than the index has none. The run does not guess a history:
it prints `Pruned nothing: the origin holds no history index at …`, and its
apply writes an index naming the build it read off `/manifest.json` and the
build it deployed. Prune on a run after that one.

**A file no document in the index names is never deleted**, because without a
listing the deploy cannot know it exists. That covers files only builds
deployed before the origin's first index named, and files put at the origin by
hand. Remove them by hand if the bytes matter: list the bucket, and delete what
no document under `/.pagedeck/manifests/` names and `manifest.json` does not
serve.

**The index is a read-modify-write, and a deploy that loses the race leaks.**
A `DeployTarget` has no compare-and-swap, so two applies that read the same
index each write it with only their own build added, and one entry is lost. The
workflows serialize applies with a `concurrency` group. A lost build's document
stays in the history, and the next deploy over that build adds it back from
`/manifest.json` when it is the build being served. Until then, a key only that
build named is not found, which leaks rather than deletes. A key it shared with
an older build can be blamed on a build stamped between the two, and get that
build's earlier deadline. That is the early-deadline fault "The grace period"
already describes for builds deployed out of stamp order.

**The prune never deletes a key the deploy writes for itself.** A DELETE for
`/manifest.json` or under `/.pagedeck/` is refused three times: as an entry in
the URL file, by the run before any request when its plan names one (only a
document written by hand can), and by `presign.bin.js` as an entry in the
requests file. The deploy history is never pruned, on any origin ("The grace
period" below).

## Types and cache policy

Every object the deploy writes carries a `Content-Type` and a
`Cache-Control` that the deploy decides (#560). The storage host does not
guess them. Without a type, the harness origin served JavaScript and CSS as
`text/plain`, which a browser refuses as a module script or a stylesheet. AWS S3
stores an untyped object as `binary/octet-stream`, and that includes HTML.

**Where they come from.** `packages/site/src/deploy-metadata.ts` maps the
manifest row of each file. `DeployTarget.put` receives the result, and
`presignedTarget` sends it as the `Content-Type` and `Cache-Control` request
headers. The filesystem target has no place to keep them and ignores them.

**The type** comes from the row's `kind` first and its extension second:

| Row | `Content-Type` |
| --- | --- |
| kind `html` | `text/html; charset=utf-8` |
| kind `js` | `text/javascript; charset=utf-8` |
| kind `css` | `text/css; charset=utf-8` |
| `.json` (`manifest.json` and `.pagedeck/manifests/*.json` too) | `application/json; charset=utf-8` |
| `.xml` | `application/xml; charset=utf-8` |
| `.txt`, `*.deployed-at`, `_headers`, `_redirects` | `text/plain; charset=utf-8` |
| `.woff2` | `font/woff2` |
| `.png`, `.webp`, `.avif` | `image/png`, `image/webp`, `image/avif` |
| `.jpg`, `.jpeg` | `image/jpeg` |
| `.svg` | `image/svg+xml` |
| `.ico` | `image/x-icon` |
| any other extension | `application/octet-stream` |

An asset row gets its type from its extension. A file with an extension the
table does not know is sent as `application/octet-stream`. After the upload,
the run prints a `Deploy: sent N files as application/octet-stream` line and
names each file. A browser downloads such a file and does not display it, so
rename the file, or add its extension to the table.

**The cache policy** is the ruling on #560:

- `public, max-age=31536000, immutable` for a file whose name carries its
  content hash. When the bytes change, the name changes too.
- `no-cache` for everything else: every page, `manifest.json`, the history
  documents under `.pagedeck/manifests/`, the edge tree files, and every asset whose
  name is not hashed.

**How "hashed" is decided.** The build decides it, and the deploy does not
read file names. When the build names a file from its bytes, it records
`"hashed": true` on that file's manifest row (`ManifestFile.hashed`, #560):

- every chunk the bundler names through its `[name]-[hash]` pattern, and every
  stylesheet and asset (an image, a font) it names that way;
- every file named by `shortHash`: font subsets, the font stylesheets and
  social images.

A page, a passthrough file and an asset a plugin emits under a name of its own
never carry the column. The deploy gives `immutable` to a row with
`"hashed": true` and `no-cache` to every other row, a page always. A manifest
written before the column existed has no such rows, so it gets `no-cache`
throughout. That costs a conditional request per file, and it never serves a
stale file. The column did not move `MANIFEST_VERSION` (#560): a reader that
misses the key gives the row `no-cache` whichever reading of the absence is
true, and that is correct for both, while a bump would make every retained
document a refusal at `readManifest` and so refuse a rollback over a key it can
do without.

**For whoever signs the URLs.** `PresignedUrls.put(key, metadata)` receives the
two values before the PUT is sent, and the CLI's `--requests` file lists them
for each key, with the body's MD5. The PUT also sends `Content-MD5`.
`presign.bin.js` signs `content-type` and `cache-control` into every PUT URL,
and `content-md5` into every PUT URL whose request carries an MD5: every file
but the deploy instant ("What a signed PUT binds" below). A URL signed over
`host` alone, like most of the harness's, still works, and S3 stores the headers with the object all the
same, but such a URL writes any bytes with any type and cache policy for as
long as it lives.

### What a signed PUT binds

A presigned PUT URL that signs only `host` lets whoever holds it write any
bytes with any `Content-Type` to its key until it expires (#60). The
`cloudflare-worker` Worker serves the stored type, so a leaked URL is a stored
XSS. A URL that leaves `Cache-Control` free can store a long `immutable` on a
page, so a later retraction of it never reaches a cache that kept it (#555).
`presign.bin.js` therefore signs the headers of each PUT from the requests file,
and the deploy sends each with exactly that value:

- **`content-type`.** Cloudflare's R2 presigned URL page: "Specify the
  allowed `Content-Type` in your SDK's parameters. The signature will include
  this header, so uploads will fail with a `403/SignatureDoesNotMatch` error if
  the client sends a different `Content-Type` for an upload request."
  (<https://developers.cloudflare.com/r2/api/s3/presigned-urls/>). AWS's
  upload guide says the same of S3: "Make sure the content type in your upload
  request matches the content type specified when generating the URL"
  (<https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html>).
- **`cache-control`.** No R2 or S3 page speaks to signing `Cache-Control` in
  particular. It is a signed header like any other: SigV4 puts each signed
  header's value in the canonical request, so a request that sends another
  value does not match the signature. The harness proves the refusal on
  SeaweedFS only.
- **`content-md5`**, the base64 MD5 of the body, in every PUT URL whose request
  carries one: every file but the deploy instant. A signed header must arrive
  with the value signed, so the URL takes only that MD5, and the host checks the
  body against it. AWS: "After uploading the object, Amazon S3 calculates the
  MD5 digest of the object and compares it to the value that you provided. The
  request succeeds only if the two digests match."
  (<https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html>).
  R2's S3 API compatibility table lists `Content-MD5` as implemented for
  `PutObject` (<https://developers.cloudflare.com/r2/api/s3/api/>).

**Why not a SHA-256.** R2's table lists no `x-amz-checksum-*` header for
`PutObject`, and lists SHA-256 for composite (multipart) checksums only, so
`x-amz-checksum-sha256`, which S3 does verify on a single-part upload, is not
documented to bind anything on R2. A hex `x-amz-content-sha256` in place of
`UNSIGNED-PAYLOAD` is documented by neither for a presigned URL, and SeaweedFS
4.47, the harness's origin, stored a different body under one when #60 tried
it. MD5 is broken for collisions, not for
second preimages, and binding a URL to a known body needs the second.

**What stays unbound.** The deploy instant
`/.pagedeck/manifests/<id>.deployed-at` gets a signed type and cache policy and
no MD5, because its bytes are the clock of the apply, which the dry run cannot
know. `presign.bin.js` refuses any other PUT in the requests file that has no
`contentMd5`, and names each one: run the dry run again on the same build and
sign the file it writes. GET and DELETE URLs sign `host` alone.

**A rebuild between the passes is refused.** The MD5s come from the bytes the
dry run read. If the apply reads other bytes for a key, the host answers 403,
and the deploy stops with `the host answered 403 to PUT`. Run both passes
again on the same build. The history index is planned from the history the dry
run read, so a deploy that lands between the passes makes the apply's index
differ, and it is refused the same way.

These are the headers the object is stored with. The headers an edge adds at
serve time (`_headers`, the CloudFront function) are routing's, and this does
not change them.

## Webhook and debounce

The webhook a CMS calls is `repository_dispatch` with type `content-published`.
The debounce is a `concurrency` group, and **the group carries whether the run
can write**:

- A run that cannot write joins `deploy-dogfood-site-dry-run` with
  `cancel-in-progress: true`, so a burst of publish events collapses to one run
  of the latest. That is correct for a dry run because of what it is derived
  from — the store snapshot and the two manifests, both read at the start of a
  run, neither accumulated across runs — and because it uploaded nothing, so
  there is nothing half-done to inherit.
- A run that can write joins `deploy-dogfood-site-apply` and is **never
  cancelled**. "A cancelled run uploaded nothing" is false for an applying run:
  `applyPlan` walks the plan in spec §11's order — assets, then HTML, then the
  build's manifest, filed once into the origin's deploy history and once as
  `manifest.json`, with the deploy instant between the two — so a cancel
  landing between two phases leaves pages live pointing at chunks that were
  never uploaded, which is exactly the half-published state the ordering
  exists to prevent. A webhook dry run could have delivered that cancel while
  the two shared one group.

A second applying run therefore queues behind the first rather than interleaving
its uploads into one origin, and the raced-deploy refusal is underneath it
either way.

## The grace period

**A deploy never deletes on its own.** `applyPlan` uploads and stops; the prune
is a separate call, and it deletes nothing before a deadline. For a hashed
`js`, `css` or `asset` file, that deadline is the instant a build was deployed
plus `graceSeconds`, and the default is **604800 seconds — seven days**. For a
page it is that instant with nothing added. *Which* build's is the whole of what #287
settled, and the answer is further down this section.

**`--prune` is what asks for that call**, and it is behind `--apply` like every
other write. It runs after every upload has succeeded, which is spec §11's third
phase and not a tail of the second. The workflow passes it on the apply step.

What it deletes is named in the plan the run prints, before the write and not
only after it: a `due` line per key going now and a `hold` line per key still
inside its window, each carrying the build that dropped it and the deadline that
build set. A dry run prints the same lines and deletes nothing, so the deletion
half of a deploy is as readable in advance as the upload half.

What it protects is a visitor holding a page from a minute ago whose browser is
still asking for the hashed chunk this build replaced. Delete on the way out and
that reader gets a 404 for a script the page they are looking at needs.

**A page has no grace period** (#555). A manifest row of kind `html` that the
new build no longer emits is not a chunk any page asks for, and when it was
dropped on purpose, as a retracted post is, the author wants it gone. So the
deploy that drops a page deletes it in the same run when it passes `--prune`,
after every upload has succeeded, and prints it on a `due` line. The hashed
chunks the same build replaced get their `hold` lines and their seven days. A
deploy without `--prune` still deletes nothing, page or chunk, so a retraction
needs `--prune`. Such a run says so in its last line, for example
`Prune 1 page on the next --prune run, and 3 files no earlier than <deadline>.` The origin is not the last copy: a CDN in front of it keeps
serving what it cached for as long as the CDN decides. The deploy writes every
page with `Cache-Control: no-cache` (#560, "Types and cache policy" below), so a
CDN that honours the origin's header asks the origin before it serves a page
again; one configured to override it keeps its own TTL.

Before a row's deadline the prune deletes nothing and answers with nothing, and
the run says which of the two it was. That is a result and not an error: a
pipeline that runs the prune on every deploy and finds every window still open
has done the right thing, and refusing would force the pipeline to compute the
date for itself.

**A file's deadline belongs to the build that stopped serving it, not to the
build running the prune.** That is what #287 changed, and until it landed the
prune in a workflow run was a no-op on every run: the only list a deploy could
compute was the difference between the live build and this one, whose window
this very deploy opens, so with the seven-day default the run holding the list
was always inside it. Nothing stale was ever deleted, because the run that could
delete it was the run that had just replaced the manifest describing it.

**So the deploy files each build it publishes into a history at the origin, and
the prune reads that history back.** `applyPlan` puts the build's own
`manifest.json` at `<origin>/.pagedeck/manifests/<build id>.json` as well — the same
bytes, under the same relative path a site's retention store has, immediately
before it publishes `manifest.json` itself. Every run reads that directory back
before it plans, through `listRetainedManifests`, the same door `pagedeck rollback`
reads a local store through. It then walks the history newest first: the first
build that no longer emits a key is the build that stopped serving it, so the
seven-day window on that key opened when *that* build was deployed. A key
dropped ten days ago is deleted today; a key this deploy dropped is held. There
is no state a CI runner has to keep between jobs, which is what makes this work
on a fresh checkout that holds one manifest of its own.

**When a build was deployed is on record beside its document, not in it**
(#403). Each apply also puts `<origin>/.pagedeck/manifests/<build id>.deployed-at`,
one line holding the ISO-8601 instant of that deploy, after the document and
before `manifest.json`. A build deployed again overwrites it. It is a separate
file because the document has to stay byte-identical to the `manifest.json` it
was deployed as, and it is one file per build rather than a field of the
history index because a `DeployTarget` has no compare-and-swap: the index is a
read-modify-write two deploys can each lose half of, and an instant lost that
way would shorten a grace period. The index only names builds, and what losing
one costs is in "Pruning a presigned origin" above. The name does not
end in `.json`, so the retention store's listing never opens it. The window
opens at that instant, and not at the build's `createdAt`, because a build waits
between being stamped and being deployed: an approval gate, a paused
pipeline, an old artifact put back. Timed from the stamp, b2 stamped on
1 January and deployed on 1 February gave the files it dropped a deadline of
8 January, already past when they stopped being served.

The build being deployed is the exception. Its instant is written by the apply
that is about to run, so when it goes over a different live build the plan
times it from the moment the deploy runs, whatever the origin holds for it.
That covers an old artifact deployed here for the first time: re-deploying a
build stamped on 1 December over a November build and a January one would
otherwise time the November build's files from 1 December and delete them on
the spot.

A file there that holds no instant is reported with the plan, on a
`Deploy history:` line naming it, and its build falls back to the stamp.
Rewrite it as the ISO-8601 UTC instant the build was deployed, with or without
milliseconds, or delete it to accept the stamp.

**The instant does not fix the order, and the order can err early.** The
history is still walked by `createdAt`, and an instant says when a build went
up, not which build it followed. When builds were deployed in a different order
from the one they were stamped in, and neither is the build being deployed or
the one it replaces, a file can be blamed on the wrong build: b2 stamped in
November but deployed on 15 December, after a build stamped on 1 December and
deployed on the 2nd, has its files timed from 2 December although b2 served
them until the deploy after it. The deadline is then early by the gap between
the two. A rollback is the same fault in the late direction, described below.

**One document per apply, and it is the document being deployed.** That is the
whole of what makes the walk above sound, and it was got wrong the first time:
the deploy published the *runner's* retention store, which is which builds this
runner **built**. Two builds made on a developer's machine between two deploys
then sat in the history having served nothing, and the older of them was blamed
for a drop that happened a month later — so a chunk the origin was serving that
second was deleted with no grace at all. Filing the bytes the apply is already
publishing removes the question rather than answering it: there is no way to
enter a build into this history without deploying it.

Four things about it are worth knowing before changing any of them:

- **The build being deployed is stated, never inferred from the order.** A
  document can be stamped ahead of what the origin actually serves — a skewed
  runner, or a build `pagedeck build` retained and never deployed — and by age alone
  that document would be the newest, making every file the live site serves read
  as superseded. The runnable passes the manifest it is deploying, and its keys
  come off the answer whatever the history says.
- **So is the build that was being served, and for a sharper reason: a rollback
  breaks the order.** `createdAt` says when a build was *stamped*, and restoring
  `b2` over `b3` leaves the clock still calling `b3` the newer — so `b3` reads
  as the build that superseded `b2`, when in truth `b2` outlived it by weeks,
  and every file the restored site serves is attributed to a deadline long past.
  The runnable passes `<origin>/manifest.json` as the build that was live, and a
  key whose newest holder is that build is named as dropped by this deploy, with
  its window opening at the moment the deploy runs — not at the deployed build's
  own clock reading, which is when the artifact was *stamped* and can be a month
  earlier if you are re-deploying an old one. That is the whole grace period
  ahead of it, measured from now. What that cannot fix is the build the
  rollback un-served: nothing anywhere records when a rollback happened, so its
  files are attributed to the next build by clock reading, which is later than
  the truth and therefore the safe side. The cost is one deploy's delay and not
  a leak — `deploy.test.ts` runs the deploy after and asserts the files then go.
- **The origin accumulates these documents and nothing bounds it — not
  `build.retention.keep`, which governs only the copy beside the site.** A
  `DeployTarget` has no list operation, and deleting the oldest documents is the
  one edit that would break the prune: a key only those builds held would go
  invisible to it and stay at the origin for ever. Never leaking an asset is
  what the growth buys, and the growth is real rather than negligible.
  **Measured on this repository: one manifest is 6110 B for the four-page
  dogfood site and 363546 B for the fifty-page docs site** — 6.1 kB and 364 kB,
  SI units, as every figure in this section is. Two things set the rate and only
  one of them is the document: the size of each scales with the pages and files
  a build emits, and how many of them you accumulate scales with how often you
  deploy. Multiply the two — a site the size of the docs site, deploying ten
  times a day, files about 3.6 MB a day. Budget it against both, and read it as
  the standing cost of a prune that works.
- **They are kept off the edge, and so is `manifest.json`** (#556). Each
  document names every file its build served, and `build.parent` leads from
  the live manifest to the one before it, so served, the history would hand
  anyone every address the site has ever had — a post set to draft since
  included — with the time each build went up. Nothing in a browser reads
  either file: the deploy reads the origin directly, through the file system
  or a signed GET, and never through the edge. So every edge adapter's
  output answers `/manifest.json` and everything under `/.pagedeck/` with the
  site's 404, the response a missing page gets, or a bare 404 on a site with
  none. That is a framework default, in every tree, and no rule a site writes
  can undo it: the planner refuses a page or a redirect at these paths, and a
  header rule there sets headers on the 404 and serves nothing. What the edge
  cannot close is the origin itself: an origin anyone can read without going
  through the edge serves these keys like any other file, and keeping the
  origin private is set up where the origin is, not in anything the framework
  emits.

**Two gaps remain on an origin that was deployed to before these changes, and
both are bounded.**

- **Builds deployed before the deploy instant was recorded fall back to their
  stamp.** Their documents have no `.deployed-at` beside them, so the files
  they dropped are timed from `createdAt` as before, and a build that waited
  between stamp and deploy still hands those files less than seven days of
  grace. That lasts only while such a build is the one that dropped a file the
  prune has not yet deleted: once those files are gone, the build no longer
  decides any deadline. From now on an apply writes the instant of the build
  it deploys once that build's files and document are up, re-deploys and
  rollbacks included, overwriting any earlier one; an apply stopped before that
  point leaves the build without one. None of this needs a migration.
- **Files dropped by builds older than the first deploy after #287 appear in no
  document and are never pruned.** Before #287 the origin held only
  `manifest.json`, so its history starts at one document, and a file that
  document already did not list is invisible to the walk above. This leaks
  bytes rather than deleting live ones, and it does not grow: it is fixed at
  adoption. Nothing in the framework can find those files, because a
  `DeployTarget` has put and delete and no list. Remove them by hand if the
  bytes matter: list the origin, and delete what no document under
  `.pagedeck/manifests/` names and `manifest.json` does not serve.

**This overrides a decision #32 made, and the override is the maintainer's
rather than this document's.** #32 put the retention store beside the output
tree and never inside it, and one of its reasons is precisely this: a store
under `outDir` would mean every CDN bucket accumulates twenty copies of a
document describing files it is serving. The reasoning holds — a deploy that
swept `outDir` would
publish twenty documents on the first apply and twenty again on the next, for a
store the origin had no use for. #287's ruling decided the origin has a use for
it after all, and the shape above is what makes the two compatible rather than
merely overruled: the origin accumulates **one** document per apply and not
twenty, it is a copy of a document the deploy was publishing anyway rather than
a directory swept off disk, and the site's own store is still outside `outDir`
and still unpublished. The count #32 warned about is the count this
arrangement does not have.

A rollback keeps the old prune and hands over no history, deliberately: that
computation is written on "the newest build in the history is what the origin
serves", and a restore makes it false, so a rollback with `--prune` would delete
the site it just restored. The workflow passes `--prune` on the deploy step and
not on the rollback step. That old prune has one deadline for the whole plan,
and a page ignores it the same way: a rollback with `--prune` deletes the pages
the rolled-back build added in the same run, and holds its chunks until the
deadline. The run ends with a `Held 1 file` or `Held <n> files` line naming
that deadline whenever it deleted some files and not others.

`pagedeck diff` and `pagedeck rollback` take `--grace-seconds <n>` to set it.
`deploy.bin.js` does not, and plans under the default — so **if you change the
window, change it in both places**, or the document a person read and the plan
that ran will disagree about when a file may go. The workflow passes it to
neither, which is why the two agree today.

There is no `--due-only` flag anywhere in this pipeline. Scheduled publishing's
build-side pass is #281's, and `deploy.bin.ts` deliberately does not call it.

## Rolling back

```sh
# the restore, as a document
node ../core/dist/bin.js rollback <build-id>

# the restore, carried out through the same uploader seam
node dist/deploy.bin.js --rollback <build-id> --origin <dir>          # dry run
node dist/deploy.bin.js --rollback <build-id> --origin <dir> --apply
```

The build id is the `build.id` in the manifest that build wrote. The plan is
`{ from: what is live, to: the retained build }`, never the other way round:
the build being restored is the one the host must end up serving, so its files
are the uploads and the live build's leftovers are the prunes. Swapped, a
rollback deletes the site it was asked to restore.

Against a presigned origin the rollback reads both manifests off the origin:

```sh
# GETs signed for /manifest.json, /.pagedeck/deploy-history.json
# and /.pagedeck/manifests/<build-id>.json
PAGEDECK_DEPLOY_URLS=reads.json  node dist/deploy.bin.js --rollback <build-id> \
  --out <tree build-id wrote> --requests requests.json
PAGEDECK_DEPLOY_URLS=signed.json node dist/deploy.bin.js --rollback <build-id> \
  --out <tree build-id wrote> --apply
```

What is live is `/manifest.json`, and the build to restore is its document in
the origin's deploy history, so the origin has to have served it. The bytes come
from `--out`, which must be the tree that build wrote: a run whose `--out` holds
another build is refused before any request.

**Two things a rollback needs that a fresh runner does not have.**

1. **The retention store.** `pagedeck build` retains manifests in `.pagedeck/manifests`
   beside the output tree, and a rollback reads the one it is named. A CI job
   that checked out and built once holds exactly one manifest — its own — so a
   real rollback needs that store restored into the workspace first.
2. **The retained build's bytes.** `pagedeck build` retains the *manifest*, not the
   output tree, and a rollback uploads files. Either keep the build artifact or
   rebuild that commit. The build test keeps build 1's tree on disk, which is the
   same fact with no build in it.

## The edge artifacts

An edge adapter compiles the site's `build.routing` into a host's files, and a deploy
treats them as two groups because a host does:

- **`tree-file`** — `/_redirects` and `/_headers` on Netlify, for instance.
  Uploaded with the site, into the output tree, **after** every file the build
  emitted for that tree. That order is what makes it impossible for a redirect to
  be live before the page it points at.
- **everything else** — a CloudFront Function, its config fragment, a KeyValueStore
  dataset, an nginx include, a Cloudflare Worker. **Published out of band.** `applyPlan` writes them
  into the `--staging` directory and stops; the workflow uploads that directory
  as a build artifact, and an operator applies it.

**A domain tree's artifacts are staged in a directory named for its tree key**
(#669). Every tree compiles to the same file names, so with one flat directory
the last tree's file would overwrite the others. The default tree's stay at the
root of the staging directory, as its files do in the output directory. The
plan names the tree on each domain tree's `stage` line:

```
  edge artifacts, compiled for cloudflare-worker
    stage  worker.js (edge-module) — applied out of band by CI
    stage  shop.example/worker.js (edge-module, tree shop.example) — applied out of band by CI
```

An applying run lists each file it staged with its tree, the default tree's
as `tree (default)`. Apply each file to the distribution or Worker that serves
its tree. A site whose only tree is a domain tree stages under that tree's key
too, so its files do not move when a second tree is added. A tree key that
would put a file outside the staging directory is refused before anything is
uploaded.

**Every tree gets edge artifacts, even a tree whose site declares no routing at
all** (#556). The deny for the reserved deploy keys — `/manifest.json` and
`/.pagedeck/`, see "The grace period" above — is compiled into every tree, so a site
that wrote nothing still has something to install:

- On `cloudfront-function`, a viewer-request function (`routing.request.js`).
  It has to be associated with the distribution for the deny to take effect.
  CloudFront allows one function per event type on a cache behaviour, so a
  distribution that already runs a viewer-request function of its own has to
  compose the two into one: this one's stages first, then its own.
- On `netlify`, and on any deploy that uploads the tree files to its origin, a
  `/_redirects` whose first three rows are the deny.
- On `nginx`, a `routing.conf` fragment whose first two lines are the deny. It
  still has to be `include`d in the `server` block.
- On `cloudflare-worker`, a `worker.js` that refuses the keys before it reads
  the bucket. It has to be published with the bucket bound to it, and routed in
  front of the site, for the deny to take effect.

A dry run stages nothing at all — it names each artifact in the plan and creates
no directory — so `--edge` is safe to leave in a workflow that has not been
authorized to deploy. The workflow's `edge_target` input defaults to
`cloudfront-function` because that is the target whose artifacts are entirely
out of band, and so the only one that exercises the staging half; it is a
statement about what the run compiles, not about where this site is served.
`none` skips the compile.

**The headers on the 404 page and on a redirect rest on host facts nobody has
checked** (#559). Every target is compiled to send the 404 page with the set
of the header rule the 404 page's own path matches, and a redirect with the set
its `from` matches. nginx does that by construction: the lines sit in the 404
page's `location` and in each redirect's. The other two need a host fact this
repository has not observed, and the equivalence check assumes it:

- **Netlify**, two facts: that `_headers` is matched against a `404` row's
  target, the 404 page, and not against the path requested; and that it
  applies to a redirect row at all, matched against the row's `from`. If the
  first is wrong, the 404 page gets the requested path's set, which is the same
  set on a site with one rule over `/`. If the second is wrong, redirects go
  out with no header from the routing document.
- **CloudFront**: that the viewer-response function runs over a custom error
  response. If it does not, the 404 page goes out with no header from the
  routing document. A redirect does not depend on it: the viewer-request
  function writes the set into the redirect it returns.
- **Cloudflare Pages**: `@pagedeck/adapter-cloudflare-pages` has no rewrite
  with a status other than 200, so a reserved deploy key (`/manifest.json`,
  `/.pagedeck/`) is proxied (200, in place) to the tree's 404 page instead,
  and `_headers` is assumed to match the *original* request's path rather than
  the proxied page's — the opposite assumption from Netlify's and CloudFront's
  above. If Cloudflare matches the proxied page's path instead, a reserved key
  carries the 404 page's own header set rather than whatever (if anything)
  matches the key itself. Whether a redirect response carries `_headers` at
  all is also unconfirmed. A missing page that is not a reserved deploy key is
  outside this adapter's files entirely: Cloudflare's own nearest-`404.html`
  lookup serves it (not `_redirects` or `_headers`), and whether that response
  carries the 404 page's header set or none is a third open question.
- **Vercel**, two facts: that a `routes` entry ahead of
  `{"handle": "filesystem"}` still wins over a real file at that path, and
  that one declared after it is reached only where no real file answers. If
  the first is wrong, a reserved deploy key is served as the real file it
  masks rather than the 404 page. If the second is wrong, a miss anywhere else
  in the tree gets no header from the routing document, or masks a page that
  does exist. A third fact, outside this check: that Vercel reads `vercel.json`
  from the Output Directory, which is where `pagedeck build` writes it. The
  how-to's "Vercel" section names the Output Directory setting that assumes it.

Check all of these on a staging deploy before relying on them, by requesting a
missing path, a redirect source and a reserved deploy key, and reading the
response headers and status.

Nothing in this repository applies the second group, and that is the standing
decision "edge artifacts are emitted, not provisioned" rather than an unfinished
step: a compiler emits the files a host needs and records what the host must be
given, and what it emits is inert until somebody installs it. The failure that
decision is written against is concrete — a CloudFront Function uploaded into the
bucket beside the site's JavaScript succeeds, publishes nothing, fires no
redirect, and reports green.

**On Netlify, a page's other trailing-slash spelling is Netlify's own answer**
(#35). Every other target redirects the other spelling of a redirect's target
to the target. Netlify [matches a `_redirects` rule with or without a trailing
slash](https://docs.netlify.com/manage/routing/redirects/redirect-options/), and
its docs say "you cannot use a redirect rule to add or remove a trailing
slash": a row such as `/new /new/ 301!` sends `/new/` to itself. So `netlify()`
writes no row whose two paths differ only by a trailing slash, refuses a
configured redirect of that shape, and the conformance cases do not claim that
redirect for Netlify. It keeps the row from a redirect source's other spelling
to the target: that row is forced (`!`), so it wins over a file at that path.
Because Netlify ignores the trailing slash, the same forced row also catches
the source's own spelling, which in effect forces the configured rule too.

The dogfood site declares two redirects and two response headers
(`packages/site/src/site.ts`), and
`packages/site/src/site.build.test.ts` compiles the real build's routing document
for two hosts and reads both back out of the artifacts. That is the only claim
made about them: they are text, compiled from the site's own config.

## The landing page on Cloudflare

The landing page (`packages/landing`) is deployed as **Workers Static
Assets**: one `wrangler deploy` uploads the built tree and publishes a Worker
that serves it, with no Worker code of the site's own and no bucket (#52). It
does not go through `deploy.bin.js`, so the incremental deploy, the deploy
history, the grace period and the rollback above do not apply to it: wrangler
uploads only the files Cloudflare does not hold yet, and Cloudflare keeps the
Worker's versions. The `cloudflare-worker` adapter, `presign.bin.js` and the
origin harness stay as they are, as the R2 path for other sites.

wrangler is `packages/landing`'s exact-version dev dependency, so every command
below runs as `pnpm exec wrangler` in `packages/landing`, never as `npx
wrangler`, which would take whatever version is latest.

**What the build writes for it.** The site's `build.adapter` is
`cloudflarePages()`. Workers Static Assets reads the same `_headers` and
`_redirects` formats as Cloudflare Pages, so `pagedeck build` writes into
`site/`:

- `_headers`: a `/*` rule with the three security headers, the
  `Content-Security-Policy` from `src/csp.ts`, the same value the routing
  header rule and the other adapters carry, and the `Permissions-Policy` and
  `Cross-Origin-Opener-Policy` from the same file (#62). Then one rule each
  for `/assets/*`, `/fonts/*` and `/social/*`, which hold only content-hashed
  names, adding `Cache-Control: public, max-age=31536000, immutable` and
  detaching the policy (#55). Those three rules set the three security headers
  too, because a path carries the set of the prefix it matches and no
  other, and the adapter writes them once, in `/*`. `/images/` holds unhashed
  names and has no rule. Every other file, and every page, gets Cloudflare's
  default `public, max-age=0, must-revalidate`, observed on the live landing
  page (#55).
- `_redirects`: three rows that proxy `/manifest.json`, `/.pagedeck` and
  `/.pagedeck/*` to `/404.html`. The site declares no redirects of its own.
- `404.html`: the adapter's bare fallback, written because the site declares
  no 404 page.
- `.assetsignore`, from `public/`, through passthrough. It names
  `/manifest.json`, `/.pagedeck` and `/404.html`. wrangler leaves those out of
  the upload, and itself leaves out `.assetsignore`, `_headers` and
  `_redirects`, which it reads as configuration.

So `manifest.json` and the fallback page are never uploaded, and the build
writes `.pagedeck/` beside `site/`, not in it. A request for `/manifest.json`
or under `/.pagedeck/` matches a proxy row whose target was not uploaded, and
the asset worker answers a proxied path with no asset `404`. Uploaded, the
fallback page would be served for those keys with status `200`, which is why
it is left out. Any other path with no asset is answered by
`not_found_handling: "none"`, a bare `404`.

`packages/landing/wrangler.jsonc` declares the Worker: the name
`pagedeck-landing`, `assets.directory` `./site`, `html_handling`
`auto-trailing-slash` (`/features` answers `307` to `/features/`),
`not_found_handling` `none`, no `main`, `workers_dev` on, and no route, because
the domain does not exist yet. The Worker serves on its `workers.dev` address.

**What is proven, and what is not.** `wrangler deploy --dry-run` against a
local landing build succeeds: it reads the 45 entries of `site/`, ignores
`.assetsignore`, `404.html`, `_headers`, `_redirects` and `manifest.json`, and
sends nothing to Cloudflare. `site.build.test.ts` holds the written `_headers`
to the landing page's header set, each hashed file to `immutable` with
`nosniff`, every other file to no `Cache-Control`, and `.assetsignore` to its
three lines.
Cloudflare has not been sent a request. These are the host facts the first
deploy checks:

- Workers Static Assets applies the `_headers` rule to every page, so each
  response carries the CSP, the three security headers, `Permissions-Policy`
  and `Cross-Origin-Opener-Policy` (#62), and a hashed file answers
  `immutable` with `nosniff`.
- A proxy row whose target is not uploaded answers `404`. This is read from
  the asset worker's source bundled in wrangler 4.148.0's Miniflare
  (`workers-shared`), not observed on Cloudflare, and whether that `404`
  carries the `_headers` set is not documented.
- An API token with Account → Workers Scripts → Edit can upload the assets and
  publish the Worker. Cloudflare's permissions reference describes that
  permission as write access to Workers scripts and names nothing for static
  assets; that nothing more is needed is not checked.

### Setting up

Once, in the Cloudflare account that will hold the domain:

1. **wrangler on your machine.** `wrangler login` opens a browser and
   authorizes wrangler for your own account. It is for the commands you run by
   hand; the workflow uses the token below.

   ```sh
   cd packages/landing
   pnpm exec wrangler login
   ```

2. **An API token for the workflow**, in the dashboard under My Profile → API
   Tokens → Create Token → Custom token, with one permission: **Account →
   Workers Scripts → Edit**, on that one account. If the first publish is
   refused with an authorization error, add only the permission the error
   names.
3. **The Worker.** Nothing creates it by hand: the first `wrangler deploy`
   creates `pagedeck-landing` with its assets and its `workers.dev` address.

### The secrets

Two repository secrets, under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the API token above |
| `CLOUDFLARE_ACCOUNT_ID` | the account's ID, from the dashboard's Workers & Pages overview |

`gh secret set <name>` reads the value from standard input when you paste it,
so the value is not on a command line. The workflow passes both to the publish
step and to no other step. A publishing run with either one unset fails, names
it, and publishes nothing.

### Deploying

```sh
gh workflow run deploy-landing.yml                  # build, then wrangler deploy --dry-run
gh workflow run deploy-landing.yml -f apply=true    # build, then wrangler deploy
```

Both build the page from the checked-out commit. A run without `apply` uses no
credential. Each run uploads the `landing-deploy` artifact: what wrangler
printed, the built `site/` and `.pagedeck/budget-report.json`.

The repository is public, so anyone can read a run's log and its artifacts.
wrangler's stdout and stderr pass through `packages/landing/dist/redact.bin.js`
before the log or `wrangler.txt` gets them. It replaces each email with
`<email>` and each 32-character hex ID, such as the account ID, with `<id>`
(#59). `packages/landing/src/redact.bin.test.ts` fails on a workflow line
that runs wrangler without it.

To deploy from your machine instead, from `packages/landing` after `pnpm build`
at the repository root:

```sh
node ../core/dist/bin.js sync
node ../core/dist/bin.js build
pnpm exec wrangler deploy --dry-run   # lists the upload; sends nothing
pnpm exec wrangler deploy
```

The first time:

1. Set up as above and set the two secrets.
2. Run with `apply=true`. wrangler creates the Worker and prints its
   `workers.dev` address.
3. Open that address. `/` answers the page, `/features` answers `307` to
   `/features/`, `/manifest.json` and `/.pagedeck/deploy-history.json` answer
   `404`, and a page carries the CSP, the three security headers, a
   `Permissions-Policy` and `Cross-Origin-Opener-Policy: same-origin` (#62).
   A file under `/assets/` answers `Cache-Control: public, max-age=31536000,
   immutable` with `X-Content-Type-Options: nosniff`, and `/` answers no
   `immutable`. Then add the domain (below).

### Rolling back

Each `wrangler deploy` makes a new version of the Worker, with its assets, and
Cloudflare keeps them. From `packages/landing`, with `wrangler login` done:

```sh
pnpm exec wrangler deployments list          # what was deployed, newest first
pnpm exec wrangler rollback                  # back to the version before the live one
pnpm exec wrangler rollback <version id>     # back to a named version
```

A rollback publishes an earlier version as it was. The next applying run
deploys the checked-out commit again, so revert the change on `main` before
the next run if it should stay rolled back.

### Adding the domain

When the domain is ready, declare it in `wrangler.jsonc`, not in the
dashboard, and turn `workers_dev` off so the page has one address. `wrangler
deploy` applies the config's `workers_dev` on every publish.

```json
"workers_dev": false,
"routes": [{ "pattern": "<domain>", "custom_domain": true }]
```

Before that, write down the DNS records the domain has: a custom domain
creates its own record. Merge and run with `apply=true`. Then:

1. Check `/` over HTTPS on the domain, as in step 3 above.
2. Declare HSTS. It is left out until then because it is a promise about a
   domain (`CONTEXT.md`, "The framework emits no header a site did not
   write"). Add `{ name: "Strict-Transport-Security", value:
   "max-age=31536000" }` to the `/` rule in `packages/landing/src/site.ts`,
   where a comment says why it is absent, and to `SERVED_HEADERS` in
   `packages/landing/src/site.build.test.ts`. Leave out `includeSubDomains`
   unless every host under the domain serves HTTPS. Merge, run with
   `apply=true`, and check one response for it.

To take the page off the domain, remove the custom domain from the Worker,
which deletes the record Cloudflare created for it, and recreate the records
you wrote down. Then take the route out of `wrangler.jsonc` and set
`workers_dev` back to `true`, so the next publish does not add the route
again.

## The docs site on Cloudflare

The docs site (`packages/docs`) deploys the way the landing page does, as its
own Workers Static Assets Worker, `pagedeck-docs` (#6). Everything in "The
landing page on Cloudflare" holds for it, with `packages/docs` for
`packages/landing` and `deploy-docs.yml` for `deploy-landing.yml`: the same
token and the same two secrets, wrangler pinned to the same version in this
package's dev dependencies, the same rollback and the same steps to add a
domain. Both workflows call `.github/workflows/deploy-worker.yml`, which builds
the one site it is given and runs wrangler on it.

**What the build writes for it.** `build.adapter` is `cloudflarePages()`, so
`pagedeck build` writes the same four files into `site/`: `_headers`, a `/*`
rule with the three security headers and the docs site's own
`Content-Security-Policy` from `src/csp.ts`, then a rule for `/assets/*`, which
holds only content-hashed names, adding `Cache-Control: public,
max-age=31536000, immutable` and detaching the policy (#86); `_redirects`, the
three proxy rows for `/manifest.json`, `/.pagedeck` and `/.pagedeck/*`; the
fallback `404.html`; and `.assetsignore`, from `public/`. The site declares no
404 page, so `not_found_handling` is `none`, and the fallback stays out of the
upload. `/search/` is the one page with JavaScript, and its index under
`/search/en/` is uploaded with the pages. The index files and `favicon.ico`
have unhashed names and no rule: like every page, they get Cloudflare's
default `public, max-age=0, must-revalidate`, as observed on the landing page
(#55).

**If the site ever declares a 404 page**, uploading it is not enough. With
`/404.html` uploaded, the asset worker bundled in wrangler 4.148.0 answers a
proxy row's target through `html_handling`: `/manifest.json` gets `307` to
`/404`, and `/404` serves the page with `200`. `site.build.test.ts` fails when
a 404 page is declared while `.assetsignore` still names `/404.html`.

`packages/docs/wrangler.jsonc` declares the Worker: `assets.directory`
`./site`, `html_handling` `auto-trailing-slash`, because the site's
`trailingSlash` is `always` (`/reference/cli` answers `307` to
`/reference/cli/`), `not_found_handling` `none`, no `main`, `workers_dev` on,
and no route. The Worker serves on
`https://pagedeck-docs.pedrodsousa.workers.dev` until a domain is chosen (#54).

**The READMEs link it.** The root README, each package README and the
README that `create-pagedeck --host` writes link the deployed pages at that
address. `site.build.test.ts` requires each linked route to be a page the
build emits, and each `#fragment` a heading on it. When the domain changes,
change `DOCS_ORIGIN` there and every link with it.

**What is proven.** `wrangler deploy --dry-run` against a local docs build
reads `site/`, ignores `.assetsignore`, `404.html`, `_headers`, `_redirects`
and `manifest.json`, and sends nothing. `site.build.test.ts` holds each hashed
file to `immutable` with the three security headers, and every other file to
the full set with no `Cache-Control`. Cloudflare has not been sent a request.

```sh
gh workflow run deploy-docs.yml                  # build, then wrangler deploy --dry-run
gh workflow run deploy-docs.yml -f apply=true    # build, then wrangler deploy
```

Each run uploads the `docs-deploy` artifact: what wrangler printed, redacted
by the landing package's `redact.bin.js` as for the landing page, and the
built `site/`. The site declares no budget, so there is no budget report.

After the first publish, open the address. `/` and `/search/` answer their
pages, `/reference/cli` answers `307` to `/reference/cli/`, `/manifest.json`
and `/.pagedeck/deploy-history.json` answer `404`, a page carries the CSP and
the three security headers, a file under `/assets/` answers `Cache-Control:
public, max-age=31536000, immutable` with `X-Content-Type-Options: nosniff`,
`/` answers no `immutable`, and a search on `/search/` returns results.
