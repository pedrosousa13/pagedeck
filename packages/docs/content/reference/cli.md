---
section: reference
title: The pagedeck command
description: Each pagedeck verb, from sync and dev to diff and rollback, is listed with the flags it takes and the exit codes it returns.
---

# The pagedeck command

`pagedeck` is run from a site directory — one holding a `pagedeck.config.ts` or
a `pagedeck.config.js`. Paths inside the config are resolved against the config
file, not against the working directory, so a CI step may run `pagedeck` from
anywhere.

```
pagedeck build [--incremental]             render, bundle and write the whole site
pagedeck dev [--port <n>] [--host <addr>]  serve the site from the store, rendering on request
pagedeck sync [--incremental]              sync every configured collection
pagedeck sync --watch                      sync again every --interval seconds, until stopped
pagedeck store pull [<url>]                fetch the store snapshot from <url>
pagedeck store push [<url>]                upload the store snapshot to <url>
pagedeck diff <from> <to>                  compare two manifests, in upload order
pagedeck rollback <build-id>               restore a retained build, in upload order
```

## pagedeck sync

Runs every collection's loader against the site's store and reports what moved,
one line per collection: how many entries changed, how many were deleted, and
the cursor now stored against the collection.

With `--incremental`, each collection syncs from its own stored cursor instead
of syncing everything. There is no `--since <cursor>` flag, because a run syncs
every configured collection and each keeps its own cursor — there is no single
cursor a caller could pass. A collection that has never been synced fails rather
than quietly falling back to a full sync.

A failing collection does not stop the others. Every failure is reported at the
end, and the exit code still says the run failed.

### pagedeck sync --watch

Keeps syncing until you stop it, so that content edits reach a running
`pagedeck dev` without either being restarted. It is its own process, run beside the
dev server:

```
pagedeck dev
pagedeck sync --watch          # in a second terminal
```

Nothing passes between the two. The dev server opens the store on every
request, so a store the watch rewrote is read by the next page load, and the
edit is there on reload.

`--interval <seconds>` sets how long the watch rests between syncs; the default
is 5. It has to be a whole number above zero — the rest is what keeps the watch
off the store the dev server is reading from — and at most 2147483, which is
the longest delay a JavaScript timer holds. A longer one is not refused by the
platform but clamped to a millisecond, so it would turn the flag on its head
and give you the rest-free loop that zero is refused to prevent. The rest is
measured between syncs rather than on a schedule, so a sync that takes a while
pushes the next one out instead of overlapping it: there is never more than one
sync running, and no backlog builds up behind a slow one.

`--watch` composes with `--incremental` and does not imply it. `pagedeck sync --watch`
runs full syncs; `pagedeck sync --incremental --watch` runs incremental ones, and each
collection has to have been synced once before that works.

Every tick reports what it moved, exactly as a single run does. A tick that
fails is reported the same way and the watch keeps going: a CMS that is down
comes back up, and a watch that exited would take your dev session's content
with it. `--interval` on a run with no `--watch` is refused rather than
ignored.

## pagedeck dev

Serves the site from the store, rendering each page on the request.

**It runs until you stop it.** Every other verb in this file is a run that
finishes and reports what it did; this one is a process that stays up, and the
command does not return until the server has stopped. It installs no signal
handler, so `Ctrl-C` ends it the way it ends `pagedeck sync --watch` — the platform's
default disposition, on a process that never promised an orderly shutdown.

It reads the store and never a content source, so run `pagedeck sync` first. The store
is opened and closed per request rather than held open for the life of the
server, which is what "edits appear on reload" means mechanically: a
`pagedeck sync --watch` in another terminal writes rows, and the next page load takes
its snapshot after that.

Once it is listening it prints the config it loaded and the origin it bound:

```
serving /site/pagedeck.config.ts at http://127.0.0.1:5173
```

`--port <n>` sets the port, and the default is 5173. It has to be a whole number
between 0 and 65535, and `0` means "whichever port is free": the kernel picks
one, and the line above reports whichever it gave. A port outside that range is
refused here rather than left to the platform, which reports a range error
naming neither the flag nor the verb.

`--host <addr>` sets the interface to bind, and **the default binds `127.0.0.1`,
this machine only.** Exposure has to be typed because a dev server authenticates
nothing and serves from the project root: binding every interface hands anything
on the network the site's unpublished content and the tree around it. That is a
reasonable thing to do on request — a phone on the same LAN is the ordinary
reason to want it — and an unreasonable thing to inherit, which is why it is a
flag rather than a config field. A flag is typed once per run, by the person on
the network in question, and it is not committed.

The address is whatever the platform will bind. Nothing checks its format and
nothing resolves a name, because a parse that resolved one would put a DNS query
in the command line. What is refused is a `--host` that named no interface while
saying it did: no value, an empty one, or the next flag taken as the value. A
bracketed IPv6 literal is unwrapped before it is bound, so `--host [::]` binds
what `--host ::` binds — the announcement is what put the brackets there, and
binding `[::]` as typed would resolve it as a name and find nothing.

A bind beyond loopback adds lines, and they answer different questions:

```
serving /site/pagedeck.config.ts at http://0.0.0.0:5173
  reachable on this network at http://192.168.1.24:5173
  this server authenticates nothing and serves from the project root
```

The first line always names the address the socket was given, which for a
wildcard bind is not an address anyone can open. So a wildcard — `0.0.0.0` or
`::` — adds the reachable line, naming the first non-internal IPv4 address this
machine has, in the order the platform lists its interfaces. It is a hint rather
than a ranking: which of a LAN address, a VPN and a container bridge you want is
a fact about your network the process cannot see. A machine with no such address
prints no reachable line rather than failing.

The exposure line is printed for every non-loopback bind, wildcard or not. What
is on the network is the same server whether it was bound on one interface or on
all of them, and the operator who typed the flag is who it is addressed to. A
specific address needs no reachable line, because the first line is already
something to paste into another device.

Loopback asked for by name prints the single line a bare `pagedeck dev` prints:
`127.0.0.1`, any other `127.` address, `localhost` and `::1` bind what the
default binds, so they expose what the default exposes, and a warning that fired
on the safe case is one a reader would learn to skip.

A flag this verb does not know, and a `--port` or `--host` given no value, are
refused before the config is loaded, with exit **2**.

## pagedeck build

Renders every page of the route table, bundles the client entries for whatever
hydrates, writes the site to the configured `outDir`, and reports the number of
pages and files written.

`pagedeck build` reads the store and never a content source, so a build does not
depend on your CMS being up. Run `pagedeck sync` first.

A site that declares `build.preview` also gets the [preview app](./preview.md)
emitted under the path it named, and one line under the summary saying so. That
line is a caveat rather than a statistic: the app authenticates nothing and
renders any draft posted to it, so whether it is safe where it landed is a
question about your deployment. A site that declares no `build.preview` emits no
app and prints no line.

With `--incremental`, the build reads the manifest of the build already in
`outDir`, works out which pages the store's changes since it affect, and reports
that plan under the summary — one line saying how many pages the plan renders,
reuses and removes. It then acts on it: only those pages are rendered, the
rest are read back off the tree at `outDir`, the write covers what the run
composed, and any file the previous build wrote that this build's manifest no
longer names is deleted. The tree it leaves is the tree a full build of the
same store leaves, byte for byte.

An incremental build makes no external link probe requests, even where the site
declares `build.links.external`; only a full build checks external links. See
[Link checking](./link-checking.md).

A page it reuses is verified before it is carried: the document on the tree has
to hash to what the previous manifest recorded, or the build refuses rather than
publishing bytes it never read.

A site that declares `build.search` builds incrementally too, and its index is
the index a full build writes. An adapter with a `patch` method is handed the
previous index, the pages this run rendered and the pages that left, and
rewrites only what moved — `@pagedeck/search` rewrites the locale directories whose
pages moved and leaves the others. An adapter without one is handed every page,
so the run renders every page, and the summary line says why. So does a run
whose previous build holds no index from the adapter — the site has just
declared `build.search`, or renamed its adapter — because there is nothing to
patch.

It refuses rather than quietly building everything: an `outDir` with no manifest
in it, a manifest another version of `pagedeck` wrote, a store whose newest position is
behind the one that manifest recorded — a restored snapshot, or a different
store — and a search index the tree no longer holds as the previous build wrote
it. Each refusal names `pagedeck build` as the fix.

## pagedeck store pull / push

Move the store file itself — a single portable SQLite file — between machines.
`<url>` is a `file:` or an `https:` URL; an S3-style target is a presigned
`https:` URL. Redirects are not followed, because a redirect can move the
transfer off `https:`.

Presigned URLs carry their credential in the query string, so every message and
success line about a snapshot has its target redacted down to scheme, host and
path.

### PAGEDECK_SNAPSHOT_URL

Redaction covers what `pagedeck` prints, and nothing else. A URL passed as `<url>` is
still an argument of the process: on stock Linux `/proc/<pid>/cmdline` is
readable by every user on the machine, so it is visible to anything else running
on a shared CI runner, and most CI providers echo the `run:` line — arguments
included — into the log before executing the step.

So `pagedeck store pull` and `pagedeck store push` take the target from `PAGEDECK_SNAPSHOT_URL`
when the command line names none:

```
- run: pagedeck store pull
  env:
    PAGEDECK_SNAPSHOT_URL: ${{ secrets.SNAPSHOT_URL }}
```

`/proc/<pid>/environ` is readable only by the user the process runs as, and the
echoed `run:` line holds no URL.

**Do not expand the variable into the command line.** `pagedeck store pull
"$PAGEDECK_SNAPSHOT_URL"` is no safer than typing the URL: the shell expands it before
`pagedeck` starts, so the value is in the process arguments and in the echoed line
again. The protection comes from `pagedeck` reading the variable itself, which means
giving it no `<url>` at all.

This reduces the exposure; it does not remove it. A workflow that echoes the
variable, or a step that dumps its environment, puts the credential back in the
log.

An empty or whitespace-only `PAGEDECK_SNAPSHOT_URL` counts as unset — a CI expression
for a secret that does not exist expands to the empty string, and that must not
be mistaken for a target.

`<url>` still works, and is the right form for a `file:` target or any URL
carrying no credential. Passing both `<url>` and `PAGEDECK_SNAPSHOT_URL` is refused
rather than resolved by precedence: two targets in one invocation have no
defensible winner, and picking one silently could upload the store to the wrong
place.

## pagedeck diff

Compares two build manifests and prints the upload order: what to add, what to
replace and what to prune. `--grace-seconds <n>` sets how long a pruned file
stays reachable after the deploy.

### --force

`pagedeck diff` refuses a build that was not based on the build it is deploying over.
Every build records the id of the newest manifest its retention store held when
it started, as `build.parent`, so the pair of manifests a deploy holds is enough
to say whether they are a chain or a race:

```
pagedeck: Manifest diff: build "9e1f4a02" was built on "3c77b1de" and is being deployed over build "51ad900c", so another deploy wrote this site after this build read it — re-run pagedeck build so it is based on what is live, or pass --force to overwrite that deploy
```

That is two deploys running at once: another one finished after this build read
the store, and uploading this diff would overwrite files it never looked at
while pruning files it never saw. The refusal is exit **2** — the manifests are
intact, and the same command line fails the same way until it is edited.

A build that records no parent at all is refused with its own sentence, because
it is a different fact. It is not evidence of a race; it is the absence of the
evidence that would rule one out:

```
pagedeck: Manifest diff: build "9e1f4a02" records no parent, so nothing in it says it was built on build "51ad900c" — a build records the newest manifest its retention store held when it started, and one that ran before the store existed records none; re-run pagedeck build so it records this base, or pass --force to deploy it anyway
```

**A build diffed against itself is exempt.** When both manifests are the same
build the document is empty and the deploy writes nothing, so there is no
ordering to protect. Refusing it would teach the reader that `--force` is what
you pass to make `pagedeck diff` work — and then it would be passed on the deploy that
is really racing. The check earns its place only while it fires rarely.

`pagedeck rollback` takes no `--force`, and that is the design rather than an
omission: the flag exists to get past this refusal, and a rollback is out of
order by definition.

## pagedeck rollback

Prints the upload order that puts a retained build back: `pagedeck diff` with both
manifests found rather than named.

```sh
pagedeck rollback 3c77b1de
```

The `<build-id>` is the `build.id` of the build to restore, and a retained
document is named after it — `pagedeck build` leaves them in `.pagedeck/manifests` beside
your config. Both sides of the comparison come from the site's own config: the
build being replaced is the `manifest.json` in `outDir`, and the build being
restored is read out of the store. What you type is the one thing only you know,
which is which build.

The document is the one `pagedeck diff` writes, in the same order, so a pipeline that
already deploys a diff deploys a rollback with no change. `--grace-seconds <n>`
works the same way here.

A build id the store no longer holds is refused with the ids it does hold:

```
pagedeck: Retained manifest "3c77b1de": is not in the store at "/site/.pagedeck/manifests" — the retained builds are "51ad900c", "9e1f4a02", so roll back to one of those, or raise build.retention.keep before the build you want is pruned
```

How far back you can go is `build.retention.keep`, and the whole recipe is in
[Deploy serialization and rollback](./deploy-serialization.md).

## Exit codes

CI branches on the number, and the number comes from the class of failure, not
from the wording.

- **0** — the run finished.
- **1** — the run did not finish. A loader threw, content failed its schema, a
  page would not render, a snapshot host refused. It is not a promise that a
  retry will help; it says the fault is not the site's wiring.
- **2** — the site's own wiring is wrong. A missing or malformed config, an
  unregistered component, a collection declaring no schema, a command line the
  CLI does not understand. Retrying never fixes one of these.
