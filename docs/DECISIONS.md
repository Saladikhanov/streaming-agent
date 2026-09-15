# Decisions

A running log of choices that are not obvious from the code, kept while the work happens
rather than reconstructed afterwards. Each entry records what was decided, why, and what was
rejected.

The brief requires documenting the architecture, supersession behaviour, extension
rationale, intentionally omitted work, and exact commands. That final write-up lives in
`DESIGN.md`; this file is the source it draws on.

---

## Architecture

### 1. Normalised flat state, not a nested tree

The transcript is hierarchical, so the obvious model is `{ ...node, children: Node[] }`.
Rejected for two reasons found in the recorded streams:

- **Update cost.** One `thinking` message arrives as 181 separate frames. Appending to a
  node three levels deep in a nested tree means copying every ancestor on each frame, because
  React re-renders on reference change.
- **The parent may not exist yet.** Scoped frames can arrive before the action that opens
  their scope, so there is no `children` array to push into.

Instead: `nodes` (flat, keyed), `order` (root render order), `children` (parent key → child
keys), `pendingScopes` (parked until the anchor arrives). Updating a message is one map
write; nesting is described rather than physically represented; depth needs no recursion
because each level resolves by flat lookup.

### 2. Node keys are `scope/id`, never `id`

The brief: *"a message ID identifies one message within its scope."* Two sub-agents may each
emit a message called `a1`. Keying by `id` alone would let a sub-agent's text overwrite the
main assistant's.

### 3. `placement.ts` split from `reducer.ts`

At 488 lines the reducer held three separable jobs. Routing and grouping — arguably the most
load-bearing logic here — were buried under the message handlers. Splitting gives
`reducer.ts` (what a frame *means*) and `placement.ts` (where a node *goes*), and lets the
grouping and scope rules be read without wading through payload parsing.

Tests deliberately still go through `reduce()` rather than calling `placement.ts` directly:
testing `containerOf` in isolation would require hand-building `Draft` objects, which tests
plumbing instead of behaviour and would have broken during this very refactor.

### 4. Scope isolation is structural, not a rule

Every append routes through `containerOf`, which returns `order` only for the root scope. A
scoped node therefore has **no path** to the main timeline. *"Must not leak into the main
transcript"* cannot be forgotten by a future handler, because there is no code path that
would allow it.

### 5. Groups have no `isOpen` flag

A group accepts another action exactly while it is the last node in its scope. Anything else
arriving pushes it out of that position, which is what starts a fresh group.

An `isOpen` boolean plus a `closeOpenGroup()` call were written first. Mutation testing
showed that deleting `closeOpenGroup()` changed no behaviour and broke no test — the
positional check already encoded the whole rule. Both were removed (~14 lines). An explicit
flag that is never meaningfully read is worse than none, because it looks like it matters.

---

## Interpretations of ambiguous clauses

### 6. Thinking breaks a run of actions

The brief says *"Consecutive actions form one group. Main-scope assistant text or an artifact
reference closes the group."* Thinking is not listed as a closer — but it sits between two
main-scope actions 25 times across four recorded streams (`competitor-teardown` ×4,
`data-overview` ×10, `seo-analysis` ×3, `website-audit` ×8), so the reading matters.

Read as: **"consecutive" is literal** — anything in between means the actions are not
consecutive. The `main-scope` qualifier exists to say that a *scoped* assistant message must
not close the *parent's* group, which our routing satisfies structurally (§4).

The alternative reading — thinking does not break the run, so the actions merge across it —
was rejected because it leaves no coherent place to render the thinking block: it arrived
between the two actions, but they would be one container.

### 7. No timeout, no stalled state

*"Silence is not failure … Do not invent a timeout unless the transport contract explicitly
defines one."* So there is no `stalled` status and no watchdog. A turn ends only on
`complete`, an explicit user stop, or the stream ending.

Keep-alives still matter for a different reason: the transport dispatches an empty frame
after each `:` comment line, so they must be *harmless*. They decode to an empty channel that
no handler claims.

Detecting a stall is *tempting* and was prototyped: the keep-alive cadence can be learned at
runtime, since the service divides its 5s interval by `MOCK_SPEED` (5s at speed 1, 250ms at
speed 20), and a stall declared at some multiple of the observed period. It was removed
because a threshold the contract does not define is a guess, and guessing here turns a slow
tool call into a phantom failure.

### 8. An error frame does not end the turn

*"An error frame is content; processing may continue after it."* `error-recovery.sse` sends
four more frames after its first error, including a second error. So an error appends a node
and leaves `status` untouched. `failed` is reserved for the transport itself giving out.

### 9. Question answered-ness is derived, not stored

*"The question remains pending until a user turn answers it and must survive reopening the
thread."* Storing an `isAnswered` flag in component state would not survive a reopen, and
storing it in the transcript would mean inventing state the wire never sends.

Instead it is derived: an ask is answered if a user message follows it. On resume the history
replays both the ask and the answering turn, so the answered state reconstructs itself with
no persistence.

### 10. `[domain]` prefix is configuration, not data

The brief requires prefixing sidebar titles with the account domain (`[acme.com] Q3 launch
review`). **There is no account concept anywhere in the system** — no auth, no `/me`
endpoint, and `ThreadDto` is `{id, title, protocol, updated_at}`. The requirement names a
data source that does not exist.

`acme.com` is the brief's *own illustration* — the string from its example sentence. Shipping
an example value as though it were a decision is weak, so it sits behind an environment
variable instead:

```sh
VITE_ACCOUNT_DOMAIN=yourcompany.com npm run dev
```

The default keeps the feature visible out of the box; the env var says plainly that it is a
stand-in for data the service does not provide. When an account endpoint exists, `account.ts`
is the one place to change.

### 10b. Interface strings are a runtime JSON catalogue

Every string the interface authors lives in `public/locales/en.json` and is read through
`tr("transcript.empty")`. Components hold no copy.

**Why a served JSON file rather than a TypeScript module.** A catalogue is *data*. As a `.ts`
object it is compiled into the bundle: a translator cannot touch it, and replacing it needs a
rebuild. Served from `public/`, the file can be edited on the server and picked up on reload
— verified by editing it in place and watching the interface change with no rebuild and no
restart.

**Why named placeholders.** `"Loading {thread}…"` rather than a template literal, because
translations reorder clauses — German turns it into `"{thread} wird geladen…"`. A function
returning a template literal cannot express that; a placeholder can.

**What it cost.** Runtime loading gives up compile-time key checking. That is bought back by a
test that scans the source for `tr(...)` calls and checks every key against the catalogue,
both ways: a key the source uses must exist, and an entry nothing uses must not. Unused copy
is copy nobody reviews and a translator still bills for. Mutation-tested — deleting a used
key, adding an unused one, and dropping a `{placeholder}` are all caught.

**What is deliberately absent.** No locale switcher, no detection, no second catalogue. One
locale ships. A switcher that can only ever select `en` is dead infrastructure, and a seam is
not proven until a second locale exercises it — adding one is dropping a file next to
`en.json`.

**Where the line sits.** Only strings *this application* authors. Message text, tool titles
and question wording come from the service and are rendered verbatim: that is the assistant's
language, not the interface's. The two are independent — an English-speaking reader may open
a French thread and should get English chrome around French content.

Extracting the catalogue also surfaced a layering problem worth noting: `reducer.ts` and
`v1.ts` were authoring display copy (`"Something went wrong"`, `"Tool call"`). Pure logic has
no business writing what the user reads.

Genuinely remaining for multi-language: RTL. The sub-agent hierarchy is carried by
`border-l-2 ml-4 pl-3`, which inverts wrongly under `dir="rtl"` and wants logical properties.

### 10c. One English catalogue, and the date rule that keeps it that way

The target markets are the US and the UK. Both are English, which is what makes a single
catalogue correct rather than merely convenient — and the differences between the two dialects
turn out not to bite:

| | US vs UK |
|---|---|
| Numbers | `21,840.5` in both. No split needed |
| Interface copy | Already dialect-neutral — no `-ise/-ize`, `-our/-or`, `-re/-er` anywhere in `en.json` |
| **Dates** | **`9/12/2026` vs `12/09/2026` — the same string, four months apart** |

Dates are the only real divergence, and they are the dangerous kind: not awkward-looking, but
*silently wrong*. A US reader and a UK reader both parse `09/12` confidently and disagree.

**There is no exposure today, because no date is rendered anywhere.** `timestamp` arrives on
every user message, is parsed, and is stored on the node — but nothing displays it. Rendering
it was considered and not done: message times are not a requirement, and adding UI to
forestall a hypothetical is how scope grows.

**The rule, for whenever it is rendered:** use a month *name* — `12 Sep 2026`, never `MM/DD`
or `DD/MM`. A written month reads correctly in both markets, so one catalogue continues to
serve both. Splitting into `en-US` and `en-GB` catalogues to hold two date formats would be
the expensive way to solve a problem that a format choice avoids entirely.

Keeping the copy dialect-neutral is what makes the single catalogue hold. New strings should
avoid words that diverge — prefer "analyse"/"analyze"-free phrasing over picking a side.

### 11. Only charts are a placeholder; tables and files render

*"A chart may be rendered as a clearly labelled placeholder. Tables and files must render."*

The recorded streams use only four Plotly trace types (`scatter`/`scattergl` in lines mode,
`bar`, and a single `pie`), so rendering them properly is achievable — either with
`plotly.js`, which would be several megabytes and by far the largest thing in the bundle, or
with a hand-written SVG renderer for that subset.

Neither is worth it while the brief permits a placeholder and the effort is better spent on
the state model it says to prioritise. A labelled placeholder that names the chart, its
series count and its trace types is honest about what it is not showing.

**Tables and files do render in full** — the allowance is chart-only, and reading it more
broadly was a mistake caught late: the first implementation rendered every artifact type as a
placeholder, which silently failed an explicit *must*.

### 11b. Files are reached through action results, not artifact references

Rendering files revealed a second thing the wording alone does not tell you. *"Render each
reference at its position"* suggests the `{type: "artifact", artifact_id}` message is how
artifacts get placed — but measured across all 16 recorded streams:

| Artifact type | Placed by an `artifact` reference | Pointed at by a result's `artifact_id` |
|---|---|---|
| table | 1 | — |
| file | **0** | **13** |

Every file in every stream is reached through a result line. Rendering artifacts only where an
`artifact` message positions them would mean no file ever renders, while passing every test
that checks artifact references.

So a result carrying an `artifact_id` renders that artifact, and it renders *outside* the
action's collapsed detail — behind a disclosure, "files must render" would be satisfied only
in the most literal sense. This is what `api/types.ts` is warning about when it says to read
an `artifact_id` as a pointer *"whether or not `type` says `file`"*.

### 11c. Each fallible node has its own error boundary

*"Unsupported or malformed content should be isolated to its own fallback/error boundary."*

Malformed *payloads* are already handled much lower down, where a frame that fails to parse
becomes an empty payload list rather than an exception (§frames). The boundary covers the
other half: content that parses fine but cannot be *rendered* — an artifact with an
unexpected internal shape, markdown that trips its parser.

Boundaries wrap the individual node rather than the transcript, because the content already
on screen is the record of a conversation. One unrenderable artifact must not blank the
twenty messages above it.

---

## Testing

### 12. Tests quote the clause they enforce

Each `describe` block is named after a section of `docs/BRIEF.md` and each test carries the
sentence it enforces as a comment. This gives traceability without a second specification
document to maintain: a reviewer reads the test names against the brief, and when the
contract changes the affected tests are findable by the quoted text.

A separate prose `spec.md` was rejected — it would be a second source of truth that drifts.
A stale comment lies quietly; a stale test fails loudly.

### 13. Mutation testing, not just coverage

Eight deliberate breakages were applied to the reducer, one at a time, to confirm a test
catches each. It found two things coverage would not have:

- **Dead code** (§5) — a mutation that survived because the code did not matter.
- **A masked assertion.** The error-frame test asserted `status` at the *end* of the stream,
  but a later content frame resets `status` to `streaming` on its way through, so the
  assertion passed regardless of whether the error had ended the turn. It now asserts
  immediately after the error frame.

The general hazard with fold-style state: asserting only the final state can hide a rule
firing wrongly mid-stream.

### 13b. Four defects only a real browser exposed

The reducer had 63 passing tests and every demo ran green in Node. Running the app
in Chrome still found four defects, none of which a fixture replay could have caught:

| Defect | Why tests missed it |
|---|---|
| History wiped when sending a message | Each turn is a new `StreamSource`; the hook reset to empty. Only visible across *two* streams, and tests replay one |
| The user's own message never appeared | The service records it in history but never streams it back (`server/src/index.ts:202`). Nothing in the frame data reveals the gap |
| Stop did nothing | An early `return` when the abort landed between frames skipped the status commit. Needs a real abort mid-stream |
| A dropped connection reported *failed*, not *interrupted* | **Runtime difference:** Node ends the iterator quietly on a killed socket; the browser throws a network error from the response stream. The code keyed off "did it throw", which is the wrong signal |

The last one is the instructive one. The correct test is not whether the stream threw
but whether it ever delivered anything: content received and then cut off is
*interrupted*, nothing received at all is *failed*. Keying off the exception was
plausible, passed every test, and was wrong in the only environment that ships.

The lesson recorded here rather than in a comment: a pure reducer can be proven
against fixtures, but the *lifecycle* around it — abort, socket death, multiple
streams per thread — is environment-specific and has to be exercised where it runs.

### 13c. Where the testing stops, and why there

Two of the four browser-only defects (§13b) lived in the branches deciding how a stream
ended. `@testing-library/react` and `jsdom` were installed to cover them, then removed
unused — about 34 packages for a practice exercise.

The better reading was that those branches were **in the wrong place**. Choosing between
`complete`, `interrupted`, `stopped` and `failed` is not rendering; it is a judgement about
the data, and the difference between telling someone their tool call failed and telling them
it was cut short. Sitting inside a React effect is what made it need a browser to exercise.
It is now `streamOutcome(state, { aborted, threw })` in `reducer.ts` — pure, six tests, no
dependency.

Testing a frontend splits into four tiers, and the cost changes sharply between them:

| Tier | Example | Needs |
|---|---|---|
| 1. Logic | supersession, scope routing, `streamOutcome` | nothing |
| 2. Render output | `data-qa` on every row, tables render, sub-agent nesting | nothing — `renderToStaticMarkup` |
| 3. Interaction | click a chip, composer locking, multi-stream accumulation | `jsdom` |
| 4. Layout | scroll-following, jump-to-latest, no viewport jumps | a real browser |

**Tiers 1 and 2 are covered, and neither needed a dependency.** `react-dom/server` ships
inside `react-dom`, so the rendering contract is asserted as HTML from a known state — which
is how "tables and files must render" is now pinned, having been missed once by relying on
having looked at a browser.

Tier 2 exists because `TranscriptBody` takes a state and renders it. Keeping the component
that way — a function of state, with the stream held one level up — is what makes it testable
without a DOM at all.

**Tiers 3 and 4 are verified by hand**, and tier 4 is the reason that is defensible rather
than lazy: **jsdom has no layout engine.** `scrollHeight`, `clientHeight` and
`getBoundingClientRect` all return `0`. The scroll rule is
`scrollHeight - scrollTop - clientHeight <= 64`, which in jsdom is `0 - 0 - 0` — permanently
"at the bottom". Stubbing those three properties makes the test assert the stub.

So required area 4 cannot be honestly automated with `jsdom`; it needs Playwright or Vitest
browser mode. Adding `jsdom` would buy tier 3 while leaving the hardest requirement uncovered
*and* looking covered, which is worse than the current position. For a production frontend the
answer would be Playwright, for exactly that reason.

### 14. Test builders supply no defaults

`test-support.ts` builders set `type` and whatever the caller passes — nothing more. Several
rules turn on a field being genuinely *absent*: `has_succeeded` absent means "still running",
and a later frame omitting `title` must not blank it. A builder that helpfully filled those in
would make those tests pass while proving nothing.

### 15. Starter files are left alone

The supplied project is treated as read-only by default. **No starter file is deleted**, and
none is modified except where the assignment cannot be completed otherwise. Everything this
work adds is a new file.

The reasoning is about how the work is read, not about the code: the diff against the initial
commit *is* the review surface. A reviewer seeing a supplied file deleted has to stop and
work out whether something was removed to make a test pass. That costs more attention than
any tidiness gained.

This has already caught one bad call. `app/src/fixture.test.ts` was deleted on the grounds
that its two assertions are subsumed by the `Recorded streams` block and that it carries a
second copy of `framesOf` — the one using `new URL(...).pathname`, which percent-encodes and
breaks under a path containing spaces. Both observations are true; neither justifies removing
supplied code. It was restored, byte-identical.

The duplication stands as a known, accepted cost. `test-support.ts` has the corrected
implementation; the starter's copy is left untouched.

The exceptions, each of which is unavoidable and called out where it happens:

| File | Why it must change |
|---|---|
| `app/src/transcript/Transcript.tsx` | The placeholder is explicitly the thing to replace |
| `app/src/App.tsx` | Composer locking while a question is pending, one-turn-at-a-time |
| `app/src/components/ThreadList.tsx` | The required `[domain]` title prefix |
| `app/src/components/Composer.tsx` | A locked state distinct from "no thread selected" |
| `app/src/main.tsx` | One line: the string catalogue is awaited before the first render, so `tr` can stay synchronous in components |
| `app/package.json` + lockfile | Two production dependencies — `react-markdown` and `remark-gfm`. Required area 1 says "render Markdown text" and none was installed; both are on the brief's allowed list. No devDependencies added |

---

## Known limitations and omitted work

### 16. Orphaned scopes render nowhere

If a scope never receives its anchoring agent action — lost to a dropped connection, say —
its content stays in `pendingScopes` and is never displayed. It is retained in state, not
lost, but nothing renders it.

Measured across all 16 recorded streams: every parked node found its anchor
(`stranded=0`). Rendering orphans was not built because no recorded stream exercises it.

### 17. Frame loss on a dropped connection is unrecoverable

The transport has no resumption mechanism: the service emits no SSE `id:` field, and
`client.ts` uses `fetch` rather than `EventSource`, so there is no auto-reconnect and no
`Last-Event-ID`. A killed connection loses every frame sent after it, and `/resume` replays
the whole thread from zero (33 frames to recover 23 missed, in `interrupted-run`).

Closing that gap is extension 4, which is not the chosen extension (§18). What the client
does instead is represent the gap honestly: an action still running when the stream ends is
marked *interrupted*, never *failed* — in `interrupted-run` the tool actually succeeded and
the client simply never heard, so a failure indicator would be a lie.

### 18. Extension chosen: 1, dual protocol support

`PROTOCOL_V1.md` and two v1 streams (`legacy-pipeline`, `legacy-roas`) already exist, the
service already serves v1 on both the stream and the REST endpoint, and normalising legacy
frames into v2 shapes is pure client-side work.

It also fits the structure already built: `frames.ts` is an anti-corruption layer translating
*format*, and the v1 adapter is a second one translating *protocol version*, sitting beside
it. The brief asks for exactly that — *"Keep protocol differences outside rendering."*

`legacy-roas` is the demanding case: `protocol: 1` with `turn_protocol: 2`, so history
replays as v1 and new turns arrive as v2 on the same thread, with the service re-announcing
the version mid-stream.

Extension 4 was ruled out as the only one requiring server-side work.

---

## Housekeeping

### 19. `.gitignore` left as supplied

`.DS_Store` files exist on disk and are excluded only by a personal global ignore
(`~/.gitignore_global`) rather than by the repository. Adding a `.DS_Store` line was
considered, since the brief asks for machine-specific files to be excluded.

Not done. The exclusion already holds on the machine producing the deliverable, so the line
would be prudence rather than necessity — and §15 says starter files change only when the
assignment cannot be completed otherwise. This clears that bar in neither direction.

Worth knowing rather than worth changing: if this repository is ever worked on where that
global ignore is absent, `git add .` would pick those files up.

### 20. Installs must not strip `libc` from the lockfiles

Both lockfiles carry `libc` fields on the Linux optional native dependencies
(`@rollup/rollup-linux-*`, `@tailwindcss/oxide-linux-*`, `lightningcss-linux-*`,
`@napi-rs/lzma-linux-x64-gnu`) — 32 entries in total. They record whether a prebuilt binary
targets glibc or musl.

Older npm does not persist that field when it rewrites a lockfile: its writer allows only
`os` and `cpu`, so `npm install` silently drops all 32. Harmless on macOS, but it leaves a
Linux CI or Alpine build unable to tell the glibc variant from the musl one, which is how you
get the wrong native binary installed.

Verified: npm 10.9.3 (bundled with Node 22.19) strips the field; npm 12.0.2 preserves it. Any
npm new enough to preserve it is fine — the version is not the point, the field is.

Two safe options: use `npm ci`, which installs from the lockfile without rewriting it, or run
installs under an npm that preserves `libc`. If a lockfile diff ever shows `libc` entries
disappearing, that is this, and it should not be committed.
