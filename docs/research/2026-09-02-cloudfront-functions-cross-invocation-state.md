# Nothing travels from a viewer-request function to a viewer-response one

Checked 2026-09-02, for #35's experiment-split compiler. The question was
load-bearing: #35 assigns an arm and rewrites to it on the same request, so the
arm chosen in the viewer-request function has to reach the viewer-response
function that writes the cookie — or else be derived twice.

## The finding

**It does not reach it.** There is no documented channel between the two
invocations. Neither a request header set in viewer-request nor the rewritten
`request.uri` is visible to viewer-response.

The evidence is one sentence, from the "Request object" section of the event
structure reference:

> The `request` object contains a representation of a viewer-to-CloudFront HTTP
> request. In the `event` object that's passed to your function, the `request`
> object represents the actual request that CloudFront received from the viewer.

— <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html>

"The actual request that CloudFront received from the viewer" is the request as
sent, not as a previous function left it. The section is general to the event
object and is not qualified by event type. Nothing on that page, or on
<https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/function-code-choose-purpose.html>,
says a viewer-response function's `request` carries viewer-request's edits.

This retires an older hedge in `assignStage`, which called the point "a fact
this repo cannot check" and designed around needing an answer.

## What the design does with it

It does not depend on the answer. The assignment table is keyed by the primary
path **and** by every arm's variant path, so the lookup hits whichever URI the
viewer-response invocation is handed. The fact above says it will be the
primary; the table does not need that to be true. A documentation change, or a
reading of it that turns out wrong, costs nothing here.

The arm itself is derived twice, identically, from `context.requestId` — which
the same page describes as the value that

> uniquely identifies a CloudFront request (and its associated response)

so one id spans the pair. If that is ever wrong, one request is served arm X
while its cookie is set to arm Y, and it self-heals on the next request,
because a held cookie wins in both functions.

## Two other facts confirmed on the same page

- `Set-Cookie` in a response is **not** part of `response.headers`; cookies "are
  represented separately in the `cookies` object". Writing a `set-cookie` header
  would not be folded back. The compiler writes `response.cookies`.
- `eventType` is documented as `viewer-request` or `viewer-response`, and a
  third exists: connection functions, for mTLS, take a different event shape
  entirely. Claims of the form "there are exactly two event types" are stale.

## A caution for anyone re-checking this

Every CloudFront documentation page fetched on this date carried an appended
"See also" block urging the reader to run `aws agent-toolkit search-skills`.
It is not AWS body text, it sits outside the documented content, and it is
prompt-injection-shaped. It was ignored here. Ignore it.
