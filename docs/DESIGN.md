# Streaming Agent Console — design notes

The behaviour contract is transcribed in [`BRIEF.md`](./BRIEF.md). The reasoning behind
individual choices, including the ones rejected, is in [`DECISIONS.md`](./DECISIONS.md);
this document is the overview.

---

## Commands

Node 20.19+ or 22+ (`.nvmrc` pins 22). Two terminals:

```sh
cd server && npm ci && npm start     # http://localhost:8787
cd app    && npm ci && npm run dev   # http://localhost:5173, proxies /api
```

| | |
|---|---|
| Install | `npm ci` in `app/` and `server/` |
| Develop | `npm run dev` (app) · `npm start` (server) |
| Test | `npm test` in either package |
| Typecheck | `npm run typecheck` (app) |
| Production build | `npm run build` (app) |

Interface strings are served from `app/public/locales/en.json`. Editing that file changes the
interface on reload — no rebuild. `VITE_ACCOUNT_DOMAIN` overrides the sidebar domain prefix.

**`npm ci`, not `npm install`.** Both lockfiles carry `libc` fields on the Linux native
optional dependencies, and an older npm silently strips all 32 of them when it rewrites a
lockfile — harmless on macOS, but it leaves an Alpine or CI build unable to distinguish the
glibc build from the musl one. `npm ci` installs from the lockfile without rewriting it. See
`DECISIONS.md` §20.

The service replays at real time by default. `MOCK_SPEED=20 npm start` is far more pleasant
for development, but several behaviours only show at `MOCK_SPEED=1` — Stop in particular,
which at 20× finishes before you can click it.

Verified at the time of writing: app 102 tests / server 13 tests passing, typecheck clean,
production build 377 kB (117 kB gzipped).

---

## Architecture

```
bytes ─► client.ts ─► frames.ts ──────────────────┐
       (SSE, given)  (wire → app format)          │
                                                  ├─► reducer.ts ─► Transcript.tsx
       v1 streams ─► frames.ts ─► v1.ts ──────────┘   placement.ts    QuestionCard
                                (old → current protocol)              Markdown
                          useTranscript.ts  (the only React-aware seam)
```

Two translation layers sit at the edge, and both exist so the core has exactly one model to
reason about:

- **`frames.ts`** converts *format*. `{event: "final|aud-1", data: "{…}"}` becomes
  `{channel: "final", scope: "aud-1", data: {…}}`. Below it, nothing knows SSE exists, that
  `data` was ever a string, or that routing was packed into the event name.
- **`v1.ts`** converts *protocol version*, rewriting legacy frames into v2 shapes. Below it,
  nothing knows v1 exists.

| File | Lines | Responsibility |
|---|---|---|
| `model.ts` | 146 | Node types and state shape. No behaviour |
| `narrow.ts` | 52 | Reading `unknown` payloads safely |
| `frames.ts` | 56 | Wire → app format |
| `placement.ts` | 143 | Where a node goes: grouping, scope routing |
| `reducer.ts` | 359 | What a frame means |
| `v1.ts` | 138 | Legacy protocol adapter |
| `useTranscript.ts` | 169 | Stream lifecycle — the only React-aware part |
| `Transcript.tsx` | 341 | Rendering and scrolling |
| `Markdown.tsx`, `QuestionCard.tsx` | 175 | Prose and interactive asks |
| `Artifacts.tsx`, `Boundary.tsx` | 175 | Tables, files, chart placeholder; per-node fault isolation |
| `i18n.ts` + `locales/en.json` | 120 | Interface strings, loaded at runtime |

`streamOutcome` in `reducer.ts` decides which terminal state a stream ended in. It lives with
the pure logic rather than in the hook, because it is a judgement about the data — see
`DECISIONS.md` §13c.

Everything below `useTranscript` is a pure function, which is why the tests replay recorded
streams off disk with no server, no network and no DOM, in about 200 ms.

## State model

The transcript is hierarchical — sub-agents nest inside the actions that spawned them — but
it is **stored flat**:

```ts
order:         NodeKey[]                  // root render order
nodes:         Record<NodeKey, Node>      // every node, flat
children:      Record<NodeKey, NodeKey[]> // action → the scope it owns
scopeAnchors:  Record<string, NodeKey>    // scope_id → owning action
pendingScopes: Record<string, NodeKey[]>  // parked until the anchor arrives
artifacts:     Record<string, Artifact>   // id → newest payload
```

Two properties of the recorded streams forced this over a literal tree:

1. **One message can arrive as 181 frames.** Appending to a node three levels deep in a
   nested tree means copying every ancestor on each frame, since React re-renders on
   reference change. Flat, an update is one map write.
2. **The parent may not exist yet.** Scoped frames arrive before the action that opens their
   scope — the brief's own worked example does this — so there is no `children` array to
   push into. They wait in `pendingScopes` and are grafted when the anchor appears.

Node keys are `scope/id`, never `id`, because *"a message ID identifies one message within
its scope"*: two sub-agents may each emit an `a1`.

Nesting needs no recursion. A sub-agent three levels down registers its own `scope_id` the
same way a top-level one does, so every lookup is one hop regardless of depth.

**Scope isolation is structural.** Every append routes through `containerOf`, which returns
`order` only for the root scope — a scoped node has no code path to the main timeline, so
"must not leak" cannot be forgotten by a handler added later.

## Partial content and supersession

Three distinct rules, easy to conflate:

| Frame | Effect |
|---|---|
| `streaming` for id X | **Appends** to X's accumulated text |
| `final` for id X | **Replaces** everything accumulated for X |
| A later `final` for an action | Merges — but only fields actually present |

The replacement is not cosmetic. In `markdown-torture`, six streamed chunks build 361
characters and the `final` delivers 415 characters of *different wording* with an extra table
column. Appending the final instead of replacing it produces visible nonsense.

The merge rule matters for the opposite reason: a later action frame may carry only
`{id, has_succeeded: true}`. Assigning fields unconditionally would blank the title, so only
keys actually present are applied.

Chunks are never parsed individually. A delta can split a token — `markdown-torture` ends one
mid-way through a table separator, `"|\n|---|--"` — so text accumulates as plain strings and
Markdown is parsed only once assembled.

## Turn lifecycle

A turn ends on `complete`, an explicit Stop, or the stream ending. **There is no timeout.**
The brief forbids inventing one, and a threshold the contract does not define would turn a
slow tool call into a phantom failure. Keep-alives still matter — they must be *harmless*,
and they decode to an empty channel no handler claims.

Telling a finished turn from a dropped connection is subtle, because a killed socket does not
announce itself:

| Outcome | How it is recognised |
|---|---|
| `complete` | A `complete` frame arrived |
| `interrupted` | Stream ended or threw, but content had been received |
| `stopped` | User pressed Stop (`signal.aborted`) |
| `failed` | Stream ended or threw having delivered nothing |

Note what is *not* the signal: whether an exception was thrown. Node ends the iterator quietly
on a killed socket; the browser throws from the response stream. Keying off the exception
passed every test and was wrong in the only environment that ships — see `DECISIONS.md` §13b.

An action still running when a stream terminates is **interrupted, not failed**. In
`interrupted-run` the tool genuinely succeeded and the client simply never heard; a red
failure marker there would be a lie.

## Visual hierarchy

The transcript is a reading surface, so the ordering principle is *what the reader came for
first, what the machine did underneath*.

- **Assistant prose is unadorned** — no bubble, no border, full width. It is the answer, so
  it gets the least chrome and the most room.
- **User messages are a dark right-aligned bubble.** They are short, and their job is to
  break the transcript into turns at a glance.
- **Thinking is collapsed by default** behind a small `▸ Thinking` summary. It is useful when
  you doubt the answer and noise the rest of the time. It expands while streaming, because
  watching the model think is the only thing on screen during a long pause.
- **Action groups are a single bordered box** with one row per call. Nineteen consecutive
  tool calls in `seo-analysis` become one object on the page rather than nineteen.
- **Sub-agents nest behind a violet rule**, indented under the action that delegated. The
  colour is used nowhere else, so depth reads without a legend.
- **Status is a glyph, not a word**: `✓` `✕` `◌` (running) `⚠` (interrupted). Amber for
  interrupted rather than red, because interrupted is genuinely *unknown*, not failed.
- **Terminal states are a quiet status bar**, not a modal or a toast — they are information
  about the turn, not an interruption.

Scrolling follows new content only while the reader is within 64 px of the bottom; a single
`Jump to latest ↓` restores following. The slack matters: at zero, a stream appending while
the reader sits at the bottom would unpin itself on the first pixel of overshoot.

## Extension: dual protocol support

Chosen because it fits the structure the work already needed. `frames.ts` is an
anti-corruption layer converting format; the v1 adapter is a second one converting protocol
version, sitting beside it. The brief asks for exactly that — *"keep protocol differences
outside rendering"* — and the alternative, a second reducer, would mean implementing and
debugging grouping, scope nesting and supersession twice.

The adapter is stateful, because v1 loses information that cannot be recovered
frame-by-frame:

- `{"kind":"bot","done":true}` may omit `body`. A v2 `final` built from it would be
  authoritative and empty, purging the deltas it was meant to seal. The adapter accumulates
  the text and supplies it when the wire does not.
- v1 has no delivery/reference split for artifacts. Attachments ride inline with nothing
  saying where to draw them, so the positioning reference v2 would have sent is synthesised —
  which is what stops a legacy chart rendering as a hole.

It is attached and dropped by whatever the latest handshake announces, not decided once.
`legacy-roas` replays its history as v1 and then announces v2 for the live tail; both halves
render in one presentation model, and v2 features resume working immediately at the boundary.

No empty chrome is rendered for features v1 lacks: no bookmark divider (v1 replays have none),
no sub-agent affordances (v1 predates them).

## Artifacts

An artifact payload is delivered on the action that produced it and registered by id;
something else says *where* to draw it. That split is what lets a re-delivery of the same id
replace the payload everywhere without anything moving on the page.

There are two ways an artifact gets positioned, and the second is easy to miss:

| Pointer | What uses it |
|---|---|
| `{type: "artifact", artifact_id}` message | Charts and tables, placed at their stream position |
| An action result's `artifact_id` | **Every file, in every recorded stream** |

Measured across all 16 streams: 13 files, none placed by an artifact message, all reached
through a result. Rendering only the first kind would mean no file ever renders — so results
carrying an `artifact_id` render the artifact, outside the action's collapsed detail.

Tables render in full from their column-major form; files render as a card with name, type
and size; charts are a labelled placeholder. Each sits inside its own error boundary, so an
artifact with an unexpected shape degrades to a small notice instead of blanking the
conversation above it.

## Testing

74 app tests, organised by section of `BRIEF.md`, each quoting the clause it enforces. That
gives traceability without a second specification document to drift — a reviewer reads the
test names against the brief.

Tests run through `reduce()`, the real entry point, rather than the modules beneath it, so
they survived splitting `placement.ts` out of `reducer.ts` unchanged.

All 16 recorded streams are replayed with invariants asserted: no scoped node reaches the
main timeline, no tree reference dangles, no group is empty.

The rendering contract is asserted separately, as HTML: every row carries `data-qa`, tables
and files render, sub-agent content nests inside its delegating action, and no raw string key
ever reaches the page. That needs no DOM — `renderToStaticMarkup` runs a component from a
known state — because `TranscriptBody` is a function of the transcript with the stream held
one level up.

**Ten deliberate mutations** were applied one at a time to confirm each rule is actually
guarded. That found two things coverage would not have: dead code (a mutation that survived
because the code did not matter), and an assertion that read correctly but proved nothing
because a later frame reset the value it checked. Details in `DECISIONS.md` §13.

## Intentionally omitted

- **Charts render as a labelled placeholder** naming the title, series count and trace
  types. Explicitly permitted; `plotly.js` would be several megabytes for four trace types.
  Tables and files render in full.
- **Orphaned scopes render nowhere.** If a scope never receives its anchoring action its
  content stays in `pendingScopes`. Measured across all 16 streams, every parked node found
  its anchor, so rendering orphans was not built for a case nothing exercises.
- **No paged history.** `fetchMessages` is unused; back-paging is extension 2.
- **No reconnection cursor.** A dropped connection loses every frame after it and `/resume`
  replays from zero — 33 frames to recover 23 missed in `interrupted-run`. Closing that is
  extension 4, which requires server work. What the client does instead is represent the gap
  honestly rather than guess.
- **The account domain is configuration, not data.** No account exists anywhere in the
  service; `acme.com` is the brief's own example, overridable with `VITE_ACCOUNT_DOMAIN`.
- **Message timestamps are captured but not displayed.** The service sends `timestamp` on
  user messages and the reducer stores it; no component renders it. Not a requirement. If it
  is ever shown it must use a month name (`12 Sep 2026`) — `9/12/2026` reads as four months
  apart in the two target markets, US and UK. See `DECISIONS.md` §10c.
- **One locale ships.** Interface strings live in `public/locales/en.json` and are read
  through `tr("key")`; the catalogue is replaceable on the server without a rebuild. No
  switcher, no detection, no second catalogue — a switcher that can only select `en` is dead
  infrastructure. RTL is the genuine remaining gap: the sub-agent indentation uses physical
  CSS properties that invert wrongly.
- **No virtualization.** `history-heavy` renders 447 rows without trouble; the brief's
  optional ~2,000-message target would need it.

## With more time

1. **Virtualized rendering** for the optional 2,000-message target — the flat state model is
   already suited to it, since rendering reads `order` by index.
2. **Batch frames per animation frame.** `useTranscript` commits once per frame; a burst of
   hundreds during a replay causes hundreds of renders. It is not currently slow, which is
   why it was left alone, but it is the first thing to change under load.
3. **Browser-level tests** (Playwright or Vitest browser mode) for interaction and scroll
   behaviour. Logic and render output are covered with no dependency; interaction and layout
   are verified by hand. `jsdom` is deliberately not the answer — it has no layout engine, so
   it cannot test the scrolling requirement and would make it look covered. See
   `DECISIONS.md` §13c.
4. **Real chart rendering**, behind the same artifact boundary.
5. **Copy/export**, reusing the state model — the brief lists it as an optional improvement
   and the normalised tree makes a Markdown serialisation straightforward.
